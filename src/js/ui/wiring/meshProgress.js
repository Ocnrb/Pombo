/**
 * Mesh file transfer progress overlay and bar.
 */

import { mediaController } from '../../media.js';
import { messageRenderer } from '../MessageRenderer.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachMeshProgress(ui) {
    // File progress - update progress overlay and bar
    mediaController.onFileProgress((fileId, percent, received, total, fileSize, bytesPerSec) => {
        // Show new video panel progress overlay
        const progressOverlay = document.querySelector(`[data-progress-overlay="${CSS.escape(fileId)}"]`);
        if (progressOverlay) {
            progressOverlay.classList.remove('hidden');
        }
        
        // Update progress percentage text
        const progressPercent = document.querySelector(`[data-progress-percent="${CSS.escape(fileId)}"]`);
        if (progressPercent) {
            progressPercent.textContent = `${percent}%`;
        }
        
        // Update progress fill
        const progressFill = document.querySelector(`[data-progress-fill="${CSS.escape(fileId)}"]`);
        if (progressFill) {
            progressFill.style.width = `${percent}%`;
        }
        
        // Update progress text with transferred size and current rate
        const progressText = document.querySelector(`[data-progress-text="${CSS.escape(fileId)}"]`);
        if (progressText) {
            const transferred = messageRenderer.formatFileSize((received / total) * fileSize);
            const totalSize = messageRenderer.formatFileSize(fileSize);
            const speed = messageRenderer.formatSpeed(bytesPerSec);
            progressText.textContent = `${transferred} of ${totalSize}${speed ? ` · ${speed}` : ''}`;
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
    });
}
