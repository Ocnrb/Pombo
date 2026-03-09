/**
 * Channel Modals UI Manager
 * Handles create channel, join channel modal functionality
 */

import { GasEstimator } from './GasEstimator.js';

class ChannelModalsUI {
    constructor() {
        this.deps = {};
        this.elements = {};
        this.currentExposure = 'hidden';
        this.currentClassification = 'personal';
        this.joinClassification = 'personal';
        this.currentReadOnly = false;
        this.currentStorageProvider = 'streamr';
    }

    /**
     * Set dependencies
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    // Convenience getters
    get channelManager() { return this.deps.channelManager; }
    get modalManager() { return this.deps.modalManager; }
    get notificationUI() { return this.deps.notificationUI; }
    get Logger() { return this.deps.Logger; }

    /**
     * Show notification helper
     */
    showNotification(message, type) {
        this.deps.showNotification?.(message, type);
    }

    /**
     * Set elements reference
     */
    setElements(elements) {
        this.elements = elements;
    }

    /**
     * Show new channel modal
     */
    show() {
        document.body.classList.add('new-channel-open');
        this.deps.modalManager?.show('new-channel-modal');
        if (this.elements.channelNameInput) this.elements.channelNameInput.value = '';
        if (this.elements.channelPasswordInput) this.elements.channelPasswordInput.value = '';
        if (this.elements.channelMembersInput) this.elements.channelMembersInput.value = '';
        
        // Reset exposure fields
        if (this.elements.channelDescriptionInput) this.elements.channelDescriptionInput.value = '';
        if (this.elements.channelLanguageInput) this.elements.channelLanguageInput.value = 'en';
        if (this.elements.channelCategoryInput) this.elements.channelCategoryInput.value = 'general';
        
        // Reset to public tab
        this.switchChannelTab('public');
        // Reset to hidden visibility (default)
        this.setVisibility(false);
        // Reset classification to personal (for Closed channels)
        this.switchClassificationTab('personal');
        // Reset read-only toggle
        this.setReadOnly(false);
        // Reset storage provider to Streamr (default)
        this.selectStorageProvider('streamr');
        
        const storageDaysSlider = document.getElementById('storage-days-input');
        if (storageDaysSlider) {
            storageDaysSlider.value = '180';
            this.updateStorageDaysDisplay(180);
        }
        
        // Fetch and display gas estimates
        this.updateGasEstimates();
    }

    /**
     * Hide new channel modal
     */
    hide() {
        document.body.classList.remove('new-channel-open');
        this.deps.modalManager?.hideNewChannelModal();
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
            this.Logger?.warn('Failed to estimate gas costs:', error);
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
        document.querySelectorAll('.channel-tab').forEach(tab => {
            const isActive = tab.dataset.tab === tabType;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('text-white/60', !isActive);
            tab.classList.toggle('hover:text-white/90', !isActive);
            tab.classList.toggle('hover:bg-white/5', !isActive);
        });
        
        document.querySelectorAll('.channel-tab-content').forEach(content => {
            content.classList.toggle('hidden', content.id !== `tab-${tabType}`);
        });
        
        // Update cost display in footer
        document.querySelectorAll('.channel-cost-display').forEach(cost => {
            cost.classList.add('hidden');
        });
        const activeCost = document.getElementById(`cost-${tabType}`);
        if (activeCost) activeCost.classList.remove('hidden');
        
        // Native (Closed) channels: hide exposure section entirely
        if (tabType === 'native') {
            this.setVisibility(false);
            this.elements.exposureSection?.classList.add('hidden');
        } else {
            this.elements.exposureSection?.classList.remove('hidden');
        }
    }

    /**
     * Toggle visibility (hidden/visible)
     */
    toggleVisibility() {
        const toggle = document.getElementById('visibility-toggle');
        if (!toggle) return;
        const isEnabled = toggle.dataset.enabled === 'true';
        this.setVisibility(!isEnabled);
    }

    /**
     * Set visibility state
     */
    setVisibility(visible) {
        const toggle = document.getElementById('visibility-toggle');
        if (!toggle) return;
        
        toggle.dataset.enabled = visible ? 'true' : 'false';
        const knob = toggle.querySelector('span');
        
        if (visible) {
            toggle.classList.remove('bg-white/10');
            toggle.classList.add('bg-[#F6851B]');
            if (knob) {
                knob.classList.remove('left-0.5', 'bg-white/30');
                knob.classList.add('left-4', 'bg-white');
            }
            this.elements.visibleFields?.classList.remove('hidden');
        } else {
            toggle.classList.remove('bg-[#F6851B]');
            toggle.classList.add('bg-white/10');
            if (knob) {
                knob.classList.remove('left-4', 'bg-white');
                knob.classList.add('left-0.5', 'bg-white/30');
            }
            this.elements.visibleFields?.classList.add('hidden');
        }
        
        this.currentExposure = visible ? 'visible' : 'hidden';
    }

