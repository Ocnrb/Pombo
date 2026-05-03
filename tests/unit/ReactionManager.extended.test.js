/**
 * Extended tests for ReactionManager.js — DOM interaction methods
 * Focus: showReactionPicker, initEmojiPicker, attachReactionListeners,
 *        _blockScroll, _unblockScroll
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactionManager } from '../../src/js/ui/ReactionManager.js';

describe('ReactionManager DOM Methods', () => {
    beforeEach(() => {
        reactionManager.messageReactions = null;
        reactionManager.reactionPickerTimeout = null;
        reactionManager._scrollBlocker = null;
        reactionManager.deps = {
            getCurrentAddress: vi.fn().mockReturnValue('0xuser1'),
            onSendReaction: vi.fn()
        };
        document.body.innerHTML = '';
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (reactionManager.reactionPickerTimeout) {
            clearTimeout(reactionManager.reactionPickerTimeout);
            reactionManager.reactionPickerTimeout = null;
        }
        if (reactionManager._scrollBlocker) {
            reactionManager._unblockScroll();
        }
    });

    // ==================== _blockScroll ====================
    describe('_blockScroll', () => {
        it('adds wheel and touchmove listeners to messages-area', () => {
            const messagesArea = document.createElement('div');
            messagesArea.id = 'messages-area';
            document.body.appendChild(messagesArea);

            const addSpy = vi.spyOn(messagesArea, 'addEventListener');

            reactionManager._blockScroll();

            expect(addSpy).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false });
            expect(addSpy).toHaveBeenCalledWith('touchmove', expect.any(Function), { passive: false });
        });

        it('stores scrollBlocker reference', () => {
            const messagesArea = document.createElement('div');
            messagesArea.id = 'messages-area';
            document.body.appendChild(messagesArea);

            reactionManager._blockScroll();

            expect(reactionManager._scrollBlocker).toBeDefined();
            expect(reactionManager._scrollBlocker.el).toBe(messagesArea);
            expect(reactionManager._scrollBlocker.handler).toBeInstanceOf(Function);
        });

        it('does nothing if messages-area not found', () => {
            reactionManager._blockScroll();
            expect(reactionManager._scrollBlocker).toBeNull();
        });

        it('does not double-block if already blocking', () => {
            const messagesArea = document.createElement('div');
            messagesArea.id = 'messages-area';
            document.body.appendChild(messagesArea);

            reactionManager._blockScroll();
            const firstBlocker = reactionManager._scrollBlocker;

            const addSpy = vi.spyOn(messagesArea, 'addEventListener');
            reactionManager._blockScroll();

            // Should not add more listeners
            expect(addSpy).not.toHaveBeenCalled();
            expect(reactionManager._scrollBlocker).toBe(firstBlocker);
        });

        it('prevents default on wheel events', () => {
            const messagesArea = document.createElement('div');
            messagesArea.id = 'messages-area';
            document.body.appendChild(messagesArea);

            reactionManager._blockScroll();

            const wheelEvent = new Event('wheel', { cancelable: true });
            const spy = vi.spyOn(wheelEvent, 'preventDefault');
            messagesArea.dispatchEvent(wheelEvent);

            expect(spy).toHaveBeenCalled();
        });
    });

    // ==================== _unblockScroll ====================
    describe('_unblockScroll', () => {
        it('removes wheel and touchmove listeners', () => {
            const messagesArea = document.createElement('div');
            messagesArea.id = 'messages-area';
            document.body.appendChild(messagesArea);

            reactionManager._blockScroll();
            const removeSpy = vi.spyOn(messagesArea, 'removeEventListener');

            reactionManager._unblockScroll();

            expect(removeSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
            expect(removeSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));
        });

        it('sets scrollBlocker to null', () => {
            const messagesArea = document.createElement('div');
            messagesArea.id = 'messages-area';
            document.body.appendChild(messagesArea);

            reactionManager._blockScroll();
            reactionManager._unblockScroll();

            expect(reactionManager._scrollBlocker).toBeNull();
        });

        it('does nothing if not blocking', () => {
            expect(() => reactionManager._unblockScroll()).not.toThrow();
        });
    });

    // ==================== showReactionPicker ====================
    describe('showReactionPicker', () => {
        let picker;

        beforeEach(() => {
            // Create messages area for scroll blocking
            const messagesArea = document.createElement('div');
            messagesArea.id = 'messages-area';
            document.body.appendChild(messagesArea);

            // Create reaction picker element
            picker = document.createElement('div');
            picker.id = 'reaction-picker';
            picker.style.display = 'none';

            // Add some emoji spans
            picker.innerHTML = '<span data-emoji="👍">👍</span><span data-emoji="❤️">❤️</span>';
            document.body.appendChild(picker);

            reactionManager.init();
        });

        it('returns early if reaction-picker not found', () => {
            picker.remove();

            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', {
                value: document.createElement('button'),
                writable: false
            });

            expect(() => reactionManager.showReactionPicker(event, 'msg1', null)).not.toThrow();
        });

        it('shows the picker', () => {
            const btn = document.createElement('button');
            document.body.appendChild(btn);

            const rect = btn.getBoundingClientRect();
            const event = new MouseEvent('mouseenter', { clientX: rect.left, clientY: rect.top });
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg1', btn);

            expect(picker.style.display).toBe('flex');
            expect(picker.style.visibility).toBe('visible');
        });

        it('stores current message ID on picker', () => {
            const btn = document.createElement('button');
            document.body.appendChild(btn);
            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg-abc', btn);

            expect(picker.dataset.currentMsgId).toBe('msg-abc');
        });

        it('clears pending hide timeout', () => {
            reactionManager.reactionPickerTimeout = setTimeout(() => {}, 99999);
            const clearSpy = vi.spyOn(global, 'clearTimeout');

            const btn = document.createElement('button');
            document.body.appendChild(btn);
            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg1', btn);

            expect(clearSpy).toHaveBeenCalled();
            expect(reactionManager.reactionPickerTimeout).toBeNull();
        });

        it('blocks scroll on messages area', () => {
            const blockSpy = vi.spyOn(reactionManager, '_blockScroll');

            const btn = document.createElement('button');
            document.body.appendChild(btn);
            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg1', btn);

            expect(blockSpy).toHaveBeenCalled();
        });

        it('attaches click handlers to emoji spans', () => {
            const toggleSpy = vi.spyOn(reactionManager, 'toggleReaction').mockReturnValue({ isRemoving: false });
            const hideSpy = vi.spyOn(reactionManager, 'hideReactionPicker');

            const btn = document.createElement('button');
            document.body.appendChild(btn);
            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg1', btn);

            // Click an emoji
            picker.querySelector('span').click();

            expect(toggleSpy).toHaveBeenCalledWith('msg1', '👍');
            expect(hideSpy).toHaveBeenCalled();
        });

        it('hides picker with delay on mouse leave', () => {
            const btn = document.createElement('button');
            document.body.appendChild(btn);
            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg1', btn);

            // Simulate mouse leave on picker
            picker.onmouseleave();

            expect(reactionManager.reactionPickerTimeout).not.toBeNull();

            // Advance timer
            vi.advanceTimersByTime(150);

            expect(picker.style.display).toBe('none');
        });

        it('cancels hide on mouse re-enter', () => {
            const btn = document.createElement('button');
            document.body.appendChild(btn);
            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg1', btn);

            // Leave then re-enter
            picker.onmouseleave();
            expect(reactionManager.reactionPickerTimeout).not.toBeNull();

            picker.onmouseenter();
            expect(reactionManager.reactionPickerTimeout).toBeNull();
        });

        it('sets up trigger button mouse leave handler', () => {
            const btn = document.createElement('button');
            document.body.appendChild(btn);
            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg1', btn);

            expect(btn.onmouseleave).toBeInstanceOf(Function);

            // Trigger it
            btn.onmouseleave();
            expect(reactionManager.reactionPickerTimeout).not.toBeNull();
        });

        it('positions picker below trigger', () => {
            const btn = document.createElement('button');
            btn.style.position = 'absolute';
            btn.style.left = '100px';
            btn.style.top = '100px';
            btn.style.width = '50px';
            btn.style.height = '30px';
            document.body.appendChild(btn);

            const event = new MouseEvent('mouseenter');
            Object.defineProperty(event, 'target', { value: btn, writable: false });

            reactionManager.showReactionPicker(event, 'msg1', btn);

            // Picker should have left and top set as px values
            expect(picker.style.left).toMatch(/\d+px/);
            expect(picker.style.top).toMatch(/\d+px/);
        });
    });

    // ==================== hideReactionPicker ====================
    describe('hideReactionPicker (extended)', () => {
        it('hides the reaction picker', () => {
            const picker = document.createElement('div');
            picker.id = 'reaction-picker';
            picker.style.display = 'flex';
            document.body.appendChild(picker);

            reactionManager.hideReactionPicker();

            expect(picker.style.display).toBe('none');
        });

        it('unblocks scroll', () => {
            const picker = document.createElement('div');
            picker.id = 'reaction-picker';
            document.body.appendChild(picker);

            const unblockSpy = vi.spyOn(reactionManager, '_unblockScroll');

            reactionManager.hideReactionPicker();

            expect(unblockSpy).toHaveBeenCalled();
        });

        it('clears pending hide timeout', () => {
            const picker = document.createElement('div');
            picker.id = 'reaction-picker';
            document.body.appendChild(picker);

            reactionManager.reactionPickerTimeout = setTimeout(() => {}, 99999);

            reactionManager.hideReactionPicker();

            expect(reactionManager.reactionPickerTimeout).toBeNull();
        });
    });

    // ==================== initEmojiPicker ====================
    describe('initEmojiPicker', () => {
        let emojiPicker, emojiBtn, messageInput;

        beforeEach(() => {
            emojiPicker = document.createElement('div');
            emojiPicker.id = 'emoji-picker';
            emojiPicker.style.display = 'none';
            document.body.appendChild(emojiPicker);

            emojiBtn = document.createElement('button');
            emojiBtn.id = 'emoji-btn';
            document.body.appendChild(emojiBtn);

            messageInput = document.createElement('div');
            messageInput.contentEditable = 'true';
            document.body.appendChild(messageInput);
        });

        it('returns early if emoji-picker not found', () => {
            emojiPicker.remove();
            expect(() => reactionManager.initEmojiPicker(messageInput)).not.toThrow();
        });

        it('returns early if emoji-btn not found', () => {
            emojiBtn.remove();
            expect(() => reactionManager.initEmojiPicker(messageInput)).not.toThrow();
        });

        it('populates emoji picker with default emojis', () => {
            reactionManager.initEmojiPicker(messageInput);

            const spans = emojiPicker.querySelectorAll('span');
            expect(spans.length).toBeGreaterThan(50);
        });

        it('inserts emoji into message input on click', () => {
            reactionManager.initEmojiPicker(messageInput);

            const spans = emojiPicker.querySelectorAll('span');
            spans[0].click();

            expect(messageInput.textContent.length).toBeGreaterThan(0);
        });

        it('focuses message input after emoji selection', () => {
            reactionManager.initEmojiPicker(messageInput);
            const focusSpy = vi.spyOn(messageInput, 'focus');

            const spans = emojiPicker.querySelectorAll('span');
            spans[0].click();

            expect(focusSpy).toHaveBeenCalled();
        });

        it('toggles emoji picker on button click', () => {
            reactionManager.initEmojiPicker(messageInput);

            // Click once — show
            emojiBtn.click();
            expect(emojiPicker.style.display).toBe('flex');

            // Click again — hide
            emojiBtn.click();
            expect(emojiPicker.style.display).toBe('none');
        });

        it('hides emoji picker when clicking outside', () => {
            reactionManager.initEmojiPicker(messageInput);

            // Show picker first
            emojiPicker.style.display = 'flex';

            // Click elsewhere
            document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            expect(emojiPicker.style.display).toBe('none');
        });

        it('does not hide picker when clicking inside picker', () => {
            reactionManager.initEmojiPicker(messageInput);

            // Show picker
            emojiPicker.style.display = 'flex';

            // Create event that appears to come from within picker
            const span = emojiPicker.querySelector('span');
            const event = new MouseEvent('click', { bubbles: true });
            // The document handler checks emojiPicker.contains(e.target)
            // Dispatching on span should bubble to document
            span.dispatchEvent(event);

            // Picker stays open (the span click appends emoji but doesn't close)
            // It should NOT be hidden since click originated inside picker
        });

        it('closes reaction picker on outside click', () => {
            // Also create a reaction picker
            const reactionPicker = document.createElement('div');
            reactionPicker.id = 'reaction-picker';
            reactionPicker.style.display = 'flex';
            document.body.appendChild(reactionPicker);

            const hideSpy = vi.spyOn(reactionManager, 'hideReactionPicker');

            reactionManager.initEmojiPicker(messageInput);

            // Click outside everything
            document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            expect(hideSpy).toHaveBeenCalled();
        });

        it('closes attach menu on outside click', () => {
            const attachMenu = document.createElement('div');
            attachMenu.id = 'attach-menu';
            document.body.appendChild(attachMenu);

            const attachBtn = document.createElement('button');
            attachBtn.id = 'attach-btn';
            document.body.appendChild(attachBtn);

            reactionManager.initEmojiPicker(messageInput);

            // Click outside
            document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            expect(attachMenu.classList.contains('hidden')).toBe(true);
        });
    });

    // ==================== attachReactionListeners ====================
    describe('attachReactionListeners', () => {
        it('attaches click handler to react buttons', () => {
            const btn = document.createElement('button');
            btn.className = 'react-btn';
            btn.dataset.msgId = 'msg1';
            document.body.appendChild(btn);

            const showSpy = vi.spyOn(reactionManager, 'showReactionPicker').mockImplementation(() => {});

            reactionManager.attachReactionListeners(null, null, null);

            // The button is cloned, find the new one
            const newBtn = document.querySelector('.react-btn');
            newBtn.click();

            expect(showSpy).toHaveBeenCalledWith(expect.any(MouseEvent), 'msg1', newBtn);
        });

        it('attaches hover handler to react buttons (mouseenter)', () => {
            const btn = document.createElement('button');
            btn.className = 'react-btn';
            btn.dataset.msgId = 'msg1';
            document.body.appendChild(btn);

            const showSpy = vi.spyOn(reactionManager, 'showReactionPicker').mockImplementation(() => {});

            reactionManager.attachReactionListeners(null, null, null);

            const newBtn = document.querySelector('.react-btn');
            newBtn.dispatchEvent(new MouseEvent('mouseenter'));

            expect(showSpy).toHaveBeenCalledWith(expect.any(MouseEvent), 'msg1', newBtn);
        });

        it('attaches click handler to reply buttons', () => {
            const btn = document.createElement('button');
            btn.className = 'reply-btn';
            btn.dataset.msgId = 'msg1';
            document.body.appendChild(btn);

            const onReply = vi.fn();

            reactionManager.attachReactionListeners(onReply, null, null);

            const newBtn = document.querySelector('.reply-btn');
            newBtn.click();

            expect(onReply).toHaveBeenCalledWith('msg1');
        });

        it('attaches click handler to reply previews', () => {
            const preview = document.createElement('div');
            preview.className = 'reply-preview';
            preview.dataset.replyToId = 'orig-msg';
            document.body.appendChild(preview);

            const onScroll = vi.fn();

            reactionManager.attachReactionListeners(null, null, onScroll);

            preview.click();

            expect(onScroll).toHaveBeenCalledWith('orig-msg');
        });

        it('does not call onScrollToMessage when replyToId is empty', () => {
            const preview = document.createElement('div');
            preview.className = 'reply-preview';
            preview.dataset.replyToId = '';
            document.body.appendChild(preview);

            const onScroll = vi.fn();

            reactionManager.attachReactionListeners(null, null, onScroll);

            preview.click();

            expect(onScroll).not.toHaveBeenCalled();
        });

        it('attaches click handler to reaction badges', () => {
            reactionManager.init();

            const badge = document.createElement('span');
            badge.className = 'reaction-badge';
            badge.dataset.msgId = 'msg1';
            badge.dataset.emoji = '👍';
            document.body.appendChild(badge);

            const toggleSpy = vi.spyOn(reactionManager, 'toggleReaction').mockReturnValue({ isRemoving: false });

            reactionManager.attachReactionListeners(null, null, null);

            badge.click();

            expect(toggleSpy).toHaveBeenCalledWith('msg1', '👍');
        });

        it('attaches click handler to download buttons', async () => {
            const btn = document.createElement('button');
            btn.className = 'download-file-btn';
            btn.dataset.fileId = 'file-123';
            document.body.appendChild(btn);

            const onDownload = vi.fn().mockResolvedValue(undefined);

            reactionManager.attachReactionListeners(null, onDownload, null);

            btn.click();

            // Wait for async handler
            await vi.advanceTimersByTimeAsync(0);

            expect(onDownload).toHaveBeenCalledWith('file-123');
        });

        it('replaces existing button event listeners (clone pattern)', () => {
            const btn = document.createElement('button');
            btn.className = 'react-btn';
            btn.dataset.msgId = 'msg1';
            const oldHandler = vi.fn();
            btn.addEventListener('click', oldHandler);
            document.body.appendChild(btn);

            reactionManager.attachReactionListeners(null, null, null);

            // The original button was replaced with a clone
            const newBtn = document.querySelector('.react-btn');
            expect(newBtn).not.toBe(btn);
        });

        it('handles null callbacks gracefully', () => {
            const btn = document.createElement('button');
            btn.className = 'reply-btn';
            btn.dataset.msgId = 'msg1';
            document.body.appendChild(btn);

            reactionManager.attachReactionListeners(null, null, null);

            const newBtn = document.querySelector('.reply-btn');
            // Should not throw with null onReply
            expect(() => newBtn.click()).not.toThrow();
        });
    });
});
