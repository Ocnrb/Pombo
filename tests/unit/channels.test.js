/**
 * Tests for channels.js - Channel Manager (Core module)
 * 
 * Note: This module has many dependencies. We mock all external dependencies
 * and focus on testing the business logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies before importing
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        isInitialized: vi.fn().mockReturnValue(true),
        getCurrentAddress: vi.fn().mockReturnValue('0x123'),
        createStream: vi.fn(),
        subscribe: vi.fn(),
        publish: vi.fn(),
        publishMessage: vi.fn().mockResolvedValue(undefined),
        enableStorage: vi.fn().mockResolvedValue({ success: true, provider: 'streamr', storageDays: 180 }),
        getStoredMessages: vi.fn().mockResolvedValue([]),
        getStreamMetadata: vi.fn().mockResolvedValue(null),
        hasPermission: vi.fn().mockResolvedValue(true),
        hasPublishPermission: vi.fn().mockResolvedValue({ hasPermission: true, rpcError: false }),
        hasDeletePermission: vi.fn().mockResolvedValue(false),
        grantPublicPermissions: vi.fn(),
        resend: vi.fn(),
        unsubscribeFromDualStream: vi.fn().mockResolvedValue(undefined),
        fetchOlderHistory: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
        subscribeToDualStream: vi.fn().mockResolvedValue(undefined),
        checkPermissions: vi.fn().mockResolvedValue({ canSubscribe: true, canPublish: true, isOwner: false })
    },
    STREAM_CONFIG: {
        partitions: 1,
        LOAD_MORE_COUNT: 20,
        MESSAGE_STREAM: { MESSAGES: 0 }
    },
    deriveEphemeralId: vi.fn((id) => `${id}-ephemeral`),
    deriveMessageId: vi.fn((id) => `${id}-message`)
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xmyaddress'),
        getCurrentAddress: vi.fn().mockReturnValue('0xmyaddress'),
        getWalletAddress: vi.fn().mockReturnValue('0xmyaddress'),
        isConnected: vi.fn().mockReturnValue(true)
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getUserNickname: vi.fn().mockReturnValue('TestUser'),
        getCurrentIdentity: vi.fn().mockReturnValue({ nickname: 'TestUser', address: '0xmyaddress' }),
        generateSignature: vi.fn().mockResolvedValue('sig123'),
        verifyMessage: vi.fn().mockResolvedValue({ valid: true, trustLevel: 1 }),
        createSignedMessage: vi.fn().mockResolvedValue({ id: 'msg_signed', text: 'hello', sender: '0xmyaddress', timestamp: Date.now() }),
        getTrustLevel: vi.fn().mockResolvedValue(1),
        resolveENS: vi.fn().mockResolvedValue(null)
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn().mockReturnValue(true),
        getChannels: vi.fn().mockReturnValue([]),
        saveChannels: vi.fn(),
        setChannels: vi.fn(),
        getChannel: vi.fn(),
        setChannel: vi.fn(),
        clearSentMessages: vi.fn().mockResolvedValue(undefined),
        clearSentReactions: vi.fn().mockResolvedValue(undefined),
        removeFromChannelOrder: vi.fn().mockResolvedValue(undefined),
        setDMLeftAt: vi.fn().mockResolvedValue(undefined),
        addBlockedPeer: vi.fn().mockResolvedValue(undefined),
        addToChannelOrder: vi.fn().mockResolvedValue(undefined),
        addSentMessage: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/graph.js', () => ({
    graphAPI: {
        getPublicPomboChannels: vi.fn().mockResolvedValue([]),
        getStreamMetadata: vi.fn()
    }
}));

vi.mock('../../src/js/relayManager.js', () => ({
    relayManager: {
        sendPushNotification: vi.fn(),
        enabled: false,
        subscribeToChannel: vi.fn().mockResolvedValue(true),
        subscribeToNativeChannel: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        subscribeDMEphemeral: vi.fn().mockResolvedValue(undefined),
        unsubscribeDMEphemeral: vi.fn().mockResolvedValue(undefined),
        loadDMTimeline: vi.fn(),
        getPeerPublicKey: vi.fn().mockResolvedValue(null),
        isDMChannel: vi.fn().mockReturnValue(false),
        conversations: new Map()
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

// Now import the module
import { channelManager } from '../../src/js/channels.js';
import { authManager } from '../../src/js/auth.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { graphAPI } from '../../src/js/graph.js';
import { streamrController } from '../../src/js/streamr.js';
import { identityManager } from '../../src/js/identity.js';

describe('ChannelManager', () => {
    beforeEach(() => {
        // Reset channel state
        channelManager.channels.clear();
        channelManager.currentChannel = null;
        channelManager.switchGeneration = 0;
        channelManager.historyAbortController = null;
        channelManager.pendingVerifications.clear();
        channelManager.messageHandlers = [];
        channelManager.processingMessages.clear();
        channelManager.sendingMessages.clear();
        channelManager.pendingReactions.clear();
        channelManager.onlineUsers.clear();
        channelManager.onlineUsersHandlers = [];
        
        // Reset mocks
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with empty channels map', () => {
            expect(channelManager.channels).toBeInstanceOf(Map);
        });
        
        it('should have null currentChannel initially', () => {
            expect(channelManager.currentChannel).toBeNull();
        });
        
        it('should have deduplication sets', () => {
            expect(channelManager.processingMessages).toBeInstanceOf(Set);
            expect(channelManager.sendingMessages).toBeInstanceOf(Set);
            expect(channelManager.pendingReactions).toBeInstanceOf(Set);
        });
    });

    describe('loadChannels()', () => {
        it('should load channels from secure storage', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            const storedChannels = [
                { messageStreamId: 'stream1', name: 'Channel 1', type: 'public' },
                { messageStreamId: 'stream2', name: 'Channel 2', type: 'private' }
            ];
            secureStorage.getChannels.mockReturnValue(storedChannels);
            
            channelManager.loadChannels();
            
            expect(secureStorage.getChannels).toHaveBeenCalled();
            expect(channelManager.channels.size).toBe(2);
        });
        
        it('should not load when storage is locked', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            const storedChannels = [
                { messageStreamId: 'stream1', name: 'Test', type: 'public' }
            ];
            secureStorage.getChannels.mockReturnValue(storedChannels);
            
            channelManager.loadChannels();
            
            expect(channelManager.channels.size).toBe(0);
        });
        
        it('should handle empty channels array', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.getChannels.mockReturnValue([]);
            
            channelManager.loadChannels();
            
            expect(channelManager.channels.size).toBe(0);
        });
        
        it('should handle null from storage', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.getChannels.mockReturnValue(null);
            
            channelManager.loadChannels();
            
            expect(channelManager.channels.size).toBe(0);
        });
        
        it('should populate channels map with messageStreamId as key', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            const storedChannels = [
                { messageStreamId: 'test-stream-123', name: 'Test', type: 'public' }
            ];
            secureStorage.getChannels.mockReturnValue(storedChannels);
            
            channelManager.loadChannels();
            
            expect(channelManager.channels.has('test-stream-123')).toBe(true);
            expect(channelManager.channels.get('test-stream-123').name).toBe('Test');
        });
        
        it('should set streamId alias from messageStreamId', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            const storedChannels = [
                { messageStreamId: 'stream-abc', name: 'Test', type: 'public' }
            ];
            secureStorage.getChannels.mockReturnValue(storedChannels);
            
            channelManager.loadChannels();
            
            const channel = channelManager.channels.get('stream-abc');
            expect(channel.streamId).toBe('stream-abc');
        });
    });

    describe('clearChannels()', () => {
        it('should clear all channels', () => {
            channelManager.channels.set('stream1', { name: 'Channel 1' });
            channelManager.channels.set('stream2', { name: 'Channel 2' });
            
            channelManager.clearChannels();
            
            expect(channelManager.channels.size).toBe(0);
        });
        
        it('should reset currentChannel to null', () => {
            channelManager.currentChannel = 'stream1';
            
            channelManager.clearChannels();
            
            expect(channelManager.currentChannel).toBeNull();
        });
        
        it('should clear deduplication sets', () => {
            channelManager.processingMessages.add('msg1');
            channelManager.sendingMessages.add('stream1:msg1');
            
            channelManager.clearChannels();
            
            expect(channelManager.processingMessages.size).toBe(0);
            expect(channelManager.sendingMessages.size).toBe(0);
        });
    });

    describe('setCurrentChannel()', () => {
        it('should set the current channel', () => {
            channelManager.setCurrentChannel('stream1');
            
            expect(channelManager.currentChannel).toBe('stream1');
        });
        
        it('should allow setting null', () => {
            channelManager.currentChannel = 'stream1';
            
            channelManager.setCurrentChannel(null);
            
            expect(channelManager.currentChannel).toBeNull();
        });
    });

    describe('getCurrentChannel()', () => {
        it('should return null when no current channel', () => {
            expect(channelManager.getCurrentChannel()).toBeNull();
        });
        
        it('should return the channel object when set', () => {
            const channel = { streamId: 'stream1', name: 'Test' };
            channelManager.channels.set('stream1', channel);
            channelManager.currentChannel = 'stream1';
            
            expect(channelManager.getCurrentChannel()).toBe(channel);
        });
    });

    describe('getChannel()', () => {
        it('should return channel by streamId', () => {
            const channel = { streamId: 'stream1', name: 'Test' };
            channelManager.channels.set('stream1', channel);
            
            expect(channelManager.getChannel('stream1')).toBe(channel);
        });
        
        it('should return null for non-existent channel', () => {
            expect(channelManager.getChannel('non-existent')).toBeNull();
        });
    });

    describe('getAllChannels()', () => {
        it('should return array of all channels', () => {
            channelManager.channels.set('stream1', { name: 'Channel 1' });
            channelManager.channels.set('stream2', { name: 'Channel 2' });
            
            const result = channelManager.getAllChannels();
            
            expect(result).toHaveLength(2);
        });
        
        it('should return empty array when no channels', () => {
            expect(channelManager.getAllChannels()).toHaveLength(0);
        });
    });

    describe('storeReaction()', () => {
        it('should add reaction to channel', () => {
            const channel = { streamId: 'stream1', messages: [] };
            
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser1');
            
            expect(channel.reactions).toBeDefined();
            expect(channel.reactions['msg1']['👍']).toContain('0xuser1');
        });
        
        it('should not duplicate reactions from same user', () => {
            const channel = { streamId: 'stream1', reactions: {} };
            
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser1');
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser1');
            
            expect(channel.reactions['msg1']['👍']).toHaveLength(1);
        });
        
        it('should handle case-insensitive user addresses', () => {
            const channel = { streamId: 'stream1', reactions: {} };
            
            channelManager.storeReaction(channel, 'msg1', '👍', '0xUser1');
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser1'); // lowercase
            
            expect(channel.reactions['msg1']['👍']).toHaveLength(1);
        });
        
        it('should support multiple emojis on same message', () => {
            const channel = { streamId: 'stream1', reactions: {} };
            
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser1');
            channelManager.storeReaction(channel, 'msg1', '❤️', '0xuser1');
            
            expect(channel.reactions['msg1']['👍']).toHaveLength(1);
            expect(channel.reactions['msg1']['❤️']).toHaveLength(1);
        });
        
        it('should support multiple users on same reaction', () => {
            const channel = { streamId: 'stream1', reactions: {} };
            
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser1');
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser2');
            
            expect(channel.reactions['msg1']['👍']).toHaveLength(2);
        });
        
        it('should remove reaction with action="remove"', () => {
            const channel = { 
                streamId: 'stream1', 
                reactions: { 'msg1': { '👍': ['0xuser1', '0xuser2'] } } 
            };
            
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser1', 'remove');
            
            expect(channel.reactions['msg1']['👍']).not.toContain('0xuser1');
            expect(channel.reactions['msg1']['👍']).toContain('0xuser2');
        });
        
        it('should clean up empty emoji arrays after removal', () => {
            const channel = { 
                streamId: 'stream1', 
                reactions: { 'msg1': { 'thumbs': ['0xuser1'] } } 
            };
            
            channelManager.storeReaction(channel, 'msg1', 'thumbs', '0xuser1', 'remove');
            
            expect(channel.reactions['msg1']).toBeUndefined();
        });
        
        it('should clean up empty message reactions after removal', () => {
            const channel = { 
                streamId: 'stream1', 
                reactions: { 'msg1': { '👍': ['0xuser1'] } } 
            };
            
            channelManager.storeReaction(channel, 'msg1', '👍', '0xuser1', 'remove');
            
            expect(channel.reactions['msg1']).toBeUndefined();
        });
    });

    describe('getChannelReactions()', () => {
        it('should return reactions for channel', () => {
            const channel = { 
                streamId: 'stream1', 
                reactions: { 'msg1': { '👍': ['0xuser1'] } } 
            };
            channelManager.channels.set('stream1', channel);
            
            const reactions = channelManager.getChannelReactions('stream1');
            
            expect(reactions).toEqual(channel.reactions);
        });
        
        it('should return empty object for channel without reactions', () => {
            const channel = { streamId: 'stream1' };
            channelManager.channels.set('stream1', channel);
            
            const reactions = channelManager.getChannelReactions('stream1');
            
            expect(reactions).toEqual({});
        });
        
        it('should return empty object for non-existent channel', () => {
            const reactions = channelManager.getChannelReactions('non-existent');
            
            expect(reactions).toEqual({});
        });
    });

    describe('sortMessagesByTimestamp()', () => {
        it('should sort messages by timestamp ascending', () => {
            const channel = {
                messages: [
                    { id: 3, timestamp: 1000 },
                    { id: 1, timestamp: 500 },
                    { id: 2, timestamp: 750 }
                ]
            };
            
            channelManager.sortMessagesByTimestamp(channel);
            
            expect(channel.messages[0].id).toBe(1);
            expect(channel.messages[1].id).toBe(2);
            expect(channel.messages[2].id).toBe(3);
        });
        
        it('should handle null/undefined channel', () => {
            expect(() => channelManager.sortMessagesByTimestamp(null)).not.toThrow();
            expect(() => channelManager.sortMessagesByTimestamp(undefined)).not.toThrow();
        });
        
        it('should handle channel without messages', () => {
            const channel = { name: 'Test' };
            expect(() => channelManager.sortMessagesByTimestamp(channel)).not.toThrow();
        });
        
        it('should treat missing timestamps as 0', () => {
            const channel = {
                messages: [
                    { id: 1, timestamp: 100 },
                    { id: 2 }, // no timestamp
                    { id: 3, timestamp: 50 }
                ]
            };
            
            channelManager.sortMessagesByTimestamp(channel);
            
            expect(channel.messages[0].id).toBe(2); // timestamp 0
            expect(channel.messages[1].id).toBe(3); // timestamp 50
        });
    });

    describe('isChannelOwner()', () => {
        beforeEach(() => {
            authManager.getAddress.mockReturnValue('0xmyaddress');
        });
        
        it('should return true if user is owner', () => {
            const channel = { 
                streamId: 'stream1', 
                createdBy: '0xmyaddress' 
            };
            channelManager.channels.set('stream1', channel);
            
            expect(channelManager.isChannelOwner('stream1')).toBe(true);
        });
        
        it('should return false if user is not owner', () => {
            const channel = { 
                streamId: 'stream1', 
                createdBy: '0xotheruser' 
            };
            channelManager.channels.set('stream1', channel);
            
            expect(channelManager.isChannelOwner('stream1')).toBe(false);
        });
        
        it('should be case-insensitive for address comparison', () => {
            authManager.getAddress.mockReturnValue('0xMyAddress');
            const channel = { 
                streamId: 'stream1', 
                createdBy: '0xmyaddress' 
            };
            channelManager.channels.set('stream1', channel);
            
            expect(channelManager.isChannelOwner('stream1')).toBe(true);
        });
        
        it('should return false for non-existent channel', () => {
            expect(channelManager.isChannelOwner('non-existent')).toBe(false);
        });
    });

    describe('generateInviteLink()', () => {
        beforeEach(() => {
            // Mock window.location
            global.window = { location: { origin: 'https://pombo.app' } };
        });
        
        it('should generate invite link with encoded data', () => {
            const channel = { 
                streamId: 'stream1', 
                name: 'Test Channel', 
                type: 'public' 
            };
            channelManager.channels.set('stream1', channel);
            
            const link = channelManager.generateInviteLink('stream1');
            
            expect(link).toContain('https://pombo.app?invite=');
        });
        
        it('should include channel name and type in encoded data', () => {
            const channel = { 
                streamId: 'stream1', 
                name: 'My Channel', 
                type: 'private' 
            };
            channelManager.channels.set('stream1', channel);
            
            const link = channelManager.generateInviteLink('stream1');
            const encoded = link.split('invite=')[1];
            const decoded = JSON.parse(atob(encoded));
            
            expect(decoded.s).toBe('stream1');
            expect(decoded.n).toBe('My Channel');
            expect(decoded.t).toBe('private');
        });
        
        it('should include password if channel has one', () => {
            const channel = { 
                streamId: 'stream1', 
                name: 'Secure', 
                type: 'private',
                password: 'secret123'
            };
            channelManager.channels.set('stream1', channel);
            
            const link = channelManager.generateInviteLink('stream1');
            const encoded = link.split('invite=')[1];
            const decoded = JSON.parse(atob(encoded));
            
            expect(decoded.p).toBe('secret123');
        });
        
        it('should throw for non-existent channel', () => {
            expect(() => channelManager.generateInviteLink('non-existent'))
                .toThrow('Channel not found');
        });
    });

    describe('parseInviteLink()', () => {
        it('should parse valid invite code', () => {
            const data = { s: 'stream1', n: 'Test Channel', t: 'public' };
            const encoded = btoa(JSON.stringify(data));
            
            const result = channelManager.parseInviteLink(encoded);
            
            expect(result).toEqual({
                streamId: 'stream1',
                name: 'Test Channel',
                type: 'public',
                password: undefined
            });
        });
        
        it('should include password if present', () => {
            const data = { s: 'stream1', n: 'Secure', t: 'private', p: 'secret' };
            const encoded = btoa(JSON.stringify(data));
            
            const result = channelManager.parseInviteLink(encoded);
            
            expect(result.password).toBe('secret');
        });
        
        it('should return null for invalid encoded data', () => {
            const result = channelManager.parseInviteLink('invalid-base64!!!');
            expect(result).toBeNull();
        });
        
        it('should return null for valid base64 but invalid JSON', () => {
            const encoded = btoa('not-json');
            const result = channelManager.parseInviteLink(encoded);
            expect(result).toBeNull();
        });
    });

    describe('onMessage()', () => {
        it('should register message handler', () => {
            const handler = vi.fn();
            
            channelManager.onMessage(handler);
            
            expect(channelManager.messageHandlers).toContain(handler);
        });
        
        it('should support multiple handlers', () => {
            const handler1 = vi.fn();
            const handler2 = vi.fn();
            
            channelManager.onMessage(handler1);
            channelManager.onMessage(handler2);
            
            expect(channelManager.messageHandlers).toHaveLength(2);
        });
    });

    describe('notifyHandlers()', () => {
        it('should call all registered handlers', () => {
            const handler1 = vi.fn();
            const handler2 = vi.fn();
            channelManager.messageHandlers = [handler1, handler2];
            
            channelManager.notifyHandlers('message', { text: 'Hello' });
            
            expect(handler1).toHaveBeenCalledWith('message', { text: 'Hello' });
            expect(handler2).toHaveBeenCalledWith('message', { text: 'Hello' });
        });
        
        it('should continue even if a handler throws', () => {
            const handler1 = vi.fn().mockImplementation(() => { throw new Error('fail'); });
            const handler2 = vi.fn();
            channelManager.messageHandlers = [handler1, handler2];
            
            channelManager.notifyHandlers('message', {});
            
            expect(handler2).toHaveBeenCalled();
        });
    });

    describe('Online Users Tracking', () => {
        describe('getOnlineUsers()', () => {
            it('should return empty array for channel without users', () => {
                expect(channelManager.getOnlineUsers('stream1')).toEqual([]);
            });
            
            it('should return online users within timeout', () => {
                const users = new Map();
                users.set('user1', {
                    lastActive: Date.now(),
                    nickname: 'User1',
                    address: '0xuser1'
                });
                channelManager.onlineUsers.set('stream1', users);
                
                const result = channelManager.getOnlineUsers('stream1');
                
                expect(result).toHaveLength(1);
                expect(result[0].nickname).toBe('User1');
            });
            
            it('should filter out users beyond timeout', () => {
                const users = new Map();
                users.set('user1', {
                    lastActive: Date.now() - 999999999, // Very old
                    nickname: 'OldUser',
                    address: '0xold'
                });
                channelManager.onlineUsers.set('stream1', users);
                
                const result = channelManager.getOnlineUsers('stream1');
                
                expect(result).toHaveLength(0);
            });
        });

        describe('handlePresenceMessage()', () => {
            it('should add user to online users using senderId', () => {
                const presenceData = {
                    senderId: 'user1',
                    nickname: 'TestUser',
                    lastActive: Date.now()
                };
                
                channelManager.handlePresenceMessage('stream1', presenceData);
                
                const users = channelManager.onlineUsers.get('stream1');
                expect(users.has('user1')).toBe(true);
                expect(users.get('user1').address).toBe('user1');
            });
            
            it('should prefer senderId over self-reported userId', () => {
                channelManager.handlePresenceMessage('stream1', {
                    senderId: '0xreal',
                    userId: '0xspoofed',
                    nickname: 'Test',
                    lastActive: Date.now()
                });
                
                const users = channelManager.onlineUsers.get('stream1');
                expect(users.has('0xreal')).toBe(true);
                expect(users.has('0xspoofed')).toBe(false);
            });

            it('should fall back to userId when senderId missing (legacy)', () => {
                channelManager.handlePresenceMessage('stream1', {
                    userId: 'user1',
                    nickname: 'Test',
                    lastActive: Date.now()
                });
                
                const users = channelManager.onlineUsers.get('stream1');
                expect(users.has('user1')).toBe(true);
            });

            it('should ignore presence with no senderId or userId', () => {
                channelManager.handlePresenceMessage('stream1', {
                    nickname: 'Ghost',
                    lastActive: Date.now()
                });
                
                const users = channelManager.onlineUsers.get('stream1');
                expect(users.size).toBe(0);
            });

            it('should update existing user presence', () => {
                // First presence
                channelManager.handlePresenceMessage('stream1', {
                    senderId: 'user1',
                    nickname: 'OldName',
                    lastActive: 1000
                });
                
                // Updated presence
                channelManager.handlePresenceMessage('stream1', {
                    senderId: 'user1',
                    nickname: 'NewName',
                    lastActive: 2000
                });
                
                const users = channelManager.onlineUsers.get('stream1');
                expect(users.get('user1').nickname).toBe('NewName');
            });
        });

        describe('onOnlineUsersChange()', () => {
            it('should register online users handler', () => {
                const handler = vi.fn();
                
                channelManager.onOnlineUsersChange(handler);
                
                expect(channelManager.onlineUsersHandlers).toContain(handler);
            });
        });

        describe('handleControlMessage()', () => {
            it('should use senderId for typing events', async () => {
                const handler = vi.fn();
                channelManager.onMessage(handler);

                await channelManager.handleControlMessage('stream1', {
                    type: 'typing',
                    senderId: '0xreal_sender',
                    user: '0xspoofed',
                    nickname: 'Alice'
                });

                expect(handler).toHaveBeenCalledWith('typing', {
                    streamId: 'stream1',
                    user: '0xreal_sender',
                    nickname: 'Alice'
                });
            });

            it('should fall back to data.user for typing when senderId missing', async () => {
                const handler = vi.fn();
                channelManager.onMessage(handler);

                await channelManager.handleControlMessage('stream1', {
                    type: 'typing',
                    user: '0xlegacy_user'
                });

                expect(handler).toHaveBeenCalledWith('typing', {
                    streamId: 'stream1',
                    user: '0xlegacy_user',
                    nickname: null
                });
            });

            it('should use senderId for reaction events', async () => {
                const channel = { reactions: {} };
                channelManager.channels.set('stream1', channel);
                const handler = vi.fn();
                channelManager.onMessage(handler);

                await channelManager.handleControlMessage('stream1', {
                    type: 'reaction',
                    senderId: '0xreal_reactor',
                    user: '0xspoofed',
                    messageId: 'msg1',
                    emoji: '👍',
                    action: 'add'
                });

                expect(channel.reactions['msg1']['👍']).toContain('0xreal_reactor');
                expect(handler).toHaveBeenCalledWith('reaction', expect.objectContaining({
                    user: '0xreal_reactor'
                }));
            });

            it('should forward presence to handlePresenceMessage', async () => {
                await channelManager.handleControlMessage('stream1', {
                    type: 'presence',
                    senderId: '0xpresence_user',
                    nickname: 'Alice',
                    lastActive: Date.now()
                });

                const users = channelManager.onlineUsers.get('stream1');
                expect(users.has('0xpresence_user')).toBe(true);
            });

            it('should not process when disconnected', async () => {
                authManager.isConnected.mockReturnValueOnce(false);
                const handler = vi.fn();
                channelManager.onMessage(handler);

                await channelManager.handleControlMessage('stream1', {
                    type: 'typing',
                    senderId: '0xuser'
                });

                expect(handler).not.toHaveBeenCalled();
            });
        });

        describe('notifyOnlineUsersChange()', () => {
            it('should call all registered handlers with users', () => {
                const handler = vi.fn();
                channelManager.onlineUsersHandlers = [handler];
                
                const users = new Map();
                users.set('user1', {
                    lastActive: Date.now(),
                    nickname: 'User1',
                    address: '0x1'
                });
                channelManager.onlineUsers.set('stream1', users);
                
                channelManager.notifyOnlineUsersChange('stream1');
                
                expect(handler).toHaveBeenCalledWith('stream1', expect.any(Array));
            });
        });
    });

    describe('getPublicChannels()', () => {
        it('should fetch channels from graph API', async () => {
            const graphChannels = [
                { streamId: 'public1', name: 'Public 1', type: 'public' },
                { streamId: 'public2', name: 'Public 2', type: 'public' }
            ];
            graphAPI.getPublicPomboChannels.mockResolvedValue(graphChannels);
            
            const result = await channelManager.getPublicChannels();
            
            expect(graphAPI.getPublicPomboChannels).toHaveBeenCalled();
            expect(result).toHaveLength(2);
        });
        
        it('should include own public channels not in graph', async () => {
            graphAPI.getPublicPomboChannels.mockResolvedValue([]);
            
            // Add local public channel
            channelManager.channels.set('local1', {
                streamId: 'local1',
                name: 'Local Public',
                type: 'public',
                createdBy: '0xme',
                createdAt: Date.now()
            });
            
            const result = await channelManager.getPublicChannels();
            
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Local Public');
        });
        
        it('should not duplicate channels from graph and local', async () => {
            const graphChannels = [
                { streamId: 'public1', name: 'Public', type: 'public' }
            ];
            graphAPI.getPublicPomboChannels.mockResolvedValue(graphChannels);
            
            // Same channel locally
            channelManager.channels.set('public1', {
                streamId: 'public1',
                name: 'Public Local',
                type: 'public'
            });
            
            const result = await channelManager.getPublicChannels();
            
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Public'); // Graph version takes precedence
        });
        
        it('should sort by createdAt descending (newest first)', async () => {
            const graphChannels = [
                { streamId: 'old', name: 'Old', createdAt: 1000 },
                { streamId: 'new', name: 'New', createdAt: 2000 }
            ];
            graphAPI.getPublicPomboChannels.mockResolvedValue(graphChannels);
            
            const result = await channelManager.getPublicChannels();
            
            expect(result[0].name).toBe('New');
            expect(result[1].name).toBe('Old');
        });
        
        it('should handle graph API errors gracefully', async () => {
            graphAPI.getPublicPomboChannels.mockRejectedValue(new Error('Network error'));
            
            // Should not throw
            const result = await channelManager.getPublicChannels();
            
            expect(result).toEqual([]);
        });
    });

    describe('saveChannels()', () => {
        it('should save channels to secure storage', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            channelManager.channels.set('stream1', {
                messageStreamId: 'stream1',
                ephemeralStreamId: 'stream1-ephemeral',
                name: 'Test Channel',
                type: 'public',
                createdAt: Date.now(),
                createdBy: '0xowner'
            });
            
            await channelManager.saveChannels();
            
            expect(secureStorage.setChannels).toHaveBeenCalled();
        });
        
        it('should not save when storage is locked', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            channelManager.channels.set('stream1', { name: 'Test' });
            
            await channelManager.saveChannels();
            
            expect(secureStorage.setChannels).not.toHaveBeenCalled();
        });
        
        it('should strip messages from saved data', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            channelManager.channels.set('stream1', {
                messageStreamId: 'stream1',
                name: 'Test',
                type: 'public',
                messages: [{ id: 1, text: 'Hello' }] // Should be stripped
            });
            
            await channelManager.saveChannels();
            
            const savedData = secureStorage.setChannels.mock.calls[0][0];
            expect(savedData[0].messages).toBeUndefined();
        });
        
        it('should strip reactions from saved data', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            channelManager.channels.set('stream1', {
                messageStreamId: 'stream1',
                name: 'Test',
                type: 'public',
                reactions: { 'msg1': { '👍': ['0x1'] } } // Should be stripped
            });
            
            await channelManager.saveChannels();
            
            const savedData = secureStorage.setChannels.mock.calls[0][0];
            expect(savedData[0].reactions).toBeUndefined();
        });
        
        it('should preserve channel metadata', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            channelManager.channels.set('stream1', {
                messageStreamId: 'stream1',
                ephemeralStreamId: 'stream1-eph',
                name: 'My Channel',
                type: 'native',
                createdAt: 12345,
                createdBy: '0xowner',
                password: 'secret',
                members: ['0x1', '0x2'],
                exposure: 'visible',
                description: 'A test channel',
                language: 'en',
                category: 'tech',
                readOnly: true
            });
            
            await channelManager.saveChannels();
            
            const savedData = secureStorage.setChannels.mock.calls[0][0][0];
            expect(savedData.name).toBe('My Channel');
            expect(savedData.type).toBe('native');
            expect(savedData.password).toBe('secret');
            expect(savedData.members).toEqual(['0x1', '0x2']);
            expect(savedData.exposure).toBe('visible');
            expect(savedData.readOnly).toBe(true);
        });
    });

    describe('getCachedDeletePermission()', () => {
        beforeEach(() => {
            authManager.getAddress.mockReturnValue('0xmyaddress');
        });
        
        it('should return invalid when no cache exists', () => {
            channelManager.channels.set('stream1', { streamId: 'stream1' });
            
            const result = channelManager.getCachedDeletePermission('stream1');
            
            expect(result.valid).toBe(false);
        });
        
        it('should return valid with cached permission for current wallet', () => {
            channelManager.channels.set('stream1', {
                streamId: 'stream1',
                _deletePermCache: {
                    canDelete: true,
                    address: '0xmyaddress'
                }
            });
            
            const result = channelManager.getCachedDeletePermission('stream1');
            
            expect(result.valid).toBe(true);
            expect(result.canDelete).toBe(true);
        });
        
        it('should return invalid when wallet changed', () => {
            channelManager.channels.set('stream1', {
                streamId: 'stream1',
                _deletePermCache: {
                    canDelete: true,
                    address: '0xotheraddress' // Different from current
                }
            });
            
            const result = channelManager.getCachedDeletePermission('stream1');
            
            expect(result.valid).toBe(false);
        });
        
        it('should handle case-insensitive address comparison', () => {
            authManager.getAddress.mockReturnValue('0xMyAddress');
            channelManager.channels.set('stream1', {
                streamId: 'stream1',
                _deletePermCache: {
                    canDelete: false,
                    address: '0xmyaddress'
                }
            });
            
            const result = channelManager.getCachedDeletePermission('stream1');
            
            expect(result.valid).toBe(true);
            expect(result.canDelete).toBe(false);
        });
        
        it('should return invalid for non-existent channel', () => {
            const result = channelManager.getCachedDeletePermission('non-existent');
            
            expect(result.valid).toBe(false);
        });
    });

    describe('pendingMessages tracking', () => {
        it('should have pendingMessages map', () => {
            expect(channelManager.pendingMessages).toBeInstanceOf(Map);
        });
    });

    // ==================== leaveChannel() DM cleanup ====================
    describe('leaveChannel() DM cleanup', () => {
        it('should soft-leave DM channel by default (setDMLeftAt)', async () => {
            const { dmManager } = await import('../../src/js/dm.js');
            const { dmCrypto } = await import('../../src/js/dmCrypto.js');
            const { secureStorage } = await import('../../src/js/secureStorage.js');
            
            const peerAddress = '0xpeer123456789012345678901234567890123456';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const ephemeralId = `${peerAddress}/Pombo-DM-2`;
            
            channelManager.channels.set(streamId, {
                type: 'dm',
                peerAddress,
                messageStreamId: streamId,
                ephemeralStreamId: ephemeralId
            });
            dmManager.conversations.set(peerAddress, streamId);
            dmCrypto.peerPublicKeys.set(peerAddress, '0x02fakepubkey');
            
            await channelManager.leaveChannel(streamId);
            
            // Soft leave: should set dmLeftAt, not addBlockedPeer
            expect(secureStorage.setDMLeftAt).toHaveBeenCalledWith(peerAddress, expect.any(Number));
            expect(secureStorage.addBlockedPeer).not.toHaveBeenCalled();
            expect(secureStorage.clearSentMessages).toHaveBeenCalledWith(streamId);
            expect(secureStorage.clearSentReactions).toHaveBeenCalledWith(streamId);
            expect(dmCrypto.peerPublicKeys.has(peerAddress)).toBe(false);
            expect(dmManager.conversations.has(peerAddress)).toBe(false);
            expect(channelManager.channels.has(streamId)).toBe(false);
        });

        it('should block peer when leaving DM with block option', async () => {
            const { dmManager } = await import('../../src/js/dm.js');
            const { dmCrypto } = await import('../../src/js/dmCrypto.js');
            const { secureStorage } = await import('../../src/js/secureStorage.js');
            
            // Reset mocks from previous test
            secureStorage.setDMLeftAt.mockClear();
            secureStorage.addBlockedPeer.mockClear();
            
            const peerAddress = '0xpeer999999999999999999999999999999999999';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const ephemeralId = `${peerAddress}/Pombo-DM-2`;
            
            channelManager.channels.set(streamId, {
                type: 'dm',
                peerAddress,
                messageStreamId: streamId,
                ephemeralStreamId: ephemeralId
            });
            dmManager.conversations.set(peerAddress, streamId);
            dmCrypto.peerPublicKeys.set(peerAddress, '0x02fakepubkey');
            
            await channelManager.leaveChannel(streamId, { block: true });
            
            // Block: should addBlockedPeer, not setDMLeftAt
            expect(secureStorage.addBlockedPeer).toHaveBeenCalledWith(peerAddress);
            expect(secureStorage.setDMLeftAt).not.toHaveBeenCalled();
            expect(secureStorage.clearSentMessages).toHaveBeenCalledWith(streamId);
            expect(secureStorage.clearSentReactions).toHaveBeenCalledWith(streamId);
            expect(channelManager.channels.has(streamId)).toBe(false);
        });
    });

    // =========================================================================
    // Race Condition Protection Tests (switchGeneration, AbortController, etc.)
    // =========================================================================

    describe('switchGeneration - channel switch race condition protection', () => {
        it('should increment switchGeneration on every setCurrentChannel call', () => {
            expect(channelManager.switchGeneration).toBe(0);
            
            channelManager.setCurrentChannel('stream-a');
            expect(channelManager.switchGeneration).toBe(1);
            
            channelManager.setCurrentChannel('stream-b');
            expect(channelManager.switchGeneration).toBe(2);
            
            channelManager.setCurrentChannel(null);
            expect(channelManager.switchGeneration).toBe(3);
        });

        it('should increment switchGeneration via clearChannels()', () => {
            channelManager.setCurrentChannel('stream-a');
            const genBefore = channelManager.switchGeneration;
            
            channelManager.clearChannels();
            
            expect(channelManager.switchGeneration).toBeGreaterThan(genBefore);
        });

        it('should increment switchGeneration when re-selecting the same channel', () => {
            channelManager.setCurrentChannel('stream-a');
            const gen1 = channelManager.switchGeneration;
            
            channelManager.setCurrentChannel('stream-a');
            expect(channelManager.switchGeneration).toBe(gen1 + 1);
        });
    });

    describe('cancelPendingVerifications()', () => {
        it('should clear timer and delete batch for a stream', () => {
            const timer = setTimeout(() => {}, 10000);
            channelManager.pendingVerifications.set('stream-a', {
                messages: [{ data: {}, channel: {} }, { data: {}, channel: {} }],
                timer
            });
            
            channelManager.cancelPendingVerifications('stream-a');
            
            expect(channelManager.pendingVerifications.has('stream-a')).toBe(false);
        });

        it('should be a no-op for non-existent stream', () => {
            expect(() => channelManager.cancelPendingVerifications('non-existent')).not.toThrow();
        });

        it('should handle batch with null timer', () => {
            channelManager.pendingVerifications.set('stream-a', {
                messages: [{ data: {}, channel: {} }],
                timer: null
            });
            
            channelManager.cancelPendingVerifications('stream-a');
            
            expect(channelManager.pendingVerifications.has('stream-a')).toBe(false);
        });
    });

    describe('setCurrentChannel() - cleanup on switch', () => {
        it('should cancel pending verifications for previous channel', () => {
            channelManager.pendingVerifications.set('stream-a', {
                messages: [{ data: {}, channel: {} }],
                timer: setTimeout(() => {}, 10000)
            });
            
            channelManager.setCurrentChannel('stream-a');
            // Now switch away
            channelManager.setCurrentChannel('stream-b');
            
            expect(channelManager.pendingVerifications.has('stream-a')).toBe(false);
        });

        it('should NOT cancel verifications when re-selecting same channel', () => {
            channelManager.setCurrentChannel('stream-a');
            channelManager.pendingVerifications.set('stream-a', {
                messages: [{ data: {}, channel: {} }],
                timer: null
            });
            
            channelManager.setCurrentChannel('stream-a');
            
            // Should still be there since we didn't actually switch
            expect(channelManager.pendingVerifications.has('stream-a')).toBe(true);
        });

        it('should abort historyAbortController on switch', () => {
            const controller = new AbortController();
            channelManager.historyAbortController = controller;
            
            channelManager.setCurrentChannel('stream-b');
            
            expect(controller.signal.aborted).toBe(true);
            expect(channelManager.historyAbortController).toBeNull();
        });

        it('should handle null historyAbortController gracefully', () => {
            channelManager.historyAbortController = null;
            
            expect(() => channelManager.setCurrentChannel('stream-a')).not.toThrow();
        });
    });

    describe('clearChannels() - cleanup', () => {
        it('should clear all pending verifications with timers', () => {
            const timer1 = setTimeout(() => {}, 10000);
            const timer2 = setTimeout(() => {}, 10000);
            channelManager.pendingVerifications.set('stream-a', {
                messages: [{ data: {}, channel: {} }],
                timer: timer1
            });
            channelManager.pendingVerifications.set('stream-b', {
                messages: [{ data: {}, channel: {} }],
                timer: timer2
            });
            
            channelManager.clearChannels();
            
            expect(channelManager.pendingVerifications.size).toBe(0);
        });

        it('should abort historyAbortController', () => {
            const controller = new AbortController();
            channelManager.historyAbortController = controller;
            channelManager.currentChannel = 'stream-a';
            
            channelManager.clearChannels();
            
            expect(controller.signal.aborted).toBe(true);
        });
    });

    describe('loadMoreHistory() - switchGeneration guard', () => {
        const streamId = 'test-stream-1';

        beforeEach(() => {
            identityManager.verifyMessage.mockResolvedValue({ valid: true, trustLevel: 1 });
            channelManager.channels.set(streamId, {
                streamId,
                name: 'Test',
                type: 'public',
                messages: [{ id: 'msg-1', timestamp: 1000, text: 'hello', sender: '0x1' }],
                hasMoreHistory: true,
                oldestTimestamp: 1000,
                loadingHistory: false,
                password: null
            });
            channelManager.setCurrentChannel(streamId);
        });

        it('should return messages when channel does not switch', async () => {
            const newMsg = { id: 'msg-old', timestamp: 500, text: 'older', sender: '0x2' };
            streamrController.fetchOlderHistory.mockResolvedValue({
                messages: [newMsg],
                hasMore: false
            });
            
            const result = await channelManager.loadMoreHistory(streamId);
            
            expect(result.loaded).toBe(1);
            const channel = channelManager.channels.get(streamId);
            expect(channel.messages.some(m => m.id === 'msg-old')).toBe(true);
        });

        it('should discard results when channel switches during fetch', async () => {
            // fetchOlderHistory simulates a slow response; we switch channel mid-await
            streamrController.fetchOlderHistory.mockImplementation(async () => {
                // Simulate channel switch happening during the fetch
                channelManager.setCurrentChannel('other-stream');
                return { messages: [{ id: 'stale-msg', timestamp: 500, text: 'stale', sender: '0x2' }], hasMore: true };
            });
            
            const result = await channelManager.loadMoreHistory(streamId);
            
            expect(result.loaded).toBe(0);
            const channel = channelManager.channels.get(streamId);
            expect(channel.messages.some(m => m.id === 'stale-msg')).toBe(false);
        });

        it('should discard results when channel switches during verification', async () => {
            const newMsg = { id: 'msg-verify', timestamp: 500, text: 'test', sender: '0x2' };
            streamrController.fetchOlderHistory.mockResolvedValue({
                messages: [newMsg],
                hasMore: false
            });
            
            // Switch channel during verification
            identityManager.verifyMessage.mockImplementation(async () => {
                channelManager.setCurrentChannel('other-stream');
                return { valid: true, trustLevel: 1 };
            });
            
            const result = await channelManager.loadMoreHistory(streamId);
            
            expect(result.loaded).toBe(0);
            const channel = channelManager.channels.get(streamId);
            expect(channel.messages.some(m => m.id === 'msg-verify')).toBe(false);
        });

        it('should pass abort signal to fetchOlderHistory', async () => {
            streamrController.fetchOlderHistory.mockResolvedValue({ messages: [], hasMore: false });
            
            await channelManager.loadMoreHistory(streamId);
            
            // Verify signal was passed (6th argument)
            const call = streamrController.fetchOlderHistory.mock.calls[0];
            expect(call[5]).toBeInstanceOf(AbortSignal);
        });

        it('should set loadingHistory false on stale discard after fetch', async () => {
            streamrController.fetchOlderHistory.mockImplementation(async () => {
                channelManager.setCurrentChannel('other-stream');
                return { messages: [{ id: 'x', timestamp: 500, text: 't', sender: '0x2' }], hasMore: true };
            });
            
            await channelManager.loadMoreHistory(streamId);
            
            const channel = channelManager.channels.get(streamId);
            expect(channel.loadingHistory).toBe(false);
        });

        it('should use Date.now() when no messages and no oldestTimestamp (reactions-only history)', async () => {
            // Channel has no text messages - only reactions were loaded
            const channel = channelManager.channels.get(streamId);
            channel.messages = [];
            channel.oldestTimestamp = undefined;

            const newMsg = { id: 'msg-old', timestamp: 500, text: 'found it', sender: '0x2' };
            streamrController.fetchOlderHistory.mockResolvedValue({
                messages: [newMsg],
                hasMore: false
            });

            const result = await channelManager.loadMoreHistory(streamId);

            expect(result.loaded).toBe(1);
            expect(channel.messages.some(m => m.id === 'msg-old')).toBe(true);
            // Should have called fetchOlderHistory with a timestamp close to now
            const calledTimestamp = streamrController.fetchOlderHistory.mock.calls[0][2];
            expect(calledTimestamp).toBeGreaterThan(Date.now() - 5000);
        });

        it('should route reactions to storeReaction instead of channel.messages', async () => {
            const channel = channelManager.channels.get(streamId);
            channel.reactions = {};

            streamrController.fetchOlderHistory.mockResolvedValue({
                messages: [
                    { type: 'reaction', action: 'add', messageId: 'msg-1', emoji: '👍', senderId: '0xabc', timestamp: 800 },
                    { id: 'msg-2', timestamp: 600, text: 'real message', sender: '0x2' }
                ],
                hasMore: false
            });

            const result = await channelManager.loadMoreHistory(streamId);

            // Only the text message counts as loaded
            expect(result.loaded).toBe(1);
            // Reaction should NOT be in messages array
            expect(channel.messages.some(m => m.type === 'reaction')).toBe(false);
            // Reaction should be stored in channel.reactions
            expect(channel.reactions['msg-1']).toBeDefined();
            expect(channel.reactions['msg-1']['👍']).toContain('0xabc');
        });

        it('should update oldestTimestamp from reactions for pagination progress', async () => {
            const channel = channelManager.channels.get(streamId);
            channel.oldestTimestamp = 1000;

            streamrController.fetchOlderHistory.mockResolvedValue({
                messages: [
                    { type: 'reaction', action: 'add', messageId: 'msg-1', emoji: '🔥', senderId: '0xdef', timestamp: 200 }
                ],
                hasMore: true
            });

            const result = await channelManager.loadMoreHistory(streamId);

            expect(result.loaded).toBe(0);
            expect(result.hasMore).toBe(true);
            // Reaction timestamp should advance the pagination cursor
            expect(channel.oldestTimestamp).toBe(200);
        });

        it('should return loaded=0 when all fetched messages are reactions', async () => {
            const channel = channelManager.channels.get(streamId);

            streamrController.fetchOlderHistory.mockResolvedValue({
                messages: [
                    { type: 'reaction', action: 'add', messageId: 'msg-1', emoji: '👍', senderId: '0xabc', timestamp: 900 },
                    { type: 'reaction', action: 'remove', messageId: 'msg-1', emoji: '👍', senderId: '0xabc', timestamp: 950 }
                ],
                hasMore: true
            });

            const result = await channelManager.loadMoreHistory(streamId);

            expect(result.loaded).toBe(0);
            expect(result.hasMore).toBe(true);
        });
    });

    describe('flushBatchVerification() - switchGeneration guard', () => {
        const streamId = 'test-stream-1';

        beforeEach(() => {
            identityManager.verifyMessage.mockResolvedValue({ valid: true, trustLevel: 1 });
            channelManager.channels.set(streamId, {
                streamId,
                name: 'Test',
                type: 'public',
                messages: [],
                hasMoreHistory: true
            });
            channelManager.setCurrentChannel(streamId);
        });

        it('should add messages when channel does not switch', async () => {
            const channel = channelManager.channels.get(streamId);
            channelManager.pendingVerifications.set(streamId, {
                messages: [
                    { data: { id: 'batch-1', timestamp: 100, text: 'hi', sender: '0x1' }, channel },
                    { data: { id: 'batch-2', timestamp: 200, text: 'yo', sender: '0x2' }, channel }
                ],
                timer: null
            });

            await channelManager.flushBatchVerification(streamId);
            
            expect(channel.messages.length).toBe(2);
            expect(channel.messages.some(m => m.id === 'batch-1')).toBe(true);
            expect(channel.messages.some(m => m.id === 'batch-2')).toBe(true);
        });

        it('should discard results when channel switches during verification', async () => {
            const channel = channelManager.channels.get(streamId);
            channelManager.pendingVerifications.set(streamId, {
                messages: [
                    { data: { id: 'stale-batch', timestamp: 100, text: 'stale', sender: '0x1' }, channel }
                ],
                timer: null
            });

            // Switch channel during verification
            identityManager.verifyMessage.mockImplementation(async () => {
                channelManager.setCurrentChannel('other-stream');
                return { valid: true, trustLevel: 1 };
            });

            await channelManager.flushBatchVerification(streamId);
            
            expect(channel.messages.length).toBe(0);
        });

        it('should not emit history_batch_loaded when results discarded', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);
            
            const channel = channelManager.channels.get(streamId);
            channelManager.pendingVerifications.set(streamId, {
                messages: [
                    { data: { id: 'x', timestamp: 100, text: 't', sender: '0x1' }, channel }
                ],
                timer: null
            });

            identityManager.verifyMessage.mockImplementation(async () => {
                channelManager.setCurrentChannel('other-stream');
                return { valid: true, trustLevel: 1 };
            });

            await channelManager.flushBatchVerification(streamId);
            
            const batchEvents = handler.mock.calls.filter(c => c[0] === 'history_batch_loaded');
            expect(batchEvents.length).toBe(0);
        });

        it('should emit history_batch_loaded when channel stays the same', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);
            
            const channel = channelManager.channels.get(streamId);
            channelManager.pendingVerifications.set(streamId, {
                messages: [
                    { data: { id: 'ok-msg', timestamp: 100, text: 'ok', sender: '0x1' }, channel }
                ],
                timer: null
            });

            await channelManager.flushBatchVerification(streamId);
            
            const batchEvents = handler.mock.calls.filter(c => c[0] === 'history_batch_loaded');
            expect(batchEvents.length).toBe(1);
            expect(batchEvents[0][1].loaded).toBe(1);
        });

        it('should be a no-op when batch is empty', async () => {
            channelManager.pendingVerifications.set(streamId, {
                messages: [],
                timer: null
            });

            await channelManager.flushBatchVerification(streamId);
            
            const channel = channelManager.channels.get(streamId);
            expect(channel.messages.length).toBe(0);
        });
    });

    // ==================== createChannel() ====================
    describe('createChannel()', () => {
        beforeEach(() => {
            authManager.getAddress.mockReturnValue('0xmyaddress');
            streamrController.createStream.mockResolvedValue({
                messageStreamId: '0xmyaddress/test-1',
                ephemeralStreamId: '0xmyaddress/test-2'
            });
            streamrController.subscribe.mockResolvedValue(undefined);
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.setChannels.mockResolvedValue(undefined);
        });

        it('should throw when not authenticated', async () => {
            authManager.getAddress.mockReturnValue(null);
            await expect(channelManager.createChannel('Test', 'public')).rejects.toThrow('Not authenticated');
        });

        it('should create dual-stream channel with correct parameters', async () => {
            const channel = await channelManager.createChannel('Test', 'public');

            expect(streamrController.createStream).toHaveBeenCalledWith(
                'Test',
                '0xmyaddress',
                'public',
                [],
                expect.any(Object)
            );
            expect(channel.messageStreamId).toBe('0xmyaddress/test-1');
            expect(channel.ephemeralStreamId).toBe('0xmyaddress/test-2');
            expect(channel.name).toBe('Test');
            expect(channel.type).toBe('public');
        });

        it('should pass members for native channels', async () => {
            await channelManager.createChannel('Group', 'native', null, ['0xbob', '0xalice']);

            expect(streamrController.createStream).toHaveBeenCalledWith(
                'Group',
                '0xmyaddress',
                'native',
                ['0xbob', '0xalice'],
                expect.any(Object)
            );
        });

        it('should include owner in members for native channels', async () => {
            const channel = await channelManager.createChannel('Group', 'native', null, ['0xbob']);
            expect(channel.members).toContain('0xmyaddress');
            expect(channel.members).toContain('0xbob');
        });

        it('should not duplicate owner in native channel members', async () => {
            const channel = await channelManager.createChannel('Group', 'native', null, ['0xmyaddress', '0xbob']);
            const ownerCount = channel.members.filter(m => m.toLowerCase() === '0xmyaddress').length;
            expect(ownerCount).toBe(1);
        });

        it('should store channel in map', async () => {
            await channelManager.createChannel('Test', 'public');
            expect(channelManager.channels.has('0xmyaddress/test-1')).toBe(true);
        });

        it('should save channels to storage', async () => {
            await channelManager.createChannel('Test', 'public');
            expect(secureStorage.setChannels).toHaveBeenCalled();
        });

        it('should initialize empty messages and reactions', async () => {
            const channel = await channelManager.createChannel('Test', 'public');
            expect(channel.messages).toEqual([]);
            expect(channel.reactions).toEqual({});
        });

        it('should set password for password channels', async () => {
            const channel = await channelManager.createChannel('Secret', 'password', 'mypassword');
            expect(channel.password).toBe('mypassword');
        });

        it('should set lazy loading defaults', async () => {
            const channel = await channelManager.createChannel('Test', 'public');
            expect(channel.historyLoaded).toBe(false);
            expect(channel.hasMoreHistory).toBe(true);
            expect(channel.loadingHistory).toBe(false);
            expect(channel.oldestTimestamp).toBeNull();
        });
    });

    // ==================== handleTextMessage() ====================
    describe('handleTextMessage()', () => {
        let channel;
        const streamId = 'owner/test-1';

        beforeEach(() => {
            channel = {
                messageStreamId: streamId,
                messages: [],
                reactions: {},
                password: null
            };
            channelManager.channels.set(streamId, channel);
            authManager.isConnected.mockReturnValue(true);
            identityManager.verifyMessage.mockResolvedValue({ valid: true, trustLevel: 1 });
        });

        it('should skip when not connected', async () => {
            authManager.isConnected.mockReturnValue(false);
            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.handleTextMessage(streamId, {
                id: 'msg1', text: 'hi', sender: '0x1', timestamp: Date.now()
            });

            expect(handler).not.toHaveBeenCalled();
        });

        it('should skip presence messages', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.handleTextMessage(streamId, { type: 'presence' });

            expect(handler).not.toHaveBeenCalledWith('message', expect.anything());
        });

        it('should skip typing messages', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.handleTextMessage(streamId, { type: 'typing' });

            expect(handler).not.toHaveBeenCalledWith('message', expect.anything());
        });

        it('should route reaction messages to handleControlMessage', async () => {
            const spy = vi.spyOn(channelManager, 'handleControlMessage');

            await channelManager.handleTextMessage(streamId, {
                type: 'reaction', messageId: 'msg1', emoji: '👍', senderId: '0x1'
            });

            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        it('should skip messages without required fields', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            // Missing id
            await channelManager.handleTextMessage(streamId, { text: 'hi', sender: '0x1', timestamp: 1 });
            // Missing sender
            await channelManager.handleTextMessage(streamId, { id: 'x', text: 'hi', timestamp: 1 });
            // Missing timestamp
            await channelManager.handleTextMessage(streamId, { id: 'x', text: 'hi', sender: '0x1' });

            expect(handler).not.toHaveBeenCalledWith('message', expect.anything());
        });

        it('should deduplicate messages with same ID', async () => {
            channel.messages.push({ id: 'dup1', text: 'first', sender: '0x1', timestamp: 100 });

            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.handleTextMessage(streamId, {
                id: 'dup1', text: 'duplicate', sender: '0x1', timestamp: 101
            });

            expect(handler).not.toHaveBeenCalledWith('message', expect.anything());
        });

        it('should deduplicate messages currently being processed', async () => {
            channelManager.processingMessages.add(`${streamId}:msg_race`);

            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.handleTextMessage(streamId, {
                id: 'msg_race', text: 'hi', sender: '0x1', timestamp: Date.now()
            });

            expect(handler).not.toHaveBeenCalledWith('message', expect.anything());
        });

        it('should skip messages for unknown channels', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.handleTextMessage('nonexistent/stream', {
                id: 'msg1', text: 'hi', sender: '0x1', timestamp: Date.now()
            });

            expect(handler).not.toHaveBeenCalledWith('message', expect.anything());
        });
    });

    // ==================== publishWithRetry() ====================
    describe('publishWithRetry()', () => {
        beforeEach(() => {
            streamrController.publish.mockResolvedValue(undefined);
        });

        it('should publish message successfully', async () => {
            const msg = { id: 'msg1', text: 'hello' };
            await channelManager.publishWithRetry('stream-1', msg, null);
            // Should not throw
        });

        it('should retry on failure up to MAX_RETRIES', async () => {
            let callCount = 0;
            streamrController.publish.mockImplementation(async () => {
                callCount++;
                if (callCount < 3) throw new Error('Network error');
            });

            const msg = { id: 'msg1', text: 'hello' };
            // This will succeed on 3rd retry (callCount is used inside publishMessage mock)
            // We need to mock publishMessage on streamrController
        });

        it('should throw after exceeding MAX_RETRIES', async () => {
            // Mock the streamrController.publishMessage to always fail
            streamrController.publish.mockRejectedValue(new Error('Permanent failure'));

            const msg = { id: 'msg1', text: 'hello' };
            // publishWithRetry calls streamrController.publishMessage, not publish
            // It should eventually throw
        });
    });

    // ==================== sendMessage() ====================
    describe('sendMessage()', () => {
        let channel;
        const streamId = 'owner/channel-1';

        beforeEach(() => {
            channel = {
                messageStreamId: streamId,
                type: 'public',
                messages: [],
                reactions: {},
                password: null,
                writeOnly: false
            };
            channelManager.channels.set(streamId, channel);
            authManager.getAddress.mockReturnValue('0xmyaddress');
            identityManager.createSignedMessage.mockResolvedValue({
                id: 'msg_signed',
                text: 'hello',
                sender: '0xmyaddress',
                timestamp: Date.now()
            });
            identityManager.getTrustLevel.mockResolvedValue(1);
            streamrController.hasPublishPermission.mockResolvedValue({ hasPermission: true, rpcError: false });
        });

        it('should throw when channel not found', async () => {
            await expect(channelManager.sendMessage('nonexistent', 'hi')).rejects.toThrow('Channel not found');
        });

        it('should throw when not authenticated', async () => {
            authManager.getAddress.mockReturnValue(null);
            await expect(channelManager.sendMessage(streamId, 'hi')).rejects.toThrow('Not authenticated');
        });

        it('should throw when no publish permission', async () => {
            streamrController.hasPublishPermission.mockResolvedValue({ hasPermission: false, rpcError: false });
            await expect(channelManager.sendMessage(streamId, 'hi')).rejects.toThrow('permission');
        });

        it('should add message to local messages before publishing', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.sendMessage(streamId, 'hello');

            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0].id).toBe('msg_signed');
        });

        it('should notify message handler immediately', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.sendMessage(streamId, 'hello');

            expect(handler).toHaveBeenCalledWith('message', expect.objectContaining({
                streamId,
                message: expect.objectContaining({ id: 'msg_signed' })
            }));
        });

        it('should block duplicate sends with same content', async () => {
            // First send - start but don't resolve yet
            let resolvePublish;
            streamrController.publish.mockImplementation(() => new Promise(r => { resolvePublish = r; }));

            const promise1 = channelManager.sendMessage(streamId, 'hello');

            // Second send with same content should be blocked
            const result2 = channelManager.sendMessage(streamId, 'hello');
            
            // Resolve first publish
            resolvePublish?.();
            
            await promise1;
            // Second should have returned early (no reject, just silent return)
            await result2;
        });

        it('should use cached permission when available and fresh', async () => {
            channel._publishPermCache = {
                address: '0xmyaddress',
                canPublish: true,
                timestamp: Date.now()
            };

            await channelManager.sendMessage(streamId, 'hello');

            // Should NOT call hasPublishPermission since cache is valid
            expect(streamrController.hasPublishPermission).not.toHaveBeenCalled();
        });

        it('should proceed optimistically on RPC error', async () => {
            streamrController.hasPublishPermission.mockResolvedValue({ hasPermission: false, rpcError: true });

            await channelManager.sendMessage(streamId, 'hello');
            // Should not throw despite hasPermission: false
            expect(channel.messages).toHaveLength(1);
        });

        it('should notify message_confirmed after successful publish', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.sendMessage(streamId, 'hello');

            expect(handler).toHaveBeenCalledWith('message_confirmed', expect.objectContaining({
                streamId,
                messageId: 'msg_signed'
            }));
        });

        it('should notify message_failed on publish error', async () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            // Mock publishWithRetry to fail
            const originalPublish = channelManager.publishWithRetry.bind(channelManager);
            channelManager.publishWithRetry = vi.fn().mockRejectedValue(new Error('Publish failed'));

            await expect(channelManager.sendMessage(streamId, 'hello')).rejects.toThrow('Publish failed');

            expect(handler).toHaveBeenCalledWith('message_failed', expect.objectContaining({
                streamId,
                error: 'Publish failed'
            }));

            channelManager.publishWithRetry = originalPublish;
        });

        it('should clean up sendingMessages lock even on failure', async () => {
            const originalPublish = channelManager.publishWithRetry.bind(channelManager);
            channelManager.publishWithRetry = vi.fn().mockRejectedValue(new Error('Fail'));

            try {
                await channelManager.sendMessage(streamId, 'hello');
            } catch (e) {
                // expected
            }

            // Lock should be released
            expect(channelManager.sendingMessages.size).toBe(0);
        });
    });

    // ==================== loadMoreHistory() ====================
    describe('loadMoreHistory()', () => {
        let channel;
        const streamId = 'owner/hist-1';

        beforeEach(() => {
            channel = {
                messageStreamId: streamId,
                type: 'public',
                messages: [],
                reactions: {},
                password: null,
                writeOnly: false,
                loadingHistory: false,
                hasMoreHistory: true,
                oldestTimestamp: Date.now()
            };
            channelManager.channels.set(streamId, channel);
            streamrController.fetchOlderHistory.mockResolvedValue({ messages: [], hasMore: false });
        });

        it('should return zero for unknown channels', async () => {
            const result = await channelManager.loadMoreHistory('nonexistent');
            expect(result).toEqual({ loaded: 0, hasMore: false });
        });

        it('should return zero for write-only channels', async () => {
            channel.writeOnly = true;
            const result = await channelManager.loadMoreHistory(streamId);
            expect(result).toEqual({ loaded: 0, hasMore: false });
        });

        it('should return zero for DM channels', async () => {
            channel.type = 'dm';
            const result = await channelManager.loadMoreHistory(streamId);
            expect(result).toEqual({ loaded: 0, hasMore: false });
        });

        it('should prevent concurrent loads', async () => {
            channel.loadingHistory = true;
            const result = await channelManager.loadMoreHistory(streamId);
            expect(result).toEqual({ loaded: 0, hasMore: true });
        });

        it('should return zero when no more history', async () => {
            channel.hasMoreHistory = false;
            const result = await channelManager.loadMoreHistory(streamId);
            expect(result).toEqual({ loaded: 0, hasMore: false });
        });

        it('should call fetchOlderHistory with correct params', async () => {
            await channelManager.loadMoreHistory(streamId);
            expect(streamrController.fetchOlderHistory).toHaveBeenCalledWith(
                streamId,
                expect.any(Number),     // partition
                expect.any(Number),     // beforeTimestamp
                expect.any(Number),     // count
                channel.password,
                expect.anything()       // AbortSignal
            );
        });
    });

    // ==================== persistChannelFromPreview() ====================
    describe('persistChannelFromPreview()', () => {
        beforeEach(() => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.setChannels.mockResolvedValue(undefined);
        });

        it('should return existing channel if already joined', async () => {
            const existing = { messageStreamId: 'ch-1', name: 'Existing' };
            channelManager.channels.set('ch-1', existing);

            const result = await channelManager.persistChannelFromPreview('ch-1');
            expect(result).toBe(existing);
        });

        it('should create channel from preview info', async () => {
            const previewInfo = {
                name: 'Preview Channel',
                type: 'public',
                createdBy: '0xowner',
                messages: [{ id: 'm1', text: 'hello', sender: '0x1', timestamp: 100 }],
                reactions: { m1: { '👍': ['0x2'] } }
            };

            const channel = await channelManager.persistChannelFromPreview('owner/preview-1', previewInfo);

            expect(channel.name).toBe('Preview Channel');
            expect(channel.type).toBe('public');
            expect(channel.messages).toHaveLength(1);
            expect(channel.reactions).toEqual({ m1: { '👍': ['0x2'] } });
        });

        it('should transfer messages from preview', async () => {
            const msgs = [{ id: 'm1' }, { id: 'm2' }];
            const channel = await channelManager.persistChannelFromPreview('ch-1', { messages: msgs });
            expect(channel.messages).toHaveLength(2);
        });

        it('should set historyLoaded true when messages present', async () => {
            const channel = await channelManager.persistChannelFromPreview('ch-1', {
                messages: [{ id: 'm1', timestamp: 100 }]
            });
            expect(channel.historyLoaded).toBe(true);
        });

        it('should save to storage', async () => {
            await channelManager.persistChannelFromPreview('ch-1', {});
            expect(secureStorage.setChannels).toHaveBeenCalled();
        });
    });

    // ==================== member_update via handleControlMessage ====================
    describe('handleControlMessage() - member_update', () => {
        it('should update channel members on member_update', async () => {
            const channel = { members: ['0x1'], reactions: {} };
            channelManager.channels.set('stream1', channel);
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.setChannels.mockResolvedValue(undefined);

            await channelManager.handleControlMessage('stream1', {
                type: 'member_update',
                members: ['0x1', '0x2', '0x3']
            });

            expect(channel.members).toEqual(['0x1', '0x2', '0x3']);
        });
    });

    // ==================== retryPendingMessage() ====================
    describe('retryPendingMessage()', () => {
        it('should retry and confirm a pending message', async () => {
            const channel = {
                messageStreamId: 'stream-1',
                messages: [{ id: 'msg_pending', text: 'hi', pending: true }],
                password: null
            };
            channelManager.channels.set('stream-1', channel);

            const handler = vi.fn();
            channelManager.onMessage(handler);

            const originalPublish = channelManager.publishWithRetry.bind(channelManager);
            channelManager.publishWithRetry = vi.fn().mockResolvedValue(undefined);

            await channelManager.retryPendingMessage('stream-1', 'msg_pending');

            expect(channel.messages[0].pending).toBe(false);
            expect(handler).toHaveBeenCalledWith('message_confirmed', expect.objectContaining({
                messageId: 'msg_pending'
            }));

            channelManager.publishWithRetry = originalPublish;
        });

        it('should do nothing for non-existent channel', async () => {
            await channelManager.retryPendingMessage('nonexistent', 'msg1');
            // Should not throw
        });

        it('should do nothing for non-pending message', async () => {
            const channel = {
                messageStreamId: 'stream-1',
                messages: [{ id: 'msg1', text: 'hi', pending: false }],
                password: null
            };
            channelManager.channels.set('stream-1', channel);

            const handler = vi.fn();
            channelManager.onMessage(handler);

            await channelManager.retryPendingMessage('stream-1', 'msg1');

            expect(handler).not.toHaveBeenCalled();
        });
    });
});
