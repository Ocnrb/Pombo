/**
 * ChatAreaUI
 * Manages the main chat area: message rendering, scrolling, loading history,
 * typing indicators, reply state, and unread counts.
 */

import { notificationUI } from './NotificationUI.js';
import { messageRenderer } from './MessageRenderer.js';
import { reactionManager } from './ReactionManager.js';
import { mediaHandler } from './MediaHandler.js';
import { previewModeUI } from './PreviewModeUI.js';
import { pinnedBannerUI } from './PinnedBannerUI.js';
import { analyzeMessageGroups, getGroupPositionClass, analyzeSpacing, getSpacingClass } from './MessageGrouper.js';
import { escapeHtml, formatAddress } from './utils.js';
import { identityManager } from '../identity.js';
import { CONFIG } from '../config.js';

class ChatAreaUI {
    constructor() {
        this.deps = {};
        
        // Elements
        this.messagesArea = null;
        this.replyBar = null;
        this.replyToName = null;
        this.replyToText = null;
        this.messageInput = null;
        
        // Scroll/loading state
        this.isLoadingMore = false;
        this._channelSwitching = false; // guard against spurious events during channel transition
        
        // Reply state
        this.replyingTo = null;
        
        // Edit state
        this.editingMessage = null;
    }

    /**
     * Inject dependencies (avoids circular imports)
     * @param {Object} deps - { 
     *   channelManager, authManager, secureStorage, Logger,
     *   getActiveChannel, mediaController 
     * }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Initialize with DOM elements
     * @param {Object} elements - { messagesArea, replyBar, replyToName, replyToText, messageInput }
     */
    init(elements) {
        this.messagesArea = elements.messagesArea;
        this.replyBar = elements.replyBar;
        this.replyToName = elements.replyToName;
        this.replyToText = elements.replyToText;
        this.messageInput = elements.messageInput;
        this._wireAdminStateHandler();
    }

    /**
     * Re-render the active channel whenever its admin state changes so
     * banned-member messages and hidden message IDs disappear immediately
     * (e.g. after the admin-stream bootstrap arrives post-render).
     * @private
     */
    _wireAdminStateHandler() {
        if (this._adminHandlerWired) return;
        const { channelManager } = this.deps;
        if (!channelManager?.onMessage) return;
        channelManager.onMessage((event, data) => {
            if (event !== 'admin_state_updated') return;
            const channel = channelManager.getCurrentChannel?.();
            if (!channel || channel.streamId !== data?.streamId) return;
            this.renderMessages(channel.messages, () => {
                this._attachMessageListeners?.();
            });
        });
        this._adminHandlerWired = true;
    }

    /**
     * Trigger a history load. Invoked by the IntersectionObserver on the
     * top sentinel (modern infinite-scroll pattern) — no per-frame scrollTop
     * reads. Kept as a named method so tests and programmatic callers
     * (e.g. _autoLoadIfContentShort) can still invoke it directly.
     */
    async handleMessagesScroll() {
        if (!this.messagesArea) return;
        
        // Suppress events during channel transitions (innerHTML='' can cause spurious events)
        if (this._channelSwitching) return;
        
        // Prevent concurrent loads
        if (this.isLoadingMore) return;
        
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel();
        const previewChannel = previewModeUI.getPreviewChannel();
        
        // Don't trigger loadMore during initial history load — let it complete
        // first. Applies to both regular channels and preview mode (preview was
        // previously unguarded, causing redundant P0/P1 refetches and duplicate
        // message injections while the initial resend was still streaming).
        if (channel?.initialLoadInProgress) return;
        if (previewChannel?.initialLoadInProgress) return;
        
        // Must have either a regular channel or a preview channel with more history
        if (channel && channel.hasMoreHistory) {
            await this._loadMoreChannelHistory(channel, channelManager);
        } else if (previewChannel && previewChannel.hasMoreHistory !== false) {
            await this._loadMorePreviewHistory(previewChannel);
        }
    }

