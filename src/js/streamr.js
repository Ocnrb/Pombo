/**
 * Streamr Controller
 * Manages Streamr client connection, subscriptions, and publishing
 * 
 * DUAL-STREAM ARCHITECTURE (v0):
 * Each channel uses 2 streams:
 * 
 * Message Stream (suffix -1): WITH STORAGE
 * - Partition 0: Text messages, reactions, images, video announcements
 * 
 * Ephemeral Stream (suffix -2): NO STORAGE
 * - Partition 0: Control/Metadata (presence, typing)
 * - Partition 1: Media chunks (P2P file transfer)
 * 
 * This solves the privacy problem where Streamr storage is per-stream,
 * not per-partition, causing presence metadata to be persisted.
 */

import { Logger } from './logger.js';
import { cryptoManager } from './crypto.js';

// === STREAM CONFIG (DUAL-STREAM ARCHITECTURE) ===
const STREAM_CONFIG = {
    // Streamr's official storage node (will be set from SDK after load)
    NODE_ADDRESS: null, // Set dynamically in init()
    
    // LogStore Virtual Storage Node (backup option)
    LOGSTORE_NODE: '0x17f98084757a75add72bf6c5b5a6f69008c28a57',
    
    // Number of messages to load on join (reduced for lazy loading)
    INITIAL_MESSAGES: 30,
    
    // Number of messages to load on scroll (pagination)
    LOAD_MORE_COUNT: 30,
    
    // Message Stream (with storage): only 1 partition needed
    MESSAGE_STREAM: {
        SUFFIX: '-1',
        PARTITIONS: 1,
        MESSAGES: 0  // Text, reactions, images, video announcements
    },
    
    // Ephemeral Stream (no storage): 2 partitions
    EPHEMERAL_STREAM: {
        SUFFIX: '-2',
        PARTITIONS: 2,
        CONTROL: 0,  // Presence, typing
        MEDIA: 1     // File chunks (P2P transfer)
    }
};

// === ID DERIVATION FUNCTIONS ===
/**
 * Derive ephemeral stream ID from message stream ID
 * @param {string} messageStreamId - Message stream ID (ends with -1)
 * @returns {string} - Ephemeral stream ID (ends with -2)
 */
function deriveEphemeralId(messageStreamId) {
    if (!messageStreamId) return null;
    return messageStreamId.replace(/-1$/, '-2');
}

/**
 * Derive message stream ID from ephemeral stream ID
 * @param {string} ephemeralStreamId - Ephemeral stream ID (ends with -2)
 * @returns {string} - Message stream ID (ends with -1)
 */
function deriveMessageId(ephemeralStreamId) {
    if (!ephemeralStreamId) return null;
    return ephemeralStreamId.replace(/-2$/, '-1');
}

/**
 * Check if a stream ID is a message stream (ends with -1)
 * @param {string} streamId - Stream ID to check
 * @returns {boolean}
 */
function isMessageStream(streamId) {
    return streamId && streamId.endsWith('-1');
}

/**
 * Check if a stream ID is an ephemeral stream (ends with -2)
 * @param {string} streamId - Stream ID to check
 * @returns {boolean}
 */
