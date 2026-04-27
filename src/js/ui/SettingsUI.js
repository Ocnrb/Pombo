import { escapeHtml as _escapeHtml, escapeAttr as _escapeAttr } from './utils.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { GasEstimator } from './GasEstimator.js';
import { CONFIG, getNetworkParams } from '../config.js';

/**
 * Settings UI Manager
 * Handles all settings modal functionality
 */

class SettingsUI {
    constructor() {
        this.deps = {};
        this.elements = {};
        this.settingsTabOrder = ['profile', 'wallet', 'notifications', 'api', 'linkpreviews', 'privacy', 'security', 'repair', 'about'];
        this.currentSettingsTabIndex = 0;
        this.isAnimating = false; // Prevent multiple simultaneous animations
    }

    /**
     * Set dependencies
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    // Convenience getters for managers
    get authManager() { return this.deps.authManager; }
    get secureStorage() { return this.deps.secureStorage; }
    get channelManager() { return this.deps.channelManager; }
    get streamrController() { return this.deps.streamrController; }
    get mediaController() { return this.deps.mediaController; }
    get identityManager() { return this.deps.identityManager; }
    get graphAPI() { return this.deps.graphAPI; }
    get Logger() { return this.deps.Logger; }
    get modalManager() { return this.deps.modalManager; }
    get notificationManager() { return this.deps.notificationManager; }
    get relayManager() { return this.deps.relayManager; }
    get notificationUI() { return this.deps.notificationUI; }
    get dmManager() { return this.deps.dmManager; }
    get showCreateDMInboxModal() { return this.deps.showCreateDMInboxModal; }
    get isMobileView() { return this.deps.isMobileView; }
    get showExploreView() { return this.deps.showExploreView; }

    /**
     * Show notification helper
     */
    showNotification(message, type) {
        this.deps.showNotification?.(message, type);
    }

