/**
 * Mesh serving stats and unrecoverable download errors.
 */

import { mediaController } from '../../media.js';
import { mediaHandler } from '../MediaHandler.js';
import { messageRenderer } from '../MessageRenderer.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachMeshServing(ui) {
    // Serving stats - upload rate and how many peers are pulling from us
    mediaController.onUploadProgress((fileId, bytesPerSec, leechers) => {
        const speedEl = document.querySelector(`[data-upload-speed="${CSS.escape(fileId)}"]`);
        if (speedEl) {
            speedEl.textContent = messageRenderer.formatSpeed(bytesPerSec) || '—';
        }

        const leecherEl = document.querySelector(`[data-leecher-count="${CSS.escape(fileId)}"]`);
        if (leecherEl) {
            leecherEl.textContent = String(leechers);
        }
    });

    // Download failed unrecoverably - drop the spinner and say why
    mediaController.onFileError((fileId, message) => {
        mediaHandler.resetDownloadUI(fileId);
        ui.showNotification('Download failed: ' + message, 'error');
    });
}