function isEphemeralStream(streamId) {
    return streamId && streamId.endsWith('-2');
}

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
                STREAM_CONFIG.NODE_ADDRESS = window.STREAMR_STORAGE_NODE_GERMANY;
                Logger.debug('Using Streamr official storage node');
            } else {
                STREAM_CONFIG.NODE_ADDRESS = STREAM_CONFIG.LOGSTORE_NODE;
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
     * Sanitize a string for use in Streamr stream path
     * Only allows alphanumeric, hyphen, underscore
     * @param {string} name - Original name
     * @returns {string} - Sanitized name safe for stream path
     */
    sanitizeStreamPath(name) {
        if (!name) return 'channel';
        
        // Replace spaces with hyphens, remove invalid chars
        let sanitized = name
            .replace(/\s+/g, '-')           // spaces -> hyphens
            .replace(/[^a-zA-Z0-9_-]/g, '') // remove all except alphanumeric, _, -
            .replace(/-+/g, '-')            // multiple hyphens -> single
            .replace(/^-|-$/g, '');         // trim hyphens from ends
        
        // Ensure not empty after sanitization
        if (!sanitized) {
            sanitized = 'channel';
        }
        
        // Limit length (Streamr has path limits)
        if (sanitized.length > 50) {
            sanitized = sanitized.substring(0, 50);
        }
        
        return sanitized;
    }

    /**
     * Create a new channel with dual-stream architecture
     * Creates 2 streams: Message stream (with storage) and Ephemeral stream (no storage)
     * 
     * @param {string} channelName - Name of the channel
     * @param {string} creatorAddress - Creator's Ethereum address
     * @param {string} type - Channel type: 'public', 'password', 'native'
     * @param {string[]} members - Array of member addresses (for native channels)
     * @param {Object} options - Additional options { exposure: 'visible'|'hidden' }
     * @returns {Promise<Object>} - Stream info with messageStreamId and ephemeralStreamId
     */
    async createStream(channelName, creatorAddress, type = 'public', members = [], options = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Use the address for the stream namespace
        const ownerAddress = this.address;
        
        // Generate unique base ID (8 char random hex)
        const randomHash = cryptoManager.generateRandomHex(8);
        const baseStreamPath = `${ownerAddress}/${randomHash}`;
        
        // Dual-stream IDs
        const messageStreamId = `${baseStreamPath}-1`;
        const ephemeralStreamId = `${baseStreamPath}-2`;

        try {
            Logger.debug('Creating dual-stream channel:', { messageStreamId, ephemeralStreamId });
            Logger.debug('   Owner address:', ownerAddress);
            Logger.debug('   Original name:', channelName);
            Logger.debug('   Type:', type);

            // Build metadata for The Graph indexing (abbreviated keys per MIGRATION_PLAN)
            // Native channels are always hidden; others default to hidden unless specified
            const exposure = options.exposure || 'hidden';
            const readOnly = options.readOnly || false;
            const metadata = JSON.stringify({
                a: 'pombo',           // app
                v: '1',               // version
                n: exposure === 'hidden' ? null : channelName,  // name
                t: type,              // type: public|private|native
                e: exposure,          // exposure: visible|hidden
                r: readOnly,          // readOnly
                // Only include metadata if visible
                d: exposure === 'visible' ? (options.description || '') : undefined,  // description
                l: exposure === 'visible' ? (options.language || 'en') : undefined,   // language
                c: exposure === 'visible' ? (options.category || 'general') : undefined,  // category
                ts: Date.now()        // createdAt
            });

            const ephemeralMetadata = JSON.stringify({
                a: 'pombo',           // app
                v: '1',               // version
                ln: messageStreamId   // linkedTo (parentStream)
            });

            // === SERIAL CREATION: Streams must be created one after another ===
            // Note: Parallel creation causes REPLACEMENT_UNDERPRICED error due to nonce conflicts
            
            // Helper function to create stream with retry
            const createStreamWithRetry = async (streamId, streamMetadata, streamDescription, maxRetries = 3) => {
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        Logger.info(`Creating stream (attempt ${attempt}/${maxRetries})...`);
                        const stream = await this.client.createStream({
                            id: streamId,
                            description: streamMetadata,
                            partitions: STREAM_CONFIG.MESSAGE_STREAM.PARTITIONS
                        });
                        Logger.info(`✓ Stream created: ${stream.id}`);
                        return stream;
                    } catch (error) {
                        Logger.warn(`Stream creation attempt ${attempt} failed:`, error.message);
                        
                        // Check if stream was actually created despite error
                        try {
                            const existingStream = await this.client.getStream(streamId);
                            if (existingStream) {
                                Logger.info(`✓ Stream exists (created despite error): ${existingStream.id}`);
                                return existingStream;
                            }
                        } catch (e) {
                            // Stream doesn't exist, continue retry
                        }
                        
                        if (attempt < maxRetries) {
                            // Wait before retry with exponential backoff
                            const delay = attempt * 3000;
                            Logger.info(`Retrying in ${delay/1000}s...`);
                            await new Promise(r => setTimeout(r, delay));
                        } else {
                            throw error;
                        }
                    }
                }
            };
            
            // Step 1: Create MESSAGE STREAM first
            Logger.info('Creating message stream...');
            const startTime = Date.now();
            
            const messageStream = await createStreamWithRetry(messageStreamId, metadata, 'message');
            
            // Step 2: Create EPHEMERAL STREAM
            Logger.info('Creating ephemeral stream...');
            const ephemeralStream = await createStreamWithRetry(ephemeralStreamId, ephemeralMetadata, 'ephemeral');
            
            const createTime = ((Date.now() - startTime) / 1000).toFixed(1);
            Logger.info(`✓ Both streams created in ${createTime}s`);

            // Step 3: Set permissions on both streams (can be parallel - different operations)
            Logger.info('Setting permissions on both streams...');
            const permStartTime = Date.now();
            
            if (type === 'public' || type === 'password') {
                // For read-only channels, grant only subscribe permissions to public
                const grantFn = readOnly 
                    ? (stream) => this.grantPublicReadOnlyPermissions(stream)
                    : (stream) => this.grantPublicPermissions(stream);
                
                const permResults = await Promise.allSettled([
                    grantFn(messageStream),
                    grantFn(ephemeralStream)
                ]);
                
                const permTime = ((Date.now() - permStartTime) / 1000).toFixed(1);
                permResults.forEach((result, i) => {
                    const name = i === 0 ? 'Message' : 'Ephemeral';
                    if (result.status === 'fulfilled') {
                        Logger.info(`✓ ${name} stream: public permissions set`);
                    } else {
                        Logger.error(`✗ ${name} stream permissions failed:`, result.reason?.message);
                    }
                });
                Logger.info(`Permissions configured in ${permTime}s`);
                
            } else if (type === 'native') {
                const permResults = await Promise.allSettled([
                    this.setStreamPermissions(messageStream.id, { public: false, members }),
                    this.setStreamPermissions(ephemeralStream.id, { public: false, members })
                ]);
                
                const permTime = ((Date.now() - permStartTime) / 1000).toFixed(1);
                permResults.forEach((result, i) => {
                    const name = i === 0 ? 'Message' : 'Ephemeral';
                    if (result.status === 'fulfilled') {
                        Logger.info(`✓ ${name} stream: permissions set`);
                    } else {
                        Logger.error(`✗ ${name} stream permissions failed:`, result.reason?.message);
                    }
                });
                Logger.info(`Permissions configured in ${permTime}s`);
            }
            
            const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
            Logger.info(`✓ Channel creation complete in ${totalTime}s total`);

            return {
                messageStreamId: messageStream.id,
                ephemeralStreamId: ephemeralStream.id,
                type: type,
                name: channelName
            };
        } catch (error) {
            Logger.warn('Create stream error:', error.message);
            
            // Check if streams were actually created despite error
            // Handle partial creation - message stream might exist even if ephemeral failed
            try {
                let existingMessageStream = null;
                let existingEphemeralStream = null;
                
                try {
                    existingMessageStream = await this.client.getStream(messageStreamId);
                    Logger.debug('Message stream exists');
                } catch (e) {
                    Logger.debug('Message stream does not exist');
                }
                
                try {
                    existingEphemeralStream = await this.client.getStream(ephemeralStreamId);
                    Logger.debug('Ephemeral stream exists');
                } catch (e) {
                    Logger.debug('Ephemeral stream does not exist');
                }
                
                // If at least message stream exists, configure permissions
                if (existingMessageStream) {
                    Logger.info('Configuring permissions on existing stream(s)...');
                    
                    // Use correct permission function based on readOnly flag
                    const grantFn = readOnly 
                        ? (stream) => this.grantPublicReadOnlyPermissions(stream)
                        : (stream) => this.grantPublicPermissions(stream);
                    
                    if (type === 'public' || type === 'password') {
                        await grantFn(existingMessageStream).catch(e => Logger.warn('Message perm error:', e.message));
                        if (existingEphemeralStream) {
                            await grantFn(existingEphemeralStream).catch(e => Logger.warn('Ephemeral perm error:', e.message));
                        }
                    } else if (type === 'native') {
                        await this.setStreamPermissions(messageStreamId, { public: false, members }).catch(e => Logger.warn('Perm error:', e.message));
                        if (existingEphemeralStream) {
                            await this.setStreamPermissions(ephemeralStreamId, { public: false, members }).catch(e => Logger.warn('Perm error:', e.message));
                        }
                    }
                    
                    // If both streams exist, return success
                    if (existingEphemeralStream) {
                        Logger.info('Both streams exist with permissions configured');
                        return {
                            messageStreamId: existingMessageStream.id,
                            ephemeralStreamId: existingEphemeralStream.id,
                            type: type,
                            name: channelName
                        };
                    }
                    
                    // Only message stream exists - try to create ephemeral again
                    Logger.info('Attempting to create missing ephemeral stream...');
                    try {
                        const newEphemeralStream = await this.client.createStream({
                            id: ephemeralStreamId,
                            description: ephemeralMetadata,
                            partitions: STREAM_CONFIG.EPHEMERAL_STREAM.PARTITIONS
                        });
                        
                        if (type === 'public' || type === 'password') {
                            await grantFn(newEphemeralStream).catch(e => Logger.warn('Ephemeral perm error:', e.message));
                        } else if (type === 'native') {
                            await this.setStreamPermissions(ephemeralStreamId, { public: false, members }).catch(e => Logger.warn('Perm error:', e.message));
                        }
                        
                        Logger.info('✓ Ephemeral stream created successfully on retry');
                        return {
                            messageStreamId: existingMessageStream.id,
                            ephemeralStreamId: newEphemeralStream.id,
                            type: type,
                            name: channelName
                        };
                    } catch (retryError) {
                        Logger.warn('Failed to create ephemeral stream on retry:', retryError.message);
                        // Return with just the message stream - channel will work in degraded mode
                        Logger.warn('Channel created in degraded mode (no ephemeral stream)');
                        return {
                            messageStreamId: existingMessageStream.id,
                            ephemeralStreamId: null,
                            type: type,
                            name: channelName
                        };
                    }
                }
            } catch (e) {
                Logger.debug('Recovery attempt failed:', e.message);
            }
            
            Logger.error('Failed to create streams:', error);
            throw error;
        }
    }

    /**
     * Set stream permissions using client.setPermissions (single batch transaction)
     * Grants permissions to public and/or specific members
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
            Logger.debug('Granting permissions to', options.members.length, 'members...');
            
            for (const member of options.members) {
                // Normalize to lowercase (Streamr uses lowercase internally)
                const normalizedMember = member.toLowerCase();
                
                Logger.debug('Granting permissions to member:', normalizedMember);
                
                assignments.push({
                    userId: normalizedMember,
                    permissions: ['subscribe', 'publish']
                });
            }
            
            Logger.debug('All member permissions granted');
        }

        if (assignments.length === 0) {
            Logger.debug('No permissions to set (owner-only)');
            return;
        }

        // Use setPermissions for batch update (single transaction)
        await this.client.setPermissions({
            streamId: streamId,
            assignments: assignments
        });

        Logger.debug('Permissions set successfully (batch)');
    }

    /**
     * Grant public SUBSCRIBE and PUBLISH permissions to a stream
     * Uses setPermissions for single transaction
     * @param {Object} stream - Stream object (or streamId string)
     */
    async grantPublicPermissions(stream, retries = 2) {
        // If string passed, get the stream object
        const streamId = typeof stream === 'string' ? stream : stream.id;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                Logger.debug(`Granting public permissions (attempt ${attempt}/${retries})...`);
                
                // Use setPermissions for consistent single-transaction behavior
                await this.client.setPermissions({
                    streamId: streamId,
                    assignments: [{
                        public: true,
                        permissions: ['subscribe', 'publish']
                    }]
                });
                
                Logger.debug('Public permissions granted successfully');
                return; // Success - exit
                
            } catch (error) {
                Logger.warn(`Permission attempt ${attempt} failed:`, error.message);
                
                if (attempt < retries) {
                    // Wait before retry (exponential backoff)
                    const delay = attempt * 3000;
                    Logger.debug(`Retrying in ${delay/1000}s...`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    Logger.error('All permission attempts failed for:', streamId);
                    throw error;
                }
            }
        }
    }

    /**
     * Grant public SUBSCRIBE only permissions (read-only channel)
     * @param {Object} stream - Stream object (or streamId string)
     */
    async grantPublicReadOnlyPermissions(stream, retries = 2) {
        const streamId = typeof stream === 'string' ? stream : stream.id;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                Logger.debug(`Granting public read-only permissions (attempt ${attempt}/${retries})...`);
                
                await this.client.setPermissions({
                    streamId: streamId,
                    assignments: [{
                        public: true,
                        permissions: ['subscribe']  // Only subscribe, no publish
                    }]
                });
                
                Logger.debug('Public read-only permissions granted successfully');
                return;
                
            } catch (error) {
                Logger.warn(`Read-only permission attempt ${attempt} failed:`, error.message);
                
                if (attempt < retries) {
                    const delay = attempt * 3000;
                    Logger.debug(`Retrying in ${delay/1000}s...`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    Logger.error('All read-only permission attempts failed for:', streamId);
                    throw error;
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
     * Uses client.setPermissions for batch operation (single transaction)
     * @param {string} streamId - Stream ID
     * @param {string[]} addresses - Array of Ethereum addresses
     */
    async grantPermissionsToAddresses(streamId, addresses) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        if (!addresses || addresses.length === 0) {
            Logger.debug('No addresses to grant permissions to');
            return;
        }

        try {
            Logger.debug('Granting permissions to addresses:', addresses);

            // Build assignments array for batch update
            const assignments = [];
            for (const address of addresses) {
                // Normalize to lowercase (Streamr uses lowercase internally)
                const normalizedAddress = address.toLowerCase();
                assignments.push({
                    userId: normalizedAddress,
                    permissions: ['subscribe', 'publish']
                });
            }

            // Use setPermissions for batch update (single transaction)
            await this.client.setPermissions({
                streamId: streamId,
                assignments: assignments
            });

            Logger.info('All permissions granted to addresses:', addresses);
        } catch (error) {
            Logger.error('Failed to grant permissions:', error);
            throw error;
        }
    }

    /**
     * Revoke permissions from specific addresses for a stream
     * Uses client.setPermissions with empty permissions array
     * @param {string} streamId - Stream ID
     * @param {string[]} addresses - Array of Ethereum addresses
     */
    async revokePermissionsFromAddresses(streamId, addresses) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        try {
            Logger.debug('Revoking permissions from addresses:', addresses);

            // Build assignments array with empty permissions (revoke all)
            const assignments = [];
            for (const address of addresses) {
                // Normalize to lowercase
                const normalizedAddress = address.toLowerCase();
                assignments.push({
                    userId: normalizedAddress,
                    permissions: [] // Empty array revokes all permissions
                });
            }

            if (assignments.length === 0) {
                Logger.debug('No addresses to revoke permissions from');
                return;
            }

            // Use setPermissions with empty permissions to revoke
            await this.client.setPermissions({
                streamId: streamId,
                assignments: assignments
            });

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

        // Normalize to lowercase (Streamr uses lowercase internally)
        const normalizedAddress = address.toLowerCase();
        Logger.debug('Updating permissions for:', normalizedAddress, 'canGrant:', permissionsToSet.canGrant);

        try {
            const stream = await this.client.getStream(streamId);
            
            if (permissionsToSet.canGrant) {
                // Grant the GRANT permission using setPermissions
                // First get current permissions, then add grant
                Logger.debug(`Granting GRANT permission to ${normalizedAddress}...`);
                
                await this.client.setPermissions({
                    streamId: streamId,
                    assignments: [{
                        userId: normalizedAddress,
                        permissions: ['subscribe', 'publish', 'grant']
                    }]
                });
                Logger.debug(`GRANT permission added to ${normalizedAddress}`);
            } else {
                // Revoke only the GRANT permission, keep subscribe/publish
                Logger.debug(`Revoking GRANT permission from ${normalizedAddress}...`);
                
                await this.client.setPermissions({
                    streamId: streamId,
                    assignments: [{
                        userId: normalizedAddress,
                        permissions: ['subscribe', 'publish'] // Remove grant by not including it
                    }]
                });
                Logger.debug(`GRANT permission removed from ${normalizedAddress}`);
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
     * Check if current user has DELETE permission on a stream
     * Uses Streamr SDK hasPermission for real-time on-chain check
     * @param {string} streamId - Stream ID
     * @returns {Promise<boolean>}
     */
    async hasDeletePermission(streamId) {
        if (!this.client) {
            return false;
        }

        try {
            const stream = await this.client.getStream(streamId);
            const StreamPermission = window.StreamPermission;
            
            if (!StreamPermission) {
                Logger.warn('StreamPermission not available, falling back to streamId check');
                // Fallback: check if streamId starts with current address
                const currentAddress = await this.client.getAddress();
                if (currentAddress) {
                    const streamOwner = streamId.split('/')[0]?.toLowerCase();
                    return streamOwner === currentAddress.toLowerCase();
                }
                return false;
            }

            const currentAddress = await this.client.getAddress();
            if (!currentAddress) {
                return false;
            }

            const hasDelete = await stream.hasPermission({
                permission: StreamPermission.DELETE,
                userId: currentAddress,
                allowPublic: false
            });
            
            Logger.debug('hasDeletePermission check:', { streamId, currentAddress: currentAddress.slice(0,10), hasDelete });
            return hasDelete;
        } catch (error) {
            Logger.error('Failed to check DELETE permission:', error);
            return false;
        }
    }

    /**
     * Delete a stream (only owner can delete)
     * For dual-stream architecture, deletes BOTH messageStream and ephemeralStream
     * @param {string} streamId - Stream ID (can be either messageStreamId or ephemeralStreamId)
     * @returns {Promise<void>}
     */
    async deleteStream(streamId) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Derive both stream IDs (v0 dual-stream architecture)
        let messageStreamId, ephemeralStreamId;
        
        if (isMessageStream(streamId)) {
            messageStreamId = streamId;
            ephemeralStreamId = deriveEphemeralId(streamId);
        } else if (isEphemeralStream(streamId)) {
            ephemeralStreamId = streamId;
            messageStreamId = deriveMessageId(streamId);
        } else {
            throw new Error('Invalid stream ID format - must end with -1 or -2');
        }

        try {
            Logger.info('Deleting channel streams...', { messageStreamId, ephemeralStreamId });
            
            // Unsubscribe from both streams first
            await this.unsubscribeFromDualStream(messageStreamId).catch(e => 
                Logger.warn('Unsubscribe warning:', e.message)
            );
            
            // Delete both streams in parallel
            const deleteResults = await Promise.allSettled([
                this.client.deleteStream(messageStreamId),
                ephemeralStreamId ? this.client.deleteStream(ephemeralStreamId) : Promise.resolve()
            ]);
            
            // Log results
            if (deleteResults[0].status === 'fulfilled') {
                Logger.info('✓ Message stream deleted:', messageStreamId);
            } else {
                Logger.error('✗ Failed to delete message stream:', deleteResults[0].reason?.message);
            }
            
            if (ephemeralStreamId && deleteResults[1].status === 'fulfilled') {
                Logger.info('✓ Ephemeral stream deleted:', ephemeralStreamId);
            } else if (ephemeralStreamId) {
                Logger.error('✗ Failed to delete ephemeral stream:', deleteResults[1].reason?.message);
            }
            
            // Throw if message stream failed (primary stream)
            if (deleteResults[0].status === 'rejected') {
                throw deleteResults[0].reason;
            }
            
        } catch (error) {
            Logger.error('Failed to delete streams:', error);
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

        try {
            // Get existing subscriptions or create new object
            // This allows subscribing to individual partitions without blocking others
            const partitionSubs = this.subscriptions.get(streamId) || {};

            // Subscribe to partition 0 (Control/Metadata) - only if not already subscribed
            if (handlers.onControl && !partitionSubs[0]) {
                Logger.debug('Subscribing to partition 0 (control) for:', streamId);
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

            // Subscribe to partition 1 (Text Messages) - only if not already subscribed
            if (handlers.onMessage && !partitionSubs[1]) {
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

            // Subscribe to partition 2 (Media) - only if not already subscribed
            if (handlers.onMedia && !partitionSubs[2]) {
                Logger.debug('Subscribing to partition 2 (media) for:', streamId);
                partitionSubs[2] = await this.client.subscribe({
                    streamId: streamId,
                    partition: 2
                }, async (message, metadata) => {
                    try {
                        let data = message;

                        // Decrypt if password provided
                        if (password && typeof message === 'string') {
                            data = await cryptoManager.decryptJSON(message, password);
                        }
                        
                        // Add sender info from metadata
                        if (metadata?.publisherId) {
                            data.senderId = metadata.publisherId;
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
     * Publish a text message to MESSAGE STREAM (partition 0 - stored)
     * In dual-stream architecture: caller must pass messageStreamId
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {Object} message - Message object
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishMessage(messageStreamId, message, password = null) {
        Logger.debug('publishMessage called - sending to messageStream partition 0:', { messageStreamId, messageId: message?.id });
        return await this.publish(messageStreamId, STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, message, password);
    }

    /**
     * Publish control/metadata to EPHEMERAL STREAM (partition 0 - ephemeral)
     * In dual-stream architecture: caller must pass ephemeralStreamId
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Object} control - Control data (presence, typing)
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishControl(ephemeralStreamId, control, password = null) {
        return await this.publish(ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL, control, password);
    }

    /**
     * Publish reaction to MESSAGE STREAM (partition 0 - stored with messages)
     * In dual-stream architecture: caller must pass messageStreamId
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {Object} reaction - Reaction data
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishReaction(messageStreamId, reaction, password = null) {
        Logger.debug('publishReaction called - sending to messageStream partition 0:', { messageStreamId, messageId: reaction?.messageId });
        return await this.publish(messageStreamId, STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, reaction, password);
    }

    /**
     * Publish media to EPHEMERAL STREAM (partition 1 - ephemeral chunks)
     * In dual-stream architecture: caller must pass ephemeralStreamId
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Object} media - Media data (chunks, requests)
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishMedia(ephemeralStreamId, media, password = null) {
        return await this.publish(ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA, media, password);
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
     * Subscribe to a specific partition only (lazy/on-demand loading)
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number (0=Messages, 1=Control, 2=Media)
     * @param {Function} handler - Message handler
     * @param {string} password - Optional password for encrypted channels
     * @returns {Promise<Object>} - Subscription object
     */
    async subscribeToPartition(streamId, partition, handler, password = null) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Get or create partition map for this stream
        let partitionSubs = this.subscriptions.get(streamId);
        if (!partitionSubs) {
            partitionSubs = {};
            this.subscriptions.set(streamId, partitionSubs);
        }

        // Skip if already subscribed to this partition
        if (partitionSubs[partition]) {
            Logger.debug(`Already subscribed to ${streamId} partition ${partition}`);
            return partitionSubs[partition];
        }

        const messageHandler = async (message, metadata) => {
            try {
                let data = message;
                if (password && typeof message === 'string') {
                    data = await cryptoManager.decryptJSON(message, password);
                }
                // Add sender info from metadata if available
                if (metadata?.publisherId && typeof data === 'object') {
                    data.senderId = metadata.publisherId;
                }
                handler(data);
            } catch (error) {
                Logger.error(`Failed to process partition ${partition} message:`, error);
            }
        };

        partitionSubs[partition] = await this.client.subscribe({
            streamId: streamId,
            partition: partition
        }, messageHandler);

        Logger.debug(`Subscribed to ${streamId} partition ${partition}`);
        return partitionSubs[partition];
    }

    /**
     * Unsubscribe from a specific partition only
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     */
    async unsubscribeFromPartition(streamId, partition) {
        const partitionSubs = this.subscriptions.get(streamId);
        
        if (partitionSubs && partitionSubs[partition]) {
            try {
                await partitionSubs[partition].unsubscribe();
                delete partitionSubs[partition];
                Logger.debug(`Unsubscribed from ${streamId} partition ${partition}`);
                
                // Clean up if no partitions remain
                if (Object.keys(partitionSubs).length === 0) {
                    this.subscriptions.delete(streamId);
                }
            } catch (error) {
                Logger.warn(`Failed to unsubscribe from partition ${partition}:`, error);
            }
        }
    }

    /**
     * Check if subscribed to a specific partition
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @returns {boolean}
     */
    isSubscribedToPartition(streamId, partition) {
        const partitionSubs = this.subscriptions.get(streamId);
        return partitionSubs && partitionSubs[partition] !== undefined;
    }

    /**
     * Ensure media partition is subscribed (lazy load when needed)
     * In dual-stream architecture: subscribes to ephemeralStream partition 1
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Function} handler - Media message handler
     * @param {string} password - Optional password
     */
    async ensureMediaSubscription(ephemeralStreamId, handler, password = null) {
        const mediaPartition = STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA;
        if (this.isSubscribedToPartition(ephemeralStreamId, mediaPartition)) {
            return;
        }
        return this.subscribeToPartition(ephemeralStreamId, mediaPartition, handler, password);
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
     * Enable storage for a MESSAGE STREAM only
     * In dual-stream architecture, storage is ONLY enabled for messageStream (-1)
     * The ephemeralStream (-2) is intentionally NOT stored for privacy
     * 
     * @param {string} messageStreamId - Message Stream ID (must end with -1)
     * @returns {Promise<boolean>} - Success status
     */
    async enableStorage(messageStreamId) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        // Safety check: only enable storage for message streams
        if (!isMessageStream(messageStreamId)) {
            Logger.warn('enableStorage called on non-message stream, ignoring:', messageStreamId);
            return false;
        }
        
        // Ensure NODE_ADDRESS is set
        const nodeAddress = STREAM_CONFIG.NODE_ADDRESS || STREAM_CONFIG.LOGSTORE_NODE;
        
        try {
            const stream = await this.client.getStream(messageStreamId);
            await stream.addToStorageNode(nodeAddress);
            Logger.info('Storage enabled for message stream:', messageStreamId, '(node:', nodeAddress.slice(0, 10) + '...)');
            return true;
        } catch (error) {
            Logger.warn('Failed to enable storage:', error.message);
            return false;
        }
    }

    /**
     * Fetch historical messages from MESSAGE STREAM
     * In dual-stream architecture, only messageStream has storage
     * 
     * @param {string} messageStreamId - Message Stream ID (must end with -1)
     * @param {number} partition - Partition number (should be 0 for messages)
     * @param {number} count - Number of messages to fetch
     * @returns {Promise<Array>} - Array of message contents
     */
    async fetchHistory(messageStreamId, partition = 0, count = STREAM_CONFIG.INITIAL_MESSAGES) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        const messages = [];
        
        try {
            // Streamr SDK resend: await before iterating
            // Format: await client.resend(streamId, { last: N, partition: P })
            const resend = await this.client.resend(
                messageStreamId,
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
     * Fetch older historical messages from MESSAGE STREAM (for lazy loading / pagination)
     * Uses timestamp-based pagination to get messages older than a given point
     * In dual-stream architecture, only messageStream has stored history
     * 
     * @param {string} messageStreamId - Message Stream ID (should end with -1)
     * @param {number} partition - Partition number (should be 0)
     * @param {number} beforeTimestamp - Unix timestamp (ms) - fetch messages before this
     * @param {number} count - Number of messages to fetch
     * @param {string} password - Password for encrypted channels (optional)
     * @returns {Promise<{messages: Array, hasMore: boolean}>} - Messages and pagination info
     */
    async fetchOlderHistory(messageStreamId, partition = 0, beforeTimestamp, count = STREAM_CONFIG.LOAD_MORE_COUNT, password = null) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        const messages = [];
        
        // Ephemeral message types that should NEVER be loaded from history
        const EPHEMERAL_TYPES = ['presence', 'typing'];
        
        // Valid message types for partition 0 (stored messages)
        const isValidStoredMessage = (msg) => {
            if (msg?.type === 'text') return true;
            if (msg?.id && msg?.text && msg?.sender && msg?.timestamp && !msg?.type) return true;
            if (msg?.type === 'reaction') return true;
            if (msg?.type === 'image' && msg?.imageId) return true;
            if (msg?.type === 'video_announce' && msg?.metadata) return true;
            return false;
        };
        
        try {
            Logger.debug(`Fetching ${count} older messages before ${new Date(beforeTimestamp).toISOString()}`);
            
            // Streamr SDK resend with range: from epoch to beforeTimestamp
            // We request more than needed to account for filtered messages
            const resend = await this.client.resend(
                messageStreamId,
                { 
                    partition: partition,
                    from: { timestamp: 0 },
                    to: { timestamp: beforeTimestamp - 1 } // -1 to exclude the boundary message
                }
            );
            
            // Collect all messages in range, then take the last N
            const allMessages = [];
            
            for await (const message of resend) {
                try {
                    let content = message.content || message;
                    
                    // Decrypt if password provided
                    if (password && typeof content === 'string') {
                        try {
                            content = await cryptoManager.decryptJSON(content, password);
                        } catch (decryptError) {
                            continue; // Skip messages we can't decrypt
                        }
                    }
                    
                    // Skip ephemeral messages
                    if (content?.type && EPHEMERAL_TYPES.includes(content.type)) {
                        continue;
                    }
                    
                    // For partition 0: only accept valid stored message types
                    if (partition === 0 && !isValidStoredMessage(content)) {
                        continue;
                    }
                    
                    allMessages.push(content);
                } catch (e) {
                    Logger.warn('Error processing historical message:', e.message);
                }
            }
            
            // Take the last N messages (most recent before the timestamp)
            const startIndex = Math.max(0, allMessages.length - count);
            const resultMessages = allMessages.slice(startIndex);
            
            // hasMore is true if there were more messages than we're returning
            const hasMore = allMessages.length > count;
            
            Logger.info(`Loaded ${resultMessages.length} older messages (hasMore: ${hasMore})`);
            
            return {
                messages: resultMessages,
                hasMore: hasMore
            };
        } catch (error) {
            Logger.warn('Older history fetch error:', error.message);
            return { messages: [], hasMore: false };
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
    async subscribeWithHistory(streamId, partition, handler, historyCount = STREAM_CONFIG.INITIAL_MESSAGES, password = null) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        const messageHandler = async (message, metadata) => {
            try {
                let data = message;
                
                // Decrypt if password provided
                if (password && typeof message === 'string') {
                    data = await cryptoManager.decryptJSON(message, password);
                }
                
                // Add sender info from metadata (for media partition)
                if (metadata?.publisherId && typeof data === 'object') {
                    data.senderId = metadata.publisherId;
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
            // Pass password for decryption of encrypted channels
            this.fetchHistoryAsync(streamId, partition, historyCount, handler, password);
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
     * @param {string} password - Password for decryption (optional)
     */
    async fetchHistoryAsync(streamId, partition, count, handler, password = null) {
        try {
            Logger.debug(`Fetching ${count} historical messages for partition ${partition}${password ? ' (encrypted)' : ''}...`);
            
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
            
            // Helper to check if message is an image
            const isImageMessage = (msg) => msg?.type === 'image' && msg?.imageId;
            
            // Helper to check if message is a video announcement
            const isVideoMessage = (msg) => msg?.type === 'video_announce' && msg?.metadata;
            
            // Valid message types for partition 0 (stored messages)
            const isValidStoredMessage = (msg) => {
                return isTextMessage(msg) || isReaction(msg) || isImageMessage(msg) || isVideoMessage(msg);
            };
            
            for await (const message of resend) {
                rawCount++;
                try {
                    let content = message.content || message;
                    
                    // Decrypt if password provided (for encrypted channels)
                    if (password && typeof content === 'string') {
                        try {
                            content = await cryptoManager.decryptJSON(content, password);
                        } catch (decryptError) {
                            // Log first few decrypt failures for debugging
                            if (rawCount <= 3) {
                                Logger.debug(`Failed to decrypt message ${rawCount}:`, decryptError.message);
                            }
                            skippedCount++;
                            continue;
                        }
                    }
                    
                    // Log first few messages for debugging
                    if (rawCount <= 3) {
                        Logger.debug(`History message ${rawCount} from partition ${partition}:`, JSON.stringify(content).slice(0, 200));
                    }
                    
                    // Skip ephemeral messages (presence, typing) - they don't belong in history
                    if (content?.type && EPHEMERAL_TYPES.includes(content.type)) {
                        skippedCount++;
                        continue;
                    }
                    
                    // For partition 0 (messages): only accept valid stored message types
                    if (partition === 0) {
                        if (!isValidStoredMessage(content)) {
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
     * Subscribe to dual-stream channel (message + ephemeral streams)
     * 
     * Message Stream (-1):
     *   - Partition 0: Text messages, reactions, images, video announcements (WITH history)
     * 
     * Ephemeral Stream (-2):
     *   - Partition 0: Control/metadata (presence, typing) - NO history
     *   - Partition 1: Media chunks (P2P transfer) - NO history
     * 
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Object} handlers - { onMessage, onControl, onMedia }
     * @param {string} password - Password for encrypted channels (optional)
     * @param {number} historyCount - Number of historical messages to fetch
     * @returns {Promise<boolean>} - Success
     */
    async subscribeToDualStream(messageStreamId, ephemeralStreamId, handlers, password = null, historyCount = STREAM_CONFIG.INITIAL_MESSAGES) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Validate stream IDs
        if (!isMessageStream(messageStreamId)) {
            Logger.warn('Invalid messageStreamId (should end with -1):', messageStreamId);
        }
        if (!isEphemeralStream(ephemeralStreamId)) {
            Logger.warn('Invalid ephemeralStreamId (should end with -2):', ephemeralStreamId);
        }

        try {
            // 1. Subscribe to MESSAGE STREAM (with storage)
            if (!this.subscriptions.has(messageStreamId)) {
                const msgSubs = {};
                
                // Partition 0: Messages WITH history
                if (handlers.onMessage) {
                    Logger.debug('Subscribing to messageStream partition 0 (messages) with history');
                    msgSubs[STREAM_CONFIG.MESSAGE_STREAM.MESSAGES] = await this.subscribeWithHistory(
                        messageStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                        handlers.onMessage,
                        historyCount,
                        password
                    );
                }
                
                this.subscriptions.set(messageStreamId, msgSubs);
                Logger.info('Subscribed to message stream:', messageStreamId);
            }

            // 2. Subscribe to EPHEMERAL STREAM (no storage)
            if (!this.subscriptions.has(ephemeralStreamId)) {
                const ephSubs = {};
                
                // Partition 0: Control (presence, typing) - NO history
                if (handlers.onControl) {
                    Logger.debug('Subscribing to ephemeralStream partition 0 (control) - no history');
                    ephSubs[STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL] = await this.subscribeWithHistory(
                        ephemeralStreamId,
                        STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL,
                        handlers.onControl,
                        0, // NO history - ephemeral
                        password
                    );
                }
                
                // Partition 1: Media chunks - NO history
                if (handlers.onMedia) {
                    Logger.debug('Subscribing to ephemeralStream partition 1 (media) - no history');
                    ephSubs[STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA] = await this.subscribeWithHistory(
                        ephemeralStreamId,
                        STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA,
                        handlers.onMedia,
                        0, // NO history - ephemeral P2P
                        password
                    );
                }
                
                this.subscriptions.set(ephemeralStreamId, ephSubs);
                Logger.info('Subscribed to ephemeral stream:', ephemeralStreamId);
            }

            return true;
        } catch (error) {
            Logger.error('Failed to subscribe to dual-stream:', error);
            throw error;
        }
    }

    /**
     * Unsubscribe from dual-stream channel
     * @param {string} messageStreamId - Message Stream ID
     * @param {string} ephemeralStreamId - Ephemeral Stream ID
     */
    async unsubscribeFromDualStream(messageStreamId, ephemeralStreamId) {
        await Promise.allSettled([
            this.unsubscribe(messageStreamId),
            this.unsubscribe(ephemeralStreamId)
        ]);
        Logger.debug('Unsubscribed from dual-stream:', messageStreamId);
    }

    // ==================== End Storage/Subscription Methods ====================
}

// Export singleton instance and config
export const streamrController = new StreamrController();
export { STREAM_CONFIG, deriveEphemeralId, deriveMessageId, isMessageStream, isEphemeralStream };
