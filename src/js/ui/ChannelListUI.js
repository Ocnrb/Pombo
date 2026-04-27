/**
 * ChannelListUI Module
 * Manages channel list rendering, filtering, sorting, and drag-and-drop reordering
 */

import { Logger } from '../logger.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { sanitizeText } from './sanitizer.js';
import { channelImageManager } from '../channelImageManager.js';
import { deriveAdminId } from '../streamConstants.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { identityManager } from '../identity.js';

class ChannelListUI {
    constructor() {
        this.elements = {};
        this.currentFilter = 'all'; // all | personal | community
        this.clickListenersAttached = false;
        this.dragAndDropBound = false;
        this.draggedItem = null;
        this.draggedStreamId = null;
        
        // Dependencies (injected)
        this.channelManager = null;
        this.secureStorage = null;
        this.onChannelSelect = null;

        // Tracks which adminStreamIds / DM peers we have *attempted* to
        // resolve. Any row not in these sets renders a spinner placeholder
        // until its lookup finishes (regardless of whether a result was
        // found). Prevents the avatar/ENS placeholder from flashing in
        // mid-resolution.
        this._resolvedImages = new Set();
        this._resolvedDMPeers = new Set();
    }

    /**
     * Set dependencies for the module
     */
    setDependencies({ channelManager, secureStorage, onChannelSelect }) {
        this.channelManager = channelManager;
        this.secureStorage = secureStorage;
        this.onChannelSelect = onChannelSelect;

        // Wire a single global listener for channel-image updates so any
        // visible row gets its avatar refreshed without a full re-render.
        // The manager emits per adminStreamId; we update only matching DOM nodes.
        if (!this._channelImageGlobalUnsub) {
            this._channelImageGlobalUnsub = this._installChannelImageListener();
        }
    }

    /** @private */
    _installChannelImageListener() {
        // The manager doesn't currently provide a "wildcard" subscription —
        // wrap setLocal/_emit by patching once: track all subscriptions and
        // re-register lazily as channels appear in the rendered list.
        // Simpler approach: hook into render() — but to also catch async
        // updates, use a lightweight MutationObserver-free approach:
        // poll the manager from within `render()` (cheap; runs on demand),
        // and rely on `renderChannelList()` callbacks already wired in
        // ChannelSettingsUI on upload. For incoming images discovered from
        // `subscribeToChannel` on this client, channels.js calls
        // `channelImageManager.get()` which only emits on hash change; we
        // subscribe per-channel below in `_subscribeAllImages()`.
        return this._subscribeAllImages();
    }

    /** @private — re-subscribe to all known channels' image streams */
    _subscribeAllImages() {
        if (this._imageSubs) {
            for (const u of this._imageSubs.values()) { try { u(); } catch {} }
        }
        this._imageSubs = new Map();
        const subscribe = (adminStreamId, streamId, password) => {
            if (!adminStreamId || this._imageSubs.has(adminStreamId)) return;
            const unsub = channelImageManager.subscribe(adminStreamId, () => {
                this._refreshSingleRow(streamId, adminStreamId);
            });
            this._imageSubs.set(adminStreamId, unsub);
            // Lazy fetch: if we don't yet have a cached image for this
            // channel (e.g. user has it in sidebar but never opened it on
            // this origin / device), trigger a background resend so the
            // sidebar can show the admin-published image without requiring
            // the user to enter the channel first. Mirrors what ExploreUI
            // does for its grid.
            if (channelImageManager.getCached(adminStreamId)) {
                this._resolvedImages.add(adminStreamId);
            } else {
                channelImageManager.get(adminStreamId, { password: password || null })
                    .catch(() => {})
                    .finally(() => {
                        this._resolvedImages.add(adminStreamId);
                        this._refreshSingleRow(streamId, adminStreamId);
                    });
            }
        };
        // Subscribe to current channels and again whenever render() runs
        try {
            const all = this.channelManager?.getAllChannels?.();
            if (Array.isArray(all)) {
                for (const ch of all) {
                    if (ch && ch.type !== 'dm') {
                        subscribe(
                            ch.adminStreamId || deriveAdminId(ch.streamId),
                            ch.streamId,
                            ch.password
                        );
                    }
                }
            }
        } catch {
            // Defensive: tests may inject minimal mocks
        }
        // Return a disposer
        return () => {
            for (const u of this._imageSubs.values()) { try { u(); } catch {} }
            this._imageSubs?.clear();
        };
    }

