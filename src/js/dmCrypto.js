/**
 * DM Crypto Module
 * End-to-end encryption for DMs using ECDH (secp256k1) + AES-256-GCM.
 *
 * How it works:
 * - Each user's public key is stored in their DM inbox stream metadata.
 * - ECDH between sender's private key and receiver's public key produces a shared secret.
 * - Shared secret is passed through HKDF to derive an AES-256-GCM key.
 * - Messages are encrypted/decrypted at the app layer; Streamr transports only ciphertext.
 *
 * Security:
 * - Even if someone subscribes to the stream, they see only ciphertext.
 * - ECDH is deterministic: both peers derive the same shared key independently.
 * - Fresh random IV per message prevents nonce reuse.
 */

import { Logger } from './logger.js';

// Leading byte of a sealed binary envelope on the MEDIA_DATA partition.
// Must not collide with BINARY_MSG_TYPE.FILE_PIECE (0x01) in media.js, which is
// what unsealed pieces carry in the same position.
const SEALED_BINARY_VERSION = 0x02;

class DMCrypto {
    constructor() {
        // Cache: peerAddress (lowercase) → CryptoKey (AES-256-GCM)
        this.sharedKeys = new Map();
        // Cache: peerAddress (lowercase) → compressedPublicKey hex
        this.peerPublicKeys = new Map();
    }

    /**
     * Get my compressed public key from wallet private key.
     * @param {string} privateKeyHex - Wallet private key (hex, with 0x prefix)
     * @returns {string} - Compressed public key (hex, 33 bytes)
     */
    getMyPublicKey(privateKeyHex) {
        const signingKey = new ethers.SigningKey(privateKeyHex);
        return signingKey.compressedPublicKey;
    }

    /**
     * Derive the AES-256-GCM shared key for a specific peer.
     * Uses ECDH + HKDF.
     * @param {string} myPrivateKeyHex - My private key (hex, with 0x prefix)
     * @param {string} peerPublicKeyHex - Peer's compressed public key (hex, 33 bytes)
     * @returns {Promise<CryptoKey>} - AES-256-GCM key
     */
    async deriveSharedKey(myPrivateKeyHex, peerPublicKeyHex) {
        // ECDH: compute raw shared secret (32 bytes)
        const signingKey = new ethers.SigningKey(myPrivateKeyHex);
        const sharedSecretHex = signingKey.computeSharedSecret(peerPublicKeyHex);
        // sharedSecretHex is 0x-prefixed, 65 bytes (uncompressed point). Take x-coordinate (bytes 1-32).
        const sharedBytes = ethers.getBytes(sharedSecretHex).slice(1, 33);

        // HKDF: derive 256-bit AES key from shared secret
        const keyMaterial = await crypto.subtle.importKey(
            'raw', sharedBytes, { name: 'HKDF' }, false, ['deriveKey']
        );

        const aesKey = await crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new TextEncoder().encode('pombo-dm-e2e-v1'),
                info: new TextEncoder().encode('aes-256-gcm')
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );

