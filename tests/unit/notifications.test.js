/**
 * Tests for notifications.js - NotificationManager
 * 
 * Covers: init, sendChannelInvite (E2E encrypted via DM inbox P3),
 * handleNotification, invite management, localStorage persistence,
 * formatAddress, generateInviteId, playNotificationSound, UI interactions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        client: {
            getStream: vi.fn().mockResolvedValue({ id: 'mock-stream' })
        },
        getDMInboxId: vi.fn((addr) => `${addr.toLowerCase()}/Pombo-DM-1`),
        getDMPublicKey: vi.fn().mockResolvedValue('0x02peerpubkey'),
        setDMPublishKey: vi.fn().mockResolvedValue(undefined),
        publishNotification: vi.fn().mockResolvedValue(undefined)
    },
    STREAM_CONFIG: {
        MESSAGE_STREAM: {
            NOTIFICATIONS: 3
        }
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xAbC1230000000000000000000000000000004567'),
        wallet: { privateKey: '0xfakeprivatekey1234567890abcdef' }
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

vi.mock('../../src/js/config.js', async () => {
    const actual = await vi.importActual('../../src/js/config.js');
    return {
        ...actual,
        CONFIG: {
            ...actual.CONFIG,
            notifications: {
                ...actual.CONFIG.notifications,
                inviteToastDurationMs: 10000
            }
        }
    };
});

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getSharedKey: vi.fn().mockResolvedValue('mock-aes-key'),
        encrypt: vi.fn().mockImplementation(async (msg) => ({ ct: 'enc', iv: 'iv', e: 'aes-256-gcm', _original: msg }))
    }
}));

import { notificationManager } from '../../src/js/notifications.js';
import { streamrController } from '../../src/js/streamr.js';
import { authManager } from '../../src/js/auth.js';
import { channelManager } from '../../src/js/channels.js';
import { uiController } from '../../src/js/ui.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';

describe('NotificationManager', () => {
    beforeEach(() => {
        // Reset state
        notificationManager.pendingInvites = new Map();
        notificationManager.initialized = false;
        notificationManager.muted = false;

        // Clear localStorage
        localStorage.clear();

        vi.clearAllMocks();
        authManager.getAddress.mockReturnValue('0xAbC1230000000000000000000000000000004567');
        streamrController.client.getStream.mockResolvedValue({ id: 'mock-stream' });
        streamrController.getDMPublicKey.mockResolvedValue('0x02peerpubkey');
    });

    // ==================== constructor ====================
    describe('constructor', () => {
        it('should initialize with default state', () => {
            expect(notificationManager.pendingInvites).toBeInstanceOf(Map);
            expect(notificationManager.initialized).toBe(false);
            expect(notificationManager.muted).toBe(false);
        });
    });

    // ==================== init() ====================
    describe('init()', () => {
        it('should return early when not authenticated', async () => {
            authManager.getAddress.mockReturnValue(null);
            await notificationManager.init();
            expect(notificationManager.initialized).toBe(false);
        });

        it('should load pending invites and set initialized', async () => {
            const address = '0xabc1230000000000000000000000000000004567';
            const inviteKey = `pombo_invites_${address}`;
            const invites = [{ inviteId: 'inv_1', from: '0xpeer', channel: { name: 'Test' } }];
            localStorage.setItem(inviteKey, JSON.stringify(invites));

            await notificationManager.init();

            expect(notificationManager.pendingInvites.size).toBe(1);
            expect(notificationManager.pendingInvites.get('inv_1')).toBeDefined();
            expect(notificationManager.initialized).toBe(true);
        });

        it('should set initialized even with no pending invites', async () => {
            await notificationManager.init();
            expect(notificationManager.initialized).toBe(true);
        });

        it('should restore muted state from localStorage', async () => {
            const address = '0xabc1230000000000000000000000000000004567';
            localStorage.setItem(`pombo_invites_muted_${address}`, '1');

            await notificationManager.init();
            expect(notificationManager.muted).toBe(true);
        });

        it('should default to unmuted when no localStorage entry', async () => {
            await notificationManager.init();
            expect(notificationManager.muted).toBe(false);
        });
    });

    // ==================== sendChannelInvite() ====================
    describe('sendChannelInvite()', () => {
        it('should throw when not authenticated', async () => {
            authManager.getAddress.mockReturnValue(null);
            await expect(
                notificationManager.sendChannelInvite('0xRecipient', { streamId: 's', name: 'n', type: 'public' })
            ).rejects.toThrow('Not authenticated');
        });

        it('should throw when recipient has no DM inbox', async () => {
            streamrController.client.getStream.mockRejectedValueOnce(new Error('not found'));

            await expect(
                notificationManager.sendChannelInvite('0xRecipient', { streamId: 's', name: 'n', type: 'public' })
            ).rejects.toThrow('not enabled DMs');
        });

        it('should throw when peer public key not available', async () => {
            streamrController.getDMPublicKey.mockResolvedValueOnce(null);

            await expect(
                notificationManager.sendChannelInvite('0xRecipient', { streamId: 's', name: 'n', type: 'public' })
            ).rejects.toThrow('peer public key not available');
        });

        it('should throw when wallet private key not available', async () => {
            const origWallet = authManager.wallet;
            authManager.wallet = null;

            await expect(
                notificationManager.sendChannelInvite('0xRecipient', { streamId: 's', name: 'n', type: 'public' })
            ).rejects.toThrow('wallet private key not available');

            authManager.wallet = origWallet;
        });

        it('should encrypt and publish invite to recipient DM inbox P3', async () => {
            const channelInfo = {
                streamId: 'owner/channel-1',
                name: 'General',
                type: 'public',
                password: null
            };

            const inviteId = await notificationManager.sendChannelInvite('0xRecipient', channelInfo);

            expect(inviteId).toMatch(/^invite_/);

            // Should check recipient inbox exists
            expect(streamrController.client.getStream).toHaveBeenCalledWith('0xrecipient/Pombo-DM-1');

            // Should get peer public key
            expect(streamrController.getDMPublicKey).toHaveBeenCalledWith('0xRecipient');

            // Should derive ECDH shared key
            expect(dmCrypto.getSharedKey).toHaveBeenCalledWith(
                '0xfakeprivatekey1234567890abcdef',
                '0xRecipient',
                '0x02peerpubkey'
            );

            // Should encrypt the invite
            expect(dmCrypto.encrypt).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'CHANNEL_INVITE',
                    from: '0xAbC1230000000000000000000000000000004567',
                    channel: expect.objectContaining({
                        streamId: 'owner/channel-1',
                        name: 'General'
                    })
                }),
                'mock-aes-key'
            );

            // Should set DM publish key and publish to P3
            expect(streamrController.setDMPublishKey).toHaveBeenCalledWith('0xrecipient/Pombo-DM-1');
            expect(streamrController.publishNotification).toHaveBeenCalledWith(
                '0xrecipient/Pombo-DM-1',
                expect.objectContaining({ ct: 'enc', iv: 'iv', e: 'aes-256-gcm' }),
                null
            );
        });

        it('should throw on publish failure', async () => {
            streamrController.publishNotification.mockRejectedValueOnce(new Error('Publish failed'));

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

    // ==================== isMuted() / setMuted() ====================
    describe('isMuted() / setMuted()', () => {
        it('should return false by default', () => {
            expect(notificationManager.isMuted()).toBe(false);
        });

        it('should return true after setMuted(true)', () => {
            notificationManager.setMuted(true);
            expect(notificationManager.isMuted()).toBe(true);
        });

        it('should return false after setMuted(false)', () => {
            notificationManager.setMuted(true);
            notificationManager.setMuted(false);
            expect(notificationManager.isMuted()).toBe(false);
        });

        it('should persist muted state to localStorage', () => {
            notificationManager.setMuted(true);
            const address = '0xabc1230000000000000000000000000000004567';
            expect(localStorage.getItem(`pombo_invites_muted_${address}`)).toBe('1');
        });

        it('should persist unmuted state to localStorage', () => {
            notificationManager.setMuted(false);
            const address = '0xabc1230000000000000000000000000000004567';
            expect(localStorage.getItem(`pombo_invites_muted_${address}`)).toBe('0');
        });

        it('should coerce truthy/falsy values', () => {
            notificationManager.setMuted(1);
            expect(notificationManager.isMuted()).toBe(true);
            notificationManager.setMuted(0);
            expect(notificationManager.isMuted()).toBe(false);
        });

        it('should skip localStorage when no address', () => {
            authManager.getAddress.mockReturnValue(null);
            notificationManager.setMuted(true);
            expect(notificationManager.isMuted()).toBe(true);
            // No localStorage entry created (no address to key on)
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
