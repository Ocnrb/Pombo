/**
 * inviteHandler.js Extended Tests
 * Covers: showInviteDialog, checkInviteLink connected branch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        isConnected: vi.fn().mockReturnValue(false)
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        parseInviteLink: vi.fn(),
        joinChannel: vi.fn()
    }
}));

vi.mock('../../src/js/ui.js', () => ({
    uiController: {
        showLoading: vi.fn(),
        hideLoading: vi.fn(),
        showNotification: vi.fn(),
        renderChannelList: vi.fn()
    }
}));

vi.mock('../../src/js/notifications.js', () => ({
    notificationManager: {
        acceptInvite: vi.fn().mockResolvedValue(undefined),
        dismissInvite: vi.fn()
    }
}));

vi.mock('../../src/js/ui/utils.js', () => ({
    escapeHtml: vi.fn((str) => str)
}));

vi.mock('../../src/js/ui/sanitizer.js', () => ({
    sanitizeText: vi.fn((str) => str)
}));

vi.mock('../../src/js/ui/modalUtils.js', () => ({
    createModalFromTemplate: vi.fn(),
    bindData: vi.fn(),
    closeModal: vi.fn(),
    setupModalCloseHandlers: vi.fn(),
    $: vi.fn()
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { inviteHandler } from '../../src/js/inviteHandler.js';
import { authManager } from '../../src/js/auth.js';
import { channelManager } from '../../src/js/channels.js';
import {
    createModalFromTemplate,
    bindData,
    closeModal,
    setupModalCloseHandlers,
    $
} from '../../src/js/ui/modalUtils.js';
import { sanitizeText } from '../../src/js/ui/sanitizer.js';

describe('inviteHandler extended', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        inviteHandler.pendingInvite = null;
        authManager.isConnected.mockReturnValue(false);
        // Default $ returns an element with addEventListener
        $.mockReturnValue({ addEventListener: vi.fn() });
    });

    // ==================== showInviteDialog ====================
    describe('showInviteDialog()', () => {
        const inviteData = {
            name: 'Test Channel',
            type: 'public',
            streamId: '0xowner/test-channel-1'
        };

        it('should return early if modal template not found', () => {
            createModalFromTemplate.mockReturnValue(null);

            inviteHandler.showInviteDialog(inviteData);

            expect(bindData).not.toHaveBeenCalled();
        });

        it('should create modal from template', () => {
            const mockModal = createMockModal();
            createModalFromTemplate.mockReturnValue(mockModal);

            inviteHandler.showInviteDialog(inviteData);

            expect(createModalFromTemplate).toHaveBeenCalledWith('modal-invite');
        });

        it('should bind sanitized channel data to modal', () => {
            const mockModal = createMockModal();
            createModalFromTemplate.mockReturnValue(mockModal);
            sanitizeText.mockImplementation((s) => `safe:${s}`);

            inviteHandler.showInviteDialog(inviteData);

            expect(bindData).toHaveBeenCalledWith(mockModal, {
                channelName: 'safe:Test Channel',
                channelType: 'Public Channel',
                streamId: 'safe:0xowner/test-channel-1'
            });
        });

        it('should setup close handlers on modal', () => {
            const mockModal = createMockModal();
            createModalFromTemplate.mockReturnValue(mockModal);

            inviteHandler.showInviteDialog(inviteData);

            expect(setupModalCloseHandlers).toHaveBeenCalledWith(mockModal, expect.any(Function));
        });

        it('should add decline click handler', () => {
            const mockModal = createMockModal();
            const declineBtn = { addEventListener: vi.fn() };
            $.mockImplementation((el, sel) => {
                if (sel === '[data-action="decline"]') return declineBtn;
                return { addEventListener: vi.fn() };
            });
            createModalFromTemplate.mockReturnValue(mockModal);

            inviteHandler.showInviteDialog(inviteData);

            expect(declineBtn.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
        });

        it('should close modal when decline is clicked', () => {
            const mockModal = createMockModal();
            const declineBtn = { addEventListener: vi.fn() };
            const acceptBtn = { addEventListener: vi.fn() };
            $.mockImplementation((el, sel) => {
                if (sel === '[data-action="decline"]') return declineBtn;
                if (sel === '[data-action="accept"]') return acceptBtn;
                return { addEventListener: vi.fn() };
            });
            createModalFromTemplate.mockReturnValue(mockModal);

            inviteHandler.showInviteDialog(inviteData);

            // Simulate decline click
            const declineHandler = declineBtn.addEventListener.mock.calls[0][1];
            declineHandler();

            expect(closeModal).toHaveBeenCalledWith(mockModal);
        });

        it('should add accept click handler', () => {
            const mockModal = createMockModal();
            const acceptBtn = { addEventListener: vi.fn() };
            $.mockImplementation((el, sel) => {
                if (sel === '[data-action="accept"]') return acceptBtn;
                return { addEventListener: vi.fn() };
            });
            createModalFromTemplate.mockReturnValue(mockModal);

            inviteHandler.showInviteDialog(inviteData);

            expect(acceptBtn.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
        });

        it('should close modal and join channel on accept', () => {
            const mockModal = createMockModal();
            const acceptBtn = { addEventListener: vi.fn() };
            $.mockImplementation((el, sel) => {
                if (sel === '[data-action="accept"]') return acceptBtn;
                return { addEventListener: vi.fn() };
            });
            createModalFromTemplate.mockReturnValue(mockModal);
            const joinSpy = vi.spyOn(inviteHandler, 'joinChannelFromInvite').mockResolvedValue(undefined);

            inviteHandler.showInviteDialog(inviteData);

            // Simulate accept click
            const acceptHandler = acceptBtn.addEventListener.mock.calls[0][1];
            acceptHandler();

            expect(closeModal).toHaveBeenCalledWith(mockModal);
            expect(joinSpy).toHaveBeenCalledWith(inviteData);
        });
    });

    // ==================== checkInviteLink connected branch ====================
    describe('checkInviteLink() when connected', () => {
        let originalLocation;

        beforeEach(() => {
            originalLocation = window.location;
            delete window.location;
            window.location = {
                search: '?invite=valid-code',
                pathname: '/test',
                hash: ''
            };
            window.history.replaceState = vi.fn();
        });

        afterEach(() => {
            window.location = originalLocation;
        });

        it('should call showInviteDialog when wallet is connected', () => {
            const inviteData = { name: 'Test', type: 'public', streamId: '0xabc/test-1' };
            channelManager.parseInviteLink.mockReturnValue(inviteData);
            authManager.isConnected.mockReturnValue(true);
            const showSpy = vi.spyOn(inviteHandler, 'showInviteDialog').mockImplementation(() => {});

            inviteHandler.checkInviteLink();

            expect(showSpy).toHaveBeenCalledWith(inviteData);
            expect(inviteHandler.pendingInvite).toBeNull();
        });
    });
});

/**
 * Helper to create a mock modal DOM element
 */
function createMockModal() {
    return {
        querySelector: vi.fn().mockReturnValue({ addEventListener: vi.fn() }),
        classList: { add: vi.fn(), remove: vi.fn() },
        remove: vi.fn()
    };
}
