/**
 * Tests for storageEndpoints.js — on-chain storage endpoint resolution,
 * caching, health rotation and format=metadata capability tracking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const mockClient = {
    getStream: vi.fn(),
    getStorageNodeMetadata: vi.fn()
};

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: { get client() { return mockClient; } },
    isWebSafeStorageNodeUrl: (u) => typeof u === 'string' && u.startsWith('https://') && !u.includes('localhost')
}));

import { storageEndpoints } from '../../src/js/storageEndpoints.js';
import { CONFIG } from '../../src/js/config.js';

const NODE_A = '0xAAA0000000000000000000000000000000000001';
const NODE_B = '0xBBB0000000000000000000000000000000000002';

describe('storageEndpoints', () => {
    beforeEach(() => {
        storageEndpoints.clear();
        vi.clearAllMocks();
        mockClient.getStream.mockResolvedValue({
            getStorageNodes: () => Promise.resolve([NODE_A, NODE_B])
        });
        mockClient.getStorageNodeMetadata.mockImplementation((addr) => {
            if (addr === NODE_A) return Promise.resolve({ urls: ['https://node-a.example/', 'http://insecure.example'] });
            if (addr === NODE_B) return Promise.resolve({ urls: ['https://node-b.example'] });
            return Promise.reject(new Error('unknown node'));
        });
    });

    it('resolves nodes and filters non-web-safe URLs', async () => {
        const nodes = await storageEndpoints.resolve('0xchan/foo-1');
        expect(nodes).toHaveLength(2);
        expect(nodes[0]).toEqual({ nodeAddress: NODE_A.toLowerCase(), urls: ['https://node-a.example'] });
        expect(nodes[1].urls).toEqual(['https://node-b.example']);
    });

    it('drops nodes whose metadata read fails, keeps the rest', async () => {
        mockClient.getStorageNodeMetadata.mockImplementation((addr) =>
            addr === NODE_B ? Promise.resolve({ urls: ['https://node-b.example'] }) : Promise.reject(new Error('rpc down')));
        const nodes = await storageEndpoints.resolve('0xchan/foo-1');
        expect(nodes).toHaveLength(1);
        expect(nodes[0].nodeAddress).toBe(NODE_B.toLowerCase());
    });

    it('drops nodes with no web-safe URL', async () => {
        mockClient.getStorageNodeMetadata.mockResolvedValue({ urls: ['http://plain.example', 'https://localhost:8443'] });
        const nodes = await storageEndpoints.resolve('0xchan/foo-1');
        expect(nodes).toHaveLength(0);
    });

    it('caches per stream within the TTL', async () => {
        await storageEndpoints.resolve('0xchan/foo-1');
        await storageEndpoints.resolve('0xchan/foo-1');
        expect(mockClient.getStream).toHaveBeenCalledTimes(1);
    });

    it('invalidate() forces a fresh resolution', async () => {
        await storageEndpoints.resolve('0xchan/foo-1');
        storageEndpoints.invalidate('0xchan/foo-1');
        await storageEndpoints.resolve('0xchan/foo-1');
        expect(mockClient.getStream).toHaveBeenCalledTimes(2);
    });

    it('handles the array-shaped getStorageNodes return', async () => {
        mockClient.getStream.mockResolvedValue({ getStorageNodes: () => [NODE_A] });
        const nodes = await storageEndpoints.resolve('0xchan/foo-1');
        expect(nodes).toHaveLength(1);
    });

    it('rotation() lists one healthy URL per node', async () => {
        const rot = await storageEndpoints.rotation('0xchan/foo-1');
        expect(rot).toEqual(['https://node-a.example', 'https://node-b.example']);
    });

    it('rotation() ejects a node after consecutive failures and restores on success', async () => {
        const limit = CONFIG.storageMedia.nodeFailureLimit;
        for (let i = 0; i < limit; i++) storageEndpoints.noteFailure('https://node-a.example');
        let rot = await storageEndpoints.rotation('0xchan/foo-1');
        expect(rot).toEqual(['https://node-b.example']);

        storageEndpoints.noteSuccess('https://node-a.example');
        rot = await storageEndpoints.rotation('0xchan/foo-1');
        expect(rot).toContain('https://node-a.example');
    });

    it('a success resets the consecutive-failure count', async () => {
        const limit = CONFIG.storageMedia.nodeFailureLimit;
        for (let i = 0; i < limit - 1; i++) storageEndpoints.noteFailure('https://node-a.example');
        storageEndpoints.noteSuccess('https://node-a.example');
        for (let i = 0; i < limit - 1; i++) storageEndpoints.noteFailure('https://node-a.example');
        const rot = await storageEndpoints.rotation('0xchan/foo-1');
        expect(rot).toContain('https://node-a.example');
    });

    it('tracks format=metadata support per URL', () => {
        expect(storageEndpoints.supportsMetaFormat('https://node-a.example')).toBeUndefined();
        storageEndpoints.setMetaFormatSupport('https://node-a.example', false);
        expect(storageEndpoints.supportsMetaFormat('https://node-a.example')).toBe(false);
        // trailing-slash normalization
        expect(storageEndpoints.supportsMetaFormat('https://node-a.example/')).toBe(false);
    });
});
