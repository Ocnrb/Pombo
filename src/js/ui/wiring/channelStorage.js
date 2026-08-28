/**
 * Storage options of the channel creation form.
 */

import { channelModalsUI } from '../ChannelModalsUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachChannelStorage(ui) {
    // Read-only toggle
    const readOnlyToggle = document.getElementById('read-only-toggle');
    readOnlyToggle?.addEventListener('click', () => {
        channelModalsUI.toggleReadOnly();
    });

    // Storage provider tabs
    document.querySelectorAll('.storage-provider-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            channelModalsUI.selectStorageProvider(tab.dataset.storage);
        });
    });

    // Storage days slider
    const storageDaysSlider = document.getElementById('storage-days-input');
    storageDaysSlider?.addEventListener('input', () => {
        channelModalsUI.updateStorageDaysDisplay(storageDaysSlider.value);
    });

    // Custom storage address input — clear error on edit
    const customStorageAddrInput = document.getElementById('custom-storage-address');
    customStorageAddrInput?.addEventListener('input', () => {
        channelModalsUI.clearCustomAddressError?.();
    });
}
