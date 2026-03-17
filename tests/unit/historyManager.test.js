/**
 * Tests for historyManager.js - Browser history integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { historyManager } from '../../src/js/historyManager.js';

describe('HistoryManager', () => {
    let originalHistory;
    let originalLocation;
    
    beforeEach(() => {
        // Reset manager state
        historyManager.isNavigating = false;
        historyManager.initialized = false;
        historyManager.onNavigate = null;
        
        // Mock window.history
        originalHistory = window.history;
        window.history.pushState = vi.fn();
        window.history.replaceState = vi.fn();
        window.history.back = vi.fn();
        window.history.forward = vi.fn();
        
        // Mock location
        originalLocation = window.location;
        delete window.location;
        window.location = {
            hash: '',
            pathname: '/app'
        };
    });

    afterEach(() => {
        // Cleanup
        historyManager.destroy();
        vi.restoreAllMocks();
    });

    describe('init()', () => {
        it('should set initialized to true', () => {
            historyManager.init(vi.fn());
            expect(historyManager.initialized).toBe(true);
        });
        
        it('should store navigate callback', () => {
            const callback = vi.fn();
            historyManager.init(callback);
            expect(historyManager.onNavigate).toBe(callback);
        });
        
        it('should not reinitialize if already initialized', () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            
            historyManager.init(callback1);
            historyManager.init(callback2);
            
            expect(historyManager.onNavigate).toBe(callback1);
        });
    });

    describe('pushState()', () => {
        it('should call history.pushState', () => {
            historyManager.pushState({ view: 'explore' });
            
            expect(window.history.pushState).toHaveBeenCalled();
        });
        
        it('should include state with timestamp', () => {
            const before = Date.now();
            historyManager.pushState({ view: 'channel', streamId: '0x123' });
            
            const calledState = window.history.pushState.mock.calls[0][0];
            expect(calledState.view).toBe('channel');
            expect(calledState.streamId).toBe('0x123');
            expect(calledState.timestamp).toBeGreaterThanOrEqual(before);
        });
        
        it('should generate correct URL for channel view', () => {
            historyManager.pushState({ view: 'channel', streamId: '0xABC' });
            
            const calledUrl = window.history.pushState.mock.calls[0][2];
            expect(calledUrl).toBe('/app#/channel/0xABC');
        });
        
        it('should not push while navigating', () => {
            historyManager.isNavigating = true;
            historyManager.pushState({ view: 'explore' });
            
            expect(window.history.pushState).not.toHaveBeenCalled();
        });
        
        it('should call replaceState when replace=true', () => {
            historyManager.pushState({ view: 'explore' }, true);
            
            expect(window.history.replaceState).toHaveBeenCalled();
            expect(window.history.pushState).not.toHaveBeenCalled();
        });
    });

    describe('replaceState()', () => {
        it('should call pushState with replace=true', () => {
            historyManager.replaceState({ view: 'settings' });
            
            expect(window.history.replaceState).toHaveBeenCalled();
        });
    });

    describe('back()', () => {
        it('should call history.back', () => {
            historyManager.back();
            expect(window.history.back).toHaveBeenCalled();
        });
    });

    describe('forward()', () => {
        it('should call history.forward', () => {
            historyManager.forward();
            expect(window.history.forward).toHaveBeenCalled();
        });
    });

    describe('parseUrl()', () => {
        describe('default/empty', () => {
            it('should return explore for empty hash', () => {
                const result = historyManager.parseUrl('');
                expect(result).toEqual({ view: 'explore' });
            });
            
            it('should return explore for # only', () => {
                const result = historyManager.parseUrl('#');
                expect(result).toEqual({ view: 'explore' });
            });
            
            it('should return explore for #/', () => {
                const result = historyManager.parseUrl('#/');
                expect(result).toEqual({ view: 'explore' });
            });
        });

        describe('explore view', () => {
            it('should parse #/explore', () => {
                const result = historyManager.parseUrl('#/explore');
                expect(result.view).toBe('explore');
                expect(result.filter).toBe('all');
            });
            
            it('should parse #/explore with filter', () => {
                const result = historyManager.parseUrl('#/explore/recent');
                expect(result.view).toBe('explore');
                expect(result.filter).toBe('recent');
            });
            
            it('should parse #/explore with filter and category', () => {
                const result = historyManager.parseUrl('#/explore/category/tech');
                expect(result.view).toBe('explore');
                expect(result.filter).toBe('category');
                expect(result.category).toBe('tech');
            });
        });

        describe('channel view', () => {
            it('should parse #/channel/streamId', () => {
                const result = historyManager.parseUrl('#/channel/0x123abc');
                expect(result.view).toBe('channel');
                expect(result.streamId).toBe('0x123abc');
            });
            
            it('should handle streamId with slashes', () => {
                const result = historyManager.parseUrl('#/channel/streams/0x123/test');
                expect(result.view).toBe('channel');
                expect(result.streamId).toBe('streams/0x123/test');
            });
            
            it('should return explore if no streamId', () => {
                const result = historyManager.parseUrl('#/channel');
                expect(result.view).toBe('explore');
            });
        });

        describe('preview view', () => {
            it('should parse #/preview/streamId', () => {
                const result = historyManager.parseUrl('#/preview/0xDEF');
                expect(result.view).toBe('preview');
                expect(result.streamId).toBe('0xDEF');
            });
            
            it('should handle streamId with slashes', () => {
                const result = historyManager.parseUrl('#/preview/path/to/stream');
                expect(result.view).toBe('preview');
                expect(result.streamId).toBe('path/to/stream');
            });
            
            it('should return explore if no streamId', () => {
                const result = historyManager.parseUrl('#/preview');
                expect(result.view).toBe('explore');
            });
        });

        describe('settings view', () => {
            it('should parse #/settings', () => {
                const result = historyManager.parseUrl('#/settings');
                expect(result.view).toBe('settings');
            });
        });

        describe('unknown views', () => {
            it('should return explore for unknown view', () => {
                const result = historyManager.parseUrl('#/unknown');
                expect(result.view).toBe('explore');
            });
            
            it('should return explore for random path', () => {
                const result = historyManager.parseUrl('#/some/random/path');
                expect(result.view).toBe('explore');
            });
        });
    });

    describe('getInitialState()', () => {
        it('should parse current window.location.hash', () => {
            window.location.hash = '#/channel/0xINIT';
            
            const result = historyManager.getInitialState();
            expect(result.view).toBe('channel');
            expect(result.streamId).toBe('0xINIT');
        });
        
        it('should return explore for empty hash', () => {
            window.location.hash = '';
            
            const result = historyManager.getInitialState();
            expect(result.view).toBe('explore');
        });
    });

    describe('_stateToUrl()', () => {
        it('should generate URL for channel view', () => {
            const url = historyManager._stateToUrl({ 
                view: 'channel', 
                streamId: '0xTEST' 
            });
            expect(url).toBe('/app#/channel/0xTEST');
        });
        
        it('should generate URL for preview view', () => {
            const url = historyManager._stateToUrl({ 
                view: 'preview', 
                streamId: '0xPREV' 
            });
            expect(url).toBe('/app#/preview/0xPREV');
        });
        
        it('should generate URL for explore view', () => {
            const url = historyManager._stateToUrl({ view: 'explore' });
            expect(url).toBe('/app#/explore');
        });
        
        it('should generate URL for explore with filter', () => {
            const url = historyManager._stateToUrl({ 
                view: 'explore', 
                filter: 'recent' 
            });
            expect(url).toBe('/app#/explore/recent');
        });
        
        it('should not include filter if "all"', () => {
            const url = historyManager._stateToUrl({ 
                view: 'explore', 
                filter: 'all' 
            });
            expect(url).toBe('/app#/explore');
        });
        
        it('should generate URL for settings view', () => {
            const url = historyManager._stateToUrl({ view: 'settings' });
            expect(url).toBe('/app#/settings');
        });
        
        it('should default to explore for unknown view', () => {
            const url = historyManager._stateToUrl({ view: 'unknown' });
            expect(url).toBe('/app#/explore');
        });
    });

    describe('_handlePopState()', () => {
        it('should call onNavigate with state from event', () => {
            const callback = vi.fn();
            historyManager.init(callback);
            
            const mockEvent = {
                state: { view: 'channel', streamId: '0xPOP' }
            };
            
            historyManager._handlePopState(mockEvent);
            
            expect(callback).toHaveBeenCalledWith(mockEvent.state);
        });
        
        it('should parse URL if event has no state', () => {
            const callback = vi.fn();
            historyManager.init(callback);
            window.location.hash = '#/settings';
            
            historyManager._handlePopState({ state: null });
            
            expect(callback).toHaveBeenCalledWith({ view: 'settings' });
        });
        
        it('should set isNavigating flag', () => {
            const callback = vi.fn();
            historyManager.init(callback);
            
            historyManager._handlePopState({ state: { view: 'explore' } });
            
            expect(historyManager.isNavigating).toBe(true);
        });
        
        it('should reset isNavigating flag after timeout', async () => {
            const callback = vi.fn();
            historyManager.init(callback);
            
            historyManager._handlePopState({ state: { view: 'explore' } });
            expect(historyManager.isNavigating).toBe(true);
            
            // Wait for timeout
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(historyManager.isNavigating).toBe(false);
        });
        
        it('should not call callback if not initialized', () => {
            const callback = vi.fn();
            // Don't call init
            
            historyManager._handlePopState({ state: { view: 'explore' } });
            
            expect(callback).not.toHaveBeenCalled();
        });
        
        it('should not call callback for modal states', () => {
            const callback = vi.fn();
            historyManager.init(callback);
            
            // This is a modal state pushed by ModalManager
            historyManager._handlePopState({ state: { modal: 'new-channel-modal' } });
            
            expect(callback).not.toHaveBeenCalled();
        });
        
        it('should skip navigation for any modal state', () => {
            const callback = vi.fn();
            historyManager.init(callback);
            
            historyManager._handlePopState({ state: { modal: 'settings-modal' } });
            historyManager._handlePopState({ state: { modal: 'contacts-modal' } });
            
            expect(callback).not.toHaveBeenCalled();
        });
        
        it('should not set isNavigating flag for modal states', () => {
            historyManager.init(vi.fn());
            historyManager.isNavigating = false;
            
            historyManager._handlePopState({ state: { modal: 'new-channel-modal' } });
            
            expect(historyManager.isNavigating).toBe(false);
        });
    });

    describe('destroy()', () => {
        it('should set initialized to false', () => {
            historyManager.init(vi.fn());
            expect(historyManager.initialized).toBe(true);
            
            historyManager.destroy();
            expect(historyManager.initialized).toBe(false);
        });
    });

    describe('URL roundtrip', () => {
        it('should parse what it generates for channel', () => {
            const original = { view: 'channel', streamId: '0xROUND' };
            const url = historyManager._stateToUrl(original);
            const hash = '#' + url.split('#')[1];
            const parsed = historyManager.parseUrl(hash);
            
            expect(parsed.view).toBe(original.view);
            expect(parsed.streamId).toBe(original.streamId);
        });
        
        it('should parse what it generates for preview', () => {
            const original = { view: 'preview', streamId: '0xPREV123' };
            const url = historyManager._stateToUrl(original);
            const hash = '#' + url.split('#')[1];
            const parsed = historyManager.parseUrl(hash);
            
            expect(parsed.view).toBe(original.view);
            expect(parsed.streamId).toBe(original.streamId);
        });
        
        it('should parse what it generates for explore with filter', () => {
            const original = { view: 'explore', filter: 'popular' };
            const url = historyManager._stateToUrl(original);
            const hash = '#' + url.split('#')[1];
            const parsed = historyManager.parseUrl(hash);
            
            expect(parsed.view).toBe(original.view);
            expect(parsed.filter).toBe(original.filter);
        });
        
        it('should parse what it generates for settings', () => {
            const original = { view: 'settings' };
            const url = historyManager._stateToUrl(original);
            const hash = '#' + url.split('#')[1];
            const parsed = historyManager.parseUrl(hash);
            
            expect(parsed.view).toBe(original.view);
        });
    });
});
