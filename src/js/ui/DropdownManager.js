/**
 * Dropdown Manager
 * Handles channel dropdown menu and positioning logic
 */

class DropdownManager {
    constructor() {
        this.deps = {};
    }

    /**
     * Set dependencies
     * @param {Object} deps - { onChannelMenuAction }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Show channel dropdown menu
     * @param {Event} e - Click event
     * @param {HTMLElement} menuBtn - The menu button element
     * @param {Object} channel - Current channel info
     * @param {boolean} isPreviewMode - Whether in preview mode
     */
    showChannelDropdown(e, menuBtn, channel, isPreviewMode = false) {
        if (!channel) return;
        
        // Close any existing dropdown
        this.closeChannelDropdown();
        
        // Build dropdown items - "Leave Channel" only shown when not in preview mode
        const leaveChannelItem = isPreviewMode ? '' : `
            <div class="my-1 border-t border-white/5"></div>
            <button class="channel-action w-full text-left px-4 py-2.5 hover:bg-red-500/10 text-sm text-white/50 hover:text-red-400 transition flex items-center gap-2" data-action="leave-channel">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"/></svg>
                Leave Channel
            </button>
        `;

        // "Pinned" only when channel has at least one pinned message
        const hasPins = Array.isArray(channel?.adminState?.pins) && channel.adminState.pins.length > 0;
        const pinnedItem = hasPins ? `
            <button class="channel-action w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm text-white/70 hover:text-white transition flex items-center gap-2" data-action="show-pinned">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z"/></svg>
                Pinned
            </button>
        ` : '';
        
        // Create dropdown
        const dropdown = document.createElement('div');
        dropdown.id = 'channel-dropdown-menu';
        dropdown.className = 'fixed bg-[#111113] border border-white/10 rounded-xl shadow-2xl py-1 z-[9999] min-w-[180px] overflow-hidden';
        dropdown.innerHTML = `
            <button class="channel-action w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm text-white/70 hover:text-white transition flex items-center gap-2" data-action="copy-stream-id">
                <span class="w-4 h-4 flex items-center justify-center font-semibold text-base">#</span>
                Copy Channel ID
            </button>
            <button class="channel-action w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm text-white/70 hover:text-white transition flex items-center gap-2" data-action="channel-settings">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                Channel Details
            </button>
            ${pinnedItem}
            ${leaveChannelItem}
        `;
        
        document.body.appendChild(dropdown);
        
        // Position dropdown below button
        const btnRect = menuBtn.getBoundingClientRect();
        const dropdownRect = dropdown.getBoundingClientRect();
        
        let left = btnRect.left;
        let top = btnRect.bottom + 4;
        
        // If would go off right edge, align to right side
        if (left + dropdownRect.width > window.innerWidth - 8) {
            left = btnRect.right - dropdownRect.width;
        }
        
        // If would go off bottom, show above
        if (top + dropdownRect.height > window.innerHeight - 8) {
            top = btnRect.top - dropdownRect.height - 4;
        }
        
        dropdown.style.left = `${left}px`;
        dropdown.style.top = `${top}px`;
        
        // Attach action listeners
        dropdown.querySelectorAll('.channel-action').forEach(actionBtn => {
            actionBtn.addEventListener('click', async (evt) => {
                evt.stopPropagation();
                const action = actionBtn.dataset.action;
                this.closeChannelDropdown();
                if (this.deps.onChannelMenuAction) {
                    await this.deps.onChannelMenuAction(action);
                }
            });
        });
        
        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', this.closeChannelDropdown.bind(this), { once: true });
        }, 0);
    }
    
    /**
     * Close channel dropdown menu
     */
    closeChannelDropdown() {
        const existing = document.getElementById('channel-dropdown-menu');
        if (existing) {
            existing.remove();
        }
    }

    /**
     * Close all dropdowns (user and channel)
     */
    closeAllDropdowns() {
        this.closeChannelDropdown();
        const userDropdown = document.getElementById('user-dropdown-menu');
        if (userDropdown) {
            userDropdown.remove();
        }
    }
}

// Export singleton instance
export const dropdownManager = new DropdownManager();
