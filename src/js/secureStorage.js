/**
 * Secure Storage Module
 * Encrypts all localStorage data using a key derived from wallet signature
 * 
 * Security Model:
 * - Storage key derived from: PBKDF2(wallet_signature, deterministic_salt)
 * - Data encrypted with AES-256-GCM
 * - Only the wallet owner can decrypt their data
 * - Each wallet has completely isolated encrypted storage
 */

import { Logger } from './logger.js';

class SecureStorage {
    constructor() {
        this.storageKey = null;       // AES-256-GCM key
        this.address = null;          // Current wallet address
        this.isUnlocked = false;      // Whether storage is decrypted
        this.cache = null;            // Decrypted data cache
        this.isGuestMode = false;     // Guest mode - no persistence
        this.STORAGE_PREFIX = 'pombo_secure_';
        this.PBKDF2_ITERATIONS = 310000;
    }

    /**
     * Derive encryption key from wallet signature
     * Uses the local signer (no MetaMask popup needed)
     * @param {Object} signer - ethers.js signer (local wallet)
     * @param {string} address - Wallet address
     * @returns {Promise<CryptoKey>}
     */
    async deriveStorageKey(signer, address) {
        const normalizedAddress = address.toLowerCase();
        
        // Create a deterministic message for signing
        // This ensures the same key is derived each time
        const message = `Pombo Secure Storage\n\nUnlock encrypted storage for:\n${normalizedAddress}\n\nThis signature is used to derive an encryption key.`;
        
        Logger.debug('Deriving storage encryption key...');
        
        // Get signature from local wallet (instant, no popup)
        const signature = await signer.signMessage(message);
        
        // Create deterministic salt from address
        const salt = new TextEncoder().encode(`pombo_salt_${normalizedAddress}`);
        
        // Import signature as key material
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(signature),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        
        // Derive AES-256-GCM key using PBKDF2
        const key = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: this.PBKDF2_ITERATIONS,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        
        Logger.debug('Storage key derived successfully');
        return key;
    }

    /**
     * Initialize secure storage for a wallet
     * @param {Object} signer - ethers.js signer (local wallet)
     * @param {string} address - Wallet address
     */
    async init(signer, address) {
        this.address = address.toLowerCase();
        
        try {
            // Derive encryption key from wallet signature
            this.storageKey = await this.deriveStorageKey(signer, address);
            
            // Load existing encrypted data or initialize empty
            await this.loadFromStorage();
            
            this.isUnlocked = true;
            Logger.info('🔓 Secure storage unlocked for:', this.address.slice(0, 8) + '...');
            
            return true;
        } catch (error) {
            Logger.error('Failed to initialize secure storage:', error);
            throw error;
        }
    }

    /**
     * Initialize secure storage for Guest mode (memory only, no persistence)
     * @param {string} address - Guest wallet address
     */
    initAsGuest(address) {
        this.address = address.toLowerCase();
        this.isGuestMode = true;
        this.isUnlocked = true;
        this.storageKey = null; // No encryption needed for in-memory only
        
        // Initialize empty cache in memory (never persisted)
        this.cache = {
            channels: [],
            trustedContacts: {},
            ensCache: {},
            username: null,
            graphApiKey: null,
            sessionData: null,
            channelLastAccess: {},
            channelOrder: [],
            lastOpenedChannel: null,
            blockedPeers: [],
            dmLeftAt: {},
            version: 2
        };
        
        Logger.info('🔓 Guest storage initialized (memory only):', this.address.slice(0, 8) + '...');
        return true;
    }

    /**
     * Get the localStorage key for current wallet
     */
    getStorageKey() {
        return `${this.STORAGE_PREFIX}${this.address}`;
    }

    /**
     * Encrypt data using AES-256-GCM
     * @param {any} data - Data to encrypt (will be JSON stringified)
     * @returns {Promise<Object>} - { iv, ciphertext }
     */
    async encrypt(data) {
        if (!this.storageKey) {
            throw new Error('Storage not initialized');
        }
        
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(JSON.stringify(data));
        
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            this.storageKey,
            plaintext
        );
        
