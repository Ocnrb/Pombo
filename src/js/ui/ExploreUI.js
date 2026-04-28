/**
 * Explore UI Manager
 * Handles the Explore view (front-page) for browsing public channels
 */

import { escapeHtml, escapeAttr } from './utils.js';
import { sanitizeText } from './sanitizer.js';
import { loadCurationManifest, applyCuration } from '../exploreCuration.js';
import { channelImageManager } from '../channelImageManager.js';
import { channelLatestMessageManager } from '../channelLatestMessageManager.js';
import { deriveAdminId } from '../streamConstants.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { formatPreviewLine } from './channelPreviewFormatter.js';
import { identityManager } from '../identity.js';

class ExploreUI {
    constructor() {
        // Filter state
        this.browseTypeFilter = 'public';
        this.browseCategoryFilter = '';
        this.browseLanguageFilterValue = '';
        
        // Cached channels
        this.cachedPublicChannels = null;
        this._handleCategoryViewportChange = () => {
            this.checkCategoriesOverflow();
        };
        this._handleCategoryRailScroll = () => {
            this._syncCategoryCarouselHints();
        };
        
        this.deps = {};
    }

    /**
     * Set dependencies
     * @param {Object} deps - { getPublicChannels, joinPublicChannel(streamId, channelInfo), getNsfwEnabled }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Generate the Explore view HTML template
     * @param {boolean} nsfwEnabled - Whether NSFW content is enabled
     * @returns {string} HTML template
     */
    getTemplate(nsfwEnabled = false) {
        const chipClass = 'explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80';
        const orderedCategoryChips = [
            { category: '', label: 'All', active: true },
            { category: 'general', label: 'General' },
            { category: 'news', label: 'News' },
            { category: 'crypto', label: 'Crypto' },
            { category: 'finance', label: 'Finance' },
            { category: 'politics', label: 'Politics' },
            { category: 'science', label: 'Science' },
            { category: 'gaming', label: 'Gaming' },
            { category: 'sports', label: 'Sports' },
            { category: 'health', label: 'Health' },
            { category: 'tech', label: 'Tech & AI' },
            { category: 'entertainment', label: 'Entertainment' },
            { category: 'education', label: 'Education' },
            { category: 'comedy', label: 'Comedy' },
            ...(nsfwEnabled
                ? [
                    { category: 'nsfw', label: 'NSFW' },
                    { category: 'adult', label: 'Adult' }
                ]
                : []),
        ];
        const categoryChips = orderedCategoryChips.map(chip => {
            const classes = chip.active ? 'explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white text-black' : chipClass;
            return `<button type="button" data-category="${chip.category}" class="${classes}">${chip.label}</button>`;
        }).join('');

        return `
            <div class="explore-view flex flex-col h-full bg-[#0f0f12]">
                <!-- Filters Section -->
                <div class="px-4 pt-3 pb-3 space-y-3">
                    <!-- Search + Language Filter -->
                    <div class="flex gap-3">
                        <div class="flex-1 relative">
                            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
                            </svg>
                            <input
                                type="search"
                                id="explore-search-input"
                                name="pombo_explore_filter"
                                placeholder="Search channels..."
                                autocomplete="off"
                                data-lpignore="true"
                                data-1p-ignore="true"
                                data-form-type="other"
                                class="w-full bg-white/5 border border-white/10 text-white pl-10 pr-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-white/30 transition placeholder:text-white/30"
                            />
                        </div>
                        <select id="explore-language-filter" class="bg-white/5 border border-white/10 text-white/80 px-3 py-2.5 rounded-xl text-sm focus:outline-none focus:border-white/30 transition cursor-pointer">
                            <option value="" selected>All Languages</option>
                            <option value="en">English</option>
                            <option value="pt">Português</option>
                            <option value="es">Español</option>
                            <option value="fr">Français</option>
                            <option value="de">Deutsch</option>
                            <option value="it">Italiano</option>
                            <option value="zh">中文</option>
                            <option value="ja">日本語</option>
                            <option value="ko">한국어</option>
                            <option value="ru">Русский</option>
                            <option value="ar">العربية</option>
                            <option value="other">Other</option>
                        </select>
                    </div>

                    <!-- Category Chips (collapsible) -->
                    <div class="explore-category-controls">
                        <div class="explore-category-rail" data-overflow="false" data-scroll-start="true" data-scroll-end="true">
                            <div id="explore-category-chips" class="explore-category-chips flex gap-1.5 transition-all duration-200" data-expanded="false">
                                ${categoryChips}
                                <button type="button" id="explore-private-chip" class="explore-private-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80 flex items-center gap-1">
                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>
                                    Private
                                </button>
                            </div>
                        </div>
                        <button id="explore-toggle-categories-btn" type="button" aria-controls="explore-category-chips" aria-expanded="false" class="explore-toggle-categories-btn hidden items-center justify-center text-white/40 hover:text-white/60 transition">
                            <svg id="explore-toggle-categories-icon" class="w-4 h-4 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 9l-7 7-7-7"/>
                            </svg>
                        </button>
                    </div>
                </div>

                <!-- Subtle separator -->
                <div class="mx-4 border-t border-white/[0.06]"></div>

                <!-- Channel List -->
                <div id="explore-channels-list" class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                    <div class="flex flex-col items-center justify-center py-12 text-white/40">
                        <div class="spinner mb-3" style="width: 28px; height: 28px;"></div>
                        <p class="text-sm">Loading channels...</p>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Setup event listeners for the Explore view
     */
    setupListeners() {
        // Search input
        const searchInput = document.getElementById('explore-search-input');
        searchInput?.addEventListener('input', (e) => {
            this.filterChannels(e.target.value);
        });
        
        // Private chip toggle
        const privateChip = document.getElementById('explore-private-chip');
        privateChip?.addEventListener('click', () => {
            const isActive = this.browseTypeFilter === 'password';
            this.browseTypeFilter = isActive ? 'public' : 'password';
            if (!isActive) {
                this.browseCategoryFilter = '';
                this.updateCategoryChips();
            }
            this.updatePrivateChip();
            this.filterChannels(searchInput?.value || '');
        });
        
        // Category chips
        document.querySelectorAll('.explore-category-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                this.browseCategoryFilter = chip.dataset.category;
                this.updateCategoryChips();
                this.filterChannels(searchInput?.value || '');
            });
        });
        
        // Toggle categories expand/collapse
        document.getElementById('explore-toggle-categories-btn')?.addEventListener('click', () => {
            this.toggleCategoriesExpand();
        });
        document.getElementById('explore-category-chips')?.addEventListener('scroll', this._handleCategoryRailScroll, { passive: true });

        window.removeEventListener('resize', this._handleCategoryViewportChange);
        window.addEventListener('resize', this._handleCategoryViewportChange);
        
        // Check if categories need expand button
        this.checkCategoriesOverflow();
        
        // Language filter
        const langFilter = document.getElementById('explore-language-filter');
        langFilter?.addEventListener('change', (e) => {
            this.browseLanguageFilterValue = e.target.value;
            this.filterChannels(searchInput?.value || '');
        });
    }

    /**
     * Reset filters to default state
     */
    resetFilters() {
        this.browseTypeFilter = 'public';
        this.browseCategoryFilter = '';
        this.browseLanguageFilterValue = '';
        
        // Sync language dropdown
        const langDropdown = document.getElementById('explore-language-filter');
        if (langDropdown) {
            langDropdown.value = this.browseLanguageFilterValue;
        }
        
        // Sync tab and chip UI to match reset state
        this.updatePrivateChip();
        this.updateCategoryChips();
    }

    /**
     * Load channels from the API
     */
    async loadChannels() {
        const listEl = document.getElementById('explore-channels-list');
        if (!listEl) return;

        // New Explore session: revalidate visible previews once even when
        // a cached entry already exists, but avoid re-fetching again on
        // every filter/search rerender within the same open view.
        this._explorePreviewResolved = new Set();
        this._explorePreviewRefreshStarted = new Set();

        listEl.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-white/40">
                <div class="spinner mb-3" style="width: 28px; height: 28px;"></div>
                <p class="text-sm">Loading channels...</p>
            </div>
        `;

        try {
            if (!this.deps.getPublicChannels) {
                throw new Error('getPublicChannels dependency not set');
            }
            // Fetch channels and curation manifest in parallel; curation failure
            // is non-fatal (helper falls back to an empty manifest).
            const [channels, manifest] = await Promise.all([
                this.deps.getPublicChannels(),
                loadCurationManifest(),
            ]);
            this.cachedPublicChannels = applyCuration(channels, manifest);
            this.filterChannels('');
        } catch (error) {
            console.error('Failed to load explore channels:', error);
            listEl.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-white/40">
                    <svg class="w-12 h-12 mb-3 text-red-400/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                    </svg>
                    <p class="text-sm">Failed to load channels</p>
                    <p class="text-xs text-white/30 mt-1">${escapeHtml(error.message)}</p>
                </div>
            `;
        }
    }

    /**
     * Filter channels based on current filter state
     * @param {string} query - Search query
     */
    filterChannels(query) {
        if (!this.cachedPublicChannels) return;
        
        let filtered = this.cachedPublicChannels;
        
        // Apply type filter
        if (this.browseTypeFilter) {
            filtered = filtered.filter(ch => ch.type === this.browseTypeFilter);
        }
        
        // Apply category filter
        if (this.browseCategoryFilter) {
            filtered = filtered.filter(ch => ch.category === this.browseCategoryFilter);
        }
        
        // Exclude NSFW/Adult channels unless:
        // 1. User explicitly selected NSFW/Adult category
        // 2. User has enabled "Show Sensitive Content" in settings
        const nsfwEnabled = this.deps.getNsfwEnabled ? this.deps.getNsfwEnabled() : false;
        if (this.browseCategoryFilter !== 'nsfw' && this.browseCategoryFilter !== 'adult' && !nsfwEnabled) {
            filtered = filtered.filter(ch => ch.category !== 'nsfw' && ch.category !== 'adult');
        }
        
        // Apply language filter (only when a specific language is selected, not "All")
        if (this.browseLanguageFilterValue) {
            filtered = filtered.filter(ch => ch.language === this.browseLanguageFilterValue);
        }
        
        // Apply search filter
        if (query) {
            const q = query.toLowerCase();
            filtered = filtered.filter(ch => 
                (ch.name || ch.displayName || '').toLowerCase().includes(q) ||
                ch.streamId.toLowerCase().includes(q) ||
                (ch.description && ch.description.toLowerCase().includes(q))
            );
        }
        
        this.renderChannelsList(filtered);
    }

    /**
     * Render the filtered channels list
     * @param {Array} channels - Array of channel objects
     */
    renderChannelsList(channels) {
        const listEl = document.getElementById('explore-channels-list');
        if (!listEl) return;

        if (channels.length === 0) {
            listEl.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-white/40">
                    <svg class="w-12 h-12 mb-3 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
                    </svg>
                    <p class="text-sm">No channels found</p>
                    <p class="text-xs text-white/30 mt-1">Try adjusting your filters</p>
                </div>
            `;
            return;
        }
        
        const categoryNames = {
            politics: 'Politics', news: 'News', tech: 'Tech & AI', crypto: 'Crypto',
            finance: 'Finance', science: 'Science', gaming: 'Gaming', entertainment: 'Entertainment',
            sports: 'Sports', health: 'Health', education: 'Education', comedy: 'Comedy', 
            general: 'General', other: 'Other', nsfw: 'NSFW', adult: 'Adult'
        };
        
        const languageNames = { 
            en: 'EN', pt: 'PT', es: 'ES', fr: 'FR', de: 'DE', 
            it: 'IT', zh: '中文', ja: '日本語', ko: '한국어', ru: 'RU', ar: 'العربية', other: 'Other'
        };

        listEl.innerHTML = channels.map(ch => {
            const readOnlyBadge = ch.readOnly 
                ? '<svg class="w-3.5 h-3.5 md:w-5 md:h-5 text-white/50 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>' 
                : '';
            const categoryBadge = ch.category && ch.category !== 'general'
                ? `<span class="px-1.5 py-0.5 bg-white/5 text-white/50 text-[9px] font-medium rounded">${escapeHtml(categoryNames[ch.category] || ch.category)}</span>`
                : '';
            const languageBadge = ch.language
                ? `<span class="px-1.5 py-0.5 bg-white/5 text-white/40 text-[9px] font-medium rounded">${escapeHtml(languageNames[ch.language] || ch.language.toUpperCase())}</span>`
                : '';
            // Defense-in-depth: sanitize user-provided content before escaping
            const description = ch.description 
                ? `<p class="text-xs text-white/40 mt-1 line-clamp-2">${escapeHtml(sanitizeText(ch.description))}</p>` 
                : '';

            // Latest message preview (sidebar/Explore share the same source).
            // Cached read first; lazy-fetch dispatched after innerHTML below.
            if (!this._explorePreviewResolved) this._explorePreviewResolved = new Set();
            const previewEntry = channelLatestMessageManager.getCached(ch.streamId);
            // `.channel-preview-line.explore-preview-line` controls color
            // (uniform muted gray) and wrapping (clamp 2 lines desktop /
            // 3 lines mobile). Drop the explicit `truncate` class — the
            // CSS rule handles overflow with multi-line clamping.
            let previewLine;
            if (previewEntry) {
                previewLine = `<p class="channel-preview-line explore-preview-line mt-2" data-channel-preview="${escapeAttr(ch.streamId)}">${formatPreviewLine(previewEntry)}</p>`;
            } else if (!this._explorePreviewResolved.has(ch.streamId)) {
                previewLine = `<p class="channel-preview-line explore-preview-line mt-2" data-channel-preview="${escapeAttr(ch.streamId)}"><span class="thumb-spinner inline-block align-middle" style="width:10px;height:10px"></span></p>`;
            } else {
                // Resolved without a usable entry → leave the slot empty
                // (avoids a permanent dead spinner on dormant channels).
                previewLine = `<p class="channel-preview-line explore-preview-line mt-2" data-channel-preview="${escapeAttr(ch.streamId)}"></p>`;
            }

            // Channel thumbnail: cached if available, else spinner placeholder
            // (or deterministic fallback once lookup has settled).
            // We always pass through the manager so the same fetch is
            // shared with the sidebar and Channel Details panes.
            const adminStreamId = deriveAdminId(ch.streamId);
            const cachedImage = adminStreamId ? channelImageManager.getCached(adminStreamId) : null;
            if (!this._exploreResolvedImages) this._exploreResolvedImages = new Set();
            let thumb;
            if (cachedImage?.dataUrl) {
                thumb = `<img class="rounded-full object-cover flex-shrink-0" alt="" src="${escapeAttr(cachedImage.dataUrl)}" data-channel-thumb="${escapeAttr(adminStreamId)}" style="width:52px;height:52px" />`;
            } else if (adminStreamId && !this._exploreResolvedImages.has(adminStreamId)) {
                thumb = `<div class="rounded-full flex items-center justify-center flex-shrink-0 bg-white/[0.04]" data-channel-thumb="${escapeAttr(adminStreamId)}" style="width:52px;height:52px"><div class="thumb-spinner" style="width:20px;height:20px"></div></div>`;
            } else {
                thumb = `<div class="rounded-full overflow-hidden flex-shrink-0" data-channel-thumb="${escapeAttr(adminStreamId || '')}" style="width:52px;height:52px">${getAvatarHtml(ch.streamId, 52, 0.5, null)}</div>`;
            }

            return `
            <div class="p-3.5 bg-white/[0.03] border border-white/[0.05] rounded-2xl hover:bg-white/[0.06] hover:border-white/[0.1] transition-all duration-200 cursor-pointer explore-channel-item group" data-stream-id="${escapeAttr(ch.streamId)}" data-type="${escapeAttr(ch.type || 'public')}">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex items-start gap-3 flex-1 min-w-0">
                        ${thumb}
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                                ${readOnlyBadge}
                                <h4 class="text-sm font-medium text-white/90 truncate">${escapeHtml(sanitizeText(ch.name || ch.displayName || 'Unknown'))}</h4>
                            </div>
                            ${description}
                            ${previewLine}
                        </div>
                    </div>
                    <svg class="w-4 h-4 text-white/15 group-hover:text-white/30 flex-shrink-0 mt-0.5 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                </div>
                <div class="flex items-center gap-1.5 mt-2.5">
                    ${categoryBadge}
                    ${languageBadge}
                </div>
            </div>
            `;
        }).join('');

        // Lazy-fetch missing thumbnails (deduped by manager).
        // Public/password channels are publicly readable on -3, so this works
        // even before joining. Native channels will simply fall back.
        for (const ch of channels) {
            const adminStreamId = deriveAdminId(ch.streamId);
            if (!adminStreamId) continue;
            if (channelImageManager.getCached(adminStreamId)?.dataUrl) continue;
            if (this._exploreResolvedImages.has(adminStreamId)) continue;
            channelImageManager.get(adminStreamId, { password: null })
                .then(entry => {
                    if (!entry?.dataUrl) return;
                    const slot = listEl.querySelector(`[data-channel-thumb="${CSS.escape(adminStreamId)}"]`);
                    if (slot && !(slot.tagName === 'IMG')) {
                        slot.outerHTML = `<img class="rounded-full object-cover flex-shrink-0" alt="" src="${escapeAttr(entry.dataUrl)}" data-channel-thumb="${escapeAttr(adminStreamId)}" style="width:52px;height:52px" />`;
                    } else if (slot && slot.tagName === 'IMG') {
                        slot.src = entry.dataUrl;
                    }
                })
                .catch(() => {})
                .finally(() => {
                    this._exploreResolvedImages.add(adminStreamId);
                    // If still showing spinner placeholder (no image found),
                    // swap to deterministic fallback avatar.
                    const slot = listEl.querySelector(`[data-channel-thumb="${CSS.escape(adminStreamId)}"]`);
                    if (slot && slot.tagName !== 'IMG' && !channelImageManager.getCached(adminStreamId)?.dataUrl) {
                        slot.outerHTML = `<div class="rounded-full overflow-hidden flex-shrink-0" data-channel-thumb="${escapeAttr(adminStreamId)}" style="width:52px;height:52px">${getAvatarHtml(ch.streamId, 52, 0.5, null)}</div>`;
                    }
                });
        }

        // Lazy-fetch missing latest-message previews (sidebar shares cache).
        // Public/password channels: -1/P0 is publicly readable, so this
        // works even before joining. Encrypted (password) channels return
        // entries we can't decrypt without the password and are silently
        // skipped — the slot will fall back to "empty" once resolved.
        // Also (re-)subscribe so a later re-emit (e.g. when ENS resolves
        // for the sender) patches the slot in place.
        if (this._explorePreviewSubs) {
            for (const u of this._explorePreviewSubs.values()) { try { u(); } catch {} }
        }
        this._explorePreviewSubs = new Map();
        if (!this._explorePreviewRefreshStarted) this._explorePreviewRefreshStarted = new Set();
        for (const ch of channels) {
            if (!ch.streamId) continue;
            if (!this._explorePreviewSubs.has(ch.streamId)) {
                const unsub = channelLatestMessageManager.subscribe(ch.streamId, (entry) => {
                    const slot = listEl.querySelector(`[data-channel-preview="${CSS.escape(ch.streamId)}"]`);
                    if (!slot) return;
                    slot.innerHTML = entry ? formatPreviewLine(entry) : '';
                    if (entry) this._resolveExplorePreviewSender(listEl, channels, entry);
                });
                this._explorePreviewSubs.set(ch.streamId, unsub);
            }
            if (this._explorePreviewRefreshStarted.has(ch.streamId)) continue;
            this._explorePreviewRefreshStarted.add(ch.streamId);
            channelLatestMessageManager.get(ch.streamId, { password: null })
                .then(entry => {
                    const slot = listEl.querySelector(`[data-channel-preview="${CSS.escape(ch.streamId)}"]`);
                    if (slot) slot.innerHTML = entry ? formatPreviewLine(entry) : '';
                    if (entry) this._resolveExplorePreviewSender(listEl, channels, entry);
                })
                .catch(() => {})
                .finally(() => {
                    this._explorePreviewResolved.add(ch.streamId);
                    // If still showing spinner placeholder (no entry), clear it
                    const slot = listEl.querySelector(`[data-channel-preview="${CSS.escape(ch.streamId)}"]`);
                    if (slot && !channelLatestMessageManager.getCached(ch.streamId)) {
                        slot.innerHTML = '';
                    }
                });
        }

        // Lazy-resolve ENS for the senders of cached/resolved preview
        // entries that don't carry a payload `senderName`. Same pattern
        // as `OnlineUsersUI`: dedupe in identityManager, refresh the
        // matching slots when the lookup settles.
        this._resolveExplorePreviewSenders(listEl, channels);

        // Add click listeners
        listEl.querySelectorAll('.explore-channel-item').forEach(item => {
            item.addEventListener('click', async () => {
                const streamId = item.dataset.streamId;
                const channelType = item.dataset.type;
                
                if (!streamId) return;
                
                // Get channel info from cache
                const channelInfo = this.cachedPublicChannels?.find(ch => ch.streamId === streamId);
                
                // For password-protected and native (closed) channels: join directly (add to list)
                // These require immediate commitment (password entry or permission check)
                if (channelType === 'password' || channelType === 'native') {
                    if (this.deps.joinPublicChannel) {
                        await this.deps.joinPublicChannel(streamId, channelInfo);
                    }
                } else {
                    // For public/open channels: enter preview mode (try before adding)
                    await this.deps.enterPreviewMode(streamId, channelInfo);
                }
            });
        });
    }

