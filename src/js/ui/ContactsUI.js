/**
 * ContactsUI
 * Manages contacts modal, context menu, and trusted contacts
 */

import { modalManager } from './ModalManager.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { getAvatar } from './AvatarGenerator.js';
import { sanitizeText } from './sanitizer.js';

class ContactsUI {
    constructor() {
        this.deps = null;
        this.elements = null;
        this.contextMenuTarget = null;
    }

    /**
     * Set dependencies from UIController
     */
    setDependencies(deps) {
        this.deps = deps;
    }

    /**
     * Set element references
     */
    setElements(elements) {
        this.elements = elements;
    }

    /**
     * Initialize contacts UI elements and listeners
     */
    init() {
        // Cache additional elements
        this.elements.contactsModal = document.getElementById('contacts-modal');
        this.elements.contactsList = document.getElementById('contacts-list');
        this.elements.addContactBtn = document.getElementById('add-contact-btn');
        this.elements.addContactAddress = document.getElementById('add-contact-address');
        this.elements.addContactNickname = document.getElementById('add-contact-nickname');
        this.elements.closeContactsBtn = document.getElementById('close-contacts-btn');
        
        this.elements.contextMenu = document.getElementById('message-context-menu');

        // Contacts modal listeners
        if (this.elements.addContactBtn) {
            this.elements.addContactBtn.addEventListener('click', () => this.handleAddContact());
        }
        if (this.elements.closeContactsBtn) {
            this.elements.closeContactsBtn.addEventListener('click', () => this.hide());
        }
        
        // Register onHide callback for back button and programmatic hide
        modalManager.registerOnHide('contacts-modal', () => this._cleanupOnHide());

        // Context menu listeners
        if (this.elements.contextMenu) {
            document.addEventListener('click', () => this.hideContextMenu());
            this.elements.contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
                item.addEventListener('click', (e) => this.handleContextMenuAction(e));
            });
        }

        // Right-click on messages
        document.addEventListener('contextmenu', (e) => this.handleMessageRightClick(e));
    }

    /**
     * Show contacts modal
     */
    show() {
        if (!this.elements.contactsModal) {
            this.init();
        }
        this.renderList();
        // Add contacts-open class for mobile
        if (window.innerWidth < 768) {
            // Add contacts-open class FIRST (before closing settings)
            // so that settings _cleanupOnHide knows we're switching tabs
            document.body.classList.add('contacts-open');
            
            // Close settings modal if open (always use modalManager to keep stack in sync)
            // Use skipHistory to prevent async history.back() from closing contacts modal
            if (modalManager.isVisible('settings-modal')) {
                if (this.deps?.settingsUI?.hide) {
                    this.deps.settingsUI.hide({ skipHistory: true });
                } else {
                    // Fallback: use modalManager to ensure stack stays in sync
                    modalManager.hide('settings-modal', { skipHistory: true });
                    document.body.classList.remove('settings-open');
                }
            }
            // Update pill nav active tab
            document.querySelectorAll('.pill-nav-item[data-pill-tab]').forEach(item => {
                item.classList.toggle('active', item.dataset.pillTab === 'contacts');
            });
        }
        modalManager.show('contacts-modal');
    }

    /**
     * Hide contacts modal
     * @param {Object} options - Optional config { skipHistory: boolean }
     */
    hide(options = {}) {
        modalManager.hide('contacts-modal', options);
    }

    /**
     * Cleanup when contacts modal is hidden (called by modalManager callback)
     * @private
     */
    _cleanupOnHide() {
        // Remove contacts-open class for mobile
        document.body.classList.remove('contacts-open');
        // Only reset pill nav to chats if still on contacts tab
        // If pill was already switched (e.g. to explore), don't override
        const activeTab = document.querySelector('.pill-nav-item[data-pill-tab].active');
        if (!activeTab || activeTab.dataset.pillTab === 'contacts') {
            if (!document.body.classList.contains('settings-open')) {
                document.querySelectorAll('.pill-nav-item[data-pill-tab]').forEach(item => {
                    item.classList.toggle('active', item.dataset.pillTab === 'chats');
                });
            }
        }
        // Clear inputs
        if (this.elements.addContactAddress) this.elements.addContactAddress.value = '';
        if (this.elements.addContactNickname) this.elements.addContactNickname.value = '';
    }

    /**
     * Render contacts list
     */
    renderList() {
        const { identityManager } = this.deps;
        const contacts = identityManager.getAllTrustedContacts();
        
        if (contacts.length === 0) {
            this.elements.contactsList.innerHTML = `
                <div class="text-center text-white/25 py-8 text-[13px]">No trusted contacts yet</div>
            `;
            return;
        }

        this.elements.contactsList.innerHTML = contacts.map(contact => {
            const avatarSvg = getAvatar(contact.address, 32, 0.22);
            // Defense-in-depth: sanitize user-provided nickname
            return `
                <div class="flex items-center justify-between p-3 bg-white/[0.05] border border-white/[0.08] rounded-xl">
                    <div class="flex items-center gap-3 flex-1 min-w-0">
                        <div class="flex-shrink-0" style="width:32px;height:32px;border-radius:6px;overflow:hidden;">${avatarSvg}</div>
                        <div class="flex-1 min-w-0">
                            <span class="text-[13px] font-medium text-white truncate block">${escapeHtml(sanitizeText(contact.nickname))}</span>
                            <div class="text-[10px] text-white/30 font-mono truncate mt-0.5">${escapeHtml(contact.address)}</div>
                        </div>
                    </div>
                    <button 
                        class="remove-contact-btn ml-2 text-white/25 hover:text-red-400 p-1.5 transition"
                        data-address="${escapeAttr(contact.address)}"
                        title="Remove contact"
                    >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');

        // Add remove handlers
        this.elements.contactsList.querySelectorAll('.remove-contact-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const address = e.currentTarget.dataset.address;
                this.showRemoveModal(address, () => {
                    this.renderList();
                });
            });
        });
    }

    /**
     * Handle add contact
     */
    async handleAddContact() {
        const { identityManager, showNotification, showLoading, hideLoading } = this.deps;
        
        const addressOrEns = this.elements.addContactAddress?.value.trim();
        const nickname = this.elements.addContactNickname?.value.trim();

        if (!addressOrEns) {
            showNotification('Please enter an address or ENS name', 'error');
            return;
        }

        let isLoading = false;
        try {
            let address = addressOrEns;
            
            // Resolve ENS if needed
            if (addressOrEns.endsWith('.eth')) {
                showLoading('Resolving ENS...');
                isLoading = true;
                address = await identityManager.resolveAddress(addressOrEns);
                
                if (!address) {
                    showNotification('Could not resolve ENS name', 'error');
                    return;
                }
            }

            // Validate address format
            if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
                showNotification('Invalid Ethereum address', 'error');
                return;
            }

            await identityManager.addTrustedContact(address, nickname || null);
            this.renderList();
            showNotification('Contact added!', 'success');

            // Clear inputs
            this.elements.addContactAddress.value = '';
            this.elements.addContactNickname.value = '';
        } catch (error) {
            showNotification('Failed to add contact: ' + error.message, 'error');
        } finally {
            if (isLoading) hideLoading();
        }
    }

    /**
     * Handle message right-click for context menu
     */
    handleMessageRightClick(e) {
        const { Logger } = this.deps;
        
        const messageDiv = e.target.closest('.message-entry');
        if (!messageDiv || !this.elements.messagesArea?.contains(messageDiv)) {
            return;
        }

        e.preventDefault();
        
        // Get the full sender address from data attribute
        const senderAddress = messageDiv.dataset.sender;
        
        if (!senderAddress) {
            Logger.warn('No sender address found for message');
            return;
        }

        // Store for context menu actions
        this.contextMenuTarget = {
            element: messageDiv,
            sender: senderAddress
        };

        // Show/hide "Block User" based on whether we're in a DM channel
        const blockBtn = document.getElementById('context-menu-block-btn');
        const blockDivider = document.getElementById('context-menu-block-divider');
        const { channelManager } = this.deps;
        const currentChannel = channelManager?.getCurrentChannel?.();
        const isDM = currentChannel?.type === 'dm' && senderAddress.toLowerCase() !== this.deps.identityManager?.getAddress?.()?.toLowerCase();
        if (blockBtn) blockBtn.classList.toggle('hidden', !isDM);
        if (blockDivider) blockDivider.classList.toggle('hidden', !isDM);

        // Position and show context menu
        this.showContextMenu(e.clientX, e.clientY);
    }

    /**
     * Show context menu at position
     */
    showContextMenu(x, y) {
        if (!this.elements.contextMenu) {
            this.init();
        }
        
        // Block scroll on messages area while menu is open (using event listeners to avoid reflow)
        this._blockScroll();
        
        if (this.elements.contextMenu) {
            // Temporarily show to measure dimensions
            this.elements.contextMenu.style.visibility = 'hidden';
            this.elements.contextMenu.classList.remove('hidden');
            
            const menuWidth = this.elements.contextMenu.offsetWidth;
            const menuHeight = this.elements.contextMenu.offsetHeight;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            // Adjust position if menu would overflow right edge
            if (x + menuWidth > viewportWidth - 10) {
                x = viewportWidth - menuWidth - 10;
            }
            
            // Adjust position if menu would overflow bottom edge
            if (y + menuHeight > viewportHeight - 10) {
                y = viewportHeight - menuHeight - 10;
            }
            
            // Ensure minimum left/top
            x = Math.max(10, x);
            y = Math.max(10, y);
            
            this.elements.contextMenu.style.left = `${x}px`;
            this.elements.contextMenu.style.top = `${y}px`;
            this.elements.contextMenu.style.visibility = 'visible';
        }
    }

    /**
     * Hide context menu
     */
    hideContextMenu() {
        this.elements.contextMenu?.classList.add('hidden');
        this._unblockScroll();
    }

    /** Block scroll on messages area without changing overflow (avoids layout reflow) */
    _blockScroll() {
        const messagesArea = document.getElementById('messages-area');
        if (!messagesArea || this._scrollBlocker) return;
        const prevent = (e) => e.preventDefault();
        messagesArea.addEventListener('wheel', prevent, { passive: false });
        messagesArea.addEventListener('touchmove', prevent, { passive: false });
        this._scrollBlocker = { el: messagesArea, handler: prevent };
    }

    /** Restore scroll on messages area */
    _unblockScroll() {
        if (!this._scrollBlocker) return;
        const { el, handler } = this._scrollBlocker;
        el.removeEventListener('wheel', handler);
        el.removeEventListener('touchmove', handler);
        this._scrollBlocker = null;
    }

    /**
     * Handle context menu action
     */
    async handleContextMenuAction(e) {
        const { showNotification, showAddContactModal, showRemoveContactModal } = this.deps;
        
        const action = e.currentTarget.dataset.action;
        const target = this.contextMenuTarget;
        
        if (!target?.sender) {
            this.hideContextMenu();
            return;
        }

        const address = target.sender;
        this.hideContextMenu();

        switch (action) {
            case 'add-contact':
                this.showAddModal(address);
                break;
                
            case 'copy-address':
                try {
                    await navigator.clipboard.writeText(address);
                    showNotification('Address copied!', 'success');
                } catch {
                    showNotification('Failed to copy', 'error');
                }
                break;
                
            case 'remove-contact':
                this.showRemoveModal(address);
                break;
                
            case 'block-user':
                this.handleBlockUser(address);
                break;
        }
    }

    /**
     * Block a user from the context menu — finds the DM channel and leaves with block
     * @param {string} address - Address of the user to block
     */
    async handleBlockUser(address) {
        const { channelManager, showNotification, renderChannelList, selectChannel, showConnectedNoChannelState } = this.deps;
        if (!channelManager) return;

        // Find the DM channel for this peer
        const channels = channelManager.getAllChannels();
        const dmChannel = channels.find(
            ch => ch.type === 'dm' && ch.peerAddress?.toLowerCase() === address.toLowerCase()
        );

        if (!dmChannel) {
            showNotification('Could not find DM conversation', 'error');
            return;
        }

        // Confirm before blocking
        const short = address.slice(0, 6) + '…' + address.slice(-4);
        if (!confirm(`Block ${short}? All messages from this user will be permanently ignored.`)) {
            return;
        }

        try {
            await channelManager.leaveChannel(dmChannel.messageStreamId || dmChannel.streamId, { block: true });
            showNotification('User blocked', 'info');

            // Refresh channel list and navigate away
            const remaining = channelManager.getAllChannels();
            if (remaining.length > 0) {
                renderChannelList?.();
                await selectChannel?.(remaining[0].streamId);
            } else {
                renderChannelList?.();
                showConnectedNoChannelState?.();
            }
        } catch (err) {
            showNotification('Failed to block user: ' + err.message, 'error');
        }
    }

    // ========================================
    // Add/Remove Contact Modal Methods
    // ========================================

    /**
     * Show add contact modal
     * @param {string} address - Contact address to add
     */
    showAddModal(address) {
        modalManager.showAddContactModal(address);
        this._pendingContactAddress = address;
    }

    /**
     * Hide add contact modal
     */
    hideAddModal() {
        modalManager.hideAddContactModal();
        this._pendingContactAddress = null;
    }

    /**
     * Confirm adding contact from modal
     */
    async confirmAdd() {
        const { identityManager, showNotification } = this.deps;
        const nicknameInput = document.getElementById('add-contact-modal-nickname');
        const nickname = nicknameInput?.value?.trim() || null;
        const address = this._pendingContactAddress || modalManager.getPendingData('contactAddress');
        
        if (!address) return;
        
        await identityManager.addTrustedContact(address, nickname);
        showNotification('Contact added!', 'success');
        this.hideAddModal();
    }

    /**
     * Show remove contact confirmation modal
     * @param {string} address - Contact address to remove
     * @param {Function} onRemoveCallback - Optional callback after removal
     */
    showRemoveModal(address, onRemoveCallback = null) {
        modalManager.showRemoveContactModal(address, onRemoveCallback);
        this._pendingRemoveContactAddress = address;
        this._onRemoveContactCallback = onRemoveCallback;
    }

    /**
     * Hide remove contact modal
     */
    hideRemoveModal() {
        modalManager.hideRemoveContactModal();
        this._pendingRemoveContactAddress = null;
        this._onRemoveContactCallback = null;
    }

    /**
     * Confirm removing contact from modal
     */
    async confirmRemove() {
        const { identityManager, showNotification } = this.deps;
        const address = this._pendingRemoveContactAddress;
        const callback = this._onRemoveContactCallback;
        
        if (!address) return;
        
        await identityManager.removeTrustedContact(address);
        showNotification('Contact removed', 'info');
        this.hideRemoveModal();
        
        if (callback) {
            callback();
        }
    }
}

export const contactsUI = new ContactsUI();
