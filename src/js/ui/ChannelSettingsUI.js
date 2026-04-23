/**
 * ChannelSettingsUI
 * Manages channel settings modal, members list, permissions, and danger zone
 */

import { Logger } from '../logger.js';
import { modalManager } from './ModalManager.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { sanitizeText } from './sanitizer.js';
import { relayManager } from '../relayManager.js';
import { graphAPI } from '../graph.js';
import { CONFIG } from '../config.js';

class ChannelSettingsUI {
    constructor() {
        this.deps = null;
        this.elements = null;
        this.showDangerTab = false;
        this.showMembersTab = true; // Only for native channels
        this._mobileSubPanelOpen = null; // Track which sub-panel is open on mobile
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
        // Initialize channel name edit handlers after elements are set
        this.initChannelNameEdit();
    }

    /**
     * Show channel settings modal
     */
    async show() {
        const { channelManager, streamrController, authManager } = this.deps;
        
        // Use getActiveChannel to support both regular and preview mode
        const currentChannel = this.deps.getActiveChannel?.() || channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.deps.showNotification('No channel selected', 'error');
            return;
        }

        // Check if in preview mode
        const isPreviewMode = this.deps.isInPreviewMode?.() || false;

        // Determine effective read-only state from cached publish permission
        // If user cannot publish, treat as read-only regardless of channel.readOnly flag
        const canPublish = currentChannel._publishPermCache?.canPublish;
        const effectiveReadOnly = canPublish === false || currentChannel.readOnly;

        // Update channel info
        this.elements.channelSettingsType.innerHTML = this.deps.getChannelTypeLabel(currentChannel.type, effectiveReadOnly, true);
        this.elements.channelSettingsId.textContent = currentChannel.streamId;

        // Populate channel name (network name or local fallback)
        const channelName = currentChannel.channelInfo?.name || currentChannel.name || '';
        if (this.elements.channelSettingsName) {
            this.elements.channelSettingsName.textContent = channelName;
        }
        if (this.elements.channelNameSection) {
            // Always show name section for DM/native channels even if name is empty
            const isDM = currentChannel.type === 'dm';
            const isNativeType = currentChannel.type === 'native';
            const showNameSection = channelName.trim() || isDM || isNativeType;
            this.elements.channelNameSection.classList.toggle('hidden', !showNameSection);
        }

        // Show edit button for channels with local names (DM, native, or channels without on-chain metadata)
        const canEditName = currentChannel.type === 'dm' || currentChannel.type === 'native' || !currentChannel.channelInfo?.name;
        if (this.elements.editChannelNameBtn) {
            this.elements.editChannelNameBtn.classList.toggle('hidden', !canEditName || isPreviewMode);
        }
        // Hide edit container initially
        if (this.elements.channelNameEditContainer) {
            this.elements.channelNameEditContainer.classList.add('hidden');
        }

        // Determine channel type
        const isNative = currentChannel.type === 'native';
        
        // In preview mode: no admin permissions
        let canDelete = false;
        let canAddMembers = false;
        
        if (!isPreviewMode) {
            // Use cached DELETE permission if valid for current wallet, else fetch fresh
            const cached = channelManager.getCachedDeletePermission(currentChannel.streamId);
            canDelete = cached.valid 
                ? cached.canDelete 
                : await streamrController.hasDeletePermission(currentChannel.streamId);
            
            Logger.debug('Channel settings:', { 
                canDelete,
                fromCache: cached.valid,
                currentAddress: authManager.getAddress()?.slice(0,10) 
            });
            
            // Check if user can add members (owner OR has GRANT permission)
            canAddMembers = isNative ? await channelManager.canAddMembers(currentChannel.streamId) : false;
        }

        // Get description from channel (regular or preview mode)
        // If no description, try to fetch from The Graph
        let description = currentChannel.description || currentChannel.channelInfo?.description || '';
        
        if (!description.trim()) {
            try {
                const graphInfo = await graphAPI.getChannelInfo(currentChannel.streamId);
                if (graphInfo?.description) {
                    description = graphInfo.description;
                    // Cache it on the channel object for future use
                    if (currentChannel.channelInfo) {
                        currentChannel.channelInfo.description = description;
                    } else {
                        currentChannel.description = description;
                    }
                }
            } catch (e) {
                Logger.debug('Could not fetch channel info from Graph:', e.message);
            }
        }
        
        // Show/hide description section in Info panel (only if description exists)
        const hasDescription = description.trim().length > 0;
        this.elements.nonNativeMessage.classList.toggle('hidden', !hasDescription);
        
        // Populate description display
        if (this.elements.channelDescriptionDisplay) {
            this.elements.channelDescriptionDisplay.textContent = description;
        }

        // Show/hide members tab button for native channels only (and not in preview mode)
        this.showMembersTab = isNative && !isPreviewMode;
        const membersTabBtn = document.querySelector('[data-channel-tab="members"]');
        membersTabBtn?.classList.toggle('hidden', !isNative || isPreviewMode);
        
