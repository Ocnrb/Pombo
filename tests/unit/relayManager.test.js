/**
 * RelayManager Tests
 * Tests for the RelayManager class (relayManager.js)
 * Covers: syncWithServiceWorker, channel tag calculation, DM type handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock all dependencies before importing relayManager.js
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        client: {
            publish: vi.fn().mockResolvedValue(undefined)
        }
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        channels: new Map()
    }
}));

vi.mock('../../src/js/pushProtocol.js', () => ({
    calculateChannelTag: vi.fn((streamId) => `tag-${streamId.slice(0, 8)}`),
    calculateNativeChannelTag: vi.fn((streamId) => `native-tag-${streamId.slice(0, 8)}`),
    createRegistrationPayload: vi.fn(),
    createChannelNotificationPayload: vi.fn(),
    createNativeChannelNotificationPayload: vi.fn(),
    DEFAULT_CONFIG: {
        pushStreamId: 'test/push-stream',
        powDifficulty: 4,
        relays: []
    }
}));

import { relayManager } from '../../src/js/relayManager.js';
import { channelManager } from '../../src/js/channels.js';
import { calculateChannelTag, calculateNativeChannelTag } from '../../src/js/pushProtocol.js';

describe('RelayManager', () => {
    let mockPostMessage;
    let originalNavigator;

    beforeEach(() => {
        // Reset relayManager state
        relayManager.subscribedChannels.clear();
        relayManager.subscribedNativeChannels.clear();
        relayManager.walletAddress = '0xmyaddress1234';

        // Reset mocked channelManager channels
        channelManager.channels.clear();

        // Mock navigator.serviceWorker
        mockPostMessage = vi.fn();
        originalNavigator = global.navigator;
        global.navigator = {
            serviceWorker: {
                controller: {
                    postMessage: mockPostMessage
                },
                addEventListener: vi.fn()
            }
        };

        // Reset mocks
        vi.clearAllMocks();
    });

    afterEach(() => {
        global.navigator = originalNavigator;
    });

    // ==================== syncWithServiceWorker() ====================
    describe('syncWithServiceWorker()', () => {
        it('should skip if no Service Worker controller', () => {
            global.navigator = {
                serviceWorker: {
                    controller: null
                }
            };

            relayManager.syncWithServiceWorker();

            expect(mockPostMessage).not.toHaveBeenCalled();
        });

        it('should sync public channel with correct structure', () => {
            const streamId = 'owner/public-channel';
            channelManager.channels.set(streamId, {
                name: 'General Chat',
                isPrivate: false
            });
            relayManager.subscribedChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            expect(mockPostMessage).toHaveBeenCalledWith({
                type: 'SYNC_CHANNELS',
                channels: expect.arrayContaining([
                    expect.objectContaining({
                        streamId,
                        type: 'public',
                        name: 'General Chat',
                        tag: expect.any(String),
                        storageEndpoints: expect.any(Array)
                    })
                ]),
                dmPeers: expect.any(Array)
            });
        });

        it('should sync private channel with correct type', () => {
            const streamId = 'owner/private-channel';
            channelManager.channels.set(streamId, {
                name: 'Secret Room',
                isPrivate: true
            });
            relayManager.subscribedChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.type).toBe('private');
        });

        it('should sync DM channel with type dm and correct name', () => {
            const streamId = '0xpeer/Pombo-DM-1';
            channelManager.channels.set(streamId, {
                type: 'dm',
                name: 'Alice',
                peerAddress: '0xpeer'
            });
            relayManager.subscribedChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.type).toBe('dm');
            expect(channelData.name).toBe('Alice');
        });

        it('should use fallback name for DM channel without name', () => {
            const streamId = '0xpeer/Pombo-DM-1';
            channelManager.channels.set(streamId, {
                type: 'dm',
                peerAddress: '0xpeer'
                // No name field
            });
            relayManager.subscribedChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.name).toBe('Direct Message');
        });

        it('should sync native channel with type native', () => {
            const streamId = '0xowner/native-channel';
            channelManager.channels.set(streamId, {
                name: 'Bob Group',
                participants: [
                    { address: '0xmyaddress1234', nickname: 'Me' },
                    { address: '0xbob', nickname: 'Bob' }
                ]
            });
            relayManager.subscribedNativeChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.type).toBe('native');
            expect(channelData.name).toBe('Bob Group');
        });

        it('should use participant nickname for native channel without name', () => {
            const streamId = '0xowner/native-channel';
            channelManager.channels.set(streamId, {
                // No name field
                participants: [
                    { address: '0xmyaddress1234', nickname: 'Me' },
                    { address: '0xbob', nickname: 'Bob' }
                ]
            });
            relayManager.subscribedNativeChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.name).toBe('Bob');
        });

        it('should use fallback for native channel without name or participants', () => {
            const streamId = '0xowner/native-channel';
            channelManager.channels.set(streamId, {});
            relayManager.subscribedNativeChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.name).toBe('Direct Message');
        });

        it('should sync multiple channels of different types', () => {
            // Add public channel
            const publicId = 'owner/public';
            channelManager.channels.set(publicId, { name: 'Public' });
            relayManager.subscribedChannels.add(publicId);

            // Add DM channel
            const dmId = '0xpeer/Pombo-DM-1';
            channelManager.channels.set(dmId, { type: 'dm', name: 'John' });
            relayManager.subscribedChannels.add(dmId);

            // Add native channel
            const nativeId = '0xowner/native';
            channelManager.channels.set(nativeId, { name: 'Private Group' });
            relayManager.subscribedNativeChannels.add(nativeId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.channels).toHaveLength(3);
            
            const publicChannel = sentData.channels.find(c => c.streamId === publicId);
            const dmChannel = sentData.channels.find(c => c.streamId === dmId);
            const nativeChannel = sentData.channels.find(c => c.streamId === nativeId);

            expect(publicChannel.type).toBe('public');
            expect(dmChannel.type).toBe('dm');
            expect(nativeChannel.type).toBe('native');
        });

        it('should use correct tag functions for each channel type', () => {
            const publicId = 'owner/public';
            channelManager.channels.set(publicId, { name: 'Public' });
            relayManager.subscribedChannels.add(publicId);

            const nativeId = '0xowner/native';
            channelManager.channels.set(nativeId, { name: 'Native' });
            relayManager.subscribedNativeChannels.add(nativeId);

            relayManager.syncWithServiceWorker();

            expect(calculateChannelTag).toHaveBeenCalledWith(publicId);
            expect(calculateNativeChannelTag).toHaveBeenCalledWith(nativeId);
        });

        it('should use Channel as fallback name for unknown channels', () => {
            const streamId = 'owner/unknown';
            relayManager.subscribedChannels.add(streamId);
            // No channel info in channelManager

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.name).toBe('Channel');
        });

        it('should include storage endpoints from channel info', () => {
            const customEndpoints = ['https://custom1.test', 'https://custom2.test'];
            const streamId = 'owner/custom';
            channelManager.channels.set(streamId, {
                name: 'Custom',
                storageEndpoints: customEndpoints
            });
            relayManager.subscribedChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.storageEndpoints).toEqual(customEndpoints);
        });

        it('should use default storage endpoints when not provided', () => {
            const streamId = 'owner/default';
            channelManager.channels.set(streamId, { name: 'Default' });
            relayManager.subscribedChannels.add(streamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.storageEndpoints).toHaveLength(6);
            expect(channelData.storageEndpoints[0]).toContain('storage-cluster');
        });

        it('should detect DM inbox subscription by stream ID pattern', () => {
            const inboxStreamId = '0xmyaddress/Pombo-DM-1';
            relayManager.subscribedChannels.add(inboxStreamId);
            // No channel info for inbox (it's the user's own inbox, not stored as a channel)

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === inboxStreamId);
            expect(channelData.type).toBe('dm');
            expect(channelData.name).toBe('Direct Message');
        });

        it('should include dmPeers array in sync message', () => {
            const dmStreamId = '0xpeer/Pombo-DM-1';
            channelManager.channels.set(dmStreamId, {
                type: 'dm',
                name: 'Alice',
                peerAddress: '0xpeer'
            });
            relayManager.subscribedChannels.add(dmStreamId);

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.dmPeers).toBeDefined();
            expect(sentData.dmPeers).toHaveLength(1);
            expect(sentData.dmPeers[0]).toEqual({
                address: '0xpeer',
                name: 'Alice'
            });
        });

        it('should include multiple DM peers from channelManager', () => {
            // Set up DM conversations with two peers
            channelManager.channels.set('0xalice/Pombo-DM-1', {
                type: 'dm',
                name: 'Alice Smith',
                peerAddress: '0xAlice'
            });
            channelManager.channels.set('0xbob/Pombo-DM-1', {
                type: 'dm',
                name: 'Bob Jones',
                peerAddress: '0xBob'
            });

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.dmPeers).toHaveLength(2);
            
            const alice = sentData.dmPeers.find(p => p.address === '0xalice');
            const bob = sentData.dmPeers.find(p => p.address === '0xbob');
            
            expect(alice.name).toBe('Alice Smith');
            expect(bob.name).toBe('Bob Jones');
        });

        it('should lowercase peer addresses in dmPeers', () => {
            channelManager.channels.set('0xPEER/Pombo-DM-1', {
                type: 'dm',
                name: 'Test',
                peerAddress: '0xPEER'
            });

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.dmPeers[0].address).toBe('0xpeer');
        });

        it('should not include DM peers without name', () => {
            channelManager.channels.set('0xpeer/Pombo-DM-1', {
                type: 'dm',
                peerAddress: '0xpeer'
                // No name
            });

            relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.dmPeers).toHaveLength(0);
        });
    });

    // ==================== subscribed channels management ====================
    describe('subscribedChannels', () => {
        it('should be empty initially', () => {
            const manager = new relayManager.constructor();
            expect(manager.subscribedChannels.size).toBe(0);
            expect(manager.subscribedNativeChannels.size).toBe(0);
        });

        it('should track added channels', () => {
            relayManager.subscribedChannels.add('stream-1');
            relayManager.subscribedChannels.add('stream-2');

            expect(relayManager.subscribedChannels.has('stream-1')).toBe(true);
            expect(relayManager.subscribedChannels.has('stream-2')).toBe(true);
            expect(relayManager.subscribedChannels.size).toBe(2);
        });
    });
});
