/**
 * Subscription Manager
 * Handles dynamic subscription lifecycle for performance optimization
 * 
 * DUAL-STREAM ARCHITECTURE:
 * - Active channel: Full subscription to BOTH streams (message + ephemeral)
 * - Background channels: Lightweight polling for activity detection (message stream only)
 * - Lazy partition loading: Media partition only subscribed when needed
 * 
 * This reduces WebSocket connections and network traffic significantly
 * when users have many channels but only actively use one at a time.
 */

import { streamrController, STREAM_CONFIG, deriveEphemeralId } from './streamr.js';
import { channelManager } from './channels.js';
import { secureStorage } from './secureStorage.js';
import { Logger } from './logger.js';

class SubscriptionManager {
    constructor() {
        // Active channel state (keyed by messageStreamId)
        this.activeChannelId = null;  // messageStreamId of active channel
        this.activeSubscriptionHandlers = null;
        
        // Background activity tracking (keyed by messageStreamId)
        this.backgroundPoller = null;
        this.channelActivity = new Map(); // messageStreamId -> { lastMessageTime, unreadCount, lastChecked }
        
        // Activity change handlers
        this.activityHandlers = [];
        
        // Configuration
        this.config = {
            POLL_INTERVAL: 30000,           // 30 seconds between background polls
            POLL_BATCH_SIZE: 3,             // Check N channels per poll cycle
            POLL_STAGGER_DELAY: 2000,       // Delay between channel checks in batch
            MIN_POLL_INTERVAL: 10000,       // Minimum time between checks for same channel
            MAX_CONCURRENT_SUBS: 1,         // Only 1 full subscription at a time (active channel)
            ACTIVITY_CHECK_MESSAGES: 3,     // Number of messages to fetch for activity check
        };
        
        // Polling state
        this.pollIndex = 0;
        this.isPolling = false;
    }

    /**
     * Set the active channel - full subscription with all partitions and history
     * Downgrades previous active channel to background mode
     * In dual-stream architecture, subscribes to BOTH message and ephemeral streams
     * @param {string} messageStreamId - Message Stream ID to activate (channel key)
     * @param {string} password - Optional password for encrypted channels
     * @param {Object} handlers - Message handlers { onControl, onMessage, onMedia }
     */
    async setActiveChannel(messageStreamId, password = null, handlers = null) {
        if (!messageStreamId) {
            Logger.warn('setActiveChannel called with null streamId');
            return;
        }

        // If same channel, just ensure subscription is active
        if (this.activeChannelId === messageStreamId) {
            Logger.debug('Channel already active:', messageStreamId);
            return;
        }

        Logger.info('Setting active channel:', messageStreamId);

        // Downgrade previous active channel (unsubscribe BOTH streams to save resources)
        if (this.activeChannelId) {
            await this.downgradeToBackground(this.activeChannelId);
        }

        this.activeChannelId = messageStreamId;
        this.activeSubscriptionHandlers = handlers;

        // Full subscription with history for active channel (BOTH streams)
        try {
            await channelManager.subscribeToChannel(messageStreamId, password);
            Logger.info('Active channel subscription complete:', messageStreamId);
        } catch (error) {
            Logger.error('Failed to subscribe to active channel:', error);
            throw error;
        }
    }

    /**
     * Downgrade channel to background mode (unsubscribe BOTH streams to free resources)
     * @param {string} messageStreamId - Message Stream ID to downgrade
     */
    async downgradeToBackground(messageStreamId) {
        if (!messageStreamId) return;

        try {
            // Store current activity state before unsubscribing
            const channel = channelManager.getChannel(messageStreamId);
            if (channel && channel.messages?.length > 0) {
                const latestMsg = channel.messages[channel.messages.length - 1];
                this.channelActivity.set(messageStreamId, {
                    lastMessageTime: latestMsg.timestamp || Date.now(),
                    unreadCount: 0,
                    lastChecked: Date.now()
                });
            }

            // Get ephemeral stream ID
            const ephemeralStreamId = channel?.ephemeralStreamId || deriveEphemeralId(messageStreamId);

            // Unsubscribe from BOTH streams
            await streamrController.unsubscribeFromDualStream(messageStreamId, ephemeralStreamId);
            Logger.debug('Downgraded to background:', messageStreamId);
        } catch (error) {
            Logger.warn('Failed to downgrade channel:', messageStreamId, error.message);
        }
    }

    /**
     * Clear active channel (when deselecting/closing)
     */
    async clearActiveChannel() {
        if (this.activeChannelId) {
            await this.downgradeToBackground(this.activeChannelId);
            this.activeChannelId = null;
            this.activeSubscriptionHandlers = null;
        }
    }

