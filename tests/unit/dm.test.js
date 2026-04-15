/**
 * DM Manager Tests
 * Tests for the DMManager class (dm.js)
 * Covers: init, destroy, routing, conversations, sentMessages integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock all dependencies before importing dm.js
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/config.js', () => ({
    CONFIG: {
        dm: {
            streamPrefix: 'Pombo-DM',
            maxConversations: 100,
            maxSentMessages: 200,
            inboxHistoryCount: 100
        },
        app: { name: 'Pombo', version: '1.0' }
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xmyaddress1234567890abcdef12345678'),
        isGuestMode: vi.fn().mockReturnValue(false),
        wallet: { privateKey: '0xfakeprivatekey1234567890abcdef' }
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        createSignedMessage: vi.fn().mockImplementation(async (text, channelId, replyTo) => ({
            id: `msg-${Date.now()}`,
            sender: '0xmyaddress1234567890abcdef12345678',
            text,
            channelId,
            replyTo: replyTo || null,
            timestamp: Date.now(),
            signature: '0xfakesig'
        })),
        getTrustLevel: vi.fn().mockResolvedValue('self'),
        resolveENS: vi.fn().mockResolvedValue(null),
        resolveAddress: vi.fn().mockResolvedValue(null)
    }
}));

vi.mock('../../src/js/relayManager.js', () => ({
    relayManager: {
        enabled: false,
        subscribeToChannel: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        getSentMessages: vi.fn().mockReturnValue([]),
        addSentMessage: vi.fn().mockResolvedValue(undefined),
        getTrustedContacts: vi.fn().mockReturnValue({}),
        getSentReactions: vi.fn().mockReturnValue({}),
        isBlocked: vi.fn().mockReturnValue(false),
        getDMLeftAt: vi.fn().mockReturnValue(null),
        clearDMLeftAt: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        getDMInboxId: vi.fn((addr) => `${addr.toLowerCase()}/Pombo-DM-1`),
        getDMEphemeralId: vi.fn((addr) => `${addr.toLowerCase()}/Pombo-DM-2`),
        createDMInbox: vi.fn().mockResolvedValue({
            messageStreamId: '0xmyaddress1234567890abcdef12345678/Pombo-DM-1',
            ephemeralStreamId: '0xmyaddress1234567890abcdef12345678/Pombo-DM-2'
        }),
        subscribeWithHistory: vi.fn().mockResolvedValue({ id: 'mock-sub' }),
        subscribeToPartition: vi.fn().mockResolvedValue({ id: 'mock-partition-sub' }),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publishMessage: vi.fn().mockResolvedValue(undefined),
        getDMPublicKey: vi.fn().mockResolvedValue('0x02peerpubkey'),
        setDMEncryptionKey: vi.fn().mockResolvedValue(undefined),
        setDMPublishKey: vi.fn().mockResolvedValue(undefined),
        addDMDecryptKey: vi.fn().mockResolvedValue(undefined),
        client: {
            getStream: vi.fn().mockRejectedValue(new Error('not found'))
        }
    },
    STREAM_CONFIG: {
        EPHEMERAL_STREAM: {
            CONTROL: 0,
            MEDIA_SIGNALS: 1,
            MEDIA_DATA: 2
        }
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getMyPublicKey: vi.fn().mockReturnValue('0x02abc123'),
        getSharedKey: vi.fn().mockResolvedValue('mock-aes-key'),
        encrypt: vi.fn().mockImplementation(async (msg) => ({ ct: 'enc', iv: 'iv', e: 'aes-256-gcm', _original: msg })),
        decrypt: vi.fn().mockImplementation(async (env) => env._original || { text: 'decrypted' }),
        encryptBinary: vi.fn().mockImplementation(async (data) => new Uint8Array([0xFF, ...data])),
        decryptBinary: vi.fn().mockImplementation(async (data) => data.slice(1)),
        isEncrypted: vi.fn().mockReturnValue(false),
        peerPublicKeys: new Map(),
        sharedKeys: new Map(),
        clear: vi.fn()
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        channels: new Map(),
        saveChannels: vi.fn().mockResolvedValue(undefined),
        setCurrentChannel: vi.fn(),
        notifyHandlers: vi.fn(),
        handleControlMessage: vi.fn(),
        sendWakeSignals: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { dmManager } from '../../src/js/dm.js';
import { authManager } from '../../src/js/auth.js';
import { streamrController } from '../../src/js/streamr.js';
import { channelManager } from '../../src/js/channels.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';
import { relayManager } from '../../src/js/relayManager.js';
import { mediaController } from '../../src/js/media.js';

describe('DMManager', () => {
    beforeEach(() => {
        // Reset DMManager state
        dmManager.inboxMessageStreamId = null;
        dmManager.inboxEphemeralStreamId = null;
        dmManager.inboxSubscription = null;
        dmManager.inboxEphemeralSubscription = null;
        dmManager.conversations.clear();
        dmManager.inboxReady = false;
        dmManager.handlers = [];

        // Reset mocked map
        channelManager.channels.clear();

        // Reset mocks
        vi.clearAllMocks();
    });

    // ==================== init() ====================
    describe('init()', () => {
        it('should skip init for guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);

            await dmManager.init();

            expect(dmManager.inboxMessageStreamId).toBeNull();
            authManager.isGuestMode.mockReturnValue(false);
        });

        it('should skip init when no address', async () => {
            authManager.getAddress.mockReturnValue(null);

            await dmManager.init();

            expect(dmManager.inboxMessageStreamId).toBeNull();
            authManager.getAddress.mockReturnValue('0xmyaddress1234567890abcdef12345678');
        });

        it('should set inbox stream IDs on init', async () => {
            // Inbox doesn't exist
            streamrController.client.getStream.mockRejectedValue(new Error('not found'));

            await dmManager.init();

            expect(dmManager.inboxMessageStreamId).toBe('0xmyaddress1234567890abcdef12345678/Pombo-DM-1');
            expect(dmManager.inboxEphemeralStreamId).toBe('0xmyaddress1234567890abcdef12345678/Pombo-DM-2');
        });

        it('should auto-subscribe when inbox exists', async () => {
            streamrController.client.getStream.mockResolvedValue({ id: 'mock-stream' });

            await dmManager.init();

            expect(dmManager.inboxReady).toBe(true);
            expect(streamrController.subscribeWithHistory).toHaveBeenCalled();
        });

        it('should rebuild conversations from existing DM channels', async () => {
            // Add a DM channel to the channelManager before init
            channelManager.channels.set('0xpeer/Pombo-DM-1', {
                type: 'dm',
                peerAddress: '0xpeer',
                messageStreamId: '0xpeer/Pombo-DM-1'
            });

            streamrController.client.getStream.mockRejectedValue(new Error('not found'));

            await dmManager.init();

            expect(dmManager.conversations.has('0xpeer')).toBe(true);
            expect(dmManager.conversations.get('0xpeer')).toBe('0xpeer/Pombo-DM-1');
        });
    });

    // ==================== destroy() ====================
    describe('destroy()', () => {
        it('should clear all state', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxEphemeralStreamId = 'test/Pombo-DM-2';
            dmManager.inboxSubscription = { id: 'sub' };
            dmManager.inboxEphemeralSubscription = { id: 'sub2' };
            dmManager.inboxReady = true;
            dmManager.conversations.set('0xpeer', 'stream-1');
            dmManager.handlers.push(() => {});

            await dmManager.destroy();

            expect(dmManager.inboxMessageStreamId).toBeNull();
            expect(dmManager.inboxEphemeralStreamId).toBeNull();
            expect(dmManager.inboxSubscription).toBeNull();
            expect(dmManager.inboxEphemeralSubscription).toBeNull();
            expect(dmManager.inboxReady).toBe(false);
            expect(dmManager.conversations.size).toBe(0);
            expect(dmManager.handlers).toHaveLength(0);
        });

        it('should call unsubscribe for message inbox', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxSubscription = { id: 'sub' };

            await dmManager.destroy();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('test/Pombo-DM-1');
        });

        it('should call unsubscribe for ephemeral inbox', async () => {
            dmManager.inboxEphemeralStreamId = 'test/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub2' };

            await dmManager.destroy();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('test/Pombo-DM-2');
        });

        it('should survive unsubscribe errors', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxSubscription = { id: 'sub' };
            streamrController.unsubscribe.mockRejectedValue(new Error('Already closed'));

            await dmManager.destroy();

            // Should not throw
            expect(dmManager.inboxSubscription).toBeNull();
        });

        it('should clear dmCrypto caches on destroy', async () => {
            await dmManager.destroy();
            expect(dmCrypto.clear).toHaveBeenCalled();
        });
    });

    // ==================== subscribeDMEphemeral / unsubscribeDMEphemeral ====================
    describe('subscribeDMEphemeral()', () => {
        it('should subscribe to DM-2 on demand', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';

            await dmManager.subscribeDMEphemeral();

            // P0: control partition via subscribeWithHistory
            expect(streamrController.subscribeWithHistory).toHaveBeenCalledWith(
                '0xmy/Pombo-DM-2', 0, expect.any(Function), 0, null
            );
            // P1: media signals, P2: media data via subscribeToPartition
            expect(streamrController.subscribeToPartition).toHaveBeenCalledWith(
                '0xmy/Pombo-DM-2', 1, expect.any(Function), null
            );
            expect(streamrController.subscribeToPartition).toHaveBeenCalledWith(
                '0xmy/Pombo-DM-2', 2, expect.any(Function), null
            );
            expect(dmManager.inboxEphemeralSubscription).toBeTruthy();
        });

        it('should skip if already subscribed', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'existing' };

            await dmManager.subscribeDMEphemeral();

            expect(streamrController.subscribeWithHistory).not.toHaveBeenCalled();
        });

        it('should skip if no ephemeral stream ID', async () => {
            dmManager.inboxEphemeralStreamId = null;

            await dmManager.subscribeDMEphemeral();

            expect(streamrController.subscribeWithHistory).not.toHaveBeenCalled();
        });

        it('should survive subscribe failure', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            streamrController.subscribeWithHistory.mockRejectedValueOnce(new Error('network error'));

            await dmManager.subscribeDMEphemeral();

            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });
    });

    describe('unsubscribeDMEphemeral()', () => {
        it('should unsubscribe from DM-2', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub' };

            await dmManager.unsubscribeDMEphemeral();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('0xmy/Pombo-DM-2');
            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });

        it('should skip if not subscribed', async () => {
            dmManager.inboxEphemeralSubscription = null;

            await dmManager.unsubscribeDMEphemeral();

            expect(streamrController.unsubscribe).not.toHaveBeenCalled();
        });

        it('should survive unsubscribe errors', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub' };
            streamrController.unsubscribe.mockRejectedValueOnce(new Error('fail'));

            await dmManager.unsubscribeDMEphemeral();

            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });
    });

    // ==================== routeInboxMessage() ====================
    describe('routeInboxMessage()', () => {
        it('should ignore messages without senderId', async () => {
            await dmManager.routeInboxMessage({});
            await dmManager.routeInboxMessage(null);

            expect(channelManager.notifyHandlers).not.toHaveBeenCalled();
        });

        it('should ignore messages from self', async () => {
            await dmManager.routeInboxMessage({
                senderId: '0xmyaddress1234567890abcdef12345678',
                id: 'msg-1',
                text: 'echo'
            });

            expect(channelManager.notifyHandlers).not.toHaveBeenCalled();
        });

        it('should route message to existing conversation', async () => {
            const peerAddress = '0xpeer111111111111111111111111111111111111';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            await dmManager.routeInboxMessage({
                senderId: peerAddress,
                id: 'msg-remote-1',
                text: 'Hello!',
                timestamp: Date.now()
            });

            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0].text).toBe('Hello!');
            expect(channel.messages[0]._dmReceived).toBe(true);
            expect(channelManager.notifyHandlers).toHaveBeenCalledWith('message', expect.any(Object));
        });

        it('should deduplicate messages with same id', async () => {
            const peerAddress = '0xpeer222222222222222222222222222222222222';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [{ id: 'dup-1', text: 'Already here', timestamp: 1 }]
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            await dmManager.routeInboxMessage({
                senderId: peerAddress,
                id: 'dup-1',
                text: 'Already here',
                timestamp: 1
            });

            // Should still be 1, not 2
            expect(channel.messages).toHaveLength(1);
        });

        it('should decrypt encrypted messages and strip sender flags', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            // Simulate encrypted envelope with sender flags baked in
            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockResolvedValueOnce({
                id: 'enc-msg-1',
                text: 'Secret!',
                timestamp: Date.now(),
                sender: peerAddress,
                pending: true,       // sender-side flag (should be stripped)
                _dmSent: true        // sender-side flag (should be stripped)
            });

            await dmManager.routeInboxMessage({
                senderId: peerAddress,
                ct: 'ciphertext',
                iv: 'iv',
                e: 'aes-256-gcm'
            });

            expect(dmCrypto.decrypt).toHaveBeenCalled();
            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0].text).toBe('Secret!');
            expect(channel.messages[0]._dmReceived).toBe(true);
            // Sender-side flags must be stripped
            expect(channel.messages[0]._dmSent).toBeUndefined();
            expect(channel.messages[0].pending).toBeUndefined();
            // senderId must be restored from envelope
            expect(channel.messages[0].senderId).toBe(peerAddress);
        });

        it('should silently drop messages that fail to decrypt', async () => {
            const peerAddress = '0xpeer444444444444444444444444444444444444';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockRejectedValueOnce(new Error('Bad ciphertext'));

            await dmManager.routeInboxMessage({
                senderId: peerAddress,
                ct: 'corrupt',
                iv: 'iv',
                e: 'aes-256-gcm'
            });

            expect(channel.messages).toHaveLength(0);
        });

        it('should route reactions to handleControlMessage instead of messages', async () => {
            const peerAddress = '0xpeer444444444444444444444444444444444444';
            const channel = {
                type: 'dm',
                peerAddress: peerAddress,
                messageStreamId: `${peerAddress}/Pombo-DM-1`,
                messages: [],
                reactions: {}
            };
            channelManager.channels.set(`${peerAddress}/Pombo-DM-1`, channel);
            dmManager.conversations.set(peerAddress, `${peerAddress}/Pombo-DM-1`);

            await dmManager.routeInboxMessage({
                senderId: peerAddress,
                type: 'reaction',
                messageId: 'msg1',
                emoji: '👍',
                action: 'add',
                timestamp: Date.now()
            });

            // Should NOT be added as a message
            expect(channel.messages).toHaveLength(0);
            // Should be routed to handleControlMessage
            expect(channelManager.handleControlMessage).toHaveBeenCalledWith(
                `${peerAddress}/Pombo-DM-1`,
                expect.objectContaining({
                    type: 'reaction',
                    messageId: 'msg1',
                    emoji: '👍',
                    senderId: peerAddress
                })
            );
        });

        it('should ignore messages from blocked peers', async () => {
            const peerAddress = '0xblocked11111111111111111111111111111111';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            secureStorage.isBlocked.mockReturnValueOnce(true);

            await dmManager.routeInboxMessage({
                senderId: peerAddress,
                id: 'blocked-msg-1',
                text: 'You should not see this',
                timestamp: Date.now()
            });

            expect(channel.messages).toHaveLength(0);
            expect(channelManager.notifyHandlers).not.toHaveBeenCalled();
        });

        it('should ignore messages older than dmLeftAt timestamp', async () => {
            const peerAddress = '0xleft22222222222222222222222222222222222222';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            const leaveTs = 1000000;
            secureStorage.getDMLeftAt.mockReturnValueOnce(leaveTs);

            await dmManager.routeInboxMessage({
                senderId: peerAddress,
                id: 'old-msg',
                text: 'Old message',
                timestamp: leaveTs - 100 // older than leave
            });

            expect(channel.messages).toHaveLength(0);
            expect(secureStorage.clearDMLeftAt).not.toHaveBeenCalled();
        });

        it('should resurface conversation when message is newer than dmLeftAt', async () => {
            const peerAddress = '0xleft33333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            const leaveTs = 1000000;
            secureStorage.getDMLeftAt.mockReturnValueOnce(leaveTs);

            await dmManager.routeInboxMessage({
                senderId: peerAddress,
                id: 'new-msg',
                text: 'New message!',
                timestamp: leaveTs + 500 // newer than leave
            });

            expect(secureStorage.clearDMLeftAt).toHaveBeenCalledWith(peerAddress);
            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0].text).toBe('New message!');
        });
    });

    // ==================== routeInboxControl() ====================
    describe('routeInboxControl()', () => {
        it('should ignore messages without senderId', async () => {
            await dmManager.routeInboxControl({});
            await dmManager.routeInboxControl(null);

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from self', async () => {
            await dmManager.routeInboxControl({
                senderId: '0xmyaddress1234567890abcdef12345678',
                type: 'typing'
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from unknown senders', async () => {
            await dmManager.routeInboxControl({
                senderId: '0xunknown',
                type: 'typing'
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should ignore control messages from blocked peers', async () => {
            const peerAddress = '0xblocked55555555555555555555555555555555';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);

            secureStorage.isBlocked.mockReturnValueOnce(true);

            await dmManager.routeInboxControl({
                senderId: peerAddress,
                type: 'typing',
                isTyping: true
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should ignore control messages from soft-left peers', async () => {
            const peerAddress = '0xleft66666666666666666666666666666666666';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);

            secureStorage.getDMLeftAt.mockReturnValueOnce(1000);

            await dmManager.routeInboxControl({
                senderId: peerAddress,
                type: 'typing',
                isTyping: true
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should forward plaintext control message to channelManager', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);

            const data = { senderId: peerAddress, type: 'typing', isTyping: true };
            await dmManager.routeInboxControl(data);

            expect(channelManager.handleControlMessage).toHaveBeenCalledWith(streamId, data);
        });

        it('should decrypt encrypted typing and inject user field', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);

            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockResolvedValueOnce({ type: 'typing', timestamp: 12345 });

            await dmManager.routeInboxControl({
                senderId: peerAddress,
                ct: 'enc', iv: 'iv', e: 'aes-256-gcm'
            });

            expect(dmCrypto.decrypt).toHaveBeenCalled();
            expect(channelManager.handleControlMessage).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({
                    type: 'typing',
                    senderId: peerAddress,
                    user: peerAddress
                })
            );
        });

        it('should decrypt encrypted presence and inject userId/address', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);

            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockResolvedValueOnce({ type: 'presence', nickname: 'Bob', lastActive: 99999 });

            await dmManager.routeInboxControl({
                senderId: peerAddress,
                ct: 'enc', iv: 'iv', e: 'aes-256-gcm'
            });

            expect(channelManager.handleControlMessage).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({
                    type: 'presence',
                    senderId: peerAddress,
                    userId: peerAddress,
                    address: peerAddress,
                    nickname: 'Bob'
                })
            );
        });

        it('should silently drop ephemeral that fails to decrypt', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);

            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockRejectedValueOnce(new Error('Bad key'));

            await dmManager.routeInboxControl({
                senderId: peerAddress,
                ct: 'corrupt', iv: 'iv', e: 'aes-256-gcm'
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });
    });

    // ==================== subscribeToInbox() ====================
    describe('subscribeToInbox()', () => {
        it('should not subscribe if inbox not initialized', async () => {
            dmManager.inboxMessageStreamId = null;

            await dmManager.subscribeToInbox();

            expect(streamrController.subscribeWithHistory).not.toHaveBeenCalled();
        });

        it('should not double-subscribe', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxSubscription = { id: 'existing' };

            await dmManager.subscribeToInbox();

            expect(streamrController.subscribeWithHistory).not.toHaveBeenCalled();
        });

        it('should subscribe to message stream only (ephemeral is on-demand)', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxEphemeralStreamId = 'test/Pombo-DM-2';

            await dmManager.subscribeToInbox();

            expect(streamrController.subscribeWithHistory).toHaveBeenCalledTimes(1);
            expect(dmManager.inboxSubscription).toBeDefined();
            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });

        it('should not subscribe to ephemeral at inbox level (on-demand only)', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxEphemeralStreamId = 'test/Pombo-DM-2';

            await dmManager.subscribeToInbox();

            // Only DM-1 subscribe, DM-2 is on-demand
            expect(streamrController.subscribeWithHistory).toHaveBeenCalledTimes(1);
            expect(dmManager.inboxSubscription).toEqual({ id: 'mock-sub' });
            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });
    });

    // ==================== getOrCreateConversation() ====================
    describe('getOrCreateConversation()', () => {
        beforeEach(() => {
            dmManager.inboxMessageStreamId = '0xmyaddress1234567890abcdef12345678/Pombo-DM-1';
        });

        it('should return existing conversation', async () => {
            const peerAddress = '0xpeer444444444444444444444444444444444444';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = { messageStreamId: streamId, type: 'dm', peerAddress };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            const result = await dmManager.getOrCreateConversation(peerAddress);

            expect(result).toBe(channel);
            // Should NOT call saveChannels (not creating new)
            expect(channelManager.saveChannels).not.toHaveBeenCalled();
        });

        it('should create new conversation for unknown peer', async () => {
            const peerAddress = '0xNewPeer5555555555555555555555555555555555';

            const result = await dmManager.getOrCreateConversation(peerAddress);

            expect(result).toBeDefined();
            expect(result.type).toBe('dm');
            expect(result.peerAddress).toBe(peerAddress.toLowerCase());
            expect(result.messageStreamId).toBe(`${peerAddress.toLowerCase()}/Pombo-DM-1`);
            expect(channelManager.saveChannels).toHaveBeenCalled();
            expect(dmManager.conversations.has(peerAddress.toLowerCase())).toBe(true);
        });

        it('should clean up stale entry and recreate conversation', async () => {
            const peerAddress = '0xstale00000000000000000000000000000000000';
            const streamId = `${peerAddress.toLowerCase()}/Pombo-DM-1`;

            // Stale entry: conversations map has it, but channelManager lost the channel
            dmManager.conversations.set(peerAddress.toLowerCase(), streamId);
            // channelManager.channels does NOT have streamId

            const result = await dmManager.getOrCreateConversation(peerAddress);

            expect(result).toBeDefined();
            expect(result.type).toBe('dm');
            expect(channelManager.saveChannels).toHaveBeenCalled();
            // Should have recreated in channelManager
            expect(channelManager.channels.has(streamId)).toBe(true);
        });

        it('should NOT load sent messages on creation (deferred to loadDMTimeline)', async () => {
            const peerAddress = '0xpeer666666666666666666666666666666666666';
            secureStorage.getSentMessages.mockReturnValue([
                { id: 'sent-1', text: 'Hi', timestamp: 1 }
            ]);

            const result = await dmManager.getOrCreateConversation(peerAddress);

            // Messages are loaded via loadDMTimeline(), not here
            expect(result.messages).toHaveLength(0);
            secureStorage.getSentMessages.mockReturnValue([]);
        });
    });

    // ==================== sendMessage() ====================
    describe('sendMessage()', () => {
        it('should throw for non-DM channel', async () => {
            channelManager.channels.set('regular-stream', { type: 'open' });

            await expect(dmManager.sendMessage('regular-stream', 'Hello'))
                .rejects.toThrow('DM channel not found');
        });

        it('should publish message to peer inbox', async () => {
            const peerAddress = '0xpeer777777777777777777777777777777777777';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            await dmManager.sendMessage(streamId, 'Hello peer!');

            // Message is E2E encrypted before publish
            expect(dmCrypto.encrypt).toHaveBeenCalled();
            expect(streamrController.publishMessage).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({ ct: 'enc', iv: 'iv', e: 'aes-256-gcm' }),
                null
            );
        });

        it('should strip local-only flags from encrypted payload', async () => {
            const peerAddress = '0xpeerbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            await dmManager.sendMessage(streamId, 'Clean payload');

            // Verify encrypt was called with a clean message (no sender-only flags)
            const encryptedInput = dmCrypto.encrypt.mock.calls[0][0];
            expect(encryptedInput.text).toBe('Clean payload');
            expect(encryptedInput.pending).toBeUndefined();
            expect(encryptedInput._dmSent).toBeUndefined();
            expect(encryptedInput.verified).toBeUndefined();
        });

        it('should persist sent message to secureStorage', async () => {
            const peerAddress = '0xpeer888888888888888888888888888888888888';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            await dmManager.sendMessage(streamId, 'Saved locally');

            expect(secureStorage.addSentMessage).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({ text: 'Saved locally' })
            );
        });

        it('should add message to channel.messages immediately', async () => {
            const peerAddress = '0xpeer999999999999999999999999999999999999';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);

            await dmManager.sendMessage(streamId, 'Instant');

            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0]._dmSent).toBe(true);
        });

        it('should throw when peer public key not available (no plaintext fallback)', async () => {
            const peerAddress = '0xpeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            streamrController.getDMPublicKey.mockResolvedValueOnce(null);
            dmCrypto.peerPublicKeys.clear();

            await expect(dmManager.sendMessage(streamId, 'Should fail'))
                .rejects.toThrow('peer public key not available');

            // Must NOT have published anything
            expect(streamrController.publishMessage).not.toHaveBeenCalled();
        });

        it('should throw when wallet private key is missing', async () => {
            const peerAddress = '0xpeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            const original = authManager.wallet;
            authManager.wallet = null;

            await expect(dmManager.sendMessage(streamId, 'Should fail'))
                .rejects.toThrow('wallet private key not available');

            expect(streamrController.publishMessage).not.toHaveBeenCalled();
            authManager.wallet = original;
        });

        it('should notify message_failed on encryption error', async () => {
            const peerAddress = '0xpeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            streamrController.getDMPublicKey.mockResolvedValueOnce(null);
            dmCrypto.peerPublicKeys.clear();

            await expect(dmManager.sendMessage(streamId, 'Fail')).rejects.toThrow();

            expect(channelManager.notifyHandlers).toHaveBeenCalledWith(
                'message_failed',
                expect.objectContaining({ error: expect.stringContaining('peer public key') })
            );
        });

        it('should send wake signals after sending', async () => {
            const peerAddress = '0xpeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            await dmManager.sendMessage(streamId, 'Wake up!');

            expect(channelManager.sendWakeSignals).toHaveBeenCalledWith(streamId);
        });
    });

    // ==================== loadDMTimeline() ====================
    describe('loadDMTimeline()', () => {
        it('should merge sent and received messages', async () => {
            const peerAddress = '0xpeerbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [
                    { id: 'recv-1', text: 'From peer', timestamp: 2, _dmReceived: true },
                    { id: 'recv-2', text: 'From peer 2', timestamp: 4, _dmReceived: true }
                ]
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            secureStorage.getSentMessages.mockReturnValue([
                { id: 'sent-1', text: 'From me', timestamp: 1 },
                { id: 'sent-2', text: 'From me 2', timestamp: 3 }
            ]);

            await dmManager.loadDMTimeline(peerAddress);

            expect(channel.messages).toHaveLength(4);
            // Should be sorted by timestamp
            expect(channel.messages[0].id).toBe('sent-1');
            expect(channel.messages[1].id).toBe('recv-1');
            expect(channel.messages[2].id).toBe('sent-2');
            expect(channel.messages[3].id).toBe('recv-2');

            secureStorage.getSentMessages.mockReturnValue([]);
        });

        it('should deduplicate by id', async () => {
            const peerAddress = '0xpeercccccccccccccccccccccccccccccccccc';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [
                    { id: 'dup-1', text: 'Received copy', timestamp: 1, _dmReceived: true }
                ]
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            secureStorage.getSentMessages.mockReturnValue([
                { id: 'dup-1', text: 'Sent copy', timestamp: 1 }
            ]);

            await dmManager.loadDMTimeline(peerAddress);

            // Should only have 1 message (deduplicated)
            expect(channel.messages).toHaveLength(1);

            secureStorage.getSentMessages.mockReturnValue([]);
        });

        it('should do nothing for unknown conversation', async () => {
            await dmManager.loadDMTimeline('0xunknownpeer');
            // No crash
        });

        it('should merge sent reactions from local storage', async () => {
            const peerAddress = '0xpeerdddddddddddddddddddddddddddddddddd';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [{ id: 'msg-1', text: 'Hello', timestamp: 1, _dmReceived: true }],
                reactions: { 'msg-1': { '👍': ['0xotherpeer'] } }
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            // Mock: we sent a reaction locally
            secureStorage.getSentReactions.mockReturnValue({
                'msg-1': { '👍': ['0xmyaddress1234567890abcdef12345678'], '❤️': ['0xmyaddress1234567890abcdef12345678'] }
            });

            await dmManager.loadDMTimeline(peerAddress);

            // Should merge without duplicates
            expect(channel.reactions['msg-1']['👍']).toContain('0xotherpeer');
            expect(channel.reactions['msg-1']['👍']).toContain('0xmyaddress1234567890abcdef12345678');
            expect(channel.reactions['msg-1']['👍']).toHaveLength(2);
            expect(channel.reactions['msg-1']['❤️']).toContain('0xmyaddress1234567890abcdef12345678');

            secureStorage.getSentReactions.mockReturnValue({});
        });
    });

    // ==================== Event handlers ====================
    describe('onEvent / notifyHandlers', () => {
        it('should register and call event handlers', () => {
            const handler = vi.fn();
            dmManager.onEvent(handler);

            dmManager.notifyHandlers('test_event', { data: 'value' });

            expect(handler).toHaveBeenCalledWith('test_event', { data: 'value' });
        });

        it('should survive handler errors', () => {
            const badHandler = vi.fn().mockImplementation(() => { throw new Error('Handler error'); });
            const goodHandler = vi.fn();
            dmManager.onEvent(badHandler);
            dmManager.onEvent(goodHandler);

            dmManager.notifyHandlers('event', {});

            expect(goodHandler).toHaveBeenCalled();
        });
    });

    // ==================== isDMChannel() ====================
    describe('isDMChannel()', () => {
        it('should return true for DM channels', () => {
            channelManager.channels.set('dm-stream', { type: 'dm' });
            expect(dmManager.isDMChannel('dm-stream')).toBe(true);
        });

        it('should return false for non-DM channels', () => {
            channelManager.channels.set('open-stream', { type: 'open' });
            expect(dmManager.isDMChannel('open-stream')).toBe(false);
        });

        it('should return false for unknown channels', () => {
            expect(dmManager.isDMChannel('nonexistent')).toBeFalsy();
        });
    });

    // ==================== getConversations() ====================
    describe('getConversations()', () => {
        it('should return empty array when no conversations', () => {
            expect(dmManager.getConversations()).toEqual([]);
        });

        it('should return conversations sorted by last message (newest first)', () => {
            const channelA = { messageStreamId: 'a', messages: [{ timestamp: 100 }], createdAt: 50 };
            const channelB = { messageStreamId: 'b', messages: [{ timestamp: 300 }], createdAt: 60 };
            const channelC = { messageStreamId: 'c', messages: [], createdAt: 200 };

            channelManager.channels.set('a', channelA);
            channelManager.channels.set('b', channelB);
            channelManager.channels.set('c', channelC);

            dmManager.conversations.set('0xpeer-a', 'a');
            dmManager.conversations.set('0xpeer-b', 'b');
            dmManager.conversations.set('0xpeer-c', 'c');

            const result = dmManager.getConversations();

            expect(result).toHaveLength(3);
            // B (300) > C (200 createdAt) > A (100)
            expect(result[0]).toBe(channelB);
            expect(result[1]).toBe(channelC);
            expect(result[2]).toBe(channelA);
        });

        it('should clean up orphaned conversation entries', () => {
            // Setup: conversation map has entry, but channel doesn't exist in channelManager
            dmManager.conversations.set('0xorphanpeer', 'orphan-stream-id');
            // channelManager.channels does NOT have 'orphan-stream-id'

            const result = dmManager.getConversations();

            expect(result).toHaveLength(0);
            expect(dmManager.conversations.has('0xorphanpeer')).toBe(false);
        });
    });

    // ==================== startDM() ====================
    describe('startDM()', () => {
        beforeEach(() => {
            dmManager.inboxMessageStreamId = '0xmyaddress1234567890abcdef12345678/Pombo-DM-1';
        });

        it('should reject DM to self', async () => {
            authManager.getAddress.mockReturnValue('0x1234567890abcdef1234567890abcdef12345678');
            await expect(dmManager.startDM('0x1234567890abcdef1234567890abcdef12345678'))
                .rejects.toThrow('Cannot send a DM to yourself');
            authManager.getAddress.mockReturnValue('0xmyaddress1234567890abcdef12345678');
        });

        it('should reject invalid address', async () => {
            await expect(dmManager.startDM('not-an-address'))
                .rejects.toThrow('Invalid Ethereum address');
        });

        it('should create conversation and switch channel', async () => {
            const peerAddress = '0xdddddddddddddddddddddddddddddddddddddddd';

            const result = await dmManager.startDM(peerAddress);

            expect(result).toBeDefined();
            expect(result.type).toBe('dm');
            expect(channelManager.setCurrentChannel).toHaveBeenCalled();
            expect(channelManager.notifyHandlers).toHaveBeenCalledWith('channelSwitched', expect.any(Object));
        });
    });

    // ==================== hasInbox() ====================
    describe('hasInbox()', () => {
        it('should return false when inbox not initialized', async () => {
            dmManager.inboxMessageStreamId = null;
            expect(await dmManager.hasInbox()).toBe(false);
        });

        it('should return true when stream exists', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            streamrController.client.getStream.mockResolvedValue({ id: 'test/Pombo-DM-1' });

            expect(await dmManager.hasInbox()).toBe(true);
        });

        it('should return false when stream does not exist', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            streamrController.client.getStream.mockRejectedValue(new Error('not found'));

            expect(await dmManager.hasInbox()).toBe(false);
        });
    });

    // ==================== createInbox() ====================
    describe('createInbox()', () => {
        it('should create inbox and subscribe', async () => {
            const result = await dmManager.createInbox();

            expect(result.messageStreamId).toContain('Pombo-DM-1');
            expect(result.ephemeralStreamId).toContain('Pombo-DM-2');
            expect(dmManager.inboxReady).toBe(true);
            expect(streamrController.subscribeWithHistory).toHaveBeenCalled();
        });
    });

    // ==================== subscribeInboxPush() ====================
    describe('subscribeInboxPush()', () => {
        beforeEach(() => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            relayManager.enabled = true;
            relayManager.subscribeToChannel.mockClear();
            
            // Mock localStorage
            global.localStorage = {
                getItem: vi.fn(),
                setItem: vi.fn(),
                removeItem: vi.fn()
            };
        });

        afterEach(() => {
            relayManager.enabled = false;
        });

        it('should skip if no inbox stream ID', async () => {
            dmManager.inboxMessageStreamId = null;

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should skip if relay manager is not enabled', async () => {
            relayManager.enabled = false;

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should skip if user preference is disabled (no force)', async () => {
            global.localStorage.getItem.mockReturnValue('false');

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should skip if user preference is not set (no force)', async () => {
            global.localStorage.getItem.mockReturnValue(null);

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should subscribe if user preference is enabled', async () => {
            global.localStorage.getItem.mockReturnValue('true');

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).toHaveBeenCalledWith('test/Pombo-DM-1');
        });

        it('should subscribe when force=true ignoring preference', async () => {
            global.localStorage.getItem.mockReturnValue('false');

            await dmManager.subscribeInboxPush(true);

            expect(relayManager.subscribeToChannel).toHaveBeenCalledWith('test/Pombo-DM-1');
        });

        it('should use lowercase address for preference key', async () => {
            authManager.getAddress.mockReturnValue('0xMYADDRESS1234');
            global.localStorage.getItem.mockReturnValue('true');

            await dmManager.subscribeInboxPush();

            expect(global.localStorage.getItem).toHaveBeenCalledWith('pombo_dm_push_0xmyaddress1234');
        });
    });

    // ==================== routeInboxMedia() ====================
    describe('routeInboxMedia()', () => {
        const peerAddress = '0xpeeraddress1234567890abcdef12345678';
        const peerInboxId = `${peerAddress}/Pombo-DM-1`;

        beforeEach(() => {
            // Setup a conversation
            dmManager.conversations.set(peerAddress, peerInboxId);
            channelManager.channels.set(peerInboxId, {
                messageStreamId: peerInboxId,
                type: 'dm',
                peerAddress
            });
            streamrController.getDMPublicKey.mockResolvedValue('0x02peerpubkey');
        });

        it('should forward JSON signal to mediaController', async () => {
            const data = { type: 'image_request', imageId: 'img-1', senderId: peerAddress };
            await dmManager.routeInboxMedia(data);

            expect(mediaController.handleMediaMessage).toHaveBeenCalledWith(
                peerInboxId, data, undefined
            );
        });

        it('should forward binary data with ECDH decryption to mediaController', async () => {
            const binaryData = new Uint8Array([0x01, 10, 20, 30]);
            // decryptBinary mock strips first byte
            dmCrypto.decryptBinary.mockResolvedValue(new Uint8Array([10, 20, 30]));

            await dmManager.routeInboxMedia(binaryData, peerAddress);

            expect(dmCrypto.decryptBinary).toHaveBeenCalledWith(binaryData, 'mock-aes-key');
            expect(mediaController.handleMediaMessage).toHaveBeenCalledWith(
                peerInboxId, new Uint8Array([10, 20, 30]), peerAddress
            );
        });

        it('should decrypt encrypted JSON signal with ECDH key', async () => {
            const envelope = { ct: 'enc', iv: 'iv', e: 'aes-256-gcm', senderId: peerAddress };
            dmCrypto.isEncrypted.mockReturnValue(true);
            dmCrypto.decrypt.mockResolvedValue({ type: 'piece_request', fileId: 'f1' });

            await dmManager.routeInboxMedia(envelope);

            expect(dmCrypto.getSharedKey).toHaveBeenCalled();
            expect(dmCrypto.decrypt).toHaveBeenCalledWith(envelope, 'mock-aes-key');
            const calledData = mediaController.handleMediaMessage.mock.calls[0][1];
            expect(calledData.type).toBe('piece_request');
            expect(calledData.senderId).toBe(peerAddress);
        });

        it('should decrypt binary with ECDH decryptBinary', async () => {
            const encrypted = new Uint8Array([0xFF, 0x01, 10, 20]);
            dmCrypto.decryptBinary.mockResolvedValue(new Uint8Array([0x01, 10, 20]));

            await dmManager.routeInboxMedia(encrypted, peerAddress);

            expect(dmCrypto.decryptBinary).toHaveBeenCalledWith(encrypted, 'mock-aes-key');
            const calledData = mediaController.handleMediaMessage.mock.calls[0][1];
            expect(calledData).toEqual(new Uint8Array([0x01, 10, 20]));
        });

        it('should ignore messages from self', async () => {
            const data = { type: 'image_request', senderId: '0xmyaddress1234567890abcdef12345678' };
            await dmManager.routeInboxMedia(data);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages without senderId', async () => {
            await dmManager.routeInboxMedia({});

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from blocked senders', async () => {
            secureStorage.isBlocked.mockReturnValue(true);
            const data = { type: 'image_request', senderId: peerAddress };
            await dmManager.routeInboxMedia(data);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
            secureStorage.isBlocked.mockReturnValue(false);
        });

        it('should ignore messages from unknown senders', async () => {
            const data = { type: 'image_request', senderId: '0xunknownpeer' };
            await dmManager.routeInboxMedia(data);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });

        it('should silently skip decryption when peer public key unavailable', async () => {
            dmCrypto.peerPublicKeys.clear();
            streamrController.getDMPublicKey.mockResolvedValue(null);
            const data = { type: 'source_announce', senderId: peerAddress };
            await dmManager.routeInboxMedia(data);

            expect(dmCrypto.decrypt).not.toHaveBeenCalled();
            expect(mediaController.handleMediaMessage).toHaveBeenCalled();
        });

        it('should return early on decryption failure', async () => {
            const envelope = { ct: 'bad', iv: 'iv', e: 'aes-256-gcm', senderId: peerAddress };
            dmCrypto.isEncrypted.mockReturnValue(true);
            dmCrypto.decrypt.mockRejectedValue(new Error('Auth tag mismatch'));

            await dmManager.routeInboxMedia(envelope);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });
    });
});
