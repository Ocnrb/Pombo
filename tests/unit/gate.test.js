/**
 * gateManager — checkAccess caching and fail-closed behaviour.
 *
 * The eth_call itself is the chain's business (pinned by the Foundry suite in
 * Pombo Contracts); what the client owns is the cache discipline — one call
 * per (gate, user) per TTL, invalidation after moderation txs, and NO ACCESS
 * on RPC failure (an outage must never hand an epoch key to an ex-member).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { gateManager, GATE_MODE } = await import('../../src/js/gate.js');
const { CONFIG } = await import('../../src/js/config.js');

const GATE = '0xf7ad70759e314f89fa150c60968df74a2550fac8';
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';

describe('gateManager.checkAccess', () => {
    let calls;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_755_000_000_000);
        calls = [];
        gateManager._accessCache.clear();
        // No real JsonRpcProvider under vitest — the op gets a null provider
        // and the contract stub below answers.
        gateManager._withProvider = (op) => op(null);
        gateManager._readContract = (gateAddress) => ({
            checkAccess: async (user) => {
                calls.push([gateAddress, user]);
                return user.toLowerCase() === ALICE;
            }
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete gateManager._readContract; // restore prototype methods
        delete gateManager._withProvider;
    });

    it('returns the chain answer and caches it for the TTL', async () => {
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(true);
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(true);
        expect(calls.length).toBe(1);

        vi.advanceTimersByTime(CONFIG.gate.checkAccessCacheMs + 1);
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(true);
        expect(calls.length).toBe(2);
    });

    it('caches negative answers too (no hammering the RPC for strangers)', async () => {
        expect(await gateManager.checkAccess(GATE, BOB)).toBe(false);
        expect(await gateManager.checkAccess(GATE, BOB)).toBe(false);
        expect(calls.length).toBe(1);
    });

    it('invalidateAccess(gate, user) drops exactly that entry', async () => {
        await gateManager.checkAccess(GATE, ALICE);
        await gateManager.checkAccess(GATE, BOB);
        gateManager.invalidateAccess(GATE, ALICE);
        await gateManager.checkAccess(GATE, ALICE);
        await gateManager.checkAccess(GATE, BOB);
        expect(calls.length).toBe(3); // Alice refetched, Bob still cached
    });

    it('fails CLOSED when the RPC errors, and does not cache the failure', async () => {
        gateManager._readContract = () => ({
            checkAccess: async () => { throw new Error('rpc down'); }
        });
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(false);

        // RPC recovers → next call answers truthfully (failure was not cached)
        gateManager._readContract = () => ({
            checkAccess: async () => true
        });
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(true);
    });
});

describe('gateManager._makeProvider', () => {
    it('unwraps Streamr-shaped endpoint entries ({ url }) into a URL string', () => {
        // Regression: passing the raw { url } object made JsonRpcProvider
        // treat it as a FetchRequest → "url.clone is not a function" on the
        // very first gate transaction in the running app.
        const provider = gateManager._makeProvider();
        const connection = provider._getConnection();
        expect(typeof connection.url).toBe('string');
        expect(connection.url).toMatch(/^https?:\/\//);
    });
});

describe('GATE_MODE', () => {
    it('mirrors the on-chain enum order (ABI compatibility)', () => {
        expect(GATE_MODE.NONE).toBe(0);
        expect(GATE_MODE.TOKEN_BALANCE).toBe(1);
        expect(GATE_MODE.NFT_OWNERSHIP).toBe(2);
        expect(GATE_MODE.PAID).toBe(3);
    });
});
