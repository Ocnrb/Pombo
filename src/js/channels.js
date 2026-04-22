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
import { identityManager } from './identity.js';
import { secureStorage } from './secureStorage.js';
import { graphAPI } from './graph.js';
import { relayManager } from './relayManager.js';
import { parseChainError } from './utils/chainErrors.js';
import { dmManager } from './dm.js';
import { dmCrypto } from './dmCrypto.js';
import { CONFIG } from './config.js';
import { StorageError } from './utils/errors.js';
import { mediaController } from './media.js';

class ChannelManager {
    constructor() {
        this.channels = new Map(); // streamId -> channel object
        this.currentChannel = null;
        this.switchGeneration = 0; // Incremented on every channel switch to detect stale async results
        this.messageHandlers = [];
        
        // Callback for post-save sync (set by app.js to avoid circular dependency)
        this.onChannelsSaved = null;
        
        // Deduplication: track message IDs currently being processed (receive-side)
        this.processingMessages = new Set();
        
        // Deduplication: track messages currently being sent (send-side)
        // Prevents duplicate sends on rapid clicks or retries
        this.sendingMessages = new Set(); // streamId:messageId
        
        // Deduplication: track reactions currently being sent
        // Prevents duplicate reaction sends on rapid clicks
        this.pendingReactions = new Set(); // streamId:messageId:emoji:action
        this.REACTION_DEBOUNCE_MS = CONFIG.channels.reactionDebounceMs;
        
        // Online presence tracking
        this.onlineUsers = new Map(); // streamId -> Map(userId -> {lastActive, nickname, address})
        this.presenceInterval = null;
        this.ONLINE_TIMEOUT = CONFIG.channels.onlineTimeoutMs;
        this.onlineUsersHandlers = [];
        
        // Pending messages (failed to send, will retry)
        this.pendingMessages = new Map(); // streamId -> [messages]
        this.MAX_RETRIES = CONFIG.channels.maxRetries;
        this.RETRY_DELAY = CONFIG.channels.retryDelayMs;
        
        // OPTIMIZATION: Batch message verification for history loading
        // Messages arriving within BATCH_WINDOW_MS are batched and verified in parallel
        this.pendingVerifications = new Map(); // streamId -> { messages: [], timer: null }
        this.pendingFlushPromises = new Map(); // streamId -> Set<Promise>
        this.BATCH_WINDOW_MS = CONFIG.channels.batchWindowMs;
        this.BATCH_MAX_SIZE = CONFIG.channels.batchMaxSize;
        
        // AbortController for in-flight history fetches - aborted on channel switch
        this.historyAbortController = null;
        
        // Deduplication: track edit/delete operations currently being sent
        this.pendingOverrides = new Set(); // streamId:targetId:type
    }

