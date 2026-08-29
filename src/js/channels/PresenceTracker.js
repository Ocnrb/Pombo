/**
 * Online presence for channels: who is in a channel right now, the heartbeat
 * that announces us on the ephemeral stream, and the timeout that drops
 * whoever stopped announcing.
 */

import { Logger } from '../logger.js';
import { streamrController, STREAM_CONFIG, deriveEphemeralId } from '../streamr.js';
import { identityManager } from '../identity.js';
import { dmManager } from '../dm.js';
import { CONFIG } from '../config.js';

export class PresenceTracker {
    /**
     * Self-calls go through `manager` on purpose: while the manager is still
     * the entry point, anything that replaces one of its presence methods has
     * to keep intercepting the calls this class makes. `channels` and
     * `currentChannel` are live manager state and are never copied here.
     * @param {Object} manager - the channel manager
     */
    constructor(manager) {
        this.manager = manager;
        this.onlineUsers = new Map(); // streamId -> Map(userId -> {lastActive, nickname, address})
        this.presenceInterval = null;
        this.ONLINE_TIMEOUT = CONFIG.channels.onlineTimeoutMs;
        this.onlineUsersHandlers = [];
    }

    /**
     * Register handler for online users updates
     * @param {Function} handler - Callback function
     */
    onOnlineUsersChange(handler) {
        this.onlineUsersHandlers.push(handler);
    }

    /**
     * Notify online users handlers
     * @param {string} streamId - Stream ID
     */
    notifyOnlineUsersChange(streamId) {
        const users = this.manager.getOnlineUsers(streamId);
        this.onlineUsersHandlers.forEach(handler => {
            try {
                handler(streamId, users);
            } catch (e) {
                Logger.error('Online users handler error:', e);
            }
        });
    }

    /**
     * Get online users for a channel
     * @param {string} streamId - Stream ID
     * @returns {Array} - Array of online users
     */
    getOnlineUsers(streamId) {
        const users = this.onlineUsers.get(streamId);
        if (!users) return [];

        const now = Date.now();
        const onlineList = [];

        for (const [userId, data] of users.entries()) {
            if (now - data.lastActive < this.ONLINE_TIMEOUT) {
                onlineList.push({
                    id: userId,
                    nickname: data.nickname,
                    address: data.address,
                    lastActive: data.lastActive
                });
            }
        }

        return onlineList;
    }

    /**
     * Update user presence
     * @param {string} streamId - Stream ID
     * @param {Object} presenceData - Presence data
     */
    handlePresenceMessage(streamId, presenceData) {
        if (!this.onlineUsers.has(streamId)) {
            this.onlineUsers.set(streamId, new Map());
        }

        // Use account from Streamr SDK (cryptographically guaranteed) over self-reported userId
        const userId = presenceData.account || presenceData.userId;
        if (!userId) return;

        const users = this.onlineUsers.get(streamId);
        users.set(userId, {
            lastActive: presenceData.lastActive || Date.now(),
            nickname: presenceData.nickname || null,
            address: userId
        });

        this.manager.notifyOnlineUsersChange(streamId);
    }

    /**
     * Publish presence to channel's EPHEMERAL stream
     * Presence goes to ephemeralStreamId (not stored)
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async publishPresence(messageStreamId) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) return;

        // Use ephemeral stream for presence (not stored)
        const ephemeralStreamId = channel.ephemeralStreamId || deriveEphemeralId(messageStreamId);

        // DM channels: sealed sender, minimal payload (identity travels inside)
        if (channel.type === 'dm' && channel.peerAddress) {
            try {
                await dmManager.sealAndPublish(ephemeralStreamId, channel.peerAddress, {
                    type: 'presence',
                    nickname: identityManager.getUsername?.() || null,
                    lastActive: Date.now()
                }, STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL);
            } catch (e) {
                Logger.warn('Failed to publish DM presence:', e.message);
            }
            return;
        }

        // Non-DM channels: no self-reported userId/address (account from SDK provides identity)
        const myNickname = identityManager.getUsername?.() || null;

        const presenceData = {
            type: 'presence',
            nickname: myNickname,
            lastActive: Date.now()
        };

        try {
            // Publish to ephemeral stream (partition 0 = control)
            await streamrController.publishControl(ephemeralStreamId, presenceData, channel.password);
        } catch (e) {
            // Waiting for the epoch key is an expected state for a member who
            // just joined a gated channel (fail-closed publish, §7.9) — the
            // heartbeat retries every beat anyway, so keep that case quiet.
            if (e.message?.includes('No epoch key')) {
                Logger.debug('Presence skipped (waiting for epoch key):', channel.messageStreamId?.slice(-20));
            } else {
                Logger.warn('Failed to publish presence:', e.message);
            }
        }
    }

    /**
     * Start presence publishing for a channel
     * @param {string} streamId - Stream ID
     */
    startPresenceTracking(streamId) {
        // Publish presence immediately
        this.manager.publishPresence(streamId);

        // Then periodically
        if (this.presenceInterval) {
            clearInterval(this.presenceInterval);
        }

        this.presenceInterval = setInterval(() => {
            if (this.manager.currentChannel === streamId) {
                this.manager.publishPresence(streamId);

                // Clean up old users
                const users = this.onlineUsers.get(streamId);
                if (users) {
                    const now = Date.now();
                    for (const [userId, data] of users.entries()) {
                        if (now - data.lastActive > this.ONLINE_TIMEOUT) {
                            users.delete(userId);
                        }
                    }
                    this.manager.notifyOnlineUsersChange(streamId);
                }
            }
        }, 5000); // Every 5 seconds
    }

    /**
     * Stop presence tracking
     */
    stopPresenceTracking() {
        if (this.presenceInterval) {
            clearInterval(this.presenceInterval);
            this.presenceInterval = null;
        }
        // Tear down DM-2 ephemeral when leaving any channel
        dmManager.unsubscribeDMEphemeral();
    }
}
