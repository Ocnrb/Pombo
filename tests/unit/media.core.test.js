/**
 * Tests for media.js core functionality
 * Focus: lifecycle, message dispatch, P2P transfer, caching, seeding persistence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        publishMessage: vi.fn().mockResolvedValue(undefined),
        publishMediaSignal: vi.fn().mockResolvedValue(undefined),
        publishMediaData: vi.fn().mockResolvedValue(undefined),
        ensureMediaSubscription: vi.fn().mockResolvedValue(undefined)
    },
    deriveEphemeralId: vi.fn((id) => `ephemeral-${id}`),
    STREAM_CONFIG: {
        EPHEMERAL_STREAM: {
            PARTITIONS: 3,
            CONTROL: 0,
            MEDIA_SIGNALS: 1,
            MEDIA_DATA: 2
        }
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xmyaddress'),
        wallet: { privateKey: '0xprivatekey' }
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        getChannel: vi.fn(),
        notifyHandlers: vi.fn()
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        createSignedMessage: vi.fn().mockResolvedValue({
            id: 'msg-123',
            sender: '0xmyaddress',
            timestamp: Date.now()
        }),
        getTrustLevel: vi.fn().mockResolvedValue('verified')
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        addSentMessage: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        getPeerPublicKey: vi.fn().mockResolvedValue('peerPubKey123')
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getSharedKey: vi.fn().mockResolvedValue('sharedAesKey'),
        encrypt: vi.fn().mockResolvedValue({ encrypted: true })
    }
}));

// Import after mocks
import { mediaController, MEDIA_CONFIG } from '../../src/js/media.js';
import { streamrController, deriveEphemeralId } from '../../src/js/streamr.js';
import { authManager } from '../../src/js/auth.js';
import { channelManager } from '../../src/js/channels.js';
import { identityManager } from '../../src/js/identity.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { dmManager } from '../../src/js/dm.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';

describe('media.js core', () => {
    let originalMaxCacheBytes;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
        // Save and reset MAX_IMAGE_CACHE_BYTES (tests may modify it)
        originalMaxCacheBytes = mediaController.MAX_IMAGE_CACHE_BYTES;
        // Reset state
        mediaController.imageCache.clear();
        mediaController.imageCacheBytes = 0;
        mediaController.localFiles.clear();
        mediaController.downloadedUrls.clear();
        mediaController.incomingFiles.clear();
        mediaController.fileSeeders.clear();
        mediaController.pieceSendQueue = [];
        mediaController.isSendingPieces = false;
        mediaController.lastPieceSentTime = 0;
        mediaController.currentOwnerAddress = null;
        mediaController.persistedStorageSize = 0;
        mediaController.handlers = {};
        mediaController.db = null;
        mediaController._pendingImageRequests = new Map();
    });

    afterEach(() => {
        mediaController.MAX_IMAGE_CACHE_BYTES = originalMaxCacheBytes;
    });

    // ==================== LIFECYCLE ====================
    describe('Lifecycle', () => {
        describe('constructor', () => {
            it('initializes imageCache as empty Map', () => {
                expect(mediaController.imageCache).toBeInstanceOf(Map);
            });

            it('initializes localFiles as empty Map', () => {
                expect(mediaController.localFiles).toBeInstanceOf(Map);
            });

            it('initializes incomingFiles as empty Map', () => {
                expect(mediaController.incomingFiles).toBeInstanceOf(Map);
            });

            it('initializes fileSeeders as empty Map', () => {
                expect(mediaController.fileSeeders).toBeInstanceOf(Map);
            });

            it('initializes handlers object', () => {
                expect(mediaController.handlers).toBeDefined();
            });

            it('initializes persistedStorageSize to 0', () => {
                expect(mediaController.persistedStorageSize).toBe(0);
            });
        });

        describe('setOwner', () => {
            it('sets currentOwnerAddress lowercase', async () => {
                mediaController.db = null; // no DB = loadPersistedSeedFiles is a no-op
                await mediaController.setOwner('0xABCDEF');
                expect(mediaController.currentOwnerAddress).toBe('0xabcdef');
            });

            it('handles null address', async () => {
                await mediaController.setOwner(null);
                expect(mediaController.currentOwnerAddress).toBeNull();
            });

            it('handles undefined address', async () => {
                await mediaController.setOwner(undefined);
                expect(mediaController.currentOwnerAddress).toBeNull();
            });
        });

        describe('reset', () => {
            it('clears imageCache', () => {
                mediaController.imageCache.set('img1', 'data');
                mediaController.reset();
                expect(mediaController.imageCache.size).toBe(0);
            });

            it('resets imageCacheBytes', () => {
                mediaController.imageCacheBytes = 5000;
                mediaController.reset();
                expect(mediaController.imageCacheBytes).toBe(0);
            });

            it('clears localFiles', () => {
                mediaController.localFiles.set('f1', {});
                mediaController.reset();
                expect(mediaController.localFiles.size).toBe(0);
            });

            it('clears downloadedUrls', () => {
                mediaController.downloadedUrls.set('f1', 'blob:url');
                mediaController.reset();
                expect(mediaController.downloadedUrls.size).toBe(0);
            });

            it('clears incomingFiles', () => {
                mediaController.incomingFiles.set('f1', {});
                mediaController.reset();
                expect(mediaController.incomingFiles.size).toBe(0);
            });

            it('clears fileSeeders', () => {
                mediaController.fileSeeders.set('f1', new Set());
                mediaController.reset();
                expect(mediaController.fileSeeders.size).toBe(0);
            });

            it('resets piece send queue', () => {
                mediaController.pieceSendQueue = [{ some: 'item' }];
                mediaController.activeSends = 2;
                mediaController.reset();
                expect(mediaController.pieceSendQueue).toEqual([]);
                expect(mediaController.activeSends).toBe(0);
            });

            it('resets currentOwnerAddress', () => {
                mediaController.currentOwnerAddress = '0xabc';
                mediaController.reset();
                expect(mediaController.currentOwnerAddress).toBeNull();
            });

            it('resets persistedStorageSize', () => {
                mediaController.persistedStorageSize = 10000;
                mediaController.reset();
                expect(mediaController.persistedStorageSize).toBe(0);
            });

            it('clears download timers', () => {
                const clearSpy = vi.spyOn(global, 'clearTimeout');
                const timer = setTimeout(() => {}, 99999);
                mediaController.incomingFiles.set('f1', {
                    seederDiscoveryTimer: timer,
                    requestsInFlight: new Map([[0, { timeoutId: setTimeout(() => {}, 99999) }]])
                });
                mediaController.reset();
                expect(clearSpy).toHaveBeenCalled();
                clearSpy.mockRestore();
            });

            it('revokes blob URLs', () => {
                const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
                mediaController.downloadedUrls.set('f1', 'blob:http://test/abc');
                mediaController.downloadedUrls.set('f2', 'blob:http://test/def');
                mediaController.reset();
                expect(revokeSpy).toHaveBeenCalledTimes(2);
                revokeSpy.mockRestore();
            });
        });
    });

    // ==================== handleMediaMessage DISPATCH ====================
    describe('handleMediaMessage dispatch', () => {
        it('dispatches piece_request to handlePieceRequest', () => {
            const spy = vi.spyOn(mediaController, 'handlePieceRequest');
            mediaController.handleMediaMessage('stream-1', { type: 'piece_request', fileId: 'f1' });
            expect(spy).toHaveBeenCalledWith('stream-1', { type: 'piece_request', fileId: 'f1' });
            spy.mockRestore();
        });

        it('dispatches file_piece to handleFilePiece', () => {
            const spy = vi.spyOn(mediaController, 'handleFilePiece');
            mediaController.handleMediaMessage('stream-1', { type: 'file_piece', fileId: 'f1', pieceIndex: 0 });
            expect(spy).toHaveBeenCalledWith('stream-1', { type: 'file_piece', fileId: 'f1', pieceIndex: 0 });
            spy.mockRestore();
        });

        it('dispatches source_request to handleSourceRequest', () => {
            const spy = vi.spyOn(mediaController, 'handleSourceRequest');
            mediaController.handleMediaMessage('stream-1', { type: 'source_request', fileId: 'f1' });
            expect(spy).toHaveBeenCalledWith('stream-1', { type: 'source_request', fileId: 'f1' });
            spy.mockRestore();
        });

        it('dispatches source_announce to handleSourceAnnounce', () => {
            const spy = vi.spyOn(mediaController, 'handleSourceAnnounce');
            mediaController.handleMediaMessage('stream-1', { type: 'source_announce', fileId: 'f1' });
            expect(spy).toHaveBeenCalledWith({ type: 'source_announce', fileId: 'f1' });
            spy.mockRestore();
        });

        it('handles unknown type without error', () => {
            expect(() => mediaController.handleMediaMessage('stream-1', { type: 'unknown_type' })).not.toThrow();
        });
    });

    // ==================== IMAGE HANDLING ====================
    describe('Image Handling', () => {
        describe('handleImageData', () => {
            it('caches image data', () => {
                mediaController.handleImageData({ type: 'image_data', imageId: 'img1', data: 'base64data' });
                expect(mediaController.imageCache.get('img1')).toBe('base64data');
            });

            it('updates imageCacheBytes', () => {
                mediaController.handleImageData({ type: 'image_data', imageId: 'img1', data: 'abc' });
                expect(mediaController.imageCacheBytes).toBe(6); // 'abc'.length * 2
            });

            it('calls onImageReceived handler', () => {
                const handler = vi.fn();
                mediaController.handlers.onImageReceived = handler;
                mediaController.handleImageData({ type: 'image_data', imageId: 'img1', data: 'data' });
                expect(handler).toHaveBeenCalledWith('img1', 'data');
            });

            it('ignores wrong type', () => {
                mediaController.handleImageData({ type: 'not_image_data', imageId: 'img1', data: 'data' });
                expect(mediaController.imageCache.size).toBe(0);
            });

            it('ignores missing imageId', () => {
                mediaController.handleImageData({ type: 'image_data', data: 'data' });
                expect(mediaController.imageCache.size).toBe(0);
            });

            it('ignores missing data', () => {
                mediaController.handleImageData({ type: 'image_data', imageId: 'img1' });
                expect(mediaController.imageCache.size).toBe(0);
            });
        });

        describe('cacheImage', () => {
            it('caches image data', () => {
                mediaController.cacheImage('img1', 'base64data');
                expect(mediaController.imageCache.get('img1')).toBe('base64data');
            });

            it('updates byte count', () => {
                mediaController.cacheImage('img1', 'abc');
                expect(mediaController.imageCacheBytes).toBe(6);
            });

            it('does not overwrite existing cache entry', () => {
                mediaController.imageCache.set('img1', 'original');
                mediaController.cacheImage('img1', 'replacement');
                expect(mediaController.imageCache.get('img1')).toBe('original');
            });

            it('calls eviction if needed', () => {
                const spy = vi.spyOn(mediaController, 'evictImageCacheIfNeeded');
                mediaController.cacheImage('img1', 'data');
                expect(spy).toHaveBeenCalled();
                spy.mockRestore();
            });
        });

        describe('evictImageCacheIfNeeded', () => {
            it('does nothing if under limit', () => {
                mediaController.imageCacheBytes = 100;
                mediaController.imageCache.set('img1', 'data');
                mediaController.evictImageCacheIfNeeded();
                expect(mediaController.imageCache.size).toBe(1);
            });

            it('evicts entries when over byte limit', () => {
                mediaController.MAX_IMAGE_CACHE_BYTES = 10;
                mediaController.imageCache.set('img1', 'aaaa'); // 8 bytes
                mediaController.imageCache.set('img2', 'bbbb'); // 8 bytes
                mediaController.imageCache.set('img3', 'cccc'); // 8 bytes
                mediaController.imageCacheBytes = 24;
                mediaController.evictImageCacheIfNeeded();
                // Should evict oldest entries until under limit
                expect(mediaController.imageCacheBytes).toBeLessThanOrEqual(10);
            });

            it('evicts in insertion order (LRU)', () => {
                mediaController.MAX_IMAGE_CACHE_BYTES = 10;
                mediaController.imageCache.set('first', 'aaaa');
                mediaController.imageCache.set('second', 'bbbb');
                mediaController.imageCache.set('third', 'cccc');
                mediaController.imageCacheBytes = 24;
                mediaController.evictImageCacheIfNeeded();
                // 'first' should be evicted first, then 'second'
                expect(mediaController.imageCache.has('first')).toBe(false);
            });
        });
    });

    // ==================== handleFilePiece ====================
    describe('handleFilePiece', () => {
        const createTransfer = (pieceCount = 3) => ({
            metadata: {
                fileId: 'file-1',
                fileSize: pieceCount * 100,
                pieceCount,
                pieceHashes: []
            },
            streamId: 'stream-1',
            password: null,
            pieceStatus: new Array(pieceCount).fill('pending'),
            requestsInFlight: new Map(),
            receivedCount: 0,
            pieces: new Array(pieceCount).fill(null),
            useIndexedDB: false
        });

        it('skips own pieces (self-filtering)', async () => {
            authManager.getAddress.mockReturnValue('0xMyAddress');
            const transfer = createTransfer();
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                senderId: '0xMyAddress',
                data: 'base64data'
            });

            expect(transfer.receivedCount).toBe(0);
        });

        it('skips pieces for unknown transfers', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            // No transfer registered
            await expect(
                mediaController.handleFilePiece('stream-1', {
                    fileId: 'no-such-file',
                    pieceIndex: 0,
                    senderId: '0xother',
                    data: 'data'
                })
            ).resolves.not.toThrow();
        });

        it('skips already done pieces', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'done';
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                senderId: '0xother',
                data: 'data'
            });

            expect(transfer.receivedCount).toBe(0);
        });

        it('skips already-done pieces', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'done'; // already received
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                senderId: '0xother',
                data: 'data'
            });

            expect(transfer.receivedCount).toBe(0);
        });

        it('resets to pending on base64 decode failure', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'requested';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(null);
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                senderId: '0xother',
                data: 'baddata'
            });

            expect(transfer.pieceStatus[0]).toBe('pending');
        });

        it('resets to pending on hash mismatch', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'requested';
            transfer.metadata.pieceHashes[0] = 'expected_hash_abc';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('wrong_hash_xyz');
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                senderId: '0xother',
                data: 'encoded'
            });

            expect(transfer.pieceStatus[0]).toBe('pending');
        });

        it('stores piece and updates state on valid piece', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'requested';
            transfer.metadata.pieceHashes[0] = 'correct_hash';
            const timeoutId = setTimeout(() => {}, 99999);
            transfer.requestsInFlight.set(0, { seederId: '0xseeder', timeoutId });
            mediaController.incomingFiles.set('file-1', transfer);

            const buf = new ArrayBuffer(8);
            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(buf);
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('correct_hash');
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});
            const clearSpy = vi.spyOn(global, 'clearTimeout');

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                senderId: '0xother',
                data: 'encoded'
            });

            expect(transfer.pieceStatus[0]).toBe('done');
            expect(transfer.receivedCount).toBe(1);
            expect(transfer.pieces[0]).toBeInstanceOf(Uint8Array);
            expect(clearSpy).toHaveBeenCalledWith(timeoutId);
            clearSpy.mockRestore();
        });

        it('calls onFileProgress handler', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const handler = vi.fn();
            mediaController.handlers.onFileProgress = handler;

            const transfer = createTransfer(5);
            transfer.pieceStatus[2] = 'requested';
            transfer.metadata.pieceHashes[2] = 'hash';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('hash');
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 2,
                senderId: '0xother',
                data: 'data'
            });

            expect(handler).toHaveBeenCalledWith('file-1', 20, 1, 5, 500);
        });

        it('calls assembleFile when all pieces done', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer(2);
            transfer.pieceStatus[0] = 'done';
            transfer.pieces[0] = new Uint8Array(8);
            transfer.receivedCount = 1;
            transfer.pieceStatus[1] = 'requested';
            transfer.metadata.pieceHashes[1] = 'hash2';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('hash2');
            const assembleSpy = vi.spyOn(mediaController, 'assembleFile').mockResolvedValue(undefined);

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 1,
                senderId: '0xother',
                data: 'data'
            });

            expect(assembleSpy).toHaveBeenCalledWith('file-1');
            assembleSpy.mockRestore();
        });
    });

    // ==================== assembleFile ====================
    describe('assembleFile', () => {
        it('assembles pieces into blob and notifies completion', async () => {
            const piece0 = new Uint8Array([1, 2, 3]);
            const piece1 = new Uint8Array([4, 5, 6]);
            const transfer = {
                metadata: {
                    fileId: 'file-1',
                    fileName: 'test.mp4',
                    fileSize: 6,
                    fileType: 'video/mp4',
                    pieceCount: 2,
                    pieceHashes: ['h1', 'h2']
                },
                streamId: 'stream-1',
                password: null,
                isPrivateChannel: false,
                pieceStatus: ['done', 'done'],
                pieces: [piece0, piece1],
                receivedCount: 2,
                useIndexedDB: false,
                seederDiscoveryTimer: null
            };
            mediaController.incomingFiles.set('file-1', transfer);

            const onComplete = vi.fn();
            mediaController.handlers.onFileComplete = onComplete;

            vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            await mediaController.assembleFile('file-1');

            // Should have cached URL
            expect(mediaController.downloadedUrls.has('file-1')).toBe(true);
            // Should notify completion
            expect(onComplete).toHaveBeenCalledWith('file-1', transfer.metadata, expect.any(String), expect.any(Blob));
            // Should register as local file for seeding
            expect(mediaController.localFiles.has('file-1')).toBe(true);
            // Should clean up transfer
            expect(mediaController.incomingFiles.has('file-1')).toBe(false);
        });

        it('aborts if not all pieces are done', async () => {
            const transfer = {
                metadata: { fileId: 'file-1', pieceCount: 3, fileSize: 9 },
                pieceStatus: ['done', 'pending', 'done'],
                pieces: [new Uint8Array(3), null, new Uint8Array(3)],
                receivedCount: 2,
                useIndexedDB: false
            };
            mediaController.incomingFiles.set('file-1', transfer);
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.assembleFile('file-1');

            // Should still be downloading
            expect(mediaController.incomingFiles.has('file-1')).toBe(true);
            expect(manageSpy).toHaveBeenCalledWith('file-1');
            manageSpy.mockRestore();
        });

        it('does nothing if transfer not found', async () => {
            await expect(mediaController.assembleFile('nonexistent')).resolves.not.toThrow();
        });

        it('announces as seeder after assembly', async () => {
            const transfer = {
                metadata: { fileId: 'file-1', fileName: 'test.mp4', fileSize: 3, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h'] },
                streamId: 'stream-1',
                password: 'pwd',
                isPrivateChannel: true,
                pieceStatus: ['done'],
                pieces: [new Uint8Array([1, 2, 3])],
                receivedCount: 1,
                useIndexedDB: false,
                seederDiscoveryTimer: null
            };
            mediaController.incomingFiles.set('file-1', transfer);
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            await mediaController.assembleFile('file-1');

            expect(announceSpy).toHaveBeenCalledWith('stream-1', 'file-1', 'pwd');
            announceSpy.mockRestore();
        });

        it('clears seeder discovery timer on completion', async () => {
            const clearSpy = vi.spyOn(global, 'clearTimeout');
            const timer = setTimeout(() => {}, 99999);
            const transfer = {
                metadata: { fileId: 'file-1', fileName: 'test.mp4', fileSize: 3, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h'] },
                streamId: 'stream-1',
                password: null,
                isPrivateChannel: false,
                pieceStatus: ['done'],
                pieces: [new Uint8Array([1, 2, 3])],
                receivedCount: 1,
                useIndexedDB: false,
                seederDiscoveryTimer: timer
            };
            mediaController.incomingFiles.set('file-1', transfer);
            vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            await mediaController.assembleFile('file-1');

            expect(clearSpy).toHaveBeenCalledWith(timer);
            clearSpy.mockRestore();
        });
    });

    // ==================== handlePieceRequest ====================
    describe('handlePieceRequest', () => {
        it('sends piece when request is for us', async () => {
            authManager.getAddress.mockReturnValue('0xMyAddr');
            mediaController.localFiles.set('file-1', { file: new Blob(['test']), metadata: {} });
            const sendSpy = vi.spyOn(mediaController, 'sendPiece').mockResolvedValue(undefined);

            await mediaController.handlePieceRequest('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                targetSeederId: '0xmyaddr' // lowercase matches
            });

            expect(sendSpy).toHaveBeenCalledWith('stream-1', 'file-1', 0);
            sendSpy.mockRestore();
        });

        it('ignores request not targeted at us', async () => {
            authManager.getAddress.mockReturnValue('0xMyAddr');
            const sendSpy = vi.spyOn(mediaController, 'sendPiece').mockResolvedValue(undefined);

            await mediaController.handlePieceRequest('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                targetSeederId: '0xOtherPeer'
            });

            expect(sendSpy).not.toHaveBeenCalled();
            sendSpy.mockRestore();
        });

        it('ignores request for unknown file', async () => {
            authManager.getAddress.mockReturnValue('0xMyAddr');
            const sendSpy = vi.spyOn(mediaController, 'sendPiece').mockResolvedValue(undefined);

            await mediaController.handlePieceRequest('stream-1', {
                fileId: 'unknown',
                pieceIndex: 0,
                targetSeederId: '0xmyaddr'
            });

            expect(sendSpy).not.toHaveBeenCalled();
            sendSpy.mockRestore();
        });

        it('handles null address gracefully', async () => {
            authManager.getAddress.mockReturnValue(null);
            await expect(mediaController.handlePieceRequest('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                targetSeederId: '0xaddr'
            })).resolves.not.toThrow();
        });
    });

    // ==================== sendPiece / _sendPieceImmediate ====================
    describe('sendPiece / _sendPieceImmediate', () => {
        it('queues piece and processes', async () => {
            const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
            mediaController.localFiles.set('file-1', {
                file: blob,
                metadata: { pieceCount: 1 }
            });
            channelManager.getChannel.mockReturnValue({ password: null });

            await mediaController.sendPiece('stream-1', 'file-1', 0);

            expect(streamrController.publishMediaData).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                expect.any(Uint8Array),
                null
            );
        });

        it('_sendPieceImmediate skips if file not found', async () => {
            await mediaController._sendPieceImmediate('stream-1', 'nonexistent', 0);
            expect(streamrController.publishMediaData).not.toHaveBeenCalled();
        });

        it('sends with encryption password', async () => {
            const blob = new Blob([new Uint8Array([10, 20])]);
            mediaController.localFiles.set('file-1', {
                file: blob,
                metadata: { pieceCount: 1 }
            });
            channelManager.getChannel.mockReturnValue({ password: 'secret123' });

            await mediaController._sendPieceImmediate('stream-1', 'file-1', 0);

            expect(streamrController.publishMediaData).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                expect.any(Uint8Array),
                'secret123'
            );
        });
    });

    // ==================== requestFileSources ====================
    describe('requestFileSources', () => {
        it('publishes source_request to ephemeral stream', async () => {
            await mediaController.requestFileSources('stream-1', 'file-1');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'source_request', fileId: 'file-1', wantPush: true },
                null
            );
        });

        it('passes password for encrypted channels', async () => {
            await mediaController.requestFileSources('stream-1', 'file-1', 'pwd');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'source_request', fileId: 'file-1', wantPush: true },
                'pwd'
            );
        });
    });

    // ==================== handleSourceRequest ====================
    describe('handleSourceRequest', () => {
        it('announces as source if file is local', async () => {
            mediaController.localFiles.set('file-1', { file: new Blob() });
            channelManager.getChannel.mockReturnValue({ password: null });
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);

            await mediaController.handleSourceRequest('stream-1', { fileId: 'file-1' });

            expect(announceSpy).toHaveBeenCalledWith('stream-1', 'file-1', null);
            announceSpy.mockRestore();
        });

        it('announces with password for encrypted channel', async () => {
            mediaController.localFiles.set('file-1', { file: new Blob() });
            channelManager.getChannel.mockReturnValue({ password: 'secret' });
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);

            await mediaController.handleSourceRequest('stream-1', { fileId: 'file-1' });

            expect(announceSpy).toHaveBeenCalledWith('stream-1', 'file-1', 'secret');
            announceSpy.mockRestore();
        });

        it('does nothing if file not local', async () => {
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);

            await mediaController.handleSourceRequest('stream-1', { fileId: 'no-file' });

            expect(announceSpy).not.toHaveBeenCalled();
            announceSpy.mockRestore();
        });
    });

    // ==================== announceFileSource ====================
    describe('announceFileSource', () => {
        it('publishes source_announce to ephemeral stream', async () => {
            await mediaController.announceFileSource('stream-1', 'file-1');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'source_announce', fileId: 'file-1', pieceCount: 0, pushMode: true },
                null
            );
        });

        it('passes password for encryption', async () => {
            await mediaController.announceFileSource('stream-1', 'file-1', 'pwd');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'source_announce', fileId: 'file-1', pieceCount: 0, pushMode: true },
                'pwd'
            );
        });
    });

    // ==================== startDownload ====================
    describe('startDownload', () => {
        it('initializes transfer state', async () => {
            vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            const metadata = {
                fileId: 'file-dl-1',
                fileName: 'test.mp4',
                fileSize: 1024,
                fileType: 'video/mp4',
                pieceCount: 3,
                pieceHashes: ['h1', 'h2', 'h3']
            };

            await mediaController.startDownload('stream-1', metadata);

            const transfer = mediaController.incomingFiles.get('file-dl-1');
            expect(transfer).toBeDefined();
            expect(transfer.metadata).toBe(metadata);
            expect(transfer.pieceStatus).toEqual(['pending', 'pending', 'pending']);
            expect(transfer.receivedCount).toBe(0);
            expect(transfer.pieces).toHaveLength(3);
            expect(transfer.downloadStarted).toBe(false);
        });

        it('initializes fileSeeders set', async () => {
            vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            await mediaController.startDownload('stream-1', {
                fileId: 'file-dl-2', fileName: 'a', fileSize: 100, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h']
            });
            expect(mediaController.fileSeeders.get('file-dl-2')).toBeInstanceOf(Set);
        });

        it('skips if download already in progress', async () => {
            const spy = vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            mediaController.incomingFiles.set('file-dl-3', {});

            await mediaController.startDownload('stream-1', {
                fileId: 'file-dl-3', fileName: 'a', fileSize: 100, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h']
            });

            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it('calls startSeederDiscovery', async () => {
            const spy = vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            await mediaController.startDownload('stream-1', {
                fileId: 'file-dl-4', fileName: 'a', fileSize: 100, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h']
            });
            expect(spy).toHaveBeenCalledWith('file-dl-4');
            spy.mockRestore();
        });
    });

    // ==================== requestPiece ====================
    describe('requestPiece', () => {
        it('sets piece status to requested', async () => {
            const transfer = {
                metadata: { pieceCount: 3 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'pending', 'pending'],
                requestsInFlight: new Map()
            };
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.requestPiece('file-1', 1, '0xseeder');

            expect(transfer.pieceStatus[1]).toBe('requested');
        });

        it('tracks request in flight', async () => {
            const transfer = {
                metadata: { pieceCount: 3 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'pending', 'pending'],
                requestsInFlight: new Map()
            };
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.requestPiece('file-1', 0, '0xseeder');

            expect(transfer.requestsInFlight.has(0)).toBe(true);
            expect(transfer.requestsInFlight.get(0).seederId).toBe('0xseeder');
        });

        it('publishes piece_request to ephemeral stream', async () => {
            const transfer = {
                metadata: { pieceCount: 1 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending'],
                requestsInFlight: new Map()
            };
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.requestPiece('file-1', 0, '0xseeder');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'piece_request', fileId: 'file-1', pieceIndex: 0, targetSeederId: '0xseeder' },
                null
            );
        });

        it('does nothing if transfer not found', async () => {
            await mediaController.requestPiece('no-file', 0, '0xseeder');
            expect(streamrController.publishMediaSignal).not.toHaveBeenCalled();
        });
    });

    // ==================== manageDownload ====================
    describe('manageDownload', () => {
        it('requests pending pieces from available seeders', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 3 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'done', 'pending'],
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set(['0xseeder1']));
            const requestSpy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});

            mediaController.manageDownload('file-1');

            expect(requestSpy).toHaveBeenCalledTimes(2); // pieces 0 and 2
            requestSpy.mockRestore();
            vi.useRealTimers();
        });

        it('respects MAX_CONCURRENT_REQUESTS', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 10 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: new Array(10).fill('pending'),
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1
            };
            // Fill up to max-1 concurrent requests
            for (let i = 0; i < MEDIA_CONFIG.MAX_CONCURRENT_REQUESTS; i++) {
                transfer.requestsInFlight.set(i, { seederId: '0x1' });
                transfer.pieceStatus[i] = 'requested';
            }
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set(['0xseeder1']));
            const requestSpy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});

            mediaController.manageDownload('file-1');

            expect(requestSpy).not.toHaveBeenCalled();
            requestSpy.mockRestore();
            vi.useRealTimers();
        });

        it('uses round-robin across seeders', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 4 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'pending', 'pending', 'pending'],
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set(['0xseeder1', '0xseeder2']));
            const requestSpy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});

            mediaController.manageDownload('file-1');

            // With 2 seeders, should alternate
            const calls = requestSpy.mock.calls;
            expect(calls.length).toBeGreaterThanOrEqual(2);
            // First and second should use different seeders
            const seeders = new Set(calls.map(c => c[2]));
            expect(seeders.size).toBe(2);
            requestSpy.mockRestore();
            vi.useRealTimers();
        });

        it('schedules retry if no seeders', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 1 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending'],
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set()); // empty
            const spy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});

            mediaController.manageDownload('file-1');

            // Should not request pieces
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
            vi.useRealTimers();
        });
    });

    // ==================== SEEDING PERSISTENCE ====================
    describe('Seeding Persistence', () => {
        describe('persistSeedFile', () => {
            const makeDbMock = () => ({
                objectStoreNames: { contains: (name) => name === 'seedFiles' }
            });

            it('returns false without db', async () => {
                mediaController.db = null;
                const result = await mediaController.persistSeedFile('f1', new Blob(), {}, 's1');
                expect(result).toBe(false);
            });

            it('returns false without seedFiles store', async () => {
                mediaController.db = { objectStoreNames: { contains: () => false } };
                const result = await mediaController.persistSeedFile('f1', new Blob(), {}, 's1');
                expect(result).toBe(false);
            });

            it('returns false without owner address', async () => {
                mediaController.db = makeDbMock();
                mediaController.currentOwnerAddress = null;
                const result = await mediaController.persistSeedFile('f1', new Blob(), {}, 's1');
                expect(result).toBe(false);
            });

            it('returns false for private channel when PERSIST_PRIVATE_CHANNELS is false', async () => {
                mediaController.db = makeDbMock();
                mediaController.currentOwnerAddress = '0xowner';
                const result = await mediaController.persistSeedFile('f1', new Blob(), { fileSize: 10 }, 's1', true);
                expect(result).toBe(false);
            });

            it('saves seed file when conditions met', async () => {
                const saveSpy = vi.spyOn(mediaController, 'saveSeedFile').mockResolvedValue(undefined);
                mediaController.db = makeDbMock();
                mediaController.currentOwnerAddress = '0xowner';
                mediaController.persistedStorageSize = 0;

                const blob = new Blob(['testdata']);
                const metadata = { fileSize: 8, fileName: 'test.mp4' };

                const result = await mediaController.persistSeedFile('f1', blob, metadata, 's1', false);

                expect(result).toBe(true);
                expect(mediaController.persistedStorageSize).toBe(8);
                expect(saveSpy).toHaveBeenCalled();
                saveSpy.mockRestore();
            });

            it('evicts old files when over quota', async () => {
                const evictSpy = vi.spyOn(mediaController, 'evictOldestSeedFiles').mockResolvedValue(100);
                const saveSpy = vi.spyOn(mediaController, 'saveSeedFile').mockResolvedValue(undefined);
                mediaController.db = makeDbMock();
                mediaController.currentOwnerAddress = '0xowner';
                mediaController.persistedStorageSize = MEDIA_CONFIG.MAX_SEED_STORAGE; // at max

                const blob = new Blob(['data']);
                const metadata = { fileSize: 50, fileName: 'test.mp4' };
                await mediaController.persistSeedFile('f1', blob, metadata, 's1');

                expect(evictSpy).toHaveBeenCalledWith(50);
                evictSpy.mockRestore();
                saveSpy.mockRestore();
            });
        });

        describe('loadPersistedSeedFiles', () => {
            it('returns early without db', async () => {
                mediaController.db = null;
                await expect(mediaController.loadPersistedSeedFiles()).resolves.not.toThrow();
            });

            it('returns early without owner address', async () => {
                mediaController.db = { objectStoreNames: { contains: () => true } };
                mediaController.currentOwnerAddress = null;
                await expect(mediaController.loadPersistedSeedFiles()).resolves.not.toThrow();
            });

            it('loads files owned by current user', async () => {
                const now = Date.now();
                const seedFiles = [
                    { fileId: 'f1', ownerAddress: '0xowner', timestamp: now, fileData: new ArrayBuffer(4), metadata: { fileSize: 4, fileType: 'video/mp4', fileName: 'a.mp4' }, streamId: 's1' },
                    { fileId: 'f2', ownerAddress: '0xother', timestamp: now, fileData: new ArrayBuffer(4), metadata: { fileSize: 4, fileType: 'video/mp4', fileName: 'b.mp4' }, streamId: 's2' }
                ];
                vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue(seedFiles);
                mediaController.db = { objectStoreNames: { contains: () => true } };
                mediaController.currentOwnerAddress = '0xowner';

                await mediaController.loadPersistedSeedFiles();

                // Should only load f1 (owned by current user)
                expect(mediaController.localFiles.has('f1')).toBe(true);
                expect(mediaController.localFiles.has('f2')).toBe(false);
            });

            it('removes expired seed files', async () => {
                const expired = Date.now() - (MEDIA_CONFIG.SEED_FILES_EXPIRE_DAYS + 1) * 24 * 60 * 60 * 1000;
                const seedFiles = [
                    { fileId: 'f1', ownerAddress: '0xowner', timestamp: expired, fileData: new ArrayBuffer(4), metadata: { fileSize: 4, fileType: 'video/mp4', fileName: 'old.mp4' }, streamId: 's1' }
                ];
                vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue(seedFiles);
                const removeSpy = vi.spyOn(mediaController, 'removeSeedFile').mockResolvedValue(undefined);
                mediaController.db = { objectStoreNames: { contains: () => true } };
                mediaController.currentOwnerAddress = '0xowner';

                await mediaController.loadPersistedSeedFiles();

                expect(removeSpy).toHaveBeenCalledWith('f1');
                expect(mediaController.localFiles.has('f1')).toBe(false);
                removeSpy.mockRestore();
            });
        });

        describe('getStorageStats', () => {
            it('returns current storage metrics', () => {
                mediaController.persistedStorageSize = 5 * 1024 * 1024; // 5MB
                mediaController.localFiles.set('f1', {});
                mediaController.localFiles.set('f2', {});

                const stats = mediaController.getStorageStats();

                expect(stats.usedBytes).toBe(5 * 1024 * 1024);
                expect(stats.maxBytes).toBe(MEDIA_CONFIG.MAX_SEED_STORAGE);
                expect(stats.usedMB).toBe('5.00');
                expect(stats.fileCount).toBe(2);
                expect(stats.percentUsed).toBeGreaterThan(0);
            });
        });

        describe('reannounceForChannel', () => {
            it('re-announces seeded files for matching channel', async () => {
                const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
                mediaController.localFiles.set('f1', { streamId: 'stream-1' });
                mediaController.localFiles.set('f2', { streamId: 'stream-2' });
                mediaController.localFiles.set('f3', { streamId: 'stream-1' });

                await mediaController.reannounceForChannel('stream-1');

                expect(announceSpy).toHaveBeenCalledTimes(2);
                expect(announceSpy).toHaveBeenCalledWith('stream-1', 'f1', null);
                expect(announceSpy).toHaveBeenCalledWith('stream-1', 'f3', null);
                announceSpy.mockRestore();
            });

            it('passes password for encrypted channels', async () => {
                const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
                mediaController.localFiles.set('f1', { streamId: 'stream-1' });

                await mediaController.reannounceForChannel('stream-1', 'secret');

                expect(announceSpy).toHaveBeenCalledWith('stream-1', 'f1', 'secret');
                announceSpy.mockRestore();
            });

            it('does nothing when no matching files', async () => {
                const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
                mediaController.localFiles.set('f1', { streamId: 'other-stream' });

                await mediaController.reannounceForChannel('stream-1');

                expect(announceSpy).not.toHaveBeenCalled();
                announceSpy.mockRestore();
            });
        });

        describe('clearAllSeedFiles', () => {
            it('removes all seed files', async () => {
                vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue([
                    { fileId: 'f1' }, { fileId: 'f2' }
                ]);
                const removeSpy = vi.spyOn(mediaController, 'removeSeedFile').mockResolvedValue(undefined);
                mediaController.db = {};

                await mediaController.clearAllSeedFiles();

                expect(removeSpy).toHaveBeenCalledWith('f1');
                expect(removeSpy).toHaveBeenCalledWith('f2');
                expect(mediaController.persistedStorageSize).toBe(0);
                removeSpy.mockRestore();
            });

            it('does nothing without db', async () => {
                mediaController.db = null;
                await expect(mediaController.clearAllSeedFiles()).resolves.not.toThrow();
            });
        });

        describe('clearSeedFilesForOwner', () => {
            it('clears files for specific owner', async () => {
                vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue([
                    { fileId: 'f1', ownerAddress: '0xTarget' },
                    { fileId: 'f2', ownerAddress: '0xOther' },
                    { fileId: 'f3', ownerAddress: null } // legacy - should also be cleared
                ]);
                const removeSpy = vi.spyOn(mediaController, 'removeSeedFile').mockResolvedValue(undefined);
                mediaController.db = {};

                await mediaController.clearSeedFilesForOwner('0xTarget');

                expect(removeSpy).toHaveBeenCalledWith('f1');
                expect(removeSpy).toHaveBeenCalledWith('f3'); // legacy
                expect(removeSpy).not.toHaveBeenCalledWith('f2');
                removeSpy.mockRestore();
            });

            it('does nothing without db', async () => {
                mediaController.db = null;
                await expect(mediaController.clearSeedFilesForOwner('0xaddr')).resolves.not.toThrow();
            });

            it('does nothing with null address', async () => {
                mediaController.db = {};
                await expect(mediaController.clearSeedFilesForOwner(null)).resolves.not.toThrow();
            });
        });

        describe('evictOldestSeedFiles', () => {
            it('returns 0 without db', async () => {
                mediaController.db = null;
                const result = await mediaController.evictOldestSeedFiles(1000);
                expect(result).toBe(0);
            });

            it('evicts oldest files first', async () => {
                mediaController.db = {};
                const getAllSpy = vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue([
                    { fileId: 'f2', timestamp: 200, metadata: { fileSize: 50 } },
                    { fileId: 'f1', timestamp: 100, metadata: { fileSize: 50 } },
                    { fileId: 'f3', timestamp: 300, metadata: { fileSize: 50 } }
                ]);
                const removeSpy = vi.spyOn(mediaController, 'removeSeedFile').mockResolvedValue(undefined);

                const freed = await mediaController.evictOldestSeedFiles(60);

                // Should evict f1 (oldest, timestamp=100) first then f2 (200)
                expect(removeSpy).toHaveBeenCalledWith('f1');
                expect(freed).toBeGreaterThanOrEqual(60);
                getAllSpy.mockRestore();
                removeSpy.mockRestore();
            });
        });
    });

    // ==================== sendImage (full flow) ====================
    describe('sendImage full flow', () => {
        it('throws for invalid image type', async () => {
            const file = new File(['test'], 'test.txt', { type: 'text/plain' });
            await expect(mediaController.sendImage('stream-1', file)).rejects.toThrow('Invalid image type');
        });

        it('sends image to regular channel', async () => {
            // Mock resizeImage to skip canvas
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:image/jpeg;base64,abc');
            channelManager.getChannel.mockReturnValue({ type: 'public', messages: [], password: null });
            // createSignedMessage returns fresh copy each call
            identityManager.createSignedMessage.mockResolvedValue({
                id: 'msg-img-1',
                sender: '0xmyaddress',
                timestamp: Date.now()
            });

            const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
            const result = await mediaController.sendImage('stream-1', file);

            expect(result.imageId).toBeDefined();
            expect(result.data).toBe('data:image/jpeg;base64,abc');
            expect(streamrController.publishMessage).toHaveBeenCalled();
            // Verify cache by checking imageCache size increased
            expect(mediaController.imageCache.size).toBeGreaterThan(0);
        });

        it('sends image with password encryption', async () => {
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:base64');
            channelManager.getChannel.mockReturnValue({ type: 'native', messages: [], password: 'pwd' });

            const file = new File(['img'], 'photo.png', { type: 'image/png' });
            await mediaController.sendImage('stream-1', file, 'pwd');

            expect(streamrController.publishMessage).toHaveBeenCalledWith('stream-1', expect.any(Object), 'pwd');
        });

        it('sends DM image with E2E encryption', async () => {
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:base64');
            channelManager.getChannel.mockReturnValue({
                type: 'dm',
                peerAddress: '0xpeer',
                messages: []
            });

            const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
            await mediaController.sendImage('stream-1', file);

            expect(dmManager.getPeerPublicKey).toHaveBeenCalledWith('0xpeer');
            expect(dmCrypto.getSharedKey).toHaveBeenCalled();
            expect(dmCrypto.encrypt).toHaveBeenCalled();
            expect(secureStorage.addSentMessage).toHaveBeenCalled();
        });

        it('persists for write-only channels', async () => {
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:base64');
            channelManager.getChannel.mockReturnValue({
                type: 'public',
                writeOnly: true,
                messages: []
            });

            const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
            await mediaController.sendImage('stream-1', file);

            expect(secureStorage.addSentMessage).toHaveBeenCalledWith('stream-1', expect.any(Object));
        });

        it('throws when DM wallet private key missing', async () => {
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:base64');
            authManager.wallet = null;
            channelManager.getChannel.mockReturnValue({
                type: 'dm',
                peerAddress: '0xpeer',
                messages: []
            });

            const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
            await expect(mediaController.sendImage('stream-1', file)).rejects.toThrow('wallet private key');

            // Restore
            authManager.wallet = { privateKey: '0xprivatekey' };
        });
    });

    // ==================== sendVideo (full flow) ====================
    describe('sendVideo', () => {
        it('throws for invalid video type', async () => {
            const file = new File(['test'], 'test.txt', { type: 'text/plain' });
            await expect(mediaController.sendVideo('stream-1', file)).rejects.toThrow('Invalid video type');
        });

        it('throws for oversized file', async () => {
            const file = { type: 'video/mp4', size: 600 * 1024 * 1024, name: 'big.mp4' };
            await expect(mediaController.sendVideo('stream-1', file)).rejects.toThrow('File too large');
        });

        it('stores temp reference with callback', async () => {
            // Mock fileWorker since we can't create real workers in test
            mediaController.fileWorker = { postMessage: vi.fn() };

            const file = new File(['videodata'], 'clip.mp4', { type: 'video/mp4' });
            // Don't await - the promise resolves when worker calls back
            const promise = mediaController.sendVideo('stream-1', file);

            // Should have stored a temp reference
            const tempKey = Array.from(mediaController.localFiles.keys()).find(k => k.startsWith('temp-'));
            expect(tempKey).toBeDefined();
            const tempRef = mediaController.localFiles.get(tempKey);
            expect(tempRef.file).toBe(file);
            expect(tempRef.streamId).toBe('stream-1');
            expect(typeof tempRef.callback).toBe('function');

            // Clean up (resolve the hanging promise)
            promise.catch(() => {}); // suppress unhandled rejection
        });
    });

    // ==================== handleWorkerMessage ====================
    describe('handleWorkerMessage', () => {
        it('moves file from temp to final on complete', async () => {
            const mockCallback = vi.fn().mockResolvedValue(undefined);
            mediaController.localFiles.set('temp-123', {
                file: new Blob(['data']),
                streamId: 'stream-1',
                isPrivateChannel: false,
                callback: mockCallback
            });
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            const metadata = { fileId: 'final-id', fileName: 'test.mp4', fileSize: 4 };
            await mediaController.handleWorkerMessage({ status: 'complete', metadata, tempId: 'temp-123' });

            expect(mediaController.localFiles.has('temp-123')).toBe(false);
            expect(mediaController.localFiles.has('final-id')).toBe(true);
            expect(mockCallback).toHaveBeenCalledWith(metadata);
        });

        it('persists seed file after callback', async () => {
            mediaController.localFiles.set('temp-456', {
                file: new Blob(['data']),
                streamId: 'stream-1',
                isPrivateChannel: false,
                callback: vi.fn().mockResolvedValue(undefined)
            });
            const persistSpy = vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(true);

            const metadata = { fileId: 'final-456', fileName: 'v.mp4', fileSize: 4 };
            await mediaController.handleWorkerMessage({ status: 'complete', metadata, tempId: 'temp-456' });

            expect(persistSpy).toHaveBeenCalledWith('final-456', expect.any(Blob), metadata, 'stream-1', false);
            // Should mark as persisted
            expect(mediaController.localFiles.get('final-456').persisted).toBe(true);
            persistSpy.mockRestore();
        });

        it('handles missing temp reference', async () => {
            const metadata = { fileId: 'final-id' };
            await expect(
                mediaController.handleWorkerMessage({ status: 'complete', metadata, tempId: 'nonexistent' })
            ).resolves.not.toThrow();
        });
    });

    // ==================== getFileUrl ====================
    describe('getFileUrl', () => {
        it('returns downloaded URL if available', () => {
            mediaController.downloadedUrls.set('file-1', 'blob:downloaded');
            const result = mediaController.getFileUrl('file-1');
            expect(result).toBe('blob:downloaded');
        });

        it('returns local file URL as fallback', () => {
            mediaController.localFiles.set('file-1', { file: new Blob(['test']) });
            const result = mediaController.getFileUrl('file-1');
            expect(result).toBeTruthy();
        });

        it('returns null if not available anywhere', () => {
            expect(mediaController.getFileUrl('nonexistent')).toBeNull();
        });
    });

    // ==================== getLocalFileUrl ====================
    describe('getLocalFileUrl', () => {
        it('creates and caches blob URL', () => {
            mediaController.localFiles.set('file-1', { file: new Blob(['test']) });
            const url = mediaController.getLocalFileUrl('file-1');
            expect(url).toBeTruthy();
            // Should cache it
            expect(mediaController.downloadedUrls.has('file-1')).toBe(true);
            // Second call returns same URL
            expect(mediaController.getLocalFileUrl('file-1')).toBe(url);
        });

        it('returns null for missing file', () => {
            expect(mediaController.getLocalFileUrl('nonexistent')).toBeNull();
        });

        it('returns null if localFile has no file property', () => {
            mediaController.localFiles.set('file-1', { metadata: {} });
            expect(mediaController.getLocalFileUrl('file-1')).toBeNull();
        });
    });

    // ==================== removeSeedFile ====================
    describe('removeSeedFile', () => {
        // removeSeedFile returns early if !this.db, so we need a mock db
        const makeMockDb = () => {
            const mockRequest = { onsuccess: null, onerror: null };
            const mockStore = {
                delete: vi.fn(() => {
                    // Simulate async success
                    setTimeout(() => mockRequest.onsuccess?.(), 0);
                    return mockRequest;
                })
            };
            const mockTx = { objectStore: vi.fn(() => mockStore) };
            return { transaction: vi.fn(() => mockTx) };
        };

        it('returns early without db', async () => {
            mediaController.db = null;
            mediaController.localFiles.set('f1', { metadata: { fileSize: 1000 } });
            mediaController.persistedStorageSize = 5000;

            await mediaController.removeSeedFile('f1');

            // Should NOT have modified anything since it returns early
            expect(mediaController.persistedStorageSize).toBe(5000);
        });

        it('updates persistedStorageSize', async () => {
            mediaController.db = makeMockDb();
            mediaController.localFiles.set('f1', { metadata: { fileSize: 1000 } });
            mediaController.persistedStorageSize = 5000;

            await mediaController.removeSeedFile('f1');

            expect(mediaController.persistedStorageSize).toBe(4000);
        });

        it('revokes blob URL', async () => {
            const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
            mediaController.db = makeMockDb();
            mediaController.downloadedUrls.set('f1', 'blob:url');

            await mediaController.removeSeedFile('f1');

            expect(revokeSpy).toHaveBeenCalledWith('blob:url');
            expect(mediaController.downloadedUrls.has('f1')).toBe(false);
            revokeSpy.mockRestore();
        });

        it('removes from localFiles', async () => {
            mediaController.db = makeMockDb();
            mediaController.localFiles.set('f1', {});

            await mediaController.removeSeedFile('f1');

            expect(mediaController.localFiles.has('f1')).toBe(false);
        });
    });
});