    /** @private — update a single row's avatar slot in place */
    _refreshSingleRow(streamId, adminStreamId) {
        if (!this.elements?.channelList) return;
        const row = this.elements.channelList.querySelector(`.channel-item[data-stream-id="${CSS.escape(streamId)}"]`);
        if (!row) return;
        const slot = row.querySelector('.channel-icon-slot');
        if (!slot) return;
        const dataUrl = this._getCachedImageDataUrl(adminStreamId);
        if (dataUrl) {
            slot.style.width = '44px';
            slot.innerHTML = `<img class="channel-item-image rounded-full object-cover" alt="" src="${escapeAttr(dataUrl)}" draggable="true" style="width:44px;height:44px" />`;
        } else if (this._resolvedImages.has(adminStreamId)) {
            // Resolution finished without a remote image — swap spinner
            // placeholder for the deterministic fallback avatar.
            slot.style.width = '44px';
            slot.innerHTML = `<div class="rounded-full overflow-hidden" style="width:44px;height:44px">${getAvatarHtml(streamId, 44, 0.5, null)}</div>`;
        }
        // Bump signature so next reconcile doesn't replace this row
        const cached = channelImageManager.getCached(adminStreamId);
        const sig = row.dataset.renderSignature;
        if (sig) {
            try {
                const arr = JSON.parse(sig);
                arr[4] = cached?.hash || '';
                row.dataset.renderSignature = JSON.stringify(arr);
            } catch {}
        }
    }

    /**
     * Kick off ENS avatar resolution for any DM rows whose peer avatar is
     * not yet cached. Resolution is deduped & cached by identityManager;
     * once it lands, the next render() picks it up via the signature change.
     * @private
     */
    _resolveDMAvatars(channelViewModels) {
        if (!Array.isArray(channelViewModels)) return;
        for (const vm of channelViewModels) {
            if (vm.type !== 'dm' || !vm.peerAddress) continue;
            const peer = vm.peerAddress;
            if (vm.peerEnsAvatar || this._resolvedDMPeers.has(peer)) continue;
            // Fire-and-forget. Trigger a re-render when it resolves so the
            // newly-cached avatar (or fallback) appears without user
            // interaction. Mark resolved on settle (success or failure)
            // so the spinner placeholder swaps to deterministic avatar.
            try {
                identityManager.resolveENSAvatar?.(peer)
                    ?.then(url => {
                        this._resolvedDMPeers.add(peer);
                        if (url) this.render();
                        else this.render();
                    })
                    ?.catch(() => {
                        this._resolvedDMPeers.add(peer);
                        this.render();
                    });
            } catch {
                this._resolvedDMPeers.add(peer);
            }
        }
    }

    /**
     * Set DOM element references
     */
    setElements(elements) {
        this.elements = elements;
    }

    /**
     * Set the current channel filter
     * @param {string} filter - 'all' | 'personal' | 'community'
     */
    setFilter(filter) {
        this.currentFilter = filter;
    }

    /**
     * Get the current channel filter
     * @returns {string}
     */
    getFilter() {
        return this.currentFilter;
    }

    /**
     * Render the channel list with current filter
     */
    render() {
        if (!this.channelManager || !this.elements.channelList) {
            Logger.warn('ChannelListUI: Missing dependencies or elements');
            return;
        }

        let channels = this.channelManager.getAllChannels();
        Logger.debug('ChannelListUI.render - Total channels:', channels.length);

        // Apply channel filter
        channels = this._applyFilter(channels);

        if (channels.length === 0) {
            this._renderEmptyState();
            return;
        }

        // Sort by user-defined order
        const channelOrder = this.secureStorage.getChannelOrder();
        if (channelOrder.length > 0) {
            channels = this._sortByOrder(channels, channelOrder);
        }

        // Get current channel for highlighting
        const currentChannel = this.channelManager.getCurrentChannel();
        const currentStreamId = currentChannel?.streamId;
        const channelViewModels = channels.map(channel =>
            this._buildChannelViewModel(channel, currentStreamId)
        );

        // Reconcile channel items without rebuilding unchanged rows
        this._reconcileChannelItems(channelViewModels);

        // Refresh per-channel image listeners (idempotent for unchanged set)
        this._channelImageGlobalUnsub = this._subscribeAllImages();

        // Lazy-resolve ENS avatars for DM peers (off-chain HTTP).
        // resolveENSAvatar dedups in-flight lookups; once resolved it
        // caches in localStorage, so the next render sees it via
        // getCachedENSAvatar and the row signature changes → re-render.
        this._resolveDMAvatars(channelViewModels);

        // Attach delegated event listeners once
        this._attachClickListeners();
        this._setupDragAndDrop();

        Logger.debug('ChannelListUI: Render complete');
    }

