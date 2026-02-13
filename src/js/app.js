/**
 * Main Application Entry Point
 * Orchestrates initialization and connects all modules
 */

import { authManager } from './auth.js';
import { streamrController } from './streamr.js';
import { channelManager } from './channels.js';
import { uiController } from './ui.js';
import { notificationManager } from './notifications.js';
import { identityManager } from './identity.js';
import { secureStorage } from './secureStorage.js';
import { mediaController } from './media.js';
import { Logger } from './logger.js';

class App {
    constructor() {
        this.initialized = false;
        this.pendingInvite = null; // Store invite to process after wallet connection
    }

    /**
     * Initialize the application
     */
    async init() {
        Logger.info('Moot - Initializing...');

        try {
            // Initialize media controller
            await mediaController.init();
            
            // Initialize UI
            uiController.init();
            
            // Expose uiController to window for onclick handlers
            window.uiController = uiController;

            // Note: Channels are loaded after wallet connection (wallet-specific)

            // Set up message handlers
            this.setupMessageHandlers();

            // Set up wallet connection handlers
            this.setupWalletHandlers();

            // Check for invite link in URL
            this.checkInviteLink();

            uiController.updateNetworkStatus('Ready to connect', false);

            this.initialized = true;
            Logger.info('Moot - Ready!');
            
            // Auto-show wallet modal if saved wallets exist
            if (authManager.hasSavedWallet()) {
                // Small delay to let UI settle
                setTimeout(() => this.connectWallet(), 300);
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

        connectBtn.addEventListener('click', async () => {
            if (authManager.isConnected()) {
                // Already connected, show options
                this.showWalletOptions();
            } else {
                // Connect wallet
                await this.connectWallet();
            }
        });

        disconnectBtn?.addEventListener('click', async () => {
            await this.disconnectWallet();
        });

        switchBtn?.addEventListener('click', async () => {
            await this.switchWallet();
        });
    }

    /**
     * Switch to another saved wallet
     */
    async switchWallet() {
        try {
            const savedWallets = authManager.listSavedWallets();
            if (savedWallets.length <= 1) return;

            // Show wallet selector (excluding current)
            const currentAddress = authManager.getAddress();
            const otherWallets = savedWallets.filter(w => w.address !== currentAddress);
            
            if (otherWallets.length === 0) return;

            const selectedAddress = await this.showWalletSelector(otherWallets);
            if (!selectedAddress) return;

            // Get password to unlock new wallet
            const password = await this.showSecureInput(
                'Unlock Wallet',
                'Enter password to unlock wallet:',
                'password'
            );
            if (!password) return;

            // Disconnect current wallet first
            await this.disconnectWallet();

            // Load selected wallet
            await this.loadWalletWithProgress(password, selectedAddress);
            uiController.showNotification('Wallet switched!', 'success');
        } catch (error) {
            uiController.showNotification(error.message || 'Failed to switch wallet', 'error');
        }
    }

    /**
     * Disconnect wallet
     */
    async disconnectWallet() {
        try {
            // Disconnect auth
            authManager.disconnect();
            
            // Lock storage
            secureStorage.lock();
            
            // Leave all channels
            await channelManager.leaveAllChannels();
            
            // Update UI
            uiController.updateWalletInfo(null);
            uiController.updateNetworkStatus('Disconnected', false);
            uiController.renderChannelList(); // Clear channel list
            uiController.showNotification('Wallet disconnected', 'info');
            
            // Reset chat area
            const messagesArea = document.getElementById('messages-area');
            if (messagesArea) {
                messagesArea.innerHTML = `
                    <div class="flex items-center justify-center h-full text-gray-500">
                        Select or create a channel to start chatting
                    </div>
                `;
            }
            document.getElementById('message-input-container')?.classList.add('hidden');
            document.getElementById('current-channel-name').textContent = 'Select a channel';
            document.getElementById('current-channel-info').textContent = '';
            
            Logger.info('Wallet disconnected');
        } catch (error) {
            Logger.error('Error disconnecting:', error);
            uiController.showNotification('Error disconnecting: ' + error.message, 'error');
        }
    }

    /**
     * Connect wallet (generate, import, or load saved)
     */
    async connectWallet() {
        try {
            // Check if there are saved wallets
            const savedWallets = authManager.listSavedWallets();
            
            if (savedWallets.length > 0) {
                // Show quick unlock or wallet selection
                await this.showUnlockWalletModal(savedWallets);
            } else {
                // No saved wallets - show create/import options
                await this.showCreateWalletModal();
            }
        } catch (error) {
            if (error.message !== 'cancelled') {
                console.error('Failed to connect wallet:', error);
                uiController.showNotification('Failed to connect: ' + error.message, 'error');
            }
        }
    }

    /**
     * Show unlock wallet modal (when saved wallets exist)
     */
    async showUnlockWalletModal(wallets) {
        return new Promise((resolve, reject) => {
            const singleWallet = wallets.length === 1;
            const wallet = singleWallet ? wallets[0] : null;
            
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 animate-fadeIn';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl w-[360px] overflow-hidden shadow-2xl border border-[#222] animate-slideUp">
                    <!-- Header -->
                    <div class="px-5 pt-5 pb-3">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">Unlock Wallet</h3>
                            <button id="close-modal" class="text-[#666] hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    
                    ${singleWallet ? `
                    <!-- Single Wallet Display -->
                    <div class="px-5 pb-4">
                        <div class="bg-[#1a1a1a] rounded-lg p-3 border border-[#282828]">
                            <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-[#252525] flex items-center justify-center">
                                    <svg class="w-4 h-4 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"/>
                                    </svg>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <div class="text-[13px] font-medium text-white truncate">${wallet.name}</div>
                                    <div class="text-[11px] text-[#666] font-mono">${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    ` : `
                    <!-- Multiple Wallets List -->
                    <div class="px-5 pb-4">
                        <div class="space-y-2 max-h-40 overflow-y-auto scrollbar-thin">
                            ${wallets.map((w, i) => `
                                <button class="wallet-item w-full bg-[#1a1a1a] hover:bg-[#202020] rounded-lg p-3 border border-[#282828] hover:border-[#444] transition-all text-left ${i === 0 ? 'selected border-[#444]' : ''}" data-address="${w.address}" data-name="${w.name}">
                                    <div class="flex items-center gap-3">
                                        <div class="w-8 h-8 rounded-lg bg-[#252525] flex items-center justify-center flex-shrink-0">
                                            <svg class="w-4 h-4 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"/>
                                            </svg>
                                        </div>
                                        <div class="flex-1 min-w-0">
                                            <div class="text-[13px] font-medium text-white truncate">${w.name}</div>
                                            <div class="text-[11px] text-[#666] font-mono">${w.address.slice(0, 6)}...${w.address.slice(-4)}</div>
                                        </div>
                                        <div class="w-4 h-4 rounded-full border border-[#444] group-[.selected]:bg-white flex items-center justify-center">
                                            <div class="w-2 h-2 rounded-full bg-white opacity-0 selected-dot"></div>
                                        </div>
                                    </div>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    `}
                    
                    <!-- Password Input -->
                    <div class="px-5 pb-4">
                        <div class="relative">
                            <input type="password" id="wallet-password" 
                                placeholder="Password"
                                class="w-full bg-[#1a1a1a] border border-[#282828] rounded-lg px-3 py-2.5 text-[13px] text-white placeholder-[#555] focus:outline-none focus:border-[#444] transition"
                                autocomplete="off">
                            <button id="toggle-password" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#555] hover:text-white transition">
                                <svg id="eye-icon" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                </svg>
                            </button>
                        </div>
                        <p id="password-error" class="text-red-500 text-[11px] mt-1.5 hidden">Incorrect password</p>
                    </div>
                    
                    <!-- Actions -->
                    <div class="px-5 pb-5">
                        <button id="unlock-btn" class="w-full bg-white hover:bg-[#e5e5e5] text-black text-[13px] font-medium py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed">
                            Unlock
                        </button>
                    </div>
                    
                    <!-- Footer -->
                    <div class="border-t border-[#222] px-5 py-3 bg-[#0d0d0d]">
                        <div class="flex items-center justify-center gap-3 text-[12px]">
                            <button id="create-new-btn" class="text-[#666] hover:text-white transition">New wallet</button>
                            <span class="text-[#333]">·</span>
                            <button id="import-btn" class="text-[#666] hover:text-white transition">Import</button>
                        </div>
                    </div>
                </div>
            `;

            // Add animations
            const style = document.createElement('style');
            style.textContent = `
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                .animate-fadeIn { animation: fadeIn 0.15s ease-out; }
                .animate-slideUp { animation: slideUp 0.2s ease-out; }
                .scrollbar-thin::-webkit-scrollbar { width: 3px; }
                .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
                .scrollbar-thin::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
                .wallet-item.selected .selected-dot { opacity: 1; }
            `;
            document.head.appendChild(style);
            document.body.appendChild(modal);

            const passwordInput = modal.querySelector('#wallet-password');
            const unlockBtn = modal.querySelector('#unlock-btn');
            const togglePassword = modal.querySelector('#toggle-password');
            const eyeIcon = modal.querySelector('#eye-icon');
            const passwordError = modal.querySelector('#password-error');
            const closeBtn = modal.querySelector('#close-modal');
            const createNewBtn = modal.querySelector('#create-new-btn');
            const importBtn = modal.querySelector('#import-btn');
            const walletItems = modal.querySelectorAll('.wallet-item');
            
            let selectedAddress = singleWallet ? wallet.address : wallets[0].address;
            let selectedName = singleWallet ? wallet.name : wallets[0].name;
            
            // Focus password input
            setTimeout(() => passwordInput.focus(), 100);
            
            // Wallet selection
            walletItems.forEach(item => {
                item.addEventListener('click', () => {
                    walletItems.forEach(w => w.classList.remove('selected', 'border-[#444]'));
                    item.classList.add('selected', 'border-[#444]');
                    selectedAddress = item.dataset.address;
                    selectedName = item.dataset.name;
                    passwordInput.focus();
                });
            });
            
            // Toggle password visibility
            togglePassword.addEventListener('click', () => {
                const isPassword = passwordInput.type === 'password';
                passwordInput.type = isPassword ? 'text' : 'password';
                eyeIcon.innerHTML = isPassword 
                    ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/>'
                    : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>';
            });
            
            const cleanup = () => {
                passwordInput.value = '';
                document.body.removeChild(modal);
                document.head.removeChild(style);
            };
            
            // Unlock action
            const attemptUnlock = async () => {
                const password = passwordInput.value;
                if (!password) {
                    passwordInput.classList.add('border-red-500');
                    return;
                }
                
                unlockBtn.disabled = true;
                unlockBtn.innerHTML = '<svg class="animate-spin h-4 w-4 mx-auto text-black" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
                
                try {
                    cleanup();
                    await this.loadWalletWithProgress(password, selectedAddress);
                    resolve();
                } catch (error) {
                    // Re-show modal with error
                    document.head.appendChild(style);
                    document.body.appendChild(modal);
                    passwordError.classList.remove('hidden');
                    passwordInput.classList.add('border-red-500');
                    unlockBtn.disabled = false;
                    unlockBtn.textContent = 'Unlock';
                    passwordInput.value = '';
                    passwordInput.focus();
                }
            };
            
            unlockBtn.addEventListener('click', attemptUnlock);
            passwordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') attemptUnlock();
            });
            passwordInput.addEventListener('input', () => {
                passwordInput.classList.remove('border-red-500');
                passwordError.classList.add('hidden');
            });
            
            // Close modal
            closeBtn.addEventListener('click', () => {
                cleanup();
                reject(new Error('cancelled'));
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    cleanup();
                    reject(new Error('cancelled'));
                }
            });
            
            // Create new / Import
            createNewBtn.addEventListener('click', async () => {
                cleanup();
                try {
                    await this.showCreateWalletModal();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
            
            importBtn.addEventListener('click', async () => {
                cleanup();
                try {
                    await this.importPrivateKey();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Show create wallet modal (when no saved wallets)
     */
    async showCreateWalletModal() {
        return new Promise((resolve, reject) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 animate-fadeIn';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl w-[340px] overflow-hidden shadow-2xl border border-[#222] animate-slideUp">
                    <!-- Header -->
                    <div class="px-5 pt-5 pb-3">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">Connect Wallet</h3>
                            <button id="close-modal" class="text-[#666] hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    
                    <!-- Options -->
                    <div class="px-5 pb-5 space-y-2">
                        <button id="create-btn" class="w-full bg-white hover:bg-[#f0f0f0] rounded-lg p-3.5 text-left transition-all">
                            <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-[#111] flex items-center justify-center">
                                    <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4.5v15m7.5-7.5h-15"/>
                                    </svg>
                                </div>
                                <div>
                                    <div class="text-[13px] font-medium text-black">Create New Wallet</div>
                                    <div class="text-[11px] text-[#666]">Generate a new wallet</div>
                                </div>
                            </div>
                        </button>
                        
                        <button id="import-btn" class="w-full bg-[#1a1a1a] hover:bg-[#202020] border border-[#282828] hover:border-[#333] rounded-lg p-3.5 text-left transition-all">
                            <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-lg bg-[#252525] flex items-center justify-center">
                                    <svg class="w-4 h-4 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/>
                                    </svg>
                                </div>
                                <div>
                                    <div class="text-[13px] font-medium text-white">Import Private Key</div>
                                    <div class="text-[11px] text-[#666]">Use existing wallet</div>
                                </div>
                            </div>
                        </button>
                    </div>
                </div>
            `;

            // Add animations
            const style = document.createElement('style');
            style.textContent = `
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                .animate-fadeIn { animation: fadeIn 0.15s ease-out; }
                .animate-slideUp { animation: slideUp 0.2s ease-out; }
            `;
            document.head.appendChild(style);
            document.body.appendChild(modal);

            const cleanup = () => {
                document.body.removeChild(modal);
                document.head.removeChild(style);
            };

            modal.querySelector('#close-modal').addEventListener('click', () => {
                cleanup();
                reject(new Error('cancelled'));
            });
            
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    cleanup();
                    reject(new Error('cancelled'));
                }
            });

            modal.querySelector('#create-btn').addEventListener('click', async () => {
                cleanup();
                try {
                    await this.connectLocal();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });

            modal.querySelector('#import-btn').addEventListener('click', async () => {
                cleanup();
                try {
                    await this.importPrivateKey();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Show wallet connection options (legacy - deprecated)
     * @returns {Promise<string>} - Selected option
     */
    async showConnectOptions() {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl p-5 w-[340px] border border-[#222]">
                    <h3 class="text-[15px] font-medium mb-3 text-white">Connect Wallet</h3>
                    <div class="space-y-2">
                        <button class="w-full bg-white hover:bg-[#f0f0f0] text-black px-3 py-2.5 rounded-lg text-left transition" data-choice="local">
                            <div class="text-[13px] font-medium">Generate New Wallet</div>
                            <div class="text-[11px] text-[#666]">Create a new wallet</div>
                        </button>
                        <button class="w-full bg-[#1a1a1a] hover:bg-[#202020] border border-[#282828] px-3 py-2.5 rounded-lg text-left transition" data-choice="import">
                            <div class="text-[13px] font-medium text-white">Import Private Key</div>
                            <div class="text-[11px] text-[#666]">Use existing wallet</div>
                        </button>
                        ${authManager.hasSavedWallet() ? `
                        <button class="w-full bg-[#1a1a1a] hover:bg-[#202020] border border-[#282828] px-3 py-2.5 rounded-lg text-left transition" data-choice="load">
                            <div class="text-[13px] font-medium text-white">Load Saved Wallet</div>
                            <div class="text-[11px] text-[#666]">Decrypt from storage</div>
                        </button>
                        ` : ''}
                        <button class="w-full bg-[#1a1a1a] hover:bg-[#202020] border border-[#282828] text-[#888] text-[13px] px-3 py-2 rounded-lg transition mt-1" data-choice="cancel">
                            Cancel
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            modal.querySelectorAll('button[data-choice]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const choice = e.currentTarget.dataset.choice;
                    document.body.removeChild(modal);
                    resolve(choice);
                });
            });
        });
    }

    /**
     * Show secure input modal (for sensitive data like private keys)
     * @param {string} title - Modal title
     * @param {string} label - Input label
     * @param {string} inputType - Input type ('text' or 'password')
     * @returns {Promise<string|null>} - User input or null if cancelled
     */
    async showSecureInput(title, label, inputType = 'password') {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl w-[340px] overflow-hidden shadow-2xl border border-[#222]">
                    <div class="px-5 pt-5 pb-3">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">${title}</h3>
                            <button id="close-modal" class="text-[#666] hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                        <p class="text-[11px] text-[#666] mt-1">${label}</p>
                    </div>
                    <div class="px-5 pb-4">
                        <div class="relative">
                            <input type="${inputType}" id="secure-input" 
                                class="w-full bg-[#1a1a1a] border border-[#282828] rounded-lg px-3 py-2.5 text-[13px] text-white placeholder-[#555] focus:outline-none focus:border-[#444] transition"
                                autocomplete="off" spellcheck="false">
                            ${inputType === 'password' ? `
                            <button id="toggle-visibility" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#555] hover:text-white transition">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                </svg>
                            </button>
                            ` : ''}
                        </div>
                    </div>
                    <div class="px-5 pb-5 flex gap-2">
                        <button id="secure-cancel" class="flex-1 bg-[#1a1a1a] hover:bg-[#202020] text-white text-[13px] font-medium py-2.5 rounded-lg transition border border-[#282828]">
                            Cancel
                        </button>
                        <button id="secure-confirm" class="flex-1 bg-white hover:bg-[#f0f0f0] text-black text-[13px] font-medium py-2.5 rounded-lg transition">
                            Continue
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const input = modal.querySelector('#secure-input');
            const confirmBtn = modal.querySelector('#secure-confirm');
            const cancelBtn = modal.querySelector('#secure-cancel');
            const closeBtn = modal.querySelector('#close-modal');
            const toggleBtn = modal.querySelector('#toggle-visibility');

            input.focus();

            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    input.type = input.type === 'password' ? 'text' : 'password';
                });
            }

            const cleanup = (value) => {
                input.value = '';
                document.body.removeChild(modal);
                resolve(value);
            };

            confirmBtn.addEventListener('click', () => cleanup(input.value || null));
            cancelBtn.addEventListener('click', () => cleanup(null));
            closeBtn.addEventListener('click', () => cleanup(null));
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') cleanup(input.value || null);
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) cleanup(null);
            });
        });
    }

    /**
     * Generate local wallet
     */
    async connectLocal() {
        try {
            const result = authManager.generateLocalWallet();

            // Show wallet created modal with secure private key display
            await this.showNewWalletModal(result.address, result.privateKey);

            // Ask if user wants to save encrypted
            const saveChoice = await this.showConfirmModal(
                'Save Wallet?',
                'Would you like to save this wallet encrypted with a password?'
            );

            if (saveChoice) {
                const password = await this.showSecureInput(
                    'Encrypt Wallet',
                    'Enter a password to encrypt your wallet:',
                    'password'
                );
                if (password) {
                    await this.saveWalletWithProgress(password);
                }
            }

            await this.onWalletConnected(result.address, result.signer);
            uiController.showNotification('Wallet created!', 'success');
        } catch (error) {
            throw error;
        }
    }

    /**
     * Show new wallet modal with secure private key reveal
     */
    async showNewWalletModal(address, privateKey) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl w-[360px] overflow-hidden shadow-2xl border border-[#222]">
                    <!-- Success Header -->
                    <div class="px-5 pt-5 pb-3">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-lg bg-[#1a2f1a] flex items-center justify-center">
                                <svg class="w-4 h-4 text-[#4ade80]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4.5 12.75l6 6 9-13.5"/>
                                </svg>
                            </div>
                            <div>
                                <h3 class="text-[15px] font-medium text-white">Wallet Created</h3>
                                <p class="text-[11px] text-[#666]">Save your private key</p>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Address -->
                    <div class="px-5 pb-2">
                        <label class="block text-[10px] text-[#666] mb-1 uppercase tracking-wide">Address</label>
                        <div class="bg-[#1a1a1a] rounded-lg px-3 py-2.5 font-mono text-[11px] text-[#888] break-all border border-[#282828]">
                            ${address}
                        </div>
                    </div>
                    
                    <!-- Private Key -->
                    <div class="px-5 pb-3">
                        <label class="block text-[10px] text-[#666] mb-1 uppercase tracking-wide">Private Key</label>
                        <div class="bg-[#1a1a1a] rounded-lg px-3 py-2.5 border border-[#282828] relative">
                            <div id="pk-hidden" class="font-mono text-[11px] text-[#444] select-none">••••••••••••••••••••••••••••••••••••</div>
                            <div id="pk-revealed" class="font-mono text-[11px] text-[#888] break-all hidden">${privateKey}</div>
                            <button id="toggle-pk" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#555] hover:text-white transition">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                </svg>
                            </button>
                        </div>
                        <button id="copy-pk" class="mt-2 w-full bg-[#1a1a1a] hover:bg-[#202020] border border-[#282828] text-white text-[12px] font-medium py-2 rounded-lg transition flex items-center justify-center gap-2">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/>
                            </svg>
                            Copy Private Key
                        </button>
                    </div>
                    
                    <!-- Warning -->
                    <div class="mx-5 mb-3 bg-[#1f1a0f] border border-[#3d3215] rounded-lg p-3">
                        <div class="flex gap-2.5">
                            <svg class="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                            </svg>
                            <div>
                                <p class="text-[#f59e0b] text-[12px] font-medium">Save your private key!</p>
                                <p class="text-[#a67c00] text-[10px] mt-0.5">Store it safely offline. This is the only way to recover your wallet.</p>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Continue Button -->
                    <div class="px-5 pb-5">
                        <button id="continue-btn" class="w-full bg-white hover:bg-[#f0f0f0] text-black text-[13px] font-medium py-2.5 rounded-lg transition">
                            Continue
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const toggleBtn = modal.querySelector('#toggle-pk');
            const pkHidden = modal.querySelector('#pk-hidden');
            const pkRevealed = modal.querySelector('#pk-revealed');
            const copyBtn = modal.querySelector('#copy-pk');
            const continueBtn = modal.querySelector('#continue-btn');

            let isRevealed = false;
            toggleBtn.addEventListener('click', () => {
                isRevealed = !isRevealed;
                pkHidden.classList.toggle('hidden', isRevealed);
                pkRevealed.classList.toggle('hidden', !isRevealed);
            });

            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(privateKey);
                    copyBtn.innerHTML = `
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                        </svg>
                        Copied!
                    `;
                    copyBtn.classList.remove('bg-gray-800', 'hover:bg-gray-700');
                    copyBtn.classList.add('bg-green-600');
                    setTimeout(() => {
                        copyBtn.innerHTML = `
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                            </svg>
                            Copy Private Key
                        `;
                        copyBtn.classList.add('bg-gray-800', 'hover:bg-gray-700');
                        copyBtn.classList.remove('bg-green-600');
                    }, 2000);
                } catch (err) {
                    const textarea = document.createElement('textarea');
                    textarea.value = privateKey;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                }
            });

            continueBtn.addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve();
            });
        });
    }

    /**
     * Show confirmation modal
     */
    async showConfirmModal(title, message) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl w-[320px] overflow-hidden shadow-2xl border border-[#222]">
                    <div class="px-5 pt-5 pb-3">
                        <h3 class="text-[15px] font-medium text-white mb-1">${title}</h3>
                        <p class="text-[#888] text-[12px]">${message}</p>
                    </div>
                    <div class="px-5 pb-5 flex gap-2">
                        <button id="confirm-no" class="flex-1 bg-[#1a1a1a] hover:bg-[#202020] text-white text-[13px] font-medium py-2.5 rounded-lg transition border border-[#282828]">
                            No
                        </button>
                        <button id="confirm-yes" class="flex-1 bg-white hover:bg-[#f0f0f0] text-black text-[13px] font-medium py-2.5 rounded-lg transition">
                            Yes
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            modal.querySelector('#confirm-yes').addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(true);
            });
            modal.querySelector('#confirm-no').addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(false);
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                    resolve(false);
                }
            });
        });
    }

    /**
     * Save wallet with progress indicator (Keystore V3)
     * @param {string} password - Encryption password
     * @param {string} name - Optional wallet name
     */
    async saveWalletWithProgress(password, name = null) {
        const modal = this.showProgressModal('Encrypting Wallet', 'Using Keystore V3 with scrypt (n=262144)...');
        
        try {
            const result = await authManager.saveWalletEncrypted(password, name, (progress) => {
                this.updateProgressModal(modal, progress);
            });
            
            this.hideProgressModal(modal);
            uiController.showNotification(`Wallet "${result.name}" saved securely!`, 'success');
            return result;
        } catch (error) {
            this.hideProgressModal(modal);
            throw error;
        }
    }

    /**
     * Load wallet with progress indicator (Keystore V3)
     * @param {string} password - Decryption password
     * @param {string} address - Optional specific wallet address
     */
    async loadWalletWithProgress(password, address = null) {
        const modal = this.showProgressModal('Decrypting Wallet', 'Verifying Keystore V3...');
        
        try {
            const result = await authManager.loadWalletEncrypted(password, address, (progress) => {
                this.updateProgressModal(modal, progress);
            });
            
            this.hideProgressModal(modal);
            await this.onWalletConnected(result.address, result.signer);
            return result;
        } catch (error) {
            this.hideProgressModal(modal);
            throw error;
        }
    }

    /**
     * Show progress modal for encryption/decryption
     */
    showProgressModal(title, subtitle) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
        modal.innerHTML = `
            <div class="bg-[#111111] rounded-xl w-[300px] overflow-hidden shadow-2xl border border-[#222]">
                <div class="px-5 pt-5 pb-2">
                    <h3 class="text-[14px] font-medium text-white">${title}</h3>
                    <p class="text-[11px] text-[#666] mt-0.5">${subtitle}</p>
                </div>
                <div class="px-5 pb-5 pt-3">
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="text-[10px] text-[#666]">Progress</span>
                        <span class="text-[10px] font-medium text-white" id="progress-label">0%</span>
                    </div>
                    <div class="h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                        <div id="progress-bar" class="h-full bg-white transition-all duration-300 ease-out" style="width: 0%"></div>
                    </div>
                    <p class="text-[10px] text-[#555] text-center mt-3">This may take a few seconds...</p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    /**
     * Update progress modal
     */
    updateProgressModal(modal, progress) {
        const percent = Math.round(progress * 100);
        const progressBar = modal.querySelector('#progress-bar');
        const progressLabel = modal.querySelector('#progress-label');
        
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressLabel) progressLabel.textContent = `${percent}%`;
    }

    /**
     * Hide progress modal
     */
    hideProgressModal(modal) {
        if (modal && modal.parentNode) {
            document.body.removeChild(modal);
        }
    }

    /**
     * Show wallet selector for multiple saved wallets
     */
    async showWalletSelector(wallets) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111111] rounded-xl p-5 w-[340px] border border-[#222]">
                    <h3 class="text-[15px] font-medium mb-3 text-white">Select Wallet</h3>
                    <div class="space-y-2 max-h-60 overflow-y-auto">
                        ${wallets.map(w => `
                            <button class="wallet-option w-full bg-[#1a1a1a] hover:bg-[#202020] border border-[#282828] px-3 py-2.5 rounded-lg text-left transition" data-address="${w.address}">
                                <div class="text-[13px] font-medium text-white">${w.name}</div>
                                <div class="text-[11px] text-[#666] font-mono">${w.address.slice(0, 10)}...${w.address.slice(-8)}</div>
                                <div class="text-[10px] text-[#555]">Last used: ${w.lastUsed ? new Date(w.lastUsed).toLocaleDateString() : 'Never'}</div>
                            </button>
                        `).join('')}
                    </div>
                    <button id="cancel-select" class="mt-3 w-full bg-[#1a1a1a] hover:bg-[#202020] border border-[#282828] text-[#888] text-[13px] px-3 py-2 rounded-lg transition">
                        Cancel
                    </button>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            modal.querySelectorAll('.wallet-option').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const address = e.currentTarget.dataset.address;
                    document.body.removeChild(modal);
                    resolve(address);
                });
            });
            
            modal.querySelector('#cancel-select').addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(null);
            });
        });
    }

    /**
     * Import private key
     */
    async importPrivateKey() {
        try {
            const privateKey = await this.showSecureInput(
                'Import Private Key',
                'Enter your private key (starts with 0x):',
                'password'
            );
            if (!privateKey) return;

            const result = authManager.importPrivateKey(privateKey);

            // Ask if user wants to save encrypted
            const save = await this.showConfirmModal(
                'Save Wallet?',
                'Would you like to save this wallet encrypted with a password?'
            );
            if (save) {
                const password = await this.showSecureInput(
                    'Encrypt Wallet',
                    'Enter a password:',
                    'password'
                );
                if (password) {
                    await this.saveWalletWithProgress(password);
                }
            }

            await this.onWalletConnected(result.address, result.signer);
            uiController.showNotification('Wallet imported!', 'success');
        } catch (error) {
            throw error;
        }
    }

    /**
     * Load saved wallet
     */
    async loadSavedWallet() {
        try {
            // Check if multiple wallets exist
            const savedWallets = authManager.listSavedWallets();
            let targetAddress = null;
            
            if (savedWallets.length > 1) {
                targetAddress = await this.showWalletSelector(savedWallets);
                if (!targetAddress) return;
            }
            
            const password = await this.showSecureInput(
                'Unlock Wallet',
                'Enter your wallet password:',
                'password'
            );
            if (!password) return;

            await this.loadWalletWithProgress(password, targetAddress);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Handle wallet connected event
     * @param {string} address - Wallet address
     * @param {Object} signer - Ethers signer
     */
    async onWalletConnected(address, signer) {
        try {
            // Update UI
            uiController.updateWalletInfo(address);
            uiController.updateNetworkStatus('Connecting to Streamr...', false);

            // Show/hide switch wallet button based on saved wallets count
            const savedWallets = authManager.listSavedWallets();
            uiController.updateSwitchWalletButton(savedWallets.length > 1);

            // Initialize secure storage for this wallet (requires signer for encryption key derivation)
            await secureStorage.init(signer, address);

            // Clear any previously loaded channels (from another wallet)
            channelManager.clearChannels();

            // Load channels for THIS wallet
            channelManager.loadChannels();
            Logger.info('Loaded channels for wallet:', address);

            // Initialize Streamr client with private key
            await streamrController.init(signer);

            // Verify Streamr connection
            const streamrAddress = await streamrController.getAddress();
            Logger.info('Streamr connected with address:', streamrAddress);

            uiController.updateNetworkStatus('Connected to Streamr', true);

            // Initialize identity manager for signature verification and ENS
            try {
                await identityManager.init();
                Logger.info('Identity manager initialized');
            } catch (idError) {
                Logger.warn('Identity manager init failed (non-critical):', idError);
            }

            // Render saved channels
            uiController.renderChannelList();

            // Re-subscribe to all channels
            for (const channel of channelManager.getAllChannels()) {
                await channelManager.subscribeToChannel(channel.streamId, channel.password);
            }
            Logger.info('Subscribed to all channels');

            // Initialize notification system
            try {
                await notificationManager.init();
                Logger.info('Notification system ready');
            } catch (notifError) {
                Logger.warn('Failed to init notifications (non-critical):', notifError);
            }

            // Process pending invite if any
            if (this.pendingInvite) {
                Logger.info('Processing pending invite:', this.pendingInvite.name);
                const inviteData = this.pendingInvite;
                this.pendingInvite = null;
                // Small delay to let UI settle
                setTimeout(() => this.showInviteDialog(inviteData), 500);
            }

            Logger.info('Wallet connected and Streamr initialized');
        } catch (error) {
            Logger.error('Failed to initialize after wallet connection:', error);
            uiController.updateNetworkStatus('Failed to connect to Streamr', false);
            throw error;
        }
    }

    /**
     * Show wallet options when already connected
     */
    showWalletOptions() {
        const address = authManager.getAddress();
        alert(`Connected: ${address}\n\nRefresh page to connect a different wallet.`);
    }

    /**
     * Set up message handlers
     */
    setupMessageHandlers() {
        // Track typing users per channel with timeout
        const typingUsers = new Map(); // streamId -> Map(user -> timestamp)
        
        channelManager.onMessage((event, data) => {
            // Get current channel to filter events
            const currentChannel = channelManager.getCurrentChannel();
            const currentStreamId = currentChannel?.streamId;
            
            if (event === 'message') {
                // Only show message if it's from the current channel
                if (data.streamId === currentStreamId) {
                    uiController.addMessage(data.message);
                }
            } else if (event === 'typing') {
                // Only show typing if it's from the current channel
                if (data.streamId !== currentStreamId) return;
                
                const user = data.user;
                const myAddress = authManager.getAddress();
                
                // Don't show typing indicator for own user
                if (user?.toLowerCase() === myAddress?.toLowerCase()) return;
                
                // Get or create typing map for this channel
                if (!typingUsers.has(data.streamId)) {
                    typingUsers.set(data.streamId, new Map());
                }
                const channelTyping = typingUsers.get(data.streamId);
                
                // Add user to typing list with timeout
                channelTyping.set(user, Date.now());
                
                // Clear old typing users (older than 3 seconds)
                const now = Date.now();
                for (const [u, time] of channelTyping) {
                    if (now - time > 3000) {
                        channelTyping.delete(u);
                    }
                }
                
                // Update UI with typing users for current channel only
                uiController.showTypingIndicator(Array.from(channelTyping.keys()));
                
                // Set timeout to hide indicator
                setTimeout(() => {
                    channelTyping.delete(user);
                    // Only update UI if still on same channel
                    const stillCurrentChannel = channelManager.getCurrentChannel();
                    if (stillCurrentChannel?.streamId === data.streamId) {
                        uiController.showTypingIndicator(Array.from(channelTyping.keys()));
                    }
                }, 3000);
                
            } else if (event === 'reaction') {
                // Only show reaction if it's from the current channel
                if (data.streamId === currentStreamId) {
                    uiController.handleIncomingReaction(data.messageId, data.emoji, data.user, data.action || 'add');
                }
            } else if (event === 'media') {
                // Handle media messages (images, file chunks, etc.)
                mediaController.handleMediaMessage(data.streamId, data.media);
            } else if (event === 'channelJoined') {
                // Re-announce as seeder for any persisted files in this channel
                mediaController.reannounceForChannel(data.streamId, data.password);
            }
        });
        
        // Online users change handler
        channelManager.onOnlineUsersChange((streamId, users) => {
            uiController.updateOnlineUsers(streamId, users);
        });
    }

    /**
     * Check for invite link in URL
     */
    checkInviteLink() {
        const params = new URLSearchParams(window.location.search);
        const inviteCode = params.get('invite');

        if (inviteCode) {
            const inviteData = channelManager.parseInviteLink(inviteCode);

            if (inviteData) {
                Logger.info('Invite detected:', inviteData);

                // Clear URL immediately to avoid re-processing on refresh
                window.history.replaceState({}, document.title, window.location.pathname);

                // If wallet already connected, process immediately
                if (authManager.isConnected()) {
                    this.showInviteDialog(inviteData);
                } else {
                    // Store for later when wallet connects
                    this.pendingInvite = inviteData;
                    uiController.showNotification('Please connect your wallet to join the channel', 'info');
                }
            }
        }
    }

    /**
     * Show invite dialog and process
     */
    showInviteDialog(inviteData) {
        // Create custom modal instead of native confirm()
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 animate-fadeIn';
        modal.innerHTML = `
            <div class="bg-[#111111] rounded-xl w-[360px] overflow-hidden shadow-2xl border border-[#222] animate-slideUp">
                <!-- Header -->
                <div class="px-5 pt-5 pb-3">
                    <div class="flex items-center justify-between">
                        <h3 class="text-[15px] font-medium text-white">Channel Invite</h3>
                        <button id="close-invite-modal" class="text-[#666] hover:text-white transition p-1 -mr-1">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <p class="text-[13px] text-[#888] mt-1">You've been invited to join a channel</p>
                </div>
                
                <!-- Channel Info -->
                <div class="px-5 pb-4">
                    <div class="bg-[#1a1a1a] rounded-lg p-4 border border-[#282828] space-y-3">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-lg bg-[#252525] flex items-center justify-center">
                                <svg class="w-5 h-5 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"/>
                                </svg>
                            </div>
                            <div class="flex-1 min-w-0">
                                <div class="text-[14px] font-medium text-white truncate">${inviteData.name}</div>
                                <div class="text-[12px] text-[#666]">${this.getChannelTypeLabel(inviteData.type)}</div>
                            </div>
                        </div>
                        <div class="pt-2 border-t border-[#282828]">
                            <div class="text-[11px] text-[#555] font-mono break-all">${inviteData.streamId}</div>
                        </div>
                    </div>
                </div>
                
                <!-- Actions -->
                <div class="px-5 pb-5 flex gap-3">
                    <button id="decline-invite" class="flex-1 bg-[#1a1a1a] hover:bg-[#252525] border border-[#282828] text-[#888] text-[13px] font-medium px-4 py-2.5 rounded-lg transition">
                        Decline
                    </button>
                    <button id="accept-invite" class="flex-1 bg-white hover:bg-[#f0f0f0] text-black text-[13px] font-medium px-4 py-2.5 rounded-lg transition">
                        Join Channel
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const closeModal = () => {
            modal.classList.add('animate-fadeOut');
            setTimeout(() => document.body.removeChild(modal), 150);
        };
        
        // Close button
        modal.querySelector('#close-invite-modal').addEventListener('click', closeModal);
        
        // Decline button
        modal.querySelector('#decline-invite').addEventListener('click', closeModal);
        
        // Accept button
        modal.querySelector('#accept-invite').addEventListener('click', () => {
            closeModal();
            this.joinChannelFromInvite(inviteData);
        });
        
        // Click outside to close
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    /**
     * Get channel type label for display
     */
    getChannelTypeLabel(type) {
        const labels = {
            'public': 'Public Channel',
            'password': 'Password Protected',
            'native': 'Native Encryption'
        };
        return labels[type] || type;
    }

    /**
     * Join channel from invite
     * @param {Object} inviteData - Invite data
     */
    async joinChannelFromInvite(inviteData) {
        try {
            if (!authManager.isConnected()) {
                alert('Please connect your wallet first!');
                return;
            }

            uiController.showLoading('Joining channel...');
            await channelManager.joinChannel(inviteData.streamId, inviteData.password, {
                name: inviteData.name,
                type: inviteData.type
            });
            uiController.hideLoading();

            uiController.renderChannelList();
            uiController.showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            uiController.hideLoading();
            uiController.showNotification('Failed to join channel: ' + error.message, 'error');
        }
    }

    /**
     * Accept invite (called from notification banner)
     * @param {string} inviteId - Invite ID
     */
    async acceptInvite(inviteId) {
        await notificationManager.acceptInvite(inviteId);
        uiController.renderChannelList();
    }

    /**
     * Dismiss invite (called from notification banner)
     * @param {string} inviteId - Invite ID
     */
    dismissInvite(inviteId) {
        notificationManager.dismissInvite(inviteId);
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();

    // Expose app to window for debugging
    window.ethChat = app;
});
