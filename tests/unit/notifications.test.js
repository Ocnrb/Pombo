/**
 * Tests for notifications.js - NotificationManager
 * 
 * Covers: enable/disable, subscribe, init, sendChannelInvite,
 * handleNotification, invite management, localStorage persistence,
 * formatAddress, generateInviteId, playNotificationSound, UI interactions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        client: {
            createStream: vi.fn()
        },
        subscribeSimple: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xAbC1230000000000000000000000000000004567')
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        joinChannel: vi.fn().mockResolvedValue({})
    }
}));

vi.mock('../../src/js/ui.js', () => ({
    uiController: {
        showNotification: vi.fn()
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/ui/utils.js', () => ({
    escapeHtml: vi.fn((str) => str)
}));

vi.mock('../../src/js/config.js', () => ({
    CONFIG: {
        notifications: {
            inviteToastDurationMs: 10000
        }
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { notificationManager } from '../../src/js/notifications.js';
import { streamrController } from '../../src/js/streamr.js';
import { authManager } from '../../src/js/auth.js';
import { channelManager } from '../../src/js/channels.js';
import { uiController } from '../../src/js/ui.js';

describe('NotificationManager', () => {
    beforeEach(() => {
        // Reset state
        notificationManager.notificationStream = null;
        notificationManager.pendingInvites = new Map();
        notificationManager.initialized = false;

        // Clear localStorage
        localStorage.clear();

        vi.clearAllMocks();
        authManager.getAddress.mockReturnValue('0xAbC1230000000000000000000000000000004567');
    });

    // ==================== constructor ====================
    describe('constructor', () => {
        it('should initialize with default state', () => {
            expect(notificationManager.notificationStream).toBeNull();
            expect(notificationManager.pendingInvites).toBeInstanceOf(Map);
            expect(notificationManager.initialized).toBe(false);
        });
    });

    // ==================== getStorageKey() ====================
    describe('getStorageKey()', () => {
        it('should return key with lowercased address', () => {
            const key = notificationManager.getStorageKey();
            expect(key).toBe('pombo_notifications_0xabc1230000000000000000000000000000004567');
        });

        it('should return default key when no address', () => {
            authManager.getAddress.mockReturnValue(null);
            const key = notificationManager.getStorageKey();
            expect(key).toBe('pombo_notifications_default');
        });
    });

    // ==================== getStreamId() ====================
    describe('getStreamId()', () => {
        it('should return lowercased address based stream ID', () => {
            const id = notificationManager.getStreamId('0xABC123');
            expect(id).toBe('0xabc123/pombo_notifications');
        });
    });

    // ==================== isEnabled() ====================
    describe('isEnabled()', () => {
        it('should return false when no settings stored', () => {
            expect(notificationManager.isEnabled()).toBe(false);
        });

        it('should return true when enabled in settings', () => {
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, JSON.stringify({ enabled: true }));
            expect(notificationManager.isEnabled()).toBe(true);
        });

        it('should return false when disabled in settings', () => {
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, JSON.stringify({ enabled: false }));
            expect(notificationManager.isEnabled()).toBe(false);
        });

        it('should return false on invalid JSON', () => {
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, 'not-json');
            expect(notificationManager.isEnabled()).toBe(false);
        });
    });

    // ==================== getSettings() ====================
    describe('getSettings()', () => {
        it('should return default settings when nothing stored', () => {
            const settings = notificationManager.getSettings();
            expect(settings).toEqual({ enabled: false, streamId: null });
        });

        it('should return stored settings', () => {
            const key = notificationManager.getStorageKey();
            const stored = { enabled: true, streamId: 'test/stream' };
            localStorage.setItem(key, JSON.stringify(stored));

            const settings = notificationManager.getSettings();
            expect(settings).toEqual(stored);
        });

        it('should return default on parse error', () => {
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, '{bad json');

            const settings = notificationManager.getSettings();
            expect(settings).toEqual({ enabled: false, streamId: null });
        });
    });

    // ==================== saveSettings() ====================
    describe('saveSettings()', () => {
        it('should save settings to localStorage', () => {
            const settings = { enabled: true, streamId: 'my/stream' };
            notificationManager.saveSettings(settings);

            const key = notificationManager.getStorageKey();
            const stored = JSON.parse(localStorage.getItem(key));
            expect(stored).toEqual(settings);
        });
    });

    // ==================== enable() ====================
    describe('enable()', () => {
        it('should throw when not authenticated', async () => {
            authManager.getAddress.mockReturnValue(null);
            await expect(notificationManager.enable()).rejects.toThrow('Not authenticated');
        });

        it('should create stream and save settings on success', async () => {
            const mockStream = {
                grantPermissions: vi.fn().mockResolvedValue(undefined)
            };
            streamrController.client.createStream.mockResolvedValue(mockStream);

            const result = await notificationManager.enable();

            expect(result).toBe(true);
            expect(streamrController.client.createStream).toHaveBeenCalledWith({
                id: expect.stringContaining('/pombo_notifications'),
                partitions: 1,
                description: 'Pombo notification channel'
            });
            expect(mockStream.grantPermissions).toHaveBeenCalled();

            // Check settings were saved
            const settings = notificationManager.getSettings();
            expect(settings.enabled).toBe(true);
            expect(settings.streamId).toContain('/pombo_notifications');
        });

        it('should subscribe after creating stream', async () => {
            const mockStream = { grantPermissions: vi.fn().mockResolvedValue(undefined) };
            streamrController.client.createStream.mockResolvedValue(mockStream);

            await notificationManager.enable();

            expect(streamrController.subscribeSimple).toHaveBeenCalled();
        });

        it('should throw on stream creation failure', async () => {
            streamrController.client.createStream.mockRejectedValue(new Error('Gas error'));

            await expect(notificationManager.enable()).rejects.toThrow('Gas error');
        });
    });

    // ==================== disable() ====================
    describe('disable()', () => {
        it('should set enabled to false in settings', () => {
            // First enable
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, JSON.stringify({ enabled: true, streamId: 'test/stream' }));
            notificationManager.notificationStream = 'test/stream';

            notificationManager.disable();

            const settings = notificationManager.getSettings();
            expect(settings.enabled).toBe(false);
        });

        it('should unsubscribe from stream', () => {
            notificationManager.notificationStream = 'test/stream';
            notificationManager.disable();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('test/stream');
        });

        it('should set initialized to false', () => {
            notificationManager.initialized = true;
            notificationManager.disable();
            expect(notificationManager.initialized).toBe(false);
        });

        it('should clear notificationStream', () => {
            notificationManager.notificationStream = 'test/stream';
            notificationManager.disable();
            expect(notificationManager.notificationStream).toBeNull();
        });

        it('should not call unsubscribe if no stream set', () => {
            notificationManager.notificationStream = null;
            notificationManager.disable();
            expect(streamrController.unsubscribe).not.toHaveBeenCalled();
        });
    });

    // ==================== subscribe() ====================
    describe('subscribe()', () => {
        it('should throw when no streamId configured', async () => {
            await expect(notificationManager.subscribe()).rejects.toThrow('No notification stream configured');
        });

        it('should subscribe to configured stream', async () => {
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, JSON.stringify({ enabled: true, streamId: 'my/stream' }));

            await notificationManager.subscribe();

            expect(streamrController.subscribeSimple).toHaveBeenCalledWith(
                'my/stream',
                expect.any(Function),
                null
            );
            expect(notificationManager.notificationStream).toBe('my/stream');
        });

        it('should throw on subscription failure', async () => {
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, JSON.stringify({ enabled: true, streamId: 'my/stream' }));
            streamrController.subscribeSimple.mockRejectedValueOnce(new Error('Network error'));

            await expect(notificationManager.subscribe()).rejects.toThrow('Network error');
        });
    });

    // ==================== init() ====================
    describe('init()', () => {
        it('should return early when not authenticated', async () => {
            authManager.getAddress.mockReturnValue(null);
            await notificationManager.init();
            expect(notificationManager.initialized).toBe(false);
        });

        it('should load pending invites', async () => {
            const address = '0xabc1230000000000000000000000000000004567';
            const inviteKey = `pombo_invites_${address}`;
            const invites = [{ inviteId: 'inv_1', from: '0xpeer', channel: { name: 'Test' } }];
            localStorage.setItem(inviteKey, JSON.stringify(invites));

            await notificationManager.init();

            expect(notificationManager.pendingInvites.size).toBe(1);
            expect(notificationManager.pendingInvites.get('inv_1')).toBeDefined();
        });

        it('should not subscribe if not enabled', async () => {
            await notificationManager.init();
            expect(streamrController.subscribeSimple).not.toHaveBeenCalled();
            expect(notificationManager.initialized).toBe(false);
        });

        it('should subscribe and set initialized when enabled', async () => {
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, JSON.stringify({ enabled: true, streamId: 'addr/pombo_notifications' }));

            await notificationManager.init();

            expect(streamrController.subscribeSimple).toHaveBeenCalled();
            expect(notificationManager.initialized).toBe(true);
        });

        it('should handle subscribe failure gracefully', async () => {
            const key = notificationManager.getStorageKey();
            localStorage.setItem(key, JSON.stringify({ enabled: true, streamId: 'addr/pombo_notifications' }));
            streamrController.subscribeSimple.mockRejectedValueOnce(new Error('fail'));

            await notificationManager.init(); // Should not throw
            expect(notificationManager.initialized).toBe(false);
        });
    });

    // ==================== sendChannelInvite() ====================
    describe('sendChannelInvite()', () => {
        it('should publish invite to recipient notification stream', async () => {
            const channelInfo = {
                streamId: 'owner/channel-1',
                name: 'General',
                type: 'public',
                password: null
            };

            const inviteId = await notificationManager.sendChannelInvite('0xRecipient', channelInfo);

            expect(inviteId).toMatch(/^invite_/);
            expect(streamrController.publish).toHaveBeenCalledWith(
                '0xrecipient/pombo_notifications',
                0,
                expect.objectContaining({
                    type: 'CHANNEL_INVITE',
                    inviteId: expect.any(String),
                    from: '0xAbC1230000000000000000000000000000004567',
                    to: '0xRecipient',
                    channel: expect.objectContaining({
                        streamId: 'owner/channel-1',
                        name: 'General'
                    })
                }),
                null
            );
        });

        it('should throw on publish failure', async () => {
            streamrController.publish.mockRejectedValueOnce(new Error('Publish failed'));

            await expect(
                notificationManager.sendChannelInvite('0xRecipient', { streamId: 's', name: 'n', type: 'public' })
            ).rejects.toThrow('Publish failed');
        });
    });

    // ==================== handleNotification() ====================
    describe('handleNotification()', () => {
        it('should route CHANNEL_INVITE to handleChannelInvite', () => {
            const spy = vi.spyOn(notificationManager, 'handleChannelInvite');
            const data = { type: 'CHANNEL_INVITE', inviteId: 'inv_1' };

            notificationManager.handleNotification(data);

            expect(spy).toHaveBeenCalledWith(data);
            spy.mockRestore();
        });

        it('should ignore unknown notification types', () => {
            const spy = vi.spyOn(notificationManager, 'handleChannelInvite');
            notificationManager.handleNotification({ type: 'UNKNOWN' });
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });
    });

    // ==================== handleChannelInvite() ====================
    describe('handleChannelInvite()', () => {
        it('should add invite to pending invites', () => {
            const invite = { inviteId: 'inv_42', from: '0xpeer', channel: { name: 'Room' } };

            notificationManager.handleChannelInvite(invite);

            expect(notificationManager.pendingInvites.get('inv_42')).toEqual(invite);
        });

        it('should save pending invites to localStorage', () => {
            const invite = { inviteId: 'inv_42', from: '0xpeer', channel: { name: 'Room' } };
            notificationManager.handleChannelInvite(invite);

            const address = '0xabc1230000000000000000000000000000004567';
            const stored = JSON.parse(localStorage.getItem(`pombo_invites_${address}`));
            expect(stored).toHaveLength(1);
            expect(stored[0].inviteId).toBe('inv_42');
        });
    });

    // ==================== acceptInvite() ====================
    describe('acceptInvite()', () => {
        it('should join channel and remove from pending', async () => {
            const invite = {
                inviteId: 'inv_1',
                channel: { streamId: 'ch-1', password: 'pw', name: 'Room', type: 'password' }
            };
            notificationManager.pendingInvites.set('inv_1', invite);

            await notificationManager.acceptInvite('inv_1');

            expect(channelManager.joinChannel).toHaveBeenCalledWith(
                'ch-1', 'pw', { name: 'Room', type: 'password' }
            );
            expect(notificationManager.pendingInvites.has('inv_1')).toBe(false);
            expect(uiController.showNotification).toHaveBeenCalledWith(
                expect.stringContaining('Room'), 'success'
            );
        });

        it('should handle non-existent invite', async () => {
            await notificationManager.acceptInvite('non-existent');
            expect(channelManager.joinChannel).not.toHaveBeenCalled();
        });

        it('should show error on join failure', async () => {
            const invite = {
                inviteId: 'inv_fail',
                channel: { streamId: 'ch-1', password: null, name: 'Room', type: 'public' }
            };
            notificationManager.pendingInvites.set('inv_fail', invite);
            channelManager.joinChannel.mockRejectedValueOnce(new Error('Permission denied'));

            await notificationManager.acceptInvite('inv_fail');

            expect(uiController.showNotification).toHaveBeenCalledWith(
                expect.stringContaining('Permission denied'), 'error'
            );
        });
    });

    // ==================== dismissInvite() ====================
    describe('dismissInvite()', () => {
        it('should remove invite and save', () => {
            notificationManager.pendingInvites.set('inv_1', { inviteId: 'inv_1' });

            notificationManager.dismissInvite('inv_1');

            expect(notificationManager.pendingInvites.has('inv_1')).toBe(false);
        });
    });

    // ==================== getPendingInvites() ====================
    describe('getPendingInvites()', () => {
        it('should return array of pending invites', () => {
            notificationManager.pendingInvites.set('a', { inviteId: 'a' });
            notificationManager.pendingInvites.set('b', { inviteId: 'b' });

            const result = notificationManager.getPendingInvites();
            expect(result).toHaveLength(2);
            expect(result[0].inviteId).toBe('a');
        });

        it('should return empty array when no invites', () => {
            expect(notificationManager.getPendingInvites()).toEqual([]);
        });
    });

    // ==================== loadPendingInvites() ====================
    describe('loadPendingInvites()', () => {
        it('should load invites from localStorage', () => {
            const address = '0xabc1230000000000000000000000000000004567';
            const invites = [
                { inviteId: 'inv_1', from: '0xpeer1' },
                { inviteId: 'inv_2', from: '0xpeer2' }
            ];
            localStorage.setItem(`pombo_invites_${address}`, JSON.stringify(invites));

            notificationManager.loadPendingInvites();

            expect(notificationManager.pendingInvites.size).toBe(2);
        });

        it('should handle missing data gracefully', () => {
            notificationManager.loadPendingInvites();
            expect(notificationManager.pendingInvites.size).toBe(0);
        });

        it('should handle corrupted data', () => {
            const address = '0xabc1230000000000000000000000000000004567';
            localStorage.setItem(`pombo_invites_${address}`, 'not valid json');

            notificationManager.loadPendingInvites(); // Should not throw
            expect(notificationManager.pendingInvites.size).toBe(0);
        });

        it('should skip when no address', () => {
            authManager.getAddress.mockReturnValue(null);
            notificationManager.loadPendingInvites();
            expect(notificationManager.pendingInvites.size).toBe(0);
        });
    });

    // ==================== savePendingInvites() ====================
    describe('savePendingInvites()', () => {
        it('should save invites to localStorage', () => {
            notificationManager.pendingInvites.set('inv_1', { inviteId: 'inv_1', from: '0x1' });

            notificationManager.savePendingInvites();

            const address = '0xabc1230000000000000000000000000000004567';
            const stored = JSON.parse(localStorage.getItem(`pombo_invites_${address}`));
            expect(stored).toHaveLength(1);
            expect(stored[0].inviteId).toBe('inv_1');
        });

        it('should skip when no address', () => {
            authManager.getAddress.mockReturnValue(null);
            notificationManager.pendingInvites.set('inv_1', { inviteId: 'inv_1' });

            notificationManager.savePendingInvites();

            // No key written
            expect(localStorage.length).toBe(0);
        });
    });

    // ==================== generateInviteId() ====================
    describe('generateInviteId()', () => {
        it('should generate unique IDs', () => {
            const id1 = notificationManager.generateInviteId();
            const id2 = notificationManager.generateInviteId();
            expect(id1).not.toBe(id2);
        });

        it('should start with invite_ prefix', () => {
            const id = notificationManager.generateInviteId();
            expect(id).toMatch(/^invite_\d+_[a-z0-9]+$/);
        });
    });

    // ==================== formatAddress() ====================
    describe('formatAddress()', () => {
        it('should shorten address to 6...4 format', () => {
            const result = notificationManager.formatAddress('0x1234567890abcdef1234567890abcdef12345678');
            expect(result).toBe('0x1234...5678');
        });

        it('should return Unknown for null', () => {
            expect(notificationManager.formatAddress(null)).toBe('Unknown');
        });

        it('should return Unknown for undefined', () => {
            expect(notificationManager.formatAddress(undefined)).toBe('Unknown');
        });

        it('should return Unknown for empty string', () => {
            expect(notificationManager.formatAddress('')).toBe('Unknown');
        });
    });

    // ==================== playNotificationSound() ====================
    describe('playNotificationSound()', () => {
        it('should not throw when AudioContext works', () => {
            // The real AudioContext test is tricky in jsdom - just verify it doesn't throw
            // when an AudioContext-like object is available
            const origAC = window.AudioContext;
            const origWAC = window.webkitAudioContext;

            const mockOscillator = {
                connect: vi.fn(),
                frequency: { value: 0 },
                type: '',
                start: vi.fn(),
                stop: vi.fn()
            };
            const mockGainNode = {
                connect: vi.fn(),
                gain: { value: 0 }
            };

            window.AudioContext = function() {
                this.createOscillator = () => mockOscillator;
                this.createGain = () => mockGainNode;
                this.destination = {};
                this.currentTime = 0;
            };

            expect(() => notificationManager.playNotificationSound()).not.toThrow();
            expect(mockOscillator.start).toHaveBeenCalled();
            expect(mockOscillator.stop).toHaveBeenCalled();

            window.AudioContext = origAC;
            window.webkitAudioContext = origWAC;
        });

        it('should not throw when AudioContext unavailable', () => {
            delete window.AudioContext;
            delete window.webkitAudioContext;

            // Should not throw
            expect(() => notificationManager.playNotificationSound()).not.toThrow();
        });
    });

    // ==================== showInviteNotification() ====================
    describe('showInviteNotification()', () => {
        let container;

        beforeEach(() => {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        });

        afterEach(() => {
            container.remove();
        });

        it('should create toast element in container', () => {
            const invite = {
                inviteId: 'inv_toast',
                from: '0x1234567890abcdef1234567890abcdef12345678',
                channel: { name: 'TestChannel' }
            };

            notificationManager.showInviteNotification(invite);

            const toast = container.querySelector('.toast');
            expect(toast).toBeTruthy();
            expect(toast.dataset.inviteId).toBe('inv_toast');
        });

        it('should not throw when toast container missing', () => {
            container.remove();
            const invite = {
                inviteId: 'inv_no_container',
                from: '0xabc',
                channel: { name: 'Test' }
            };

            // Should not throw
            expect(() => notificationManager.showInviteNotification(invite)).not.toThrow();
        });

        it('should set up accept button click handler', () => {
            const invite = {
                inviteId: 'inv_accept_btn',
                from: '0x1234567890abcdef1234567890abcdef12345678',
                channel: { name: 'Room', streamId: 'ch-1', password: null, type: 'public' }
            };
            const spy = vi.spyOn(notificationManager, 'acceptInvite').mockResolvedValue(undefined);

            notificationManager.showInviteNotification(invite);

            const acceptBtn = container.querySelector('.accept-btn');
            expect(acceptBtn).toBeTruthy();
            acceptBtn.click();
            expect(spy).toHaveBeenCalledWith('inv_accept_btn');

            spy.mockRestore();
        });

        it('should set up dismiss button click handler', () => {
            const invite = {
                inviteId: 'inv_dismiss_btn',
                from: '0x1234567890abcdef1234567890abcdef12345678',
                channel: { name: 'Room' }
            };
            const spy = vi.spyOn(notificationManager, 'dismissInvite');

            notificationManager.showInviteNotification(invite);

            const dismissBtn = container.querySelector('.dismiss-btn');
            expect(dismissBtn).toBeTruthy();
            dismissBtn.click();
            expect(spy).toHaveBeenCalledWith('inv_dismiss_btn');

            spy.mockRestore();
        });
    });
});
