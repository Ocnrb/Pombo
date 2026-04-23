/**
 * Explore Curation Tests
 * Tests for the manifest-based pin/hide curation applied to the Explore view.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

import { applyCuration, loadCurationManifest } from '../../src/js/exploreCuration.js';
import { Logger } from '../../src/js/logger.js';

const ch = (streamId, extra = {}) => ({ streamId, name: streamId, ...extra });

describe('applyCuration', () => {
    it('returns input unchanged when manifest is empty', () => {
        const channels = [ch('a/1'), ch('b/2'), ch('c/3')];
        const result = applyCuration(channels, { pinned: [], hidden: [] });
        expect(result.map(c => c.streamId)).toEqual(['a/1', 'b/2', 'c/3']);
    });

    it('returns a new array (does not mutate input)', () => {
        const channels = [ch('a/1'), ch('b/2')];
        const result = applyCuration(channels, { pinned: ['b/2'], hidden: [] });
        expect(result).not.toBe(channels);
        expect(channels.map(c => c.streamId)).toEqual(['a/1', 'b/2']);
    });

    it('handles empty/null input gracefully', () => {
        expect(applyCuration([], { pinned: ['x'], hidden: [] })).toEqual([]);
        expect(applyCuration(null, { pinned: [], hidden: [] })).toEqual([]);
        expect(applyCuration(undefined, { pinned: [], hidden: [] })).toEqual([]);
    });

    it('returns a copy when manifest is missing', () => {
        const channels = [ch('a/1')];
        const result = applyCuration(channels, null);
        expect(result).toEqual(channels);
        expect(result).not.toBe(channels);
    });

    it('removes hidden channels', () => {
        const channels = [ch('a/1'), ch('b/2'), ch('c/3')];
        const result = applyCuration(channels, { pinned: [], hidden: ['b/2'] });
        expect(result.map(c => c.streamId)).toEqual(['a/1', 'c/3']);
    });

    it('hides case-insensitively', () => {
        const channels = [ch('0xABC/Welcome'), ch('0xDEF/spam')];
        const result = applyCuration(channels, { pinned: [], hidden: ['0xdef/SPAM'] });
        expect(result.map(c => c.streamId)).toEqual(['0xABC/Welcome']);
    });

    it('places pinned channels at the top in manifest order', () => {
        const channels = [ch('a/1'), ch('b/2'), ch('c/3'), ch('d/4')];
        const result = applyCuration(channels, {
            pinned: ['c/3', 'a/1'],
            hidden: []
        });
        expect(result.map(c => c.streamId)).toEqual(['c/3', 'a/1', 'b/2', 'd/4']);
    });

    it('preserves original relative order for non-pinned channels', () => {
        const channels = [ch('a/1'), ch('b/2'), ch('c/3'), ch('d/4')];
        const result = applyCuration(channels, { pinned: ['b/2'], hidden: [] });
        expect(result.map(c => c.streamId)).toEqual(['b/2', 'a/1', 'c/3', 'd/4']);
    });

    it('silently ignores pinned streamIds not present in input', () => {
        const channels = [ch('a/1'), ch('b/2')];
        const result = applyCuration(channels, {
            pinned: ['nonexistent/x', 'b/2', 'also/missing'],
            hidden: []
        });
        expect(result.map(c => c.streamId)).toEqual(['b/2', 'a/1']);
    });

    it('applies hidden before pinned (a hidden+pinned channel is removed)', () => {
        const channels = [ch('a/1'), ch('b/2')];
        const result = applyCuration(channels, {
            pinned: ['b/2'],
            hidden: ['b/2']
        });
        expect(result.map(c => c.streamId)).toEqual(['a/1']);
    });

    it('does not duplicate when the same streamId appears twice in pinned', () => {
        const channels = [ch('a/1'), ch('b/2'), ch('c/3')];
        const result = applyCuration(channels, {
            pinned: ['b/2', 'b/2'],
            hidden: []
        });
        expect(result.map(c => c.streamId)).toEqual(['b/2', 'a/1', 'c/3']);
    });
});

describe('loadCurationManifest', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        vi.clearAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
    });

    it('fetches the manifest and normalizes string and object entries', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                pinned: ['A/1', { streamId: 'B/2' }, '', null, { foo: 'bar' }],
                hidden: [{ streamId: 'C/3' }]
            })
        });

        const manifest = await loadCurationManifest({ force: true });
        expect(manifest.pinned).toEqual(['a/1', 'b/2']);
        expect(manifest.hidden).toEqual(['c/3']);
    });

    it('de-duplicates entries while preserving order', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                pinned: ['a/1', 'A/1', 'b/2'],
                hidden: ['x/1', 'x/1']
            })
        });

        const manifest = await loadCurationManifest({ force: true });
        expect(manifest.pinned).toEqual(['a/1', 'b/2']);
        expect(manifest.hidden).toEqual(['x/1']);
    });

    it('falls back to empty manifest on HTTP error', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

        const manifest = await loadCurationManifest({ force: true });
        expect(manifest).toEqual({ pinned: [], hidden: [] });
        expect(Logger.warn).toHaveBeenCalled();
    });

    it('falls back to empty manifest on network error', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));

        const manifest = await loadCurationManifest({ force: true });
        expect(manifest).toEqual({ pinned: [], hidden: [] });
        expect(Logger.warn).toHaveBeenCalled();
    });

    it('falls back to empty manifest on invalid JSON', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => { throw new SyntaxError('bad json'); }
        });

        const manifest = await loadCurationManifest({ force: true });
        expect(manifest).toEqual({ pinned: [], hidden: [] });
    });

    it('tolerates missing fields in the manifest', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({})
        });

        const manifest = await loadCurationManifest({ force: true });
        expect(manifest).toEqual({ pinned: [], hidden: [] });
    });

    it('coalesces concurrent in-flight requests', async () => {
        let resolveFetch;
        globalThis.fetch = vi.fn(() => new Promise(res => { resolveFetch = res; }));

        const p1 = loadCurationManifest({ force: true });
        const p2 = loadCurationManifest({ force: true });

        resolveFetch({ ok: true, json: async () => ({ pinned: ['a/1'], hidden: [] }) });
        const [m1, m2] = await Promise.all([p1, p2]);

        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(m1).toBe(m2);
        expect(m1.pinned).toEqual(['a/1']);
    });
});
