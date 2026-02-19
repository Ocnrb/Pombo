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
import { mediaController } from './media.js';
import { streamrController } from './streamr.js';
import { subscriptionManager } from './subscriptionManager.js';

// UI Modules
import { GasEstimator } from './ui/GasEstimator.js';
import { notificationUI } from './ui/NotificationUI.js';
import { escapeHtml as _escapeHtml, escapeAttr as _escapeAttr, formatAddress as _formatAddress, isValidMediaUrl as _isValidMediaUrl } from './ui/utils.js';
import { reactionManager } from './ui/ReactionManager.js';
import { onlineUsersUI } from './ui/OnlineUsersUI.js';
import { dropdownManager } from './ui/DropdownManager.js';
import { mediaHandler } from './ui/MediaHandler.js';
import { messageRenderer } from './ui/MessageRenderer.js';
import { analyzeMessageGroups, getGroupPositionClass, analyzeSpacing, getSpacingClass } from './ui/MessageGrouper.js';
import { modalManager } from './ui/ModalManager.js';
import { settingsUI } from './ui/SettingsUI.js';
import { exploreUI } from './ui/ExploreUI.js';

class UIController {
    constructor() {
        this.elements = {};
        
        // Lazy loading state
        this.isLoadingMore = false;
        this.scrollThreshold = 100; // pixels from top to trigger load
        
        // Reply state
        this.replyingTo = null; // { id, text, sender, senderName }
        
        // Send button debounce - prevents duplicate sends on rapid clicks
        this.isSending = false;
        
        // Channel filter state (sidebar tabs: all/personal/community)
        this.currentChannelFilter = 'all';
        
        // Setup callbacks for UI modules
        this._setupModuleCallbacks();
    }
    
    /**
     * Setup dependencies for UI modules
     */
    _setupModuleCallbacks() {
        // ReactionManager
        reactionManager.setDependencies({
            getCurrentAddress: () => authManager.getAddress(),
            onSendReaction: (msgId, emoji, isRemoving) => {
                const channel = channelManager.getCurrentChannel();
                if (channel) {
                    channelManager.sendReaction(channel.streamId, msgId, emoji, isRemoving);
                }
            }
        });
        
        // OnlineUsersUI
        onlineUsersUI.setDependencies({
            getCurrentAddress: () => authManager.getAddress(),
            onUserMenuAction: (action, address) => this.handleUserMenuAction(action, address)
        });
        
        // DropdownManager
        dropdownManager.setDependencies({
            onChannelMenuAction: (action) => this.handleChannelMenuAction(action)
        });
        
        // MediaHandler
        mediaHandler.setDependencies({
            showNotification: (msg, type) => this.showNotification(msg, type)
        });
        
        // MessageRenderer
        messageRenderer.setDependencies({
            getCurrentAddress: () => authManager.getAddress(),
            getMessageReactions: (msgId) => reactionManager.getReactions(msgId),
            registerMedia: (url, type) => this.registerMedia(url, type),
            getImage: (imageId) => mediaController.getImage(imageId),
            cacheImage: (imageId, data) => mediaController.cacheImage(imageId, data),
            requestImage: (streamId, imageId, password) => mediaController.requestImage(streamId, imageId, password),
            getCurrentChannel: () => channelManager.getCurrentChannel(),
            getFileUrl: (fileId) => mediaController.getFileUrl(fileId),
            isSeeding: (fileId) => mediaController.isSeeding(fileId),
            isVideoPlayable: (fileType) => mediaController.isVideoPlayable(fileType)
        });
        
        // SettingsUI
        settingsUI.setDependencies({
            authManager,
            secureStorage,
            channelManager,
            streamrController,
            mediaController,
            identityManager,
            graphAPI,
            Logger,
            modalManager,
            showNotification: (msg, type) => this.showNotification(msg, type),
            updateWalletInfo: (address) => this.updateWalletInfo(address),
            updateNetworkStatus: (status, connected) => this.updateNetworkStatus(status, connected),
            renderChannelList: () => this.renderChannelList(),
            resetToDisconnectedState: () => this.resetToDisconnectedState()
        });
        
        // ExploreUI
        exploreUI.setDependencies({
            getPublicChannels: () => channelManager.getPublicChannels(),
            joinPublicChannel: (streamId, channelInfo) => this.joinPublicChannel(streamId, channelInfo),
            getNsfwEnabled: () => secureStorage.getNsfwEnabled()
        });
    }
    
    /**
     * Register media URL (delegates to MediaHandler)
     */
    registerMedia(url, type = 'image') {
        return mediaHandler.registerMedia(url, type);
    }
    
    /**
     * Open lightbox by media ID (delegates to MediaHandler)
     */
    openLightboxById(mediaId) {
        mediaHandler.openLightboxById(mediaId);
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
            contactsBtn: document.getElementById('contacts-btn'),

            // Sidebar
            channelList: document.getElementById('channel-list'),
            newChannelBtn: document.getElementById('new-channel-btn'),

            // Chat area
            chatHeader: document.getElementById('chat-header'),
            currentChannelName: document.getElementById('current-channel-name'),
            currentChannelInfo: document.getElementById('current-channel-info'),
            channelMenuBtn: document.getElementById('channel-menu-btn'),
            closeChannelBtn: document.getElementById('close-channel-btn'),
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
            // Exposure/visibility fields
            exposureSection: document.getElementById('exposure-section'),
            visibleFields: document.getElementById('visible-fields'),
            channelDescriptionInput: document.getElementById('channel-description-input'),
            channelLanguageInput: document.getElementById('channel-language-input'),
            channelCategoryInput: document.getElementById('channel-category-input'),
            createChannelBtn: document.getElementById('create-channel-btn'),
            cancelChannelBtn: document.getElementById('cancel-channel-btn'),

            // Online users
            onlineHeader: document.getElementById('online-header'),
            onlineSeparator: document.getElementById('online-separator'),
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
            quickJoinInput: document.getElementById('quick-join-input'),
            quickJoinHash: document.getElementById('quick-join-hash'),
            browseChannelsBtn: document.getElementById('browse-channels-btn'),
            browseBtnIcon: document.getElementById('browse-btn-icon'),
            browseBtnText: document.getElementById('browse-btn-text'),
            browseChannelsModal: document.getElementById('browse-channels-modal'),
            browseSearchInput: document.getElementById('browse-search-input'),
            browseLanguageFilter: document.getElementById('browse-language-filter'),
            browseChannelsList: document.getElementById('browse-channels-list'),
            closeBrowseBtn: document.getElementById('close-browse-btn'),
            
            // Reply UI
            replyBar: document.getElementById('reply-bar'),
            replyToName: document.getElementById('reply-to-name'),
            replyToText: document.getElementById('reply-to-text'),
            replyBarClose: document.getElementById('reply-bar-close')
        };

        // Set up event listeners
        this.setupEventListeners();
        
        // Register activity handler for background channel updates
        this.setupActivityHandler();

