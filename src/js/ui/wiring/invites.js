/**
 * Invite modal: tabs, sending, link copy and QR.
 */

import { previewModeUI } from '../PreviewModeUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachInvites(ui) {
    // Invite users button
    ui.elements.inviteUsersBtn.addEventListener('click', () => {
        ui.showInviteModal();
    });

    // Join channel button (preview mode)
    ui.elements.joinChannelBtn?.addEventListener('click', () => {
        previewModeUI.addPreviewToList();
    });

    // Send invite
    ui.elements.sendInviteBtn.addEventListener('click', () => {
        ui.handleSendInvite();
    });

    // Cancel invite
    ui.elements.cancelInviteBtn.addEventListener('click', () => {
        ui.hideInviteModal();
    });

    // Invite modal tabs
    document.querySelectorAll('.invite-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabType = tab.dataset.inviteTab;
            ui.switchInviteTab(tabType);
        });
    });

    // Copy invite link
    ui.elements.copyInviteLinkBtn.addEventListener('click', () => {
        ui.copyInviteLink();
    });

    //Show QR code
    ui.elements.showQrBtn.addEventListener('click', () => {
        ui.showInviteQR();
    });
}