    /**
     * Start background activity polling for all channels
     * Polls channels in batches to detect new messages without full subscriptions
     */
    startBackgroundPoller() {
        if (this.backgroundPoller) {
            Logger.debug('Background poller already running');
            return;
        }

        Logger.info('Starting background activity poller');
        
        // Initialize activity state for all channels
        this.initializeActivityState();

        // Start polling
        this.backgroundPoller = setInterval(async () => {
            await this.pollBackgroundChannels();
        }, this.config.POLL_INTERVAL);

        // Run first poll immediately (after short delay)
        setTimeout(() => this.pollBackgroundChannels(), 5000);
    }

    /**
     * Initialize activity tracking state from stored data
     * Uses messageStreamId as key (dual-stream architecture)
     */
    initializeActivityState() {
        const channels = channelManager.getAllChannels();
        const lastAccessMap = secureStorage.getAllChannelLastAccess();

        for (const channel of channels) {
            // Use messageStreamId as key (dual-stream)
            const messageStreamId = channel.messageStreamId || channel.streamId;
            
            if (!this.channelActivity.has(messageStreamId)) {
                // Initialize with last known access time
                const lastAccess = lastAccessMap[messageStreamId] || lastAccessMap[channel.streamId] || 0;
                this.channelActivity.set(messageStreamId, {
                    lastMessageTime: lastAccess,
                    unreadCount: 0,
                    lastChecked: 0
                });
            }
        }
    }

