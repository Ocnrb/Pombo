/**
 * Members-only authorship wrapper:
 *
 *  - The payload travels as the exact signed STRING (`p`); the author is
 *    recovered from the bind proof, the pseudonym only signs messages.
 *  - Forgery is impossible without BOTH keys: pasting someone else's bind
 *    proof onto your own message fails (sig recovers to YOUR pseudonym, the
 *    proof binds THEIRS), and reusing a proof in another channel fails (the
 *    digests are channel-scoped).
 *  - Cross-client parity locked by fixed vectors
 *    (docs/GATED-CHANNELS-authorship-vectors.json).
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { authorship } = await import('../../src/js/authorship.js');

const VEC = {
    accountPriv: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    author: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    pseudonymPriv: '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e01',
    streamId: '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1',
    wrapper: {
        v: 1,
        p: '{"type":"text","id":"msg-0001","text":"olá autoria selada","timestamp":1787000000000}',
        pk: '0x03126e8824ff1ce4bbf18352df62dc12687ea5613f046a32a3bcfc268b2b5b0a30',
        sig: '0xe8ab29125cb8a9e7f5a9762494b56dcb525e03f92eb60ce720c3d8cf1ce35f6f4aad074a93d38a051aab3d9973c99b87700c7d52b90e540a94524ac60df3e6391b',
        bp: '0x6bedd9ed7332468bc2da2e4e29b600ba128c8705144bd5b9ac92c0eb09eeb96e40b6c9734a56575641c88f22dd6a4eea0f74c158652da6888920acb2cafbf0721c'
    }
};

describe('authorship wrapper (parity vectors)', () => {
    it('opens the fixed vector to the exact author and payload', () => {
        const opened = authorship.open(VEC.streamId, VEC.wrapper);
        expect(opened).not.toBeNull();
        expect(opened.author).toBe(VEC.author);
        expect(opened.payload.text).toBe('olá autoria selada');
        expect(opened.payload.timestamp).toBe(1787000000000);
    });

    it('round-trips seal → open', () => {
        const pseudonym = authorship.generatePseudonym();
        const bp = authorship.createBindProof(VEC.streamId, pseudonym.publicKey, VEC.accountPriv);
        const wrapper = authorship.seal(
            VEC.streamId, { type: 'text', id: 'x', text: 'hello' }, pseudonym, bp);
        const opened = authorship.open(VEC.streamId, wrapper);
        expect(opened?.author).toBe(VEC.author);
        expect(opened?.payload.text).toBe('hello');
    });

    it('rejects a tampered payload', () => {
        const tampered = { ...VEC.wrapper, p: VEC.wrapper.p.replace('selada', 'forjada') };
        expect(authorship.open(VEC.streamId, tampered)).toBeNull();
    });

    it('a pasted bind proof can never impersonate its owner', () => {
        // Attacker signs their own message with their own pseudonym but
        // pastes the victim's bind proof. ecrecover always yields SOME
        // address, so the message is not dropped here — but the recovered
        // author is meaningless garbage, never the victim: the digest is
        // over the ATTACKER's pseudonym, and forging a signature that
        // recovers to a chosen account is exactly the hard problem. Garbage
        // non-member authors are then cut by the live gate check.
        const attacker = authorship.generatePseudonym();
        const forged = authorship.seal(
            VEC.streamId, { type: 'text', id: 'f', text: 'not me' },
            attacker, VEC.wrapper.bp);
        const opened = authorship.open(VEC.streamId, forged);
        expect(opened?.author).not.toBe(VEC.author);
    });

    it('rejects a proof replayed into another channel (channel-scoped digests)', () => {
        const otherStream = '0x' + '99'.repeat(20) + '/other-1';
        expect(authorship.open(otherStream, VEC.wrapper)).toBeNull();
    });

    it('non-wrappers are not mistaken for wrappers', () => {
        expect(authorship.isWrapper({ type: 'text', text: 'hi' })).toBe(false);
        expect(authorship.isWrapper(VEC.wrapper)).toBe(true);
    });
});
