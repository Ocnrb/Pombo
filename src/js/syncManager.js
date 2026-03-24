/**
 * Sync Manager
 * Cross-device synchronization using DM inbox.
 * 
 * Architecture:
 * - Partition 1 (SYNC): state payloads (channels, messages metadata, reactions)
 * - Partition 2 (SYNC_BLOBS): image blobs (heavy, incremental)
 * - ECDH self-encryption: only the owner can decrypt
 * - Pull fetches history from storage nodes, merges chronologically
 * - Push uploads current local state + unsynced blobs
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
import { identityManager } from './identity.js';

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

            // Progressive merge: start with local state (preserving imageData),
            // apply each remote chronologically. Using exportForBackup() instead
            // of exportForSync() so local imageData is not stripped before merge.
            // The merge dedup keeps local versions, so images we already have
            // won't be lost when the remote version lacks imageData.
            let merged = secureStorage.exportForBackup();
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

            // Reload username in identity manager
            identityManager.loadUsername();

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
     * Strategy: channels, blockedPeers and dmLeftAt use latest-wins (incoming replaces base);
     * sentMessages/sentReactions merge per-key with dedup;
     * trustedContacts/ensCache use union with incoming precedence.
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

        // Sent Reactions: incoming wins per messageId, local-only preserved
        merged.sentReactions = this.mergeSentReactions(
            base.sentReactions || {},
            incoming.sentReactions || {}
        );

        // Channels: latest state wins (incoming replaces base)
        merged.channels = incoming.channels !== undefined
            ? incoming.channels
            : (base.channels || []);

        // Blocked Peers: latest state wins (incoming replaces base)
        merged.blockedPeers = incoming.blockedPeers !== undefined
            ? incoming.blockedPeers
            : (base.blockedPeers || []);

        // DM Left At: latest state wins (incoming replaces base)
        merged.dmLeftAt = incoming.dmLeftAt !== undefined
            ? incoming.dmLeftAt
            : (base.dmLeftAt || {});

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
        // Defensive copy — never mutate caller's arrays or message objects
        const result = {};
        for (const [k, v] of Object.entries(local)) {
            result[k] = v.map(m => ({ ...m }));
        }

        for (const [streamId, remoteMessages] of Object.entries(remote)) {
            if (!result[streamId]) {
                result[streamId] = remoteMessages.map(m => ({ ...m }));
            } else {
                // Merge by message ID, preserving imageData from either side
                const localById = new Map(result[streamId].map(m => [m.id, m]));
                for (const msg of remoteMessages) {
                    const existing = localById.get(msg.id);
                    if (!existing) {
                        result[streamId].push({ ...msg });
                    } else if (msg.type === 'image' && msg.imageData && !existing.imageData) {
                        // Remote has imageData that local lost — adopt it
                        existing.imageData = msg.imageData;
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
     * Merge sent reactions from two states.
     * Per messageId: incoming (newer) state wins over base (handles removals correctly).
     * Entries only in base (local-only, not yet synced) are preserved.
     * @param {Object} local - Local sentReactions { streamId: { messageId: { emoji: [users] } } }
     * @param {Object} remote - Remote sentReactions (from newer sync payloads)
     * @returns {Object} - Merged sentReactions
     */
    mergeSentReactions(local, remote) {
        const result = {};

        // Collect all streamIds from both
        const allStreamIds = new Set([...Object.keys(local), ...Object.keys(remote)]);

        for (const streamId of allStreamIds) {
            const localStream = local[streamId] || {};
            const remoteStream = remote[streamId] || {};
            result[streamId] = {};

            const allMessageIds = new Set([...Object.keys(localStream), ...Object.keys(remoteStream)]);

            for (const messageId of allMessageIds) {
                const inLocal = messageId in localStream;
                const inRemote = messageId in remoteStream;

                if (inRemote) {
                    // Remote state wins (handles both additions and removals)
                    const remoteReactions = remoteStream[messageId];
                    if (Object.keys(remoteReactions).length > 0) {
                        result[streamId][messageId] = remoteReactions;
                    }
                    // If remote has empty reactions for this message, it was fully removed — skip it
                } else {
                    // Only in local (new, not yet synced) — preserve
                    result[streamId][messageId] = localStream[messageId];
                }
            }

            // Clean up empty streamId entries
            if (Object.keys(result[streamId]).length === 0) {
                delete result[streamId];
            }
        }

        return result;
    }

    /**
     * Push unsynced image blobs to Partition 2 (SYNC_BLOBS).
     * Each image is published as a separate message to avoid payload limits.
     * Uses async generator to stream images one-at-a-time.
     */
    async pushImageBlobs() {
        if (authManager.isGuestMode()) return;
        if (this.isSyncing) return;

        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) return;

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) return;

        const inboxStreamId = this.getInboxStreamId();
        if (!inboxStreamId) return;

        const myPubKey = dmCrypto.getMyPublicKey(privateKey);
        const aesKey = await dmCrypto.deriveSharedKey(privateKey, myPubKey);

        await streamrController.setDMPublishKey(inboxStreamId);

        let count = 0;
        for await (const record of secureStorage.getUnsyncedImages()) {
            try {
                const imageData = await secureStorage.decryptBlob(record.encryptedData, record.iv);

                const payload = {
                    type: 'sync_blob',
                    v: 2,
                    ts: Date.now(),
                    imageId: record.imageId,
                    streamId: record.streamId,
                    data: imageData
                };

                const encrypted = await dmCrypto.encrypt(payload, aesKey);
                await streamrController.publish(
                    inboxStreamId,
                    STREAM_CONFIG.MESSAGE_STREAM.SYNC_BLOBS,
                    encrypted
                );

                await secureStorage.markImageSynced(record.imageId);
                count++;
            } catch (err) {
                Logger.warn('Sync: Failed to push blob', record.imageId, err.message);
            }
        }

        if (count > 0) {
            Logger.info(`Sync: Pushed ${count} image blob(s)`);
        }
    }

    /**
     * Pull image blobs from Partition 2 (SYNC_BLOBS).
     * Imports blobs from other devices into the local IndexedDB ledger.
     * @param {Object} options
     * @param {number} options.limit - Max messages to fetch (default: 50)
     */
    async pullImageBlobs(options = {}) {
        if (authManager.isGuestMode()) return;
        if (this.isSyncing) return;

        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) return;

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) return;

        const myAddress = authManager.getAddress()?.toLowerCase();
        const inboxStreamId = this.getInboxStreamId();
        if (!inboxStreamId) return;

        await streamrController.addDMDecryptKey(myAddress);

        const messages = await streamrController.fetchPartitionHistory(
            inboxStreamId,
            STREAM_CONFIG.MESSAGE_STREAM.SYNC_BLOBS,
            options.limit || 50
        );

        if (!messages.length) return;

        const myPubKey = dmCrypto.getMyPublicKey(privateKey);
        const aesKey = await dmCrypto.deriveSharedKey(privateKey, myPubKey);

        let imported = 0;
        for (const msg of messages) {
            if (msg.publisherId?.toLowerCase() !== myAddress) continue;
            if (!dmCrypto.isEncrypted(msg.content)) continue;

            try {
                const payload = await dmCrypto.decrypt(msg.content, aesKey);
                if (payload.type !== 'sync_blob' || payload.v !== 2) continue;

                const saved = await secureStorage.saveImageToLedger(
                    payload.imageId,
                    payload.data,
                    payload.streamId
                );
                // Mark as synced immediately — this image came FROM the network,
                // so it doesn't need to be pushed back on next sync cycle
                await secureStorage.markImageSynced(payload.imageId);
                if (saved) {
                    imported++;
                    // Notify UI so placeholders get replaced in real-time
                    this.notifyHandlers('blob_pulled', { imageId: payload.imageId, data: payload.data });
                }
            } catch (err) {
                Logger.warn('Sync: Failed to import blob', err.message);
            }
        }

        if (imported > 0) {
            Logger.info(`Sync: Imported ${imported} image blob(s)`);
        }
    }

    /**
     * Smart sync: push first (snapshot local state), then pull (accept latest remote).
     * Push-first ensures our state is on the storage node before we pull,
     * so leaving a channel is respected (our push without the channel is the latest).
     * Also syncs image blobs via Partition 2.
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
            // Push state (partition 1)
            await this.pushSync();
            result.pushed = true;

            // Push image blobs (partition 2) — incremental, non-blocking
            await this.pushImageBlobs();

            // Pull state (partition 1)
            const pullResult = await this.pullSync();
            result.pulled = pullResult !== null;

            // Pull image blobs (partition 2)
            await this.pullImageBlobs();

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
            // Push first (state + blobs)
            await this.pushSync();
            await this.pushImageBlobs();
            
            // Wait for storage propagation
            Logger.info(`Sync: Waiting ${delay}ms for storage propagation...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Pull to verify (state + blobs)
            const pullResult = await this.pullSync();
            await this.pullImageBlobs();
            
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
     * Full sync: push then pull (state + blobs).
     * Push first to snapshot local state, then pull and merge remote changes.
     */
    async fullSync() {
        await this.pushSync();
        await this.pushImageBlobs();
        await this.pullSync();
        await this.pullImageBlobs();
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
