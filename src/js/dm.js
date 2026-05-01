/**
 * DM Manager
 * Manages Direct Messages using paired many-to-one Streamr streams.
 * 
 * Architecture:
 * - Each user has a deterministic inbox: {address}/Pombo-DM-1 (stored) + {address}/Pombo-DM-2 (ephemeral)
 * - Permissions: public PUBLISH, owner-only SUBSCRIBE (protects social graph)
 * - Streamr-layer encryption uses pre-agreed "Pombo key" (allows history fetch when publisher offline)
 * - Real E2E security: app-layer ECDH + AES-256-GCM encryption per conversation
 * - To DM Bob: Alice publishes to Bob's inbox. Bob reads from his own inbox.
 * - The senderId (Streamr publisherId) identifies who sent each message.
 * - Conversations are keyed by peerAddress and stored locally.
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { CryptoError } from './utils/errors.js';
import { streamrController, STREAM_CONFIG } from './streamr.js';
import { channelManager } from './channels.js';
import { secureStorage } from './secureStorage.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { relayManager } from './relayManager.js';
import { dmCrypto } from './dmCrypto.js';
import { mediaController } from './media.js';

class DMManager {
    constructor() {
        // My inbox stream IDs
        this.inboxMessageStreamId = null;
        this.inboxEphemeralStreamId = null;

        // Active inbox subscriptions (when app is open)
        this.inboxSubscription = null;
        this.inboxEphemeralSubscription = null;
        this.inboxNotificationSub = null;

        // Conversations: peerAddress (lowercase) → messageStreamId in channelManager
        this.conversations = new Map();

        // Guards against concurrent getOrCreateConversation for the same peer
        // peerAddress → Promise<channel>
        this.pendingConversations = new Map();

        // Whether inbox has been verified/created
        this.inboxReady = false;

        // Event handlers (UI notifications)
        this.handlers = [];
    }

    /**
     * Initialize DM system — called after wallet connection (non-guest only)
     * Checks if inbox exists, loads saved DM conversations, sets up routing.
     */
    async init() {
        if (authManager.isGuestMode()) {
            Logger.debug('DM: Skipping init for guest mode');
            return;
        }

        const myAddress = authManager.getAddress();
        if (!myAddress) {
            Logger.warn('DM: No address available, skipping init');
            return;
        }

        this.inboxMessageStreamId = streamrController.getDMInboxId(myAddress);
        this.inboxEphemeralStreamId = streamrController.getDMEphemeralId(myAddress);

        // Rebuild conversations map from saved channels
        this.loadConversationsFromChannels();

        Logger.info('DM: Initialized', {
            inbox: this.inboxMessageStreamId,
            conversations: this.conversations.size
        });

        // Auto-subscribe to inbox if it exists (loads history + real-time)
        try {
            const exists = await this.hasInbox();
            if (exists) {
                this.inboxReady = true;
                await this.subscribeToInbox();

                // Also re-register push notifications for inbox
                this.subscribeInboxPush().catch(e => {
                    Logger.debug('DM: Push re-registration failed (non-critical):', e.message);
                });
            }
        } catch (e) {
            Logger.warn('DM: Auto-subscribe to inbox failed (non-critical):', e.message);
        }
    }

    /**
     * Rebuild the conversations map from existing DM channels in channelManager
     */
    loadConversationsFromChannels() {
        this.conversations.clear();
        for (const [streamId, channel] of channelManager.channels) {
            if (channel.type === 'dm' && channel.peerAddress) {
                this.conversations.set(channel.peerAddress.toLowerCase(), streamId);
            }
        }
    }

    /**
     * Check if the current user's inbox already exists on-chain
     * @returns {Promise<boolean>}
     */
    async hasInbox() {
        if (!this.inboxMessageStreamId) return false;

        try {
            await streamrController.client.getStream(this.inboxMessageStreamId);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Create inbox streams (idempotent — skips if already exists)
     * @param {Object} options - Storage options
     * @param {string} options.storageProvider - 'streamr' or 'logstore' (default: 'streamr')
     * @param {number} options.storageDays - Retention days for Streamr (default: 180)
     * @param {Function} [options.onProgress] - Called once per on-chain step
     * @returns {Promise<{messageStreamId: string, ephemeralStreamId: string}>}
     */
    async createInbox(options = {}) {
        // Compute our public key for ECDH key exchange (stored in stream metadata)
        const privateKey = authManager.wallet?.privateKey;
        const publicKey = privateKey ? dmCrypto.getMyPublicKey(privateKey) : null;

        const result = await streamrController.createDMInbox(publicKey, options);
        this.inboxMessageStreamId = result.messageStreamId;
        this.inboxEphemeralStreamId = result.ephemeralStreamId;
        this.inboxReady = true;

        Logger.info('DM: Inbox created/verified');
        this.notifyHandlers('inbox_ready', { streamId: this.inboxMessageStreamId });

        // Subscribe to inbox for real-time messages
        await this.subscribeToInbox();

        // Auto-subscribe to push notifications for our inbox
        this.subscribeInboxPush().catch(e => {
            Logger.debug('DM: Push subscription for inbox failed (non-critical):', e.message);
        });

        return result;
    }

    /**
     * Diagnose inbox health — read-only, no gas.
     * @returns {Promise<Object>} Diagnosis report from streamrController.diagnoseInbox()
     */
    async diagnoseInbox() {
        const address = authManager.getAddress();
        if (!address) throw new Error('No wallet connected');
        return streamrController.diagnoseInbox(address);
    }

    /**
     * Repair inbox based on diagnosis — only runs missing/broken steps.
     * @param {Object} diagnosis - Result from diagnoseInbox()
     * @param {Object} options - Storage options { storageProvider, storageDays }
     * @param {Function} onStep - Progress callback: (stepName, status)
     * @returns {Promise<Object>} Repair result
     */
    async repairInbox(diagnosis, options = {}, onStep = () => {}) {
        const privateKey = authManager.wallet?.privateKey;
        const publicKey = privateKey ? dmCrypto.getMyPublicKey(privateKey) : null;

        const result = await streamrController.repairInbox(diagnosis, publicKey, options, onStep);

        this.inboxMessageStreamId = result.messageStreamId;
        this.inboxEphemeralStreamId = result.ephemeralStreamId;
        this.inboxReady = true;

        Logger.info('DM: Inbox repaired');
        this.notifyHandlers('inbox_ready', { streamId: this.inboxMessageStreamId });

        // Re-subscribe to inbox after repair
        this.inboxSubscription = null; // Force re-subscribe
        await this.subscribeToInbox();

        return result;
    }

    /**
     * Subscribe to own inbox (real-time messages from others)
     * Call when user opens the Personal/DM tab or on startup.
     */
    async subscribeToInbox() {
        if (!this.inboxMessageStreamId) {
            Logger.warn('DM: Cannot subscribe — inbox not initialized');
            return;
        }

        if (this.inboxSubscription) {
            Logger.debug('DM: Already subscribed to inbox');
            return;
        }

        try {
            Logger.info('DM: Subscribing to inbox', this.inboxMessageStreamId);

            // Add decrypt keys for all known conversation peers
            // This allows us to decrypt messages from senders who used the Pombo key
            for (const peerAddress of this.conversations.keys()) {
                await streamrController.addDMDecryptKey(peerAddress);
            }

            // Subscribe to message stream (DM-1 partition 0) with history
            this.inboxSubscription = await streamrController.subscribeWithHistory(
                this.inboxMessageStreamId,
                0,  // partition 0 = messages
                (data) => this.routeInboxMessage(data),
                CONFIG.dm.inboxHistoryCount,
                null  // No Streamr password; messages encrypted E2E at app layer (ECDH+AES-256-GCM)
            );

            Logger.info('DM: Inbox message subscription active');

            // Subscribe to notification partition (DM-1 partition 3) for channel invites
            // Skip if user has muted invites
            const { notificationManager } = await import('./notifications.js');
            if (!notificationManager.isMuted()) {
                try {
                    this.inboxNotificationSub = await streamrController.subscribeToPartition(
                        this.inboxMessageStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS,
                        (data) => this.routeNotification(data),
                        null
                    );
                    Logger.info('DM: Notification subscription active (P3)');
                } catch (e) {
                    Logger.warn('DM: Failed to subscribe to notification partition:', e.message);
                    this.inboxNotificationSub = null;
                }
            } else {
                Logger.info('DM: Notification invites muted — skipping P3 subscription');
            }

            // DM-2 ephemeral (typing/presence) is on-demand only:
            // subscribed when user opens a DM conversation, unsubscribed when they leave.
        } catch (error) {
            Logger.error('DM: Failed to subscribe to inbox:', error.message);
            this.inboxSubscription = null;
        }
    }

    /**
     * Unsubscribe from inbox (when leaving DM tab or disconnecting)
     */
    async unsubscribeFromInbox() {
        try {
            if (this.inboxSubscription) {
                await streamrController.unsubscribe(this.inboxMessageStreamId);
            }
            Logger.info('DM: Unsubscribed from inbox');
        } catch (error) {
            Logger.warn('DM: Error unsubscribing:', error.message);
        }
        this.inboxSubscription = null;
        this.inboxNotificationSub = null;
        // Also tear down ephemeral if active
        await this.unsubscribeDMEphemeral();
    }

    /**
     * Subscribe to notification partition (P3) on demand.
     * Called when user unmutes channel invites.
     */
    async subscribeNotifications() {
        if (!this.inboxMessageStreamId || this.inboxNotificationSub) return;
        try {
            this.inboxNotificationSub = await streamrController.subscribeToPartition(
                this.inboxMessageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS,
                (data) => this.routeNotification(data),
                null
            );
            Logger.info('DM: Notification subscription active (P3)');
        } catch (e) {
            Logger.warn('DM: Failed to subscribe to notification partition:', e.message);
            this.inboxNotificationSub = null;
        }
    }

    /**
     * Unsubscribe from notification partition (P3).
     * Called when user mutes channel invites.
     */
    async unsubscribeNotifications() {
        if (!this.inboxNotificationSub) return;
        try {
            await streamrController.unsubscribeFromPartition(
                this.inboxMessageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS
            );
            Logger.info('DM: Unsubscribed from notification partition (P3)');
        } catch (e) {
            Logger.warn('DM: Error unsubscribing from P3:', e.message);
        }
        this.inboxNotificationSub = null;
    }

    /**
     * Subscribe to DM-2 ephemeral (typing/presence) — on-demand.
     * Called when user opens a DM conversation.
     */
    async subscribeDMEphemeral() {
        if (!this.inboxEphemeralStreamId) return;
        if (this.inboxEphemeralSubscription) {
            Logger.debug('DM: Ephemeral already subscribed');
            return;
        }

        try {
            // Add decrypt keys for known peers (for ephemeral control messages)
            for (const peerAddress of this.conversations.keys()) {
                await streamrController.addDMDecryptKey(peerAddress);
            }

            // Partition 0: Control (presence, typing)
            this.inboxEphemeralSubscription = await streamrController.subscribeWithHistory(
                this.inboxEphemeralStreamId,
                STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL,
                (data) => this.routeInboxControl(data),
                0,  // no history — ephemeral
                null
            );

            // Partition 1: Media signals (piece_request, source_request, etc.)
            await streamrController.subscribeToPartition(
                this.inboxEphemeralStreamId,
                STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS,
                (data) => this.routeInboxMedia(data),
                null
            );

            // Partition 2: Media data (file_piece — binary)
            await streamrController.subscribeToPartition(
                this.inboxEphemeralStreamId,
                STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA,
                (data, senderId) => this.routeInboxMedia(data, senderId),
                null
            );

            Logger.info('DM: Ephemeral subscription active (control + media signals + media data)');
        } catch (error) {
            Logger.warn('DM: Ephemeral subscription failed (non-critical):', error.message);
            this.inboxEphemeralSubscription = null;
        }
    }

    /**
     * Unsubscribe from DM-2 ephemeral — called when user leaves DM conversation.
     */
    async unsubscribeDMEphemeral() {
        if (!this.inboxEphemeralSubscription) return;

        try {
            await streamrController.unsubscribe(this.inboxEphemeralStreamId);
            Logger.info('DM: Ephemeral unsubscribed');
        } catch (error) {
            Logger.warn('DM: Error unsubscribing ephemeral:', error.message);
        }
        this.inboxEphemeralSubscription = null;
    }

    /**
     * Decrypt an E2E encrypted DM envelope.
     * @param {Object} data - Encrypted envelope { ct, iv, e } with senderId
     * @param {string} senderAddress - Sender's address (lowercase)
     * @returns {Promise<Object|null>} - Decrypted data with senderId restored, or null if not encrypted / missing keys
     * @throws {CryptoError} If decryption fails on a genuinely encrypted envelope
     */
    async decryptDMEnvelope(data, senderAddress) {
        if (!dmCrypto.isEncrypted(data)) {
            return data;
        }

        try {
            const privateKey = authManager.wallet?.privateKey;
            if (!privateKey) {
                Logger.warn('DM: Cannot decrypt — no private key');
                return null;
            }

            const peerPubKey = await this.getPeerPublicKey(senderAddress);
            if (!peerPubKey) {
                Logger.warn('DM: Cannot decrypt — missing peer public key for', senderAddress);
                return null;
            }

            const aesKey = await dmCrypto.getSharedKey(privateKey, senderAddress, peerPubKey);
            const decrypted = await dmCrypto.decrypt(data, aesKey);
            
            // Restore senderId (not part of encrypted payload)
            decrypted.senderId = senderAddress;
            
            return decrypted;
        } catch (e) {
            Logger.error('DM: Decryption failed from', senderAddress, e.message);
            throw new CryptoError(
                `DM decryption failed from ${senderAddress}`,
                'DM_DECRYPT_FAILED',
                { cause: e }
            );
        }
    }

    /**
     * Route an incoming ephemeral/control message (typing, presence) to the correct conversation.
     * Messages arrive on MY DM-2, routed by senderId to the matching conversation.
     * E2E encrypted envelopes are decrypted before forwarding.
     * @param {Object} data - Control data (possibly encrypted) with senderId from Streamr publisherId
     */
    async routeInboxControl(data) {
        if (!data || !data.senderId) return;

        const senderAddress = data.senderId.toLowerCase();
        const myAddress = authManager.getAddress()?.toLowerCase();
        if (senderAddress === myAddress) return;

        // Block check: ignore control messages from blocked peers
        if (secureStorage.isBlocked(senderAddress)) return;

        // Soft-leave check: ignore control messages from peers we left
        if (secureStorage.getDMLeftAt(senderAddress)) return;

        // Find the conversation for this sender
        const channelStreamId = this.conversations.get(senderAddress);
        if (!channelStreamId) return;

        // Decrypt E2E envelope if present
        let controlData;
        try {
            controlData = await this.decryptDMEnvelope(data, senderAddress);
        } catch {
            return; // Decryption failed — already logged inside decryptDMEnvelope
        }
        if (!controlData) return;

        // Inject identity fields for control messages
        if (controlData.type === 'typing') {
            controlData.user = senderAddress;
        } else if (controlData.type === 'presence') {
            controlData.userId = controlData.userId || senderAddress;
            controlData.address = controlData.address || senderAddress;
        }

        // Forward to channelManager with the conversation's messageStreamId
        channelManager.handleControlMessage(channelStreamId, controlData);
    }

    /**
     * Route an incoming media message from DM inbox ephemeral to mediaController.
     * @param {Object|Uint8Array} data - Media data (JSON or binary)
     * @param {string} [senderId] - Publisher ID (provided for binary messages)
     */
    async routeInboxMedia(data, senderId) {
        // For JSON messages, senderId is embedded in data.senderId
        const sender = senderId || data?.senderId;
        if (!sender) return;

        const senderAddress = sender.toLowerCase();
        const myAddress = authManager.getAddress()?.toLowerCase();
        if (senderAddress === myAddress) return;

        // Block check
        if (secureStorage.isBlocked(senderAddress)) return;

        // Find conversation for this sender
        const channelStreamId = this.conversations.get(senderAddress);
        if (!channelStreamId) return;

        // Decrypt media with ECDH shared key (Alice-Bob specific)
        try {
            const privateKey = authManager.wallet?.privateKey;
            const peerPubKey = await this.getPeerPublicKey(senderAddress);

            if (privateKey && peerPubKey) {
                const aesKey = await dmCrypto.getSharedKey(privateKey, senderAddress, peerPubKey);

                if (data instanceof Uint8Array) {
                    // P2: Binary media — decrypt with ECDH key
                    data = await dmCrypto.decryptBinary(data, aesKey);
                } else if (dmCrypto.isEncrypted(data)) {
                    // P1: JSON signal — decrypt envelope with ECDH key
                    data = await dmCrypto.decrypt(data, aesKey);
                    data.senderId = senderAddress;
                }
            }
        } catch (e) {
            Logger.warn('DM: Media decryption failed from', senderAddress, e.message);
            return;
        }

        // Forward to mediaController — it handles binary decode and dispatch
        mediaController.handleMediaMessage(channelStreamId, data, senderId);
    }

    /**
     * Route an incoming inbox message to the correct DM conversation.
     * If the sender has no conversation yet, auto-create one.
     * @param {Object} data - Message with senderId from Streamr publisherId
     */
    async routeInboxMessage(data) {
        if (!data || !data.senderId) {
            Logger.warn('DM: Received message without senderId, ignoring');
            return;
        }

        const senderAddress = data.senderId.toLowerCase();
        const myAddress = authManager.getAddress()?.toLowerCase();

        // Ignore our own messages (echoed back from inbox)
        if (senderAddress === myAddress) return;

        // Block check: permanently blocked peers are always ignored
        if (secureStorage.isBlocked(senderAddress)) {
            Logger.debug('DM: Ignoring message from blocked peer', senderAddress);
            return;
        }

        // E2E decrypt if needed
        try {
            data = await this.decryptDMEnvelope(data, senderAddress);
        } catch {
            return; // Decryption failed — already logged inside decryptDMEnvelope
        }
        if (!data) return;

        // Soft-leave check: ignore messages older than the leave timestamp
        const leftAt = secureStorage.getDMLeftAt(senderAddress);
        if (leftAt) {
            const messageTs = data.timestamp || 0;
            if (messageTs <= leftAt) {
                // Old message from before we left — ignore
                return;
            }
            // New message after we left — conversation resurfaces
            await secureStorage.clearDMLeftAt(senderAddress);
            Logger.info('DM: Conversation resurfaced from', senderAddress, '(new message after leave)');
        }

        // Clean sender-side flags
        delete data.pending;
        delete data._dmSent;

        // Find or create conversation for this sender
        let channelStreamId = this.conversations.get(senderAddress);
        let channel;

        if (channelStreamId) {
            channel = channelManager.channels.get(channelStreamId);
        }

        if (!channel) {
            // Auto-create conversation for new sender
            Logger.info('DM: New conversation from', senderAddress);
            try {
                channel = await this.getOrCreateConversation(senderAddress);
            } catch (e) {
                Logger.error('DM: Failed to create conversation for', senderAddress, e);
                return;
            }
            if (!channel) {
                Logger.error('DM: Failed to create conversation for', senderAddress);
                return;
            }
        }

        if (typeof mediaController?.isStoredImageChunkMessage === 'function' && mediaController.isStoredImageChunkMessage(data)) {
            if (typeof mediaController.registerStoredImageChunk === 'function') {
                await mediaController.registerStoredImageChunk(channel.messageStreamId, data);
            }
            return;
        }

        // Route reactions through handleControlMessage (not as text messages)
        if (data.type === 'reaction') {
            data.senderId = senderAddress;
            channelManager.handleControlMessage(channel.messageStreamId, data);
            return;
        }

        // Route edit/delete overrides
        if (data.type === 'edit' || data.type === 'delete') {
            data.senderId = senderAddress;
            channelManager.handleOverrideMessage(channel.messageStreamId, data);
            return;
        }

        if (
            typeof mediaController?.isStoredChunkedImageManifest === 'function'
            && mediaController.isStoredChunkedImageManifest(data)
            && typeof mediaController.registerStoredImageManifest === 'function'
        ) {
            await mediaController.registerStoredImageManifest(channel.messageStreamId, data);
        }

        // Deduplicate: check if message already exists
        if (data.id && channel.messages.some(m => m.id === data.id)) {
            return;
        }

        // Tag message as received (not sent by us)
        data._dmReceived = true;

        // Add verification info for display (ENS + trust level)
        data.verified = {
            valid: true,
            trustLevel: await identityManager.getTrustLevel(senderAddress),
            ensName: await identityManager.resolveENS(senderAddress)
        };

        // Add to channel messages
        channel.messages.push(data);
        channel.messages.sort((a, b) => a.timestamp - b.timestamp);

        // Notify UI
        channelManager.notifyHandlers('message', {
            streamId: channel.messageStreamId,
            message: data
        });

        this.notifyHandlers('dm_message', {
            peerAddress: senderAddress,
            streamId: channel.messageStreamId,
            message: data
        });
    }

    /**
     * Route an incoming notification from DM-1 partition 3.
     * Decrypts the E2E envelope and delegates to NotificationManager.
     * @param {Object} data - Encrypted notification with senderId from Streamr publisherId
     */
    async routeNotification(data) {
        if (!data || !data.senderId) {
            Logger.warn('DM: Notification without senderId, ignoring');
            return;
        }

        const senderAddress = data.senderId.toLowerCase();
        const myAddress = authManager.getAddress()?.toLowerCase();
        if (senderAddress === myAddress) return;
        if (secureStorage.isBlocked(senderAddress)) return;

        // E2E decrypt (same flow as DM messages)
        try {
            data = await this.decryptDMEnvelope(data, senderAddress);
        } catch {
            return; // Decryption failed — already logged inside decryptDMEnvelope
        }
        if (!data) return;

        // Delegate to NotificationManager (lazy import to avoid circular dep)
        const { notificationManager } = await import('./notifications.js');
        notificationManager.handleNotification(data);
    }

    /**
     * Get existing or create a new DM conversation with a peer
     * @param {string} peerAddress - Peer's Ethereum address
     * @param {string} [localName] - Optional local name for the conversation
     * @returns {Object} - Channel object
     */
    async getOrCreateConversation(peerAddress, localName) {
        const normalizedPeer = peerAddress.toLowerCase();

        // Check if conversation already exists
        const existingStreamId = this.conversations.get(normalizedPeer);
        if (existingStreamId) {
            const existing = channelManager.channels.get(existingStreamId);
            if (existing) return existing;
            // Stale entry — channel was removed from channelManager; clean up and recreate
            this.conversations.delete(normalizedPeer);
        }

        // Guard against concurrent creation for the same peer:
        // If another call is already creating this conversation, wait for it
        const pending = this.pendingConversations.get(normalizedPeer);
        if (pending) {
            return pending;
        }

        // Create the promise and store it SYNCHRONOUSLY before any await
        const creationPromise = this._createConversation(normalizedPeer, localName);
        this.pendingConversations.set(normalizedPeer, creationPromise);

        try {
            return await creationPromise;
        } finally {
            this.pendingConversations.delete(normalizedPeer);
        }
    }

    /**
     * Internal: actually create a DM conversation (called only once per peer)
     * @param {string} normalizedPeer - Lowercase peer address
     * @param {string} [localName] - Optional local name
     * @returns {Promise<Object>} - Channel object
     */
    async _createConversation(normalizedPeer, localName) {
        // Build deterministic stream IDs for the PEER's inbox (where we publish TO)
        const peerInboxId = streamrController.getDMInboxId(normalizedPeer);
        const peerEphemeralId = streamrController.getDMEphemeralId(normalizedPeer);

        // Resolve a display name
        const displayName = localName || await this.resolveDisplayName(normalizedPeer);

        // Create channel object
        const channel = {
            messageStreamId: peerInboxId,
            ephemeralStreamId: peerEphemeralId,
            streamId: peerInboxId,
            inboxStreamId: this.inboxMessageStreamId,
            name: displayName,
            type: 'dm',
            peerAddress: normalizedPeer,
            classification: 'personal',
            createdAt: Date.now(),
            createdBy: authManager.getAddress(),
            password: null,
            members: [],
            readOnly: false,
            writeOnly: false,  // We can read from our own inbox
            storageEnabled: false,
            exposure: 'hidden',
            description: '',
            language: '',
            category: '',
            messages: [],
            reactions: {},
            historyLoaded: false,
            hasMoreHistory: true,
            loadingHistory: false,
            oldestTimestamp: null,
        };

        // Register in channelManager and conversations map
        channelManager.channels.set(peerInboxId, channel);
        this.conversations.set(normalizedPeer, peerInboxId);

        // Persist channels
        await channelManager.saveChannels();

        // NOTE: Sent messages and reactions are loaded via loadDMTimeline() when channel is opened
        // This avoids duplicating merge logic here

        // Notify UI about new conversation
        channelManager.notifyHandlers('channelJoined', {
            channel,
            streamId: peerInboxId
        });

        this.notifyHandlers('dm_conversation_created', {
            peerAddress: normalizedPeer,
            streamId: peerInboxId,
            name: displayName
        });

        Logger.info('DM: Conversation created for', normalizedPeer, displayName);
        return channel;
    }

    /**
     * Start a new DM by user action (e.g. "New DM" button)
     * @param {string} peerAddress - Peer's Ethereum address (or ENS name to resolve)
     * @param {string} [localName] - Local name for the conversation
     * @returns {Object} - Channel object
     */
    async startDM(peerAddress, localName) {
        let resolvedAddress = peerAddress;

        // If it looks like an ENS name, resolve it
        if (peerAddress.includes('.') && !peerAddress.startsWith('0x')) {
            const resolved = await identityManager.resolveAddress(peerAddress);
            if (!resolved) {
                throw new Error(`Could not resolve ENS name: ${peerAddress}`);
            }
            resolvedAddress = resolved;
            // Use the ENS name as display name if no local name provided
            if (!localName) localName = peerAddress;
        }

        // Validate Ethereum address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(resolvedAddress)) {
            throw new Error('Invalid Ethereum address');
        }

        // Don't allow DM to yourself
        const myAddress = authManager.getAddress()?.toLowerCase();
        if (resolvedAddress.toLowerCase() === myAddress) {
            throw new Error('Cannot send a DM to yourself');
        }

        // Check if the peer has a DM inbox before creating the conversation
        // Skip check if we already have a conversation with this peer (they had an inbox before)
        const normalizedPeer = resolvedAddress.toLowerCase();
        if (!this.conversations.has(normalizedPeer)) {
            const peerInboxId = streamrController.getDMInboxId(normalizedPeer);
            try {
                await streamrController.client.getStream(peerInboxId);
            } catch {
                throw new Error('This user has not enabled DMs yet. They need to open Pombo and create their inbox first.');
            }
        }

        const channel = await this.getOrCreateConversation(resolvedAddress, localName);

        // Switch to the DM channel
        channelManager.setCurrentChannel(channel.messageStreamId);
        channelManager.notifyHandlers('channelSwitched', {
            streamId: channel.messageStreamId,
            channel
        });

        return channel;
    }

    /**
     * Send a DM message to a peer.
     * Publishes to the PEER's inbox, persists locally.
     * @param {string} peerInboxStreamId - The peer's inbox message stream ID
     * @param {string} text - Message text
     * @param {string} [replyTo] - Reply-to message ID
     * @returns {Object} - The sent message
     */
    async sendMessage(peerInboxStreamId, text, replyTo = null) {
        const channel = channelManager.channels.get(peerInboxStreamId);
        if (!channel || channel.type !== 'dm') {
            throw new Error('DM channel not found');
        }

        // Create signed message
        const message = await identityManager.createSignedMessage(text, peerInboxStreamId, replyTo);

        // Add verification info for local display
        message.verified = {
            valid: true,
            trustLevel: await identityManager.getTrustLevel(message.sender),
            ensName: await identityManager.resolveENS(message.sender)
        };

        // Mark as pending
        message.pending = true;
        message._dmSent = true;

        // Add to local messages immediately
        channel.messages.push(message);

        // Notify UI
        channelManager.notifyHandlers('message', {
            streamId: peerInboxStreamId,
            message
        });

        try {
            // E2E encrypt before publishing — NEVER send plaintext DMs
            const privateKey = authManager.wallet?.privateKey;
            const peerAddress = channel.peerAddress;

            if (!privateKey) {
                throw new Error('Cannot send DM: wallet private key not available (required for E2E encryption)');
            }
            if (!peerAddress) {
                throw new Error('Cannot send DM: peer address not found');
            }

            const peerPubKey = await this.getPeerPublicKey(peerAddress);
            if (!peerPubKey) {
                throw new Error('Cannot send DM: peer public key not available. The recipient may need to open Pombo first to create their inbox.');
            }

            const aesKey = await dmCrypto.getSharedKey(privateKey, peerAddress, peerPubKey);
            const { pending, _dmSent, verified, ...cleanMessage } = message;
            const payload = await dmCrypto.encrypt(cleanMessage, aesKey);

            // Set Pombo key for publishing (peer can decrypt if they have the key)
            await streamrController.setDMPublishKey(peerInboxStreamId);

            // Publish encrypted payload to peer's inbox (message stream, partition 0, no password)
            await streamrController.publishMessage(peerInboxStreamId, payload, null);

            // Mark as sent
            message.pending = false;

            // Persist locally (we can't read from peer's inbox, so save our sent copy)
            await secureStorage.addSentMessage(peerInboxStreamId, message);

            // Notify confirmed
            channelManager.notifyHandlers('message_confirmed', {
                streamId: peerInboxStreamId,
                messageId: message.id
            });

            Logger.debug('DM: Message sent to', peerInboxStreamId);

            // Send wake signal so the peer gets a push notification
            channelManager.sendWakeSignals(peerInboxStreamId).catch(err => {
                Logger.debug('DM: Wake signal failed (non-critical):', err.message);
            });
        } catch (error) {
            Logger.error('DM: Failed to send message:', error.message);
            channelManager.notifyHandlers('message_failed', {
                streamId: peerInboxStreamId,
                messageId: message.id,
                error: error.message
            });
            throw error;
        }

        return message;
    }

    /**
     * Send an edit override for a DM message
     * @param {string} peerInboxStreamId - Peer's inbox stream ID
     * @param {string} targetId - ID of the message to edit
     * @param {string} newText - New text content
     */
    async sendEdit(peerInboxStreamId, targetId, newText) {
        const channel = channelManager.channels.get(peerInboxStreamId);
        if (!channel || channel.type !== 'dm') throw new Error('DM channel not found');

        const original = channel.messages.find(m => m.id === targetId);
        if (!original) throw new Error('Message not found');

        const myAddress = authManager.getAddress();
        if (original.sender?.toLowerCase() !== myAddress?.toLowerCase()) {
            throw new Error('Can only edit your own messages');
        }

        const override = { type: 'edit', targetId, text: newText.trim(), timestamp: Date.now() };

        // Apply locally first
        original.text = override.text;
        original._edited = true;
        original._editedAt = override.timestamp;

        // Update local persisted copy
        secureStorage.updateSentMessage(peerInboxStreamId, targetId, { text: override.text, _edited: true, _editedAt: override.timestamp });

        channelManager.notifyHandlers('message_edited', { streamId: peerInboxStreamId, targetId });

        // E2E encrypt and publish to peer's inbox
        const privateKey = authManager.wallet?.privateKey;
        const peerAddress = channel.peerAddress;
        if (!privateKey || !peerAddress) throw new Error('Cannot send DM edit: missing credentials');

        const peerPubKey = await this.getPeerPublicKey(peerAddress);
        if (!peerPubKey) throw new Error('Cannot send DM edit: peer public key not available');

        const aesKey = await dmCrypto.getSharedKey(privateKey, peerAddress, peerPubKey);
        const payload = await dmCrypto.encrypt(override, aesKey);
        await streamrController.setDMPublishKey(peerInboxStreamId);
        await streamrController.publishMessage(peerInboxStreamId, payload, null);

        Logger.debug('DM: Edit sent for message:', targetId);
    }

    /**
     * Send a delete override for a DM message
     * @param {string} peerInboxStreamId - Peer's inbox stream ID
     * @param {string} targetId - ID of the message to delete
     */
    async sendDelete(peerInboxStreamId, targetId) {
        const channel = channelManager.channels.get(peerInboxStreamId);
        if (!channel || channel.type !== 'dm') throw new Error('DM channel not found');

        const original = channel.messages.find(m => m.id === targetId);
        if (!original) throw new Error('Message not found');

        const myAddress = authManager.getAddress();
        if (original.sender?.toLowerCase() !== myAddress?.toLowerCase()) {
            throw new Error('Can only delete your own messages');
        }

        const override = { type: 'delete', targetId, timestamp: Date.now() };

        // Apply locally — remove from messages array
        const idx = channel.messages.indexOf(original);
        if (idx >= 0) channel.messages.splice(idx, 1);

        // Remove from local persisted copy
        secureStorage.removeSentMessage(peerInboxStreamId, targetId);

        channelManager.notifyHandlers('message_deleted', { streamId: peerInboxStreamId, targetId });

        // E2E encrypt and publish to peer's inbox
        const privateKey = authManager.wallet?.privateKey;
        const peerAddress = channel.peerAddress;
        if (!privateKey || !peerAddress) throw new Error('Cannot send DM delete: missing credentials');

        const peerPubKey = await this.getPeerPublicKey(peerAddress);
        if (!peerPubKey) throw new Error('Cannot send DM delete: peer public key not available');

        const aesKey = await dmCrypto.getSharedKey(privateKey, peerAddress, peerPubKey);
        const payload = await dmCrypto.encrypt(override, aesKey);
        await streamrController.setDMPublishKey(peerInboxStreamId);
        await streamrController.publishMessage(peerInboxStreamId, payload, null);

        Logger.debug('DM: Delete sent for message:', targetId);
    }

    /**
     * Load the merged timeline for a DM conversation.
     * Merges locally-stored sent messages/reactions with received from inbox.
     * @param {string} peerAddress - Peer's address
     */
    async loadDMTimeline(peerAddress) {
        const normalizedPeer = peerAddress.toLowerCase();
        const channelStreamId = this.conversations.get(normalizedPeer);
        if (!channelStreamId) return;

        const channel = channelManager.channels.get(channelStreamId);
        if (!channel) return;

        // Sent messages (from local storage)
        const sent = secureStorage.getSentMessages(channelStreamId);

        // Received messages (already in channel.messages from inbox subscription)
        const received = channel.messages.filter(m => m._dmReceived);

        // Merge: combine sent + received, deduplicate by id, sort by timestamp
        // Prefer versions that have imageData (LogStore messages may have it when sentMessages lost it)
        const allMessages = [...sent, ...received];
        const unique = new Map();
        for (const msg of allMessages) {
            if (!msg.id) continue;
            const existing = unique.get(msg.id);
            if (!existing) {
                unique.set(msg.id, msg);
            } else if (msg.type === 'image' && msg.imageData && !existing.imageData) {
                unique.set(msg.id, msg);
            }
        }

        channel.messages = Array.from(unique.values())
            .sort((a, b) => a.timestamp - b.timestamp);

        // Resolve ENS for all unique senders in the timeline
        const senders = new Set(channel.messages.map(m => m.sender?.toLowerCase()).filter(Boolean));
        const ensCache = {};
        const trustCache = {};
        await Promise.all([...senders].map(async (addr) => {
            ensCache[addr] = await identityManager.resolveENS(addr);
            trustCache[addr] = await identityManager.getTrustLevel(addr);
        }));
        for (const msg of channel.messages) {
            if (!msg.verified) {
                const addr = msg.sender?.toLowerCase();
                msg.verified = {
                    valid: true,
                    trustLevel: trustCache[addr] ?? 0,
                    ensName: ensCache[addr] || null
                };
            } else if (!msg.verified.ensName) {
                const addr = msg.sender?.toLowerCase();
                msg.verified.ensName = ensCache[addr] || null;
                msg.verified.trustLevel = trustCache[addr] ?? msg.verified.trustLevel;
            }
        }

        // Merge locally-stored reactions (we don't receive our own from peer's inbox)
        const sentReactions = secureStorage.getSentReactions(channelStreamId);
        if (Object.keys(sentReactions).length > 0) {
            if (!channel.reactions) channel.reactions = {};
            for (const [messageId, emojis] of Object.entries(sentReactions)) {
                if (!channel.reactions[messageId]) channel.reactions[messageId] = {};
                for (const [emoji, users] of Object.entries(emojis)) {
                    if (!channel.reactions[messageId][emoji]) {
                        channel.reactions[messageId][emoji] = [];
                    }
                    // Merge users without duplicates
                    for (const user of users) {
                        const normalized = user.toLowerCase();
                        if (!channel.reactions[messageId][emoji].some(u => u.toLowerCase() === normalized)) {
                            channel.reactions[messageId][emoji].push(user);
                        }
                    }
                }
            }
        }
    }

    /**
     * Fetch older DM messages from the inbox stream for a specific peer.
     * Uses a time-windowed query to avoid scanning the entire stream from epoch.
     * Messages from all peers arrive on the same inbox; we filter for the target peer.
     * 
     * @param {string} peerAddress - Peer's address
     * @param {AbortSignal} [signal] - Optional abort signal
     * @returns {Promise<{loaded: number, hasMore: boolean, noResultsInWindow: boolean}>}
     */
    async fetchOlderDMMessages(peerAddress, signal) {
        const normalizedPeer = peerAddress.toLowerCase();
        const channelStreamId = this.conversations.get(normalizedPeer);
        if (!channelStreamId) return { loaded: 0, hasMore: false, noResultsInWindow: false };

        const channel = channelManager.channels.get(channelStreamId);
        if (!channel) return { loaded: 0, hasMore: false, noResultsInWindow: false };

        if (!this.inboxMessageStreamId) return { loaded: 0, hasMore: false, noResultsInWindow: false };

        // Determine the timestamp to search before
        const beforeTimestamp = channel.oldestTimestamp || Date.now();
        const windowMs = CONFIG.dm.searchWindowMs;

        try {
            Logger.info('DM: Fetching older messages for', normalizedPeer, 'before', new Date(beforeTimestamp).toISOString());

            // Fetch from OUR inbox (not the peer's) using a time window
            const result = await streamrController.fetchOlderHistoryWindowed(
                this.inboxMessageStreamId,
                0, // partition 0 = messages
                beforeTimestamp,
                windowMs,
                signal
            );

            if (signal?.aborted) return { loaded: 0, hasMore: channel.hasMoreHistory, noResultsInWindow: false };

            let addedCount = 0;
            const privateKey = authManager.wallet?.privateKey;

            for (const rawMsg of result.messages) {
                if (signal?.aborted) break;

                const publisherId = rawMsg.publisherId?.toLowerCase();
                if (!publisherId) continue;

                // Skip our own echoed messages
                const myAddress = authManager.getAddress()?.toLowerCase();
                if (publisherId === myAddress) continue;

                // Only keep messages from the target peer
                if (publisherId !== normalizedPeer) continue;

                // Decrypt E2E envelope
                let data;
                try {
                    let content = rawMsg.content;
                    if (content && typeof content === 'object') {
                        content.senderId = publisherId;
                    }
                    data = await this.decryptDMEnvelope(content, normalizedPeer);
                } catch {
                    continue; // Decryption failed
                }
                if (!data) continue;

                // Skip reactions (they're handled separately)
                if (data.type === 'reaction') {
                    if (data.messageId && data.emoji) {
                        channelManager.storeReaction(channel, data.messageId, data.emoji, publisherId, data.action || 'add');
                    }
                    continue;
                }

                // Skip non-content messages
                if (!data.id || !data.timestamp) continue;

                // Deduplicate
                if (channel.messages.some(m => m.id === data.id)) continue;

                // Tag as received and add verification
                data._dmReceived = true;
                data.verified = {
                    valid: true,
                    trustLevel: await identityManager.getTrustLevel(normalizedPeer),
                    ensName: await identityManager.resolveENS(normalizedPeer)
                };

                channel.messages.push(data);
                addedCount++;

                // Track oldest timestamp
                if (!channel.oldestTimestamp || data.timestamp < channel.oldestTimestamp) {
                    channel.oldestTimestamp = data.timestamp;
                }
            }

            if (addedCount > 0) {
                channel.messages.sort((a, b) => a.timestamp - b.timestamp);
            } else if (result.hasMore && typeof result.windowStart === 'number') {
                // Empty window but stream still has older data: advance the
                // pagination cursor past this window so the next call (e.g.
                // user clicks "Search older messages") scans the PREVIOUS
                // window instead of re-scanning the same empty one forever.
                channel.oldestTimestamp = result.windowStart;
            }

            // Update hasMore based on whether the stream has older data
            channel.hasMoreHistory = result.hasMore;

            const noResultsInWindow = addedCount === 0 && result.hasMore;

            Logger.info(`DM: Fetched ${addedCount} older messages for ${normalizedPeer} (noResultsInWindow: ${noResultsInWindow}, hasMore: ${result.hasMore})`);

            return { loaded: addedCount, hasMore: result.hasMore, noResultsInWindow };
        } catch (error) {
            Logger.error('DM: fetchOlderDMMessages failed:', error.message);
            return { loaded: 0, hasMore: channel.hasMoreHistory, noResultsInWindow: false };
        }
    }

    /**
     * Resolve a display name for a peer address.
     * Tries: trusted contact name → ENS → truncated address.
     * @param {string} address - Ethereum address
     * @returns {Promise<string>} - Display name
     */
    async resolveDisplayName(address) {
        const normalized = address.toLowerCase();

        // Check trusted contacts
        const contacts = secureStorage.getTrustedContacts() || {};
        if (contacts[normalized]?.name) {
            return contacts[normalized].name;
        }

        // Try ENS (async, non-blocking fallback)
        try {
            const ensName = await identityManager.resolveENS(normalized);
            if (ensName) return ensName;
        } catch (e) {
            // ENS lookup failed, use fallback
        }

        // Fallback: truncated address
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Get all DM conversations, sorted by last message timestamp
     * @returns {Array<Object>} - Array of channel objects
     */
    getConversations() {
        const dmChannels = [];
        const orphanedPeers = [];

        for (const [peerAddress, streamId] of this.conversations) {
            const channel = channelManager.channels.get(streamId);
            if (channel) {
                dmChannels.push(channel);
            } else {
                // Mark orphaned entry for cleanup
                orphanedPeers.push(peerAddress);
            }
        }

        // Clean up orphaned entries
        for (const peer of orphanedPeers) {
            this.conversations.delete(peer);
            Logger.debug('DM: Cleaned orphaned conversation entry for', peer);
        }

        // Sort by last message timestamp (newest first)
        dmChannels.sort((a, b) => {
            const aLast = a.messages.length > 0 ? a.messages[a.messages.length - 1].timestamp : a.createdAt;
            const bLast = b.messages.length > 0 ? b.messages[b.messages.length - 1].timestamp : b.createdAt;
            return bLast - aLast;
        });

        return dmChannels;
    }

    /**
     * Check if a channel is a DM conversation
     * @param {string} streamId - Message stream ID
     * @returns {boolean}
     */
    isDMChannel(streamId) {
        const channel = channelManager.channels.get(streamId);
        return channel?.type === 'dm';
    }

    /**
     * Register an event handler
     * @param {Function} handler - Handler function (event, data)
     */
    onEvent(handler) {
        this.handlers.push(handler);
    }

    /**
     * Notify all registered handlers
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    notifyHandlers(event, data) {
        for (const handler of this.handlers) {
            try {
                handler(event, data);
            } catch (error) {
                Logger.error('DM handler error:', error);
            }
        }
    }

    /**
     * Subscribe our inbox to push notifications.
     * Uses the existing relay system with the inbox streamId as tag source.
     * @param {boolean} force - If true, skip preference check (for explicit toggle)
     */
    async subscribeInboxPush(force = false) {
        if (!this.inboxMessageStreamId) return;
        if (!relayManager.enabled) return;

        // Check user preference unless forced
        if (!force) {
            const address = authManager.getAddress();
            if (address) {
                const storageKey = CONFIG.storageKeys.dmPush(address);
                const dmPushEnabled = localStorage.getItem(storageKey) === 'true';
                if (!dmPushEnabled) {
                    Logger.debug('DM: Push notifications preference disabled, skipping registration');
                    return;
                }
            }
        }

        await relayManager.subscribeToChannel(this.inboxMessageStreamId);
        Logger.info('DM: Push notifications registered for inbox');
    }

    /**
     * Fetch and cache the peer's ECDH public key from their inbox stream metadata.
     * @param {string} peerAddress - Peer's Ethereum address (lowercase)
     * @returns {Promise<string|null>} - Compressed public key hex, or null
     */
    async getPeerPublicKey(peerAddress) {
        const normalized = peerAddress.toLowerCase();

        // Check dmCrypto cache first
        if (dmCrypto.peerPublicKeys.has(normalized)) {
            return dmCrypto.peerPublicKeys.get(normalized);
        }

        // Fetch from stream metadata
        const pubKey = await streamrController.getDMPublicKey(normalized);
        if (pubKey) {
            dmCrypto.peerPublicKeys.set(normalized, pubKey);
        }
        return pubKey;
    }

    /**
     * Cleanup on disconnect
     */
    async destroy() {
        await this.unsubscribeFromInbox();
        this.conversations.clear();
        this.pendingConversations.clear();
        this.inboxMessageStreamId = null;
        this.inboxEphemeralStreamId = null;
        this.inboxSubscription = null;
        this.inboxEphemeralSubscription = null;
        this.inboxReady = false;
        this.handlers = [];
        dmCrypto.clear();
    }
}

// Singleton export (same pattern as other modules)
export const dmManager = new DMManager();
