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
        modalManager.show('contacts-modal');
    }

    /**
     * Hide contacts modal
     */
    hide() {
        modalManager.hide('contacts-modal');
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
                <div class="text-center text-[#555] py-8 text-[13px]">No trusted contacts yet</div>
            `;
            return;
        }

        this.elements.contactsList.innerHTML = contacts.map(contact => {
            const avatarSvg = getAvatar(contact.address, 32, 0.22);
            // Defense-in-depth: sanitize user-provided nickname
            return `
                <div class="flex items-center justify-between p-3 bg-[#1a1a1a] border border-[#282828] rounded-lg">
                    <div class="flex items-center gap-3 flex-1 min-w-0">
                        <div class="flex-shrink-0" style="width:32px;height:32px;border-radius:6px;overflow:hidden;">${avatarSvg}</div>
                        <div class="flex-1 min-w-0">
                            <span class="text-[13px] font-medium text-white truncate block">${escapeHtml(sanitizeText(contact.nickname))}</span>
                            <div class="text-[10px] text-[#666] font-mono truncate mt-0.5">${contact.address}</div>
                        </div>
                    </div>
                    <button 
                        class="remove-contact-btn ml-2 text-[#555] hover:text-red-400 p-1.5 transition"
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
                this.deps.showRemoveContactModal(address, () => {
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
                showAddContactModal(address);
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
                showRemoveContactModal(address);
                break;
        }
    }
}

export const contactsUI = new ContactsUI();
