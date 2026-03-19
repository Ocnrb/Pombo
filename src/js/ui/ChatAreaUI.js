/**
 * ChatAreaUI
 * Manages the main chat area: message rendering, scrolling, loading history,
 * typing indicators, reply state, and unread counts.
 */

import { notificationUI } from './NotificationUI.js';
import { messageRenderer } from './MessageRenderer.js';
import { reactionManager } from './ReactionManager.js';
import { mediaHandler } from './MediaHandler.js';
import { analyzeMessageGroups, getGroupPositionClass, analyzeSpacing, getSpacingClass } from './MessageGrouper.js';
import { escapeHtml, formatAddress } from './utils.js';

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
        this.scrollThreshold = 100; // pixels from top to trigger load
        
        // Reply state
        this.replyingTo = null;
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
    }

    /**
     * Handle scroll event - loads more history when near top
     */
    async handleMessagesScroll() {
        if (!this.messagesArea) return;
        
        // Check if scrolled near the top
        if (this.messagesArea.scrollTop > this.scrollThreshold) {
            return; // Not near top, do nothing
        }
        
        // Prevent concurrent loads
        if (this.isLoadingMore) return;
        
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel();
        if (!channel || !channel.hasMoreHistory) return;
        
        this.isLoadingMore = true;
        const generationAtStart = channelManager.switchGeneration;
        
        // Show loading indicator at top
        this.showLoadingMoreIndicator();
        
        // Save current scroll position
        const previousScrollHeight = this.messagesArea.scrollHeight;
        const previousScrollTop = this.messagesArea.scrollTop;
        
        try {
            const result = await channelManager.loadMoreHistory(channel.streamId);
            
            // Discard results if user switched channels during load
            if (channelManager.switchGeneration !== generationAtStart) return;
            
            if (result.loaded > 0) {
                // Re-render all messages
                this.renderMessages(channel.messages);
                
                // Restore scroll position (keep viewing same content)
                const newScrollHeight = this.messagesArea.scrollHeight;
                const heightDiff = newScrollHeight - previousScrollHeight;
                this.messagesArea.scrollTop = previousScrollTop + heightDiff;
            }
        } catch (error) {
            this.deps.Logger?.error('Failed to load more messages:', error);
        } finally {
            this.hideLoadingMoreIndicator();
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
     * Render messages in the chat area
     * @param {Array} messages - Array of message objects
     * @param {Function} onRenderComplete - Callback after render (for attaching listeners)
     */
    renderMessages(messages, onRenderComplete = null) {
        const { channelManager, authManager, getActiveChannel } = this.deps;
        
        const channel = getActiveChannel ? getActiveChannel() : channelManager?.getCurrentChannel();
        const hasMoreHistory = channel?.hasMoreHistory !== false;
        
        if (!this.messagesArea) return;
        
        if (messages.length === 0) {
            this.messagesArea.innerHTML = `
                <div class="flex items-center justify-center h-full text-white/40">
                    No messages yet. Start the conversation!
                </div>
            `;
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
        const groupPositions = analyzeMessageGroups(messages);
        // Analyze spacing for 3-level margin system
        const spacingTypes = analyzeSpacing(messages, currentAddress);

        this.messagesArea.innerHTML = messages.map((msg, index) => {
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
                displayName = formatAddress(msg.sender);
            }
            
            // Get group position class for Stack Effect
            const groupClass = getGroupPositionClass(groupPositions[index]);
            // Get spacing class for margin
            const spacingClass = getSpacingClass(spacingTypes[index]);
            
            return dateSeparator + messageRenderer.buildMessageHTML(msg, isOwn, time, badge, displayName, groupClass, groupPositions[index], spacingClass);
        }).join('');

        this.messagesArea.innerHTML = historyStartIndicator + this.messagesArea.innerHTML;

        if (!this.isLoadingMore) {
            this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
        }
        
        // Call render complete callback for attaching listeners
        if (onRenderComplete) {
            onRenderComplete();
        }
    }

    /**
     * Scroll to a specific message with highlight
     * @param {string} msgId - Message ID to scroll to
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
        
        const displayName = msg.senderName || msg.verified?.ensName || formatAddress(msg.sender);
        
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
        
        const names = users.map(u => formatAddress(u)).join(', ');
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
        
        const countEl = document.querySelector(`[data-channel-count="${streamId}"]`);
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
        const unreadCount = channel.messages.filter(m => m.timestamp > lastAccess).length;
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

        // Valid signature - show badges based on trust level
        const trustLevel = msg.verified?.trustLevel ?? 0;
        
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
