/**
 * Identity Module
 * Handles identity verification, ENS resolution, and trusted contacts
 * 
 * Trust Levels:
 * - 0: Unknown (signature valid but not in contacts)
 * - 1: ENS Verified (has ENS name)
 * - 2: Trusted Contact (manually added)
 * - -1: Invalid (signature failed)
 */

import { authManager } from './auth.js';
import { secureStorage } from './secureStorage.js';
import { Logger } from './logger.js';

// ENS cache duration (24 hours)
const ENS_CACHE_DURATION = 24 * 60 * 60 * 1000;

// Message timestamp tolerance (5 minutes) - prevents replay attacks
const MESSAGE_TIMESTAMP_TOLERANCE = 5 * 60 * 1000;

// Ethereum mainnet provider for ENS
const ENS_PROVIDER_URL = 'https://eth.llamarpc.com';

class IdentityManager {
    constructor() {
        this.ensCache = new Map();
        this.trustedContacts = new Map();
        this.ensProvider = null;
        this.username = null;
    }

    /**
     * Initialize identity manager
     */
    async init() {
        this.loadTrustedContacts();
        this.loadENSCache();
        this.loadUsername();
        
        // Initialize ENS provider (Ethereum mainnet)
        try {
            this.ensProvider = new ethers.JsonRpcProvider(ENS_PROVIDER_URL);
            Logger.info('ENS provider initialized');
        } catch (error) {
            Logger.warn('Failed to initialize ENS provider:', error);
        }
    }

    // ==================== USERNAME ====================

    /**
     * Get the current username
     * @returns {string|null}
     */
    getUsername() {
        return this.username;
    }

    /**
     * Set the username
     * @param {string} name - Username to set
     */
    async setUsername(name) {
        this.username = name ? name.trim() : null;
        await this.saveUsername();
    }

    /**
     * Save username to secure storage
     */
    async saveUsername() {
        if (!secureStorage.isStorageUnlocked()) {
            Logger.warn('Cannot save username - secure storage not unlocked');
            return;
        }
        await secureStorage.setUsername(this.username);
    }

