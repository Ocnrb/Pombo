/**
 * Notification System
 * Handles channel invites and notifications via Streamr messages
 * NOTE: Creating a notification stream costs gas - user must opt-in
 */

import { streamrController } from './streamr.js';
import { authManager } from './auth.js';
import { channelManager } from './channels.js';
import { Logger } from './logger.js';

class NotificationManager {
    constructor() {
        this.notificationStream = null;
        this.pendingInvites = new Map(); // inviteId -> invite data
        this.initialized = false;
    }

    /**
     * Get localStorage key for notification preference (per wallet)
     * @returns {string}
     */
    getStorageKey() {
        const address = authManager.getAddress();
        if (!address) return 'moot_notifications_default';
        return `moot_notifications_${address.toLowerCase()}`;
    }

    /**
     * Get the notification stream ID for an address
     * Format: {address}/moot_notifications
     * @param {string} address - Ethereum address
     * @returns {string} - Stream ID
     */
    getStreamId(address) {
        return `${address.toLowerCase()}/moot_notifications`;
    }

    /**
     * Check if notifications are enabled for current wallet
     * @returns {boolean}
     */
    isEnabled() {
        try {
            const data = localStorage.getItem(this.getStorageKey());
            if (data) {
                const parsed = JSON.parse(data);
                return parsed.enabled === true;
            }
        } catch (e) {
            Logger.warn('Failed to check notification status:', e);
        }
        return false;
    }

    /**
     * Get notification settings
     * @returns {Object}
     */
    getSettings() {
        try {
            const data = localStorage.getItem(this.getStorageKey());
            if (data) {
                return JSON.parse(data);
            }
        } catch (e) {}
        return { enabled: false, streamId: null };
    }

    /**
     * Save notification settings
     * @param {Object} settings 
     */
    saveSettings(settings) {
        localStorage.setItem(this.getStorageKey(), JSON.stringify(settings));
    }

    /**
     * Enable notifications - creates the notification stream (costs gas!)
     * @returns {Promise<boolean>}
     */
    async enable() {
        const address = authManager.getAddress();
        if (!address) {
            throw new Error('Not authenticated');
        }

        const streamId = this.getStreamId(address);

        try {
            Logger.info('Creating notification stream (costs gas):', streamId);
            
            // Create a public stream for receiving notifications
            const stream = await streamrController.client.createStream({
                id: streamId,
                partitions: 1,
                description: 'Moot notification channel'
            });

            // Make it publicly writable (anyone can send invites)
            const StreamPermission = window.StreamPermission || {
                SUBSCRIBE: 'subscribe',
                PUBLISH: 'publish'
            };

            await stream.grantPermissions({
                public: true,
                permissions: [StreamPermission.PUBLISH]
            });

            Logger.info('Notification stream created:', streamId);

            // Save settings
            this.saveSettings({
                enabled: true,
                streamId: streamId,
                createdAt: Date.now()
            });

            // Now subscribe
            await this.subscribe();

            return true;
        } catch (error) {
            Logger.error('Failed to enable notifications:', error);
            throw error;
        }
    }

    /**
     * Disable notifications (doesn't delete the stream, just stops subscribing)
     */
    disable() {
        const settings = this.getSettings();
        settings.enabled = false;
        this.saveSettings(settings);
        
        if (this.notificationStream) {
            streamrController.unsubscribe(this.notificationStream).catch(e => Logger.warn('Unsubscribe error:', e));
            this.notificationStream = null;
        }
        
        this.initialized = false;
        Logger.info('Notifications disabled');
    }

    /**
     * Subscribe to notification stream
     */
    async subscribe() {
        const settings = this.getSettings();
        if (!settings.streamId) {
            throw new Error('No notification stream configured');
        }

        try {
            this.notificationStream = settings.streamId;

            await streamrController.subscribe(
                settings.streamId,
                {
                    onMessage: (data) => this.handleNotification(data)
                },
                null
            );

            Logger.info('Subscribed to notifications:', settings.streamId);
        } catch (error) {
            Logger.error('Failed to subscribe to notifications:', error);
            throw error;
        }
    }

    /**
     * Initialize notification system for current user
     * Only subscribes if already enabled (stream created previously)
     */
    async init() {
        const address = authManager.getAddress();
        if (!address) {
            Logger.warn('Cannot init notifications: not authenticated');
            return;
        }

        // Load pending invites from localStorage
        this.loadPendingInvites();

        // Only subscribe if enabled
        if (!this.isEnabled()) {
            Logger.info('Notifications not enabled for this wallet');
            return;
        }

        try {
            await this.subscribe();
            this.initialized = true;
            Logger.info('Notification system initialized');
        } catch (error) {
            Logger.warn('Failed to init notifications:', error);
        }
    }

    /**
     * Send channel invite to a user
     * @param {string} recipientAddress - Recipient's Ethereum address
     * @param {Object} channelInfo - Channel information
     */
    async sendChannelInvite(recipientAddress, channelInfo) {
        try {
            const senderAddress = authManager.getAddress();
            const inviteStreamId = this.getStreamId(recipientAddress);

            const inviteMessage = {
                type: 'CHANNEL_INVITE',
                inviteId: this.generateInviteId(),
                timestamp: Date.now(),
                from: senderAddress,
                to: recipientAddress,
                channel: {
                    streamId: channelInfo.streamId,
                    name: channelInfo.name,
                    type: channelInfo.type,
                    // Note: password should be encrypted in production
                    password: channelInfo.password
                }
            };

            // Publish to recipient's notification stream
            await streamrController.publish(
                inviteStreamId,
                0, // Partition 0
                inviteMessage,
                null
            );

            Logger.info('Channel invite sent to:', recipientAddress);
            return inviteMessage.inviteId;
        } catch (error) {
            Logger.error('Failed to send invite:', error);
            throw error;
        }
    }

