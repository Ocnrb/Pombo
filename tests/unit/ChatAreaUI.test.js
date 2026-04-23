/**
 * ChatAreaUI Tests
 * Covers: startEdit, cancelEdit, getEditingMessage, handleMessagesScroll, _loadMoreChannelHistory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/js/ui/NotificationUI.js', () => ({
    notificationUI: {
        showLoadingMoreIndicator: vi.fn(),
        hideLoadingMoreIndicator: vi.fn()
    }
}));

vi.mock('../../src/js/ui/MessageRenderer.js', () => ({
    messageRenderer: {
        buildMessageHTML: vi.fn(() => '<div class="message-entry">msg</div>'),
        renderDateSeparator: vi.fn(() => '')
    }
}));

vi.mock('../../src/js/ui/ReactionManager.js', () => ({
    reactionManager: {
        attachReactionListeners: vi.fn(),
        loadFromChannelState: vi.fn()
    }
}));

vi.mock('../../src/js/ui/MediaHandler.js', () => ({
    mediaHandler: {
        attachLightboxListeners: vi.fn()
    }
}));

vi.mock('../../src/js/ui/PreviewModeUI.js', () => ({
    previewModeUI: {
        getPreviewChannel: vi.fn(() => null),
        isInPreviewMode: vi.fn(() => false)
    }
}));

vi.mock('../../src/js/ui/MessageGrouper.js', () => ({
    analyzeMessageGroups: vi.fn(() => []),
    getGroupPositionClass: vi.fn(() => ''),
    analyzeSpacing: vi.fn(() => []),
    getSpacingClass: vi.fn(() => '')
}));

vi.mock('../../src/js/ui/utils.js', () => ({
    escapeHtml: vi.fn(s => s || ''),
    formatAddress: vi.fn(a => a ? a.substring(0, 8) : '')
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getENSAvatarUrl: vi.fn(() => null),
        getUserNickname: vi.fn(() => null),
        getCachedENSAvatar: vi.fn(() => null)
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { chatAreaUI } from '../../src/js/ui/ChatAreaUI.js';
import { previewModeUI } from '../../src/js/ui/PreviewModeUI.js';
import { messageRenderer } from '../../src/js/ui/MessageRenderer.js';

describe('ChatAreaUI', () => {
    let messageInput;

    beforeEach(() => {
        vi.clearAllMocks();
        previewModeUI.getPreviewChannel.mockReturnValue(null);
        previewModeUI.isInPreviewMode.mockReturnValue(false);
        chatAreaUI.editingMessage = null;
        chatAreaUI.replyingTo = null;
        chatAreaUI.isLoadingMore = false;
        chatAreaUI._channelSwitching = false;
        chatAreaUI.deps = {};

        // Set up minimal DOM
        document.body.innerHTML = `
            <div id="messages-area" style="height: 500px; overflow-y: auto;"></div>
            <div id="edit-bar"><span id="edit-bar-text"></span></div>
            <div id="reply-bar"><span id="reply-to-name"></span><span id="reply-to-text"></span></div>
            <textarea id="message-input"></textarea>
        `;

        messageInput = document.getElementById('message-input');
        chatAreaUI.init({
            messagesArea: document.getElementById('messages-area'),
            replyBar: document.getElementById('reply-bar'),
            replyToName: document.getElementById('reply-to-name'),
            replyToText: document.getElementById('reply-to-text'),
            messageInput
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ==================== startEdit ====================
    describe('startEdit()', () => {
        function setupChannel(messages = []) {
            const channel = {
                streamId: 'stream-1',
                messages
            };
            chatAreaUI.setDependencies({
                getActiveChannel: () => channel
            });
            return channel;
        }

        it('should enter edit mode for a valid message', () => {
            setupChannel([{ id: 'msg-1', text: 'Hello world', sender: '0xabc' }]);

            chatAreaUI.startEdit('msg-1');

            expect(chatAreaUI.editingMessage).toEqual({
                id: 'msg-1',
                originalText: 'Hello world',
                streamId: 'stream-1'
            });
        });

        it('should pre-fill input with message text', () => {
            setupChannel([{ id: 'msg-1', text: 'Hello world', sender: '0xabc' }]);

            chatAreaUI.startEdit('msg-1');

            expect(messageInput.value).toBe('Hello world');
        });

        it('should show edit bar with active class', () => {
            setupChannel([{ id: 'msg-1', text: 'Hello world', sender: '0xabc' }]);

            chatAreaUI.startEdit('msg-1');

            const editBar = document.getElementById('edit-bar');
            expect(editBar.classList.contains('active')).toBe(true);
        });

        it('should truncate long text in edit bar to 100 chars', () => {
            const longText = 'A'.repeat(150);
            setupChannel([{ id: 'msg-1', text: longText, sender: '0xabc' }]);

            chatAreaUI.startEdit('msg-1');

            const editBarText = document.getElementById('edit-bar-text');
            expect(editBarText.textContent).toBe('A'.repeat(100) + '...');
        });

        it('should not truncate text at exactly 100 chars', () => {
            const exactText = 'B'.repeat(100);
            setupChannel([{ id: 'msg-1', text: exactText, sender: '0xabc' }]);

            chatAreaUI.startEdit('msg-1');

            const editBarText = document.getElementById('edit-bar-text');
            expect(editBarText.textContent).toBe(exactText);
        });

        it('should cancel active reply before editing', () => {
            chatAreaUI.replyingTo = { id: 'reply-1', text: 'some reply' };
            const replyBar = document.getElementById('reply-bar');
            replyBar.classList.add('active');

            setupChannel([{ id: 'msg-1', text: 'edit me', sender: '0xabc' }]);

            chatAreaUI.startEdit('msg-1');

            expect(chatAreaUI.replyingTo).toBeNull();
            expect(replyBar.classList.contains('active')).toBe(false);
        });

        it('should do nothing if no active channel', () => {
            chatAreaUI.setDependencies({ getActiveChannel: () => null });

            chatAreaUI.startEdit('msg-1');

            expect(chatAreaUI.editingMessage).toBeNull();
        });

        it('should do nothing if message not found', () => {
            setupChannel([{ id: 'msg-other', text: 'Other', sender: '0xabc' }]);

            chatAreaUI.startEdit('msg-nonexistent');

            expect(chatAreaUI.editingMessage).toBeNull();
        });

        it('should do nothing if message has no text', () => {
            setupChannel([{ id: 'msg-1', sender: '0xabc' }]);

            chatAreaUI.startEdit('msg-1');

            expect(chatAreaUI.editingMessage).toBeNull();
        });

        it('should match by timestamp fallback if id missing', () => {
            setupChannel([{ timestamp: 12345, text: 'ts msg', sender: '0xabc' }]);

            chatAreaUI.startEdit(12345);

            expect(chatAreaUI.editingMessage).toEqual({
                id: 12345,
                originalText: 'ts msg',
                streamId: 'stream-1'
            });
        });
    });

    // ==================== cancelEdit ====================
    describe('cancelEdit()', () => {
        it('should clear edit state', () => {
            chatAreaUI.editingMessage = { id: 'msg-1', originalText: 'text', streamId: 's1' };

            chatAreaUI.cancelEdit();

            expect(chatAreaUI.editingMessage).toBeNull();
        });

        it('should remove active class from edit bar', () => {
            const editBar = document.getElementById('edit-bar');
            editBar.classList.add('active');

            chatAreaUI.cancelEdit();

            expect(editBar.classList.contains('active')).toBe(false);
        });

        it('should clear message input', () => {
            messageInput.value = 'some text';

            chatAreaUI.cancelEdit();

            expect(messageInput.value).toBe('');
        });

        it('should dispatch input event to trigger resize', () => {
            const inputSpy = vi.fn();
            messageInput.addEventListener('input', inputSpy);

            chatAreaUI.cancelEdit();

            expect(inputSpy).toHaveBeenCalled();
        });
    });

    // ==================== getEditingMessage ====================
    describe('getEditingMessage()', () => {
        it('should return null when not editing', () => {
            expect(chatAreaUI.getEditingMessage()).toBeNull();
        });

        it('should return edit state when editing', () => {
            const editState = { id: 'msg-1', originalText: 'hello', streamId: 's1' };
            chatAreaUI.editingMessage = editState;

            expect(chatAreaUI.getEditingMessage()).toEqual(editState);
        });
    });

    // ==================== handleMessagesScroll ====================
    describe('handleMessagesScroll()', () => {
        it('should return early if no messagesArea', async () => {
            chatAreaUI.messagesArea = null;

            await chatAreaUI.handleMessagesScroll();

            expect(chatAreaUI.isLoadingMore).toBe(false);
        });

        it('should return early if channel switching', async () => {
            chatAreaUI._channelSwitching = true;

            await chatAreaUI.handleMessagesScroll();

            expect(chatAreaUI.isLoadingMore).toBe(false);
        });

        it('should return early if already loading', async () => {
            Object.defineProperty(chatAreaUI.messagesArea, 'scrollTop', { value: 10, configurable: true });
            chatAreaUI.isLoadingMore = true;

            const loadSpy = vi.spyOn(chatAreaUI, '_loadMoreChannelHistory');
            await chatAreaUI.handleMessagesScroll();

            expect(loadSpy).not.toHaveBeenCalled();
        });

        it('should return early if initial load in progress', async () => {
            Object.defineProperty(chatAreaUI.messagesArea, 'scrollTop', { value: 10, configurable: true });
            const channel = { hasMoreHistory: true, initialLoadInProgress: true, messages: [] };
            chatAreaUI.setDependencies({
                channelManager: { getCurrentChannel: () => channel }
            });

            const loadSpy = vi.spyOn(chatAreaUI, '_loadMoreChannelHistory');
            await chatAreaUI.handleMessagesScroll();

            expect(loadSpy).not.toHaveBeenCalled();
        });

        it('should call _loadMoreChannelHistory when near top with more history', async () => {
            Object.defineProperty(chatAreaUI.messagesArea, 'scrollTop', { value: 10, configurable: true });
            const channel = { hasMoreHistory: true, messages: [{ id: '1', text: 'hi' }], streamId: 's1' };
            const channelManager = { getCurrentChannel: () => channel };
            chatAreaUI.setDependencies({ channelManager });

            const loadSpy = vi.spyOn(chatAreaUI, '_loadMoreChannelHistory').mockResolvedValue();
            await chatAreaUI.handleMessagesScroll();

            expect(loadSpy).toHaveBeenCalledWith(channel, channelManager);
        });

        it('should not load if channel has no more history', async () => {
            Object.defineProperty(chatAreaUI.messagesArea, 'scrollTop', { value: 10, configurable: true });
            const channel = { hasMoreHistory: false, messages: [] };
            chatAreaUI.setDependencies({
                channelManager: { getCurrentChannel: () => channel }
            });

            const loadSpy = vi.spyOn(chatAreaUI, '_loadMoreChannelHistory');
            await chatAreaUI.handleMessagesScroll();

            expect(loadSpy).not.toHaveBeenCalled();
        });

        it('should load preview channel history if in preview mode', async () => {
            Object.defineProperty(chatAreaUI.messagesArea, 'scrollTop', { value: 10, configurable: true });
            chatAreaUI.setDependencies({
                channelManager: { getCurrentChannel: () => null }
            });

            const previewChannel = { hasMoreHistory: true, messages: [{ id: '1', text: 'preview' }] };
            previewModeUI.getPreviewChannel.mockReturnValue(previewChannel);

            const loadSpy = vi.spyOn(chatAreaUI, '_loadMorePreviewHistory').mockResolvedValue();
            await chatAreaUI.handleMessagesScroll();

            expect(loadSpy).toHaveBeenCalledWith(previewChannel);
        });
    });

    // ==================== _loadMoreChannelHistory ====================
    describe('_loadMoreChannelHistory()', () => {
        let channel, channelManager;

        beforeEach(() => {
            channel = {
                streamId: 'stream-1',
                hasMoreHistory: true,
                messages: [{ id: 'msg-1', text: 'hello', sender: '0xabc', timestamp: 1000 }],
                type: 'public'
            };
            channelManager = {
                switchGeneration: 1,
                loadMoreHistory: vi.fn().mockResolvedValue({ loaded: 5, hasMore: true })
            };
            chatAreaUI.setDependencies({
                channelManager,
                Logger: { error: vi.fn() }
            });
        });

        it('should set isLoadingMore to true then false', async () => {
            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(chatAreaUI.isLoadingMore).toBe(false);
        });

        it('should call loadMoreHistory with streamId', async () => {
            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(channelManager.loadMoreHistory).toHaveBeenCalledWith('stream-1');
        });

        it('should re-render messages when history is loaded', async () => {
            const renderSpy = vi.spyOn(chatAreaUI, 'renderMessages');
            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(renderSpy).toHaveBeenCalled();
        });

        it('should abort if switchGeneration changed', async () => {
            channelManager.loadMoreHistory.mockImplementation(async () => {
                channelManager.switchGeneration = 99; // simulate channel switch during load
                return { loaded: 5, hasMore: true };
            });

            const renderSpy = vi.spyOn(chatAreaUI, 'renderMessages');
            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(renderSpy).not.toHaveBeenCalled();
        });

        it('should not show loading indicator for empty channel', async () => {
            const { notificationUI } = await import('../../src/js/ui/NotificationUI.js');
            channel.messages = [];

            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(notificationUI.showLoadingMoreIndicator).not.toHaveBeenCalled();
        });

        it('should show loading indicator when channel has messages', async () => {
            const { notificationUI } = await import('../../src/js/ui/NotificationUI.js');

            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(notificationUI.showLoadingMoreIndicator).toHaveBeenCalled();
            expect(notificationUI.hideLoadingMoreIndicator).toHaveBeenCalled();
        });

        it('should handle loadMoreHistory error gracefully', async () => {
            const logError = vi.fn();
            chatAreaUI.setDependencies({ channelManager, Logger: { error: logError } });
            channelManager.loadMoreHistory.mockRejectedValue(new Error('network'));

            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(logError).toHaveBeenCalled();
            expect(chatAreaUI.isLoadingMore).toBe(false);
        });

        it('should show beginning-of-conversation for DM with no more history', async () => {
            channel.type = 'dm';
            channelManager.loadMoreHistory.mockResolvedValue({ loaded: 0, hasMore: false });

            const beginSpy = vi.spyOn(chatAreaUI, '_showBeginningOfConversation');
            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(beginSpy).toHaveBeenCalled();
        });

        it('should show search-older banner when no results in window', async () => {
            channelManager.loadMoreHistory.mockResolvedValue({
                loaded: 0, hasMore: true, noResultsInWindow: true
            });

            const bannerSpy = vi.spyOn(chatAreaUI, '_showSearchOlderBanner');
            await chatAreaUI._loadMoreChannelHistory(channel, channelManager);

            expect(bannerSpy).toHaveBeenCalledWith(channel, channelManager);
        });
    });

    // ==================== renderMessages() ====================
    describe('renderMessages()', () => {
        beforeEach(() => {
            chatAreaUI.setDependencies({
                channelManager: {
                    getCurrentChannel: () => null
                },
                authManager: {
                    getAddress: () => '0xme'
                },
                getActiveChannel: () => ({
                    streamId: 'stream-1',
                    hasMoreHistory: true,
                    initialLoadInProgress: false
                })
            });
        });

        it('should show loading state during initial load when no cached messages exist', () => {
            chatAreaUI.setDependencies({
                channelManager: {
                    getCurrentChannel: () => null
                },
                authManager: {
                    getAddress: () => '0xme'
                },
                getActiveChannel: () => ({
                    streamId: 'stream-1',
                    hasMoreHistory: true,
                    initialLoadInProgress: true
                })
            });

            // No cached messages — spinner should be shown
            chatAreaUI.renderMessages([]);

            expect(chatAreaUI.messagesArea.textContent).toContain('Loading messages...');
            expect(messageRenderer.buildMessageHTML).not.toHaveBeenCalled();
        });

        it('should render cached messages during initial load (avoids hiding persisted state behind spinner)', () => {
            chatAreaUI.setDependencies({
                channelManager: {
                    getCurrentChannel: () => null
                },
                authManager: {
                    getAddress: () => '0xme'
                },
                getActiveChannel: () => ({
                    streamId: 'stream-1',
                    hasMoreHistory: true,
                    initialLoadInProgress: true
                })
            });

            // Cached messages present — should render immediately, even while
            // initial history reconciliation is still in progress. A second
            // render triggered by `initial_history_complete` will reconcile.
            chatAreaUI.renderMessages([
                { id: 'msg-1', text: 'hello', sender: '0xother', timestamp: Date.now() }
            ]);

            expect(chatAreaUI.messagesArea.textContent).not.toContain('Loading messages...');
            expect(messageRenderer.buildMessageHTML).toHaveBeenCalled();
        });

        it('should filter out deleted and edit/delete control messages before rendering', () => {
            chatAreaUI.renderMessages([
                { id: 'msg-1', text: 'visible', sender: '0xother', timestamp: Date.now() - 1000 },
                { id: 'msg-2', text: 'deleted', sender: '0xother', timestamp: Date.now() - 900, _deleted: true },
                { id: 'msg-3', type: 'edit', targetId: 'msg-1', sender: '0xother', timestamp: Date.now() - 800 },
                { id: 'msg-4', type: 'delete', targetId: 'msg-1', sender: '0xother', timestamp: Date.now() - 700 }
            ]);

            expect(messageRenderer.buildMessageHTML).toHaveBeenCalledTimes(1);
        });
    });
});
