/**
 * Tests for adminStatePoller.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../src/js/config.js', () => ({
    CONFIG: {
        subscriptions: {
            adminPollIntervalMs: 30000
        }
    }
}));

import { adminStatePoller } from '../../src/js/adminStatePoller.js';

describe('AdminStatePoller', () => {
    beforeEach(() => {
        adminStatePoller.stop();
        vi.useFakeTimers();
        // Reset document.hidden between tests
        Object.defineProperty(document, 'hidden', {
            configurable: true, get: () => false
        });
    });

    afterEach(() => {
        adminStatePoller.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('start() / stop()', () => {
        it('records the active streamId', () => {
            const fn = vi.fn();
            adminStatePoller.start('stream-1', fn);
            expect(adminStatePoller.getStreamId()).toBe('stream-1');
        });

        it('clears state on stop()', () => {
            adminStatePoller.start('stream-1', vi.fn());
            adminStatePoller.stop();
            expect(adminStatePoller.getStreamId()).toBeNull();
        });

        it('does not call refreshFn immediately', () => {
            const fn = vi.fn();
            adminStatePoller.start('stream-1', fn);
            expect(fn).not.toHaveBeenCalled();
        });

        it('rejects invalid args silently', () => {
            adminStatePoller.start(null, vi.fn());
            expect(adminStatePoller.getStreamId()).toBeNull();
            adminStatePoller.start('s', null);
            expect(adminStatePoller.getStreamId()).toBeNull();
        });

        it('switching streamId stops previous timer', () => {
            const fn1 = vi.fn().mockResolvedValue(undefined);
            const fn2 = vi.fn().mockResolvedValue(undefined);
            adminStatePoller.start('stream-1', fn1);
            adminStatePoller.start('stream-2', fn2);
            expect(adminStatePoller.getStreamId()).toBe('stream-2');
            vi.advanceTimersByTime(30000);
            expect(fn1).not.toHaveBeenCalled();
            expect(fn2).toHaveBeenCalledTimes(1);
        });
    });

    describe('periodic polling', () => {
        it('calls refreshFn on every interval tick', async () => {
            const fn = vi.fn().mockResolvedValue(undefined);
            adminStatePoller.start('stream-1', fn);
            await vi.advanceTimersByTimeAsync(30000);
            expect(fn).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(30000);
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('skips overlapping ticks (re-entrancy guard)', async () => {
            let resolveSlow;
            const slow = new Promise((r) => { resolveSlow = r; });
            const fn = vi.fn().mockImplementation(() => slow);
            adminStatePoller.start('stream-1', fn);
            await vi.advanceTimersByTimeAsync(30000);
            await vi.advanceTimersByTimeAsync(30000); // would re-enter, must skip
            expect(fn).toHaveBeenCalledTimes(1);
            resolveSlow();
        });
    });

    describe('pollNow() coalescing', () => {
        it('coalesces multiple calls into one refresh', async () => {
            const fn = vi.fn().mockResolvedValue(undefined);
            adminStatePoller.start('stream-1', fn);
            adminStatePoller.pollNow();
            adminStatePoller.pollNow();
            adminStatePoller.pollNow();
            await vi.advanceTimersByTimeAsync(60);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('does nothing if not started', async () => {
            const fn = vi.fn();
            adminStatePoller.pollNow();
            await vi.advanceTimersByTimeAsync(100);
            expect(fn).not.toHaveBeenCalled();
        });
    });

    describe('markFresh()', () => {
        it('restarts the periodic interval', async () => {
            const fn = vi.fn().mockResolvedValue(undefined);
            adminStatePoller.start('stream-1', fn);
            await vi.advanceTimersByTimeAsync(20000);
            adminStatePoller.markFresh();
            // Old timer cleared; new 30s window starts now.
            await vi.advanceTimersByTimeAsync(20000); // total 40s but only 20s after markFresh
            expect(fn).toHaveBeenCalledTimes(0);
            await vi.advanceTimersByTimeAsync(15000); // 35s after markFresh — fires
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe('visibility pause/resume', () => {
        it('pauses interval when document becomes hidden', async () => {
            const fn = vi.fn().mockResolvedValue(undefined);
            adminStatePoller.start('stream-1', fn);

            Object.defineProperty(document, 'hidden', {
                configurable: true, get: () => true
            });
            document.dispatchEvent(new Event('visibilitychange'));

            await vi.advanceTimersByTimeAsync(60000);
            expect(fn).toHaveBeenCalledTimes(0);
        });

        it('on resume, fires immediate pollNow and restarts interval', async () => {
            const fn = vi.fn().mockResolvedValue(undefined);
            adminStatePoller.start('stream-1', fn);

            Object.defineProperty(document, 'hidden', {
                configurable: true, get: () => true
            });
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(60000);
            expect(fn).toHaveBeenCalledTimes(0);

            Object.defineProperty(document, 'hidden', {
                configurable: true, get: () => false
            });
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(60); // coalesce window
            expect(fn).toHaveBeenCalledTimes(1); // pollNow

            await vi.advanceTimersByTimeAsync(30000);
            expect(fn).toHaveBeenCalledTimes(2);
        });
    });

    describe('error handling', () => {
        it('does not throw when refreshFn rejects', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('network'));
            adminStatePoller.start('stream-1', fn);
            await vi.advanceTimersByTimeAsync(30000);
            expect(fn).toHaveBeenCalledTimes(1);
            // Subsequent ticks still run
            await vi.advanceTimersByTimeAsync(30000);
            expect(fn).toHaveBeenCalledTimes(2);
        });
    });
});
