/**
 * PreviewModeUI - Handles channel preview mode functionality
 * Allows users to view channels before joining them
 */

import { Logger } from '../logger.js';

class PreviewModeUI {
    constructor() {
        // Preview channel state
        this.previewChannel = null;
        
        // Dependencies (set via setDependencies)
        this.deps = null;
        
        // UI Controller callbacks (set via setUIController)
        this.ui = null;
    }

    /**
     * Set module dependencies
     * @param {Object} deps - Dependencies object
     */
    setDependencies(deps) {
        this.deps = deps;
    }

    /**
     * Set UI Controller references
     * @param {Object} ui - UI Controller callbacks and references
     */
    setUIController(ui) {
        this.ui = ui;
    }

    /**
     * Check if currently in preview mode
     * @returns {boolean}
     */
    isInPreviewMode() {
        return this.previewChannel !== null;
    }

    /**
     * Get current preview channel
     * @returns {Object|null}
     */
    getPreviewChannel() {
        return this.previewChannel;
    }

    /**
     * Enter preview mode for a channel (view without adding to list)
     * For public/open channels - allows users to try before committing
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata
     */
    async enterPreviewMode(streamId, channelInfo = null) {
        // Check if channel is already in user's list
        if (this.deps.channelManager.getChannel(streamId)) {
            // Already joined - just select it normally
            await this.ui.selectChannel(streamId);
            return;
        }
        await this._enterPreviewCore(streamId, channelInfo, true);
    }

    /**
     * Enter preview mode without pushing to history (for popstate handling)
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata
     */
    async enterPreviewWithoutHistory(streamId, channelInfo) {
        if (this.deps.channelManager.getChannel(streamId)) {
            await this.ui.selectChannelWithoutHistory(streamId);
            return;
        }
        await this._enterPreviewCore(streamId, channelInfo, false);
    }

