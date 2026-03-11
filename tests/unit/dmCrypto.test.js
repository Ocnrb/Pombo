/**
 * DM Crypto Tests
 * Tests for the DMCrypto class (dmCrypto.js)
 * Covers: getMyPublicKey, deriveSharedKey, getSharedKey, encrypt, decrypt, isEncrypted, clear
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

// Mock ethers globally (dmCrypto uses globalThis.ethers)
const mockSharedSecret = '0x04' + 'ab'.repeat(32); // 65 bytes uncompressed point

class MockSigningKey {
    constructor(privateKey) {
        this._privateKey = privateKey;
        this.compressedPublicKey = '0x02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab';
    }
    computeSharedSecret(peerPubKey) {
        return mockSharedSecret;
    }
}

globalThis.ethers = {
    SigningKey: MockSigningKey,
    getBytes: vi.fn().mockImplementation((hex) => {
        // Return 65 bytes for shared secret (uncompressed point)
        const bytes = new Uint8Array(65);
        for (let i = 0; i < 65; i++) bytes[i] = 0xab;
        return bytes;
    })
};

// Mock crypto.subtle for HKDF + AES-GCM
const mockAesKey = { type: 'secret', algorithm: { name: 'AES-GCM' } };
const mockCiphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
const mockPlaintext = new TextEncoder().encode(JSON.stringify({ text: 'hello' })).buffer;

const originalSubtle = globalThis.crypto?.subtle;
Object.defineProperty(globalThis, 'crypto', {
    value: {
        subtle: {
            importKey: vi.fn().mockResolvedValue('hkdf-key-material'),
            deriveKey: vi.fn().mockResolvedValue(mockAesKey),
            encrypt: vi.fn().mockResolvedValue(mockCiphertext),
            decrypt: vi.fn().mockResolvedValue(mockPlaintext),
        },
        getRandomValues: vi.fn((arr) => {
            for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
            return arr;
        })
    },
    writable: true,
    configurable: true
});

import { dmCrypto } from '../../src/js/dmCrypto.js';

describe('DMCrypto', () => {
    beforeEach(() => {
        dmCrypto.clear();
        vi.clearAllMocks();
    });

    // ========================================
    // getMyPublicKey
    // ========================================
    describe('getMyPublicKey()', () => {
        it('should return compressed public key from private key', () => {
            const pubKey = dmCrypto.getMyPublicKey('0xdeadbeef');
            expect(pubKey).toBe('0x02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab');
        });

        it('should create SigningKey with the provided private key', () => {
            const spy = vi.spyOn(ethers, 'SigningKey');
            dmCrypto.getMyPublicKey('0x1234');
            expect(spy).toHaveBeenCalledWith('0x1234');
            spy.mockRestore();
        });
    });

    // ========================================
    // deriveSharedKey
    // ========================================
    describe('deriveSharedKey()', () => {
        it('should compute ECDH shared secret', async () => {
            const spy = vi.spyOn(MockSigningKey.prototype, 'computeSharedSecret');
            await dmCrypto.deriveSharedKey('0xmykey', '0x02peerkey');
            expect(spy).toHaveBeenCalledWith('0x02peerkey');
            spy.mockRestore();
        });

        it('should import shared bytes as HKDF key material', async () => {
            await dmCrypto.deriveSharedKey('0xmykey', '0x02peerkey');
            expect(crypto.subtle.importKey).toHaveBeenCalledWith(
                'raw',
                expect.any(Uint8Array),
                { name: 'HKDF' },
                false,
                ['deriveKey']
            );
        });

        it('should derive AES-256-GCM key via HKDF', async () => {
            await dmCrypto.deriveSharedKey('0xmykey', '0x02peerkey');
            expect(crypto.subtle.deriveKey).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'HKDF',
                    hash: 'SHA-256',
                }),
                'hkdf-key-material',
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        });

        it('should return an AES key', async () => {
            const key = await dmCrypto.deriveSharedKey('0xmykey', '0x02peerkey');
            expect(key).toBe(mockAesKey);
        });

        it('should use correct HKDF salt and info', async () => {
            await dmCrypto.deriveSharedKey('0xmykey', '0x02peerkey');
            const call = crypto.subtle.deriveKey.mock.calls[0][0];
            const salt = new TextDecoder().decode(call.salt);
            const info = new TextDecoder().decode(call.info);
            expect(salt).toBe('pombo-dm-e2e-v1');
            expect(info).toBe('aes-256-gcm');
        });
    });

    // ========================================
    // getSharedKey (with caching)
    // ========================================
    describe('getSharedKey()', () => {
        it('should derive and cache key on first call', async () => {
            const key = await dmCrypto.getSharedKey('0xmykey', '0xPeer', '0x02peerkey');
            expect(key).toBe(mockAesKey);
            expect(dmCrypto.sharedKeys.has('0xpeer')).toBe(true);
        });

        it('should return cached key on second call', async () => {
            await dmCrypto.getSharedKey('0xmykey', '0xPeer', '0x02peerkey');
            vi.clearAllMocks();

            const key = await dmCrypto.getSharedKey('0xmykey', '0xPeer', '0x02peerkey');
            expect(key).toBe(mockAesKey);
            // Should not call deriveKey again
            expect(crypto.subtle.deriveKey).not.toHaveBeenCalled();
        });

        it('should normalize address to lowercase for cache', async () => {
            await dmCrypto.getSharedKey('0xmykey', '0xABCDEF', '0x02peerkey');
            expect(dmCrypto.sharedKeys.has('0xabcdef')).toBe(true);
        });

        it('should cache different keys for different peers', async () => {
            const mockKey2 = { type: 'secret', peer: 2 };
            crypto.subtle.deriveKey.mockResolvedValueOnce(mockAesKey);
            await dmCrypto.getSharedKey('0xmykey', '0xPeerA', '0x02peerA');

            crypto.subtle.deriveKey.mockResolvedValueOnce(mockKey2);
            await dmCrypto.getSharedKey('0xmykey', '0xPeerB', '0x02peerB');

            expect(dmCrypto.sharedKeys.size).toBe(2);
        });
    });

    // ========================================
    // encrypt
    // ========================================
    describe('encrypt()', () => {
        it('should encrypt a message with AES-GCM', async () => {
            const result = await dmCrypto.encrypt({ text: 'hello' }, mockAesKey);
            expect(crypto.subtle.encrypt).toHaveBeenCalled();
            const call = crypto.subtle.encrypt.mock.calls[0];
            expect(call[0].name).toBe('AES-GCM');
            expect(call[1]).toBe(mockAesKey);
            expect(result).toHaveProperty('ct');
            expect(result).toHaveProperty('iv');
            expect(result.e).toBe('aes-256-gcm');
        });

        it('should generate a 12-byte IV', async () => {
            await dmCrypto.encrypt({ text: 'test' }, mockAesKey);
            const encryptCall = crypto.subtle.encrypt.mock.calls[0][0];
            expect(encryptCall.iv).toHaveLength(12);
        });

        it('should JSON-stringify the message before encrypting', async () => {
            const msg = { text: 'hello', sender: '0x123' };
            await dmCrypto.encrypt(msg, mockAesKey);
            const plaintext = crypto.subtle.encrypt.mock.calls[0][2];
            const decoded = new TextDecoder().decode(plaintext);
            expect(JSON.parse(decoded)).toEqual(msg);
        });

        it('should return base64-encoded ct and iv', async () => {
            const result = await dmCrypto.encrypt({ text: 'hi' }, mockAesKey);
            // Verify it's valid base64
            expect(() => atob(result.ct)).not.toThrow();
            expect(() => atob(result.iv)).not.toThrow();
        });
    });

    // ========================================
    // decrypt
    // ========================================
    describe('decrypt()', () => {
        it('should decrypt an envelope back to the original message', async () => {
            const envelope = {
                ct: btoa(String.fromCharCode(1, 2, 3)),
                iv: btoa(String.fromCharCode(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)),
                e: 'aes-256-gcm'
            };
            const result = await dmCrypto.decrypt(envelope, mockAesKey);
            expect(result).toEqual({ text: 'hello' });
        });

        it('should call crypto.subtle.decrypt with correct params', async () => {
            const envelope = {
                ct: btoa('ciphertext'),
                iv: btoa('123456789012'),
                e: 'aes-256-gcm'
            };
            await dmCrypto.decrypt(envelope, mockAesKey);
            expect(crypto.subtle.decrypt).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'AES-GCM' }),
                mockAesKey,
                expect.any(ArrayBuffer)
            );
        });

        it('should throw for unknown encryption type', async () => {
            const envelope = { ct: 'x', iv: 'y', e: 'unknown-algo' };
            await expect(dmCrypto.decrypt(envelope, mockAesKey)).rejects.toThrow('Unknown DM encryption');
        });

        it('should propagate crypto.subtle.decrypt errors', async () => {
            crypto.subtle.decrypt.mockRejectedValueOnce(new Error('Decryption failed'));
            const envelope = {
                ct: btoa('bad'),
                iv: btoa('123456789012'),
                e: 'aes-256-gcm'
            };
            await expect(dmCrypto.decrypt(envelope, mockAesKey)).rejects.toThrow('Decryption failed');
        });
    });

    // ========================================
    // isEncrypted
    // ========================================
    describe('isEncrypted()', () => {
        it('should return true for valid encrypted envelope', () => {
            expect(dmCrypto.isEncrypted({ ct: 'abc', iv: 'def', e: 'aes-256-gcm' })).toBe(true);
        });

        it('should return false for plaintext message', () => {
            expect(dmCrypto.isEncrypted({ text: 'hello', sender: '0x123' })).toBe(false);
        });

        it('should return false for null', () => {
            expect(dmCrypto.isEncrypted(null)).toBe(false);
        });

        it('should return false for undefined', () => {
            expect(dmCrypto.isEncrypted(undefined)).toBe(false);
        });

        it('should return false if ct is not a string', () => {
            expect(dmCrypto.isEncrypted({ ct: 123, iv: 'def', e: 'aes-256-gcm' })).toBe(false);
        });

        it('should return false for wrong encryption type', () => {
            expect(dmCrypto.isEncrypted({ ct: 'abc', iv: 'def', e: 'chacha20' })).toBe(false);
        });
    });

    // ========================================
    // clear
    // ========================================
    describe('clear()', () => {
        it('should clear sharedKeys cache', async () => {
            await dmCrypto.getSharedKey('0xmykey', '0xPeer', '0x02pk');
            expect(dmCrypto.sharedKeys.size).toBe(1);
            dmCrypto.clear();
            expect(dmCrypto.sharedKeys.size).toBe(0);
        });

        it('should clear peerPublicKeys cache', () => {
            dmCrypto.peerPublicKeys.set('0xpeer', '0x02abc');
            expect(dmCrypto.peerPublicKeys.size).toBe(1);
            dmCrypto.clear();
            expect(dmCrypto.peerPublicKeys.size).toBe(0);
        });
    });

    // ========================================
    // bufToBase64 / base64ToBuf roundtrip
    // ========================================
    describe('encoding helpers', () => {
        it('should roundtrip bufToBase64 and base64ToBuf', () => {
            const original = new Uint8Array([0, 1, 127, 128, 255]);
            const b64 = dmCrypto.bufToBase64(original.buffer);
            const restored = new Uint8Array(dmCrypto.base64ToBuf(b64));
            expect(restored).toEqual(original);
        });

        it('should handle empty buffer', () => {
            const empty = new Uint8Array(0);
            const b64 = dmCrypto.bufToBase64(empty.buffer);
            const restored = new Uint8Array(dmCrypto.base64ToBuf(b64));
            expect(restored.length).toBe(0);
        });
    });
});
