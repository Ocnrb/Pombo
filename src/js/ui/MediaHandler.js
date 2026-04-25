/**
 * Media Handler
 * Manages media cache, lightbox, and file downloads
 */

import { Logger } from '../logger.js';
import { isValidMediaUrl } from './utils.js';

class MediaHandler {
    constructor() {
        // Media cache for safe lightbox handling (prevents XSS via onclick)
        // Maps mediaId -> { url, type }
        this.mediaCache = new Map();
        this.mediaIdCounter = 0;
        this.deps = {};
        this._lightboxOpen = false;
        this._popstateHandler = this._onPopState.bind(this);
    }

    /**
     * Set dependencies
     * @param {Object} deps - { showNotification }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Register media URL and get a safe ID for onclick handlers
     * @param {string} url - Media URL (base64, blob, or http)
     * @param {string} type - 'image' or 'video'
     * @returns {string|null} - Safe media ID or null if invalid
     */
    registerMedia(url, type = 'image') {
        // Validate URL before registering
        if (!isValidMediaUrl(url)) {
            Logger.warn('Invalid media URL rejected:', url?.substring(0, 50));
            return null;
        }
        const mediaId = `media_${++this.mediaIdCounter}`;
        this.mediaCache.set(mediaId, { url, type });
        return mediaId;
    }

    /**
     * Get media info by ID
     * @param {string} mediaId - Media ID
     * @returns {{ url: string, type: string }|undefined}
     */
    getMedia(mediaId) {
        return this.mediaCache.get(mediaId);
    }

    /**
     * Open lightbox by media ID (safe method)
     * @param {string} mediaId - Registered media ID
     * @param {Element} [triggerEl] - The DOM element that opened the lightbox
     *   (used to anchor scroll restoration to the originating message).
     */
    openLightboxById(mediaId, triggerEl = null) {
        const media = this.mediaCache.get(mediaId);
        if (media) {
            this.openLightbox(media.url, media.type, triggerEl);
        }
    }

    /**
     * Open media lightbox
     * @param {string} src - Media source URL
     * @param {string} type - 'image' or 'video'
     * @param {Element} [triggerEl] - Element that triggered the open; its closest
     *   `.message-entry` is remembered so we can restore scroll on close.
     */
    openLightbox(src, type = 'image', triggerEl = null) {
        const modal = document.getElementById('media-lightbox-modal');
        const imageEl = document.getElementById('lightbox-image');
        const videoEl = document.getElementById('lightbox-video');
        
        if (!modal) return;
        
        // Reset both
        if (imageEl) imageEl.classList.add('hidden');
        if (videoEl) {
            videoEl.classList.add('hidden');
            videoEl.pause();
            videoEl.src = '';
        }
        
        // Show appropriate media
        if (type === 'image' && imageEl) {
            imageEl.src = src;
            imageEl.classList.remove('hidden');
        } else if (type === 'video' && videoEl) {
            videoEl.src = src;
            videoEl.classList.remove('hidden');
        }
        
        modal.classList.remove('hidden');

        // Unlock native pinch-zoom while lightbox is open
        document.body.style.touchAction = 'manipulation';

        // Snapshot messages-area scroll so we can restore it on close.
        // We anchor on the message element when available — re-finding it
        // and aligning to the same viewport offset is robust to reflows
        // (image decode, viewport meta toggle, address bar resize, etc.).
        const messagesArea = document.getElementById('messages-area');
        if (messagesArea) {
            this._savedScrollEl = messagesArea;
            this._savedScrollTop = messagesArea.scrollTop;
            const anchorEl = triggerEl?.closest?.('.message-entry') || null;
            if (anchorEl && messagesArea.contains(anchorEl)) {
                this._savedAnchorEl = anchorEl;
                this._savedAnchorOffset =
                    anchorEl.getBoundingClientRect().top
                    - messagesArea.getBoundingClientRect().top;
            } else {
                this._savedAnchorEl = null;
                this._savedAnchorOffset = 0;
            }
        } else {
            this._savedScrollEl = null;
            this._savedScrollTop = null;
            this._savedAnchorEl = null;
        }

        // Push history state so back button closes lightbox instead of navigating
        if (!this._lightboxOpen) {
            this._lightboxOpen = true;
            window.history.pushState({ lightbox: true }, '');
            window.addEventListener('popstate', this._popstateHandler, true);
        }
    }

    /**
     * Close media lightbox
     * @param {Object} options - { skipHistory: boolean } skip history.back if popstate already fired
     */
    closeLightbox(options = {}) {
        const modal = document.getElementById('media-lightbox-modal');
        const videoEl = document.getElementById('lightbox-video');
        
        if (videoEl) {
            videoEl.pause();
        }
        
        if (modal) {
            modal.classList.add('hidden');
        }

        // Restore zoom lock and reset any active pinch-zoom to default
        document.body.style.touchAction = '';
        const vp = document.querySelector('meta[name="viewport"]');
        if (vp) {
            const original = vp.getAttribute('content');
            vp.setAttribute('content', original + ', maximum-scale=1');
            requestAnimationFrame(() => vp.setAttribute('content', original));
        }

        // Pop the history entry we pushed (unless triggered by popstate)
        if (this._lightboxOpen) {
            window.removeEventListener('popstate', this._popstateHandler, true);
            if (!options.skipHistory) {
                window.history.back();
            }
            this._lightboxOpen = false;
        }

        // Restore messages-area scroll. We re-pin over ~500ms because the
        // viewport meta toggle, image decode, address-bar resize and
        // history.back() can each schedule a late layout pass that
        // resets scrollTop. We also prefer anchoring on the originating
        // message element when we have one (robust to list reflow).
        const el = this._savedScrollEl;
        const anchorEl = this._savedAnchorEl;
        const anchorOffset = this._savedAnchorOffset || 0;
        const fallbackTop = this._savedScrollTop;

        const apply = () => {
            if (!el || !el.isConnected) return;
            if (anchorEl && el.contains(anchorEl)) {
                const desired =
                    el.scrollTop
                    + (anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top)
                    - anchorOffset;
                el.scrollTop = desired;
            } else if (fallbackTop != null) {
                el.scrollTop = fallbackTop;
            }
        };

        if (el && (anchorEl || fallbackTop != null)) {
            apply();
            // Re-apply on next frames + a short interval to defeat late layout passes.
            requestAnimationFrame(apply);
            requestAnimationFrame(() => requestAnimationFrame(apply));
            const start = Date.now();
            const tick = () => {
                if (Date.now() - start > 500) return;
                apply();
                setTimeout(tick, 50);
            };
            setTimeout(tick, 50);
        }

        this._savedScrollEl = null;
        this._savedScrollTop = null;
        this._savedAnchorEl = null;
        this._savedAnchorOffset = 0;
    }

