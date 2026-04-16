/**
 * Main Application Entry Point
 * Thin orchestrator â€” delegates wallet flows, invite handling, and messaging
 * to dedicated modules. Owns only lifecycle (init/teardown) and cross-module wiring.
 */

import { authManager } from './auth.js';
import { streamrController } from './streamr.js';
import { channelManager } from './channels.js';
import { uiController } from './ui.js';
import { notificationManager } from './notifications.js';
import { identityManager } from './identity.js';
import { secureStorage } from './secureStorage.js';
import { mediaController } from './media.js';
import { subscriptionManager } from './subscriptionManager.js';
import { relayManager } from './relayManager.js';
import { dmManager } from './dm.js';
import { syncManager } from './syncManager.js';
import { Logger } from './logger.js';
import { headerUI } from './ui/HeaderUI.js';
import { settingsUI } from './ui/SettingsUI.js';
import { contactsUI } from './ui/ContactsUI.js';
import { chatAreaUI } from './ui/ChatAreaUI.js';
import { reactionManager } from './ui/ReactionManager.js';
import { mediaHandler } from './ui/MediaHandler.js';
import { walletFlows } from './walletFlows.js';
import { inviteHandler } from './inviteHandler.js';
import { channelModalsUI } from './ui/ChannelModalsUI.js';

class App {
    constructor() {
        this.initialized = false;
    }

    /**
     * Initialize the application
     */
    async init() {
        Logger.info('Pombo - Initializing...');

        try {
            // Initialize media controller
            await mediaController.init();
            
            // Initialize UI
            uiController.init();
            
            // Wire cross-module callbacks (avoids circular dependencies and window globals)
            channelManager.onChannelsSaved = () => syncManager.scheduleAutoPush();
            settingsUI.setDependencies({ connectWallet: () => walletFlows.connectWallet() });

            // Wire wallet flows with app-level callbacks
            walletFlows.init({
                disconnectWallet: (opts) => this.disconnectWallet(opts),
                onWalletConnected: (addr, signer) => this.onWalletConnected(addr, signer),
                fallbackToGuest: (msg) => this.fallbackToGuest(msg)
            });

            // Set up message handlers
            this.setupMessageHandlers();

            // Set up wallet connection handlers
            this.setupWalletHandlers();

            // Initialize mobile pill nav
            headerUI.initPillNav({
                onConnect: () => walletFlows.connectWallet(),
                onDisconnect: () => this.disconnectWallet(),
                onSwitchWallet: () => walletFlows.switchWallet(),
                onChatsTab: () => {
                    settingsUI.hide({ skipHistory: true });
                    contactsUI.hide({ skipHistory: true });
                    uiController.closeChatView();
                    // Clean orphaned modal history entry
                    if (window.history.state?.modal) {
                        window.history.replaceState(null, '');
                    }
                },
                onExploreTab: () => {
                    settingsUI.hide({ skipHistory: true });
                    contactsUI.hide({ skipHistory: true });
                    uiController.openExploreView();
                },
                onJoinWithId: () => {
                    uiController.showQuickJoinModal();
                },
                onCreateChannel: () => {
                    channelModalsUI.show();
                }
            });

            // Check for invite link in URL
            inviteHandler.checkInviteLink();

            headerUI.updateNetworkStatus('Ready to connect', false);

            this.initialized = true;
            Logger.info('Pombo - Ready!');
            
            // Auto-connect: if saved wallets exist show unlock, otherwise connect as Guest
            if (authManager.hasSavedWallet()) {
                setTimeout(() => walletFlows.connectWallet(), 300);
            } else {
                setTimeout(() => this.connectAsGuest(), 300);
            }
        } catch (error) {
            Logger.error('Initialization failed:', error);
            uiController.showNotification('Failed to initialize app: ' + error.message, 'error');
        }
    }

