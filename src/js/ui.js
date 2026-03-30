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
import { historyManager } from './historyManager.js';
import { relayManager } from './relayManager.js';
import { dmManager } from './dm.js';

// UI Modules
import { notificationUI } from './ui/NotificationUI.js';
import { sanitizeText } from './ui/sanitizer.js';
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
import { channelSettingsUI } from './ui/ChannelSettingsUI.js';
import { contactsUI } from './ui/ContactsUI.js';
import { channelListUI } from './ui/ChannelListUI.js';
import { chatAreaUI } from './ui/ChatAreaUI.js';
import { inputUI } from './ui/InputUI.js';
import { headerUI } from './ui/HeaderUI.js';
import { previewModeUI } from './ui/PreviewModeUI.js';
import { channelModalsUI } from './ui/ChannelModalsUI.js';
import { dmModalsUI } from './ui/DMModalsUI.js';
import { init as initJoinChannelUI, getInstance as getJoinChannelUI } from './ui/JoinChannelUI.js';
import { inviteUI } from './ui/InviteUI.js';
import { channelViewUI } from './ui/ChannelViewUI.js';

class UIController {
    constructor() {
        this.elements = {};
        
        // Reply state (kept for backward compatibility, synced with ChatAreaUI)
        this.replyingTo = null; // { id, text, sender, senderName }
        
        // Channel filter state (sidebar tabs: all/personal/community)
        this.currentChannelFilter = 'all';
        this.isFilterAnimating = false; // Prevent rapid swipes
        
        // Preview mode state - handled by previewModeUI module
        
        // Setup callbacks for UI modules
        this._setupModuleCallbacks();
    }

