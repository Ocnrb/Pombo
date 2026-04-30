/**
 * InputUI
 * Manages message input area: text input, file attachments, sending state,
 * auto-resize, and typing indicator.
 */

import { modalManager } from './ModalManager.js';
import { sanitizeText } from './sanitizer.js';
import { escapeHtml } from './utils.js';

class InputUI {
    constructor() {
        this.deps = {};
        
        // DOM elements
        this.messageInput = null;
        this.sendMessageBtn = null;
        this.attachBtn = null;
        this.attachMenu = null;
        
        // State
        this.isSending = false;
        this.pendingFile = null;
        this.pendingFileType = null;
        
        // Typing indicator state
        this.typingTimeout = null;
        this.lastTypingSent = 0;
    }

    /**
     * Inject dependencies
     * @param {Object} deps - { channelManager, mediaController, Logger, showNotification, showLoading, hideLoading, formatFileSize }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Initialize with DOM elements
     * @param {Object} elements - { messageInput, sendMessageBtn }
     */
    init(elements) {
        this.messageInput = elements.messageInput;
        this.sendMessageBtn = elements.sendMessageBtn;
        
        // Setup auto-resize
        this.setupAutoResize();
        
        // Setup typing indicator
        this.setupTypingIndicator();
    }

    /**
     * Setup auto-resize for textarea
     */
    setupAutoResize() {
        if (!this.messageInput) return;
        
        this.messageInput.addEventListener('input', () => {
            this.messageInput.style.height = 'auto';
            this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 120) + 'px';
        });
    }

    /**
     * Setup typing indicator sender
     */
    setupTypingIndicator() {
        if (!this.messageInput) return;
        
        this.messageInput.addEventListener('input', () => {
            const { channelManager } = this.deps;
            const now = Date.now();
            
            // Send typing signal every 2 seconds while typing
            if (now - this.lastTypingSent > 2000) {
                const currentChannel = channelManager?.getCurrentChannel();
                if (currentChannel) {
                    channelManager.sendTypingIndicator(currentChannel.streamId);
                }
                this.lastTypingSent = now;
            }
            
            clearTimeout(this.typingTimeout);
            this.typingTimeout = setTimeout(() => {
                // Stop typing (no-op for now, can add notification)
            }, 3000);
        });
    }

    /**
     * Initialize attach button and file handling
     */
    initAttachButton() {
        this.attachBtn = document.getElementById('attach-btn');
        this.attachMenu = document.getElementById('attach-menu');
        const sendImageBtn = document.getElementById('send-image-btn');
        const sendVideoBtn = document.getElementById('send-video-btn');
        const imageInput = document.getElementById('image-input');
        const videoInput = document.getElementById('video-input');
        
        // File confirm modal buttons
        const cancelFileBtn = document.getElementById('cancel-file-btn');
        const confirmFileBtn = document.getElementById('confirm-file-btn');
        
        if (!this.attachBtn || !this.attachMenu) return;
        
        // Toggle attach menu
        this.attachBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.attachMenu.classList.toggle('hidden');
        });
        
        // Image button
        sendImageBtn?.addEventListener('click', () => {
            this.attachMenu.classList.add('hidden');
            imageInput?.click();
        });
        
        // Video button
        sendVideoBtn?.addEventListener('click', () => {
            this.attachMenu.classList.add('hidden');
            videoInput?.click();
        });
        
        // Image file selected
        imageInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this.showFileConfirmModal(file, 'image');
            }
            e.target.value = '';
        });
        
        // Video file selected
        videoInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this.showFileConfirmModal(file, 'video');
            }
            e.target.value = '';
        });
        
        // Cancel file send
        cancelFileBtn?.addEventListener('click', () => {
            this.clearPendingFile();
            modalManager.hide('file-confirm-modal');
        });
        
        // Confirm file send
        confirmFileBtn?.addEventListener('click', async () => {
            if (!this.pendingFile) return;
            
            const file = this.pendingFile;
            const type = this.pendingFileType;
            
            this.clearPendingFile();
            modalManager.hide('file-confirm-modal');
            
            await this.sendMediaFile(file, type);
        });
    }
    
    /**
     * Show file confirm modal
     * @param {File} file - File to confirm
     * @param {string} type - 'image' or 'video'
     */
    showFileConfirmModal(file, type) {
        const modal = document.getElementById('file-confirm-modal');
        const fileName = document.getElementById('confirm-file-name');
        const fileSize = document.getElementById('confirm-file-size');
        const previewIcon = document.getElementById('file-preview-icon');
        
        if (!modal) return;
        
        this.pendingFile = file;
        this.pendingFileType = type;
        
        fileName.textContent = file.name;
        fileSize.textContent = this.formatFileSize(file.size);
        
        // Update icon based on type
        if (type === 'image') {
            previewIcon.innerHTML = `
                <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/>
                </svg>
            `;
        } else if (type === 'video') {
            previewIcon.innerHTML = `
                <svg class="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                </svg>
            `;
        }
        
        modalManager.show('file-confirm-modal');
    }
    
    /**
     * Send media file to current channel
     * @param {File} file - File to send
     * @param {string} type - 'image' or 'video'
     */
    async sendMediaFile(file, type) {
        const { channelManager, mediaController, showNotification, showLoading, hideLoading } = this.deps;
        
        const currentChannel = channelManager?.getCurrentChannel();
        if (!currentChannel) {
            showNotification?.('No channel selected', 'error');
            return;
        }
        
        try {
            showLoading?.(type === 'image' ? 'Sending image...' : 'Processing video...');
            
            if (type === 'image') {
                const result = await mediaController.sendImage(currentChannel.streamId, file, currentChannel.password);
                if (result?.finalMime && result?.originalMime && result.finalMime !== result.originalMime) {
                    const finalLabel = result.finalMime.replace('image/', '').toUpperCase();
                    showNotification?.(`Image sent! Converted to ${finalLabel} to fit the 1MB limit.`, 'success');
                } else {
                    showNotification?.('Image sent!', 'success');
                }
            } else if (type === 'video') {
                await mediaController.sendVideo(currentChannel.streamId, file, currentChannel.password);
                showNotification?.('Video shared!', 'success');
            }
        } catch (error) {
            showNotification?.('Failed to send: ' + error.message, 'error');
        } finally {
            hideLoading?.();
        }
    }

    /**
     * Clear pending file state
     */
    clearPendingFile() {
        this.pendingFile = null;
        this.pendingFileType = null;
    }

    /**
     * Format file size for display
     * @param {number} bytes - Size in bytes
     * @returns {string} Formatted size
     */
    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    /**
     * Get current input value (trimmed)
     * @returns {string} Input text
     */
    getValue() {
        return this.messageInput?.value.trim() || '';
    }

    /**
     * Set input value
     * @param {string} text - Text to set
     */
    setValue(text) {
        if (this.messageInput) {
            this.messageInput.value = text;
            // Trigger resize
            this.messageInput.dispatchEvent(new Event('input'));
        }
    }

    /**
     * Clear input and reset height
     */
    clear() {
        if (this.messageInput) {
            this.messageInput.value = '';
            this.messageInput.style.height = 'auto';
        }
    }

    /**
     * Focus the input
     */
    focus() {
        this.messageInput?.focus();
    }

    /**
     * Check if currently sending
     * @returns {boolean}
     */
    getIsSending() {
        return this.isSending;
    }

    /**
     * Set sending state
     * @param {boolean} sending 
     */
    setIsSending(sending) {
        this.isSending = sending;
    }

    /**
     * Close attach menu if open
     */
    closeAttachMenu() {
        this.attachMenu?.classList.add('hidden');
    }

    /**
     * Hide input container (for explore/disconnected states)
     * @param {HTMLElement} container - The message input container element
     */
    hideInputContainer(container) {
        container?.classList.add('hidden');
    }

    /**
     * Show input container
     * @param {HTMLElement} container - The message input container element
     */
    showInputContainer(container) {
        container?.classList.remove('hidden');
    }
}

// Export singleton
export const inputUI = new InputUI();