    /**
     * Handle popstate (back button) while lightbox is open
     * @private
     */
    _onPopState(event) {
        if (this._lightboxOpen) {
            // Close without calling history.back() (popstate already consumed it)
            this.closeLightbox({ skipHistory: true });
            event.stopImmediatePropagation();
        }
    }

    /**
     * Attach click listeners to lightbox trigger elements
     * Uses data-media-id instead of inline onclick to prevent XSS
     */
    attachLightboxListeners() {
        document.querySelectorAll('.lightbox-trigger[data-media-id]').forEach(el => {
            // Skip if already has listener attached
            if (el.dataset.lightboxBound) return;
            el.dataset.lightboxBound = 'true';
            
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const mediaId = el.dataset.mediaId;
                if (mediaId) {
                    this.openLightboxById(mediaId, el);
                }
            });
        });
    }

    /**
     * Initialize lightbox modal event listeners
     * Called once on app startup to avoid inline onclick (CSP 'unsafe-inline')
     */
    initLightboxModal() {
        const modal = document.getElementById('media-lightbox-modal');
        const closeBtn = document.getElementById('lightbox-close-btn');
        const imageEl = document.getElementById('lightbox-image');
        const videoEl = document.getElementById('lightbox-video');

        // Close on overlay click
        if (modal) {
            modal.addEventListener('click', () => this.closeLightbox());
        }

        // Close button
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeLightbox();
            });
        }

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._lightboxOpen) {
                this.closeLightbox();
            }
        });

        // Prevent close when clicking on image/video
        if (imageEl) {
            imageEl.addEventListener('click', (e) => e.stopPropagation());
        }
        if (videoEl) {
            videoEl.addEventListener('click', (e) => e.stopPropagation());
        }
    }

    /**
     * Handle file download button click
     * @param {string} fileId - File ID
     * @param {Object} channel - Current channel
     * @param {Function} mediaController - Media controller for downloads
     */
    async handleFileDownload(fileId, channel, mediaController) {
        if (!channel) return;
        
        // Find the message with this file
        const msg = channel.messages.find(m => m.metadata?.fileId === fileId);
        if (!msg || !msg.metadata) {
            if (this.deps.showNotification) {
                this.deps.showNotification('File not found', 'error');
            }
            return;
        }
        
        // Show progress overlay
        const progressOverlay = document.querySelector(`[data-progress-overlay="${CSS.escape(fileId)}"]`);
        if (progressOverlay) {
            progressOverlay.classList.remove('hidden');
        }
        
        const progressText = document.querySelector(`[data-progress-text="${CSS.escape(fileId)}"]`);
        if (progressText) {
            progressText.textContent = 'Starting...';
        }
        
        // Update download button to show loading state
        const downloadBtn = document.querySelector(`.download-file-btn[data-file-id="${CSS.escape(fileId)}"]`);
        if (downloadBtn) {
            const playIcon = downloadBtn.querySelector('.download-play-icon');
            const loadingIcon = downloadBtn.querySelector('.download-loading-icon');
            if (playIcon) playIcon.classList.add('hidden');
            if (loadingIcon) loadingIcon.classList.remove('hidden');
            downloadBtn.disabled = true;
            downloadBtn.classList.add('cursor-not-allowed');
        }
        
        try {
            await mediaController.startDownload(channel.streamId, msg.metadata, channel.password);
        } catch (error) {
            if (this.deps.showNotification) {
                this.deps.showNotification('Download failed: ' + error.message, 'error');
            }
            // Reset UI state on error
            this.resetDownloadUI(fileId);
        }
    }

    /**
     * Reset download UI to initial state (on error or cancel)
     * @param {string} fileId - File ID
     */
    resetDownloadUI(fileId) {
        const progressOverlay = document.querySelector(`[data-progress-overlay="${CSS.escape(fileId)}"]`);
        if (progressOverlay) {
            progressOverlay.classList.add('hidden');
        }
        
        const downloadBtn = document.querySelector(`.download-file-btn[data-file-id="${CSS.escape(fileId)}"]`);
        if (downloadBtn) {
            const playIcon = downloadBtn.querySelector('.download-play-icon');
            const loadingIcon = downloadBtn.querySelector('.download-loading-icon');
            if (playIcon) playIcon.classList.remove('hidden');
            if (loadingIcon) loadingIcon.classList.add('hidden');
            downloadBtn.disabled = false;
            downloadBtn.classList.remove('cursor-not-allowed', 'opacity-50');
        }
    }

    /**
     * Clear media cache (when needed)
     */
    clearCache() {
        this.mediaCache.clear();
        this.mediaIdCounter = 0;
    }
}

// Export singleton instance
export const mediaHandler = new MediaHandler();
