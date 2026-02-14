/**
 * Authentication Module
 * Handles Ethereum wallet management via private keys (generated or imported)
 * 
 * Keystore V3 Standard (ethers.js v6 defaults):
 * - Uses scrypt for key derivation (n=131072, r=8, p=1)
 * - AES-128-CTR for encryption
 * - Keccak256 for MAC
 */

import { Logger } from './logger.js';

// Storage key for wallets (keystores are NOT encrypted - they already are)
const WALLETS_STORAGE_KEY = 'eth_chat_keystores';

class AuthManager {
    constructor() {
        this.wallet = null;
        this.address = null;
        this.signer = null;
        this.currentWalletName = null;
    }

    /**
     * Generate a new local wallet (private key stored in memory)
     */
    generateLocalWallet() {
        try {
            const wallet = ethers.Wallet.createRandom();
            this.wallet = wallet;
            this.address = wallet.address;
            this.signer = wallet;

            Logger.info('Generated local wallet:', this.address);
            Logger.warn('Private key is only stored in memory. Save it to keep access!');

            return {
                address: this.address,
                privateKey: wallet.privateKey,
                signer: this.signer
            };
        } catch (error) {
            Logger.error('Failed to generate local wallet:', error);
            throw error;
        }
    }

    /**
     * Import wallet from private key
     */
    importPrivateKey(privateKey) {
        try {
            const wallet = new ethers.Wallet(privateKey);
            this.wallet = wallet;
            this.address = wallet.address;
            this.signer = wallet;

            Logger.info('Imported wallet:', this.address);

            return {
                address: this.address,
                signer: this.signer
            };
        } catch (error) {
            Logger.error('Failed to import private key:', error);
            throw error;
        }
    }