    /**
     * Lazy-resolve ENS for the senders of every preview entry rendered
     * in the Explore list. Mirrors the pattern used by OnlineUsersUI /
     * ChannelListUI: identityManager dedupes inflight lookups + caches
     * 24h, so calling this on every render is cheap. When ENS lands we
     * patch only the slots whose sender matches.
     * @private
     */
    _resolveExplorePreviewSenders(listEl, channels) {
        const runPass = () => {
            for (const ch of channels) {
                if (!ch?.streamId) continue;
                const entry = channelLatestMessageManager.getCached(ch.streamId);
                this._resolveExplorePreviewSender(listEl, channels, entry);
            }
        };
        runPass();
        // Retry once shortly after render so startup races between
        // preview hydration and identityManager.init() still settle
        // without requiring the user to navigate into the channel.
        setTimeout(runPass, 1500);
    }

    /** @private */
    _resolveExplorePreviewSender(listEl, channels, entry) {
        if (!entry?.sender || entry.senderName) return;
        const addr = entry.sender;
        const normalizedAddr = typeof addr === 'string' ? addr.toLowerCase() : addr;
        const cached = normalizedAddr ? identityManager.ensCache?.get(normalizedAddr) : null;
        if (cached && cached.name) return;
        identityManager.resolveENS?.(addr)
            ?.then(name => {
                if (!name) return;
                for (const ch of channels) {
                    if (!ch?.streamId) continue;
                    const e = channelLatestMessageManager.getCached(ch.streamId);
                    if (!e?.sender) continue;
                    const sender = typeof e.sender === 'string' ? e.sender.toLowerCase() : e.sender;
                    if (sender !== normalizedAddr) continue;
                    const slot = listEl.querySelector(`[data-channel-preview="${CSS.escape(ch.streamId)}"]`);
                    if (slot) slot.innerHTML = formatPreviewLine(e);
                }
            })
            ?.catch(() => {});
    }