    /**
     * Core preview mode logic
     * @param {string} streamId - Channel stream ID  
     * @param {Object} channelInfo - Channel metadata (optional)
     * @param {boolean} pushHistory - Whether to push to browser history
     * @private
     */
    async _enterPreviewCore(streamId, channelInfo, pushHistory) {
        const { channelManager, subscriptionManager, graphAPI, notificationUI, historyManager, headerUI, reactionManager } = this.deps;
        const elements = this.ui.elements;

        // No longer in explore view
        document.body.classList.remove('explore-open');

        try {
            // Exit any existing preview first (only one preview at a time)
            if (this.previewChannel) {
                await this.exitPreviewMode(false);
            }

            // Clear current channel selection (preview is not a "real" selection)
            channelManager.setCurrentChannel(null);

            // Clear stale reactions from any previously viewed channel
            reactionManager.loadFromChannelState({});

            notificationUI.showLoadingToast('Loading channel...', 'Connecting to stream');

            // If no channelInfo, try to fetch from The Graph
            if (!channelInfo) {
                try {
                    channelInfo = await graphAPI.getChannelInfo(streamId);
                } catch (e) {
                    Logger.warn('Could not get channel info from Graph:', e.message);
                }
            }

            // Store preview state
            this.previewChannel = {
                streamId,
                channelInfo,
                name: this._getChannelDisplayName(streamId, channelInfo),
                type: channelInfo?.type || 'public',
                readOnly: channelInfo?.readOnly || false,
                password: null, // Preview mode doesn't have password (public channels only)
                messages: []
            };

            // Subscribe to channel stream temporarily (without persisting)
            await subscriptionManager.setPreviewChannel(streamId);

            // Update UI for preview mode
            this._showPreviewUI();
            
            // Check actual publish permission via SDK and update header accordingly
            this._checkAndUpdateReadOnlyState();

            // Mobile: navigate to chat view
            this.ui.openChatView();
            
            // Push to browser history if requested
            if (pushHistory) {
                const currentState = window.history.state;
                if (currentState?.view === 'preview' || currentState?.view === 'channel') {
                    historyManager.replaceState({ view: 'preview', streamId });
                } else {
                    historyManager.pushState({ view: 'preview', streamId });
                }
            }

            Logger.info('Entered preview mode for:', streamId);
        } catch (error) {
            this.previewChannel = null;
            Logger.error('Failed to enter preview mode:', error);
            this.ui.showNotification('Failed to load channel: ' + error.message, 'error');
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Get display name for a channel, with fallbacks
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata (optional)
     * @returns {string} - Display name
     * @private
     */
    _getChannelDisplayName(streamId, channelInfo) {
        // Use explicit name if set, or displayName from Graph, or extract from streamId
        if (channelInfo?.name) return channelInfo.name;
        if (channelInfo?.displayName) return channelInfo.displayName;
        // Extract name from streamId (format: address/name-N)
        const namePart = streamId.split('/')[1];
        if (namePart) {
            return namePart.replace(/-\d$/, '');
        }
        return streamId;
    }

    /**
     * Update UI to show preview mode state
     * @private
     */
    _showPreviewUI() {
        if (!this.previewChannel) return;

        const elements = this.ui.elements;
        const { headerUI } = this.deps;

        // Clear messages area first and show loading spinner
        elements.messagesArea.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-white/40">
                <div class="spinner mb-3" style="width: 24px; height: 24px;"></div>
                <span class="text-sm">Loading messages...</span>
            </div>
        `;
        elements.messagesArea?.classList.add('p-4');
        
        // Set a flag to track if we're still loading
        this.previewChannel.isLoading = true;
        
        // After a short delay, if still no messages, show empty state
        setTimeout(() => {
            if (this.previewChannel && this.previewChannel.isLoading && this.previewChannel.messages.length === 0) {
                this.previewChannel.isLoading = false;
                elements.messagesArea.innerHTML = `
                    <div class="flex items-center justify-center h-full text-white/40">
                        No messages yet. Start the conversation!
                    </div>
                `;
            }
        }, 20000); // 20 seconds timeout

        // Update header
        elements.currentChannelName.textContent = this.previewChannel.name;
        elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(this.previewChannel.type, this.previewChannel.readOnly);
        elements.currentChannelInfo.parentElement.classList.remove('hidden');

        // Show message input (full functionality in preview)
        elements.messageInputContainer.classList.remove('hidden');

        // Hide explore type tabs
        elements.exploreTypeTabs?.classList.add('hidden');

        // Restore right header buttons
        elements.chatHeaderRight?.classList.remove('hidden');

        // Show JOIN button, hide INVITE button
        elements.joinChannelBtn?.classList.remove('hidden');
        elements.inviteUsersBtn?.classList.add('hidden');

        // Show channel menu button
        if (elements.channelMenuBtn) {
            elements.channelMenuBtn.classList.remove('hidden');
        }
        if (elements.channelMenuBtnMobile) {
            elements.channelMenuBtnMobile.classList.remove('hidden');
        }

        // Show close channel buttons
        if (elements.closeChannelBtn) {
            elements.closeChannelBtn.classList.remove('hidden');
        }
        if (elements.closeChannelBtnDesktop) {
            elements.closeChannelBtnDesktop.classList.remove('hidden');
        }

        // Show online users container
        elements.onlineHeader?.classList.remove('hidden');
        elements.onlineHeader?.classList.add('flex');
        elements.onlineSeparator?.classList.remove('hidden');
    }

    /**
     * Check publish permission via SDK and update header read-only indicator
     * Called after preview UI is shown to provide accurate permission state
     * @private
     */
    async _checkAndUpdateReadOnlyState() {
        if (!this.previewChannel) return;
        
        const { streamrController, headerUI } = this.deps;
        const elements = this.ui.elements;
        
        try {
            const result = await streamrController.hasPublishPermission(this.previewChannel.streamId, true);
            
            // Handle RPC error - don't mark as read-only when we can't verify
            if (result.rpcError) {
                Logger.warn('RPC error checking permissions, keeping optimistic state');
                // For public channels, assume user can publish (optimistic)
                // Server will reject if actually not allowed
                return;
            }
            
            const canPublish = result.hasPermission;
            
            // Update effective read-only: either channel is marked read-only OR user cannot publish
            const effectiveReadOnly = !canPublish || this.previewChannel.readOnly;
            this.previewChannel.effectiveReadOnly = effectiveReadOnly;
            
            // Update header label
            if (elements.currentChannelInfo) {
                elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(
                    this.previewChannel.type, 
                    effectiveReadOnly
                );
            }
            
            // Update input state
            if (!canPublish) {
                const messageInput = elements.messageInput;
                const sendBtn = document.querySelector('#send-btn');
                if (messageInput) {
                    messageInput.disabled = true;
                    messageInput.placeholder = 'This channel is read-only';
                    messageInput.classList.add('cursor-not-allowed', 'opacity-50');
                }
                if (sendBtn) {
                    sendBtn.disabled = true;
                    sendBtn.classList.add('opacity-50', 'cursor-not-allowed');
                }
            }
            
            Logger.debug('Preview permission check:', {
                streamId: this.previewChannel.streamId,
                canPublish,
                effectiveReadOnly
            });
        } catch (error) {
            Logger.warn('Failed to check preview permissions:', error.message);
        }
    }

    /**
     * Add preview channel to user's list (convert preview to joined)
     */
    async addPreviewToList() {
        if (!this.previewChannel) {
            Logger.warn('No preview channel to add');
            return;
        }

        const { channelManager, subscriptionManager, reactionManager, notificationUI } = this.deps;

        try {
            const { streamId, channelInfo, name, type, readOnly, messages } = this.previewChannel;

            notificationUI.showLoadingToast('Adding channel...', 'Saving to your list');

            // Use fast path - channel already subscribed via preview
            await channelManager.persistChannelFromPreview(streamId, {
                name: name,
                type: type,
                readOnly: readOnly,
                createdBy: channelInfo?.createdBy,
                messages: messages || [],
                reactions: reactionManager.exportAsObject(),
                oldestTimestamp: this.previewChannel.oldestTimestamp || null
            });

            // Clear preview state
            const previewStreamId = streamId;
            this.previewChannel = null;

            // Transfer subscription handlers from preview to channelManager
            await subscriptionManager.promotePreviewToActive(previewStreamId);

            // Update UI - hide Join, show Invite
            this.ui.elements.joinChannelBtn?.classList.add('hidden');
            this.ui.elements.inviteUsersBtn?.classList.remove('hidden');

            // Update channel list in sidebar
            this.ui.renderChannelList();

            // Select the now-joined channel
            await this.ui.selectChannel(previewStreamId);

            this.ui.showNotification('Channel added to your list!', 'success');
            Logger.info('Preview channel added to list:', previewStreamId);
        } catch (error) {
            Logger.error('Failed to add preview to list:', error);
            this.ui.showNotification('Failed to add channel: ' + error.message, 'error');
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Exit preview mode and return to Explore
     * @param {boolean} navigateToExplore - Whether to navigate back to Explore view (default: true)
     */
    async exitPreviewMode(navigateToExplore = true) {
        if (!this.previewChannel) return;

        const { subscriptionManager, reactionManager } = this.deps;

        try {
            const streamId = this.previewChannel.streamId;

            // Unsubscribe from preview channel
            await subscriptionManager.clearPreviewChannel();

            // Clear preview state
            this.previewChannel = null;

            // Reset any stuck loading indicator from preview history loading
            const { chatAreaUI } = this.deps;
            if (chatAreaUI) {
                chatAreaUI.isLoadingMore = false;
                chatAreaUI.hideLoadingMoreIndicator();
            }

            // Clear stale reactions from the previewed channel
            reactionManager.loadFromChannelState({});

            // Hide Join button
            this.ui.elements.joinChannelBtn?.classList.add('hidden');

            Logger.info('Exited preview mode for:', streamId);

            // Navigate back to Explore if requested
            if (navigateToExplore) {
                await this.ui.openExploreView();
            }
        } catch (error) {
            Logger.error('Error exiting preview mode:', error);
            this.previewChannel = null;
        }
    }

    /**
     * Handle message received in preview mode
     * @param {Object} message - Message object
     */
    async handlePreviewMessage(message) {
        if (!this.previewChannel) return;

        const { reactionManager, identityManager, chatAreaUI, mediaHandler } = this.deps;

        // Filter out non-content messages (presence, typing)
        if (message?.type === 'presence' || message?.type === 'typing') {
            return;
        }

        // Handle reactions in preview mode
        if (message?.type === 'reaction') {
            const reactionUser = message.user || message.senderId;
            if (!reactionUser) return;
            reactionManager.handleIncomingReaction(
                message.messageId,
                message.emoji,
                reactionUser,
                message.action || 'add'
            );
            return;
        }

        // Validate message has required properties
        const isTextMessage = message?.text;
        const isImageMessage = message?.type === 'image' && message?.imageId;
        const isVideoMessage = message?.type === 'video_announce' && message?.metadata;

        if (!message?.id || !message?.sender || !message?.timestamp) {
            return;
        }

        if (!isTextMessage && !isImageMessage && !isVideoMessage) {
            Logger.debug('Preview: Unknown message type, skipping:', message?.type);
            return;
        }

        // Deduplication: skip if message already exists
        const exists = this.previewChannel.messages.some(m => m.id === message.id);
        if (exists) {
            Logger.debug('Preview: Message already exists, skipping:', message.id);
            return;
        }

        Logger.debug('Preview message received:', message.id, message.text?.slice(0, 30));

        // Verify message signature (same as channel mode)
        const streamId = this.previewChannel.streamId;
        const isRecentMessage = Date.now() - message.timestamp < 30000;
        
        try {
            // Add channelId if missing
            if (!message.channelId) {
                message.channelId = streamId;
            }
            
            const verification = await identityManager.verifyMessage(message, streamId, {
                skipTimestampCheck: !isRecentMessage
            });
            message.verified = verification;
        } catch (error) {
            Logger.error('Preview verification error:', error);
            message.verified = { valid: false, error: error.message, trustLevel: -1 };
        }

        // Check if preview channel still exists (may have been cleared during async verification)
        if (!this.previewChannel) {
            Logger.debug('Preview: Channel cleared during verification, skipping message');
            return;
        }

        // Mark as no longer loading (we got at least one message)
        this.previewChannel.isLoading = false;

        // Track oldest timestamp for pagination (scroll-to-top load-more)
        if (!this.previewChannel.oldestTimestamp || message.timestamp < this.previewChannel.oldestTimestamp) {
            this.previewChannel.oldestTimestamp = message.timestamp;
        }

        // Add message to preview channel
        this.previewChannel.messages.push(message);

        // Sort by timestamp to ensure correct order
        this.previewChannel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        // Re-render messages
        chatAreaUI.renderMessages(this.previewChannel.messages, () => {
            this.ui.attachReactionListeners();
            mediaHandler.attachLightboxListeners();
        });

        // Scroll to bottom
        if (this.ui.elements.messagesArea) {
            this.ui.elements.messagesArea.scrollTop = this.ui.elements.messagesArea.scrollHeight;
        }
    }

    /**
     * Send a message in preview mode (directly to stream without channelManager)
     * @param {string} text - Message text
     * @param {Object} replyTo - Reply to message (optional)
     */
    async sendPreviewMessage(text, replyTo = null) {
        if (!this.previewChannel) return;

        const { identityManager, streamrController, chatAreaUI, mediaHandler } = this.deps;
        
        const streamId = this.previewChannel.streamId;
        
        // Create signed message using identity manager (same as channelManager)
        const message = await identityManager.createSignedMessage(text, streamId, replyTo);
        
        // Add verification info for local display
        message.verified = {
            valid: true,
            trustLevel: await identityManager.getTrustLevel(message.sender)
        };
        
        // Add to local preview messages immediately
        this.previewChannel.messages.push(message);
        this.previewChannel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        chatAreaUI.renderMessages(this.previewChannel.messages, () => {
            this.ui.attachReactionListeners();
            mediaHandler.attachLightboxListeners();
        });
        
        // Scroll to bottom
        if (this.ui.elements.messagesArea) {
            this.ui.elements.messagesArea.scrollTop = this.ui.elements.messagesArea.scrollHeight;
        }
        
        // Publish to the message stream
        await streamrController.publishMessage(streamId, message);
        
        Logger.debug('Preview message sent:', message.id);
    }

    /**
     * Send a reaction in preview mode (directly to stream without channelManager)
     * @param {string} msgId - Message ID to react to
     * @param {string} emoji - Emoji reaction
     * @param {boolean} isRemoving - True if removing reaction
     */
    async sendPreviewReaction(msgId, emoji, isRemoving) {
        if (!this.previewChannel) return;

        const { authManager, streamrController } = this.deps;
        
        const streamId = this.previewChannel.streamId;
        const action = isRemoving ? 'remove' : 'add';
        
        try {
            const reaction = {
                type: 'reaction',
                action: action,
                messageId: msgId,
                emoji: emoji,
                user: authManager.getAddress(),
                timestamp: Date.now()
            };

            // Publish to message stream (reactions are stored with messages)
            await streamrController.publishReaction(streamId, reaction, this.previewChannel.password);
            
            Logger.debug('Preview reaction sent:', action, emoji, 'to', msgId);
        } catch (error) {
            Logger.error('Failed to send preview reaction:', error);
            this.ui.showNotification('Failed to send reaction', 'error');
        }
    }
    /**
     * Load older history for preview channel (scroll-to-top load-more)
     * @returns {Promise<{loaded: number, hasMore: boolean}>}
     */
    async loadMorePreviewHistory() {
        if (!this.previewChannel) return { loaded: 0, hasMore: false };
        if (this.previewChannel.loadingHistory) return { loaded: 0, hasMore: true };

        const { streamrController, identityManager, chatAreaUI, mediaHandler } = this.deps;
        const channel = this.previewChannel;
        const streamId = channel.streamId;

        // Use oldest message timestamp, or compute from existing messages, or Date.now()
        let beforeTimestamp = channel.oldestTimestamp;
        if (!beforeTimestamp && channel.messages.length > 0) {
            beforeTimestamp = Math.min(...channel.messages.map(m => m.timestamp || Infinity));
            channel.oldestTimestamp = beforeTimestamp;
        }
        if (!beforeTimestamp) beforeTimestamp = Date.now();

        channel.loadingHistory = true;

        try {
            const result = await streamrController.fetchOlderHistory(
                streamId,
                0, // partition 0 (messages)
                beforeTimestamp,
                30,
                channel.password
            );

            if (!this.previewChannel) return { loaded: 0, hasMore: false };

            // Separate reactions from content messages
            let addedCount = 0;
            const { reactionManager } = this.deps;

            for (const msg of result.messages) {
                if (msg?.type === 'reaction') {
                    const reactionUser = msg.user || msg.senderId;
                    if (reactionUser) {
                        reactionManager.handleIncomingReaction(
                            msg.messageId, msg.emoji, reactionUser, msg.action || 'add'
                        );
                    }
                    // Track oldest timestamp from reactions too (for pagination progress)
                    if (msg.timestamp && (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp)) {
                        channel.oldestTimestamp = msg.timestamp;
                    }
                    continue;
                }

                if (!msg?.id || !msg?.sender || !msg?.timestamp) continue;
                if (channel.messages.some(m => m.id === msg.id)) continue;

                // Verify signature
                try {
                    if (!msg.channelId) msg.channelId = streamId;
                    msg.verified = await identityManager.verifyMessage(msg, streamId, { skipTimestampCheck: true });
                } catch (e) {
                    msg.verified = { valid: false, error: e.message, trustLevel: -1 };
                }

                channel.messages.push(msg);
                addedCount++;

                if (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp) {
                    channel.oldestTimestamp = msg.timestamp;
                }
            }

            if (addedCount > 0) {
                channel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            }

            channel.hasMoreHistory = result.hasMore;
            Logger.debug(`Preview: Loaded ${addedCount} older messages, hasMore: ${result.hasMore}`);

            return { loaded: addedCount, hasMore: result.hasMore };
        } catch (error) {
            Logger.error('Preview: Failed to load more history:', error);
            return { loaded: 0, hasMore: true };
        } finally {
            if (this.previewChannel) {
                this.previewChannel.loadingHistory = false;
            }
        }
    }
}

// Export singleton
export const previewModeUI = new PreviewModeUI();
