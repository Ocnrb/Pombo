/**
 * Tests for identity.js — storage_file_announce manifest signing/hashing.
 * The canonical JSON string is the cross-client contract: field ORDER and
 * null-defaults must never drift (Android will reproduce it byte for byte).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn(() => '0xTestUser'),
        signMessage: vi.fn(() => Promise.resolve('0xMockSignature'))
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn(() => true),
        getUsername: vi.fn(() => null),
        setUsername: vi.fn(),
        getTrustedContacts: vi.fn(() => ({})),
        setTrustedContacts: vi.fn(),
        getENSCache: vi.fn(() => ({})),
        setENSCache: vi.fn()
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

vi.mock('../../src/js/workers/cryptoWorkerPool.js', () => ({
    cryptoWorkerPool: { execute: vi.fn() }
}));

// Capture what gets hashed — keccak256 input IS the canonical form
const hashedInputs = [];
globalThis.ethers = {
    keccak256: vi.fn((bytes) => {
        hashedInputs.push(new TextDecoder().decode(bytes));
        return '0xMockHash';
    }),
    toUtf8Bytes: vi.fn((str) => new TextEncoder().encode(str)),
    Network: { from: vi.fn(() => ({ name: 'mainnet', chainId: 1n })) },
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
        lookupAddress: vi.fn(() => Promise.resolve(null)),
        resolveName: vi.fn(() => Promise.resolve(null))
    }))
};

import { identityManager } from '../../src/js/identity.js';
import { authManager } from '../../src/js/auth.js';

const METADATA = {
    transferId: 'ab'.repeat(16),
    fileName: 'report.pdf',
    fileType: 'application/pdf',
    originalSize: 123456,
    compressedSize: 100000,
    compression: 'deflate',
    totalChunks: 12,
    chunkDataSize: 245000,
    chunkPartitions: 9,
    firstChunkPartition: 2,
    firstChunkTs: 1753200000000,
    lastChunkTs: 1753200060000,
    storedChunks: 12,
    encSalt: 'c2FsdHNhbHRzYWx0c2E='
};

describe('createStorageFileManifestHash', () => {
    beforeEach(() => { hashedInputs.length = 0; });

    it('produces the canonical field order (cross-client contract)', () => {
        identityManager.createStorageFileManifestHash({
            id: 'msg1', sender: '0xABCDEF', timestamp: 42, channelId: '0xchan/x-1', metadata: METADATA
        });
        const parsed = JSON.parse(hashedInputs[0]);
        expect(Object.keys(parsed)).toEqual([
            'protocol', 'version', 'type', 'id', 'sender', 'timestamp', 'channelId',
            'transferId', 'fileName', 'fileType', 'originalSize', 'compressedSize',
            'compression', 'totalChunks', 'chunkDataSize', 'chunkPartitions',
            'firstChunkPartition', 'firstChunkTs', 'lastChunkTs', 'storedChunks', 'encSalt'
        ]);
        expect(parsed.protocol).toBe('POMBO');
        expect(parsed.version).toBe(1);
        expect(parsed.type).toBe('storage_file_announce');
        expect(parsed.sender).toBe('0xabcdef'); // lowercased
    });

    it('missing metadata fields hash as null, not undefined', () => {
        identityManager.createStorageFileManifestHash({
            id: 'msg1', sender: '0xA', timestamp: 1, channelId: 'c', metadata: { transferId: 't' }
        });
        const parsed = JSON.parse(hashedInputs[0]);
        expect(parsed.fileName).toBeNull();
        expect(parsed.storedChunks).toBeNull();
        expect(parsed.encSalt).toBeNull();
    });

    it('is deterministic and sensitive to metadata changes', () => {
        const input = { id: 'msg1', sender: '0xA', timestamp: 1, channelId: 'c', metadata: METADATA };
        identityManager.createStorageFileManifestHash(input);
        identityManager.createStorageFileManifestHash(input);
        expect(hashedInputs[0]).toBe(hashedInputs[1]);

        identityManager.createStorageFileManifestHash({
            ...input, metadata: { ...METADATA, totalChunks: 13 }
        });
        expect(hashedInputs[2]).not.toBe(hashedInputs[0]);
    });
});

describe('createSignedStorageFileManifest', () => {
    it('signs the manifest and returns the announce shape', async () => {
        const msg = await identityManager.createSignedStorageFileManifest({
            channelId: '0xchan/x-1', metadata: METADATA
        });
        expect(msg.type).toBe('storage_file_announce');
        expect(msg.v).toBe(1);
        expect(msg.sender).toBe('0xTestUser');
        expect(msg.metadata).toEqual(METADATA);
        expect(msg.signature).toBe('0xMockSignature');
        expect(msg.replyTo).toBeNull();
        expect(authManager.signMessage).toHaveBeenCalledWith('0xMockHash');
    });

    it('reuses a caller-provided id (optimistic bubble dedupe)', async () => {
        const msg = await identityManager.createSignedStorageFileManifest({
            channelId: 'c', metadata: METADATA, id: 'preset-id-123'
        });
        expect(msg.id).toBe('preset-id-123');
    });
});