    /**
     * Set up wallet connection handlers
     */
    setupWalletHandlers() {
        const connectBtn = document.getElementById('connect-wallet');
        const disconnectBtn = document.getElementById('disconnect-wallet');
        const switchBtn = document.getElementById('switch-wallet');
        const desktopJoinIdBtn = document.getElementById('desktop-join-id-btn');
        const syncBtn = document.getElementById('sync-devices-btn');
        const pillSyncBtn = document.getElementById('pill-sync-devices-btn');

        connectBtn.addEventListener('click', () => walletFlows.connectWallet());

        disconnectBtn?.addEventListener('click', async () => {
            headerUI._closeDesktopDropdown();
            await this.disconnectWallet();
        });

        switchBtn?.addEventListener('click', async () => {
            headerUI._closeDesktopDropdown();
            await walletFlows.switchWallet();
        });

        desktopJoinIdBtn?.addEventListener('click', () => {
            headerUI._closeDesktopDropdown();
            uiController.showQuickJoinModal();
        });

        // Sync buttons (desktop + mobile)
        const handleSync = async (btn) => {
            if (authManager.isGuestMode()) {
                uiController.showNotification('Sync not available in guest mode', 'warning');
                return;
            }

            const textEl = btn.querySelector('.sync-btn-text');
            const iconEl = btn.querySelector('.sync-icon');
            const originalText = textEl?.textContent;

            try {
                btn.disabled = true;
                if (textEl) textEl.textContent = 'Syncing...';
                if (iconEl) iconEl.classList.add('animate-spin');

                const result = await syncManager.smartSync();

                if (result.noInbox) {
                    uiController.showNotification('Create DM inbox first to enable sync', 'warning');
                } else if (result.pulled && result.pushed) {
                    uiController.renderChannelList();
                    uiController.showNotification('Devices synced successfully', 'success');
                } else if (result.pushed) {
                    uiController.showNotification('Your data has been saved', 'success');
                } else {
                    uiController.showNotification('Already in sync', 'info');
                }
            } catch (err) {
                Logger.error('Sync failed:', err);
                uiController.showNotification('Sync failed: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                if (textEl) textEl.textContent = originalText;
                if (iconEl) iconEl.classList.remove('animate-spin');
            }
        };

        syncBtn?.addEventListener('click', async () => {
            headerUI._closeDesktopDropdown();
            await handleSync(syncBtn);
        });

        pillSyncBtn?.addEventListener('click', async () => {
            await handleSync(pillSyncBtn);
        });

        // Auto-push on page unload
        window.addEventListener('beforeunload', () => {
            syncManager.forcePushNow();
        });

        // Auto-push when app goes to background (mobile reliability)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                syncManager.scheduleAutoPush(5000);
            }
        });
    }

    /**
     * Disconnect wallet - COMPLETE CLEANUP
     * @param {Object} options - Options
     * @param {boolean} options.skipFallback - If true, don't fallback to guest (used during account switch)
     */
    async disconnectWallet(options = {}) {
        const { skipFallback = false } = options;
        const wasGuest = authManager.isGuestMode();
        
        try {
            channelManager.stopPresenceTracking();
            await subscriptionManager.cleanup();
            await channelManager.leaveAllChannels();
            await dmManager.destroy();
            await streamrController.disconnect();
            mediaController.reset();
            secureStorage.lock();
            authManager.disconnect();
            
            headerUI.updateWalletInfo(null);
            headerUI.updateNetworkStatus('Disconnected', false);
            uiController.renderChannelList();
            uiController.resetToDisconnectedState();
            
            if (wasGuest) {
                uiController.showNotification('Guest session ended - all data has been cleared', 'info');
            } else if (!skipFallback) {
                await this.fallbackToGuest('Account disconnected - continuing as Guest');
            }
            
            Logger.info('Account disconnected - full cleanup complete');
        } catch (error) {
            Logger.error('Error disconnecting:', error);
            headerUI.updateWalletInfo(null);
            headerUI.updateNetworkStatus('Disconnected', false);
            uiController.resetToDisconnectedState();
            uiController.showNotification('Error disconnecting: ' + error.message, 'error');
        }
    }

    /**
     * Connect as Guest with ephemeral wallet
     */
    async connectAsGuest() {
        try {
            headerUI.updateNetworkStatus('Connecting as Guest...', false);
            const { address, signer } = authManager.connectAsGuest();
            Logger.info('Guest account created:', address);
            await this.onWalletConnected(address, signer);
            Logger.info('Connected as Guest - ready to explore!');
        } catch (error) {
            Logger.error('Failed to connect as Guest:', error);
            headerUI.updateNetworkStatus('Failed to connect', false);
            uiController.showNotification('Failed to connect: ' + error.message, 'error');
        }
    }

    /**
     * Fallback to Guest mode when no account is connected
     */
    async fallbackToGuest(message = 'Continuing as Guest') {
        await this.connectAsGuest();
        uiController.showNotification(message, 'info');
    }

    /**
     * Handle wallet connected event â€” initializes all subsystems for the active wallet.
     * @param {string} address - Wallet address
     * @param {Object} signer - Ethers signer
     */
    async onWalletConnected(address, signer) {
        try {
            const isGuest = authManager.isGuestMode();
            
            headerUI.updateWalletInfo(address, isGuest);
            headerUI.updateNetworkStatus('Connecting to Streamr...', false);

            const savedWallets = authManager.listSavedWallets();
            headerUI.updateSwitchWalletButton(savedWallets.length > 1);

            if (isGuest) {
                secureStorage.initAsGuest(address);
            } else {
                await secureStorage.init(signer, address);
            }

            channelManager.clearChannels();
            channelManager.loadChannels();
            Logger.info('Loaded channels for wallet:', address);

            await streamrController.init(signer);

            const deepLinkStreamId = this._getDeepLinkStreamId();
            streamrController.warmupNetwork(deepLinkStreamId);

            await mediaController.setOwner(address);

            const streamrAddress = await streamrController.getAddress();
            Logger.info('Streamr connected with address:', streamrAddress);
            headerUI.updateNetworkStatus('Connected to Streamr', true);

            try {
                await identityManager.init();
                Logger.info('Identity manager initialized');
                const username = identityManager.getUsername();
                if (username) {
                    headerUI.updateDisplayName(username);
                }
                // Always resolve own ENS — overrides local username if available
                identityManager.resolveENS(address).then(ensName => {
                    if (ensName) {
                        headerUI.updateDisplayName(ensName);
                        // ENS takes priority — clear local username so sync propagates deletion
                        if (identityManager.getUsername()) {
                            identityManager.setUsername(null);
                            Logger.info('ENS active — cleared local username');
                        }
                        // Store ENS in plain localStorage for unlock modal display
                        localStorage.setItem(`pombo_ens_${address.toLowerCase()}`, ensName);
                    }
                    // Resolve ENS avatar (needs ENS name first, so chain after name resolution)
                    identityManager.resolveENSAvatar(address).then(avatarUrl => {
                        if (avatarUrl) {
                            // Re-render header avatars with ENS image
                            headerUI.updateWalletInfo(address);
                        }
                    }).catch(() => {});
                }).catch(() => {});
            } catch (idError) {
                Logger.warn('Identity manager init failed (non-critical):', idError);
            }

            try {
                await dmManager.init();
                Logger.info('DM manager initialized');
                if (dmManager.inboxReady) {
                    // Wire blob_pulled events to update image placeholders in real-time
                    syncManager.on('blob_pulled', ({ imageId, data }) => {
                        mediaController.handleImageData({ type: 'image_data', imageId, data });
                    });

                    uiController.showNotification('Syncing your data...', 'info');
                    syncManager.pullSync().then(async () => {
                        Logger.info('Sync: Initial pull complete');
                        uiController.renderChannelList();

                        // Update header with synced username or ENS
                        const syncedUsername = identityManager.getUsername();
                        if (syncedUsername) {
                            headerUI.updateDisplayName(syncedUsername);
                        }
                        // Always resolve own ENS after sync — overrides local username
                        identityManager.resolveENS(address).then(ensName => {
                            if (ensName) {
                                headerUI.updateDisplayName(ensName);
                                if (identityManager.getUsername()) {
                                    identityManager.setUsername(null);
                                    Logger.info('ENS active — cleared local username (post-sync)');
                                }
                                localStorage.setItem(`pombo_ens_${address.toLowerCase()}`, ensName);
                            }
                        }).catch(() => {});
                        // Pull image blobs (partition 2) after state sync
                        try {
                            await syncManager.pullImageBlobs();
                            Logger.info('Sync: Initial image blob pull complete');
                        } catch (e) {
                            Logger.debug('Sync: Image blob pull failed (non-critical):', e.message);
                        }
                        uiController.showNotification('Your data is up to date', 'success');
                    }).catch(e => {
                        Logger.debug('Sync: Initial pull failed (non-critical):', e.message);
                    });
                }
            } catch (dmError) {
                Logger.warn('Failed to init DM manager (non-critical):', dmError);
            }

            uiController.renderChannelList();
            await uiController.processInitialUrl();

            subscriptionManager.startBackgroundPoller();
            Logger.info('Dynamic subscription management active (background poller started)');

            try {
                await notificationManager.init();
                Logger.info('Notification system ready');
            } catch (notifError) {
                Logger.warn('Failed to init notifications (non-critical):', notifError);
            }

            try {
                await relayManager.init(address);
                Logger.info('Relay manager initialized');
            } catch (relayError) {
                Logger.warn('Failed to init relay manager (non-critical):', relayError);
            }

            // Process pending invite if any
            if (inviteHandler.pendingInvite) {
                Logger.info('Processing pending invite:', inviteHandler.pendingInvite.name);
                const inviteData = inviteHandler.pendingInvite;
                inviteHandler.pendingInvite = null;
                setTimeout(() => inviteHandler.showInviteDialog(inviteData), 500);
            }

            Logger.info('Wallet connected and Streamr initialized');
        } catch (error) {
            Logger.error('Failed to initialize after wallet connection:', error);
            headerUI.updateNetworkStatus('Failed to connect to Streamr', false);
            throw error;
        }
    }

    /**
     * Set up message handlers
     */
    setupMessageHandlers() {
        const typingUsers = new Map();
        
        channelManager.onMessage((event, data) => {
            if (!authManager.isConnected()) {
                Logger.debug('Message ignored - user disconnected');
                return;
            }
            
            const currentChannel = channelManager.getCurrentChannel();
            const currentStreamId = currentChannel?.streamId;
            
            if (event === 'message') {
                chatAreaUI.updateUnreadCount(data.streamId);
                if (data.streamId === currentStreamId) {
                    // Skip render during initial history load — will render once when complete
                    if (currentChannel?.initialLoadInProgress) return;
                    chatAreaUI.addMessage(data.message, data.streamId, () => {
                        uiController.attachReactionListeners();
                        mediaHandler.attachLightboxListeners();
                    });
                }
            } else if (event === 'typing') {
                if (data.streamId !== currentStreamId) return;
                
                const user = data.user;
                const nickname = data.nickname || null;
                const myAddress = authManager.getAddress();
                if (user?.toLowerCase() === myAddress?.toLowerCase()) return;
                
                if (!typingUsers.has(data.streamId)) {
                    typingUsers.set(data.streamId, new Map());
                }
                const channelTyping = typingUsers.get(data.streamId);
                channelTyping.set(user, { time: Date.now(), nickname });
                
                const now = Date.now();
                for (const [u, info] of channelTyping) {
                    if (now - info.time > 3000) channelTyping.delete(u);
                }
                
                const typingList = Array.from(channelTyping.entries()).map(([addr, info]) => ({ address: addr, nickname: info.nickname }));
                chatAreaUI.showTypingIndicator(typingList);
                
                setTimeout(() => {
                    channelTyping.delete(user);
                    const stillCurrentChannel = channelManager.getCurrentChannel();
                    if (stillCurrentChannel?.streamId === data.streamId) {
                        const remaining = Array.from(channelTyping.entries()).map(([addr, info]) => ({ address: addr, nickname: info.nickname }));
                        chatAreaUI.showTypingIndicator(remaining);
                    }
                }, 3000);
                
            } else if (event === 'reaction') {
                if (data.streamId === currentStreamId) {
                    reactionManager.handleIncomingReaction(data.messageId, data.emoji, data.user, data.action || 'add');
                }
            } else if (event === 'media') {
                mediaController.handleMediaMessage(data.streamId, data.media);
            } else if (event === 'channelJoined') {
                mediaController.reannounceForChannel(data.streamId, data.password);
                if (data.permissions && !data.permissions.canPublish && data.permissions.canSubscribe) {
                    uiController.showNotification(
                        'You have read-only access to this channel. You cannot send messages.',
                        'warning',
                        5000
                    );
                }
                uiController.renderChannelList();
            } else if (event === 'history_loaded') {
                if (data.streamId === currentStreamId) {
                    Logger.debug(`History loaded: ${data.loaded} messages, hasMore: ${data.hasMore}`);
                }
            } else if (event === 'history_batch_loaded') {
                if (data.streamId === currentStreamId) {
                    const channel = channelManager.getCurrentChannel();
                    if (channel) {
                        chatAreaUI.renderMessages(channel.messages, () => {
                            uiController.attachReactionListeners();
                            mediaHandler.attachLightboxListeners();
                        });
                        Logger.debug(`History batch loaded: ${data.loaded}/${data.total} messages`);
                    }
                }
            } else if (event === 'initial_history_complete') {
                if (data.streamId === currentStreamId) {
                    const channel = channelManager.getCurrentChannel();
                    if (channel) {
                        chatAreaUI.renderMessages(channel.messages, () => {
                            uiController.attachReactionListeners();
                            mediaHandler.attachLightboxListeners();
                        });
                        Logger.info(`Initial history complete — rendered ${channel.messages.length} messages`);
                    }
                }
            }
        });
        
        channelManager.onOnlineUsersChange((streamId, users) => {
            uiController.updateOnlineUsers(streamId, users);
        });
    }

    /**
     * Extract stream ID from deep link URL if present
     * @returns {string|null}
     * @private
     */
    _getDeepLinkStreamId() {
        try {
            const hash = window.location.hash;
            if (!hash) return null;
            const match = hash.match(/#\/(channel|preview)\/((0x[a-fA-F0-9]+)\/[^\/]+)/);
            if (match && match[2]) return match[2];
        } catch (e) {
            // Ignore parsing errors
        }
        return null;
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
