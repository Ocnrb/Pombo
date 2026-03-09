/**
 * @fileoverview Join Channel UI Manager
 * Handles all join channel related functionality including quick join,
 * password-protected channels, and public channel joining.
 */
import { Logger } from '../logger.js';

// Forward declarations - dependencies injected via init()
let channelManager = null;
let modalManager = null;
let notificationUI = null;
let graphAPI = null;
let exploreUI = null;
let channelModalsUI = null;

/**
 * Manages join channel UI and workflows
 */
class JoinChannelUI {
    /**
     * @param {Object} elements - DOM element references from UIController
     */
    constructor(elements) {
        this.elements = elements;
    }

    /**
     * Show join channel modal
     */
    showJoinChannelModal() {
        modalManager.showJoinChannelModal(
            this.elements.joinChannelModal,
            this.elements.joinStreamIdInput,
            this.elements.joinPasswordInput,
            this.elements.joinPasswordField
        );
    }

    /**
     * Hide join channel modal
     */
    hideJoinChannelModal() {
        modalManager.hide('join-channel-modal');
    }

    /**
     * Update browse/join button state based on input content
     * Shows "Join" when there's input, "Explore" when empty
     */
    updateBrowseJoinButton() {
        const hasInput = this.elements.quickJoinInput?.value.trim();
        const btn = this.elements.browseChannelsBtn;
        const icon = this.elements.browseBtnIcon;
        const text = this.elements.browseBtnText;
        
        if (!btn || !icon || !text) return;
        
        if (hasInput) {
            // Show "Join" mode with orange styling
            btn.classList.remove('text-white/50', 'hover:text-white');
            btn.classList.add('text-[#F6851B]', 'hover:text-[#ff9933]', 'border-[#F6851B]/30');
            text.textContent = 'Join';
            // Change icon to chat bubble (message balloon)
            icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>';
        } else {
            // Show "Explore" mode with default styling
            btn.classList.remove('text-[#F6851B]', 'hover:text-[#ff9933]', 'border-[#F6851B]/30');
            btn.classList.add('text-white/50', 'hover:text-white');
            text.textContent = 'Explore';
            // Restore globe icon
            icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"/>';
        }
    }

    /**
     * Update quick join hash visibility based on input content
     * Shows # prefix when there's input, hidden when empty to save space for placeholder
     */
    updateQuickJoinHash() {
        const hasInput = this.elements.quickJoinInput?.value.trim();
        const hash = this.elements.quickJoinHash;
        const input = this.elements.quickJoinInput;
        
        if (!hash || !input) return;
        
        if (hasInput) {
            hash.classList.remove('hidden');
            input.classList.add('pl-6');
            input.classList.remove('px-3');
        } else {
            hash.classList.add('hidden');
            input.classList.remove('pl-6');
            input.classList.add('px-3');
        }
    }

    /**
     * Handle quick join from sidebar input
     * @param {Function} showNotification - Notification callback
     * @param {Function} renderChannelList - Channel list render callback
     */
    async handleQuickJoin(showNotification, renderChannelList) {
        const streamId = this.elements.quickJoinInput?.value.trim();
        
        if (!streamId) {
            showNotification('Please enter a channel ID', 'error');
            return;
        }

        // First check cache (from ExploreUI), then query The Graph for channel info
        let channelInfo = exploreUI.cachedPublicChannels?.find(ch => ch.streamId === streamId);
        
        if (!channelInfo) {
            // Not in cache - query The Graph
            notificationUI.showLoading('Checking channel...');
            try {
                channelInfo = await graphAPI.getChannelInfo(streamId);
            } catch (error) {
                Logger.warn('Failed to query channel info:', error);
            } finally {
                notificationUI.hideLoading();
            }
        }
        
        // If we know it's a password-protected channel, show password modal
        if (channelInfo?.type === 'password') {
            const displayName = channelInfo.name || channelInfo.displayName || 'this channel';
            const password = await this.showPasswordInputModal('Join Password Channel', 
                `Enter password for "${displayName}":`);
            
            if (!password) {
                return; // User cancelled
            }
            
            try {
                notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, password, {
                    name: channelInfo.name,
                    type: 'password'
                });
                
                // Clear the input
                this._clearQuickJoinInput();
                
                renderChannelList();
                showNotification('Joined channel successfully!', 'success');
            } catch (error) {
                showNotification('Failed to join: ' + error.message, 'error');
            } finally {
                notificationUI.hideLoadingToast();
            }
            return;
        }
        