        Logger.info('UI Controller initialized');
    }
    
    /**
     * Setup handler for background channel activity updates
     * Updates unread badges when new messages are detected in background channels
     */
    setupActivityHandler() {
        subscriptionManager.onActivity((streamId, activity) => {
            Logger.debug('Background activity update:', streamId, activity);
            
            // Update unread badge in sidebar
            const countEl = document.querySelector(`[data-channel-count="${streamId}"]`);
            if (countEl && activity.unreadCount > 0) {
                countEl.textContent = activity.unreadCount >= 30 ? '+30' : activity.unreadCount;
                countEl.classList.remove('hidden', 'text-[#666]', 'bg-[#252525]');
                countEl.classList.add('text-white', 'bg-[#F6851B]/20');
            }
        });
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

        // Exposure tabs - switch between hidden/visible
        document.querySelectorAll('.exposure-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const exposure = tab.dataset.exposure;
                this.switchExposureTab(exposure);
            });
        });

        // Classification tabs (for Closed channels) - switch between personal/community
        document.querySelectorAll('.classification-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchClassificationTab(tab.dataset.classification);
            });
        });

        // Join classification tabs (in join-closed-channel modal)
        document.querySelectorAll('.join-classification-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchJoinClassificationTab(tab.dataset.joinClassification);
            });
        });

        // Channel filter tabs (sidebar: All/Personal/Communities)
        document.querySelectorAll('.channel-filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchChannelFilterTab(tab.dataset.channelFilter);
            });
        });

        // Read-only toggle
        const readOnlyToggle = document.getElementById('read-only-toggle');
        readOnlyToggle?.addEventListener('click', () => {
            this.toggleReadOnly();
        });

        // Online users dropdown toggle
        this.elements.onlineHeader?.addEventListener('click', () => {
            this.elements.onlineUsersList?.classList.toggle('hidden');
        });

        // Close online users list when clicking outside
        document.addEventListener('click', (e) => {
            const clickedOnHeader = this.elements.onlineHeader?.contains(e.target);
            const clickedOnList = this.elements.onlineUsersList?.contains(e.target);
            if (!clickedOnHeader && !clickedOnList) {
                this.elements.onlineUsersList?.classList.add('hidden');
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

        // Footer cancel button (new design)
        document.getElementById('cancel-channel-btn-footer')?.addEventListener('click', () => {
            this.hideNewChannelModal();
        });

        // Channel types info modal
        document.getElementById('channel-info-help-btn')?.addEventListener('click', () => {
            modalManager.show('channel-types-modal');
        });
        document.getElementById('close-channel-types-btn')?.addEventListener('click', () => {
            modalManager.hide('channel-types-modal');
        });
        document.getElementById('close-channel-types-btn-footer')?.addEventListener('click', () => {
            modalManager.hide('channel-types-modal');
        });

        // Quick join input (sidebar) - Enter to join
        this.elements.quickJoinInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.handleQuickJoin();
            }
        });

        // Quick join input - Toggle button state and hash visibility on input change
        this.elements.quickJoinInput?.addEventListener('input', (e) => {
            this.updateBrowseJoinButton();
            this.updateQuickJoinHash();
        });

        // Browse/Join channels button (sidebar) - Dynamic behavior
        this.elements.browseChannelsBtn?.addEventListener('click', () => {
            const hasInput = this.elements.quickJoinInput?.value.trim();
            if (hasInput) {
                this.handleQuickJoin();
            } else {
                // No input: go to Explore view (deselect channel)
                this.deselectChannel();
            }
        });

        // Join channel (in modal)
        this.elements.joinBtn?.addEventListener('click', () => {
            this.handleJoinChannel();
        });

        // Cancel join
        this.elements.cancelJoinBtn?.addEventListener('click', () => {
            this.hideJoinChannelModal();
        });

        // Join Closed Channel modal buttons
        document.getElementById('join-closed-btn')?.addEventListener('click', () => {
            this.handleJoinClosedChannel();
        });
        document.getElementById('cancel-join-closed-btn')?.addEventListener('click', () => {
            this.hideJoinClosedChannelModal();
        });
        
        // Switch from normal join to closed join modal
        document.getElementById('switch-to-closed-join-btn')?.addEventListener('click', () => {
            const streamId = this.elements.joinStreamIdInput?.value.trim() || '';
            this.hideJoinChannelModal();
            this.showJoinClosedChannelModal(streamId);
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
        this.browseTypeFilter = 'public';
        this.browseCategoryFilter = '';
        this.browseLanguageFilterValue = 'en';
        
        document.querySelectorAll('.browse-filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.browseTypeFilter = tab.dataset.browseFilter;
                this.updateBrowseFilterTabs();
                this.filterBrowseChannels(this.elements.browseSearchInput?.value || '');
            });
        });
        
        // Browse category chips
        document.querySelectorAll('.browse-category-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                this.browseCategoryFilter = chip.dataset.category;
                this.updateBrowseCategoryChips();
                this.filterBrowseChannels(this.elements.browseSearchInput?.value || '');
            });
        });
        
        // Toggle categories expand/collapse
        document.getElementById('toggle-categories-btn')?.addEventListener('click', () => {
            this.toggleCategoriesExpand();
        });
        
        // Browse language filter
        this.elements.browseLanguageFilter?.addEventListener('change', (e) => {
            this.browseLanguageFilterValue = e.target.value;
            this.filterBrowseChannels(this.elements.browseSearchInput?.value || '');
        });

        // Send message
        this.elements.sendMessageBtn.addEventListener('click', () => {
            this.handleSendMessage();
        });

        // Enter key to send message (Shift+Enter for new line)
        this.elements.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendMessage();
            }
            // Escape to cancel reply
            if (e.key === 'Escape' && this.replyingTo) {
                this.cancelReply();
            }
        });
        
        // Reply bar close button
        this.elements.replyBarClose?.addEventListener('click', () => {
            this.cancelReply();
        });

        // Lazy loading - scroll to top loads more history
        this.elements.messagesArea?.addEventListener('scroll', () => {
            this.handleMessagesScroll();
        });
        
        // Auto-resize textarea as user types
        this.elements.messageInput.addEventListener('input', () => {
            const textarea = this.elements.messageInput;
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
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

        // Close channel button (X)
        if (this.elements.closeChannelBtn) {
            this.elements.closeChannelBtn.addEventListener('click', async () => {
                await this.deselectChannel();
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
        
        // Initialize attach button
        this.initAttachButton();
        
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
        if (!dot) return;
        
        if (connected) {
            dot.classList.remove('bg-[#444]', 'bg-amber-400');
            dot.classList.add('bg-emerald-400');
        } else if (status.toLowerCase().includes('connecting')) {
            dot.classList.remove('bg-[#444]', 'bg-emerald-400');
            dot.classList.add('bg-amber-400');
        } else {
            dot.classList.remove('bg-emerald-400', 'bg-amber-400');
            dot.classList.add('bg-[#444]');
        }
    }

    /**
     * Render channel list
     */
    renderChannelList() {
        let channels = channelManager.getAllChannels();
        Logger.debug('renderChannelList called - Total channels:', channels.length);
        Logger.debug('Channels:', channels);
        
        // Apply channel filter (All/Personal/Communities)
        if (this.currentChannelFilter === 'personal') {
            // Personal: Closed channels with classification 'personal'
            channels = channels.filter(ch => 
                ch.type === 'native' && ch.classification === 'personal'
            );
        } else if (this.currentChannelFilter === 'community') {
            // Communities: Open + Protected + Closed with classification 'community'
            channels = channels.filter(ch => 
                ch.type !== 'native' || ch.classification === 'community'
            );
        }
        // 'all' - no filtering

        if (channels.length === 0) {
            const filterMsg = this.currentChannelFilter === 'all' 
                ? 'No channels yet' 
                : `No ${this.currentChannelFilter} channels`;
            this.elements.channelList.innerHTML = `
                <div class="p-4 text-center text-[#555] text-[13px]">
                    ${filterMsg}
                </div>
            `;
            Logger.debug('No channels to render');
            return;
        }

        // Sort channels by user-defined order
        const channelOrder = secureStorage.getChannelOrder();
        if (channelOrder.length > 0) {
            channels = this.sortChannelsByOrder(channels, channelOrder);
        }

        // Initialize lastSeenCounts for channels that haven't been tracked yet
        // (on first load, existing messages are considered "seen")
        // Using timestamp-based tracking now via secureStorage

        // Get current channel to highlight it
        const currentChannel = channelManager.getCurrentChannel();
        const currentStreamId = currentChannel?.streamId;

        this.elements.channelList.innerHTML = channels.map(channel => {
            // Calculate unread count based on timestamps
            const lastAccess = secureStorage.getChannelLastAccess(channel.streamId) || 0;
            const unreadMessages = channel.messages.filter(m => m.timestamp > lastAccess);
            const unreadCount = unreadMessages.length;
            const hasUnread = unreadCount > 0;
            const countClass = hasUnread 
                ? 'text-white bg-[#F6851B]/20' 
                : 'text-[#666] bg-[#252525]';
            
            // Show "+30" if we hit the initial load limit (may have more unread)
            const displayCount = hasUnread ? (unreadCount >= 30 ? '+30' : unreadCount) : '';
            
            // Check if this is the currently open channel
            const isActive = channel.streamId === currentStreamId;
            const activeClass = isActive ? 'border-l-2 border-l-[#F6851B] bg-[#1a1a1a]' : 'border-l-2 border-l-transparent';
            
            return `
            <div
                class="channel-item px-3 py-4 mx-2 rounded-lg cursor-pointer bg-[#151515] border border-[#222] hover:bg-[#1e1e1e] hover:border-[#333] transition group ${activeClass}"
                data-stream-id="${channel.streamId}"
                draggable="true"
            >
                <div class="flex items-center justify-between">
                    <!-- Drag handle (6 dots) - visible on hover -->
                    <div class="drag-handle flex-shrink-0 mr-2 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity text-[#555] hover:text-[#888]" title="Drag to reorder">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="8" cy="6" r="1.5"/>
                            <circle cx="16" cy="6" r="1.5"/>
                            <circle cx="8" cy="12" r="1.5"/>
                            <circle cx="16" cy="12" r="1.5"/>
                            <circle cx="8" cy="18" r="1.5"/>
                            <circle cx="16" cy="18" r="1.5"/>
                        </svg>
                    </div>
                    <div class="flex-1 min-w-0 pl-1">
                        <h3 class="text-[13px] font-medium text-white truncate">${this.escapeHtml(channel.name)}</h3>
                    </div>
                    <div class="flex items-center gap-1.5 ml-2">
                        ${hasUnread ? `<span class="channel-msg-count text-[10px] ${countClass} px-1.5 py-0.5 rounded" data-channel-count="${channel.streamId}">${unreadCount}</span>` : `<span class="channel-msg-count text-[10px] text-[#666] bg-[#252525] px-1.5 py-0.5 rounded hidden" data-channel-count="${channel.streamId}">0</span>`}
                        <svg class="w-3.5 h-3.5 text-[#444]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8.25 4.5l7.5 7.5-7.5 7.5"></path>
                        </svg>
                    </div>
                </div>
            </div>
        `}).join('');

        Logger.debug('Channels rendered, adding click listeners...');

        // Add click listeners
        document.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                // Ignore clicks on drag handle
                if (e.target.closest('.drag-handle')) return;
                
                const streamId = e.currentTarget.dataset.streamId;
                Logger.debug('Channel clicked:', streamId);
                this.selectChannel(streamId);
            });
        });

        // Setup drag and drop for channel reordering
        this.setupChannelDragAndDrop();

        Logger.debug('Channel list rendering complete');
    }

    /**
     * Sort channels by user-defined order
     * Channels not in the order array appear at the end
     * @param {Array} channels - Array of channel objects
     * @param {Array} order - Array of streamIds in desired order
     * @returns {Array} - Sorted channels
     */
    sortChannelsByOrder(channels, order) {
        const orderMap = new Map(order.map((id, index) => [id, index]));
        return [...channels].sort((a, b) => {
            const indexA = orderMap.has(a.streamId) ? orderMap.get(a.streamId) : Infinity;
            const indexB = orderMap.has(b.streamId) ? orderMap.get(b.streamId) : Infinity;
            return indexA - indexB;
        });
    }

    /**
     * Setup drag and drop for channel list reordering
     */
    setupChannelDragAndDrop() {
        const channelItems = document.querySelectorAll('.channel-item');
        let draggedItem = null;
        let draggedStreamId = null;

        channelItems.forEach(item => {
            // Drag start
            item.addEventListener('dragstart', (e) => {
                draggedItem = item;
                draggedStreamId = item.dataset.streamId;
                item.classList.add('dragging');
                
                // Required for Firefox
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', draggedStreamId);
                
                // Make it slightly transparent
                setTimeout(() => {
                    item.style.opacity = '0.5';
                }, 0);
            });

            // Drag end
            item.addEventListener('dragend', (e) => {
                item.classList.remove('dragging');
                item.style.opacity = '';
                draggedItem = null;
                draggedStreamId = null;
                
                // Remove all drag-over styles
                document.querySelectorAll('.channel-item').forEach(el => {
                    el.classList.remove('drag-over');
                });
            });

            // Drag over
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                if (item !== draggedItem) {
                    item.classList.add('drag-over');
                }
            });

            // Drag leave
            item.addEventListener('dragleave', (e) => {
                item.classList.remove('drag-over');
            });

            // Drop
            item.addEventListener('drop', async (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                
                if (!draggedItem || item === draggedItem) return;
                
                const targetStreamId = item.dataset.streamId;
                
                // Get current order or create from current channel list
                let currentOrder = secureStorage.getChannelOrder();
                const channels = channelManager.getAllChannels();
                
                // If no saved order, create from current channels
                if (currentOrder.length === 0) {
                    currentOrder = channels.map(ch => ch.streamId);
                }
                
                // Ensure all current channels are in the order
                channels.forEach(ch => {
                    if (!currentOrder.includes(ch.streamId)) {
                        currentOrder.push(ch.streamId);
                    }
                });
                
                // Find positions
                const draggedIndex = currentOrder.indexOf(draggedStreamId);
                const targetIndex = currentOrder.indexOf(targetStreamId);
                
                if (draggedIndex === -1 || targetIndex === -1) return;
                
                // Remove dragged item and insert at new position
                currentOrder.splice(draggedIndex, 1);
                currentOrder.splice(targetIndex, 0, draggedStreamId);
                
                // Save the new order
                await secureStorage.setChannelOrder(currentOrder);
                
                // Re-render the list
                this.renderChannelList();
                
                Logger.debug('Channel order updated');
            });
        });
    }

    /**
     * Select and open a channel
     * @param {string} streamId - Stream ID
     */
    async selectChannel(streamId) {
        // Clear typing indicator from previous channel
        this.hideTypingIndicator();
        
        // Clear any pending reply from previous channel
        this.cancelReply();
        
        // Immediately clear messages area to prevent flash of explore view with wrong padding
        this.elements.messagesArea.innerHTML = '';
        
        // Restore padding for chat messages
        this.elements.messagesArea?.classList.add('p-4');
        
        channelManager.setCurrentChannel(streamId);
        const channel = channelManager.getCurrentChannel();

        if (channel) {
            // Use subscriptionManager for dynamic subscription (only active channel is fully subscribed)
            try {
                await subscriptionManager.setActiveChannel(streamId, channel.password);
            } catch (e) {
                Logger.warn('Subscribe error (may already be subscribed):', e.message);
            }
            
            // Save as last opened channel for session restore
            await secureStorage.setLastOpenedChannel(streamId);
            
            // Clear unread count since user is now viewing this channel
            subscriptionManager.clearUnreadCount(streamId);
            
            this.elements.currentChannelName.textContent = channel.name;
            this.elements.currentChannelInfo.innerHTML = this.getChannelTypeLabel(channel.type, channel.readOnly);
            this.elements.currentChannelInfo.parentElement.classList.remove('hidden');
            this.elements.messageInputContainer.classList.remove('hidden');

            // Handle read-only channels (async - checks actual publish permission)
            await this.updateReadOnlyUI(channel);

            // Show invite button
            this.elements.inviteUsersBtn.classList.remove('hidden');

            // Show channel menu button
            if (this.elements.channelMenuBtn) {
                this.elements.channelMenuBtn.classList.remove('hidden');
            }

            // Show close channel button
            if (this.elements.closeChannelBtn) {
                this.elements.closeChannelBtn.classList.remove('hidden');
            }
            
            // Show online users container
            this.elements.onlineHeader?.classList.remove('hidden');
            this.elements.onlineHeader?.classList.add('flex');
            this.elements.onlineSeparator?.classList.remove('hidden');

            // Load reactions from channel state
            this.loadChannelReactions(streamId);

            this.renderMessages(channel.messages);
            
            // Mark channel as read - save current timestamp
            await secureStorage.setChannelLastAccess(streamId, Date.now());
            
            // Update sidebar to clear unread indicator
            this.renderChannelList();
            
            // Start presence tracking
            channelManager.startPresenceTracking(streamId);
            
            // Update online users display
            this.updateOnlineUsers(streamId, channelManager.getOnlineUsers(streamId));
            
            // Pre-load DELETE permission in background for faster settings modal
            channelManager.preloadDeletePermission(streamId);
        }
    }

    /**
     * Deselect current channel (close it)
     */
    async deselectChannel() {
        // Clear typing indicator
        this.hideTypingIndicator();
        
        // Clear any pending reply
        this.cancelReply();
        
        // Stop presence tracking
        channelManager.stopPresenceTracking();
        
        // Clear active channel in subscription manager (downgrades to background)
        await subscriptionManager.clearActiveChannel();
        
        // Clear current channel
        channelManager.setCurrentChannel(null);
        
        // Hide message input (will be shown by showExploreView if needed)
        this.elements.messageInputContainer.classList.add('hidden');
        
        // Hide channel-specific buttons
        this.elements.inviteUsersBtn?.classList.add('hidden');
        this.elements.channelMenuBtn?.classList.add('hidden');
        this.elements.closeChannelBtn?.classList.add('hidden');
        this.elements.onlineHeader?.classList.add('hidden');
        this.elements.onlineHeader?.classList.remove('flex');
        this.elements.onlineSeparator?.classList.add('hidden');
        
        // Reset online users list
        if (this.elements.onlineUsersList) {
            this.elements.onlineUsersList.innerHTML = '<div class="text-gray-400 text-sm text-center">No one online</div>';
        }
        if (this.elements.onlineUsersCount) {
            this.elements.onlineUsersCount.textContent = '0';
        }
        
        // Show Explore view (front-page) instead of static message
        this.showExploreView();
        
        // Remove selection highlight from channel list
        document.querySelectorAll('.channel-item').forEach(item => {
            item.classList.remove('bg-[#252525]');
        });
    }

    /**
     * Reset UI to disconnected state
     */
    resetToDisconnectedState() {
        // Clear typing indicator
        this.hideTypingIndicator();
        
        // Reset sending state
        this.isSending = false;
        
        // Clear quick join input and reset button
        if (this.elements.quickJoinInput) {
            this.elements.quickJoinInput.value = '';
        }
        this.updateBrowseJoinButton();
        this.updateQuickJoinHash();
        
        // Close any open modals first (using ModalManager)
        modalManager.hide('channel-settings-modal');
        modalManager.hide('invite-users-modal');
        modalManager.hide('delete-channel-modal');
        this.hideLeaveChannelModal();
        
        // Reset channel name and info
        this.elements.currentChannelName.textContent = 'Explore Channels';
        this.elements.currentChannelInfo.textContent = '';
        this.elements.currentChannelInfo.parentElement.classList.add('hidden');
        this.elements.messageInputContainer.classList.add('hidden');
        
        this.elements.inviteUsersBtn?.classList.add('hidden');
        this.elements.channelMenuBtn?.classList.add('hidden');
        this.elements.closeChannelBtn?.classList.add('hidden');
        this.elements.onlineHeader?.classList.add('hidden');
        this.elements.onlineHeader?.classList.remove('flex');
        this.elements.onlineSeparator?.classList.add('hidden');
        
        // Reset online users list
        if (this.elements.onlineUsersList) {
            this.elements.onlineUsersList.innerHTML = '<div class="text-gray-400 text-sm text-center">No one online</div>';
        }
        if (this.elements.onlineUsersCount) {
            this.elements.onlineUsersCount.textContent = '0';
        }
        
        // Clear messages area (will show loading or empty state)
        this.elements.messagesArea.innerHTML = '';
    }

    /**
     * Show connected but no channel selected state
     * Now shows the Explore view as the front-page
     */
    showConnectedNoChannelState() {
        this.showExploreView();
    }

    /**
     * Show Explore view inline in messages area (not as modal)
     * This is the front-page when no channel is selected
     */
    async showExploreView() {
        // Hide message input (not needed in Explore view)
        this.elements.messageInputContainer?.classList.add('hidden');
        
        // Remove padding from messages area for edge-to-edge explore view
        this.elements.messagesArea?.classList.remove('p-4');
        
        // Update header to show Explore context
        this.elements.currentChannelName.textContent = 'Explore Channels';
        this.elements.currentChannelInfo.textContent = '';
        this.elements.currentChannelInfo.parentElement.classList.add('hidden');
        
        // Hide channel-specific buttons
        this.elements.inviteUsersBtn?.classList.add('hidden');
        this.elements.channelMenuBtn?.classList.add('hidden');
        this.elements.closeChannelBtn?.classList.add('hidden');
        this.elements.onlineHeader?.classList.add('hidden');
        this.elements.onlineSeparator?.classList.add('hidden');
        
        // Render Explore view using ExploreUI module
        const nsfwEnabled = secureStorage.getNsfwEnabled();
        this.elements.messagesArea.innerHTML = exploreUI.getTemplate(nsfwEnabled);
        
        // Setup listeners and reset filters
        exploreUI.setupListeners();
        exploreUI.resetFilters();
        
        // Load channels
        await exploreUI.loadChannels();
    }

    /**
     * Update online users display
     * @param {string} streamId - Stream ID
     * @param {Array} users - Array of online users
     */
    updateOnlineUsers(streamId, users) {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel || currentChannel.streamId !== streamId) return;
        onlineUsersUI.updateOnlineUsers(this.elements.onlineUsersCount, this.elements.onlineUsersList, users);
    }
    
    /**
     * Attach event listeners for user dropdown menus
     */
    attachUserMenuListeners() {
        onlineUsersUI.attachUserMenuListeners();
    }
    
    /**
     * Close user dropdown menu
     */
    closeUserDropdown() {
        onlineUsersUI.closeUserDropdown();
    }
    
    /**
     * Show channel dropdown menu
     */
    showChannelDropdown(e) {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;
        dropdownManager.showChannelDropdown(e, this.elements.channelMenuBtn, currentChannel);
    }
    
    /**
     * Close channel dropdown menu
     */
    closeChannelDropdown() {
        dropdownManager.closeChannelDropdown();
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
     * Format Ethereum address for display (delegates to utils)
     */
    formatAddress(address) {
        return _formatAddress(address);
    }

    /**
     * Escape HTML to prevent XSS (delegates to utils)
     */
    escapeHtml(str) {
        return _escapeHtml(str);
    }

    /**
     * Escape string for use in HTML attributes (delegates to utils)
     */
    escapeAttr(str) {
        return _escapeAttr(str);
    }

    /**
     * Validate URL for safe use in src/href attributes (delegates to utils)
     */
    isValidMediaUrl(url) {
        return _isValidMediaUrl(url);
    }

    /**
     * Load reactions from channel state into UI (delegates to ReactionManager)
     * @param {string} streamId - Stream ID
     */
    loadChannelReactions(streamId) {
        const reactions = channelManager.getChannelReactions(streamId);
        reactionManager.loadFromChannelState(reactions);
        Logger.debug('Loaded reactions for channel:', Object.keys(reactions).length, 'messages with reactions');
    }

    /**
     * Handle scroll in messages area - lazy load older messages
     */
    async handleMessagesScroll() {
        const messagesArea = this.elements.messagesArea;
        if (!messagesArea) return;
        
        // Check if scrolled near the top
        if (messagesArea.scrollTop > this.scrollThreshold) {
            return; // Not near top, do nothing
        }
        
        // Prevent concurrent loads
        if (this.isLoadingMore) return;
        
        const channel = channelManager.getCurrentChannel();
        if (!channel || !channel.hasMoreHistory) return;
        
        this.isLoadingMore = true;
        
        // Show loading indicator at top
        this.showLoadingMoreIndicator();
        
        // Save current scroll position and first message
        const previousScrollHeight = messagesArea.scrollHeight;
        const previousScrollTop = messagesArea.scrollTop;
        
        try {
            const result = await channelManager.loadMoreHistory(channel.streamId);
            
            if (result.loaded > 0) {
                // Re-render all messages
                this.renderMessages(channel.messages);
                
                // Restore scroll position (keep viewing same content)
                const newScrollHeight = messagesArea.scrollHeight;
                const heightDiff = newScrollHeight - previousScrollHeight;
                messagesArea.scrollTop = previousScrollTop + heightDiff;
            }
            
            this.hideLoadingMoreIndicator();
        } catch (error) {
            Logger.error('Failed to load more messages:', error);
            this.hideLoadingMoreIndicator();
        }
        
        this.isLoadingMore = false;
    }

    /**
     * Show loading indicator at top of messages (delegates to NotificationUI)
     */
    showLoadingMoreIndicator() {
        notificationUI.showLoadingMoreIndicator(this.elements.messagesArea);
    }

    /**
     * Hide loading indicator (delegates to NotificationUI)
     */
    hideLoadingMoreIndicator() {
        notificationUI.hideLoadingMoreIndicator();
    }

    /**
     * Render messages in the chat area (bubble style like CHATtest.html)
     * @param {Array} messages - Array of message objects
     */
    renderMessages(messages) {
        const channel = channelManager.getCurrentChannel();
        const hasMoreHistory = channel?.hasMoreHistory !== false;
        
        if (messages.length === 0) {
            this.elements.messagesArea.innerHTML = `
                <div class="flex items-center justify-center h-full text-gray-500">
                    No messages yet. Start the conversation!
                </div>
            `;
            return;
        }

        const currentAddress = authManager.getAddress();
        let lastDateStr = null;
        
        let historyStartIndicator = '';
        if (!hasMoreHistory) {
            historyStartIndicator = `
                <div class="flex justify-center py-4">
                    <div class="text-[#444] text-xs">
                        — beginning of conversation —
                    </div>
                </div>
            `;
        }

        // Analyze message groups for Stack Effect
        const groupPositions = analyzeMessageGroups(messages);
        // Analyze spacing for 3-level margin system
        const spacingTypes = analyzeSpacing(messages, currentAddress);

        this.elements.messagesArea.innerHTML = messages.map((msg, index) => {
            const isOwn = msg.sender?.toLowerCase() === currentAddress?.toLowerCase();
            const msgDate = new Date(msg.timestamp);
            const time = msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            const dateStr = msgDate.toDateString();
            let dateSeparator = '';
            if (dateStr !== lastDateStr) {
                lastDateStr = dateStr;
                dateSeparator = messageRenderer.renderDateSeparator(msgDate);
            }
            
            const badge = this.getVerificationBadge(msg, isOwn);
            let displayName = msg.senderName || msg.verified?.ensName;
            if (!displayName) {
                displayName = this.formatAddress(msg.sender);
            }
            
            // Get group position class for Stack Effect
            const groupClass = getGroupPositionClass(groupPositions[index]);
            // Get spacing class for margin
            const spacingClass = getSpacingClass(spacingTypes[index]);
            
            return dateSeparator + messageRenderer.buildMessageHTML(msg, isOwn, time, badge, displayName, groupClass, groupPositions[index], spacingClass);
        }).join('');

        this.elements.messagesArea.innerHTML = historyStartIndicator + this.elements.messagesArea.innerHTML;

        if (!this.isLoadingMore) {
            this.elements.messagesArea.scrollTop = this.elements.messagesArea.scrollHeight;
        }
        
        this.attachReactionListeners();
        this.attachLightboxListeners();
    }

    /**
     * Render date separator pill
     */
    renderDateSeparator(date) {
        return messageRenderer.renderDateSeparator(date);
    }

    /**
     * Render reactions for a message
     */
    renderReactions(msgId, isOwn) {
        return messageRenderer.renderReactions(msgId, isOwn);
    }

    /**
     * Render reply preview for a message
     */
    renderReplyPreview(replyTo) {
        return messageRenderer.renderReplyPreview(replyTo);
    }

    /**
     * Start replying to a message
     */
    startReply(msgId) {
        const channel = channelManager.getCurrentChannel();
        if (!channel) return;
        
        const msg = channel.messages.find(m => (m.id || m.timestamp) === msgId);
        if (!msg) return;
        
        const displayName = msg.senderName || msg.verified?.ensName || this.formatAddress(msg.sender);
        
        this.replyingTo = {
            id: msgId,
            text: msg.text ? msg.text.substring(0, 100) : '',
            sender: msg.sender,
            senderName: displayName
        };
        
        // Update reply bar UI
        if (this.elements.replyToName) {
            this.elements.replyToName.textContent = displayName;
        }
        if (this.elements.replyToText) {
            this.elements.replyToText.textContent = msg.text ? msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : '') : '[Media]';
        }
        if (this.elements.replyBar) {
            this.elements.replyBar.classList.add('active');
        }
        
        // Focus input
        this.elements.messageInput?.focus();
    }

    /**
     * Cancel reply
     */
    cancelReply() {
        this.replyingTo = null;
        if (this.elements.replyBar) {
            this.elements.replyBar.classList.remove('active');
        }
    }

    /**
     * Scroll to a specific message
     */
    scrollToMessage(msgId) {
        const msgElement = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (msgElement) {
            msgElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            msgElement.classList.add('message-highlight');
            setTimeout(() => {
                msgElement.classList.remove('message-highlight');
            }, 1500);
        }
    }

    /**
     * Initialize reactions map
     */
    initReactions() {
        reactionManager.init();
    }

    /**
     * Add or toggle a reaction
     */
    toggleReaction(msgId, emoji) {
        reactionManager.toggleReaction(msgId, emoji);
    }

    /**
     * Update reaction UI for specific message
     */
    updateReactionUI(msgId) {
        reactionManager.updateReactionUI(msgId);
    }

    /**
     * Handle incoming reaction
     */
    handleIncomingReaction(msgId, emoji, sender, action = 'add') {
        reactionManager.handleIncomingReaction(msgId, emoji, sender, action);
    }

    /**
     * Attach reaction button listeners
     */
    attachReactionListeners() {
        reactionManager.attachReactionListeners(
            (msgId) => this.startReply(msgId),
            (fileId) => this.handleFileDownload(fileId),
            (msgId) => this.scrollToMessage(msgId)
        );
    }
    
    /**
     * Handle file download button click
     */
    async handleFileDownload(fileId) {
        const channel = channelManager.getCurrentChannel();
        await mediaHandler.handleFileDownload(fileId, channel, mediaController);
    }

    /**
     * Reset download UI to initial state (on error or cancel)
     */
    resetDownloadUI(fileId) {
        mediaHandler.resetDownloadUI(fileId);
    }

    /**
     * Show reaction picker
     */
    showReactionPicker(e, msgId, triggerBtn) {
        reactionManager.showReactionPicker(e, msgId, triggerBtn);
    }

    /**
     * Initialize emoji picker
     */
    initEmojiPicker() {
        reactionManager.initEmojiPicker(this.elements.messageInput);
    }

    /**
     * Initialize attach button and file handling
     */
    initAttachButton() {
        const attachBtn = document.getElementById('attach-btn');
        const attachMenu = document.getElementById('attach-menu');
        const sendImageBtn = document.getElementById('send-image-btn');
        const sendVideoBtn = document.getElementById('send-video-btn');
        const imageInput = document.getElementById('image-input');
        const videoInput = document.getElementById('video-input');
        
        // File confirm modal buttons
        const cancelFileBtn = document.getElementById('cancel-file-btn');
        const confirmFileBtn = document.getElementById('confirm-file-btn');
        
        if (!attachBtn || !attachMenu) return;
        
        // Store selected file and type
        this.pendingFile = null;
        this.pendingFileType = null;
        
        // Toggle attach menu
        attachBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            attachMenu.classList.toggle('hidden');
        });
        
        // Image button
        sendImageBtn?.addEventListener('click', () => {
            attachMenu.classList.add('hidden');
            imageInput?.click();
        });
        
        // Video button
        sendVideoBtn?.addEventListener('click', () => {
            attachMenu.classList.add('hidden');
            videoInput?.click();
        });
        
        // Image file selected
        imageInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this.showFileConfirmModal(file, 'image');
            }
            e.target.value = '';
        });
        
        // Video file selected
        videoInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this.showFileConfirmModal(file, 'video');
            }
            e.target.value = '';
        });
        
        // Cancel file send
        cancelFileBtn?.addEventListener('click', () => {
            this.pendingFile = null;
            this.pendingFileType = null;
            modalManager.hide('file-confirm-modal');
        });
        
        // Confirm file send
        confirmFileBtn?.addEventListener('click', async () => {
            if (!this.pendingFile) return;
            
            const file = this.pendingFile;
            const type = this.pendingFileType;
            
            this.pendingFile = null;
            this.pendingFileType = null;
            modalManager.hide('file-confirm-modal');
            
            await this.sendMediaFile(file, type);
        });
        
        // Setup media controller handlers
        this.setupMediaHandlers();
    }
    
    /**
     * Show file confirm modal
     */
    showFileConfirmModal(file, type) {
        const modal = document.getElementById('file-confirm-modal');
        const fileName = document.getElementById('confirm-file-name');
        const fileSize = document.getElementById('confirm-file-size');
        const previewIcon = document.getElementById('file-preview-icon');
        
        if (!modal) return;
        
        this.pendingFile = file;
        this.pendingFileType = type;
        
        fileName.textContent = file.name;
        fileSize.textContent = this.formatFileSize(file.size);
        
        // Update icon based on type
        if (type === 'image') {
            previewIcon.innerHTML = `
                <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/>
                </svg>
            `;
        } else if (type === 'video') {
            previewIcon.innerHTML = `
                <svg class="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                </svg>
            `;
        }
        
        modalManager.show('file-confirm-modal');
    }
    
    /**
     * Send media file
     */
    async sendMediaFile(file, type) {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.showNotification('No channel selected', 'error');
            return;
        }
        
        try {
            this.showLoading(type === 'image' ? 'Sending image...' : 'Processing video...');
            
            if (type === 'image') {
                await mediaController.sendImage(currentChannel.streamId, file, currentChannel.password);
                this.showNotification('Image sent!', 'success');
            } else if (type === 'video') {
                await mediaController.sendVideo(currentChannel.streamId, file, currentChannel.password);
                this.showNotification('Video shared!', 'success');
            }
            
            this.hideLoading();
        } catch (error) {
            this.hideLoading();
            this.showNotification('Failed to send: ' + error.message, 'error');
        }
    }
    
    /**
     * Setup media controller event handlers
     */
    setupMediaHandlers() {
        // Image received - update image placeholders
        mediaController.onImageReceived((imageId, base64Data) => {
            const placeholder = document.querySelector(`[data-image-id="${imageId}"]`);
            if (placeholder) {
                // Register media for safe onclick handling
                const mediaId = this.registerMedia(base64Data, 'image');
                if (!mediaId) return; // Invalid URL rejected
                
                placeholder.outerHTML = `
                    <div class="relative inline-block max-w-xs group">
                        <img src="${base64Data}" 
                             class="max-w-full max-h-60 rounded-lg cursor-pointer object-contain lightbox-trigger" 
                             data-media-id="${mediaId}"
                             alt="Image"/>
                        <button class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white p-1 rounded transition opacity-0 group-hover:opacity-100 lightbox-trigger"
                                data-media-id="${mediaId}"
                                title="Maximize">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                            </svg>
                        </button>
                    </div>
                `;
                // Attach click handlers
                this.attachLightboxListeners();
            }
        });
        
        // File progress - update progress overlay and bar
        mediaController.onFileProgress((fileId, percent, received, total, fileSize) => {
            // Show new video panel progress overlay
            const progressOverlay = document.querySelector(`[data-progress-overlay="${fileId}"]`);
            if (progressOverlay) {
                progressOverlay.classList.remove('hidden');
            }
            
            // Update progress percentage text
            const progressPercent = document.querySelector(`[data-progress-percent="${fileId}"]`);
            if (progressPercent) {
                progressPercent.textContent = `${percent}%`;
            }
            
            // Update progress fill
            const progressFill = document.querySelector(`[data-progress-fill="${fileId}"]`);
            if (progressFill) {
                progressFill.style.width = `${percent}%`;
            }
            
            // Update progress text with MB
            const progressText = document.querySelector(`[data-progress-text="${fileId}"]`);
            if (progressText) {
                const receivedMB = ((received / total) * fileSize / (1024 * 1024)).toFixed(1);
                const totalMB = (fileSize / (1024 * 1024)).toFixed(1);
                progressText.textContent = `${receivedMB} / ${totalMB} MB`;
            }
            
            // Update download button to show loading state
            const downloadBtn = document.querySelector(`.download-file-btn[data-file-id="${fileId}"]`);
            if (downloadBtn) {
                const playIcon = downloadBtn.querySelector('.download-play-icon');
                const loadingIcon = downloadBtn.querySelector('.download-loading-icon');
                if (playIcon) playIcon.classList.add('hidden');
                if (loadingIcon) loadingIcon.classList.remove('hidden');
                downloadBtn.disabled = true;
                downloadBtn.classList.add('cursor-not-allowed');
            }
        });
        
        // File complete - show video player with seeding badge
        mediaController.onFileComplete((fileId, metadata, url, blob) => {
            const container = document.querySelector(`[data-file-id="${fileId}"]`);
            if (container) {
                const isSeeding = mediaController.isSeeding(fileId);
                
                // Escape filename for safe HTML insertion
                const safeFileName = this.escapeHtml(metadata.fileName);
                const safeFileType = this.escapeHtml(metadata.fileType);
                
                if (metadata.fileType.startsWith('video/')) {
                    // Check if video format is playable in browser
                    const isPlayable = mediaController.isVideoPlayable(metadata.fileType);
                    
                    // Register media for safe lightbox handling
                    const mediaId = this.registerMedia(url, 'video');
                    
                    if (isPlayable && mediaId) {
                        // Show video player
                        container.outerHTML = `
                            <div data-file-id="${this.escapeAttr(fileId)}" class="max-w-xs">
                                <div class="relative rounded-lg overflow-hidden bg-black">
                                    <video src="${url}" 
                                           class="max-w-full max-h-60 cursor-pointer video-player-${this.escapeAttr(fileId)}" 
                                           controls
                                           preload="metadata"
                                           playsinline>
                                        <source src="${url}" type="${safeFileType}">
                                        Your browser does not support this video format.
                                    </video>
                                    <button class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white p-1 rounded transition lightbox-trigger"
                                            data-media-id="${mediaId}"
                                            title="Fullscreen">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                                        </svg>
                                    </button>
                                    ${isSeeding ? `
                                    <div class="absolute bottom-1 left-1 bg-green-600/90 text-white text-xs px-2 py-0.5 rounded-full flex items-center gap-1">
                                        <svg class="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
                                            <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/>
                                        </svg>
                                        <span>Seeding</span>
                                    </div>
                                    ` : ''}
                                </div>
                                <div class="flex items-center justify-between mt-1 text-xs text-gray-500">
                                    <span class="truncate flex-1">${safeFileName}</span>
                                    <div class="flex items-center gap-2 ml-2">
                                        <span>${this.formatFileSize(metadata.fileSize)}</span>
                                        <a href="${url}" download="${safeFileName}" class="text-blue-400 hover:underline">Save</a>
                                    </div>
                                </div>
                            </div>
                        `;
                        
                        // Attach lightbox click handlers
                        this.attachLightboxListeners();
                        
                        // Add error handler to video element
                        setTimeout(() => {
                            const videoEl = document.querySelector(`.video-player-${fileId}`);
                            if (videoEl) {
                                videoEl.addEventListener('error', (e) => {
                                    console.error('Video playback error:', e);
                                    // Replace with download link on error
                                    const parent = videoEl.closest('[data-file-id]');
                                    if (parent) {
                                        parent.innerHTML = `
                                            <div class="bg-[#252525] rounded-lg p-3">
                                                <div class="flex items-center gap-2 mb-2">
                                                    <svg class="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                                    </svg>
                                                    <span class="text-sm text-gray-300">Format not supported</span>
                                                </div>
                                                <a href="${url}" download="${safeFileName}" class="block w-full bg-blue-600 hover:bg-blue-700 text-white text-center px-3 py-2 rounded-lg text-sm transition">
                                                    Download ${safeFileName}
                                                </a>
                                            </div>
                                        `;
                                    }
                                });
                                // Force load
                                videoEl.load();
                            }
                        }, 100);
                    } else {
                        // Format not playable - show download button
                        container.outerHTML = `
                            <div data-file-id="${this.escapeAttr(fileId)}" class="max-w-xs">
                                <div class="bg-[#252525] rounded-lg p-3">
                                    <div class="flex items-center gap-2 mb-2">
                                        <svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                                        </svg>
                                        <span class="font-medium text-sm truncate text-white">${safeFileName}</span>
                                    </div>
                                    <div class="text-xs text-yellow-500 mb-2">
                                        ⚠️ Format not supported in browser (${safeFileType.split('/')[1]?.toUpperCase() || 'video'})
                                    </div>
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs text-gray-400">${this.formatFileSize(metadata.fileSize)}</span>
                                        <a href="${url}" download="${safeFileName}" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm transition">
                                            Download
                                        </a>
                                    </div>
                                    ${isSeeding ? `
                                    <div class="flex items-center gap-2 mt-2">
                                        <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                                        <span class="text-xs text-green-400">Seeding...</span>
                                    </div>
                                    ` : ''}
                                </div>
                            </div>
                        `;
                    }
                } else {
                    container.innerHTML = `
                        <a href="${url}" download="${safeFileName}" class="text-blue-400 hover:underline">${safeFileName}</a>
                    `;
                }
            }
        });
        
        // Seeder update
        mediaController.onSeederUpdate((fileId, count) => {
            const seederEl = document.querySelector(`[data-seeder-count="${fileId}"]`);
            if (seederEl) {
                seederEl.textContent = `${count} seeder${count !== 1 ? 's' : ''}`;
            }
        });
    }
    
    /**
     * Open media lightbox
     */
    openLightbox(src, type = 'image') {
        mediaHandler.openLightbox(src, type);
    }
    
    /**
     * Close media lightbox
     */
    closeLightbox() {
        mediaHandler.closeLightbox();
    }
    
    /**
     * Attach click listeners to lightbox trigger elements
     */
    attachLightboxListeners() {
        mediaHandler.attachLightboxListeners();
    }
    
    /**
     * Check if text is emoji-only
     */
    isEmojiOnly(text) {
        return messageRenderer.isEmojiOnly(text);
    }

    /**
     * Wrap emojis in text with span for styling
     */
    wrapInlineEmojis(html) {
        return messageRenderer.wrapInlineEmojis(html);
    }

    /**
     * Render message content based on type
     */
    renderMessageContent(msg) {
        return messageRenderer.renderMessageContent(msg);
    }
    
    /**
     * Format file size for display
     */
    formatFileSize(bytes) {
        return messageRenderer.formatFileSize(bytes);
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

        // No signature (system message or unsigned)
        if (!msg.signature) {
            return {
                html: '',
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
        // 1 = ENS verified: ✓✓ (double check)
        // 2 = Trusted contact: ★ (star)
        
        const badges = {
            0: { icon: '✓', color: 'text-green-400', label: 'Valid signature' },
            1: { icon: '✓✓', color: 'text-green-400', label: 'ENS verified' },
            2: { icon: '★', color: 'text-yellow-400', label: 'Trusted contact' }
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
            // Update unread count in sidebar for all channels
            this.updateUnreadCount(channel.streamId);
        }
    }

    /**
     * Update unread count badge for a channel in the sidebar
     * Uses timestamp-based tracking - compares last access time with message timestamps
     * @param {string} streamId - Channel stream ID
     */
    updateUnreadCount(streamId) {
        const countEl = document.querySelector(`[data-channel-count="${streamId}"]`);
        if (!countEl) return;
        
        const channel = channelManager.getChannel(streamId);
        if (!channel) return;
        
        // Get last access timestamp
        const lastAccess = secureStorage.getChannelLastAccess(streamId) || 0;
        
        // If user is currently viewing this channel, update access timestamp
        const currentChannel = channelManager.getCurrentChannel();
        const isCurrentChannel = currentChannel?.streamId === streamId;
        
        if (isCurrentChannel) {
            // User is viewing this channel - mark as read
            secureStorage.setChannelLastAccess(streamId, Date.now());
            countEl.classList.add('hidden');
            return;
        }
        
        // Calculate unread count (messages newer than last access)
        const unreadCount = channel.messages.filter(m => m.timestamp > lastAccess).length;
        const hasUnread = unreadCount > 0;
        
        if (hasUnread) {
            // Show "+30" if we hit the initial load limit (may have more unread)
            countEl.textContent = unreadCount >= 30 ? '+30' : unreadCount;
            countEl.classList.remove('hidden', 'text-[#666]', 'bg-[#252525]');
            countEl.classList.add('text-white', 'bg-[#F6851B]/20');
        } else {
            countEl.classList.add('hidden');
            countEl.classList.remove('text-white', 'bg-[#F6851B]/20');
            countEl.classList.add('text-[#666]', 'bg-[#252525]');
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
        
        // Exposure and metadata (for visible channels)
        const exposure = type === 'native' ? 'hidden' : (this.currentExposure || 'hidden');
        const description = exposure === 'visible' ? (this.elements.channelDescriptionInput?.value?.trim() || '') : '';
        const language = exposure === 'visible' ? (this.elements.channelLanguageInput?.value || 'en') : '';
        const category = exposure === 'visible' ? (this.elements.channelCategoryInput?.value || 'general') : '';
        
        // Classification for Closed channels (stored locally only)
        const classification = type === 'native' ? (this.currentClassification || 'personal') : null;

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
        
        // Build options object with all metadata
        const options = {
            exposure,
            description,
            language,
            category,
            classification,
            readOnly: this.currentReadOnly || false
        };

        Logger.debug('Creating channel:', { name, type, password: password ? '***' : null, members, options });

        try {
            this.showLoadingToast('Creating channel...', 'This may take a minute');
            this.hideNewChannelModal();
            
            const channel = await channelManager.createChannel(name, type, password, members, options);
            Logger.debug('Channel created in UI:', channel);

            this.hideLoadingToast();

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
            this.hideLoadingToast();
            this.showNotification('Failed to create channel: ' + error.message, 'error');
        }
    }

    /**
     * Handle send message
     */
    async handleSendMessage() {
        // DEBOUNCE: Prevent rapid double-clicks from sending duplicates
        if (this.isSending) {
            return;
        }
        
        const text = this.elements.messageInput.value.trim();
        if (!text) return;

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        // Lock sending state
        this.isSending = true;
        
        try {
            // Capture reply context before clearing
            const replyTo = this.replyingTo;
            
            // Clear input and reply bar
            this.elements.messageInput.value = '';
            this.elements.messageInput.style.height = 'auto'; // Reset textarea height
            this.cancelReply(); // Clear reply state
            
            await channelManager.sendMessage(currentChannel.streamId, text, replyTo);
            // UI update happens via notifyHandlers -> addMessage
        } catch (error) {
            this.showNotification('Failed to send message: ' + error.message, 'error');
        } finally {
            // Always unlock sending state
            this.isSending = false;
        }
    }

    /**
     * Show new channel modal (uses ModalManager for display)
     */
    showNewChannelModal() {
        modalManager.show('new-channel-modal');
        this.elements.channelNameInput.value = '';
        this.elements.channelPasswordInput.value = '';
        this.elements.channelMembersInput.value = '';
        // Reset exposure fields
        if (this.elements.channelDescriptionInput) this.elements.channelDescriptionInput.value = '';
        if (this.elements.channelLanguageInput) this.elements.channelLanguageInput.value = 'en';
        if (this.elements.channelCategoryInput) this.elements.channelCategoryInput.value = 'general';
        // Reset to public tab
        this.switchChannelTab('public');
        // Reset to hidden exposure (default)
        this.switchExposureTab('hidden');
        // Reset classification to personal (for Closed channels)
        this.switchClassificationTab('personal');
        // Reset read-only toggle
        this.setReadOnly(false);
        
        // Fetch and display gas estimates
        this.updateGasEstimates();
    }
    
    /**
     * Update gas cost estimates in the create channel modal
     */
    async updateGasEstimates() {
        const costPublic = document.getElementById('cost-public');
        const costPassword = document.getElementById('cost-password');
        const costNative = document.getElementById('cost-native');
        
        try {
            const estimates = await GasEstimator.estimateCosts();
            const tooltipText = `Gas: ${estimates.formatted.gasPrice}`;
            
            if (costPublic) {
                costPublic.textContent = estimates.formatted.public;
                costPublic.dataset.tooltip = tooltipText;
            }
            if (costPassword) {
                costPassword.textContent = estimates.formatted.password;
                costPassword.dataset.tooltip = tooltipText;
            }
            if (costNative) {
                costNative.textContent = estimates.formatted.native;
                costNative.dataset.tooltip = tooltipText;
            }
        } catch (error) {
            Logger.warn('Failed to estimate gas costs:', error);
            // Show fallback text
            const fallbackTooltip = 'Gas: ~30 gwei';
            if (costPublic) {
                costPublic.textContent = '~0.01 POL';
                costPublic.dataset.tooltip = fallbackTooltip;
            }
            if (costPassword) {
                costPassword.textContent = '~0.01 POL';
                costPassword.dataset.tooltip = fallbackTooltip;
            }
            if (costNative) {
                costNative.textContent = '~0.02 POL';
                costNative.dataset.tooltip = fallbackTooltip;
            }
        }
    }

    /**
     * Switch channel type tab
     */
    switchChannelTab(tabType) {
        // Update sidebar tab buttons (new design)
        document.querySelectorAll('.channel-tab').forEach(tab => {
            const isActive = tab.dataset.tab === tabType;
            // Active: bg-white/10 text-white
            // Inactive: text-white/60 hover:text-white/90 hover:bg-white/5
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('text-white/60', !isActive);
            tab.classList.toggle('hover:text-white/90', !isActive);
            tab.classList.toggle('hover:bg-white/5', !isActive);
        });
        // Update tab content
        document.querySelectorAll('.channel-tab-content').forEach(content => {
            content.classList.toggle('hidden', content.id !== `tab-${tabType}`);
        });
        
        // Update cost display in footer
        document.querySelectorAll('.channel-cost-display').forEach(cost => {
            cost.classList.add('hidden');
        });
        const activeCost = document.getElementById(`cost-${tabType}`);
        if (activeCost) activeCost.classList.remove('hidden');
        
        // Native (Closed) channels: hide exposure section entirely (always hidden, no choice)
        if (tabType === 'native') {
            this.switchExposureTab('hidden');
            this.elements.exposureSection?.classList.add('hidden');
        } else {
            this.elements.exposureSection?.classList.remove('hidden');
        }
    }

    /**
     * Switch exposure tab (hidden/visible)
     */
    switchExposureTab(exposure) {
        // Update exposure buttons with subtle orange highlight for active
        document.querySelectorAll('.exposure-tab').forEach(tab => {
            const isActive = tab.dataset.exposure === exposure;
            // Active: subtle orange bg and text
            // Inactive: muted white text with hover
            tab.classList.toggle('bg-[#F6851B]/20', isActive);
            tab.classList.toggle('text-[#F6851B]', isActive);
            tab.classList.toggle('text-white/30', !isActive);
            tab.classList.toggle('hover:text-white/50', !isActive);
            tab.classList.toggle('hover:bg-white/5', !isActive);
        });
        
        // Show/hide visible fields
        if (exposure === 'visible') {
            this.elements.visibleFields?.classList.remove('hidden');
        } else {
            this.elements.visibleFields?.classList.add('hidden');
        }
        
        // Store current exposure
        this.currentExposure = exposure;
    }

    /**
     * Switch classification tab (personal/community) in Create modal
     */
    switchClassificationTab(classification) {
        document.querySelectorAll('.classification-tab').forEach(tab => {
            const isActive = tab.dataset.classification === classification;
            // Active: bg-white/10 text-white border-white/10
            // Inactive: bg-white/5 text-white/50 border-white/5 hover:bg-white/10 hover:text-white/70
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('border-white/10', isActive);
            tab.classList.toggle('bg-white/5', !isActive);
            tab.classList.toggle('text-white/50', !isActive);
            tab.classList.toggle('border-white/5', !isActive);
            tab.classList.toggle('hover:bg-white/10', !isActive);
            tab.classList.toggle('hover:text-white/70', !isActive);
        });
        this.currentClassification = classification;
    }

    /**
     * Switch classification tab in Join Closed Channel modal
     */
    switchJoinClassificationTab(classification) {
        document.querySelectorAll('.join-classification-tab').forEach(tab => {
            const isActive = tab.dataset.joinClassification === classification;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('border-white/10', isActive);
            tab.classList.toggle('bg-white/5', !isActive);
            tab.classList.toggle('text-white/50', !isActive);
            tab.classList.toggle('border-white/5', !isActive);
            tab.classList.toggle('hover:bg-white/10', !isActive);
            tab.classList.toggle('hover:text-white/70', !isActive);
        });
        this.joinClassification = classification;
    }

    /**
     * Switch channel filter tab in sidebar (All/Personal/Communities)
     */
    switchChannelFilterTab(filter) {
        document.querySelectorAll('.channel-filter-tab').forEach(tab => {
            const isActive = tab.dataset.channelFilter === filter;
            
            // Border bottom indicator for active state
            tab.classList.toggle('border-[#F6851B]', isActive);
            tab.classList.toggle('border-transparent', !isActive);
            tab.classList.toggle('text-[#F6851B]', isActive);
            tab.classList.toggle('text-white/40', !isActive);
            tab.classList.toggle('hover:text-white/60', !isActive);
        });
        
        this.currentChannelFilter = filter;
        this.renderChannelList();
    }

    /**
     * Toggle read-only mode
     */
    toggleReadOnly() {
        const toggle = document.getElementById('read-only-toggle');
        if (!toggle) return;
        const isEnabled = toggle.dataset.enabled === 'true';
        this.setReadOnly(!isEnabled);
    }

    /**
     * Set read-only mode state
     */
    setReadOnly(enabled) {
        const toggle = document.getElementById('read-only-toggle');
        if (!toggle) return;
        
        toggle.dataset.enabled = enabled ? 'true' : 'false';
        const knob = toggle.querySelector('span');
        
        if (enabled) {
            toggle.classList.remove('bg-white/10');
            toggle.classList.add('bg-[#F6851B]');
            if (knob) {
                knob.classList.remove('left-0.5', 'bg-white/30');
                knob.classList.add('left-4', 'bg-white');
            }
        } else {
            toggle.classList.remove('bg-[#F6851B]');
            toggle.classList.add('bg-white/10');
            if (knob) {
                knob.classList.remove('left-4', 'bg-white');
                knob.classList.add('left-0.5', 'bg-white/30');
            }
        }
        
        this.currentReadOnly = enabled;
    }

    /**
     * Update UI for read-only channel state
     * Checks actual publish permission from blockchain via Streamr SDK
     * @param {Object} channel - Channel object
     */
    async updateReadOnlyUI(channel) {
        const messageInput = this.elements.messageInput;
        const sendBtn = document.querySelector('#send-btn');
        
        // Get current user address
        const currentAddress = authManager.getAddress();
        
        if (!currentAddress) {
            // No address - disable input
            this.setReadOnlyInputState(true);
            return;
        }

        // Check if we have cached permission for current user (valid for 1 min)
        const cacheValid = channel._publishPermCache?.address?.toLowerCase() === currentAddress.toLowerCase() &&
                          channel._publishPermCache?.timestamp && 
                          (Date.now() - channel._publishPermCache.timestamp) < 60000;
        
        if (cacheValid) {
            const canPublish = channel._publishPermCache.canPublish;
            this.setReadOnlyInputState(!canPublish, canPublish && channel.readOnly);
            return;
        }

        // Default to disabled while checking permission
        this.setReadOnlyInputState(true);

        // Check actual permission from blockchain via Streamr SDK
        try {
            const canPublish = await streamrController.hasPublishPermission(channel.messageStreamId, true);
            
            // Cache the result
            channel._publishPermCache = {
                address: currentAddress,
                canPublish: canPublish,
                timestamp: Date.now()
            };

            // Update UI based on actual permission
            // If channel is read-only and user can publish, show "broadcast" placeholder
            this.setReadOnlyInputState(!canPublish, canPublish && channel.readOnly);
            
            Logger.debug('Permission check via SDK:', {
                channel: channel.name,
                canPublish: canPublish,
                readOnly: channel.readOnly
            });
        } catch (error) {
            Logger.warn('Failed to check publish permission:', error);
            // On error, disable input for safety
            this.setReadOnlyInputState(true);
        }
    }

    /**
     * Helper to set input state for read-only channels
     * @param {boolean} disabled - Whether input should be disabled
     * @param {boolean} canBroadcast - Whether user can broadcast (has publish permission)
     */
    setReadOnlyInputState(disabled, canBroadcast = false) {
        const messageInput = this.elements.messageInput;
        const sendBtn = document.querySelector('#send-btn');
        
        if (disabled) {
            if (messageInput) {
                messageInput.disabled = true;
                messageInput.placeholder = 'This channel is read-only';
                messageInput.classList.add('cursor-not-allowed', 'opacity-50');
            }
            if (sendBtn) {
                sendBtn.disabled = true;
                sendBtn.classList.add('opacity-50', 'cursor-not-allowed');
            }
        } else {
            if (messageInput) {
                messageInput.disabled = false;
                messageInput.placeholder = canBroadcast ? 'Type a message (broadcast)...' : 'Type a message...';
                messageInput.classList.remove('cursor-not-allowed', 'opacity-50');
            }
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
    }

    /**
     * Hide new channel modal
     */
    hideNewChannelModal() {
        modalManager.hideNewChannelModal();
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
     * Show join closed channel modal (with name + classification)
     */
    showJoinClosedChannelModal(streamId = '') {
        modalManager.showJoinClosedChannelModal(streamId);
        this.switchJoinClassificationTab('personal');
    }

    /**
     * Hide join closed channel modal
     */
    hideJoinClosedChannelModal() {
        modalManager.hide('join-closed-channel-modal');
    }

    /**
     * Handle joining a closed channel (with local name + classification)
     */
    async handleJoinClosedChannel() {
        const streamId = document.getElementById('join-closed-stream-id-input')?.value.trim();
        const localName = document.getElementById('join-closed-name-input')?.value.trim();
        const classification = this.joinClassification || 'personal';
        
        if (!streamId) {
            this.showNotification('Please enter a Channel ID', 'error');
            return;
        }
        
        if (!localName) {
            this.showNotification('Please give the channel a name', 'error');
            return;
        }
        
        this.hideJoinClosedChannelModal();
        this.showLoadingToast('Joining channel...', 'Setting up encryption');
        
        try {
            const channel = await channelManager.joinChannel(streamId, null, {
                localName,
                classification
            });
            
            this.hideLoadingToast();
            
            // Clear the quick join input if it has the same ID
            if (this.elements.quickJoinInput?.value.trim() === streamId) {
                this.elements.quickJoinInput.value = '';
                this.updateBrowseJoinButton();
                this.updateQuickJoinHash();
            }
            
            this.renderChannelList();
            
            if (channel) {
                setTimeout(() => this.selectChannel(channel.streamId), 100);
            }
            
            this.showNotification('Joined closed channel!', 'success');
        } catch (error) {
            this.hideLoadingToast();
            this.showNotification('Failed to join: ' + error.message, 'error');
        }
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
            btn.classList.remove('text-[#888]', 'hover:text-white');
            btn.classList.add('text-[#F6851B]', 'hover:text-[#ff9933]', 'border-[#F6851B]/30');
            text.textContent = 'Join';
            // Change icon to chat bubble (message balloon)
            icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>';
        } else {
            // Show "Explore" mode with default styling
            btn.classList.remove('text-[#F6851B]', 'hover:text-[#ff9933]', 'border-[#F6851B]/30');
            btn.classList.add('text-[#888]', 'hover:text-white');
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
     */
    async handleQuickJoin() {
        const streamId = this.elements.quickJoinInput?.value.trim();
        
        if (!streamId) {
            this.showNotification('Please enter a channel ID', 'error');
            return;
        }

        // First check cache, then query The Graph for channel info
        let channelInfo = this.cachedPublicChannels?.find(ch => ch.streamId === streamId);
        
        if (!channelInfo) {
            // Not in cache - query The Graph
            this.showLoading('Checking channel...');
            try {
                channelInfo = await graphAPI.getChannelInfo(streamId);
            } catch (error) {
                Logger.warn('Failed to query channel info:', error);
            }
            this.hideLoading();
        }
        
        // If we know it's a password-protected channel, show password modal
        if (channelInfo?.type === 'password') {
            const password = await this.showPasswordInputModal('Join Password Channel', 
                `Enter password for "${channelInfo.name}":`);
            
            if (!password) {
                return; // User cancelled
            }
            
            try {
                this.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, password, {
                    name: channelInfo.name,
                    type: 'password'
                });
                this.hideLoadingToast();
                
                // Clear the input
                if (this.elements.quickJoinInput) {
                    this.elements.quickJoinInput.value = '';
                    this.updateBrowseJoinButton();
                    this.updateQuickJoinHash();
                }
                
                this.renderChannelList();
                this.showNotification('Joined channel successfully!', 'success');
            } catch (error) {
                this.hideLoadingToast();
                this.showNotification('Failed to join: ' + error.message, 'error');;
            }
            return;
        }
        
        // For native/Closed channels, show the special modal to get name + classification
        if (channelInfo?.type === 'native') {
            this.hideLoading();
            this.showJoinClosedChannelModal(streamId);
            return;
        }

        // For unknown channels or public channels, try direct join
        try {
            this.showLoadingToast('Joining channel...', 'This may take a moment');
            await channelManager.joinChannel(streamId, null, channelInfo ? {
                name: channelInfo.name,
                type: channelInfo.type
            } : undefined);
            this.hideLoadingToast();
            
            // Clear the input
            if (this.elements.quickJoinInput) {
                this.elements.quickJoinInput.value = '';
                this.updateBrowseJoinButton();
                this.updateQuickJoinHash();
            }
            
            this.renderChannelList();
            this.showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            this.hideLoadingToast();
            
            // If channel isn't in cache but might require password, show join modal
            // This happens when we don't have info about the channel
            if (!channelInfo) {
                // Pre-fill the join modal and show it
                if (this.elements.joinStreamIdInput) {
                    this.elements.joinStreamIdInput.value = streamId;
                }
                // Reset password checkbox
                const checkbox = document.getElementById('join-has-password');
                if (checkbox) {
                    checkbox.checked = false;
                    this.elements.joinPasswordField?.classList.add('hidden');
                }
                modalManager.show('join-channel-modal');
                this.showNotification('Enter channel details or check if password is required', 'info');
                
                // Clear quick join input
                if (this.elements.quickJoinInput) {
                    this.elements.quickJoinInput.value = '';
                    this.updateBrowseJoinButton();
                    this.updateQuickJoinHash();
                }
            } else {
                this.showNotification('Failed to join: ' + error.message, 'error');
            }
        }
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
            this.showLoadingToast('Joining channel...', 'This may take a moment');
            await channelManager.joinChannel(streamId, password);
            this.hideLoadingToast();
            this.hideJoinChannelModal();
            this.renderChannelList();
            this.showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            this.hideLoadingToast();
            this.showNotification('Failed to join: ' + error.message, 'error');
        }
    }

    /**
     * Show browse channels modal (uses ModalManager for display)
     */
    async showBrowseChannelsModal() {
        modalManager.show('browse-channels-modal');
        if (this.elements.browseSearchInput) {
            this.elements.browseSearchInput.value = '';
        }
        
        // Reset all filters
        this.browseTypeFilter = 'public';
        this.browseCategoryFilter = '';
        this.browseLanguageFilterValue = 'en';
        
        // Reset language dropdown
        if (this.elements.browseLanguageFilter) {
            this.elements.browseLanguageFilter.value = 'en';
        }
        
        this.updateBrowseFilterTabs();
        this.updateBrowseCategoryChips();
        this.resetCategoriesExpand();
        
        // Load public channels from registry
        await this.loadPublicChannels();
    }

    /**
     * Hide browse channels modal (delegates to ModalManager)
     */
    hideBrowseChannelsModal() {
        modalManager.hide('browse-channels-modal');
    }

    /**
     * Load public channels from registry
     */
    async loadPublicChannels() {
        if (!this.elements.browseChannelsList) return;

        this.elements.browseChannelsList.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-white/40">
                <div class="spinner mb-3" style="width: 28px; height: 28px;"></div>
                <p class="text-sm">Loading channels...</p>
            </div>
        `;

        try {
            const channels = await channelManager.getPublicChannels();
            this.cachedPublicChannels = channels;
            // Apply current filter instead of showing all
            this.filterBrowseChannels(this.elements.browseSearchInput?.value || '');
        } catch (error) {
            Logger.error('Failed to load public channels:', error);
            this.elements.browseChannelsList.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-white/40">
                    <svg class="w-12 h-12 mb-3 text-red-400/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                    </svg>
                    <p class="text-sm">Failed to load channels</p>
                    <p class="text-xs text-white/30 mt-1">${this.escapeHtml(error.message)}</p>
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
                <div class="flex flex-col items-center justify-center py-12 text-white/40">
                    <svg class="w-12 h-12 mb-3 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
                    </svg>
                    <p class="text-sm">No channels found</p>
                    <p class="text-xs text-white/30 mt-1">Try adjusting your filters</p>
                </div>
            `;
            return;
        }
        
        // Category display names
        const categoryNames = {
            politics: 'Politics', news: 'News', tech: 'Tech & AI', crypto: 'Crypto',
            finance: 'Finance', science: 'Science', gaming: 'Gaming', entertainment: 'Entertainment',
            sports: 'Sports', health: 'Health', education: 'Education', comedy: 'Comedy', 
            general: 'General', other: 'Other', nsfw: 'NSFW', adult: 'Adult'
        };
        
        // Language display names
        const languageNames = { 
            en: 'EN', pt: 'PT', es: 'ES', fr: 'FR', de: 'DE', 
            it: 'IT', zh: '中文', ja: '日本語', ko: '한국어', ru: 'RU', ar: 'العربية', other: 'Other'
        };

        this.elements.browseChannelsList.innerHTML = channels.map(ch => {
            const readOnlyBadge = ch.readOnly 
                ? '<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-500/15 text-amber-400/80 text-[9px] font-medium rounded">RO</span>' 
                : '';
            const categoryBadge = ch.category && ch.category !== 'general'
                ? `<span class="px-1.5 py-0.5 bg-white/5 text-white/50 text-[9px] font-medium rounded">${this.escapeHtml(categoryNames[ch.category] || ch.category)}</span>`
                : '';
            const languageBadge = ch.language
                ? `<span class="px-1.5 py-0.5 bg-white/5 text-white/40 text-[9px] font-medium rounded">${this.escapeHtml(languageNames[ch.language] || ch.language.toUpperCase())}</span>`
                : '';
            const description = ch.description 
                ? `<p class="text-xs text-white/40 mt-1 line-clamp-2">${this.escapeHtml(ch.description)}</p>` 
                : '';
            
            return `
            <div class="p-3 bg-white/5 border border-white/5 rounded-xl hover:bg-white/[0.07] hover:border-white/10 transition cursor-pointer browse-channel-item group" data-stream-id="${ch.streamId}" data-type="${ch.type || 'public'}">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <h4 class="text-sm font-medium text-white/90 truncate">${this.escapeHtml(ch.name)}</h4>
                            ${readOnlyBadge}
                        </div>
                        ${description}
                    </div>
                    <svg class="w-4 h-4 text-white/20 group-hover:text-white/40 flex-shrink-0 mt-0.5 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                </div>
                <div class="flex items-center gap-1.5 mt-2">
                    ${categoryBadge}
                    ${languageBadge}
                </div>
            </div>
            `;
        }).join('');

        // Add click listeners to the whole item
        this.elements.browseChannelsList.querySelectorAll('.browse-channel-item').forEach(item => {
            item.addEventListener('click', async () => {
                const streamId = item.dataset.streamId;
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
        if (this.browseTypeFilter) {
            filtered = filtered.filter(ch => ch.type === this.browseTypeFilter);
        }
        
        // Apply category filter
        if (this.browseCategoryFilter) {
            filtered = filtered.filter(ch => ch.category === this.browseCategoryFilter);
        }
        
        // Apply language filter
        if (this.browseLanguageFilterValue) {
            filtered = filtered.filter(ch => ch.language === this.browseLanguageFilterValue);
        }
        
        // Apply search filter
        if (query) {
            const q = query.toLowerCase();
            filtered = filtered.filter(ch => 
                ch.name.toLowerCase().includes(q) ||
                ch.streamId.toLowerCase().includes(q) ||
                (ch.description && ch.description.toLowerCase().includes(q))
            );
        }
        
        this.renderPublicChannelsList(filtered);
    }

    /**
     * Update browse filter tabs UI (sidebar style)
     */
    updateBrowseFilterTabs() {
        document.querySelectorAll('.browse-filter-tab').forEach(tab => {
            const isActive = tab.dataset.browseFilter === this.browseTypeFilter;
            if (isActive) {
                tab.classList.add('bg-white/10', 'text-white');
                tab.classList.remove('text-white/60', 'hover:text-white/90', 'hover:bg-white/5');
            } else {
                tab.classList.remove('bg-white/10', 'text-white');
                tab.classList.add('text-white/60', 'hover:text-white/90', 'hover:bg-white/5');
            }
        });
    }
    
    /**
     * Update browse category chips UI
     */
    updateBrowseCategoryChips() {
        document.querySelectorAll('.browse-category-chip').forEach(chip => {
            const isActive = chip.dataset.category === this.browseCategoryFilter;
            if (isActive) {
                chip.classList.add('bg-white', 'text-black');
                chip.classList.remove('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
            } else {
                chip.classList.remove('bg-white', 'text-black');
                chip.classList.add('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
            }
        });
    }

    /**
     * Toggle category chips expand/collapse
     */
    toggleCategoriesExpand() {
        const container = document.getElementById('browse-category-chips');
        const icon = document.getElementById('toggle-categories-icon');
        const btn = document.getElementById('toggle-categories-btn');
        
        if (!container) return;
        
        const isExpanded = container.dataset.expanded === 'true';
        
        if (isExpanded) {
            // Collapse
            container.classList.add('max-h-[26px]');
            container.classList.remove('max-h-[200px]');
            container.dataset.expanded = 'false';
            icon?.classList.remove('rotate-180');
            btn?.classList.remove('bg-transparent');
        } else {
            // Expand
            container.classList.remove('max-h-[26px]');
            container.classList.add('max-h-[200px]');
            container.dataset.expanded = 'true';
            icon?.classList.add('rotate-180');
            btn?.classList.add('bg-transparent');
        }
    }

    /**
     * Reset category chips to collapsed state
     */
    resetCategoriesExpand() {
        const container = document.getElementById('browse-category-chips');
        const icon = document.getElementById('toggle-categories-icon');
        const btn = document.getElementById('toggle-categories-btn');
        
        if (container) {
            container.classList.add('max-h-[26px]');
            container.classList.remove('max-h-[200px]');
            container.dataset.expanded = 'false';
        }
        icon?.classList.remove('rotate-180');
        btn?.classList.remove('bg-transparent');
    }

    /**
     * Join a public channel from browse/explore
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata (optional, will fallback to cache)
     */
    async joinPublicChannel(streamId, channelInfo = null) {
        try {
            // Use passed channelInfo or fallback to local cache
            const info = channelInfo || this.cachedPublicChannels?.find(ch => ch.streamId === streamId);
            
            // If password-protected, ask for password
            if (info?.type === 'password') {
                const password = await this.showPasswordInputModal('Join Password Channel', 
                    `Enter password for "${info.name}":`);
                
                if (!password) {
                    return; // User cancelled
                }
                
                this.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, password, {
                    name: info?.name,
                    type: 'password',
                    readOnly: info?.readOnly || false,
                    createdBy: info?.createdBy
                });
            } else {
                this.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, null, {
                    name: info?.name,
                    type: info?.type || 'public',
                    readOnly: info?.readOnly || false,
                    createdBy: info?.createdBy
                });
            }
            
            this.hideLoadingToast();
            this.hideBrowseChannelsModal();
            this.renderChannelList();
            this.showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            this.hideLoadingToast();
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
     * Show loading indicator with spinner overlay (delegates to NotificationUI)
     */
    showLoading(message) {
        notificationUI.showLoading(message);
    }

    /**
     * Hide loading indicator (delegates to NotificationUI)
     */
    hideLoading() {
        notificationUI.hideLoading();
    }

    /**
     * Show add contact modal
     */
    showAddContactModal(address) {
        modalManager.showAddContactModal(address);
        this._pendingContactAddress = address;
    }

    /**
     * Hide add contact modal
     */
    hideAddContactModal() {
        modalManager.hideAddContactModal();
        this._pendingContactAddress = null;
    }

    /**
     * Confirm adding contact from modal
     */
    async confirmAddContact() {
        const nicknameInput = document.getElementById('add-contact-modal-nickname');
        const nickname = nicknameInput?.value?.trim() || null;
        const address = this._pendingContactAddress || modalManager.getPendingData('contactAddress');
        
        if (!address) return;
        
        await identityManager.addTrustedContact(address, nickname);
        this.showNotification('Contact added!', 'success');
        this.hideAddContactModal();
    }

    /**
     * Show remove contact confirmation modal
     */
    showRemoveContactModal(address, onRemoveCallback = null) {
        modalManager.showRemoveContactModal(address, onRemoveCallback);
        this._pendingRemoveContactAddress = address;
        this._onRemoveContactCallback = onRemoveCallback;
    }

    /**
     * Hide remove contact modal
     */
    hideRemoveContactModal() {
        modalManager.hideRemoveContactModal();
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
     * Show toast notification (delegates to NotificationUI)
     */
    showNotification(message, type = 'info', duration = 3000) {
        notificationUI.showNotification(message, type, duration);
    }

    /**
     * Show a persistent loading toast notification (delegates to NotificationUI)
     * @returns {HTMLElement} - Toast element (call hideLoadingToast to dismiss)
     */
    showLoadingToast(message, subtitle = 'This may take a moment...') {
        return notificationUI.showLoadingToast(message, subtitle);
    }

    /**
     * Hide the current loading toast (delegates to NotificationUI)
     */
    hideLoadingToast(toast = null) {
        notificationUI.hideLoadingToast(toast);
    }

    /**
     * Get channel type label with icon
     * @param {string} type - Channel type
     * @param {boolean} readOnly - Whether channel is read-only
     * @returns {string} - HTML with icon and label
     */
    getChannelTypeLabel(type, readOnly = false) {
        // Pencil-slash icon for read-only indicator
        const roIcon = readOnly ? '<svg class="w-3 h-3 ml-1 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3l18 18"/></svg>' : '';
        const labels = {
            'public': `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>Open${roIcon}</span>`,
            'password': `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>Protected${roIcon}</span>`,
            'native': `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5l-8 13.5 8 4.5 8-4.5-8-13.5zm0 18l-8-4.5 8 9 8-9-8 4.5z"/></svg>Closed${roIcon}</span>`
        };
        return labels[type] || type;
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

        // Show modal (using ModalManager)
        modalManager.show('invite-users-modal');
    }

    /**
     * Hide invite modal (delegates to ModalManager)
     */
    hideInviteModal() {
        modalManager.hide('invite-users-modal');
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
        this.elements.channelSettingsType.innerHTML = this.getChannelTypeLabel(currentChannel.type, currentChannel.readOnly);
        this.elements.channelSettingsId.textContent = currentChannel.streamId;

        // Determine channel type
        const isNative = currentChannel.type === 'native';
        
        // Use cached DELETE permission if valid for current wallet, else fetch fresh
        const cached = channelManager.getCachedDeletePermission(currentChannel.streamId);
        const canDelete = cached.valid 
            ? cached.canDelete 
            : await streamrController.hasDeletePermission(currentChannel.streamId);
        
        Logger.debug('Channel settings:', { 
            canDelete,
            fromCache: cached.valid,
            currentAddress: authManager.getAddress()?.slice(0,10) 
        });
        
        // Check if user can add members (owner OR has GRANT permission)
        const canAddMembers = isNative ? await channelManager.canAddMembers(currentChannel.streamId) : false;

        // Show/hide non-native message in Info panel
        this.elements.nonNativeMessage.classList.toggle('hidden', isNative);

        // Show/hide members tab button for native channels only
        const membersTabBtn = document.querySelector('[data-channel-tab="members"]');
        membersTabBtn?.classList.toggle('hidden', !isNative);

        // Show/hide members-related elements based on permission to add members
        this.elements.addMemberForm?.classList.toggle('hidden', !canAddMembers);
        this.elements.permissionsSection?.classList.toggle('hidden', !canDelete || !isNative);

        // Clear members list for non-native channels (prevents stale data)
        if (!isNative && this.elements.membersList) {
            this.elements.membersList.innerHTML = '';
        }

        // Initialize channel settings tabs (clones elements, must be before toggling visibility)
        this.initChannelSettingsTabs();
        
        // Re-fetch danger tab elements after cloning (initChannelSettingsTabs replaces DOM elements)
        const dangerTabDivider = document.getElementById('danger-tab-divider');
        const dangerTabBtn = document.getElementById('danger-tab-btn');
        
        // Show/hide danger tab for users with DELETE permission only
        dangerTabDivider?.classList.toggle('hidden', !canDelete);
        dangerTabBtn?.classList.toggle('hidden', !canDelete);

        // Select appropriate starting tab (always info for non-native since members tab is hidden)
        this.selectChannelSettingsTab('info');

        // Show modal (using ModalManager)
        modalManager.show('channel-settings-modal');

        // Load members and permissions if native channel
        if (isNative) {
            await this.loadChannelMembers();
            if (canDelete) {
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
     * Hide channel settings modal (delegates to ModalManager)
     */
    hideChannelSettingsModal() {
        modalManager.hide('channel-settings-modal');
        this.elements.addMemberInput.value = '';
    }

    /**
     * Show delete channel confirmation modal (uses ModalManager for display)
     */
    showDeleteChannelModal() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        this.elements.deleteChannelName.textContent = currentChannel.name;
        modalManager.show('delete-channel-modal');
    }

    /**
     * Hide delete channel confirmation modal (delegates to ModalManager)
     */
    hideDeleteChannelModal() {
        modalManager.hide('delete-channel-modal');
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

            // Remove from subscription manager tracking first
            await subscriptionManager.removeChannel(streamId);

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
                this.showConnectedNoChannelState();
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
            // Remove from subscription manager tracking first
            await subscriptionManager.removeChannel(streamId);
            
            await channelManager.leaveChannel(streamId);
            this.showNotification(`Left "${channelName}"`, 'info');
            
            // Update UI - select first remaining channel or show empty state
            const channels = channelManager.getAllChannels();
            if (channels.length > 0) {
                this.renderChannelList();
                await this.selectChannel(channels[0].streamId);
            } else {
                this.renderChannelList();
                this.showConnectedNoChannelState();
            }
        } catch (error) {
            this.showNotification('Failed to leave channel: ' + error.message, 'error');
        }
    }
    
    /**
     * Handle leave channel - shows confirmation modal
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
     * Handle remove member - shows confirmation modal
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
                const newName = e.target.value;
                await identityManager.setUsername(newName);
                // Also update keystore name for unlock modal display
                authManager.updateWalletName(newName || null);
                this.showNotification('Username updated!', 'success');
            });
        }

        // Copy address from settings
        if (this.elements.copyOwnAddressBtn) {
            this.elements.copyOwnAddressBtn.addEventListener('click', () => this.copyOwnAddress());
        }

        // Refresh balance button
        const refreshBalanceBtn = document.getElementById('refresh-balance-btn');
        if (refreshBalanceBtn) {
            refreshBalanceBtn.addEventListener('click', () => {
                const address = authManager.getAddress();
                this.updateBalanceDisplay(address);
            });
        }

        // Fund with MetaMask button
        const fundMetaMaskBtn = document.getElementById('fund-metamask-btn');
        if (fundMetaMaskBtn) {
            fundMetaMaskBtn.addEventListener('click', () => this.handleFundWithMetaMask());
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

        // Initialize export private key functionality (delegates to SettingsUI)
        settingsUI.initExportPrivateKeyUI();

        // Initialize backup/restore functionality (delegates to SettingsUI)
        settingsUI.initBackupRestoreUI((title, desc, confirm) => this.showPasswordPrompt(title, desc, confirm));

        // Initialize delete account functionality (delegates to SettingsUI)
        settingsUI.initDeleteAccountUI();

        // About button and modal
        const aboutBtn = document.getElementById('about-btn');
        const aboutModal = document.getElementById('about-modal');
        const closeAboutBtn = document.getElementById('close-about-btn');

        if (aboutBtn && aboutModal) {
            aboutBtn.addEventListener('click', () => {
                modalManager.show('about-modal');
            });
        }

        if (closeAboutBtn && aboutModal) {
            closeAboutBtn.addEventListener('click', () => {
                modalManager.hide('about-modal');
            });
            // Close on backdrop click
            aboutModal.addEventListener('click', (e) => {
                if (e.target === aboutModal) {
                    modalManager.hide('about-modal');
                }
            });
        }

        // NSFW toggle
        const nsfwToggle = document.getElementById('nsfw-enabled');
        if (nsfwToggle) {
            nsfwToggle.addEventListener('change', async (e) => {
                await secureStorage.setNsfwEnabled(e.target.checked);
                // Refresh explore view if visible
                const exploreView = document.querySelector('.explore-view');
                if (exploreView) {
                    this.showExploreView();
                }
            });
        }
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

            // Update balance field
            this.updateBalanceDisplay(address);

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

            // Update NSFW toggle state
            const nsfwToggle = document.getElementById('nsfw-enabled');
            if (nsfwToggle) {
                nsfwToggle.checked = secureStorage.getNsfwEnabled();
            }

            // Select first tab by default
            this.selectSettingsTab('profile');

            // Reset private key export UI to step 1
            document.getElementById('export-key-step1')?.classList.remove('hidden');
            document.getElementById('export-key-step2')?.classList.add('hidden');
            const exportKeyPassword = document.getElementById('export-key-password');
            if (exportKeyPassword) exportKeyPassword.value = '';

            // Reset delete account UI to step 1
            document.getElementById('delete-account-step1')?.classList.remove('hidden');
            document.getElementById('delete-account-step2')?.classList.add('hidden');
            const deleteAccountPassword = document.getElementById('delete-account-password');
            if (deleteAccountPassword) deleteAccountPassword.value = '';

            modalManager.show('settings-modal');
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
     * Update POL balance display
     */
    async updateBalanceDisplay(address) {
        const balanceEl = document.getElementById('settings-balance');
        if (!balanceEl) return;
        
        if (!address) {
            balanceEl.textContent = 'Not connected';
            return;
        }
        
        balanceEl.textContent = 'Loading...';
        
        const balanceWei = await GasEstimator.getBalance(address);
        balanceEl.textContent = GasEstimator.formatBalancePOL(balanceWei);
    }

    /**
     * Handle funding from MetaMask
     */
    async handleFundWithMetaMask() {
        const localAddress = authManager.getAddress();
        if (!localAddress) {
            this.showNotification('No account connected', 'error');
            return;
        }

        // Check if MetaMask is available
        if (typeof window.ethereum === 'undefined') {
            this.showNotification('MetaMask not detected. Please install MetaMask.', 'error');
            window.open('https://metamask.io/download/', '_blank');
            return;
        }

        try {
            // Request MetaMask account access
            const accounts = await window.ethereum.request({ 
                method: 'eth_requestAccounts' 
            });
            
            if (!accounts || accounts.length === 0) {
                this.showNotification('MetaMask connection cancelled', 'error');
                return;
            }

            const metamaskAddress = accounts[0];

            // Check if on Polygon network (chainId 137)
            const chainId = await window.ethereum.request({ method: 'eth_chainId' });
            if (chainId !== '0x89') {
                // Try to switch to Polygon
                try {
                    await window.ethereum.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: '0x89' }],
                    });
                } catch (switchError) {
                    // If Polygon not added, add it
                    if (switchError.code === 4902) {
                        await window.ethereum.request({
                            method: 'wallet_addEthereumChain',
                            params: [{
                                chainId: '0x89',
                                chainName: 'Polygon Mainnet',
                                nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
                                rpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://rpc.ankr.com/polygon'],
                                blockExplorerUrls: ['https://polygonscan.com']
                            }],
                        });
                    } else {
                        throw switchError;
                    }
                }
            }

            // Show amount prompt
            const amount = await this.showFundAmountPrompt();
            if (!amount) return;

            // Convert to wei (hex)
            const amountWei = BigInt(Math.floor(parseFloat(amount) * 1e18));
            const amountHex = '0x' + amountWei.toString(16);

            // Send transaction
            this.showNotification('Confirm transaction in MetaMask...', 'info');
            
            const txHash = await window.ethereum.request({
                method: 'eth_sendTransaction',
                params: [{
                    from: metamaskAddress,
                    to: localAddress,
                    value: amountHex,
                }],
            });

            this.showNotification('Transaction sent! Waiting for confirmation...', 'info');

            // Wait for transaction receipt
            let receipt = null;
            while (!receipt) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                receipt = await window.ethereum.request({
                    method: 'eth_getTransactionReceipt',
                    params: [txHash],
                });
            }

            if (receipt.status === '0x1') {
                this.showNotification(`Funded ${amount} POL successfully!`, 'success');
                // Refresh balance
                this.updateBalanceDisplay(localAddress);
            } else {
                this.showNotification('Transaction failed', 'error');
            }

        } catch (error) {
            Logger.error('MetaMask funding error:', error);
            if (error.code === 4001) {
                this.showNotification('Transaction cancelled', 'error');
            } else {
                this.showNotification('Error: ' + (error.message || 'Unknown error'), 'error');
            }
        }
    }

    /**
     * Show amount prompt for MetaMask funding
     */
    async showFundAmountPrompt() {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl w-[320px] overflow-hidden shadow-2xl border border-[#222]">
                    <div class="px-5 pt-5 pb-4">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">Fund Account</h3>
                            <button id="close-fund-modal" class="text-[#666] hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div class="px-5 pb-5">
                        <input
                            type="number"
                            id="fund-amount"
                            placeholder="Amount in POL"
                            step="1"
                            min="1"
                            class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-[#8247E5]/50 transition placeholder:text-white/30 mb-3"
                        />
                        <div class="flex gap-2 mb-4">
                            <button class="fund-preset flex-1 bg-white/5 hover:bg-white/10 text-white/60 px-2 py-1.5 rounded-lg text-xs transition whitespace-nowrap" data-amount="5">5 POL</button>
                            <button class="fund-preset flex-1 bg-white/5 hover:bg-white/10 text-white/60 px-2 py-1.5 rounded-lg text-xs transition whitespace-nowrap" data-amount="10">10 POL</button>
                            <button class="fund-preset flex-1 bg-white/5 hover:bg-white/10 text-white/60 px-2 py-1.5 rounded-lg text-xs transition whitespace-nowrap" data-amount="15">15 POL</button>
                            <button class="fund-preset flex-1 bg-white/5 hover:bg-white/10 text-white/60 px-2 py-1.5 rounded-lg text-xs transition whitespace-nowrap" data-amount="20">20 POL</button>
                        </div>
                        <button id="confirm-fund-btn" class="w-full bg-[#F6851B]/10 hover:bg-[#F6851B]/20 text-[#F6851B] border border-[#F6851B]/30 px-4 py-3 rounded-xl text-sm font-medium transition flex items-center justify-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"/></svg>
                            Continue to MetaMask
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const amountInput = modal.querySelector('#fund-amount');
            const confirmBtn = modal.querySelector('#confirm-fund-btn');
            const closeBtn = modal.querySelector('#close-fund-modal');
            const presetBtns = modal.querySelectorAll('.fund-preset');

            const cleanup = (result) => {
                modal.remove();
                resolve(result);
            };

            // Preset buttons - fill input
            presetBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    amountInput.value = btn.dataset.amount;
                    amountInput.focus();
                });
            });

            // Confirm amount
            confirmBtn.addEventListener('click', () => {
                const amount = parseFloat(amountInput.value);
                if (!amount || amount <= 0) {
                    amountInput.classList.add('border-red-500/50');
                    return;
                }
                cleanup(amountInput.value);
            });

            // Enter key on input
            amountInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    confirmBtn.click();
                }
            });

            // Close
            closeBtn.addEventListener('click', () => cleanup(null));
            modal.addEventListener('click', (e) => {
                if (e.target === modal) cleanup(null);
            });

            // Focus input
            setTimeout(() => amountInput.focus(), 100);
        });
    }

    /**
     * Hide settings modal (delegates to ModalManager)
     */
    hideSettingsModal() {
        modalManager.hide('settings-modal');
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
     * Show contacts modal (uses ModalManager for display)
     */
    showContactsModal() {
        if (!this.elements.contactsModal) {
            this.initContactsUI();
        }
        this.renderContactsList();
        modalManager.show('contacts-modal');
    }

    /**
     * Hide contacts modal (delegates to ModalManager)
     */
    hideContactsModal() {
        modalManager.hide('contacts-modal');
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
