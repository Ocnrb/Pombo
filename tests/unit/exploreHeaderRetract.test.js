import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/js/ui/utils.js', () => ({
    escapeHtml: vi.fn(value => value ?? ''),
    escapeAttr: vi.fn(value => value ?? '')
}));

vi.mock('../../src/js/ui/sanitizer.js', () => ({
    sanitizeText: vi.fn(value => value ?? '')
}));

vi.mock('../../src/js/exploreCuration.js', () => ({
    loadCurationManifest: vi.fn(async () => ({})),
    applyCuration: vi.fn(channels => channels)
}));

vi.mock('../../src/js/channelImageManager.js', () => ({
    channelImageManager: { getCached: vi.fn(() => null) }
}));

vi.mock('../../src/js/channelLatestMessageManager.js', () => ({
    channelLatestMessageManager: {
        getCached: vi.fn(() => null),
        get: vi.fn(async () => null),
        subscribe: vi.fn(() => () => {})
    }
}));

vi.mock('../../src/js/streamConstants.js', () => ({
    deriveAdminId: vi.fn(() => null)
}));

vi.mock('../../src/js/ui/AvatarGenerator.js', () => ({
    getAvatarHtml: vi.fn(() => '<div></div>')
}));

vi.mock('../../src/js/ui/channelPreviewFormatter.js', () => ({
    formatPreviewLine: vi.fn(() => '')
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: { ensCache: new Map(), resolveENS: vi.fn(async () => null) }
}));

import { exploreUI } from '../../src/js/ui/ExploreUI.js';

const VIEWPORT = 400;
const CONTENT = 2000;
/** Furthest scrollTop the scroller can legitimately report. */
const MAX_SCROLL = CONTENT - VIEWPORT;

let scroller;

/** Drive the handler the way a scroll event would, from a given position. */
function scrollTo(position) {
    scroller.scrollTop = position;
    exploreUI._handleExploreHeaderScroll();
}

const isRetracted = () => document.body.classList.contains('explore-header-retracted');

describe('Explore header retraction', () => {
    beforeEach(() => {
        document.body.className = 'explore-open';
        document.body.innerHTML = '<div id="messages-area"></div>';
        scroller = document.getElementById('messages-area');
        Object.defineProperty(scroller, 'scrollHeight', { value: CONTENT, configurable: true });
        Object.defineProperty(scroller, 'clientHeight', { value: VIEWPORT, configurable: true });
        exploreUI._lastExploreScrollTop = 0;
    });

    it('retracts once the list has scrolled past the header', () => {
        scrollTo(200);
        expect(isRetracted()).toBe(true);
    });

    it('stays while the header row itself is still on screen', () => {
        scrollTo(40);
        expect(isRetracted()).toBe(false);
    });

    it('comes back on the way up', () => {
        scrollTo(300);
        expect(isRetracted()).toBe(true);
        scrollTo(200);
        expect(isRetracted()).toBe(false);
    });

    it('ignores movement inside the dead zone', () => {
        scrollTo(300);
        expect(isRetracted()).toBe(true);
        // A nudge smaller than the dead zone must not restore it, or the
        // reflow retracting causes could toggle the header back and forth.
        scrollTo(296);
        expect(isRetracted()).toBe(true);
    });

    it('ignores overscroll beyond either end', () => {
        scrollTo(300);
        expect(isRetracted()).toBe(true);
        scrollTo(-80);
        expect(isRetracted()).toBe(true);
        scrollTo(MAX_SCROLL + 80);
        expect(isRetracted()).toBe(true);
    });

    it('leaves the chat view alone, which scrolls the same element', () => {
        document.body.className = '';
        scrollTo(300);
        expect(isRetracted()).toBe(false);
    });
});
