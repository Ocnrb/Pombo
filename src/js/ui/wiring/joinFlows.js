/**
 * Join channel flows: quick join, normal join and closed channels.
 */

import { channelModalsUI } from '../ChannelModalsUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachJoinFlows(ui) {
    // Quick Join modal (mobile pill) - Enter to join
    const quickJoinModalInput = document.getElementById('quick-join-modal-input');
    const quickJoinModal = document.getElementById('quick-join-modal');
    quickJoinModalInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            ui._handleQuickJoinModal();
        }
    });
    document.getElementById('confirm-quick-join-modal')?.addEventListener('click', () => {
        ui._handleQuickJoinModal();
    });
    document.getElementById('cancel-quick-join-modal')?.addEventListener('click', () => {
        quickJoinModal?.classList.add('hidden');
    });
    // Close on backdrop click
    quickJoinModal?.addEventListener('click', (e) => {
        if (e.target === quickJoinModal) quickJoinModal.classList.add('hidden');
    });

    // Join channel (in modal)
    ui.elements.joinBtn?.addEventListener('click', () => {
        ui.handleJoinChannel();
    });

    // Cancel join
    ui.elements.cancelJoinBtn?.addEventListener('click', () => {
        ui.hideJoinChannelModal();
    });

    // Join Closed Channel modal buttons
    document.getElementById('join-closed-btn')?.addEventListener('click', () => {
        channelModalsUI.handleJoinClosedChannel();
    });
    document.getElementById('cancel-join-closed-btn')?.addEventListener('click', () => {
        channelModalsUI.hideJoinClosedModal();
    });
    
    // Switch from normal join to closed join modal
    document.getElementById('switch-to-closed-join-btn')?.addEventListener('click', () => {
        const streamId = ui.elements.joinStreamIdInput?.value.trim() || '';
        ui.hideJoinChannelModal();
        channelModalsUI.showJoinClosedModal(streamId);
    });

    // Join password toggle
    const joinHasPassword = document.getElementById('join-has-password');
    joinHasPassword?.addEventListener('change', (e) => {
        ui.elements.joinPasswordField?.classList.toggle('hidden', !e.target.checked);
    });

    // Join password visibility toggle (eye icon)
    document.getElementById('join-password-toggle')?.addEventListener('click', () => {
        const input = document.getElementById('join-password-input');
        const eyeOpen = document.getElementById('join-pw-eye-open');
        const eyeOff = document.getElementById('join-pw-eye-off');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        input.style.webkitTextSecurity = isPassword ? 'none' : 'disc';
        eyeOpen?.classList.toggle('hidden', isPassword);
        eyeOff?.classList.toggle('hidden', !isPassword);
    });
}
