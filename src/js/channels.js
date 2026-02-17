/**
 * Channel Manager
 * Manages channel creation, joining, and local storage
 * 
 * DUAL-STREAM ARCHITECTURE (v2):
 * Each channel now has two streams:
 * - messageStreamId (-1): Stored messages, reactions, images
 * - ephemeralStreamId (-2): Presence, typing, media chunks (not stored)
 */

import { Logger } from './logger.js';
import { streamrController, STREAM_CONFIG, deriveEphemeralId, deriveMessageId } from './streamr.js';
import { authManager } from './auth.js';
import { cryptoManager } from './crypto.js';
import { identityManager } from './identity.js';
import { secureStorage } from './secureStorage.js';
import { graphAPI } from './graph.js';

/**
 * Check if an error is a blockchain/gas related error
 * @param {Error} error - The error to check
 * @returns {{ isGasError: boolean, message: string }}
 */
function parseChainError(error) {
    const errorMsg = error.message || '';
    const errorCode = error.code || '';
    const reason = error.reason?.code || error.reason || '';
    const errorMsgLower = errorMsg.toLowerCase();
    
    // Insufficient funds for gas (check various formats)
    if (errorCode === 'INSUFFICIENT_FUNDS' ||
        errorMsg.includes('INSUFFICIENT_FUNDS') ||
        errorMsg.includes('code=INSUFFICIENT_FUNDS') ||
        errorMsgLower.includes('insufficient funds') ||
        errorMsgLower.includes('not enough balance')) {
        return {
            isGasError: true,
            message: 'Insufficient POL for gas fees. Please add POL to your wallet on Polygon network.'
        };
    }
    
    // Contract call exception (often means out of gas or reverted)
    if (errorCode === 'CALL_EXCEPTION' || 
        reason === 'CALL_EXCEPTION' ||
        errorMsg.includes('CALL_EXCEPTION')) {
        return {
            isGasError: true,
            message: 'Transaction failed. This usually means insufficient POL for gas fees or the transaction was rejected.'
        };
    }
    
    // Network/RPC errors
    if (errorCode === 'NETWORK_ERROR' || 
        errorCode === 'SERVER_ERROR' ||
        errorMsgLower.includes('network') ||
        errorMsgLower.includes('timeout')) {
        return {
            isGasError: false,
            message: 'Network error. Please check your connection and try again.'
        };
    }
    
    // User rejected transaction
    if (errorCode === 'ACTION_REJECTED' || 
        errorCode === 4001 ||
        errorMsgLower.includes('user rejected')) {
        return {
            isGasError: false,
            message: 'Transaction was cancelled.'
        };
    }
    
    // Not a recognized chain error
    return {
        isGasError: false,
        message: errorMsg || 'An unknown error occurred'
    };
}

class ChannelManager {
    constructor() {
        this.channels = new Map(); // streamId -> channel object
        this.currentChannel = null;
        this.messageHandlers = [];
        
        // Deduplication: track message IDs currently being processed (receive-side)
        this.processingMessages = new Set();
        
        // Deduplication: track messages currently being sent (send-side)
        // Prevents duplicate sends on rapid clicks or retries
        this.sendingMessages = new Set(); // streamId:messageId
        
        // Deduplication: track reactions currently being sent
        // Prevents duplicate reaction sends on rapid clicks
        this.pendingReactions = new Set(); // streamId:messageId:emoji:action
        this.REACTION_DEBOUNCE_MS = 500; // Minimum time between same reaction sends
        
        // Online presence tracking
        this.onlineUsers = new Map(); // streamId -> Map(userId -> {lastActive, nickname, address})
        this.presenceInterval = null;
        this.ONLINE_TIMEOUT = 15000; // 15 seconds to consider user offline
        this.onlineUsersHandlers = [];
        
        // Pending messages (failed to send, will retry)
        this.pendingMessages = new Map(); // streamId -> [messages]
        this.MAX_RETRIES = 3;
        this.RETRY_DELAY = 2000; // 2 seconds
    }

