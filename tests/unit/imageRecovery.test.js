/**
 * Tests for chunked-image recovery loops:
 *  - channelManager.recoverIncompleteImages (joined channels, channels.js)
 *  - previewModeUI._recoverIncompletePreviewImages (guest preview, ui/PreviewModeUI.js)
 *
 * Both loops paginate stored history to fill image manifests whose chunks
 * fell outside the initial resend window. They share four invariants:
 *  1. Happy path: complete after enough rounds to bring chunks/manifests.
 *  2. Stagnation guard: bail after N consecutive rounds with no progress.
 *  3. Exhaustion: stop when hasMoreHistory becomes false.
 *  4. No-op when cached: short-circuit if the image is already in memory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- Shared mocks ----------

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        isInitialized: vi.fn().mockReturnValue(true),
        getCurrentAddress: vi.fn().mockReturnValue('0x123'),
        subscribe: vi.fn(),
        publish: vi.fn(),
        publishMessage: vi.fn().mockResolvedValue(undefined),
        getStoredMessages: vi.fn().mockResolvedValue([]),
        hasPermission: vi.fn().mockResolvedValue(true),
        hasPublishPermission: vi.fn().mockResolvedValue({ hasPermission: true, rpcError: false }),
        hasDeletePermission: vi.fn().mockResolvedValue(false),
        resend: vi.fn(),
        fetchOlderHistory: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
        fetchOlderHistoryWindowed: vi.fn().mockResolvedValue({ messages: [], hasMore: false, windowStart: 0 }),
        checkPermissions: vi.fn().mockResolvedValue({ canSubscribe: true, canPublish: true, isOwner: false })
    },
    STREAM_CONFIG: {
        partitions: 1,
        LOAD_MORE_COUNT: 20,
        ADMIN_HISTORY_COUNT: 10,
        MESSAGE_STREAM: { MESSAGES: 0, CONTROL: 1 },
        ADMIN_STREAM: { MODERATION: 0 }
    },
    deriveEphemeralId: vi.fn((id) => `${id}-eph`),
    deriveMessageId: vi.fn((id) => `${id}-msg`),
    deriveAdminId: vi.fn((id) => `${id}-admin`)
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xme'),
        getCurrentAddress: vi.fn().mockReturnValue('0xme'),
        getWalletAddress: vi.fn().mockReturnValue('0xme'),
        isConnected: vi.fn().mockReturnValue(true)
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getUserNickname: vi.fn().mockReturnValue('Me'),
        getCurrentIdentity: vi.fn().mockReturnValue({ nickname: 'Me', address: '0xme' }),
        verifyMessage: vi.fn().mockResolvedValue({ valid: true, trustLevel: 1 })
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn().mockReturnValue(true),
        getChannels: vi.fn().mockReturnValue([]),
        saveChannels: vi.fn(),
        setChannels: vi.fn(),
        getChannel: vi.fn(),
        setChannel: vi.fn(),
        getImageBlob: vi.fn().mockResolvedValue(null)
    }
}));

vi.mock('../../src/js/graph.js', () => ({
    graphAPI: {
        getPublicPomboChannels: vi.fn().mockResolvedValue([]),
        getStreamMetadata: vi.fn()
    }
}));

vi.mock('../../src/js/relayManager.js', () => ({
    relayManager: { enabled: false }
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: { isDMChannel: vi.fn().mockReturnValue(false), conversations: new Map() }
}));

// mediaController stub shared between channels.js and PreviewModeUI.js mocks.
// IMPORTANT: vi.mock() factories are hoisted, so the stub must be created
// inline inside the factory (cannot reference top-level vars).
vi.mock('../../src/js/media.js', () => {
    const mediaController = {
        isStoredChunkedImageManifest: vi.fn((m) => m?.type === 'image_manifest'),
        isStoredImageChunkMessage: vi.fn((m) => m?.type === 'image_chunk'),
        deletedImageIds: new Set(),
        pendingImageAssemblies: new Map(),
        getImage: vi.fn().mockReturnValue(null),
        recoverImage: vi.fn(),
        handleImageData: vi.fn(),
        registerStoredImageManifest: vi.fn().mockResolvedValue(undefined),
        registerStoredImageChunk: vi.fn().mockResolvedValue(true)
    };
    return { mediaController, handleMediaMessage: vi.fn() };
});

// ---------- Import after mocks ----------
import { channelManager } from '../../src/js/channels.js';
import { previewModeUI } from '../../src/js/ui/PreviewModeUI.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { Logger } from '../../src/js/logger.js';
import { mediaController } from '../../src/js/media.js';
import { streamrController } from '../../src/js/streamr.js';

// ---------- Helpers ----------

function makeManifest(imageId) {
    return { type: 'image_manifest', imageId, verified: { valid: true } };
}

function makePending({ streamId, chunkCount = 5, chunks = 0 }) {
    const chunkMap = new Map();
    for (let i = 0; i < chunks; i++) chunkMap.set(i, { idx: i });
    return {
        streamId,
        manifest: { chunkCount },
        chunks: chunkMap,
        timerId: null
    };
}

function resetMediaStub() {
    mediaController.pendingImageAssemblies.clear();
    mediaController.deletedImageIds.clear();
    mediaController.getImage.mockReturnValue(null);
    mediaController.recoverImage.mockClear();
    mediaController.handleImageData.mockClear();
    mediaController.registerStoredImageManifest.mockClear();
}

// ============================================================
// channelManager.recoverIncompleteImages
// ============================================================
describe('channelManager.recoverIncompleteImages', () => {
    const streamId = 'stream-abcdef-channel-recovery';

    beforeEach(() => {
        resetMediaStub();
        channelManager.channels.clear();
        channelManager.switchGeneration = 0;
        vi.clearAllMocks();
    });

    it('completes when pagination brings chunks that finish the manifest', async () => {
        const imageId = 'img-happy';
        const manifest = makeManifest(imageId);
        // Channel state: manifest already known, no chunks yet
        channelManager.channels.set(streamId, {
            streamId,
            messages: [manifest],
            hasMoreHistory: true,
            writeOnly: false,
            type: 'public'
        });
        mediaController.pendingImageAssemblies.set(imageId,
            makePending({ streamId, chunkCount: 2, chunks: 0 }));

        // First loadMoreHistory: chunks 0+1 arrive -> assembly completes,
        // image cached, manifest leaves the incomplete list.
        let round = 0;
        channelManager.loadMoreHistory = vi.fn(async () => {
            round++;
            if (round === 1) {
                // Bring 2 chunks for the pending assembly
                const pending = mediaController.pendingImageAssemblies.get(imageId);
                pending.chunks.set(0, { idx: 0 });
                pending.chunks.set(1, { idx: 1 });
                return { loaded: 2, hasMore: true };
            }
            // Subsequent rounds: cache says image is now ready
            mediaController.getImage.mockReturnValue('data:image/png;base64,xxx');
            return { loaded: 0, hasMore: true };
        });

        await channelManager.recoverIncompleteImages(streamId);

        expect(channelManager.loadMoreHistory).toHaveBeenCalled();
        // Final round resolves (no incomplete left)
        expect(Logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining('stagnant')
        );
    });

    it('aborts after stagnant rounds and dispatches imageRecoveryGaveUp', async () => {
        const imageId = 'img-stuck';
        channelManager.channels.set(streamId, {
            streamId,
            messages: [makeManifest(imageId)],
            hasMoreHistory: true,
            writeOnly: false,
            type: 'public'
        });
        mediaController.pendingImageAssemblies.set(imageId,
            makePending({ streamId, chunkCount: 5, chunks: 0 }));

        // Pagination always returns 0 / hasMore: true -> stagnates
        channelManager.loadMoreHistory = vi.fn().mockResolvedValue({ loaded: 0, hasMore: true });

        const events = [];
        const handler = (ev) => events.push(ev.detail);
        window.addEventListener('pombo:imageRecoveryGaveUp', handler);

        await channelManager.recoverIncompleteImages(streamId);

        window.removeEventListener('pombo:imageRecoveryGaveUp', handler);

        // Stagnation warning fired
        expect(Logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('stagnant')
        );
        // Event dispatched with our imageId
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].imageIds).toContain(imageId);
        expect(events[0].streamId).toBe(streamId);
    });

    it('aborts and marks unavailable when channel has no more history', async () => {
        const imageId = 'img-exhausted';
        channelManager.channels.set(streamId, {
            streamId,
            messages: [makeManifest(imageId)],
            hasMoreHistory: false,
            writeOnly: false,
            type: 'public'
        });
        mediaController.pendingImageAssemblies.set(imageId,
            makePending({ streamId, chunkCount: 3, chunks: 0 }));

        channelManager.loadMoreHistory = vi.fn();

        const events = [];
        const handler = (ev) => events.push(ev.detail);
        window.addEventListener('pombo:imageRecoveryGaveUp', handler);

        await channelManager.recoverIncompleteImages(streamId);

        window.removeEventListener('pombo:imageRecoveryGaveUp', handler);

        // No pagination needed — exhausted branch fires immediately
        expect(channelManager.loadMoreHistory).not.toHaveBeenCalled();
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].imageIds).toContain(imageId);
    });

    it('short-circuits when the image is already cached in memory', async () => {
        const imageId = 'img-cached';
        channelManager.channels.set(streamId, {
            streamId,
            messages: [makeManifest(imageId)],
            hasMoreHistory: true,
            writeOnly: false,
            type: 'public'
        });
        // Cache hit on first lookup
        mediaController.getImage.mockReturnValue('data:image/png;base64,yyy');
        channelManager.loadMoreHistory = vi.fn();

        await channelManager.recoverIncompleteImages(streamId);

        // No pagination — the manifest was resolved by cache lookup
        expect(channelManager.loadMoreHistory).not.toHaveBeenCalled();
        expect(mediaController.recoverImage).toHaveBeenCalledWith(imageId);
    });

    it('recovers chunks via targeted window when pagination was silently truncated', async () => {
        const imageId = 'img-truncated';
        // Manifest WITH timestamp — anchor for the window query
        const manifest = {
            type: 'image_manifest',
            imageId,
            timestamp: 1700000000000,
            verified: { valid: true }
        };
        channelManager.channels.set(streamId, {
            streamId,
            messages: [manifest],
            hasMoreHistory: false, // pagination (falsely) exhausted
            writeOnly: false,
            type: 'public',
            password: null
        });
        mediaController.pendingImageAssemblies.set(imageId,
            makePending({ streamId, chunkCount: 2, chunks: 0 }));

        // The targeted window resend DOES return the "missing" chunks
        streamrController.fetchOlderHistoryWindowed.mockResolvedValue({
            messages: [
                { content: { type: 'image_chunk', imageId, chunkIndex: 0 }, publisherId: '0xme', timestamp: 1699999990000 },
                { content: { type: 'image_chunk', imageId, chunkIndex: 1 }, publisherId: '0xme', timestamp: 1699999995000 }
            ],
            hasMore: false,
            windowStart: 0
        });
        mediaController.registerStoredImageChunk.mockImplementation(async (_sid, chunk) => {
            const pending = mediaController.pendingImageAssemblies.get(chunk.imageId);
            pending.chunks.set(chunk.chunkIndex, { idx: chunk.chunkIndex });
            return true;
        });

        const events = [];
        const handler = (ev) => events.push(ev.detail);
        window.addEventListener('pombo:imageRecoveryGaveUp', handler);

        await channelManager.recoverIncompleteImages(streamId);

        window.removeEventListener('pombo:imageRecoveryGaveUp', handler);

        // Window recovery was attempted with the channel's stream + partition
        expect(streamrController.fetchOlderHistoryWindowed).toHaveBeenCalled();
        // Chunks completed the assembly → image nudged, NOT marked unavailable
        expect(mediaController.recoverImage).toHaveBeenCalledWith(imageId);
        expect(events.length).toBe(0);
    });

    it('marks unavailable only images the window recovery could not complete', async () => {
        const imageId = 'img-really-gone';
        const manifest = {
            type: 'image_manifest',
            imageId,
            timestamp: 1700000000000,
            verified: { valid: true }
        };
        channelManager.channels.set(streamId, {
            streamId,
            messages: [manifest],
            hasMoreHistory: false,
            writeOnly: false,
            type: 'public',
            password: null
        });
        mediaController.pendingImageAssemblies.set(imageId,
            makePending({ streamId, chunkCount: 3, chunks: 1 }));

        // Window resend returns nothing — chunks truly absent from storage
        streamrController.fetchOlderHistoryWindowed.mockResolvedValue({
            messages: [], hasMore: false, windowStart: 0
        });

        const events = [];
        const handler = (ev) => events.push(ev.detail);
        window.addEventListener('pombo:imageRecoveryGaveUp', handler);

        await channelManager.recoverIncompleteImages(streamId);

        window.removeEventListener('pombo:imageRecoveryGaveUp', handler);

        // Retried the window (fresh connections) before giving up
        expect(streamrController.fetchOlderHistoryWindowed.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].imageIds).toContain(imageId);
    });
});

// ============================================================
// previewModeUI._recoverIncompletePreviewImages
// ============================================================
describe('previewModeUI._recoverIncompletePreviewImages', () => {
    const streamId = 'stream-preview-recovery-xyz';

    beforeEach(() => {
        resetMediaStub();
        previewModeUI.previewChannel = null;
        previewModeUI.previewGeneration = 0;
        previewModeUI._recoveryInFlight = false;
        previewModeUI._expiredImageIds.clear();
        vi.clearAllMocks();

        // Stub loadMorePreviewHistory by default (each test overrides)
        previewModeUI.loadMorePreviewHistory = vi.fn().mockResolvedValue({ loaded: 0, hasMore: false });
        // Stub _markImageUnavailable so tests can assert without DOM
        vi.spyOn(previewModeUI, '_markImageUnavailable');
    });

    it('completes when pagination brings chunks that finish the manifest', async () => {
        const imageId = 'pimg-happy';
        const manifest = makeManifest(imageId);
        const ownerChannel = {
            streamId,
            messages: [manifest],
            hasMoreHistory: true
        };
        previewModeUI.previewChannel = ownerChannel;
        mediaController.pendingImageAssemblies.set(imageId,
            makePending({ streamId, chunkCount: 2, chunks: 0 }));

        let round = 0;
        previewModeUI.loadMorePreviewHistory = vi.fn(async () => {
            round++;
            if (round === 1) {
                const pending = mediaController.pendingImageAssemblies.get(imageId);
                pending.chunks.set(0, { idx: 0 });
                pending.chunks.set(1, { idx: 1 });
                return { loaded: 2, hasMore: true };
            }
            mediaController.getImage.mockReturnValue('data:image/png;base64,zzz');
            return { loaded: 0, hasMore: true };
        });

        await previewModeUI._recoverIncompletePreviewImages(ownerChannel);

        expect(previewModeUI.loadMorePreviewHistory).toHaveBeenCalled();
        expect(previewModeUI._markImageUnavailable).not.toHaveBeenCalled();
    });

    it('aborts after stagnant rounds and marks affected ids unavailable', async () => {
        const imageId = 'pimg-stuck';
        const ownerChannel = {
            streamId,
            messages: [makeManifest(imageId)],
            hasMoreHistory: true
        };
        previewModeUI.previewChannel = ownerChannel;
        mediaController.pendingImageAssemblies.set(imageId,
            makePending({ streamId, chunkCount: 4, chunks: 0 }));

        previewModeUI.loadMorePreviewHistory = vi.fn().mockResolvedValue({ loaded: 0, hasMore: true });

        await previewModeUI._recoverIncompletePreviewImages(ownerChannel);

        expect(previewModeUI._markImageUnavailable).toHaveBeenCalledWith(imageId);
    });

    it('aborts and marks unavailable when ownerChannel has no more history', async () => {
        const imageId = 'pimg-exhausted';
        const ownerChannel = {
            streamId,
            messages: [makeManifest(imageId)],
            hasMoreHistory: false
        };
        previewModeUI.previewChannel = ownerChannel;
        mediaController.pendingImageAssemblies.set(imageId,
            makePending({ streamId, chunkCount: 3, chunks: 0 }));

        await previewModeUI._recoverIncompletePreviewImages(ownerChannel);

        // No pagination performed — the exhausted branch fires immediately
        expect(previewModeUI.loadMorePreviewHistory).not.toHaveBeenCalled();
        expect(previewModeUI._markImageUnavailable).toHaveBeenCalledWith(imageId);
    });

    it('short-circuits when the image is already cached in memory', async () => {
        const imageId = 'pimg-cached';
        const ownerChannel = {
            streamId,
            messages: [makeManifest(imageId)],
            hasMoreHistory: true
        };
        previewModeUI.previewChannel = ownerChannel;
        mediaController.getImage.mockReturnValue('data:image/png;base64,abc');

        await previewModeUI._recoverIncompletePreviewImages(ownerChannel);

        // Preview's collectIncomplete() filters cached images at the top so
        // the inner loop never runs for them; pagination is not started and
        // nothing is marked unavailable. (Joined-channel path calls
        // recoverImage() because it re-fires the delivery to heal a
        // placeholder rendered after the cache fill; preview relies on the
        // standard onImageReceived event instead.)
        expect(previewModeUI.loadMorePreviewHistory).not.toHaveBeenCalled();
        expect(previewModeUI._markImageUnavailable).not.toHaveBeenCalled();
    });
});
