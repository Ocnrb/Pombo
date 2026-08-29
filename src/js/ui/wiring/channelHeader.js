/**
 * Channel header buttons: contacts, menus and closing the channel.
 */

import { channelManager } from '../../channels.js';
import { contactsUI } from '../ContactsUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachChannelHeader(ui) {
    // Contacts button
    if (ui.elements.contactsBtn) {
        ui.elements.contactsBtn.addEventListener('click', () => {
            contactsUI.show();
        });
    }

    // Channel menu button (dropdown)
    if (ui.elements.channelMenuBtn) {
        ui.elements.channelMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            ui.showChannelDropdown(e);
        });
    }

    // Mobile channel menu button (kebab - same action as chevron)
    if (ui.elements.channelMenuBtnMobile) {
        ui.elements.channelMenuBtnMobile.addEventListener('click', (e) => {
            e.stopPropagation();
            ui.showChannelDropdown(e);
        });
    }

    // Close channel button (X) - handles both mobile (left) and desktop (right) buttons
    if (ui.elements.closeChannelBtn) {
        ui.elements.closeChannelBtn.addEventListener('click', async () => {
            // Mobile: always go back to sidebar (channel list)
            const currentChannel = channelManager.getCurrentChannel();
            if (currentChannel) {
                await ui.deselectChannel();
            }
            ui.closeChatView();
        });
    }
    
    // Desktop close channel button
    if (ui.elements.closeChannelBtnDesktop) {
        ui.elements.closeChannelBtnDesktop.addEventListener('click', async () => {
            await ui.deselectChannel();
        });
    }
}