    /**
     * Save wallet as Keystore V3 (encrypted with password)
     * @param {string} password - Password for encryption
     * @param {string} name - Optional wallet name (default: address)
     * @param {Function} progressCallback - Optional progress callback (0-1)
     * @returns {Promise<Object>} - Saved keystore info
     */
    async saveWalletEncrypted(password, name = null, progressCallback = null) {
        if (!this.wallet) {
            throw new Error('No local wallet to save');
        }

        try {
            const walletName = name || `Wallet ${this.address.slice(0, 8)}`;
            
            Logger.debug('Encrypting wallet with Keystore V3 (this may take a moment)...');
            
            // ethers.js v6: encrypt(password, progressCallback)
            // Uses secure scrypt defaults (n=131072, r=8, p=1)
            let encryptedJson;
            if (progressCallback && typeof progressCallback === 'function') {
                encryptedJson = await this.wallet.encrypt(password, progressCallback);
            } else {
                encryptedJson = await this.wallet.encrypt(password);
            }
            
            // Parse to validate and add metadata
            const keystore = JSON.parse(encryptedJson);
            
            // Load existing wallets
            const wallets = this.loadAllKeystores();
            
            // Add or update wallet
            wallets[this.address.toLowerCase()] = {
                name: walletName,
                keystore: keystore,
                createdAt: Date.now(),
                lastUsed: Date.now()
            };
            
            // Save to localStorage
            localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(wallets));
            
            this.currentWalletName = walletName;
            
            // ethers.js v6 uses 'Crypto' (uppercase), some versions use 'crypto'
            const crypto = keystore.crypto || keystore.Crypto;
            
            Logger.info('Wallet saved as Keystore V3');
            Logger.debug(`   Name: ${walletName}`);
            Logger.debug(`   Address: ${this.address}`);
            Logger.debug(`   Crypto: ${crypto?.cipher || 'aes-128-ctr'} + ${crypto?.kdf || 'scrypt'}`);
            
            return {
                name: walletName,
                address: this.address,
                version: keystore.version
            };
        } catch (error) {
            Logger.error('Failed to save wallet:', error);
            throw error;
        }
    }

    /**
     * Load wallet from Keystore V3
     * @param {string} password - Password for decryption
     * @param {string} address - Optional specific address to load (default: first available)
     * @param {Function} progressCallback - Optional progress callback (0-1)
     * @returns {Promise<Object>} - Loaded wallet info
     */
    async loadWalletEncrypted(password, address = null, progressCallback = null) {
        try {
            const wallets = this.loadAllKeystores();
            
            if (Object.keys(wallets).length === 0) {
                throw new Error('No saved wallets found');
            }
            
            // Get specific wallet or first available
            let walletData;
            let walletAddress;
            
            if (address) {
                walletAddress = address.toLowerCase();
                walletData = wallets[walletAddress];
                if (!walletData) {
                    throw new Error(`Wallet not found: ${address}`);
                }
            } else {
                // Get most recently used wallet
                const sorted = Object.entries(wallets)
                    .sort((a, b) => (b[1].lastUsed || 0) - (a[1].lastUsed || 0));
                [walletAddress, walletData] = sorted[0];
            }
            
            // Validate keystore structure
            this.validateKeystore(walletData.keystore);
            
            Logger.debug('Decrypting Keystore V3 (this may take a moment)...');
            
            // Decrypt keystore - ethers.js v6: fromEncryptedJson(json, password, progress)
            const keystoreJson = JSON.stringify(walletData.keystore);
            let wallet;
            if (progressCallback && typeof progressCallback === 'function') {
                wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password, progressCallback);
            } else {
                wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
            }
            
            this.wallet = wallet;
            this.address = wallet.address;
            this.signer = wallet;
            this.currentWalletName = walletData.name;
            
            // Update last used timestamp
            wallets[walletAddress].lastUsed = Date.now();
            localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(wallets));
            
            Logger.info('Wallet loaded from Keystore V3');
            Logger.debug(`   Name: ${walletData.name}`);
            Logger.debug(`   Address: ${this.address}`);
            
            return {
                address: this.address,
                name: walletData.name,
                signer: this.signer
            };
        } catch (error) {
            Logger.error('Failed to load wallet:', error);
            throw error;
        }
    }

    /**
     * Validate Keystore V3 structure
     * @param {Object} keystore - Keystore object to validate
     * @throws {Error} If keystore is invalid
     */
    validateKeystore(keystore) {
        if (!keystore) {
            throw new Error('Invalid keystore: empty');
        }
        
        if (keystore.version !== 3) {
            throw new Error(`Invalid keystore version: ${keystore.version} (expected 3)`);
        }
        
        if (!keystore.crypto && !keystore.Crypto) {
            throw new Error('Invalid keystore: missing crypto section');
        }
        
        const crypto = keystore.crypto || keystore.Crypto;
        
        if (!crypto.cipher || !crypto.ciphertext || !crypto.cipherparams) {
            throw new Error('Invalid keystore: missing cipher data');
        }
        
        if (!crypto.kdf || !crypto.kdfparams) {
            throw new Error('Invalid keystore: missing KDF data');
        }
        
        if (!crypto.mac) {
            throw new Error('Invalid keystore: missing MAC');
        }
        
        return true;
    }

    /**
     * Load all saved keystores (without decrypting)
     * @returns {Object} - Map of address -> keystore data
     */
    loadAllKeystores() {
        try {
            const saved = localStorage.getItem(WALLETS_STORAGE_KEY);
            if (!saved) {
                // Check for legacy single wallet format
                const legacyWallet = localStorage.getItem('eth_chat_wallet');
                if (legacyWallet) {
                    return this.migrateLegacyWallet(legacyWallet);
                }
                return {};
            }
            return JSON.parse(saved);
        } catch (error) {
            Logger.error('Failed to load keystores:', error);
            return {};
        }
    }

    /**
     * Migrate legacy single wallet to new format
     * @param {string} legacyJson - Legacy encrypted wallet JSON
     * @returns {Object} - Migrated wallets object
     */
    migrateLegacyWallet(legacyJson) {
        try {
            const keystore = JSON.parse(legacyJson);
            const address = keystore.address ? `0x${keystore.address}` : 'unknown';
            
            const wallets = {
                [address.toLowerCase()]: {
                    name: 'Migrated Wallet',
                    keystore: keystore,
                    createdAt: Date.now(),
                    lastUsed: Date.now(),
                    migrated: true
                }
            };
            
            // Save in new format
            localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(wallets));
            
            // Remove legacy key
            localStorage.removeItem('eth_chat_wallet');
            
            Logger.info('Migrated legacy wallet to Keystore V3 format');
            
            return wallets;
        } catch (error) {
            Logger.error('Failed to migrate legacy wallet:', error);
            return {};
        }
    }

    /**
     * List all saved wallets (without passwords)
     * @returns {Array} - Array of wallet info objects
     */
    listSavedWallets() {
        const wallets = this.loadAllKeystores();
        
        return Object.entries(wallets).map(([address, data]) => ({
            address: address,
            name: data.name,
            createdAt: data.createdAt,
            lastUsed: data.lastUsed,
            version: data.keystore?.version || 3
        }));
    }

    /**
     * Update wallet display name
     * @param {string} newName - New display name
     * @param {string} address - Wallet address (optional, defaults to current)
     * @returns {boolean} - Success
     */
    updateWalletName(newName, address = null) {
        const targetAddress = (address || this.address)?.toLowerCase();
        if (!targetAddress) return false;
        
        const wallets = this.loadAllKeystores();
        if (!wallets[targetAddress]) return false;
        
        wallets[targetAddress].name = newName || `Account ${targetAddress.slice(0, 8)}`;
        localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(wallets));
        
        if (targetAddress === this.address?.toLowerCase()) {
            this.currentWalletName = wallets[targetAddress].name;
        }
        
        return true;
    }

    /**
     * Export keystore as JSON string (for backup)
     * @param {string} address - Wallet address to export
     * @returns {string} - Keystore JSON string
     */
    exportKeystore(address = null) {
        const wallets = this.loadAllKeystores();
        const targetAddress = address?.toLowerCase() || this.address?.toLowerCase();
        
        if (!targetAddress) {
            throw new Error('No wallet address specified');
        }
        
        const walletData = wallets[targetAddress];
        if (!walletData) {
            throw new Error(`Wallet not found: ${targetAddress}`);
        }
        
        // Return standard Keystore V3 JSON
        return JSON.stringify(walletData.keystore, null, 2);
    }

    /**
     * Import keystore from JSON
     * @param {string} keystoreJson - Keystore JSON string
     * @param {string} password - Password to verify (and decrypt temporarily)
     * @param {string} name - Optional wallet name
     * @returns {Promise<Object>} - Imported wallet info
     */
    async importKeystore(keystoreJson, password, name = null) {
        try {
            const keystore = JSON.parse(keystoreJson);
            
            // Validate structure
            this.validateKeystore(keystore);
            
            // Verify password by attempting to decrypt
            Logger.debug('Verifying keystore password...');
            const wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
            
            const walletName = name || `Imported ${wallet.address.slice(0, 8)}`;
            
            // Load existing and add new
            const wallets = this.loadAllKeystores();
            wallets[wallet.address.toLowerCase()] = {
                name: walletName,
                keystore: keystore,
                createdAt: Date.now(),
                lastUsed: Date.now(),
                imported: true
            };
            
            localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(wallets));
            
            // Set as current wallet
            this.wallet = wallet;
            this.address = wallet.address;
            this.signer = wallet;
            this.currentWalletName = walletName;
            
            Logger.info('Keystore imported successfully');
            
            return {
                address: wallet.address,
                name: walletName,
                signer: wallet
            };
        } catch (error) {
            Logger.error('Failed to import keystore:', error);
            throw error;
        }
    }

    /**
     * Delete a saved wallet
     * @param {string} address - Wallet address to delete
     * @returns {boolean} - Success
     */
    deleteWallet(address) {
        const wallets = this.loadAllKeystores();
        const targetAddress = address.toLowerCase();
        
        if (!wallets[targetAddress]) {
            throw new Error(`Wallet not found: ${address}`);
        }
        
        delete wallets[targetAddress];
        localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(wallets));
        
        // If deleted current wallet, disconnect
        if (this.address?.toLowerCase() === targetAddress) {
            this.disconnect();
        }
        
        Logger.info('Wallet deleted:', address);
        return true;
    }

    /**
     * Check if there's a saved wallet
     */
    hasSavedWallet() {
        const wallets = this.loadAllKeystores();
        return Object.keys(wallets).length > 0;
    }

    /**
     * Disconnect wallet
     */
    disconnect() {
        this.wallet = null;
        this.address = null;
        this.signer = null;
        this.currentWalletName = null;
        Logger.info('Wallet disconnected');
    }

    /**
     * Get current address
     */
    getAddress() {
        return this.address;
    }

    /**
     * Get current wallet name
     */
    getWalletName() {
        return this.currentWalletName;
    }

    /**
     * Get current signer (for signing Streamr messages)
     */
    getSigner() {
        return this.signer;
    }

    /**
     * Check if connected
     */
    isConnected() {
        return this.address !== null;
    }

    /**
     * Sign a message
     */
    async signMessage(message) {
        if (!this.signer) {
            throw new Error('No signer available');
        }

        try {
            const signature = await this.signer.signMessage(message);
            return signature;
        } catch (error) {
            Logger.error('Failed to sign message:', error);
            throw error;
        }
    }

    /**
     * Change wallet password (re-encrypt with new password)
     * @param {string} oldPassword - Current password
     * @param {string} newPassword - New password
     * @param {string} address - Wallet address (default: current)
     * @returns {Promise<boolean>} - Success
     */
    async changePassword(oldPassword, newPassword, address = null) {
        const targetAddress = address?.toLowerCase() || this.address?.toLowerCase();
        
        if (!targetAddress) {
            throw new Error('No wallet address specified');
        }
        
        // Load and decrypt with old password
        const result = await this.loadWalletEncrypted(oldPassword, targetAddress);
        
        // Re-encrypt with new password
        await this.saveWalletEncrypted(newPassword, result.name);
        
        Logger.info('Password changed successfully');
        return true;
    }

    /**
     * Get private key after verifying password
     * @param {string} password - Wallet password for verification
     * @param {string} address - Wallet address (default: current)
     * @returns {Promise<string>} - Private key
     */
    async getPrivateKey(password, address = null) {
        const targetAddress = address?.toLowerCase() || this.address?.toLowerCase();
        
        if (!targetAddress) {
            throw new Error('No wallet address specified');
        }

        // If wallet is already loaded in memory, verify password by re-loading
        const wallets = this.loadAllKeystores();
        const walletData = wallets[targetAddress];
        
        if (!walletData) {
            throw new Error('Wallet not found');
        }

        try {
            // Decrypt to verify password and get private key
            const keystoreJson = JSON.stringify(walletData.keystore);
            const wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
            
            Logger.debug('Password verified, returning private key');
            return wallet.privateKey;
        } catch (error) {
            if (error.message.includes('invalid') || error.message.includes('password')) {
                throw new Error('Incorrect password');
            }
            throw error;
        }
    }

    /**
     * Export keystores only (already encrypted with scrypt)
     * @returns {Object} - Keystores data
     */
    exportKeystores() {
        const data = {
            format: 'moot-keystores',
            version: 1,
            exportedAt: new Date().toISOString(),
            keystores: {}
        };

        // Export all keystores (they're already encrypted)
        const wallets = this.loadAllKeystores();
        for (const [address, walletData] of Object.entries(wallets)) {
            data.keystores[address] = {
                name: walletData.name,
                keystore: walletData.keystore,
                createdAt: walletData.createdAt
            };
        }

        return data;
    }

    /**
     * Import keystores from backup
     * @param {Object} data - Keystores backup
     * @param {boolean} merge - Merge with existing (true) or replace (false)
     * @returns {Object} - Import summary
     */
    importKeystores(data, merge = true) {
        if (!data || data.format !== 'moot-keystores') {
            throw new Error('Invalid keystores backup format');
        }

        const summary = { keystoresImported: 0 };

        if (data.keystores) {
            const existingWallets = merge ? this.loadAllKeystores() : {};
            
            for (const [address, walletData] of Object.entries(data.keystores)) {
                if (!merge || !existingWallets[address]) {
                    existingWallets[address] = {
                        name: walletData.name,
                        keystore: walletData.keystore,
                        createdAt: walletData.createdAt || Date.now(),
                        lastUsed: Date.now()
                    };
                    summary.keystoresImported++;
                }
            }
            
            localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(existingWallets));
        }

        Logger.info('Keystores imported:', summary);
        return summary;
    }

    /**
     * Export all app data for backup (LEGACY - plaintext wallet data)
     * @returns {Object} - All exportable data
     * @deprecated Use exportKeystores() + secureStorage.exportEncrypted() instead
     */
    exportAllData() {
        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            keystores: {},
            walletData: {}
        };

        // Export all keystores
        const wallets = this.loadAllKeystores();
        for (const [address, walletData] of Object.entries(wallets)) {
            data.keystores[address] = {
                name: walletData.name,
                keystore: walletData.keystore,
                createdAt: walletData.createdAt
            };
        }

        // Export per-wallet data (channels, contacts, etc)
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith('moot_data_')) {
                const address = key.replace('moot_data_', '');
                try {
                    data.walletData[address] = JSON.parse(localStorage.getItem(key));
                } catch (e) {
                    Logger.warn('Failed to export data for', address);
                }
            }
        }

        return data;
    }

    /**
     * Import all app data from backup
     * @param {Object} data - Exported data object
     * @param {boolean} merge - Merge with existing data (true) or replace (false)
     * @returns {Object} - Import summary
     */
    importAllData(data, merge = true) {
        if (!data || data.version !== 1) {
            throw new Error('Invalid backup format');
        }

        const summary = {
            keystoresImported: 0,
            walletDataImported: 0
        };

        // Import keystores
        if (data.keystores) {
            const existingWallets = merge ? this.loadAllKeystores() : {};
            
            for (const [address, walletData] of Object.entries(data.keystores)) {
                if (!merge || !existingWallets[address]) {
                    existingWallets[address] = {
                        name: walletData.name,
                        keystore: walletData.keystore,
                        createdAt: walletData.createdAt || Date.now(),
                        lastUsed: Date.now()
                    };
                    summary.keystoresImported++;
                }
            }
            
            localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify(existingWallets));
        }

        // Import per-wallet data
        if (data.walletData) {
            for (const [address, walletData] of Object.entries(data.walletData)) {
                const key = `moot_data_${address}`;
                if (!merge || !localStorage.getItem(key)) {
                    localStorage.setItem(key, JSON.stringify(walletData));
                    summary.walletDataImported++;
                }
            }
        }

        Logger.info('Data imported:', summary);
        return summary;
    }
}

// Export singleton instance
export const authManager = new AuthManager();
