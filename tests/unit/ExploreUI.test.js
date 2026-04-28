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
    channelImageManager: {
        getCached: vi.fn(() => null)
    }
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
    identityManager: {
        ensCache: new Map(),
        resolveENS: vi.fn(async () => null)
    }
}));

import { exploreUI } from '../../src/js/ui/ExploreUI.js';

describe('ExploreUI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        exploreUI.browseTypeFilter = 'public';
        exploreUI.browseCategoryFilter = '';
        exploreUI.browseLanguageFilterValue = '';
        exploreUI.cachedPublicChannels = null;
        exploreUI.deps = {};
        document.body.innerHTML = exploreUI.getTemplate(true);
    });

    it('renders the editorial chip order and keeps Private last when sensitive chips are visible', () => {
        const labels = Array.from(document.querySelectorAll('#explore-category-chips > button'))
            .map(button => button.textContent.replace(/\s+/g, ' ').trim());

        expect(labels).toEqual([
            'All',
            'General',
            'News',
            'Crypto',
            'Finance',
            'Politics',
            'Science',
            'Gaming',
            'Sports',
            'Health',
            'Tech & AI',
            'Entertainment',
            'Education',
            'Comedy',
            'NSFW',
            'Adult',
            'Private'
        ]);
    });

    it('activating Private resets the category filter back to All', () => {
        exploreUI.setupListeners();

        const adultChip = document.querySelector('.explore-category-chip[data-category="adult"]');
        const allChip = document.querySelector('.explore-category-chip[data-category=""]');
        const privateChip = document.getElementById('explore-private-chip');

        adultChip.click();
        expect(exploreUI.browseCategoryFilter).toBe('adult');

        privateChip.click();

        expect(exploreUI.browseTypeFilter).toBe('password');
        expect(exploreUI.browseCategoryFilter).toBe('');
        expect(allChip.classList.contains('bg-white')).toBe(true);
        expect(adultChip.classList.contains('bg-white')).toBe(false);
    });

    it('uses a horizontal carousel when collapsed and keeps wrapped mode for expand', () => {
        exploreUI.setupListeners();

        const container = document.getElementById('explore-category-chips');
        const button = document.getElementById('explore-toggle-categories-btn');
        const rail = document.querySelector('.explore-category-rail');

        Object.defineProperty(container, 'clientWidth', {
            configurable: true,
            get: () => 120
        });
        Object.defineProperty(container, 'scrollWidth', {
            configurable: true,
            get: () => 360
        });

        exploreUI.checkCategoriesOverflow();

        expect(container.dataset.expanded).toBe('false');
        expect(button.classList.contains('flex')).toBe(true);
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(rail.dataset.overflow).toBe('true');
        expect(rail.dataset.scrollStart).toBe('true');
        expect(rail.dataset.scrollEnd).toBe('false');

        container.scrollLeft = 48;
        container.dispatchEvent(new Event('scroll'));

        expect(rail.dataset.scrollStart).toBe('false');

        button.click();

        expect(container.dataset.expanded).toBe('true');
        expect(button.getAttribute('aria-expanded')).toBe('true');

        container.scrollLeft = 48;
        button.click();

        expect(container.dataset.expanded).toBe('false');
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(container.scrollLeft).toBe(0);
        expect(rail.dataset.scrollStart).toBe('true');
    });
});
