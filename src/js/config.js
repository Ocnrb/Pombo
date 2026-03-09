/**
 * Application Configuration
 * Centralized configuration for network, retry logic, and app settings
 */

export const CONFIG = {
    // Polygon Network Configuration
    network: {
        chainId: 137,
        name: 'Polygon Mainnet',
        currency: {
            name: 'POL',
            symbol: 'POL',
            decimals: 18
        },
        rpcEndpoints: [
            'https://rpc.ankr.com/polygon',
            'https://polygon.drpc.org',
            'https://polygon-bor-rpc.publicnode.com'
        ],
        blockExplorer: 'https://polygonscan.com'
    },

    // Retry Configuration
    retry: {
        maxAttempts: 7,
        baseDelayMs: 3000,
        // Multiplier for exponential backoff (attempt * baseDelayMs)
        backoffMultiplier: 1
    },

    // Stream Configuration
    stream: {
        // Number of messages to load on join
        initialMessages: 30,
        // Number of messages to load on scroll
        loadMoreCount: 30,
        // Message stream partitions
        messagePartitions: 1,
        // Ephemeral stream partitions (control + media)
        ephemeralPartitions: 2
    },

    // Storage Providers
    storage: {
        // LogStore Virtual Storage Node
        logstoreNode: '0x17f98084757a75add72bf6c5b5a6f69008c28a57',
        // Default provider: 'streamr' or 'logstore'
        defaultProvider: 'streamr',
        // Default retention days for Streamr storage
        defaultRetentionDays: 180
    },

    // Application Metadata
    app: {
        name: 'pombo',
        version: '1'
    }
};

/**
 * Get RPC endpoints for Streamr SDK configuration
 * @returns {Array<{url: string}>} - Array of RPC endpoint objects
 */
export function getRpcEndpoints() {
    return CONFIG.network.rpcEndpoints.map(url => ({ url }));
}

/**
 * Get network configuration for wallet connection
 * @returns {Object} - Network params for wallet_addEthereumChain
 */
export function getNetworkParams() {
    return {
        chainId: `0x${CONFIG.network.chainId.toString(16)}`,
        chainName: CONFIG.network.name,
        nativeCurrency: CONFIG.network.currency,
        rpcUrls: CONFIG.network.rpcEndpoints,
        blockExplorerUrls: [CONFIG.network.blockExplorer]
    };
}
