/**
 * channelIdentity — one throwaway publisher per channel session (D2).
 *
 * The properties under test: the same channel keeps one pseudonym while it is
 * open, two channels never share one, and the proof it carries names the real
 * account. Real secp256k1 — the whole point is that the binding verifies.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const account = new ethers.Wallet('0x' + '11'.repeat(32));

vi.mock('../../src/js/auth.js', () => ({
    authManager: { wallet: { privateKey: '0x' + '11'.repeat(32) } }
}));

const {
    getChannelIdentity, dropChannelIdentity, clearChannelIdentities,
    hasChannelIdentity, baseChannelId
} = await import('../../src/js/channelIdentity.js');
const { recoverPublisherAccount } = await import('../../src/js/publisherProof.js');

describe('channelIdentity', () => {
    beforeAll(() => {
        // The SDK identity is irrelevant here; only the key material matters.
        window.EthereumKeyPairIdentity = {
            fromPrivateKey: (pk) => ({ __identity: true, privateKey: pk })
        };
    });

    beforeEach(() => clearChannelIdentities());

    it('keeps one identity for a channel while it stays open', () => {
        const a = getChannelIdentity('0xowner/chan-1');
        const b = getChannelIdentity('0xowner/chan-1');

        expect(b.publisherId).toBe(a.publisherId);
        expect(b.identity).toBe(a.identity);
    });

    it('shares one identity across the channel\'s three streams', () => {
        // Messages, media signals and admin traffic must not split a member
        // into three pseudonyms — that would hand an observer the correlation.
        const message = getChannelIdentity('0xowner/chan-1');
        const ephemeral = getChannelIdentity('0xowner/chan-2');
        const admin = getChannelIdentity('0xowner/chan-3');

        expect(ephemeral.publisherId).toBe(message.publisherId);
        expect(admin.publisherId).toBe(message.publisherId);
    });

    it('gives different channels different publishers', () => {
        const one = getChannelIdentity('0xowner/alpha-1');
        const two = getChannelIdentity('0xowner/beta-1');

        expect(one.publisherId).not.toBe(two.publisherId);
    });

    it('carries a proof that names the real account', () => {
        const { publisherId, proof } = getChannelIdentity('0xowner/chan-1');

        expect(recoverPublisherAccount(publisherId, proof))
            .toBe(account.address.toLowerCase());
    });

    it('never exposes the account as the publisher', () => {
        const { publisherId } = getChannelIdentity('0xowner/chan-1');
        expect(publisherId.toLowerCase()).not.toBe(account.address.toLowerCase());
    });

    it('rotates on re-entry after being dropped', () => {
        const before = getChannelIdentity('0xowner/chan-1');
        dropChannelIdentity('0xowner/chan-1');
        const after = getChannelIdentity('0xowner/chan-1');

        expect(after.publisherId).not.toBe(before.publisherId);
    });

    it('drops by any of the channel\'s stream ids', () => {
        getChannelIdentity('0xowner/chan-1');
        dropChannelIdentity('0xowner/chan-2');

        expect(hasChannelIdentity('0xowner/chan-1')).toBe(false);
    });

    it('leaves other channels alone when one is dropped', () => {
        const other = getChannelIdentity('0xowner/beta-1');
        getChannelIdentity('0xowner/alpha-1');

        dropChannelIdentity('0xowner/alpha-1');

        expect(getChannelIdentity('0xowner/beta-1').publisherId).toBe(other.publisherId);
    });

    it('normalises any stream suffix to the channel', () => {
        expect(baseChannelId('0xowner/chan-1')).toBe('0xowner/chan');
        expect(baseChannelId('0xowner/chan-2')).toBe('0xowner/chan');
        expect(baseChannelId('0xowner/chan-3')).toBe('0xowner/chan');
        expect(baseChannelId(null)).toBeNull();
    });

    it('refuses to build an identity without a stream id', () => {
        expect(() => getChannelIdentity(null)).toThrow('no stream id');
    });
});
