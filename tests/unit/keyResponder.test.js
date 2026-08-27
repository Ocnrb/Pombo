/**
 * Owner key-responder policy:
 *
 *  - The marked set is per device AND per address (plain localStorage, never
 *    synced): serving keys is a duty of the chosen device, not the account.
 *  - The key-request wake is a normal native wake with channelType 'keys' —
 *    same tag, same PoW — so the relay forwards it untouched and pre-'keys'
 *    receivers verify-and-discard it silently.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { keyResponder } = await import('../../src/js/keyResponder.js');
const { authManager } = await import('../../src/js/auth.js');
const {
    createKeysNotificationPayload,
    calculateNativeChannelTag,
    verifyPoW
} = await import('../../src/js/pushProtocol.js');

const ADDR_A = '0x' + 'aa'.repeat(20);
const ADDR_B = '0x' + 'bb'.repeat(20);
const STREAM = '0xaaa/responder-test-1';

describe('keyResponder marked set', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        keyResponder.stop();
    });

    it('marks and unmarks per device, keyed by address', () => {
        const addr = vi.spyOn(authManager, 'getAddress').mockReturnValue(ADDR_A);
        // Avoid the immediate sweep hitting the network in tests
        vi.spyOn(keyResponder, 'sweepNow').mockImplementation(() => {});

        expect(keyResponder.isMarked(STREAM)).toBe(false);
        keyResponder.setMarked(STREAM, true);
        expect(keyResponder.isMarked(STREAM)).toBe(true);

        // Another account on the same device sees nothing
        addr.mockReturnValue(ADDR_B);
        expect(keyResponder.isMarked(STREAM)).toBe(false);

        addr.mockReturnValue(ADDR_A);
        keyResponder.setMarked(STREAM, false);
        expect(keyResponder.isMarked(STREAM)).toBe(false);
    });

    it('start() is a no-op with nothing marked', () => {
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ADDR_A);
        keyResponder.start();
        expect(keyResponder.timer).toBeNull();
    });
});

describe('key-request wake payload', () => {
    it('is a native wake with channelType keys and a valid PoW', async () => {
        const payload = await createKeysNotificationPayload(STREAM, 1);
        expect(payload.type).toBe('notification');
        expect(payload.channelType).toBe('keys');
        expect(payload.tag).toBe(calculateNativeChannelTag(STREAM));
        expect(verifyPoW(payload.pow, payload.tag, payload.nonce, payload.epoch, 1)).toBe(true);
    });
});
