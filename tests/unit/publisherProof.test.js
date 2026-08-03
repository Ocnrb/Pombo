/**
 * publisherProof — binding an ephemeral publisher to a real account.
 *
 * The property under test: a proof names its author to everyone, and cannot be
 * made to name anyone else. Real secp256k1 — mocking it would test nothing.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const {
    publisherBindDigest,
    createPublisherProof,
    recoverPublisherAccount,
    clearPublisherProofCache
} = await import('../../src/js/publisherProof.js');

describe('publisherProof', () => {
    let alice, mallory, ephemeral, otherEphemeral;

    beforeAll(() => {
        // Fixed keys, not createRandom(): under jsdom ethers' RNG returns a Node
        // Buffer that fails its own cross-realm BytesLike check.
        alice = new ethers.Wallet('0x' + '11'.repeat(32));
        mallory = new ethers.Wallet('0x' + '33'.repeat(32));
        ephemeral = new ethers.Wallet('0x' + '44'.repeat(32));
        otherEphemeral = new ethers.Wallet('0x' + '55'.repeat(32));
    });

    beforeEach(() => clearPublisherProofCache());

    it('recovers the account that signed it', () => {
        const proof = createPublisherProof(alice.privateKey, ephemeral.address);

        expect(recoverPublisherAccount(ephemeral.address, proof))
            .toBe(alice.address.toLowerCase());
    });

    it('is case-insensitive about the publisher address', () => {
        // Streamr lowercases publisherId; the signer may not have.
        const proof = createPublisherProof(alice.privateKey, ephemeral.address);

        expect(recoverPublisherAccount(ephemeral.address.toLowerCase(), proof))
            .toBe(alice.address.toLowerCase());
    });

    it('does not name the victim when lifted onto another publisher', () => {
        // The core claim. Mallory takes Alice's proof and republishes under a
        // key she controls — the digest changes, so it stops naming Alice.
        const proof = createPublisherProof(alice.privateKey, ephemeral.address);

        const recovered = recoverPublisherAccount(otherEphemeral.address, proof);

        expect(recovered).not.toBe(alice.address.toLowerCase());
        expect(recovered).not.toBe(otherEphemeral.address.toLowerCase());
    });

    it('binds each publisher to a distinct digest', () => {
        expect(publisherBindDigest(ephemeral.address))
            .not.toBe(publisherBindDigest(otherEphemeral.address));
    });

    it('returns null for a malformed proof instead of throwing', () => {
        // Untrusted input on a public stream, not an exceptional condition.
        expect(recoverPublisherAccount(ephemeral.address, 'not-a-signature')).toBeNull();
        expect(recoverPublisherAccount(ephemeral.address, '0x00')).toBeNull();
        expect(recoverPublisherAccount(ephemeral.address, null)).toBeNull();
        expect(recoverPublisherAccount(null, '0xabc')).toBeNull();
    });

    it('distinguishes two accounts proving the same publisher', () => {
        const fromAlice = createPublisherProof(alice.privateKey, ephemeral.address);
        const fromMallory = createPublisherProof(mallory.privateKey, ephemeral.address);

        expect(recoverPublisherAccount(ephemeral.address, fromAlice))
            .toBe(alice.address.toLowerCase());
        expect(recoverPublisherAccount(ephemeral.address, fromMallory))
            .toBe(mallory.address.toLowerCase());
    });

    it('caches by proof, not by publisher alone', () => {
        // A publisher whose proof changes must not keep the old identity.
        const fromAlice = createPublisherProof(alice.privateKey, ephemeral.address);
        const fromMallory = createPublisherProof(mallory.privateKey, ephemeral.address);

        expect(recoverPublisherAccount(ephemeral.address, fromAlice))
            .toBe(alice.address.toLowerCase());
        expect(recoverPublisherAccount(ephemeral.address, fromMallory))
            .toBe(mallory.address.toLowerCase());
    });

    it('refuses to build a proof without a key', () => {
        expect(() => createPublisherProof(null, ephemeral.address)).toThrow('no private key');
        expect(() => createPublisherProof(alice.privateKey, null)).toThrow('no publisher id');
    });
});
