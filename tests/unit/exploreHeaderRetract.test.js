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

/**
 * Drive one evaluation from a given position. The listener itself defers to
 * requestAnimationFrame; these go straight at the decision so the assertions
 * stay synchronous.
 */
function scrollTo(position) {
    scroller.scrollTop = position;
    exploreUI._evaluateExploreHeader();
}

/** Reach a position the way a reader does, in steps rather than one jump. */
function scrollBy(from, to, step = 40) {
    const down = to > from;
    let at = from;
    while (down ? at < to : at > to) {
        at = down ? Math.min(at + step, to) : Math.max(at - step, to);
        scrollTo(at);
    }
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
        exploreUI._exploreScrollIntent = 0;
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

    it('waits for travel in one direction before answering', () => {
        scrollTo(300);
        expect(isRetracted()).toBe(true);
        // Short of the intent threshold: the reflow retracting causes reports
        // movement of its own, and answering it restarts the transition.
        scrollTo(288);
        expect(isRetracted()).toBe(true);
    });

    it('does not spend a downward flick answering the way back up', () => {
        scrollTo(300);
        expect(isRetracted()).toBe(true);
        // Turning around starts the count over, so these do not add up to a
        // reveal until the reader has genuinely gone back.
        scrollTo(290);
        scrollTo(300);
        scrollTo(290);
        expect(isRetracted()).toBe(true);
        scrollBy(290, 200);
        expect(isRetracted()).toBe(false);
    });

    it('leaves the header alone at the end of the list', () => {
        // Retracting there shortens the scrollable range with nothing left to
        // absorb it; the browser pulls scrollTop back, that reads as scrolling
        // up, and the header oscillates.
        scrollBy(0, MAX_SCROLL);
        const settled = isRetracted();
        scrollTo(MAX_SCROLL);
        scrollTo(MAX_SCROLL);
        expect(isRetracted()).toBe(settled);
    });

    it('still reveals on the way up from the end of the list', () => {
        scrollBy(0, 900);
        expect(isRetracted()).toBe(true);
        scrollBy(900, MAX_SCROLL);
        scrollBy(MAX_SCROLL, MAX_SCROLL - 200);
        expect(isRetracted()).toBe(false);
    });

    it('clamps overscroll rather than counting it as travel', () => {
        scrollTo(300);
        expect(isRetracted()).toBe(true);

        // Rubber-banding past the top is still the top, and the header belongs
        // there. What must not happen is the bounce being measured as distance
        // of its own once the position settles back.
        scrollTo(-80);
        expect(isRetracted()).toBe(false);
        expect(exploreUI._lastExploreScrollTop).toBe(0);

        scrollTo(MAX_SCROLL + 80);
        expect(exploreUI._lastExploreScrollTop).toBe(MAX_SCROLL);
    });

    it('leaves the chat view alone, which scrolls the same element', () => {
        document.body.className = '';
        scrollTo(300);
        expect(isRetracted()).toBe(false);
    });
});
