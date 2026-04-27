/**
 * PreviewModeUI - Handles channel preview mode functionality
 * Allows users to view channels before joining them
 */

import { Logger } from '../logger.js';
import { STREAM_CONFIG } from '../streamr.js';

class PreviewModeUI {
    constructor() {
        // Preview channel state
        this.previewChannel = null;

        // Switch fence — incremented on every preview enter/exit so async
        // work captured during a previous preview can detect that it has
        // been superseded and bail before mutating state, mirroring
        // channelManager.switchGeneration for joined channels. Prevents
        // cross-channel message leaks when the user clicks rapidly through
        // multiple Explore items.
        this.previewGeneration = 0;
        
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

        // Claim this switch. Any previous preview's in-flight async work
        // (verify, admin resend, subscribe) will see gen !== previewGeneration
        // after their awaits and bail out without touching UI/state.
        const gen = ++this.previewGeneration;

        // No longer in explore view
        document.body.classList.remove('explore-open');

        try {
            // Exit any existing preview first (only one preview at a time).
            // Use the internal teardown so it does NOT bump generation again
            // — we already claimed `gen` for this enter call.
            if (this.previewChannel) {
                this.cancelPendingPreviewVerifications(this.previewChannel);
                await this._teardownPreview(false);
                if (gen !== this.previewGeneration) return;
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
                if (gen !== this.previewGeneration) return;
            }

            // Store preview state
            this.previewChannel = {
                streamId,
                // Mirror messageStreamId so channelManager.applyAdminState() can be reused
                messageStreamId: streamId,
                channelInfo,
                name: this._getChannelDisplayName(streamId, channelInfo),
                type: channelInfo?.type || 'public',
                readOnly: channelInfo?.readOnly || false,
                password: null, // Preview mode doesn't have password (public channels only)
                // Admin/moderation layer (rebuilt on subscribe to -3/P0)
                createdBy: channelInfo?.createdBy || streamId.split('/')[0] || null,
                adminState: { bannedMembers: [], hiddenMessageIds: [], pins: [] },
                adminRev: 0,
                adminTs: 0,
                adminLoaded: false,
                messages: [],
                _pendingOverrides: new Map(),
                // In-flight dedup: ids currently being verified/pushed.
                // Prevents races when the same message arrives via both the
                // real-time websocket subscription and the HTTP resend, or via
                // concurrent resend + loadMore fetches.
                _processingIds: new Set(),
                initialLoadInProgress: true
            };

            // Capture the just-created preview as the "owner" closure for
            // the onHistoryComplete callback so a stale callback fired by
            // an old subscription cannot mutate a newer preview's state.
            const ownerChannel = this.previewChannel;

            // Subscribe to channel stream temporarily (without persisting)
            await subscriptionManager.setPreviewChannel(streamId, () => {
                // ownerChannel identity check is sufficient: every code path
                // that replaces `previewChannel` also bumps previewGeneration.
                if (this.previewChannel !== ownerChannel) return;
                this._applyPreviewOverrides();
                ownerChannel.messages = ownerChannel.messages.filter(m => !m._deleted);
                ownerChannel.initialLoadInProgress = false;
                const { chatAreaUI, mediaHandler } = this.deps;
                chatAreaUI.renderMessages(ownerChannel.messages, () => {
                    this.ui.attachReactionListeners();
                    mediaHandler.attachLightboxListeners();
                });
            });
            if (this.previewChannel !== ownerChannel) return;

            // Update UI for preview mode
            this._showPreviewUI(ownerChannel);
            
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
            // Only clear state if we are still the active switch — otherwise
            // a newer enter call already owns `previewChannel` and we must
            // not touch it.
            if (gen === this.previewGeneration) {
                this.previewChannel = null;
            }
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
     * @param {Object} [ownerChannel] - Preview channel snapshot owning this UI update.
     *   Used by the deferred empty-state setTimeout to detect rapid switches
     *   and skip the DOM mutation if a different preview now owns the area.
     * @private
     */
    _showPreviewUI(ownerChannel = this.previewChannel) {
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
            // Bail if a different preview now owns the UI (rapid switch
            // between Explore items would otherwise stomp the new
            // channel's messages area with the previous channel's empty
            // state placeholder).
            if (this.previewChannel !== ownerChannel) return;
            if (ownerChannel.isLoading && ownerChannel.messages.length === 0) {
                ownerChannel.isLoading = false;
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
        headerUI.updateChannelThumb(this.previewChannel);

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
        // Capture the owner snapshot up-front so a switch during the
        // permission RPC cannot apply state to a different channel.
        const ownerChannel = this.previewChannel;
        
        try {
            const result = await streamrController.hasPublishPermission(ownerChannel.streamId, true);
            
            // Bail if a rapid switch invalidated this preview while the
            // permission check was in flight.
            if (this.previewChannel !== ownerChannel) return;

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
            const { streamId, channelInfo, name, type, readOnly, messages, adminState, adminRev, adminTs, adminLoaded } = this.previewChannel;

            notificationUI.showLoadingToast('Joining channel...', 'Saving channel...');

            // Use fast path - channel already subscribed via preview
            await channelManager.persistChannelFromPreview(streamId, {
                name: name,
                type: type,
                readOnly: readOnly,
                createdBy: channelInfo?.createdBy,
                messages: messages || [],
                reactions: reactionManager.exportAsObject(),
                oldestTimestamp: this.previewChannel.oldestTimestamp || null,
                // Carry over moderation layer so pins / bans / hidden ids
                // stay visible across the preview→joined transition.
                adminState,
                adminRev,
                adminTs,
                adminLoaded
            });

            // Clear preview state
            const previewStreamId = streamId;
            this.previewChannel = null;

            // Transfer subscription handlers from preview to channelManager
            // (also unsubscribes the admin stream so we can rewire it below).
            await subscriptionManager.promotePreviewToActive(previewStreamId);

            // Re-bootstrap admin stream against channelManager so live
            // ADMIN_STATE updates after Join keep flowing into the joined
            // channel. Best-effort — pin/ban state already carried over via
            // persistChannelFromPreview, so failure here doesn't lose UI.
            try {
                const joined = channelManager.getChannel(previewStreamId);
                if (joined?.adminStreamId) {
                    await channelManager.bootstrapAdminState(
                        previewStreamId,
                        joined.adminStreamId,
                        joined.password || null
                    );
                }
            } catch (e) {
                Logger.warn('Post-join admin bootstrap failed:', e.message);
            }

            // Update UI - hide Join, show Invite
            this.ui.elements.joinChannelBtn?.classList.add('hidden');
            this.ui.elements.inviteUsersBtn?.classList.remove('hidden');

            // Update channel list in sidebar
            this.ui.renderChannelList();

            // Select the now-joined channel
            await this.ui.selectChannel(previewStreamId);

            this.ui.showNotification('Joined channel successfully!', 'success');
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
        // Bump generation so any in-flight async work for this preview
        // (verifyMessage, _checkAndUpdateReadOnlyState, deferred timeouts)
        // detects it has been superseded after their awaits and bails.
        this.previewGeneration++;
        this.cancelPendingPreviewVerifications(this.previewChannel);
        return this._teardownPreview(navigateToExplore);
    }

    /**
     * Cancel pending in-flight verifications for a preview channel.
     * Mirrors channelManager.cancelPendingVerifications: the actual async
     * verifyMessage promises remain in flight (we cannot abort them) but
     * downstream consumers gate on `_processingIds` and the previewGeneration
     * fence, so clearing the set + bumping the generation invalidates them.
     * Logs the discarded count for parity with the joined-channel path.
     * @param {Object} channel - Preview channel to cancel verifications for
     */
    cancelPendingPreviewVerifications(channel) {
        if (!channel?._processingIds) return;
        const discarded = channel._processingIds.size;
        channel._processingIds.clear();
        if (discarded > 0) {
            Logger.debug(`Cancelled ${discarded} pending preview verifications for`,
                String(channel.streamId || '').slice(-20));
        }
    }

    /**
     * Internal teardown of preview state without bumping the generation.
     * Used both by `exitPreviewMode` (which bumps externally) and by
     * `_enterPreviewCore` when transitioning from one preview to another
     * (the enter call has already claimed the new generation; teardown
     * must not invalidate the new switch).
     * @param {boolean} navigateToExplore
     * @private
     */
    async _teardownPreview(navigateToExplore = true) {
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
     * Handle ADMIN_STATE message received on the preview channel's -3/P0 stream.
     * Reuses channelManager.applyAdminState() so the latest-wins logic
     * (rev + ts tiebreaker) and validation remain in one place.
     * Triggers a re-render so banned/hidden messages disappear immediately.
     * @param {string} streamId - Preview channel streamId
     * @param {Object} adminMsg - Decoded ADMIN_STATE payload
     */
    handlePreviewAdmin(streamId, adminMsg) {
        if (!this.previewChannel || this.previewChannel.streamId !== streamId) return;
        const { channelManager, chatAreaUI } = this.deps;
        if (!channelManager?.applyAdminState) return;
        const applied = channelManager.applyAdminState(this.previewChannel, adminMsg);
        if (!applied) return;
        // Re-render preview timeline to drop banned/hidden messages
        if (chatAreaUI?.renderMessages) {
            chatAreaUI.renderMessages(this.previewChannel.messages, () => {
                this.ui?.attachReactionListeners?.();
                this.deps.mediaHandler?.attachLightboxListeners?.();
            });
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

        // Deduplication: skip if message already exists OR is currently being
        // processed by a concurrent handler invocation (prevents races between
        // realtime websocket delivery and HTTP resend iterator, which can both
        // call this handler for the same message id).
        if (this.previewChannel._processingIds.has(message.id)) {
            Logger.debug('Preview: Message already being processed, skipping:', message.id);
            return;
        }
        const exists = this.previewChannel.messages.some(m => m.id === message.id);
        if (exists) {
            Logger.debug('Preview: Message already exists, skipping:', message.id);
            return;
        }

        // Snapshot owner channel: rapid-switch protection. Without this,
        // a stale message from a previous Explore preview could be pushed
        // into the new preview's array after the async verify completes —
        // exactly the cross-channel leak that
        // channelManager.cancelPendingVerifications guards against for
        // joined channels. Identity check is sufficient because every
        // path that replaces `previewChannel` also bumps generation.
        const ownerChannel = this.previewChannel;
        ownerChannel._processingIds.add(message.id);

        try {
            Logger.debug('Preview message received:', message.id, message.text?.slice(0, 30));

            // Verify message signature (same as channel mode)
            const streamId = ownerChannel.streamId;
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

            // Bail if a rapid switch invalidated this preview while the
            // signature verification was in flight. Identity check covers
            // both "channel cleared" and "channel replaced" cases.
            if (this.previewChannel !== ownerChannel) {
                Logger.debug('Preview: Channel changed during verification, skipping message');
                return;
            }

            // Re-check dedup after async verify: defence-in-depth in case the
            // _processingIds set was somehow bypassed (e.g. preview channel
            // recreated mid-flight).
            if (ownerChannel.messages.some(m => m.id === message.id)) {
                Logger.debug('Preview: Message raced in during verify, skipping:', message.id);
                return;
            }

            // Mark as no longer loading (we got at least one message)
            ownerChannel.isLoading = false;

            // Track oldest timestamp for pagination (scroll-to-top load-more)
            if (!ownerChannel.oldestTimestamp || message.timestamp < ownerChannel.oldestTimestamp) {
                ownerChannel.oldestTimestamp = message.timestamp;
            }

            // Add message to preview channel
            ownerChannel.messages.push(message);

            // Sort by timestamp to ensure correct order
            ownerChannel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            // Apply any override (edit/delete) that arrived BEFORE this
            // message and was queued in `_pendingOverrides`. Race-safe by
            // design: the SDK delivers P0 (content) and P1 (overrides)
            // independently and async verification means a delete can be
            // queued before its target lands here. Without this, the
            // override would only be flushed in `onHistoryComplete` —
            // which is unreliable for streams whose resend iterator never
            // signals `done`. ChatAreaUI.renderMessages already filters
            // `_deleted` and `type:'edit'|'delete'`, so flagging is enough.
            this._applyPreviewOverrides();

            // Always render — ChatAreaUI gates to spinner only when there are no
            // cached messages. This safety net ensures messages become visible even
            // if the SDK resend iterator never signals `done` (observed with some
            // legacy streams), which would otherwise leave `initialLoadInProgress`
            // stuck at true and suppress the final onHistoryComplete render.
            chatAreaUI.renderMessages(ownerChannel.messages, () => {
                this.ui.attachReactionListeners();
                mediaHandler.attachLightboxListeners();
            });

            // Scroll to bottom
            if (this.ui.elements.messagesArea) {
                this.ui.elements.messagesArea.scrollTop = this.ui.elements.messagesArea.scrollHeight;
            }
        } finally {
            // Always release the in-flight id, whether the message was added,
            // rejected, or an error was thrown during verification. Use the
            // captured ownerChannel so we never delete from a newer preview.
            ownerChannel?._processingIds?.delete(message.id);
        }
    }

    /**
     * Handle a -1/P1 override (edit/delete) received in preview mode.
     * Applies immediately when the target is already loaded, otherwise
     * queues the override in `_pendingOverrides` so it is applied as
     * soon as the target arrives via `handlePreviewMessage`. Re-renders
     * the timeline so the message disappears (delete) or updates (edit)
     * without waiting for `onHistoryComplete` — the SDK resend iterator
     * is unreliable on some streams and may never signal `done`.
     * @param {Object} override - { type:'edit'|'delete', targetId, senderId, text?, timestamp }
     */
    handlePreviewOverride(override) {
        if (!this.previewChannel) return;
        if (!override || (override.type !== 'edit' && override.type !== 'delete')) return;
        const { chatAreaUI, mediaHandler } = this.deps;

        this._applyOrQueuePreviewOverride(override);

        if (chatAreaUI?.renderMessages) {
            chatAreaUI.renderMessages(this.previewChannel.messages, () => {
                this.ui?.attachReactionListeners?.();
                mediaHandler?.attachLightboxListeners?.();
            });
        }
    }

    /**
     * Apply pending edit/delete overrides to preview channel messages
     * @private
     */
    _applyPreviewOverrides() {
        if (!this.previewChannel?._pendingOverrides?.size) return;
        // Only delete entries that were actually applied. Targets whose
        // P0 content message hasn't landed yet (e.g. its async signature
        // verification is still in flight when onHistoryComplete fires)
        // must remain queued so the override applies as soon as the
        // message is pushed via handlePreviewMessage.
        const applied = [];
        for (const [targetId, override] of this.previewChannel._pendingOverrides) {
            const msg = this.previewChannel.messages.find(m => m.id === targetId);
            if (!msg) continue;
            if (msg.sender?.toLowerCase() !== override.senderId?.toLowerCase()) continue;
            if (override.type === 'edit' && override.text) {
                msg.text = override.text;
                msg._edited = true;
            } else if (override.type === 'delete') {
                msg._deleted = true;
            }
            applied.push(targetId);
        }
        for (const id of applied) {
            this.previewChannel._pendingOverrides.delete(id);
        }
    }

    /**
     * Apply a preview override immediately when possible, otherwise queue it.
     * @param {Object} override - Override message
     * @private
     */
    _applyOrQueuePreviewOverride(override) {
        if (!this.previewChannel || !override?.senderId || !override?.targetId) return;

        const original = this.previewChannel.messages.find(m => m.id === override.targetId);
        if (!original) {
            const pending = this.previewChannel._pendingOverrides;
            if (pending) {
                const existing = pending.get(override.targetId);
                if (!existing || override.timestamp > existing.timestamp) {
                    pending.set(override.targetId, override);
                }
            }
            return;
        }

        if (original.sender?.toLowerCase() !== override.senderId.toLowerCase()) return;

        if (override.type === 'edit' && override.text) {
            original.text = override.text;
            original._edited = true;
        } else if (override.type === 'delete') {
            original._deleted = true;
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
            const [contentResult, overrideResult] = await Promise.all([
                streamrController.fetchOlderHistory(
                    streamId,
                    STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                    beforeTimestamp,
                    30,
                    channel.password
                ),
                streamrController.fetchOlderHistory(
                    streamId,
                    STREAM_CONFIG.MESSAGE_STREAM.CONTROL,
                    beforeTimestamp,
                    30,
                    channel.password
                )
            ]);

            if (!this.previewChannel) return { loaded: 0, hasMore: false };

            // Separate reactions from content messages
            let addedCount = 0;
            const { reactionManager } = this.deps;

            for (const msg of contentResult.messages || []) {
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
                if (channel._processingIds?.has(msg.id)) continue;
                channel._processingIds?.add(msg.id);

                try {
                    // Verify signature
                    try {
                        if (!msg.channelId) msg.channelId = streamId;
                        msg.verified = await identityManager.verifyMessage(msg, streamId, { skipTimestampCheck: true });
                    } catch (e) {
                        msg.verified = { valid: false, error: e.message, trustLevel: -1 };
                    }

                    // Re-check after await (race with concurrent handler)
                    if (channel.messages.some(m => m.id === msg.id)) continue;

                    channel.messages.push(msg);
                    addedCount++;

                    if (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp) {
                        channel.oldestTimestamp = msg.timestamp;
                    }
                } finally {
                    channel._processingIds?.delete(msg.id);
                }
            }

            for (const override of overrideResult.messages || []) {
                if (override?.timestamp && (!channel.oldestTimestamp || override.timestamp < channel.oldestTimestamp)) {
                    channel.oldestTimestamp = override.timestamp;
                }
                this._applyOrQueuePreviewOverride(override);
            }

            this._applyPreviewOverrides();
            channel.messages = channel.messages.filter(m => !m._deleted);

            if (addedCount > 0) {
                channel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            }

            channel.hasMoreHistory = !!(contentResult.hasMore || overrideResult.hasMore);
            Logger.debug(`Preview: Loaded ${addedCount} older messages, hasMore: ${channel.hasMoreHistory}`);

            return { loaded: addedCount, hasMore: channel.hasMoreHistory };
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
