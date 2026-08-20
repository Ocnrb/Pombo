/**
 * dmCrypto — sealed sender (v2)
 *
 * The property under test: a message reveals its sender to the recipient and to
 * nobody else. Everything on the wire — publisherId, envelope header — is a
 * throwaway key, so an observer of the inbox stream cannot draw the
 * (sender → recipient) edge.
 *
 * Uses real secp256k1 and real WebCrypto. Mocking either would test nothing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import { dmCrypto } from '../../src/js/dmCrypto.js';

globalThis.ethers = ethers;

const pubOf = pk => new ethers.SigningKey(pk).compressedPublicKey;

describe('dmCrypto — sealed sender', () => {
    let alice, bob, mallory;

    beforeAll(() => {
        // Fixed keys, not createRandom(): under jsdom ethers' RNG returns a Node
        // Buffer that fails its own cross-realm BytesLike check. Deterministic
        // keys also make any failure reproducible.
        alice = new ethers.Wallet('0x' + '11'.repeat(32));
        bob = new ethers.Wallet('0x' + '22'.repeat(32));
        mallory = new ethers.Wallet('0x' + '33'.repeat(32));
    });

    const sealForBob = (msg, sender = alice, pow = null) => dmCrypto.seal(msg, {
        senderPrivateKey: sender.privateKey,
        recipientAddress: bob.address,
        recipientPublicKey: pubOf(bob.privateKey),
        pow
    });

    const openAsBob = envelope => dmCrypto.open(envelope, {
        myPrivateKey: bob.privateKey,
        myAddress: bob.address
    });

    describe('round trip', () => {
        it('recovers both the content and the real sender', async () => {
            const { envelope } = await sealForBob({ text: 'olá', id: 'm1' });
            const { sender, message } = await openAsBob(envelope);

            expect(message.text).toBe('olá');
            expect(message.id).toBe('m1');
            expect(sender.toLowerCase()).toBe(alice.address.toLowerCase());
        });

        it('strips the proof from the returned message', async () => {
            const { envelope } = await sealForBob({ text: 'olá' });
            const { message } = await openAsBob(envelope);
            expect(message.p).toBeUndefined();
        });
    });

    describe('what the wire exposes', () => {
        it('leaks nothing about the sender', async () => {
            const { envelope } = await sealForBob({ text: 'segredo' });
            const wire = JSON.stringify(envelope).toLowerCase();

            expect(wire).not.toContain(alice.address.toLowerCase().slice(2));
            expect(wire).not.toContain(pubOf(alice.privateKey).toLowerCase().slice(2));
            expect(wire).not.toContain('segredo');
        });

        it('uses a fresh ephemeral key every time, so messages are unlinkable', async () => {
            const a = await sealForBob({ text: '1' });
            const b = await sealForBob({ text: '2' });

            expect(a.envelope.epk).not.toBe(b.envelope.epk);
            expect(a.ephemeralPrivateKey).not.toBe(b.ephemeralPrivateKey);
        });

        it('hands back the ephemeral private key for use as the publisher identity', async () => {
            // This is what keeps publisherId off the wallet: the same throwaway
            // key that does the ECDH also signs the Streamr message.
            const { envelope, ephemeralPrivateKey } = await sealForBob({ text: 'x' });
            expect(pubOf(ephemeralPrivateKey)).toBe(envelope.epk);

            const ephAddress = new ethers.Wallet(ephemeralPrivateKey).address;
            expect(ephAddress.toLowerCase()).not.toBe(alice.address.toLowerCase());
        });
    });

    describe('confidentiality', () => {
        it('cannot be opened by a third party holding the whole envelope', async () => {
            const { envelope } = await sealForBob({ text: 'só para o Bob' });
            await expect(dmCrypto.open(envelope, {
                myPrivateKey: mallory.privateKey,
                myAddress: mallory.address
            })).rejects.toThrow();
        });

        it('cannot be opened by the sender either', async () => {
            // Forward secrecy of a sort: Alice discards the ephemeral key, so
            // she cannot re-derive the AES key from what is on the wire.
            const { envelope } = await sealForBob({ text: 'x' });
            await expect(dmCrypto.open(envelope, {
                myPrivateKey: alice.privateKey,
                myAddress: alice.address
            })).rejects.toThrow();
        });

        it('rejects a tampered ciphertext (AES-GCM auth tag)', async () => {
            const { envelope } = await sealForBob({ text: 'original' });
            const bytes = atob(envelope.ct).split('').map(c => c.charCodeAt(0));
            bytes[0] ^= 0xff;
            envelope.ct = btoa(String.fromCharCode(...bytes));

            await expect(openAsBob(envelope)).rejects.toThrow();
        });
    });

    describe('the proof binds to one recipient', () => {
        it('does not validate when replayed into another inbox', async () => {
            // Mallory copies Alice's envelope into her own inbox to make it look
            // like Alice wrote to her. She cannot decrypt it — but even if she
            // could, the proof is bound to Bob's address.
            const { envelope } = await sealForBob({ text: 'x' });

            const digestForMallory = dmCrypto.bindDigest(mallory.address, envelope.epk);
            const digestForBob = dmCrypto.bindDigest(bob.address, envelope.epk);
            expect(digestForMallory).not.toBe(digestForBob);
        });

        it('recovers a different address when opened against the wrong identity', async () => {
            // Sanity check on the mechanism: the recovered sender is only
            // meaningful when the digest is rebuilt with the right recipient.
            const { envelope } = await sealForBob({ text: 'x' });
            const { message } = await openAsBob(envelope);
            expect(message).toBeDefined();

            const wrongDigest = dmCrypto.bindDigest(mallory.address, envelope.epk);
            const inner = await dmCrypto.decrypt(
                { ct: envelope.ct, iv: envelope.iv, e: 'aes-256-gcm' },
                await dmCrypto.deriveSealedKey(bob.privateKey, envelope.epk)
            );
            const wrongSender = ethers.recoverAddress(wrongDigest, inner.p);
            expect(wrongSender.toLowerCase()).not.toBe(alice.address.toLowerCase());
        });

        it('attributes correctly when a different wallet signs', async () => {
            const { envelope } = await sealForBob({ text: 'x' }, mallory);
            const { sender } = await openAsBob(envelope);
            expect(sender.toLowerCase()).toBe(mallory.address.toLowerCase());
        });
    });

    describe('envelope shape', () => {
        it('carries the PoW stamp in the clear so spam is cheap to drop', async () => {
            const pow = { pow: '0x0000abc', nonce: 42, epoch: 1700 };
            const { envelope } = await sealForBob({ text: 'x' }, alice, pow);

            expect(envelope.pow).toBe('0x0000abc');
            expect(envelope.nonce).toBe(42);
            expect(envelope.epoch).toBe(1700);
        });

        it('is recognised by isSealed, and v1 envelopes are not', async () => {
            const { envelope } = await sealForBob({ text: 'x' });
            expect(dmCrypto.isSealed(envelope)).toBe(true);

            const v1 = { ct: 'x', iv: 'y', e: 'aes-256-gcm' };
            expect(dmCrypto.isSealed(v1)).toBe(false);
            expect(dmCrypto.isSealed(null)).toBe(false);
            expect(dmCrypto.isSealed({ v: 2 })).toBe(false);
        });

        it('refuses to open anything that is not a v2 envelope', async () => {
            await expect(dmCrypto.open(
                { ct: 'x', iv: 'y', e: 'aes-256-gcm' },
                { myPrivateKey: bob.privateKey, myAddress: bob.address }
            )).rejects.toThrow('Not a sealed-sender envelope');
        });
    });

    describe('domain separation from v1', () => {
        it('derives a different key than the v1 scheme from the same pair', async () => {
            // Same ECDH secret, different HKDF salt. Without this, a v1
            // ciphertext could be opened by the v2 path and vice versa.
            const v1Key = await dmCrypto.deriveSharedKey(alice.privateKey, pubOf(bob.privateKey));
            const v2Key = await dmCrypto.deriveSealedKey(alice.privateKey, pubOf(bob.privateKey));

            const payload = { text: 'x' };
            const sealedV1 = await dmCrypto.encrypt(payload, v1Key);
            await expect(dmCrypto.decrypt(sealedV1, v2Key)).rejects.toThrow();
        });
    });

    describe('sealed binary (P7 — MEDIA_DATA pieces)', () => {
        const sealerForBob = (sender = alice) => dmCrypto.createBinarySealer({
            senderPrivateKey: sender.privateKey,
            recipientAddress: bob.address,
            recipientPublicKey: pubOf(bob.privateKey)
        });

        const openAsBob = sealed => dmCrypto.openBinary(sealed, {
            myPrivateKey: bob.privateKey,
            myAddress: bob.address
        });

        it('round-trips a piece and proves the real sender', async () => {
            const piece = new Uint8Array([1, 2, 3, 4, 250, 0, 128]);
            const sealer = await sealerForBob();

            const { sender, bytes } = await openAsBob(await sealer.seal(piece));

            expect(bytes).toEqual(piece);
            expect(sender.toLowerCase()).toBe(alice.address.toLowerCase());
        });

        it('keeps the sender out of the cleartext header', async () => {
            const sealer = await sealerForBob();
            const sealed = await sealer.seal(new Uint8Array([9, 9, 9]));

            // [v:1][epk:33][iv:12][ct:...] — nothing here is derived from Alice
            expect(sealed[0]).toBe(0x02);
            const header = ethers.hexlify(sealed.slice(0, 46)).toLowerCase();
            expect(header).not.toContain(alice.address.slice(2).toLowerCase());
            expect(ethers.hexlify(sealed.slice(1, 34))).toBe(sealer.ephemeralPublicKey);
        });

        it('uses one ephemeral key for every piece of a transfer', async () => {
            const sealer = await sealerForBob();

            const a = await sealer.seal(new Uint8Array([1]));
            const b = await sealer.seal(new Uint8Array([2]));

            // Same epk, different IV — reusing the IV would be catastrophic
            expect(ethers.hexlify(a.slice(1, 34))).toBe(ethers.hexlify(b.slice(1, 34)));
            expect(ethers.hexlify(a.slice(34, 46))).not.toBe(ethers.hexlify(b.slice(34, 46)));
        });

        it('gives a different transfer a different ephemeral key', async () => {
            const one = await sealerForBob();
            const two = await sealerForBob();
            expect(one.ephemeralPublicKey).not.toBe(two.ephemeralPublicKey);
        });

        it('does not open for anyone but the recipient', async () => {
            const sealer = await sealerForBob();
            const sealed = await sealer.seal(new Uint8Array([1, 2, 3]));

            await expect(dmCrypto.openBinary(sealed, {
                myPrivateKey: mallory.privateKey,
                myAddress: mallory.address
            })).rejects.toThrow();
        });

        it('recovers a meaningless sender when the proof is replayed at someone else', async () => {
            // The proof binds (recipient, epk). Mallory re-addressing Alice's
            // envelope cannot make it recover to Alice.
            const sealer = await dmCrypto.createBinarySealer({
                senderPrivateKey: alice.privateKey,
                recipientAddress: mallory.address,
                recipientPublicKey: pubOf(bob.privateKey)  // sealed to Bob's key
            });
            const sealed = await sealer.seal(new Uint8Array([1, 2, 3]));

            const { sender } = await openAsBob(sealed);
            expect(sender.toLowerCase()).not.toBe(alice.address.toLowerCase());
        });

        it('rejects a truncated envelope rather than reading past the end', async () => {
            const sealer = await sealerForBob();
            const sealed = await sealer.seal(new Uint8Array([1, 2, 3]));

            await expect(openAsBob(sealed.slice(0, 100)))
                .rejects.toThrow('Not a sealed binary envelope');
        });

        it('does not mistake an unsealed piece for a sealed one', async () => {
            // Unsealed pieces lead with BINARY_MSG_TYPE.FILE_PIECE (0x01)
            const plainPiece = new Uint8Array(200);
            plainPiece[0] = 0x01;
            expect(dmCrypto.isSealedBinary(plainPiece)).toBe(false);
        });
    });
});

describe('dmCrypto.sealToPublicKey — push-relay variant (§9.1 #3)', () => {
    const relay = new ethers.Wallet('0x' + '44'.repeat(32));
    const relayPub = () => new ethers.SigningKey(relay.privateKey).compressedPublicKey;
    const SALT = 'pombo-push-sealed-v1';

    const openAsRelay = async (envelope) => {
        const key = await dmCrypto.deriveSealedKey(relay.privateKey, envelope.epk, SALT);
        return dmCrypto.decrypt({ ct: envelope.ct, iv: envelope.iv, e: 'aes-256-gcm' }, key);
    };

    it('round-trips a registration payload with no identity inside', async () => {
        const payload = { type: 'registration', tag: 'e7', subscription: '{"fcmToken":"t"}', timestamp: 1 };
        const { envelope, ephemeralPrivateKey } = await dmCrypto.sealToPublicKey(payload, relayPub(), SALT);

        expect(envelope.v).toBe(1);
        expect(envelope.epk.startsWith('0x0')).toBe(true);
        const opened = await openAsRelay(envelope);
        expect(opened).toEqual(payload);
        // No proof field — the relay must never learn the account
        expect(opened.p).toBeUndefined();
        // The ephemeral is the transport identity for this publish
        expect(new ethers.SigningKey(ephemeralPrivateKey).compressedPublicKey).toBe(envelope.epk);
    });

    it('the push salt domain-separates from the DM scheme', async () => {
        const { envelope } = await dmCrypto.sealToPublicKey({ x: 1 }, relayPub(), SALT);
        const dmKey = await dmCrypto.deriveSealedKey(relay.privateKey, envelope.epk); // DM salt
        await expect(dmCrypto.decrypt({ ct: envelope.ct, iv: envelope.iv, e: 'aes-256-gcm' }, dmKey))
            .rejects.toThrow();
    });

    it('a different key cannot open it', async () => {
        const { envelope } = await dmCrypto.sealToPublicKey({ x: 1 }, relayPub(), SALT);
        const strangerKey = await dmCrypto.deriveSealedKey('0x' + '55'.repeat(32), envelope.epk, SALT);
        await expect(dmCrypto.decrypt({ ct: envelope.ct, iv: envelope.iv, e: 'aes-256-gcm' }, strangerKey))
            .rejects.toThrow();
    });
});