    /**
     * Apply filter to channels
     * @private
     */
    _applyFilter(channels) {
        switch (this.currentFilter) {
            case 'personal':
                // Personal: any channel with classification 'personal'
                return channels.filter(ch => ch.classification === 'personal');
            case 'community':
                // Communities: channels without classification OR with classification 'community'
                // This includes public/password channels without explicit classification
                return channels.filter(ch => 
                    !ch.classification || ch.classification === 'community'
                );
            default:
                // 'all' - no filtering
                return channels;
        }
    }

    /**
     * Render empty state message
     * @private
     */
    _renderEmptyState() {
        const filterMsg = this.currentFilter === 'all' 
            ? 'No channels yet' 
            : `No ${this.currentFilter} channels`;

        const emptyState = document.createElement('div');
        emptyState.className = 'p-4 text-center text-white/25 text-[13px]';
        emptyState.textContent = filterMsg;
        this.elements.channelList.replaceChildren(emptyState);
        Logger.debug('ChannelListUI: No channels to render');
    }

    /**
     * Build the render view-model for a channel row.
     * @private
     */
    _buildChannelViewModel(channel, currentStreamId) {
        const lastAccess = this.secureStorage.getChannelLastAccess(channel.streamId) || 0;
        const messages = Array.isArray(channel.messages) ? channel.messages : [];
        const unreadCount = messages.reduce((count, message) => {
            const isUnread = message.timestamp > lastAccess
                && !message._deleted
                && !['reaction', 'edit', 'delete'].includes(message.type);
            return isUnread ? count + 1 : count;
        }, 0);
        const hasUnread = unreadCount > 0;

        return {
            streamId: channel.streamId,
            name: channel.name,
            type: channel.type,
            readOnly: !!channel.readOnly,
            unreadCount,
            hasUnread,
            displayCount: hasUnread ? (unreadCount >= 30 ? '+30' : unreadCount) : '',
            isActive: channel.streamId === currentStreamId,
            // Channel image hash (for render signature; null if no image cached)
            imageHash: this._getCachedImageHash(channel.streamId, channel.type),
            adminStreamId: channel.adminStreamId || deriveAdminId(channel.streamId),
            // For DM rows: peer address + cached ENS avatar URL (if any)
            peerAddress: channel.peerAddress || null,
            peerEnsAvatar: channel.peerAddress
                ? (identityManager.getCachedENSAvatar?.(channel.peerAddress) || null)
                : null
        };
    }

    /** @private */
    _getCachedImageHash(streamId, type) {
        if (type === 'dm') return null;
        const adminId = deriveAdminId(streamId);
        if (!adminId) return null;
        return channelImageManager.getCached(adminId)?.hash || null;
    }

    /** @private */
    _getCachedImageDataUrl(adminStreamId) {
        if (!adminStreamId) return null;
        return channelImageManager.getCached(adminStreamId)?.dataUrl || null;
    }

    /**
     * Reconcile channel rows by stream id so unchanged nodes can be reused.
     * @private
     */
    _reconcileChannelItems(channelViewModels) {
        const existingItems = new Map(
            Array.from(this.elements.channelList.querySelectorAll('.channel-item'))
                .map(item => [item.dataset.streamId, item])
        );
        const signatures = channelViewModels.map(viewModel => this._buildRenderSignature(viewModel));
        const currentItems = Array.from(this.elements.channelList.children)
            .filter(element => element.classList?.contains('channel-item'));
        const isUnchanged = currentItems.length === channelViewModels.length
            && currentItems.every((item, index) => (
                item.dataset.streamId === channelViewModels[index].streamId
                && item.dataset.renderSignature === signatures[index]
            ));

        if (isUnchanged) {
            return;
        }

        const fragment = document.createDocumentFragment();

        channelViewModels.forEach((viewModel, index) => {
            const signature = signatures[index];
            let item = existingItems.get(viewModel.streamId);

            if (!item || item.dataset.renderSignature !== signature) {
                item = this._createChannelItemElement(viewModel, signature);
            }

            fragment.appendChild(item);
        });

        this.elements.channelList.replaceChildren(fragment);
    }

