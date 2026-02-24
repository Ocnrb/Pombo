/**
 * ChannelSettingsUI
 * Manages channel settings modal, members list, permissions, and danger zone
 */

import { Logger } from '../logger.js';
import { modalManager } from './ModalManager.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { sanitizeText } from './sanitizer.js';

class ChannelSettingsUI {
    constructor() {
        this.deps = null;
        this.elements = null;
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
     * Show channel settings modal
     */
    async show() {
        const { channelManager, streamrController, authManager } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.deps.showNotification('No channel selected', 'error');
            return;
        }

        // Update channel info
        this.elements.channelSettingsName.textContent = currentChannel.name;
        this.elements.channelSettingsType.innerHTML = this.deps.getChannelTypeLabel(currentChannel.type, currentChannel.readOnly);
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
        this.initTabs();
        
        // Re-fetch danger tab elements after cloning (initTabs replaces DOM elements)
        const dangerTabDivider = document.getElementById('danger-tab-divider');
        const dangerTabBtn = document.getElementById('danger-tab-btn');
        
        // Show/hide danger tab for users with DELETE permission only
        dangerTabDivider?.classList.toggle('hidden', !canDelete);
        dangerTabBtn?.classList.toggle('hidden', !canDelete);

        // Select appropriate starting tab (always info for non-native since members tab is hidden)
        this.selectTab('info');

        // Show modal
        modalManager.show('channel-settings-modal');

        // Load members and permissions if native channel
        if (isNative) {
            await this.loadMembers();
            if (canDelete) {
                this.loadPermissions();
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
     * Select a channel settings tab
     */
    selectTab(tabName) {
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
    hide() {
        modalManager.hide('channel-settings-modal');
        this.elements.addMemberInput.value = '';
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
                        Are you sure you want to leave <span class="text-white/80 font-medium">"${escapeHtml(currentChannel.name)}"</span>?
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
        modal.querySelector('#cancel-leave-btn').addEventListener('click', () => this.hideLeaveModal());
        modal.querySelector('#confirm-leave-btn').addEventListener('click', () => this.confirmLeave());
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
    async confirmLeave() {
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
            
            await channelManager.leaveChannel(streamId);
            showNotification(`Left "${channelName}"`, 'info');
            
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
            this.elements.membersList.innerHTML = `<div class="text-center text-red-400/80 py-4 text-sm">Failed to load: ${sanitizeText(error.message)}</div>`;
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
                    who = `<span class="font-mono text-white/60">${short}${isOwner ? ' <span class="text-yellow-400/80"><svg class="w-3 h-3 inline" fill="currentColor" viewBox="0 0 24 24"><path d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z"/></svg></span>' : ''}</span>`;
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
            this.elements.permissionsList.innerHTML = `<div class="text-red-400/80 text-sm">Error: ${sanitizeText(error.message)}</div>`;
        }
    }
}

export const channelSettingsUI = new ChannelSettingsUI();
