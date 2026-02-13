/**
 * Streamr Controller
 * Manages Streamr client connection, subscriptions, and publishing
 * Implements partition-based communication (0=Control, 1=Messages, 2=Media)
 * 
 * Partition Structure:
 * - 0: Control (presence, reactions)
 * - 1: Messages (text messages)
 * - 2: Media (images, files, streams)
 */

import { Logger } from './logger.js';
import { cryptoManager } from './crypto.js';

// === STORAGE CONFIG ===
// Using Streamr's official storage node for message history/persistence
// Fallback: LogStore node if Streamr storage unavailable
const LOGSTORE_CONFIG = {
    // Streamr's official storage node (will be set from SDK after load)
    // Fallback to LogStore if SDK constant not available
    NODE_ADDRESS: null, // Set dynamically in init()
    
    // LogStore Virtual Storage Node (backup option)
    LOGSTORE_NODE: '0x17f98084757a75add72bf6c5b5a6f69008c28a57',
    
    // Number of messages to load on join
    INITIAL_MESSAGES: 100,
    
    // Partitions (swapped: messages on 0 for storage compatibility)
    PARTITIONS: {
        MESSAGES: 0,  // Text messages (partition 0 = stored reliably)
        CONTROL: 1,   // Presence, typing (ephemeral - no history needed)
        MEDIA: 2      // Images, files
    }
};

class StreamrController {
    constructor() {
        this.client = null;
        this.subscriptions = new Map(); // streamId -> { partition -> subscription }
        this.channels = new Map(); // streamId -> channel config
        this.address = null;
    }

    /**
     * Initialize Streamr client with signer
     * @param {Object} signer - Ethers signer from wallet (must have privateKey)
     */
    async init(signer) {
        try {
            // Get StreamrClient from global window object (loaded via CDN)
            if (!window.StreamrClient) {
                throw new Error('StreamrClient not found. Make sure the Streamr SDK is loaded.');
            }

            if (!signer.privateKey) {
                throw new Error('Signer must have a privateKey');
            }

            this.client = new StreamrClient({
                auth: {
                    privateKey: signer.privateKey
                }
            });
            
            // Set storage node address from SDK (prefer Streamr's official node)
            if (window.STREAMR_STORAGE_NODE_GERMANY) {
                LOGSTORE_CONFIG.NODE_ADDRESS = window.STREAMR_STORAGE_NODE_GERMANY;
                Logger.debug('Using Streamr official storage node');
            } else {
                LOGSTORE_CONFIG.NODE_ADDRESS = LOGSTORE_CONFIG.LOGSTORE_NODE;
                Logger.debug('Using LogStore storage node (fallback)');
            }
            
            this.address = await this.client.getAddress();
            Logger.info('Streamr client initialized with address:', this.address);

            return true;
        } catch (error) {
            Logger.error('Failed to initialize Streamr client:', error);
            throw error;
        }
    }

    /**
     * Get the address of the connected account
     * @returns {Promise<string>} - Ethereum address
     */
    async getAddress() {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        return this.address;
    }

    /**
     * Create a new stream with partitions
     * @param {string} channelName - Name of the channel
     * @param {string} creatorAddress - Creator's Ethereum address
     * @param {string} type - Channel type: 'public', 'password', 'native'
     * @param {string[]} members - Array of member addresses (for native channels)
     * @returns {Promise<Object>} - Stream info
     */
    async createStream(channelName, creatorAddress, type = 'public', members = []) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Use the address for the stream namespace
        const ownerAddress = this.address;
        
        // Generate unique stream ID ONCE
        const randomHash = cryptoManager.generateRandomHex(8);
        const streamId = `${ownerAddress}/${channelName}_${randomHash}`;