    /**
     * Show progress modal for encryption/decryption operations
     */
    showProgressModal(title, subtitle) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
        modal.innerHTML = `
            <div class="bg-[#111113] rounded-2xl w-[300px] overflow-hidden shadow-2xl border border-white/[0.06]">
                <div class="px-5 pt-5 pb-2">
                    <h3 class="text-[14px] font-medium text-white">${_escapeHtml(title)}</h3>
                    <p class="text-[11px] text-white/30 mt-0.5">${_escapeHtml(subtitle)}</p>
                </div>
                <div class="px-5 pb-5 pt-3">
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="text-[10px] text-white/30">Progress</span>
                        <span class="text-[10px] font-medium text-white" id="progress-label">0%</span>
                    </div>
                    <div class="h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
                        <div id="progress-bar" class="h-full bg-white transition-all duration-300 ease-out" style="width: 0%"></div>
                    </div>
                    <p class="text-[10px] text-white/25 text-center mt-3">This may take a few seconds...</p>
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
     * Initialize export private key UI handlers
     */
    initExportPrivateKeyUI() {
        const exportKeyPassword = document.getElementById('export-key-password');
        const unlockBtn = document.getElementById('unlock-private-key-btn');
        const step1 = document.getElementById('export-key-step1');
        const step2 = document.getElementById('export-key-step2');
        const privateKeyDisplay = document.getElementById('private-key-display');
        const toggleVisibilityBtn = document.getElementById('toggle-key-visibility');
        const copyKeyBtn = document.getElementById('copy-private-key-btn');
        const copyKeyProgress = document.getElementById('copy-key-progress');
        const copyKeyText = document.getElementById('copy-key-text');
        const lockBtn = document.getElementById('lock-private-key-btn');

        let unlockedPrivateKey = null;
        let holdTimer = null;
        let isKeyVisible = false;

        // Unlock private key
        if (unlockBtn) {
            unlockBtn.addEventListener('click', async () => {
                const password = exportKeyPassword?.value;
                if (!password) {
                    this.showNotification('Please enter your password', 'error');
                    return;
                }

                try {
                    unlockBtn.disabled = true;
                    unlockBtn.textContent = '🔄 Verifying...';
                    
                    unlockedPrivateKey = await this.authManager.getPrivateKey(password);
                    
                    // Show step 2
                    step1?.classList.add('hidden');
                    step2?.classList.remove('hidden');
                    
                    // Display masked key
                    if (privateKeyDisplay) {
                        privateKeyDisplay.value = unlockedPrivateKey;
                        privateKeyDisplay.type = 'password';
                        isKeyVisible = false;
                    }
                    
                    this.showNotification('Private key unlocked!', 'success');
                } catch (error) {
                    this.showNotification(error.message || 'Failed to unlock', 'error');
                } finally {
                    unlockBtn.disabled = false;
                    unlockBtn.textContent = 'Unlock Key';
                    if (exportKeyPassword) exportKeyPassword.value = '';
                }
            });
        }

        // Toggle visibility
        if (toggleVisibilityBtn) {
            toggleVisibilityBtn.addEventListener('click', () => {
                if (privateKeyDisplay) {
                    isKeyVisible = !isKeyVisible;
                    privateKeyDisplay.type = isKeyVisible ? 'text' : 'password';
                    toggleVisibilityBtn.innerHTML = isKeyVisible 
                        ? '<svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/></svg>'
                        : '<svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';
                }
            });
        }

        // Long press to copy (2 seconds)
        if (copyKeyBtn) {
            const startHold = () => {
                if (!unlockedPrivateKey) return;
                
                copyKeyProgress?.classList.remove('-translate-x-full');
                copyKeyProgress?.classList.add('translate-x-0');
                if (copyKeyText) copyKeyText.textContent = 'Keep holding...';

                holdTimer = setTimeout(async () => {
                    try {
                        await navigator.clipboard.writeText(unlockedPrivateKey);
                        this.showNotification('Private key copied!', 'success');
                        if (copyKeyText) copyKeyText.textContent = 'Copied!';
                        
                        setTimeout(() => {
                            if (copyKeyText) copyKeyText.textContent = 'Hold to Copy Private Key (2s)';
                        }, 2000);
                    } catch (e) {
                        this.showNotification('Failed to copy', 'error');
                    }
                    resetProgress();
                }, 2000);
            };

            const resetProgress = () => {
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
                copyKeyProgress?.classList.remove('translate-x-0');
                copyKeyProgress?.classList.add('-translate-x-full');
                if (copyKeyText && copyKeyText.textContent === 'Keep holding...') {
                    copyKeyText.textContent = 'Hold to Copy Private Key (2s)';
                }
            };

            copyKeyBtn.addEventListener('mousedown', startHold);
            copyKeyBtn.addEventListener('touchstart', startHold);
            copyKeyBtn.addEventListener('mouseup', resetProgress);
            copyKeyBtn.addEventListener('mouseleave', resetProgress);
            copyKeyBtn.addEventListener('touchend', resetProgress);
            copyKeyBtn.addEventListener('touchcancel', resetProgress);
        }

        // Lock (reset to step 1)
        if (lockBtn) {
            lockBtn.addEventListener('click', () => {
                unlockedPrivateKey = null;
                step2?.classList.add('hidden');
                step1?.classList.remove('hidden');
                if (privateKeyDisplay) {
                    privateKeyDisplay.value = '';
                    privateKeyDisplay.type = 'password';
                }
                isKeyVisible = false;
                if (toggleVisibilityBtn) toggleVisibilityBtn.innerHTML = '<svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';
                this.showNotification('Private key locked', 'info');
            });
        }
    }

    /**
     * Initialize backup/restore UI handlers
     */
    initBackupRestoreUI(showPasswordPrompt) {
        const exportBtn = document.getElementById('export-all-data-btn');
        const importBtn = document.getElementById('import-data-btn');
        const importFileInput = document.getElementById('import-data-file');

        // Export account backup (uses account password with scrypt)
        if (exportBtn) {
            exportBtn.addEventListener('click', async () => {
                try {
                    if (!this.secureStorage.isStorageUnlocked()) {
                        this.showNotification('Please unlock account first', 'error');
                        return;
                    }

                    // Get account password (same as keystore password)
                    const password = await showPasswordPrompt(
                        'Export Account Backup',
                        'Enter your account password to create a backup.',
                        false
                    );
                    if (!password) return;

                    // Get current account's keystore
                    const address = this.authManager.getAddress();
                    const keystoreJson = this.authManager.exportKeystore(address);
                    if (!keystoreJson) {
                        this.showNotification('No keystore found for this account', 'error');
                        return;
                    }
                    const keystore = JSON.parse(keystoreJson);

                    // Show progress modal - Step 1: Verify password
                    const progressModal = this.showProgressModal(
                        'Creating Backup',
                        'Verifying password...'
                    );

                    try {
                        // First verify password against keystore (prevents wrong password in backup)
                        try {
                            await ethers.Wallet.fromEncryptedJson(
                                keystoreJson,
                                password,
                                (progress) => this.updateProgressModal(progressModal, progress * 0.4)
                            );
                        } catch (verifyError) {
                            this.hideProgressModal(progressModal);
                            this.showNotification('Wrong password', 'error');
                            return;
                        }

                        // Password verified - now create backup
                        this.updateProgressModal(progressModal, 0.4);
                        progressModal.querySelector('p')?.textContent && 
                            (progressModal.querySelector('p').textContent = 'Encrypting data with scrypt...');

                        // Create backup with scrypt (progress 0.4 to 1.0)
                        const backup = await this.secureStorage.exportAccountBackup(
                            keystore,
                            password,
                            (progress) => this.updateProgressModal(progressModal, 0.4 + progress * 0.6)
                        );

                        this.hideProgressModal(progressModal);

                        // Download backup file
                        const json = JSON.stringify(backup, null, 2);
                        const blob = new Blob([json], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        
                        const timestamp = new Date().toISOString().slice(0, 10);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `pombo-account-backup-${timestamp}.json`;
                        a.click();
                        
                        URL.revokeObjectURL(url);
                        this.showNotification('Account backup exported!', 'success');
                    } catch (exportError) {
                        this.hideProgressModal(progressModal);
                        // Check if password was wrong (scrypt will fail silently, but we can detect)
                        this.showNotification('Failed to export: ' + exportError.message, 'error');
                    }
                } catch (error) {
                    this.Logger?.error('Export failed:', error);
                    this.showNotification('Failed to export: ' + error.message, 'error');
                }
            });
        }

        // Import encrypted data
        if (importBtn && importFileInput) {
            importBtn.addEventListener('click', () => {
                importFileInput.click();
            });

            importFileInput.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;

                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    
                    if (data.format === 'pombo-account-backup' && data.version === 1) {
                        // Scrypt-encrypted account backup
                        await this.handleAccountBackupImport(data, showPasswordPrompt);
                    }
                    else {
                        throw new Error('Unknown backup format. Only pombo-account-backup v1 is supported.');
                    }
                } catch (error) {
                    this.Logger?.error('Import failed:', error);
                    this.showNotification('Failed to import: ' + error.message, 'error');
                } finally {
                    importFileInput.value = '';
                }
            });
        }
    }

    /**
     * Initialize delete account UI handlers
     */
    initDeleteAccountUI() {
        const deletePasswordInput = document.getElementById('delete-account-password');
        const verifyBtn = document.getElementById('verify-delete-account-btn');
        const step1 = document.getElementById('delete-account-step1');
        const step2 = document.getElementById('delete-account-step2');
        const deleteBtn = document.getElementById('delete-account-btn');
        const deleteProgress = document.getElementById('delete-account-progress');
        const deleteText = document.getElementById('delete-account-text');
        const cancelBtn = document.getElementById('cancel-delete-account-btn');

        let isPasswordVerified = false;
        let holdTimer = null;

        // Verify password
        if (verifyBtn) {
            verifyBtn.addEventListener('click', async () => {
                const password = deletePasswordInput?.value;
                if (!password) {
                    this.showNotification('Please enter your password', 'error');
                    return;
                }

                try {
                    verifyBtn.disabled = true;
                    verifyBtn.textContent = '🔄 Verifying...';
                    
                    await this.authManager.getPrivateKey(password);
                    
                    isPasswordVerified = true;
                    step1?.classList.add('hidden');
                    step2?.classList.remove('hidden');
                    
                    this.showNotification('Password verified', 'success');
                } catch (error) {
                    this.showNotification('Incorrect password', 'error');
                } finally {
                    verifyBtn.disabled = false;
                    verifyBtn.textContent = 'Verify Password';
                    if (deletePasswordInput) deletePasswordInput.value = '';
                }
            });
        }

        // Cancel - back to step 1
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                isPasswordVerified = false;
                step2?.classList.add('hidden');
                step1?.classList.remove('hidden');
            });
        }

        // Long press to delete (2 seconds)
        if (deleteBtn) {
            const startHold = () => {
                if (!isPasswordVerified) return;
                
                deleteProgress?.classList.remove('-translate-x-full');
                deleteProgress?.classList.add('translate-x-0');
                if (deleteText) deleteText.textContent = 'Keep holding...';

                holdTimer = setTimeout(async () => {
                    try {
                        const currentAddress = this.authManager.getAddress();
                        if (!currentAddress) {
                            throw new Error('No account connected');
                        }

                        // 1. Stop presence tracking
                        this.channelManager.stopPresenceTracking();

                        // 2. Destroy DM manager (unsubscribes inbox)
                        this.dmManager?.destroy();

                        // 3. Leave all channels
                        await this.channelManager.leaveAllChannels();

                        // 4. Destroy Streamr client
                        await this.streamrController.disconnect();

                        // 5. Clear seed files
                        await this.mediaController.clearSeedFilesForOwner(currentAddress);

                        // 6. Reset media controller
                        this.mediaController.reset();

                        // 7. Delete encrypted storage
                        await this.secureStorage.deletePersistentState(currentAddress);

                        // 8. Lock secure storage
                        this.secureStorage.lock();

                        // 9. Delete wallet keystore
                        this.authManager.deleteWallet(currentAddress);
                        
                        this.showNotification('Account deleted successfully', 'success');
                        
                        // Close modal & update UI via callbacks
                        this.modalManager?.hide('settings-modal');
                        
                        this.deps.updateWalletInfo?.(null);
                        this.deps.updateNetworkStatus?.('Disconnected', false);
                        this.deps.renderChannelList?.();
                        this.deps.resetToDisconnectedState?.();
                        
                        // Check for other accounts
                        if (this.authManager.hasSavedWallet()) {
                            setTimeout(() => {
                                this.deps.connectWallet?.();
                            }, 500);
                        }
                    } catch (e) {
                        this.Logger?.error('Failed to delete account:', e);
                        this.showNotification('Failed to delete: ' + e.message, 'error');
                    }
                    resetProgress();
                }, 2000);
            };

            const resetProgress = () => {
                if (holdTimer) {
                    clearTimeout(holdTimer);
                    holdTimer = null;
                }
                deleteProgress?.classList.remove('translate-x-0');
                deleteProgress?.classList.add('-translate-x-full');
                if (deleteText && deleteText.textContent === 'Keep holding...') {
                    deleteText.textContent = 'Hold to Delete (2s)';
                }
            };

            deleteBtn.addEventListener('mousedown', startHold);
            deleteBtn.addEventListener('touchstart', startHold);
            deleteBtn.addEventListener('mouseup', resetProgress);
            deleteBtn.addEventListener('mouseleave', resetProgress);
            deleteBtn.addEventListener('touchend', resetProgress);
            deleteBtn.addEventListener('touchcancel', resetProgress);
        }
    }

    /**
     * Handle new account backup import (pombo-account-backup v1)
     * This imports data (channels, contacts) from a backup into the current account
     */
    async handleAccountBackupImport(backup, showPasswordPrompt) {
        if (!this.secureStorage.isStorageUnlocked()) {
            this.showNotification('Please unlock account to import data', 'error');
            return;
        }

        const password = await showPasswordPrompt(
            'Decrypt Backup',
            'Enter the password used for this backup.',
            false
        );
        if (!password) return;

        // Show progress modal
        const progressModal = this.showProgressModal(
            'Restoring Backup',
            'Unlocking your data...'
        );

        try {
            // Decrypt the backup
            const result = await this.secureStorage.importAccountBackup(
                backup,
                password,
                (progress) => this.updateProgressModal(progressModal, progress)
            );

            this.hideProgressModal(progressModal);

            // Check if backup is from a different account
            const currentAddress = this.authManager.getAddress()?.toLowerCase();
            const backupAddress = result.address?.toLowerCase();
            
            if (backupAddress && currentAddress && backupAddress !== currentAddress) {
                const confirmed = confirm(
                    `This backup is from a different account:\n\n` +
                    `Backup: ${backupAddress.slice(0, 8)}...${backupAddress.slice(-6)}\n` +
                    `Current: ${currentAddress.slice(0, 8)}...${currentAddress.slice(-6)}\n\n` +
                    `Import channels and contacts to your current account?`
                );
                if (!confirmed) return;
            }

            // Import data into current account's secure storage
            const data = result.data;
            let channelsImported = 0;
            let contactsImported = 0;

            // Import channels
            if (data.channels && data.channels.length > 0) {
                const existingIds = new Set((this.secureStorage.cache.channels || []).map(c => c.messageStreamId || c.streamId));
                for (const channel of data.channels) {
                    const chId = channel.messageStreamId || channel.streamId;
                    if (chId && !existingIds.has(chId)) {
                        this.secureStorage.cache.channels.push(channel);
                        channelsImported++;
                    }
                }
            }

            // Import trusted contacts
            if (data.trustedContacts) {
                for (const [addr, contact] of Object.entries(data.trustedContacts)) {
                    if (!this.secureStorage.cache.trustedContacts[addr]) {
                        this.secureStorage.cache.trustedContacts[addr] = contact;
                        contactsImported++;
                    }
                }
            }

            // Import sent DM messages
            let dmImported = 0;
            if (data.sentMessages) {
                if (!this.secureStorage.cache.sentMessages) {
                    this.secureStorage.cache.sentMessages = {};
                }
                for (const [streamId, msgs] of Object.entries(data.sentMessages)) {
                    if (!this.secureStorage.cache.sentMessages[streamId]) {
                        this.secureStorage.cache.sentMessages[streamId] = msgs;
                        dmImported++;
                    }
                }
            }

            // Import sent DM reactions
            if (data.sentReactions) {
                if (!this.secureStorage.cache.sentReactions) {
                    this.secureStorage.cache.sentReactions = {};
                }
                for (const [streamId, reactions] of Object.entries(data.sentReactions)) {
                    if (!this.secureStorage.cache.sentReactions[streamId]) {
                        this.secureStorage.cache.sentReactions[streamId] = reactions;
                        dmImported++;
                    }
                }
            }

            // Import username (only if not set)
            if (data.username && !this.secureStorage.cache.username) {
                this.secureStorage.cache.username = data.username;
            }

            // Import blocked peers (union — never lose a block)
            if (data.blockedPeers && data.blockedPeers.length > 0) {
                if (!this.secureStorage.cache.blockedPeers) {
                    this.secureStorage.cache.blockedPeers = [];
                }
                for (const addr of data.blockedPeers) {
                    const normalized = addr.toLowerCase();
                    if (!this.secureStorage.cache.blockedPeers.includes(normalized)) {
                        this.secureStorage.cache.blockedPeers.push(normalized);
                    }
                }
            }

            // Import DM left-at timestamps (don't overwrite existing)
            if (data.dmLeftAt) {
                if (!this.secureStorage.cache.dmLeftAt) {
                    this.secureStorage.cache.dmLeftAt = {};
                }
                for (const [peer, ts] of Object.entries(data.dmLeftAt)) {
                    if (!this.secureStorage.cache.dmLeftAt[peer]) {
                        this.secureStorage.cache.dmLeftAt[peer] = ts;
                    }
                }
            }

            // Save
            await this.secureStorage.saveToStorage();

            // Import image blobs from backup into IDB ledger
            if (result.imageBlobs && result.imageBlobs.length > 0) {
                await this.secureStorage.importImageBlobs(result.imageBlobs);
            }

            this.showNotification(
                `Imported: ${channelsImported} channels, ${contactsImported} contacts` +
                (dmImported > 0 ? `, ${dmImported} DM histories` : ''),
                'success'
            );

            if (channelsImported > 0) {
                this.channelManager.loadChannels();
                this.deps.renderChannelList?.();
            }

            // Reload trusted contacts in identity manager
            if (contactsImported > 0) {
                this.identityManager?.loadTrustedContacts?.();
            }

        } catch (error) {
            this.hideProgressModal(progressModal);
            this.Logger?.error('Account backup import failed:', error);
            this.showNotification('Failed to import: ' + error.message, 'error');
        }
    }

    /**
     * Update Graph API status display
     */
    async updateGraphApiStatus(graphApiStatusEl) {
        if (!graphApiStatusEl || !this.graphAPI) return;
        
        const isValid = await this.graphAPI.validateKey();
        const isDefault = this.graphAPI.isUsingDefaultKey();
        
        if (isDefault) {
            graphApiStatusEl.textContent = 'Using default key';
            graphApiStatusEl.className = 'text-xs text-yellow-500';
        } else if (isValid) {
            graphApiStatusEl.textContent = 'Valid';
            graphApiStatusEl.className = 'text-xs text-green-500';
        } else {
            graphApiStatusEl.textContent = 'Invalid key';
            graphApiStatusEl.className = 'text-xs text-red-500';
        }
    }

    /**
     * Reset export key UI to initial state
     */
    resetExportKeyUI() {
        document.getElementById('export-key-step1')?.classList.remove('hidden');
        document.getElementById('export-key-step2')?.classList.add('hidden');
        const exportKeyPassword = document.getElementById('export-key-password');
        if (exportKeyPassword) exportKeyPassword.value = '';
    }

    /**
     * Reset delete account UI to initial state
     */
    resetDeleteAccountUI() {
        document.getElementById('delete-account-step1')?.classList.remove('hidden');
        document.getElementById('delete-account-step2')?.classList.add('hidden');
        const deleteAccountPassword = document.getElementById('delete-account-password');
        if (deleteAccountPassword) deleteAccountPassword.value = '';
    }

    /**
     * Initialize all settings UI
     */
    init() {
        // Cache elements
        this.elements.settingsBtn = document.getElementById('settings-btn');
        this.elements.settingsModal = document.getElementById('settings-modal');
        this.elements.closeSettingsBtn = document.getElementById('close-settings-btn');
        this.elements.notificationsEnabled = document.getElementById('notifications-enabled');
        this.elements.notificationsStatus = document.getElementById('notifications-status');
        this.elements.pushNotificationsEnabled = document.getElementById('push-notifications-enabled');
        this.elements.pushNotificationsStatus = document.getElementById('push-notifications-status');
        this.elements.dmPushEnabled = document.getElementById('dm-push-enabled');
        this.elements.dmPushSection = document.getElementById('dm-push-section');
        this.elements.settingsUsername = document.getElementById('settings-username');
        this.elements.settingsAddress = document.getElementById('settings-address');
        this.elements.copyOwnAddressBtn = document.getElementById('copy-own-address-btn');
        this.elements.settingsGraphApiKey = document.getElementById('settings-graph-api-key');
        this.elements.graphApiStatus = document.getElementById('graph-api-status');

        // Cache tab elements
        this.elements.settingsTabs = document.querySelectorAll('.settings-tab');
        this.elements.settingsPanels = document.querySelectorAll('.settings-panel');

        // Initialize tabs navigation
        this.initSettingsTabs();

        // Desktop settings button event
        document.addEventListener('pombo:open-settings', () => this.show());

        // Close settings modal
        if (this.elements.closeSettingsBtn) {
            this.elements.closeSettingsBtn.addEventListener('click', () => this.hide());
        }
        
        // Register onHide callback for back button and programmatic hide
        this.modalManager?.registerOnHide('settings-modal', () => this._cleanupOnHide());

        // Click outside settings modal to close (desktop only - on mobile it's a full-screen container)
        if (this.elements.settingsModal) {
            this.elements.settingsModal.addEventListener('click', (e) => {
                if (e.target === this.elements.settingsModal && this.isMobileView && !this.isMobileView()) {
                    this.hide();
                }
            });
        }

        // Notifications toggle (on-chain invites)
        if (this.elements.notificationsEnabled) {
            this.elements.notificationsEnabled.addEventListener('change', (e) => this.handleNotificationsToggle(e));
        }

        // Push notifications toggle
        if (this.elements.pushNotificationsEnabled) {
            this.elements.pushNotificationsEnabled.addEventListener('change', (e) => this.handlePushNotificationsToggle(e));
        }

        // DM push notifications toggle
        if (this.elements.dmPushEnabled) {
            this.elements.dmPushEnabled.addEventListener('change', (e) => this.handleDMPushToggle(e));
        }

        // Push learn more modal
        const pushLearnMoreBtn = document.getElementById('push-learn-more-btn');
        const pushLearnMoreModal = document.getElementById('push-learn-more-modal');
        const closePushLearnMoreBtn = document.getElementById('close-push-learn-more-btn');
        if (pushLearnMoreBtn && pushLearnMoreModal) {
            pushLearnMoreBtn.addEventListener('click', () => pushLearnMoreModal.classList.remove('hidden'));
            closePushLearnMoreBtn?.addEventListener('click', () => pushLearnMoreModal.classList.add('hidden'));
            pushLearnMoreModal.addEventListener('click', (e) => {
                if (e.target === pushLearnMoreModal) pushLearnMoreModal.classList.add('hidden');
            });
        }

        // Username change
        if (this.elements.settingsUsername) {
            this.elements.settingsUsername.addEventListener('change', async (e) => {
                // Block local name changes when ENS is active
                if (e.target.disabled) return;
                const newName = e.target.value;
                try {
                    await this.identityManager.setUsername(newName);
                    this.authManager.updateWalletName(newName || null);
                    this.deps.updateDisplayName?.(newName || null);
                    this.showNotification('Username updated!', 'success');
                } catch (err) {
                    this.showNotification('Failed to update username', 'error');
                }
            });
        }

        // Copy address from settings
        if (this.elements.copyOwnAddressBtn) {
            this.elements.copyOwnAddressBtn.addEventListener('click', () => this.copyOwnAddress());
        }

        // Refresh balance button
        const refreshBalanceBtn = document.getElementById('refresh-balance-btn');
        if (refreshBalanceBtn) {
            refreshBalanceBtn.addEventListener('click', () => {
                const address = this.authManager.getAddress();
                this.updateBalanceDisplay(address);
            });
        }

        // Fund with MetaMask button
        const fundMetaMaskBtn = document.getElementById('fund-metamask-btn');
        if (fundMetaMaskBtn) {
            fundMetaMaskBtn.addEventListener('click', () => this.handleFundWithMetaMask());
        }

        // Graph API key change
        if (this.elements.settingsGraphApiKey) {
            this.elements.settingsGraphApiKey.addEventListener('change', async (e) => {
                const newKey = e.target.value.trim();
                await this.graphAPI.setApiKey(newKey || null);
                await this.updateGraphApiStatusDisplay();
                this.showNotification('Graph API key updated!', 'success');
            });
        }

        // Initialize RPC settings
        this.initRpcSettings();

        // Initialize export private key functionality
        this.initExportPrivateKeyUI();

        // Initialize backup/restore functionality
        this.initBackupRestoreUI((title, desc, confirm) => this.showPasswordPrompt(title, desc, confirm));

        // Initialize delete account functionality
        this.initDeleteAccountUI();

        // NSFW toggle
        const nsfwToggle = document.getElementById('nsfw-enabled');
        if (nsfwToggle) {
            nsfwToggle.addEventListener('change', async (e) => {
                await this.secureStorage.setNsfwEnabled(e.target.checked);
                const exploreView = document.querySelector('.explore-view');
                if (exploreView && this.showExploreView) {
                    this.showExploreView();
                }
            });
        }

        // YouTube embeds toggle
        const youtubeEmbedsToggle = document.getElementById('youtube-embeds-enabled');
        if (youtubeEmbedsToggle) {
            youtubeEmbedsToggle.addEventListener('change', async (e) => {
                await this.secureStorage.setYouTubeEmbedsEnabled(e.target.checked);
            });
        }

        // Initialize repair inbox UI
        this.initRepairUI();
    }

    /**
     * Show settings modal
     */
    async show() {
        if (this.elements.settingsModal) {
            // Update username field — if user has ENS, show it and disable local name editing
            const address = this.authManager.getAddress();
            const ensName = address ? await this.identityManager.resolveENS(address) : null;

            // Update avatar in settings profile
            const avatarContainer = document.getElementById('settings-avatar-container');
            if (avatarContainer && address) {
                const ensAvatar = this.identityManager.getCachedENSAvatar(address);
                avatarContainer.innerHTML = `<div class="w-14 h-14 rounded-lg overflow-hidden border border-white/[0.08]">${getAvatarHtml(address, 56, 0.2, ensAvatar)}</div>`;
            }

            if (this.elements.settingsUsername) {
                if (ensName) {
                    this.elements.settingsUsername.value = ensName;
                    this.elements.settingsUsername.disabled = true;
                    this.elements.settingsUsername.title = 'Name is set via ENS (Primary Name)';
                    // Show ENS badge hint below input
                    let ensHint = document.getElementById('ens-name-hint');
                    if (!ensHint) {
                        ensHint = document.createElement('p');
                        ensHint.id = 'ens-name-hint';
                        ensHint.className = 'text-xs text-blue-400 mt-2 flex items-center gap-1';
                        this.elements.settingsUsername.parentNode.appendChild(ensHint);
                    }
                    ensHint.innerHTML = '<svg class="inline-block" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#4ade80" stroke-width="2" fill="none"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg> ENS Verified';
                    ensHint.classList.remove('hidden');
                    // Hide the default hint
                    const defaultHint = this.elements.settingsUsername.parentNode.querySelector('p.text-white\\/30');
                    if (defaultHint && defaultHint !== ensHint) defaultHint.classList.add('hidden');
                } else {
                    const username = this.identityManager.getUsername();
                    this.elements.settingsUsername.value = username || '';
                    this.elements.settingsUsername.disabled = false;
                    this.elements.settingsUsername.title = '';
                    const ensHint = document.getElementById('ens-name-hint');
                    if (ensHint) ensHint.classList.add('hidden');
                    const defaultHint = this.elements.settingsUsername.parentNode.querySelector('p.text-white\\/30:not(#ens-name-hint)');
                    if (defaultHint) defaultHint.classList.remove('hidden');
                }
            }

            // Update address field
            if (this.elements.settingsAddress) {
                this.elements.settingsAddress.value = address || '';
            }

            // Update balance field
            this.updateBalanceDisplay(address);

            // Channel invites mute toggle
            const isMuted = this.notificationManager?.isMuted();
            if (this.elements.notificationsEnabled) {
                this.elements.notificationsEnabled.checked = !isMuted;
            }
            if (this.elements.notificationsStatus) {
                this.elements.notificationsStatus.textContent = isMuted ? 'Muted' : '';
                this.elements.notificationsStatus.className = isMuted 
                    ? 'text-xs text-white/40' 
                    : 'text-xs text-white/40';
            }

            // Update push notifications toggle state
            const pushEnabled = this.relayManager?.enabled;
            if (this.elements.pushNotificationsEnabled) {
                this.elements.pushNotificationsEnabled.checked = pushEnabled || false;
            }
            this.updatePushNotificationsStatus();

            // Update Graph API key field
            if (this.elements.settingsGraphApiKey) {
                const currentKey = this.graphAPI.isUsingDefaultKey() ? '' : this.graphAPI.getApiKey();
                this.elements.settingsGraphApiKey.value = currentKey;
            }
            await this.updateGraphApiStatusDisplay();

            // Update RPC settings display
            this.updateRpcStatusDisplay();

            // Update NSFW toggle state
            const nsfwToggle = document.getElementById('nsfw-enabled');
            if (nsfwToggle) {
                nsfwToggle.checked = this.secureStorage.getNsfwEnabled();
            }

            // Update YouTube embeds toggle state
            const youtubeEmbedsToggle = document.getElementById('youtube-embeds-enabled');
            if (youtubeEmbedsToggle) {
                youtubeEmbedsToggle.checked = this.secureStorage.getYouTubeEmbedsEnabled();
            }

            // Select first tab by default
            this.selectSettingsTab('profile');

            // Reset private key export UI to step 1
            this.resetExportKeyUI();

            // Reset delete account UI to step 1
            this.resetDeleteAccountUI();

            // Add settings-open class for mobile slide-in effect
            if (this.isMobileView && this.isMobileView()) {
                // Add settings-open class FIRST (before closing contacts)
                // so that contacts _cleanupOnHide knows we're switching tabs
                document.body.classList.add('settings-open');
                
                // Close contacts modal if open (always use modalManager to keep stack in sync)
                // Use skipHistory to prevent async history.back() from closing settings modal
                if (this.modalManager?.isVisible('contacts-modal')) {
                    if (this.deps.contactsUI?.hide) {
                        this.deps.contactsUI.hide({ skipHistory: true });
                    } else {
                        // Fallback: use modalManager to ensure stack stays in sync
                        this.modalManager?.hide('contacts-modal', { skipHistory: true });
                        document.body.classList.remove('contacts-open');
                    }
                }
                // Update pill nav active tab
                document.querySelectorAll('.pill-nav-item[data-pill-tab]').forEach(item => {
                    item.classList.toggle('active', item.dataset.pillTab === 'settings');
                });
            }

            this.modalManager?.show('settings-modal');
        }
    }

    /**
     * Cleanup when settings modal is hidden (called by modalManager callback)
     * @private
     */
    _cleanupOnHide() {
        // Remove settings-open class for mobile
        document.body.classList.remove('settings-open');
        // Clear active tab highlight from settings dropdown
        document.querySelectorAll('#pill-settings-dropdown .pill-dropdown-item[data-settings-tab]').forEach(item => {
            item.classList.remove('active-tab');
        });
        // Only reset pill nav to chats if still on settings tab
        // If pill was already switched (e.g. to explore), don't override
        const activeTab = document.querySelector('.pill-nav-item[data-pill-tab].active');
        if (!activeTab || activeTab.dataset.pillTab === 'settings') {
            if (!document.body.classList.contains('contacts-open')) {
                document.querySelectorAll('.pill-nav-item[data-pill-tab]').forEach(item => {
                    item.classList.toggle('active', item.dataset.pillTab === 'chats');
                });
            }
        }
    }

    /**
     * Hide settings modal
     * @param {Object} options - Optional config { skipHistory: boolean }
     */
    hide(options = {}) {
        this.modalManager?.hide('settings-modal', options);
    }

    /**
     * Initialize settings tabs navigation
     */
    initSettingsTabs() {
        if (this.elements.settingsTabs) {
            this.elements.settingsTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const tabName = tab.dataset.settingsTab;
                    this.selectSettingsTab(tabName);
                });
            });
        }
        this.initSettingsCarousel();
        this.initPillSettingsDropdown();
    }

    /**
     * Initialize pill settings dropdown for mobile
     */
    initPillSettingsDropdown() {
        const settingsBtn = document.getElementById('settings-btn');
        const dropdown = document.getElementById('pill-settings-dropdown');
        if (!settingsBtn || !dropdown) return;

        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close profile dropdown if open
            document.getElementById('pill-profile-dropdown')?.classList.add('hidden');
            dropdown.classList.toggle('hidden');
        });

        // Tab items in dropdown
        dropdown.querySelectorAll('.pill-dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const tabName = item.dataset.settingsTab;
                if (tabName) {
                    dropdown.classList.add('hidden');
                    this.show().then(() => {
                        this.selectSettingsTab(tabName);
                    });
                }
            });
        });

        // Close dropdown on outside click
        document.addEventListener('click', (e) => {
            if (!settingsBtn.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });
    }

    /**
     * Initialize settings carousel for mobile
     */
    initSettingsCarousel() {
        const carousel = document.getElementById('settings-carousel');
        const modal = document.getElementById('settings-modal');
        if (!carousel || !modal) return;

        const tabElements = carousel.querySelectorAll('.carousel-tab');

        tabElements.forEach((tab, index) => {
            tab.addEventListener('click', () => {
                if (index === 0) {
                    this.navigateSettingsCarousel(-1);
                } else if (index === 2) {
                    this.navigateSettingsCarousel(1);
                }
            });
        });

        // Add swipe support on entire modal
        let touchStartX = 0;
        let touchStartY = 0;
        let isSwiping = false;
        
        const modalContainer = modal.querySelector('.bg-\\[\\#111113\\]');
        if (!modalContainer) return;

        modalContainer.addEventListener('touchstart', (e) => {
            const target = e.target;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
                isSwiping = false;
                return;
            }
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: true });

        modalContainer.addEventListener('touchend', (e) => {
            if (!isSwiping || (this.isMobileView && !this.isMobileView())) return;
            
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const diffX = touchStartX - touchEndX;
            const diffY = touchStartY - touchEndY;
            
            if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
                // Infinite carousel - always navigate (loops around)
                this.navigateSettingsCarousel(diffX > 0 ? 1 : -1);
            }
            isSwiping = false;
        }, { passive: true });
    }

    /**
     * Navigate carousel by offset (-1 for prev, +1 for next)
     */
    navigateSettingsCarousel(offset) {
        // Prevent multiple simultaneous animations
        if (this.isAnimating) return;
        
        const total = this.settingsTabOrder.length;
        this.currentSettingsTabIndex = (this.currentSettingsTabIndex + offset + total) % total;
        const tabName = this.settingsTabOrder[this.currentSettingsTabIndex];
        this.selectSettingsTab(tabName, offset);
    }

    /**
     * Update carousel display with current, prev, and next tabs
     * @param {string} tabName - Current tab name
     * @param {number} direction - Direction of navigation for animation (-1, 0, or 1)
     */
    updateSettingsCarousel(tabName, direction = 0) {
        const carousel = document.getElementById('settings-carousel');
        if (!carousel) return;

        const tabsContainer = carousel.querySelector('.carousel-tabs');
        const tabs = carousel.querySelectorAll('.carousel-tab');
        if (tabs.length !== 3 || !tabsContainer) return;

        const total = this.settingsTabOrder.length;
        const currentIndex = this.settingsTabOrder.indexOf(tabName);
        if (currentIndex === -1) return;

        this.currentSettingsTabIndex = currentIndex;

        const prevIndex = (currentIndex - 1 + total) % total;
        const nextIndex = (currentIndex + 1) % total;

        const tabLabels = {
            'profile': 'Account',
            'wallet': 'Wallet',
            'notifications': 'Notifications',
            'api': 'API',
            'linkpreviews': 'Content',
            'privacy': 'Privacy',
            'security': 'Security',
            'repair': 'Repair',
            'about': 'About'
        };

        const newLabels = [
            tabLabels[this.settingsTabOrder[prevIndex]],
            tabLabels[this.settingsTabOrder[currentIndex]],
            tabLabels[this.settingsTabOrder[nextIndex]]
        ];

        // Simple cross-fade animation for tabs
        if (direction !== 0) {
            // Fade out
            tabsContainer.style.transition = 'opacity 0.15s ease';
            tabsContainer.style.opacity = '0';
            
            setTimeout(() => {
                // Update labels while hidden
                tabs[0].textContent = newLabels[0];
                tabs[0].dataset.tab = this.settingsTabOrder[prevIndex];
                tabs[0].classList.remove('active');
                tabs[0].classList.add('adjacent');

                tabs[1].textContent = newLabels[1];
                tabs[1].dataset.tab = this.settingsTabOrder[currentIndex];
                tabs[1].classList.add('active');
                tabs[1].classList.remove('adjacent');

                tabs[2].textContent = newLabels[2];
                tabs[2].dataset.tab = this.settingsTabOrder[nextIndex];
                tabs[2].classList.remove('active');
                tabs[2].classList.add('adjacent');

                // Fade in
                tabsContainer.style.opacity = '1';
                
                setTimeout(() => {
                    tabsContainer.style.transition = '';
                    tabsContainer.style.opacity = '';
                }, 150);
            }, 150);
        } else {
            // Instant update (no animation)
            tabs[0].textContent = newLabels[0];
            tabs[0].dataset.tab = this.settingsTabOrder[prevIndex];
            tabs[0].classList.remove('active');
            tabs[0].classList.add('adjacent');

            tabs[1].textContent = newLabels[1];
            tabs[1].dataset.tab = this.settingsTabOrder[currentIndex];
            tabs[1].classList.add('active');
            tabs[1].classList.remove('adjacent');

            tabs[2].textContent = newLabels[2];
            tabs[2].dataset.tab = this.settingsTabOrder[nextIndex];
            tabs[2].classList.remove('active');
            tabs[2].classList.add('adjacent');
        }
    }

    /**
     * Select a settings tab
     * @param {string} tabName - Tab to select
     * @param {number} direction - Direction of navigation (-1 = left, 1 = right, 0 = direct click)
     */
    selectSettingsTab(tabName, direction = 0) {
        // Update settings dropdown active indicator
        document.querySelectorAll('#pill-settings-dropdown .pill-dropdown-item[data-settings-tab]').forEach(item => {
            item.classList.toggle('active-tab', item.dataset.settingsTab === tabName);
        });

        // Render blocked peers list when privacy tab is selected
        if (tabName === 'privacy') {
            this.renderBlockedPeersList();
        }

        // Auto-diagnose when repair tab is selected
        if (tabName === 'repair') {
            this.runDiagnosis();
        }

        // Start animation lock
        if (direction !== 0) {
            this.isAnimating = true;
        }

        this.elements.settingsTabs?.forEach(tab => {
            const isActive = tab.dataset.settingsTab === tabName;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('text-white/60', !isActive);
        });

        if (this.isMobileView && this.isMobileView()) {
            this.updateSettingsCarousel(tabName, direction);
        }

        // Animate panel transition on mobile
        const isMobile = this.isMobileView && this.isMobileView();
        
        if (isMobile && direction !== 0) {
            // Find current and target panels
            let currentPanel = null;
            let targetPanel = null;
            
            this.elements.settingsPanels?.forEach(panel => {
                const panelName = panel.id.replace('settings-panel-', '');
                if (panelName === tabName) {
                    targetPanel = panel;
                } else if (!panel.classList.contains('hidden')) {
                    currentPanel = panel;
                }
            });

            if (currentPanel && targetPanel) {
                // Simple cross-fade for panels (more reliable than slide)
                currentPanel.style.transition = 'opacity 0.2s ease';
                currentPanel.style.opacity = '0';
                
                setTimeout(() => {
                    currentPanel.classList.add('hidden');
                    currentPanel.style.transition = '';
                    currentPanel.style.opacity = '';
                    
                    targetPanel.classList.remove('hidden');
                    targetPanel.style.opacity = '0';
                    targetPanel.style.transition = 'opacity 0.2s ease';
                    
                    // Force reflow
                    targetPanel.offsetHeight;
                    
                    targetPanel.style.opacity = '1';
                    
                    setTimeout(() => {
                        targetPanel.style.transition = '';
                        targetPanel.style.opacity = '';
                        this.isAnimating = false;
                    }, 200);
                }, 200);
            } else if (targetPanel) {
                targetPanel.classList.remove('hidden');
                this.isAnimating = false;
            } else {
                this.isAnimating = false;
            }
        } else {
            // Instant switch (desktop or direct click)
            this.elements.settingsPanels?.forEach(panel => {
                const panelName = panel.id.replace('settings-panel-', '');
                const isTarget = panelName === tabName;
                panel.classList.toggle('hidden', !isTarget);
                panel.style.transition = '';
                panel.style.opacity = '';
                panel.style.transform = '';
            });
            this.isAnimating = false;
        }
    }

    /**
     * Render the blocked peers list in the Privacy panel
     */
    renderBlockedPeersList() {
        const container = document.getElementById('blocked-peers-list');
        if (!container) return;

        const blockedPeers = this.secureStorage.getBlockedPeers?.() || [];

        if (blockedPeers.length === 0) {
            container.innerHTML = '<p class="text-xs text-white/30 py-4 text-center">No blocked users</p>';
            return;
        }

        container.innerHTML = blockedPeers.map(addr => {
            const safe = _escapeAttr(addr);
            const short = _escapeHtml(addr.slice(0, 6) + '...' + addr.slice(-4));
            return `
                <div class="flex items-center justify-between py-2 px-3 bg-white/[0.03] rounded-lg group">
                    <span class="text-xs text-white/60 font-mono" title="${safe}">${short}</span>
                    <button class="unblock-peer-btn text-xs text-emerald-400 hover:text-emerald-300 opacity-60 hover:opacity-100 transition px-2 py-1 rounded hover:bg-emerald-500/10" data-address="${safe}">
                        Unblock
                    </button>
                </div>
            `;
        }).join('');

        // Attach unblock listeners
        container.querySelectorAll('.unblock-peer-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const address = btn.dataset.address;
                await this.secureStorage.removeBlockedPeer(address);
                this.showNotification('User unblocked', 'info');
                this.renderBlockedPeersList();
            });
        });
    }

    /**
     * Update Graph API status display
     */
    async updateGraphApiStatusDisplay() {
        if (!this.elements.graphApiStatus) return;
        
        const isDefault = this.graphAPI.isUsingDefaultKey();
        
        if (isDefault) {
            this.elements.graphApiStatus.innerHTML = '<span class="text-yellow-500 inline-flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>Using default key (rate limited)</span>';
        } else {
            this.elements.graphApiStatus.innerHTML = '<span class="text-white/30">Testing connection...</span>';
            const connected = await this.graphAPI.testConnection();
            if (connected) {
                this.elements.graphApiStatus.innerHTML = '<span class="text-green-500 inline-flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>Custom key active</span>';
            } else {
                this.elements.graphApiStatus.innerHTML = '<span class="text-red-500 inline-flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>Invalid key or connection failed</span>';
            }
        }
    }

    /**
     * Update POL balance display
     */
    async updateBalanceDisplay(address) {
        const balanceEl = document.getElementById('settings-balance');
        if (!balanceEl) return;
        
        if (!address) {
            balanceEl.textContent = 'Not connected';
            return;
        }
        
        balanceEl.textContent = 'Loading...';
        
        const balanceWei = await GasEstimator.getBalance(address);
        balanceEl.textContent = GasEstimator.formatBalancePOL(balanceWei);
    }

    /**
     * Copy own address to clipboard
     */
    async copyOwnAddress() {
        const address = this.authManager.getAddress();
        if (!address) return;
        
        try {
            await navigator.clipboard.writeText(address);
            this.showNotification('Address copied!', 'success');
        } catch {
            this.showNotification('Failed to copy', 'error');
        }
    }

    /**
     * Handle funding from MetaMask
     */
    async handleFundWithMetaMask() {
        const localAddress = this.authManager.getAddress();
        if (!localAddress) {
            this.showNotification('No account connected', 'error');
            return;
        }

        if (typeof window.ethereum === 'undefined') {
            this.showNotification('MetaMask not detected. Please install MetaMask.', 'error');
            window.open('https://metamask.io/download/', '_blank');
            return;
        }

        try {
            const accounts = await window.ethereum.request({ 
                method: 'eth_requestAccounts' 
            });
            
            if (!accounts || accounts.length === 0) {
                this.showNotification('MetaMask connection cancelled', 'error');
                return;
            }

            const metamaskAddress = accounts[0];

            const chainId = await window.ethereum.request({ method: 'eth_chainId' });
            if (chainId !== '0x89') {
                try {
                    await window.ethereum.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: '0x89' }],
                    });
                } catch (switchError) {
                    if (switchError.code === 4902) {
                        await window.ethereum.request({
                            method: 'wallet_addEthereumChain',
                            params: [getNetworkParams()],
                        });
                    } else {
                        throw switchError;
                    }
                }
            }

            const amount = await this.showFundAmountPrompt();
            if (!amount) return;

            const amountWei = BigInt(Math.floor(parseFloat(amount) * 1e18));
            const amountHex = '0x' + amountWei.toString(16);

            this.showNotification('Confirm transaction in MetaMask...', 'info');
            
            const txHash = await window.ethereum.request({
                method: 'eth_sendTransaction',
                params: [{
                    from: metamaskAddress,
                    to: localAddress,
                    value: amountHex,
                }],
            });

            this.showNotification('Transaction sent! Waiting for confirmation...', 'info');

            let receipt = null;
            while (!receipt) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                receipt = await window.ethereum.request({
                    method: 'eth_getTransactionReceipt',
                    params: [txHash],
                });
            }

            if (receipt.status === '0x1') {
                this.showNotification(`Funded ${amount} POL successfully!`, 'success');
                this.updateBalanceDisplay(localAddress);
            } else {
                this.showNotification('Transaction failed', 'error');
            }

        } catch (error) {
            this.Logger?.error('MetaMask funding error:', error);
            if (error.code === 4001) {
                this.showNotification('Transaction cancelled', 'error');
            } else {
                this.showNotification('Error: ' + (error.message || 'Unknown error'), 'error');
            }
        }
    }

    /**
     * Show amount prompt for MetaMask funding
     */
    async showFundAmountPrompt() {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl w-[320px] overflow-hidden shadow-2xl border border-white/[0.06]">
                    <div class="px-5 pt-5 pb-4">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">Fund Account</h3>
                            <button id="close-fund-modal" class="text-white/30 hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div class="px-5 pb-5">
                        <input
                            type="number"
                            id="fund-amount"
                            placeholder="Amount in POL"
                            step="1"
                            min="1"
                            class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-[#8247E5]/50 transition placeholder:text-white/30 mb-3"
                        />
                        <div class="flex gap-2 mb-4">
                            <button class="fund-preset flex-1 bg-white/5 hover:bg-white/10 text-white/60 px-2 py-1.5 rounded-lg text-xs transition whitespace-nowrap" data-amount="5">5 POL</button>
                            <button class="fund-preset flex-1 bg-white/5 hover:bg-white/10 text-white/60 px-2 py-1.5 rounded-lg text-xs transition whitespace-nowrap" data-amount="10">10 POL</button>
                            <button class="fund-preset flex-1 bg-white/5 hover:bg-white/10 text-white/60 px-2 py-1.5 rounded-lg text-xs transition whitespace-nowrap" data-amount="15">15 POL</button>
                            <button class="fund-preset flex-1 bg-white/5 hover:bg-white/10 text-white/60 px-2 py-1.5 rounded-lg text-xs transition whitespace-nowrap" data-amount="20">20 POL</button>
                        </div>
                        <button id="confirm-fund-btn" class="w-full bg-[#F6851B]/10 hover:bg-[#F6851B]/20 text-[#F6851B] border border-[#F6851B]/30 px-4 py-3 rounded-xl text-sm font-medium transition flex items-center justify-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"/></svg>
                            Continue to MetaMask
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const amountInput = modal.querySelector('#fund-amount');
            const confirmBtn = modal.querySelector('#confirm-fund-btn');
            const closeBtn = modal.querySelector('#close-fund-modal');
            const presetBtns = modal.querySelectorAll('.fund-preset');

            const cleanup = (result) => {
                modal.remove();
                resolve(result);
            };

            presetBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    amountInput.value = btn.dataset.amount;
                    amountInput.focus();
                });
            });

            confirmBtn.addEventListener('click', () => {
                const amount = parseFloat(amountInput.value);
                if (!amount || amount <= 0) {
                    amountInput.classList.add('border-red-500/50');
                    return;
                }
                cleanup(amountInput.value);
            });

            amountInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    confirmBtn.click();
                }
            });

            closeBtn.addEventListener('click', () => cleanup(null));
            modal.addEventListener('click', (e) => {
                if (e.target === modal) cleanup(null);
            });

            setTimeout(() => amountInput.focus(), 100);
        });
    }

    /**
     * Handle notifications toggle
     */
    async handleNotificationsToggle(e) {
        const muted = !e.target.checked;
        this.notificationManager?.setMuted(muted);

        if (muted) {
            await this.dmManager?.unsubscribeNotifications();
        } else {
            await this.dmManager?.subscribeNotifications();
        }

        if (this.elements.notificationsStatus) {
            this.elements.notificationsStatus.textContent = muted ? 'Muted' : '';
        }

        this.showNotification(
            muted ? 'Channel invites muted' : 'Channel invites enabled',
            'info'
        );
    }

    /**
     * Handle push notifications toggle
     */
    async handlePushNotificationsToggle(e) {
        const enable = e.target.checked;
        
        if (enable) {
            try {
                const subscription = await this.relayManager.subscribe();
                
                if (subscription) {
                    this.showNotification('Push notifications enabled!', 'success');
                    this.updatePushNotificationsStatus();
                } else {
                    e.target.checked = false;
                    this.showNotification('Could not enable push notifications', 'error');
                }
            } catch (error) {
                e.target.checked = false;
                this.showNotification('Failed to enable: ' + error.message, 'error');
            }
        } else {
            await this.relayManager.unsubscribe();
            this.showNotification('Push notifications disabled', 'info');
            this.updatePushNotificationsStatus();
        }
    }

    /**
     * Handle DM push notifications toggle
     */
    async handleDMPushToggle(e) {
        const enable = e.target.checked;
        const address = this.authManager?.getAddress();
        
        if (!address) {
            e.target.checked = false;
            return;
        }

        // Storage key for this preference
        const storageKey = CONFIG.storageKeys.dmPush(address);

        if (enable) {
            // Ensure push notifications are enabled first
            if (!this.relayManager?.enabled) {
                e.target.checked = false;
                this.showNotification('Enable Push Notifications first', 'warning');
                return;
            }

            // Ensure DM inbox exists
            if (!this.dmManager?.inboxReady) {
                e.target.checked = false;
                this.showNotification('Create your DM inbox first (send or receive a DM)', 'warning');
                return;
            }

            try {
                await this.dmManager.subscribeInboxPush(true); // force = true for explicit toggle
                localStorage.setItem(storageKey, 'true');
                this.showNotification('DM notifications enabled!', 'success');
            } catch (error) {
                e.target.checked = false;
                this.showNotification('Failed to enable DM notifications: ' + error.message, 'error');
            }
        } else {
            // Just save preference - relay will not send notifications without re-registration
            localStorage.removeItem(storageKey);
            this.showNotification('DM notifications disabled', 'info');
        }
    }

    /**
     * Update push notifications status text
     */
    updatePushNotificationsStatus() {
        if (!this.elements.pushNotificationsStatus) return;
        
        const pushEnabled = this.relayManager?.enabled;
        
        if (pushEnabled) {
            const channelCount = this.relayManager.subscribedChannels.size + this.relayManager.subscribedNativeChannels.size;
            this.elements.pushNotificationsStatus.textContent = `Enabled - ${channelCount} channel(s) with notifications enabled`;
            this.elements.pushNotificationsStatus.className = 'text-xs text-green-500';
        } else {
            this.elements.pushNotificationsStatus.textContent = 'Disabled';
            this.elements.pushNotificationsStatus.className = 'text-xs text-white/40';
        }

        // Show/hide DM push section based on push being enabled
        if (this.elements.dmPushSection) {
            if (pushEnabled) {
                this.elements.dmPushSection.classList.remove('hidden');
                
                // Update DM toggle state based on saved preference
                if (this.elements.dmPushEnabled) {
                    const address = this.authManager?.getAddress();
                    if (address) {
                        const storageKey = CONFIG.storageKeys.dmPush(address);
                        const dmPushEnabled = localStorage.getItem(storageKey) === 'true';
                        this.elements.dmPushEnabled.checked = dmPushEnabled;
                    }
                }
            } else {
                this.elements.dmPushSection.classList.add('hidden');
                if (this.elements.dmPushEnabled) {
                    this.elements.dmPushEnabled.checked = false;
                }
            }
        }
    }

    /**
     * Show password prompt modal
     */
    async showPasswordPrompt(title, description, requireConfirm = false) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            const safeTitle = _escapeHtml(title);
            const safeDescription = _escapeHtml(description);
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl w-[360px] overflow-hidden shadow-2xl border border-white/[0.06]">
                    <div class="px-5 pt-5 pb-3">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">${safeTitle}</h3>
                            <button id="close-modal" class="text-white/30 hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                        <p class="text-[11px] text-white/30 mt-1 whitespace-pre-line">${safeDescription}</p>
                    </div>
                    <div class="px-5 pb-4 space-y-3">
                        <div class="relative">
                            <input type="password" id="password-input" placeholder="Password"
                                class="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[13px] text-white placeholder-white/25 focus:outline-none focus:border-white/[0.15] transition"
                                autocomplete="off">
                            <button id="toggle-visibility" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white transition">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                </svg>
                            </button>
                        </div>
                        ${requireConfirm ? `
                        <div class="relative">
                            <input type="password" id="password-confirm" placeholder="Confirm password"
                                class="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[13px] text-white placeholder-white/25 focus:outline-none focus:border-white/[0.15] transition"
                                autocomplete="off">
                        </div>
                        ` : ''}
                        <p id="password-error" class="text-[11px] text-red-500 hidden"></p>
                    </div>
                    <div class="px-5 pb-5 flex gap-2">
                        <button id="pw-cancel" class="flex-1 bg-white/[0.05] hover:bg-white/[0.08] text-white text-[13px] font-medium py-2.5 rounded-xl transition border border-white/[0.08]">
                            Cancel
                        </button>
                        <button id="pw-confirm" class="flex-1 bg-white hover:bg-[#f0f0f0] text-black text-[13px] font-medium py-2.5 rounded-lg transition">
                            Continue
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const passwordInput = modal.querySelector('#password-input');
            const confirmInput = modal.querySelector('#password-confirm');
            const errorEl = modal.querySelector('#password-error');
            const confirmBtn = modal.querySelector('#pw-confirm');
            const cancelBtn = modal.querySelector('#pw-cancel');
            const closeBtn = modal.querySelector('#close-modal');
            const toggleBtn = modal.querySelector('#toggle-visibility');

            passwordInput.focus();

            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    const type = passwordInput.type === 'password' ? 'text' : 'password';
                    passwordInput.type = type;
                    if (confirmInput) confirmInput.type = type;
                });
            }

            const cleanup = (value) => {
                passwordInput.value = '';
                if (confirmInput) confirmInput.value = '';
                document.body.removeChild(modal);
                resolve(value);
            };

            const validate = () => {
                const pw = passwordInput.value;
                if (!pw || pw.length < 4) {
                    errorEl.textContent = 'Password must be at least 4 characters';
                    errorEl.classList.remove('hidden');
                    return null;
                }
                if (requireConfirm && confirmInput && pw !== confirmInput.value) {
                    errorEl.textContent = 'Passwords do not match';
                    errorEl.classList.remove('hidden');
                    return null;
                }
                return pw;
            };

            confirmBtn.addEventListener('click', () => {
                const pw = validate();
                if (pw) cleanup(pw);
            });
            cancelBtn.addEventListener('click', () => cleanup(null));
            closeBtn.addEventListener('click', () => cleanup(null));
            
            const handleEnter = (e) => {
                if (e.key === 'Enter') {
                    const pw = validate();
                    if (pw) cleanup(pw);
                }
            };
            passwordInput.addEventListener('keypress', handleEnter);
            if (confirmInput) confirmInput.addEventListener('keypress', handleEnter);
            
            modal.addEventListener('click', (e) => {
                if (e.target === modal) cleanup(null);
            });
        });
    }

    // ========================================
    // RPC Settings Methods
    // ========================================

    /**
     * Initialize RPC settings UI
     */
    initRpcSettings() {
        const presetSelect = document.getElementById('rpc-preset-select');
        const customContainer = document.getElementById('custom-rpc-container');
        const customInput = document.getElementById('custom-rpc-url');
        const testBtn = document.getElementById('test-rpc-btn');
        
        if (!presetSelect) return;
        
        // Set default to dRPC if no preference saved
        presetSelect.value = 'drpc';
        
        // Load saved preference
        const saved = localStorage.getItem(CONFIG.storageKeys.rpcPreference);
        if (saved) {
            try {
                const pref = JSON.parse(saved);
                presetSelect.value = pref.preset || 'drpc';
                if (pref.preset === 'custom' && pref.customUrl) {
                    customInput.value = pref.customUrl;
                    customContainer?.classList.remove('hidden');
                }
            } catch (e) {
                // Use defaults
            }
        }
        
        // Show/hide custom input based on selection
        presetSelect.addEventListener('change', (e) => {
            const isCustom = e.target.value === 'custom';
            customContainer?.classList.toggle('hidden', !isCustom);
            if (!isCustom) {
                this.saveRpcPreference();
            }
        });
        
        // Save custom URL on change
        customInput?.addEventListener('change', () => {
            if (customInput.value.trim()) {
                this.saveRpcPreference();
            }
        });
        
        // Test connection button
        testBtn?.addEventListener('click', () => this.testRpcConnection());
    }

    /**
     * Save RPC preference to localStorage and reconnect client
     */
    async saveRpcPreference() {
        const presetSelect = document.getElementById('rpc-preset-select');
        const customInput = document.getElementById('custom-rpc-url');
        
        if (!presetSelect) return;
        
        const preset = presetSelect.value;
        const pref = { preset };
        
        if (preset === 'custom' && customInput?.value.trim()) {
            pref.customUrl = customInput.value.trim();
        }
        
        localStorage.setItem(CONFIG.storageKeys.rpcPreference, JSON.stringify(pref));
        this.Logger?.info('RPC preference saved:', pref);
        
        // Reconnect Streamr client with new RPC endpoints
        if (this.streamrController?.client) {
            this.showNotification('Reconnecting with new RPC...', 'info');
            const success = await this.streamrController.reconnect();
            if (success) {
                this.showNotification('RPC updated successfully', 'success');
            } else {
                this.showNotification('RPC saved. Reload page to apply.', 'warning');
            }
        } else {
            this.showNotification('RPC preference saved', 'info');
        }
    }

    /**
     * Test RPC connection
     */
    async testRpcConnection() {
        const statusEl = document.getElementById('rpc-status');
        const testBtn = document.getElementById('test-rpc-btn');
        const presetSelect = document.getElementById('rpc-preset-select');
        const customInput = document.getElementById('custom-rpc-url');
        
        if (!statusEl || !testBtn) return;
        
        // Disable button during test
        testBtn.disabled = true;
        testBtn.textContent = 'Testing...';
        statusEl.innerHTML = '<span class="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-1.5 align-middle animate-pulse"></span><span class="align-middle">Testing...</span>';
        
        // Get URLs to test based on current selection
        let urlsToTest = [];
        const preset = presetSelect?.value || 'auto';
        
        if (preset === 'custom' && customInput?.value.trim()) {
            urlsToTest = [customInput.value.trim()];
        } else {
            // Import dynamically to avoid circular dependencies
            const { RPC_PRESETS } = await import('../config.js');
            urlsToTest = RPC_PRESETS[preset]?.urls || RPC_PRESETS['auto'].urls;
        }
        
        // Test first 3 endpoints
        const testUrls = urlsToTest.slice(0, 3);
        let workingCount = 0;
        
        for (const url of testUrls) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_blockNumber',
                        params: [],
                        id: 1
                    }),
                    signal: AbortSignal.timeout(5000)
                });
                
                const data = await response.json();
                if (data.result && !data.error) {
                    workingCount++;
                }
            } catch (e) {
                // Failed to connect
                this.Logger?.debug('RPC test failed for', url, e.message);
            }
        }
        
        // Update status
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
        
        if (workingCount === 0) {
            statusEl.innerHTML = '<span class="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 align-middle"></span><span class="align-middle text-red-400">All endpoints failed</span>';
        } else if (workingCount < testUrls.length) {
            statusEl.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-1.5 align-middle"></span><span class="align-middle text-yellow-400">${workingCount}/${testUrls.length} working</span>`;
        } else {
            statusEl.innerHTML = '<span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5 align-middle"></span><span class="align-middle text-green-400">Connected</span>';
        }
    }

    /**
     * Update RPC status display when opening settings
     */
    updateRpcStatusDisplay() {
        const presetSelect = document.getElementById('rpc-preset-select');
        const customContainer = document.getElementById('custom-rpc-container');
        const customInput = document.getElementById('custom-rpc-url');
        const statusEl = document.getElementById('rpc-status');
        
        // Load saved preference
        const saved = localStorage.getItem(CONFIG.storageKeys.rpcPreference);
        if (saved && presetSelect) {
            try {
                const pref = JSON.parse(saved);
                presetSelect.value = pref.preset || 'auto';
                if (pref.preset === 'custom' && pref.customUrl && customInput) {
                    customInput.value = pref.customUrl;
                    customContainer?.classList.remove('hidden');
                } else {
                    customContainer?.classList.add('hidden');
                }
            } catch (e) {
                presetSelect.value = 'auto';
                customContainer?.classList.add('hidden');
            }
        }
        
        // Reset status to "Not tested"
        if (statusEl) {
            statusEl.innerHTML = '<span class="inline-block w-2 h-2 rounded-full bg-white/20 mr-1.5 align-middle"></span><span class="align-middle">Not tested</span>';
        }
    }

    // === REPAIR INBOX UI ===

    /**
     * Initialize repair inbox button listeners
     */
    initRepairUI() {
        this._repairDiagnosis = null;
        this._repairPrimaryAction = 'diagnose';

        const diagnoseBtn = document.getElementById('repair-diagnose-btn');
        const fixBtn = document.getElementById('repair-fix-btn');

        diagnoseBtn?.addEventListener('click', () => this.handleRepairPrimaryAction());
        fixBtn?.addEventListener('click', () => this.runRepair());

        if (!this._repairInboxReadyListenerAttached) {
            document.addEventListener('pombo:dm-inbox-ready', () => {
                const repairPanel = document.getElementById('settings-panel-repair');
                if (!repairPanel || repairPanel.classList.contains('hidden')) return;

                this.runDiagnosis().catch((error) => {
                    this.Logger?.debug('Repair UI refresh failed:', error.message);
                });
            });
            this._repairInboxReadyListenerAttached = true;
        }
    }

    handleRepairPrimaryAction() {
        if (this._repairPrimaryAction === 'create') {
            if (this.showCreateDMInboxModal) {
                this.showCreateDMInboxModal();
            } else {
                this.modalManager?.show('dm-inbox-setup-modal');
            }
            return;
        }

        this.runDiagnosis();
    }

    _setRepairPrimaryAction(mode = 'diagnose') {
        const button = document.getElementById('repair-diagnose-btn');
        const icon = button?.querySelector('svg');
        const label = button?.querySelector('span');
        if (!button || !icon || !label) return;

        this._repairPrimaryAction = mode;

        if (mode === 'create') {
            button.className = 'flex-1 px-5 py-2.5 bg-[#F6851B]/15 hover:bg-[#F6851B]/25 text-white border border-[#F6851B]/30 text-sm font-medium rounded-xl transition-all duration-200 inline-flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-[#F6851B]/10';
            icon.setAttribute('class', 'w-4 h-4');
            icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>';
            label.textContent = 'Create DM Inbox';
            return;
        }

        button.className = 'flex-1 bg-white/5 hover:bg-white/10 text-white/70 border border-white/10 px-3 py-2 rounded-lg text-xs transition flex items-center justify-center gap-1.5';
        icon.setAttribute('class', 'w-3.5 h-3.5');
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>';
        label.textContent = 'Diagnose';
    }

    /**
     * Update the unified repair status card
     * @param {'idle'|'loading'|'noInbox'|'healthy'|'issues'|'error'|'repairing'|'repaired'} state
     * @param {string} [detail] - Optional detail text
     */
    _setRepairStatus(state, detail) {
        const card = document.getElementById('repair-status-card');
        const icon = document.getElementById('repair-status-icon');
        const title = document.getElementById('repair-status-title');
        const detailEl = document.getElementById('repair-status-detail');
        if (!card || !icon || !title || !detailEl) return;

        const hideCard = state === 'noInbox';
        card.classList.toggle('hidden', hideCard);
        if (hideCard) return;

        const states = {
            idle: {
                icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>',
                iconBg: 'bg-white/5 text-white/20',
                border: 'border-white/5',
                title: 'Not checked',
                detail: 'Run a diagnosis to check inbox health'
            },
            loading: {
                icon: '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>',
                iconBg: 'bg-white/5 text-white/40',
                border: 'border-white/5',
                title: 'Diagnosing...',
                detail: 'Checking streams, permissions and storage'
            },
            healthy: {
                icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
                iconBg: 'bg-green-500/10 text-green-400',
                border: 'border-green-500/10',
                title: 'Inbox healthy',
                detail: 'All checks passed'
            },
            issues: {
                icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>',
                iconBg: 'bg-yellow-500/10 text-yellow-400',
                border: 'border-yellow-500/10',
                title: 'Issues found',
                detail: detail || 'Click Repair to fix'
            },
            error: {
                icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
                iconBg: 'bg-red-500/10 text-red-400',
                border: 'border-red-500/10',
                title: 'Error',
                detail: detail || 'Something went wrong'
            },
            repairing: {
                icon: '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>',
                iconBg: 'bg-[#F6851B]/10 text-[#F6851B]',
                border: 'border-[#F6851B]/10',
                title: 'Repairing...',
                detail: detail || 'This may require gas'
            },
            repaired: {
                icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
                iconBg: 'bg-green-500/10 text-green-400',
                border: 'border-green-500/10',
                title: 'Repaired',
                detail: detail || 'All issues fixed'
            }
        };

        const s = states[state] || states.idle;
        icon.innerHTML = s.icon;
        icon.className = `w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full ${s.iconBg}`;
        card.className = `p-4 rounded-xl bg-white/[0.03] border ${s.border}`;
        title.textContent = s.title;
        detailEl.textContent = detail || s.detail;
    }

    /**
     * Run inbox diagnosis and update the unified status card
     */
    async runDiagnosis() {
        if (!this.dmManager) {
            this._setRepairPrimaryAction('diagnose');
            this._setRepairStatus('error', 'DM system not available');
            return;
        }

        this._setRepairStatus('loading');

        const fixBtn = document.getElementById('repair-fix-btn');
        const diagnoseBtn = document.getElementById('repair-diagnose-btn');
        if (diagnoseBtn) diagnoseBtn.disabled = true;

        try {
            const hasInbox = await this.dmManager.hasInbox();
            if (!hasInbox) {
                this._repairDiagnosis = null;
                this._setRepairPrimaryAction('create');
                this._setRepairStatus('noInbox');
                fixBtn?.classList.add('hidden');
                return;
            }

            const diagnosis = await this.dmManager.diagnoseInbox();
            this._repairDiagnosis = diagnosis;
            this._setRepairPrimaryAction('diagnose');

            // Count issues
            const issues = [];
            if (!diagnosis.messageStream.exists) issues.push('message stream');
            if (!diagnosis.ephemeralStream.exists) issues.push('ephemeral stream');
            if (diagnosis.messageStream.exists && !diagnosis.messageStream.partitionsCorrect) issues.push('partition count');
            if (diagnosis.messageStream.exists && !diagnosis.messageStream.publicKeyPresent) issues.push('public key');
            if (!diagnosis.permissions.messagePublicPublish) issues.push('message permissions');
            if (!diagnosis.permissions.ephemeralPublicPublish) issues.push('ephemeral permissions');
            if (!diagnosis.storage.enabled) issues.push('storage');

            if (issues.length > 0) {
                const summary = issues.length === 1
                    ? `Missing: ${issues[0]}`
                    : `${issues.length} issues: ${issues.join(', ')}`;
                this._setRepairStatus('issues', summary);
                fixBtn?.classList.remove('hidden');
            } else {
                // Build a short summary line
                const parts = [];
                if (diagnosis.storage.provider) parts.push(diagnosis.storage.provider);
                if (diagnosis.storage.storageDays) parts.push(`${diagnosis.storage.storageDays}d`);
                this._setRepairStatus('healthy', parts.length ? `Storage: ${parts.join(' · ')}` : 'All checks passed');
                fixBtn?.classList.add('hidden');
            }
        } catch (e) {
            this._repairDiagnosis = null;
            this._setRepairPrimaryAction('diagnose');
            this._setRepairStatus('error', e.message);
            fixBtn?.classList.add('hidden');
        } finally {
            if (diagnoseBtn) diagnoseBtn.disabled = false;
        }
    }

    /**
     * Run inbox repair using the last diagnosis
     */
    async runRepair() {
        if (!this._repairDiagnosis || !this.dmManager) return;

        const fixBtn = document.getElementById('repair-fix-btn');
        const diagnoseBtn = document.getElementById('repair-diagnose-btn');
        if (fixBtn) { fixBtn.disabled = true; fixBtn.querySelector('span').textContent = 'Repairing...'; }
        if (diagnoseBtn) diagnoseBtn.disabled = true;

        const stepLabels = {
            messageStream: 'Creating message stream',
            partitions: 'Updating partition count',
            ephemeralStream: 'Creating ephemeral stream',
            metadata: 'Updating metadata',
            messagePermissions: 'Setting message permissions',
            ephemeralPermissions: 'Setting ephemeral permissions',
            storage: 'Enabling storage'
        };

        this._setRepairStatus('repairing', 'Starting...');

        try {
            const result = await this.dmManager.repairInbox(
                this._repairDiagnosis,
                {},
                (stepName, status) => {
                    if (status === 'start') {
                        this._setRepairStatus('repairing', stepLabels[stepName] || stepName);
                    }
                }
            );

            const steps = result.steps;
            const failed = Object.values(steps).filter(s => s === 'fail').length;
            const fixed = Object.values(steps).filter(s => s === 'ok').length;

            if (failed > 0) {
                this._setRepairStatus('issues', `${fixed} fixed, ${failed} failed`);
            } else {
                this._setRepairStatus('repaired', fixed > 0 ? `${fixed} issue${fixed > 1 ? 's' : ''} fixed` : 'Nothing to repair');
                fixBtn?.classList.add('hidden');
            }

            this.showNotification(
                failed > 0 ? `Inbox repair: ${fixed} fixed, ${failed} failed` : 'Inbox repaired successfully',
                failed > 0 ? 'warning' : 'success'
            );
        } catch (e) {
            this._setRepairStatus('error', e.message);
            this.showNotification('Inbox repair failed: ' + e.message, 'error');
        } finally {
            if (fixBtn) { fixBtn.disabled = false; fixBtn.querySelector('span').textContent = 'Repair'; }
            if (diagnoseBtn) diagnoseBtn.disabled = false;
        }
    }
}

// Create singleton instance
const settingsUI = new SettingsUI();

export { settingsUI, SettingsUI };