    /**
     * Build a stable signature for a rendered channel row.
     * @private
     */
    _buildRenderSignature(channelViewModel) {
        const isResolved = channelViewModel.type === 'dm'
            ? (!!channelViewModel.peerEnsAvatar || (channelViewModel.peerAddress ? this._resolvedDMPeers.has(channelViewModel.peerAddress) : true))
            : (!!channelViewModel.imageHash || (channelViewModel.adminStreamId ? this._resolvedImages.has(channelViewModel.adminStreamId) : true));
        return JSON.stringify([
            channelViewModel.name,
            channelViewModel.type,
            channelViewModel.unreadCount,
            channelViewModel.isActive,
            channelViewModel.imageHash || '',
            channelViewModel.peerEnsAvatar || '',
            channelViewModel.readOnly ? 1 : 0,
            isResolved ? 1 : 0
        ]);
    }

    /**
     * Create a channel row element.
     * @private
     */
    _createChannelItemElement(channelViewModel, signature) {
        const template = document.createElement('template');
        template.innerHTML = this._renderChannelItem(channelViewModel).trim();
        const element = template.content.firstElementChild;
        element.dataset.renderSignature = signature;
        return element;
    }

    /**
     * Render type-indicator icons that appear after the channel name in
     * the sidebar. Mirrors the iconography used in the chat header
     * (HeaderUI.getChannelTypeLabel) for visual consistency.
     *
     * Mapping:
     *   - dm                                          → envelope
     *   - native                                      → ethereum diamond
     *   - public  many-to-many  (readOnly = false)    → eye
     *   - public  one-to-many   (readOnly = true)     → megaphone
     *   - password many-to-many (readOnly = false)    → lock
     *   - password one-to-many  (readOnly = true)     → megaphone + lock
     *
     * @private
     */
    _renderChannelTypeIcons(type, readOnly = false) {
        const cls = 'w-3.5 h-3.5 text-white/40 flex-shrink-0';
        const envelope = `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`;
        const eye = `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`;
        const lock = `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>`;
        const megaphone = `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>`;
        const ethereum = `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5l-8 13.5 8 4.5 8-4.5-8-13.5zm0 18l-8-4.5 8 9 8-9-8 4.5z"/></svg>`;
        switch (type) {
            case 'dm': return envelope;
            case 'native': return ethereum;
            case 'password': return readOnly ? (megaphone + lock) : lock;
            case 'public':   return readOnly ? megaphone : eye;
            default: return '';
        }
    }

