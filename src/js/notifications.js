/**
 * Notification System
 * Handles channel invites and notifications via DM inbox partition 3.
 * Uses the same E2E encryption (ECDH + AES-256-GCM) as DM messages.
 * Requires both sender and recipient to have a DM inbox created.
 */

import { streamrController, STREAM_CONFIG } from './streamr.js';
import { authManager } from './auth.js';
import { Logger } from './logger.js';
import { escapeHtml } from './ui/utils.js';
import { sanitizeText } from './ui/sanitizer.js';
import { CONFIG } from './config.js';
import { dmCrypto } from './dmCrypto.js';

class NotificationManager {
    constructor() {
        this.pendingInvites = new Map(); // inviteId -> invite data
        this.initialized = false;
        this.muted = false;
    }

    /**
     * Whether invite notifications are muted (silent).
     * Invites are still received and stored, but no toast/sound is shown.
     * @returns {boolean}
     */
    isMuted() {
        return this.muted;
    }

    /**
     * Set muted state and persist to localStorage.
     * @param {boolean} muted
     */
    setMuted(muted) {
        this.muted = !!muted;
        const address = authManager.getAddress()?.toLowerCase();
        if (address) {
            localStorage.setItem(`pombo_invites_muted_${address}`, this.muted ? '1' : '0');
        }
    }

    /**
     * Initialize notification system for current user.
     * Loads pending invites from localStorage.
     * Subscription to P3 is managed by DM Manager.
     */
    async init() {
        const address = authManager.getAddress();
        if (!address) {
            Logger.warn('Cannot init notifications: not authenticated');
            return;
        }

        this.loadPendingInvites();

        // Restore muted preference
        const addr = address.toLowerCase();
        this.muted = localStorage.getItem(`pombo_invites_muted_${addr}`) === '1';

        this.initialized = true;
        Logger.info('Notification system initialized');
    }

    /**
     * Send channel invite to a user via their DM inbox partition 3.
     * Requires recipient to have a DM inbox (same check as starting a DM).
     * @param {string} recipientAddress - Recipient's Ethereum address
     * @param {Object} channelInfo - Channel information
     * @returns {Promise<string>} - Invite ID
     */
    async sendChannelInvite(recipientAddress, channelInfo) {
        const senderAddress = authManager.getAddress();
        if (!senderAddress) {
            throw new Error('Not authenticated');
        }

        // 1. Check if recipient has DM inbox
        const peerInboxId = streamrController.getDMInboxId(recipientAddress);
        try {
            await streamrController.client.getStream(peerInboxId);
        } catch {
            throw new Error(
                'This user has not enabled DMs yet. ' +
                'They need to open Pombo and create their inbox first.'
            );
        }

        // 2. Get peer's public key for ECDH encryption
        const peerPubKey = await streamrController.getDMPublicKey(recipientAddress);
        if (!peerPubKey) {
            throw new Error('Cannot send invite: peer public key not available.');
        }

        // 3. Build invite message
        const inviteMessage = {
            type: 'CHANNEL_INVITE',
            inviteId: this.generateInviteId(),
            timestamp: Date.now(),
            from: senderAddress,
            channel: {
                streamId: channelInfo.streamId,
                name: channelInfo.name,
                type: channelInfo.type,
                password: channelInfo.password
            }
        };

        // 4. E2E encrypt with ECDH shared key (same as DMs)
        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) {
            throw new Error('Cannot send invite: wallet private key not available');
        }
        const aesKey = await dmCrypto.getSharedKey(privateKey, recipientAddress, peerPubKey);
        const encrypted = await dmCrypto.encrypt(inviteMessage, aesKey);

        // 5. Set Pombo key for publishing
        await streamrController.setDMPublishKey(peerInboxId);

        // 6. Publish to recipient's DM inbox partition 3 (notifications)
        await streamrController.publishNotification(peerInboxId, encrypted, null);

        Logger.info('Channel invite sent to:', recipientAddress);
        return inviteMessage.inviteId;
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
        // P3 is only subscribed when not muted, so receiving means invites are active
        this.pendingInvites.set(invite.inviteId, invite);
        this.savePendingInvites();
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

        const duration = CONFIG.notifications.inviteToastDurationMs;
        const toast = document.createElement('div');
        toast.className = 'toast invite';
        toast.dataset.inviteId = invite.inviteId;
        toast.style.setProperty('--toast-duration', `${duration}ms`);
        toast.innerHTML = `
            <svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            <div class="toast-content">
                <div class="text-[13px] font-medium text-white/90 mb-1">Channel Invite</div>
                <div class="text-[11px] text-white/50 mb-0.5">From: ${escapeHtml(this.formatAddress(invite.from))}</div>
                <div class="text-[12px] text-white/80 font-medium">${escapeHtml(sanitizeText(invite.channel.name))}</div>
                <div class="mt-2.5 flex gap-2">
                    <button class="accept-btn bg-white/90 hover:bg-white text-[#0a0a0a] px-3 py-1 rounded-md text-[11px] font-medium transition">
                        Accept
                    </button>
                    <button class="dismiss-btn bg-white/10 hover:bg-white/20 text-white/70 px-3 py-1 rounded-md text-[11px] font-medium transition">
                        Dismiss
                    </button>
                </div>
            </div>
            <span class="toast-close" title="Dismiss">
                <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </span>
            <div class="toast-progress"></div>
        `;

        // Add event listeners
        toast.querySelector('.accept-btn').addEventListener('click', () => {
            this.acceptInvite(invite.inviteId);
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 250);
        });
        
        toast.querySelector('.dismiss-btn').addEventListener('click', () => {
            this.dismissInvite(invite.inviteId);
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 250);
        });
        
        toast.querySelector('.toast-close')?.addEventListener('click', () => {
            this.dismissInvite(invite.inviteId);
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 250);
        });

        container.appendChild(toast);

        // Auto-dismiss after duration
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('toast-exit');
                setTimeout(() => toast.remove(), 250);
            }
        }, duration);

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
            // Lazy imports to avoid circular dependency (notifications ↔ channels ↔ dm, notifications ↔ ui)
            const { channelManager } = await import('./channels.js');

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
            const { uiController } = await import('./ui.js');
            uiController.showNotification(`Joined channel: ${invite.channel.name}!`, 'success');
        } catch (error) {
            Logger.error('Failed to accept invite:', error);
            try {
                const { uiController } = await import('./ui.js');
                uiController.showNotification('Failed to join channel: ' + error.message, 'error');
            } catch { /* ui not available */ }
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
            
            const key = `pombo_invites_${address.toLowerCase()}`;
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
            
            const key = `pombo_invites_${address.toLowerCase()}`;
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
