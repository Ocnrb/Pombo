/**
 * Online Users UI
 * Manages the online users list and user dropdown menus
 */

import { escapeHtml, escapeAttr, formatAddress } from './utils.js';
import { getAvatar } from './AvatarGenerator.js';
import { sanitizeText } from './sanitizer.js';

class OnlineUsersUI {
    constructor() {
        this.deps = {};
    }

    /**
     * Set dependencies
     * @param {Object} deps - { getCurrentAddress, onUserMenuAction }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Update online users display
     * @param {HTMLElement} countEl - Element showing user count
     * @param {HTMLElement} listEl - Element containing user list
     * @param {Array} users - Array of online users
     */
    updateOnlineUsers(countEl, listEl, users) {
        // Update count
        if (countEl) {
            countEl.textContent = users.length;
        }
        
        // Update list
        if (listEl) {
            if (users.length === 0) {
                listEl.innerHTML = '<div class="text-gray-400 text-sm text-center">No one online</div>';
            } else {
                const myAddress = this.deps.getCurrentAddress?.()?.toLowerCase();
                
                listEl.innerHTML = users.map(user => {
                    const address = user.address || user.id;
                    const isMe = address?.toLowerCase() === myAddress;
                    const nickname = user.nickname;
                    const shortAddress = formatAddress(address);
                    
                    // Display: nickname or address as main name
                    // Defense-in-depth: sanitize + escape user-provided nickname
                    const displayName = nickname 
                        ? escapeHtml(sanitizeText(nickname)) 
                        : shortAddress;
                    
                    // Subtitle: address if has nickname, or "(you)" if it's me
                    let subtitle = '';
                    if (nickname) {
                        subtitle = isMe ? `${shortAddress} (you)` : shortAddress;
                    } else if (isMe) {
                        subtitle = '(you)';
                    }
                    
                    const avatarSvg = getAvatar(address, 28, 0.22);
                    
                    return `
                        <div class="user-item-wrapper" data-user-address="${escapeAttr(address)}">
                            <div class="user-item cursor-pointer hover:bg-[#2a2a2a] rounded px-2 py-1.5 -mx-2">
                                <div class="user-avatar-small flex-shrink-0" style="width:28px;height:28px;border-radius:6px;overflow:hidden;">${avatarSvg}</div>
                                <div class="flex flex-col min-w-0 flex-1">
                                    <span class="text-gray-300 truncate text-sm ${isMe ? 'font-semibold' : ''}">${displayName}</span>
                                    ${subtitle ? `<span class="text-gray-500 text-xs truncate">${subtitle}</span>` : ''}
                                </div>
                                <button class="user-menu-btn ml-auto text-gray-500 hover:text-gray-300 p-1" title="Options">
                                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    `;
                }).join('');
                
                // Attach event listeners for dropdowns
                this.attachUserMenuListeners();
            }
        }
    }
    
    /**
     * Attach event listeners for user dropdown menus
     */
    attachUserMenuListeners() {
        document.querySelectorAll('.user-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const wrapper = btn.closest('.user-item-wrapper');
                const address = wrapper?.dataset.userAddress;
                const isMe = address?.toLowerCase() === this.deps.getCurrentAddress?.()?.toLowerCase();
                
                // Close any existing dropdown
                this.closeUserDropdown();
                
                // Create dropdown and append to body for proper positioning
                const dropdown = document.createElement('div');
                dropdown.id = 'user-dropdown-menu';
                dropdown.className = 'fixed bg-[#1e1e1e] border border-gray-700 rounded-lg shadow-xl py-1 z-[9999] min-w-[160px]';
                
                const safeAddress = escapeAttr(address);
                
                dropdown.innerHTML = `
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-[#2a2a2a] text-sm text-gray-300" data-action="copy-address" data-address="${safeAddress}">
                        📋 Copy Address
                    </button>
                    ${!isMe ? `
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-[#2a2a2a] text-sm text-gray-300" data-action="add-contact" data-address="${safeAddress}">
                        ➕ Add to Contacts
                    </button>
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-[#2a2a2a] text-sm text-red-400" data-action="start-dm" data-address="${safeAddress}">
                        💬 Start DM
                    </button>
                    ` : ''}
                `;
                
                document.body.appendChild(dropdown);
                
                // Position dropdown relative to button
                const btnRect = btn.getBoundingClientRect();
                const dropdownRect = dropdown.getBoundingClientRect();
                
                let left = btnRect.left - dropdownRect.width - 8;
                let top = btnRect.top;
                
                if (left < 8) {
                    left = btnRect.right + 8;
                }
                
                if (top + dropdownRect.height > window.innerHeight - 8) {
                    top = window.innerHeight - dropdownRect.height - 8;
                }
                
                dropdown.style.left = `${left}px`;
                dropdown.style.top = `${top}px`;
                
                // Attach action listeners
                dropdown.querySelectorAll('.user-action').forEach(actionBtn => {
                    actionBtn.addEventListener('click', async (evt) => {
                        evt.stopPropagation();
                        const action = actionBtn.dataset.action;
                        const addr = actionBtn.dataset.address;
                        this.closeUserDropdown();
                        if (this.deps.onUserMenuAction) {
                            await this.deps.onUserMenuAction(action, addr);
                        }
                    });
                });
                
                // Close on outside click
                setTimeout(() => {
                    document.addEventListener('click', this.closeUserDropdown.bind(this), { once: true });
                }, 0);
            });
        });
    }
    
    /**
     * Close user dropdown menu
     */
    closeUserDropdown() {
        const existing = document.getElementById('user-dropdown-menu');
        if (existing) {
            existing.remove();
        }
    }
}

// Export singleton instance
export const onlineUsersUI = new OnlineUsersUI();