        // For native/Closed channels, show the special modal to get name + classification
        if (channelInfo?.type === 'native') {
            channelModalsUI.showJoinClosedModal(streamId, channelInfo);
            return;
        }
        
        // For hidden channels without a name, ask user for a local name
        // This applies to any channel type with exposure: hidden and name: null
        if (channelInfo && !channelInfo.name) {
            channelModalsUI.showJoinHiddenModal(streamId, channelInfo);
            return;
        }

        // For unknown channels (no channelInfo), show modal to get name
        if (!channelInfo) {
            channelModalsUI.showJoinHiddenModal(streamId, null);
            return;
        }

        // For public visible channels with name, try direct join
        try {
            notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
            await channelManager.joinChannel(streamId, null, {
                name: channelInfo.name,
                type: channelInfo.type,
                readOnly: channelInfo.readOnly || false,
                createdBy: channelInfo.createdBy
            });
            
            // Clear the input
            this._clearQuickJoinInput();
            
            renderChannelList();
            showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            showNotification('Failed to join: ' + error.message, 'error');
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Clear quick join input and update UI
     * @private
     */
    _clearQuickJoinInput() {
        if (this.elements.quickJoinInput) {
            this.elements.quickJoinInput.value = '';
            this.updateBrowseJoinButton();
            this.updateQuickJoinHash();
        }
    }

    /**
     * Handle join channel from modal
     * @param {Function} showNotification - Notification callback
     * @param {Function} renderChannelList - Channel list render callback
     */
    async handleJoinChannel(showNotification, renderChannelList) {
        const streamId = this.elements.joinStreamIdInput?.value.trim();
        const password = this.elements.joinPasswordInput?.value || null;

        if (!streamId) {
            showNotification('Please enter a Stream ID', 'error');
            return;
        }

        try {
            notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
            await channelManager.joinChannel(streamId, password);
            this.hideJoinChannelModal();
            renderChannelList();
            showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            showNotification('Failed to join: ' + error.message, 'error');
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Join a public channel from browse/explore
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata (optional)
     * @param {Function} showNotification - Notification callback
     * @param {Function} renderChannelList - Channel list render callback
     * @param {Function} selectChannel - Channel selection callback
     */
    async joinPublicChannel(streamId, channelInfo, showNotification, renderChannelList, selectChannel) {
        try {
            // For native/Closed channels, show the special modal to get name + classification
            if (channelInfo?.type === 'native') {
                channelModalsUI.showJoinClosedModal(streamId, channelInfo);
                return;
            }
            
            // For hidden channels without a name, ask user for a local name
            if (channelInfo && !channelInfo.name) {
                channelModalsUI.showJoinHiddenModal(streamId, channelInfo);
                return;
            }
            
            // If password-protected, ask for password
            if (channelInfo?.type === 'password') {
                const displayName = channelInfo.name || channelInfo.displayName || 'this channel';
                const password = await this.showPasswordInputModal('Join Password Channel', 
                    `Enter password for "${displayName}":`);
                
                if (!password) {
                    return; // User cancelled
                }
                
                notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, password, {
                    name: channelInfo?.name,
                    type: 'password',
                    readOnly: channelInfo?.readOnly || false,
                    createdBy: channelInfo?.createdBy
                });
            } else {
                notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, null, {
                    name: channelInfo?.name,
                    type: channelInfo?.type || 'public',
                    readOnly: channelInfo?.readOnly || false,
                    createdBy: channelInfo?.createdBy
                });
            }
            
            renderChannelList();
            
            // Automatically enter the channel after joining
            await selectChannel(streamId);
            
            showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            showNotification('Failed to join: ' + error.message, 'error');
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Show password input modal for joining password-protected channels
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @returns {Promise<string|null>} Password or null if cancelled
     */
    showPasswordInputModal(title, message) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[60]';
            // Security: escape user-provided content to prevent XSS
            const safeTitle = this._escapeHtml(title);
            const safeMessage = this._escapeHtml(message);
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl p-5 w-[340px] max-w-full mx-4 border border-white/[0.06]">
                    <h3 class="text-[15px] font-medium mb-2 text-white">${safeTitle}</h3>
                    <p class="text-[12px] text-white/50 mb-4">${safeMessage}</p>
                    <input type="password" id="browse-password-input" placeholder="Password" 
                        class="w-full bg-white/[0.05] border border-white/[0.08] text-white px-3 py-2.5 rounded-xl text-[13px] focus:outline-none focus:border-white/[0.15] transition mb-4"
                        autocomplete="off">
                    <div class="flex gap-2">
                        <button id="cancel-pw-btn" class="flex-1 bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-white/50 text-[13px] font-medium py-2.5 rounded-xl transition">
                            Cancel
                        </button>
                        <button id="confirm-pw-btn" class="flex-1 bg-white hover:bg-[#f0f0f0] text-black text-[13px] font-medium py-2.5 rounded-lg transition">
                            Join
                        </button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            const input = modal.querySelector('#browse-password-input');
            const cancelBtn = modal.querySelector('#cancel-pw-btn');
            const confirmBtn = modal.querySelector('#confirm-pw-btn');
            
            setTimeout(() => input.focus(), 100);
            
            const cleanup = (value) => {
                document.body.removeChild(modal);
                resolve(value);
            };
            
            cancelBtn.addEventListener('click', () => cleanup(null));
            confirmBtn.addEventListener('click', () => cleanup(input.value));
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') cleanup(input.value);
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) cleanup(null);
            });
        });
    }

    /**
     * Generate and display QR code for invite
     * @param {string} inviteLink - Invite link
     * @param {Function} showNotification - Notification callback
     */
    async generateQRCode(inviteLink, showNotification) {
        try {
            // QRCode is bundled in vendor.bundle.js
            if (!window.QRCode) {
                throw new Error('QRCode library not loaded');
            }

            // Show in modal
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl p-5 border border-white/[0.06]">
                    <h3 class="text-[15px] font-medium mb-4 text-white">Invite QR Code</h3>
                    <div id="qr-container" class="bg-white p-3 rounded-lg flex items-center justify-center"></div>
                    <button class="mt-4 w-full bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-white/50 text-[13px] font-medium px-4 py-2.5 rounded-xl transition">Close</button>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            // Generate QR code using qrcode npm package
            // Use lowest error correction level (L) to allow more data capacity
            const container = modal.querySelector('#qr-container');
            const canvas = document.createElement('canvas');
            await window.QRCode.toCanvas(canvas, inviteLink, {
                width: 200,
                margin: 1,
                errorCorrectionLevel: 'L',
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                }
            });
            container.appendChild(canvas);
            
            modal.querySelector('button').addEventListener('click', () => {
                document.body.removeChild(modal);
            });
            
            // Click outside to close
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                }
            });
        } catch (error) {
            Logger.error('Failed to generate QR code:', error);
            showNotification('Failed to generate QR code', 'error');
        }
    }

    /**
     * Escape HTML characters to prevent XSS
     * @param {string} unsafe - Unsafe string
     * @returns {string} Safe escaped string
     * @private
     */
    _escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}

// Singleton instance
let instance = null;

/**
 * Initialize JoinChannelUI with dependencies
 * @param {Object} deps - Dependencies
 * @returns {JoinChannelUI} Singleton instance
 */
export function init(deps) {
    channelManager = deps.channelManager;
    modalManager = deps.modalManager;
    notificationUI = deps.notificationUI;
    graphAPI = deps.graphAPI;
    exploreUI = deps.exploreUI;
    channelModalsUI = deps.channelModalsUI;
    
    instance = new JoinChannelUI(deps.elements);
    return instance;
}

/**
 * Get the singleton instance
 * @returns {JoinChannelUI|null}
 */
export function getInstance() {
    return instance;
}

export { JoinChannelUI };