    /**
     * Load channels from secure storage (encrypted)
     */
    loadChannels() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                Logger.warn('Secure storage not unlocked - cannot load channels');
                return;
            }
            
            const channelsData = secureStorage.getChannels();
            Logger.debug('Loading channels from secure storage');

            if (channelsData && channelsData.length > 0) {
                for (const channel of channelsData) {
                    // Initialize empty arrays - messages loaded from storage on demand
                    channel.messages = [];
                    channel.reactions = {};
                    channel.historyLoaded = false;  // Track if initial history was loaded
                    channel.hasMoreHistory = true;  // Assume there's more until proven otherwise
                    channel.loadingHistory = false; // Prevent concurrent loads
                    channel.oldestTimestamp = null; // For pagination
                    
                    // Key by messageStreamId
                    this.channels.set(channel.messageStreamId, channel);
                }

                Logger.debug(`Loaded ${channelsData.length} channels from secure storage (metadata only)`);
                Logger.debug('Channels in map:', Array.from(this.channels.keys()));
            } else {
                Logger.debug('No saved channels found');
            }
        } catch (error) {
            Logger.error('Failed to load channels:', error);
        }
    }

    /**
     * Save channels to secure storage (encrypted)
     * NOTE: messages and reactions are NOT persisted - they come from storage
     */
    async saveChannels() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                Logger.warn('Secure storage not unlocked - cannot save channels');
                return;
            }
            
            // Strip messages and reactions from persistence - only save metadata
            // Messages are loaded from storage on demand (lazy loading)
            const channelsData = Array.from(this.channels.values()).map(ch => ({
                messageStreamId: ch.messageStreamId,
                ephemeralStreamId: ch.ephemeralStreamId,
                name: ch.name,
                type: ch.type,
                createdAt: ch.createdAt,
                createdBy: ch.createdBy,
                password: ch.password,
                members: ch.members || [],
                storageEnabled: ch.storageEnabled,
                // Exposure and metadata
                exposure: ch.exposure || 'hidden',
                description: ch.description || '',
                language: ch.language || '',
                category: ch.category || ''
                // messages: excluded - loaded from storage
                // reactions: excluded - loaded from storage
            }));
            Logger.debug('Saving channels to secure storage:', channelsData.length);

            await secureStorage.setChannels(channelsData);
            Logger.debug('Channels saved to secure storage (metadata only)');
        } catch (error) {
            Logger.error('Failed to save channels:', error);
        }
    }

    /**
     * Clear channels when switching wallets
     */
    clearChannels() {
        this.channels.clear();
        this.currentChannel = null;
        this.onlineUsers.clear();
        this.processingMessages.clear();
        this.pendingMessages.clear();
        this.sendingMessages.clear();
        this.pendingReactions.clear();
        Logger.debug('Channels cleared from memory');
    }

    /**
     * Create a new channel
     * @param {string} name - Channel name
     * @param {string} type - Channel type: 'public', 'password', 'native'
     * @param {string} password - Password for encrypted channels (optional)
     * @param {string[]} members - Member addresses for native private channels (optional)
     * @param {Object} options - Additional options { exposure: 'visible'|'hidden' }
     * @returns {Promise<Object>} - Created channel
     */
    async createChannel(name, type, password = null, members = [], options = {}) {
        try {
            const realAddress = authManager.getAddress();
            if (!realAddress) {
                throw new Error('Not authenticated');
            }

            Logger.debug('Creating dual-stream channel:', { name, type, realAddress, members: type === 'native' ? members : [] });

            // Create dual-stream channel - streamrController handles on-chain operations
            // Returns: { messageStreamId, ephemeralStreamId, type, name }
            const streamInfo = await streamrController.createStream(
                name, 
                realAddress, 
                type, 
                type === 'native' ? members : [],
                options
            );
            Logger.debug('Dual-stream created:', { 
                messageStreamId: streamInfo.messageStreamId, 
                ephemeralStreamId: streamInfo.ephemeralStreamId 
            });

            // Enable storage ONLY for message stream (ephemeral stream intentionally not stored)
            let storageEnabled = false;
            try {
                storageEnabled = await streamrController.enableStorage(streamInfo.messageStreamId);
                Logger.debug('Storage enabled for messageStream:', storageEnabled);
            } catch (storageError) {
                Logger.warn('Failed to enable storage (continuing without history):', storageError.message);
            }

            // Create channel object with dual-stream IDs
            // Include owner in members array for native channels
            const channelMembers = type === 'native' 
                ? [realAddress, ...members.filter(m => m.toLowerCase() !== realAddress.toLowerCase())]
                : [];
            
            // Extract exposure and metadata from options
            const exposure = options.exposure || (type === 'native' ? 'hidden' : 'hidden');
            
            const channel = {
                messageStreamId: streamInfo.messageStreamId,
                ephemeralStreamId: streamInfo.ephemeralStreamId,
                streamId: streamInfo.messageStreamId,  // Alias for convenience
                name: name,
                type: type,
                createdAt: Date.now(),
                createdBy: realAddress,
                password: password,
                members: channelMembers,
                messages: [],
                reactions: {}, // messageId -> { emoji -> [users] }
                storageEnabled: storageEnabled,
                // Exposure and metadata (for visible channels)
                exposure: exposure,
                description: exposure === 'visible' ? (options.description || '') : '',
                language: exposure === 'visible' ? (options.language || 'en') : '',
                category: exposure === 'visible' ? (options.category || 'general') : '',
                readOnly: options.readOnly || false,
                // Lazy loading state (not persisted)
                historyLoaded: false,
                hasMoreHistory: true,
                loadingHistory: false,
                oldestTimestamp: null
            };

            // Add to channels map (keyed by messageStreamId)
            this.channels.set(channel.messageStreamId, channel);
            await this.saveChannels();
            
            // Add to channel order (new channels go to top)
            await secureStorage.addToChannelOrder(channel.messageStreamId);
            
            Logger.debug('Channel saved to localStorage:', channel.messageStreamId);
            Logger.debug('Total channels:', this.channels.size);

            // Subscribe to both streams
            try {
                await this.subscribeToChannel(channel.messageStreamId);
                Logger.debug('Subscribed to dual-stream channel');
            } catch (subError) {
                Logger.warn('Failed to subscribe (can retry later):', subError);
            }

            Logger.info('Dual-stream channel created successfully:', channel.messageStreamId);
            return channel;
        } catch (error) {
            Logger.error('Failed to create channel:', error);
            // Check if it's a chain/gas error and throw with user-friendly message
            const chainError = parseChainError(error);
            throw new Error(chainError.message);
        }
    }

    /**
     * Join an existing channel (dual-stream architecture)
     * @param {string} messageStreamId - Message Stream ID to join (ends with -1)
     * @param {string} password - Password for encrypted channels (optional)
     * @param {Object} options - Additional options (name, type from invite)
     * @returns {Promise<Object>} - Joined channel
     */
    async joinChannel(messageStreamId, password = null, options = {}) {
        try {
            // Derive ephemeral stream ID from message stream ID
            const ephemeralStreamId = deriveEphemeralId(messageStreamId);
            
            // Check if already joined (use messageStreamId as key)
            if (this.channels.has(messageStreamId)) {
                Logger.debug('Already in this channel');
                return this.channels.get(messageStreamId);
            }

            // Determine type: use provided, detect via Graph API, or infer from password
            let channelType = options.type;
            let members = [];
            let createdBy = options.createdBy || null;
            
            if (!channelType || !createdBy) {
                // Try to detect type and get owner from The Graph
                Logger.debug('Detecting channel type via The Graph...');
                try {
                    // Clear cache first to get fresh data
                    graphAPI.clearCache();
                    
                    if (!channelType) {
                        channelType = await graphAPI.detectStreamType(messageStreamId);
                        Logger.debug('Detected type:', channelType);
                    }
                    
                    // Always get stream members to find owner (for storage enabling)
                    const streamMembers = await graphAPI.getStreamMembers(messageStreamId);
                    if (streamMembers && streamMembers.length > 0) {
                        const owner = streamMembers.find(m => m.isOwner);
                        if (!createdBy && owner) {
                            createdBy = owner.address;
                            Logger.debug('Found owner from Graph:', createdBy?.slice(0,10));
                        }
                        // For native channels, also get member list
                        if (channelType === 'native') {
                            members = streamMembers.map(m => m.address);
                            Logger.debug('Got', members.length, 'members');
                        }
                    }
                } catch (graphError) {
                    Logger.warn('Graph API failed, falling back to inference:', graphError.message);
                    // Default to native for safety - it's better to assume private than public
                    channelType = password ? 'password' : 'native';
                }
            }
            
            // Final fallback - default to native (private) instead of public
            // The Graph may take time to index, so unknown likely means native
            if (!channelType || channelType === 'unknown') {
                Logger.debug('Type unknown, defaulting to native (private)');
                channelType = password ? 'password' : 'native';
            }
            
            // Extract name from streamId if not provided (simplified ID format)
            let channelName = options.name || messageStreamId.split('/')[1]?.replace(/-\d$/, '') || messageStreamId;

            const channel = {
                messageStreamId: messageStreamId,
                ephemeralStreamId: ephemeralStreamId,
                streamId: messageStreamId,  // Alias for convenience
                name: channelName,
                type: channelType,
                createdAt: Date.now(),
                createdBy: createdBy,
                password: password,
                members: members,
                messages: [],
                reactions: {}, // messageId -> { emoji -> [users] }
                readOnly: options.readOnly || false,
                // Lazy loading state (not persisted)
                historyLoaded: false,
                hasMoreHistory: true,
                loadingHistory: false,
                oldestTimestamp: null
            };

            // Add to channels map (keyed by messageStreamId)
            this.channels.set(messageStreamId, channel);
            await this.saveChannels();
            
            // Add to channel order (new channels go to top)
            await secureStorage.addToChannelOrder(messageStreamId);

            // Subscribe to both streams
            await this.subscribeToChannel(messageStreamId, password);

            // Notify handlers about channel join (for media seeding re-announcement)
            this.notifyHandlers('channelJoined', { 
                streamId: messageStreamId, 
                messageStreamId,
                ephemeralStreamId,
                password, 
                channel 
            });

            Logger.info('Joined dual-stream channel:', messageStreamId);
            return channel;
        } catch (error) {
            Logger.error('Failed to join channel:', error);
            throw error;
        }
    }

    /**
     * Sync channel info from The Graph (members, type, owner)
     * Use this to refresh on-chain data for a channel
     * @param {string} messageStreamId - Message Stream ID
     * @returns {Promise<Object|null>} - Updated channel or null if not found
     */
    async syncChannelFromGraph(messageStreamId) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) {
            Logger.warn('Channel not found for sync:', streamId);
            return null;
        }

        try {
            Logger.debug('Syncing channel from The Graph:', streamId);
            
            // Get stream data from The Graph
            const streamData = await graphAPI.getStream(streamId);
            if (!streamData) {
                Logger.warn('Stream not found in The Graph');
                return channel;
            }

            // Update type based on permissions
            const type = await graphAPI.detectStreamType(streamId);
            if (type !== 'unknown') {
                channel.type = type;
            }

            // Get members
            const members = await graphAPI.getStreamMembers(streamId);
            channel.members = members.map(m => m.address);

            // Get owner
            const owner = members.find(m => m.isOwner);
            if (owner) {
                channel.createdBy = owner.address;
            }

            // Save updated info
            await this.saveChannels();
            
            Logger.debug('Channel synced:', {
                type: channel.type,
                members: channel.members.length,
                owner: channel.createdBy?.slice(0, 10)
            });

            return channel;
        } catch (error) {
            Logger.warn('Failed to sync channel from Graph:', error);
            return channel;
        }
    }

    /**
     * Check if current user has access to a stream (before joining)
     * @param {string} streamId - Stream ID
     * @returns {Promise<Object>} - Access info { hasAccess, canPublish, canSubscribe, isOwner }
     */
    async checkChannelAccess(streamId) {
        const userAddress = authManager.getAddress();
        if (!userAddress) {
            return { hasAccess: false, error: 'Not authenticated' };
        }

        return await graphAPI.checkUserAccess(streamId, userAddress);
    }

    /**
     * Add a member to a native encrypted channel (grants access to BOTH streams)
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @param {string} address - Ethereum address to add
     * @returns {Promise<boolean>} - Success status
     */
    async addMember(messageStreamId, address) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        if (channel.type !== 'native') {
            throw new Error('Can only add members to native encrypted channels');
        }

        // Normalize address
        const normalizedAddress = address.toLowerCase();
        
        // Check if already a member
        if (channel.members.map(m => m.toLowerCase()).includes(normalizedAddress)) {
            throw new Error('Address is already a member');
        }

        // Get ephemeral stream ID
        const ephemeralStreamId = channel.ephemeralStreamId || deriveEphemeralId(messageStreamId);

        try {
            // Grant permissions on BOTH streams (messageStream and ephemeralStream)
            await Promise.all([
                streamrController.grantPermissionsToAddresses(messageStreamId, [address]),
                streamrController.grantPermissionsToAddresses(ephemeralStreamId, [address])
            ]);
            
            // Clear Graph cache to refresh member list
            graphAPI.clearCache();
            
            // Update local channel
            channel.members.push(address);
            await this.saveChannels();
            
            Logger.info('Member added to dual-stream channel:', address);
            return true;
        } catch (error) {
            Logger.error('Failed to add member:', error);
            const chainError = parseChainError(error);
            throw new Error(chainError.message);
        }
    }

    /**
     * Remove a member from a native encrypted channel (revokes access to BOTH streams)
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @param {string} address - Ethereum address to remove
     * @returns {Promise<boolean>} - Success status
     */
    async removeMember(messageStreamId, address) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        if (channel.type !== 'native') {
            throw new Error('Can only remove members from native encrypted channels');
        }

        // Normalize address
        const normalizedAddress = address.toLowerCase();
        
        // Check if is a member
        const memberIndex = channel.members.findIndex(m => m.toLowerCase() === normalizedAddress);
        if (memberIndex === -1) {
            throw new Error('Address is not a member');
        }

        // Cannot remove the channel creator
        if (channel.createdBy && channel.createdBy.toLowerCase() === normalizedAddress) {
            throw new Error('Cannot remove the channel creator');
        }

        // Get ephemeral stream ID
        const ephemeralStreamId = channel.ephemeralStreamId || deriveEphemeralId(messageStreamId);

        try {
            // Revoke permissions on BOTH streams (messageStream and ephemeralStream)
            await Promise.all([
                streamrController.revokePermissionsFromAddresses(messageStreamId, [address]),
                streamrController.revokePermissionsFromAddresses(ephemeralStreamId, [address])
            ]);
            
            // Clear Graph cache to refresh member list
            graphAPI.clearCache();
            
            // Update local channel
            channel.members.splice(memberIndex, 1);
            await this.saveChannels();
            
            Logger.info('Member removed from dual-stream channel:', address);
            return true;
        } catch (error) {
            Logger.error('Failed to remove member:', error);
            const chainError = parseChainError(error);
            throw new Error(chainError.message);
        }
    }

    /**
     * Get members of a channel with their permissions
     * @param {string} streamId - Stream ID
     * @returns {Promise<Array>} - Array of { address, canGrant, canEdit, canDelete, isOwner }
     */
    async getChannelMembers(streamId) {
        const channel = this.channels.get(streamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        if (channel.type !== 'native') {
            return []; // Non-native channels don't have member list
        }

        const ownerAddress = channel.createdBy?.toLowerCase();
        const membersMap = new Map(); // address -> permissions

        // Always include owner with full permissions
        if (ownerAddress) {
            membersMap.set(ownerAddress, {
                address: ownerAddress,
                canGrant: true,
                canEdit: true,
                canDelete: true,
                isOwner: true
            });
        }

        try {
            // PRIMARY: Use The Graph API for on-chain data (includes permissions)
            Logger.debug('Fetching members from The Graph...');
            const graphMembers = await graphAPI.getStreamMembers(streamId);
            Logger.debug('Graph members result:', graphMembers);
            
            if (graphMembers && graphMembers.length > 0) {
                Logger.debug('Graph returned', graphMembers.length, 'members');
                for (const member of graphMembers) {
                    if (member.address) {
                        const addr = member.address.toLowerCase();
                        // Update existing or add new member
                        membersMap.set(addr, {
                            address: addr,
                            canGrant: member.canGrant || false,
                            canEdit: member.canEdit || false,
                            canDelete: member.canDelete || false,
                            isOwner: member.isOwner || false
                        });
                    }
                }
            } else {
                // FALLBACK: Use local cache (no permission info)
                Logger.debug('Graph empty, using local cache...');
                if (channel.members && channel.members.length > 0) {
                    for (const addr of channel.members) {
                        const normalizedAddr = addr.toLowerCase();
                        if (!membersMap.has(normalizedAddr)) {
                            membersMap.set(normalizedAddr, {
                                address: normalizedAddr,
                                canGrant: false,
                                canEdit: false,
                                canDelete: false,
                                isOwner: false
                            });
                        }
                    }
                }
            }
        } catch (error) {
            Logger.warn('Failed to get permissions:', error.message);
            // Use local cache as last resort
            if (channel.members && channel.members.length > 0) {
                for (const addr of channel.members) {
                    const normalizedAddr = addr.toLowerCase();
                    if (!membersMap.has(normalizedAddr)) {
                        membersMap.set(normalizedAddr, {
                            address: normalizedAddr,
                            canGrant: false,
                            canEdit: false,
                            canDelete: false,
                            isOwner: false
                        });
                    }
                }
            }
        }

        // Convert to array with checksum addresses
        const members = Array.from(membersMap.values()).map(m => {
            try {
                return { ...m, address: ethers.getAddress(m.address) };
            } catch {
                return m;
            }
        });

        // Update local cache (addresses only)
        channel.members = members.map(m => m.address);
        await this.saveChannels();

        return members;
    }

    /**
     * Update member permissions (grant or revoke GRANT permission)
     * @param {string} streamId - Stream ID
     * @param {string} address - Member address
     * @param {Object} permissions - { canGrant: boolean }
     */
    async updateMemberPermissions(streamId, address, permissions) {
        const channel = this.channels.get(streamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        if (channel.type !== 'native') {
            throw new Error('Can only update permissions on native channels');
        }

        try {
            await streamrController.updatePermissions(streamId, address, permissions);
            
            // Clear Graph cache to refresh permissions
            graphAPI.clearCache();
            
            Logger.info('Member permissions updated:', address, permissions);
            return true;
        } catch (error) {
            Logger.error('Failed to update permissions:', error);
            const chainError = parseChainError(error);
            throw new Error(chainError.message);
        }
    }

    /**
     * Check if current user is the channel owner
     * @param {string} streamId - Stream ID
     * @returns {boolean}
     */
    isChannelOwner(streamId) {
        const channel = this.channels.get(streamId);
        const currentAddress = authManager.getAddress();
        
        if (!currentAddress) return false;
        
        // Check by createdBy field first
        if (channel?.createdBy && 
            channel.createdBy.toLowerCase() === currentAddress.toLowerCase()) {
            return true;
        }
        
        // Fallback: check if streamId starts with user's address (Streamr format: address/path)
        // Extract address part (before the /)
        const streamIdAddress = (streamId?.split('/')[0] || '').toLowerCase();
        const addressLower = currentAddress.toLowerCase();
        
        // Only compare if streamIdAddress looks like a full address (42 chars)
        if (streamIdAddress.length === 42 && streamIdAddress === addressLower) {
            return true;
        }
        
        return false;
    }

    /**
     * Check if current user can add members (owner or has GRANT permission)
     * @param {string} streamId - Stream ID
     * @returns {Promise<boolean>}
     */
    async canAddMembers(streamId) {
        // Owner can always add members
        if (this.isChannelOwner(streamId)) {
            return true;
        }

        // Check if user has GRANT permission
        try {
            const currentAddress = authManager.getAddress();
            if (!currentAddress) return false;

            const members = await this.getChannelMembers(streamId);
            const currentMember = members.find(
                m => m.address.toLowerCase() === currentAddress.toLowerCase()
            );

            return currentMember?.canGrant === true;
        } catch (error) {
            Logger.warn('Failed to check canAddMembers:', error);
            return false;
        }
    }

    /**
     * Pre-load DELETE permission for a channel (fire-and-forget, non-blocking)
     * Caches result on the channel object for faster modal opening
     * @param {string} streamId - Stream ID
     */
    preloadDeletePermission(streamId) {
        const channel = this.channels.get(streamId);
        if (!channel) return;
        
        const currentAddress = authManager.getAddress();
        if (!currentAddress) return;
        
        // If already cached for current wallet, skip
        if (channel._deletePermCache?.address?.toLowerCase() === currentAddress.toLowerCase()) {
            return;
        }
        
        // Fire-and-forget permission check
        streamrController.hasDeletePermission(streamId)
            .then(canDelete => {
                // Double-check channel still exists and wallet hasn't changed
                const ch = this.channels.get(streamId);
                const addr = authManager.getAddress();
                if (ch && addr) {
                    ch._deletePermCache = { 
                        canDelete, 
                        address: addr.toLowerCase() 
                    };
                    Logger.debug('Cached DELETE permission:', { streamId: streamId.slice(-20), canDelete });
                }
            })
            .catch(err => {
                Logger.warn('Failed to preload DELETE permission:', err.message);
            });
    }

    /**
     * Get cached DELETE permission for a channel if valid for current wallet
     * @param {string} streamId - Stream ID
     * @returns {{ valid: boolean, canDelete: boolean }}
     */
    getCachedDeletePermission(streamId) {
        const channel = this.channels.get(streamId);
        if (!channel?._deletePermCache) {
            return { valid: false, canDelete: false };
        }
        
        const currentAddress = authManager.getAddress();
        if (!currentAddress) {
            return { valid: false, canDelete: false };
        }
        
        // Cache is valid only if it was checked by the current wallet
        if (channel._deletePermCache.address === currentAddress.toLowerCase()) {
            return { valid: true, canDelete: channel._deletePermCache.canDelete };
        }
        
        return { valid: false, canDelete: false };
    }

    /**
     * Subscribe to a channel's dual-stream with message history
     * In dual-stream architecture:
     * - messageStream: messages with history
     * - ephemeralStream: control/media without history
     * 
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {string} password - Password for encrypted channels (optional)
     */
    async subscribeToChannel(messageStreamId, password = null) {
        const channel = this.channels.get(messageStreamId);
        const pwd = password || (channel ? channel.password : null);
        
        // Get or derive ephemeral stream ID
        const ephemeralStreamId = channel?.ephemeralStreamId || deriveEphemeralId(messageStreamId);

        // Try to enable storage if user is owner and storage not already enabled
        // Only the stream owner can add a stream to a storage node
        // Storage is ONLY for messageStream (ephemeral is never stored)
        if (channel && !channel.storageEnabled) {
            const currentAddress = authManager.getAddress()?.toLowerCase();
            const ownerAddress = channel.createdBy?.toLowerCase();
            
            if (currentAddress && ownerAddress && currentAddress === ownerAddress) {
                Logger.debug('Owner subscribing - trying to enable storage for messageStream:', messageStreamId);
                try {
                    const enabled = await streamrController.enableStorage(messageStreamId);
                    if (enabled) {
                        channel.storageEnabled = true;
                        await this.saveChannels();
                        Logger.info('Storage enabled by owner for messageStream');
                    }
                } catch (e) {
                    Logger.debug('Could not enable storage (may already be enabled):', e.message);
                }
            }
        }

        // Use dual-stream subscription
        await streamrController.subscribeToDualStream(
            messageStreamId,
            ephemeralStreamId,
            {
                onMessage: (data) => this.handleTextMessage(messageStreamId, data),
                onControl: (data) => this.handleControlMessage(messageStreamId, data),
                onMedia: (data) => this.handleMediaMessage(messageStreamId, data)
            },
            pwd,
            STREAM_CONFIG.INITIAL_MESSAGES
        );
        
        Logger.debug('Subscribed to dual-stream channel:', messageStreamId);
    }

    /**
     * Store a reaction in the channel object
     * @param {Object} channel - Channel object
     * @param {string} messageId - Message ID
     * @param {string} emoji - Emoji
     * @param {string} user - User address
     * @param {string} action - 'add' or 'remove' (default: 'add')
     */
    storeReaction(channel, messageId, emoji, user, action = 'add') {
        if (!channel.reactions) {
            channel.reactions = {};
        }
        if (!channel.reactions[messageId]) {
            channel.reactions[messageId] = {};
        }
        if (!channel.reactions[messageId][emoji]) {
            channel.reactions[messageId][emoji] = [];
        }
        
        const normalizedUser = user.toLowerCase();
        const userIndex = channel.reactions[messageId][emoji].findIndex(u => u.toLowerCase() === normalizedUser);
        
        if (action === 'remove') {
            // Remove user from reaction
            if (userIndex >= 0) {
                channel.reactions[messageId][emoji].splice(userIndex, 1);
                // Clean up empty arrays
                if (channel.reactions[messageId][emoji].length === 0) {
                    delete channel.reactions[messageId][emoji];
                }
                if (Object.keys(channel.reactions[messageId]).length === 0) {
                    delete channel.reactions[messageId];
                }
            }
        } else {
            // Add user if not already in the list
            if (userIndex < 0) {
                channel.reactions[messageId][emoji].push(user);
            }
        }
    }

    /**
     * Get reactions for a channel
     * @param {string} streamId - Stream ID
     * @returns {Object} - Reactions object { messageId -> { emoji -> [users] } }
     */
    getChannelReactions(streamId) {
        const channel = this.channels.get(streamId);
        return channel?.reactions || {};
    }

    // ==================== Presence Tracking ====================

    /**
     * Register handler for online users updates
     * @param {Function} handler - Callback function
     */
    onOnlineUsersChange(handler) {
        this.onlineUsersHandlers.push(handler);
    }

    /**
     * Notify online users handlers
     * @param {string} streamId - Stream ID
     */
    notifyOnlineUsersChange(streamId) {
        const users = this.getOnlineUsers(streamId);
        this.onlineUsersHandlers.forEach(handler => {
            try {
                handler(streamId, users);
            } catch (e) {
                Logger.error('Online users handler error:', e);
            }
        });
    }

    /**
     * Get online users for a channel
     * @param {string} streamId - Stream ID
     * @returns {Array} - Array of online users
     */
    getOnlineUsers(streamId) {
        const users = this.onlineUsers.get(streamId);
        if (!users) return [];
        
        const now = Date.now();
        const onlineList = [];
        
        for (const [userId, data] of users.entries()) {
            if (now - data.lastActive < this.ONLINE_TIMEOUT) {
                onlineList.push({
                    id: userId,
                    nickname: data.nickname,
                    address: data.address,
                    lastActive: data.lastActive
                });
            }
        }
        
        return onlineList;
    }

    /**
     * Update user presence
     * @param {string} streamId - Stream ID
     * @param {Object} presenceData - Presence data
     */
    handlePresenceMessage(streamId, presenceData) {
        if (!this.onlineUsers.has(streamId)) {
            this.onlineUsers.set(streamId, new Map());
        }
        
        const users = this.onlineUsers.get(streamId);
        users.set(presenceData.userId, {
            lastActive: presenceData.lastActive || Date.now(),
            nickname: presenceData.nickname || null,
            address: presenceData.address || null
        });
        
        this.notifyOnlineUsersChange(streamId);
    }

    /**
     * Publish presence to channel's EPHEMERAL stream
     * Presence goes to ephemeralStreamId (not stored)
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async publishPresence(messageStreamId) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) return;
        
        // Use ephemeral stream for presence (not stored)
        const ephemeralStreamId = channel.ephemeralStreamId || deriveEphemeralId(messageStreamId);
        
        const myAddress = authManager.getAddress();
        const myNickname = identityManager.getUsername?.() || null;
        
        const presenceData = {
            type: 'presence',
            userId: myAddress,
            address: myAddress,
            nickname: myNickname,
            lastActive: Date.now()
        };
        
        try {
            // Publish to ephemeral stream (partition 0 = control)
            await streamrController.publishControl(ephemeralStreamId, presenceData, channel.password);
        } catch (e) {
            Logger.warn('Failed to publish presence:', e.message);
        }
    }

    /**
     * Start presence publishing for a channel
     * @param {string} streamId - Stream ID
     */
    startPresenceTracking(streamId) {
        // Publish presence immediately
        this.publishPresence(streamId);
        
        // Then periodically
        if (this.presenceInterval) {
            clearInterval(this.presenceInterval);
        }
        
        this.presenceInterval = setInterval(() => {
            if (this.currentChannel === streamId) {
                this.publishPresence(streamId);
                
                // Clean up old users
                const users = this.onlineUsers.get(streamId);
                if (users) {
                    const now = Date.now();
                    for (const [userId, data] of users.entries()) {
                        if (now - data.lastActive > this.ONLINE_TIMEOUT) {
                            users.delete(userId);
                        }
                    }
                    this.notifyOnlineUsersChange(streamId);
                }
            }
        }, 5000); // Every 5 seconds
    }

    /**
     * Stop presence tracking
     */
    stopPresenceTracking() {
        if (this.presenceInterval) {
            clearInterval(this.presenceInterval);
            this.presenceInterval = null;
        }
    }

    // ==================== End Presence Tracking ====================

    /**
     * Handle control/metadata message
     * @param {string} streamId - Stream ID
     * @param {Object} data - Control data
     */
    async handleControlMessage(streamId, data) {
        // CRITICAL: Check if still connected before processing
        if (!authManager.isConnected()) {
            return;
        }
        
        // Handle different control message types
        if (data.type === 'typing') {
            this.notifyHandlers('typing', { streamId, user: data.user });
        } else if (data.type === 'presence') {
            // Handle presence update
            this.handlePresenceMessage(streamId, data);
        } else if (data.type === 'reaction') {
            // Someone reacted to a message - store in memory only
            const channel = this.channels.get(streamId);
            if (channel && data.messageId && data.emoji && data.user) {
                this.storeReaction(channel, data.messageId, data.emoji, data.user, data.action || 'add');
                // NOTE: No saveChannels() - reactions are not persisted, only in RAM
            }
            
            // Notify handlers to update UI
            this.notifyHandlers('reaction', { 
                streamId, 
                messageId: data.messageId,
                emoji: data.emoji,
                user: data.user,
                action: data.action || 'add'
            });
        } else if (data.type === 'member_update') {
            const channel = this.channels.get(streamId);
            if (channel) {
                channel.members = data.members;
                await this.saveChannels();
            }
        }
    }

    /**
     * Handle text message (real-time and historical)
     * @param {string} streamId - Stream ID
     * @param {Object} data - Message data
     */
    async handleTextMessage(streamId, data) {
        // CRITICAL: Check if still connected before processing
        // This prevents messages from being processed after disconnect
        if (!authManager.isConnected()) {
            return;
        }
        
        // Skip presence/typing - these are ephemeral
        if (data?.type === 'presence' || data?.type === 'typing') {
            return;
        }
        
        // Reactions go to partition 0 now (for storage), but handle them via control handler
        if (data?.type === 'reaction') {
            this.handleControlMessage(streamId, data);
            return;
        }
        
        // Validate that this looks like a message (has required properties)
        // Text messages need: id, text, sender, timestamp
        // Image messages need: id, imageId, sender, timestamp
        // Video messages need: id, metadata, sender, timestamp
        const isTextMessage = data?.text;
        const isImageMessage = data?.type === 'image' && data?.imageId;
        const isVideoMessage = data?.type === 'video_announce' && data?.metadata;
        
        if (!data?.id || !data?.sender || !data?.timestamp) {
            return;
        }
        
        if (!isTextMessage && !isImageMessage && !isVideoMessage) {
            Logger.debug('Unknown message type, skipping:', data?.type);
            return;
        }
        
        Logger.debug('handleTextMessage:', { messageId: data.id, type: data.type || 'text', sender: data.sender?.slice(0,10) });
        
        // Early deduplication check using processing set (prevents race conditions)
        const messageKey = `${streamId}:${data.id}`;
        if (this.processingMessages.has(messageKey)) {
            Logger.debug('Message already being processed, skipping:', data.id);
            return;
        }
        this.processingMessages.add(messageKey);
        
        // Clean up after processing (with timeout to handle async operations)
        setTimeout(() => this.processingMessages.delete(messageKey), 5000);
        
        const channel = this.channels.get(streamId);
        if (!channel) {
            Logger.warn('Channel not found for streamId:', streamId);
            return;
        }

        // Check if message already exists (deduplication)
        // This handles duplicates from network AND historical messages
        const messageExists = channel.messages.some(m => m.id === data.id);
        
        if (messageExists) {
            Logger.debug('Message already exists, skipping duplicate:', data.id);
            return;
        }
        
        // For real-time messages (not from history), skip our own messages
        // since they were already added locally in sendMessage()
        // Historical messages from ourselves should be processed normally
        const myAddress = authManager.getAddress();
        const isOwnMessage = data.sender?.toLowerCase() === myAddress?.toLowerCase();
        
        // Check if this is a very recent message (likely real-time, not historical)
        const messageAge = Date.now() - (data.timestamp || 0);
        const isRecentMessage = messageAge < 30000; // 30 seconds
        
        if (isOwnMessage && isRecentMessage) {
            Logger.debug('Skipping own recent message (already added locally):', data.id);
            return;
        }

        // Verify message signature
        try {
            // Add channelId if missing (for backwards compatibility)
            if (!data.channelId) {
                data.channelId = streamId;
            }
            
            // Pass streamId for session key verification
            // Skip timestamp check for historical messages (older than 30 seconds)
            // to allow legitimate old messages from history to be verified
            const verification = await identityManager.verifyMessage(data, streamId, {
                skipTimestampCheck: !isRecentMessage
            });
            data.verified = verification;
            
            if (!verification.valid) {
                Logger.warn('Message signature verification failed:', verification.error);
                Logger.warn('   Claimed sender:', data.sender);
                if (verification.actualSigner) {
                    Logger.warn('   Actual signer:', verification.actualSigner);
                }
            } else if (verification.pendingVerification) {
                Logger.debug('Message signature valid, identity pending:', data.sender);
            } else if (verification.verifiedViaSession) {
                Logger.debug('Message verified via session key:', verification.ensName || data.sender);
            } else {
                Logger.debug('Message verified from:', verification.ensName || data.sender);
            }
        } catch (error) {
            Logger.error('Verification error:', error);
            data.verified = { valid: false, error: error.message, trustLevel: -1 };
        }

        // Add to channel messages
        channel.messages.push(data);
        
        // Update oldest timestamp for pagination
        if (!channel.oldestTimestamp || data.timestamp < channel.oldestTimestamp) {
            channel.oldestTimestamp = data.timestamp;
        }
        
        // Sort to maintain chronological order (in case of out-of-order delivery)
        this.sortMessagesByTimestamp(channel);
        
        // NOTE: No saveChannels() - messages are not persisted, only in RAM
        // They will be reloaded from LogStore on next session

        // Notify handlers
        this.notifyHandlers('message', { streamId, message: data });
    }

    /**
     * Handle media message
     * @param {string} streamId - Stream ID
     * @param {Object} data - Media data
     */
    handleMediaMessage(streamId, data) {
        // CRITICAL: Check if still connected before processing
        if (!authManager.isConnected()) {
            return;
        }
        
        // Skip control messages (presence, typing, reactions) - these shouldn't be on partition 2
        if (data?.type === 'presence' || data?.type === 'typing' || data?.type === 'reaction') {
            return;
        }
        
        // Skip if it doesn't look like media
        if (!data?.type) {
            return;
        }
        
        Logger.debug('Media message received:', data?.type);

        // Notify handlers
        this.notifyHandlers('media', { streamId, media: data });
    }

    /**
     * Send a text message to MESSAGE stream
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @param {string} text - Message text
     * @param {Object|null} replyTo - Reply context (optional)
     */
    async sendMessage(messageStreamId, text, replyTo = null) {
        let message = null;
        let sendKey = null;
        
        try {
            const channel = this.channels.get(messageStreamId);
            if (!channel) {
                throw new Error('Channel not found');
            }

            // Check if channel is read-only and user is not the creator
            if (channel.readOnly) {
                const currentAddress = identityManager.getAddress()?.toLowerCase();
                const creatorAddress = channel.createdBy?.toLowerCase();
                if (currentAddress !== creatorAddress) {
                    throw new Error('This channel is read-only. Only the creator can send messages.');
                }
            }

            // Create signed message using identity manager
            message = await identityManager.createSignedMessage(text, messageStreamId, replyTo);
            
            // DEDUPLICATION: Check if this message is already being sent
            // This prevents double-sends from rapid clicks or retry loops
            sendKey = `${messageStreamId}:${message.id}`;
            if (this.sendingMessages.has(sendKey)) {
                Logger.warn('Message already being sent, skipping duplicate:', message.id);
                return; // Don't throw - just silently skip duplicate
            }
            this.sendingMessages.add(sendKey);

            // Add verification info for local display
            message.verified = {
                valid: true,
                trustLevel: await identityManager.getTrustLevel(message.sender)
            };
            
            // Mark as pending until confirmed sent
            message.pending = true;

            // Add to local messages FIRST (before publishing)
            channel.messages.push(message);
            // NOTE: No saveChannels() - messages are not persisted

            // Notify handlers to update UI immediately (with pending indicator)
            this.notifyHandlers('message', { streamId: messageStreamId, message: message });

            // Publish to MESSAGE stream (stored)
            await this.publishWithRetry(messageStreamId, message, channel.password);
            
            // Mark as sent (remove pending flag)
            message.pending = false;
            // NOTE: No saveChannels() - messages are not persisted
            
            // Notify UI that message is confirmed
            this.notifyHandlers('message_confirmed', { streamId: messageStreamId, messageId: message.id });

            Logger.debug('Message sent to messageStream:', message.id);
        } catch (error) {
            Logger.error('Failed to send message:', error);
            // Message stays in local storage with pending flag
            // User can see it failed and retry manually
            this.notifyHandlers('message_failed', { streamId: messageStreamId, messageId: message?.id, error: error.message });
            throw error;
        } finally {
            // Always clean up the sending lock
            if (sendKey) {
                this.sendingMessages.delete(sendKey);
            }
        }
    }
    
    /**
     * Publish message with retry mechanism
     * @param {string} messageStreamId - Message Stream ID
     * @param {Object} message - Message to publish
     * @param {string} password - Channel password (optional)
     * @param {number} retryCount - Current retry attempt
     */
    async publishWithRetry(messageStreamId, message, password = null, retryCount = 0) {
        try {
            await streamrController.publishMessage(messageStreamId, message, password);
            Logger.info('Text message published to messageStream:', message.id);
        } catch (error) {
            if (retryCount < this.MAX_RETRIES) {
                Logger.warn(`Publish failed, retrying (${retryCount + 1}/${this.MAX_RETRIES})...`);
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
                return this.publishWithRetry(messageStreamId, message, password, retryCount + 1);
            }
            throw error;
        }
    }
    
    /**
     * Retry sending a pending message
     * @param {string} streamId - Stream ID
     * @param {string} messageId - Message ID to retry
     */
    async retryPendingMessage(streamId, messageId) {
        const channel = this.channels.get(streamId);
        if (!channel) return;
        
        const message = channel.messages.find(m => m.id === messageId && m.pending);
        if (!message) {
            Logger.warn('Message not found or not pending:', messageId);
            return;
        }
        
        try {
            await this.publishWithRetry(streamId, message, channel.password);
            message.pending = false;
            // NOTE: No saveChannels() - messages are not persisted
            this.notifyHandlers('message_confirmed', { streamId, messageId: message.id });
            Logger.debug('Pending message sent:', messageId);
        } catch (error) {
            Logger.error('Failed to retry message:', error);
            this.notifyHandlers('message_failed', { streamId, messageId, error: error.message });
        }
    }
    
    /**
     * Sort messages by timestamp
     * @param {Object} channel - Channel object
     */
    sortMessagesByTimestamp(channel) {
        if (!channel || !channel.messages) return;
        channel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    /**
     * Load more (older) history from MESSAGE stream - for lazy loading / infinite scroll
     * In dual-stream architecture, only messageStream has storage
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @returns {Promise<{loaded: number, hasMore: boolean}>} - Number of messages loaded and if more exist
     */
    async loadMoreHistory(messageStreamId) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) {
            Logger.warn('Channel not found for loadMoreHistory:', messageStreamId);
            return { loaded: 0, hasMore: false };
        }
        
        // Prevent concurrent loads
        if (channel.loadingHistory) {
            Logger.debug('Already loading history, skipping');
            return { loaded: 0, hasMore: channel.hasMoreHistory };
        }
        
        // Check if there's more to load
        if (!channel.hasMoreHistory) {
            Logger.debug('No more history to load');
            return { loaded: 0, hasMore: false };
        }
        
        // Need a reference point (oldest message timestamp)
        if (!channel.oldestTimestamp && channel.messages.length === 0) {
            Logger.debug('No messages yet, cannot load more history');
            return { loaded: 0, hasMore: true };
        }
        
        const beforeTimestamp = channel.oldestTimestamp || Date.now();
        
        channel.loadingHistory = true;
        this.notifyHandlers('history_loading', { streamId: messageStreamId, loading: true });
        
        try {
            Logger.debug('Loading more history before:', new Date(beforeTimestamp).toISOString());
            
            // Fetch from MESSAGE stream (messageStreamId ends with -1)
            const result = await streamrController.fetchOlderHistory(
                messageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, // partition 0
                beforeTimestamp,
                STREAM_CONFIG.LOAD_MORE_COUNT,
                channel.password
            );
            
            if (result.messages.length > 0) {
                // Process and verify each message
                for (const msg of result.messages) {
                    // Skip if already exists
                    if (channel.messages.some(m => m.id === msg.id)) {
                        continue;
                    }
                    
                    // Verify signature (skip timestamp check for historical)
                    try {
                        if (!msg.channelId) msg.channelId = messageStreamId;
                        const verification = await identityManager.verifyMessage(msg, messageStreamId, {
                            skipTimestampCheck: true
                        });
                        msg.verified = verification;
                    } catch (error) {
                        msg.verified = { valid: false, error: error.message, trustLevel: -1 };
                    }
                    
                    channel.messages.push(msg);
                    
                    // Update oldest timestamp
                    if (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp) {
                        channel.oldestTimestamp = msg.timestamp;
                    }
                }
                
                // Sort messages
                this.sortMessagesByTimestamp(channel);
            }
            
            channel.hasMoreHistory = result.hasMore;
            channel.loadingHistory = false;
            
            this.notifyHandlers('history_loaded', { 
                streamId: messageStreamId, 
                loaded: result.messages.length, 
                hasMore: result.hasMore 
            });
            
            Logger.info(`Loaded ${result.messages.length} older messages, hasMore: ${result.hasMore}`);
            
            return { loaded: result.messages.length, hasMore: result.hasMore };
        } catch (error) {
            Logger.error('Failed to load more history:', error);
            channel.loadingHistory = false;
            this.notifyHandlers('history_loading', { streamId: messageStreamId, loading: false });
            return { loaded: 0, hasMore: channel.hasMoreHistory };
        }
    }

    /**
     * Send typing indicator to EPHEMERAL stream
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async sendTypingIndicator(messageStreamId) {
        try {
            const channel = this.channels.get(messageStreamId);
            if (!channel) return;

            // Use ephemeral stream for typing (not stored)
            const ephemeralStreamId = channel.ephemeralStreamId || deriveEphemeralId(messageStreamId);

            const control = {
                type: 'typing',
                user: authManager.getAddress(),
                timestamp: Date.now()
            };

            await streamrController.publishControl(
                ephemeralStreamId,
                control,
                channel.password
            );
        } catch (error) {
            Logger.error('Failed to send typing indicator:', error);
        }
    }

    /**
     * Send reaction to a message
     * @param {string} streamId - Stream ID
     * @param {string} messageId - Message ID to react to
     * @param {string} emoji - Emoji reaction
     * @param {boolean} isRemoving - True if removing reaction
     */
    async sendReaction(streamId, messageId, emoji, isRemoving = false) {
        const action = isRemoving ? 'remove' : 'add';
        
        // DEDUPLICATION: Create unique key for this reaction operation
        // Prevents duplicate sends on rapid clicks
        const reactionKey = `${messageStreamId}:${messageId}:${emoji}:${action}`;
        
        if (this.pendingReactions.has(reactionKey)) {
            Logger.debug('Reaction already pending, skipping duplicate:', reactionKey);
            return; // Silently skip duplicate
        }
        
        this.pendingReactions.add(reactionKey);
        
        try {
            const channel = this.channels.get(messageStreamId);
            if (!channel) return;

            const reaction = {
                type: 'reaction',
                action: action,
                messageId: messageId,
                emoji: emoji,
                user: authManager.getAddress(),
                timestamp: Date.now()
            };

            // Send to MESSAGE stream (stored) via publishReaction
            await streamrController.publishReaction(
                messageStreamId,
                reaction,
                channel.password
            );
            
            Logger.debug('Reaction', action, ':', emoji, 'to message:', messageId);
        } catch (error) {
            Logger.error('Failed to send reaction:', error);
        } finally {
            // Remove from pending after debounce period to prevent rapid re-sends
            setTimeout(() => {
                this.pendingReactions.delete(reactionKey);
            }, this.REACTION_DEBOUNCE_MS);
        }
    }

    /**
     * Leave a channel (unsubscribe from both streams)
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async leaveChannel(messageStreamId) {
        try {
            const channel = this.channels.get(messageStreamId);
            const ephemeralStreamId = channel?.ephemeralStreamId || deriveEphemeralId(messageStreamId);
            
            // Unsubscribe from both streams
            await streamrController.unsubscribeFromDualStream(messageStreamId, ephemeralStreamId);
            
            this.channels.delete(messageStreamId);
            await this.saveChannels();
            
            // Remove from channel order
            await secureStorage.removeFromChannelOrder(messageStreamId);

            if (this.currentChannel === messageStreamId) {
                this.currentChannel = null;
            }

            Logger.debug('Left channel:', messageStreamId);
        } catch (error) {
            Logger.error('Failed to leave channel:', error);
            throw error;
        }
    }

    /**
     * Leave all channels (used on disconnect)
     */
    async leaveAllChannels() {
        try {
            const channelIds = Array.from(this.channels.keys());
            for (const streamId of channelIds) {
                try {
                    await streamrController.unsubscribe(streamId);
                } catch (e) {
                    Logger.warn('Failed to unsubscribe from', streamId, e);
                }
            }
            this.channels.clear();
            this.currentChannel = null;
            this.onlineUsers.clear();
            this.processingMessages.clear();
            this.pendingMessages.clear();
            // Don't clear from localStorage - keep for reconnect
            Logger.debug('Left all channels');
        } catch (error) {
            Logger.error('Failed to leave all channels:', error);
        }
    }

    /**
     * Delete a channel completely (deletes the stream from Streamr network)
     * Only the channel owner can delete a channel
     * @param {string} streamId - Stream ID
     */
    async deleteChannel(streamId) {
        try {
            if (!this.isChannelOwner(streamId)) {
                throw new Error('Only the channel owner can delete a channel');
            }

            // Try to delete the stream from Streamr network
            try {
                await streamrController.deleteStream(streamId);
                Logger.debug('Stream deleted from Streamr network:', streamId);
            } catch (networkError) {
                const chainError = parseChainError(networkError);
                
                // Gas/transaction errors should stop the delete and inform user
                if (chainError.isGasError) {
                    throw new Error(chainError.message);
                }
                
                // Stream might not exist on network or other non-critical error
                // - that's OK, proceed to remove locally
                Logger.warn('Could not delete from network (may not exist):', networkError.message);
            }
            
            // Remove from local storage
            this.channels.delete(streamId);
            await this.saveChannels();
            
            // Remove from channel order
            await secureStorage.removeFromChannelOrder(streamId);

            if (this.currentChannel === streamId) {
                this.currentChannel = null;
            }

            Logger.info('Channel removed:', streamId);
        } catch (error) {
            Logger.error('Failed to delete channel:', error);
            throw error;
        }
    }

    /**
     * Set current active channel
     * @param {string} streamId - Stream ID
     */
    setCurrentChannel(streamId) {
        this.currentChannel = streamId;
    }

    /**
     * Get current channel
     * @returns {Object|null} - Current channel object
     */
    getCurrentChannel() {
        return this.currentChannel ? this.channels.get(this.currentChannel) : null;
    }

    /**
     * Get channel by stream ID
     * @param {string} streamId - Stream ID
     * @returns {Object|null} - Channel object or null
     */
    getChannel(streamId) {
        return this.channels.get(streamId) || null;
    }

    /**
     * Get all channels
     * @returns {Array} - Array of channel objects
     */
    getAllChannels() {
        return Array.from(this.channels.values());
    }

    /**
     * Register a message handler
     * @param {Function} handler - Handler function (event, data)
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }

    /**
     * Notify all handlers
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    notifyHandlers(event, data) {
        for (const handler of this.messageHandlers) {
            try {
                handler(event, data);
            } catch (error) {
                Logger.error('Handler error:', error);
            }
        }
    }

    /**
     * Generate invite link for a channel
     * @param {string} streamId - Stream ID
     * @returns {string} - Invite link
     */
    generateInviteLink(streamId) {
        const channel = this.channels.get(streamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        // Use short keys to minimize QR code data size
        const inviteData = {
            s: streamId,      // streamId
            n: channel.name,  // name
            t: channel.type   // type
        };

        if (channel.password) {
            inviteData.p = channel.password;  // password
        }

        const encoded = btoa(JSON.stringify(inviteData));
        return `${window.location.origin}?invite=${encoded}`;
    }

    /**
     * Parse invite link
     * @param {string} inviteCode - Encoded invite code
     * @returns {Object} - Invite data
     */
    parseInviteLink(inviteCode) {
        try {
            const decoded = atob(inviteCode);
            const data = JSON.parse(decoded);
            
            // Compact format: s=streamId, n=name, t=type, p=password
            return {
                streamId: data.s,
                name: data.n,
                type: data.t,
                password: data.p
            };
        } catch (error) {
            Logger.error('Failed to parse invite link:', error);
            return null;
        }
    }

    // ==================== PUBLIC CHANNEL DISCOVERY ====================

    /**
     * Get public Pombo channels
     * Queries The Graph for streams with Pombo metadata and public permissions
     * @returns {Promise<Array>} - List of public channels
     */
    async getPublicChannels() {
        const channelsMap = new Map(); // Use map to deduplicate by streamId

        // 1. Query The Graph for public Pombo channels
        try {
            Logger.debug('Fetching public channels from The Graph...');
            const graphChannels = await graphAPI.getPublicPomboChannels();
            
            for (const ch of graphChannels) {
                channelsMap.set(ch.streamId, ch);
            }
            Logger.debug(`Found ${graphChannels.length} public channels from The Graph`);
        } catch (error) {
            Logger.warn('Failed to fetch from The Graph:', error.message);
        }

        // 2. Add own public channels (in case Graph hasn't indexed them yet)
        for (const channel of this.channels.values()) {
            if (channel.type === 'public' && !channelsMap.has(channel.streamId)) {
                channelsMap.set(channel.streamId, {
                    streamId: channel.streamId,
                    name: channel.name,
                    createdBy: channel.createdBy,
                    createdAt: channel.createdAt,
                    type: 'public'
                });
            }
        }

        // Convert to array and sort by creation date (newest first)
        const channels = Array.from(channelsMap.values());
        channels.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        return channels;
    }
}

// Export singleton instance
export const channelManager = new ChannelManager();
