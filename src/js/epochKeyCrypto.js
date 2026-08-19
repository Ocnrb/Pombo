/**
 * Epoch Key Crypto — primitives for the keys stream (-4) protocol.
 *
 * Gated/native channel content on -1 is encrypted with a channel-wide EPOCH KEY,
 * versioned by `kid`. This module holds the pure crypto; the protocol state
 * machine (who announces, who wraps, when to rotate) lives in epochKeyManager.
 *
 * Distribution (see UNIFIED_IMPLEMENTATION_PLAN.md §5.4, D12–D14):
 *   - Admin announces { epoch, keyId, keyHash } — the trust anchor.
 *   - A joiner publishes KEY_REQUEST carrying a fresh EPHEMERAL request pubkey.
 *   - Any member holding the key answers with KEY_WRAP: the epoch key sealed
 *     via ECIES to that request pubkey, addressed by
 *     tag = sha256(requestPubkey ‖ keyId) — O(1) lookup, and because the tag is
 *     over a throwaway key it confirms nothing about who is in the channel.
 *   - The joiner verifies sha256(unwrapped) === announced keyHash before
 *     adopting. A malicious wrapper can only waste bandwidth.
 *
 * ECIES here is the same construction as dmCrypto's sealed sender (secp256k1
 * ECDH + HKDF + AES-256-GCM) with its own HKDF salt for domain separation —
 * the two schemes can never derive the same key from the same secret.
 */

import { dmCrypto } from './dmCrypto.js';

const KEYWRAP_HKDF_SALT = 'pombo-keywrap-v1';
const WRAP_TAG_DOMAIN = 'POMBO_WRAP_TAG_V1';

// Leading byte of an epoch-sealed binary envelope on the MEDIA_DATA partition.
// The partition's other frames claim 0x01/0x03 (media) and 0x02 (dmCrypto's
// sealed envelope) — never reuse any of them.
export const BINARY_EPOCH_VERSION = 0x04;

class EpochKeyCrypto {
    /**
     * Generate a fresh 256-bit epoch key.
     * @returns {string} 0x-prefixed 32-byte hex
     */
    generateEpochKey() {
        return ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
    }

    /**
     * Hash binding a key to its KEY_ANNOUNCE. Announced by the admin;
     * recomputed by receivers over every unwrapped key before adopting it.
     * @param {string} epochKeyHex - 0x-prefixed 32-byte hex
     * @returns {Promise<string>} 0x-prefixed sha256 hex
     */
    async computeKeyHash(epochKeyHex) {
        const digest = await crypto.subtle.digest('SHA-256', ethers.getBytes(epochKeyHex));
        return ethers.hexlify(new Uint8Array(digest));
    }

    /**
     * Fresh secp256k1 keypair for one KEY_REQUEST (D12). Lives in memory only,
     * until the matching wrap arrives — never persisted, never reused.
     * @returns {{privateKey: string, publicKey: string}} hex; publicKey compressed (33 bytes)
     */
    generateRequestKeypair() {
        const privateKey = dmCrypto.generateEphemeralPrivateKey();
        const publicKey = new ethers.SigningKey(privateKey).compressedPublicKey;
        return { privateKey, publicKey };
    }

    /**
     * Wrap address tag: sha256 over a domain-separated canonical string, so
     * both platforms derive it identically. Computed over the request pubkey —
     * a throwaway — so the tag carries no membership information.
     * @param {string} requestPubkeyHex - Compressed pubkey from the KEY_REQUEST
     * @param {string} keyId - Announced key id
     * @returns {Promise<string>} 0x-prefixed sha256 hex
     */
    async computeWrapTag(requestPubkeyHex, keyId) {
        const canonical = `${WRAP_TAG_DOMAIN}|${requestPubkeyHex.toLowerCase()}|${keyId}`;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
        return ethers.hexlify(new Uint8Array(digest));
    }

    /**
     * ECIES key for wrap/unwrap. Symmetric: the wrapper passes
     * (wrapEphemeral.priv, requestPub); the requester passes
     * (request.priv, wrapEphemeral.pub from the envelope).
     * @param {string} privateKeyHex
     * @param {string} publicKeyHex - Compressed secp256k1 public key
     * @returns {Promise<CryptoKey>} AES-256-GCM key
     */
    async deriveWrapKey(privateKeyHex, publicKeyHex) {
        const signingKey = new ethers.SigningKey(privateKeyHex);
        const sharedSecretHex = signingKey.computeSharedSecret(publicKeyHex);
        const sharedBytes = ethers.getBytes(sharedSecretHex).slice(1, 33);

        const keyMaterial = await crypto.subtle.importKey(
            'raw', sharedBytes, { name: 'HKDF' }, false, ['deriveKey']
        );

        return crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new TextEncoder().encode(KEYWRAP_HKDF_SALT),
                info: new TextEncoder().encode('aes-256-gcm')
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Seal an epoch key to a request pubkey (ECIES).
     * @param {string} epochKeyHex - 0x-prefixed 32-byte hex
     * @param {string} requestPubkeyHex - Compressed pubkey from the KEY_REQUEST
     * @returns {Promise<{epk: string, iv: string, ct: string}>} epk hex, iv/ct base64
     */
    async wrapEpochKey(epochKeyHex, requestPubkeyHex) {
        const wrapEphemeralKey = dmCrypto.generateEphemeralPrivateKey();
        const epk = new ethers.SigningKey(wrapEphemeralKey).compressedPublicKey;

        const aesKey = await this.deriveWrapKey(wrapEphemeralKey, requestPubkeyHex);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, aesKey, ethers.getBytes(epochKeyHex)
        );

        return {
            epk,
            iv: dmCrypto.bufToBase64(iv),
            ct: dmCrypto.bufToBase64(ct)
        };
    }

