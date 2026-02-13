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
        this.STORAGE_PREFIX = 'moot_secure_';
        this.PBKDF2_ITERATIONS = 100000;
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
        const message = `Moot Secure Storage\n\nUnlock encrypted storage for:\n${normalizedAddress}\n\nThis signature is used to derive an encryption key.`;
        
        Logger.debug('Deriving storage encryption key...');
        
        // Get signature from local wallet (instant, no popup)
        const signature = await signer.signMessage(message);
        
        // Create deterministic salt from address
        const salt = new TextEncoder().encode(`moot_salt_${normalizedAddress}`);
        
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
            
            // Check for migration from plaintext format
            if (this.needsMigration(address)) {
                // Initialize empty cache first
                this.cache = {
                    channels: [],
                    trustedContacts: {},
                    ensCache: {},
                    username: null,
                    graphApiKey: null,
                    sessionData: null,
                    version: 2
                };
                await this.migrateFromPlaintext(address);
            } else {
                // Try to load existing encrypted data
                await this.loadFromStorage();
            }
            
            this.isUnlocked = true;
            Logger.info('🔓 Secure storage unlocked for:', this.address.slice(0, 8) + '...');
            
            return true;
        } catch (error) {
            Logger.error('Failed to initialize secure storage:', error);
            throw error;
        }
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
                version: 2
            };
        }
    }

    /**
     * Save encrypted data to localStorage
     */
    async saveToStorage() {
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

    // ==================== Lifecycle ====================

    /**
     * Lock storage (on disconnect)
     */
    lock() {
        this.storageKey = null;
        this.cache = null;
        this.isUnlocked = false;
        this.address = null;
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

    // ==================== Migration ====================

    /**
     * Migrate plaintext data to encrypted storage
     * @param {string} address - Wallet address
     */
    async migrateFromPlaintext(address) {
        const normalizedAddress = address.toLowerCase();
        
        // Check for existing plaintext data from different storage formats
        const oldPlaintextKey = `moot_data_${normalizedAddress}`;
        const oldChannelsKey = `moot_channels_${normalizedAddress}`;
        const oldPlaintext = localStorage.getItem(oldPlaintextKey);
        const oldChannels = localStorage.getItem(oldChannelsKey);
        
        const oldContactsKey = 'eth_chat_trusted_contacts';
        const oldContacts = localStorage.getItem(oldContactsKey);
        
        const oldUsernameKey = 'eth_chat_username';
        const oldUsername = localStorage.getItem(oldUsernameKey);
        
        const oldENSKey = 'eth_chat_ens_cache';
        const oldENS = localStorage.getItem(oldENSKey);
        
        let migrated = false;
        
        // Migrate from previous plaintext storage (moot_data_)
        if (oldPlaintext) {
            try {
                const data = JSON.parse(oldPlaintext);
                if (data.channels && data.channels.length > 0) {
                    this.cache.channels = data.channels;
                    migrated = true;
                }
                if (data.trustedContacts) {
                    this.cache.trustedContacts = data.trustedContacts;
                    migrated = true;
                }
                if (data.ensCache) {
                    this.cache.ensCache = data.ensCache;
                    migrated = true;
                }
                if (data.username) {
                    this.cache.username = data.username;
                    migrated = true;
                }
                if (data.graphApiKey) {
                    this.cache.graphApiKey = data.graphApiKey;
                    migrated = true;
                }
                Logger.info('📦 Migrated data from plaintext storage');
            } catch (e) {
                Logger.warn('Failed to migrate plaintext storage:', e);
            }
        }
        
        // Migrate old format channels
        if (oldChannels) {
            try {
                const channels = JSON.parse(oldChannels);
                if (channels.length > 0) {
                    this.cache.channels = channels;
                    migrated = true;
                    Logger.info(`📦 Migrated ${channels.length} channels`);
                }
            } catch (e) {
                Logger.warn('Failed to migrate channels:', e);
            }
        }
        
        // Migrate contacts
        if (oldContacts) {
            try {
                const contacts = JSON.parse(oldContacts);
                this.cache.trustedContacts = contacts;
                migrated = true;
                Logger.info('📦 Migrated trusted contacts');
            } catch (e) {
                Logger.warn('Failed to migrate contacts:', e);
            }
        }
        
        // Migrate username
        if (oldUsername) {
            this.cache.username = oldUsername;
            migrated = true;
            Logger.info('📦 Migrated username');
        }
        
        // Migrate ENS cache
        if (oldENS) {
            try {
                const ensCache = JSON.parse(oldENS);
                this.cache.ensCache = ensCache;
                migrated = true;
                Logger.info('📦 Migrated ENS cache');
            } catch (e) {
                Logger.warn('Failed to migrate ENS cache:', e);
            }
        }
        
        if (migrated) {
            // Save as encrypted data
            await this.saveToStorage();
            
            // Clean up old plaintext data
            localStorage.removeItem(oldPlaintextKey);
            localStorage.removeItem(oldChannelsKey);
            localStorage.removeItem(oldContactsKey);
            localStorage.removeItem(oldUsernameKey);
            localStorage.removeItem(oldENSKey);
            
            Logger.info('✅ Migration complete - old plaintext data removed');
        }
        
        return migrated;
    }

    /**
     * Check if migration is needed (plaintext data exists)
     */
    needsMigration(address) {
        const normalizedAddress = address.toLowerCase();
        const oldPlaintextKey = `moot_data_${normalizedAddress}`;
        const oldChannelsKey = `moot_channels_${normalizedAddress}`;
        return localStorage.getItem(oldPlaintextKey) !== null || 
               localStorage.getItem(oldChannelsKey) !== null;
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
            format: 'moot-encrypted-backup',
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

        if (backup.format !== 'moot-encrypted-backup') {
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
        let totalMessages = 0;
        for (const channel of channels) {
            totalMessages += (channel.messages || []).length;
        }

        return {
            channels: channels.length,
            messages: totalMessages,
            contacts: Object.keys(this.cache.trustedContacts || {}).length,
            ensEntries: Object.keys(this.cache.ensCache || {}).length,
            hasUsername: !!this.cache.username,
            hasApiKey: !!this.cache.graphApiKey,
            version: this.cache.version
        };
    }
}

// Export singleton instance
export const secureStorage = new SecureStorage();