        return aesKey;
    }

    /**
     * Get or derive the shared key for a peer (with caching).
     * @param {string} myPrivateKeyHex - My private key
     * @param {string} peerAddress - Peer's Ethereum address (for cache lookup)
     * @param {string} peerPublicKeyHex - Peer's compressed public key
     * @returns {Promise<CryptoKey>}
     */
    async getSharedKey(myPrivateKeyHex, peerAddress, peerPublicKeyHex) {
        const normalized = peerAddress.toLowerCase();

        if (this.sharedKeys.has(normalized)) {
            return this.sharedKeys.get(normalized);
        }

        const key = await this.deriveSharedKey(myPrivateKeyHex, peerPublicKeyHex);
        this.sharedKeys.set(normalized, key);
        return key;
    }

    /**
     * Encrypt a message object for DM transport.
     * @param {Object} message - Plaintext message object
     * @param {CryptoKey} aesKey - AES-256-GCM key
     * @returns {Promise<Object>} - { ct: base64, iv: base64, e: 'aes-256-gcm' }
     */
    async encrypt(message, aesKey) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(JSON.stringify(message));

        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            plaintext
        );

        return {
            ct: this.bufToBase64(ciphertext),
            iv: this.bufToBase64(iv),
            e: 'aes-256-gcm'
        };
    }

    /**
     * Decrypt a DM envelope back to the original message object.
     * @param {Object} envelope - { ct, iv, e }
     * @param {CryptoKey} aesKey - AES-256-GCM key
     * @returns {Promise<Object>} - Decrypted message object
     */
    async decrypt(envelope, aesKey) {
        if (envelope.e !== 'aes-256-gcm') {
            throw new Error(`Unknown DM encryption: ${envelope.e}`);
        }

        const ciphertext = this.base64ToBuf(envelope.ct);
        const iv = this.base64ToBuf(envelope.iv);

        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            ciphertext
        );

        return JSON.parse(new TextDecoder().decode(plaintext));
    }

    /**
     * Encrypt binary data (Uint8Array) for DM transport.
     * Used for media payloads (file pieces, image data) on ephemeral P2.
     * Output format: [12B iv][N ciphertext+authTag]
     * @param {Uint8Array} data - Raw binary data
     * @param {CryptoKey} aesKey - AES-256-GCM key (from ECDH shared secret)
     * @returns {Promise<Uint8Array>} - Encrypted binary (iv + ciphertext)
     */
    async encryptBinary(data, aesKey) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            data
        );
        const result = new Uint8Array(12 + ciphertext.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(ciphertext), 12);
        return result;
    }

    /**
     * Decrypt binary data (Uint8Array) from DM transport.
     * Input format: [12B iv][N ciphertext+authTag]
     * @param {Uint8Array} encrypted - Encrypted binary (iv + ciphertext)
     * @param {CryptoKey} aesKey - AES-256-GCM key (from ECDH shared secret)
     * @returns {Promise<Uint8Array>} - Decrypted raw binary
     */
    async decryptBinary(encrypted, aesKey) {
        if (!(encrypted instanceof Uint8Array) || encrypted.byteLength < 28) {
            throw new Error(`Invalid encrypted binary: expected Uint8Array ≥28 bytes (12B IV + 16B tag), got ${encrypted?.byteLength ?? 0}`);
        }
        const iv = encrypted.slice(0, 12);
        const ciphertext = encrypted.slice(12);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            ciphertext
        );
        return new Uint8Array(plaintext);
    }

    /**
     * Check if a data object is an encrypted DM envelope.
     * @param {Object} data - Raw data from Streamr
     * @returns {boolean}
     */
    isEncrypted(data) {
        return !!(data && typeof data.ct === 'string' && typeof data.iv === 'string' && data.e === 'aes-256-gcm');
    }

    // ==================== SEALED SENDER (v2) ====================
    //
    // v1 derives the conversation key from ECDH(sender.static, recipient.static).
    // That works, but the recipient has to know WHO sent a message before it can
    // pick a key — so the sender's identity has to be on the wire, in the
    // publisherId. Anyone watching the inbox stream (a storage node operator, a
    // node in the partition topology) reads the full (sender → recipient) edge.
    // The recipient's address is already in the stream ID; the sender's was the
    // last piece needed to draw the social graph.
    //
    // v2 replaces the sender's static key with a throwaway one:
    //
    //     AES = HKDF( ECDH(ephemeral.priv, recipient.staticPub) )
    //
    // The recipient does ECDH with its OWN static key and the ephemeral public
    // key carried in the cleartext header — no idea who sent it, and no need to
    // guess. O(1), not trial decryption against every known contact.
    //
    // The real sender is inside the ciphertext, as a signature binding their
    // wallet to this ephemeral key for this recipient. Sealed-sender, as in
    // Signal.
    //
    // The same ephemeral key doubles as the Streamr publishing identity, so the
    // publisherId on the wire is a throwaway address too. seal() returns its
    // private key for exactly that.

    /**
     * Digest signed by the sender's wallet to vouch for an ephemeral key.
     *
     * Binds to the recipient AND the ephemeral key, so a captured proof cannot
     * be replayed into someone else's inbox or reused to speak for a different
     * ephemeral key.
     *
     * @param {string} recipientAddress
     * @param {string} ephemeralPublicKey - Compressed secp256k1 public key
     * @returns {string} keccak256 digest
     */
    bindDigest(recipientAddress, ephemeralPublicKey) {
        return ethers.keccak256(ethers.toUtf8Bytes(
            `POMBO_DM_BIND_V2|${String(recipientAddress).toLowerCase()}|${ephemeralPublicKey}`
        ));
    }

    /**
     * Derive the sealed-sender AES key from one side's private key and the
     * other side's public key. Symmetric: sender passes (ephemeral.priv,
     * recipient.pub), recipient passes (own.priv, ephemeral.pub).
     *
     * Uses a different HKDF salt from v1 so the two schemes can never produce
     * the same key from the same secret (domain separation). Other sealed
     * consumers (the push relay) pass their own salt for the same reason.
     *
     * @param {string} privateKeyHex
     * @param {string} publicKeyHex - Compressed secp256k1 public key
     * @param {string} [salt] - HKDF salt (domain separator)
     * @returns {Promise<CryptoKey>} AES-256-GCM key
     */
    async deriveSealedKey(privateKeyHex, publicKeyHex, salt = 'pombo-dm-sealed-v2') {
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
                salt: new TextEncoder().encode(salt),
                info: new TextEncoder().encode('aes-256-gcm')
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Seal a payload to a bare public key with NO sender identity inside —
     * the push-relay variant (§9.1 #3): confidentiality without authorship.
     * Unlike seal(), the plaintext carries no proof — the relay maps
     * tags→endpoints and must never learn accounts. The caller's salt keeps
     * the derived keys domain-separated from the DM scheme.
     *
     * @param {Object} message - Plaintext payload
     * @param {string} recipientPublicKey - Compressed secp256k1 public key
     * @param {string} salt - HKDF salt (e.g. 'pombo-push-sealed-v1')
     * @returns {Promise<{envelope: Object, ephemeralPrivateKey: string}>}
     *   envelope = { v: 1, epk, ct, iv }; ephemeralPrivateKey doubles as the
     *   transport publishing identity, like seal().
     */
    async sealToPublicKey(message, recipientPublicKey, salt) {
        const ephemeralPrivateKey = this.generateEphemeralPrivateKey();
        const epk = new ethers.SigningKey(ephemeralPrivateKey).compressedPublicKey;
        const aesKey = await this.deriveSealedKey(ephemeralPrivateKey, recipientPublicKey, salt);
        const sealed = await this.encrypt(message, aesKey);
        return {
            envelope: { v: 1, epk, ct: sealed.ct, iv: sealed.iv },
            ephemeralPrivateKey
        };
    }

    /**
     * Seal a message for a recipient without revealing the sender on the wire.
     *
     * @param {Object} message - Plaintext message object
     * @param {Object} opts
     * @param {string} opts.senderPrivateKey - Sender's wallet private key (signs the proof)
     * @param {string} opts.recipientAddress - Recipient's address
     * @param {string} opts.recipientPublicKey - Recipient's compressed static public key
     * @param {Object} [opts.pow] - { pow, nonce, epoch } from pushProtocol.calculatePoW.
     *   Supported but NOT used by the send path. Verification is cheap (one
     *   keccak, ~1000x less than the ECDH+AES it guards) so the concern is not
     *   receiver cost — it is that PoW arrives too late to matter. By the time
     *   it is checked the spam has already been propagated, stored on the
     *   inbox owner's dime, and downloaded. It would save ~1ms of CPU and
     *   nothing that actually costs. DM anti-spam has to act on retention or
     *   at the storage node; left wired but off rather than pretending the
     *   problem is solved.
     * @returns {Promise<{envelope: Object, ephemeralPrivateKey: string}>}
     *   `ephemeralPrivateKey` is the Streamr publishing identity for this message.
     */
    async seal(message, { senderPrivateKey, recipientAddress, recipientPublicKey, pow = null }) {
        const ephemeralPrivateKey = this.generateEphemeralPrivateKey();
        const ephemeralPublicKey = new ethers.SigningKey(ephemeralPrivateKey).compressedPublicKey;

        const aesKey = await this.deriveSealedKey(ephemeralPrivateKey, recipientPublicKey);

        // The proof travels INSIDE the ciphertext — that is the whole point.
        const digest = this.bindDigest(recipientAddress, ephemeralPublicKey);
        const proof = new ethers.SigningKey(senderPrivateKey).sign(digest).serialized;

        const sealed = await this.encrypt({ p: proof, ...message }, aesKey);

        const envelope = {
            v: 2,
            epk: ephemeralPublicKey,
            ct: sealed.ct,
            iv: sealed.iv,
            e: 'aes-256-gcm'
        };
        // Cleartext, so it can be checked before spending a decryption on spam
        if (pow) {
            envelope.pow = pow.pow;
            envelope.nonce = pow.nonce;
            envelope.epoch = pow.epoch;
        }

        return { envelope, ephemeralPrivateKey };
    }

    /**
     * Generate a throwaway secp256k1 private key.
     *
     * Uses `crypto.getRandomValues` rather than `ethers.Wallet.createRandom()`
     * on purpose: under jsdom the latter throws, because ethers' RNG hands back
     * a Node Buffer that fails an `instanceof Uint8Array` check across realms.
     * Allocating the array ourselves works in both the browser and the tests —
     * and keeps this off ethers' RNG plumbing entirely.
     *
     * A uniform 32-byte value can in principle land outside the curve order.
     * The odds are about 2^-128, but retrying is free, so we do.
     *
     * @returns {string} 0x-prefixed 32-byte private key
     */
    generateEphemeralPrivateKey() {
        for (let attempt = 0; attempt < 4; attempt++) {
            const candidate = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
            try {
                new ethers.SigningKey(candidate);
                return candidate;
            } catch {
                // Out of range — vanishingly rare, just draw again
            }
        }
        throw new Error('Could not generate a valid ephemeral key');
    }

    /**
     * Open a sealed envelope addressed to us.
     *
     * @param {Object} envelope - { v: 2, epk, ct, iv }
     * @param {Object} opts
     * @param {string} opts.myPrivateKey - Our wallet private key
     * @param {string} opts.myAddress - Our address (must match what the sender bound to)
     * @returns {Promise<{sender: string, message: Object}>}
     * @throws if the envelope is not v2, does not decrypt, or carries no valid proof
     */
    async open(envelope, { myPrivateKey, myAddress }) {
        if (!this.isSealed(envelope)) {
            throw new Error('Not a sealed-sender envelope');
        }

        const aesKey = await this.deriveSealedKey(myPrivateKey, envelope.epk);
        const inner = await this.decrypt(
            { ct: envelope.ct, iv: envelope.iv, e: 'aes-256-gcm' }, aesKey);

        if (!inner || typeof inner.p !== 'string') {
            throw new Error('Sealed envelope carries no identity proof');
        }

        // Recomputed with OUR address: a proof bound to someone else will
        // recover to a different, meaningless address rather than validate.
        const digest = this.bindDigest(myAddress, envelope.epk);
        const sender = ethers.recoverAddress(digest, inner.p);

        const { p, ...message } = inner;
        return { sender, message };
    }

    /**
     * @param {Object} data - Raw data from Streamr
     * @returns {boolean} true if this is a sealed-sender (v2) envelope
     */
    isSealed(data) {
        return !!(data && data.v === 2 && typeof data.epk === 'string'
            && typeof data.ct === 'string' && typeof data.iv === 'string');
    }

    // ==================== SEALED SENDER — BINARY ====================
    //
    // On the MEDIA_DATA partition the payload is a raw Uint8Array: there is no
    // JSON to carry the proof, which is the only reason binary media is a
    // separate phase from the rest of sealed sender.
    //
    //   wire:      [v:1][epk:33][iv:12][ct:...]
    //   plaintext: [proof:65][payload:...]
    //
    // The recipient does ECDH with its own static key and the cleartext `epk`,
    // so opening is O(1) — no trial decryption against every known peer.
    //
    // ONE EPHEMERAL KEY PER TRANSFER, not per piece: `epk` and `proof` are both
    // fixed for the transfer, so createBinarySealer() computes them once and
    // every piece reuses them. Per-piece keys would add an ECDH per piece and
    // buy nothing — the pieces are already correlated by arriving together.

    /**
     * @param {Uint8Array} bytes - Raw payload from the MEDIA_DATA partition
     * @returns {boolean} true if this looks like a sealed binary envelope
     */
    isSealedBinary(bytes) {
        // 1 + 33 + 12 + 16 (GCM tag) + 65 (proof) = 127 is the shortest legal
        // envelope. Legacy v1 binary starts with a random IV byte, so a 1-in-256
        // legacy message also matches — the caller must fall back on failure
        // rather than treat this as proof of format.
        return bytes instanceof Uint8Array
            && bytes.byteLength >= 127
            && bytes[0] === SEALED_BINARY_VERSION;
    }

    /**
     * Build a sealer that holds one ephemeral identity for a whole transfer.
     *
     * @param {Object} params
     * @param {string} params.senderPrivateKey
     * @param {string} params.recipientAddress
     * @param {string} params.recipientPublicKey - Compressed secp256k1 public key
     * @returns {Promise<{ephemeralPublicKey: string, seal: (payload: Uint8Array) => Promise<Uint8Array>}>}
     */
    async createBinarySealer({ senderPrivateKey, recipientAddress, recipientPublicKey }) {
        const ephemeralPrivateKey = this.generateEphemeralPrivateKey();
        const ephemeralPublicKey = new ethers.SigningKey(ephemeralPrivateKey).compressedPublicKey;

        const aesKey = await this.deriveSealedKey(ephemeralPrivateKey, recipientPublicKey);

        const digest = this.bindDigest(recipientAddress, ephemeralPublicKey);
        const proofBytes = ethers.getBytes(
            new ethers.SigningKey(senderPrivateKey).sign(digest).serialized);
        const epkBytes = ethers.getBytes(ephemeralPublicKey);

        const seal = async (payload) => {
            const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);

            const plain = new Uint8Array(proofBytes.length + bytes.byteLength);
            plain.set(proofBytes, 0);
            plain.set(bytes, proofBytes.length);

            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ct = new Uint8Array(await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv }, aesKey, plain));

            const out = new Uint8Array(1 + epkBytes.length + 12 + ct.byteLength);
            out[0] = SEALED_BINARY_VERSION;
            out.set(epkBytes, 1);
            out.set(iv, 1 + epkBytes.length);
            out.set(ct, 1 + epkBytes.length + 12);
            return out;
        };

        return { ephemeralPublicKey, ephemeralPrivateKey, seal };
    }

    /**
     * Open a sealed binary envelope.
     *
     * @param {Uint8Array} sealed
     * @param {Object} params
     * @param {string} params.myPrivateKey
     * @param {string} params.myAddress
     * @returns {Promise<{sender: string, bytes: Uint8Array}>}
     */
    async openBinary(sealed, { myPrivateKey, myAddress }) {
        if (!this.isSealedBinary(sealed)) {
            throw new Error('Not a sealed binary envelope');
        }

        const epk = ethers.hexlify(sealed.slice(1, 34));
        const aesKey = await this.deriveSealedKey(myPrivateKey, epk);

        const iv = sealed.slice(34, 46);
        const ct = sealed.slice(46);
        const plain = new Uint8Array(await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv }, aesKey, ct));

        if (plain.byteLength < 65) {
            throw new Error('Sealed binary carries no identity proof');
        }

        // Recomputed with OUR address, exactly as in open(): a proof bound to
        // someone else recovers to a different, meaningless address.
        const digest = this.bindDigest(myAddress, epk);
        const sender = ethers.recoverAddress(digest, ethers.hexlify(plain.slice(0, 65)));

        return { sender, bytes: plain.slice(65) };
    }

    /**
     * Clear all cached keys (on disconnect/logout).
     */
    clear() {
        this.sharedKeys.clear();
        this.peerPublicKeys.clear();
    }

    // -- Helpers --

    bufToBase64(buf) {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Returns a Uint8Array, not the underlying ArrayBuffer.
     *
     * WebCrypto accepts either, but a bare ArrayBuffer fails SubtleCrypto's
     * type check when it crosses a realm boundary — which is exactly what
     * happens under jsdom, and could happen anywhere this runs inside a worker
     * or sandboxed frame. A TypedArray is the portable choice.
     */
    base64ToBuf(b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
}

export const dmCrypto = new DMCrypto();
