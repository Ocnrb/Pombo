/**
 * Sync Manager
 * Cross-device synchronization using DM inbox Partition 1.
 * 
 * Architecture:
 * - Users publish encrypted sync payloads to their own inbox (Partition 1)
 * - ECDH self-encryption: only the owner can decrypt
 * - Pull fetches history from storage nodes, merges chronologically
 * - Push uploads current local state
 * 
 * Requirements:
 * - User must have created their DM inbox first (dmManager.createInbox)
 * - Sync operations silently skip if inbox doesn't exist
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { streamrController, STREAM_CONFIG } from './streamr.js';
import { secureStorage } from './secureStorage.js';
import { authManager } from './auth.js';
import { dmCrypto } from './dmCrypto.js';
import { channelManager } from './channels.js';
import { dmManager } from './dm.js';

class SyncManager {
    constructor() {
        this.syncSubscription = null;
        this.lastSyncTs = null;
        this.handlers = [];
        this.isSyncing = false;
    }

    /**
     * Register event handler
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    on(event, handler) {
        this.handlers.push({ event, handler });
    }

    /**
     * Remove event handler
     * @param {string} event - Event name
     * @param {Function} handler - Handler function to remove
     */
    off(event, handler) {
        this.handlers = this.handlers.filter(
            h => !(h.event === event && h.handler === handler)
        );
    }

    /**
     * Notify handlers of an event
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    notifyHandlers(event, data) {
        for (const { event: e, handler } of this.handlers) {
            if (e === event) {
                try {
                    handler(data);
                } catch (err) {
                    Logger.error('Sync handler error:', err);
                }
            }
        }
    }

    /**
     * Get the inbox stream ID for sync operations
     * @returns {string|null}
     */
    getInboxStreamId() {
        const myAddress = authManager.getAddress();
        if (!myAddress) return null;
        return streamrController.getDMInboxId(myAddress);
    }

    /**
     * Push current local state to sync partition.
     * Encrypts with self-ECDH so only the owner can decrypt.
     */
    async pushSync() {
        if (authManager.isGuestMode()) {
            Logger.debug('Sync: Skipping push in guest mode');
            return;
        }

        if (this.isSyncing) {
            Logger.warn('Sync: Already syncing, skipping push');
            return;
        }

        // Check if inbox exists (required for sync)
        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) {
            Logger.debug('Sync: No inbox yet, skipping push');
            return;
        }

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) {
            throw new Error('Sync: No wallet private key available');
        }

        const inboxStreamId = this.getInboxStreamId();
        if (!inboxStreamId) {
            throw new Error('Sync: DM inbox not available');
        }

        this.isSyncing = true;

        try {
            // Gather state from secureStorage
            const state = secureStorage.exportForSync();

            const payload = {
                type: 'sync',
                v: 1,
                ts: Date.now(),
                data: state
            };

            // Encrypt with self-ECDH (app-layer E2E)
            const myPubKey = dmCrypto.getMyPublicKey(privateKey);
            const aesKey = await dmCrypto.deriveSharedKey(privateKey, myPubKey);
            const encrypted = await dmCrypto.encrypt(payload, aesKey);

            // Set Pombo key for Streamr-layer encryption (consistent with DM messages)
            await streamrController.setDMPublishKey(inboxStreamId);

            // Publish to Partition 1 (SYNC)
            await streamrController.publish(
                inboxStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.SYNC,
                encrypted
            );

            this.lastSyncTs = payload.ts;
            Logger.info('Sync: Pushed state to storage nodes', { ts: payload.ts });

            this.notifyHandlers('sync_pushed', { ts: payload.ts });
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Pull sync history and merge with local state.
     * Fetches all payloads, merges chronologically (older first, newer overwrites).
     * @param {Object} options
     * @param {number} options.limit - Max payloads to fetch (default: 10)
     * @returns {Promise<Object|null>} - Merged state or null if no sync data
     */
    async pullSync(options = {}) {
        if (authManager.isGuestMode()) {
            Logger.debug('Sync: Skipping pull in guest mode');
            return null;
        }

        if (this.isSyncing) {
            Logger.warn('Sync: Already syncing, skipping pull');
            return null;
        }

        // Check if inbox exists (required for sync)
        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) {
            Logger.debug('Sync: No inbox yet, skipping pull');
            return null;
        }

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) {
            throw new Error('Sync: No wallet private key available');
        }

        const myAddress = authManager.getAddress()?.toLowerCase();
        const inboxStreamId = this.getInboxStreamId();
        if (!inboxStreamId) {
            throw new Error('Sync: DM inbox not available');
        }

        this.isSyncing = true;

        try {
            Logger.info('Sync: Pulling from storage nodes...', { streamId: inboxStreamId, partition: STREAM_CONFIG.MESSAGE_STREAM.SYNC });

            // Add our own decrypt key for Streamr-layer encryption
            // (we encrypted with Pombo key, need to add it to read our own messages)
            await streamrController.addDMDecryptKey(myAddress);

            // Fetch history from Partition 1 (SYNC)
            const messages = await streamrController.fetchPartitionHistory(
                inboxStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.SYNC,
                options.limit || 10
            );

            Logger.info('Sync: Fetched messages:', { count: messages.length });

            if (!messages.length) {
                Logger.info('Sync: No remote state found');
                return null;
            }

            // Decrypt payloads
            const myPubKey = dmCrypto.getMyPublicKey(privateKey);
            const aesKey = await dmCrypto.deriveSharedKey(privateKey, myPubKey);

            const decrypted = [];
            for (const msg of messages) {
                Logger.debug('Sync: Processing message', { 
                    publisherId: msg.publisherId, 
                    myAddress,
                    match: msg.publisherId?.toLowerCase() === myAddress
                });

                // Verify sender is self (ignore spam from others)
                if (msg.publisherId?.toLowerCase() !== myAddress) {
                    Logger.warn('Sync: Ignoring payload from unknown sender', msg.publisherId);
                    continue;
                }

                if (!dmCrypto.isEncrypted(msg.content)) {
                    Logger.debug('Sync: Message not encrypted, skipping');
                    continue;
                }

                try {
                    const payload = await dmCrypto.decrypt(msg.content, aesKey);
                    Logger.debug('Sync: Decrypted payload', { type: payload.type, v: payload.v });
                    if (payload.type === 'sync' && payload.v === 1) {
                        decrypted.push(payload);
                    }
                } catch (e) {
                    Logger.warn('Sync: Failed to decrypt payload', e.message);
                }
            }

            Logger.info('Sync: Valid payloads found:', { count: decrypted.length });

            if (!decrypted.length) {
                Logger.info('Sync: No valid sync payloads found');
                return null;
            }

            // Sort by timestamp (oldest first) and merge all
            decrypted.sort((a, b) => a.ts - b.ts);

            // Progressive merge: start with local, apply each remote chronologically
            let merged = secureStorage.exportForSync();
            for (const payload of decrypted) {
                merged = this.mergeState(merged, payload.data);
            }

            // Apply final merged state
            const channelsUpdated = await secureStorage.importFromSync(merged);

            // Reload channelManager if channels were updated
            if (channelsUpdated) {
                channelManager.loadChannels();
                Logger.info('Sync: Reloaded channel list');
            }

            const latestTs = decrypted[decrypted.length - 1].ts;
            this.lastSyncTs = latestTs;

            Logger.info('Sync: Merged remote state', {
                payloads: decrypted.length,
                latestTs: new Date(latestTs).toISOString()
            });

            this.notifyHandlers('sync_pulled', { ts: latestTs });

            return merged;
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Merge two states together.
     * Strategy: Union with deduplication, incoming values preferred for scalars.
     * @param {Object} base - Base state (local or accumulated)
     * @param {Object} incoming - Incoming state to merge
     * @returns {Object} - Merged state
     */
    mergeState(base, incoming) {
        const merged = {};

        // Sent Messages: merge per conversation, dedupe by message ID
        merged.sentMessages = this.mergeSentMessages(
            base.sentMessages || {},
            incoming.sentMessages || {}
        );

        // Channels: merge by streamId (union)
        merged.channels = this.mergeChannels(
            base.channels || [],
            incoming.channels || []
        );

        // Trusted Contacts: union, incoming values take precedence
        merged.trustedContacts = {
            ...base.trustedContacts,
            ...incoming.trustedContacts
        };

        // ENS Cache: union
        merged.ensCache = {
            ...base.ensCache,
            ...incoming.ensCache
        };

        // Username: prefer incoming if set
        merged.username = incoming.username || base.username;

        // Graph API Key: prefer incoming if set
        merged.graphApiKey = incoming.graphApiKey || base.graphApiKey;

        return merged;
    }

    /**
     * Merge sent messages from two states.
     * Deduplicates by message ID, sorts by timestamp, trims to max.
     * @param {Object} local - Local sentMessages { streamId: [...messages] }
     * @param {Object} remote - Remote sentMessages
     * @returns {Object} - Merged sentMessages
     */
    mergeSentMessages(local, remote) {
        const result = { ...local };

        for (const [streamId, remoteMessages] of Object.entries(remote)) {
            if (!result[streamId]) {
                result[streamId] = remoteMessages;
            } else {
                // Merge by message ID
                const localIds = new Set(result[streamId].map(m => m.id));
                for (const msg of remoteMessages) {
                    if (!localIds.has(msg.id)) {
                        result[streamId].push(msg);
                    }
                }
                // Sort by timestamp
                result[streamId].sort((a, b) => a.timestamp - b.timestamp);
                // Trim to max
                if (result[streamId].length > CONFIG.dm.maxSentMessages) {
                    result[streamId] = result[streamId].slice(-CONFIG.dm.maxSentMessages);
                }
            }
        }

        return result;
    }

    /**
     * Merge channels from two states.
     * Union by streamId, prefers remote metadata on conflict.
     * @param {Array} local - Local channels array
     * @param {Array} remote - Remote channels array
     * @returns {Array} - Merged channels
     */
    mergeChannels(local, remote) {
        const byStreamId = new Map();

        // Add local channels
        for (const ch of local) {
            const id = ch.messageStreamId || ch.streamId;
            byStreamId.set(id, ch);
        }

        // Merge remote channels (remote takes precedence)
        for (const ch of remote) {
            const id = ch.messageStreamId || ch.streamId;
            if (!byStreamId.has(id)) {
                byStreamId.set(id, ch);
            } else {
                // Merge: keep local but update with remote fields
                const existing = byStreamId.get(id);
                byStreamId.set(id, { ...existing, ...ch });
            }
        }

        return Array.from(byStreamId.values());
    }

    /**
     * Smart sync: pull first, then push if we have local changes.
     * Always pushes after pull to ensure remote has latest merged state.
     * @returns {Promise<{pulled: boolean, pushed: boolean, noInbox: boolean}>}
     */
    async smartSync() {
        if (authManager.isGuestMode()) {
            Logger.debug('Sync: Skipping smart sync in guest mode');
            return { pulled: false, pushed: false, noInbox: false };
        }

        // Check if inbox exists
        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) {
            Logger.info('Sync: No inbox yet, skipping smart sync');
            return { pulled: false, pushed: false, noInbox: true };
        }

        Logger.info('Sync: Starting smart sync...');
        const result = { pulled: false, pushed: false, noInbox: false };

        try {
            // Pull first - merges remote into local
            const pullResult = await this.pullSync();
            result.pulled = pullResult !== null;

            // Always push to ensure remote has our merged state
            await this.pushSync();
            result.pushed = true;

            Logger.info('Sync: Smart sync completed', result);
            this.notifyHandlers('sync_complete', result);
        } catch (err) {
            Logger.error('Sync: Smart sync failed', err);
            throw err;
        }

        return result;
    }

    /**
     * Full sync with verification: push, wait, then pull to verify.
     * Used when user wants to ensure data is synced.
     * @param {number} delay - Delay in ms to wait for storage propagation (default: 5000)
     * @returns {Promise<{pushed: boolean, verified: boolean}>}
     */
    async fullSyncWithVerify(delay = 5000) {
        if (authManager.isGuestMode()) {
            return { pushed: false, verified: false };
        }

        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) {
            return { pushed: false, verified: false, noInbox: true };
        }

        try {
            // Push first
            await this.pushSync();
            
            // Wait for storage propagation
            Logger.info(`Sync: Waiting ${delay}ms for storage propagation...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Pull to verify
            const pullResult = await this.pullSync();
            
            return { 
                pushed: true, 
                verified: pullResult !== null 
            };
        } catch (err) {
            Logger.error('Sync: Full sync with verify failed', err);
            throw err;
        }
    }

    /**
     * Schedule an auto-push with debounce.
     * Useful for triggering sync after user actions.
     * @param {number} delay - Debounce delay in ms (default: 15000)
     */
    scheduleAutoPush(delay = 15000) {
        if (authManager.isGuestMode()) return;

        // Clear existing timeout
        if (this.autoPushTimeout) {
            clearTimeout(this.autoPushTimeout);
        }

        this.autoPushTimeout = setTimeout(async () => {
            try {
                await this.pushSync();
                Logger.info('Sync: Auto-push completed');
            } catch (err) {
                Logger.warn('Sync: Auto-push failed', err.message);
            }
        }, delay);
    }

    /**
     * Cancel any pending auto-push
     */
    cancelAutoPush() {
        if (this.autoPushTimeout) {
            clearTimeout(this.autoPushTimeout);
            this.autoPushTimeout = null;
        }
    }

    /**
     * Force immediate push (e.g., on page unload)
     * Uses synchronous-friendly approach
     */
    async forcePushNow() {
        this.cancelAutoPush();
        if (!authManager.isGuestMode() && !this.isSyncing) {
            try {
                await this.pushSync();
            } catch (err) {
                Logger.warn('Sync: Force push failed', err.message);
            }
        }
    }

    /**
     * Full sync: pull then push.
     * Pull first to get remote changes, then push local state.
     */
    async fullSync() {
        await this.pullSync();
        await this.pushSync();
    }

    /**
     * Get sync status
     * @returns {Object} - { lastSyncTs, isSyncing }
     */
    getStatus() {
        return {
            lastSyncTs: this.lastSyncTs,
            isSyncing: this.isSyncing
        };
    }
}

export const syncManager = new SyncManager();