        return {
            iv: Array.from(iv),
            ciphertext: Array.from(new Uint8Array(ciphertext))
        };
    }

    /**
     * Decrypt data using AES-256-GCM
     * @param {Object} encryptedData - { iv, ciphertext }
     * @returns {Promise<any>} - Decrypted data
     */
    async decrypt(encryptedData) {
        if (!this.storageKey) {
            throw new Error('Storage not initialized');
        }
        
        const iv = new Uint8Array(encryptedData.iv);
        const ciphertext = new Uint8Array(encryptedData.ciphertext);
        
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            this.storageKey,
            ciphertext
        );
        
        return JSON.parse(new TextDecoder().decode(plaintext));
    }

    /**
     * Load and decrypt data from localStorage
     */
    async loadFromStorage() {
        const storageKey = this.getStorageKey();
        const stored = localStorage.getItem(storageKey);
        
        if (!stored) {
            // No existing data - initialize empty cache
            this.cache = {
                channels: [],
                trustedContacts: {},
                ensCache: {},
                username: null,
                graphApiKey: null,
                sessionData: null,
                channelLastAccess: {}, // streamId -> timestamp
                channelOrder: [], // Array of streamIds in user-defined order
                lastOpenedChannel: null, // streamId of last opened channel (for session restore)
                blockedPeers: [],
                dmLeftAt: {},
                version: 2
            };
            Logger.info('📦 Initialized empty secure storage');
            return;
        }
        
        try {
            const encryptedData = JSON.parse(stored);
            this.cache = await this.decrypt(encryptedData);
            Logger.info('📦 Loaded and decrypted data from storage');
        } catch (error) {
            Logger.error('Failed to decrypt storage - may be corrupted or from different key');
            // Initialize fresh storage
            this.cache = {
                channels: [],
                trustedContacts: {},
                ensCache: {},
                username: null,
                graphApiKey: null,
                sessionData: null,
                channelLastAccess: {},
                channelOrder: [],
                lastOpenedChannel: null,
                blockedPeers: [],
                dmLeftAt: {},
                version: 2
            };
        }
    }

    /**
     * Save encrypted data to localStorage
     */
    async saveToStorage() {
        // Guest mode: keep in memory only, don't persist
        if (this.isGuestMode) {
            Logger.debug('💾 Guest mode - data kept in memory only');
            return;
        }
        
        if (!this.isUnlocked || !this.cache) {
            Logger.warn('Cannot save - storage not unlocked');
            return;
        }
        
        try {
            const encrypted = await this.encrypt(this.cache);
            localStorage.setItem(this.getStorageKey(), JSON.stringify(encrypted));
            Logger.debug('💾 Saved encrypted data to storage');
        } catch (error) {
            Logger.error('Failed to save to secure storage:', error);
        }
    }

    // ==================== Data Accessors ====================

    /**
     * Get channels
     */
    getChannels() {
        if (!this.isUnlocked) return [];
        return this.cache.channels || [];
    }

    /**
     * Set channels
     */
    async setChannels(channels) {
        if (!this.isUnlocked) return;
        this.cache.channels = channels;
        await this.saveToStorage();
    }

    /**
     * Get trusted contacts
     */
    getTrustedContacts() {
        if (!this.isUnlocked) return {};
        return this.cache.trustedContacts || {};
    }

    /**
     * Set trusted contacts
     */
    async setTrustedContacts(contacts) {
        if (!this.isUnlocked) return;
        this.cache.trustedContacts = contacts;
        await this.saveToStorage();
    }

    /**
     * Get ENS cache
     */
    getENSCache() {
        if (!this.isUnlocked) return {};
        return this.cache.ensCache || {};
    }

    /**
     * Set ENS cache
     */
    async setENSCache(cache) {
        if (!this.isUnlocked) return;
        this.cache.ensCache = cache;
        await this.saveToStorage();
    }

    /**
     * Get username
     */
    getUsername() {
        if (!this.isUnlocked) return null;
        return this.cache.username;
    }

    /**
     * Set username
     */
    async setUsername(username) {
        if (!this.isUnlocked) return;
        this.cache.username = username;
        await this.saveToStorage();
    }

    /**
     * Get NSFW content enabled setting
     */
    getNsfwEnabled() {
        if (!this.isUnlocked) return false;
        return this.cache.nsfwEnabled || false;
    }

    /**
     * Set NSFW content enabled setting
     */
    async setNsfwEnabled(enabled) {
        if (!this.isUnlocked) return;
        this.cache.nsfwEnabled = enabled;
        await this.saveToStorage();
    }

    /**
     * Get YouTube embeds enabled setting (default: true)
     */
    getYouTubeEmbedsEnabled() {
        if (!this.isUnlocked) return true;
        return this.cache.youtubeEmbedsEnabled !== false; // Default true
    }

    /**
     * Set YouTube embeds enabled setting
     */
    async setYouTubeEmbedsEnabled(enabled) {
        if (!this.isUnlocked) return;
        this.cache.youtubeEmbedsEnabled = enabled;
        await this.saveToStorage();
    }

    /**
     * Get The Graph API key
     */
    getGraphApiKey() {
        if (!this.isUnlocked) return null;
        return this.cache.graphApiKey || null;
    }

    /**
     * Set The Graph API key
     */
    async setGraphApiKey(apiKey) {
        if (!this.isUnlocked) return;
        this.cache.graphApiKey = apiKey;
        await this.saveToStorage();
    }

    /**
     * Get session data
     */
    getSessionData() {
        if (!this.isUnlocked) return null;
        return this.cache.sessionData;
    }

    /**
     * Set session data
     */
    async setSessionData(sessionData) {
        if (!this.isUnlocked) return;
        this.cache.sessionData = sessionData;
        await this.saveToStorage();
    }

    /**
     * Clear session data (on disconnect)
     */
    async clearSessionData() {
        if (!this.isUnlocked) return;
        this.cache.sessionData = null;
        await this.saveToStorage();
    }

    // ==================== Channel Last Access ====================

    /**
     * Get last access timestamp for a channel
     * Checks both encrypted storage AND emergency localStorage (from beforeunload)
     * @param {string} streamId - Channel stream ID
     * @returns {number|null} - Timestamp or null if never accessed
     */
    getChannelLastAccess(streamId) {
        if (!this.isUnlocked) return null;
        
        // Get from encrypted cache
        const cachedAccess = this.cache.channelLastAccess?.[streamId] || 0;
        
        // Check emergency localStorage (saved on beforeunload/pagehide)
        const emergencyKey = `pombo_channel_access_${streamId}`;
        const emergencyValue = localStorage.getItem(emergencyKey);
        const emergencyAccess = emergencyValue ? parseInt(emergencyValue, 10) : 0;
        
        // Use the most recent timestamp
        const latestAccess = Math.max(cachedAccess, emergencyAccess);
        
        // If emergency value was newer, sync it to encrypted storage and cleanup
        if (emergencyAccess > cachedAccess && emergencyAccess > 0) {
            if (!this.cache.channelLastAccess) {
                this.cache.channelLastAccess = {};
            }
            this.cache.channelLastAccess[streamId] = emergencyAccess;
            // Clean up emergency key (async, fire-and-forget)
            localStorage.removeItem(emergencyKey);
            this.saveToStorage();
        }
        
        return latestAccess > 0 ? latestAccess : null;
    }

    /**
     * Set last access timestamp for a channel (marks as read)
     * @param {string} streamId - Channel stream ID
     * @param {number} timestamp - Access timestamp (defaults to now)
     */
    async setChannelLastAccess(streamId, timestamp = Date.now()) {
        if (!this.isUnlocked) return;
        if (!this.cache.channelLastAccess) {
            this.cache.channelLastAccess = {};
        }
        this.cache.channelLastAccess[streamId] = timestamp;
        
        // Clean up any emergency localStorage value for this channel
        const emergencyKey = `pombo_channel_access_${streamId}`;
        localStorage.removeItem(emergencyKey);
        
        await this.saveToStorage();
    }

    /**
     * Get all channel last access timestamps
     * @returns {Object} - { streamId: timestamp }
     */
    getAllChannelLastAccess() {
        if (!this.isUnlocked) return {};
        return this.cache.channelLastAccess || {};
    }

    // ==================== Channel Order ====================

    /**
     * Get channel order (array of streamIds in user-defined order)
     * @returns {string[]} - Array of streamIds
     */
    getChannelOrder() {
        if (!this.isUnlocked) return [];
        return this.cache.channelOrder || [];
    }

    /**
     * Set channel order
     * @param {string[]} order - Array of streamIds in desired order
     */
    async setChannelOrder(order) {
        if (!this.isUnlocked) return;
        this.cache.channelOrder = order;
        await this.saveToStorage();
    }

    /**
     * Remove a channel from the order (when leaving/deleting)
     * @param {string} streamId - Channel to remove
     */
    async removeFromChannelOrder(streamId) {
        if (!this.isUnlocked) return;
        if (!this.cache.channelOrder) return;
        this.cache.channelOrder = this.cache.channelOrder.filter(id => id !== streamId);
        await this.saveToStorage();
    }

    /**
     * Add a channel to the order (at the end by default)
     * @param {string} streamId - Channel to add
     */
    async addToChannelOrder(streamId) {
        if (!this.isUnlocked) return;
        if (!this.cache.channelOrder) {
            this.cache.channelOrder = [];
        }
        // Don't add duplicates
        if (!this.cache.channelOrder.includes(streamId)) {
            this.cache.channelOrder.push(streamId);
            await this.saveToStorage();
        }
    }

    // ==================== Sent Messages (Write-Only Channels) ====================

    /**
     * Get locally stored sent messages for a write-only channel
     * @param {string} streamId - Stream ID
     * @returns {Array} - Array of sent messages
     */
    getSentMessages(streamId) {
        if (!this.isUnlocked) return [];
        return this.cache.sentMessages?.[streamId] || [];
    }

    /**
     * Add a sent message to local storage (for write-only channels)
     * Stores text, image, and video_announce messages
     * Keeps last 200 messages per channel to avoid storage bloat
     * @param {string} streamId - Stream ID
     * @param {Object} message - Message object to store
     */
    async addSentMessage(streamId, message) {
        if (!this.isUnlocked) return;
        if (!this.cache.sentMessages) {
            this.cache.sentMessages = {};
        }
        if (!this.cache.sentMessages[streamId]) {
            this.cache.sentMessages[streamId] = [];
        }
        // Store fields based on message type
        const stored = {
            id: message.id,
            sender: message.sender,
            timestamp: message.timestamp,
            signature: message.signature,
            channelId: message.channelId
        };
        if (message.type === 'image') {
            stored.type = 'image';
            stored.imageId = message.imageId;
            stored.imageData = message.imageData;
        } else if (message.type === 'video_announce') {
            stored.type = 'video_announce';
            stored.metadata = message.metadata;
        } else {
            // Text message
            stored.text = message.text;
            stored.replyTo = message.replyTo || null;
        }
        // Dedup check: avoid adding same message twice
        const existing = this.cache.sentMessages[streamId];
        if (existing.some(m => m.id === stored.id)) {
            return;
        }
        existing.push(stored);
        // Cap at 200 messages per channel
        if (this.cache.sentMessages[streamId].length > 200) {
            this.cache.sentMessages[streamId] = this.cache.sentMessages[streamId].slice(-200);
        }
        await this.saveToStorage();
    }

    /**
     * Clear sent messages for a channel
     * @param {string} streamId - Stream ID
     */
    async clearSentMessages(streamId) {
        if (!this.isUnlocked) return;
        if (this.cache.sentMessages?.[streamId]) {
            delete this.cache.sentMessages[streamId];
            await this.saveToStorage();
        }
    }

    /**
     * Clear sent reactions for a channel
     * @param {string} streamId - Stream ID
     */
    async clearSentReactions(streamId) {
        if (!this.isUnlocked) return;
        if (this.cache.sentReactions?.[streamId]) {
            delete this.cache.sentReactions[streamId];
            await this.saveToStorage();
        }
    }

    /**
     * Get locally stored reactions for a write-only channel
     * @param {string} streamId - Stream ID
     * @returns {Object} - Reactions object { messageId -> { emoji -> [users] } }
     */
    getSentReactions(streamId) {
        if (!this.isUnlocked) return {};
        return this.cache.sentReactions?.[streamId] || {};
    }

    /**
     * Add a reaction to local storage (for write-only channels)
     * @param {string} streamId - Stream ID
     * @param {string} messageId - Message ID
     * @param {string} emoji - Emoji
     * @param {string} user - User address
     * @param {string} action - 'add' or 'remove'
     */
    async addSentReaction(streamId, messageId, emoji, user, action = 'add') {
        if (!this.isUnlocked) return;
        if (!this.cache.sentReactions) {
            this.cache.sentReactions = {};
        }
        if (!this.cache.sentReactions[streamId]) {
            this.cache.sentReactions[streamId] = {};
        }
        const reactions = this.cache.sentReactions[streamId];
        if (!reactions[messageId]) {
            reactions[messageId] = {};
        }
        if (!reactions[messageId][emoji]) {
            reactions[messageId][emoji] = [];
        }
        const normalizedUser = user.toLowerCase();
        const idx = reactions[messageId][emoji].findIndex(u => u.toLowerCase() === normalizedUser);
        if (action === 'remove') {
            if (idx >= 0) {
                reactions[messageId][emoji].splice(idx, 1);
                if (reactions[messageId][emoji].length === 0) delete reactions[messageId][emoji];
                if (Object.keys(reactions[messageId]).length === 0) delete reactions[messageId];
            }
        } else {
            if (idx < 0) reactions[messageId][emoji].push(user);
        }
        await this.saveToStorage();
    }

    // ==================== Blocked Peers (DM) ====================

    /**
     * Get list of blocked peer addresses
     * @returns {string[]} - Array of lowercase addresses
     */
    getBlockedPeers() {
        if (!this.isUnlocked) return [];
        return this.cache.blockedPeers || [];
    }

    /**
     * Check if a peer is blocked
     * @param {string} address - Peer address
     * @returns {boolean}
     */
    isBlocked(address) {
        if (!this.isUnlocked) return false;
        const normalized = address.toLowerCase();
        return (this.cache.blockedPeers || []).includes(normalized);
    }

    /**
     * Block a peer (all DM messages from this peer will be ignored)
     * @param {string} address - Peer address
     */
    async addBlockedPeer(address) {
        if (!this.isUnlocked) return;
        const normalized = address.toLowerCase();
        if (!this.cache.blockedPeers) {
            this.cache.blockedPeers = [];
        }
        if (!this.cache.blockedPeers.includes(normalized)) {
            this.cache.blockedPeers.push(normalized);
            await this.saveToStorage();
        }
    }

    /**
     * Unblock a peer
     * @param {string} address - Peer address
     */
    async removeBlockedPeer(address) {
        if (!this.isUnlocked) return;
        const normalized = address.toLowerCase();
        if (!this.cache.blockedPeers) return;
        const idx = this.cache.blockedPeers.indexOf(normalized);
        if (idx >= 0) {
            this.cache.blockedPeers.splice(idx, 1);
            await this.saveToStorage();
        }
    }

    // ==================== DM Left At (Soft Leave) ====================

    /**
     * Get the leftAt timestamp for a DM peer (soft leave).
     * Messages with timestamp <= leftAt are ignored; newer messages resurface the conversation.
     * @param {string} address - Peer address
     * @returns {number|null} - Timestamp or null if not left
     */
    getDMLeftAt(address) {
        if (!this.isUnlocked) return null;
        const normalized = address.toLowerCase();
        return this.cache.dmLeftAt?.[normalized] ?? null;
    }

    /**
     * Get all dmLeftAt entries
     * @returns {Object} - { peerAddress: timestamp }
     */
    getAllDMLeftAt() {
        if (!this.isUnlocked) return {};
        return this.cache.dmLeftAt || {};
    }

    /**
     * Set leftAt timestamp for a DM peer (soft leave)
     * @param {string} address - Peer address
     * @param {number} timestamp - Leave timestamp
     */
    async setDMLeftAt(address, timestamp) {
        if (!this.isUnlocked) return;
        const normalized = address.toLowerCase();
        if (!this.cache.dmLeftAt) {
            this.cache.dmLeftAt = {};
        }
        this.cache.dmLeftAt[normalized] = timestamp;
        await this.saveToStorage();
    }

    /**
     * Clear leftAt for a DM peer (conversation resurfaced by new message)
     * @param {string} address - Peer address
     */
    async clearDMLeftAt(address) {
        if (!this.isUnlocked) return;
        const normalized = address.toLowerCase();
        if (this.cache.dmLeftAt?.[normalized]) {
            delete this.cache.dmLeftAt[normalized];
            await this.saveToStorage();
        }
    }

    // ==================== Last Opened Channel ====================

    /**
     * Get last opened channel (for session restore)
     * @returns {string|null} - streamId or null
     */
    getLastOpenedChannel() {
        if (!this.isUnlocked) return null;
        return this.cache.lastOpenedChannel || null;
    }

    /**
     * Set last opened channel
     * @param {string|null} streamId - Channel streamId or null to clear
     */
    async setLastOpenedChannel(streamId) {
        if (!this.isUnlocked) return;
        this.cache.lastOpenedChannel = streamId;
        await this.saveToStorage();
    }

    // ==================== Lifecycle ==

    /**
     * Lock storage (on disconnect)
     */
    lock() {
        this.storageKey = null;
        this.cache = null;
        this.isUnlocked = false;
        this.address = null;
        this.isGuestMode = false;
        Logger.info('🔒 Secure storage locked');
    }

    /**
     * Check if storage is unlocked/initialized
     */
    isStorageUnlocked() {
        return this.isUnlocked;
    }

    /**
     * Get current address
     */
    getCurrentAddress() {
        return this.address;
    }

    /**
     * Get storage statistics
     * @returns {Object} - Storage stats
     */
    getStats() {
        if (!this.isUnlocked || !this.cache) {
            return null;
        }

        const channels = this.cache.channels || [];

        return {
            channels: channels.length,
            contacts: Object.keys(this.cache.trustedContacts || {}).length,
            ensEntries: Object.keys(this.cache.ensCache || {}).length,
            hasUsername: !!this.cache.username,
            hasApiKey: !!this.cache.graphApiKey,
            version: this.cache.version
        };
    }

    // ==================== Cross-Device Sync ====================

    /**
     * Export state for cross-device sync.
     * Same data as account backup, but without sensitive session data.
     * @returns {Object} - State to sync
     */
    exportForSync() {
        if (!this.isUnlocked || !this.cache) {
            throw new Error('Storage not unlocked');
        }

        return {
            sentMessages: this.cache.sentMessages || {},
            sentReactions: this.cache.sentReactions || {},
            channels: this.cache.channels || [],
            blockedPeers: this.cache.blockedPeers || [],
            dmLeftAt: this.cache.dmLeftAt || {},
            trustedContacts: this.cache.trustedContacts || {},
            ensCache: this.cache.ensCache || {},
            username: this.cache.username || null,
            graphApiKey: this.cache.graphApiKey || null
        };
    }

    /**
     * Import merged state from sync.
     * Replaces local state with merged data from sync process.
     * @param {Object} data - Merged state from syncManager
     * @returns {Promise<boolean>} - True if channels were updated (caller should reload UI)
     */
    async importFromSync(data) {
        if (!this.isUnlocked || !this.cache) {
            throw new Error('Storage not unlocked');
        }

        let channelsUpdated = false;

        if (data.sentMessages !== undefined) this.cache.sentMessages = data.sentMessages;
        if (data.sentReactions !== undefined) this.cache.sentReactions = data.sentReactions;
        if (data.channels !== undefined) {
            this.cache.channels = data.channels;
            channelsUpdated = true;
        }
        if (data.blockedPeers !== undefined) this.cache.blockedPeers = data.blockedPeers;
        if (data.dmLeftAt !== undefined) this.cache.dmLeftAt = data.dmLeftAt;
        if (data.trustedContacts !== undefined) this.cache.trustedContacts = data.trustedContacts;
        if (data.ensCache !== undefined) this.cache.ensCache = data.ensCache;
        if (data.username !== undefined) this.cache.username = data.username;
        if (data.graphApiKey !== undefined) this.cache.graphApiKey = data.graphApiKey;

        await this.saveToStorage();
        Logger.info('📥 Imported sync data');
        
        return channelsUpdated;
    }

    // ==================== Account Backup with Scrypt ====================

    /**
     * Export complete account backup using scrypt (same security as Keystore V3)
     * Uses the same password as the account keystore
     * @param {Object} keystore - The account's Keystore V3 object
     * @param {string} password - Account password (verified against keystore before calling)
     * @param {Function} progressCallback - Optional progress callback (0-1)
     * @returns {Promise<Object>} - Complete backup object
     */
    async exportAccountBackup(keystore, password, progressCallback = null) {
        if (!this.isUnlocked || !this.cache) {
            throw new Error('Storage not unlocked');
        }

        // Prepare data to encrypt (reuse sync export structure)
        const dataToBackup = {
            version: 3,
            exportedAt: new Date().toISOString(),
            address: this.address,
            data: this.exportForSync()
        };

        // Generate random salt for scrypt (different from keystore's salt)
        const salt = ethers.randomBytes(32);
        const iv = ethers.randomBytes(16);

        // Scrypt parameters (same as Keystore V3)
        const N = 131072;  // 2^17
        const r = 8;
        const p = 1;
        const dkLen = 32;

        // Derive key using scrypt (password must be UTF-8 bytes for ethers v6)
        Logger.debug('Deriving backup encryption key with scrypt...');
        const passwordBytes = ethers.toUtf8Bytes(password);
        let derivedKey;
        if (progressCallback) {
            derivedKey = await ethers.scrypt(passwordBytes, salt, N, r, p, dkLen, (progress) => {
                progressCallback(progress * 0.5); // 0-50% for key derivation
            });
        } else {
            derivedKey = await ethers.scrypt(passwordBytes, salt, N, r, p, dkLen);
        }

        // Convert hex string to bytes for Web Crypto
        const keyBytes = ethers.getBytes(derivedKey);

        // Import key for AES-GCM
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt']
        );

        // Encrypt data
        if (progressCallback) progressCallback(0.6);
        const plaintext = new TextEncoder().encode(JSON.stringify(dataToBackup));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            cryptoKey,
            plaintext
        );

        if (progressCallback) progressCallback(0.9);

        Logger.info('📤 Account backup created with scrypt encryption');

        return {
            format: 'pombo-account-backup',
            version: 3,
            exportedAt: new Date().toISOString(),
            // Include the keystore (already encrypted with scrypt)
            keystore: keystore,
            // Include encrypted data (also scrypt-protected)
            encryptedData: {
                kdf: 'scrypt',
                kdfparams: {
                    n: N,
                    r: r,
                    p: p,
                    dklen: dkLen,
                    salt: ethers.hexlify(salt)
                },
                cipher: 'aes-256-gcm',
                cipherparams: {
                    iv: ethers.hexlify(iv)
                },
                ciphertext: ethers.hexlify(new Uint8Array(ciphertext))
            }
        };
    }

    /**
     * Import complete account backup
     * @param {Object} backup - Backup object from exportAccountBackup
     * @param {string} password - Account password
     * @param {Function} progressCallback - Optional progress callback (0-1)
     * @returns {Promise<Object>} - { wallet, summary }
     */
    async importAccountBackup(backup, password, progressCallback = null) {
        if (backup.format !== 'pombo-account-backup' || backup.version !== 3) {
            throw new Error('Invalid backup format. Expected pombo-account-backup v3');
        }

        // Step 1: Decrypt keystore to recover wallet (verifies password)
        Logger.debug('Decrypting keystore from backup...');
        let wallet;
        try {
            if (progressCallback) {
                wallet = await ethers.Wallet.fromEncryptedJson(
                    JSON.stringify(backup.keystore),
                    password,
                    (progress) => progressCallback(progress * 0.4) // 0-40%
                );
            } else {
                wallet = await ethers.Wallet.fromEncryptedJson(
                    JSON.stringify(backup.keystore),
                    password
                );
            }
        } catch (error) {
            throw new Error('Incorrect password or corrupted backup');
        }

        // Step 2: Decrypt data using scrypt
        const enc = backup.encryptedData;
        const salt = ethers.getBytes(enc.kdfparams.salt);
        const iv = ethers.getBytes(enc.cipherparams.iv);
        const ciphertext = ethers.getBytes(enc.ciphertext);

        Logger.debug('Deriving data decryption key with scrypt...');
        const passwordBytes = ethers.toUtf8Bytes(password);
        let derivedKey;
        if (progressCallback) {
            derivedKey = await ethers.scrypt(
                passwordBytes, 
                salt, 
                enc.kdfparams.n, 
                enc.kdfparams.r, 
                enc.kdfparams.p, 
                enc.kdfparams.dklen,
                (progress) => progressCallback(0.4 + progress * 0.4) // 40-80%
            );
        } else {
            derivedKey = await ethers.scrypt(
                passwordBytes, 
                salt, 
                enc.kdfparams.n, 
                enc.kdfparams.r, 
                enc.kdfparams.p, 
                enc.kdfparams.dklen
            );
        }

        const keyBytes = ethers.getBytes(derivedKey);

        // Import key for AES-GCM
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );

        // Decrypt data
        if (progressCallback) progressCallback(0.85);
        let decryptedData;
        try {
            const plaintext = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                cryptoKey,
                ciphertext
            );
            decryptedData = JSON.parse(new TextDecoder().decode(plaintext));
        } catch (error) {
            throw new Error('Failed to decrypt backup data');
        }

        if (progressCallback) progressCallback(1.0);

        Logger.info('📥 Account backup decrypted successfully');

        return {
            wallet: wallet,
            keystore: backup.keystore,
            data: decryptedData.data,
            address: decryptedData.address,
            exportedAt: decryptedData.exportedAt
        };
    }
}

// Export singleton instance
export const secureStorage = new SecureStorage();
