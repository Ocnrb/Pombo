/**
 * Application Configuration
 * Centralized configuration for network, retry logic, and app settings
 */

// RPC Presets for user selection
// Order matters for 'auto' - most reliable CORS-friendly endpoints first
export const RPC_PRESETS = {
    'auto': {
        name: 'Auto (try all)',
        urls: [
            'https://polygon.drpc.org',           // Very reliable, good CORS
            'https://polygon-bor-rpc.publicnode.com', // Reliable, good CORS
            'https://rpc.ankr.com/polygon',       // Reliable, may throttle heavy use
            'https://polygon.meowrpc.com',        // Good alternative
            'https://polygon.gateway.tenderly.co', // Good alternative
            'https://polygon.llamarpc.com',       // Sometimes has DNS issues
            'https://1rpc.io/matic'               // Rate limits quickly from localhost
        ]
    },
    'drpc': {
        name: 'dRPC (Recommended)',
        urls: ['https://polygon.drpc.org']
    },
    'publicnode': {
        name: 'PublicNode',
        urls: ['https://polygon-bor-rpc.publicnode.com']
    },
    'ankr': {
        name: 'Ankr',
        urls: ['https://rpc.ankr.com/polygon']
    },
    'meowrpc': {
        name: 'Meow RPC',
        urls: ['https://polygon.meowrpc.com']
    },
    'tenderly': {
        name: 'Tenderly',
        urls: ['https://polygon.gateway.tenderly.co']
    },
    'llamarpc': {
        name: 'Llama RPC',
        urls: ['https://polygon.llamarpc.com']
    },
    '1rpc': {
        name: '1RPC (Privacy)',
        urls: ['https://1rpc.io/matic']
    }
};

// Default RPC endpoints (used when no user preference)
export const DEFAULT_RPC_ENDPOINTS = RPC_PRESETS['auto'].urls;

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
            'https://polygon.drpc.org',
            'https://polygon-bor-rpc.publicnode.com',
            'https://rpc.ankr.com/polygon',
            'https://polygon.meowrpc.com',
            'https://polygon.gateway.tenderly.co',
            'https://polygon.llamarpc.com',
            'https://1rpc.io/matic'
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

    // DM Configuration
    dm: {
        // Deterministic stream path prefix
        streamPrefix: 'Pombo-DM',
        // Max conversations stored locally
        maxConversations: 100,
        // Max sent messages per conversation (local storage)
        maxSentMessages: 200,
        // Inbox history to load on login
        inboxHistoryCount: 100,
    },

    // Application Metadata
    app: {
        name: 'pombo',
        version: '1'
    }
};

/**
 * Get RPC endpoints for Streamr SDK configuration
 * Checks user preference first, falls back to defaults
 * @returns {Array<{url: string}>} - Array of RPC endpoint objects
 */
export function getRpcEndpoints() {
    // Check for user preference in localStorage
    const saved = localStorage.getItem('pombo_rpc_preference');
    if (saved) {
        try {
            const pref = JSON.parse(saved);
            if (pref.preset === 'custom' && pref.customUrl) {
                return [{ url: pref.customUrl }];
            }
            const urls = RPC_PRESETS[pref.preset]?.urls;
            if (urls && urls.length > 0) {
                return urls.map(url => ({ url }));
            }
        } catch (e) {
            // Invalid saved preference, use defaults
        }
    }
    
    // Default: use dRPC (most reliable)
    return RPC_PRESETS['drpc'].urls.map(url => ({ url }));
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
