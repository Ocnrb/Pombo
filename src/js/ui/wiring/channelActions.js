/**
 * Create/cancel channel, storage info modal and the explore entry point.
 */

import { channelModalsUI } from '../ChannelModalsUI.js';
import { modalManager } from '../ModalManager.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachChannelActions(ui) {
    // Create channel
    ui.elements.createChannelBtn.addEventListener('click', () => {
        channelModalsUI.handleCreate();
    });

    // Cancel channel creation
    ui.elements.cancelChannelBtn.addEventListener('click', () => {
        channelModalsUI.hide();
    });

    // Footer cancel button (new design)
    document.getElementById('cancel-channel-btn-footer')?.addEventListener('click', () => {
        channelModalsUI.hide();
    });

    // Storage info modal
    document.querySelectorAll('.storage-learn-more-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            modalManager.show('storage-info-modal');
        });
    });
    document.getElementById('close-storage-info-btn')?.addEventListener('click', () => {
        modalManager.hide('storage-info-modal');
    });
    document.getElementById('close-storage-info-btn-footer')?.addEventListener('click', () => {
        modalManager.hide('storage-info-modal');
    });

    // Explore channels button (sidebar)
    ui.elements.browseChannelsBtn?.addEventListener('click', () => {
        ui.openExploreView();
    });
}
