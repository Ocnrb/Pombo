/**
 * Tests for channelEntry.js — the routing shared by the Explore card tap and
 * the `#/channel/<streamId>` deep link.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateManager = {
    getGateInfo: vi.fn(),
    checkAccess: vi.fn()
};
const authManager = { getAddress: vi.fn() };

vi.mock('../../src/js/gate.js', () => ({
    gateManager,
    GATE_MODE: { NONE: 0, TOKEN_BALANCE: 1, NFT_OWNERSHIP: 2, PAID: 3 }
}));
vi.mock('../../src/js/auth.js', () => ({ authManager }));
vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { openUnjoinedChannel } = await import('../../src/js/channelEntry.js');

const makeDeps = () => ({
    enterPreviewMode: vi.fn().mockResolvedValue(undefined),
    joinPublicChannel: vi.fn().mockResolvedValue(undefined)
});

describe('openUnjoinedChannel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authManager.getAddress.mockReturnValue('0xme');
    });

    it('previews a public channel', async () => {
        const deps = makeDeps();
        await openUnjoinedChannel('s1', { type: 'public' }, deps);

        expect(deps.enterPreviewMode).toHaveBeenCalledWith('s1', { type: 'public' });
        expect(deps.joinPublicChannel).not.toHaveBeenCalled();
    });

    it('treats missing metadata as public — a link to an unindexed channel still opens', async () => {
        const deps = makeDeps();
        await openUnjoinedChannel('s1', null, deps);

        expect(deps.enterPreviewMode).toHaveBeenCalledWith('s1', null);
    });

    it('sends a password channel to the join flow, which prompts', async () => {
        const deps = makeDeps();
        await openUnjoinedChannel('s1', { type: 'password' }, deps);

        expect(deps.joinPublicChannel).toHaveBeenCalledWith('s1', { type: 'password' });
        expect(deps.enterPreviewMode).not.toHaveBeenCalled();
    });

    it('previews a token gate the user holds', async () => {
        const deps = makeDeps();
        gateManager.getGateInfo.mockResolvedValue({ mode: 1 });
        gateManager.checkAccess.mockResolvedValue(true);

        await openUnjoinedChannel('s1', { type: 'gated', gateAddress: '0xgate' }, deps);

        expect(deps.enterPreviewMode).toHaveBeenCalled();
        expect(deps.joinPublicChannel).not.toHaveBeenCalled();
    });

    it('sends a token gate the user does NOT hold to the join flow', async () => {
        const deps = makeDeps();
        gateManager.getGateInfo.mockResolvedValue({ mode: 1 });
        gateManager.checkAccess.mockResolvedValue(false);

        await openUnjoinedChannel('s1', { type: 'gated', gateAddress: '0xgate' }, deps);

        expect(deps.joinPublicChannel).toHaveBeenCalled();
        expect(deps.enterPreviewMode).not.toHaveBeenCalled();
    });

    it('never previews a paid gate, even for a holder — paying is the commitment', async () => {
        const deps = makeDeps();
        gateManager.getGateInfo.mockResolvedValue({ mode: 3 });
        gateManager.checkAccess.mockResolvedValue(true);

        await openUnjoinedChannel('s1', { type: 'gated', gateAddress: '0xgate' }, deps);

        expect(deps.joinPublicChannel).toHaveBeenCalled();
        expect(deps.enterPreviewMode).not.toHaveBeenCalled();
    });

    it('falls back to the join flow when the gate cannot be read', async () => {
        const deps = makeDeps();
        gateManager.getGateInfo.mockRejectedValue(new Error('rpc down'));

        await openUnjoinedChannel('s1', { type: 'gated', gateAddress: '0xgate' }, deps);

        expect(deps.joinPublicChannel).toHaveBeenCalled();
    });

    it('falls back to the join flow for a gated channel with no gate address', async () => {
        const deps = makeDeps();

        await openUnjoinedChannel('s1', { type: 'gated' }, deps);

        expect(deps.joinPublicChannel).toHaveBeenCalled();
        expect(gateManager.getGateInfo).not.toHaveBeenCalled();
    });

    it('sends a disconnected visitor to the join flow rather than checking access', async () => {
        const deps = makeDeps();
        authManager.getAddress.mockReturnValue(null);
        gateManager.getGateInfo.mockResolvedValue({ mode: 1 });

        await openUnjoinedChannel('s1', { type: 'gated', gateAddress: '0xgate' }, deps);

        expect(gateManager.checkAccess).not.toHaveBeenCalled();
        expect(deps.joinPublicChannel).toHaveBeenCalled();
    });
});
