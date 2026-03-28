/**
 * SyncManager Module Tests
 * Tests for cross-device synchronization functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing syncManager
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
            maxSentMessages: 200
        }
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        getDMInboxId: vi.fn().mockReturnValue('0xabc/Pombo-DM-1'),
        publish: vi.fn().mockResolvedValue(undefined),
        fetchPartitionHistory: vi.fn().mockResolvedValue([]),
        setDMPublishKey: vi.fn().mockResolvedValue(undefined),
        addDMDecryptKey: vi.fn().mockResolvedValue(undefined)
    },
    STREAM_CONFIG: {
        MESSAGE_STREAM: {
            PARTITIONS: 1,
            DM_PARTITIONS: 3,
            MESSAGES: 0,
            SYNC: 1,
            SYNC_BLOBS: 2
        }
    }
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        hasInbox: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        exportForSync: vi.fn().mockReturnValue({
            sentMessages: {},
            sentReactions: {},
            channels: [],
            blockedPeers: [],
            dmLeftAt: {},
            trustedContacts: {},
            ensCache: {},
            username: null,
            graphApiKey: null
        }),
        exportForBackup: vi.fn().mockReturnValue({
            sentMessages: {},
            sentReactions: {},
            channels: [],
            blockedPeers: [],
            dmLeftAt: {},
            trustedContacts: {},
            ensCache: {},
            username: null,
            graphApiKey: null
        }),
        importFromSync: vi.fn().mockResolvedValue(false),
        getUnsyncedImages: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
        decryptBlob: vi.fn().mockResolvedValue('base64data'),
        markImageSynced: vi.fn().mockResolvedValue(undefined),
        saveImageToLedger: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        isGuestMode: vi.fn().mockReturnValue(false),
        getAddress: vi.fn().mockReturnValue('0xabc123'),
        wallet: null  // Will be set per test
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getMyPublicKey: vi.fn().mockReturnValue('0x02abcdef'),
        deriveSharedKey: vi.fn().mockResolvedValue({ type: 'secret' }),
        encrypt: vi.fn().mockResolvedValue({ ct: 'encrypted', iv: 'iv123', e: 'aes-256-gcm' }),
        decrypt: vi.fn().mockImplementation(async (env) => env._decrypted || { type: 'sync', v: 1, ts: Date.now(), data: {} }),
        isEncrypted: vi.fn().mockReturnValue(true)
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        loadChannels: vi.fn()
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        loadUsername: vi.fn()
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { syncManager } from '../../src/js/syncManager.js';
import { authManager } from '../../src/js/auth.js';
import { streamrController } from '../../src/js/streamr.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';
import { channelManager } from '../../src/js/channels.js';
import { identityManager } from '../../src/js/identity.js';
import { dmManager } from '../../src/js/dm.js';

describe('syncManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncManager.isSyncing = false;
        syncManager.lastSyncTs = null;
        syncManager.handlers = [];
        // Reset authManager state
        authManager.wallet = { privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' };
        authManager.isGuestMode.mockReturnValue(false);
        authManager.getAddress.mockReturnValue('0xabc123');
    });

    describe('constructor', () => {
        it('should initialize with default state', () => {
            expect(syncManager.isSyncing).toBe(false);
            expect(syncManager.lastSyncTs).toBe(null);
            expect(syncManager.handlers).toEqual([]);
        });
    });

    describe('on/off event handlers', () => {
        it('should register event handler', () => {
            const handler = vi.fn();
            syncManager.on('sync_pushed', handler);
            
            expect(syncManager.handlers).toHaveLength(1);
            expect(syncManager.handlers[0]).toEqual({ event: 'sync_pushed', handler });
        });

        it('should remove event handler', () => {
            const handler = vi.fn();
            syncManager.on('sync_pushed', handler);
            syncManager.off('sync_pushed', handler);
            
            expect(syncManager.handlers).toHaveLength(0);
        });

        it('should only remove matching handler', () => {
            const handler1 = vi.fn();
            const handler2 = vi.fn();
            syncManager.on('sync_pushed', handler1);
            syncManager.on('sync_pushed', handler2);
            syncManager.off('sync_pushed', handler1);
            
            expect(syncManager.handlers).toHaveLength(1);
            expect(syncManager.handlers[0].handler).toBe(handler2);
        });
    });

    describe('notifyHandlers', () => {
        it('should call matching handlers', () => {
            const handler = vi.fn();
            syncManager.on('sync_pushed', handler);
            
            syncManager.notifyHandlers('sync_pushed', { ts: 12345 });
            
            expect(handler).toHaveBeenCalledWith({ ts: 12345 });
        });

        it('should not call non-matching handlers', () => {
            const handler = vi.fn();
            syncManager.on('sync_pulled', handler);
            
            syncManager.notifyHandlers('sync_pushed', { ts: 12345 });
            
            expect(handler).not.toHaveBeenCalled();
        });

        it('should continue if handler throws', () => {
            const handler1 = vi.fn().mockImplementation(() => { throw new Error('test'); });
            const handler2 = vi.fn();
            syncManager.on('sync_pushed', handler1);
            syncManager.on('sync_pushed', handler2);
            
            syncManager.notifyHandlers('sync_pushed', { ts: 12345 });
            
            expect(handler2).toHaveBeenCalled();
        });
    });

    describe('getInboxStreamId', () => {
        it('should return inbox stream ID', () => {
            authManager.getAddress.mockReturnValue('0xabc123');
            streamrController.getDMInboxId.mockReturnValue('0xabc123/Pombo-DM-1');
            
            const result = syncManager.getInboxStreamId();
            
            expect(result).toBe('0xabc123/Pombo-DM-1');
        });

        it('should return null if no address', () => {
            authManager.getAddress.mockReturnValue(null);
            
            const result = syncManager.getInboxStreamId();
            
            expect(result).toBe(null);
        });
    });

    describe('pushSync', () => {
        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            
            await syncManager.pushSync();
            
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should skip if already syncing', async () => {
            syncManager.isSyncing = true;
            
            await syncManager.pushSync();
            
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should throw if no private key', async () => {
            authManager.wallet = null;
            
            await expect(syncManager.pushSync()).rejects.toThrow('No wallet private key');
        });

        it('should encrypt and publish sync payload', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            const mockState = { channels: [], sentMessages: {} };
            secureStorage.exportForSync.mockReturnValue(mockState);
            
            await syncManager.pushSync();
            
            expect(dmCrypto.encrypt).toHaveBeenCalled();
            expect(streamrController.publish).toHaveBeenCalledWith(
                expect.any(String),
                1, // SYNC partition
                expect.objectContaining({ ct: 'encrypted' })
            );
        });

        it('should update lastSyncTs after push', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            const before = Date.now();
            
            await syncManager.pushSync();
            
            expect(syncManager.lastSyncTs).toBeGreaterThanOrEqual(before);
        });

        it('should reset isSyncing even on error', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            streamrController.publish.mockRejectedValue(new Error('Network error'));
            
            await expect(syncManager.pushSync()).rejects.toThrow();
            
            expect(syncManager.isSyncing).toBe(false);
        });
    });

    describe('pullSync', () => {
        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            
            const result = await syncManager.pullSync();
            
            expect(result).toBe(null);
        });

        it('should skip if already syncing', async () => {
            syncManager.isSyncing = true;
            
            const result = await syncManager.pullSync();
            
            expect(result).toBe(null);
        });

        it('should return null if no messages', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            streamrController.fetchPartitionHistory.mockResolvedValue([]);
            
            const result = await syncManager.pullSync();
            
            expect(result).toBe(null);
        });

        it('should ignore messages from other senders', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xOTHER', timestamp: 1000 }
            ]);
            
            const result = await syncManager.pullSync();
            
            expect(result).toBe(null);
        });

        it('should decrypt and merge payloads', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            
            const syncPayload = { type: 'sync', v: 1, ts: 1000, data: { channels: ['ch1'] } };
            dmCrypto.decrypt.mockResolvedValue(syncPayload);
            
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);
            
            await syncManager.pullSync();
            
            expect(secureStorage.importFromSync).toHaveBeenCalled();
        });

        it('should reload channels if updated', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            
            const syncPayload = { type: 'sync', v: 1, ts: 1000, data: { channels: ['ch1'] } };
            dmCrypto.decrypt.mockResolvedValue(syncPayload);
            secureStorage.importFromSync.mockResolvedValue(true);
            
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);
            
            await syncManager.pullSync();
            
            expect(channelManager.loadChannels).toHaveBeenCalled();
        });

        it('should reload username after sync', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            
            const syncPayload = { type: 'sync', v: 1, ts: 1000, data: { username: 'SyncedName' } };
            dmCrypto.decrypt.mockResolvedValue(syncPayload);
            secureStorage.importFromSync.mockResolvedValue(false);
            
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);
            
            await syncManager.pullSync();
            
            expect(identityManager.loadUsername).toHaveBeenCalled();
        });
    });

    describe('mergeState', () => {
        it('should merge sent messages by ID', () => {
            const base = {
                sentMessages: {
                    'stream1': [{ id: 'msg1', timestamp: 1000 }]
                }
            };
            const incoming = {
                sentMessages: {
                    'stream1': [{ id: 'msg2', timestamp: 2000 }]
                }
            };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.sentMessages.stream1).toHaveLength(2);
        });

        it('should deduplicate messages with same ID', () => {
            const base = {
                sentMessages: {
                    'stream1': [{ id: 'msg1', timestamp: 1000 }]
                }
            };
            const incoming = {
                sentMessages: {
                    'stream1': [{ id: 'msg1', timestamp: 1000 }]
                }
            };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.sentMessages.stream1).toHaveLength(1);
        });

        it('should use latest channels from incoming (latest-wins)', () => {
            const base = {
                channels: [{ messageStreamId: 'ch1', name: 'Channel 1' }]
            };
            const incoming = {
                channels: [{ messageStreamId: 'ch2', name: 'Channel 2' }]
            };
            
            const result = syncManager.mergeState(base, incoming);
            
            // Incoming wins — only ch2, ch1 is gone
            expect(result.channels).toHaveLength(1);
            expect(result.channels[0].messageStreamId).toBe('ch2');
        });

        it('should prefer incoming username if set', () => {
            const base = { username: 'old' };
            const incoming = { username: 'new' };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.username).toBe('new');
        });

        it('should keep base username if incoming is empty', () => {
            const base = { username: 'old' };
            const incoming = { username: null };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.username).toBe('old');
        });

        it('should merge trustedContacts', () => {
            const base = { trustedContacts: { '0x1': { level: 1 } } };
            const incoming = { trustedContacts: { '0x2': { level: 2 } } };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.trustedContacts['0x1']).toBeDefined();
            expect(result.trustedContacts['0x2']).toBeDefined();
        });

        it('should merge sentReactions with remote-wins strategy', () => {
            const base = {
                sentReactions: {
                    'stream1': { 'msg1': { '👍': ['0x1'] }, 'msg2': { '❤️': ['0x1'] } }
                }
            };
            const incoming = {
                sentReactions: {
                    'stream1': { 'msg1': { '🔥': ['0x1'] } },
                    'stream2': { 'msg3': { '👍': ['0x2'] } }
                }
            };

            const result = syncManager.mergeState(base, incoming);

            // msg1: remote wins (🔥 replaces 👍)
            expect(result.sentReactions.stream1.msg1['🔥']).toEqual(['0x1']);
            expect(result.sentReactions.stream1.msg1['👍']).toBeUndefined();
            // msg2: local-only preserved
            expect(result.sentReactions.stream1.msg2['❤️']).toEqual(['0x1']);
            // stream2: from remote
            expect(result.sentReactions.stream2.msg3['👍']).toEqual(['0x2']);
        });

        it('should use latest blockedPeers from incoming', () => {
            const base = { blockedPeers: ['0xaaa'] };
            const incoming = { blockedPeers: ['0xaaa', '0xbbb'] };

            const result = syncManager.mergeState(base, incoming);

            expect(result.blockedPeers).toEqual(['0xaaa', '0xbbb']);
        });

        it('should keep base blockedPeers when incoming is undefined', () => {
            const base = { blockedPeers: ['0xaaa'] };
            const incoming = {};

            const result = syncManager.mergeState(base, incoming);

            expect(result.blockedPeers).toEqual(['0xaaa']);
        });

        it('should propagate unblock via latest-wins', () => {
            const base = { blockedPeers: ['0xaaa', '0xbbb'] };
            const incoming = { blockedPeers: ['0xbbb'] }; // 0xaaa unblocked remotely

            const result = syncManager.mergeState(base, incoming);

            expect(result.blockedPeers).toEqual(['0xbbb']);
        });

        it('should use latest dmLeftAt from incoming', () => {
            const base = { dmLeftAt: { '0xaaa': 100, '0xbbb': 300 } };
            const incoming = { dmLeftAt: { '0xaaa': 200, '0xccc': 400 } };

            const result = syncManager.mergeState(base, incoming);

            expect(result.dmLeftAt).toEqual({ '0xaaa': 200, '0xccc': 400 });
        });

        it('should keep base dmLeftAt when incoming is undefined', () => {
            const base = { dmLeftAt: { '0xaaa': 100 } };
            const incoming = {};

            const result = syncManager.mergeState(base, incoming);

            expect(result.dmLeftAt).toEqual({ '0xaaa': 100 });
        });

        it('should propagate clearDMLeftAt via latest-wins', () => {
            const base = { dmLeftAt: { '0xaaa': 100, '0xbbb': 200 } };
            const incoming = { dmLeftAt: {} }; // all cleared remotely

            const result = syncManager.mergeState(base, incoming);

            expect(result.dmLeftAt).toEqual({});
        });
    });

    describe('mergeSentMessages', () => {
        it('should add new streams from remote', () => {
            const local = { 'stream1': [{ id: 'msg1' }] };
            const remote = { 'stream2': [{ id: 'msg2' }] };
            
            const result = syncManager.mergeSentMessages(local, remote);
            
            expect(result.stream1).toBeDefined();
            expect(result.stream2).toBeDefined();
        });

        it('should sort merged messages by timestamp', () => {
            const local = { 'stream1': [{ id: 'msg1', timestamp: 2000 }] };
            const remote = { 'stream1': [{ id: 'msg2', timestamp: 1000 }] };
            
            const result = syncManager.mergeSentMessages(local, remote);
            
            expect(result.stream1[0].timestamp).toBe(1000);
            expect(result.stream1[1].timestamp).toBe(2000);
        });
    });

    describe('mergeSentReactions', () => {
        it('should merge reactions from different streams', () => {
            const local = { 'stream1': { 'msg1': { '👍': ['0x1'] } } };
            const remote = { 'stream2': { 'msg2': { '❤️': ['0x2'] } } };

            const result = syncManager.mergeSentReactions(local, remote);

            expect(result.stream1.msg1['👍']).toEqual(['0x1']);
            expect(result.stream2.msg2['❤️']).toEqual(['0x2']);
        });

        it('should prefer remote state when same messageId exists in both', () => {
            const local = { 'stream1': { 'msg1': { '👍': ['0x1'] } } };
            const remote = { 'stream1': { 'msg1': { '❤️': ['0x1'] } } };

            const result = syncManager.mergeSentReactions(local, remote);

            // Remote wins — only ❤️, no 👍
            expect(result.stream1.msg1['❤️']).toEqual(['0x1']);
            expect(result.stream1.msg1['👍']).toBeUndefined();
        });

        it('should handle reaction removal via remote (empty message entry)', () => {
            const local = { 'stream1': { 'msg1': { '👍': ['0x1'] } } };
            const remote = { 'stream1': { 'msg1': {} } };

            const result = syncManager.mergeSentReactions(local, remote);

            // Remote removed all reactions for msg1
            expect(result.stream1).toBeUndefined();
        });

        it('should preserve local-only entries not in remote', () => {
            const local = { 'stream1': { 'msg1': { '👍': ['0x1'] }, 'msg2': { '❤️': ['0x1'] } } };
            const remote = { 'stream1': { 'msg1': { '🔥': ['0x1'] } } };

            const result = syncManager.mergeSentReactions(local, remote);

            // msg1: remote wins
            expect(result.stream1.msg1['🔥']).toEqual(['0x1']);
            expect(result.stream1.msg1['👍']).toBeUndefined();
            // msg2: local preserved (not in remote)
            expect(result.stream1.msg2['❤️']).toEqual(['0x1']);
        });

        it('should handle empty inputs', () => {
            expect(syncManager.mergeSentReactions({}, {})).toEqual({});
            expect(syncManager.mergeSentReactions(
                { 'stream1': { 'msg1': { '👍': ['0x1'] } } },
                {}
            ).stream1.msg1['👍']).toEqual(['0x1']);
        });
    });

    describe('fullSync', () => {
        it('should call push then pull (push-first order)', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            const order = [];
            const pushSpy = vi.spyOn(syncManager, 'pushSync').mockImplementation(async () => { order.push('push'); });
            const pullSpy = vi.spyOn(syncManager, 'pullSync').mockImplementation(async () => { order.push('pull'); return null; });
            
            await syncManager.fullSync();
            
            expect(pushSpy).toHaveBeenCalled();
            expect(pullSpy).toHaveBeenCalled();
            expect(order).toEqual(['push', 'pull']);
            
            pushSpy.mockRestore();
            pullSpy.mockRestore();
        });
    });

    describe('getStatus', () => {
        it('should return current status', () => {
            syncManager.lastSyncTs = 12345;
            syncManager.isSyncing = true;
            
            const status = syncManager.getStatus();
            
            expect(status).toEqual({
                lastSyncTs: 12345,
                isSyncing: true
            });
        });
    });
});
