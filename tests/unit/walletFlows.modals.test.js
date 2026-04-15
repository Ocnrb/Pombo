/**
 * Tests for walletFlows.js modal methods — showSecureInput, showUnlockWalletModal,
 * showCreateWalletModal, showNewAccountSetupModal, showImportPrivateKeyModal
 * These methods build DOM directly and are tested via jsdom interactions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock dependencies before import ---
vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        isGuestMode: vi.fn().mockReturnValue(false),
        isConnected: vi.fn().mockReturnValue(true),
        getAddress: vi.fn().mockReturnValue('0xabc'),
        listSavedWallets: vi.fn().mockReturnValue([]),
        generateLocalWallet: vi.fn().mockReturnValue({
            address: '0xnewwallet',
            privateKey: '0x' + 'ab'.repeat(32),
            signer: { signMessage: vi.fn() }
        }),
        importPrivateKey: vi.fn().mockReturnValue({
            address: '0ximported',
            signer: { signMessage: vi.fn() }
        }),
        loadWalletEncrypted: vi.fn().mockResolvedValue({
            address: '0xloaded',
            signer: { signMessage: vi.fn() }
        }),
        saveWalletEncrypted: vi.fn().mockResolvedValue({
            name: 'TestWallet',
            address: '0xsaved'
        })
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn().mockReturnValue(true),
        importAccountBackup: vi.fn().mockResolvedValue({ data: null }),
        saveToStorage: vi.fn().mockResolvedValue(undefined),
        cache: {}
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: { loadChannels: vi.fn(), clearChannels: vi.fn() }
}));

vi.mock('../../src/js/ui.js', () => ({
    uiController: {
        showNotification: vi.fn(),
        showLoading: vi.fn(),
        hideLoading: vi.fn(),
        renderChannelList: vi.fn()
    }
}));

vi.mock('../../src/js/ui/AvatarGenerator.js', () => ({
    getAvatar: vi.fn(() => '<svg></svg>'),
    getAvatarHtml: vi.fn(() => '<svg></svg>'),
    generateAvatar: vi.fn(() => '<svg></svg>'),
    setAvatarSeed: vi.fn(),
    generateRandomAvatarSeed: vi.fn(() => '0x' + 'a'.repeat(40))
}));

vi.mock('../../src/js/ui/utils.js', () => ({
    escapeHtml: vi.fn((s) => s),
    escapeAttr: vi.fn((s) => s)
}));

// For the modal methods, createModalFromTemplate is used by showSecureInput & showCreateWalletModal.
// showUnlockWalletModal, showNewAccountSetupModal, showImportPrivateKeyModal create DOM directly.
let setupPasswordStrengthCb = null;
vi.mock('../../src/js/ui/modalUtils.js', () => ({
    createModalFromTemplate: vi.fn((templateId, data) => {
        const el = document.createElement('div');
        el.className = 'modal-root';
        el.setAttribute('data-template', templateId);
        if (templateId === 'modal-secure-input') {
            el.innerHTML = `
                <div data-modal-content>
                    <input data-secure-input type="text" />
                    <button data-confirm>OK</button>
                    <button data-cancel>Cancel</button>
                    <button data-toggle-visibility>Toggle</button>
                </div>`;
        } else if (templateId === 'modal-create-wallet') {
            el.innerHTML = `
                <div data-modal-content>
                    <button data-action="create">Create</button>
                    <button data-action="import">Import</button>
                    <button data-action="restore">Restore</button>
                    <input data-restore-input type="file" />
                </div>`;
        } else if (templateId === 'modal-progress') {
            el.innerHTML = `
                <div data-progress-bar style="width:0%"></div>
                <div data-progress-label>0%</div>`;
        }
        document.body.appendChild(el);
        return el;
    }),
    closeModal: vi.fn((m) => m?.remove?.()),
    setupModalCloseHandlers: vi.fn((modal, onClose) => {
        // Store callback so tests can trigger it
        modal._onClose = onClose;
    }),
    setupPasswordToggle: vi.fn(),
    $: vi.fn((parent, selector) => parent?.querySelector?.(selector) || null),
    getPasswordStrengthHtml: vi.fn(() => '<div class="strength-indicators"></div>'),
    setupPasswordStrengthValidation: vi.fn((input, modal, cb) => {
        setupPasswordStrengthCb = cb;
    })
}));

import { walletFlows } from '../../src/js/walletFlows.js';
import { authManager } from '../../src/js/auth.js';
import { uiController } from '../../src/js/ui.js';
import { createModalFromTemplate, setupModalCloseHandlers, $ as $mock } from '../../src/js/ui/modalUtils.js';

const mockCallbacks = {
    disconnectWallet: vi.fn().mockResolvedValue(undefined),
    onWalletConnected: vi.fn().mockResolvedValue(undefined),
    fallbackToGuest: vi.fn().mockResolvedValue(undefined)
};

// Save originals for restoration
const originals = {};

describe('WalletFlows Modal Methods', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupPasswordStrengthCb = null;
        // Save & restore originals
        originals.showSecureInput = walletFlows.showSecureInput;
        originals.showCreateWalletModal = walletFlows.showCreateWalletModal;
        originals.showUnlockWalletModal = walletFlows.showUnlockWalletModal;
        originals.showNewAccountSetupModal = walletFlows.showNewAccountSetupModal;
        originals.showImportPrivateKeyModal = walletFlows.showImportPrivateKeyModal;
        originals.saveWalletWithProgress = walletFlows.saveWalletWithProgress;
        originals.loadWalletWithProgress = walletFlows.loadWalletWithProgress;
        originals.showProgressModal = walletFlows.showProgressModal;
        originals.updateProgressModal = walletFlows.updateProgressModal;
        originals.hideProgressModal = walletFlows.hideProgressModal;
        originals.connectLocal = walletFlows.connectLocal;
        originals.importPrivateKey = walletFlows.importPrivateKey;
        originals.restoreFromBackup = walletFlows.restoreFromBackup;
        originals.showWalletSelector = walletFlows.showWalletSelector;

        walletFlows.init(mockCallbacks);
        document.body.innerHTML = '';
    });

    afterEach(() => {
        Object.assign(walletFlows, originals);
        vi.restoreAllMocks();
    });

    // ==================== showSecureInput ====================
    describe('showSecureInput', () => {
        it('creates modal from template with title and label', async () => {
            const promise = walletFlows.showSecureInput('My Title', 'My Label', 'text');

            expect(createModalFromTemplate).toHaveBeenCalledWith('modal-secure-input', {
                title: 'My Title',
                label: 'My Label'
            });

            // Confirm to resolve
            const confirmBtn = document.querySelector('[data-confirm]');
            confirmBtn.click();
            await promise;
        });

        it('resolves with input value on confirm', async () => {
            const promise = walletFlows.showSecureInput('Title', 'Label', 'text');

            const input = document.querySelector('[data-secure-input]');
            input.value = 'my secret value';
            document.querySelector('[data-confirm]').click();

            const result = await promise;
            expect(result).toBe('my secret value');
        });

        it('resolves with null on cancel', async () => {
            const promise = walletFlows.showSecureInput('Title', 'Label', 'password');

            document.querySelector('[data-cancel]').click();

            const result = await promise;
            expect(result).toBeNull();
        });

        it('resolves with null when input is empty on confirm', async () => {
            const promise = walletFlows.showSecureInput('Title', 'Label', 'text');

            const input = document.querySelector('[data-secure-input]');
            input.value = '';
            document.querySelector('[data-confirm]').click();

            const result = await promise;
            expect(result).toBeNull();
        });

        it('sets input type from parameter', async () => {
            const promise = walletFlows.showSecureInput('T', 'L', 'password');

            const input = document.querySelector('[data-secure-input]');
            expect(input.type).toBe('password');

            document.querySelector('[data-cancel]').click();
            await promise;
        });

        it('resolves with null when close handler triggered', async () => {
            const promise = walletFlows.showSecureInput('T', 'L', 'password');

            // The setupModalCloseHandlers mock stores the callback
            const modal = document.querySelector('.modal-root');
            expect(modal._onClose).toBeDefined();
            modal._onClose();

            const result = await promise;
            expect(result).toBeNull();
        });

        it('resolves on Enter key press', async () => {
            const promise = walletFlows.showSecureInput('T', 'L', 'text');

            const input = document.querySelector('[data-secure-input]');
            input.value = 'entered value';
            input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

            const result = await promise;
            expect(result).toBe('entered value');
        });

        it('adds hidden username field for wallet address password manager support', async () => {
            const promise = walletFlows.showSecureInput('T', 'L', 'password', {
                walletAddress: '0xABC123'
            });

            const input = document.querySelector('[data-secure-input]');
            // Should have a username sibling inserted before it
            const usernameInput = input.parentNode.querySelector('input[name="username"]');
            expect(usernameInput).not.toBeNull();
            expect(usernameInput.value).toBe('0xabc123');
            expect(usernameInput.autocomplete).toBe('username');
            expect(input.name).toBe('password');
            expect(input.autocomplete).toBe('current-password');

            document.querySelector('[data-cancel]').click();
            await promise;
        });

        it('hides toggle button for non-password input types', async () => {
            const promise = walletFlows.showSecureInput('T', 'L', 'text');

            const toggleBtn = document.querySelector('[data-toggle-visibility]');
            expect(toggleBtn.style.display).toBe('none');

            document.querySelector('[data-cancel]').click();
            await promise;
        });

        it('clears input value on cleanup', async () => {
            const promise = walletFlows.showSecureInput('T', 'L', 'text');

            const input = document.querySelector('[data-secure-input]');
            input.value = 'sensitive data';
            document.querySelector('[data-confirm]').click();

            await promise;
            expect(input.value).toBe('');
        });

        it('removes modal from DOM on cleanup', async () => {
            const promise = walletFlows.showSecureInput('T', 'L', 'text');

            expect(document.querySelector('.modal-root')).not.toBeNull();

            document.querySelector('[data-cancel]').click();
            await promise;

            expect(document.querySelector('.modal-root')).toBeNull();
        });
    });

    // ==================== showCreateWalletModal ====================
    describe('showCreateWalletModal', () => {
        it('creates modal from create-wallet template', async () => {
            walletFlows.connectLocal = vi.fn().mockResolvedValue(undefined);

            const promise = walletFlows.showCreateWalletModal();

            expect(createModalFromTemplate).toHaveBeenCalledWith('modal-create-wallet');

            // Click create to resolve
            document.querySelector('[data-action="create"]').click();
            await promise;
        });

        it('rejects with error if template not found', async () => {
            createModalFromTemplate.mockReturnValueOnce(null);

            await expect(walletFlows.showCreateWalletModal()).rejects.toThrow('Template not found');
        });

        it('resolves after create button delegates to connectLocal', async () => {
            walletFlows.connectLocal = vi.fn().mockResolvedValue(undefined);

            const promise = walletFlows.showCreateWalletModal();
            document.querySelector('[data-action="create"]').click();

            await promise;
            expect(walletFlows.connectLocal).toHaveBeenCalled();
        });

        it('resolves after import button delegates to importPrivateKey', async () => {
            walletFlows.importPrivateKey = vi.fn().mockResolvedValue(undefined);

            const promise = walletFlows.showCreateWalletModal();
            document.querySelector('[data-action="import"]').click();

            await promise;
            expect(walletFlows.importPrivateKey).toHaveBeenCalled();
        });

        it('rejects with cancelled when close handler triggered', async () => {
            const promise = walletFlows.showCreateWalletModal();

            const modal = document.querySelector('.modal-root');
            modal._onClose();

            await expect(promise).rejects.toThrow('cancelled');
        });

        it('rejects when connectLocal throws', async () => {
            walletFlows.connectLocal = vi.fn().mockRejectedValue(new Error('create fail'));

            const promise = walletFlows.showCreateWalletModal();
            document.querySelector('[data-action="create"]').click();

            await expect(promise).rejects.toThrow('create fail');
        });

        it('rejects when importPrivateKey throws', async () => {
            walletFlows.importPrivateKey = vi.fn().mockRejectedValue(new Error('import fail'));

            const promise = walletFlows.showCreateWalletModal();
            document.querySelector('[data-action="import"]').click();

            await expect(promise).rejects.toThrow('import fail');
        });

        it('handles restore file selection', async () => {
            walletFlows.restoreFromBackup = vi.fn().mockResolvedValue(undefined);

            const promise = walletFlows.showCreateWalletModal();

            const fileInput = document.querySelector('[data-restore-input]');
            // Simulate file selection
            const file = new File(['{}'], 'backup.json', { type: 'application/json' });
            Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
            fileInput.dispatchEvent(new Event('change'));

            await promise;
            expect(walletFlows.restoreFromBackup).toHaveBeenCalledWith(file);
        });

        it('does nothing when no file is selected', async () => {
            walletFlows.restoreFromBackup = vi.fn();
            walletFlows.connectLocal = vi.fn().mockResolvedValue(undefined);

            const promise = walletFlows.showCreateWalletModal();

            const fileInput = document.querySelector('[data-restore-input]');
            // No files
            Object.defineProperty(fileInput, 'files', { value: [], configurable: true });
            fileInput.dispatchEvent(new Event('change'));

            // resolve via create since file selection did nothing
            document.querySelector('[data-action="create"]').click();
            await promise;

            expect(walletFlows.restoreFromBackup).not.toHaveBeenCalled();
        });

        it('rejects when restoreFromBackup throws non-cancelled error', async () => {
            walletFlows.restoreFromBackup = vi.fn().mockRejectedValue(new Error('corrupt'));

            const promise = walletFlows.showCreateWalletModal();

            const fileInput = document.querySelector('[data-restore-input]');
            const file = new File(['{}'], 'backup.json');
            Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
            fileInput.dispatchEvent(new Event('change'));

            await expect(promise).rejects.toThrow('corrupt');
            expect(uiController.showNotification).toHaveBeenCalledWith(
                expect.stringContaining('corrupt'),
                'error'
            );
        });

        it('rejects but does not show notification for cancelled restore', async () => {
            walletFlows.restoreFromBackup = vi.fn().mockRejectedValue(new Error('cancelled'));

            const promise = walletFlows.showCreateWalletModal();

            const fileInput = document.querySelector('[data-restore-input]');
            const file = new File(['{}'], 'backup.json');
            Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
            fileInput.dispatchEvent(new Event('change'));

            await expect(promise).rejects.toThrow('cancelled');
            expect(uiController.showNotification).not.toHaveBeenCalled();
        });
    });

    // ==================== showUnlockWalletModal ====================
    describe('showUnlockWalletModal', () => {
        it('renders single wallet display for one wallet', async () => {
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});
            const wallets = [{ address: '0xaaa111bbb222', name: 'My Wallet' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);

            // Single wallet: no wallet-item buttons, just a display
            expect(document.querySelectorAll('.wallet-item').length).toBe(0);
            // Should have password input
            const pwInput = document.querySelector('#wallet-password');
            expect(pwInput).not.toBeNull();

            // Fill password and submit form
            pwInput.value = 'secret123';
            document.querySelector('#unlock-form').dispatchEvent(new Event('submit', { cancelable: true }));

            await promise;
            expect(walletFlows.loadWalletWithProgress).toHaveBeenCalledWith('secret123', '0xaaa111bbb222');
        });

        it('renders multiple wallet items for multiple wallets', async () => {
            const wallets = [
                { address: '0xaaa', name: 'W1' },
                { address: '0xbbb', name: 'W2' }
            ];

            const promise = walletFlows.showUnlockWalletModal(wallets);

            expect(document.querySelectorAll('.wallet-item').length).toBe(2);

            // Close to cleanup
            document.querySelector('#close-modal').click();
            await promise.catch(() => {});
        });

        it('rejects with cancelled on close button', async () => {
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);
            document.querySelector('#close-modal').click();

            await expect(promise).rejects.toThrow('cancelled');
        });

        it('rejects with cancelled on backdrop click', async () => {
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);

            // The outer modal div is the first child of body
            const modal = document.body.firstElementChild;
            const event = new MouseEvent('click', { bubbles: true });
            Object.defineProperty(event, 'target', { value: modal });
            modal.dispatchEvent(event);

            await expect(promise).rejects.toThrow('cancelled');
        });

        it('does nothing when password is empty on submit', async () => {
            walletFlows.loadWalletWithProgress = vi.fn();
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);

            const pwInput = document.querySelector('#wallet-password');
            pwInput.value = '';
            document.querySelector('#unlock-form').dispatchEvent(new Event('submit', { cancelable: true }));

            // Should NOT have called loadWalletWithProgress
            expect(walletFlows.loadWalletWithProgress).not.toHaveBeenCalled();
            // Should add error styling
            expect(pwInput.classList.contains('border-red-500')).toBe(true);

            // Clean up
            document.querySelector('#close-modal').click();
            await promise.catch(() => {});
        });

        it('updates hidden username when selecting different wallet', async () => {
            const wallets = [
                { address: '0xAAA', name: 'W1' },
                { address: '0xBBB', name: 'W2' }
            ];

            const promise = walletFlows.showUnlockWalletModal(wallets);

            const walletItems = document.querySelectorAll('.wallet-item');
            // Click second wallet
            walletItems[1].click();

            const usernameInput = document.querySelector('#wallet-username');
            expect(usernameInput.value).toBe('0xbbb');

            // Cleanup
            document.querySelector('#close-modal').click();
            await promise.catch(() => {});
        });

        it('shows error and re-renders modal on failed unlock', async () => {
            walletFlows.loadWalletWithProgress = vi.fn().mockRejectedValue(new Error('wrong pw'));
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);

            const pwInput = document.querySelector('#wallet-password');
            pwInput.value = 'wrongpass';
            document.querySelector('#unlock-form').dispatchEvent(new Event('submit', { cancelable: true }));

            // Wait for the async error handling
            await new Promise(r => setTimeout(r, 10));

            // Password error should be visible, password cleared
            const passwordError = document.querySelector('#password-error');
            expect(passwordError.classList.contains('hidden')).toBe(false);
            expect(pwInput.value).toBe('');

            // Cleanup
            document.querySelector('#close-modal').click();
            await promise.catch(() => {});
        });

        it('clears password error on new input', async () => {
            walletFlows.loadWalletWithProgress = vi.fn().mockRejectedValue(new Error('wrong'));
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);

            const pwInput = document.querySelector('#wallet-password');
            pwInput.value = 'wrongpass';
            document.querySelector('#unlock-form').dispatchEvent(new Event('submit', { cancelable: true }));

            await new Promise(r => setTimeout(r, 10));

            // Type new input
            pwInput.dispatchEvent(new Event('input', { bubbles: true }));

            const passwordError = document.querySelector('#password-error');
            expect(passwordError.classList.contains('hidden')).toBe(true);
            expect(pwInput.classList.contains('border-red-500')).toBe(false);

            document.querySelector('#close-modal').click();
            await promise.catch(() => {});
        });

        it('delegates to showCreateWalletModal on "New account" click', async () => {
            walletFlows.showCreateWalletModal = vi.fn().mockResolvedValue(undefined);
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);
            document.querySelector('#create-new-btn').click();

            await promise;
            expect(walletFlows.showCreateWalletModal).toHaveBeenCalled();
        });

        it('delegates to importPrivateKey on "Import" click', async () => {
            walletFlows.importPrivateKey = vi.fn().mockResolvedValue(undefined);
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);
            document.querySelector('#import-btn').click();

            await promise;
            expect(walletFlows.importPrivateKey).toHaveBeenCalled();
        });

        it('rejects when create new wallet fails', async () => {
            walletFlows.showCreateWalletModal = vi.fn().mockRejectedValue(new Error('cancelled'));
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showUnlockWalletModal(wallets);
            document.querySelector('#create-new-btn').click();

            await expect(promise).rejects.toThrow('cancelled');
        });

        it('uses getDisplayName with default for auto-generated names', async () => {
            const wallets = [
                { address: '0xaaa', name: '' },
                { address: '0xbbb', name: 'Wallet 1' },
                { address: '0xccc', name: 'My Custom' }
            ];

            const promise = walletFlows.showUnlockWalletModal(wallets);

            const items = document.querySelectorAll('.wallet-item');
            expect(items[0].textContent).toContain('Account 1');
            expect(items[1].textContent).toContain('Account 2');
            expect(items[2].textContent).toContain('My Custom');

            document.querySelector('#close-modal').click();
            await promise.catch(() => {});
        });
    });

    // ==================== showNewAccountSetupModal ====================
    describe('showNewAccountSetupModal', () => {
        const address = '0xNewAddress123';
        const privateKey = '0x' + 'ab'.repeat(32);

        // Helper: advance past avatar step to details step
        const goToDetailsStep = () => {
            document.querySelector('#avatar-continue-btn').click();
        };

        it('renders avatar selection step initially', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);

            expect(document.querySelector('#step-avatar')).not.toBeNull();
            expect(document.querySelector('#step-details').classList.contains('hidden')).toBe(true);
            expect(document.querySelector('#step-confirm').classList.contains('hidden')).toBe(true);
            expect(document.querySelector('#avatar-grid')).not.toBeNull();

            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('resolves with cancelled on cancel button', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);

            document.querySelector('#avatar-cancel-btn').click();

            const result = await promise;
            expect(result).toBe('cancelled');
        });

        it('transitions from avatar step to details step', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);

            goToDetailsStep();

            expect(document.querySelector('#step-avatar').classList.contains('hidden')).toBe(true);
            expect(document.querySelector('#step-details').classList.contains('hidden')).toBe(false);
            expect(document.body.textContent).toContain(address);

            // Go back to avatar step
            document.querySelector('#details-back-btn').click();
            expect(document.querySelector('#step-avatar').classList.contains('hidden')).toBe(false);

            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('shuffles avatars when shuffle button is clicked', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);

            const gridBefore = document.querySelector('#avatar-grid').innerHTML;
            document.querySelector('#shuffle-avatars').click();
            const gridAfter = document.querySelector('#avatar-grid').innerHTML;

            // Grid should have been re-rendered (seeds regenerated)
            expect(gridAfter).not.toBe(gridBefore);

            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('toggles private key visibility', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            const pkHidden = document.querySelector('#pk-hidden');
            const pkRevealed = document.querySelector('#pk-revealed');
            expect(pkRevealed.classList.contains('hidden')).toBe(true);

            document.querySelector('#toggle-pk').click();
            expect(pkRevealed.classList.contains('hidden')).toBe(false);
            expect(pkHidden.classList.contains('hidden')).toBe(true);

            // Toggle back
            document.querySelector('#toggle-pk').click();
            expect(pkRevealed.classList.contains('hidden')).toBe(true);

            document.querySelector('#details-back-btn').click();
            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('copies private key to clipboard', async () => {
            const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            await document.querySelector('#copy-pk').click();

            expect(writeTextSpy).toHaveBeenCalledWith(privateKey);

            document.querySelector('#details-back-btn').click();
            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('uses fallback copy when clipboard API fails', async () => {
            vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
            document.execCommand = vi.fn().mockReturnValue(true);

            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            await document.querySelector('#copy-pk').click();
            // Wait for the async catch to execute
            await new Promise(r => setTimeout(r, 0));

            expect(document.execCommand).toHaveBeenCalledWith('copy');

            document.querySelector('#details-back-btn').click();
            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('continue button is disabled until password strength callback fires true', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            const continueBtn = document.querySelector('#details-continue-btn');
            expect(continueBtn.disabled).toBe(true);

            // Simulate password strength validation callback
            expect(setupPasswordStrengthCb).toBeDefined();
            setupPasswordStrengthCb(true);
            expect(continueBtn.disabled).toBe(false);

            // Disable again
            setupPasswordStrengthCb(false);
            expect(continueBtn.disabled).toBe(true);

            document.querySelector('#details-back-btn').click();
            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('transitions to confirm step on continue', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            // Enable continue
            setupPasswordStrengthCb(true);
            const continueBtn = document.querySelector('#details-continue-btn');
            continueBtn.click();

            expect(document.querySelector('#step-details').classList.contains('hidden')).toBe(true);
            expect(document.querySelector('#step-confirm').classList.contains('hidden')).toBe(false);

            // Go back to details
            document.querySelector('#confirm-back-btn').click();
            expect(document.querySelector('#step-details').classList.contains('hidden')).toBe(false);

            document.querySelector('#details-back-btn').click();
            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('shows error when passwords do not match on confirm', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            const passwordInput = document.querySelector('#password-input');
            passwordInput.value = 'StrongPass123!';

            // Go to confirm step
            setupPasswordStrengthCb(true);
            document.querySelector('#details-continue-btn').click();

            // Enter wrong confirmation
            const confirmInput = document.querySelector('#confirm-password-input');
            confirmInput.value = 'WrongPass456!';
            document.querySelector('#confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            const passwordError = document.querySelector('#password-error');
            expect(passwordError.classList.contains('hidden')).toBe(false);
            expect(confirmInput.classList.contains('border-red-400')).toBe(true);

            // Cancel
            document.querySelector('#confirm-back-btn').click();
            document.querySelector('#details-back-btn').click();
            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('resolves with password and displayName on matching confirm', async () => {
            // Mock storeCredentials (module-level, uses PasswordCredential)
            window.PasswordCredential = undefined;

            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            const passwordInput = document.querySelector('#password-input');
            const displayNameInput = document.querySelector('#display-name-input');
            passwordInput.value = 'StrongPass123!';
            displayNameInput.value = 'Alice';

            // Go to confirm step
            setupPasswordStrengthCb(true);
            document.querySelector('#details-continue-btn').click();

            // Enter matching confirmation
            const confirmInput = document.querySelector('#confirm-password-input');
            confirmInput.value = 'StrongPass123!';
            document.querySelector('#confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            const result = await promise;
            expect(result).toEqual({
                password: 'StrongPass123!',
                displayName: 'Alice'
            });
        });

        it('resolves with null displayName when empty', async () => {
            window.PasswordCredential = undefined;

            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            document.querySelector('#password-input').value = 'Pass123!';
            document.querySelector('#display-name-input').value = '';

            setupPasswordStrengthCb(true);
            document.querySelector('#details-continue-btn').click();

            document.querySelector('#confirm-password-input').value = 'Pass123!';
            document.querySelector('#confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            const result = await promise;
            expect(result.displayName).toBeNull();
        });

        it('clears confirm error on new input', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            document.querySelector('#password-input').value = 'Pass123!';
            setupPasswordStrengthCb(true);
            document.querySelector('#details-continue-btn').click();

            const confirmInput = document.querySelector('#confirm-password-input');
            confirmInput.value = 'wrong';
            document.querySelector('#confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            // Error shown
            expect(document.querySelector('#password-error').classList.contains('hidden')).toBe(false);

            // Type new input
            confirmInput.dispatchEvent(new Event('input', { bubbles: true }));
            expect(document.querySelector('#password-error').classList.contains('hidden')).toBe(true);
            expect(confirmInput.classList.contains('border-red-400')).toBe(false);

            document.querySelector('#confirm-back-btn').click();
            document.querySelector('#details-back-btn').click();
            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('Enter key on password triggers continue when enabled', async () => {
            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            const passwordInput = document.querySelector('#password-input');
            passwordInput.value = 'Pass123!';

            setupPasswordStrengthCb(true);
            passwordInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

            // Should have moved to confirm step
            expect(document.querySelector('#step-details').classList.contains('hidden')).toBe(true);

            document.querySelector('#confirm-back-btn').click();
            document.querySelector('#details-back-btn').click();
            document.querySelector('#avatar-cancel-btn').click();
            await promise;
        });

        it('removes modal from DOM after resolve', async () => {
            window.PasswordCredential = undefined;

            const promise = walletFlows.showNewAccountSetupModal(address, privateKey);
            goToDetailsStep();

            document.querySelector('#password-input').value = 'Pass1!';
            setupPasswordStrengthCb(true);
            document.querySelector('#details-continue-btn').click();
            document.querySelector('#confirm-password-input').value = 'Pass1!';
            document.querySelector('#confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            await promise;
            // Modal should be removed
            expect(document.querySelector('#step-avatar')).toBeNull();
        });
    });

    // ==================== showImportPrivateKeyModal ====================
    describe('showImportPrivateKeyModal', () => {
        it('renders step 1 with private key and password inputs', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            expect(document.querySelector('#step-1')).not.toBeNull();
            expect(document.querySelector('#private-key-input')).not.toBeNull();
            expect(document.querySelector('#password-input')).not.toBeNull();

            // Close
            document.querySelector('#close-btn').click();
            await promise;
        });

        it('resolves with null on close button', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            document.querySelector('#close-btn').click();

            const result = await promise;
            expect(result).toBeNull();
        });

        it('resolves with null on backdrop click', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const modal = document.body.firstElementChild;
            const event = new MouseEvent('click', { bubbles: true });
            Object.defineProperty(event, 'target', { value: modal });
            modal.dispatchEvent(event);

            const result = await promise;
            expect(result).toBeNull();
        });

        it('validates private key format - shows error for invalid key', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'not-a-valid-key';
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            const pkError = document.querySelector('#pk-error');
            expect(pkError.classList.contains('hidden')).toBe(false);
            expect(pkInput.classList.contains('border-red-400')).toBe(true);

            document.querySelector('#close-btn').click();
            await promise;
        });

        it('validates private key format - accepts 64 hex chars without 0x', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            const pkError = document.querySelector('#pk-error');
            expect(pkError.classList.contains('hidden')).toBe(true);

            document.querySelector('#close-btn').click();
            await promise;
        });

        it('validates private key format - accepts 0x-prefixed 64 hex chars', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = '0x' + 'cd'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            expect(document.querySelector('#pk-error').classList.contains('hidden')).toBe(true);

            document.querySelector('#close-btn').click();
            await promise;
        });

        it('hides error when key field is empty', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = '';
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            expect(document.querySelector('#pk-error').classList.contains('hidden')).toBe(true);

            document.querySelector('#close-btn').click();
            await promise;
        });

        it('toggles private key visibility', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            expect(pkInput.type).toBe('password');

            document.querySelector('#toggle-pk').click();
            expect(pkInput.type).toBe('text');

            document.querySelector('#toggle-pk').click();
            expect(pkInput.type).toBe('password');

            document.querySelector('#close-btn').click();
            await promise;
        });

        it('skip button resolves with null password when pk is valid', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            document.querySelector('#skip-btn').click();

            const result = await promise;
            expect(result).toEqual({
                privateKey: '0x' + 'ab'.repeat(32),
                password: null
            });
        });

        it('skip button does nothing when pk is invalid', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'invalid';
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            document.querySelector('#skip-btn').click();

            // Modal should still be visible
            expect(document.querySelector('#step-1')).not.toBeNull();

            document.querySelector('#close-btn').click();
            await promise;
        });

        it('save button disabled until both pk and password are valid', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const saveBtn = document.querySelector('#save-btn');
            expect(saveBtn.disabled).toBe(true);

            // Set valid pk
            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            // Password not yet valid
            expect(saveBtn.disabled).toBe(true);

            // Simulate password strength valid
            setupPasswordStrengthCb(true);
            expect(saveBtn.disabled).toBe(false);

            document.querySelector('#close-btn').click();
            await promise;
        });

        it('transitions to step 2 on save click', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));
            setupPasswordStrengthCb(true);

            document.querySelector('#save-btn').click();

            expect(document.querySelector('#step-1').classList.contains('hidden')).toBe(true);
            expect(document.querySelector('#step-2').classList.contains('hidden')).toBe(false);

            // Go back
            document.querySelector('#back-btn').click();
            expect(document.querySelector('#step-1').classList.contains('hidden')).toBe(false);

            document.querySelector('#close-btn').click();
            await promise;
        });

        it('shows error on password mismatch in step 2', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            document.querySelector('#password-input').value = 'StrongPass123!';
            setupPasswordStrengthCb(true);
            document.querySelector('#save-btn').click();

            // Mismatch
            document.querySelector('#confirm-password-input').value = 'WrongPass!';
            document.querySelector('#import-confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            expect(document.querySelector('#password-error').classList.contains('hidden')).toBe(false);

            document.querySelector('#back-btn').click();
            document.querySelector('#close-btn').click();
            await promise;
        });

        it('clears error on new confirm input', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#password-input').value = 'StrongPass!';
            setupPasswordStrengthCb(true);
            document.querySelector('#save-btn').click();

            const confirmInput = document.querySelector('#confirm-password-input');
            confirmInput.value = 'Wrong';
            document.querySelector('#import-confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            // Error shown
            expect(document.querySelector('#password-error').classList.contains('hidden')).toBe(false);

            // New input clears
            confirmInput.dispatchEvent(new Event('input', { bubbles: true }));
            expect(document.querySelector('#password-error').classList.contains('hidden')).toBe(true);

            document.querySelector('#back-btn').click();
            document.querySelector('#close-btn').click();
            await promise;
        });

        it('resolves with privateKey and password on matching confirm', async () => {
            window.PasswordCredential = undefined;

            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            document.querySelector('#password-input').value = 'StrongPass123!';
            setupPasswordStrengthCb(true);
            document.querySelector('#save-btn').click();

            document.querySelector('#confirm-password-input').value = 'StrongPass123!';
            document.querySelector('#import-confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            const result = await promise;
            expect(result).toEqual({
                privateKey: '0x' + 'ab'.repeat(32),
                password: 'StrongPass123!'
            });
        });

        it('removes modal from DOM after resolve', async () => {
            window.PasswordCredential = undefined;

            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            document.querySelector('#password-input').value = 'Pass!';
            setupPasswordStrengthCb(true);
            document.querySelector('#save-btn').click();

            document.querySelector('#confirm-password-input').value = 'Pass!';
            document.querySelector('#import-confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            await promise;
            expect(document.querySelector('#step-1')).toBeNull();
        });

        it('Enter on password triggers save when enabled', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            const pwInput = document.querySelector('#password-input');
            pwInput.value = 'StrongPass!';
            setupPasswordStrengthCb(true);

            pwInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

            // Should transition to step 2
            expect(document.querySelector('#step-1').classList.contains('hidden')).toBe(true);

            document.querySelector('#back-btn').click();
            document.querySelector('#close-btn').click();
            await promise;
        });

        it('Enter on private key triggers skip when pk valid but save disabled', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));

            // No password set → save disabled, but pk valid → skip should fire
            pkInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));

            const result = await promise;
            expect(result).toEqual({
                privateKey: '0x' + 'ab'.repeat(32),
                password: null
            });
        });

        it('back button clears confirm password and error', async () => {
            const promise = walletFlows.showImportPrivateKeyModal();

            const pkInput = document.querySelector('#private-key-input');
            pkInput.value = 'ab'.repeat(32);
            pkInput.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#password-input').value = 'Pass!';
            setupPasswordStrengthCb(true);
            document.querySelector('#save-btn').click();

            const confirmInput = document.querySelector('#confirm-password-input');
            confirmInput.value = 'something';

            document.querySelector('#back-btn').click();

            expect(confirmInput.value).toBe('');
            expect(document.querySelector('#password-error').classList.contains('hidden')).toBe(true);

            document.querySelector('#close-btn').click();
            await promise;
        });
    });

    // ==================== storeCredentials (indirect) ====================
    describe('storeCredentials (indirect via showNewAccountSetupModal)', () => {
        it('stores credentials via PasswordCredential API when available', async () => {
            const mockStore = vi.fn().mockResolvedValue(undefined);
            window.PasswordCredential = function (opts) {
                this.id = opts.id;
                this.password = opts.password;
                this.name = opts.name;
            };
            Object.defineProperty(navigator, 'credentials', {
                value: { store: mockStore },
                configurable: true
            });

            const promise = walletFlows.showNewAccountSetupModal('0xTestAddr', '0x' + 'ff'.repeat(32));

            document.querySelector('#avatar-continue-btn').click();
            document.querySelector('#password-input').value = 'MyPass123!';
            setupPasswordStrengthCb(true);
            document.querySelector('#details-continue-btn').click();

            document.querySelector('#confirm-password-input').value = 'MyPass123!';
            document.querySelector('#confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            await promise;
            expect(mockStore).toHaveBeenCalled();
        });

        it('does not throw when PasswordCredential not supported', async () => {
            window.PasswordCredential = undefined;

            const promise = walletFlows.showNewAccountSetupModal('0xAddr', '0x' + 'ff'.repeat(32));

            document.querySelector('#avatar-continue-btn').click();
            document.querySelector('#password-input').value = 'Pass1!';
            setupPasswordStrengthCb(true);
            document.querySelector('#details-continue-btn').click();
            document.querySelector('#confirm-password-input').value = 'Pass1!';
            document.querySelector('#confirm-password-form').dispatchEvent(new Event('submit', { cancelable: true }));

            const result = await promise;
            expect(result.password).toBe('Pass1!');
        });
    });

    // ==================== connectWallet integration ====================
    describe('connectWallet', () => {
        it('shows create modal for guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            walletFlows.showCreateWalletModal = vi.fn().mockResolvedValue(undefined);
            authManager.getAddress.mockReturnValue('0xabc');

            await walletFlows.connectWallet();

            expect(walletFlows.showCreateWalletModal).toHaveBeenCalled();
        });

        it('shows unlock modal when saved wallets exist', async () => {
            authManager.isGuestMode.mockReturnValue(false);
            authManager.listSavedWallets.mockReturnValue([{ address: '0x1', name: 'W' }]);
            walletFlows.showUnlockWalletModal = vi.fn().mockResolvedValue(undefined);
            authManager.getAddress.mockReturnValue('0x1');

            await walletFlows.connectWallet();

            expect(walletFlows.showUnlockWalletModal).toHaveBeenCalledWith([{ address: '0x1', name: 'W' }]);
        });

        it('shows create modal when no saved wallets', async () => {
            authManager.isGuestMode.mockReturnValue(false);
            authManager.listSavedWallets.mockReturnValue([]);
            walletFlows.showCreateWalletModal = vi.fn().mockResolvedValue(undefined);
            authManager.getAddress.mockReturnValue('0xabc');

            await walletFlows.connectWallet();

            expect(walletFlows.showCreateWalletModal).toHaveBeenCalled();
        });

        it('falls back to guest when address is null after flow', async () => {
            authManager.isGuestMode.mockReturnValue(false);
            authManager.listSavedWallets.mockReturnValue([]);
            walletFlows.showCreateWalletModal = vi.fn().mockResolvedValue(undefined);
            authManager.getAddress.mockReturnValue(null);

            await walletFlows.connectWallet();

            expect(mockCallbacks.fallbackToGuest).toHaveBeenCalledWith(expect.stringContaining('Guest'));
        });

        it('shows error notification on non-cancelled error', async () => {
            authManager.isGuestMode.mockReturnValue(false);
            authManager.listSavedWallets.mockReturnValue([{ address: '0x1', name: 'W' }]);
            walletFlows.showUnlockWalletModal = vi.fn().mockRejectedValue(new Error('network err'));
            authManager.getAddress.mockReturnValue(null);

            await walletFlows.connectWallet();

            expect(uiController.showNotification).toHaveBeenCalledWith(
                expect.stringContaining('network err'),
                'error'
            );
        });

        it('does not show notification for cancelled error', async () => {
            authManager.isGuestMode.mockReturnValue(false);
            authManager.listSavedWallets.mockReturnValue([{ address: '0x1', name: 'W' }]);
            walletFlows.showUnlockWalletModal = vi.fn().mockRejectedValue(new Error('cancelled'));
            authManager.getAddress.mockReturnValue(null);

            await walletFlows.connectWallet();

            expect(uiController.showNotification).not.toHaveBeenCalled();
        });
    });
});
