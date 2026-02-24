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
     */
    openLightboxById(mediaId) {
        const media = this.mediaCache.get(mediaId);
        if (media) {
            this.openLightbox(media.url, media.type);
        }
    }

    /**
     * Open media lightbox
     * @param {string} src - Media source URL
     * @param {string} type - 'image' or 'video'
     */
    openLightbox(src, type = 'image') {
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
    }

    /**
     * Close media lightbox
     */
    closeLightbox() {
        const modal = document.getElementById('media-lightbox-modal');
        const videoEl = document.getElementById('lightbox-video');
        
        if (videoEl) {
            videoEl.pause();
        }
        
        if (modal) {
            modal.classList.add('hidden');
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
                    this.openLightboxById(mediaId);
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
        const progressOverlay = document.querySelector(`[data-progress-overlay="${fileId}"]`);
        if (progressOverlay) {
            progressOverlay.classList.remove('hidden');
        }
        
        const progressText = document.querySelector(`[data-progress-text="${fileId}"]`);
        if (progressText) {
            progressText.textContent = 'Starting...';
        }
        
        // Update download button to show loading state
        const downloadBtn = document.querySelector(`.download-file-btn[data-file-id="${fileId}"]`);
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
        const progressOverlay = document.querySelector(`[data-progress-overlay="${fileId}"]`);
        if (progressOverlay) {
            progressOverlay.classList.add('hidden');
        }
        
        const downloadBtn = document.querySelector(`.download-file-btn[data-file-id="${fileId}"]`);
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