    /**
     * Update Private chip UI state
     */
    updatePrivateChip() {
        const chip = document.getElementById('explore-private-chip');
        if (!chip) return;
        const isActive = this.browseTypeFilter === 'password';
        if (isActive) {
            chip.classList.add('bg-white', 'text-black');
            chip.classList.remove('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
        } else {
            chip.classList.remove('bg-white', 'text-black');
            chip.classList.add('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
        }
    }

    /**
     * Update category chips UI state
     */
    updateCategoryChips() {
        document.querySelectorAll('.explore-category-chip').forEach(chip => {
            const isActive = chip.dataset.category === this.browseCategoryFilter;
            if (isActive) {
                chip.classList.add('bg-white', 'text-black');
                chip.classList.remove('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
            } else {
                chip.classList.remove('bg-white', 'text-black');
                chip.classList.add('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
            }
        });
    }

    /** @private */
    _measureCollapsedCategoriesOverflow(container) {
        if (!container) return false;
        const wasExpanded = container.dataset.expanded === 'true';
        if (wasExpanded) container.dataset.expanded = 'false';
        const hasOverflow = container.scrollWidth > (container.clientWidth + 1);
        if (wasExpanded) container.dataset.expanded = 'true';
        return hasOverflow;
    }

    /** @private */
    _syncCategoryCarouselHints() {
        const rail = document.querySelector('.explore-category-rail');
        const container = document.getElementById('explore-category-chips');

        if (!rail || !container) return;

        const isExpanded = container.dataset.expanded === 'true';
        const hasOverflow = isExpanded
            ? this._measureCollapsedCategoriesOverflow(container)
            : container.scrollWidth > (container.clientWidth + 1);

        if (isExpanded || !hasOverflow) {
            rail.dataset.overflow = 'false';
            rail.dataset.scrollStart = 'true';
            rail.dataset.scrollEnd = 'true';
            return;
        }

        const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
        const currentScrollLeft = Math.max(0, container.scrollLeft || 0);
        const threshold = 2;

        rail.dataset.overflow = 'true';
        rail.dataset.scrollStart = currentScrollLeft <= threshold ? 'true' : 'false';
        rail.dataset.scrollEnd = currentScrollLeft >= (maxScrollLeft - threshold) ? 'true' : 'false';
    }

    /** @private */
    _setCategoriesExpanded(expanded) {
        const container = document.getElementById('explore-category-chips');
        const icon = document.getElementById('explore-toggle-categories-icon');
        const btn = document.getElementById('explore-toggle-categories-btn');

        if (!container) return;

        container.dataset.expanded = expanded ? 'true' : 'false';
        if (!expanded) {
            container.scrollLeft = 0;
        }
        icon?.classList.toggle('rotate-180', !!expanded);
        btn?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        this._syncCategoryCarouselHints();
    }

    /**
     * Toggle categories expand/collapse
     */
    toggleCategoriesExpand() {
        const container = document.getElementById('explore-category-chips');
        
        if (!container) return;
        
        const isExpanded = container.dataset.expanded === 'true';

        this._setCategoriesExpanded(!isExpanded);
    }

    /**
     * Check if category chips overflow and show/hide expand button
     */
    checkCategoriesOverflow() {
        const container = document.getElementById('explore-category-chips');
        const btn = document.getElementById('explore-toggle-categories-btn');
        
        if (!container || !btn) return;

        const hasOverflow = this._measureCollapsedCategoriesOverflow(container);
        if (hasOverflow) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
            this._syncCategoryCarouselHints();
        } else {
            this._setCategoriesExpanded(false);
            btn.classList.add('hidden');
            btn.classList.remove('flex');
        }
    }
}

// Export singleton instance
export const exploreUI = new ExploreUI();
