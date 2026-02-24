/**
 * Notification UI Manager
 * Handles toast notifications, loading overlays, and loading indicators
 */

import { Logger } from '../logger.js';
import { escapeHtml } from './utils.js';
import { sanitizeText } from './sanitizer.js';

// Toast icon SVGs
const TOAST_ICONS = {
    success: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
    error: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`,
    info: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    warning: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`
};

class NotificationUI {
    constructor() {
        this.currentLoadingToast = null;
    }

    /**
     * Show loading indicator with spinner overlay
     * @param {string} message - Loading message
     */
    showLoading(message) {
        const overlay = document.getElementById('loading-overlay');
        const textEl = document.getElementById('loading-text');
        if (overlay && textEl) {
            textEl.textContent = message || 'Loading...';
            overlay.classList.add('active');
        }
    }

    /**
     * Hide loading indicator
     */
    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    /**
     * Show toast notification
     * @param {string} message - Notification message
     * @param {string} type - Notification type (success, error, info, warning)
     * @param {number} duration - Duration in ms (default 3000)
     */
    showNotification(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        if (!container) {
            Logger.debug(`[${type}] ${message}`);
            return;
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.style.setProperty('--toast-duration', `${duration}ms`);
        // Defense-in-depth: sanitize then escape user content
        toast.innerHTML = `
            ${TOAST_ICONS[type] || TOAST_ICONS.info}
            <div class="toast-content">
                <span class="toast-message">${escapeHtml(sanitizeText(message))}</span>
            </div>
            <span class="toast-close" title="Dismiss">
                <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </span>
            <div class="toast-progress"></div>
        `;
        
        // Close button handler
        const closeBtn = toast.querySelector('.toast-close');
        closeBtn?.addEventListener('click', () => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 250);
        });
        
        container.appendChild(toast);

        // Auto remove after duration
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('toast-exit');
                setTimeout(() => toast.remove(), 250);
            }
        }, duration);
    }

    /**
     * Show a persistent loading toast notification (for long operations)
     * @param {string} message - Loading message
     * @param {string} subtitle - Optional subtitle with more info
     * @returns {HTMLElement} - Toast element (call hideLoadingToast to dismiss)
     */
    showLoadingToast(message, subtitle = 'This may take a moment...') {
        const container = document.getElementById('toast-container');
        if (!container) {
            Logger.debug(`[loading] ${message}`);
            return null;
        }

        // Remove any existing loading toasts
        container.querySelectorAll('.toast.loading').forEach(t => t.remove());

        const toast = document.createElement('div');
        toast.className = 'toast loading';
        toast.innerHTML = `
            <svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            <div class="toast-content">
                <span class="toast-message">${escapeHtml(message)}</span>
                ${subtitle ? `<span class="text-[11px] text-white/40 block mt-0.5">${escapeHtml(subtitle)}</span>` : ''}
            </div>
            <div class="toast-progress"></div>
        `;
        
        container.appendChild(toast);
        this.currentLoadingToast = toast;
        return toast;
    }

    /**
     * Hide the current loading toast
     * @param {HTMLElement} toast - Optional specific toast to hide
     */
    hideLoadingToast(toast = null) {
        const target = toast || this.currentLoadingToast;
        if (target && target.parentElement) {
            target.classList.add('toast-exit');
            setTimeout(() => target.remove(), 250);
        }
        this.currentLoadingToast = null;
    }

    /**
     * Show loading indicator at top of messages area
     * @param {HTMLElement} messagesArea - The messages container element
     */
    showLoadingMoreIndicator(messagesArea) {
        // Remove existing if any
        this.hideLoadingMoreIndicator();
        
        const indicator = document.createElement('div');
        indicator.id = 'loading-more-indicator';
        indicator.className = 'flex justify-center py-3';
        indicator.innerHTML = `
            <div class="flex items-center gap-2 text-gray-400 text-sm">
                <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Loading older messages...</span>
            </div>
        `;
        messagesArea?.prepend(indicator);
    }

    /**
     * Hide loading indicator from messages area
     */
    hideLoadingMoreIndicator() {
        const indicator = document.getElementById('loading-more-indicator');
        if (indicator) {
            indicator.remove();
        }
    }
}

// Export singleton instance
export const notificationUI = new NotificationUI();
