/**
 * The Graph API Module
 * Provides access to Streamr subgraph data for stream/channel information
 * 
 * Subgraph: https://thegraph.com/explorer/subgraphs/EGWFdhhiWypDuz22Uy7b3F69E9MEkyfU9iAQMttkH5Rj
 * 
 * Features:
 * - Get stream permissions (detect public vs native)
 * - Get stream members
 * - Check user access to stream
 * - Get stream metadata
 */

import { secureStorage } from './secureStorage.js';
import { Logger } from './logger.js';

// Default API key (fallback if user doesn't provide their own)
const DEFAULT_API_KEY = 'a637f5422fb071df7782cd6e3580f614';

// Subgraph ID on Arbitrum One
const SUBGRAPH_ID = 'EGWFdhhiWypDuz22Uy7b3F69E9MEkyfU9iAQMttkH5Rj';

class GraphAPI {
    constructor() {
        this.cache = new Map();
        this.CACHE_DURATION = 30000; // 30 seconds cache
    }

    /**
     * Get the API key (user's or default)
     * @returns {string} - The Graph API key
     */
    getApiKey() {
        if (secureStorage.isStorageUnlocked()) {
            const userKey = secureStorage.getGraphApiKey();
            if (userKey && userKey.trim()) {
                return userKey.trim();
            }
        }
        return DEFAULT_API_KEY;
    }

    /**
     * Set user's API key
     * @param {string} apiKey - The Graph API key
     */
    async setApiKey(apiKey) {
        if (secureStorage.isStorageUnlocked()) {
            await secureStorage.setGraphApiKey(apiKey);
            Logger.info('Graph API key updated');
        }
    }

    /**
     * Check if using default API key
     * @returns {boolean}
     */
    isUsingDefaultKey() {
        return this.getApiKey() === DEFAULT_API_KEY;
    }

    /**
     * Get the subgraph endpoint URL
     * @returns {string}
     */
    getEndpoint() {
        return `https://gateway.thegraph.com/api/${this.getApiKey()}/subgraphs/id/${SUBGRAPH_ID}`;
    }

    /**
     * Execute a GraphQL query
     * @param {string} query - GraphQL query string
     * @param {Object} variables - Query variables (optional)
     * @returns {Promise<Object>} - Query result
     */
    async query(query, variables = {}) {
        try {
            const response = await fetch(this.getEndpoint(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query, variables })
            });