    /**
     * Get the currently active channel (preview or joined)
     * @returns {Object|null} Channel object or null
     */
    getActiveChannel() {
        return previewModeUI.getPreviewChannel() || channelManager.getCurrentChannel();
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
                } else if (previewModeUI.isInPreviewMode()) {
                    // Preview mode: send reaction directly via streamrController
                    previewModeUI.sendPreviewReaction(msgId, emoji, isRemoving);
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
        mediaHandler.initLightboxModal();
        
        // MessageRenderer
        messageRenderer.setDependencies({
            getCurrentAddress: () => authManager.getAddress(),
            getMessageReactions: (msgId) => reactionManager.getReactions(msgId),
            registerMedia: (url, type) => mediaHandler.registerMedia(url, type),
            getImage: (imageId) => mediaController.getImage(imageId),
            cacheImage: (imageId, data) => mediaController.cacheImage(imageId, data),
            loadImageFromLedger: (imageId) => {
                secureStorage.getImageBlob(imageId).then(data => {
                    if (data) {
                        mediaController.handleImageData({ type: 'image_data', imageId, data });
                    }
                }).catch(() => {});
            },
            getCurrentChannel: () => this.getActiveChannel(),
            getFileUrl: (fileId) => mediaController.getFileUrl(fileId),
            isSeeding: (fileId) => mediaController.isSeeding(fileId),
            isDownloading: (fileId) => mediaController.isDownloading(fileId),
            getDownloadProgress: (fileId) => mediaController.getDownloadProgress(fileId),
            isVideoPlayable: (fileType) => mediaController.isVideoPlayable(fileType),
            getYouTubeEmbedsEnabled: () => secureStorage.getYouTubeEmbedsEnabled()
        });
        
        // SettingsUI - All settings functionality
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
            notificationManager,
            relayManager,
            notificationUI,
            contactsUI,
            dmManager,
            showNotification: (msg, type) => this.showNotification(msg, type),
            updateWalletInfo: (address, isGuest) => headerUI.updateWalletInfo(address, isGuest),
            updateDisplayName: (username) => headerUI.updateDisplayName(username),
            updateNetworkStatus: (status, connected) => headerUI.updateNetworkStatus(status, connected),
            renderChannelList: () => this.renderChannelList(),
            resetToDisconnectedState: () => this.resetToDisconnectedState(),
            isMobileView: () => this.isMobileView(),
            showExploreView: () => this.showExploreView()
        });
        
        // ExploreUI
        exploreUI.setDependencies({
            getPublicChannels: () => channelManager.getPublicChannels(),
            joinPublicChannel: (streamId, channelInfo) => this.joinPublicChannel(streamId, channelInfo),
            enterPreviewMode: (streamId, channelInfo) => previewModeUI.enterPreviewMode(streamId, channelInfo),
            getNsfwEnabled: () => secureStorage.getNsfwEnabled()
        });
        
        // ChannelSettingsUI
        channelSettingsUI.setDependencies({
            channelManager,
            streamrController,
            authManager,
            subscriptionManager,
            showNotification: (msg, type) => this.showNotification(msg, type),
            showLoading: (msg) => this.showLoading(msg),
            hideLoading: () => this.hideLoading(),
            getChannelTypeLabel: (type, readOnly, showLabel) => headerUI.getChannelTypeLabel(type, readOnly, showLabel),
            renderChannelList: () => this.renderChannelList(),
            selectChannel: (streamId) => this.selectChannel(streamId),
            showConnectedNoChannelState: () => this.showConnectedNoChannelState(),
            getActiveChannel: () => this.getActiveChannel(),
            isInPreviewMode: () => previewModeUI.isInPreviewMode()
        });
        
        // ContactsUI
        contactsUI.setDependencies({
            identityManager,
            Logger,
            settingsUI,
            channelManager,
            secureStorage,
            showNotification: (msg, type) => this.showNotification(msg, type),
            showLoading: (msg) => this.showLoading(msg),
            hideLoading: () => this.hideLoading(),
            renderChannelList: () => this.renderChannelList(),
            selectChannel: (streamId) => this.selectChannel(streamId),
            showConnectedNoChannelState: () => this.showConnectedNoChannelState()
        });

        // ChannelListUI
        channelListUI.setDependencies({
            channelManager,
            secureStorage,
            onChannelSelect: (streamId) => this.selectChannel(streamId)
        });

        // ChannelModalsUI
        channelModalsUI.setDependencies({
            channelManager,
            modalManager,
            notificationUI,
            Logger,
            showNotification: (msg, type) => this.showNotification(msg, type),
            renderChannelList: () => this.renderChannelList(),
            selectChannel: (streamId) => this.selectChannel(streamId),
            updateQuickJoinHash: () => this.updateQuickJoinHash(),
            updateBrowseJoinButton: () => this.updateBrowseJoinButton()
        });

        // DMModalsUI
        dmModalsUI.setDependencies({
            dmManager,
            modalManager,
            authManager,
            notificationUI,
            Logger,
            showNotification: (msg, type) => this.showNotification(msg, type),
            renderChannelList: () => this.renderChannelList()
        });
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
            switchWalletBtn: document.getElementById('switch-wallet'),
            contactsBtn: document.getElementById('contacts-btn'),
            // Desktop account dropdown
            desktopAccountWrapper: document.getElementById('desktop-account-wrapper'),
            desktopAccountBtn: document.getElementById('desktop-account-btn'),
            desktopAccountAvatar: document.getElementById('desktop-account-avatar'),
            desktopAccountName: document.getElementById('desktop-account-name'),
            desktopAccountDropdown: document.getElementById('desktop-account-dropdown'),
            desktopDropdownAddress: document.getElementById('desktop-dropdown-address'),

            // Sidebar
            channelList: document.getElementById('channel-list'),
            newChannelBtn: document.getElementById('new-channel-btn'),

            // Chat area
            chatHeader: document.getElementById('chat-header'),
            currentChannelName: document.getElementById('current-channel-name'),
            currentChannelInfo: document.getElementById('current-channel-info'),
            channelMenuBtn: document.getElementById('channel-menu-btn'),
            channelMenuBtnMobile: document.getElementById('channel-menu-btn-mobile'),
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

            // Join button (preview mode)
            joinChannelBtn: document.getElementById('join-channel-btn'),
            
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
            channelSettingsType: document.getElementById('channel-settings-type'),
            channelSettingsId: document.getElementById('channel-settings-id'),
            channelSettingsName: document.getElementById('channel-settings-name'),
            channelNameSection: document.getElementById('channel-name-section'),
            editChannelNameBtn: document.getElementById('edit-channel-name-btn'),
            channelNameEditContainer: document.getElementById('channel-name-edit-container'),
            channelSettingsNameInput: document.getElementById('channel-settings-name-input'),
            saveChannelNameBtn: document.getElementById('save-channel-name-btn'),
            cancelChannelNameBtn: document.getElementById('cancel-channel-name-btn'),
            copyStreamIdBtn: document.getElementById('copy-stream-id-btn'),
            membersSection: document.getElementById('members-section'),
            nonNativeMessage: document.getElementById('non-native-message'),
            channelDescriptionDisplay: document.getElementById('channel-description-display'),
            channelStorageProvider: document.getElementById('channel-storage-provider'),
            channelStorageNode: document.getElementById('channel-storage-node'),
            channelStorageRetention: document.getElementById('channel-storage-retention'),
            channelStorageNoStorage: document.getElementById('channel-storage-no-storage'),
            copyStorageNodeBtn: document.getElementById('copy-storage-node-btn'),
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
            
            // Reply UI
            replyBar: document.getElementById('reply-bar'),
            replyToName: document.getElementById('reply-to-name'),
            replyToText: document.getElementById('reply-to-text'),
            replyBarClose: document.getElementById('reply-bar-close'),

            // Mobile navigation
            sidebar: document.getElementById('sidebar'),
            chatArea: document.getElementById('chat-area'),
            closeChannelBtnDesktop: document.getElementById('close-channel-btn-desktop'),
            chatHeaderRight: document.getElementById('chat-header-right'),
            
            // Explore type tabs
            exploreTypeTabs: document.getElementById('explore-type-tabs')
        };

        // Set element references for UI modules
        channelSettingsUI.setElements(this.elements);
        contactsUI.setElements(this.elements);
        channelListUI.setElements(this.elements);
        channelModalsUI.setElements(this.elements);
        
        // Initialize JoinChannelUI with dependencies
        this.joinChannelUI = initJoinChannelUI({
            channelManager,
            modalManager,
            notificationUI,
            graphAPI,
            exploreUI,
            channelModalsUI,
            elements: this.elements
        });

        // Initialize InviteUI with dependencies
        inviteUI.setDependencies({
            channelManager,
            modalManager,
            showNotification: (msg, type, duration) => this.showNotification(msg, type, duration),
            showLoading: (msg) => this.showLoading(msg),
            hideLoading: () => this.hideLoading(),
            generateQRCode: (link) => this.generateQRCode(link)
        });
        inviteUI.setElements(this.elements);

        // Initialize ChannelViewUI with dependencies
        channelViewUI.setDependencies({
            channelManager,
            subscriptionManager,
            secureStorage,
            historyManager,
            previewModeUI,
            chatAreaUI,
            headerUI,
            reactionManager,
            mediaHandler,
            onlineUsersUI,
            exploreUI,
            inputUI,
            // Callbacks to UIController
            stopAccessHeartbeat: () => this.stopAccessHeartbeat(),
            startAccessHeartbeat: (streamId) => this.startAccessHeartbeat(streamId),
            setReplyingTo: (val) => { this.replyingTo = val; },
            updateReadOnlyUI: (channel) => this.updateReadOnlyUI(channel),
            attachReactionListeners: () => this.attachReactionListeners(),
            renderChannelList: () => this.renderChannelList(),
            openChatView: () => this.openChatView(),
            showExploreView: () => this.showExploreView(),
            isMobileView: () => this.isMobileView()
        });
        channelViewUI.setElements(this.elements);
        
        // Initialize ChatAreaUI with dependencies and elements
        chatAreaUI.setDependencies({
            channelManager,
            authManager,
            secureStorage,
            Logger,
            getActiveChannel: () => this.getActiveChannel()
        });
        chatAreaUI.init({
            messagesArea: this.elements.messagesArea,
            replyBar: this.elements.replyBar,
            replyToName: this.elements.replyToName,
            replyToText: this.elements.replyToText,
            messageInput: this.elements.messageInput
        });

        // Initialize InputUI with dependencies and elements
        inputUI.setDependencies({
            channelManager,
            mediaController,
            Logger,
            showNotification: (msg, type) => this.showNotification(msg, type),
            showLoading: (msg) => this.showLoading(msg),
            hideLoading: () => this.hideLoading()
        });
        inputUI.init({
            messageInput: this.elements.messageInput,
            sendMessageBtn: this.elements.sendMessageBtn
        });

        // Initialize HeaderUI with elements
        headerUI.init({
            walletInfo: this.elements.walletInfo,
            connectWalletBtn: this.elements.connectWalletBtn,
            switchWalletBtn: this.elements.switchWalletBtn,
            contactsBtn: this.elements.contactsBtn,
            settingsBtn: document.getElementById('settings-btn'),
            currentChannelName: this.elements.currentChannelName,
            currentChannelInfo: this.elements.currentChannelInfo,
            chatHeaderRight: this.elements.chatHeaderRight,
            desktopAccountWrapper: this.elements.desktopAccountWrapper,
            desktopAccountBtn: this.elements.desktopAccountBtn,
            desktopAccountAvatar: this.elements.desktopAccountAvatar,
            desktopAccountName: this.elements.desktopAccountName,
            desktopAccountDropdown: this.elements.desktopAccountDropdown,
            desktopDropdownAddress: this.elements.desktopDropdownAddress
        });

        // Initialize PreviewModeUI with dependencies
        previewModeUI.setDependencies({
            channelManager,
            subscriptionManager,
            graphAPI,
            reactionManager,
            chatAreaUI,
            headerUI,
            mediaHandler,
            identityManager,
            authManager,
            streamrController,
            notificationUI,
            historyManager
        });
        previewModeUI.setUIController({
            elements: this.elements,
            selectChannel: (streamId) => this.selectChannel(streamId),
            selectChannelWithoutHistory: (streamId) => this._selectChannelWithoutHistory(streamId),
            openExploreView: () => this.openExploreView(),
            openChatView: () => this.openChatView(),
            showNotification: (msg, type) => this.showNotification(msg, type),
            attachReactionListeners: () => this.attachReactionListeners(),
            renderChannelList: () => this.renderChannelList()
        });

        // Set up event listeners
        this.setupEventListeners();
        
        // Register activity handler for background channel updates
        this.setupActivityHandler();
        
        // Setup heartbeat for tracking channel access (handles abrupt app closure)
        this.setupAccessHeartbeat();
        
        // Initialize history manager for browser back/forward navigation
        historyManager.init((state) => this.navigateToState(state));

        Logger.info('UI Controller initialized');
    }
    
    /**
     * Setup heartbeat system for tracking channel access
     * This ensures lastAccess is saved even if app closes abruptly
     */
    setupAccessHeartbeat() {
        // Heartbeat interval (15 seconds)
        this.HEARTBEAT_INTERVAL = 15000;
        this.heartbeatTimer = null;
        
        // Save access on page unload (best effort)
        window.addEventListener('beforeunload', () => {
            this.saveCurrentChannelAccess();
        });
        
        // Save access when tab becomes hidden (user switches tabs)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.saveCurrentChannelAccess();
            }
        });
        
        // Save access on page hide (mobile browsers)
        window.addEventListener('pagehide', () => {
            this.saveCurrentChannelAccess();
        });
    }
    
    /**
     * Start heartbeat for current channel
     * @param {string} streamId - Channel stream ID
     */
    startAccessHeartbeat(streamId) {
        this.stopAccessHeartbeat();
        this.heartbeatStreamId = streamId;
        
        // Save immediately when entering channel
        secureStorage.setChannelLastAccess(streamId, Date.now());
        
        // Then save periodically
        this.heartbeatTimer = setInterval(() => {
            if (this.heartbeatStreamId) {
                secureStorage.setChannelLastAccess(this.heartbeatStreamId, Date.now());
            }
        }, this.HEARTBEAT_INTERVAL);
    }
    
    /**
     * Stop heartbeat and save final access time
     */
    stopAccessHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        // Save final access time
        if (this.heartbeatStreamId) {
            secureStorage.setChannelLastAccess(this.heartbeatStreamId, Date.now());
            this.heartbeatStreamId = null;
        }
    }
    
    /**
     * Save current channel access (for emergency saves on unload/hide)
     */
    saveCurrentChannelAccess() {
        const currentChannel = channelManager.getCurrentChannel();
        if (currentChannel) {
            // Use synchronous localStorage directly for reliability during unload
            const key = `pombo_channel_access_${currentChannel.streamId}`;
            localStorage.setItem(key, Date.now().toString());
        }
    }
    
    /**
     * Setup handler for background channel activity updates
     * Updates unread badges when new messages are detected in background channels
     */
    setupActivityHandler() {
        // Wire preview message callback (avoids circular dependency with subscriptionManager)
        subscriptionManager.onPreviewMessage = (msg) => this.handlePreviewMessage(msg);
        
        subscriptionManager.onActivity((streamId, activity) => {
            Logger.debug('Background activity update:', streamId, activity);
            
            // Update unread badge in sidebar
            const countEl = document.querySelector(`[data-channel-count="${CSS.escape(streamId)}"]`);
            if (countEl && activity.unreadCount > 0) {
                countEl.textContent = activity.unreadCount >= 30 ? '+30' : activity.unreadCount;
                countEl.classList.remove('hidden', 'text-white/30', 'bg-white/[0.04]');
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
            channelModalsUI.show();
        });

        // Channel type tabs - switch between tab content
        document.querySelectorAll('.channel-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabType = tab.dataset.tab;
                channelModalsUI.switchChannelTab(tabType);
            });
        });

        // Visibility toggle - switch between hidden/visible
        document.getElementById('visibility-toggle')?.addEventListener('click', () => {
            channelModalsUI.toggleVisibility();
        });

        // Classification tabs (for Closed channels) - switch between personal/community
        document.querySelectorAll('.classification-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                channelModalsUI.switchClassificationTab(tab.dataset.classification);
            });
        });

        // Join classification tabs (in join-closed-channel modal)
        document.querySelectorAll('.join-classification-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                channelModalsUI.switchJoinClassificationTab(tab.dataset.joinClassification);
            });
        });

        // Channel filter tabs (sidebar: All/Personal/Communities)
        document.querySelectorAll('.channel-filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchChannelFilterTab(tab.dataset.channelFilter);
            });
        });

        // Mobile swipe gestures for channel filter tabs
        this.initChannelFilterSwipe();

        // Read-only toggle
        const readOnlyToggle = document.getElementById('read-only-toggle');
        readOnlyToggle?.addEventListener('click', () => {
            channelModalsUI.toggleReadOnly();
        });

        // Storage provider tabs
        document.querySelectorAll('.storage-provider-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                channelModalsUI.selectStorageProvider(tab.dataset.storage);
            });
        });

        // Storage days slider
        const storageDaysSlider = document.getElementById('storage-days-input');
        storageDaysSlider?.addEventListener('input', () => {
            channelModalsUI.updateStorageDaysDisplay(storageDaysSlider.value);
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
            channelModalsUI.handleCreate();
        });

        // Cancel channel creation
        this.elements.cancelChannelBtn.addEventListener('click', () => {
            channelModalsUI.hide();
        });

        // Footer cancel button (new design)
        document.getElementById('cancel-channel-btn-footer')?.addEventListener('click', () => {
            channelModalsUI.hide();
        });

        // Channel types info modal
        document.querySelectorAll('.channel-info-help-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modalManager.show('channel-types-modal');
            });
        });
        document.getElementById('close-channel-types-btn')?.addEventListener('click', () => {
            modalManager.hide('channel-types-modal');
        });
        document.getElementById('close-channel-types-btn-footer')?.addEventListener('click', () => {
            modalManager.hide('channel-types-modal');
        });

        // Storage info modal
        document.querySelectorAll('.storage-learn-more-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modalManager.show('storage-info-modal');
            });
        });
        document.getElementById('close-storage-info-btn')?.addEventListener('click', () => {
            modalManager.hide('storage-info-modal');
        });
        document.getElementById('close-storage-info-btn-footer')?.addEventListener('click', () => {
            modalManager.hide('storage-info-modal');
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
                // No input: show Explore (unified for mobile/desktop)
                this.openExploreView();
            }
        });

        // Quick Join modal (mobile pill) - Enter to join
        const quickJoinModalInput = document.getElementById('quick-join-modal-input');
        const quickJoinModal = document.getElementById('quick-join-modal');
        quickJoinModalInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this._handleQuickJoinModal();
            }
        });
        document.getElementById('confirm-quick-join-modal')?.addEventListener('click', () => {
            this._handleQuickJoinModal();
        });
        document.getElementById('cancel-quick-join-modal')?.addEventListener('click', () => {
            quickJoinModal?.classList.add('hidden');
        });
        // Close on backdrop click
        quickJoinModal?.addEventListener('click', (e) => {
            if (e.target === quickJoinModal) quickJoinModal.classList.add('hidden');
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
            channelModalsUI.handleJoinClosedChannel();
        });
        document.getElementById('cancel-join-closed-btn')?.addEventListener('click', () => {
            channelModalsUI.hideJoinClosedModal();
        });
        
        // Switch from normal join to closed join modal
        document.getElementById('switch-to-closed-join-btn')?.addEventListener('click', () => {
            const streamId = this.elements.joinStreamIdInput?.value.trim() || '';
            this.hideJoinChannelModal();
            channelModalsUI.showJoinClosedModal(streamId);
        });

        // Join password toggle
        const joinHasPassword = document.getElementById('join-has-password');
        joinHasPassword?.addEventListener('change', (e) => {
            this.elements.joinPasswordField?.classList.toggle('hidden', !e.target.checked);
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
                chatAreaUI.cancelReply();
                this.replyingTo = null;
            }
        });
        
        // Reply bar close button
        this.elements.replyBarClose?.addEventListener('click', () => {
            chatAreaUI.cancelReply();
            this.replyingTo = null;
        });

        // Lazy loading - scroll to top loads more history
        this.elements.messagesArea?.addEventListener('scroll', () => {
            chatAreaUI.handleMessagesScroll();
        });
        
        // Mobile: tap on message to show reply/react buttons
        this.elements.messagesArea?.addEventListener('click', (e) => {
            const messageEntry = e.target.closest('.message-entry');
            const isActionButton = e.target.closest('.reply-trigger, .react-trigger, .reaction-badge');
            
            // Don't toggle when clicking action buttons
            if (isActionButton) return;
            
            // Clear any previously active message
            document.querySelectorAll('.message-entry.message-active').forEach(el => {
                if (el !== messageEntry) {
                    el.classList.remove('message-active');
                }
            });
            
            // Toggle active state on tapped message
            if (messageEntry) {
                messageEntry.classList.toggle('message-active');
            }
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

        // Join channel button (preview mode)
        this.elements.joinChannelBtn?.addEventListener('click', () => {
            previewModeUI.addPreviewToList();
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
                contactsUI.show();
            });
        }

        // Channel menu button (dropdown)
        if (this.elements.channelMenuBtn) {
            this.elements.channelMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showChannelDropdown(e);
            });
        }

        // Mobile channel menu button (kebab - same action as chevron)
        if (this.elements.channelMenuBtnMobile) {
            this.elements.channelMenuBtnMobile.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showChannelDropdown(e);
            });
        }

        // Close channel button (X) - handles both mobile (left) and desktop (right) buttons
        if (this.elements.closeChannelBtn) {
            this.elements.closeChannelBtn.addEventListener('click', async () => {
                // Mobile: always go back to sidebar (channel list)
                const currentChannel = channelManager.getCurrentChannel();
                if (currentChannel) {
                    await this.deselectChannel();
                }
                this.closeChatView();
            });
        }
        
        // Desktop close channel button
        if (this.elements.closeChannelBtnDesktop) {
            this.elements.closeChannelBtnDesktop.addEventListener('click', async () => {
                await this.deselectChannel();
            });
        }

        // Close channel settings modal
        if (this.elements.closeChannelSettingsBtn) {
            this.elements.closeChannelSettingsBtn.addEventListener('click', () => {
                this.hideChannelSettingsModal();
            });
        }

        // Click outside channel settings modal to close (desktop only - on mobile it's a full-screen container)
        if (this.elements.channelSettingsModal) {
            this.elements.channelSettingsModal.addEventListener('click', (e) => {
                if (e.target === this.elements.channelSettingsModal && !this.isMobileView()) {
                    this.hideChannelSettingsModal();
                }
            });
        }

        // Refresh members button
        if (this.elements.refreshMembersBtn) {
            this.elements.refreshMembersBtn.addEventListener('click', () => {
                channelSettingsUI.loadMembers();
            });
        }

        // Refresh permissions button
        if (this.elements.refreshPermissionsBtn) {
            this.elements.refreshPermissionsBtn.addEventListener('click', () => {
                channelSettingsUI.loadPermissions();
            });
        }

        // Add member button
        if (this.elements.addMemberBtn) {
            this.elements.addMemberBtn.addEventListener('click', () => {
                channelSettingsUI.handleAddMember();
            });
        }

        // Batch add members button
        if (this.elements.batchAddMembersBtn) {
            this.elements.batchAddMembersBtn.addEventListener('click', () => {
                channelSettingsUI.handleBatchAddMembers();
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

        // Copy storage node address button
        if (this.elements.copyStorageNodeBtn) {
            this.elements.copyStorageNodeBtn.addEventListener('click', async () => {
                const nodeAddress = this.elements.channelStorageNode?.textContent;
                if (nodeAddress && nodeAddress !== '-' && nodeAddress !== 'Streamr Network Storage') {
                    try {
                        await navigator.clipboard.writeText(nodeAddress);
                        this.showNotification('Node address copied!', 'success');
                    } catch {
                        this.showNotification('Failed to copy', 'error');
                    }
                }
            });
        }

        // Delete channel button
        if (this.elements.deleteChannelBtn) {
            this.elements.deleteChannelBtn.addEventListener('click', () => {
                channelSettingsUI.showDeleteModal();
            });
        }

        // Cancel delete button
        if (this.elements.cancelDeleteBtn) {
            this.elements.cancelDeleteBtn.addEventListener('click', () => {
                channelSettingsUI.hideDeleteModal();
            });
        }

        // Confirm delete button
        if (this.elements.confirmDeleteBtn) {
            this.elements.confirmDeleteBtn.addEventListener('click', () => {
                channelSettingsUI.handleDelete();
            });
        }

        // Click outside delete modal to close
        if (this.elements.deleteChannelModal) {
            this.elements.deleteChannelModal.addEventListener('click', (e) => {
                if (e.target === this.elements.deleteChannelModal) {
                    channelSettingsUI.hideDeleteModal();
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
                    channelSettingsUI.handleAddMember();
                }
            });
        }

        // Initialize contacts UI
        contactsUI.init();

        // Initialize DM modals UI
        dmModalsUI.init();
        
        // Initialize settings UI (delegates to SettingsUI)
        settingsUI.init();
        
        // Initialize emoji picker
        this.initEmojiPicker();
        
        // Initialize attach button (delegates to InputUI)
        inputUI.initAttachButton();
        
        // Setup media controller handlers
        this.setupMediaHandlers();
        
        // Initialize reactions
        reactionManager.init();
    }

    /**
     * Render channel list (delegates to ChannelListUI)
     */
    renderChannelList() {
        channelListUI.setFilter(this.currentChannelFilter);
        channelListUI.render();
        // Update DM sidebar buttons visibility
        dmModalsUI.updateVisibility();
    }

    /**
     * Select and open a channel (delegates to ChannelViewUI)
     * @param {string} streamId - Stream ID
     */
    async selectChannel(streamId) {
        return channelViewUI.selectChannel(streamId, { pushHistory: true });
    }

    /**
     * Deselect current channel (delegates to ChannelViewUI)
     */
    async deselectChannel() {
        return channelViewUI.deselectChannel();
    }

    /**
     * Reset UI to disconnected state
     */
    resetToDisconnectedState() {
        // Clear typing indicator
        chatAreaUI.hideTypingIndicator();
        
        // Reset sending state
        inputUI.setIsSending(false);
        
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
        this.elements.channelMenuBtnMobile?.classList.add('hidden');
        this.elements.closeChannelBtn?.classList.add('hidden');
        this.elements.closeChannelBtnDesktop?.classList.add('hidden');
        this.elements.onlineHeader?.classList.add('hidden');
        this.elements.onlineHeader?.classList.remove('flex');
        this.elements.onlineSeparator?.classList.add('hidden');
        
        // Reset online users list
        if (this.elements.onlineUsersList) {
            this.elements.onlineUsersList.innerHTML = '<div class="text-white/30 text-sm text-center">No one online</div>';
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
     * Open Explore view (unified for mobile/desktop)
     * Mobile: navigates to chat-area with Explore
     * Desktop: shows Explore inline
     */
    async openExploreView() {
        // Deselect any current channel first
        channelManager.setCurrentChannel(null);
        
        // Mobile: open chat area to show Explore
        this.openChatView();
        
        // Show Explore view
        await this.showExploreView();
        
        // Remove selection highlight from channel list
        document.querySelectorAll('.channel-item').forEach(item => {
            item.classList.remove('bg-white/[0.06]');
        });
        
        // Push to browser history
        historyManager.pushState({ view: 'explore' });
    }

    /**
     * Navigate to a state (called by historyManager on popstate)
     * Does not push to history - used for back/forward navigation
     * @param {Object} state - State object { view, streamId?, channelInfo? }
     */
    async navigateToState(state) {
        if (!state || !state.view) {
            // Clear any preview state first
            if (previewModeUI.isInPreviewMode()) {
                await previewModeUI.exitPreviewMode(false);
            }
            
            // On mobile, go back to sidebar; on desktop, show explore
            if (this.isMobileView()) {
                this.closeChatView();
            } else {
                await this.showExploreView();
            }
            return;
        }

        Logger.debug('Navigating to state:', state);

        switch (state.view) {
            case 'channel':
                if (state.streamId) {
                    // Check if channel is in user's list
                    const channel = channelManager.getChannel(state.streamId);
                    if (channel) {
                        await this._selectChannelWithoutHistory(state.streamId);
                    } else {
                        // Channel not in list - clear preview and go back
                        if (previewModeUI.isInPreviewMode()) {
                            await previewModeUI.exitPreviewMode(false);
                        }
                        
                        // Go back to explore/sidebar
                        if (this.isMobileView()) {
                            this.closeChatView();
                        } else {
                            await this.showExploreView();
                        }
                        this.showNotification('Channel not found in your list', 'warning');
                    }
                }
                break;

            case 'preview':
                if (state.streamId) {
                    await previewModeUI.enterPreviewWithoutHistory(state.streamId, state.channelInfo);
                }
                break;

            case 'explore':
            default:
                // Clear preview state if active
                if (previewModeUI.isInPreviewMode()) {
                    await previewModeUI.exitPreviewMode(false);
                }
                
                // On mobile, back to explore means close chat view (show sidebar)
                // User can then click Explore button if they want explore view
                if (this.isMobileView()) {
                    this.closeChatView();
                } else {
                    await this.showExploreView();
                }
                break;
        }
    }

    /**
     * Process initial URL on app load (deep link handling)
     * Called after wallet connection when channels are loaded
     */
    async processInitialUrl() {
        const state = historyManager.getInitialState();
        
        if (!state || state.view === 'explore') {
            // Default view - show explore and set initial history entry
            await this.showExploreView();
            historyManager.replaceState({ view: 'explore' });
            return;
        }

        Logger.info('Processing deep link:', state);

        switch (state.view) {
            case 'channel':
                if (state.streamId) {
                    const channel = channelManager.getChannel(state.streamId);
                    if (channel) {
                        await this._selectChannelWithoutHistory(state.streamId);
                        historyManager.replaceState(state);
                    } else {
                        // Channel not in list - try preview mode
                        await previewModeUI.enterPreviewWithoutHistory(state.streamId, null);
                        historyManager.replaceState({ view: 'preview', streamId: state.streamId });
                    }
                }
                break;

            case 'preview':
                if (state.streamId) {
                    await previewModeUI.enterPreviewWithoutHistory(state.streamId, state.channelInfo);
                    historyManager.replaceState(state);
                }
                break;

            default:
                await this.showExploreView();
                historyManager.replaceState({ view: 'explore' });
                break;
        }
    }

    /**
     * Select channel without pushing to history (for popstate handling)
     * @private
     */
    async _selectChannelWithoutHistory(streamId) {
        return channelViewUI.selectChannel(streamId, { pushHistory: false });
    }

    /**
     * Show Explore view inline in messages area (delegates to ChannelViewUI)
     */
    async showExploreView() {
        return channelViewUI.showExploreView();
    }

    /**
     * Update online users display
     * @param {string} streamId - Stream ID
     * @param {Array} users - Array of online users
     */
    updateOnlineUsers(streamId, users) {
        // Check if this is for the current channel
        const currentChannel = channelManager.getCurrentChannel();
        const isCurrentChannel = currentChannel && currentChannel.streamId === streamId;
        
        // Also check if this is for the preview channel
        const previewChannel = previewModeUI.getPreviewChannel();
        const isPreviewChannel = previewChannel && previewChannel.streamId === streamId;
        
        if (!isCurrentChannel && !isPreviewChannel) return;
        
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
     * @param {Event} e - Click event (currentTarget is the button clicked)
     */
    showChannelDropdown(e) {
        const currentChannel = this.getActiveChannel();
        if (!currentChannel) return;
        const isPreviewMode = previewModeUI.isInPreviewMode();
        // Use the actual button that was clicked for positioning
        const menuBtn = e.currentTarget || this.elements.channelMenuBtn;
        dropdownManager.showChannelDropdown(e, menuBtn, currentChannel, isPreviewMode);
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
        const currentChannel = this.getActiveChannel();
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
                channelSettingsUI.show();
                break;
                
            case 'leave-channel':
                channelSettingsUI.showLeaveModal();
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
                dmModalsUI.showNewDMModalWithAddress(address);
                break;
        }
    }

    /**
     * Attach reaction button listeners
     */
    attachReactionListeners() {
        reactionManager.attachReactionListeners(
            (msgId) => {
                chatAreaUI.startReply(msgId);
                this.replyingTo = chatAreaUI.getReplyingTo();
            },
            (fileId) => this.handleFileDownload(fileId),
            (msgId) => chatAreaUI.scrollToMessage(msgId)
        );
    }
    
    /**
     * Handle file download button click
     */
    async handleFileDownload(fileId) {
        const channel = this.getActiveChannel();
        if (!channel) {
            this.showNotification('No active channel', 'error');
            return;
        }
        await mediaHandler.handleFileDownload(fileId, channel, mediaController);
    }

    /**
     * Initialize emoji picker
     */
    initEmojiPicker() {
        reactionManager.initEmojiPicker(this.elements.messageInput);
    }
    
    /**
     * Setup media controller event handlers
     */
    setupMediaHandlers() {
        // Image received - update image placeholders
        mediaController.onImageReceived((imageId, base64Data) => {
            const placeholder = document.querySelector(`[data-image-id="${CSS.escape(imageId)}"]`);
            if (placeholder) {
                // CRITICAL: Verify channel context to prevent cross-channel image leakage
                const placeholderChannelId = placeholder.getAttribute('data-channel-id');
                const currentChannel = this.getActiveChannel();
                if (placeholderChannelId && currentChannel && placeholderChannelId !== currentChannel.streamId) {
                    Logger.debug('Image received for different channel, skipping DOM update:', imageId);
                    return;
                }
                
                // Register media for safe onclick handling
                const mediaId = mediaHandler.registerMedia(base64Data, 'image');
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
                mediaHandler.attachLightboxListeners();
            }
        });
        
        // File progress - update progress overlay and bar
        mediaController.onFileProgress((fileId, percent, received, total, fileSize) => {
            // Show new video panel progress overlay
            const progressOverlay = document.querySelector(`[data-progress-overlay="${CSS.escape(fileId)}"]`);
            if (progressOverlay) {
                progressOverlay.classList.remove('hidden');
            }
            
            // Update progress percentage text
            const progressPercent = document.querySelector(`[data-progress-percent="${CSS.escape(fileId)}"]`);
            if (progressPercent) {
                progressPercent.textContent = `${percent}%`;
            }
            
            // Update progress fill
            const progressFill = document.querySelector(`[data-progress-fill="${CSS.escape(fileId)}"]`);
            if (progressFill) {
                progressFill.style.width = `${percent}%`;
            }
            
            // Update progress text with MB
            const progressText = document.querySelector(`[data-progress-text="${CSS.escape(fileId)}"]`);
            if (progressText) {
                const receivedMB = ((received / total) * fileSize / (1024 * 1024)).toFixed(1);
                const totalMB = (fileSize / (1024 * 1024)).toFixed(1);
                progressText.textContent = `${receivedMB} / ${totalMB} MB`;
            }
            
            // Update download button to show loading state
            const downloadBtn = document.querySelector(`.download-file-btn[data-file-id="${CSS.escape(fileId)}"]`);
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
            const container = document.querySelector(`[data-file-id="${CSS.escape(fileId)}"]`);
            if (container) {
                const isSeeding = mediaController.isSeeding(fileId);
                
                // Defense-in-depth: sanitize network-provided metadata
                const safeFileName = sanitizeText(metadata.fileName);
                const safeFileType = sanitizeText(metadata.fileType);
                
                if (metadata.fileType.startsWith('video/')) {
                    // Check if video format is playable in browser
                    const isPlayable = mediaController.isVideoPlayable(metadata.fileType);
                    
                    // Register media for safe lightbox handling
                    const mediaId = mediaHandler.registerMedia(url, 'video');
                    
                    if (isPlayable && mediaId) {
                        // Show video player
                        container.outerHTML = `
                            <div data-file-id="${_escapeAttr(fileId)}" class="max-w-xs">
                                <div class="relative rounded-lg overflow-hidden bg-black">
                                    <video src="${url}" 
                                           class="max-w-full max-h-60 cursor-pointer video-player-${_escapeAttr(fileId)}" 
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
                                <div class="flex items-center justify-between mt-1 text-xs text-white/40">
                                    <span class="truncate flex-1">${safeFileName}</span>
                                    <div class="flex items-center gap-2 ml-2">
                                        <span>${messageRenderer.formatFileSize(metadata.fileSize)}</span>
                                        <a href="${url}" download="${safeFileName}" class="text-blue-400 hover:underline">Save</a>
                                    </div>
                                </div>
                            </div>
                        `;
                        
                        // Attach lightbox click handlers
                        mediaHandler.attachLightboxListeners();
                        
                        // Add error handler to video element
                        setTimeout(() => {
                            const videoEl = document.querySelector(`.video-player-${CSS.escape(fileId)}`);
                            if (videoEl) {
                                videoEl.addEventListener('error', (e) => {
                                    console.error('Video playback error:', e);
                                    // Replace with download link on error
                                    const parent = videoEl.closest('[data-file-id]');
                                    if (parent) {
                                        parent.innerHTML = `
                                            <div class="bg-white/[0.06] rounded-lg p-3">
                                                <div class="flex items-center gap-2 mb-2">
                                                    <svg class="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                                    </svg>
                                                    <span class="text-sm text-white/70">Format not supported</span>
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
                            <div data-file-id="${_escapeAttr(fileId)}" class="max-w-xs">
                                <div class="bg-white/[0.06] rounded-lg p-3">
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
                                        <span class="text-xs text-white/30">${messageRenderer.formatFileSize(metadata.fileSize)}</span>
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
            const seederEl = document.querySelector(`[data-seeder-count="${CSS.escape(fileId)}"]`);
            if (seederEl) {
                seederEl.textContent = `${count} seeder${count !== 1 ? 's' : ''}`;
            }
        });
    }

    /**
     * Handle preview message - delegates to PreviewModeUI
     * Required for subscriptionManager callback
     * @param {Object} message - Message object
     */
    handlePreviewMessage(message) {
        previewModeUI.handlePreviewMessage(message);
    }

    /**
     * Handle send message
     */
    async handleSendMessage() {
        // DEBOUNCE: Prevent rapid double-clicks from sending duplicates
        if (inputUI.getIsSending()) {
            return;
        }
        
        const text = inputUI.getValue();
        if (!text) return;

        // Check if in preview mode or normal channel mode
        const currentChannel = channelManager.getCurrentChannel();
        const isPreviewMode = previewModeUI.isInPreviewMode();
        
        if (!currentChannel && !isPreviewMode) return;

        // Lock sending state
        inputUI.setIsSending(true);
        
        try {
            // Capture reply context before clearing
            const replyTo = this.replyingTo;
            
            // Clear input and reply bar
            inputUI.clear();
            chatAreaUI.cancelReply(); // Clear reply state
            this.replyingTo = null;
            
            if (isPreviewMode) {
                // Send message in preview mode via streamrController directly
                await previewModeUI.sendPreviewMessage(text, replyTo);
            } else {
                await channelManager.sendMessage(currentChannel.streamId, text, replyTo);
            }
            // UI update happens via notifyHandlers -> addMessage (or handlePreviewMessage)
        } catch (error) {
            this.showNotification('Failed to send message: ' + error.message, 'error');
        } finally {
            // Always unlock sending state
            inputUI.setIsSending(false);
        }
    }

    // =========================================
    // Mobile Navigation Methods
    // =========================================

    /**
     * Check if we're on mobile viewport
     */
    isMobileView() {
        return window.innerWidth < 768;
    }

    /**
     * Open chat view (mobile: push navigation from sidebar)
     */
    openChatView() {
        if (this.isMobileView()) {
            this.elements.sidebar?.classList.add('chat-active');
            this.elements.chatArea?.classList.add('active');
            document.body.classList.add('chat-open');
        }
    }

    /**
     * Close chat view and return to sidebar (mobile back navigation)
     */
    closeChatView() {
        if (this.isMobileView()) {
            this.elements.sidebar?.classList.remove('chat-active');
            this.elements.chatArea?.classList.remove('active');
            document.body.classList.remove('chat-open');
            // Clean up any dangling modal body classes
            document.body.classList.remove('settings-open', 'contacts-open', 'new-channel-open');
            // Reset pill tab to chats
            headerUI.setActivePillTab('chats');
        }
    }

    /**
     * Switch channel filter tab in sidebar (All/Personal/Communities)
     * @param {string} filter - Filter to apply ('all', 'personal', 'community')
     * @param {number} direction - Direction of swipe (-1 = right/prev, 1 = left/next, 0 = click)
     */
    switchChannelFilterTab(filter, direction = 0) {
        // Animation lock for swipes
        if (direction !== 0 && this.isFilterAnimating) return;
        if (direction !== 0) this.isFilterAnimating = true;
        
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
        
        // Animate channel list on mobile swipe
        const channelList = this.elements.channelList;
        if (this.isMobileView() && direction !== 0 && channelList) {
            // Fade out with slide
            channelList.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
            channelList.style.opacity = '0';
            channelList.style.transform = direction > 0 ? 'translateX(-20px)' : 'translateX(20px)';
            
            setTimeout(() => {
                this.renderChannelList();
                
                // Slide in from opposite direction
                channelList.style.transition = 'none';
                channelList.style.transform = direction > 0 ? 'translateX(20px)' : 'translateX(-20px)';
                
                // Trigger reflow
                channelList.offsetHeight;
                
                channelList.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                channelList.style.opacity = '1';
                channelList.style.transform = 'translateX(0)';
                
                // Cleanup
                setTimeout(() => {
                    channelList.style.transition = '';
                    channelList.style.transform = '';
                    channelList.style.opacity = '';
                    this.isFilterAnimating = false;
                }, 200);
            }, 150);
        } else {
            this.renderChannelList();
            this.isFilterAnimating = false;
        }
    }

    /**
     * Initialize swipe gestures for channel filter tabs (mobile)
     * Allows swiping left/right on channel list to switch between All/Personal/Communities
     */
    initChannelFilterSwipe() {
        const channelList = this.elements.channelList;
        if (!channelList) return;

        const filterOrder = ['all', 'personal', 'community'];
        let touchStartX = 0;
        let touchStartY = 0;
        let isSwiping = false;

        channelList.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: true });

        channelList.addEventListener('touchend', (e) => {
            if (!isSwiping || !this.isMobileView()) return;

            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const diffX = touchStartX - touchEndX;
            const diffY = touchStartY - touchEndY;

            // Require horizontal swipe > 50px and more horizontal than vertical (1.5x)
            if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
                const currentIndex = filterOrder.indexOf(this.currentChannelFilter);
                let newIndex;

                if (diffX > 0) {
                    // Swipe left - go to next tab
                    newIndex = Math.min(currentIndex + 1, filterOrder.length - 1);
                } else {
                    // Swipe right - go to previous tab
                    newIndex = Math.max(currentIndex - 1, 0);
                }

                if (newIndex !== currentIndex) {
                    const direction = newIndex > currentIndex ? 1 : -1;
                    this.switchChannelFilterTab(filterOrder[newIndex], direction);
                }
            }

            isSwiping = false;
        }, { passive: true });
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
            
            // Update header label with cached permission result
            const effectiveReadOnly = !canPublish || channel.readOnly;
            if (this.elements.currentChannelInfo) {
                this.elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(channel.type, effectiveReadOnly);
            }
            return;
        }

        // Default to enabled while checking (optimistic for public channels)
        // This prevents the annoying flash of "read-only" before verification completes
        if (channel.type === 'public' || channel.type === 'password') {
            this.setReadOnlyInputState(false);
        } else {
            this.setReadOnlyInputState(true);
        }

        // Check actual permission from blockchain via Streamr SDK
        try {
            const result = await streamrController.hasPublishPermission(channel.messageStreamId, true);
            
            // Handle RPC error - use optimistic approach for public channels
            if (result.rpcError) {
                Logger.warn('RPC error in updateReadOnlyUI, using optimistic state');
                
                // For public/password channels, assume user can publish
                // The server will reject if not allowed anyway
                if (channel.type === 'public' || channel.type === 'password') {
                    this.setReadOnlyInputState(false);
                    return;
                }
                
                // For native/private channels, use cache or stay disabled for safety
                if (cacheValid) {
                    const cachedCanPublish = channel._publishPermCache.canPublish;
                    this.setReadOnlyInputState(!cachedCanPublish, cachedCanPublish && channel.readOnly);
                }
                return;
            }
            
            const canPublish = result.hasPermission;
            
            // Cache the result
            channel._publishPermCache = {
                address: currentAddress,
                canPublish: canPublish,
                timestamp: Date.now()
            };

            // Update UI based on actual permission
            // If channel is read-only and user can publish, show "broadcast" placeholder
            this.setReadOnlyInputState(!canPublish, canPublish && channel.readOnly);
            
            // Update header label to reflect actual read-only state (user cannot publish)
            const effectiveReadOnly = !canPublish || channel.readOnly;
            if (this.elements.currentChannelInfo) {
                this.elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(channel.type, effectiveReadOnly);
            }
            
            Logger.debug('Permission check via SDK:', {
                channel: channel.name,
                canPublish: canPublish,
                readOnly: channel.readOnly,
                effectiveReadOnly: effectiveReadOnly
            });
        } catch (error) {
            Logger.warn('Failed to check publish permission:', error);
            // On error with public channel, stay optimistic
            if (channel.type === 'public' || channel.type === 'password') {
                this.setReadOnlyInputState(false);
            }
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

    // ========================================
    // Join Channel Methods (delegated to JoinChannelUI)
    // ========================================

    showJoinChannelModal() {
        this.joinChannelUI.showJoinChannelModal();
    }

    hideJoinChannelModal() {
        this.joinChannelUI.hideJoinChannelModal();
    }

    updateBrowseJoinButton() {
        this.joinChannelUI.updateBrowseJoinButton();
    }

    updateQuickJoinHash() {
        this.joinChannelUI.updateQuickJoinHash();
    }

    async handleQuickJoin() {
        return this.joinChannelUI.handleQuickJoin(
            (msg, type) => this.showNotification(msg, type),
            () => this.renderChannelList()
        );
    }

    /**
     * Show the quick join modal (mobile pill)
     */
    showQuickJoinModal() {
        const modal = document.getElementById('quick-join-modal');
        const input = document.getElementById('quick-join-modal-input');
        if (modal) {
            modal.classList.remove('hidden');
            setTimeout(() => input?.focus(), 100);
        }
    }

    /**
     * Handle join from the quick join modal
     * @private
     */
    async _handleQuickJoinModal() {
        const modal = document.getElementById('quick-join-modal');
        const input = document.getElementById('quick-join-modal-input');
        const streamId = input?.value.trim();

        if (!streamId) {
            this.showNotification('Please enter a channel ID', 'error');
            return;
        }

        // Set the value in the sidebar input so handleQuickJoin can use it
        if (this.elements.quickJoinInput) {
            this.elements.quickJoinInput.value = streamId;
        }

        // Hide modal
        modal?.classList.add('hidden');
        if (input) input.value = '';

        // Delegate to existing quick join logic
        await this.handleQuickJoin();
    }

    async handleJoinChannel() {
        return this.joinChannelUI.handleJoinChannel(
            (msg, type) => this.showNotification(msg, type),
            () => this.renderChannelList()
        );
    }

    async joinPublicChannel(streamId, channelInfo = null) {
        return this.joinChannelUI.joinPublicChannel(
            streamId,
            channelInfo,
            (msg, type) => this.showNotification(msg, type),
            () => this.renderChannelList(),
            (sid) => this.selectChannel(sid)
        );
    }

    showPasswordInputModal(title, message) {
        return this.joinChannelUI.showPasswordInputModal(title, message);
    }

    async generateQRCode(inviteLink) {
        return this.joinChannelUI.generateQRCode(
            inviteLink,
            (msg, type) => this.showNotification(msg, type)
        );
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

    // ========================================
    // Contact Modal Methods (delegated to ContactsUI)
    // ========================================

    showAddContactModal(address) {
        contactsUI.showAddModal(address);
    }

    hideAddContactModal() {
        contactsUI.hideAddModal();
    }

    async confirmAddContact() {
        return contactsUI.confirmAdd();
    }

    showRemoveContactModal(address, onRemoveCallback = null) {
        contactsUI.showRemoveModal(address, onRemoveCallback);
    }

    hideRemoveContactModal() {
        contactsUI.hideRemoveModal();
    }

    async confirmRemoveContact() {
        return contactsUI.confirmRemove();
    }

    // ========================================
    // Channel Settings Methods (delegated to ChannelSettingsUI)
    // ========================================

    hideChannelSettingsModal() {
        channelSettingsUI.hide();
    }

    hideLeaveChannelModal() {
        channelSettingsUI.hideLeaveModal();
    }

    /**
     * Show toast notification (delegates to NotificationUI)
     */
    showNotification(message, type = 'info', duration = 3000) {
        notificationUI.showNotification(message, type, duration);
    }

    // ========================================
    // Invite Modal Methods (delegated to InviteUI)
    // ========================================

    showInviteModal() {
        inviteUI.show();
    }

    hideInviteModal() {
        inviteUI.hide();
    }

    switchInviteTab(tabType) {
        inviteUI.switchTab(tabType);
    }

    async handleSendInvite() {
        return inviteUI.handleSendInvite();
    }

    copyInviteLink() {
        inviteUI.copyInviteLink();
    }

    showInviteQR() {
        inviteUI.showQR();
    }
}

// Export singleton instance
export const uiController = new UIController();
