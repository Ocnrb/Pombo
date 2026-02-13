/**
 * UI Controller
 * Manages DOM manipulation, rendering, and QR code generation
 */

import { channelManager } from './channels.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { notificationManager } from './notifications.js';
import { graphAPI } from './graph.js';
import { secureStorage } from './secureStorage.js';
import { Logger } from './logger.js';

class UIController {
    constructor() {
        this.elements = {};
    }

    /**
     * Initialize UI elements and event listeners
     */
    init() {
        // Cache DOM elements
        this.elements = {
            // Header
            walletInfo: document.getElementById('wallet-info'),
            connectWalletBtn: document.getElementById('connect-wallet'),
            disconnectWalletBtn: document.getElementById('disconnect-wallet'),
            walletControls: document.getElementById('wallet-controls'),
            switchWalletBtn: document.getElementById('switch-wallet'),
            networkStatus: document.getElementById('network-status'),
            contactsBtn: document.getElementById('contacts-btn'),

            // Sidebar
            channelList: document.getElementById('channel-list'),
            newChannelBtn: document.getElementById('new-channel-btn'),

            // Chat area
            chatHeader: document.getElementById('chat-header'),
            currentChannelName: document.getElementById('current-channel-name'),
            currentChannelInfo: document.getElementById('current-channel-info'),
            channelMenuBtn: document.getElementById('channel-menu-btn'),
            messagesArea: document.getElementById('messages-area'),
            messageInput: document.getElementById('message-input'),
            messageInputContainer: document.getElementById('message-input-container'),
            sendMessageBtn: document.getElementById('send-message-btn'),

            // Modals
            newChannelModal: document.getElementById('new-channel-modal'),
            channelNameInput: document.getElementById('channel-name-input'),
            channelPasswordInput: document.getElementById('channel-password-input'),
            channelMembersInput: document.getElementById('channel-members-input'),
            passwordField: document.getElementById('password-field'),
            membersField: document.getElementById('members-field'),
            createChannelBtn: document.getElementById('create-channel-btn'),
            cancelChannelBtn: document.getElementById('cancel-channel-btn'),

            // Online users
            onlineUsersContainer: document.getElementById('online-users-container'),
            onlineHeader: document.getElementById('online-header'),
            onlineUsersCount: document.getElementById('online-users-count'),
            onlineUsersList: document.getElementById('online-users-list'),

            joinChannelModal: document.getElementById('join-channel-modal'),
            joinStreamIdInput: document.getElementById('join-stream-id-input'),
            joinPasswordInput: document.getElementById('join-password-input'),
            joinPasswordField: document.getElementById('join-password-field'),
            joinBtn: document.getElementById('join-btn'),
            cancelJoinBtn: document.getElementById('cancel-join-btn'),

            // Invite modal
            inviteUsersBtn: document.getElementById('invite-users-btn'),
            inviteUsersModal: document.getElementById('invite-users-modal'),
            inviteAddressInput: document.getElementById('invite-address-input'),
            inviteLinkDisplay: document.getElementById('invite-link-display'),
            copyInviteLinkBtn: document.getElementById('copy-invite-link-btn'),
            showQrBtn: document.getElementById('show-qr-btn'),
            sendInviteBtn: document.getElementById('send-invite-btn'),
            cancelInviteBtn: document.getElementById('cancel-invite-btn'),

            // Channel settings modal
            channelInfoBtn: document.getElementById('channel-info-btn'),
            channelSettingsModal: document.getElementById('channel-settings-modal'),
            channelSettingsName: document.getElementById('channel-settings-name'),
            channelSettingsType: document.getElementById('channel-settings-type'),
            channelSettingsId: document.getElementById('channel-settings-id'),
            copyStreamIdBtn: document.getElementById('copy-stream-id-btn'),
            membersSection: document.getElementById('members-section'),
            nonNativeMessage: document.getElementById('non-native-message'),
            refreshMembersBtn: document.getElementById('refresh-members-btn'),
            addMemberForm: document.getElementById('add-member-form'),
            addMemberInput: document.getElementById('add-member-input'),
            addMemberBtn: document.getElementById('add-member-btn'),
            batchMembersInput: document.getElementById('batch-members-input'),
            batchAddMembersBtn: document.getElementById('batch-add-members-btn'),
            membersList: document.getElementById('members-list'),
            permissionsSection: document.getElementById('permissions-section'),
            permissionsList: document.getElementById('permissions-list'),
            refreshPermissionsBtn: document.getElementById('refresh-permissions-btn'),
            closeChannelSettingsBtn: document.getElementById('close-channel-settings-btn'),
            dangerTabDivider: document.getElementById('danger-tab-divider'),
            dangerTabBtn: document.getElementById('danger-tab-btn'),
            deleteChannelSection: document.getElementById('delete-channel-section'),
            deleteChannelBtn: document.getElementById('delete-channel-btn'),
            channelSettingsTabs: document.querySelectorAll('.channel-settings-tab'),
            channelSettingsPanels: document.querySelectorAll('.channel-settings-panel'),

            // Delete channel confirmation modal
            deleteChannelModal: document.getElementById('delete-channel-modal'),
            deleteChannelName: document.getElementById('delete-channel-name'),
            cancelDeleteBtn: document.getElementById('cancel-delete-btn'),
            confirmDeleteBtn: document.getElementById('confirm-delete-btn'),

            // Join/Browse channels
            joinChannelBtn: document.getElementById('join-channel-btn'),
            browseChannelsBtn: document.getElementById('browse-channels-btn'),
            browseChannelsModal: document.getElementById('browse-channels-modal'),
            browseSearchInput: document.getElementById('browse-search-input'),
            browseChannelsList: document.getElementById('browse-channels-list'),
            closeBrowseBtn: document.getElementById('close-browse-btn')
        };

        // Set up event listeners
        this.setupEventListeners();

        Logger.info('UI Controller initialized');
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        // New channel button
        this.elements.newChannelBtn.addEventListener('click', () => {
            this.showNewChannelModal();
        });

        // Channel type tabs - switch between tab content
        document.querySelectorAll('.channel-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabType = tab.dataset.tab;
                this.switchChannelTab(tabType);
            });
        });

        // Online users dropdown toggle
        this.elements.onlineHeader?.addEventListener('click', () => {
            this.elements.onlineUsersList?.classList.toggle('hidden');
            this.elements.onlineHeader?.querySelector('svg')?.classList.toggle('rotate-180');
        });

        // Close online users list when clicking outside
        document.addEventListener('click', (e) => {
            if (this.elements.onlineUsersContainer && !this.elements.onlineUsersContainer.contains(e.target)) {
                this.elements.onlineUsersList?.classList.add('hidden');
                this.elements.onlineHeader?.querySelector('svg')?.classList.remove('rotate-180');
            }
        });

        // Create channel
        this.elements.createChannelBtn.addEventListener('click', () => {
            this.handleCreateChannel();
        });

        // Cancel channel creation
        this.elements.cancelChannelBtn.addEventListener('click', () => {
            this.hideNewChannelModal();
        });

        // Join channel button (sidebar)
        this.elements.joinChannelBtn?.addEventListener('click', () => {
            this.showJoinChannelModal();
        });

        // Browse channels button (sidebar)
        this.elements.browseChannelsBtn?.addEventListener('click', () => {
            this.showBrowseChannelsModal();
        });

        // Join channel (in modal)
        this.elements.joinBtn?.addEventListener('click', () => {
            this.handleJoinChannel();
        });

        // Cancel join
        this.elements.cancelJoinBtn?.addEventListener('click', () => {
            this.hideJoinChannelModal();
        });

        // Join password toggle
        const joinHasPassword = document.getElementById('join-has-password');
        joinHasPassword?.addEventListener('change', (e) => {
            this.elements.joinPasswordField?.classList.toggle('hidden', !e.target.checked);
        });

        // Close browse modal
        this.elements.closeBrowseBtn?.addEventListener('click', () => {
            this.hideBrowseChannelsModal();
        });

        // Browse search filter
        this.elements.browseSearchInput?.addEventListener('input', (e) => {
            this.filterBrowseChannels(e.target.value);
        });

        // Browse type filter tabs
        this.browseTypeFilter = 'all';
        document.querySelectorAll('.browse-filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.browseTypeFilter = tab.dataset.browseFilter;
                this.updateBrowseFilterTabs();
                this.filterBrowseChannels(this.elements.browseSearchInput?.value || '');
            });
        });

        // Send message
        this.elements.sendMessageBtn.addEventListener('click', () => {
            this.handleSendMessage();
        });

        // Enter key to send message
        this.elements.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.handleSendMessage();
            }
        });

        // Typing indicator - send signal while typing
        let typingTimeout;
        let lastTypingSent = 0;
        this.elements.messageInput.addEventListener('input', () => {
            const now = Date.now();
            // Send typing signal every 2 seconds while typing
            if (now - lastTypingSent > 2000) {
                const currentChannel = channelManager.getCurrentChannel();
                if (currentChannel) {
                    channelManager.sendTypingIndicator(currentChannel.streamId);
                }
                lastTypingSent = now;
            }
            
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                // Stop typing
            }, 3000);
        });

        // Invite users button
        this.elements.inviteUsersBtn.addEventListener('click', () => {
            this.showInviteModal();
        });

        // Send invite
        this.elements.sendInviteBtn.addEventListener('click', () => {
            this.handleSendInvite();
        });

        // Cancel invite
        this.elements.cancelInviteBtn.addEventListener('click', () => {
            this.hideInviteModal();
        });

        // Invite modal tabs
        document.querySelectorAll('.invite-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabType = tab.dataset.inviteTab;
                this.switchInviteTab(tabType);
            });
        });

        // Copy invite link
        this.elements.copyInviteLinkBtn.addEventListener('click', () => {
            this.copyInviteLink();
        });

        //Show QR code
        this.elements.showQrBtn.addEventListener('click', () => {
            this.showInviteQR();
        });

        // Contacts button
        if (this.elements.contactsBtn) {
            this.elements.contactsBtn.addEventListener('click', () => {
                this.showContactsModal();
            });
        }

        // Channel menu button (dropdown)
        if (this.elements.channelMenuBtn) {
            this.elements.channelMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showChannelDropdown(e);
            });
        }

        // Close channel settings modal
        if (this.elements.closeChannelSettingsBtn) {
            this.elements.closeChannelSettingsBtn.addEventListener('click', () => {
                this.hideChannelSettingsModal();
            });
        }

        // Click outside channel settings modal to close
        if (this.elements.channelSettingsModal) {
            this.elements.channelSettingsModal.addEventListener('click', (e) => {
                if (e.target === this.elements.channelSettingsModal) {
                    this.hideChannelSettingsModal();
                }
            });
        }

        // Refresh members button
        if (this.elements.refreshMembersBtn) {
            this.elements.refreshMembersBtn.addEventListener('click', () => {
                this.loadChannelMembers();
            });
        }

        // Refresh permissions button
        if (this.elements.refreshPermissionsBtn) {
            this.elements.refreshPermissionsBtn.addEventListener('click', () => {
                this.loadStreamPermissions();
            });
        }

        // Add member button
        if (this.elements.addMemberBtn) {
            this.elements.addMemberBtn.addEventListener('click', () => {
                this.handleAddMember();
            });
        }

        // Batch add members button
        if (this.elements.batchAddMembersBtn) {
            this.elements.batchAddMembersBtn.addEventListener('click', () => {
                this.handleBatchAddMembers();
            });
        }

        // Copy stream ID button
        if (this.elements.copyStreamIdBtn) {
            this.elements.copyStreamIdBtn.addEventListener('click', async () => {
                const currentChannel = channelManager.getCurrentChannel();
                if (currentChannel) {
                    try {
                        await navigator.clipboard.writeText(currentChannel.streamId);
                        this.showNotification('Stream ID copied!', 'success');
                    } catch {
                        this.showNotification('Failed to copy', 'error');
                    }
                }
            });
        }

        // Delete channel button
        if (this.elements.deleteChannelBtn) {
            this.elements.deleteChannelBtn.addEventListener('click', () => {
                this.showDeleteChannelModal();
            });
        }

        // Cancel delete button
        if (this.elements.cancelDeleteBtn) {
            this.elements.cancelDeleteBtn.addEventListener('click', () => {
                this.hideDeleteChannelModal();
            });
        }

        // Confirm delete button
        if (this.elements.confirmDeleteBtn) {
            this.elements.confirmDeleteBtn.addEventListener('click', () => {
                this.handleDeleteChannel();
            });
        }

        // Click outside delete modal to close
        if (this.elements.deleteChannelModal) {
            this.elements.deleteChannelModal.addEventListener('click', (e) => {
                if (e.target === this.elements.deleteChannelModal) {
                    this.hideDeleteChannelModal();
                }
            });
        }

        // Add contact nickname modal
        const cancelAddContactBtn = document.getElementById('cancel-add-contact-btn');
        const confirmAddContactBtn = document.getElementById('confirm-add-contact-btn');
        const addContactNicknameModal = document.getElementById('add-contact-nickname-modal');
        const addContactModalNickname = document.getElementById('add-contact-modal-nickname');
        
        if (cancelAddContactBtn) {
            cancelAddContactBtn.addEventListener('click', () => {
                this.hideAddContactModal();
            });
        }
        
        if (confirmAddContactBtn) {
            confirmAddContactBtn.addEventListener('click', () => {
                this.confirmAddContact();
            });
        }
        
        if (addContactNicknameModal) {
            addContactNicknameModal.addEventListener('click', (e) => {
                if (e.target === addContactNicknameModal) {
                    this.hideAddContactModal();
                }
            });
        }
        
        if (addContactModalNickname) {
            addContactModalNickname.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.confirmAddContact();
                }
            });
        }

        // Remove contact confirmation modal
        const cancelRemoveContactBtn = document.getElementById('cancel-remove-contact-btn');
        const confirmRemoveContactBtn = document.getElementById('confirm-remove-contact-btn');
        const removeContactModal = document.getElementById('remove-contact-modal');
        
        if (cancelRemoveContactBtn) {
            cancelRemoveContactBtn.addEventListener('click', () => {
                this.hideRemoveContactModal();
            });
        }
        
        if (confirmRemoveContactBtn) {
            confirmRemoveContactBtn.addEventListener('click', () => {
                this.confirmRemoveContact();
            });
        }
        
        if (removeContactModal) {
            removeContactModal.addEventListener('click', (e) => {
                if (e.target === removeContactModal) {
                    this.hideRemoveContactModal();
                }
            });
        }

        // Enter key on add member input
        if (this.elements.addMemberInput) {
            this.elements.addMemberInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.handleAddMember();
                }
            });
        }

        // Initialize contacts UI (will be called lazily if needed)
        this.initContactsUI();
        
        // Initialize settings UI
        this.initSettingsUI();
        
        // Initialize emoji picker
        this.initEmojiPicker();
        
        // Initialize reactions
        this.initReactions();
    }

    /**
     * Update wallet info display
     * @param {string} address - Wallet address
     */
    updateWalletInfo(address) {
        if (address) {
            const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
            this.elements.walletInfo.textContent = short;
            // Hide connect button, show wallet controls
            this.elements.connectWalletBtn.classList.add('hidden');
            this.elements.walletControls?.classList.remove('hidden');
            // Show contacts button
            this.elements.contactsBtn?.classList.remove('hidden');
            // Show settings button
            this.elements.settingsBtn?.classList.remove('hidden');
        } else {
            this.elements.walletInfo.textContent = 'Not Connected';
            // Show connect button, hide wallet controls
            this.elements.connectWalletBtn.classList.remove('hidden');
            this.elements.walletControls?.classList.add('hidden');
            // Hide contacts button
            this.elements.contactsBtn?.classList.add('hidden');
            // Hide settings button
            this.elements.settingsBtn?.classList.add('hidden');
        }
    }

    /**
     * Update switch wallet button visibility
     * @param {boolean} show - Whether to show the switch button
     */
    updateSwitchWalletButton(show) {
        if (show) {
            this.elements.switchWalletBtn?.classList.remove('hidden');
        } else {
            this.elements.switchWalletBtn?.classList.add('hidden');
        }
    }

    /**
     * Update network status
     * @param {string} status - Status message
     * @param {boolean} connected - Connection status
     */
    updateNetworkStatus(status, connected = false) {
        const dot = document.getElementById('network-dot');
        
        // Normalize status text to be minimal
        let displayStatus = 'offline';
        if (connected) {
            displayStatus = 'online';
        } else if (status.toLowerCase().includes('connecting')) {
            displayStatus = 'connecting';
        } else if (status.toLowerCase().includes('ready')) {
            displayStatus = 'ready';
        }
        
        this.elements.networkStatus.textContent = displayStatus;
        
        if (connected) {
            this.elements.networkStatus.classList.add('text-emerald-400');
            this.elements.networkStatus.classList.remove('text-[#555]', 'text-amber-400');
            if (dot) {
                dot.classList.remove('bg-[#444]', 'bg-amber-400');
                dot.classList.add('bg-emerald-400');
            }
        } else if (displayStatus === 'connecting') {
            this.elements.networkStatus.classList.add('text-amber-400');
            this.elements.networkStatus.classList.remove('text-[#555]', 'text-emerald-400');
            if (dot) {
                dot.classList.remove('bg-[#444]', 'bg-emerald-400');
                dot.classList.add('bg-amber-400');
            }
        } else {
            this.elements.networkStatus.classList.remove('text-emerald-400', 'text-amber-400');
            this.elements.networkStatus.classList.add('text-[#555]');
            if (dot) {
                dot.classList.remove('bg-emerald-400', 'bg-amber-400');
                dot.classList.add('bg-[#444]');
            }
        }
    }

    /**
     * Render channel list
     */
    renderChannelList() {
        const channels = channelManager.getAllChannels();
        Logger.debug('renderChannelList called - Total channels:', channels.length);
        Logger.debug('Channels:', channels);

        if (channels.length === 0) {
            this.elements.channelList.innerHTML = `
                <div class="p-4 text-center text-[#555] text-[13px]">
                    No channels yet
                </div>
            `;
            Logger.debug('No channels to render');
            return;
        }

        this.elements.channelList.innerHTML = channels.map(channel => `
            <div
                class="channel-item px-3 py-2.5 mx-2 my-1 rounded-lg cursor-pointer bg-[#151515] border border-[#222] hover:bg-[#1e1e1e] hover:border-[#333] transition"
                data-stream-id="${channel.streamId}"
            >
                <div class="flex items-center justify-between">
                    <div class="flex-1 min-w-0">
                        <h3 class="text-[13px] font-medium text-white truncate">${this.escapeHtml(channel.name)}</h3>
                        <p class="text-[11px] text-[#666]">${this.getChannelTypeLabel(channel.type)}</p>
                    </div>
                    <div class="flex items-center gap-1.5 ml-2">
                        ${channel.messages.length > 0 ? `<span class="text-[10px] text-[#555] bg-[#252525] px-1.5 py-0.5 rounded">${channel.messages.length}</span>` : ''}
                        <svg class="w-3.5 h-3.5 text-[#444]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8.25 4.5l7.5 7.5-7.5 7.5"></path>
                        </svg>
                    </div>
                </div>
            </div>
        `).join('');

        Logger.debug('Channels rendered, adding click listeners...');

        // Add click listeners
        document.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const streamId = e.currentTarget.dataset.streamId;
                Logger.debug('Channel clicked:', streamId);
                this.selectChannel(streamId);
            });
        });

        Logger.debug('Channel list rendering complete');
    }

    /**
     * Select and open a channel
     * @param {string} streamId - Stream ID
     */
    async selectChannel(streamId) {
        // Clear typing indicator from previous channel
        this.hideTypingIndicator();
        
        channelManager.setCurrentChannel(streamId);
        const channel = channelManager.getCurrentChannel();

        if (channel) {
            // Ensure we're subscribed to this channel
            try {
                await channelManager.subscribeToChannel(streamId, channel.password);
            } catch (e) {
                Logger.warn('Subscribe error (may already be subscribed):', e.message);
            }
            
            this.elements.currentChannelName.textContent = channel.name;
            this.elements.currentChannelInfo.innerHTML = this.getChannelTypeLabel(channel.type);
            this.elements.messageInputContainer.classList.remove('hidden');

            // Show invite button
            this.elements.inviteUsersBtn.classList.remove('hidden');

            // Show channel menu button
            if (this.elements.channelMenuBtn) {
                this.elements.channelMenuBtn.classList.remove('hidden');
            }
            
            // Show online users container
            this.elements.onlineUsersContainer?.classList.remove('hidden');

            // Load reactions from channel state
            this.loadChannelReactions(streamId);

            this.renderMessages(channel.messages);
            
            // Start presence tracking
            channelManager.startPresenceTracking(streamId);
            
            // Update online users display
            this.updateOnlineUsers(streamId, channelManager.getOnlineUsers(streamId));
        }
    }

    /**
     * Update online users display
     * @param {string} streamId - Stream ID
     * @param {Array} users - Array of online users
     */
    updateOnlineUsers(streamId, users) {
        // Only update if this is the current channel
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel || currentChannel.streamId !== streamId) return;
        
        // Update count
        if (this.elements.onlineUsersCount) {
            this.elements.onlineUsersCount.textContent = users.length;
        }
        
        // Update list
        if (this.elements.onlineUsersList) {
            if (users.length === 0) {
                this.elements.onlineUsersList.innerHTML = '<div class="text-gray-400 text-sm text-center">No one online</div>';
            } else {
                const myAddress = authManager.getAddress()?.toLowerCase();
                
                this.elements.onlineUsersList.innerHTML = users.map(user => {
                    const address = user.address || user.id;
                    const isMe = address?.toLowerCase() === myAddress;
                    const nickname = user.nickname;
                    const shortAddress = this.formatAddress(address);
                    
                    // Display: nickname or address as main name
                    const displayName = nickname 
                        ? `${this.escapeHtml(nickname)}` 
                        : shortAddress;
                    
                    // Subtitle: address if has nickname, or "(you)" if it's me
                    let subtitle = '';
                    if (nickname) {
                        subtitle = isMe ? `${shortAddress} (you)` : shortAddress;
                    } else if (isMe) {
                        subtitle = '(you)';
                    }
                    
                    return `
                        <div class="user-item-wrapper" data-user-address="${address}">
                            <div class="user-item cursor-pointer hover:bg-[#2a2a2a] rounded px-2 py-1 -mx-2">
                                <div class="user-dot ${isMe ? 'bg-white' : ''}"></div>
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
        // Menu toggle buttons
        document.querySelectorAll('.user-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const wrapper = btn.closest('.user-item-wrapper');
                const address = wrapper?.dataset.userAddress;
                const isMe = address?.toLowerCase() === authManager.getAddress()?.toLowerCase();
                
                // Close any existing dropdown
                this.closeUserDropdown();
                
                // Create dropdown and append to body for proper positioning
                const dropdown = document.createElement('div');
                dropdown.id = 'user-dropdown-menu';
                dropdown.className = 'fixed bg-[#1e1e1e] border border-gray-700 rounded-lg shadow-xl py-1 z-[9999] min-w-[160px]';
                dropdown.innerHTML = `
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-[#2a2a2a] text-sm text-gray-300" data-action="copy-address" data-address="${address}">
                        📋 Copy Address
                    </button>
                    ${!isMe ? `
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-[#2a2a2a] text-sm text-gray-300" data-action="add-contact" data-address="${address}">
                        ➕ Add to Contacts
                    </button>
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-[#2a2a2a] text-sm text-red-400" data-action="start-dm" data-address="${address}">
                        💬 Start DM
                    </button>
                    ` : ''}
                `;
                
                document.body.appendChild(dropdown);
                
                // Position dropdown relative to button
                const btnRect = btn.getBoundingClientRect();
                const dropdownRect = dropdown.getBoundingClientRect();
                
                // Position to the left of the button, aligned with top
                let left = btnRect.left - dropdownRect.width - 8;
                let top = btnRect.top;
                
                // If would go off left edge, position to the right instead
                if (left < 8) {
                    left = btnRect.right + 8;
                }
                
                // If would go off bottom, adjust up
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
                        await this.handleUserMenuAction(action, addr);
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
    
    /**
     * Show channel dropdown menu
     */
    showChannelDropdown(e) {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;
        
        // Close any existing dropdown
        this.closeChannelDropdown();
        
        // Create dropdown
        const dropdown = document.createElement('div');
        dropdown.id = 'channel-dropdown-menu';
        dropdown.className = 'fixed bg-[#141414] border border-white/10 rounded-xl shadow-2xl py-1 z-[9999] min-w-[180px] overflow-hidden';
        dropdown.innerHTML = `
            <button class="channel-action w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm text-white/70 hover:text-white transition flex items-center gap-2" data-action="copy-stream-id">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/></svg>
                Copy Channel ID
            </button>
            <button class="channel-action w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm text-white/70 hover:text-white transition flex items-center gap-2" data-action="channel-settings">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                Channel Settings
            </button>
            <div class="my-1 border-t border-white/5"></div>
            <button class="channel-action w-full text-left px-4 py-2.5 hover:bg-red-500/10 text-sm text-white/50 hover:text-red-400 transition flex items-center gap-2" data-action="leave-channel">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"/></svg>
                Leave Channel
            </button>
        `;
        
        document.body.appendChild(dropdown);
        
        // Position dropdown below button
        const btn = this.elements.channelMenuBtn;
        const btnRect = btn.getBoundingClientRect();
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
                await this.handleChannelMenuAction(action);
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
     * Handle channel menu action
     */
    async handleChannelMenuAction(action) {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;
        
        switch (action) {
            case 'copy-stream-id':
                try {
                    await navigator.clipboard.writeText(currentChannel.streamId);
                    this.showNotification('Channel ID copied!', 'success');
                } catch {
                    this.showNotification('Failed to copy', 'error');
                }
                break;
                
            case 'channel-settings':
                this.showChannelSettingsModal();
                break;
                
            case 'leave-channel':
                this.showLeaveChannelModal();
                break;
        }
    }
    
    /**
     * Handle user menu action
     */
    async handleUserMenuAction(action, address) {
        switch (action) {
            case 'copy-address':
                try {
                    await navigator.clipboard.writeText(address);
                    this.showNotification('Address copied!', 'success');
                } catch {
                    this.showNotification('Failed to copy', 'error');
                }
                break;
                
            case 'add-contact':
                this.showAddContactModal(address);
                break;
                
            case 'start-dm':
                // TODO: Implement DM functionality
                this.showNotification('DM feature coming soon!', 'info');
                break;
        }
    }

    /**
     * Format Ethereum address for display
     * @param {string} address - Full address
     * @returns {string} - Formatted address
     */
    formatAddress(address) {
        if (!address) return 'Unknown';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} str - String to escape
     * @returns {string} - Escaped string
     */
    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * Load reactions from channel state into UI
     * @param {string} streamId - Stream ID
     */
    loadChannelReactions(streamId) {
        this.initReactions();
        this.messageReactions.clear();
        
        const reactions = channelManager.getChannelReactions(streamId);
        
        for (const [messageId, emojiMap] of Object.entries(reactions)) {
            this.messageReactions.set(messageId, emojiMap);
        }
        
        Logger.debug('Loaded reactions for channel:', Object.keys(reactions).length, 'messages with reactions');
    }

    /**
     * Render messages in the chat area (bubble style like CHATtest.html)
     * @param {Array} messages - Array of message objects
     */
    renderMessages(messages) {
        if (messages.length === 0) {
            this.elements.messagesArea.innerHTML = `
                <div class="flex items-center justify-center h-full text-gray-500">
                    No messages yet. Start the conversation!
                </div>
            `;
            return;
        }

        const currentAddress = authManager.getAddress();

        this.elements.messagesArea.innerHTML = messages.map(msg => {
            const isOwn = msg.sender?.toLowerCase() === currentAddress?.toLowerCase();
            const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            // Get verification badge (pass isOwn to show different badge for own messages)
            const badge = this.getVerificationBadge(msg, isOwn);
            
            // Priority for display name:
            // 1. senderName (from message)
            // 2. ENS name
            // 3. Sender address
            let displayName = msg.senderName || msg.verified?.ensName;
            if (!displayName) {
                displayName = this.formatAddress(msg.sender);
            }
            
            const msgId = msg.id || msg.timestamp;
            
            // Get reactions for this message
            const reactionsHtml = this.renderReactions(msgId, isOwn);

            return `
                <div class="message-entry ${isOwn ? 'own-message' : 'other-message'}" data-msg-id="${msgId}" data-sender="${msg.sender || ''}">
                    <div class="message-bubble">
                        <div class="flex items-center gap-1 mb-1">
                            ${badge.html}
                            <span class="text-xs font-medium ${badge.textColor}">${this.escapeHtml(displayName)}</span>
                        </div>
                        <div class="message-content">${this.escapeHtml(msg.text)}</div>
                        <div class="text-xs text-gray-500 mt-1 ${isOwn ? 'text-right' : 'text-left'}">${time}</div>
                        ${!msg.verified?.valid && msg.signature ? '<div class="text-xs text-red-400 mt-1">⚠️ Invalid signature</div>' : ''}
                        <div class="message-actions">
                            <span class="action-btn react-btn" data-msg-id="${msgId}" title="React">😀</span>
                        </div>
                    </div>
                    ${reactionsHtml}
                </div>
            `;
        }).join('');

        // Scroll to bottom
        this.elements.messagesArea.scrollTop = this.elements.messagesArea.scrollHeight;
        
        // Attach reaction button listeners
        this.attachReactionListeners();
    }

    /**
     * Render reactions for a message
     */
    renderReactions(msgId, isOwn) {
        const reactions = this.messageReactions?.get(msgId);
        if (!reactions || Object.keys(reactions).length === 0) {
            return `<div class="reactions-container" data-reactions-for="${msgId}"></div>`;
        }

        const currentAddress = authManager.getAddress()?.toLowerCase();
        let html = `<div class="reactions-container" data-reactions-for="${msgId}">`;
        
        for (const [emoji, users] of Object.entries(reactions)) {
            if (users.length > 0) {
                const userReacted = users.some(u => u.toLowerCase() === currentAddress);
                html += `<span class="reaction-badge ${userReacted ? 'user-reacted' : ''}" data-emoji="${emoji}" data-msg-id="${msgId}">${emoji} ${users.length}</span>`;
            }
        }
        
        html += '</div>';
        return html;
    }

    /**
     * Initialize reactions map
     */
    initReactions() {
        if (!this.messageReactions) {
            this.messageReactions = new Map();
        }
    }

    /**
     * Add or toggle a reaction
     */
    toggleReaction(msgId, emoji) {
        this.initReactions();
        
        const currentAddress = authManager.getAddress();
        if (!currentAddress) return;
        
        if (!this.messageReactions.has(msgId)) {
            this.messageReactions.set(msgId, {});
        }
        
        const reactions = this.messageReactions.get(msgId);
        if (!reactions[emoji]) {
            reactions[emoji] = [];
        }
        
        const userIndex = reactions[emoji].findIndex(u => u.toLowerCase() === currentAddress.toLowerCase());
        const isRemoving = userIndex >= 0;
        
        if (isRemoving) {
            reactions[emoji].splice(userIndex, 1);
        } else {
            reactions[emoji].push(currentAddress);
        }
        
        // Update the UI
        this.updateReactionUI(msgId);
        
        // Send reaction to channel (will be stored via handleControlMessage)
        this.sendReaction(msgId, emoji, isRemoving);
    }

    /**
     * Update reaction UI for specific message
     */
    updateReactionUI(msgId) {
        const container = document.querySelector(`[data-reactions-for="${msgId}"]`);
        if (!container) return;
        
        const reactions = this.messageReactions?.get(msgId);
        const currentAddress = authManager.getAddress()?.toLowerCase();
        
        container.innerHTML = '';
        
        if (reactions) {
            for (const [emoji, users] of Object.entries(reactions)) {
                if (users.length > 0) {
                    const userReacted = users.some(u => u.toLowerCase() === currentAddress);
                    const badge = document.createElement('span');
                    badge.className = `reaction-badge ${userReacted ? 'user-reacted' : ''}`;
                    badge.dataset.emoji = emoji;
                    badge.dataset.msgId = msgId;
                    badge.textContent = `${emoji} ${users.length}`;
                    badge.addEventListener('click', () => this.toggleReaction(msgId, emoji));
                    container.appendChild(badge);
                }
            }
        }
    }

    /**
     * Send reaction via channel
     * @param {string} msgId - Message ID
     * @param {string} emoji - Emoji
     * @param {boolean} isRemoving - True if removing reaction
     */
    sendReaction(msgId, emoji, isRemoving = false) {
        const channel = channelManager.getCurrentChannel();
        if (channel) {
            channelManager.sendReaction(channel.streamId, msgId, emoji, isRemoving);
        }
    }

    /**
     * Handle incoming reaction
     * @param {string} msgId - Message ID
     * @param {string} emoji - Emoji
     * @param {string} sender - Sender address
     * @param {string} action - 'add' or 'remove'
     */
    handleIncomingReaction(msgId, emoji, sender, action = 'add') {
        this.initReactions();
        
        if (!this.messageReactions.has(msgId)) {
            this.messageReactions.set(msgId, {});
        }
        
        const reactions = this.messageReactions.get(msgId);
        if (!reactions[emoji]) {
            reactions[emoji] = [];
        }
        
        const senderLower = sender.toLowerCase();
        const userIndex = reactions[emoji].findIndex(u => u.toLowerCase() === senderLower);
        
        if (action === 'remove') {
            // Remove user from reaction
            if (userIndex >= 0) {
                reactions[emoji].splice(userIndex, 1);
                // Clean up empty arrays
                if (reactions[emoji].length === 0) {
                    delete reactions[emoji];
                }
                this.updateReactionUI(msgId);
            }
        } else {
            // Add if not already present
            if (userIndex < 0) {
                reactions[emoji].push(sender);
                this.updateReactionUI(msgId);
            }
        }
    }

    /**
     * Attach reaction button listeners
     */
    attachReactionListeners() {
        document.querySelectorAll('.react-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const msgId = btn.dataset.msgId;
                this.showReactionPicker(e, msgId);
            });
        });
        
        document.querySelectorAll('.reaction-badge').forEach(badge => {
            badge.addEventListener('click', (e) => {
                const msgId = badge.dataset.msgId;
                const emoji = badge.dataset.emoji;
                this.toggleReaction(msgId, emoji);
            });
        });
    }

    /**
     * Show reaction picker
     */
    showReactionPicker(e, msgId) {
        const picker = document.getElementById('reaction-picker');
        if (!picker) return;
        
        // Position near the button
        const rect = e.target.getBoundingClientRect();
        
        // Temporarily show picker to measure dimensions
        picker.style.visibility = 'hidden';
        picker.style.display = 'flex';
        
        const pickerWidth = picker.offsetWidth;
        const pickerHeight = picker.offsetHeight;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Calculate initial position
        let left = rect.left;
        let top = rect.bottom + 5;
        
        // Adjust if picker would overflow right edge
        if (left + pickerWidth > viewportWidth - 10) {
            left = viewportWidth - pickerWidth - 10;
        }
        
        // Adjust if picker would overflow bottom edge
        if (top + pickerHeight > viewportHeight - 10) {
            top = rect.top - pickerHeight - 5; // Show above instead
        }
        
        // Ensure minimum left
        left = Math.max(10, left);
        
        picker.style.left = `${left}px`;
        picker.style.top = `${top}px`;
        picker.style.visibility = 'visible';
        
        // Store current message ID
        picker.dataset.currentMsgId = msgId;
        
        // Attach click handlers
        picker.querySelectorAll('span').forEach(span => {
            span.onclick = () => {
                this.toggleReaction(msgId, span.dataset.emoji);
                picker.style.display = 'none';
            };
        });
    }

    /**
     * Initialize emoji picker
     */
    initEmojiPicker() {
        const emojiPicker = document.getElementById('emoji-picker');
        const emojiBtn = document.getElementById('emoji-btn');
        
        if (!emojiPicker || !emojiBtn) return;
        
        const emojis = [
            '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
            '🙂', '🙃', '😉', '😍', '🥰', '😘', '😋', '😛', '😜', '🤪',
            '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😔', '😢', '😭',
            '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨',
            '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😬', '🙄', '😯',
            '😲', '🥱', '😴', '🤤', '😵', '🤐', '🥴', '🤢', '🤮', '🤧',
            '👍', '👎', '👏', '🙌', '🤝', '🙏', '✌️', '🤞', '🤟', '🤘',
            '👋', '💪', '❤️', '🔥', '⭐', '🎉', '🎊', '💯', '✅', '❌',
            '⚡', '🚀', '💀', '👻', '🤖', '👽', '💩', '🤡'
        ];
        
        emojiPicker.innerHTML = emojis.map(e => `<span>${e}</span>`).join('');
        
        // Add click handlers
        emojiPicker.querySelectorAll('span').forEach(span => {
            span.addEventListener('click', () => {
                if (this.elements.messageInput) {
                    this.elements.messageInput.value += span.textContent;
                    this.elements.messageInput.focus();
                }
            });
        });
        
        // Toggle emoji picker
        emojiBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            emojiPicker.style.display = emojiPicker.style.display === 'flex' ? 'none' : 'flex';
        });
        
        // Close picker when clicking outside
        document.addEventListener('click', (e) => {
            if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) {
                emojiPicker.style.display = 'none';
            }
            
            // Also close reaction picker
            const reactionPicker = document.getElementById('reaction-picker');
            if (reactionPicker && !reactionPicker.contains(e.target)) {
                reactionPicker.style.display = 'none';
            }
        });
    }

    /**
     * Show typing indicator
     */
    showTypingIndicator(users) {
        const indicator = document.getElementById('typing-indicator');
        const usersSpan = document.getElementById('typing-users');
        
        if (!indicator || !usersSpan) return;
        
        if (users.length === 0) {
            indicator.classList.add('hidden');
            return;
        }
        
        const names = users.map(u => this.formatAddress(u)).join(', ');
        usersSpan.textContent = names + (users.length === 1 ? ' is' : ' are');
        indicator.classList.remove('hidden');
    }

    /**
     * Hide typing indicator
     */
    hideTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) {
            indicator.classList.add('hidden');
        }
    }

    /**
     * Get verification badge HTML for a message
     * @param {Object} msg - Message object
     * @param {boolean} isOwn - Whether this is the user's own message
     * @returns {Object} - { html, textColor, bgColor, border }
     */
    getVerificationBadge(msg, isOwn = false) {
        // Own messages - simple check, no special badge needed
        if (isOwn) {
            return {
                html: '<span class="text-green-400" title="Your message">✓</span>',
                textColor: 'text-green-400',
                bgColor: '',
                border: ''
            };
        }

        // No signature (old message format or system message)
        if (!msg.signature) {
            return {
                html: '',  // No badge for legacy messages
                textColor: 'text-gray-400',
                bgColor: 'bg-gray-700',
                border: ''
            };
        }

        // Signature verification failed
        if (msg.verified && !msg.verified.valid) {
            return {
                html: '<span class="text-red-500" title="⚠️ Invalid signature - may be impersonation!">❌</span>',
                textColor: 'text-red-400',
                bgColor: 'bg-red-900/20',
                border: 'border border-red-500/50'
            };
        }

        // Valid signature - show badges based on trust level
        const trustLevel = msg.verified?.trustLevel ?? 0;
        
        // Trust level badges (simplified and intuitive):
        // 0 = Valid signature, unknown sender: ✓ (green check)
        // 1 = ENS verified: verified badge
        // 2 = Trusted contact: star
        
        const badges = {
            0: { icon: '<svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>', color: 'text-green-400', label: 'Valid signature' },
            1: { icon: '<svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z"/></svg>', color: 'text-green-400', label: 'ENS verified' },
            2: { icon: '<svg class="w-3.5 h-3.5 inline" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" clip-rule="evenodd"/></svg>', color: 'text-yellow-400', label: 'Trusted contact' }
        };
        
        const badge = badges[trustLevel] || badges[0];

        return {
            html: `<span class="${badge.color}" title="${badge.label}">${badge.icon}</span>`,
            textColor: badge.color,
            bgColor: '',
            border: ''
        };
    }

    /**
     * Add a new message to the UI
     * @param {Object} message - Message object
     */
    addMessage(message) {
        const channel = channelManager.getCurrentChannel();
        if (channel) {
            this.renderMessages(channel.messages);
        }
    }

    /**
     * Handle create channel
     */
    async handleCreateChannel() {
        const name = this.elements.channelNameInput.value.trim();
        const activeTab = document.querySelector('.channel-tab-content:not(.hidden)');
        const type = activeTab?.querySelector('.channel-type-input')?.value || 'public';
        const password = this.elements.channelPasswordInput.value;
        const membersText = this.elements.channelMembersInput.value;

        if (!name) {
            alert('Please enter a channel name');
            return;
        }

        if (type === 'password' && !password) {
            alert('Please enter a password');
            return;
        }

        const members = type === 'native'
            ? membersText.split('\n').map(m => m.trim()).filter(m => m)
            : [];

        Logger.debug('Creating channel:', { name, type, password: password ? '***' : null, members });

        try {
            this.showLoading('Creating channel...');
            const channel = await channelManager.createChannel(name, type, password, members);
            Logger.debug('Channel created in UI:', channel);

            this.hideLoading();
            this.hideNewChannelModal();

            // Force render channel list
            Logger.debug('Rendering channel list...');
            this.renderChannelList();

            // Auto-select the new channel
            if (channel) {
                setTimeout(() => {
                    this.selectChannel(channel.streamId);
                }, 100);
            }

            this.showNotification('Channel created successfully!', 'success');
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to create channel: ' + error.message, 'error');
        }
    }

    /**
     * Handle send message
     */
    async handleSendMessage() {
        const text = this.elements.messageInput.value.trim();
        if (!text) return;

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            this.elements.messageInput.value = '';
            await channelManager.sendMessage(currentChannel.streamId, text);
            // UI update happens via notifyHandlers -> addMessage
        } catch (error) {
            this.showNotification('Failed to send message: ' + error.message, 'error');
        }
    }

    /**
     * Show new channel modal
     */
    showNewChannelModal() {
        this.elements.newChannelModal.classList.remove('hidden');
        this.elements.channelNameInput.value = '';
        this.elements.channelPasswordInput.value = '';
        this.elements.channelMembersInput.value = '';
        // Reset to public tab
        this.switchChannelTab('public');
    }

    /**
     * Switch channel type tab
     */
    switchChannelTab(tabType) {
        // Update tab buttons
        document.querySelectorAll('.channel-tab').forEach(tab => {
            const isActive = tab.dataset.tab === tabType;
            tab.classList.toggle('bg-white', isActive);
            tab.classList.toggle('text-black', isActive);
            tab.classList.toggle('font-medium', isActive);
            tab.classList.toggle('text-[#888]', !isActive);
            tab.classList.toggle('hover:text-white', !isActive);
            tab.classList.toggle('hover:bg-[#252525]', !isActive);
        });
        // Update tab content
        document.querySelectorAll('.channel-tab-content').forEach(content => {
            content.classList.toggle('hidden', content.id !== `tab-${tabType}`);
        });
    }

    /**
     * Hide new channel modal
     */
    hideNewChannelModal() {
        this.elements.newChannelModal.classList.add('hidden');
    }

    /**
     * Show join channel modal
     */
    showJoinChannelModal() {
        this.elements.joinChannelModal?.classList.remove('hidden');
        if (this.elements.joinStreamIdInput) {
            this.elements.joinStreamIdInput.value = '';
        }
        if (this.elements.joinPasswordInput) {
            this.elements.joinPasswordInput.value = '';
        }
        this.elements.joinPasswordField?.classList.add('hidden');
        // Reset checkbox
        const checkbox = document.getElementById('join-has-password');
        if (checkbox) checkbox.checked = false;
    }

    /**
     * Hide join channel modal
     */
    hideJoinChannelModal() {
        this.elements.joinChannelModal?.classList.add('hidden');
    }

    /**
     * Handle join channel
     */
    async handleJoinChannel() {
        const streamId = this.elements.joinStreamIdInput?.value.trim();
        const password = this.elements.joinPasswordInput?.value || null;

        if (!streamId) {
            this.showNotification('Please enter a Stream ID', 'error');
            return;
        }

        try {
            this.showLoading('Joining channel...');
            await channelManager.joinChannel(streamId, password);
            this.hideLoading();
            this.hideJoinChannelModal();
            this.renderChannelList();
            this.showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to join: ' + error.message, 'error');
        }
    }

    /**
     * Show browse channels modal
     */
    async showBrowseChannelsModal() {
        this.elements.browseChannelsModal?.classList.remove('hidden');
        if (this.elements.browseSearchInput) {
            this.elements.browseSearchInput.value = '';
        }
        
        // Reset type filter
        this.browseTypeFilter = 'all';
        this.updateBrowseFilterTabs();
        
        // Load public channels from registry
        await this.loadPublicChannels();
    }

    /**
     * Hide browse channels modal
     */
    hideBrowseChannelsModal() {
        this.elements.browseChannelsModal?.classList.add('hidden');
    }

    /**
     * Load public channels from registry
     */
    async loadPublicChannels() {
        if (!this.elements.browseChannelsList) return;

        this.elements.browseChannelsList.innerHTML = `
            <div class="text-center text-gray-500 py-8">
                <div class="spinner mx-auto mb-2" style="width: 32px; height: 32px;"></div>
                Loading public channels...
            </div>
        `;

        try {
            const channels = await channelManager.getPublicChannels();
            this.cachedPublicChannels = channels;
            this.renderPublicChannelsList(channels);
        } catch (error) {
            Logger.error('Failed to load public channels:', error);
            this.elements.browseChannelsList.innerHTML = `
                <div class="text-center text-gray-500 py-8">
                    <p>Failed to load channels</p>
                    <p class="text-sm mt-2">${error.message}</p>
                </div>
            `;
        }
    }

    /**
     * Render public channels list
     */
    renderPublicChannelsList(channels) {
        if (!this.elements.browseChannelsList) return;

        if (channels.length === 0) {
            this.elements.browseChannelsList.innerHTML = `
                <div class="text-center text-[#555] py-8 text-[13px]">
                    No channels found
                </div>
            `;
            return;
        }

        this.elements.browseChannelsList.innerHTML = channels.map(ch => {
            const typeBadge = ch.type === 'password' 
                ? '<span class="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded ml-2 inline-flex items-center gap-1"><svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>Password</span>'
                : '<span class="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded ml-2 inline-flex items-center gap-1"><svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"/></svg>Public</span>';
            
            return `
            <div class="p-3 bg-[#1a1a1a] border border-[#282828] rounded-lg hover:bg-[#202020] hover:border-[#333] transition cursor-pointer browse-channel-item" data-stream-id="${ch.streamId}" data-type="${ch.type || 'public'}">
                <div class="flex justify-between items-start">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center">
                            <h4 class="text-[13px] font-medium text-white truncate">${this.escapeHtml(ch.name)}</h4>
                            ${typeBadge}
                        </div>
                        <p class="text-[10px] text-[#555] truncate font-mono mt-0.5">${ch.streamId}</p>
                        ${ch.members ? `<p class="text-[10px] text-[#666] mt-1">${ch.members} members</p>` : ''}
                    </div>
                    <button class="ml-2 px-2.5 py-1 bg-white hover:bg-[#f0f0f0] text-black rounded text-[11px] font-medium transition join-public-btn">
                        Join
                    </button>
                </div>
            </div>
            `;
        }).join('');

        // Add click listeners
        this.elements.browseChannelsList.querySelectorAll('.join-public-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const item = btn.closest('.browse-channel-item');
                const streamId = item?.dataset.streamId;
                if (streamId) {
                    await this.joinPublicChannel(streamId);
                }
            });
        });
    }

    /**
     * Filter browse channels by search and type
     */
    filterBrowseChannels(query) {
        if (!this.cachedPublicChannels) return;
        
        let filtered = this.cachedPublicChannels;
        
        // Apply type filter
        if (this.browseTypeFilter && this.browseTypeFilter !== 'all') {
            filtered = filtered.filter(ch => ch.type === this.browseTypeFilter);
        }
        
        // Apply search filter
        if (query) {
            filtered = filtered.filter(ch => 
                ch.name.toLowerCase().includes(query.toLowerCase()) ||
                ch.streamId.toLowerCase().includes(query.toLowerCase())
            );
        }
        
        this.renderPublicChannelsList(filtered);
    }

    /**
     * Update browse filter tabs UI
     */
    updateBrowseFilterTabs() {
        document.querySelectorAll('.browse-filter-tab').forEach(tab => {
            const isActive = tab.dataset.browseFilter === this.browseTypeFilter;
            if (isActive) {
                tab.classList.add('bg-white', 'text-black', 'font-medium');
                tab.classList.remove('text-[#888]', 'hover:text-white', 'hover:bg-[#252525]');
            } else {
                tab.classList.remove('bg-white', 'text-black', 'font-medium');
                tab.classList.add('text-[#888]', 'hover:text-white', 'hover:bg-[#252525]');
            }
        });
    }

    /**
     * Join a public channel from browse
     */
    async joinPublicChannel(streamId) {
        try {
            // Find channel info from cache
            const channelInfo = this.cachedPublicChannels?.find(ch => ch.streamId === streamId);
            
            // If password-protected, ask for password
            if (channelInfo?.type === 'password') {
                const password = await this.showPasswordInputModal('Join Password Channel', 
                    `Enter password for "${channelInfo.name}":`);
                
                if (!password) {
                    return; // User cancelled
                }
                
                this.showLoading('Joining channel...');
                await channelManager.joinChannel(streamId, password, {
                    name: channelInfo?.name,
                    type: 'password'
                });
            } else {
                this.showLoading('Joining channel...');
                await channelManager.joinChannel(streamId, null, {
                    name: channelInfo?.name,
                    type: channelInfo?.type || 'public'
                });
            }
            
            this.hideLoading();
            this.hideBrowseChannelsModal();
            this.renderChannelList();
            this.showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to join: ' + error.message, 'error');
        }
    }

    /**
     * Show password input modal for joining password-protected channels
     */
    showPasswordInputModal(title, message) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[60]';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl p-5 w-[340px] max-w-full mx-4 border border-[#222]">
                    <h3 class="text-[15px] font-medium mb-2 text-white">${title}</h3>
                    <p class="text-[12px] text-[#888] mb-4">${message}</p>
                    <input type="password" id="browse-password-input" placeholder="Password" 
                        class="w-full bg-[#1a1a1a] border border-[#282828] text-white px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:border-[#444] transition mb-4"
                        autocomplete="off">
                    <div class="flex gap-2">
                        <button id="cancel-pw-btn" class="flex-1 bg-[#1a1a1a] hover:bg-[#252525] border border-[#282828] text-[#888] text-[13px] font-medium py-2.5 rounded-lg transition">
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
     */
    async generateQRCode(inviteLink) {
        try {
            // QRCode is bundled in vendor.bundle.js
            if (!window.QRCode) {
                throw new Error('QRCode library not loaded');
            }

            // Show in modal
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl p-5 border border-[#222]">
                    <h3 class="text-[15px] font-medium mb-4 text-white">Invite QR Code</h3>
                    <div id="qr-container" class="bg-white p-3 rounded-lg flex items-center justify-center"></div>
                    <button class="mt-4 w-full bg-[#1a1a1a] hover:bg-[#252525] border border-[#282828] text-[#888] text-[13px] font-medium px-4 py-2.5 rounded-lg transition">Close</button>
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
            this.showNotification('Failed to generate QR code', 'error');
        }
    }

    /**
     * Show loading indicator with spinner overlay
     * @param {string} message - Loading message
     */
    showLoading(message) {
        const overlay = document.getElementById('loading-overlay');
        const textEl = document.getElementById('loading-text');
        if (overlay && textEl) {
            textEl.textContent = message || 'Loading...';
            overlay.classList.add('active');
        }
    }

    /**
     * Hide loading indicator
     */
    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    /**
     * Show add contact modal
     * @param {string} address - Contact address to add
     */
    showAddContactModal(address) {
        const modal = document.getElementById('add-contact-nickname-modal');
        const addressDisplay = document.getElementById('add-contact-modal-address');
        const nicknameInput = document.getElementById('add-contact-modal-nickname');
        
        if (!modal || !addressDisplay || !nicknameInput) return;
        
        // Store the address for later use
        this._pendingContactAddress = address;
        
        // Set the address display
        addressDisplay.textContent = address;
        nicknameInput.value = '';
        
        // Show modal
        modal.classList.remove('hidden');
        nicknameInput.focus();
    }

    /**
     * Hide add contact modal
     */
    hideAddContactModal() {
        const modal = document.getElementById('add-contact-nickname-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
        this._pendingContactAddress = null;
    }

    /**
     * Confirm adding contact from modal
     */
    async confirmAddContact() {
        const nicknameInput = document.getElementById('add-contact-modal-nickname');
        const nickname = nicknameInput?.value?.trim() || null;
        const address = this._pendingContactAddress;
        
        if (!address) return;
        
        await identityManager.addTrustedContact(address, nickname);
        this.showNotification('Contact added!', 'success');
        this.hideAddContactModal();
    }

    /**
     * Show remove contact confirmation modal
     * @param {string} address - Contact address to remove
     * @param {Function} onRemoveCallback - Optional callback after removal
     */
    showRemoveContactModal(address, onRemoveCallback = null) {
        const modal = document.getElementById('remove-contact-modal');
        const addressDisplay = document.getElementById('remove-contact-modal-address');
        
        if (!modal || !addressDisplay) return;
        
        // Store the address and callback for later use
        this._pendingRemoveContactAddress = address;
        this._onRemoveContactCallback = onRemoveCallback;
        
        // Set the address display
        addressDisplay.textContent = address;
        
        // Show modal
        modal.classList.remove('hidden');
    }

    /**
     * Hide remove contact modal
     */
    hideRemoveContactModal() {
        const modal = document.getElementById('remove-contact-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
        this._pendingRemoveContactAddress = null;
        this._onRemoveContactCallback = null;
    }

    /**
     * Confirm removing contact from modal
     */
    async confirmRemoveContact() {
        const address = this._pendingRemoveContactAddress;
        const callback = this._onRemoveContactCallback;
        
        if (!address) return;
        
        await identityManager.removeTrustedContact(address);
        this.showNotification('Contact removed', 'info');
        this.hideRemoveContactModal();
        
        if (callback) {
            callback();
        }
    }

    /**
     * Show toast notification
     * @param {string} message - Notification message
     * @param {string} type - Notification type (success, error, info, warning)
     * @param {number} duration - Duration in ms (default 3000)
     */
    showNotification(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        if (!container) {
            Logger.debug(`[${type}] ${message}`);
            return;
        }

        const icons = {
            success: '✓',
            error: '✕',
            info: 'ℹ',
            warning: '⚠'
        };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span>${icons[type] || ''}</span><span>${this.escapeHtml(message)}</span>`;
        
        container.appendChild(toast);

        // Auto remove after duration
        setTimeout(() => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    /**
     * Get channel type label with icon
     * @param {string} type - Channel type
     * @returns {string} - HTML with icon and label
     */
    getChannelTypeLabel(type) {
        const labels = {
            'public': '<span class="inline-flex items-center gap-1 text-[#666]"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>Public</span>',
            'password': '<span class="inline-flex items-center gap-1 text-[#666]"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>Password</span>',
            'native': '<span class="inline-flex items-center gap-1 text-[#666]"><svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5l-8 13.5 8 4.5 8-4.5-8-13.5zm0 18l-8-4.5 8 9 8-9-8 4.5z"/></svg>Verified Membership</span>'
        };
        return labels[type] || type;
    }

    /**
     * Format Ethereum address
     * @param {string} address - Full address
     * @returns {string} - Shortened address
     */
    formatAddress(address) {
        if (!address) return 'Unknown';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} text - Text to escape
     * @returns {string} - Escaped text
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Show invite modal
     */
    showInviteModal() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.showNotification('Please select a channel first', 'warning');
            return;
        }

        // Generate invite link
        const inviteLink = channelManager.generateInviteLink(currentChannel.streamId);
        this.elements.inviteLinkDisplay.value = inviteLink;

        // Clear address input
        this.elements.inviteAddressInput.value = '';

        // Reset to link tab
        this.switchInviteTab('link');

        // Show modal
        this.elements.inviteUsersModal.classList.remove('hidden');
    }

    /**
     * Hide invite modal
     */
    hideInviteModal() {
        this.elements.inviteUsersModal.classList.add('hidden');
    }

    /**
     * Switch invite modal tab
     * @param {string} tabType - Tab type (link or address)
     */
    switchInviteTab(tabType) {
        // Update tab buttons
        document.querySelectorAll('.invite-tab').forEach(tab => {
            if (tab.dataset.inviteTab === tabType) {
                tab.classList.add('bg-white', 'text-black', 'font-medium');
                tab.classList.remove('text-[#888]', 'hover:text-white', 'hover:bg-[#252525]');
            } else {
                tab.classList.remove('bg-white', 'text-black', 'font-medium');
                tab.classList.add('text-[#888]', 'hover:text-white', 'hover:bg-[#252525]');
            }
        });

        // Show/hide content panels
        document.querySelectorAll('.invite-tab-content').forEach(panel => {
            panel.classList.add('hidden');
        });

        const targetPanel = document.getElementById(`invite-tab-${tabType}`);
        if (targetPanel) {
            targetPanel.classList.remove('hidden');
        }
    }

    /**
     * Handle send invite
     */
    async handleSendInvite() {
        const address = this.elements.inviteAddressInput.value.trim();
        if (!address) {
            this.showNotification('Please enter a user address', 'warning');
            return;
        }

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.showNotification('No channel selected', 'error');
            return;
        }

        try {
            // Import notificationManager
            const { notificationManager } = await import('./notifications.js');

            this.showLoading('Sending invite...');
            await notificationManager.sendChannelInvite(address, currentChannel);
            this.hideLoading();
            this.hideInviteModal();
            this.showNotification('Invite sent successfully!', 'success');
        } catch (error) {
            this.hideLoading();
            
            // Check for STREAM_NOT_FOUND error - user doesn't have notifications enabled
            if (error.message?.includes('STREAM_NOT_FOUND') || error.message?.includes('Stream not found')) {
                this.showNotification('User does not have notifications enabled', 'error', 5000);
            } else {
                this.showNotification('Failed to send invite', 'error');
            }
        }
    }

    /**
     * Copy invite link
     */
    copyInviteLink() {
        this.elements.inviteLinkDisplay.select();
        document.execCommand('copy');
        this.showNotification('Link copied to clipboard!', 'success');
    }

    /**
     * Show invite QR code
     */
    showInviteQR() {
        const inviteLink = this.elements.inviteLinkDisplay.value;
        this.generateQRCode(inviteLink);
    }

    // ==================== CHANNEL SETTINGS ====================

    /**
     * Show channel settings modal
     */
    async showChannelSettingsModal() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.showNotification('No channel selected', 'error');
            return;
        }

        // Update channel info
        this.elements.channelSettingsName.textContent = currentChannel.name;
        this.elements.channelSettingsType.innerHTML = this.getChannelTypeLabel(currentChannel.type);
        this.elements.channelSettingsId.textContent = currentChannel.streamId;

        // Determine channel type and ownership
        const isNative = currentChannel.type === 'native';
        const isOwner = channelManager.isChannelOwner(currentChannel.streamId);
        
        // Check if user can add members (owner OR has GRANT permission)
        const canAddMembers = isNative ? await channelManager.canAddMembers(currentChannel.streamId) : false;

        // Show/hide non-native message in Info panel
        this.elements.nonNativeMessage.classList.toggle('hidden', isNative);

        // Show/hide members tab button for native channels only
        const membersTabBtn = document.querySelector('[data-channel-tab="members"]');
        membersTabBtn?.classList.toggle('hidden', !isNative);

        // Show/hide members-related elements based on permission to add members
        this.elements.addMemberForm?.classList.toggle('hidden', !canAddMembers);
        this.elements.permissionsSection?.classList.toggle('hidden', !isOwner || !isNative);

        // Show/hide danger tab for owner only
        this.elements.dangerTabDivider?.classList.toggle('hidden', !isOwner);
        this.elements.dangerTabBtn?.classList.toggle('hidden', !isOwner);

        // Clear members list for non-native channels (prevents stale data)
        if (!isNative && this.elements.membersList) {
            this.elements.membersList.innerHTML = '';
        }

        // Initialize channel settings tabs
        this.initChannelSettingsTabs();

        // Select appropriate starting tab (always info for non-native since members tab is hidden)
        this.selectChannelSettingsTab('info');

        // Show modal
        this.elements.channelSettingsModal.classList.remove('hidden');

        // Load members and permissions if native channel
        if (isNative) {
            await this.loadChannelMembers();
            if (isOwner) {
                this.loadStreamPermissions();
            }
        }
    }

    /**
     * Initialize channel settings tabs navigation
     */
    initChannelSettingsTabs() {
        if (this.elements.channelSettingsTabs) {
            this.elements.channelSettingsTabs.forEach(tab => {
                // Remove old listeners by cloning
                const newTab = tab.cloneNode(true);
                tab.parentNode.replaceChild(newTab, tab);
                
                newTab.addEventListener('click', () => {
                    const tabName = newTab.dataset.channelTab;
                    this.selectChannelSettingsTab(tabName);
                });
            });
            // Re-cache tabs after cloning
            this.elements.channelSettingsTabs = document.querySelectorAll('.channel-settings-tab');
        }
    }

    /**
     * Select a channel settings tab
     */
    selectChannelSettingsTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.channel-settings-tab').forEach(tab => {
            const isActive = tab.dataset.channelTab === tabName;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('text-white/60', !isActive && tab.dataset.channelTab !== 'danger');
        });

        // Update panels
        document.querySelectorAll('.channel-settings-panel').forEach(panel => {
            const panelName = panel.id.replace('channel-panel-', '');
            panel.classList.toggle('hidden', panelName !== tabName);
        });
    }

    /**
     * Hide channel settings modal
     */
    hideChannelSettingsModal() {
        this.elements.channelSettingsModal.classList.add('hidden');;
        this.elements.addMemberInput.value = '';
    }

    /**
     * Show delete channel confirmation modal
     */
    showDeleteChannelModal() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        this.elements.deleteChannelName.textContent = currentChannel.name;
        this.elements.deleteChannelModal.classList.remove('hidden');
    }

    /**
     * Hide delete channel confirmation modal
     */
    hideDeleteChannelModal() {
        this.elements.deleteChannelModal.classList.add('hidden');
    }

    /**
     * Handle delete channel confirmation
     */
    async handleDeleteChannel() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        const channelName = currentChannel.name;
        const streamId = currentChannel.streamId;

        try {
            this.showLoading('Deleting channel...');
            this.hideDeleteChannelModal();
            this.hideChannelSettingsModal();

            await channelManager.deleteChannel(streamId);

            this.hideLoading();
            this.showNotification(`Channel "${channelName}" deleted successfully`, 'success');

            // Update UI - select first remaining channel or show empty state
            const channels = channelManager.getAllChannels();
            if (channels.length > 0) {
                this.renderChannelList();
                await this.selectChannel(channels[0].streamId);
            } else {
                this.renderChannelList();
                this.elements.messagesArea.innerHTML = '<div class="text-center text-gray-500 py-8">No channels. Create one to start chatting!</div>';
                this.elements.channelNameDisplay.textContent = 'No channel selected';
            }
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to delete channel: ' + error.message, 'error');
        }
    }

    /**
     * Show leave channel confirmation modal
     */
    showLeaveChannelModal() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;
        
        // Close any existing modal
        this.hideLeaveChannelModal();
        
        const modal = document.createElement('div');
        modal.id = 'leave-channel-modal';
        modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60]';
        modal.innerHTML = `
            <div class="bg-[#141414] rounded-2xl w-[380px] max-w-[95vw] mx-4 shadow-2xl border border-white/5 overflow-hidden">
                <div class="p-6">
                    <div class="flex items-center gap-3 mb-4">
                        <div class="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-lg">🚪</div>
                        <h3 class="text-lg font-medium text-white/90">Leave Channel</h3>
                    </div>
                    <p class="text-sm text-white/50 mb-4">
                        Are you sure you want to leave <span class="text-white/80 font-medium">"${currentChannel.name}"</span>?
                    </p>
                    <p class="text-xs text-white/30 bg-white/5 rounded-lg px-3 py-2">
                        You can rejoin later if you have the invite link.
                    </p>
                </div>
                <div class="flex border-t border-white/5">
                    <button id="cancel-leave-btn" class="flex-1 px-4 py-3 text-sm text-white/60 hover:text-white hover:bg-white/5 transition">
                        Cancel
                    </button>
                    <button id="confirm-leave-btn" class="flex-1 px-4 py-3 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 border-l border-white/5 transition">
                        Leave
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Attach listeners
        modal.querySelector('#cancel-leave-btn').addEventListener('click', () => this.hideLeaveChannelModal());
        modal.querySelector('#confirm-leave-btn').addEventListener('click', () => this.confirmLeaveChannel());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideLeaveChannelModal();
        });
    }
    
    /**
     * Hide leave channel modal
     */
    hideLeaveChannelModal() {
        const modal = document.getElementById('leave-channel-modal');
        if (modal) modal.remove();
    }
    
    /**
     * Confirm and execute leave channel
     */
    async confirmLeaveChannel() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;
        
        const channelName = currentChannel.name;
        const streamId = currentChannel.streamId;
        
        this.hideLeaveChannelModal();
        this.hideChannelSettingsModal();
        
        try {
            await channelManager.leaveChannel(streamId);
            this.showNotification(`Left "${channelName}"`, 'info');
            
            // Update UI - select first remaining channel or show empty state
            const channels = channelManager.getAllChannels();
            if (channels.length > 0) {
                this.renderChannelList();
                await this.selectChannel(channels[0].streamId);
            } else {
                this.renderChannelList();
                this.elements.messagesArea.innerHTML = '<div class="text-center text-gray-500 py-8">No channels. Create one to start chatting!</div>';
                this.elements.channelNameDisplay.textContent = 'No channel selected';
            }
        } catch (error) {
            this.showNotification('Failed to leave channel: ' + error.message, 'error');
        }
    }
    
    /**
     * Handle leave channel (legacy - now uses modal)
     */
    async handleLeaveChannel() {
        this.showLeaveChannelModal();
    }

    /**
     * Load channel members
     */
    async loadChannelMembers() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel || currentChannel.type !== 'native') {
            return;
        }

        this.elements.membersList.innerHTML = '<div class="text-center text-white/30 py-4 text-sm">Loading...</div>';

        try {
            const members = await channelManager.getChannelMembers(currentChannel.streamId);
            this.renderMembersList(members, currentChannel);
        } catch (error) {
            this.elements.membersList.innerHTML = `<div class="text-center text-red-400/80 py-4 text-sm">Failed to load: ${error.message}</div>`;
        }
    }

    /**
     * Render members list with permissions
     */
    renderMembersList(members, channel) {
        if (!members || members.length === 0) {
            this.elements.membersList.innerHTML = '<div class="text-center text-white/30 py-4 text-sm">No members found</div>';
            return;
        }

        const currentAddress = authManager.getAddress()?.toLowerCase();
        const creatorAddress = channel.createdBy?.toLowerCase();
        const isOwner = channelManager.isChannelOwner(channel.streamId);
        
        // Find if current user has admin (canGrant) permission
        const currentUserMember = members.find(m => (typeof m === 'string' ? m : m.address)?.toLowerCase() === currentAddress);
        const currentUserCanGrant = typeof currentUserMember === 'object' ? currentUserMember.canGrant : false;

        this.elements.membersList.innerHTML = members.map(member => {
            // Handle both old format (string) and new format (object)
            const address = typeof member === 'string' ? member : member.address;
            const canGrant = typeof member === 'object' ? member.canGrant : false;
            const memberIsOwner = typeof member === 'object' ? member.isOwner : false;
            
            const normalizedAddr = address.toLowerCase();
            const isCreator = normalizedAddr === creatorAddress;
            const isMe = normalizedAddr === currentAddress;
            const shortAddr = `${address.slice(0, 8)}...${address.slice(-6)}`;
            
            let badgeHtml = '';
            if (isCreator || memberIsOwner) {
                badgeHtml += '<span class="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">Owner</span>';
            } else if (canGrant) {
                badgeHtml += '<span class="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full">Admin</span>';
            }
            if (isMe) {
                badgeHtml += '<span class="text-xs text-white/60 ml-1">(you)</span>';
            }

            // Owner can manage anyone except self
            // Admin (canGrant) can manage regular members only (not owner/creator, not other admins)
            const memberIsAdmin = !memberIsOwner && !isCreator && canGrant;
            const canManage = !isMe && (isOwner || (currentUserCanGrant && !memberIsOwner && !isCreator && !memberIsAdmin));
            const menuBtn = canManage 
                ? `<button class="member-menu-btn text-white/30 hover:text-white/60 p-1.5 rounded-lg hover:bg-white/5 transition" 
                          data-address="${address}" data-can-grant="${canGrant}" data-current-is-owner="${isOwner}" title="Manage member">
                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
                    </svg>
                   </button>`
                : '';

            return `
                <div class="flex items-center justify-between p-2.5 bg-white/5 rounded-xl border border-white/5 hover:border-white/10 transition group">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                        <div class="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs text-white/60 font-mono">
                            ${address.slice(2, 4)}
                        </div>
                        <div class="flex flex-col min-w-0">
                            <span class="font-mono text-xs text-white/70 truncate">${shortAddr}</span>
                            <div class="flex items-center gap-1 mt-0.5">${badgeHtml}</div>
                        </div>
                    </div>
                    ${menuBtn}
                </div>
            `;
        }).join('');

        // Add event listeners for member menu buttons
        this.elements.membersList.querySelectorAll('.member-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const currentUserIsOwner = btn.dataset.currentIsOwner === 'true';
                this.showMemberDropdown(btn, btn.dataset.address, btn.dataset.canGrant === 'true', currentUserIsOwner);
            });
        });
    }

    /**
     * Show member dropdown menu
     * @param {boolean} currentUserIsOwner - Whether the current user is the channel owner
     */
    showMemberDropdown(targetBtn, address, canGrant, currentUserIsOwner = false) {
        // Close any existing dropdown
        this.closeMemberDropdown();

        const shortAddr = `${address.slice(0, 8)}...${address.slice(-6)}`;
        
        // Only owner can toggle admin permissions
        const toggleGrantBtn = currentUserIsOwner ? `
            <button class="member-action w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm transition flex items-center justify-between" data-action="toggle-grant">
                <span class="flex items-center gap-2 ${canGrant ? 'text-purple-400' : 'text-white/70'}">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>
                    <span>Can add members</span>
                </span>
                <span class="text-xs ${canGrant ? 'text-purple-400' : 'text-white/30'}">${canGrant ? 'ON' : 'OFF'}</span>
            </button>
            <div class="my-1 border-t border-white/5"></div>
        ` : '';
        
        const dropdown = document.createElement('div');
        dropdown.id = 'member-dropdown-menu';
        dropdown.className = 'fixed bg-[#141414] border border-white/10 rounded-xl shadow-2xl py-1 z-[9999] min-w-[200px] overflow-hidden';
        dropdown.innerHTML = `
            <div class="px-3 py-2 border-b border-white/5">
                <div class="text-xs text-white/40">Member</div>
                <div class="text-sm text-white/80 font-mono">${shortAddr}</div>
            </div>
            ${toggleGrantBtn}
            <button class="member-action w-full text-left px-4 py-2.5 hover:bg-red-500/10 text-sm text-white/50 hover:text-red-400 transition flex items-center gap-2" data-action="remove">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
                <span>Remove from channel</span>
            </button>
        `;

        document.body.appendChild(dropdown);

        // Position dropdown near the button
        const btnRect = targetBtn.getBoundingClientRect();
        let left = btnRect.right - dropdown.offsetWidth;
        let top = btnRect.bottom + 4;

        // Keep within viewport
        if (left < 8) left = 8;
        if (top + dropdown.offsetHeight > window.innerHeight - 8) {
            top = btnRect.top - dropdown.offsetHeight - 4;
        }

        dropdown.style.left = `${left}px`;
        dropdown.style.top = `${top}px`;

        // Attach action listeners
        dropdown.querySelectorAll('.member-action').forEach(actionBtn => {
            actionBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = actionBtn.dataset.action;
                this.closeMemberDropdown();
                await this.handleMemberAction(action, address, canGrant);
            });
        });

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', this.closeMemberDropdown.bind(this), { once: true });
        }, 0);
    }

    /**
     * Close member dropdown
     */
    closeMemberDropdown() {
        const existing = document.getElementById('member-dropdown-menu');
        if (existing) existing.remove();
    }

    /**
     * Handle member action from dropdown
     */
    async handleMemberAction(action, address, currentCanGrant) {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        switch (action) {
            case 'toggle-grant':
                const newCanGrant = !currentCanGrant;
                try {
                    this.showLoading(newCanGrant ? 'Granting admin permission...' : 'Revoking admin permission...');
                    await channelManager.updateMemberPermissions(currentChannel.streamId, address, { canGrant: newCanGrant });
                    this.hideLoading();
                    this.showNotification(
                        newCanGrant ? 'Member can now add others!' : 'Admin permission removed',
                        'success'
                    );
                    // Refresh members list
                    await this.loadChannelMembers();
                } catch (error) {
                    this.hideLoading();
                    this.showNotification('Failed to update permission: ' + error.message, 'error');
                }
                break;

            case 'remove':
                this.showRemoveMemberModal(address);
                break;
        }
    }

    /**
     * Handle add member
     */
    async handleAddMember() {
        const address = this.elements.addMemberInput.value.trim();
        if (!address) {
            this.showNotification('Please enter an address', 'error');
            return;
        }

        if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
            this.showNotification('Invalid Ethereum address', 'error');
            return;
        }

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            this.showLoading('Adding member (on-chain transaction)...');
            await channelManager.addMember(currentChannel.streamId, address);
            this.hideLoading();
            this.elements.addMemberInput.value = '';
            this.showNotification('Member added successfully!', 'success');
            await this.loadChannelMembers();
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to add member: ' + error.message, 'error');
        }
    }

    /**
     * Handle batch add members
     */
    async handleBatchAddMembers() {
        const input = this.elements.batchMembersInput?.value || '';
        const lines = input.split('\n').map(l => l.trim()).filter(l => l);
        
        if (lines.length === 0) {
            this.showNotification('Please enter at least one address', 'error');
            return;
        }

        // Validate all addresses
        const validAddresses = [];
        const invalidAddresses = [];
        
        for (const line of lines) {
            if (line.match(/^0x[a-fA-F0-9]{40}$/)) {
                validAddresses.push(line);
            } else {
                invalidAddresses.push(line);
            }
        }

        if (invalidAddresses.length > 0) {
            this.showNotification(`${invalidAddresses.length} invalid address(es) found`, 'error');
            return;
        }

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            this.showLoading(`Adding ${validAddresses.length} members (on-chain transactions)...`);
            
            let added = 0;
            let failed = 0;
            
            for (const address of validAddresses) {
                try {
                    await channelManager.addMember(currentChannel.streamId, address);
                    added++;
                } catch (e) {
                    Logger.error('Failed to add:', address, e);
                    failed++;
                }
            }
            
            this.hideLoading();
            this.elements.batchMembersInput.value = '';
            
            if (failed > 0) {
                this.showNotification(`Added ${added} members, ${failed} failed`, 'warning');
            } else {
                this.showNotification(`${added} members added successfully!`, 'success');
            }
            
            await this.loadChannelMembers();
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to add members: ' + error.message, 'error');
        }
    }

    /**
     * Show remove member confirmation modal
     */
    showRemoveMemberModal(address) {
        const shortAddr = `${address.slice(0, 8)}...${address.slice(-6)}`;
        
        // Close any existing modal
        this.hideRemoveMemberModal();
        
        const modal = document.createElement('div');
        modal.id = 'remove-member-modal';
        modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[70]';
        modal.innerHTML = `
            <div class="bg-[#141414] rounded-2xl w-[380px] max-w-[95vw] mx-4 shadow-2xl border border-white/5 overflow-hidden">
                <div class="p-6">
                    <div class="flex items-center gap-3 mb-4">
                        <div class="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center text-lg">👤</div>
                        <h3 class="text-lg font-medium text-white/90">Remove Member</h3>
                    </div>
                    <p class="text-sm text-white/50 mb-2">
                        Remove <span class="text-white/80 font-mono">${shortAddr}</span> from this channel?
                    </p>
                    <p class="text-xs text-white/30 bg-white/5 rounded-lg px-3 py-2">
                        This will revoke their access via an on-chain transaction.
                    </p>
                </div>
                <div class="flex border-t border-white/5">
                    <button id="cancel-remove-member-btn" class="flex-1 px-4 py-3 text-sm text-white/60 hover:text-white hover:bg-white/5 transition">
                        Cancel
                    </button>
                    <button id="confirm-remove-member-btn" class="flex-1 px-4 py-3 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 border-l border-white/5 transition" data-address="${address}">
                        Remove
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Attach listeners
        modal.querySelector('#cancel-remove-member-btn').addEventListener('click', () => this.hideRemoveMemberModal());
        modal.querySelector('#confirm-remove-member-btn').addEventListener('click', (e) => {
            const addr = e.currentTarget.dataset.address;
            this.hideRemoveMemberModal();
            this.executeRemoveMember(addr);
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideRemoveMemberModal();
        });
    }

    /**
     * Hide remove member modal
     */
    hideRemoveMemberModal() {
        const modal = document.getElementById('remove-member-modal');
        if (modal) modal.remove();
    }

    /**
     * Execute remove member
     */
    async executeRemoveMember(address) {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            this.showLoading('Removing member (on-chain transaction)...');
            await channelManager.removeMember(currentChannel.streamId, address);
            this.hideLoading();
            this.showNotification('Member removed successfully!', 'success');
            await this.loadChannelMembers();
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to remove member: ' + error.message, 'error');
        }
    }

    /**
     * Handle remove member (legacy - now uses modal)
     */
    async handleRemoveMember(address) {
        this.showRemoveMemberModal(address);
    }

    /**
     * Load and display stream permissions
     */
    async loadStreamPermissions() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel || currentChannel.type !== 'native') {
            return;
        }

        if (!this.elements.permissionsList) return;
        
        this.elements.permissionsList.innerHTML = '<div class="text-white/30">Loading...</div>';

        try {
            // Use The Graph API for permissions (same source as members list)
            const { graphAPI } = await import('./graph.js');
            let permissions = [];
            
            try {
                permissions = await graphAPI.getStreamPermissions(currentChannel.streamId);
            } catch (e) {
                Logger.debug('Could not fetch permissions from The Graph:', e.message);
            }
            
            // If no permissions from API, show local members
            if (permissions.length === 0) {
                const localMembers = currentChannel.members || [];
                const owner = currentChannel.createdBy;
                
                let html = '';
                
                // Show owner
                if (owner) {
                    const shortOwner = `${owner.slice(0, 8)}...${owner.slice(-4)}`;
                    html += `<div class="flex justify-between items-center py-1.5 px-2.5 bg-white/5 rounded-lg">
                        <span class="font-mono text-white/60">${shortOwner}</span>
                        <span class="text-xs text-yellow-400/80">Owner</span>
                    </div>`;
                }
                
                // Show local members
                for (const member of localMembers) {
                    const shortMember = `${member.slice(0, 8)}...${member.slice(-4)}`;
                    html += `<div class="flex justify-between items-center py-1.5 px-2.5 bg-white/5 rounded-lg">
                        <span class="font-mono text-white/60">${shortMember}</span>
                        <span class="text-white/40 flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg></span>
                    </div>`;
                }
                
                if (!html) {
                    html = '<div class="text-white/30">Owner only (private)</div>';
                }
                
                const note = `<div class="text-white/20 mt-2 pt-2 border-t border-white/5 text-[10px] flex items-center gap-1">
                    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/></svg>
                    Showing local cache. Check Stream Explorer for on-chain permissions.
                </div>`;
                
                this.elements.permissionsList.innerHTML = html + note;
                return;
            }

            const ownerAddress = currentChannel.createdBy?.toLowerCase();

            // Format permissions for display (The Graph format)
            // Uses: userAddress, canGrant, canEdit, canDelete, publishExpiration, subscribeExpiration
            const now = Math.floor(Date.now() / 1000);
            
            const formatted = permissions
                .map(perm => {
                let who;
                let isOwner = false;
                
                // The Graph uses userAddress (null for public)
                const userAddr = perm.userAddress;
                
                if (!userAddr || userAddr === '0x0000000000000000000000000000000000000000') {
                    who = '<span class="text-yellow-400/80 inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3"/></svg>PUBLIC</span>';
                } else {
                    const short = `${userAddr.slice(0, 8)}...${userAddr.slice(-4)}`;
                    isOwner = ownerAddress && userAddr.toLowerCase() === ownerAddress;
                    who = `<span class="font-mono text-white/60">${short}${isOwner ? ' <span class="text-yellow-400/80"><svg class="w-3 h-3 inline" fill="currentColor" viewBox="0 0 24 24"><path d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z"/></svg></span>' : ''}</span>`;
                }
                
                // Build permissions array from The Graph fields
                const permList = [];
                
                // Check subscribe permission
                const canSubscribe = perm.subscribeExpiration === null || 
                    parseInt(perm.subscribeExpiration) > now;
                if (canSubscribe) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>');
                
                // Check publish permission
                const canPublish = perm.publishExpiration === null || 
                    parseInt(perm.publishExpiration) > now;
                if (canPublish) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>');
                
                // Check edit, delete, grant
                if (perm.canEdit) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>');
                if (perm.canDelete) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>');
                if (perm.canGrant) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>');
                
                const permsStr = permList.join(' ');
                
                return `<div class="flex justify-between items-center py-1.5 px-2.5 bg-white/5 rounded-lg">
                    <span>${who}</span>
                    <span class="text-white/40">${permsStr}</span>
                </div>`;
            }).join('');
            
            // Add legend
            const legend = `<div class="text-white/20 mt-2 pt-2 border-t border-white/5 text-[10px] flex items-center gap-2 flex-wrap">
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>sub</span>
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>pub</span>
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>edit</span>
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>del</span>
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>grant</span>
            </div>`;
            
            this.elements.permissionsList.innerHTML = formatted + legend;
            
        } catch (error) {
            this.elements.permissionsList.innerHTML = `<div class="text-red-400/80 text-sm">Error: ${error.message}</div>`;
        }
    }

    // ==================== SETTINGS ====================

    /**
     * Initialize settings UI elements and listeners
     */
    initSettingsUI() {
        // Cache elements
        this.elements.settingsBtn = document.getElementById('settings-btn');
        this.elements.settingsModal = document.getElementById('settings-modal');
        this.elements.closeSettingsBtn = document.getElementById('close-settings-btn');
        this.elements.notificationsEnabled = document.getElementById('notifications-enabled');
        this.elements.notificationsStatus = document.getElementById('notifications-status');
        this.elements.settingsUsername = document.getElementById('settings-username');
        this.elements.settingsAddress = document.getElementById('settings-address');
        this.elements.copyOwnAddressBtn = document.getElementById('copy-own-address-btn');
        this.elements.settingsGraphApiKey = document.getElementById('settings-graph-api-key');
        this.elements.graphApiStatus = document.getElementById('graph-api-status');

        // Cache tab elements
        this.elements.settingsTabs = document.querySelectorAll('.settings-tab');
        this.elements.settingsPanels = document.querySelectorAll('.settings-panel');

        // Initialize tabs navigation
        this.initSettingsTabs();

        // Open settings modal
        if (this.elements.settingsBtn) {
            this.elements.settingsBtn.addEventListener('click', () => this.showSettingsModal());
        }

        // Close settings modal
        if (this.elements.closeSettingsBtn) {
            this.elements.closeSettingsBtn.addEventListener('click', () => this.hideSettingsModal());
        }

        // Notifications toggle
        if (this.elements.notificationsEnabled) {
            this.elements.notificationsEnabled.addEventListener('change', (e) => this.handleNotificationsToggle(e));
        }

        // Username change
        if (this.elements.settingsUsername) {
            this.elements.settingsUsername.addEventListener('change', async (e) => {
                await identityManager.setUsername(e.target.value);
                this.showNotification('Username updated!', 'success');
            });
        }

        // Copy address from settings
        if (this.elements.copyOwnAddressBtn) {
            this.elements.copyOwnAddressBtn.addEventListener('click', () => this.copyOwnAddress());
        }

        // Graph API key change
        if (this.elements.settingsGraphApiKey) {
            this.elements.settingsGraphApiKey.addEventListener('change', async (e) => {
                const newKey = e.target.value.trim();
                await graphAPI.setApiKey(newKey || null);
                await this.updateGraphApiStatus();
                this.showNotification('Graph API key updated!', 'success');
            });
        }

        // Click on wallet-info to copy address
        if (this.elements.walletInfo) {
            this.elements.walletInfo.addEventListener('click', () => this.copyOwnAddress());
        }

        // Initialize export private key functionality
        this.initExportPrivateKeyUI();

        // Initialize backup/restore functionality
        this.initBackupRestoreUI();
    }

    /**
     * Initialize export private key UI handlers
     */
    initExportPrivateKeyUI() {
        const exportKeyPassword = document.getElementById('export-key-password');
        const unlockBtn = document.getElementById('unlock-private-key-btn');
        const step1 = document.getElementById('export-key-step1');
        const step2 = document.getElementById('export-key-step2');
        const privateKeyDisplay = document.getElementById('private-key-display');
        const toggleVisibilityBtn = document.getElementById('toggle-key-visibility');
        const copyKeyBtn = document.getElementById('copy-private-key-btn');
        const copyKeyProgress = document.getElementById('copy-key-progress');
        const copyKeyText = document.getElementById('copy-key-text');
        const lockBtn = document.getElementById('lock-private-key-btn');

        let unlockedPrivateKey = null;
        let holdTimer = null;
        let isKeyVisible = false;

        // Unlock private key
        if (unlockBtn) {
            unlockBtn.addEventListener('click', async () => {
                const password = exportKeyPassword?.value;
                if (!password) {
                    this.showNotification('Please enter your password', 'error');
                    return;
                }

                try {
                    unlockBtn.disabled = true;
                    unlockBtn.textContent = '🔄 Verifying...';
                    
                    unlockedPrivateKey = await authManager.getPrivateKey(password);
                    
                    // Show step 2
                    step1?.classList.add('hidden');
                    step2?.classList.remove('hidden');
                    
                    // Display masked key
                    if (privateKeyDisplay) {
                        privateKeyDisplay.value = unlockedPrivateKey;
                        privateKeyDisplay.type = 'password';
                        isKeyVisible = false;
                    }
                    
                    this.showNotification('Private key unlocked!', 'success');
                } catch (error) {
                    this.showNotification(error.message || 'Failed to unlock', 'error');
                } finally {
                    unlockBtn.disabled = false;
                    unlockBtn.textContent = 'Unlock Key';
                    if (exportKeyPassword) exportKeyPassword.value = '';
                }
            });
        }

        // Toggle visibility
        if (toggleVisibilityBtn) {
            toggleVisibilityBtn.addEventListener('click', () => {
                if (privateKeyDisplay) {
                    isKeyVisible = !isKeyVisible;
                    privateKeyDisplay.type = isKeyVisible ? 'text' : 'password';
                    toggleVisibilityBtn.innerHTML = isKeyVisible 
                        ? '<svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/></svg>'
                        : '<svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';
                }
            });
        }

        // Long press to copy (2 seconds)
        if (copyKeyBtn) {
            const startHold = () => {
                if (!unlockedPrivateKey) return;
                
                // Start progress animation
                copyKeyProgress?.classList.remove('-translate-x-full');
                copyKeyProgress?.classList.add('translate-x-0');
                if (copyKeyText) copyKeyText.textContent = 'Keep holding...';

                holdTimer = setTimeout(async () => {
                    try {
                        await navigator.clipboard.writeText(unlockedPrivateKey);
                        this.showNotification('Private key copied!', 'success');
                        if (copyKeyText) copyKeyText.textContent = 'Copied!';
                        
                        // Reset after 2s
                        setTimeout(() => {
                            if (copyKeyText) copyKeyText.textContent = 'Hold to Copy Private Key (2s)';
                        }, 2000);
                    } catch (e) {
                        this.showNotification('Failed to copy', 'error');
                    }
                    resetProgress();
                }, 2000);
            };

            const resetProgress = () => {
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
                copyKeyProgress?.classList.remove('translate-x-0');
                copyKeyProgress?.classList.add('-translate-x-full');
                if (copyKeyText && copyKeyText.textContent === 'Keep holding...') {
                    copyKeyText.textContent = 'Hold to Copy Private Key (2s)';
                }
            };

            copyKeyBtn.addEventListener('mousedown', startHold);
            copyKeyBtn.addEventListener('touchstart', startHold);
            copyKeyBtn.addEventListener('mouseup', resetProgress);
            copyKeyBtn.addEventListener('mouseleave', resetProgress);
            copyKeyBtn.addEventListener('touchend', resetProgress);
            copyKeyBtn.addEventListener('touchcancel', resetProgress);
        }

        // Lock (reset to step 1)
        if (lockBtn) {
            lockBtn.addEventListener('click', () => {
                unlockedPrivateKey = null;
                step2?.classList.add('hidden');
                step1?.classList.remove('hidden');
                if (privateKeyDisplay) {
                    privateKeyDisplay.value = '';
                    privateKeyDisplay.type = 'password';
                }
                isKeyVisible = false;
                if (toggleVisibilityBtn) toggleVisibilityBtn.innerHTML = '<svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';
                this.showNotification('Private key locked', 'info');
            });
        }
    }

    /**
     * Initialize backup/restore UI handlers
     */
    initBackupRestoreUI() {
        const exportBtn = document.getElementById('export-all-data-btn');
        const importBtn = document.getElementById('import-data-btn');
        const importFileInput = document.getElementById('import-data-file');

        // Export encrypted data
        if (exportBtn) {
            exportBtn.addEventListener('click', async () => {
                try {
                    if (!secureStorage.isStorageUnlocked()) {
                        this.showNotification('Please unlock wallet first', 'error');
                        return;
                    }

                    // Get password for encryption
                    const password = await this.showPasswordPrompt(
                        'Encrypt Backup',
                        'Enter a password to encrypt your backup.\nYou will need this password to restore.',
                        true
                    );
                    if (!password) return;

                    // Get stats for confirmation
                    const stats = secureStorage.getStats();
                    const confirmed = confirm(
                        'Export encrypted backup?\n\n' +
                        `📁 Channels: ${stats.channels}\n` +
                        `💬 Messages: ${stats.messages}\n` +
                        `👥 Contacts: ${stats.contacts}\n\n` +
                        'Your data will be encrypted with the password you provided.'
                    );
                    if (!confirmed) return;

                    // Export encrypted data
                    const encryptedData = await secureStorage.exportEncrypted(password);
                    
                    // Also include keystores
                    const keystores = authManager.exportKeystores();
                    
                    const fullBackup = {
                        format: 'moot-full-backup',
                        version: 2,
                        exportedAt: new Date().toISOString(),
                        keystores: keystores,
                        encryptedData: encryptedData
                    };

                    const json = JSON.stringify(fullBackup, null, 2);
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    
                    const timestamp = new Date().toISOString().slice(0, 10);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `moot-backup-encrypted-${timestamp}.json`;
                    a.click();
                    
                    URL.revokeObjectURL(url);
                    this.showNotification('Encrypted backup exported!', 'success');
                } catch (error) {
                    Logger.error('Export failed:', error);
                    this.showNotification('Failed to export: ' + error.message, 'error');
                }
            });
        }

        // Import encrypted data
        if (importBtn && importFileInput) {
            importBtn.addEventListener('click', () => {
                importFileInput.click();
            });

            importFileInput.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;

                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    
                    // Handle new encrypted format
                    if (data.format === 'moot-full-backup' && data.version === 2) {
                        await this.handleEncryptedImport(data);
                    } 
                    // Handle encrypted data only
                    else if (data.format === 'moot-encrypted-backup') {
                        await this.handleEncryptedDataImport(data);
                    }
                    // Handle keystores only
                    else if (data.format === 'moot-keystores') {
                        await this.handleKeystoresImport(data);
                    }
                    // Handle legacy format
                    else if (data.version === 1 && data.keystores) {
                        await this.handleLegacyImport(data);
                    }
                    else {
                        throw new Error('Unknown backup format');
                    }
                } catch (error) {
                    Logger.error('Import failed:', error);
                    this.showNotification('Failed to import: ' + error.message, 'error');
                } finally {
                    importFileInput.value = '';
                }
            });
        }
    }

    /**
     * Handle encrypted full backup import
     */
    async handleEncryptedImport(data) {
        // First import keystores (no password needed - already encrypted with wallet password)
        const keystoresCount = Object.keys(data.keystores?.keystores || {}).length;
        
        // Get password for encrypted data
        const password = await this.showPasswordPrompt(
            'Decrypt Backup',
            'Enter the password used to encrypt this backup.',
            false
        );
        if (!password) return;

        if (!secureStorage.isStorageUnlocked()) {
            this.showNotification('Please unlock wallet to import data', 'error');
            return;
        }

        // Import keystores
        let keystoresSummary = { keystoresImported: 0 };
        if (data.keystores && keystoresCount > 0) {
            keystoresSummary = authManager.importKeystores(data.keystores, true);
        }

        // Import encrypted data
        const dataSummary = await secureStorage.importEncrypted(data.encryptedData, password, true);

        this.showNotification(
            `Imported: ${keystoresSummary.keystoresImported} wallets, ` +
            `${dataSummary.channelsImported} channels, ` +
            `${dataSummary.contactsImported} contacts`,
            'success'
        );

        // Reload channels if any were imported
        if (dataSummary.channelsImported > 0) {
            channelManager.loadChannels();
            this.renderChannelList();
        }
    }

    /**
     * Handle encrypted data only import
     */
    async handleEncryptedDataImport(data) {
        const password = await this.showPasswordPrompt(
            'Decrypt Backup',
            'Enter the password used to encrypt this backup.',
            false
        );
        if (!password) return;

        if (!secureStorage.isStorageUnlocked()) {
            this.showNotification('Please unlock wallet to import data', 'error');
            return;
        }

        const summary = await secureStorage.importEncrypted(data, password, true);

        this.showNotification(
            `Imported: ${summary.channelsImported} channels, ${summary.contactsImported} contacts`,
            'success'
        );

        if (summary.channelsImported > 0) {
            channelManager.loadChannels();
            this.renderChannelList();
        }
    }

    /**
     * Handle keystores only import
     */
    async handleKeystoresImport(data) {
        const confirmed = confirm(
            'Import wallets from backup?\n\n' +
            `Wallets found: ${Object.keys(data.keystores || {}).length}\n\n` +
            'This will merge with existing wallets.'
        );
        if (!confirmed) return;

        const summary = authManager.importKeystores(data, true);
        this.showNotification(`Imported ${summary.keystoresImported} wallets`, 'success');
    }

    /**
     * Handle legacy plaintext import
     */
    async handleLegacyImport(data) {
        const confirmed = confirm(
            'Import legacy backup?\n\n' +
            `Keystores: ${Object.keys(data.keystores || {}).length}\n` +
            `Wallet data: ${Object.keys(data.walletData || {}).length}\n\n` +
            '⚠️ This is an old format. Data will be merged.'
        );
        if (!confirmed) return;

        const summary = authManager.importAllData(data, true);
        this.showNotification(
            `Imported: ${summary.keystoresImported} wallets, ${summary.walletDataImported} data sets`,
            'success'
        );
    }

    /**
     * Show password prompt modal
     * @param {string} title - Modal title
     * @param {string} description - Description text
     * @param {boolean} requireConfirm - Whether to require password confirmation
     * @returns {Promise<string|null>}
     */
    async showPasswordPrompt(title, description, requireConfirm = false) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl w-[360px] overflow-hidden shadow-2xl border border-[#222]">
                    <div class="px-5 pt-5 pb-3">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">${title}</h3>
                            <button id="close-modal" class="text-[#666] hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                        <p class="text-[11px] text-[#666] mt-1 whitespace-pre-line">${description}</p>
                    </div>
                    <div class="px-5 pb-4 space-y-3">
                        <div class="relative">
                            <input type="password" id="password-input" placeholder="Password"
                                class="w-full bg-[#1a1a1a] border border-[#282828] rounded-lg px-3 py-2.5 text-[13px] text-white placeholder-[#555] focus:outline-none focus:border-[#444] transition"
                                autocomplete="off">
                            <button id="toggle-visibility" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#555] hover:text-white transition">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                </svg>
                            </button>
                        </div>
                        ${requireConfirm ? `
                        <div class="relative">
                            <input type="password" id="password-confirm" placeholder="Confirm password"
                                class="w-full bg-[#1a1a1a] border border-[#282828] rounded-lg px-3 py-2.5 text-[13px] text-white placeholder-[#555] focus:outline-none focus:border-[#444] transition"
                                autocomplete="off">
                        </div>
                        ` : ''}
                        <p id="password-error" class="text-[11px] text-red-500 hidden"></p>
                    </div>
                    <div class="px-5 pb-5 flex gap-2">
                        <button id="pw-cancel" class="flex-1 bg-[#1a1a1a] hover:bg-[#202020] text-white text-[13px] font-medium py-2.5 rounded-lg transition border border-[#282828]">
                            Cancel
                        </button>
                        <button id="pw-confirm" class="flex-1 bg-white hover:bg-[#f0f0f0] text-black text-[13px] font-medium py-2.5 rounded-lg transition">
                            Continue
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const passwordInput = modal.querySelector('#password-input');
            const confirmInput = modal.querySelector('#password-confirm');
            const errorEl = modal.querySelector('#password-error');
            const confirmBtn = modal.querySelector('#pw-confirm');
            const cancelBtn = modal.querySelector('#pw-cancel');
            const closeBtn = modal.querySelector('#close-modal');
            const toggleBtn = modal.querySelector('#toggle-visibility');

            passwordInput.focus();

            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    const type = passwordInput.type === 'password' ? 'text' : 'password';
                    passwordInput.type = type;
                    if (confirmInput) confirmInput.type = type;
                });
            }

            const cleanup = (value) => {
                passwordInput.value = '';
                if (confirmInput) confirmInput.value = '';
                document.body.removeChild(modal);
                resolve(value);
            };

            const validate = () => {
                const pw = passwordInput.value;
                if (!pw || pw.length < 4) {
                    errorEl.textContent = 'Password must be at least 4 characters';
                    errorEl.classList.remove('hidden');
                    return null;
                }
                if (requireConfirm && confirmInput && pw !== confirmInput.value) {
                    errorEl.textContent = 'Passwords do not match';
                    errorEl.classList.remove('hidden');
                    return null;
                }
                return pw;
            };

            confirmBtn.addEventListener('click', () => {
                const pw = validate();
                if (pw) cleanup(pw);
            });
            cancelBtn.addEventListener('click', () => cleanup(null));
            closeBtn.addEventListener('click', () => cleanup(null));
            
            const handleEnter = (e) => {
                if (e.key === 'Enter') {
                    const pw = validate();
                    if (pw) cleanup(pw);
                }
            };
            passwordInput.addEventListener('keypress', handleEnter);
            if (confirmInput) confirmInput.addEventListener('keypress', handleEnter);
            
            modal.addEventListener('click', (e) => {
                if (e.target === modal) cleanup(null);
            });
        });
    }

    /**
     * Copy own address to clipboard
     */
    async copyOwnAddress() {
        const address = authManager.getAddress();
        if (!address) return;
        
        try {
            await navigator.clipboard.writeText(address);
            this.showNotification('Address copied!', 'success');
        } catch {
            this.showNotification('Failed to copy', 'error');
        }
    }

    /**
     * Show settings modal
     */
    async showSettingsModal() {
        if (this.elements.settingsModal) {
            // Update username field
            const username = identityManager.getUsername();
            if (this.elements.settingsUsername) {
                this.elements.settingsUsername.value = username || '';
            }

            // Update address field
            const address = authManager.getAddress();
            if (this.elements.settingsAddress) {
                this.elements.settingsAddress.value = address || '';
            }

            // Update checkbox state
            const enabled = notificationManager.isEnabled();
            if (this.elements.notificationsEnabled) {
                this.elements.notificationsEnabled.checked = enabled;
            }
            if (this.elements.notificationsStatus) {
                this.elements.notificationsStatus.textContent = enabled ? 'Enabled' : 'Disabled';
                this.elements.notificationsStatus.className = enabled 
                    ? 'text-xs text-green-500' 
                    : 'text-xs text-white/40';
            }

            // Update Graph API key field
            if (this.elements.settingsGraphApiKey) {
                const currentKey = graphAPI.isUsingDefaultKey() ? '' : graphAPI.getApiKey();
                this.elements.settingsGraphApiKey.value = currentKey;
            }
            await this.updateGraphApiStatus();

            // Select first tab by default
            this.selectSettingsTab('profile');

            this.elements.settingsModal.classList.remove('hidden');
        }
    }

    /**
     * Initialize settings tabs navigation
     */
    initSettingsTabs() {
        if (this.elements.settingsTabs) {
            this.elements.settingsTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const tabName = tab.dataset.settingsTab;
                    this.selectSettingsTab(tabName);
                });
            });
        }
    }

    /**
     * Select a settings tab
     */
    selectSettingsTab(tabName) {
        // Update tab buttons
        this.elements.settingsTabs?.forEach(tab => {
            const isActive = tab.dataset.settingsTab === tabName;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('text-white/60', !isActive);
        });

        // Update panels
        this.elements.settingsPanels?.forEach(panel => {
            const panelName = panel.id.replace('settings-panel-', '');
            panel.classList.toggle('hidden', panelName !== tabName);
        });
    }

    /**
     * Update Graph API status display
     */
    async updateGraphApiStatus() {
        if (!this.elements.graphApiStatus) return;
        
        const isDefault = graphAPI.isUsingDefaultKey();
        
        if (isDefault) {
            this.elements.graphApiStatus.innerHTML = '<span class="text-yellow-500 inline-flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>Using default key (rate limited)</span>';
        } else {
            // Test the custom key
            this.elements.graphApiStatus.innerHTML = '<span class="text-gray-400">Testing connection...</span>';
            const connected = await graphAPI.testConnection();
            if (connected) {
                this.elements.graphApiStatus.innerHTML = '<span class="text-green-500 inline-flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>Custom key active</span>';
            } else {
                this.elements.graphApiStatus.innerHTML = '<span class="text-red-500 inline-flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>Invalid key or connection failed</span>';
            }
        }
    }

    /**
     * Hide settings modal
     */
    hideSettingsModal() {
        this.elements.settingsModal?.classList.add('hidden');
    }

    /**
     * Handle notifications toggle
     */
    async handleNotificationsToggle(e) {
        const enable = e.target.checked;
        
        if (enable) {
            // Show confirmation
            const confirmed = confirm(
                'Enabling notifications will create a Streamr stream.\n\n' +
                'This requires a blockchain transaction and will cost gas fees.\n\n' +
                'Do you want to continue?'
            );
            
            if (!confirmed) {
                e.target.checked = false;
                return;
            }

            try {
                this.showLoading('Creating notification stream (on-chain transaction)...');
                await notificationManager.enable();
                this.hideLoading();
                this.showNotification('Notifications enabled!', 'success');
                
                if (this.elements.notificationsStatus) {
                    this.elements.notificationsStatus.textContent = 'Enabled';
                    this.elements.notificationsStatus.className = 'text-xs text-green-500';
                }
            } catch (error) {
                this.hideLoading();
                e.target.checked = false;
                this.showNotification('Failed to enable notifications: ' + error.message, 'error');
            }
        } else {
            notificationManager.disable();
            this.showNotification('Notifications disabled', 'info');
            
            if (this.elements.notificationsStatus) {
                this.elements.notificationsStatus.textContent = 'Disabled';
                this.elements.notificationsStatus.className = 'text-xs text-gray-500';
            }
        }
    }

    // ==================== CONTACTS & VERIFICATION ====================

    /**
     * Initialize contacts UI elements and listeners
     */
    initContactsUI() {
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
            this.elements.closeContactsBtn.addEventListener('click', () => this.hideContactsModal());
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
    showContactsModal() {
        if (!this.elements.contactsModal) {
            this.initContactsUI();
        }
        this.renderContactsList();
        this.elements.contactsModal?.classList.remove('hidden');
    }

    /**
     * Hide contacts modal
     */
    hideContactsModal() {
        this.elements.contactsModal?.classList.add('hidden');
        // Clear inputs
        if (this.elements.addContactAddress) this.elements.addContactAddress.value = '';
        if (this.elements.addContactNickname) this.elements.addContactNickname.value = '';
    }

    /**
     * Render contacts list
     */
    renderContactsList() {
        const contacts = identityManager.getAllTrustedContacts();
        
        if (contacts.length === 0) {
            this.elements.contactsList.innerHTML = `
                <div class="text-center text-[#555] py-8 text-[13px]">No trusted contacts yet</div>
            `;
            return;
        }

        this.elements.contactsList.innerHTML = contacts.map(contact => {
            return `
                <div class="flex items-center justify-between p-3 bg-[#1a1a1a] border border-[#282828] rounded-lg">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="w-2 h-2 bg-emerald-500 rounded-full"></span>
                            <span class="text-[13px] font-medium text-white truncate">${this.escapeHtml(contact.nickname)}</span>
                        </div>
                        <div class="text-[10px] text-[#666] font-mono truncate mt-0.5">${contact.address}</div>
                    </div>
                    <button 
                        class="remove-contact-btn ml-2 text-[#555] hover:text-red-400 p-1.5 transition"
                        data-address="${contact.address}"
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
                this.showRemoveContactModal(address, () => {
                    this.renderContactsList();
                });
            });
        });
    }

    /**
     * Handle add contact
     */
    async handleAddContact() {
        const addressOrEns = this.elements.addContactAddress?.value.trim();
        const nickname = this.elements.addContactNickname?.value.trim();

        if (!addressOrEns) {
            this.showNotification('Please enter an address or ENS name', 'error');
            return;
        }

        try {
            let address = addressOrEns;
            
            // Resolve ENS if needed
            if (addressOrEns.endsWith('.eth')) {
                this.showLoading('Resolving ENS...');
                address = await identityManager.resolveAddress(addressOrEns);
                this.hideLoading();
                
                if (!address) {
                    this.showNotification('Could not resolve ENS name', 'error');
                    return;
                }
            }

            // Validate address format
            if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
                this.showNotification('Invalid Ethereum address', 'error');
                return;
            }

            await identityManager.addTrustedContact(address, nickname || null);
            this.renderContactsList();
            this.showNotification('Contact added!', 'success');

            // Clear inputs
            this.elements.addContactAddress.value = '';
            this.elements.addContactNickname.value = '';
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to add contact: ' + error.message, 'error');
        }
    }

    /**
     * Handle message right-click for context menu
     */
    handleMessageRightClick(e) {
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
            this.initContactsUI();
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
                this.showAddContactModal(address);
                break;
                
            case 'copy-address':
                try {
                    await navigator.clipboard.writeText(address);
                    this.showNotification('Address copied!', 'success');
                } catch {
                    this.showNotification('Failed to copy', 'error');
                }
                break;
                
            case 'remove-contact':
                this.showRemoveContactModal(address);
                break;
        }
    }
}

// Export singleton instance
export const uiController = new UIController();
