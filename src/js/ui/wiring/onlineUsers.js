/**
 * Online users dropdown in the channel header.
 */

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachOnlineUsers(ui) {
    // Online users dropdown toggle
    ui.elements.onlineHeader?.addEventListener('click', () => {
        ui.elements.onlineUsersList?.classList.toggle('hidden');
    });

    // Close online users list when clicking outside
    document.addEventListener('click', (e) => {
        const clickedOnHeader = ui.elements.onlineHeader?.contains(e.target);
        const clickedOnList = ui.elements.onlineUsersList?.contains(e.target);
        if (!clickedOnHeader && !clickedOnList) {
            ui.elements.onlineUsersList?.classList.add('hidden');
        }
    });
}
