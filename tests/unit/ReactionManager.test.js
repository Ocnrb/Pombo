/**
 * Tests for ReactionManager.js - Message reactions handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactionManager } from '../../src/js/ui/ReactionManager.js';

describe('ReactionManager', () => {
    beforeEach(() => {
        // Reset state
        reactionManager.messageReactions = null;
        reactionManager.reactionPickerTimeout = null;
        reactionManager.deps = {};
        
        // Clear DOM
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (reactionManager.reactionPickerTimeout) {
            clearTimeout(reactionManager.reactionPickerTimeout);
        }
    });

    describe('setDependencies()', () => {
        it('should set dependencies', () => {
            const getCurrentAddress = vi.fn();
            reactionManager.setDependencies({ getCurrentAddress });
            expect(reactionManager.deps.getCurrentAddress).toBe(getCurrentAddress);
        });
        
        it('should merge dependencies', () => {
            reactionManager.setDependencies({ dep1: 'a' });
            reactionManager.setDependencies({ dep2: 'b' });
            expect(reactionManager.deps.dep1).toBe('a');
            expect(reactionManager.deps.dep2).toBe('b');
        });
    });

    describe('init()', () => {
        it('should initialize messageReactions map', () => {
            expect(reactionManager.messageReactions).toBeNull();
            reactionManager.init();
            expect(reactionManager.messageReactions).toBeInstanceOf(Map);
        });
        
        it('should not reinitialize if already exists', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('test', {});
            reactionManager.init();
            expect(reactionManager.messageReactions.has('test')).toBe(true);
        });
    });

    describe('clear()', () => {
        it('should clear all reactions', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0x1'] });
            reactionManager.messageReactions.set('msg2', { '❤️': ['0x2'] });
            
            reactionManager.clear();
            
            expect(reactionManager.messageReactions.size).toBe(0);
        });
        
        it('should handle clear when not initialized', () => {
            reactionManager.messageReactions = null;
            // Should not throw
            reactionManager.clear();
        });
    });

    describe('loadFromChannelState()', () => {
        it('should load reactions from channel state', () => {
            const reactions = {
                'msg1': { '👍': ['0x111', '0x222'] },
                'msg2': { '❤️': ['0x333'], '🔥': ['0x444'] }
            };
            
            reactionManager.loadFromChannelState(reactions);
            
            expect(reactionManager.messageReactions.get('msg1')).toEqual({ '👍': ['0x111', '0x222'] });
            expect(reactionManager.messageReactions.get('msg2')).toEqual({ '❤️': ['0x333'], '🔥': ['0x444'] });
        });
        
        it('should clear existing reactions before loading', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('old', { '⭐': ['0xOLD'] });
            
            reactionManager.loadFromChannelState({ 'new': { '🎉': ['0xNEW'] } });
            
            expect(reactionManager.messageReactions.has('old')).toBe(false);
            expect(reactionManager.messageReactions.has('new')).toBe(true);
        });
        
        it('should handle empty reactions', () => {
            reactionManager.loadFromChannelState({});
            expect(reactionManager.messageReactions.size).toBe(0);
        });
    });

    describe('getReactions()', () => {
        it('should return reactions for message', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0x1'] });
            
            const result = reactionManager.getReactions('msg1');
            expect(result).toEqual({ '👍': ['0x1'] });
        });
        
        it('should return undefined for non-existent message', () => {
            reactionManager.init();
            const result = reactionManager.getReactions('nonexistent');
            expect(result).toBeUndefined();
        });
        
        it('should return undefined when not initialized', () => {
            reactionManager.messageReactions = null;
            const result = reactionManager.getReactions('msg1');
            expect(result).toBeUndefined();
        });
    });

    describe('exportAsObject()', () => {
        it('should export reactions as plain object', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0x1'] });
            reactionManager.messageReactions.set('msg2', { '❤️': ['0x2'] });
            
            const result = reactionManager.exportAsObject();
            
            expect(result).toEqual({
                'msg1': { '👍': ['0x1'] },
                'msg2': { '❤️': ['0x2'] }
            });
        });
        
        it('should return empty object when not initialized', () => {
            reactionManager.messageReactions = null;
            const result = reactionManager.exportAsObject();
            expect(result).toEqual({});
        });
        
        it('should return empty object when empty', () => {
            reactionManager.init();
            const result = reactionManager.exportAsObject();
            expect(result).toEqual({});
        });
    });

    describe('toggleReaction()', () => {
        beforeEach(() => {
            reactionManager.setDependencies({
                getCurrentAddress: () => '0xCurrentUser'
            });
        });
        
        it('should add reaction when not present', () => {
            const result = reactionManager.toggleReaction('msg1', '👍');
            
            expect(result.isRemoving).toBe(false);
            expect(reactionManager.messageReactions.get('msg1')).toEqual({
                '👍': ['0xCurrentUser']
            });
        });
        
        it('should remove reaction when already present', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0xCurrentUser'] });
            
            const result = reactionManager.toggleReaction('msg1', '👍');
            
            expect(result.isRemoving).toBe(true);
            expect(reactionManager.messageReactions.get('msg1')['👍']).toBeUndefined();
        });
        
        it('should be case-insensitive for user addresses', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0xCURRENTUSER'] });
            
            const result = reactionManager.toggleReaction('msg1', '👍');
            
            expect(result.isRemoving).toBe(true);
        });
        
        it('should clean up empty emoji arrays', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0xCurrentUser'] });
            
            reactionManager.toggleReaction('msg1', '👍');
            
            const reactions = reactionManager.messageReactions.get('msg1');
            expect(reactions['👍']).toBeUndefined();
        });
        
        it('should call onSendReaction callback', () => {
            const onSendReaction = vi.fn();
            reactionManager.setDependencies({
                getCurrentAddress: () => '0xSender',
                onSendReaction
            });
            
            reactionManager.toggleReaction('msg1', '🎉');
            
            expect(onSendReaction).toHaveBeenCalledWith('msg1', '🎉', false);
        });
        
        it('should call onSendReaction with isRemoving=true when removing', () => {
            const onSendReaction = vi.fn();
            reactionManager.setDependencies({
                getCurrentAddress: () => '0xSender',
                onSendReaction
            });
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '🎉': ['0xSender'] });
            
            reactionManager.toggleReaction('msg1', '🎉');
            
            expect(onSendReaction).toHaveBeenCalledWith('msg1', '🎉', true);
        });
        
        it('should return early if no current address', () => {
            reactionManager.setDependencies({
                getCurrentAddress: () => null
            });
            
            const result = reactionManager.toggleReaction('msg1', '👍');
            
            expect(result.isRemoving).toBe(false);
            // init() is called but no reaction is added
            expect(reactionManager.messageReactions.get('msg1')).toBeUndefined();
        });
        
        it('should handle multiple emojis on same message', () => {
            reactionManager.toggleReaction('msg1', '👍');
            reactionManager.toggleReaction('msg1', '❤️');
            reactionManager.toggleReaction('msg1', '🔥');
            
            const reactions = reactionManager.messageReactions.get('msg1');
            expect(Object.keys(reactions)).toHaveLength(3);
        });
    });

    describe('handleIncomingReaction()', () => {
        it('should add reaction from other user', () => {
            reactionManager.handleIncomingReaction('msg1', '👍', '0xOtherUser', 'add');
            
            expect(reactionManager.messageReactions.get('msg1')).toEqual({
                '👍': ['0xOtherUser']
            });
        });
        
        it('should remove reaction from other user', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0xOtherUser', '0xAnotherUser'] });
            
            reactionManager.handleIncomingReaction('msg1', '👍', '0xOtherUser', 'remove');
            
            expect(reactionManager.messageReactions.get('msg1')['👍']).toEqual(['0xAnotherUser']);
        });
        
        it('should be case-insensitive for remove', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0xOTHERUSER'] });
            
            reactionManager.handleIncomingReaction('msg1', '👍', '0xotheruser', 'remove');
            
            expect(reactionManager.messageReactions.get('msg1')['👍']).toBeUndefined();
        });
        
        it('should not duplicate user on add', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0xExisting'] });
            
            reactionManager.handleIncomingReaction('msg1', '👍', '0xExisting', 'add');
            
            expect(reactionManager.messageReactions.get('msg1')['👍']).toHaveLength(1);
        });
        
        it('should default to add action', () => {
            reactionManager.handleIncomingReaction('msg1', '👍', '0xUser');
            
            expect(reactionManager.messageReactions.get('msg1')['👍']).toContain('0xUser');
        });
        
        it('should clean up empty emoji arrays on remove', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0xOnlyUser'] });
            
            reactionManager.handleIncomingReaction('msg1', '👍', '0xOnlyUser', 'remove');
            
            expect(reactionManager.messageReactions.get('msg1')['👍']).toBeUndefined();
        });
        
        it('should handle remove for non-existent user', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0xUser1'] });
            
            // Should not throw
            reactionManager.handleIncomingReaction('msg1', '👍', '0xNonExistent', 'remove');
            expect(reactionManager.messageReactions.get('msg1')['👍']).toEqual(['0xUser1']);
        });
    });

    describe('updateReactionUI()', () => {
        beforeEach(() => {
            // Create container in DOM
            const container = document.createElement('div');
            container.dataset.reactionsFor = 'msg1';
            document.body.appendChild(container);
        });
        
        it('should render reaction badges', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { 
                '👍': ['0x1', '0x2'], 
                '❤️': ['0x3'] 
            });
            
            reactionManager.updateReactionUI('msg1');
            
            const container = document.querySelector('[data-reactions-for="msg1"]');
            const badges = container.querySelectorAll('.reaction-badge');
            expect(badges.length).toBe(2);
        });
        
        it('should show reaction count', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { 
                '👍': ['0x1', '0x2', '0x3'] 
            });
            
            reactionManager.updateReactionUI('msg1');
            
            const container = document.querySelector('[data-reactions-for="msg1"]');
            expect(container.textContent).toContain('3');
        });
        
        it('should clear container when no reactions', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', {});
            
            const container = document.querySelector('[data-reactions-for="msg1"]');
            container.innerHTML = '<span>old content</span>';
            
            reactionManager.updateReactionUI('msg1');
            
            expect(container.innerHTML).toBe('');
        });
        
        it('should handle missing container gracefully', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg2', { '👍': ['0x1'] });
            
            // Should not throw
            reactionManager.updateReactionUI('msg2');
        });
        
        it('should not show badges for empty user lists', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { 
                '👍': [],  // Empty
                '❤️': ['0x1'] 
            });
            
            reactionManager.updateReactionUI('msg1');
            
            const container = document.querySelector('[data-reactions-for="msg1"]');
            const badges = container.querySelectorAll('.reaction-badge');
            expect(badges.length).toBe(1);
        });
    });

    describe('reaction flow integration', () => {
        it('should handle full add/remove cycle', () => {
            reactionManager.setDependencies({
                getCurrentAddress: () => '0xTestUser'
            });
            
            // Add reaction
            let result = reactionManager.toggleReaction('msg1', '👍');
            expect(result.isRemoving).toBe(false);
            expect(reactionManager.getReactions('msg1')['👍']).toContain('0xTestUser');
            
            // Remove same reaction
            result = reactionManager.toggleReaction('msg1', '👍');
            expect(result.isRemoving).toBe(true);
            expect(reactionManager.getReactions('msg1')['👍']).toBeUndefined();
        });
        
        it('should handle mixed local and remote reactions', () => {
            reactionManager.setDependencies({
                getCurrentAddress: () => '0xLocalUser'
            });
            
            // Add local reaction
            reactionManager.toggleReaction('msg1', '👍');
            
            // Receive remote reaction
            reactionManager.handleIncomingReaction('msg1', '👍', '0xRemoteUser', 'add');
            
            expect(reactionManager.getReactions('msg1')['👍']).toHaveLength(2);
            expect(reactionManager.getReactions('msg1')['👍']).toContain('0xLocalUser');
            expect(reactionManager.getReactions('msg1')['👍']).toContain('0xRemoteUser');
        });
        
        it('should preserve reactions on export/import', () => {
            reactionManager.init();
            reactionManager.messageReactions.set('msg1', { '👍': ['0x1'] });
            reactionManager.messageReactions.set('msg2', { '❤️': ['0x2'] });
            
            const exported = reactionManager.exportAsObject();
            
            reactionManager.clear();
            expect(reactionManager.messageReactions.size).toBe(0);
            
            reactionManager.loadFromChannelState(exported);
            
            expect(reactionManager.getReactions('msg1')).toEqual({ '👍': ['0x1'] });
            expect(reactionManager.getReactions('msg2')).toEqual({ '❤️': ['0x2'] });
        });
    });

    describe('hideReactionPicker()', () => {
        it('should hide the reaction picker element', () => {
            const picker = document.createElement('div');
            picker.id = 'reaction-picker';
            picker.style.display = 'block';
            document.body.appendChild(picker);

            reactionManager.hideReactionPicker();

            expect(picker.style.display).toBe('none');
        });

        it('should restore overflow on messages area', () => {
            const picker = document.createElement('div');
            picker.id = 'reaction-picker';
            document.body.appendChild(picker);

            const messagesArea = document.createElement('div');
            messagesArea.id = 'messages-area';
            document.body.appendChild(messagesArea);

            // Simulate _blockScroll having been called
            const prevent = (e) => e.preventDefault();
            messagesArea.addEventListener('wheel', prevent, { passive: false });
            messagesArea.addEventListener('touchmove', prevent, { passive: false });
            reactionManager._scrollBlocker = { el: messagesArea, handler: prevent };

            reactionManager.hideReactionPicker();

            expect(reactionManager._scrollBlocker).toBeNull();
        });

        it('should clear pending hide timeout', () => {
            reactionManager.reactionPickerTimeout = setTimeout(() => {}, 10000);
            const picker = document.createElement('div');
            picker.id = 'reaction-picker';
            document.body.appendChild(picker);

            reactionManager.hideReactionPicker();

            expect(reactionManager.reactionPickerTimeout).toBeNull();
        });

        it('should handle missing picker element gracefully', () => {
            // No picker in DOM - should not throw
            reactionManager.hideReactionPicker();
        });
    });
});