    /**
     * Handle incoming notification
     * @param {Object} data - Notification data
     */
    handleNotification(data) {
        Logger.debug('Notification received:', data);

        if (data.type === 'CHANNEL_INVITE') {
            this.handleChannelInvite(data);
        }
    }

    /**
     * Handle channel invite notification
     * @param {Object} invite - Invite data
     */
    handleChannelInvite(invite) {
        // Add to pending invites
        this.pendingInvites.set(invite.inviteId, invite);
        this.savePendingInvites();

        // Show notification to user
        this.showInviteNotification(invite);
    }

    /**
     * Show invite notification in UI
     * @param {Object} invite - Invite data
     */
    showInviteNotification(invite) {
        // Use toast container
        const container = document.getElementById('toast-container');
        if (!container) {
            Logger.warn('Toast container not found');
            return;
        }

        const toast = document.createElement('div');
        toast.className = 'toast invite';
        toast.dataset.inviteId = invite.inviteId;
        toast.innerHTML = `
            <div class="flex-1">
                <div class="font-bold mb-1">📨 Channel Invite</div>
                <div class="text-xs opacity-90">From: ${this.formatAddress(invite.from)}</div>
                <div class="text-sm font-medium">${invite.channel.name}</div>
                <div class="mt-2 flex space-x-2">
                    <button class="accept-btn bg-white text-cyan-700 px-2 py-0.5 rounded text-xs font-medium hover:bg-gray-100">
                        Accept
                    </button>
                    <button class="dismiss-btn bg-transparent border border-white px-2 py-0.5 rounded text-xs hover:bg-cyan-700">
                        Dismiss
                    </button>
                </div>
            </div>
        `;

        // Add event listeners
        toast.querySelector('.accept-btn').addEventListener('click', () => {
            this.acceptInvite(invite.inviteId);
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        });
        
        toast.querySelector('.dismiss-btn').addEventListener('click', () => {
            this.dismissInvite(invite.inviteId);
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        });

        container.appendChild(toast);

        // Auto-dismiss after 15 seconds
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('toast-exit');
                setTimeout(() => toast.remove(), 300);
            }
        }, 15000);

        // Play notification sound
        this.playNotificationSound();
    }

    /**
     * Accept channel invite
     * @param {string} inviteId - Invite ID
     */
    async acceptInvite(inviteId) {
        const invite = this.pendingInvites.get(inviteId);
        if (!invite) {
            Logger.error('Invite not found:', inviteId);
            return;
        }

        try {
            // Join the channel
            await channelManager.joinChannel(
                invite.channel.streamId,
                invite.channel.password,
                {
                    name: invite.channel.name,
                    type: invite.channel.type
                }
            );

            // Remove from pending
            this.pendingInvites.delete(inviteId);
            this.savePendingInvites();

            Logger.info('Invite accepted:', inviteId);
            
            // Show toast
            if (window.uiController) {
                window.uiController.showNotification(`Joined channel: ${invite.channel.name}!`, 'success');
            }
        } catch (error) {
            Logger.error('Failed to accept invite:', error);
            if (window.uiController) {
                window.uiController.showNotification('Failed to join channel: ' + error.message, 'error');
            }
        }
    }

    /**
     * Dismiss invite
     * @param {string} inviteId - Invite ID
     */
    dismissInvite(inviteId) {
        this.pendingInvites.delete(inviteId);
        this.savePendingInvites();
        Logger.info('Invite dismissed:', inviteId);
    }

    /**
     * Get all pending invites
     * @returns {Array} - Array of pending invites
     */
    getPendingInvites() {
        return Array.from(this.pendingInvites.values());
    }

    /**
     * Load pending invites from localStorage
     */
    loadPendingInvites() {
        try {
            const address = authManager.getAddress();
            if (!address) return;
            
            const key = `moot_invites_${address.toLowerCase()}`;
            const saved = localStorage.getItem(key);
            if (saved) {
                const invites = JSON.parse(saved);
                for (const invite of invites) {
                    this.pendingInvites.set(invite.inviteId, invite);
                }
                Logger.info('Loaded pending invites:', invites.length);
            }
        } catch (error) {
            Logger.error('Failed to load pending invites:', error);
        }
    }

    /**
     * Save pending invites to localStorage
     */
    savePendingInvites() {
        try {
            const address = authManager.getAddress();
            if (!address) return;
            
            const key = `moot_invites_${address.toLowerCase()}`;
            const invites = Array.from(this.pendingInvites.values());
            localStorage.setItem(key, JSON.stringify(invites));
        } catch (error) {
            Logger.error('Failed to save pending invites:', error);
        }
    }

    /**
     * Generate unique invite ID
     * @returns {string} - Invite ID
     */
    generateInviteId() {
        return `invite_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Format Ethereum address
     * @param {string} address - Full address
     * @returns {string} - Shortened address
     */
    formatAddress(address) {
        if (!address) return 'Unknown';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Play notification sound
     */
    playNotificationSound() {
        try {
            // Simple beep using Web Audio API
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.frequency.value = 800;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.1;

            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.1);
        } catch (error) {
            Logger.warn('Failed to play notification sound:', error);
        }
    }
}

// Export singleton instance
export const notificationManager = new NotificationManager();