    /**
     * Load more history for a regular channel
     * @private
     */
    async _loadMoreChannelHistory(channel, channelManager) {
        this.isLoadingMore = true;
        const generationAtStart = channelManager.switchGeneration;
        
        // Only show "Loading More" indicator if there are existing messages
        // (otherwise the central spinner from renderMessages is already showing)
        const showIndicator = channel.messages.length > 0;
        if (showIndicator) this.showLoadingMoreIndicator();
        
        // Remove any existing "search older" banner before loading
        this._removeSearchOlderBanner();
        
        const previousScrollHeight = this.messagesArea.scrollHeight;
        const previousScrollTop = this.messagesArea.scrollTop;
        
        try {
            const result = await channelManager.loadMoreHistory(channel.streamId);
            
            if (channelManager.switchGeneration !== generationAtStart) return;
            
            if (result.loaded > 0) {
                this.renderMessages(channel.messages, () => {
                    this._attachMessageListeners();
                });
                
                const newScrollHeight = this.messagesArea.scrollHeight;
                const heightDiff = newScrollHeight - previousScrollHeight;
                this.messagesArea.scrollTop = previousScrollTop + heightDiff;
            } else if (result.noResultsInWindow && result.hasMore) {
                // DM pagination: no messages from this peer in the current time window
                this._showSearchOlderBanner(channel, channelManager);
            } else if (!result.hasMore && result.loaded === 0) {
                // Reached the beginning — show end-of-history marker for DMs
                if (channel.type === 'dm') {
                    this._showBeginningOfConversation();
                }
            } else if (channel.messages.length === 0) {
                // No messages loaded and channel is empty - re-render to update spinner to "no messages"
                this.renderMessages(channel.messages);
            }
        } catch (error) {
            this.deps.Logger?.error('Failed to load more messages:', error);
        } finally {
            if (showIndicator) this.hideLoadingMoreIndicator();
            this.isLoadingMore = false;
        }
    }

    /**
     * Show "No messages found — Search older" banner at top of messages area (DM pagination)
     * @private
     */
    _showSearchOlderBanner(channel, channelManager) {
        this._removeSearchOlderBanner();
        
        const banner = document.createElement('div');
        banner.id = 'dm-search-older-banner';
        banner.className = 'flex justify-center py-3 cursor-pointer group';
        banner.innerHTML = `
            <div class="flex items-center gap-2 text-white/30 text-sm group-hover:text-white/60 transition-colors">
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span>No messages found in this time range — Search older</span>
            </div>
        `;
        banner.addEventListener('click', async () => {
            banner.remove();
            await this._loadMoreChannelHistory(channel, channelManager);
        });
        this.messagesArea?.prepend(banner);
    }

    /**
     * Show "Beginning of conversation" marker at top (DM pagination exhausted)
     * @private
     */
    _showBeginningOfConversation() {
        this._removeSearchOlderBanner();
        
        const marker = document.createElement('div');
        marker.id = 'dm-search-older-banner';
        marker.className = 'flex justify-center py-3';
        marker.innerHTML = `
            <div class="flex items-center gap-2 text-white/20 text-sm">
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 11l7-7 7 7M5 19l7-7 7 7" />
                </svg>
                <span>Beginning of conversation</span>
            </div>
        `;
        this.messagesArea?.prepend(marker);
    }

    /**
     * Remove the "search older" or "beginning" banner
     * @private
     */
    _removeSearchOlderBanner() {
        document.getElementById('dm-search-older-banner')?.remove();
    }

    /**
     * Load more history for a preview channel
     * @private
     */
    async _loadMorePreviewHistory(previewChannel) {
        this.isLoadingMore = true;
        
        // Only show "Loading More" indicator if there are existing messages
        // (otherwise the central spinner from renderMessages is already showing)
        const showIndicator = previewChannel.messages.length > 0;
        if (showIndicator) this.showLoadingMoreIndicator();
        
        const previousScrollHeight = this.messagesArea.scrollHeight;
        const previousScrollTop = this.messagesArea.scrollTop;
        
        try {
            const result = await previewModeUI.loadMorePreviewHistory();
            
            if (!previewModeUI.isInPreviewMode()) return;
            
            if (result.loaded > 0) {
                this.renderMessages(previewChannel.messages, () => {
                    this._attachMessageListeners();
                });
                
                const newScrollHeight = this.messagesArea.scrollHeight;
                const heightDiff = newScrollHeight - previousScrollHeight;
                this.messagesArea.scrollTop = previousScrollTop + heightDiff;
            } else if (previewChannel.messages.length === 0) {
                // No messages loaded and channel is empty - re-render to update spinner to "no messages"
                this.renderMessages(previewChannel.messages);
            }
        } catch (error) {
            this.deps.Logger?.error('Failed to load more preview messages:', error);
        } finally {
            if (showIndicator) this.hideLoadingMoreIndicator();
            this.isLoadingMore = false;
        }
    }