    /**
     * Switch classification tab (personal/community) in Create modal
     */
    switchClassificationTab(classification) {
        document.querySelectorAll('.classification-tab').forEach(tab => {
            const isActive = tab.dataset.classification === classification;
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
     * Select storage provider (streamr or logstore)
     */
    selectStorageProvider(provider) {
        this.currentStorageProvider = provider;
        
        document.querySelectorAll('.storage-provider-tab').forEach(tab => {
            if (tab.dataset.storage === provider) {
                tab.classList.remove('bg-white/5', 'text-white/50', 'border-white/5');
                tab.classList.add('bg-white/10', 'text-white', 'border-white/10');
            } else {
                tab.classList.remove('bg-white/10', 'text-white', 'border-white/10');
                tab.classList.add('bg-white/5', 'text-white/50', 'border-white/5');
            }
        });
        
        const storageDaysSection = document.getElementById('storage-days-section');
        const logstoreInfo = document.getElementById('logstore-info');
        
        if (provider === 'streamr') {
            storageDaysSection?.classList.remove('hidden');
            logstoreInfo?.classList.add('hidden');
        } else {
            storageDaysSection?.classList.add('hidden');
            logstoreInfo?.classList.remove('hidden');
        }
    }

    /**
     * Update storage days slider display and progress
     */
    updateStorageDaysDisplay(days) {
        days = parseInt(days, 10);
        const label = document.getElementById('storage-days-value');
        const slider = document.getElementById('storage-days-input');
        
        if (days === 1) {
            if (label) label.textContent = '1 day';
        } else if (days < 30) {
            if (label) label.textContent = `${days} days`;
        } else if (days < 365) {
            const months = Math.round(days / 30);
            if (label) label.textContent = months === 1 ? '1 month' : `${months} months`;
        } else {
            if (label) label.textContent = '1 year';
        }
        
        if (slider) {
            const progress = ((days - 1) / (365 - 1)) * 100;
            slider.style.setProperty('--slider-progress', `${progress}%`);
        }
    }

    /**
     * Show join channel modal
     */
    showJoinModal() {
        this.deps.modalManager?.showJoinChannelModal(
            this.elements.joinChannelModal,
            this.elements.joinStreamIdInput,
            this.elements.joinPasswordInput,
            this.elements.joinPasswordField
        );
    }

    /**
     * Hide join channel modal
     */
    hideJoinModal() {
        this.deps.modalManager?.hide('join-channel-modal');
    }

    /**
     * Show join closed channel modal (with name + classification)
     */
    /**
     * Show join channel modal for channels requiring local name
     * Used for: native channels, hidden channels, unknown channels
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel info from Graph (optional)
     */
    showJoinClosedModal(streamId = '', channelInfo = null) {
        // Store channelInfo for use when joining
        this._pendingJoinChannelInfo = channelInfo;
        
        this.deps.modalManager?.showJoinClosedChannelModal(streamId);
        this.switchJoinClassificationTab('personal');
        
        // Always show classification section - helps organize any channel locally
        const classificationSection = document.getElementById('join-classification-section');
        classificationSection?.classList.remove('hidden');
        
        // Update modal title based on channel type
        const modalTitle = document.querySelector('#join-closed-channel-modal h3');
        if (modalTitle) {
            if (channelInfo?.type === 'native') {
                modalTitle.textContent = 'Join Closed Channel';
            } else if (channelInfo) {
                modalTitle.textContent = 'Name This Channel';
            } else {
                modalTitle.textContent = 'Join Channel';
            }
        }
    }
    
    /**
     * Show join hidden channel modal (alias for consistency)
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel info from Graph (optional)
     */
    showJoinHiddenModal(streamId = '', channelInfo = null) {
        // Use the same modal - classification is useful for all hidden channels
        this.showJoinClosedModal(streamId, channelInfo);
    }

    /**
     * Hide join closed channel modal
     */
    hideJoinClosedModal() {
        this.deps.modalManager?.hide('join-closed-channel-modal');
    }

    /**
     * Handle joining a channel (with local name + classification)
     */
    async handleJoinClosedChannel() {
        const streamId = document.getElementById('join-closed-stream-id-input')?.value.trim();
        const localName = document.getElementById('join-closed-name-input')?.value.trim();
        const classification = this.joinClassification || 'personal';
        
        // Get stored channel info from when modal was opened
        const channelInfo = this._pendingJoinChannelInfo;
        
        if (!streamId) {
            this.showNotification('Please enter a Stream ID', 'error');
            return;
        }
        
        if (!localName) {
            this.showNotification('Please enter a name for this channel', 'error');
            return;
        }
        
        this.hideJoinClosedModal();
        
        // Clear pending state
        this._pendingJoinChannelInfo = null;
        
        try {
            this.notificationUI?.showLoadingToast('Joining channel...', 'This may take a moment');
            
            // Use actual channel type from Graph, or 'native' if unknown
            const channelType = channelInfo?.type || 'native';
            
            await this.channelManager.joinChannel(streamId, null, {
                name: localName,
                type: channelType,
                classification: classification,  // Always save classification for local organization
                readOnly: channelInfo?.readOnly || false,
                createdBy: channelInfo?.createdBy
            });
            
            this.deps.renderChannelList?.();
            this.showNotification('Joined channel successfully!', 'success');
            
            // Clear the quick join input if present
            const quickJoinInput = document.getElementById('quick-join-input');
            if (quickJoinInput) {
                quickJoinInput.value = '';
                this.deps.updateQuickJoinHash?.();
                this.deps.updateBrowseJoinButton?.();
            }
        } catch (error) {
            this.showNotification('Failed to join: ' + error.message, 'error');
        } finally {
            this.notificationUI?.hideLoadingToast();
        }
    }

    /**
     * Handle create channel
     */
    async handleCreate() {
        const name = this.elements.channelNameInput?.value.trim();
        const activeTab = document.querySelector('.channel-tab-content:not(.hidden)');
        const type = activeTab?.querySelector('.channel-type-input')?.value || 'public';
        const password = this.elements.channelPasswordInput?.value;
        const membersText = this.elements.channelMembersInput?.value;
        
        // Exposure and metadata (for visible channels)
        const exposure = type === 'native' ? 'hidden' : (this.currentExposure || 'hidden');
        const description = exposure === 'visible' ? (this.elements.channelDescriptionInput?.value?.trim() || '') : '';
        const language = exposure === 'visible' ? (this.elements.channelLanguageInput?.value || 'en') : '';
        const category = exposure === 'visible' ? (this.elements.channelCategoryInput?.value || 'general') : '';
        
        // Classification for Closed channels (stored locally only)
        const classification = type === 'native' ? (this.currentClassification || 'personal') : null;

        // Storage provider selection
        const storageProvider = this.currentStorageProvider || 'streamr';
        const storageDays = storageProvider === 'streamr' 
            ? parseInt(document.getElementById('storage-days-input')?.value || '180', 10)
            : null;

        if (!name) {
            alert('Please enter a channel name');
            return;
        }

        if (type === 'password' && !password) {
            alert('Please enter a password');
            return;
        }

        const members = type === 'native'
            ? (membersText || '').split('\n').map(m => m.trim()).filter(m => m)
            : [];
        
        const options = {
            exposure,
            description,
            language,
            category,
            classification,
            readOnly: this.currentReadOnly || false,
            storageProvider,
            storageDays
        };

        this.Logger?.debug('Creating channel:', { name, type, password: password ? '***' : null, members, options });

        try {
            this.notificationUI?.showLoadingToast('Creating channel...', 'This may take a minute');
            this.hide();
            
            const channel = await this.channelManager.createChannel(name, type, password, members, options);
            this.Logger?.debug('Channel created in UI:', channel);

            this.deps.renderChannelList?.();

            // Auto-select the new channel
            if (channel) {
                setTimeout(() => {
                    this.deps.selectChannel?.(channel.streamId);
                }, 100);
            }

            this.showNotification('Channel created successfully!', 'success');
        } catch (error) {
            this.showNotification('Failed to create channel: ' + error.message, 'error');
        } finally {
            this.notificationUI?.hideLoadingToast();
        }
    }
}

// Create singleton instance
const channelModalsUI = new ChannelModalsUI();

export { channelModalsUI, ChannelModalsUI };
