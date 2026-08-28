/**
 * Add, edit and remove contact modals.
 */

import { channelSettingsUI } from '../ChannelSettingsUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachContactModals(ui) {
    // Add contact nickname modal
    const cancelAddContactBtn = document.getElementById('cancel-add-contact-btn');
    const confirmAddContactBtn = document.getElementById('confirm-add-contact-btn');
    const addContactNicknameModal = document.getElementById('add-contact-nickname-modal');
    const addContactModalNickname = document.getElementById('add-contact-modal-nickname');
    
    if (cancelAddContactBtn) {
        cancelAddContactBtn.addEventListener('click', () => {
            ui.hideAddContactModal();
        });
    }
    
    if (confirmAddContactBtn) {
        confirmAddContactBtn.addEventListener('click', () => {
            ui.confirmAddContact();
        });
    }
    
    if (addContactNicknameModal) {
        addContactNicknameModal.addEventListener('click', (e) => {
            if (e.target === addContactNicknameModal) {
                ui.hideAddContactModal();
            }
        });
    }
    
    if (addContactModalNickname) {
        addContactModalNickname.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                ui.confirmAddContact();
            }
        });
    }

    // Edit contact modal
    const cancelEditContactBtn = document.getElementById('cancel-edit-contact-btn');
    const confirmEditContactBtn = document.getElementById('confirm-edit-contact-btn');
    const editContactModal = document.getElementById('edit-contact-modal');
    const editContactModalNickname = document.getElementById('edit-contact-modal-nickname');

    if (cancelEditContactBtn) {
        cancelEditContactBtn.addEventListener('click', () => {
            ui.hideEditContactModal();
        });
    }

    if (confirmEditContactBtn) {
        confirmEditContactBtn.addEventListener('click', () => {
            ui.confirmEditContact();
        });
    }

    if (editContactModal) {
        editContactModal.addEventListener('click', (e) => {
            if (e.target === editContactModal) {
                ui.hideEditContactModal();
            }
        });
    }

    if (editContactModalNickname) {
        editContactModalNickname.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                ui.confirmEditContact();
            }
        });
    }

    // Remove contact confirmation modal
    const cancelRemoveContactBtn = document.getElementById('cancel-remove-contact-btn');
    const confirmRemoveContactBtn = document.getElementById('confirm-remove-contact-btn');
    const removeContactModal = document.getElementById('remove-contact-modal');
    
    if (cancelRemoveContactBtn) {
        cancelRemoveContactBtn.addEventListener('click', () => {
            ui.hideRemoveContactModal();
        });
    }
    
    if (confirmRemoveContactBtn) {
        confirmRemoveContactBtn.addEventListener('click', () => {
            ui.confirmRemoveContact();
        });
    }
    
    if (removeContactModal) {
        removeContactModal.addEventListener('click', (e) => {
            if (e.target === removeContactModal) {
                ui.hideRemoveContactModal();
            }
        });
    }

    // Enter key on add member input
    if (ui.elements.addMemberInput) {
        ui.elements.addMemberInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                channelSettingsUI.handleAddMember();
            }
        });
    }
}
