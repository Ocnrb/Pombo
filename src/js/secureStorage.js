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
     * @param {string} streamId - Channel stream ID
     * @returns {number|null} - Timestamp or null if never accessed
     */
    getChannelLastAccess(streamId) {
        if (!this.isUnlocked) return null;
        return this.cache.channelLastAccess?.[streamId] || null;
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

    // ==================== Encrypted Export/Import ====================

    /**
     * Derive encryption key from user password (for portable backups)
     * @param {string} password - User-provided password
     * @param {Uint8Array} salt - Salt for key derivation
     * @returns {Promise<CryptoKey>}
     */
    async deriveKeyFromPassword(password, salt) {
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        
        return await crypto.subtle.deriveKey(
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
    }

    /**
     * Export all data as encrypted backup
     * @param {string} password - Password to encrypt backup
     * @returns {Promise<Object>} - Encrypted backup object
     */
    async exportEncrypted(password) {
        if (!this.isUnlocked || !this.cache) {
            throw new Error('Storage not unlocked');
        }

        // Generate random salt for this backup
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        
        // Derive key from password
        const key = await this.deriveKeyFromPassword(password, salt);
        
        // Prepare export data
        const exportData = {
            version: 2,
            exportedAt: new Date().toISOString(),
            address: this.address,
            data: {
                channels: this.cache.channels || [],
                trustedContacts: this.cache.trustedContacts || {},
                ensCache: this.cache.ensCache || {},
                username: this.cache.username,
                graphApiKey: this.cache.graphApiKey
            }
        };
        
        // Encrypt
        const plaintext = new TextEncoder().encode(JSON.stringify(exportData));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            plaintext
        );
        
        Logger.info('📤 Exported encrypted backup');
        
        return {
            format: 'pombo-encrypted-backup',
            version: 2,
            salt: Array.from(salt),
            iv: Array.from(iv),
            ciphertext: Array.from(new Uint8Array(ciphertext))
        };
    }

    /**
     * Import encrypted backup
     * @param {Object} backup - Encrypted backup object
     * @param {string} password - Password to decrypt backup
     * @param {boolean} merge - Merge with existing data (true) or replace (false)
     * @returns {Promise<Object>} - Import summary
     */
    async importEncrypted(backup, password, merge = true) {
        if (!this.isUnlocked) {
            throw new Error('Storage not unlocked');
        }

        if (backup.format !== 'pombo-encrypted-backup') {
            throw new Error('Invalid backup format');
        }

        // Derive key from password
        const salt = new Uint8Array(backup.salt);
        const iv = new Uint8Array(backup.iv);
        const ciphertext = new Uint8Array(backup.ciphertext);
        
        const key = await this.deriveKeyFromPassword(password, salt);
        
        // Decrypt
        let decryptedData;
        try {
            const plaintext = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                ciphertext
            );
            decryptedData = JSON.parse(new TextDecoder().decode(plaintext));
        } catch (error) {
            throw new Error('Incorrect password or corrupted backup');
        }

        const summary = {
            channelsImported: 0,
            contactsImported: 0,
            fromAddress: decryptedData.address,
            exportedAt: decryptedData.exportedAt
        };

        const data = decryptedData.data;

        // Import channels
        if (data.channels && data.channels.length > 0) {
            if (merge) {
                // Merge: add channels that don't exist
                const existingIds = new Set((this.cache.channels || []).map(c => c.streamId));
                for (const channel of data.channels) {
                    if (!existingIds.has(channel.streamId)) {
                        this.cache.channels.push(channel);
                        summary.channelsImported++;
                    }
                }
            } else {
                // Replace
                this.cache.channels = data.channels;
                summary.channelsImported = data.channels.length;
            }
        }

        // Import trusted contacts
        if (data.trustedContacts) {
            const contactCount = Object.keys(data.trustedContacts).length;
            if (merge) {
                // Merge: add contacts that don't exist
                for (const [addr, contact] of Object.entries(data.trustedContacts)) {
                    if (!this.cache.trustedContacts[addr]) {
                        this.cache.trustedContacts[addr] = contact;
                        summary.contactsImported++;
                    }
                }
            } else {
                this.cache.trustedContacts = data.trustedContacts;
                summary.contactsImported = contactCount;
            }
        }

        // Import ENS cache (always merge)
        if (data.ensCache) {
            this.cache.ensCache = { ...this.cache.ensCache, ...data.ensCache };
        }

        // Import username (only if not set)
        if (data.username && !this.cache.username) {
            this.cache.username = data.username;
        }

        // Import Graph API key (only if not set)
        if (data.graphApiKey && !this.cache.graphApiKey) {
            this.cache.graphApiKey = data.graphApiKey;
        }

        // Save merged/replaced data
        await this.saveToStorage();
        
        Logger.info('📥 Imported encrypted backup:', summary);
        
        return summary;
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

        // Prepare data to encrypt
        const dataToBackup = {
            version: 3,
            exportedAt: new Date().toISOString(),
            address: this.address,
            data: {
                channels: this.cache.channels || [],
                trustedContacts: this.cache.trustedContacts || {},
                ensCache: this.cache.ensCache || {},
                username: this.cache.username,
                graphApiKey: this.cache.graphApiKey
            }
        };

        // Generate random salt for scrypt (different from keystore's salt)
        const salt = ethers.randomBytes(32);
        const iv = ethers.randomBytes(16);

        // Scrypt parameters (same as Keystore V3)
        const N = 131072;  // 2^17
        const r = 8;
        const p = 1;
        const dkLen = 32;

        // Derive key using scrypt
        Logger.debug('Deriving backup encryption key with scrypt...');
        let derivedKey;
        if (progressCallback) {
            derivedKey = await ethers.scrypt(password, salt, N, r, p, dkLen, (progress) => {
                progressCallback(progress * 0.5); // 0-50% for key derivation
            });
        } else {
            derivedKey = await ethers.scrypt(password, salt, N, r, p, dkLen);
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
        let derivedKey;
        if (progressCallback) {
            derivedKey = await ethers.scrypt(
                password, 
                salt, 
                enc.kdfparams.n, 
                enc.kdfparams.r, 
                enc.kdfparams.p, 
                enc.kdfparams.dklen,
                (progress) => progressCallback(0.4 + progress * 0.4) // 40-80%
            );
        } else {
            derivedKey = await ethers.scrypt(
                password, 
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