    /**
     * Load channels from secure storage (encrypted)
     */
    loadChannels() {
        if (!secureStorage.isStorageUnlocked()) {
            Logger.warn('Secure storage not unlocked - cannot load channels');
            return;
        }
        
        const channelsData = secureStorage.getChannels();
        Logger.debug('Loading channels from secure storage');

        if (channelsData && channelsData.length > 0) {
            for (const channel of channelsData) {
                const existing = this.channels.get(channel.messageStreamId);
                
                if (existing) {
                    // Channel already in memory — update metadata only,
                    // preserve in-memory state (messages, reactions, history flags)
                    const preserve = ['messages', 'reactions', 'historyLoaded', 'hasMoreHistory',
                        'loadingHistory', 'oldestTimestamp', 'streamId'];
                    for (const [key, value] of Object.entries(channel)) {
                        if (!preserve.includes(key)) {
                            existing[key] = value;
                        }
                    }
                } else {
                    // New channel — initialize empty runtime state
                    channel.messages = [];
                    channel.reactions = {};
                    channel.historyLoaded = false;
                    channel.hasMoreHistory = true;
                    channel.loadingHistory = false;
                    channel.oldestTimestamp = null;
                    channel.streamId = channel.messageStreamId;
                    this.channels.set(channel.messageStreamId, channel);
                }
            }

            Logger.debug(`Loaded ${channelsData.length} channels from secure storage (metadata only)`);
            Logger.debug('Channels in map:', Array.from(this.channels.keys()));
        } else {
            Logger.debug('No saved channels found');
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
                category: ch.category || '',
                // Channel options
                readOnly: ch.readOnly || false,
                writeOnly: ch.writeOnly || false,
                classification: ch.classification || null,
                // DM-specific
                peerAddress: ch.peerAddress || null,
                inboxStreamId: ch.inboxStreamId || null
                // messages: excluded - loaded from storage
                // reactions: excluded - loaded from storage
            }));
            Logger.debug('Saving channels to secure storage:', channelsData.length);

            await secureStorage.setChannels(channelsData);
            Logger.debug('Channels saved to secure storage (metadata only)');

            // Schedule auto-push to sync (debounced 30s)
            this.onChannelsSaved?.();
        } catch (error) {
            Logger.error('Failed to save channels:', error);
            throw new StorageError(
                'Failed to save channels to secure storage',
                'CHANNELS_SAVE_FAILED',
                { cause: error }
            );
        }
    }

    /**
     * Clear channels when switching wallets
     */
    clearChannels() {
        this.channels.clear();
        this.setCurrentChannel(null);
        this.onlineUsers.clear();
        this.processingMessages.clear();
        this.pendingMessages.clear();
        this.sendingMessages.clear();
        this.pendingReactions.clear();
        // Cancel all pending batch verifications
        for (const [streamId, batch] of this.pendingVerifications) {
            if (batch.timer) clearTimeout(batch.timer);
        }
        this.pendingVerifications.clear();
        this.pendingFlushPromises.clear();
        this.pendingOverrides.clear();
        Logger.debug('Channels cleared from memory');
    }

    /**
     * Create a new channel
     * @param {string} name - Channel name
     * @param {string} type - Channel type: 'public', 'password', 'native'
     * @param {string} password - Password for encrypted channels (optional)
     * @param {string[]} members - Member addresses for native private channels (optional)
     * @param {Object} options - Additional options
     * @param {string} options.exposure - 'visible' or 'hidden'
     * @param {string} options.storageProvider - 'streamr' or 'logstore' (default: 'streamr')
     * @param {number} options.storageDays - Retention days (for Streamr, default: 180)
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
            // Pass storage options (provider, days)
            let storageResult = { success: false, provider: null, storageDays: null };
            try {
                storageResult = await streamrController.enableStorage(streamInfo.messageStreamId, {
                    storageProvider: options.storageProvider,
                    storageDays: options.storageDays
                });
                Logger.debug('Storage result:', storageResult);
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
            
            // Classification for local organization (any channel type)
            // Default to 'personal' for native, null for others unless specified
            const classification = options.classification || (type === 'native' ? 'personal' : null);
            
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
                storageEnabled: storageResult.success,
                // Storage configuration
                storageProvider: storageResult.provider || 'streamr',
                storageDays: storageResult.storageDays,
                // Exposure and metadata (for visible channels)
                exposure: exposure,
                description: exposure === 'visible' ? (options.description || '') : '',
                language: exposure === 'visible' ? (options.language || 'en') : '',
                category: exposure === 'visible' ? (options.category || 'general') : '',
                classification: classification,
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
            
            // Auto-enable notifications for this channel if global notifications are enabled
            if (relayManager.enabled) {
                try {
                    if (type === 'native') {
                        await relayManager.subscribeToNativeChannel(channel.messageStreamId);
                    } else {
                        await relayManager.subscribeToChannel(channel.messageStreamId);
                    }
                    Logger.debug('Auto-enabled notifications for created channel');
                } catch (err) {
                    Logger.warn('Failed to auto-enable notifications:', err.message);
                }
            }
            
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
            
            // OPTIMIZATION: Run SDK permission check and Graph API calls in PARALLEL
            // This significantly speeds up the join process
            Logger.debug('Checking permissions and channel info in parallel...');
            
            const needGraphData = !channelType || !createdBy;
            
            const [permissions, graphResult] = await Promise.all([
                // 1. SDK permission check (blockchain RPC calls)
                streamrController.checkPermissions(messageStreamId),
                
                // 2. Graph API calls (only if needed) - detectStreamType and getStreamMembers
                //    share cached getStreamPermissions() internally, so they're efficient together
                needGraphData ? (async () => {
                    try {
                        const [detectedType, membersResult] = await Promise.all([
                            !channelType ? graphAPI.detectStreamType(messageStreamId) : Promise.resolve(channelType),
                            graphAPI.getStreamMembers(messageStreamId)
                        ]);
                        return { success: true, detectedType, streamMembers: membersResult.ok ? membersResult.data : [] };
                    } catch (graphError) {
                        Logger.warn('Graph API failed, falling back to inference:', graphError.message);
                        return { success: false, error: graphError };
                    }
                })() : Promise.resolve({ success: true, detectedType: channelType, streamMembers: [] })
            ]);
            
            Logger.debug('Permissions result:', permissions);

            // User needs at least one permission (publish OR subscribe) to join
            // Many-to-one streams may grant only publish (public) without subscribe
            if (!permissions.canSubscribe && !permissions.canPublish) {
                throw new Error('You do not have permission to access this channel. This is a private channel and you are not a member.');
            }
            
            // Process Graph API results
            if (graphResult.success) {
                if (!channelType) {
                    channelType = graphResult.detectedType;
                    Logger.debug('Detected type:', channelType);
                }
                
                const streamMembers = graphResult.streamMembers;
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
            } else {
                // Default to native for safety - it's better to assume private than public
                channelType = password ? 'password' : 'native';
            }
            
            // Final fallback - default to native (private) instead of public
            // The Graph may take time to index, so unknown likely means native
            if (!channelType || channelType === 'unknown') {
                Logger.debug('Type unknown, defaulting to native (private)');
                channelType = password ? 'password' : 'native';
            }
            
            // Extract name from streamId if not provided (simplified ID format)
            // For Closed channels, use localName from options (user-provided)
            let channelName = options.localName || options.name || messageStreamId.split('/')[1]?.replace(/-\d$/, '') || messageStreamId;
            
            // Classification for local organization (any channel type)
            const classification = options.classification || (channelType === 'native' ? 'personal' : null);

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
                classification: classification,
                readOnly: options.readOnly || false,
                writeOnly: permissions.canPublish && !permissions.canSubscribe,
                // Lazy loading state (not persisted)
                historyLoaded: false,
                hasMoreHistory: true,
                loadingHistory: false,
                oldestTimestamp: null
            };

            // Cache permissions from SDK check (done earlier)
            const currentAddress = authManager.getAddress();
            if (currentAddress) {
                channel._publishPermCache = {
                    address: currentAddress,
                    canPublish: permissions.canPublish,
                    timestamp: Date.now()
                };
            }

            // Add to channels map (keyed by messageStreamId)
            this.channels.set(messageStreamId, channel);
            
            // OPTIMIZATION: Run storage saves and subscription in parallel
            // Channel is already in memory, so subscription can start immediately
            // Skip network subscription for write-only channels (no subscribe permission)
            const tasks = [
                this.saveChannels(),
                secureStorage.addToChannelOrder(messageStreamId)
            ];
            if (permissions.canSubscribe) {
                tasks.push(this.subscribeToChannel(messageStreamId, password));
            } else {
                Logger.info('Write-only channel - skipping subscription (no subscribe permission)');
            }
            await Promise.all(tasks);

            // Notify handlers about channel join (for media seeding re-announcement)
            // Include permissions info so UI can show appropriate feedback
            this.notifyHandlers('channelJoined', { 
                streamId: messageStreamId, 
                messageStreamId,
                ephemeralStreamId,
                password, 
                channel,
                permissions: {
                    canPublish: permissions.canPublish,
                    canSubscribe: permissions.canSubscribe,
                    isOwner: permissions.isOwner
                }
            });

            // Log access mode warnings
            if (!permissions.canPublish) {
                Logger.warn('Joined channel with read-only access (no publish permission)');
            }
            if (!permissions.canSubscribe) {
                Logger.warn('Joined channel with write-only access (no subscribe permission)');
            }

            Logger.info('Joined dual-stream channel:', messageStreamId);
            
            // Auto-enable notifications for this channel if global notifications are enabled
            if (relayManager.enabled) {
                try {
                    if (channelType === 'native') {
                        await relayManager.subscribeToNativeChannel(messageStreamId);
                    } else {
                        await relayManager.subscribeToChannel(messageStreamId);
                    }
                    Logger.debug('Auto-enabled notifications for new channel');
                } catch (err) {
                    Logger.warn('Failed to auto-enable notifications:', err.message);
                }
            }
            
            return channel;
        } catch (error) {
            Logger.error('Failed to join channel:', error);
            throw error;
        }
    }

    /**
     * OPTIMIZED: Persist a channel from preview mode (already subscribed)
     * This is much faster than joinChannel() because:
     * - Skips permission checks (preview already worked = has permission)
     * - Skips Graph API calls (uses info from preview)
     * - Skips subscription (already subscribed via preview)
     * 
     * @param {string} messageStreamId - Message Stream ID
     * @param {Object} previewInfo - Info from preview: { name, type, createdBy, readOnly, messages, reactions }
     * @returns {Promise<Object>} - Persisted channel
     */
    async persistChannelFromPreview(messageStreamId, previewInfo = {}) {
        try {
            const ephemeralStreamId = deriveEphemeralId(messageStreamId);
            
            // Check if already joined
            if (this.channels.has(messageStreamId)) {
                Logger.debug('Channel already in list');
                return this.channels.get(messageStreamId);
            }

            Logger.debug('Persisting channel from preview:', messageStreamId);

            // Extract info from preview (already validated by successful preview)
            const channelType = previewInfo.type || 'public';
            const channelName = previewInfo.name || messageStreamId.split('/')[1]?.replace(/-\d$/, '') || messageStreamId;
            // Classification for local organization (any channel type)
            const classification = previewInfo.classification || (channelType === 'native' ? 'personal' : null);

            // IMPORTANT: Transfer messages and reactions from preview
            const previewMessages = Array.isArray(previewInfo.messages) ? previewInfo.messages : [];
            const previewReactions = previewInfo.reactions || {};

            const channel = {
                messageStreamId: messageStreamId,
                ephemeralStreamId: ephemeralStreamId,
                streamId: messageStreamId,
                name: channelName,
                type: channelType,
                createdAt: Date.now(),
                createdBy: previewInfo.createdBy || null,
                password: null, // Preview doesn't support password channels yet
                members: [],
                messages: previewMessages,  // Transfer messages from preview
                reactions: previewReactions, // Transfer reactions from preview
                classification: classification,
                readOnly: previewInfo.readOnly || false,
                historyLoaded: previewMessages.length > 0,  // Mark as loaded if we have messages
                hasMoreHistory: true,
                loadingHistory: false,
                oldestTimestamp: previewMessages.length > 0 
                    ? previewMessages[0]?.timestamp 
                    : (previewInfo.oldestTimestamp || null)
            };

            // Add to channels map
            this.channels.set(messageStreamId, channel);
            
            // Save to storage (parallel)
            await Promise.all([
                this.saveChannels(),
                secureStorage.addToChannelOrder(messageStreamId)
            ]);

            // Notify handlers
            this.notifyHandlers('channelJoined', { 
                streamId: messageStreamId, 
                messageStreamId,
                ephemeralStreamId,
                channel,
                fromPreview: true
            });

            Logger.info('Channel persisted from preview:', messageStreamId);
            
            // Auto-enable notifications for this channel if global notifications are enabled
            if (relayManager.enabled) {
                try {
                    if (channelType === 'native') {
                        await relayManager.subscribeToNativeChannel(messageStreamId);
                    } else {
                        await relayManager.subscribeToChannel(messageStreamId);
                    }
                    Logger.debug('Auto-enabled notifications for channel from preview');
                } catch (err) {
                    Logger.warn('Failed to auto-enable notifications:', err.message);
                }
            }
            
            return channel;
        } catch (error) {
            Logger.error('Failed to persist channel from preview:', error);
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
            Logger.warn('Channel not found for sync:', messageStreamId);
            return null;
        }

        try {
            Logger.debug('Syncing channel from The Graph:', messageStreamId);
            
            // OPTIMIZATION: Fetch all Graph data in parallel
            const [streamData, type, membersResult] = await Promise.all([
                graphAPI.getStream(messageStreamId),
                graphAPI.detectStreamType(messageStreamId),
                graphAPI.getStreamMembers(messageStreamId)
            ]);
            
            if (!streamData) {
                Logger.warn('Stream not found in The Graph');
                return channel;
            }

            // Update type based on permissions
            if (type !== 'unknown') {
                channel.type = type;
            }

            const members = membersResult.ok ? membersResult.data : [];

            // Update members
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
            const membersResult = await graphAPI.getStreamMembers(streamId);
            const graphMembers = membersResult.ok ? membersResult.data : [];
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
        try {
            await this.saveChannels();
        } catch (e) {
            Logger.error('Failed to persist member cache:', e);
        }

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
        
        // DM-2 ephemeral lifecycle: unsubscribe when leaving a DM conversation
        if (channel?.type !== 'dm') {
            dmManager.unsubscribeDMEphemeral();
        }
        
        // Skip network subscription for write-only channels (no subscribe permission)
        // Instead, load locally persisted sent messages and reactions
        if (channel?.writeOnly) {
            Logger.debug('Write-only channel - loading local data:', messageStreamId);
            const sentMessages = secureStorage.getSentMessages(messageStreamId);
            if (sentMessages.length > 0) {
                // Filter out messages already in channel (avoid duplicates on re-select)
                const existingIds = new Set(channel.messages.map(m => m.id));
                const newMessages = sentMessages.filter(m => !existingIds.has(m.id));
                if (newMessages.length > 0) {
                    // Mark all as verified (they're our own messages)
                    for (const msg of newMessages) {
                        msg.verified = { valid: true, trustLevel: 2 };
                        channel.messages.push(msg);
                    }
                    this.sortMessagesByTimestamp(channel);
                    Logger.info(`Loaded ${newMessages.length} local sent messages for write-only channel`);
                }
            }
            // Load persisted reactions
            const sentReactions = secureStorage.getSentReactions(messageStreamId);
            if (Object.keys(sentReactions).length > 0) {
                channel.reactions = sentReactions;
                Logger.info('Loaded local reactions for write-only channel');
            }
            channel.historyLoaded = true;
            channel.hasMoreHistory = false;
            return;
        }

        // DM channels: load merged timeline (sent local + received from inbox)
        if (channel?.type === 'dm') {
            Logger.debug('DM channel - loading merged timeline:', messageStreamId);
            // Gate renders while loading — inbox messages may still arrive via routeInboxMessage()
            channel.initialLoadInProgress = true;
            await dmManager.loadDMTimeline(channel.peerAddress);
            channel.historyLoaded = true;
            // Enable scroll-up pagination for DMs — set oldestTimestamp from loaded messages
            if (channel.messages.length > 0) {
                const oldest = channel.messages.reduce((min, m) => m.timestamp < min ? m.timestamp : min, channel.messages[0].timestamp);
                channel.oldestTimestamp = oldest;
                channel.hasMoreHistory = true;
            } else {
                channel.hasMoreHistory = false;
            }
            // Subscribe to DM-2 ephemeral on-demand (typing/presence)
            dmManager.subscribeDMEphemeral();
            // Clear gate and notify UI to re-render with ENS data
            channel.initialLoadInProgress = false;
            this.notifyHandlers('initial_history_complete', { streamId: messageStreamId });
            return;
        }

        // Get or derive ephemeral stream ID
        const ephemeralStreamId = channel?.ephemeralStreamId || deriveEphemeralId(messageStreamId);

        // Detect whether this stream supports dedicated control partition (P1)
        let hasControlPartition = true;
        try {
            const partitionCount = await streamrController.getStreamPartitionCount(messageStreamId);
            hasControlPartition = partitionCount >= 2;
            channel._controlPartitionSupported = hasControlPartition;
            Logger.debug('Message stream partition capability:', {
                streamId: messageStreamId.slice(-20),
                partitionCount,
                hasControlPartition
            });
        } catch (e) {
            // Fail-open for compatibility if partition introspection fails
            hasControlPartition = true;
            channel._controlPartitionSupported = true;
            Logger.warn('Could not determine stream partition count, assuming control partition support:', e.message);
        }

        // Mark channel as loading initial history (suppresses per-message renders)
        if (channel) {
            channel.initialLoadInProgress = true;
        }

        // Use dual-stream subscription with onHistoryComplete callback
        const onHistoryComplete = async () => {
            if (!channel || !channel.initialLoadInProgress) return;
            
            // Flush any remaining batch verifications
            await this.flushBatchVerification(messageStreamId);
            
            // Await ALL in-flight flush promises (may have been fired before onHistoryComplete)
            await this.awaitAllFlushes(messageStreamId);
            
            // Apply pending overrides and remove deleted messages before first render
            this.applyPendingOverrides(channel);
            channel.messages = channel.messages.filter(m => !m._deleted);
            
            channel.initialLoadInProgress = false;
            Logger.debug('Initial history load complete for', messageStreamId.slice(-20));
            
            this.notifyHandlers('initial_history_complete', { streamId: messageStreamId });
        };

        await streamrController.subscribeToDualStream(
            messageStreamId,
            ephemeralStreamId,
            {
                onMessage: (data) => this.handleTextMessage(messageStreamId, data),
                onOverride: hasControlPartition
                    ? (data) => this.handleOverrideMessage(
                        messageStreamId,
                        data,
                        channel?.initialLoadInProgress ?? false
                    )
                    : null,
                allowOverridesInContentPartition: !hasControlPartition,
                onControl: (data) => this.handleControlMessage(messageStreamId, data),
                onMedia: (data, senderId) => this.handleMediaMessage(messageStreamId, data, senderId)
            },
            pwd,
            STREAM_CONFIG.INITIAL_MESSAGES,
            onHistoryComplete
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

    // ==================== Message Edit/Delete (Append-Only Overrides) ====================

    /**
     * Handle an edit or delete override message (real-time or from history)
     * Validates senderId matches original message sender, then applies the override.
     * @param {string} streamId - Stream ID
     * @param {Object} data - Override message { type: 'edit'|'delete', targetId, text?, senderId, timestamp }
     * @param {boolean} [fromHistory=false] - Whether this is from history replay (skip notification)
     */
    handleOverrideMessage(streamId, data, fromHistory = false) {
        const channel = this.channels.get(streamId);
        if (!channel) return;

        const senderId = data.senderId;
        if (!senderId || !data.targetId) return;

        // Find the original message
        const original = channel.messages.find(m => m.id === data.targetId);

        if (!original) {
            // Message not loaded yet — store as pending override to apply later
            if (!(channel._pendingOverrides instanceof Map)) channel._pendingOverrides = new Map();
            const existing = channel._pendingOverrides.get(data.targetId);
            // Keep only the latest override per targetId
            if (!existing || data.timestamp > existing.timestamp) {
                channel._pendingOverrides.set(data.targetId, data);
            }
            return;
        }

        // SECURITY: Only the original sender can edit/delete their message
        if (original.sender?.toLowerCase() !== senderId.toLowerCase()) {
            Logger.warn('Override rejected: sender mismatch', { 
                originalSender: original.sender, overrideSender: senderId 
            });
            return;
        }

        // Apply the override
        if (data.type === 'edit') {
            if (!data.text) return;
            original.text = data.text;
            original._edited = true;
            original._editedAt = data.timestamp;
        } else if (data.type === 'delete') {
            // Remove from messages array
            const idx = channel.messages.indexOf(original);
            if (idx >= 0) channel.messages.splice(idx, 1);
        }

        if (!fromHistory) {
            this.notifyHandlers(data.type === 'edit' ? 'message_edited' : 'message_deleted', {
                streamId,
                targetId: data.targetId
            });
        }
    }

    /**
     * Apply any pending overrides to messages that just arrived (e.g. from history)
     * Called after messages are added to channel.messages
     * @param {Object} channel - Channel object
     */
    applyPendingOverrides(channel) {
        if (!(channel._pendingOverrides instanceof Map) || channel._pendingOverrides.size === 0) return;
        
        const applied = [];
        for (const [targetId, override] of channel._pendingOverrides) {
            const msg = channel.messages.find(m => m.id === targetId);
            if (!msg) continue;
            
            // Verify sender match
            if (msg.sender?.toLowerCase() !== override.senderId?.toLowerCase()) continue;
            
            if (override.type === 'edit' && override.text) {
                msg.text = override.text;
                msg._edited = true;
                msg._editedAt = override.timestamp;
            } else if (override.type === 'delete') {
                msg._deleted = true;
                msg._deletedAt = override.timestamp;
            }
            applied.push(targetId);
        }
        
        for (const id of applied) {
            channel._pendingOverrides.delete(id);
        }
    }

    /**
     * Send an edit for a previously sent message
     * @param {string} streamId - Message Stream ID (channel key)
     * @param {string} targetId - ID of the message to edit
     * @param {string} newText - New text content
     */
    async sendEdit(streamId, targetId, newText) {
        if (!newText?.trim()) throw new Error('Edit text cannot be empty');
        
        const channel = this.channels.get(streamId);
        if (!channel) throw new Error('Channel not found');

        // DM channels: route through DMManager
        if (channel.type === 'dm') {
            return await dmManager.sendEdit(streamId, targetId, newText);
        }

        const overrideKey = `${streamId}:${targetId}:edit`;
        if (this.pendingOverrides.has(overrideKey)) return;
        this.pendingOverrides.add(overrideKey);

        try {
            const original = channel.messages.find(m => m.id === targetId);
            if (!original) throw new Error('Message not found');
            
            const myAddress = authManager.getAddress();
            if (original.sender?.toLowerCase() !== myAddress?.toLowerCase()) {
                throw new Error('Can only edit your own messages');
            }

            const override = {
                type: 'edit',
                targetId,
                text: newText.trim(),
                timestamp: Date.now()
            };

            // Apply locally first (optimistic)
            original.text = override.text;
            original._edited = true;
            original._editedAt = override.timestamp;

            this.notifyHandlers('message_edited', { streamId, targetId });

            // Publish to control partition when available, else fallback to content partition
            const overridePartition = channel?._controlPartitionSupported === false
                ? STREAM_CONFIG.MESSAGE_STREAM.MESSAGES
                : STREAM_CONFIG.MESSAGE_STREAM.CONTROL;
            await streamrController.publish(
                streamId,
                overridePartition,
                override,
                channel.password
            );
            Logger.debug('Edit published for message:', targetId);
        } finally {
            setTimeout(() => this.pendingOverrides.delete(overrideKey), 2000);
        }
    }

    /**
     * Send a delete for a previously sent message
     * @param {string} streamId - Message Stream ID (channel key)
     * @param {string} targetId - ID of the message to delete
     */
    async sendDelete(streamId, targetId) {
        const channel = this.channels.get(streamId);
        if (!channel) throw new Error('Channel not found');

        // DM channels: route through DMManager
        if (channel.type === 'dm') {
            return await dmManager.sendDelete(streamId, targetId);
        }

        const overrideKey = `${streamId}:${targetId}:delete`;
        if (this.pendingOverrides.has(overrideKey)) return;
        this.pendingOverrides.add(overrideKey);

        try {
            const original = channel.messages.find(m => m.id === targetId);
            if (!original) throw new Error('Message not found');
            
            const myAddress = authManager.getAddress();
            if (original.sender?.toLowerCase() !== myAddress?.toLowerCase()) {
                throw new Error('Can only delete your own messages');
            }

            const override = {
                type: 'delete',
                targetId,
                timestamp: Date.now()
            };

            // Apply locally first (optimistic) — remove from messages array
            const idx = channel.messages.indexOf(original);
            if (idx >= 0) channel.messages.splice(idx, 1);

            this.notifyHandlers('message_deleted', { streamId, targetId });

            // Publish to control partition when available, else fallback to content partition
            const overridePartition = channel?._controlPartitionSupported === false
                ? STREAM_CONFIG.MESSAGE_STREAM.MESSAGES
                : STREAM_CONFIG.MESSAGE_STREAM.CONTROL;
            await streamrController.publish(
                streamId,
                overridePartition,
                override,
                channel.password
            );
            Logger.debug('Delete published for message:', targetId);
        } finally {
            setTimeout(() => this.pendingOverrides.delete(overrideKey), 2000);
        }
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
        
        // Use senderId from Streamr SDK (cryptographically guaranteed) over self-reported userId
        const userId = presenceData.senderId || presenceData.userId;
        if (!userId) return;

        const users = this.onlineUsers.get(streamId);
        users.set(userId, {
            lastActive: presenceData.lastActive || Date.now(),
            nickname: presenceData.nickname || null,
            address: userId
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
        
        // DM channels: E2E encrypt, minimal payload (senderId from SDK provides identity)
        if (channel.type === 'dm' && channel.peerAddress) {
            const privateKey = authManager.wallet?.privateKey;
            if (privateKey) {
                const peerPubKey = await dmManager.getPeerPublicKey(channel.peerAddress);
                if (peerPubKey) {
                    try {
                        const aesKey = await dmCrypto.getSharedKey(privateKey, channel.peerAddress, peerPubKey);
                        const encrypted = await dmCrypto.encrypt({
                            type: 'presence',
                            nickname: identityManager.getUsername?.() || null,
                            lastActive: Date.now()
                        }, aesKey);
                        // Set Pombo key for publishing to peer's ephemeral stream
                        await streamrController.setDMPublishKey(ephemeralStreamId);
                        await streamrController.publishControl(ephemeralStreamId, encrypted, null);
                    } catch (e) {
                        Logger.warn('Failed to publish DM presence:', e.message);
                    }
                }
            }
            return;
        }
        
        // Non-DM channels: no self-reported userId/address (senderId from SDK provides identity)
        const myNickname = identityManager.getUsername?.() || null;
        
        const presenceData = {
            type: 'presence',
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
        // Tear down DM-2 ephemeral when leaving any channel
        dmManager.unsubscribeDMEphemeral();
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
        // Use senderId from Streamr SDK (cryptographically guaranteed) instead of self-reported fields
        if (data.type === 'typing') {
            this.notifyHandlers('typing', { streamId, user: data.senderId || data.user, nickname: data.nickname || null });
        } else if (data.type === 'presence') {
            // Handle presence update
            this.handlePresenceMessage(streamId, data);
        } else if (data.type === 'reaction') {
            // Someone reacted to a message - store in memory only
            const reactionUser = data.senderId || data.user;
            const channel = this.channels.get(streamId);
            if (channel && data.messageId && data.emoji && reactionUser) {
                this.storeReaction(channel, data.messageId, data.emoji, reactionUser, data.action || 'add');
                // NOTE: No saveChannels() - reactions are not persisted, only in RAM
            }
            
            // Notify handlers to update UI
            this.notifyHandlers('reaction', { 
                streamId, 
                messageId: data.messageId,
                emoji: data.emoji,
                user: reactionUser,
                action: data.action || 'add'
            });
        } else if (data.type === 'member_update') {
            const channel = this.channels.get(streamId);
            if (channel) {
                channel.members = data.members;
                try {
                    await this.saveChannels();
                } catch (e) {
                    Logger.error('Failed to persist member update:', e);
                }
            }
        }
    }

    /**
     * Handle text message (real-time and historical)
     * Uses batch processing for historical messages to improve performance
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
        
        // Edit/Delete overrides are normally handled on message stream partition 1 via onOverride.
        // For streams without control partition support, accept overrides on content path.
        if (data?.type === 'edit' || data?.type === 'delete') {
            const channel = this.channels.get(streamId);
            if (channel?._controlPartitionSupported === false) {
                this.handleOverrideMessage(streamId, data, channel?.initialLoadInProgress ?? false);
                return;
            }
            Logger.debug('Ignoring override on content handler path:', data?.type);
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
        
        // Add channelId if missing (for backwards compatibility)
        if (!data.channelId) {
            data.channelId = streamId;
        }

        // OPTIMIZATION: Use batch processing for historical messages
        // Real-time messages are processed immediately for best UX
        if (!isRecentMessage) {
            this.queueMessageForBatchVerification(streamId, data, channel);
            return;
        }

        // Real-time message: verify immediately
        try {
            const verification = await identityManager.verifyMessage(data, streamId, {
                skipTimestampCheck: false
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

        // Notify handlers
        this.notifyHandlers('message', { streamId, message: data });
    }
    
    /**
     * Queue a historical message for batch verification
     * Messages are batched and verified in parallel for better performance
     * @private
     */
    queueMessageForBatchVerification(streamId, data, channel) {
        // Get or create batch queue for this stream
        if (!this.pendingVerifications.has(streamId)) {
            this.pendingVerifications.set(streamId, { messages: [], timer: null });
        }
        
        const batch = this.pendingVerifications.get(streamId);
        batch.messages.push({ data, channel });
        
        // Flush immediately if batch is full
        if (batch.messages.length >= this.BATCH_MAX_SIZE) {
            if (batch.timer) {
                clearTimeout(batch.timer);
                batch.timer = null;
            }
            this._trackFlush(streamId, this.flushBatchVerification(streamId));
            return;
        }
        
        // Set or reset timer for batch flush
        if (batch.timer) {
            clearTimeout(batch.timer);
        }
        batch.timer = setTimeout(() => {
            this._trackFlush(streamId, this.flushBatchVerification(streamId));
        }, this.BATCH_WINDOW_MS);
    }
    
    /**
     * Flush pending batch verifications for a stream
     * @private
     */
    async flushBatchVerification(streamId) {
        const batch = this.pendingVerifications.get(streamId);
        if (!batch || batch.messages.length === 0) {
            return;
        }
        
        // Clear the batch
        const messagesToProcess = batch.messages;
        batch.messages = [];
        batch.timer = null;
        
        const generationAtStart = this.switchGeneration;
        
        Logger.debug(`Batch verifying ${messagesToProcess.length} historical messages for ${streamId.slice(-20)}`);
        
        // Verify all messages in parallel using Promise.all
        const verificationPromises = messagesToProcess.map(async ({ data, channel }) => {
            try {
                const verification = await identityManager.verifyMessage(data, streamId, {
                    skipTimestampCheck: true
                });
                data.verified = verification;
            } catch (error) {
                data.verified = { valid: false, error: error.message, trustLevel: -1 };
            }
            return { data, channel };
        });
        
        const verifiedMessages = await Promise.all(verificationPromises);
        
        // Discard results if user switched channels during batch verification
        if (this.switchGeneration !== generationAtStart) {
            Logger.debug('Channel switched during batch verification, discarding results for', streamId.slice(-20));
            return;
        }
        
        // Add all verified messages to channel
        let addedCount = 0;
        for (const { data, channel } of verifiedMessages) {
            // Double-check channel still exists and message not already added
            if (!channel || !this.channels.has(streamId)) {
                continue;
            }
            if (channel.messages.some(m => m.id === data.id)) {
                continue;
            }
            
            channel.messages.push(data);
            addedCount++;
            
            // Update oldest timestamp
            if (!channel.oldestTimestamp || data.timestamp < channel.oldestTimestamp) {
                channel.oldestTimestamp = data.timestamp;
            }
        }
        
        if (addedCount > 0) {
            // Sort messages once after adding all
            const channel = this.channels.get(streamId);
            if (channel) {
                this.sortMessagesByTimestamp(channel);
                
                // Apply any pending overrides whose targets were just added
                this.applyPendingOverrides(channel);
            }
            
            // Notify handlers with batch completion event
            this.notifyHandlers('history_batch_loaded', { 
                streamId, 
                loaded: addedCount,
                total: messagesToProcess.length
            });
            
            Logger.debug(`Batch verification complete: ${addedCount}/${messagesToProcess.length} messages added`);
        }
    }

    /**
     * Track a flush promise for later awaiting
     * @private
     */
    _trackFlush(streamId, promise) {
        if (!this.pendingFlushPromises.has(streamId)) {
            this.pendingFlushPromises.set(streamId, new Set());
        }
        const set = this.pendingFlushPromises.get(streamId);
        set.add(promise);
        promise.finally(() => {
            set.delete(promise);
            if (set.size === 0) {
                this.pendingFlushPromises.delete(streamId);
            }
        });
    }

    /**
     * Await all in-flight flush promises for a stream
     * @private
     */
    async awaitAllFlushes(streamId) {
        const set = this.pendingFlushPromises.get(streamId);
        if (set && set.size > 0) {
            await Promise.all([...set]);
        }
    }

    /**
     * Handle media message (JSON from MEDIA_SIGNALS or binary from MEDIA_DATA)
     * @param {string} streamId - Stream ID
     * @param {Object|Uint8Array} data - Media data (JSON object or binary)
     * @param {string} [senderId] - Publisher ID (provided for binary messages)
     */
    handleMediaMessage(streamId, data, senderId) {
        // CRITICAL: Check if still connected before processing
        if (!authManager.isConnected()) {
            return;
        }
        
        // Binary data from MEDIA_DATA partition — delegate to mediaController for decoding
        if (data instanceof Uint8Array) {
            mediaController.handleMediaMessage(streamId, data, senderId);
            return;
        }
        
        // Skip control messages (presence, typing, reactions) - these belong on control partition
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

            // DM channels: route through DMManager
            if (channel.type === 'dm') {
                return await dmManager.sendMessage(messageStreamId, text, replyTo);
            }

            // Check publish permission using Streamr SDK (real-time on-chain check)
            // This applies to ALL channel types - the SDK handles public permissions correctly
            const currentAddress = authManager.getAddress();
            if (!currentAddress) {
                throw new Error('Not authenticated');
            }

            // Check cached permission first (set by UI or previous check)
            let canPublish = false;
            const cacheValid = channel._publishPermCache?.address?.toLowerCase() === currentAddress.toLowerCase() &&
                              channel._publishPermCache?.timestamp && 
                              (Date.now() - channel._publishPermCache.timestamp) < 60000; // 1 min cache
            
            if (cacheValid) {
                canPublish = channel._publishPermCache.canPublish;
            } else {
                // Check via Streamr SDK (real-time on-chain)
                try {
                    const result = await streamrController.hasPublishPermission(messageStreamId, true);
                    
                    // Handle RPC error - be optimistic and try to publish anyway
                    if (result.rpcError) {
                        Logger.warn('RPC error checking publish permission, proceeding optimistically');
                        canPublish = true;
                    } else {
                        canPublish = result.hasPermission;
                        // Cache the result (only if we got a definitive answer)
                        channel._publishPermCache = {
                            address: currentAddress,
                            canPublish: canPublish,
                            timestamp: Date.now()
                        };
                    }
                    Logger.debug('Publish permission check via SDK:', { streamId: messageStreamId, canPublish, rpcError: result.rpcError });
                } catch (error) {
                    Logger.warn('Failed to check publish permission via SDK:', error);
                    // On error, try to publish anyway - the network will reject if no permission
                    canPublish = true;
                }
            }

            if (!canPublish) {
                throw new Error('You do not have permission to send messages in this channel.');
            }

            // DEDUPLICATION: Use content-based key to block duplicate sends synchronously
            // This key is created BEFORE the async createSignedMessage to prevent
            // two rapid clicks from both passing the check before either adds to the Set
            sendKey = `${messageStreamId}:${text}:${replyTo || ''}`;
            if (this.sendingMessages.has(sendKey)) {
                Logger.warn('Duplicate send blocked (same content already in flight)');
                return;
            }
            this.sendingMessages.add(sendKey);

            // Create signed message using identity manager
            message = await identityManager.createSignedMessage(text, messageStreamId, replyTo);

            // Add verification info for local display (includes ENS for badge + display name)
            message.verified = {
                valid: true,
                trustLevel: await identityManager.getTrustLevel(message.sender),
                ensName: await identityManager.resolveENS(message.sender)
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
            
            // For write-only channels, persist sent messages locally
            // (no subscribe permission = can't fetch history from network)
            if (channel.writeOnly) {
                await secureStorage.addSentMessage(messageStreamId, message);
            }
            
            // Notify UI that message is confirmed
            this.notifyHandlers('message_confirmed', { streamId: messageStreamId, messageId: message.id });

            // Send wake signals to other channel members (async, don't await)
            this.sendWakeSignals(messageStreamId).catch(err => {
                Logger.debug('Wake signals failed (non-critical):', err.message);
            });

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

        // Write-only channels have no network history access
        if (channel.writeOnly) {
            return { loaded: 0, hasMore: false };
        }

        // DM channels: paginate from inbox stream via dmManager
        if (channel.type === 'dm') {
            if (channel.loadingHistory) {
                return { loaded: 0, hasMore: channel.hasMoreHistory };
            }
            if (!channel.hasMoreHistory) {
                return { loaded: 0, hasMore: false };
            }
            channel.loadingHistory = true;
            this.historyAbortController = new AbortController();
            const signal = this.historyAbortController.signal;
            const generationAtStart = this.switchGeneration;
            try {
                const result = await dmManager.fetchOlderDMMessages(channel.peerAddress, signal);
                if (this.switchGeneration !== generationAtStart) {
                    channel.loadingHistory = false;
                    return { loaded: 0, hasMore: channel.hasMoreHistory };
                }
                channel.loadingHistory = false;
                return result;
            } catch (error) {
                Logger.error('DM: loadMoreHistory failed:', error);
                channel.loadingHistory = false;
                return { loaded: 0, hasMore: channel.hasMoreHistory };
            }
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
        
        // Use oldest message timestamp, or Date.now() if history was only reactions
        const beforeTimestamp = channel.oldestTimestamp || Date.now();
        
        channel.loadingHistory = true;
        this.notifyHandlers('history_loading', { streamId: messageStreamId, loading: true });
        
        const generationAtStart = this.switchGeneration;
        
        // Create AbortController for this fetch - will be aborted on channel switch
        this.historyAbortController = new AbortController();
        const signal = this.historyAbortController.signal;
        
        try {
            Logger.debug('Loading more history before:', new Date(beforeTimestamp).toISOString());
            const supportsControlPartition = channel?._controlPartitionSupported !== false;
            
            // Fetch from MESSAGE stream partition 0 (content) and partition 1 (overrides)
            const [contentResult, overrideResult] = await Promise.all([
                streamrController.fetchOlderHistory(
                    messageStreamId,
                    STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                    beforeTimestamp,
                    STREAM_CONFIG.LOAD_MORE_COUNT,
                    channel.password,
                    signal,
                    !supportsControlPartition
                ),
                supportsControlPartition
                    ? streamrController.fetchOlderHistory(
                        messageStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.CONTROL,
                        beforeTimestamp,
                        STREAM_CONFIG.LOAD_MORE_COUNT,
                        channel.password,
                        signal,
                        false
                    )
                    : Promise.resolve({ messages: [], hasMore: false })
            ]);
            
            // Discard results if user switched channels during fetch
            if (this.switchGeneration !== generationAtStart) {
                Logger.debug('Channel switched during history fetch, discarding results for', messageStreamId.slice(-20));
                channel.loadingHistory = false;
                return { loaded: 0, hasMore: channel.hasMoreHistory };
            }
            
            // Separate reactions and overrides from content messages
            let addedCount = 0;
            
            const contentMessagesRaw = contentResult.messages || [];
            const overridesRaw = overrideResult.messages || [];

            if (contentMessagesRaw.length > 0 || overridesRaw.length > 0) {
                const contentMessages = [];
                const overrides = [...overridesRaw];
                
                for (const msg of contentMessagesRaw) {
                    // Route reactions to storeReaction (NOT channel.messages)
                    if (msg?.type === 'reaction') {
                        const reactionUser = msg.senderId || msg.user;
                        if (reactionUser && msg.messageId && msg.emoji) {
                            this.storeReaction(channel, msg.messageId, msg.emoji, reactionUser, msg.action || 'add');
                        }
                        // Track oldest timestamp from reactions too (for pagination progress)
                        if (msg.timestamp && (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp)) {
                            channel.oldestTimestamp = msg.timestamp;
                        }
                        continue;
                    }

                    // Legacy fallback path: stream has no control partition, overrides come from P0
                    if (!supportsControlPartition && (msg?.type === 'edit' || msg?.type === 'delete')) {
                        if (msg.timestamp && (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp)) {
                            channel.oldestTimestamp = msg.timestamp;
                        }
                        overrides.push(msg);
                        continue;
                    }
                    
                    // Skip non-content or incomplete messages
                    if (!msg?.id || !msg?.sender || !msg?.timestamp) continue;
                    // Deduplicate
                    if (channel.messages.some(m => m.id === msg.id)) continue;
                    
                    contentMessages.push(msg);
                }
                
                if (contentMessages.length > 0) {
                    // OPTIMIZATION: Verify all messages in parallel using worker pool
                    const verificationPromises = contentMessages.map(async (msg) => {
                        try {
                            if (!msg.channelId) msg.channelId = messageStreamId;
                            const verification = await identityManager.verifyMessage(msg, messageStreamId, {
                                skipTimestampCheck: true
                            });
                            msg.verified = verification;
                        } catch (error) {
                            msg.verified = { valid: false, error: error.message, trustLevel: -1 };
                        }
                        return msg;
                    });
                    
                    // Wait for all verifications to complete in parallel
                    const verifiedMessages = await Promise.all(verificationPromises);
                    
                    // Discard results if user switched channels during verification
                    if (this.switchGeneration !== generationAtStart) {
                        Logger.debug('Channel switched during history verification, discarding results for', messageStreamId.slice(-20));
                        channel.loadingHistory = false;
                        return { loaded: 0, hasMore: channel.hasMoreHistory };
                    }
                    
                    // Add all verified messages to channel (with dedup re-check for race conditions)
                    for (const msg of verifiedMessages) {
                        // Re-check dedup: real-time messages may have arrived during verification
                        if (channel.messages.some(m => m.id === msg.id)) {
                            continue;
                        }
                        channel.messages.push(msg);
                        addedCount++;
                        
                        // Update oldest timestamp
                        if (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp) {
                            channel.oldestTimestamp = msg.timestamp;
                        }
                    }
                    
                    // Sort messages
                    this.sortMessagesByTimestamp(channel);
                }
                
                // Apply edit/delete overrides after content messages are added
                for (const override of overrides) {
                    this.handleOverrideMessage(messageStreamId, override, true);
                }
                // Apply any previously pending overrides that now have matching messages
                this.applyPendingOverrides(channel);
                // Remove deleted messages from array
                channel.messages = channel.messages.filter(m => !m._deleted);
            }
            
            // Pagination is driven by content partition
            channel.hasMoreHistory = contentResult.hasMore;
            channel.loadingHistory = false;
            
            this.notifyHandlers('history_loaded', { 
                streamId: messageStreamId, 
                loaded: addedCount, 
                hasMore: contentResult.hasMore 
            });
            
            Logger.info(`Loaded ${addedCount} older messages (P0: ${contentMessagesRaw.length}, P1: ${overridesRaw.length}), hasMore: ${contentResult.hasMore}`);
            
            return { loaded: addedCount, hasMore: contentResult.hasMore };
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

            // DM channels: E2E encrypt ephemeral, no user field (senderId from SDK provides identity)
            if (channel.type === 'dm' && channel.peerAddress) {
                const privateKey = authManager.wallet?.privateKey;
                if (privateKey) {
                    const peerPubKey = await dmManager.getPeerPublicKey(channel.peerAddress);
                    if (peerPubKey) {
                        const aesKey = await dmCrypto.getSharedKey(privateKey, channel.peerAddress, peerPubKey);
                        const encrypted = await dmCrypto.encrypt({ type: 'typing', nickname: identityManager.getUsername?.() || null, timestamp: Date.now() }, aesKey);
                        // Set Pombo key for publishing to peer's ephemeral stream
                        await streamrController.setDMPublishKey(ephemeralStreamId);
                        await streamrController.publishControl(ephemeralStreamId, encrypted, null);
                    }
                }
                return;
            }

            // Non-DM channels: no self-reported user field (senderId from SDK provides identity)
            await streamrController.publishControl(
                ephemeralStreamId,
                { type: 'typing', nickname: identityManager.getUsername?.() || null, timestamp: Date.now() },
                channel.password
            );
        } catch (error) {
            Logger.error('Failed to send typing indicator:', error);
        }
    }

    /**
     * Send wake signals to other members in the channel.
     * This notifies them via push notification that there's a new message.
     * 
     * HYBRID ARCHITECTURE:
     * - Native channels: Send to each member's userTag (max privacy)
     * - Public/Password channels: Send to channelTag (opt-in subscribers)
     * 
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async sendWakeSignals(messageStreamId) {
        try {
            const channel = this.channels.get(messageStreamId);
            if (!channel) return;
            
            const channelType = channel.type || 'unknown';
            
            // DM channels: Send wake signal using the peer's inbox stream ID
            // The tag is based on the peer's inbox, so the peer gets notified
            if (channelType === 'dm') {
                Logger.debug('Sending DM wake signal for:', messageStreamId.slice(0, 20) + '...');
                await relayManager.sendChannelWakeSignal(messageStreamId);
                Logger.debug('DM wake signal sent');
                
            // Native channels: Send to channel tag (per-channel notifications)
            } else if (channelType === 'native') {
                Logger.debug('Sending native channel wake signal for:', messageStreamId.slice(0, 20) + '...');
                await relayManager.sendNativeChannelWakeSignal(messageStreamId);
                Logger.debug('Native channel wake signal sent');
                
            } else {
                // Public/Password channels: Send to channel tag
                // Anyone who opted into notifications for this channel will receive
                Logger.debug('Sending channel wake signal for:', channelType, 'channel');
                await relayManager.sendChannelWakeSignal(messageStreamId);
                Logger.debug('Channel wake signal sent');
            }
            
        } catch (error) {
            // Non-critical - log but don't throw
            Logger.debug('Failed to send wake signals:', error.message);
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
        const reactionKey = `${streamId}:${messageId}:${emoji}:${action}`;
        
        if (this.pendingReactions.has(reactionKey)) {
            Logger.debug('Reaction already pending, skipping duplicate:', reactionKey);
            return; // Silently skip duplicate
        }
        
        this.pendingReactions.add(reactionKey);
        
        try {
            const channel = this.channels.get(streamId);
            if (!channel) return;

            const reaction = {
                type: 'reaction',
                action: action,
                messageId: messageId,
                emoji: emoji,
                timestamp: Date.now()
            };

            // DM channels: E2E encrypt reaction before publishing to peer's inbox
            if (channel.type === 'dm' && channel.peerAddress) {
                const privateKey = authManager.wallet?.privateKey;
                const myAddress = authManager.getAddress();
                if (privateKey) {
                    const peerPubKey = await dmManager.getPeerPublicKey(channel.peerAddress);
                    if (peerPubKey) {
                        const aesKey = await dmCrypto.getSharedKey(privateKey, channel.peerAddress, peerPubKey);
                        const encrypted = await dmCrypto.encrypt(reaction, aesKey);
                        // Set Pombo key for publishing to peer's inbox
                        await streamrController.setDMPublishKey(streamId);
                        await streamrController.publishReaction(streamId, encrypted, null);
                        
                        // Persist locally — we won't receive our own reaction back from peer's inbox
                        await secureStorage.addSentReaction(streamId, messageId, emoji, myAddress, action);
                    } else {
                        Logger.warn('DM reaction: peer public key not available');
                    }
                }
            } else {
                // Regular channels: send to MESSAGE stream (stored) via publishReaction
                await streamrController.publishReaction(
                    streamId,
                    reaction,
                    channel.password
                );
            }
            
            // Persist locally for write-only channels
            if (channel.writeOnly) {
                await secureStorage.addSentReaction(streamId, messageId, emoji, reaction.user, action);
            }
            
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
     * @param {Object} [options] - Leave options
     * @param {boolean} [options.block] - If true, block the peer (DM only). All future messages ignored.
     */
    async leaveChannel(messageStreamId, options = {}) {
        try {
            const channel = this.channels.get(messageStreamId);
            const ephemeralStreamId = channel?.ephemeralStreamId || deriveEphemeralId(messageStreamId);
            
            // DM-specific cleanup: clear local sent data and cached keys
            if (channel?.type === 'dm' && channel.peerAddress) {
                if (options.block) {
                    // Leave and Block: permanently ignore all messages from this peer
                    await secureStorage.addBlockedPeer(channel.peerAddress);
                    Logger.info('DM: Blocked peer', channel.peerAddress);
                } else {
                    // Soft leave: mark timestamp so older messages are ignored,
                    // but new messages after this point will resurface the conversation
                    await secureStorage.setDMLeftAt(channel.peerAddress, Date.now());
                    Logger.info('DM: Soft-left conversation with', channel.peerAddress);
                }
                await secureStorage.clearSentMessages(messageStreamId);
                await secureStorage.clearSentReactions(messageStreamId);
                dmCrypto.peerPublicKeys.delete(channel.peerAddress);
                dmManager.conversations.delete(channel.peerAddress);
                Logger.debug('DM: Cleaned up local data for', channel.peerAddress);
            }
            
            // Unsubscribe from both streams
            await streamrController.unsubscribeFromDualStream(messageStreamId, ephemeralStreamId);
            
            // Cancel any pending batch verifications for this channel
            this.cancelPendingVerifications(messageStreamId);
            
            // Clean up online users tracking for this channel
            this.onlineUsers.delete(messageStreamId);
            
            this.channels.delete(messageStreamId);
            await this.saveChannels();
            
            // Remove from channel order
            await secureStorage.removeFromChannelOrder(messageStreamId);

            if (this.currentChannel === messageStreamId) {
                this.setCurrentChannel(null);
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
            this.setCurrentChannel(null);
            this.onlineUsers.clear();
            this.processingMessages.clear();
            this.pendingMessages.clear();
            // Cancel all pending batch verifications
            for (const [, batch] of this.pendingVerifications) {
                if (batch.timer) clearTimeout(batch.timer);
            }
            this.pendingVerifications.clear();
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
            
            // Clear transient async/send state for this channel
            this.clearStreamTransientState(streamId);
            
            // Remove from channel order
            await secureStorage.removeFromChannelOrder(streamId);

            if (this.currentChannel === streamId) {
                this.setCurrentChannel(null);
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
        const previousChannel = this.currentChannel;
        this.currentChannel = streamId;
        this.switchGeneration++;
        
        // Abort any in-flight history fetch for the previous channel
        if (this.historyAbortController) {
            this.historyAbortController.abort();
            this.historyAbortController = null;
        }
        
        // Cancel any pending batch verifications for the previous channel
        // to avoid stale messages being processed after the switch
        if (previousChannel && previousChannel !== streamId) {
            this.clearStreamTransientState(previousChannel);
        }
    }

    /**
     * Clear transient async/send state for a specific stream.
     * Used on channel switch/delete to isolate stale in-flight work.
     * @param {string} streamId - Stream ID
     */
    clearStreamTransientState(streamId) {
        if (!streamId) return;
        this.cancelPendingVerifications(streamId);
        this.pendingFlushPromises.delete(streamId);

        // Remove send-side override dedupe keys for this stream (format: streamId:targetId:type)
        for (const key of [...this.pendingOverrides]) {
            if (key.startsWith(`${streamId}:`)) {
                this.pendingOverrides.delete(key);
            }
        }
    }

    /**
     * Cancel pending batch verifications for a stream
     * Called on channel switch to discard queued work for the previous channel
     * @param {string} streamId - Stream ID to cancel
     */
    cancelPendingVerifications(streamId) {
        const batch = this.pendingVerifications.get(streamId);
        if (batch) {
            if (batch.timer) {
                clearTimeout(batch.timer);
            }
            const discarded = batch.messages.length;
            this.pendingVerifications.delete(streamId);
            if (discarded > 0) {
                Logger.debug(`Cancelled ${discarded} pending batch verifications for`, streamId.slice(-20));
            }
        }
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
     * Convert bytes to URL-safe base64 without padding
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    bytesToBase64Url(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    /**
     * Convert URL-safe base64 to bytes
     * @param {string} value
     * @returns {Uint8Array}
     */
    base64UrlToBytes(value) {
        const normalized = value
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
        const binary = atob(normalized + padding);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    /**
     * Generate invite link for a channel
     * @param {string} streamId - Stream ID
     * @returns {string} - Invite link
     */
    async generateInviteLink(streamId) {
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

        const keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt']
        );

        const payloadBytes = new TextEncoder().encode(JSON.stringify(inviteData));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            payloadBytes
        );

        const token = [
            this.bytesToBase64Url(iv),
            this.bytesToBase64Url(new Uint8Array(ciphertext)),
            this.bytesToBase64Url(keyBytes)
        ].join('.');

        return `${window.location.origin}${window.location.pathname}#/invite/v2/${token}`;
    }

    /**
     * Parse invite link
     * @param {string} inviteCode - Encrypted invite token (iv.cipher.key)
     * @returns {Object} - Invite data
     */
    async parseInviteLink(inviteCode) {
        try {
            const parts = inviteCode.split('.');
            if (parts.length !== 3) {
                throw new Error('Invalid invite token format');
            }

            const iv = this.base64UrlToBytes(parts[0]);
            const ciphertext = this.base64UrlToBytes(parts[1]);
            const keyBytes = this.base64UrlToBytes(parts[2]);

            if (iv.length !== 12 || keyBytes.length !== 32) {
                throw new Error('Invalid invite token length');
            }

            const key = await crypto.subtle.importKey(
                'raw',
                keyBytes,
                { name: 'AES-GCM' },
                false,
                ['decrypt']
            );

            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                ciphertext
            );

            const decoded = new TextDecoder().decode(decrypted);
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