    /**
     * Load username from secure storage
     */
    loadUsername() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                this.username = null;
                return;
            }
            this.username = secureStorage.getUsername() || null;
        } catch (error) {
            Logger.error('Failed to load username:', error);
        }
    }

    // ==================== MESSAGE SIGNING ====================

    /**
     * Create signed message payload
     * @param {string} text - Message text
     * @param {string} channelId - Channel ID for context
     * @param {Object|null} replyTo - Reply context (optional)
     * @returns {Promise<Object>} - Signed message object
     */
    async createSignedMessage(text, channelId, replyTo = null) {
        const sender = authManager.getAddress();
        const timestamp = Date.now();
        const messageId = this.generateMessageId();
        
        // Create deterministic message hash for signing
        // Note: replyTo is NOT included in hash (it's metadata, not signed content)
        const messageHash = this.createMessageHash(messageId, text, sender, timestamp, channelId);
        
        // Sign the hash
        const signature = await authManager.signMessage(messageHash);
        
        const message = {
            type: 'text', // Explicit type for history filtering
            id: messageId,
            text: text,
            sender: sender,
            senderName: this.username || null,
            timestamp: timestamp,
            channelId: channelId,
            signature: signature,
            replyTo: replyTo // Reply context (null if not a reply)
        };
        
        return message;
    }

    /**
     * Create deterministic message hash for signing/verification
     * Uses keccak256 for cryptographic security and collision resistance
     * @param {string} id - Message ID
     * @param {string} text - Message content
     * @param {string} sender - Sender address
     * @param {number} timestamp - Message timestamp
     * @param {string} channelId - Channel ID
     * @returns {string} - Keccak256 hash of the message data
     */
    createMessageHash(id, text, sender, timestamp, channelId) {
        // Use structured data encoding to prevent delimiter injection attacks
        const data = JSON.stringify({
            protocol: 'POMBO',
            version: 1,
            id: id,
            text: text,
            sender: sender.toLowerCase(),
            timestamp: timestamp,
            channelId: channelId
        });
        // Use keccak256 for cryptographic hash
        return ethers.keccak256(ethers.toUtf8Bytes(data));
    }

    /**
     * Validate message timestamp is within acceptable window
     * Prevents replay attacks with old messages
     * @param {number} messageTimestamp - Timestamp from message
     * @returns {Object} - { valid: boolean, error?: string }
     */
    validateTimestamp(messageTimestamp) {
        const now = Date.now();
        const diff = Math.abs(now - messageTimestamp);
        
        if (diff > MESSAGE_TIMESTAMP_TOLERANCE) {
            const direction = messageTimestamp < now ? 'old' : 'future';
            const minutes = Math.round(diff / 60000);
            return {
                valid: false,
                error: `Message timestamp too ${direction} (${minutes} min)`
            };
        }
        
        return { valid: true };
    }

    /**
     * Generate unique message ID
     */
    generateMessageId() {
        const random = crypto.getRandomValues(new Uint8Array(16));
        return Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Verify message signature
     * @param {Object} message - Message object with signature
     * @param {string} channelId - Channel ID (optional)
     * @returns {Object} - Verification result { valid, recoveredAddress, trustLevel, ensName }
     */
    async verifyMessage(message, channelId = null, options = {}) {
        const { skipTimestampCheck = false } = options;
        
        try {
            if (!message.signature) {
                return { 
                    valid: false, 
                    error: 'No signature',
                    trustLevel: -1 
                };
            }

            // Validate timestamp to prevent replay attacks
            if (!skipTimestampCheck) {
                const timestampResult = this.validateTimestamp(message.timestamp);
                if (!timestampResult.valid) {
                    return {
                        valid: false,
                        error: timestampResult.error,
                        trustLevel: -1,
                        isReplayAttempt: true
                    };
                }
            }

            // Recreate the message hash
            const messageHash = this.createMessageHash(
                message.id,
                message.text,
                message.sender,
                message.timestamp,
                message.channelId
            );

            // Recover the signer address from signature
            const recoveredAddress = ethers.verifyMessage(messageHash, message.signature);
            
            // Direct signature mode: signature should match sender
            const valid = recoveredAddress.toLowerCase() === message.sender.toLowerCase();
            
            if (!valid) {
                return {
                    valid: false,
                    error: 'Signature mismatch',
                    claimedSender: message.sender,
                    actualSigner: recoveredAddress,
                    trustLevel: -1
                };
            }

            // Get trust level and ENS name
            const trustLevel = await this.getTrustLevel(recoveredAddress);
            const ensName = await this.resolveENS(recoveredAddress);

            return {
                valid: true,
                recoveredAddress: recoveredAddress,
                trustLevel: trustLevel,
                ensName: ensName
            };
        } catch (error) {
            Logger.error('Signature verification failed:', error);
            return {
                valid: false,
                error: error.message,
                trustLevel: -1
            };
        }
    }

    // ==================== ENS RESOLUTION ====================

    /**
     * Resolve ENS name for an address
     * @param {string} address - Ethereum address
     * @returns {Promise<string|null>} - ENS name or null
     */
    async resolveENS(address) {
        const normalizedAddress = address.toLowerCase();
        
        // Check cache first
        const cached = this.ensCache.get(normalizedAddress);
        if (cached && Date.now() - cached.timestamp < ENS_CACHE_DURATION) {
            return cached.name;
        }

        // No provider available
        if (!this.ensProvider) {
            return null;
        }

        try {
            const name = await this.ensProvider.lookupAddress(address);
            
            // Cache result (even if null)
            this.ensCache.set(normalizedAddress, {
                name: name,
                timestamp: Date.now()
            });
            await this.saveENSCache();
            
            return name;
        } catch (error) {
            Logger.warn('ENS lookup failed for', address, error);
            return null;
        }
    }

    /**
     * Resolve address from ENS name
     * @param {string} ensName - ENS name (e.g., "vitalik.eth")
     * @returns {Promise<string|null>} - Address or null
     */
    async resolveAddress(ensName) {
        if (!this.ensProvider) {
            return null;
        }

        try {
            return await this.ensProvider.resolveName(ensName);
        } catch (error) {
            Logger.warn('ENS resolve failed for', ensName, error);
            return null;
        }
    }

    // ==================== TRUSTED CONTACTS ====================

    /**
     * Add a trusted contact
     * @param {string} address - Ethereum address
     * @param {string} nickname - Optional nickname
     * @param {string} notes - Optional notes
     */
    async addTrustedContact(address, nickname = null, notes = null) {
        const normalizedAddress = address.toLowerCase();
        
        this.trustedContacts.set(normalizedAddress, {
            address: address,
            nickname: nickname || `Contact ${address.slice(0, 8)}`,
            notes: notes,
            addedAt: Date.now(),
            addedBy: authManager.getAddress()
        });
        
        await this.saveTrustedContacts();
        Logger.info('Added trusted contact:', address);
    }

    /**
     * Remove a trusted contact
     * @param {string} address - Ethereum address
     */
    async removeTrustedContact(address) {
        const normalizedAddress = address.toLowerCase();
        this.trustedContacts.delete(normalizedAddress);
        await this.saveTrustedContacts();
        Logger.info('Removed trusted contact:', address);
    }

    /**
     * Check if address is a trusted contact
     * @param {string} address - Ethereum address
     * @returns {Object|null} - Contact info or null
     */
    getTrustedContact(address) {
        return this.trustedContacts.get(address.toLowerCase()) || null;
    }

    /**
     * Get all trusted contacts
     * @returns {Array} - Array of contact objects
     */
    getAllTrustedContacts() {
        return Array.from(this.trustedContacts.values());
    }

    // ==================== TRUST LEVEL CALCULATION ====================

    /**
     * Get trust level for an address
     * @param {string} address - Ethereum address
     * @returns {Promise<number>} - Trust level (0-2, -1 for invalid)
     */
    async getTrustLevel(address) {
        const normalizedAddress = address.toLowerCase();
        
        // Check trusted contacts
        if (this.trustedContacts.has(normalizedAddress)) {
            return 2; // Trusted contact
        }
        
        // Check ENS
        const ensName = await this.resolveENS(address);
        if (ensName) {
            return 1; // ENS verified
        }
        
        return 0; // Unknown but valid signature
    }

    /**
     * Get trust level label
     * @param {number} level - Trust level
     * @returns {Object} - { label, icon, color }
     */
    getTrustLevelInfo(level) {
        const levels = {
            [-1]: { label: 'Invalid Signature', icon: '<svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>', color: 'red', bgColor: 'bg-red-900/30', textColor: 'text-red-400' },
            [0]: { label: 'Valid Signature', icon: '<svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>', color: 'green', bgColor: '', textColor: 'text-green-400' },
            [1]: { label: 'ENS Verified', icon: '<svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z"/></svg>', color: 'green', bgColor: '', textColor: 'text-green-400' },
            [2]: { label: 'Trusted Contact', icon: '<svg class="w-3.5 h-3.5 inline" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" clip-rule="evenodd"/></svg>', color: 'yellow', bgColor: '', textColor: 'text-yellow-400' }
        };
        return levels[level] || levels[0];
    }

    // ==================== PERSISTENCE ====================

    async saveTrustedContacts() {
        if (!secureStorage.isStorageUnlocked()) {
            Logger.warn('Cannot save contacts - secure storage not unlocked');
            return;
        }
        const data = Object.fromEntries(this.trustedContacts.entries());
        await secureStorage.setTrustedContacts(data);
    }

    loadTrustedContacts() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                return;
            }
            const data = secureStorage.getTrustedContacts();
            if (data && typeof data === 'object') {
                this.trustedContacts = new Map(Object.entries(data));
            }
        } catch (error) {
            Logger.error('Failed to load trusted contacts:', error);
        }
    }

    async saveENSCache() {
        if (!secureStorage.isStorageUnlocked()) {
            return;
        }
        const data = Object.fromEntries(this.ensCache.entries());
        await secureStorage.setENSCache(data);
    }

    loadENSCache() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                return;
            }
            const data = secureStorage.getENSCache();
            if (data && typeof data === 'object') {
                this.ensCache = new Map(Object.entries(data));
            }
        } catch (error) {
            Logger.error('Failed to load ENS cache:', error);
        }
    }

    // ==================== DISPLAY HELPERS ====================

    /**
     * Get display name for an address (ENS > Nickname > Short address)
     * @param {string} address - Ethereum address
     * @returns {Promise<string>} - Display name
     */
    async getDisplayName(address) {
        // Check for ENS name
        const ensName = await this.resolveENS(address);
        if (ensName) {
            return ensName;
        }
        
        // Check for trusted contact nickname
        const contact = this.getTrustedContact(address);
        if (contact && contact.nickname) {
            return contact.nickname;
        }
        
        // Return shortened address
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Get full identity info for display
     * @param {string} address - Ethereum address  
     * @param {Object} verificationResult - Result from verifyMessage
     * @returns {Promise<Object>} - Full identity info for UI
     */
    async getIdentityInfo(address, verificationResult = null) {
        const ensName = verificationResult?.ensName || await this.resolveENS(address);
        const trustLevel = verificationResult?.trustLevel ?? await this.getTrustLevel(address);
        const trustInfo = this.getTrustLevelInfo(trustLevel);
        const contact = this.getTrustedContact(address);
        const displayName = ensName || contact?.nickname || `${address.slice(0, 6)}...${address.slice(-4)}`;
        
        return {
            address: address,
            displayName: displayName,
            ensName: ensName,
            nickname: contact?.nickname,
            trustLevel: trustLevel,
            trustInfo: trustInfo,
            isTrusted: trustLevel >= 2,
            hasENS: !!ensName,
            signatureValid: verificationResult?.valid ?? null
        };
    }
}

// Export singleton instance
export const identityManager = new IdentityManager();