        try {
            Logger.debug('Creating stream:', streamId, '- Type:', type);
            Logger.debug('   Owner address:', ownerAddress);

            // Build metadata for The Graph indexing
            // This allows querying Moot channels via The Graph API
            const metadata = JSON.stringify({
                app: 'moot',
                version: '1',
                name: channelName,
                type: type,
                createdAt: Date.now()
            });

            // Create stream with metadata
            const stream = await this.client.createStream({
                id: streamId,
                description: metadata,
                partitions: 3
            });

            Logger.debug('Stream created:', stream.id);

            // Configure permissions based on channel type
            if (type === 'public' || type === 'password') {
                // Public/Password streams: grant public permissions (anyone can pub/sub)
                // Password channels are public at network level, encryption is client-side
                try {
                    Logger.debug('Configuring public permissions for', type, 'channel...');
                    await this.grantPublicPermissions(stream);
                    Logger.debug('Public permissions granted');
                } catch (permError) {
                    Logger.warn('Failed to grant public permissions:', permError.message);
                    // Retry with direct stream method
                    try {
                        await stream.grantPermissions({ public: true, permissions: ['subscribe', 'publish'] });
                        Logger.debug('Public permissions granted (retry)');
                    } catch (retryError) {
                        Logger.error('Failed to grant public permissions after retry:', retryError.message);
                    }
                }
            } else if (type === 'native') {
                // Private (native) streams: set all permissions in single transaction
                try {
                    Logger.debug('Private channel - setting permissions (single transaction)...');
                    await this.setStreamPermissions(stream.id, {
                        public: false,
                        members: members
                    });
                    Logger.debug('All permissions set in single transaction');
                } catch (e) {
                    Logger.warn('Failed to set permissions:', e.message);
                }
            }

            return {
                streamId: stream.id,
                type: type,
                name: channelName
            };
        } catch (error) {
            // Check if stream was actually created despite error
            Logger.warn('Create stream error:', error.message);
            
            try {
                const existingStream = await this.client.getStream(streamId);
                if (existingStream) {
                    Logger.debug('Stream exists (created despite error):', streamId);
                    
                    // Configure permissions based on type (same logic as above)
                    if (type === 'public' || type === 'password') {
                        try {
                            await this.grantPublicPermissions(existingStream);
                        } catch (e) {
                            Logger.warn('Could not grant public permissions:', e.message);
                            // Direct fallback
                            try {
                                await existingStream.grantPermissions({ public: true, permissions: ['subscribe', 'publish'] });
                            } catch (e2) {
                                Logger.error('Public permissions failed completely:', e2.message);
                            }
                        }
                    } else if (type === 'native') {
                        // Private channel - set all permissions in single transaction
                        try {
                            await this.setStreamPermissions(existingStream.id, {
                                public: false,
                                members: members
                            });
                        } catch (e) {
                            Logger.warn('Could not set permissions:', e.message);
                        }
                    }
                    
                    return {
                        streamId: existingStream.id,
                        type: type,
                        name: channelName
                    };
                }
            } catch (e) {
                // Stream really doesn't exist
            }
            
            Logger.error('Failed to create stream:', error);
            throw error;
        }
    }

    /**
     * Set stream permissions in a single transaction (like Streamr Hub)
     * Uses client.setPermissions() for batch permission updates
     * @param {string} streamId - Stream ID
     * @param {Object} options - Permission options
     * @param {boolean} options.public - Whether to grant public permissions
     * @param {string[]} options.members - Array of member addresses
     */
    async setStreamPermissions(streamId, options = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        const assignments = [];

        // Add public permissions if requested
        if (options.public) {
            assignments.push({
                public: true,
                permissions: ['subscribe', 'publish']
            });
        }

        // Add member permissions
        if (options.members && options.members.length > 0) {
            for (const member of options.members) {
                assignments.push({
                    userId: member,
                    permissions: ['subscribe', 'publish']
                });
            }
        }

        if (assignments.length === 0) {
            Logger.debug('No permissions to set (owner-only)');
            return;
        }

        Logger.debug('Setting permissions (single transaction):', assignments.length, 'assignments');

        // Use setPermissions for batch update (single transaction)
        await this.client.setPermissions({
            streamId: streamId,
            assignments: assignments
        });

        Logger.debug('Permissions set successfully');
    }

    /**
     * Grant public SUBSCRIBE and PUBLISH permissions to a stream
     * @param {Object} stream - Stream object (or streamId string)
     */
    async grantPublicPermissions(stream) {
        // If string passed, get the stream object
        if (typeof stream === 'string') {
            stream = await this.client.getStream(stream);
        }

        // Get StreamPermission enum from SDK (different ways it might be exposed)
        const StreamPermission = window.StreamPermission || 
                                 window.StreamrClient?.StreamPermission;

        // Try to grant both permissions in a SINGLE transaction
        // This reduces gas costs and number of confirmation popups
        const combinedFormats = [];
        
        // Format 1: Using StreamPermission enum with both permissions combined
        if (StreamPermission && StreamPermission.SUBSCRIBE && StreamPermission.PUBLISH) {
            combinedFormats.push({
                public: true,
                permissions: [StreamPermission.SUBSCRIBE, StreamPermission.PUBLISH]
            });
        }
        
        // Format 2: String format (lowercase) - both combined
        combinedFormats.push({
            public: true,
            permissions: ['subscribe', 'publish']
        });
        
        // Format 3: String format (uppercase) - both combined
        combinedFormats.push({
            public: true,
            permissions: ['SUBSCRIBE', 'PUBLISH']
        });

        for (let i = 0; i < combinedFormats.length; i++) {
            try {
                await stream.grantPermissions(combinedFormats[i]);
                Logger.debug('Public permissions granted (combined, format ' + (i + 1) + ')');
                return;
            } catch (error) {
                Logger.warn(`Combined permission format ${i + 1} failed:`, error.message);
                if (i === combinedFormats.length - 1) {
                    // All combined formats failed, try separate calls as fallback
                    Logger.debug('Falling back to separate permission calls...');
                    await stream.grantPermissions({ public: true, permissions: ['subscribe'] });
                    await stream.grantPermissions({ public: true, permissions: ['publish'] });
                    Logger.debug('Public permissions granted (separate calls)');
                }
            }
        }
    }

    /**
     * Revoke public permissions from a stream (make it private)
     * @param {Object} stream - Stream object (or streamId string)
     */
    async revokePublicPermissions(stream) {
        // If string passed, get the stream object
        if (typeof stream === 'string') {
            stream = await this.client.getStream(stream);
        }

        try {
            await stream.revokePermissions({
                public: true,
                permissions: ['subscribe', 'publish']
            });
            Logger.debug('Public permissions revoked');
        } catch (error) {
            Logger.warn('Failed to revoke public permissions:', error.message);
        }
    }

    /**
     * Grant permissions to specific addresses (for native private channels)
     * @param {string} streamId - Stream ID
     * @param {string[]} addresses - Array of Ethereum addresses
     */
    async grantPermissionsToAddresses(streamId, addresses) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        try {
            const stream = await this.client.getStream(streamId);
            
            // Get StreamPermission enum (SDK v103+)
            const StreamPermission = window.StreamPermission || window.StreamrClient?.StreamPermission;
            const subscribePerm = StreamPermission?.SUBSCRIBE ?? 'subscribe';
            const publishPerm = StreamPermission?.PUBLISH ?? 'publish';

            Logger.debug('Granting permissions to addresses:', addresses);
            Logger.debug('Using permission values:', { subscribePerm, publishPerm });

            for (const address of addresses) {
                // Ensure checksum address
                const checksumAddress = ethers.getAddress(address);
                Logger.debug(`Granting to ${checksumAddress}...`);
                await stream.grantPermissions({
                    userId: checksumAddress,
                    permissions: [subscribePerm, publishPerm]
                });
                Logger.debug(`Granted permissions to ${checksumAddress}`);
            }

            Logger.info('All permissions granted to addresses:', addresses);
        } catch (error) {
            Logger.error('Failed to grant permissions:', error);
            throw error;
        }
    }

    /**
     * Revoke permissions from specific addresses for a stream
     * @param {string} streamId - Stream ID
     * @param {string[]} addresses - Array of Ethereum addresses
     */
    async revokePermissionsFromAddresses(streamId, addresses) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        try {
            const stream = await this.client.getStream(streamId);
            
            // Get StreamPermission enum (SDK v103+)
            const StreamPermission = window.StreamPermission || window.StreamrClient?.StreamPermission;
            const subscribePerm = StreamPermission?.SUBSCRIBE ?? 'subscribe';
            const publishPerm = StreamPermission?.PUBLISH ?? 'publish';
            const grantPerm = StreamPermission?.GRANT ?? 'grant';

            for (const address of addresses) {
                // Ensure checksum address
                const checksumAddress = ethers.getAddress(address);
                await stream.revokePermissions({
                    userId: checksumAddress,
                    permissions: [subscribePerm, publishPerm, grantPerm]
                });
            }

            Logger.debug('Permissions revoked from addresses:', addresses);
        } catch (error) {
            Logger.error('Failed to revoke permissions:', error);
            throw error;
        }
    }

    /**
     * Update specific permissions for an address
     * @param {string} streamId - Stream ID
     * @param {string} address - User address
     * @param {Object} permissions - { canGrant: boolean }
     */
    async updatePermissions(streamId, address, permissionsToSet) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Validate address
        if (!address || typeof address !== 'string' || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
            throw new Error('Invalid Ethereum address: ' + address);
        }

        // Ensure checksum address
        const checksumAddress = ethers.getAddress(address);
        Logger.debug('Updating permissions for:', checksumAddress, 'canGrant:', permissionsToSet.canGrant);

        try {
            const stream = await this.client.getStream(streamId);
            
            // Get StreamPermission enum (SDK v103+)
            const StreamPermission = window.StreamPermission || window.StreamrClient?.StreamPermission;
            Logger.debug('StreamPermission enum:', StreamPermission);
            
            if (permissionsToSet.canGrant) {
                // Grant the GRANT permission
                Logger.debug(`Granting GRANT permission to ${checksumAddress}...`);
                
                // Use enum if available, otherwise string
                const grantPerm = StreamPermission?.GRANT ?? 'grant';
                Logger.debug('Using permission value:', grantPerm);
                
                await stream.grantPermissions({
                    userId: checksumAddress,
                    permissions: [grantPerm]
                });
                Logger.debug(`GRANT permission added to ${checksumAddress}`);
            } else {
                // Revoke the GRANT permission
                Logger.debug(`Revoking GRANT permission from ${checksumAddress}...`);
                
                const grantPerm = StreamPermission?.GRANT ?? 'grant';
                Logger.debug('Using permission value:', grantPerm);
                
                await stream.revokePermissions({
                    userId: checksumAddress,
                    permissions: [grantPerm]
                });
                Logger.debug(`GRANT permission removed from ${checksumAddress}`);
            }
        } catch (error) {
            Logger.error('Failed to update permissions:', error);
            throw error;
        }
    }

    /**
     * Get list of addresses with permissions on a stream
     * @param {string} streamId - Stream ID
     * @returns {Promise<Array>} - Array of permission objects
     */
    async getStreamPermissions(streamId) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        try {
            const stream = await this.client.getStream(streamId);
            const permissions = [];
            
            // Try different methods depending on SDK version
            if (typeof stream.getPermissions === 'function') {
                const result = stream.getPermissions();
                
                // Check if it's an async iterator
                if (result && typeof result[Symbol.asyncIterator] === 'function') {
                    for await (const permission of result) {
                        permissions.push(permission);
                    }
                } 
                // Check if it's a promise
                else if (result && typeof result.then === 'function') {
                    const perms = await result;
                    if (Array.isArray(perms)) {
                        return perms;
                    }
                }
                // Check if it's already an array
                else if (Array.isArray(result)) {
                    return result;
                }
            }
            
            // Fallback: try hasPermission for known addresses
            if (permissions.length === 0) {
                Logger.debug('getPermissions not available, using fallback');
                // Return empty - will use local cache
                return [];
            }
            
            return permissions;
        } catch (error) {
            Logger.error('Failed to get stream permissions:', error);
            throw error;
        }
    }

    /**
     * Delete a stream (only owner can delete)
    /**
     * Delete a stream
     * @param {string} streamId - Stream ID
     * @returns {Promise<void>}
     */
    async deleteStream(streamId) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        try {
            // Unsubscribe first
            await this.unsubscribe(streamId);
            
            // Delete stream
            await this.client.deleteStream(streamId);
            
            Logger.debug('Stream deleted:', streamId);
        } catch (error) {
            Logger.error('Failed to delete stream:', error);
            throw error;
        }
    }

    /**
     * Subscribe to all partitions of a stream
     * @param {string} streamId - Stream ID
     * @param {Object} handlers - Event handlers for each partition
     * @param {string} password - Password for encrypted channels (optional)
     */
    async subscribe(streamId, handlers, password = null) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Check if already subscribed to this stream
        if (this.subscriptions.has(streamId)) {
            Logger.debug('Already subscribed to stream:', streamId);
            return true;
        }

        try {
            const partitionSubs = {};

            // Subscribe to partition 0 (Control/Metadata)
            if (handlers.onControl) {
                partitionSubs[0] = await this.client.subscribe({
                    streamId: streamId,
                    partition: 0
                }, async (message) => {
                    try {
                        let data = message;

                        // Decrypt if password provided
                        if (password && typeof message === 'string') {
                            data = await cryptoManager.decryptJSON(message, password);
                        }

                        handlers.onControl(data);
                    } catch (error) {
                        Logger.error('Failed to process control message:', error);
                    }
                });
            }

            // Subscribe to partition 1 (Text Messages)
            if (handlers.onMessage) {
                Logger.debug('Subscribing to partition 1 (messages) for:', streamId);
                partitionSubs[1] = await this.client.subscribe({
                    streamId: streamId,
                    partition: 1
                }, async (message) => {
                    Logger.debug('RAW message received on partition 1:', message);
                    try {
                        let data = message;

                        // Decrypt if password provided
                        if (password && typeof message === 'string') {
                            data = await cryptoManager.decryptJSON(message, password);
                        }

                        Logger.debug('Processed message, calling handler:', data);
                        handlers.onMessage(data);
                    } catch (error) {
                        Logger.error('Failed to process message:', error);
                    }
                });
                Logger.debug('Subscribed to partition 1');
            }

            // Subscribe to partition 2 (Media)
            if (handlers.onMedia) {
                partitionSubs[2] = await this.client.subscribe({
                    streamId: streamId,
                    partition: 2
                }, async (message) => {
                    try {
                        let data = message;

                        // Decrypt if password provided
                        if (password && typeof message === 'string') {
                            data = await cryptoManager.decryptJSON(message, password);
                        }

                        handlers.onMedia(data);
                    } catch (error) {
                        Logger.error('Failed to process media:', error);
                    }
                });
            }

            this.subscriptions.set(streamId, partitionSubs);
            Logger.info('Subscribed to stream:', streamId);

            return true;
        } catch (error) {
            Logger.error('Failed to subscribe to stream:', error);
            throw error;
        }
    }

    /**
     * Publish message to a specific partition
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number (0, 1, or 2)
     * @param {Object} data - Data to publish
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publish(streamId, partition, data, password = null) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        try {
            let payload = data;

            // Encrypt if password provided
            if (password) {
                payload = await cryptoManager.encryptJSON(data, password);
            }

            await this.client.publish({
                streamId: streamId,
                partition: partition
            }, payload);

            Logger.debug(`Published to ${streamId} partition ${partition}`);
        } catch (error) {
            Logger.error('Failed to publish:', error);
            throw error;
        }
    }

    /**
     * Publish a text message (partition 0 - stored)
     * @param {string} streamId - Stream ID
     * @param {Object} message - Message object
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishMessage(streamId, message, password = null) {
        Logger.debug('publishMessage called - sending to partition 0:', { streamId, messageId: message?.id });
        return await this.publish(streamId, 0, message, password);
    }

    /**
     * Publish control/metadata (partition 1 - ephemeral)
     * @param {string} streamId - Stream ID
     * @param {Object} control - Control data
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishControl(streamId, control, password = null) {
        return await this.publish(streamId, 1, control, password);
    }

    /**
     * Publish reaction (partition 0 - stored with messages)
     * @param {string} streamId - Stream ID
     * @param {Object} reaction - Reaction data
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishReaction(streamId, reaction, password = null) {
        Logger.debug('publishReaction called - sending to partition 0:', { streamId, messageId: reaction?.messageId });
        return await this.publish(streamId, 0, reaction, password);
    }

    /**
     * Publish media (partition 2)
     * @param {string} streamId - Stream ID
     * @param {Object} media - Media data
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishMedia(streamId, media, password = null) {
        return await this.publish(streamId, 2, media, password);
    }

    /**
     * Unsubscribe from a stream
     * @param {string} streamId - Stream ID
     */
    async unsubscribe(streamId) {
        const partitionSubs = this.subscriptions.get(streamId);

        if (partitionSubs) {
            for (const partition in partitionSubs) {
                await partitionSubs[partition].unsubscribe();
            }

            this.subscriptions.delete(streamId);
            Logger.debug('Unsubscribed from stream:', streamId);
        }
    }

    /**
     * Disconnect Streamr client
     */
    async disconnect() {
        if (this.client) {
            // Unsubscribe from all streams
            for (const streamId of this.subscriptions.keys()) {
                await this.unsubscribe(streamId);
            }

            await this.client.destroy();
            this.client = null;
            Logger.info('Streamr client disconnected');
        }
        
        this.address = null;
    }

    // ==================== Storage Methods ====================

    /**
     * Enable storage for a stream (uses Streamr official node or LogStore fallback)
     * This allows message history/persistence via the Storage Node
     * @param {string} streamId - Stream ID
     * @returns {Promise<boolean>} - Success status
     */
    async enableStorage(streamId) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        // Ensure NODE_ADDRESS is set
        const nodeAddress = LOGSTORE_CONFIG.NODE_ADDRESS || LOGSTORE_CONFIG.LOGSTORE_NODE;
        
        try {
            const stream = await this.client.getStream(streamId);
            await stream.addToStorageNode(nodeAddress);
            Logger.info('Storage enabled for stream:', streamId, '(node:', nodeAddress.slice(0, 10) + '...)');
            return true;
        } catch (error) {
            Logger.warn('Failed to enable storage:', error.message);
            return false;
        }
    }

    /**
     * Fetch historical messages from a stream partition
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {number} count - Number of messages to fetch
     * @returns {Promise<Array>} - Array of message contents
     */
    async fetchHistory(streamId, partition = 1, count = LOGSTORE_CONFIG.INITIAL_MESSAGES) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        const messages = [];
        
        try {
            // Streamr SDK resend: await before iterating
            // Format: await client.resend(streamId, { last: N, partition: P })
            const resend = await this.client.resend(
                streamId,
                { last: count, partition: partition }
            );
            
            // Consume the async iterator
            for await (const message of resend) {
                messages.push(message.content);
            }
            
            Logger.debug(`Fetched ${messages.length} messages from partition ${partition}`);
            return messages;
        } catch (error) {
            Logger.warn('History fetch error:', error.message);
            return messages;
        }
    }

    /**
     * Subscribe to stream with historical resend
     * First subscribes for real-time, then attempts to fetch history separately
     * Falls back gracefully if history fetch fails (e.g., CORS issues on localhost)
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {Function} handler - Message handler
     * @param {number} historyCount - Number of historical messages to fetch (0 = no history)
     * @param {string} password - Password for encrypted channels (optional)
     * @returns {Promise<Object>} - Subscription object
     */
    async subscribeWithHistory(streamId, partition, handler, historyCount = LOGSTORE_CONFIG.INITIAL_MESSAGES, password = null) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        const messageHandler = async (message) => {
            try {
                let data = message;
                
                // Decrypt if password provided
                if (password && typeof message === 'string') {
                    data = await cryptoManager.decryptJSON(message, password);
                }
                
                handler(data);
            } catch (error) {
                Logger.error('Failed to process message:', error);
            }
        };
        
        // First, subscribe for real-time messages (this always works)
        const subscription = await this.client.subscribe(
            {
                streamId: streamId,
                partition: partition
            },
            messageHandler
        );
        
        Logger.debug(`Subscribed to`, streamId, 'partition', partition);
        
        // Only fetch history if historyCount > 0 (skip for ephemeral partitions like control)
        if (historyCount > 0) {
            // Fetch history separately (may fail due to CORS on localhost)
            // This is non-blocking and fails gracefully
            this.fetchHistoryAsync(streamId, partition, historyCount, messageHandler);
        }
        
        return subscription;
    }
    
    /**
     * Fetch history asynchronously and pass to handler
     * Fails gracefully if CORS or other issues occur
     * @private
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {number} count - Number of messages to fetch
     * @param {Function} handler - Message handler
     * @param {string} expectedType - Expected message type filter (optional)
     */
    async fetchHistoryAsync(streamId, partition, count, handler, expectedType = null) {
        try {
            Logger.debug(`Fetching ${count} historical messages for partition ${partition}...`);
            
            // Streamr SDK resend: must await before iterating
            const resend = await this.client.resend(
                streamId,
                { last: count, partition: partition }
            );
            
            Logger.debug(`Resend object received for partition ${partition}:`, typeof resend);
            
            // Consume the async iterator and process each message
            let msgCount = 0;
            let skippedCount = 0;
            let rawCount = 0;
            
            // Ephemeral message types that should NEVER be loaded from history
            const EPHEMERAL_TYPES = ['presence', 'typing'];
            
            // Helper to check if message looks like a text message
            const isTextMessage = (msg) => {
                // Has explicit text type
                if (msg?.type === 'text') return true;
                // OR has text message structure (id, text, sender, timestamp)
                if (msg?.id && msg?.text && msg?.sender && msg?.timestamp && !msg?.type) return true;
                return false;
            };
            
            // Helper to check if message is a reaction
            const isReaction = (msg) => msg?.type === 'reaction';
            
            for await (const message of resend) {
                rawCount++;
                try {
                    const content = message.content || message;
                    
                    // Log first few messages for debugging
                    if (rawCount <= 3) {
                        Logger.debug(`Raw message ${rawCount} from partition ${partition}:`, JSON.stringify(content).slice(0, 200));
                    }
                    
                    // Skip ephemeral messages (presence, typing) - they don't belong in history
                    if (content?.type && EPHEMERAL_TYPES.includes(content.type)) {
                        skippedCount++;
                        continue;
                    }
                    
                    // For partition 0 (messages + reactions): only accept text messages and reactions
                    if (partition === 0) {
                        if (!isTextMessage(content) && !isReaction(content)) {
                            skippedCount++;
                            continue;
                        }
                    }
                    
                    handler(content);
                    msgCount++;
                } catch (e) {
                    Logger.warn('Error processing historical message:', e.message);
                }
            }
            
            if (msgCount > 0) {
                Logger.info(`Loaded ${msgCount} historical messages for partition ${partition}` + 
                    (skippedCount > 0 ? ` (skipped ${skippedCount} ephemeral)` : ''));
            } else {
                Logger.debug(`No historical messages for partition ${partition}` +
                    (skippedCount > 0 ? ` (skipped ${skippedCount} ephemeral)` : '') +
                    ` (raw received: ${rawCount})`);
            }
        } catch (error) {
            // CORS errors and other network issues are caught here
            Logger.warn(`History fetch failed for partition ${partition} (may be CORS on localhost):`, error.message);
        }
    }

    /**
     * Subscribe to all partitions with history support
     * @param {string} streamId - Stream ID
     * @param {Object} handlers - Event handlers for each partition
     * @param {string} password - Password for encrypted channels (optional)
     * @param {number} historyCount - Number of historical messages to fetch
     */
    async subscribeWithHistoryAll(streamId, handlers, password = null, historyCount = LOGSTORE_CONFIG.INITIAL_MESSAGES) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Check if already subscribed to this stream
        if (this.subscriptions.has(streamId)) {
            Logger.debug('Already subscribed to stream:', streamId);
            return true;
        }

        try {
            const partitionSubs = {};

            // Subscribe to partition 0 (Text Messages) WITH HISTORY
            // This is the main stored partition
            if (handlers.onMessage) {
                Logger.debug('Subscribing to partition 0 (messages) with history for:', streamId);
                partitionSubs[0] = await this.subscribeWithHistory(
                    streamId,
                    0,
                    handlers.onMessage,
                    historyCount,
                    password
                );
                Logger.debug('Subscribed to partition 0 with history');
            }

            // Subscribe to partition 1 (Control/Metadata) - NO HISTORY
            // Presence and typing are ephemeral - they don't need history
            if (handlers.onControl) {
                partitionSubs[1] = await this.subscribeWithHistory(
                    streamId,
                    1,
                    handlers.onControl,
                    0, // NO history for control partition - presence/typing are ephemeral
                    password
                );
            }

            // Subscribe to partition 2 (Media) with history
            if (handlers.onMedia) {
                partitionSubs[2] = await this.subscribeWithHistory(
                    streamId,
                    2,
                    handlers.onMedia,
                    historyCount,
                    password
                );
            }

            this.subscriptions.set(streamId, partitionSubs);
            Logger.info('Subscribed to stream with history:', streamId);

            return true;
        } catch (error) {
            Logger.error('Failed to subscribe with history to stream:', error);
            throw error;
        }
    }

    // ==================== End LogStore Methods ====================
}

// Export singleton instance and config
export const streamrController = new StreamrController();
export { LOGSTORE_CONFIG };