    /**
     * Render a single channel item
     * @private
     */
    _renderChannelItem(channelViewModel) {
        const countClass = channelViewModel.hasUnread 
            ? 'text-white bg-[#F6851B]/20 font-medium' 
            : 'text-white/30 bg-white/[0.04]';

        const activeClass = channelViewModel.isActive 
            ? 'border-l-2 border-l-[#F6851B] bg-white/[0.06]' 
            : 'border-l-2 border-l-transparent';

        // Icon / avatar slot:
        //   - DM channels: peer ENS avatar (if cached) or deterministic
        //     avatar from peer address. Falls back to streamId so DMs
        //     without a known peerAddress still render something.
        //   - Other channels: render channel image if cached, else fallback avatar.
        // Render image / avatar / spinner. We show a spinner whenever the
        // remote lookup is still pending so the deterministic fallback
        // doesn't flash before the real image / ENS avatar arrives.
        const spinnerSlot = `<div class="rounded-full flex items-center justify-center bg-white/[0.04]" style="width:44px;height:44px"><div class="thumb-spinner" style="width:16px;height:16px"></div></div>`;
        let iconSlot = '';
        if (channelViewModel.type === 'dm') {
            const seed = channelViewModel.peerAddress || channelViewModel.streamId;
            if (channelViewModel.peerEnsAvatar) {
                iconSlot = `<img class="channel-item-image rounded-full object-cover" alt="" src="${escapeAttr(channelViewModel.peerEnsAvatar)}" draggable="true" style="width:44px;height:44px" />`;
            } else if (channelViewModel.peerAddress && !this._resolvedDMPeers.has(channelViewModel.peerAddress)) {
                iconSlot = spinnerSlot;
            } else {
                iconSlot = `<div class="rounded-full overflow-hidden" style="width:44px;height:44px">${getAvatarHtml(seed, 44, 0.5, null)}</div>`;
            }
        } else {
            const dataUrl = this._getCachedImageDataUrl(channelViewModel.adminStreamId);
            if (dataUrl) {
                iconSlot = `<img class="channel-item-image rounded-full object-cover" alt="" src="${escapeAttr(dataUrl)}" draggable="true" style="width:44px;height:44px" />`;
            } else if (channelViewModel.adminStreamId && !this._resolvedImages.has(channelViewModel.adminStreamId)) {
                iconSlot = spinnerSlot;
            } else {
                iconSlot = `<div class="rounded-full overflow-hidden" style="width:44px;height:44px">${getAvatarHtml(channelViewModel.streamId, 44, 0.5, null)}</div>`;
            }
        }

        return `
            <div
                class="channel-item mx-2 rounded-xl cursor-pointer bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.06] hover:border-white/[0.08] transition-all duration-200 group ${activeClass}"
                data-stream-id="${escapeAttr(channelViewModel.streamId)}"
                data-admin-stream-id="${escapeAttr(channelViewModel.adminStreamId || '')}"
                draggable="true"
            >
                <div class="channel-item-body flex items-center">
                    <!-- Icon / avatar slot -->
                    <div class="channel-icon-slot flex-shrink-0 flex items-center justify-center" style="width:44px">
                        ${iconSlot}
                    </div>
                    <!-- Channel name + type icons -->
                    <div class="channel-item-main flex-1 min-w-0">
                        <div class="flex items-center min-w-0">
                            <h3 class="text-sm font-medium text-white/90 truncate">${escapeHtml(sanitizeText(channelViewModel.name))}</h3>
                            <div class="channel-item-type-icons flex items-center flex-shrink-0">
                                ${this._renderChannelTypeIcons(channelViewModel.type, channelViewModel.readOnly)}
                            </div>
                        </div>
                    </div>
                    <!-- Right side: drag handle + counter + arrow -->
                    <div class="channel-item-actions flex items-center flex-shrink-0">
                        <!-- Drag handle (6 dots) - visible on hover -->
                        <div class="drag-handle cursor-grab opacity-0 group-hover:opacity-100 transition-opacity text-white/20 hover:text-white/40" title="Drag to reorder">
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="8" cy="6" r="1.5"/>
                                <circle cx="16" cy="6" r="1.5"/>
                                <circle cx="8" cy="12" r="1.5"/>
                                <circle cx="16" cy="12" r="1.5"/>
                                <circle cx="8" cy="18" r="1.5"/>
                                <circle cx="16" cy="18" r="1.5"/>
                            </svg>
                        </div>
                        ${channelViewModel.hasUnread 
                            ? `<span class="channel-msg-count text-[10px] ${countClass} rounded-md" data-channel-count="${escapeAttr(channelViewModel.streamId)}">${channelViewModel.displayCount}</span>` 
                            : `<span class="channel-msg-count text-[10px] text-white/30 bg-white/[0.04] rounded-md hidden" data-channel-count="${escapeAttr(channelViewModel.streamId)}">0</span>`
                        }
                        <svg class="w-3.5 h-3.5 text-white/15 group-hover:text-white/30 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8.25 4.5l7.5 7.5-7.5 7.5"></path>
                        </svg>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Sort channels by user-defined order
     * @private
     */
    _sortByOrder(channels, order) {
        const orderMap = new Map(order.map((id, index) => [id, index]));
        return [...channels].sort((a, b) => {
            const indexA = orderMap.has(a.streamId) ? orderMap.get(a.streamId) : Infinity;
            const indexB = orderMap.has(b.streamId) ? orderMap.get(b.streamId) : Infinity;
            return indexA - indexB;
        });
    }

    /**
     * Attach click listeners to channel items
     * @private
     */
    _attachClickListeners() {
        if (this.clickListenersAttached || !this.elements.channelList) {
            return;
        }

        this.elements.channelList.addEventListener('click', (event) => {
            const clickTarget = event.target instanceof Element ? event.target : null;
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item || clickTarget?.closest('.drag-handle')) {
                return;
            }

            const streamId = item.dataset.streamId;
            Logger.debug('ChannelListUI: Channel clicked:', streamId);

            if (this.onChannelSelect) {
                this.onChannelSelect(streamId);
            }
        });

        this.elements.channelList.addEventListener('contextmenu', (event) => {
            if (this._getChannelItemFromEventTarget(event.target)) {
                event.preventDefault();
            }
        });

        this.clickListenersAttached = true;
    }

    /**
     * Setup drag and drop for channel reordering
     * @private
     */
    _setupDragAndDrop() {
        if (this.dragAndDropBound || !this.elements.channelList) {
            return;
        }

        this.elements.channelList.addEventListener('dragstart', (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item) {
                return;
            }

            this.draggedItem = item;
            this.draggedStreamId = item.dataset.streamId;
            item.classList.add('dragging');

            // Required for Firefox
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', this.draggedStreamId);

            setTimeout(() => {
                item.style.opacity = '0.5';
            }, 0);
        });

        this.elements.channelList.addEventListener('dragend', (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item) {
                return;
            }

            item.classList.remove('dragging');
            item.style.opacity = '';
            this.draggedItem = null;
            this.draggedStreamId = null;

            this.elements.channelList.querySelectorAll('.channel-item').forEach(element => {
                element.classList.remove('drag-over');
            });
        });

        this.elements.channelList.addEventListener('dragover', (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item) {
                return;
            }

            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';

            if (item !== this.draggedItem) {
                item.classList.add('drag-over');
            }
        });

        this.elements.channelList.addEventListener('dragleave', (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item || (event.relatedTarget instanceof Element && item.contains(event.relatedTarget))) {
                return;
            }

            item.classList.remove('drag-over');
        });

        this.elements.channelList.addEventListener('drop', async (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item) {
                return;
            }

            event.preventDefault();
            item.classList.remove('drag-over');

            if (!this.draggedItem || item === this.draggedItem) {
                return;
            }

            const targetStreamId = item.dataset.streamId;
            await this._handleDrop(this.draggedStreamId, targetStreamId);
        });

        this.dragAndDropBound = true;
    }

    /**
     * Resolve a channel row from an event target.
     * @private
     */
    _getChannelItemFromEventTarget(target) {
        if (!(target instanceof Element) || !this.elements.channelList) {
            return null;
        }

        const item = target.closest('.channel-item');
        return item && this.elements.channelList.contains(item) ? item : null;
    }

    /**
     * Handle drop event - reorder channels
     * @private
     */
    async _handleDrop(draggedStreamId, targetStreamId) {
        // Get current order or create from current channel list
        let currentOrder = this.secureStorage.getChannelOrder();
        const channels = this.channelManager.getAllChannels();
        
        // If no saved order, create from current channels
        if (currentOrder.length === 0) {
            currentOrder = channels.map(ch => ch.streamId);
        }
        
        // Ensure all current channels are in the order
        channels.forEach(ch => {
            if (!currentOrder.includes(ch.streamId)) {
                currentOrder.push(ch.streamId);
            }
        });
        
        // Find positions
        const draggedIndex = currentOrder.indexOf(draggedStreamId);
        const targetIndex = currentOrder.indexOf(targetStreamId);
        
        if (draggedIndex === -1 || targetIndex === -1) return;
        
        // Remove dragged item and insert at new position
        currentOrder.splice(draggedIndex, 1);
        currentOrder.splice(targetIndex, 0, draggedStreamId);
        
        // Save the new order
        await this.secureStorage.setChannelOrder(currentOrder);

        if (this.draggedItem) {
            this.draggedItem.classList.remove('dragging');
            this.draggedItem.style.opacity = '';
        }
        this.draggedItem = null;
        this.draggedStreamId = null;
        
        // Re-render the list
        this.render();
        
        Logger.debug('ChannelListUI: Channel order updated');
    }

    /**
     * Update unread badge for a specific channel
     * @param {string} streamId - Channel stream ID
     * @param {number} count - New unread count
     */
    updateUnreadBadge(streamId, count) {
        const badge = this.elements.channelList?.querySelector(`[data-channel-count="${CSS.escape(streamId)}"]`);
        if (!badge) return;

        if (count > 0) {
            badge.textContent = count >= 30 ? '+30' : count;
            badge.classList.remove('hidden', 'text-white/30', 'bg-white/[0.04]');
            badge.classList.add('text-white', 'bg-[#F6851B]/20', 'font-medium');
        } else {
            badge.textContent = '0';
            badge.classList.add('hidden');
            badge.classList.remove('text-white', 'bg-[#F6851B]/20', 'font-medium');
            badge.classList.add('text-white/30', 'bg-white/[0.04]');
        }
    }

    /**
     * Highlight the active channel in the list
     * @param {string} streamId - Channel stream ID to highlight
     */
    setActiveChannel(streamId) {
        this.elements.channelList?.querySelectorAll('.channel-item').forEach(item => {
            const isActive = item.dataset.streamId === streamId;
            item.classList.toggle('border-l-[#F6851B]', isActive);
            item.classList.toggle('bg-white/[0.06]', isActive);
            item.classList.toggle('border-l-transparent', !isActive);
        });
    }
}

// Export singleton instance
export const channelListUI = new ChannelListUI();
