/**
 * Tests for the TTL-aware republish of -3 artifacts on owner open
 * (docs/TTL_REPUBLISH_PLAN.md):
 *   - shouldRepublish() pure decision logic (ttlRepublish.js)
 *   - channelManager._ttlRepublishOnOpen() wiring (channels.js)
 *   - setChannelStorageDays keeping the local storageDays in sync
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies before importing (same set as channels.test.js)
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        isInitialized: vi.fn().mockReturnValue(true),
        getCurrentAddress: vi.fn().mockReturnValue('0xmyaddress'),
        subscribe: vi.fn(),
        publish: vi.fn(),
        publishAsChannel: vi.fn().mockResolvedValue(undefined),
        resend: vi.fn(),
        resendAdminState: vi.fn().mockResolvedValue(null),
        publishAdminState: vi.fn().mockResolvedValue(undefined),
        publishPasswordChallenge: vi.fn().mockResolvedValue(undefined),
        verifyPasswordChallenge: vi.fn().mockResolvedValue({ found: true, valid: true, ts: Date.now() }),
        resendChannelImage: vi.fn().mockResolvedValue(null),
        publishChannelImage: vi.fn().mockResolvedValue(undefined),
        setStorageDays: vi.fn().mockResolvedValue(true),
        subscribeToKeysStream: vi.fn().mockResolvedValue(undefined),
        checkPermissions: vi.fn().mockResolvedValue({ canSubscribe: true, canPublish: true, isOwner: false })
    },
    STREAM_CONFIG: {
        partitions: 1,
        LOAD_MORE_COUNT: 20,
        ADMIN_HISTORY_COUNT: 10,
        MESSAGE_STREAM: { MESSAGES: 0, CONTROL: 1 },
        ADMIN_STREAM: { MODERATION: 0 }
    },
    deriveEphemeralId: vi.fn((id) => `${id}-ephemeral`),
    deriveMessageId: vi.fn((id) => `${id}-message`),
    deriveAdminId: vi.fn((id) => `${id}-admin`),
    deriveKeysId: vi.fn((id) => `${id}-keys`)
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xmyaddress'),
        getCurrentAddress: vi.fn().mockReturnValue('0xmyaddress'),
        isConnected: vi.fn().mockReturnValue(true)
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getUserNickname: vi.fn().mockReturnValue('TestUser'),
        getCurrentIdentity: vi.fn().mockReturnValue({ nickname: 'TestUser', address: '0xmyaddress' })
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn().mockReturnValue(true),
        getChannels: vi.fn().mockReturnValue([]),
        saveChannels: vi.fn(),
        setChannels: vi.fn(),
        clearChannelLeftAt: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/graph.js', () => ({
    graphAPI: {
        getPublicPomboChannels: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue(null)
    }
}));

vi.mock('../../src/js/relayManager.js', () => ({
    relayManager: {
        sendPushNotification: vi.fn(),
        enabled: false
    }
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        isDMChannel: vi.fn().mockReturnValue(false),
        conversations: new Map()
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

vi.mock('../../src/js/channelImageManager.js', () => ({
    channelImageManager: {
        get: vi.fn().mockResolvedValue(null),
        getCached: vi.fn().mockReturnValue(null),
        setLocal: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {})
    }
}));

import { shouldRepublish } from '../../src/js/ttlRepublish.js';
import { channelManager } from '../../src/js/channels.js';
import { streamrController } from '../../src/js/streamr.js';
import { authManager } from '../../src/js/auth.js';
import { channelImageManager } from '../../src/js/channelImageManager.js';
import { graphAPI } from '../../src/js/graph.js';
import { epochKeyManager } from '../../src/js/epochKeyManager.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { CONFIG } from '../../src/js/config.js';

const streamMetadata = (storageDays) => ({
    metadata: JSON.stringify({
        partitions: 3,
        description: '{"a":"pombo","k":"admin"}',
        ...(storageDays === undefined ? {} : { storageDays })
    })
});

const DAY = 86_400_000;

describe('shouldRepublish()', () => {
    const NOW = 1_800_000_000_000;

    it('returns false for missing or invalid artifact ts', () => {
        expect(shouldRepublish(0, 180, NOW)).toBe(false);
        expect(shouldRepublish(null, 180, NOW)).toBe(false);
        expect(shouldRepublish(undefined, 180, NOW)).toBe(false);
        expect(shouldRepublish(-5, 180, NOW)).toBe(false);
        expect(shouldRepublish('abc', 180, NOW)).toBe(false);
    });

    it('returns false for missing or invalid storageDays', () => {
        expect(shouldRepublish(NOW - 100 * DAY, 0, NOW)).toBe(false);
        expect(shouldRepublish(NOW - 100 * DAY, null, NOW)).toBe(false);
        expect(shouldRepublish(NOW - 100 * DAY, undefined, NOW)).toBe(false);
        expect(shouldRepublish(NOW - 100 * DAY, -1, NOW)).toBe(false);
    });

    it('returns false while younger than the age fraction of the TTL', () => {
        // 180d TTL, 0.8 fraction -> threshold at 144 days
        expect(shouldRepublish(NOW - 10 * DAY, 180, NOW)).toBe(false);
        expect(shouldRepublish(NOW - 143 * DAY, 180, NOW)).toBe(false);
    });

    it('returns true once older than the age fraction of the TTL', () => {
        expect(shouldRepublish(NOW - 145 * DAY, 180, NOW)).toBe(true);
        expect(shouldRepublish(NOW - 179 * DAY, 180, NOW)).toBe(true);
        // Even past the TTL (still retained until the purge runs)
        expect(shouldRepublish(NOW - 500 * DAY, 180, NOW)).toBe(true);
    });

    it('is strict at the exact threshold', () => {
        expect(shouldRepublish(NOW - 144 * DAY, 180, NOW)).toBe(false);
    });

    it('honours an explicit ageFraction override', () => {
        expect(shouldRepublish(NOW - 10 * DAY, 180, NOW, 0.01)).toBe(true);
        expect(shouldRepublish(NOW - 143 * DAY, 180, NOW, 0.99)).toBe(false);
    });

    it('scales with short TTLs', () => {
        // 1d TTL -> threshold at 0.8 days
        expect(shouldRepublish(NOW - 0.5 * DAY, 1, NOW)).toBe(false);
        expect(shouldRepublish(NOW - 0.9 * DAY, 1, NOW)).toBe(true);
    });
});

describe('channelManager._ttlRepublishOnOpen()', () => {
    const STREAM_ID = 'owner/pombo/test-1';
    const ADMIN_ID = 'owner/pombo/test-3';
    const FRESH_TS = () => Date.now() - 1 * DAY;
    const OLD_TS = () => Date.now() - 170 * DAY; // past 144d threshold for 180d TTL

    function makeChannel(overrides = {}) {
        return {
            messageStreamId: STREAM_ID,
            adminStreamId: ADMIN_ID,
            name: 'Test',
            type: 'public',
            createdBy: '0xmyaddress',
            storageEnabled: true,
            storageDays: 180,
            adminState: { bannedMembers: ['0xbad'], hiddenMessageIds: [], pins: [] },
            adminRev: 3,
            adminTs: FRESH_TS(),
            adminLoaded: true,
            ...overrides
        };
    }

    let publishAdminStateSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        channelManager.channels.clear();
        authManager.getAddress.mockReturnValue('0xmyaddress');
        graphAPI.getStream.mockResolvedValue(null);
        streamrController.resendChannelImage.mockResolvedValue(null);
        streamrController.verifyPasswordChallenge.mockResolvedValue({ found: true, valid: true, ts: FRESH_TS() });
        // The admin-state branch delegates to the real publishAdminState — spy
        // it out so tests assert intent without exercising rev bookkeeping.
        publishAdminStateSpy = vi.spyOn(channelManager, 'publishAdminState').mockResolvedValue({ rev: 4, state: {} });
    });

    afterEach(() => {
        publishAdminStateSpy.mockRestore();
    });

    it('is a no-op for non-owners', async () => {
        const channel = makeChannel({ createdBy: '0xsomeoneelse', adminTs: OLD_TS(), type: 'password' });
        await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, 'pw');
        expect(publishAdminStateSpy).not.toHaveBeenCalled();
        expect(streamrController.verifyPasswordChallenge).not.toHaveBeenCalled();
        expect(streamrController.resendChannelImage).not.toHaveBeenCalled();
    });

    it('derives ownership from the stream prefix when createdBy is missing', async () => {
        // Locally-joined password channels may not carry createdBy — the
        // stream path prefix (the creator's address) must still qualify.
        const channel = makeChannel({
            createdBy: undefined,
            messageStreamId: '0xmyaddress/pombo/test-1',
            adminTs: OLD_TS()
        });
        await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
        expect(publishAdminStateSpy).toHaveBeenCalled();
    });

    it('is a no-op for DMs', async () => {
        await channelManager._ttlRepublishOnOpen(makeChannel({ type: 'dm', adminTs: OLD_TS() }), ADMIN_ID, null);
        expect(publishAdminStateSpy).not.toHaveBeenCalled();
        expect(streamrController.resendChannelImage).not.toHaveBeenCalled();
    });

    it('runs even when the local storageEnabled flag is stale/false', async () => {
        // The stream can have storage on-chain while the local flag is false
        // (joined channels, pre-flag records) — branches self-gate instead.
        const channel = makeChannel({ storageEnabled: false, adminTs: OLD_TS() });
        await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
        expect(publishAdminStateSpy).toHaveBeenCalled();
    });

    describe('ADMIN_STATE branch', () => {
        it('republishes the current state when the snapshot is near TTL', async () => {
            const channel = makeChannel({ adminTs: OLD_TS() });
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(publishAdminStateSpy).toHaveBeenCalledWith(STREAM_ID, { state: channel.adminState });
        });

        it('does not republish a fresh snapshot', async () => {
            await channelManager._ttlRepublishOnOpen(makeChannel({ adminTs: FRESH_TS() }), ADMIN_ID, null);
            expect(publishAdminStateSpy).not.toHaveBeenCalled();
        });

        it('does not republish when no snapshot was ever published (rev 0)', async () => {
            await channelManager._ttlRepublishOnOpen(
                makeChannel({ adminRev: 0, adminTs: OLD_TS() }), ADMIN_ID, null);
            expect(publishAdminStateSpy).not.toHaveBeenCalled();
        });

        it('does not republish before the bootstrap marked adminLoaded', async () => {
            await channelManager._ttlRepublishOnOpen(
                makeChannel({ adminLoaded: false, adminTs: OLD_TS() }), ADMIN_ID, null);
            expect(publishAdminStateSpy).not.toHaveBeenCalled();
        });

        it('falls back to defaultRetentionDays when the channel has no storageDays', async () => {
            const age = (CONFIG.storage.defaultRetentionDays - 10) * DAY; // past 0.8×default
            const channel = makeChannel({ storageDays: null, adminTs: Date.now() - age });
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(publishAdminStateSpy).toHaveBeenCalled();
        });
    });

    describe('PASSWORD_CHALLENGE branch', () => {
        it('skips non-password channels', async () => {
            await channelManager._ttlRepublishOnOpen(makeChannel(), ADMIN_ID, null);
            expect(streamrController.verifyPasswordChallenge).not.toHaveBeenCalled();
        });

        it('keeps the legacy redundancy semantics: republishes when not found', async () => {
            streamrController.verifyPasswordChallenge.mockResolvedValue({ found: false, valid: false, ts: 0 });
            await channelManager._ttlRepublishOnOpen(makeChannel({ type: 'password' }), ADMIN_ID, 'pw');
            expect(streamrController.publishPasswordChallenge).toHaveBeenCalledWith(ADMIN_ID, 'pw');
        });

        it('republishes when the retained entry does not verify', async () => {
            streamrController.verifyPasswordChallenge.mockResolvedValue({ found: true, valid: false, ts: 0 });
            await channelManager._ttlRepublishOnOpen(makeChannel({ type: 'password' }), ADMIN_ID, 'pw');
            expect(streamrController.publishPasswordChallenge).toHaveBeenCalledWith(ADMIN_ID, 'pw');
        });

        it('republishes a valid challenge nearing TTL', async () => {
            streamrController.verifyPasswordChallenge.mockResolvedValue({ found: true, valid: true, ts: OLD_TS() });
            await channelManager._ttlRepublishOnOpen(makeChannel({ type: 'password' }), ADMIN_ID, 'pw');
            expect(streamrController.publishPasswordChallenge).toHaveBeenCalledWith(ADMIN_ID, 'pw');
        });

        it('leaves a fresh valid challenge alone', async () => {
            streamrController.verifyPasswordChallenge.mockResolvedValue({ found: true, valid: true, ts: FRESH_TS() });
            await channelManager._ttlRepublishOnOpen(makeChannel({ type: 'password' }), ADMIN_ID, 'pw');
            expect(streamrController.publishPasswordChallenge).not.toHaveBeenCalled();
        });

        it('never republishes on a ts-less valid verdict (legacy safety)', async () => {
            streamrController.verifyPasswordChallenge.mockResolvedValue({ found: true, valid: true, ts: 0 });
            await channelManager._ttlRepublishOnOpen(makeChannel({ type: 'password' }), ADMIN_ID, 'pw');
            expect(streamrController.publishPasswordChallenge).not.toHaveBeenCalled();
        });
    });

    describe('CHANNEL_IMAGE branch', () => {
        const RETAINED = (ts, extra = {}) => ({
            type: 'CHANNEL_IMAGE', v: 1, rev: 7, ts,
            createdBy: '0xmyaddress', encrypted: false,
            mime: 'image/jpeg', hash: 'abc123', data: 'data:image/jpeg;base64,xxx',
            ...extra
        });

        it('republishes the retained payload with rev+1 and a fresh ts', async () => {
            const old = OLD_TS();
            streamrController.resendChannelImage.mockResolvedValue(RETAINED(old));
            const channel = makeChannel();
            const before = Date.now();
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);

            expect(streamrController.publishChannelImage).toHaveBeenCalledTimes(1);
            const [adminId, payload, password] = streamrController.publishChannelImage.mock.calls[0];
            expect(adminId).toBe(ADMIN_ID);
            expect(payload.rev).toBe(8);
            expect(payload.ts).toBeGreaterThanOrEqual(before);
            expect(payload.hash).toBe('abc123');
            expect(payload.data).toBe('data:image/jpeg;base64,xxx');
            expect(password).toBeNull();
            expect(channel.channelImageRev).toBe(8);
            expect(channelImageManager.setLocal).toHaveBeenCalledWith(ADMIN_ID, expect.objectContaining({
                hash: 'abc123', rev: 8
            }));
        });

        it('does not republish a fresh image', async () => {
            streamrController.resendChannelImage.mockResolvedValue(RETAINED(FRESH_TS()));
            await channelManager._ttlRepublishOnOpen(makeChannel(), ADMIN_ID, null);
            expect(streamrController.publishChannelImage).not.toHaveBeenCalled();
        });

        it('does not publish when nothing is retained (no cache resurrection)', async () => {
            streamrController.resendChannelImage.mockResolvedValue(null);
            await channelManager._ttlRepublishOnOpen(makeChannel(), ADMIN_ID, null);
            expect(streamrController.publishChannelImage).not.toHaveBeenCalled();
        });

        it('re-encrypts with the channel password when the payload was encrypted', async () => {
            streamrController.resendChannelImage.mockResolvedValue(RETAINED(OLD_TS(), { encrypted: true }));
            await channelManager._ttlRepublishOnOpen(makeChannel({ type: 'password' }), ADMIN_ID, 'pw');
            const [, , password] = streamrController.publishChannelImage.mock.calls[0];
            expect(password).toBe('pw');
        });

        it('skips an encrypted payload when no password is available', async () => {
            streamrController.resendChannelImage.mockResolvedValue(RETAINED(OLD_TS(), { encrypted: true }));
            await channelManager._ttlRepublishOnOpen(makeChannel(), ADMIN_ID, null);
            expect(streamrController.publishChannelImage).not.toHaveBeenCalled();
        });
    });

    describe('retention source', () => {
        // The purge applies the -3 stream's retention. `channel.storageDays`
        // is the -1 value requested at creation, is absent on joined records
        // and does not survive a reload, so trusting it disarms the republish
        // on every channel whose real retention is shorter than the default.
        const AGE = (days) => Date.now() - days * DAY;

        it('uses the -3 retention from the chain, not the local storageDays', async () => {
            graphAPI.getStream.mockResolvedValue(streamMetadata(3));
            // 2.9d is fresh under the local 180d (threshold 144d) and stale
            // under the real 3d (threshold 2.4d).
            const channel = makeChannel({ storageDays: 180, adminTs: AGE(2.9) });
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(publishAdminStateSpy).toHaveBeenCalled();
        });

        it('reads the admin stream, not the message stream', async () => {
            graphAPI.getStream.mockResolvedValue(streamMetadata(3));
            await channelManager._ttlRepublishOnOpen(makeChannel(), ADMIN_ID, null);
            expect(graphAPI.getStream).toHaveBeenCalledWith(ADMIN_ID);
            expect(graphAPI.getStream).not.toHaveBeenCalledWith(STREAM_ID);
        });

        it('does not look up the retention for non-owners', async () => {
            await channelManager._ttlRepublishOnOpen(
                makeChannel({ createdBy: '0xsomeoneelse' }), ADMIN_ID, null);
            expect(graphAPI.getStream).not.toHaveBeenCalled();
        });

        it('caches the resolved retention on the channel and persists it', async () => {
            graphAPI.getStream.mockResolvedValue(streamMetadata(7));
            const channel = makeChannel();
            channelManager.channels.set(STREAM_ID, channel);
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(channel.adminStorageDays).toBe(7);
            expect(secureStorage.setChannels).toHaveBeenCalledWith(
                expect.arrayContaining([expect.objectContaining({ adminStorageDays: 7 })])
            );
        });

        it('does not re-persist when the retention is unchanged', async () => {
            graphAPI.getStream.mockResolvedValue(streamMetadata(7));
            const channel = makeChannel({ adminStorageDays: 7 });
            channelManager.channels.set(STREAM_ID, channel);
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(secureStorage.setChannels).not.toHaveBeenCalled();
        });

        it('falls back to the cached retention when the Graph is unreachable', async () => {
            graphAPI.getStream.mockRejectedValue(new Error('graph down'));
            const channel = makeChannel({ storageDays: 180, adminStorageDays: 3, adminTs: AGE(2.9) });
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(publishAdminStateSpy).toHaveBeenCalled();
        });

        it('falls back to the local storageDays when nothing was ever cached', async () => {
            graphAPI.getStream.mockRejectedValue(new Error('graph down'));
            const channel = makeChannel({ storageDays: 10, adminTs: AGE(9) });
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(publishAdminStateSpy).toHaveBeenCalled();
        });

        it('falls back to the default when no retention is known anywhere', async () => {
            graphAPI.getStream.mockRejectedValue(new Error('graph down'));
            const age = (CONFIG.storage.defaultRetentionDays - 10) * DAY;
            const channel = makeChannel({ storageDays: null, adminTs: Date.now() - age });
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(publishAdminStateSpy).toHaveBeenCalled();
        });

        it('ignores metadata without a retention instead of reading it as zero', async () => {
            graphAPI.getStream.mockResolvedValue(streamMetadata(undefined));
            const channel = makeChannel({ storageDays: 10, adminStorageDays: null, adminTs: AGE(9) });
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(channel.adminStorageDays).toBeNull();
            expect(publishAdminStateSpy).toHaveBeenCalled();
        });

        it('ignores unparseable metadata', async () => {
            graphAPI.getStream.mockResolvedValue({ metadata: 'not json' });
            const channel = makeChannel({ storageDays: 10, adminTs: AGE(9) });
            await channelManager._ttlRepublishOnOpen(channel, ADMIN_ID, null);
            expect(publishAdminStateSpy).toHaveBeenCalled();
        });
    });
});

describe('setChannelStorageDays() local sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        channelManager.channels.clear();
    });

    it('updates channel.storageDays after a successful on-chain update', async () => {
        const channel = {
            messageStreamId: 's-1', adminStreamId: 's-3',
            name: 'T', type: 'public', storageDays: 180
        };
        channelManager.channels.set('s-1', channel);
        streamrController.setStorageDays.mockResolvedValue(true);

        await channelManager.setChannelStorageDays('s-1', 30);
        expect(channel.storageDays).toBe(30);
    });

    it('keeps the old value when the on-chain update fails', async () => {
        const channel = {
            messageStreamId: 's-1', adminStreamId: 's-3',
            name: 'T', type: 'public', storageDays: 180
        };
        channelManager.channels.set('s-1', channel);
        streamrController.setStorageDays.mockResolvedValue(false);

        await channelManager.setChannelStorageDays('s-1', 30);
        expect(channel.storageDays).toBe(180);
    });

    it('updates the cached -3 retention alongside the message one', async () => {
        const channel = {
            messageStreamId: 's-1', adminStreamId: 's-3',
            name: 'T', type: 'public', storageDays: 180, adminStorageDays: 180
        };
        channelManager.channels.set('s-1', channel);
        streamrController.setStorageDays.mockResolvedValue(true);

        await channelManager.setChannelStorageDays('s-1', 30);
        expect(channel.adminStorageDays).toBe(30);
    });

    it('updates each stream independently when one of the two fails', async () => {
        const channel = {
            messageStreamId: 's-1', adminStreamId: 's-3',
            name: 'T', type: 'public', storageDays: 180, adminStorageDays: 180
        };
        channelManager.channels.set('s-1', channel);
        // Message first, admin second.
        streamrController.setStorageDays
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);

        await channelManager.setChannelStorageDays('s-1', 30);
        expect(channel.storageDays).toBe(180);
        expect(channel.adminStorageDays).toBe(30);
    });

    // A gated channel's KEY_ANNOUNCEs live on the -4 and age out by its own
    // retention. Leaving it out of the update lets it purge on a schedule
    // nobody chose, while the settings panel reports success.
    describe('keys stream (-4)', () => {
        const gated = (extra = {}) => ({
            messageStreamId: 's-1', adminStreamId: 's-3', keysStreamId: 's-4',
            name: 'T', type: 'gated', gate: { address: '0xgate' },
            storageDays: 180, adminStorageDays: 180, keysStorageDays: 180, ...extra
        });

        it('applies the retention to the keys stream too', async () => {
            channelManager.channels.set('s-1', gated());
            streamrController.setStorageDays.mockResolvedValue(true);

            const result = await channelManager.setChannelStorageDays('s-1', 30);
            expect(streamrController.setStorageDays).toHaveBeenCalledWith('s-4', 30);
            expect(result.keys).toBe(true);
        });

        it('derives the keys stream when the record does not carry it', async () => {
            channelManager.channels.set('s-1', gated({ keysStreamId: undefined }));
            streamrController.setStorageDays.mockResolvedValue(true);

            await channelManager.setChannelStorageDays('s-1', 30);
            expect(streamrController.setStorageDays).toHaveBeenCalledWith('s-1-keys', 30);
        });

        it('caches the keys retention only when its own update succeeded', async () => {
            const channel = gated();
            channelManager.channels.set('s-1', channel);
            // Message, admin, keys — in that order.
            streamrController.setStorageDays
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false);

            const result = await channelManager.setChannelStorageDays('s-1', 30);
            expect(channel.storageDays).toBe(30);
            expect(channel.adminStorageDays).toBe(30);
            expect(channel.keysStorageDays).toBe(180);
            expect(result.keys).toBe(false);
        });

        it('reports null rather than false for a channel with no keys stream', async () => {
            channelManager.channels.set('s-1', {
                messageStreamId: 's-1', adminStreamId: 's-3', name: 'T', type: 'public'
            });
            streamrController.setStorageDays.mockResolvedValue(true);

            const result = await channelManager.setChannelStorageDays('s-1', 30);
            expect(result.keys).toBeNull();
            expect(streamrController.setStorageDays).toHaveBeenCalledTimes(2);
        });
    });
});

describe('saveChannels() retention persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        channelManager.channels.clear();
    });

    // Unsaved, every reload reverts these to the 180-day default and disarms
    // both the TTL republish and the epoch-key re-announce.
    it('persists the retention of all three stored streams', async () => {
        channelManager.channels.set('s-1', {
            messageStreamId: 's-1', adminStreamId: 's-3', keysStreamId: 's-4',
            name: 'T', type: 'gated',
            storageDays: 30, adminStorageDays: 20, keysStorageDays: 10
        });

        await channelManager.saveChannels();
        expect(secureStorage.setChannels).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({
                storageDays: 30, adminStorageDays: 20, keysStorageDays: 10
            })])
        );
    });

    it('writes null rather than dropping an unresolved retention', async () => {
        channelManager.channels.set('s-1', {
            messageStreamId: 's-1', adminStreamId: 's-3', name: 'T', type: 'public'
        });

        await channelManager.saveChannels();
        const [saved] = secureStorage.setChannels.mock.calls[0][0];
        expect(saved.storageDays).toBeNull();
        expect(saved.adminStorageDays).toBeNull();
        expect(saved.keysStorageDays).toBeNull();
    });
});

describe('channelManager._resolveKeysRetention()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        channelManager.channels.clear();
        graphAPI.getStream.mockResolvedValue(null);
    });

    const gated = (extra = {}) => ({
        messageStreamId: 's-1', keysStreamId: 's-4',
        name: 'T', type: 'gated', storageDays: 180, ...extra
    });

    it('reads the keys stream, not the message or admin one', async () => {
        graphAPI.getStream.mockResolvedValue(streamMetadata(7));
        await channelManager._resolveKeysRetention(gated());
        expect(graphAPI.getStream).toHaveBeenCalledWith('s-4');
        expect(graphAPI.getStream).toHaveBeenCalledTimes(1);
    });

    it('caches the resolved retention and persists it', async () => {
        graphAPI.getStream.mockResolvedValue(streamMetadata(7));
        const channel = gated();
        channelManager.channels.set('s-1', channel);

        await channelManager._resolveKeysRetention(channel);
        expect(channel.keysStorageDays).toBe(7);
        expect(secureStorage.setChannels).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ keysStorageDays: 7 })])
        );
    });

    it('does not re-persist an unchanged retention', async () => {
        graphAPI.getStream.mockResolvedValue(streamMetadata(7));
        await channelManager._resolveKeysRetention(gated({ keysStorageDays: 7 }));
        expect(secureStorage.setChannels).not.toHaveBeenCalled();
    });

    it('leaves the cached value alone when the Graph is unreachable', async () => {
        graphAPI.getStream.mockRejectedValue(new Error('graph down'));
        const channel = gated({ keysStorageDays: 3 });
        await channelManager._resolveKeysRetention(channel);
        expect(channel.keysStorageDays).toBe(3);
        expect(secureStorage.setChannels).not.toHaveBeenCalled();
    });

    it('derives the keys stream when the record does not carry it', async () => {
        graphAPI.getStream.mockResolvedValue(streamMetadata(7));
        await channelManager._resolveKeysRetention(gated({ keysStreamId: undefined }));
        expect(graphAPI.getStream).toHaveBeenCalledWith('s-1-keys');
    });

    // Opening the channel is the only thing that refreshes this value: the
    // sweep that consumes it runs every 45s and never looks it up.
    it('runs when a gated channel is wired into the epoch-key protocol', async () => {
        const resolve = vi.spyOn(channelManager, '_resolveKeysRetention').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, 'onKeyAdopted').mockImplementation(() => {});
        vi.spyOn(epochKeyManager, 'loadPersistedState').mockImplementation(() => {});
        vi.spyOn(epochKeyManager, 'hasCurrentKey').mockReturnValue(true);
        vi.spyOn(epochKeyManager, 'ensureChannelKeys').mockResolvedValue(undefined);

        const channel = gated();
        try {
            await channelManager._setupEpochKeys(channel);
            expect(resolve).toHaveBeenCalledWith(channel);
        } finally {
            vi.restoreAllMocks();
        }
    });
});