            if (!response.ok) {
                throw new Error(`Graph API error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();

            if (result.errors) {
                Logger.error('GraphQL errors:', result.errors);
                throw new Error(result.errors[0]?.message || 'GraphQL query failed');
            }

            return result.data;
        } catch (error) {
            Logger.error('Graph API query failed:', error);
            throw error;
        }
    }

    /**
     * Get cached data or fetch fresh
     * @param {string} cacheKey - Cache key
     * @param {Function} fetchFn - Function to fetch data
     * @returns {Promise<any>}
     */
    async getCached(cacheKey, fetchFn) {
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
            return cached.data;
        }

        const data = await fetchFn();
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
    }

    // ==================== STREAM QUERIES ====================

    /**
     * Get stream information including permissions
     * @param {string} streamId - Stream ID
     * @returns {Promise<Object|null>} - Stream data or null if not found
     */
    async getStream(streamId) {
        const cacheKey = `stream:${streamId}`;
        
        return this.getCached(cacheKey, async () => {
            const query = `
                query GetStream($id: ID!) {
                    stream(id: $id) {
                        id
                        metadata
                        createdAt
                        updatedAt
                    }
                }
            `;

            const data = await this.query(query, { id: streamId.toLowerCase() });
            return data?.stream || null;
        });
    }

    /**
     * Get stream permissions using streamPermissions entity
     * @param {string} streamId - Stream ID
     * @returns {Promise<Array>} - Array of permission objects
     */
    async getStreamPermissions(streamId) {
        const cacheKey = `permissions:${streamId}`;
        
        return this.getCached(cacheKey, async () => {
            // Use streamId as-is (case-sensitive in subgraph)
            const query = `
                query GetStreamPermissions {
                    streamPermissions(
                        first: 100, 
                        where: { stream: "${streamId}" },
                        subgraphError: allow
                    ) {
                        id
                        userAddress
                        userId
                        canEdit
                        canDelete
                        canGrant
                        publishExpiration
                        subscribeExpiration
                    }
                }
            `;

            Logger.debug('Querying streamPermissions for:', streamId);
            Logger.debug('Query:', query);
            const data = await this.query(query);
            Logger.debug('Permissions response:', data);
            return data?.streamPermissions || [];
        });
    }

    /**
     * Detect stream/channel type from metadata (primary) or permissions (fallback)
     * @param {string} streamId - Stream ID
     * @returns {Promise<string>} - 'public' | 'password' | 'native' | 'unknown'
     */
    async detectStreamType(streamId) {
        try {
            Logger.debug('Detecting stream type for:', streamId);
            
            // First, try to get type from metadata (most reliable)
            try {
                const stream = await this.getStream(streamId);
                if (stream?.metadata) {
                    const outerMetadata = JSON.parse(stream.metadata || '{}');
                    const mootMetadata = JSON.parse(outerMetadata.description || '{}');
                    
                    if (mootMetadata.app === 'moot' && mootMetadata.type) {
                        Logger.debug('Type from metadata:', mootMetadata.type);
                        return mootMetadata.type;
                    }
                }
            } catch (metaError) {
                Logger.debug('Could not get type from metadata:', metaError.message);
            }
            
            // Fallback: check permissions (can only detect public vs native)
            const permissions = await this.getStreamPermissions(streamId);
            Logger.debug('Permissions for type detection:', permissions);
            
            if (permissions.length === 0) {
                Logger.debug('No permissions found, returning unknown');
                return 'unknown';
            }

            // Check for public permissions (userAddress is null or 0x0...)
            const hasPublicPermission = permissions.some(p => {
                const addr = p.userAddress;
                const isPublic = addr === null || 
                    addr === '0x0000000000000000000000000000000000000000';
                return isPublic;
            });

            // If public permissions, could be 'public' or 'password' - default to 'public'
            // (metadata check above would have caught 'password' if available)
            const result = hasPublicPermission ? 'public' : 'native';
            Logger.debug('Detected type from permissions:', result);
            return result;
        } catch (error) {
            Logger.warn('Failed to detect stream type:', error);
            return 'unknown';
        }
    }

    /**
     * Get list of members (addresses with permissions) for a stream
     * @param {string} streamId - Stream ID
     * @returns {Promise<Array>} - Array of { address, canPublish, canSubscribe, canGrant, canEdit, isOwner }
     */
    async getStreamMembers(streamId) {
        try {
            const permissions = await this.getStreamPermissions(streamId);
            Logger.debug('Permissions for members:', permissions);
            
            const now = Math.floor(Date.now() / 1000);
            
            // Filter out public permissions and map to member format
            return permissions
                .filter(p => p.userAddress && p.userAddress !== '0x0000000000000000000000000000000000000000')
                .map(p => {
                    // Check expiration times (null = unlimited)
                    const canPublish = p.publishExpiration === null || 
                        parseInt(p.publishExpiration) > now;
                    const canSubscribe = p.subscribeExpiration === null || 
                        parseInt(p.subscribeExpiration) > now;
                    
                    return {
                        address: p.userAddress,
                        canPublish,
                        canSubscribe,
                        canGrant: p.canGrant || false,
                        canEdit: p.canEdit || false,
                        canDelete: p.canDelete || false,
                        // isOwner = has all admin permissions
                        isOwner: p.canGrant && p.canEdit && p.canDelete
                    };
                });
        } catch (error) {
            Logger.warn('Failed to get stream members:', error);
            return [];
        }
    }

    /**
     * Check if a specific address has access to a stream
     * @param {string} streamId - Stream ID
     * @param {string} userAddress - User's Ethereum address
     * @returns {Promise<Object>} - { hasAccess, canPublish, canSubscribe, isOwner }
     */
    async checkUserAccess(streamId, userAddress) {
        try {
            const permissions = await this.getStreamPermissions(streamId);
            const normalizedUser = userAddress.toLowerCase();

            // Check for public access
            const hasPublicAccess = permissions.some(p => 
                p.userAddress === null || 
                p.userAddress === '0x0000000000000000000000000000000000000000'
            );

            if (hasPublicAccess) {
                return {
                    hasAccess: true,
                    canPublish: true,
                    canSubscribe: true,
                    isOwner: false,
                    isPublic: true
                };
            }

            // Check for specific user permission
            const userPerm = permissions.find(p => 
                p.userAddress?.toLowerCase() === normalizedUser
            );

            if (!userPerm) {
                return {
                    hasAccess: false,
                    canPublish: false,
                    canSubscribe: false,
                    isOwner: false,
                    isPublic: false
                };
            }

            const now = Math.floor(Date.now() / 1000);
            const canPublish = userPerm.publishExpiration === null || 
                parseInt(userPerm.publishExpiration) > now;
            const canSubscribe = userPerm.subscribeExpiration === null || 
                parseInt(userPerm.subscribeExpiration) > now;

            return {
                hasAccess: canPublish || canSubscribe,
                canPublish,
                canSubscribe,
                isOwner: userPerm.canGrant && userPerm.canEdit && userPerm.canDelete,
                isPublic: false
            };
        } catch (error) {
            console.warn('Failed to check user access:', error);
            return {
                hasAccess: false,
                canPublish: false,
                canSubscribe: false,
                isOwner: false,
                isPublic: false,
                error: error.message
            };
        }
    }

    /**
     * Get stream owner address
     * @param {string} streamId - Stream ID
     * @returns {Promise<string|null>} - Owner address or null
     */
    async getStreamOwner(streamId) {
        try {
            const members = await this.getStreamMembers(streamId);
            const owner = members.find(m => m.isOwner);
            return owner?.address || null;
        } catch (error) {
            Logger.warn('Failed to get stream owner:', error);
            return null;
        }
    }

    /**
     * Search for streams by various criteria
     * @param {Object} options - Search options
     * @param {string} options.owner - Filter by owner address
     * @param {number} options.first - Number of results (default: 20)
     * @param {number} options.skip - Offset for pagination (default: 0)
     * @returns {Promise<Array>} - Array of stream objects
     */
    async searchStreams(options = {}) {
        const { owner, first = 20, skip = 0 } = options;

        let whereClause = '';
        if (owner) {
            whereClause = `, where: { permissions_: { userAddress: "${owner.toLowerCase()}", canEdit: true } }`;
        }

        const query = `
            query SearchStreams {
                streams(first: ${first}, skip: ${skip}${whereClause}, orderBy: createdAt, orderDirection: desc) {
                    id
                    metadata
                    createdAt
                    updatedAt
                }
            }
        `;

        try {
            const data = await this.query(query);
            return data?.streams || [];
        } catch (error) {
            Logger.warn('Failed to search streams:', error);
            return [];
        }
    }

    /**
     * Get public Moot channels from The Graph
     * Queries streams with Moot metadata and public permissions
     * @param {Object} options - Query options
     * @param {number} options.first - Number of results (default: 50)
     * @param {number} options.skip - Offset for pagination (default: 0)
     * @returns {Promise<Array>} - Array of public Moot channels
     */
    async getPublicMootChannels(options = {}) {
        const { first = 50, skip = 0 } = options;
        const cacheKey = `moot_public:${first}:${skip}`;

        return this.getCached(cacheKey, async () => {
            // Query streams that have public permissions (userAddress is 0x0...0 for public)
            const query = `
                query GetPublicMootChannels {
                    streams(
                        first: ${first}, 
                        skip: ${skip}, 
                        orderBy: updatedAt, 
                        orderDirection: desc,
                        where: { permissions_: { userAddress: "0x0000000000000000000000000000000000000000" } },
                        subgraphError: allow
                    ) {
                        id
                        metadata
                        createdAt
                        updatedAt
                    }
                }
            `;

            try {
                Logger.debug('Querying public Moot channels from The Graph...');
                const data = await this.query(query);
                const streams = data?.streams || [];
                
                // Filter and transform to Moot channel format
                const channels = [];
                for (const stream of streams) {
                    try {
                        // Parse metadata - Streamr stores { partitions, description }
                        // Our Moot JSON is inside the description field
                        const outerMetadata = JSON.parse(stream.metadata || '{}');
                        const mootMetadata = JSON.parse(outerMetadata.description || '{}');
                        
                        if (mootMetadata.app === 'moot') {
                            channels.push({
                                streamId: stream.id,
                                name: mootMetadata.name || stream.id.split('/')[1]?.split('_')[0] || 'Unknown',
                                type: mootMetadata.type || 'public',
                                createdAt: mootMetadata.createdAt || parseInt(stream.createdAt) * 1000,
                                updatedAt: parseInt(stream.updatedAt) * 1000,
                                // Owner is the first part of streamId (address/path format)
                                createdBy: stream.id.split('/')[0]
                            });
                        }
                    } catch (parseError) {
                        // Not a valid Moot channel, skip
                        continue;
                    }
                }

                Logger.debug(`Found ${channels.length} public Moot channels`);
                return channels;
            } catch (error) {
                Logger.warn('Failed to get public Moot channels:', error);
                return [];
            }
        });
    }

    /**
     * Test API connection
     * @returns {Promise<boolean>} - True if connection successful
     */
    async testConnection() {
        try {
            const query = `{ _meta { block { number } } }`;
            const data = await this.query(query);
            Logger.info('Graph API connected, latest block:', data?._meta?.block?.number);
            return true;
        } catch (error) {
            Logger.error('Graph API connection failed:', error);
            return false;
        }
    }
}

// Export singleton instance
export const graphAPI = new GraphAPI();