    /**
     * Poll background channels for new activity
     * Uses lightweight history fetch to check for new messages
     */
    async pollBackgroundChannels() {
        if (this.isPolling) {
            Logger.debug('Poll already in progress, skipping');
            return;
        }

        this.isPolling = true;

        try {
            const channels = channelManager.getAllChannels();
            const backgroundChannels = channels.filter(c => c.streamId !== this.activeChannelId);

            if (backgroundChannels.length === 0) {
                Logger.debug('No background channels to poll');
                return;
            }

            // Get batch of channels to poll this cycle (round-robin)
            const batchSize = Math.min(this.config.POLL_BATCH_SIZE, backgroundChannels.length);
            const channelsToPoll = [];

            for (let i = 0; i < batchSize; i++) {
                const idx = (this.pollIndex + i) % backgroundChannels.length;
                channelsToPoll.push(backgroundChannels[idx]);
            }

            this.pollIndex = (this.pollIndex + batchSize) % backgroundChannels.length;

            // Poll each channel in batch with stagger delay
            for (let i = 0; i < channelsToPoll.length; i++) {
                const channel = channelsToPoll[i];
                
                // Use messageStreamId as key (dual-stream architecture)
                const messageStreamId = channel.messageStreamId || channel.streamId;
                
                // Check if enough time has passed since last check
                const activity = this.channelActivity.get(messageStreamId);
                const timeSinceLastCheck = Date.now() - (activity?.lastChecked || 0);
                
                if (timeSinceLastCheck < this.config.MIN_POLL_INTERVAL) {
                    continue;
                }

                try {
                    await this.checkChannelActivity(channel);
                } catch (error) {
                    Logger.debug('Activity check failed for:', messageStreamId, error.message);
                }

                // Stagger delay between checks
                if (i < channelsToPoll.length - 1) {
                    await new Promise(r => setTimeout(r, this.config.POLL_STAGGER_DELAY));
                }
            }
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * Check activity for a single channel without full subscription
     * In dual-stream architecture, only queries MESSAGE stream (the one with storage)
     * @param {Object} channel - Channel object
     */
    async checkChannelActivity(channel) {
        // Use messageStreamId as the identifier (dual-stream)
        const messageStreamId = channel.messageStreamId || channel.streamId;
        const password = channel.password || null;

        // Get current activity state
        const currentActivity = this.channelActivity.get(messageStreamId) || {
            lastMessageTime: 0,
            unreadCount: 0,
            lastChecked: 0
        };

        try {
            // Fetch recent messages from MESSAGE stream (lightweight - no subscription needed)
            // Note: Only messageStream has storage, so we can only query it
            const result = await streamrController.fetchOlderHistory(
                messageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, // partition 0
                Date.now(),
                this.config.ACTIVITY_CHECK_MESSAGES,
                password
            );

            const messages = result.messages || [];
            
            // Count new messages since last check
            let newCount = 0;
            let latestTime = currentActivity.lastMessageTime;

            for (const msg of messages) {
                if (msg.timestamp > currentActivity.lastMessageTime) {
                    newCount++;
                    if (msg.timestamp > latestTime) {
                        latestTime = msg.timestamp;
                    }
                }
            }

            // Update activity state
            const newActivity = {
                lastMessageTime: latestTime,
                unreadCount: currentActivity.unreadCount + newCount,
                lastChecked: Date.now()
            };
            this.channelActivity.set(messageStreamId, newActivity);

            // Notify handlers if new messages detected
            if (newCount > 0) {
                Logger.debug('New activity detected:', messageStreamId, newCount, 'messages');
                this.notifyActivityHandlers(messageStreamId, newActivity);
            }

        } catch (error) {
            // Update lastChecked even on error to prevent rapid retries
            currentActivity.lastChecked = Date.now();
            this.channelActivity.set(messageStreamId, currentActivity);
            throw error;
        }
    }

    /**
     * Register handler for activity changes
     * @param {Function} handler - Callback (streamId, activity) => void
     */
    onActivity(handler) {
        if (typeof handler === 'function') {
            this.activityHandlers.push(handler);
        }
    }

    /**
     * Remove activity handler
     * @param {Function} handler - Handler to remove
     */
    offActivity(handler) {
        this.activityHandlers = this.activityHandlers.filter(h => h !== handler);
    }

    /**
     * Notify all activity handlers
     * @param {string} streamId - Channel stream ID
     * @param {Object} activity - Activity data
     */
    notifyActivityHandlers(streamId, activity) {
        for (const handler of this.activityHandlers) {
            try {
                handler(streamId, activity);
            } catch (error) {
                Logger.warn('Activity handler error:', error);
            }
        }
    }

    /**
     * Get activity state for a channel
     * @param {string} streamId - Stream ID
     * @returns {Object|null} - Activity data or null
     */
    getChannelActivity(streamId) {
        return this.channelActivity.get(streamId) || null;
    }

    /**
     * Get unread count for a channel
     * @param {string} streamId - Stream ID
     * @returns {number} - Unread message count
     */
    getUnreadCount(streamId) {
        const activity = this.channelActivity.get(streamId);
        return activity?.unreadCount || 0;
    }

    /**
     * Clear unread count for a channel (when user opens it)
     * @param {string} streamId - Stream ID
     */
    clearUnreadCount(streamId) {
        const activity = this.channelActivity.get(streamId);
        if (activity) {
            activity.unreadCount = 0;
            this.channelActivity.set(streamId, activity);
        }
    }

    /**
     * Remove a channel from tracking (when leaving or deleting)
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async removeChannel(messageStreamId) {
        Logger.debug('Removing channel from subscription manager:', messageStreamId);
        
        // Clear from activity tracking (keyed by messageStreamId)
        this.channelActivity.delete(messageStreamId);
        
        // If this was the active channel, clear it
        if (this.activeChannelId === messageStreamId) {
            this.activeChannelId = null;
            this.activeSubscriptionHandlers = null;
        }
        
        // Clear lastOpenedChannel if it points to this channel
        const lastOpened = secureStorage.getLastOpenedChannel();
        if (lastOpened === messageStreamId) {
            await secureStorage.setLastOpenedChannel(null);
        }
    }

    /**
     * Stop background polling
     */
    stopBackgroundPoller() {
        if (this.backgroundPoller) {
            clearInterval(this.backgroundPoller);
            this.backgroundPoller = null;
            Logger.debug('Background poller stopped');
        }
    }

    /**
     * Full cleanup - stop polling and clear all state
     */
    async cleanup() {
        Logger.info('Subscription manager cleanup');
        
        // Stop background polling
        this.stopBackgroundPoller();
        
        // Clear active channel
        this.activeChannelId = null;
        this.activeSubscriptionHandlers = null;
        
        // Clear activity state
        this.channelActivity.clear();
        this.pollIndex = 0;
        this.isPolling = false;
        
        // Clear handlers
        this.activityHandlers = [];
    }

    /**
     * Check if a channel is currently the active channel
     * @param {string} streamId - Stream ID to check (messageStreamId)
     * @returns {boolean}
     */
    isActiveChannel(streamId) {
        return this.activeChannelId === streamId;
    }

    /**
     * Get the active channel ID (messageStreamId)
     * @returns {string|null}
     */
    getActiveChannelId() {
        return this.activeChannelId;
    }

    /**
     * Force poll a specific channel immediately
     * Useful when user hovers over channel in sidebar
     * @param {string} messageStreamId - Message Stream ID to poll
     */
    async forcePollChannel(messageStreamId) {
        const channel = channelManager.getChannel(messageStreamId);
        if (!channel || messageStreamId === this.activeChannelId) {
            return;
        }

        try {
            await this.checkChannelActivity(channel);
        } catch (error) {
            Logger.debug('Force poll failed:', messageStreamId, error.message);
        }
    }

    /**
     * Update configuration
     * @param {Object} newConfig - New configuration values
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        Logger.debug('Subscription manager config updated:', this.config);
    }
}

// Export singleton instance
export const subscriptionManager = new SubscriptionManager();