    /**
     * Show loading indicator at top of messages
     */
    showLoadingMoreIndicator() {
        notificationUI.showLoadingMoreIndicator(this.messagesArea);
    }

    /**
     * Hide loading indicator
     */
    hideLoadingMoreIndicator() {
        notificationUI.hideLoadingMoreIndicator();
    }

    /**
     * Attach reaction/reply/download listeners to message buttons.
     * Used as callback after renderMessages completes.
     * @private
     */
    _attachMessageListeners() {
        const { mediaController } = this.deps;
        const channel = this.deps.channelManager?.getCurrentChannel() || previewModeUI.getPreviewChannel();
        
        reactionManager.attachReactionListeners(
            (msgId) => this.startReply(msgId),
            async (fileId) => {
                if (channel && mediaController) {
                    await mediaHandler.handleFileDownload(fileId, channel, mediaController);
                }
            },
            (msgId) => this.scrollToMessage(msgId)
        );
        mediaHandler.attachLightboxListeners();
    }

    /**
     * Render messages in the chat area
     * @param {Array} messages - Array of message objects
     * @param {Function} onRenderComplete - Callback after render (for attaching listeners)
     */
    renderMessages(messages, onRenderComplete = null) {
        const { channelManager, authManager, getActiveChannel } = this.deps;
        
        const channel = getActiveChannel ? getActiveChannel() : channelManager?.getCurrentChannel();
        const previewChannel = previewModeUI.getPreviewChannel?.();
        const effectiveChannel = previewChannel || channel;
        const hasMoreHistory = effectiveChannel?.hasMoreHistory !== false;
        
        if (!this.messagesArea) return;

        // Refresh pinned-message banner whenever we re-render (channel switch,
        // admin update, history complete, etc.).
        pinnedBannerUI.update();

        // While initial history reconciliation is in progress, render cached
        // messages if any exist (avoids hiding persisted state behind a spinner
        // while the storage-node resend iterator completes — particularly slow
        // for native channels). Only gate to empty when there is nothing cached
        // to show. A second render fires on `initial_history_complete` to
        // reconcile with any newly fetched content/overrides.
        const sourceMessages = Array.isArray(messages) ? messages : [];
        const adminState = effectiveChannel?.adminState;
        const hiddenIds = adminState && Array.isArray(adminState.hiddenMessageIds)
            ? new Set(adminState.hiddenMessageIds)
            : null;
        const bannedSet = adminState && Array.isArray(adminState.bannedMembers)
            ? new Set(adminState.bannedMembers.map((a) => String(a).toLowerCase()))
            : null;
        const filteredSource = sourceMessages.filter((m) => {
            if (!m || m._deleted || ['edit', 'delete'].includes(m.type)) return false;
            if (hiddenIds && m.id && hiddenIds.has(m.id)) return false;
            if (bannedSet && m.sender && bannedSet.has(String(m.sender).toLowerCase())) return false;
            return true;
        });
        const messagesForRender = effectiveChannel?.initialLoadInProgress && filteredSource.length === 0
            ? []
            : filteredSource;
        
        // Clear any existing loading timeout
        if (this._loadingTimeoutId) {
            clearTimeout(this._loadingTimeoutId);
            this._loadingTimeoutId = null;
        }
        
        if (messagesForRender.length === 0) {
            // If there might be more history to load, show loading spinner instead of "no messages"
            if (hasMoreHistory) {
                this.messagesArea.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full text-white/40 gap-3">
                        <div class="spinner" style="width: 24px; height: 24px;"></div>
                        <span class="text-sm">Loading messages...</span>
                    </div>
                `;
                // 20s timeout fallback - if loading never completes, show empty state
                const channelId = channel?.streamId;
                this._loadingTimeoutId = setTimeout(() => {
                    const currentChannel = getActiveChannel ? getActiveChannel() : channelManager?.getCurrentChannel();
                    // Only update if still on same channel and still empty
                    if (currentChannel?.streamId === channelId && currentChannel?.messages?.length === 0) {
                        this.messagesArea.innerHTML = `
                            <div class="flex items-center justify-center h-full text-white/40">
                                No messages yet. Start the conversation!
                            </div>
                        `;
                    }
                }, 20000);
            } else {
                this.messagesArea.innerHTML = `
                    <div class="flex items-center justify-center h-full text-white/40">
                        No messages yet. Start the conversation!
                    </div>
                `;
            }
            // Still trigger auto-load — initial history may have been all reactions
            if (!this.isLoadingMore) {
                requestAnimationFrame(() => this._autoLoadIfContentShort());
            }
            return;
        }

        const currentAddress = authManager?.getAddress();
        let lastDateStr = null;
        
        let historyStartIndicator = '';
        if (!hasMoreHistory) {
            historyStartIndicator = `
                <div class="flex justify-center py-4">
                    <div class="text-white/[0.12] text-xs">
                        — beginning of conversation —
                    </div>
                </div>
            `;
        }

        // Analyze message groups for Stack Effect
        const groupPositions = analyzeMessageGroups(messagesForRender);
        // Analyze spacing for 3-level margin system
        const spacingTypes = analyzeSpacing(messagesForRender, currentAddress);

        // Build all HTML in a single pass (single innerHTML assignment — avoids double reflow)
        const messagesHtml = messagesForRender.map((msg, index) => {
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
            let displayName = msg.verified?.ensName || msg.senderName;
            if (!displayName) {
                displayName = formatAddress(msg.sender);
            }
            
            // Get group position class for Stack Effect
            const groupClass = getGroupPositionClass(groupPositions[index]);
            // Get spacing class for margin
            const spacingClass = getSpacingClass(spacingTypes[index]);
            // Get ENS avatar URL from cache (sync, no network call)
            const ensAvatarUrl = identityManager.getCachedENSAvatar(msg.sender);
            
            return dateSeparator + messageRenderer.buildMessageHTML(msg, isOwn, time, badge, displayName, groupClass, groupPositions[index], spacingClass, ensAvatarUrl);
        }).join('');

        this.messagesArea.innerHTML = historyStartIndicator + messagesHtml;

        if (!this.isLoadingMore) {
            this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
        } else {
            // Re-insert loading indicator destroyed by innerHTML replacement
            this.showLoadingMoreIndicator();
        }

        // Install IntersectionObserver sentinel for infinite scroll (replaces scroll-event polling)
        this._setupHistorySentinel();
        
        // Call render complete callback for attaching listeners
        if (onRenderComplete) {
            onRenderComplete();
        }
        
        // Auto-load more if content doesn't fill viewport (e.g. only 1 message visible)
        if (!this.isLoadingMore) {
            requestAnimationFrame(() => this._autoLoadIfContentShort());
        }
    }

    /**
     * Install a sentinel element at the top of the messages area and observe it
     * with IntersectionObserver. When the sentinel enters the root viewport,
     * more history is loaded. Replaces the old scroll-event + scrollTop threshold
     * approach (which forces a layout read on every scroll frame).
     * @private
     */
    _setupHistorySentinel() {
        if (!this.messagesArea) return;

        // Feature detect — older browsers / test environments without IO
        if (typeof IntersectionObserver === 'undefined') return;

        // Lazily create the observer (reused across renders)
        if (!this._historyObserver) {
            this._historyObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        this.handleMessagesScroll();
                    }
                }
            }, {
                root: this.messagesArea,
                rootMargin: '200px 0px 0px 0px',
                threshold: 0
            });
        } else {
            this._historyObserver.disconnect();
        }

        // Only install sentinel when there's more history to load
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel();
        const previewChannel = previewModeUI.getPreviewChannel?.();
        const hasMore = (channel && channel.hasMoreHistory) ||
                        (previewChannel && previewChannel.hasMoreHistory !== false);
        if (!hasMore) return;

        const sentinel = document.createElement('div');
        sentinel.id = 'history-sentinel';
        sentinel.setAttribute('aria-hidden', 'true');
        sentinel.style.cssText = 'height:1px;width:100%;pointer-events:none;';
        this.messagesArea.prepend(sentinel);
        this._historyObserver.observe(sentinel);
    }

    /**
     * Rebuild only a single message entry in the DOM (used when a message is edited).
     * Avoids the cost of re-rendering the entire conversation.
     * Falls back to a full render if the target node cannot be found.
     * @param {Object} msg - Updated message object
     */
    updateMessage(msg) {
        if (!this.messagesArea || !msg) return;
        const msgId = msg.id || msg.timestamp;
        if (msgId == null) return;

        const selector = `.message-entry[data-msg-id="${CSS.escape(String(msgId))}"]`;
        const existing = this.messagesArea.querySelector(selector);
        if (!existing) {
            // Not in DOM yet — fall back to full render via caller
            return false;
        }

        const { authManager } = this.deps;
        const currentAddress = authManager?.getAddress();
        const isOwn = msg.sender?.toLowerCase() === currentAddress?.toLowerCase();
        const msgDate = new Date(msg.timestamp);
        const time = msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const badge = this.getVerificationBadge(msg, isOwn);
        let displayName = msg.verified?.ensName || msg.senderName;
        if (!displayName) displayName = formatAddress(msg.sender);

        // Preserve existing grouping/spacing classes from the DOM so we don't
        // need to re-analyze the whole conversation for a single edit.
        const classes = Array.from(existing.classList);
        const groupClass = classes.find(c => c.startsWith('msg-group-')) || 'msg-group-single';
        const spacingClass = classes.find(c => c.startsWith('msg-space-') || c.startsWith('spacing-')) || '';
        // Map class back to GroupPosition enum (buildMessageHTML uses it for avatar/name logic)
        const groupPosition = groupClass === 'msg-group-first' ? 'first'
            : groupClass === 'msg-group-middle' ? 'middle'
            : groupClass === 'msg-group-last' ? 'last'
            : 'single';
        const ensAvatarUrl = identityManager.getCachedENSAvatar(msg.sender);

        const html = messageRenderer.buildMessageHTML(
            msg, isOwn, time, badge, displayName,
            groupClass, groupPosition, spacingClass, ensAvatarUrl
        );

        const template = document.createElement('template');
        template.innerHTML = html.trim();
        const newEl = template.content.firstElementChild;
        if (newEl) {
            existing.replaceWith(newEl);
            return true;
        }
        return false;
    }

    /**
     * Remove a single message entry from the DOM (used when a message is deleted).
     * Avoids the cost of re-rendering the entire conversation.
     * @param {string} msgId - Message ID to remove
     * @returns {boolean} - true if the node was found and removed
     */
    removeMessage(msgId) {
        if (!this.messagesArea || msgId == null) return false;
        const selector = `.message-entry[data-msg-id="${CSS.escape(String(msgId))}"]`;
        const existing = this.messagesArea.querySelector(selector);
        if (!existing) return false;
        existing.remove();
        return true;
    }

    /**
     * Auto-load more history if content doesn't fill the viewport.
     * Retries up to MAX_AUTO_LOAD_RETRIES times when fetched history is all reactions.
     * @private
     * @param {number} retriesLeft - Remaining retries (default: 5)
     */
    async _autoLoadIfContentShort(retriesLeft = 5) {
        if (!this.messagesArea) return;
        if (this.isLoadingMore) return;
        if (this.messagesArea.scrollHeight > this.messagesArea.clientHeight) return;
        if (retriesLeft <= 0) return;
        
        // Check if there's more history to load
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel();
        const previewChannel = previewModeUI.getPreviewChannel();
        const hasMore = (channel && channel.hasMoreHistory) || 
                        (previewChannel && previewChannel.hasMoreHistory !== false);
        if (!hasMore) return;
        
        // Content fits without scrolling - try to load more
        await this.handleMessagesScroll();
        
        // After loading, if content still doesn't fill viewport, retry
        // (handles case where fetched history was all reactions)
        if (this.messagesArea.scrollHeight <= this.messagesArea.clientHeight) {
            setTimeout(() => this._autoLoadIfContentShort(retriesLeft - 1), 300);
        }
    }

    /**
     * Scroll to a specific message with highlight
     * @param {string} msgId - Message ID to scroll to
     */
    scrollToMessage(msgId) {
        const msgElement = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
        if (msgElement) {
            msgElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            msgElement.classList.add('message-highlight');
            setTimeout(() => {
                msgElement.classList.remove('message-highlight');
            }, 1500);
        }
    }

    /**
     * Scroll to bottom of messages
     */
    scrollToBottom() {
        if (this.messagesArea) {
            this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
        }
    }

    /**
     * Start replying to a message
     * @param {string} msgId - Message ID
     */
    startReply(msgId) {
        const { getActiveChannel } = this.deps;
        const channel = getActiveChannel ? getActiveChannel() : null;
        if (!channel) return;
        
        const msg = channel.messages.find(m => (m.id || m.timestamp) === msgId);
        if (!msg) return;
        
        const displayName = msg.verified?.ensName || msg.senderName || formatAddress(msg.sender);
        
        this.replyingTo = {
            id: msgId,
            text: msg.text ? msg.text.substring(0, 100) : '',
            sender: msg.sender,
            senderName: displayName
        };
        
        // Update reply bar UI
        if (this.replyToName) {
            this.replyToName.textContent = displayName;
        }
        if (this.replyToText) {
            this.replyToText.textContent = msg.text ? msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : '') : '[Media]';
        }
        if (this.replyBar) {
            this.replyBar.classList.add('active');
        }
        
        // Focus input
        this.messageInput?.focus();
    }

    /**
     * Cancel reply mode
     */
    cancelReply() {
        this.replyingTo = null;
        if (this.replyBar) {
            this.replyBar.classList.remove('active');
        }
    }

    /**
     * Get current reply state
     * @returns {Object|null} - Reply state or null
     */
    getReplyingTo() {
        return this.replyingTo;
    }

    /**
     * Clear reply state (after message sent)
     */
    clearReply() {
        this.cancelReply();
    }

    // ==================== Edit Mode ====================

    /**
     * Enter edit mode for a message
     * @param {string} msgId - Message ID to edit
     */
    startEdit(msgId) {
        const { getActiveChannel } = this.deps;
        const channel = getActiveChannel ? getActiveChannel() : null;
        if (!channel) return;

        const msg = channel.messages.find(m => (m.id || m.timestamp) === msgId);
        if (!msg || !msg.text) return;

        // Cancel reply if active
        this.cancelReply();

        this.editingMessage = {
            id: msgId,
            originalText: msg.text,
            streamId: channel.streamId
        };

        // Show edit bar
        const editBar = document.getElementById('edit-bar');
        const editBarText = document.getElementById('edit-bar-text');
        if (editBarText) {
            editBarText.textContent = msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : '');
        }
        if (editBar) {
            editBar.classList.add('active');
        }

        // Pre-fill input with current text
        if (this.messageInput) {
            this.messageInput.value = msg.text;
            this.messageInput.dispatchEvent(new Event('input')); // trigger resize
            this.messageInput.focus();
            // Move cursor to end
            this.messageInput.setSelectionRange(msg.text.length, msg.text.length);
        }
    }

    /**
     * Cancel edit mode
     */
    cancelEdit() {
        this.editingMessage = null;
        const editBar = document.getElementById('edit-bar');
        if (editBar) {
            editBar.classList.remove('active');
        }
        // Clear input
        if (this.messageInput) {
            this.messageInput.value = '';
            this.messageInput.dispatchEvent(new Event('input'));
        }
    }

    /**
     * Get current edit state
     * @returns {Object|null} - { id, originalText, streamId } or null
     */
    getEditingMessage() {
        return this.editingMessage || null;
    }

    /**
     * Show typing indicator
     * @param {Array} users - Array of user addresses currently typing
     */
    showTypingIndicator(users) {
        const indicator = document.getElementById('typing-indicator');
        const usersSpan = document.getElementById('typing-users');
        
        if (!indicator || !usersSpan) return;
        
        if (users.length === 0) {
            indicator.classList.add('hidden');
            return;
        }
        
        const names = users.map(u => {
            const addr = u.address || u;
            const ensName = addr ? localStorage.getItem(CONFIG.storageKeys.ens(addr)) : null;
            return ensName || u.nickname || formatAddress(addr);
        }).join(', ');
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
     * Add a new message to the UI
     * @param {Object} message - Message object
     * @param {string} streamId - Stream ID the message belongs to
     * @param {Function} onRenderComplete - Callback after render
     */
    addMessage(message, streamId, onRenderComplete = null) {
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel();
        if (channel && channel.streamId === streamId) {
            this.renderMessages(channel.messages, onRenderComplete);
            this.updateUnreadCount(channel.streamId);
        }
    }

    /**
     * Update unread count badge for a channel in the sidebar
     * @param {string} streamId - Channel stream ID
     */
    updateUnreadCount(streamId) {
        const { channelManager, secureStorage } = this.deps;
        
        const countEl = document.querySelector(`[data-channel-count="${CSS.escape(streamId)}"]`);
        if (!countEl) return;
        
        const channel = channelManager?.getChannel(streamId);
        if (!channel) return;
        
        // Get last access timestamp
        const lastAccess = secureStorage?.getChannelLastAccess(streamId) || 0;
        
        // If user is currently viewing this channel, update access timestamp
        const currentChannel = channelManager?.getCurrentChannel();
        const isCurrentChannel = currentChannel?.streamId === streamId;
        
        if (isCurrentChannel) {
            // User is viewing this channel - mark as read
            secureStorage?.setChannelLastAccess(streamId, Date.now());
            countEl.classList.add('hidden');
            return;
        }
        
        // Calculate unread count (messages newer than last access)
        // Exclude deleted messages and control messages (reactions, edits, deletes)
        const unreadCount = channel.messages.filter(m => 
            m.timestamp > lastAccess && 
            !m._deleted && 
            !['reaction', 'edit', 'delete'].includes(m.type)
        ).length;
        const hasUnread = unreadCount > 0;
        
        if (hasUnread) {
            countEl.textContent = unreadCount >= 30 ? '+30' : unreadCount;
            countEl.classList.remove('hidden', 'text-white/30', 'bg-white/[0.04]');
            countEl.classList.add('text-white', 'bg-[#F6851B]/20');
        } else {
            countEl.classList.add('hidden');
            countEl.classList.remove('text-white', 'bg-[#F6851B]/20');
            countEl.classList.add('text-white/30', 'bg-white/[0.04]');
        }
    }

    /**
     * Get verification badge HTML for a message
     * @param {Object} msg - Message object
     * @param {boolean} isOwn - Whether this is the user's own message
     * @returns {Object} - { html, textColor, bgColor, border }
     */
    getVerificationBadge(msg, isOwn = false) {
        const trustLevel = msg.verified?.trustLevel ?? 0;
        const hasENS = trustLevel === 1 || (trustLevel >= 1 && msg.verified?.ensName);

        // ENS verified badge — green checkmark inside organic circle
        const ensBadgeSvg = `<svg class="inline-block" style="vertical-align: -1px" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="#4ade80" stroke-width="2" fill="none"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

        // Own messages
        if (isOwn) {
            if (hasENS) {
                return {
                    html: `<span title="ENS verified">${ensBadgeSvg}</span>`,
                    textColor: 'text-green-400',
                    bgColor: '',
                    border: ''
                };
            }
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
                textColor: 'text-white/30',
                bgColor: 'bg-white/10',
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

        // Valid signature - ENS badge overrides all other badges
        if (hasENS) {
            return {
                html: `<span title="ENS verified">${ensBadgeSvg}</span>`,
                textColor: 'text-green-400',
                bgColor: '',
                border: ''
            };
        }

        const trustedStarSvg = `<svg class="inline-block" style="vertical-align: -1px" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.5l2.9 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.3l-5.8 3.8 1.1-6.4-4.6-4.5 6.4-.9z" fill="#d4a544" opacity="0.85" stroke="#d4a544" stroke-width="0.5" stroke-linejoin="round"/></svg>`;

        const badges = {
            0: { icon: '✓', color: 'text-green-400', label: 'Valid signature' },
            2: { icon: trustedStarSvg, color: 'text-amber-400/70', label: 'Trusted contact' }
        };
        
        const badge = badges[trustLevel] || badges[0];

        return {
            html: trustLevel === 2 ? `<span title="${badge.label}">${badge.icon}</span>` : `<span class="${badge.color}" title="${badge.label}">${badge.icon}</span>`,
            textColor: badge.color,
            bgColor: '',
            border: ''
        };
    }

    /**
     * Clear all messages from the chat area
     */
    clearMessages() {
        if (this.messagesArea) {
            this.messagesArea.innerHTML = '';
        }
    }

    /**
     * Show empty state when no channel is selected
     * @param {string} message - Custom message to display
     */
    showEmptyState(message = 'Select a channel to start chatting') {
        if (this.messagesArea) {
            this.messagesArea.innerHTML = `
                <div class="flex items-center justify-center h-full text-white/40">
                    ${escapeHtml(message)}
                </div>
            `;
        }
    }
}

// Export singleton
export const chatAreaUI = new ChatAreaUI();
