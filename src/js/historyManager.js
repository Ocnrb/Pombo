/**
 * History Manager
 * Manages browser history integration for in-app navigation
 * Supports deep links via URL hash fragments
 * 
 * URL Structure:
 * - pombo.cc/#/explore - Explore view
 * - pombo.cc/#/channel/streamId - Channel view
 * - pombo.cc/#/preview/streamId - Preview mode
 * - pombo.cc/#/settings - Settings view
 */

import { Logger } from './logger.js';

class HistoryManager {
    constructor() {
        this.isNavigating = false; // Prevents loop when restoring state
        this.initialized = false;
        this.onNavigate = null; // Callback for navigation events
        
        // Bind popstate handler
        this._handlePopState = this._handlePopState.bind(this);
    }

    /**
     * Initialize history manager
     * @param {Function} navigateCallback - Called when user navigates (back/forward)
     */
    init(navigateCallback) {
        if (this.initialized) return;
        
        this.onNavigate = navigateCallback;
        window.addEventListener('popstate', this._handlePopState);
        this.initialized = true;
        
        Logger.info('History manager initialized');
    }

    /**
     * Push a new state to browser history
     * @param {Object} state - State object { view, streamId?, channelInfo?, filter? }
     * @param {boolean} replace - If true, replaces current state instead of pushing
     */
    pushState(state, replace = false) {
        if (this.isNavigating) return; // Don't push while restoring
        
        const url = this._stateToUrl(state);
        const historyState = { ...state, timestamp: Date.now() };
        
        if (replace) {
            window.history.replaceState(historyState, '', url);
            Logger.debug('History replaced:', url);
        } else {
            window.history.pushState(historyState, '', url);
            Logger.debug('History pushed:', url);
        }
    }

    /**
     * Replace current state without adding to history
     * @param {Object} state - State object
     */
    replaceState(state) {
        this.pushState(state, true);
    }

    /**
     * Navigate back
     */
    back() {
        window.history.back();
    }

    /**
     * Navigate forward
     */
    forward() {
        window.history.forward();
    }

    /**
     * Parse URL hash to state object
     * @param {string} hash - URL hash (e.g., '#/channel/0x123...')
     * @returns {Object|null} - State object or null if invalid
     */
    parseUrl(hash = window.location.hash) {
        if (!hash || hash === '#' || hash === '#/') {
            return { view: 'explore' }; // Default view
        }

        // Remove leading # and /
        const path = hash.replace(/^#\/?/, '');
        const parts = path.split('/');
        
        if (parts.length === 0) {
            return { view: 'explore' };
        }

        const view = parts[0];
        
        switch (view) {
            case 'explore':
                return { 
                    view: 'explore',
                    filter: parts[1] || 'all',
                    category: parts[2] || null
                };
                
            case 'channel':
                if (parts.length >= 2) {
                    // Reconstruct streamId (may contain /)
                    const streamId = parts.slice(1).join('/');
                    return { view: 'channel', streamId };
                }
                return { view: 'explore' };
                
            case 'preview':
                if (parts.length >= 2) {
                    const streamId = parts.slice(1).join('/');
                    return { view: 'preview', streamId };
                }
                return { view: 'explore' };
                
            case 'settings':
                return { view: 'settings' };
                
            default:
                // Could be a direct streamId for backward compatibility
                // or invite link format
                return { view: 'explore' };
        }
    }

    /**
     * Get initial state from URL on page load
     * @returns {Object} - Initial state
     */
    getInitialState() {
        return this.parseUrl(window.location.hash);
    }

    /**
     * Convert state to URL hash
     * @param {Object} state - State object
     * @returns {string} - URL with hash
     */
    _stateToUrl(state) {
        const base = window.location.pathname;
        
        switch (state.view) {
            case 'channel':
                return `${base}#/channel/${state.streamId}`;
                
            case 'preview':
                return `${base}#/preview/${state.streamId}`;
                
            case 'explore':
                if (state.filter && state.filter !== 'all') {
                    return `${base}#/explore/${state.filter}`;
                }
                return `${base}#/explore`;
                
            case 'settings':
                return `${base}#/settings`;
                
            default:
                return `${base}#/explore`;
        }
    }

    /**
     * Handle browser back/forward navigation
     * @param {PopStateEvent} event
     * @private
     */
    _handlePopState(event) {
        Logger.debug('Popstate event:', event.state);
        
        // Get state from event or parse URL
        const state = event.state || this.parseUrl();
        
        if (this.onNavigate) {
            this.isNavigating = true;
            try {
                this.onNavigate(state);
            } finally {
                // Reset flag after a tick to allow async operations
                setTimeout(() => {
                    this.isNavigating = false;
                }, 100);
            }
        }
    }

    /**
     * Clean up event listeners
     */
    destroy() {
        window.removeEventListener('popstate', this._handlePopState);
        this.initialized = false;
    }
}

// Singleton export
export const historyManager = new HistoryManager();
