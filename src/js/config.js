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
        // Multiplier for exponential backoff: delay = baseDelay * multiplier^(attempt-1)
        backoffMultiplier: 2
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
        // Number of inbox messages to fetch per pagination request
        loadMoreCount: 100,
        // Time window (ms) per pagination search (7 days)
        searchWindowMs: 7 * 24 * 3600 * 1000,
        // Pre-agreed encryption key for Streamr native layer (all Pombo DMs use this)
        // Real E2E security comes from ECDH app-layer encryption, not this key
        // This allows history/resend without key-exchange (publisher offline)
        encryptionKeyId: 'pombo-dm-v1',
        encryptionKeyHex: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'
    },

    // Channel Settings
    channels: {
        reactionDebounceMs: 500,       // Minimum time between same reaction sends
        onlineTimeoutMs: 25000,        // 25s to consider user offline (5x heartbeat)
        maxRetries: 3,                 // Message publish retry limit
        retryDelayMs: 2000,            // Delay between retries
        batchWindowMs: 100,            // Window to collect messages for batch verification
        batchMaxSize: 50               // Maximum batch size before flushing
    },

    // Identity & ENS
    identity: {
        ensCacheDurationMs: 24 * 60 * 60 * 1000,      // 24h ENS cache
        maxEnsCacheSize: 500,                          // Max cached ENS entries
        messageTimestampToleranceMs: 5 * 60 * 1000     // 5min replay-attack window
    },

    // Media / File Transfer
    media: {
        maxImageCacheBytes: 100 * 1024 * 1024,            // 100MB max image cache in memory
        imageMaxWidth: 1280,
        imageMaxHeight: 720,
        imageQuality: 0.92,
        pieceSize: 220 * 1024,                  // 220KB chunks
        pieceSendDelayMs: 5,                    // 5ms delay between piece sends
        maxConcurrentRequests: 8,
        concurrentSends: 25,                     // Parallel Streamr publishes (bounded concurrency)
        pieceRequestTimeoutMs: 5000,            // 5s per piece retry timeout
        maxFileSize: 500 * 1024 * 1024,        // 500MB max upload
        minSeeders: 1,
        preferredSeeders: 3,
        seederRequestIntervalMs: 1000,
        seederDiscoveryTimeoutMs: 30000,
        seederRefreshIntervalMs: 10000,
        maxSeederRequests: 10,
        maxSeedStorage: 700 * 1024 * 1024,     // 700MB persistent storage
        seedFilesExpireDays: 7,
        pushWatchdogIntervalMs: 3000,           // Check for missing pieces every 3s
        pushWatchdogStartDelayMs: 2000,         // Wait 2s before first watchdog check
        pushStallTimeoutMs: 5000                // If no new pieces in 5s, request missing
    },

    // Subscription Manager / Polling
    subscriptions: {
        pollIntervalMs: 30000,         // 30s between background polls
        pollBatchSize: 3,              // Channels per poll cycle
        pollStaggerDelayMs: 2000,      // Delay between channel checks
        minPollIntervalMs: 10000,      // Minimum time between checks for same channel
        maxConcurrentSubs: 1,          // Only 1 full subscription at a time
        activityCheckMessages: 3,      // Messages to fetch for activity check
        previewPresenceIntervalMs: 20000, // Presence broadcast interval in preview
        initialPollDelayMs: 5000       // Delay before first background poll
    },

    // Push Notifications
    push: {
        tagBytes: 1,                   // K-anonymity tag size (256 possible tags)
        powDifficulty: 4,              // PoW leading zeros required
        powMaxTimeMs: 30000,           // Max PoW computation time
        powYieldInterval: 10000,       // Yield to UI every N iterations
        reRegistrationIntervalMs: 6 * 60 * 60 * 1000  // 6h token refresh
    },

    // Notifications UI
    notifications: {
        inviteToastDurationMs: 15000   // Invite toast display duration
    },

    // Cryptography
    crypto: {
        pbkdf2Iterations: 310000       // PBKDF2 key derivation iterations
    },

    // Graph API
    graph: {
        cacheDurationMs: 30000         // 30s query result cache
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
