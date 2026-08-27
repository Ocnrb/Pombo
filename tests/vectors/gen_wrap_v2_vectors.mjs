// One-shot generator for the wrap-v2 parity vectors embedded in
// tests/unit/epochKeyCrypto.wrapV2.test.js (web) and EpochKeyCryptoTest.kt
// (Android). Deterministic: fixed account key, epoch key, ephemeral and IV.
import { SigningKey, getBytes, hexlify } from 'ethers';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

const ACCOUNT_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EPOCH_KEY = '0x' + '42'.repeat(32);
const EPH_PRIV = '0x' + '77'.repeat(31) + '01';
const IV = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const REQUEST_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const KEY_ID = '3.deadbeef42';

const spk = new SigningKey(ACCOUNT_PRIV).compressedPublicKey;
const epk = new SigningKey(EPH_PRIV).compressedPublicKey;

const shared = getBytes(new SigningKey(EPH_PRIV).computeSharedSecret(spk)).slice(1, 33);
const keyMaterial = await subtle.importKey('raw', shared, { name: 'HKDF' }, false, ['deriveKey']);
const aesKey = await subtle.deriveKey(
    {
        name: 'HKDF', hash: 'SHA-256',
        salt: new TextEncoder().encode('pombo-keywrap-static-v2'),
        info: new TextEncoder().encode('aes-256-gcm')
    },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: IV }, aesKey, getBytes(EPOCH_KEY)));

const tagInput = `POMBO_WRAP_TAG_V2|${REQUEST_ID}|${KEY_ID}`;
const tag = hexlify(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(tagInput))));

const b64 = (u8) => Buffer.from(u8).toString('base64');
console.log(JSON.stringify({
    accountPriv: ACCOUNT_PRIV,
    spk,
    epochKey: EPOCH_KEY,
    requestId: REQUEST_ID,
    keyId: KEY_ID,
    tag,
    wrapped: { epk, iv: b64(IV), ct: b64(ct) }
}, null, 2));
