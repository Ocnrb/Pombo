// pushProtocol.js - Push Notifications Protocol
// ==================================================
// Functions to calculate tags, PoW, and create payloads
// for Pombo's push notifications system.
// ==================================================

// ethers is exposed globally by vendor.bundle.js
const getEthers = () => {
    if (typeof window !== 'undefined' && window.ethers) return window.ethers;
    throw new Error('ethers not available - vendor bundle must be loaded first');
};

// ================================================
// TAG CALCULATION
// ================================================

/**
 * Calculate notification tag for a public/password channel.
 * Users opt-in to receive notifications for these channels.
 * 
 * @param {string} streamId - Channel stream ID (ex: 0x.../channelname-1)
 * @returns {string} 10-character tag (0x + 8 hex chars)
 */
export function calculateChannelTag(streamId) {
    if (!streamId) {
        throw new Error('Invalid streamId');
    }
    
    const eth = getEthers();
    
    // Prefix to distinguish from user/native tags
    const data = `channel:${streamId.toLowerCase()}`;
    const hash = eth.keccak256(eth.toUtf8Bytes(data));
    
    // Get first 4 bytes
    return hash.slice(0, 10);
}

/**
 * Calculate notification tag for a native channel.
 * Native channels use per-channel tags (not per-user tags) for granular control.
 * Privacy is maintained because only channel members know the streamId.
 * 
 * @param {string} streamId - Channel stream ID
 * @returns {string} 10-character tag (0x + 8 hex chars)
 */
export function calculateNativeChannelTag(streamId) {
    if (!streamId) {
        throw new Error('Invalid streamId');
    }
    
    const eth = getEthers();
    
    // Prefix to distinguish from public channel tags
    const data = `native:${streamId.toLowerCase()}`;
    const hash = eth.keccak256(eth.toUtf8Bytes(data));
    
    // Get first 4 bytes
    return hash.slice(0, 10);
}

// ================================================
// PROOF OF WORK
// ================================================

/**
 * Calculate Proof-of-Work for anti-spam.
 * Uses keccak256 hashing to find a nonce that produces a hash with leading zeros.
 * 
 * @param {string} tag - Recipient tag
 * @param {number} difficulty - Number of zeros required (default: 4)
 * @returns {Promise<{pow: string, nonce: number}>}
 */
export async function calculatePoW(tag, difficulty = 4) {
    const maxTime = 30000; // 30 seconds max
    const eth = getEthers();
    const target = '0'.repeat(difficulty);
    const startTime = Date.now();
    
    let nonce = 0;
    let pow;
    
    while (Date.now() - startTime < maxTime) {
        const data = `${tag}:${nonce}`;
        pow = eth.keccak256(eth.toUtf8Bytes(data));
        
        if (pow.slice(2).startsWith(target)) {
            console.log(`[PoW] Main thread found in ${Date.now() - startTime}ms, nonce: ${nonce}`);
            return { pow, nonce };
        }
        
        nonce++;
        
        // Yield every 10000 iterations to not block UI completely
        if (nonce % 10000 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    
    throw new Error('PoW timeout - could not find valid nonce');
}

/**
 * Verify if a PoW is valid (for debug/testing)
 */
export function verifyPoW(pow, tag, nonce, difficulty = 4) {
    const eth = getEthers();
    const target = '0'.repeat(difficulty);
    const data = `${tag}:${nonce}`;
    const expected = eth.keccak256(eth.toUtf8Bytes(data));
    
    return pow === expected && pow.slice(2).startsWith(target);
}

// ================================================
// PAYLOADS
// ================================================

/**
 * Create payload to register device with a relay.
 * 
 * @param {string} tag - Calculated tag from address
 * @param {PushSubscription} subscription - Web Push subscription
 * @returns {object} Payload to send to stream
 */
export function createRegistrationPayload(tag, subscription) {
    return {
        type: 'registration',
        tag: tag,
        subscription: typeof subscription === 'string' 
            ? subscription 
            : JSON.stringify(subscription),
        timestamp: Date.now()
    };
}

/**
 * Create payload to send channel notification (wake signal).
 * Used for public/password channels.
 * 
 * @param {string} streamId - Channel stream ID
 * @param {number} difficulty - PoW difficulty
 * @returns {Promise<object>} Payload to send to stream
 */
export async function createChannelNotificationPayload(streamId, difficulty = 4) {
    const tag = calculateChannelTag(streamId);
    const { pow, nonce } = await calculatePoW(tag, difficulty);
    
    return {
        type: 'notification',
        tag: tag,
        pow: pow,
        nonce: nonce,
        channelType: 'public',
        timestamp: Date.now()
    };
}

/**
 * Create payload to send native channel notification (wake signal).
 * Used for native/DM channels.
 * 
 * @param {string} streamId - Channel stream ID
 * @param {number} difficulty - PoW difficulty
 * @returns {Promise<object>} Payload to send to stream
 */
export async function createNativeChannelNotificationPayload(streamId, difficulty = 4) {
    const tag = calculateNativeChannelTag(streamId);
    const { pow, nonce } = await calculatePoW(tag, difficulty);
    
    return {
        type: 'notification',
        tag: tag,
        pow: pow,
        nonce: nonce,
        channelType: 'private',
        timestamp: Date.now()
    };
}

// ================================================
// CONFIGURATION
// ================================================

// Default relay configuration
export const DEFAULT_CONFIG = {
    // Single stream for push notifications (MVP)
    pushStreamId: '0xae340e799e8151f6a4999d245e466197aa217667/push',
    
    // PoW difficulty (must match relay)
    powDifficulty: 4,
    
    // List of known relays
    relays: [
        {
            name: 'Pombo Relay 1',
            address: '0x905309e8b4d22a02b08459f42a203c7265abd3ad',
            vapidPublicKey: 'BFsT-uCydgNHZA4r3_vKo2JRyTr0EwziKbJl6rNUNKtbSJLNOzA7Vxm81mVADuitIllOp_HI8fpvBNayOb8BDtY'
        }
    ]
};

export default {
    calculateChannelTag,
    calculateNativeChannelTag,
    calculatePoW,
    verifyPoW,
    createRegistrationPayload,
    createChannelNotificationPayload,
    createNativeChannelNotificationPayload,
    DEFAULT_CONFIG
};
