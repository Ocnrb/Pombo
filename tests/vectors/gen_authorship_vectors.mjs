// One-shot generator for the Members-only authorship parity vectors embedded
// in tests/unit/authorship.test.js (web) and AuthorshipTest.kt (Android).
// Signatures are RFC 6979 deterministic, but the vectors are consumed by
// VERIFICATION (open a web-produced wrapper), not by sign-equality.
import { SigningKey, keccak256, toUtf8Bytes, computeAddress } from 'ethers';

const ACCOUNT_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PSEUDONYM_PRIV = '0x' + '5e'.repeat(31) + '01';
const STREAM = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1';
const PAYLOAD = { type: 'text', id: 'msg-0001', text: 'olá autoria selada', timestamp: 1787000000000 };

const pseudonymPub = new SigningKey(PSEUDONYM_PRIV).compressedPublicKey;
const p = JSON.stringify(PAYLOAD);

const bindDigest = keccak256(toUtf8Bytes(
    `POMBO_BIND_V1|${STREAM.toLowerCase()}|${pseudonymPub.toLowerCase()}`));
const bp = new SigningKey(ACCOUNT_PRIV).sign(bindDigest).serialized;

const msgDigest = keccak256(toUtf8Bytes(`POMBO_MSG_V1|${STREAM.toLowerCase()}|${p}`));
const sig = new SigningKey(PSEUDONYM_PRIV).sign(msgDigest).serialized;

console.log(JSON.stringify({
    accountPriv: ACCOUNT_PRIV,
    author: computeAddress(new SigningKey(ACCOUNT_PRIV).publicKey).toLowerCase(),
    pseudonymPriv: PSEUDONYM_PRIV,
    streamId: STREAM,
    wrapper: { v: 1, p, pk: pseudonymPub, sig, bp }
}, null, 2));