        // Show/hide notifications tab in preview mode
        const notificationsTabBtn = document.querySelector('[data-channel-tab="notifications"]');
        notificationsTabBtn?.classList.toggle('hidden', isPreviewMode);

        // Populate storage info
        this.populateStorageInfo(currentChannel);

        // Show/hide members-related elements based on permission to add members
        this.elements.addMemberForm?.classList.toggle('hidden', !canAddMembers);
        this.elements.permissionsSection?.classList.toggle('hidden', !canDelete || !isNative);

        // Clear members list for non-native channels (prevents stale data)
        if (!isNative && this.elements.membersList) {
            this.elements.membersList.innerHTML = '';
        }

        // Initialize channel settings tabs (clones elements, must be before toggling visibility)
        this.initTabs();
        
        // Re-fetch danger tab elements after cloning (initTabs replaces DOM elements)
        const dangerTabDivider = document.getElementById('danger-tab-divider');
        const dangerTabBtn = document.getElementById('danger-tab-btn');
        
        // Show/hide danger tab for users with DELETE permission only
        this.showDangerTab = canDelete;
        dangerTabDivider?.classList.toggle('hidden', !canDelete);
        dangerTabBtn?.classList.toggle('hidden', !canDelete);

        // Select appropriate starting tab (desktop) or show unified view (mobile)
        if (this.isMobileView()) {
            this.showMobileUnifiedView(currentChannel, isPreviewMode);
            document.body.classList.add('channel-details-open');
        } else {
            this.selectTab('info');
        }

        // Show modal
        modalManager.show('channel-settings-modal');

        // Initialize channel notifications toggle (only when not in preview mode)
        if (!isPreviewMode) {
            this.initChannelNotificationsToggle(currentChannel.streamId);
        }

