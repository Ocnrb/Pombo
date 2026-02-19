/**
 * Explore UI Manager
 * Handles the Explore view (front-page) for browsing public channels
 */

import { escapeHtml } from './utils.js';

class ExploreUI {
    constructor() {
        // Filter state
        this.browseTypeFilter = 'public';
        this.browseCategoryFilter = '';
        this.browseLanguageFilterValue = '';
        
        // Cached channels
        this.cachedPublicChannels = null;
        
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
        const nsfwChips = nsfwEnabled 
            ? '<button type="button" data-category="nsfw" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">NSFW</button><button type="button" data-category="adult" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Adult</button>' 
            : '';

        return `
            <div class="explore-view flex h-full bg-[#161616]">
                <!-- Sidebar: Channel Type -->
                <div class="w-36 bg-[#0d0d0d] border-r border-[#333] pt-3 flex flex-col flex-shrink-0">
                    <div class="px-3 mb-2">
                        <span class="text-[10px] font-medium text-white/30 uppercase tracking-wider">Type</span>
                    </div>
                    <nav class="space-y-1 px-2 pb-3">
                        <button type="button" data-browse-filter="public" class="browse-filter-tab w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-left transition-all bg-white/10 text-white">
                            <svg class="w-4 h-4 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"/></svg>
                            <span>Public</span>
                        </button>
                        <button type="button" data-browse-filter="password" class="browse-filter-tab w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-left transition-all text-white/60 hover:text-white/90 hover:bg-white/5">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>
                            <span>Private</span>
                        </button>
                    </nav>
                </div>

                <!-- Content Panel -->
                <div class="flex-1 flex flex-col overflow-hidden">
                    <!-- Filters Section -->
                    <div class="px-5 pt-4 pb-3 space-y-3">
                        <!-- Search + Language Filter -->
                        <div class="flex gap-3">
                            <div class="flex-1 relative">
                                <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
                                </svg>
                                <input
                                    type="text"
                                    id="explore-search-input"
                                    placeholder="Search channels..."
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
                        <div class="relative">
                            <div id="explore-category-chips" class="flex flex-wrap gap-1.5 overflow-hidden max-h-[26px] transition-all duration-200" data-expanded="false">
                                <button type="button" data-category="" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white text-black">All</button>
                                <button type="button" data-category="general" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">General</button>
                                <button type="button" data-category="politics" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Politics</button>
                                <button type="button" data-category="news" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">News</button>
                                <button type="button" data-category="tech" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Tech & AI</button>
                                <button type="button" data-category="crypto" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Crypto</button>
                                <button type="button" data-category="finance" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Finance</button>
                                <button type="button" data-category="science" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Science</button>
                                <button type="button" data-category="gaming" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Gaming</button>
                                <button type="button" data-category="entertainment" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Entertainment</button>
                                <button type="button" data-category="sports" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Sports</button>
                                <button type="button" data-category="health" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Health</button>
                                <button type="button" data-category="education" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Education</button>
                                <button type="button" data-category="comedy" class="explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80">Comedy</button>
                                ${nsfwChips}
                            </div>
                            <button id="explore-toggle-categories-btn" type="button" class="hidden absolute right-0 top-0 h-[26px] px-2 items-center bg-gradient-to-l from-[#161616] via-[#161616] to-transparent pl-6 text-white/40 hover:text-white/60 transition">
                                <svg id="explore-toggle-categories-icon" class="w-4 h-4 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 9l-7 7-7-7"/>
                                </svg>
                            </button>
                        </div>
                    </div>

                    <!-- Subtle separator -->
                    <div class="mx-5 border-t border-[#333]"></div>

                    <!-- Channel List -->
                    <div id="explore-channels-list" class="flex-1 overflow-y-auto px-5 py-3 space-y-2">
                        <div class="flex flex-col items-center justify-center py-12 text-white/40">
                            <div class="spinner mb-3" style="width: 28px; height: 28px;"></div>
                            <p class="text-sm">Loading channels...</p>
                        </div>
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
        
        // Type filter tabs
        document.querySelectorAll('.explore-view .browse-filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.browseTypeFilter = tab.dataset.browseFilter;
                this.updateFilterTabs();
                this.filterChannels(searchInput?.value || '');
            });
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
    }

    /**
     * Load channels from the API
     */
    async loadChannels() {
        const listEl = document.getElementById('explore-channels-list');
        if (!listEl) return;

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
            const channels = await this.deps.getPublicChannels();
            this.cachedPublicChannels = channels;
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
                ch.name.toLowerCase().includes(q) ||
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
                ? '<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-500/15 text-amber-400/80 text-[9px] font-medium rounded">RO</span>' 
                : '';
            const categoryBadge = ch.category && ch.category !== 'general'
                ? `<span class="px-1.5 py-0.5 bg-white/5 text-white/50 text-[9px] font-medium rounded">${escapeHtml(categoryNames[ch.category] || ch.category)}</span>`
                : '';
            const languageBadge = ch.language
                ? `<span class="px-1.5 py-0.5 bg-white/5 text-white/40 text-[9px] font-medium rounded">${escapeHtml(languageNames[ch.language] || ch.language.toUpperCase())}</span>`
                : '';
            const description = ch.description 
                ? `<p class="text-xs text-white/40 mt-1 line-clamp-2">${escapeHtml(ch.description)}</p>` 
                : '';
            
            return `
            <div class="p-3 bg-white/5 border border-white/5 rounded-xl hover:bg-white/[0.07] hover:border-white/10 transition cursor-pointer explore-channel-item group" data-stream-id="${ch.streamId}" data-type="${ch.type || 'public'}">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <h4 class="text-sm font-medium text-white/90 truncate">${escapeHtml(ch.name)}</h4>
                            ${readOnlyBadge}
                        </div>
                        ${description}
                    </div>
                    <svg class="w-4 h-4 text-white/20 group-hover:text-white/40 flex-shrink-0 mt-0.5 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                </div>
                <div class="flex items-center gap-1.5 mt-2">
                    ${categoryBadge}
                    ${languageBadge}
                </div>
            </div>
            `;
        }).join('');

        // Add click listeners
        listEl.querySelectorAll('.explore-channel-item').forEach(item => {
            item.addEventListener('click', async () => {
                const streamId = item.dataset.streamId;
                if (streamId && this.deps.joinPublicChannel) {
                    // Pass channel info from our cache
                    const channelInfo = this.cachedPublicChannels?.find(ch => ch.streamId === streamId);
                    await this.deps.joinPublicChannel(streamId, channelInfo);
                }
            });
        });
    }

    /**
     * Update filter tabs UI state
     */
    updateFilterTabs() {
        document.querySelectorAll('.explore-view .browse-filter-tab').forEach(tab => {
            const isActive = tab.dataset.browseFilter === this.browseTypeFilter;
            if (isActive) {
                tab.classList.add('bg-white/10', 'text-white');
                tab.classList.remove('text-white/60', 'hover:text-white/90', 'hover:bg-white/5');
            } else {
                tab.classList.remove('bg-white/10', 'text-white');
                tab.classList.add('text-white/60', 'hover:text-white/90', 'hover:bg-white/5');
            }
        });
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

    /**
     * Toggle categories expand/collapse
     */
    toggleCategoriesExpand() {
        const container = document.getElementById('explore-category-chips');
        const icon = document.getElementById('explore-toggle-categories-icon');
        const btn = document.getElementById('explore-toggle-categories-btn');
        
        if (!container) return;
        
        const isExpanded = container.dataset.expanded === 'true';
        
        if (isExpanded) {
            container.classList.add('max-h-[26px]');
            container.classList.remove('max-h-[200px]');
            container.dataset.expanded = 'false';
            icon?.classList.remove('rotate-180');
            btn?.classList.remove('bg-transparent');
        } else {
            container.classList.remove('max-h-[26px]');
            container.classList.add('max-h-[200px]');
            container.dataset.expanded = 'true';
            icon?.classList.add('rotate-180');
            btn?.classList.add('bg-transparent');
        }
    }

    /**
     * Check if category chips overflow and show/hide expand button
     */
    checkCategoriesOverflow() {
        const container = document.getElementById('explore-category-chips');
        const btn = document.getElementById('explore-toggle-categories-btn');
        
        if (!container || !btn) return;
        
        // Check if content overflows (scrollHeight > clientHeight means overflow)
        if (container.scrollHeight > container.clientHeight) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
        } else {
            btn.classList.add('hidden');
            btn.classList.remove('flex');
        }
    }
}

// Export singleton instance
export const exploreUI = new ExploreUI();
