// @vitest-environment node
// (jsdom swaps the Uint8Array realm and the SDK's binary/UserID checks — and
// ethers' BytesLike checks — start failing on their own values; same issue
// noted in publisherProof.test.js. The SDK parity suite needs plain node.)
/**
 * envelopeSigner — authorship recovery for gated channels (N-C).
 *
 * PARITY SUITE: messages are built with the SDK's OWN MessageSigner (the same
 * code path publishAs uses in production) and recovery is asserted against
 * the signing wallet. If an SDK upgrade changes the signature payload layout
 * or the digest scheme, these tests fail loudly — the alternative is silent
 * author misattribution in every gated channel.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

import {
    MessageSigner,
    MessageID,
    MessageRef,
    EthereumKeyPairIdentity,
    StreamMessageType,
    ContentType,
    EncryptionType,
    SignatureType
} from '@streamr/sdk';

const { recoverEnvelopeSigner, buildEnvelopePayload } =
    await import('../../src/js/envelopeSigner.js');

const GATE = '0xf7ad70759e314f89fa150c60968df74a2550fac8';
const STREAM = '0x1111111111111111111111111111111111111111/abc123-1';

describe('envelopeSigner (SDK parity)', () => {
    let wallet, identity, signer;

    beforeAll(() => {
        wallet = new ethers.Wallet('0x' + '22'.repeat(32));
        identity = EthereumKeyPairIdentity.fromPrivateKey(wallet.privateKey);
        signer = new MessageSigner(identity);
    });

    async function signedMessage({
        publisherId = GATE,
        signatureType = SignatureType.ERC_1271,
        content = new TextEncoder().encode(JSON.stringify({ hello: 'gate' })),
        prevMsgRef = undefined,
        timestamp = 1_755_000_000_000
    } = {}) {
        const messageId = new MessageID(STREAM, 0, timestamp, 0, publisherId, 'chain-1');
        return signer.createSignedMessage({
            messageId,
            prevMsgRef,
            content,
            contentType: ContentType.JSON,
            encryptionType: EncryptionType.NONE,
            messageType: StreamMessageType.MESSAGE
        }, signatureType);
    }

    it('recovers the signing wallet from an ERC-1271 message (publisherId = gate clone)', async () => {
        const msg = await signedMessage();
        expect(recoverEnvelopeSigner(msg)).toBe(wallet.address.toLowerCase());
    });

    it('recovers the signing wallet from a plain EVM-signed message', async () => {
        const userId = await identity.getUserId();
        const msg = await signedMessage({
            publisherId: userId,
            signatureType: SignatureType.ECDSA_SECP256K1_EVM
        });
        expect(recoverEnvelopeSigner(msg)).toBe(wallet.address.toLowerCase());
    });

    it('includes prevMsgRef in the recovered payload (chained messages)', async () => {
        const msg = await signedMessage({
            prevMsgRef: new MessageRef(1_754_999_999_000, 3)
        });
        expect(recoverEnvelopeSigner(msg)).toBe(wallet.address.toLowerCase());
    });

    it('recovers binary-content messages', async () => {
        const msg = await signedMessage({
            content: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
        });
        expect(recoverEnvelopeSigner(msg)).toBe(wallet.address.toLowerCase());
    });

    it('unwraps the public Message wrapper (live callbacks and resend iterators)', async () => {
        // Live subscriptions and client.resend hand the app a `Message`
        // wrapper whose raw StreamMessage sits in `.streamMessage` — found
        // live: the -4 resend dropped the admin's own KEY_ANNOUNCE as
        // "unrecoverable" because the wrapper has no messageId of its own.
        const msg = await signedMessage();
        const wrapper = {
            content: { hello: 'gate' },       // parsed, not bytes
            publisherId: GATE,
            streamMessage: msg
        };
        expect(recoverEnvelopeSigner(wrapper)).toBe(wallet.address.toLowerCase());
    });

    it('a tampered content stops naming the signer', async () => {
        const msg = await signedMessage();
        const tampered = Object.create(
            Object.getPrototypeOf(msg),
            Object.getOwnPropertyDescriptors(msg)
        );
        Object.defineProperty(tampered, 'content', {
            value: new TextEncoder().encode(JSON.stringify({ hello: 'forged' })),
            writable: false
        });
        const recovered = recoverEnvelopeSigner(tampered);
        // ecrecover over a different digest yields SOME address, never the wallet
        expect(recovered).not.toBe(wallet.address.toLowerCase());
    });

    it('returns null for malformed signatures', async () => {
        const msg = await signedMessage();
        const broken = Object.create(
            Object.getPrototypeOf(msg),
            Object.getOwnPropertyDescriptors(msg)
        );
        Object.defineProperty(broken, 'signature', { value: new Uint8Array(10) });
        expect(recoverEnvelopeSigner(broken)).toBe(null);
        expect(recoverEnvelopeSigner(null)).toBe(null);
        expect(recoverEnvelopeSigner({})).toBe(null);
    });

    it('payload layout: header ‖ content, header is the exact SDK field concatenation', async () => {
        const msg = await signedMessage();
        const payload = buildEnvelopePayload(msg);
        const expectedHeader = `${STREAM}0${1_755_000_000_000}0${GATE}chain-1`;
        const headerBytes = new TextEncoder().encode(expectedHeader);
        expect(Array.from(payload.slice(0, headerBytes.length)))
            .toEqual(Array.from(headerBytes));
        expect(payload.length).toBe(headerBytes.length + msg.content.length);
    });
});