        // Load members and permissions if native channel (not in preview mode)
        if (isNative && !isPreviewMode) {
            await this.loadMembers();
            if (canDelete) {
                this.loadPermissions();
            }
        }
    }

    /**
     * Populate storage info panel from Streamr SDK
     * @param {Object} channel - Channel object
     */
    async populateStorageInfo(channel) {
        const { streamrController } = this.deps;

        // Known storage node addresses for identification
        const LOGSTORE_NODE = CONFIG.storage.logstoreNode;
        
        // Show loading state
        if (this.elements.channelStorageProvider) {
            this.elements.channelStorageProvider.textContent = 'Loading...';
        }
        if (this.elements.channelStorageNode) {
            this.elements.channelStorageNode.textContent = 'Loading...';
        }
        if (this.elements.channelStorageRetention) {
            this.elements.channelStorageRetention.textContent = 'Loading...';
        }
        
        try {
            // Fetch storage info from Streamr SDK
            const storageInfo = await streamrController.getStreamStorageInfo(channel.streamId);
            
            const { enabled, nodes, storageDays } = storageInfo;
            
            // Determine provider based on node address
            let providerName = 'Unknown';
            let nodeAddress = '-';
            let isLogStore = false;
            
            if (enabled && nodes.length > 0) {
                nodeAddress = nodes[0]; // Use first node
                
                // Check if it's LogStore
                if (nodeAddress.toLowerCase() === LOGSTORE_NODE.toLowerCase()) {
                    providerName = 'LogStore';
                    isLogStore = true;
                } else {
                    providerName = 'Streamr Official';
                }
            }
            
            // Update provider name
            if (this.elements.channelStorageProvider) {
                this.elements.channelStorageProvider.textContent = enabled ? providerName : '-';
            }
            
            // Update node address
            if (this.elements.channelStorageNode) {
                this.elements.channelStorageNode.textContent = enabled ? nodeAddress : '-';
            }
            
            // Update retention period
            if (this.elements.channelStorageRetention) {
                if (!enabled) {
                    this.elements.channelStorageRetention.textContent = '-';
                } else if (isLogStore) {
                    this.elements.channelStorageRetention.textContent = 'Permanent';
                } else if (storageDays !== null && storageDays !== undefined && typeof storageDays === 'number') {
                    this.elements.channelStorageRetention.textContent = `${storageDays} days`;
                } else {
                    this.elements.channelStorageRetention.textContent = 'Not set';
                }
            }
            
            // Show/hide "no storage" warning
            if (this.elements.channelStorageNoStorage) {
                this.elements.channelStorageNoStorage.classList.toggle('hidden', enabled);
            }
        } catch (error) {
            Logger.error('Failed to fetch storage info:', error);
            
            // Show error state
            if (this.elements.channelStorageProvider) {
                this.elements.channelStorageProvider.textContent = 'Error';
            }
            if (this.elements.channelStorageNode) {
                this.elements.channelStorageNode.textContent = '-';
            }
            if (this.elements.channelStorageRetention) {
                this.elements.channelStorageRetention.textContent = '-';
            }
            if (this.elements.channelStorageNoStorage) {
                this.elements.channelStorageNoStorage.classList.remove('hidden');
            }
        }
    }

    /**
     * Initialize channel settings tabs navigation
     */
    initTabs() {
        if (this.elements.channelSettingsTabs) {
            this.elements.channelSettingsTabs.forEach(tab => {
                // Remove old listeners by cloning
                const newTab = tab.cloneNode(true);
                tab.parentNode.replaceChild(newTab, tab);
                
                newTab.addEventListener('click', () => {
                    const tabName = newTab.dataset.channelTab;
                    this.selectTab(tabName);
                });
            });
            // Re-cache tabs after cloning
            this.elements.channelSettingsTabs = document.querySelectorAll('.channel-settings-tab');
        }
    }

    /**
     * Select a channel settings tab (desktop only)
     * @param {string} tabName - Tab to select
     */
    selectTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.channel-settings-tab').forEach(tab => {
            const isActive = tab.dataset.channelTab === tabName;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('text-white/60', !isActive && tab.dataset.channelTab !== 'danger');
        });

        // Instant switch panels
        document.querySelectorAll('.channel-settings-panel').forEach(panel => {
            const panelName = panel.id.replace('channel-panel-', '');
            panel.classList.toggle('hidden', panelName !== tabName);
        });
    }

    /**
     * Check if we're in mobile view
     */
    isMobileView() {
        return window.innerWidth < 768;
    }



    /**
     * Show mobile unified view — info + storage inline, nav list for Members/Delete
     */
    showMobileUnifiedView(channel, isPreviewMode) {
        const unified = document.getElementById('channel-mobile-unified');
        if (!unified) return;

        // Hide all tab panels
        document.querySelectorAll('.channel-settings-panel').forEach(p => p.classList.add('hidden'));

        // Show info panel + storage panel inline (stacked vertically)
        const infoPanel = document.getElementById('channel-panel-info');
        const storagePanel = document.getElementById('channel-panel-storage');
        if (infoPanel) infoPanel.classList.remove('hidden');
        if (storagePanel) storagePanel.classList.remove('hidden');

        // Show unified nav
        unified.classList.remove('hidden');

        // Toggle nav item visibility based on permissions/type
        const membersNav = unified.querySelector('[data-mobile-nav="members"]');
        const dangerNav = unified.querySelector('[data-mobile-nav="danger"]');

        membersNav?.classList.toggle('hidden', !this.showMembersTab);
        dangerNav?.classList.toggle('hidden', !this.showDangerTab);

        // Attach click handlers (clone to remove old listeners)
        unified.querySelectorAll('.channel-mobile-nav-item').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                const panel = newBtn.dataset.mobileNav;
                if (panel) this.openMobileSubPanel(panel);
            });
        });

        // Initialize notification chip for mobile (visible to all users)
        this.initMobileNotifChip(channel.streamId);

        this._mobileSubPanelOpen = null;
    }

    /**
     * Initialize the mobile notification bell chip
     */
    initMobileNotifChip(streamId) {
        const chip = document.getElementById('mobile-notif-chip');
        const chipLabel = document.getElementById('mobile-notif-chip-label');
        if (!chip) return;

        const { channelManager } = this.deps;
        const channel = channelManager.channels.get(streamId);
        const isNative = channel?.type === 'native';
        const pushEnabled = relayManager.enabled;

        const isSubscribed = isNative
            ? relayManager.isNativeChannelSubscribed(streamId)
            : relayManager.isChannelSubscribed(streamId);

        // Update chip visual state
        this.updateNotifChipState(chip, chipLabel, isSubscribed, pushEnabled);

        // Show chip on mobile
        chip.classList.remove('hidden');
        chip.classList.add('inline-flex');

        // Attach click handler (clone to remove old)
        const newChip = chip.cloneNode(true);
        chip.parentNode.replaceChild(newChip, chip);
        newChip.addEventListener('click', async () => {
            if (!pushEnabled) {
                this.deps.showNotification('Enable Push Notifications in Settings first', 'warning');
                return;
            }
            const nowSubscribed = isNative
                ? relayManager.isNativeChannelSubscribed(streamId)
                : relayManager.isChannelSubscribed(streamId);
            const enable = !nowSubscribed;
            try {
                if (isNative) {
                    if (enable) await relayManager.subscribeToNativeChannel(streamId);
                    else await relayManager.unsubscribeFromNativeChannel(streamId);
                } else {
                    if (enable) await relayManager.subscribeToChannel(streamId);
                    else await relayManager.unsubscribeFromChannel(streamId);
                }
                const newLabel = document.getElementById('mobile-notif-chip-label');
                this.updateNotifChipState(newChip, newLabel, enable, pushEnabled);
                // Also sync the desktop toggle if it exists
                const desktopToggle = document.getElementById('channel-notifications-enabled');
                if (desktopToggle) desktopToggle.checked = enable;
            } catch (err) {
                this.deps.showNotification('Failed to update notifications', 'error');
            }
        });
    }

    /**
     * Update notification chip visual state
     */
    updateNotifChipState(chip, label, isSubscribed, pushEnabled) {
        if (!chip) return;
        if (isSubscribed) {
            chip.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition border border-[#F6851B]/30 bg-[#F6851B]/10 text-[#F6851B]';
            if (label) label.textContent = 'Notifications On';
        } else {
            chip.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition border border-white/10 bg-white/5 text-white/40';
            if (label) label.textContent = 'Notifications Off';
        }
        if (!pushEnabled) {
            chip.classList.add('opacity-50');
        }
    }

    /**
     * Open a sub-panel on mobile with slide-in animation
     */
    openMobileSubPanel(panelName) {
        const panel = document.getElementById(`channel-panel-${panelName}`);
        const unified = document.getElementById('channel-mobile-unified');
        const infoPanel = document.getElementById('channel-panel-info');
        const storagePanel = document.getElementById('channel-panel-storage');
        const header = document.querySelector('#channel-settings-modal .flex.border-b h3');
        if (!panel) return;

        // Store which sub-panel is open
        this._mobileSubPanelOpen = panelName;

        // Update header title
        const titles = {
            'members': 'Members',
            'danger': 'Delete Channel'
        };
        if (header) header.textContent = titles[panelName] || 'Channel Details';

        // Hide unified view + info + storage
        if (unified) unified.classList.add('hidden');
        if (infoPanel) infoPanel.classList.add('hidden');
        if (storagePanel) storagePanel.classList.add('hidden');

        // Show the target panel with slide animation
        panel.classList.remove('hidden');
        panel.style.transform = 'translateX(100%)';
        panel.style.transition = 'transform 0.25s ease';
        // Force reflow
        panel.offsetHeight;
        panel.style.transform = 'translateX(0)';

        setTimeout(() => {
            panel.style.transition = '';
            panel.style.transform = '';
        }, 250);
    }

    /**
     * Close current mobile sub-panel and return to unified view
     */
    closeMobileSubPanel() {
        if (!this._mobileSubPanelOpen) return false;

        const panel = document.getElementById(`channel-panel-${this._mobileSubPanelOpen}`);
        const unified = document.getElementById('channel-mobile-unified');
        const infoPanel = document.getElementById('channel-panel-info');
        const storagePanel = document.getElementById('channel-panel-storage');
        const header = document.querySelector('#channel-settings-modal .flex.border-b h3');

        // Restore header
        if (header) header.textContent = 'Channel Details';

        // Slide out sub-panel
        if (panel) {
            panel.style.transition = 'transform 0.2s ease';
            panel.style.transform = 'translateX(100%)';
            setTimeout(() => {
                panel.classList.add('hidden');
                panel.style.transition = '';
                panel.style.transform = '';
            }, 200);
        }

        // Show unified view + info + storage
        if (unified) unified.classList.remove('hidden');
        if (infoPanel) infoPanel.classList.remove('hidden');
        if (storagePanel) storagePanel.classList.remove('hidden');

        this._mobileSubPanelOpen = null;
        return true;
    }

    /**
     * Hide channel settings modal
     */
    hide() {
        this._mobileSubPanelOpen = null;
        document.body.classList.remove('channel-details-open');
        modalManager.hide('channel-settings-modal');
        this.elements.addMemberInput.value = '';
    }

    /**
     * Initialize channel notifications toggle
     */
    initChannelNotificationsToggle(streamId) {
        const toggle = document.getElementById('channel-notifications-enabled');
        const status = document.getElementById('channel-notifications-status');
        const requiresPush = document.getElementById('channel-notifications-requires-push');
        const container = document.getElementById('channel-notifications-container');
        const tooltip = document.getElementById('channel-notifications-tooltip');
        const label = document.getElementById('channel-notifications-label');
        
        if (!toggle) return;
        
        // Get channel type
        const { channelManager } = this.deps;
        const channel = channelManager.channels.get(streamId);
        const isNative = channel?.type === 'native';
        
        // Check if push notifications are enabled globally
        const pushEnabled = relayManager.enabled;
        
        // Check if this channel has notifications enabled (use appropriate method based on type)
        const isSubscribed = isNative 
            ? relayManager.isNativeChannelSubscribed(streamId)
            : relayManager.isChannelSubscribed(streamId);
        
        // Set toggle state
        toggle.checked = isSubscribed;
        toggle.disabled = !pushEnabled;
        
        // Apply visual grey out to container when disabled
        if (container) {
            container.classList.toggle('opacity-50', !pushEnabled);
        }
        
        // Update label cursor
        if (label) {
            label.classList.toggle('cursor-not-allowed', !pushEnabled);
            label.classList.toggle('cursor-pointer', pushEnabled);
        }
        
        // Setup tooltip hover handlers (stored on element to avoid duplicates)
        if (tooltip && label) {
            // Remove old handlers if they exist
            if (label._tooltipEnter) label.removeEventListener('mouseenter', label._tooltipEnter);
            if (label._tooltipLeave) label.removeEventListener('mouseleave', label._tooltipLeave);
            if (label._tooltipClick) label.removeEventListener('click', label._tooltipClick);
            
            if (!pushEnabled) {
                // Store handlers on element for later removal
                label._tooltipEnter = () => tooltip.classList.remove('hidden');
                label._tooltipLeave = () => tooltip.classList.add('hidden');
                label._tooltipClick = (e) => {
                    e.preventDefault();
                    if (requiresPush) {
                        requiresPush.classList.add('animate-pulse');
                        setTimeout(() => requiresPush.classList.remove('animate-pulse'), 1000);
                    }
                };
                label.addEventListener('mouseenter', label._tooltipEnter);
                label.addEventListener('mouseleave', label._tooltipLeave);
                label.addEventListener('click', label._tooltipClick);
            } else {
                tooltip.classList.add('hidden');
            }
        }
        
        // Update status text
        if (status) {
            if (!pushEnabled) {
                status.textContent = '';
            } else if (isSubscribed) {
                status.textContent = 'Push notifications enabled for this channel';
                status.className = 'text-xs text-green-500';
            } else {
                status.textContent = 'Push notifications disabled';
                status.className = 'text-xs text-white/40';
            }
        }
        
        // Show/hide "enable push first" warning
        if (requiresPush) {
            requiresPush.classList.toggle('hidden', pushEnabled);
        }
        
        // Setup toggle change handler (stored on element to avoid duplicates)
        if (toggle._changeHandler) toggle.removeEventListener('change', toggle._changeHandler);
        toggle._changeHandler = async (e) => {
            await this.handleChannelNotificationsToggle(e, streamId);
        };
        toggle.addEventListener('change', toggle._changeHandler);
    }

    /**
     * Handle channel notifications toggle change
     */
    async handleChannelNotificationsToggle(e, streamId) {
        const enable = e.target.checked;
        const status = document.getElementById('channel-notifications-status');
        const { showNotification, channelManager } = this.deps;
        
        // Get channel type
        const channel = channelManager.channels.get(streamId);
        const isNative = channel?.type === 'native';
        
        if (enable) {
            try {
                // Use appropriate method based on channel type
                const success = isNative
                    ? await relayManager.subscribeToNativeChannel(streamId)
                    : await relayManager.subscribeToChannel(streamId);
                    
                if (success) {
                    showNotification('Push notifications enabled!', 'success');
                    if (status) {
                        status.textContent = 'Push notifications enabled for this channel';
                        status.className = 'text-xs text-green-500';
                    }
                } else {
                    e.target.checked = false;
                    showNotification('Failed to enable push notifications', 'error');
                }
            } catch (error) {
                e.target.checked = false;
                showNotification('Error: ' + error.message, 'error');
            }
        } else {
            // Use appropriate method based on channel type
            if (isNative) {
                relayManager.unsubscribeFromNativeChannel(streamId);
            } else {
                relayManager.unsubscribeFromChannel(streamId);
            }
            showNotification('Push notifications disabled', 'info');
            if (status) {
                status.textContent = 'Push notifications disabled';
                status.className = 'text-xs text-white/40';
            }
        }
    }

    /**
     * Show delete channel confirmation modal
     */
    showDeleteModal() {
        const currentChannel = this.deps.channelManager.getCurrentChannel();
        if (!currentChannel) return;

        this.elements.deleteChannelName.textContent = currentChannel.name;
        modalManager.show('delete-channel-modal');
    }

    /**
     * Hide delete channel confirmation modal
     */
    hideDeleteModal() {
        modalManager.hide('delete-channel-modal');
    }

    /**
     * Handle delete channel confirmation
     */
    async handleDelete() {
        const { channelManager, subscriptionManager, showNotification, showLoading, hideLoading, renderChannelList, selectChannel, showConnectedNoChannelState } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        const channelName = currentChannel.name;
        const streamId = currentChannel.streamId;

        try {
            showLoading('Deleting channel...');
            this.hideDeleteModal();
            this.hide();

            // Remove from subscription manager tracking first
            await subscriptionManager.removeChannel(streamId);

            await channelManager.deleteChannel(streamId);

            showNotification(`Channel "${channelName}" deleted successfully`, 'success');

            // Update UI - select first remaining channel or show empty state
            const channels = channelManager.getAllChannels();
            if (channels.length > 0) {
                renderChannelList();
                await selectChannel(channels[0].streamId);
            } else {
                renderChannelList();
                showConnectedNoChannelState();
            }
        } catch (error) {
            showNotification('Failed to delete channel: ' + error.message, 'error');
        } finally {
            hideLoading();
        }
    }

    /**
     * Show leave channel confirmation modal
     */
    showLeaveModal() {
        const currentChannel = this.deps.channelManager.getCurrentChannel();
        if (!currentChannel) return;
        
        // Close any existing modal
        this.hideLeaveModal();
        
        const isDM = currentChannel.type === 'dm';
        const channelLabel = escapeHtml(currentChannel.name || currentChannel.peerAddress || 'this channel');
        
        const hint = isDM
            ? '<p class="text-xs text-white/30 mt-1">New messages will reopen the conversation.</p>'
            : '<p class="text-xs text-white/30 mt-1">You can rejoin later with the invite link.</p>';
        
        const blockButton = isDM ? `
            <button id="block-leave-btn" class="flex-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 text-sm font-medium px-3 py-2.5 rounded-xl transition">
                Block
            </button>
        ` : '';
        
        const modal = document.createElement('div');
        modal.id = 'leave-channel-modal';
        modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[60]';
        modal.innerHTML = `
            <div class="bg-[#111113] rounded-2xl p-5 w-[340px] max-w-full mx-4 border border-white/[0.06]">
                <h3 class="text-base font-medium mb-4 text-white">${isDM ? 'Leave Conversation' : 'Leave Channel'}</h3>
                <div class="space-y-3">
                    <p class="text-sm text-white/50">
                        Are you sure you want to leave <span class="text-white/80 font-medium">"${channelLabel}"</span>?
                    </p>
                    ${hint}
                </div>
                <div class="flex gap-2 mt-5">
                    <button id="cancel-leave-btn" class="flex-1 bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-white/50 text-sm font-medium px-3 py-2.5 rounded-xl transition">
                        Cancel
                    </button>
                    <button id="confirm-leave-btn" class="flex-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 text-sm font-medium px-3 py-2.5 rounded-xl transition">
                        Leave
                    </button>
                    ${blockButton}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Attach listeners
        modal.querySelector('#cancel-leave-btn').addEventListener('click', () => this.hideLeaveModal());
        modal.querySelector('#confirm-leave-btn').addEventListener('click', () => this.confirmLeave(false));
        const blockBtn = modal.querySelector('#block-leave-btn');
        if (blockBtn) {
            blockBtn.addEventListener('click', () => this.confirmLeave(true));
        }
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideLeaveModal();
        });
    }
    
    /**
     * Hide leave channel modal
     */
    hideLeaveModal() {
        const modal = document.getElementById('leave-channel-modal');
        if (modal) modal.remove();
    }
    
    /**
     * Confirm and execute leave channel
     */
    async confirmLeave(block = false) {
        const { channelManager, subscriptionManager, showNotification, renderChannelList, selectChannel, showConnectedNoChannelState } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;
        
        const channelName = currentChannel.name;
        const streamId = currentChannel.streamId;
        
        this.hideLeaveModal();
        this.hide();
        
        try {
            // Remove from subscription manager tracking first
            await subscriptionManager.removeChannel(streamId);
            
            await channelManager.leaveChannel(streamId, { block });
            
            if (block) {
                showNotification(`Blocked and left "${channelName}"`, 'info');
            } else {
                showNotification(`Left "${channelName}"`, 'info');
            }
            
            // Update UI - select first remaining channel or show empty state
            const channels = channelManager.getAllChannels();
            if (channels.length > 0) {
                renderChannelList();
                await selectChannel(channels[0].streamId);
            } else {
                renderChannelList();
                showConnectedNoChannelState();
            }
        } catch (error) {
            showNotification('Failed to leave channel: ' + error.message, 'error');
        }
    }

    /**
     * Load channel members
     */
    async loadMembers() {
        const currentChannel = this.deps.channelManager.getCurrentChannel();
        if (!currentChannel || currentChannel.type !== 'native') {
            return;
        }

        this.elements.membersList.innerHTML = '<div class="text-center text-white/30 py-4 text-sm">Loading...</div>';

        try {
            const members = await this.deps.channelManager.getChannelMembers(currentChannel.streamId);
            this.renderMembersList(members, currentChannel);
        } catch (error) {
            this.elements.membersList.innerHTML = `<div class="text-center text-red-400/80 py-4 text-sm">Failed to load: ${escapeHtml(sanitizeText(error.message))}</div>`;
        }
    }

    /**
     * Render members list with permissions
     */
    renderMembersList(members, channel) {
        const { authManager, channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
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
                          data-address="${escapeAttr(address)}" data-can-grant="${canGrant}" data-current-is-owner="${isOwner}" title="Manage member">
                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
                    </svg>
                   </button>`
                : '';

            return `
                <div class="flex items-center justify-between p-2.5 bg-white/5 rounded-xl border border-white/5 hover:border-white/10 transition group">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                        <div class="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs text-white/60 font-mono">
                            ${escapeHtml(address.slice(2, 4))}
                        </div>
                        <div class="flex flex-col min-w-0">
                            <span class="font-mono text-xs text-white/70 truncate">${escapeHtml(shortAddr)}</span>
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
        dropdown.className = 'fixed bg-[#111113] border border-white/10 rounded-xl shadow-2xl py-1 z-[9999] min-w-[200px] overflow-hidden';
        dropdown.innerHTML = `
            <div class="px-3 py-2 border-b border-white/5">
                <div class="text-xs text-white/40">Member</div>
                <div class="text-sm text-white/80 font-mono">${escapeHtml(shortAddr)}</div>
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
        const { channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        switch (action) {
            case 'toggle-grant':
                const newCanGrant = !currentCanGrant;
                try {
                    showLoading(newCanGrant ? 'Granting admin permission...' : 'Revoking admin permission...');
                    await channelManager.updateMemberPermissions(currentChannel.streamId, address, { canGrant: newCanGrant });
                    showNotification(
                        newCanGrant ? 'Member can now add others!' : 'Admin permission removed',
                        'success'
                    );
                    // Refresh members list
                    await this.loadMembers();
                } catch (error) {
                    showNotification('Failed to update permission: ' + error.message, 'error');
                } finally {
                    hideLoading();
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
        const { channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
        const address = this.elements.addMemberInput.value.trim();
        if (!address) {
            showNotification('Please enter an address', 'error');
            return;
        }

        if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
            showNotification('Invalid Ethereum address', 'error');
            return;
        }

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            showLoading('Adding member (on-chain transaction)...');
            await channelManager.addMember(currentChannel.streamId, address);
            this.elements.addMemberInput.value = '';
            showNotification('Member added successfully!', 'success');
            await this.loadMembers();
        } catch (error) {
            showNotification('Failed to add member: ' + error.message, 'error');
        } finally {
            hideLoading();
        }
    }

    /**
     * Handle batch add members
     */
    async handleBatchAddMembers() {
        const { channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
        const input = this.elements.batchMembersInput?.value || '';
        const lines = input.split('\n').map(l => l.trim()).filter(l => l);
        
        if (lines.length === 0) {
            showNotification('Please enter at least one address', 'error');
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
            showNotification(`${invalidAddresses.length} invalid address(es) found`, 'error');
            return;
        }

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            showLoading(`Adding ${validAddresses.length} members (on-chain transactions)...`);
            
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
            
            this.elements.batchMembersInput.value = '';
            
            if (failed > 0) {
                showNotification(`Added ${added} members, ${failed} failed`, 'warning');
            } else {
                showNotification(`${added} members added successfully!`, 'success');
            }
            
            await this.loadMembers();
        } catch (error) {
            showNotification('Failed to add members: ' + error.message, 'error');
        } finally {
            hideLoading();
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
            <div class="bg-[#111113] rounded-2xl w-[380px] max-w-[95vw] mx-4 shadow-2xl border border-white/[0.06] overflow-hidden">
                <div class="p-6">
                    <div class="flex items-center gap-3 mb-4">
                        <div class="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center text-lg">👤</div>
                        <h3 class="text-lg font-medium text-white/90">Remove Member</h3>
                    </div>
                    <p class="text-sm text-white/50 mb-2">
                        Remove <span class="text-white/80 font-mono">${escapeHtml(shortAddr)}</span> from this channel?
                    </p>
                    <p class="text-xs text-white/30 bg-white/5 rounded-lg px-3 py-2">
                        This will revoke their access via an on-chain transaction.
                    </p>
                </div>
                <div class="flex border-t border-white/5">
                    <button id="cancel-remove-member-btn" class="flex-1 px-4 py-3 text-sm text-white/60 hover:text-white hover:bg-white/5 transition">
                        Cancel
                    </button>
                    <button id="confirm-remove-member-btn" class="flex-1 px-4 py-3 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 border-l border-white/5 transition" data-address="${escapeAttr(address)}">
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
        const { channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            showLoading('Removing member (on-chain transaction)...');
            await channelManager.removeMember(currentChannel.streamId, address);
            showNotification('Member removed successfully!', 'success');
            await this.loadMembers();
        } catch (error) {
            showNotification('Failed to remove member: ' + error.message, 'error');
        } finally {
            hideLoading();
        }
    }

    /**
     * Load and display stream permissions
     */
    async loadPermissions() {
        const { channelManager } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel || currentChannel.type !== 'native') {
            return;
        }

        if (!this.elements.permissionsList) return;
        
        this.elements.permissionsList.innerHTML = '<div class="text-white/30">Loading...</div>';

        try {
            // Use The Graph API for permissions (same source as members list)
            const { graphAPI } = await import('../graph.js');
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
                        <span class="font-mono text-white/60">${escapeHtml(shortOwner)}</span>
                        <span class="text-xs text-yellow-400/80">Owner</span>
                    </div>`;
                }
                
                // Show local members
                for (const member of localMembers) {
                    const shortMember = `${member.slice(0, 8)}...${member.slice(-4)}`;
                    html += `<div class="flex justify-between items-center py-1.5 px-2.5 bg-white/5 rounded-lg">
                        <span class="font-mono text-white/60">${escapeHtml(shortMember)}</span>
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
            const now = Math.floor(Date.now() / 1000);
            
            const formatted = permissions
                .map(perm => {
                let who;
                let isOwner = false;
                
                const userAddr = perm.userAddress;
                
                if (!userAddr || userAddr === '0x0000000000000000000000000000000000000000') {
                    who = '<span class="text-yellow-400/80 inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3"/></svg>PUBLIC</span>';
                } else {
                    const short = `${userAddr.slice(0, 8)}...${userAddr.slice(-4)}`;
                    isOwner = ownerAddress && userAddr.toLowerCase() === ownerAddress;
                    who = `<span class="font-mono text-white/60">${escapeHtml(short)}${isOwner ? ' <span class="text-yellow-400/80"><svg class="w-3 h-3 inline" fill="currentColor" viewBox="0 0 24 24"><path d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z"/></svg></span>' : ''}</span>`;
                }
                
                // Build permissions array from The Graph fields
                const permList = [];
                
                const canSubscribe = perm.subscribeExpiration === null || parseInt(perm.subscribeExpiration) > now;
                if (canSubscribe) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>');
                
                const canPublish = perm.publishExpiration === null || parseInt(perm.publishExpiration) > now;
                if (canPublish) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>');
                
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
            this.elements.permissionsList.innerHTML = `<div class="text-red-400/80 text-sm">Error: ${escapeHtml(sanitizeText(error.message))}</div>`;
        }
    }

    /**
     * Initialize channel name edit handlers
     * Called after elements are set
     */
    initChannelNameEdit() {
        // Edit button click
        if (this.elements.editChannelNameBtn) {
            this.elements.editChannelNameBtn.addEventListener('click', () => this.startEditingName());
        }
        
        // Save button click
        if (this.elements.saveChannelNameBtn) {
            this.elements.saveChannelNameBtn.addEventListener('click', () => this.saveChannelName());
        }
        
        // Cancel button click
        if (this.elements.cancelChannelNameBtn) {
            this.elements.cancelChannelNameBtn.addEventListener('click', () => this.cancelEditingName());
        }
        
        // Enter key in input
        if (this.elements.channelSettingsNameInput) {
            this.elements.channelSettingsNameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.saveChannelName();
                } else if (e.key === 'Escape') {
                    this.cancelEditingName();
                }
            });
        }
    }

    /**
     * Start editing the channel name
     */
    startEditingName() {
        const currentName = this.elements.channelSettingsName?.textContent || '';
        
        // Show edit container, hide name display
        if (this.elements.channelNameEditContainer) {
            this.elements.channelNameEditContainer.classList.remove('hidden');
        }
        if (this.elements.channelSettingsName) {
            this.elements.channelSettingsName.classList.add('hidden');
        }
        if (this.elements.editChannelNameBtn) {
            this.elements.editChannelNameBtn.classList.add('hidden');
        }
        
        // Set current name in input and focus
        if (this.elements.channelSettingsNameInput) {
            this.elements.channelSettingsNameInput.value = currentName;
            this.elements.channelSettingsNameInput.focus();
            this.elements.channelSettingsNameInput.select();
        }
    }

    /**
     * Cancel editing the channel name
     */
    cancelEditingName() {
        // Hide edit container, show name display
        if (this.elements.channelNameEditContainer) {
            this.elements.channelNameEditContainer.classList.add('hidden');
        }
        if (this.elements.channelSettingsName) {
            this.elements.channelSettingsName.classList.remove('hidden');
        }
        if (this.elements.editChannelNameBtn) {
            this.elements.editChannelNameBtn.classList.remove('hidden');
        }
    }

    /**
     * Save the edited channel name
     */
    async saveChannelName() {
        const { channelManager, showNotification } = this.deps;
        
        const currentChannel = this.deps.getActiveChannel?.() || channelManager.getCurrentChannel();
        if (!currentChannel) return;

        const newName = this.elements.channelSettingsNameInput?.value?.trim() || '';
        
        if (!newName) {
            showNotification('Name cannot be empty', 'error');
            return;
        }

        try {
            // Update channel name
            currentChannel.name = newName;
            
            // Save to localStorage
            await channelManager.saveChannels();
            
            // Update UI display in modal
            if (this.elements.channelSettingsName) {
                this.elements.channelSettingsName.textContent = newName;
            }
            
            // Update chat header if this is the current channel
            if (this.elements.currentChannelName) {
                const activeChannelId = channelManager.getCurrentChannel()?.messageStreamId || 
                                       channelManager.getCurrentChannel()?.streamId;
                const editedChannelId = currentChannel.messageStreamId || currentChannel.streamId;
                
                if (activeChannelId === editedChannelId) {
                    this.elements.currentChannelName.textContent = newName;
                }
            }
            
            // Exit edit mode
            this.cancelEditingName();
            
            // Sync with Service Worker for push notifications
            relayManager.syncWithServiceWorker();
            
            // Re-render channel list to show new name
            this.deps.renderChannelList?.();
            
            showNotification('Name updated!', 'success');
            Logger.debug('Channel name updated:', newName);
            
        } catch (error) {
            showNotification('Failed to save name: ' + error.message, 'error');
            Logger.error('Failed to save channel name:', error);
        }
    }
}

export const channelSettingsUI = new ChannelSettingsUI();
