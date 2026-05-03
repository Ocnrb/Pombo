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

        // Setup typing indicator
        this.setupTypingIndicator();

        // Enter handling for contenteditable (insert plain '\n' instead of <div>/<br>)
        this.setupEnterKey();

        // Setup paste / drag-and-drop image insertion
        this.setupImagePaste();
        this.setupImageDrop();

        // Watch for keyboard-injected <img> elements (Android Gboard / Tenor)
        this.setupKeyboardImageObserver();
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
     * Allowed image MIME types for paste/drop. Mirrors the
     * `accept` attribute of #image-input in index.html.
     */
    static IMAGE_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

    /**
     * Pick the first allowed image File from a DataTransferItemList /
     * FileList. Returns null if none match. Only File instances pass —
     * never strings/HTML — so this path cannot inject markup into the DOM.
     * @param {DataTransferItem[]|File[]} items
     * @returns {File|null}
     */
    _pickImageFile(items) {
        if (!items) return null;
        for (const item of items) {
            // DataTransferItem (paste / drop): kind === 'file'
            if (item && typeof item.getAsFile === 'function' && item.kind === 'file') {
                const file = item.getAsFile();
                if (file && InputUI.IMAGE_MIME_ALLOWLIST.includes(file.type)) {
                    return file;
                }
                continue;
            }
            // FileList entry
            if (item instanceof File && InputUI.IMAGE_MIME_ALLOWLIST.includes(item.type)) {
                return item;
            }
        }
        return null;
    }

    /**
     * Capture image files pasted into the message input (mobile keyboard
     * stickers/GIFs that copy to clipboard, desktop screenshot paste, etc.).
     * Falls back to plain-text insertion to keep the contenteditable safe
     * from rich-HTML injection (XSS).
     */
    setupImagePaste() {
        if (!this.messageInput) return;
        this.messageInput.addEventListener('paste', (e) => {
            const file = this._pickImageFile(e.clipboardData?.items || []);
            if (file) {
                e.preventDefault();
                this.showFileConfirmModal(file, 'image');
                return;
            }
            // Strip rich HTML — only plain text is allowed into the contenteditable.
            const text = e.clipboardData?.getData('text/plain');
            if (typeof text === 'string') {
                e.preventDefault();
                this._insertText(text);
            }
        });
    }

    /**
     * Accept image files dropped onto the chat area. Scoped to the chat
     * column to avoid stealing drops elsewhere; falls back to messageInput
     * if the chat container isn't in the DOM yet.
     */
    setupImageDrop() {
        const dropZone = document.getElementById('chat-area')
            || document.getElementById('message-input-container')
            || this.messageInput;
        if (!dropZone) return;

        const isImageDrag = (e) => {
            const types = e.dataTransfer?.types;
            if (!types) return false;
            // 'Files' is the standard token Chromium/Firefox set when a file
            // is dragged from the OS. We can't read the actual file list
            // until 'drop', so this is a best-effort check.
            return Array.from(types).includes('Files');
        };

        dropZone.addEventListener('dragover', (e) => {
            if (!isImageDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        dropZone.addEventListener('drop', (e) => {
            if (!isImageDrag(e)) return;
            const file = this._pickImageFile(e.dataTransfer?.files || []);
            if (!file) return;
            e.preventDefault();
            this.showFileConfirmModal(file, 'image');
        });
    }

    /**
     * Insert plain text at the current caret position. Used by the paste
     * handler (after stripping HTML) and the Enter handler (for newlines).
     * Always operates on Text nodes — never on HTML — so XSS is impossible.
     * @param {string} text
     */
    _insertText(text) {
        const sel = window.getSelection?.();
        if (!sel || !this.messageInput) return;
        // If the selection is outside our input, append at the end instead.
        if (sel.rangeCount === 0 || !this.messageInput.contains(sel.anchorNode)) {
            this.messageInput.appendChild(document.createTextNode(text));
        } else {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const node = document.createTextNode(text);
            range.insertNode(node);
            range.setStartAfter(node);
            range.setEndAfter(node);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        this.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * Force Enter to insert a literal '\n' character (Text node) instead of
     * the browser's default <div> or <br> insertion in contenteditable.
     * Without this, `textContent` on multi-line input would join all lines
     * with no separator. Ctrl/Cmd+Enter is left alone for the global send
     * handler in ui.js.
     */
    setupEnterKey() {
        if (!this.messageInput) return;
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            if (e.ctrlKey || e.metaKey) return; // Send shortcut handled in ui.js
            e.preventDefault();
            this._insertText('\n');
        });
    }

    /**
     * Some Android keyboards (Gboard with Tenor, SwiftKey stickers) deliver
     * GIFs/images via InputConnection.commitContent which Chromium surfaces
     * by inserting an `<img src="content://...">` (or blob:/data:) element
     * into the focused contenteditable. We intercept those, fetch the
     * underlying blob, route it through the normal image-confirm flow, and
     * remove the injected element. The element is also hidden by CSS so
     * users never see a partial state.
     *
     * Note on XSS: the injected element comes from the browser's own input
     * pipeline (not from another origin), and we only ever read its `src`
     * to fetch a Blob — never inject the element's HTML elsewhere.
     */
    setupKeyboardImageObserver() {
        if (!this.messageInput || typeof MutationObserver === 'undefined') return;
        const handleNode = async (node) => {
            if (!(node instanceof HTMLElement)) return;
            const imgs = node.tagName === 'IMG' ? [node] : Array.from(node.querySelectorAll?.('img') || []);
            for (const img of imgs) {
                const src = img.getAttribute('src') || '';
                img.remove();
                if (!src) continue;
                try {
                    const response = await fetch(src);
                    const blob = await response.blob();
                    if (!InputUI.IMAGE_MIME_ALLOWLIST.includes(blob.type)) {
                        Logger.debug('Keyboard image: rejected MIME', blob.type);
                        continue;
                    }
                    const ext = blob.type.split('/')[1] || 'bin';
                    const file = new File([blob], `keyboard-image.${ext}`, { type: blob.type });
                    this.showFileConfirmModal(file, 'image');
                } catch (err) {
                    Logger.debug('Keyboard image: fetch failed', err?.message);
                }
            }
        };
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                m.addedNodes.forEach(handleNode);
            }
        });
        observer.observe(this.messageInput, { childList: true, subtree: true });
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
     * Get current input value (trimmed). Reads `textContent` so HTML inserted
     * by anything other than our own handlers is ignored as plain text.
     * @returns {string} Input text
     */
    getValue() {
        return (this.messageInput?.textContent || '').trim();
    }

    /**
     * Set input value as plain text.
     * @param {string} text - Text to set
     */
    setValue(text) {
        if (this.messageInput) {
            this.messageInput.textContent = text;
            this.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /**
     * Clear input.
     */
    clear() {
        if (this.messageInput) {
            this.messageInput.textContent = '';
            this.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
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
