/**
 * Crypto Module
 * Uses Web Crypto API (native) for AES-GCM encryption
 * Used for password-based encrypted channels
 */

class CryptoManager {
    constructor() {
        this.textEncoder = new TextEncoder();
        this.textDecoder = new TextDecoder();
    }

    /**
     * Derive encryption key from password using PBKDF2
     * @param {string} password - The password
     * @param {Uint8Array} salt - Salt for key derivation
     * @returns {Promise<CryptoKey>} - Derived key
     */
    async deriveKey(password, salt) {
        const passwordBuffer = this.textEncoder.encode(password);

        // Import password as key material
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            passwordBuffer,
            'PBKDF2',
            false,
            ['deriveKey']
        );

        // Derive AES-GCM key
        const key = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: 100000,
                hash: 'SHA-256'
            },
            keyMaterial,
            {
                name: 'AES-GCM',
                length: 256
            },
            false,
            ['encrypt', 'decrypt']
        );

        return key;
    }

    /**
     * Generate a random salt
     * @returns {Uint8Array} - 16 byte salt
     */
    generateSalt() {
        return crypto.getRandomValues(new Uint8Array(16));
    }

    /**
     * Generate a random IV (Initialization Vector)
     * @returns {Uint8Array} - 12 byte IV
     */
    generateIV() {
        return crypto.getRandomValues(new Uint8Array(12));
    }

    /**
     * Encrypt message with AES-GCM
     * @param {string} plaintext - Message to encrypt
     * @param {string} password - Password for encryption
     * @returns {Promise<string>} - Base64 encoded encrypted data
     */
    async encrypt(plaintext, password) {
        try {
            // Generate salt and IV
            const salt = this.generateSalt();
            const iv = this.generateIV();

            // Derive key from password
            const key = await this.deriveKey(password, salt);

            // Encrypt the message
            const plaintextBuffer = this.textEncoder.encode(plaintext);
            const ciphertext = await crypto.subtle.encrypt(
                {
                    name: 'AES-GCM',
                    iv: iv
                },
                key,
                plaintextBuffer
            );

            // Combine salt + iv + ciphertext
            const combined = new Uint8Array(
                salt.length + iv.length + ciphertext.byteLength
            );
            combined.set(salt, 0);
            combined.set(iv, salt.length);
            combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

            // Convert to base64
            return this.arrayBufferToBase64(combined);
        } catch (error) {
            console.error('Encryption failed:', error);
            throw error;
        }
    }

    /**
     * Decrypt message with AES-GCM
     * @param {string} encryptedBase64 - Base64 encoded encrypted data
     * @param {string} password - Password for decryption
     * @returns {Promise<string>} - Decrypted plaintext
     */
    async decrypt(encryptedBase64, password) {
        try {
            // Decode base64
            const combined = this.base64ToArrayBuffer(encryptedBase64);

            // Extract salt, iv, and ciphertext
            const salt = combined.slice(0, 16);
            const iv = combined.slice(16, 28);
            const ciphertext = combined.slice(28);

            // Derive key from password
            const key = await this.deriveKey(password, salt);

            // Decrypt the message
            const plaintextBuffer = await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: iv
                },
                key,
                ciphertext
            );

            // Convert to string
            return this.textDecoder.decode(plaintextBuffer);
        } catch (error) {
            console.error('Decryption failed:', error);
            throw error;
        }
    }

    /**
     * Encrypt JSON object
     * @param {Object} obj - Object to encrypt
     * @param {string} password - Password for encryption
     * @returns {Promise<string>} - Encrypted base64 string
     */
    async encryptJSON(obj, password) {
        const json = JSON.stringify(obj);
        return await this.encrypt(json, password);
    }

    /**
     * Decrypt to JSON object
     * @param {string} encryptedBase64 - Encrypted base64 string
     * @param {string} password - Password for decryption
     * @returns {Promise<Object>} - Decrypted object
     */
    async decryptJSON(encryptedBase64, password) {
        const json = await this.decrypt(encryptedBase64, password);
        return JSON.parse(json);
    }

    /**
     * Convert ArrayBuffer to Base64
     * @param {ArrayBuffer|Uint8Array} buffer - Buffer to convert
     * @returns {string} - Base64 string
     */
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Convert Base64 to ArrayBuffer
     * @param {string} base64 - Base64 string
     * @returns {Uint8Array} - Array buffer
     */
    base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    /**
     * Hash a string with SHA-256 (useful for generating stream IDs)
     * @param {string} input - String to hash
     * @returns {Promise<string>} - Hex string of hash
     */
    async sha256(input) {
        const buffer = this.textEncoder.encode(input);
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Generate random hex string
     * @param {number} length - Length in bytes
     * @returns {string} - Random hex string
     */
    generateRandomHex(length = 16) {
        const bytes = crypto.getRandomValues(new Uint8Array(length));
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
}

// Export singleton instance
export const cryptoManager = new CryptoManager();
