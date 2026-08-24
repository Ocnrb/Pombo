/**
 * PinnedBannerUI Tests
 * Covers: newest-pin-first ordering and the dismiss walk-back through history.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/ui/PreviewModeUI.js', () => ({
    previewModeUI: {
        getPreviewChannel: vi.fn(() => null)
    }
}));

vi.mock('../../src/js/ui/utils.js', () => ({
    formatAddress: vi.fn(a => (a ? a.substring(0, 8) : ''))
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getCachedENS: vi.fn(() => null)
    }
}));

const { pinnedBannerUI } = await import('../../src/js/ui/PinnedBannerUI.js');

function makePin(targetId, text, pinnedAt) {
    return {
        targetId,
        pinnedAt,
        snapshot: { sender: '0xabcdef0123', text, senderName: 'Alice' }
    };
}

describe('PinnedBannerUI', () => {
    let elements;
    let channel;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="pinned-banner" class="pinned-banner hidden">
                <div id="pinned-banner-name"></div>
                <div id="pinned-banner-text"></div>
                <span id="pinned-banner-count" class="hidden"></span>
                <button id="pinned-banner-close"></button>
            </div>
        `;
        elements = {
            banner: document.getElementById('pinned-banner'),
            name: document.getElementById('pinned-banner-name'),
            text: document.getElementById('pinned-banner-text'),
            count: document.getElementById('pinned-banner-count'),
            closeBtn: document.getElementById('pinned-banner-close')
        };

        pinnedBannerUI._dismissed = new Map();
        pinnedBannerUI._currentPin = null;
        pinnedBannerUI._currentStreamId = null;
        pinnedBannerUI.elements = elements;

        channel = {
            streamId: 'stream-1',
            messages: [],
            adminState: { pins: [] }
        };
        pinnedBannerUI.setDependencies({
            getActiveChannel: () => channel,
            channelManager: {},
            chatAreaUI: { scrollToMessage: vi.fn() }
        });
    });

    it('shows the most recently pinned message', () => {
        channel.adminState.pins = [
            makePin('m1', 'oldest', 1000),
            makePin('m2', 'middle', 2000),
            makePin('m3', 'newest', 3000)
        ];

        pinnedBannerUI.update();

        expect(elements.banner.classList.contains('hidden')).toBe(false);
        expect(elements.text.textContent).toBe('newest');
    });

    it('counts the pins a dismissal would still reveal', () => {
        channel.adminState.pins = [
            makePin('m1', 'oldest', 1000),
            makePin('m2', 'middle', 2000),
            makePin('m3', 'newest', 3000)
        ];

        pinnedBannerUI.update();
        expect(elements.count.textContent).toBe('+2');
        expect(elements.count.classList.contains('hidden')).toBe(false);

        pinnedBannerUI.dismissCurrent();
        expect(elements.count.textContent).toBe('+1');

        pinnedBannerUI.dismissCurrent();
        expect(elements.count.textContent).toBe('');
        expect(elements.count.classList.contains('hidden')).toBe(true);
    });

    it('hides the counter for a lone pin', () => {
        channel.adminState.pins = [makePin('m1', 'only', 1000)];

        pinnedBannerUI.update();

        expect(elements.count.classList.contains('hidden')).toBe(true);
    });

    it('shows the newest pin even when every pinnedAt is identical', () => {
        // Android restamps every pin's `pinnedAt` on each ADMIN_STATE
        // republish, so only array order distinguishes them.
        channel.adminState.pins = [
            makePin('m1', 'oldest', 5000),
            makePin('m2', 'newest', 5000)
        ];

        pinnedBannerUI.update();

        expect(elements.text.textContent).toBe('newest');
    });

    it('walks back through older pins on each dismissal, then hides', () => {
        channel.adminState.pins = [
            makePin('m1', 'oldest', 1000),
            makePin('m2', 'middle', 2000),
            makePin('m3', 'newest', 3000)
        ];

        pinnedBannerUI.update();
        expect(elements.text.textContent).toBe('newest');

        pinnedBannerUI.dismissCurrent();
        expect(elements.text.textContent).toBe('middle');

        pinnedBannerUI.dismissCurrent();
        expect(elements.text.textContent).toBe('oldest');

        pinnedBannerUI.dismissCurrent();
        expect(elements.banner.classList.contains('hidden')).toBe(true);
    });

    it('showAndScroll clears dismissals and returns to the newest pin', () => {
        channel.adminState.pins = [
            makePin('m1', 'oldest', 1000),
            makePin('m2', 'newest', 2000)
        ];

        pinnedBannerUI.update();
        pinnedBannerUI.dismissCurrent();
        expect(elements.text.textContent).toBe('oldest');

        pinnedBannerUI.showAndScroll();

        expect(elements.banner.classList.contains('hidden')).toBe(false);
        expect(elements.text.textContent).toBe('newest');
        expect(pinnedBannerUI.deps.chatAreaUI.scrollToMessage).toHaveBeenCalledWith('m2');
    });

    it('drops dismissals for pins that no longer exist', () => {
        channel.adminState.pins = [makePin('m1', 'only', 1000)];
        pinnedBannerUI.update();
        pinnedBannerUI.dismissCurrent();
        expect(elements.banner.classList.contains('hidden')).toBe(true);

        // Unpinned, then pinned again → the banner comes back.
        channel.adminState.pins = [];
        pinnedBannerUI._reconcileDismissals(channel);
        channel.adminState.pins = [makePin('m1', 'only', 4000)];
        pinnedBannerUI.update();

        expect(elements.banner.classList.contains('hidden')).toBe(false);
        expect(elements.text.textContent).toBe('only');
    });
});