    /**
     * Open a wrap addressed to our request keypair.
     * @param {{epk: string, iv: string, ct: string}} wrapped
     * @param {string} requestPrivateKeyHex - Private half of the request keypair
     * @returns {Promise<string>} epoch key, 0x-prefixed 32-byte hex
     * @throws if the envelope does not decrypt or has the wrong length
     */
    async unwrapEpochKey(wrapped, requestPrivateKeyHex) {
        const aesKey = await this.deriveWrapKey(requestPrivateKeyHex, wrapped.epk);
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: dmCrypto.base64ToBuf(wrapped.iv) },
            aesKey,
            dmCrypto.base64ToBuf(wrapped.ct)
        );
        const bytes = new Uint8Array(plain);
        if (bytes.byteLength !== 32) {
            throw new Error(`Unwrapped epoch key has wrong length: ${bytes.byteLength}`);
        }
        return ethers.hexlify(bytes);
    }

    /**
     * Import an epoch key for message encryption/decryption.
     * @param {string} epochKeyHex - 0x-prefixed 32-byte hex
     * @returns {Promise<CryptoKey>} AES-256-GCM key
     */
    importEpochKey(epochKeyHex) {
        return crypto.subtle.importKey(
            'raw', ethers.getBytes(epochKeyHex),
            { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
        );
    }

    /**
     * Encrypt a message object with an epoch key.
     * @param {Object} message - Plaintext message object
     * @param {CryptoKey} epochKey - From importEpochKey()
     * @returns {Promise<{ct: string, iv: string}>} base64
     */
    async encryptWithEpochKey(message, epochKey) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            epochKey,
            new TextEncoder().encode(JSON.stringify(message))
        );
        return { ct: dmCrypto.bufToBase64(ct), iv: dmCrypto.bufToBase64(iv) };
    }

    /**
     * Decrypt a message envelope with an epoch key.
     * @param {{ct: string, iv: string}} envelope
     * @param {CryptoKey} epochKey - From importEpochKey()
     * @returns {Promise<Object>} plaintext message object
     */
    async decryptWithEpochKey(envelope, epochKey) {
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: dmCrypto.base64ToBuf(envelope.iv) },
            epochKey,
            dmCrypto.base64ToBuf(envelope.ct)
        );
        return JSON.parse(new TextDecoder().decode(plain));
    }

    /**
     * Seal a binary media frame with an epoch key (MEDIA_DATA partition).
     *
     * Frame: [1B version=0x04] [1B kidLen] [kidLen B kid UTF-8] [12B iv] [ct].
     * The kid travels in the clear for the same reason `k` does in the JSON
     * envelope: receivers pick the key without trial decryption.
     *
     * @param {Uint8Array} bytes - Plaintext frame
     * @param {CryptoKey} epochKey - From importEpochKey()
     * @param {string} kid - Key id of the sealing epoch
     * @returns {Promise<Uint8Array>}
     */
    async sealBinaryWithEpochKey(bytes, epochKey, kid) {
        const kidBytes = new TextEncoder().encode(kid);
        if (kidBytes.byteLength === 0 || kidBytes.byteLength > 255) {
            throw new Error(`Epoch kid does not fit the binary envelope: ${kid}`);
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, epochKey, bytes
        ));

        const buf = new Uint8Array(2 + kidBytes.byteLength + 12 + ct.byteLength);
        buf[0] = BINARY_EPOCH_VERSION;
        buf[1] = kidBytes.byteLength;
        buf.set(kidBytes, 2);
        buf.set(iv, 2 + kidBytes.byteLength);
        buf.set(ct, 2 + kidBytes.byteLength + 12);
        return buf;
    }

    /**
     * @param {*} buf - Raw MEDIA_DATA payload
     * @returns {boolean} true if this is an epoch-sealed binary envelope
     */
    isBinaryEpochEnvelope(buf) {
        return buf instanceof Uint8Array && buf.byteLength > 0
            && buf[0] === BINARY_EPOCH_VERSION;
    }

    /**
     * Split an epoch binary envelope into its parts.
     * @param {Uint8Array} buf
     * @returns {{kid: string, iv: Uint8Array, ct: Uint8Array}|null} null if malformed
     */
    parseBinaryEpochEnvelope(buf) {
        if (!this.isBinaryEpochEnvelope(buf) || buf.byteLength < 2) return null;
        const kidLen = buf[1];
        // Minimum ct is the bare 16-byte GCM tag (empty plaintext)
        if (kidLen === 0 || buf.byteLength < 2 + kidLen + 12 + 16) return null;
        return {
            kid: new TextDecoder().decode(buf.subarray(2, 2 + kidLen)),
            iv: buf.slice(2 + kidLen, 2 + kidLen + 12),
            ct: buf.slice(2 + kidLen + 12)
        };
    }

    /**
     * Open a parsed epoch binary envelope.
     * @param {{iv: Uint8Array, ct: Uint8Array}} parsed - From parseBinaryEpochEnvelope()
     * @param {CryptoKey} epochKey - From importEpochKey()
     * @returns {Promise<Uint8Array>} plaintext frame
     */
    async decryptBinaryWithEpochKey(parsed, epochKey) {
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: parsed.iv }, epochKey, parsed.ct
        );
        return new Uint8Array(plain);
    }
}

export const epochKeyCrypto = new EpochKeyCrypto();
