/**
 * epochKeyCrypto — wrap/unwrap primitives for the keys stream (-4)
 *
 * Properties under test: a wrapped epoch key round-trips only for the holder
 * of the request keypair; the keyHash binds a wrap to its announce (a wrong
 * key is detectable); the tag is deterministic per (pubkey, keyId) and says
 * nothing without the request pubkey; message encryption round-trips by kid.
 *
 * Uses real secp256k1 and real WebCrypto. Mocking either would test nothing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import { epochKeyCrypto } from '../../src/js/epochKeyCrypto.js';

globalThis.ethers = ethers;

describe('epochKeyCrypto', () => {
    let requestKeypair;

    beforeAll(() => {
        requestKeypair = epochKeyCrypto.generateRequestKeypair();
    });

    describe('epoch key generation', () => {
        it('generates 32-byte keys with 32-byte sha256 hashes', async () => {
            const key = epochKeyCrypto.generateEpochKey();
            expect(ethers.getBytes(key)).toHaveLength(32);
            const hash = await epochKeyCrypto.computeKeyHash(key);
            expect(ethers.getBytes(hash)).toHaveLength(32);
        });

        it('generates distinct keys per call', () => {
            expect(epochKeyCrypto.generateEpochKey())
                .not.toBe(epochKeyCrypto.generateEpochKey());
        });
    });

    describe('wrap round trip', () => {
        it('unwraps to the exact key that was wrapped', async () => {
            const epochKey = epochKeyCrypto.generateEpochKey();
            const wrapped = await epochKeyCrypto.wrapEpochKey(epochKey, requestKeypair.publicKey);
            const unwrapped = await epochKeyCrypto.unwrapEpochKey(wrapped, requestKeypair.privateKey);
            expect(unwrapped.toLowerCase()).toBe(epochKey.toLowerCase());
        });

        it('does not open with a different request key', async () => {
            const epochKey = epochKeyCrypto.generateEpochKey();
            const wrapped = await epochKeyCrypto.wrapEpochKey(epochKey, requestKeypair.publicKey);
            const other = epochKeyCrypto.generateRequestKeypair();
            await expect(epochKeyCrypto.unwrapEpochKey(wrapped, other.privateKey))
                .rejects.toThrow();
        });

        it('carries neither the key nor the request identity on the wire', async () => {
            const epochKey = epochKeyCrypto.generateEpochKey();
            const wrapped = await epochKeyCrypto.wrapEpochKey(epochKey, requestKeypair.publicKey);
            const wire = JSON.stringify(wrapped).toLowerCase();
            expect(wire).not.toContain(epochKey.toLowerCase().slice(2));
            expect(wire).not.toContain(requestKeypair.publicKey.toLowerCase().slice(2));
        });
    });

    describe('keyHash binding (the anti-poisoning check)', () => {
        it('detects a wrap of the wrong key', async () => {
            const announced = epochKeyCrypto.generateEpochKey();
            const announcedHash = await epochKeyCrypto.computeKeyHash(announced);

            const malicious = epochKeyCrypto.generateEpochKey();
            const wrapped = await epochKeyCrypto.wrapEpochKey(malicious, requestKeypair.publicKey);
            const unwrapped = await epochKeyCrypto.unwrapEpochKey(wrapped, requestKeypair.privateKey);

            const actualHash = await epochKeyCrypto.computeKeyHash(unwrapped);
            expect(actualHash).not.toBe(announcedHash);
        });
    });

    describe('wrap tag', () => {
        it('is deterministic per (pubkey, keyId)', async () => {
            const a = await epochKeyCrypto.computeWrapTag(requestKeypair.publicKey, '1.abc123');
            const b = await epochKeyCrypto.computeWrapTag(requestKeypair.publicKey, '1.abc123');
            expect(a).toBe(b);
        });

        it('differs across keyIds and across pubkeys', async () => {
            const other = epochKeyCrypto.generateRequestKeypair();
            const base = await epochKeyCrypto.computeWrapTag(requestKeypair.publicKey, '1.abc123');
            expect(await epochKeyCrypto.computeWrapTag(requestKeypair.publicKey, '2.def456'))
                .not.toBe(base);
            expect(await epochKeyCrypto.computeWrapTag(other.publicKey, '1.abc123'))
                .not.toBe(base);
        });

        it('is case-insensitive on the pubkey (canonical form)', async () => {
            const upper = requestKeypair.publicKey.toUpperCase().replace('0X', '0x');
            const a = await epochKeyCrypto.computeWrapTag(requestKeypair.publicKey, '1.abc123');
            const b = await epochKeyCrypto.computeWrapTag(upper, '1.abc123');
            expect(a).toBe(b);
        });
    });

    describe('message encryption by epoch key', () => {
        it('round-trips a message object', async () => {
            const keyHex = epochKeyCrypto.generateEpochKey();
            const cryptoKey = await epochKeyCrypto.importEpochKey(keyHex);
            const envelope = await epochKeyCrypto.encryptWithEpochKey(
                { id: 'm1', text: 'olá', sender: '0xabc' }, cryptoKey);
            const plain = await epochKeyCrypto.decryptWithEpochKey(envelope, cryptoKey);
            expect(plain).toEqual({ id: 'm1', text: 'olá', sender: '0xabc' });
        });

        it('does not decrypt with another epoch key', async () => {
            const keyA = await epochKeyCrypto.importEpochKey(epochKeyCrypto.generateEpochKey());
            const keyB = await epochKeyCrypto.importEpochKey(epochKeyCrypto.generateEpochKey());
            const envelope = await epochKeyCrypto.encryptWithEpochKey({ text: 'segredo' }, keyA);
            await expect(epochKeyCrypto.decryptWithEpochKey(envelope, keyB)).rejects.toThrow();
            expect(JSON.stringify(envelope)).not.toContain('segredo');
        });
    });

    describe('binary envelope (MEDIA_DATA frames)', () => {
        const KID = '1.a1b2c3d4e5f6';

        it('round-trips a binary frame and carries the kid in the clear', async () => {
            const cryptoKey = await epochKeyCrypto.importEpochKey(epochKeyCrypto.generateEpochKey());
            const frame = crypto.getRandomValues(new Uint8Array(1024));

            const sealed = await epochKeyCrypto.sealBinaryWithEpochKey(frame, cryptoKey, KID);
            expect(sealed[0]).toBe(0x04);
            expect(epochKeyCrypto.isBinaryEpochEnvelope(sealed)).toBe(true);

            const parsed = epochKeyCrypto.parseBinaryEpochEnvelope(sealed);
            expect(parsed.kid).toBe(KID);

            const opened = await epochKeyCrypto.decryptBinaryWithEpochKey(parsed, cryptoKey);
            expect(opened).toEqual(frame);
        });

        it('does not open with another epoch key', async () => {
            const keyA = await epochKeyCrypto.importEpochKey(epochKeyCrypto.generateEpochKey());
            const keyB = await epochKeyCrypto.importEpochKey(epochKeyCrypto.generateEpochKey());
            const sealed = await epochKeyCrypto.sealBinaryWithEpochKey(
                new TextEncoder().encode('piece bytes'), keyA, KID);
            const parsed = epochKeyCrypto.parseBinaryEpochEnvelope(sealed);
            await expect(epochKeyCrypto.decryptBinaryWithEpochKey(parsed, keyB)).rejects.toThrow();
        });

        it('leaves the other MEDIA_DATA frame types untouched', () => {
            // 0x01/0x03 media frames and 0x02 DM sealed envelopes must never
            // be mistaken for an epoch envelope.
            for (const lead of [0x01, 0x02, 0x03]) {
                expect(epochKeyCrypto.isBinaryEpochEnvelope(new Uint8Array([lead, 0, 0]))).toBe(false);
            }
        });

        it('rejects malformed envelopes instead of slicing garbage', () => {
            expect(epochKeyCrypto.parseBinaryEpochEnvelope(new Uint8Array([0x04]))).toBeNull();
            expect(epochKeyCrypto.parseBinaryEpochEnvelope(new Uint8Array([0x04, 0]))).toBeNull();
            // kidLen pointing past the end of a truncated frame
            expect(epochKeyCrypto.parseBinaryEpochEnvelope(
                new Uint8Array([0x04, 200, 1, 2, 3]))).toBeNull();
        });

        it('refuses a kid that does not fit one length byte', async () => {
            const cryptoKey = await epochKeyCrypto.importEpochKey(epochKeyCrypto.generateEpochKey());
            await expect(epochKeyCrypto.sealBinaryWithEpochKey(
                new Uint8Array([1]), cryptoKey, 'x'.repeat(256))).rejects.toThrow();
        });
    });
});
