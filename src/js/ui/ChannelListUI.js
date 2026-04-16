/**
 * ChannelListUI Module
 * Manages channel list rendering, filtering, sorting, and drag-and-drop reordering
 */

import { Logger } from '../logger.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { sanitizeText } from './sanitizer.js';

class ChannelListUI {
    constructor() {
        this.elements = {};
        this.currentFilter = 'all'; // all | personal | community
        
        // Dependencies (injected)
        this.channelManager = null;
        this.secureStorage = null;
        this.onChannelSelect = null;
    }

    /**
     * Set dependencies for the module
     */
    setDependencies({ channelManager, secureStorage, onChannelSelect }) {
        this.channelManager = channelManager;
        this.secureStorage = secureStorage;
        this.onChannelSelect = onChannelSelect;
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

        // Render channel items
        this.elements.channelList.innerHTML = channels.map(channel => 
            this._renderChannelItem(channel, currentStreamId)
        ).join('');

        // Attach event listeners
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
        
        this.elements.channelList.innerHTML = `
            <div class="p-4 text-center text-white/25 text-[13px]">
                ${filterMsg}
            </div>
        `;
        Logger.debug('ChannelListUI: No channels to render');
    }

    /**
     * Render a single channel item
     * @private
     */
    _renderChannelItem(channel, currentStreamId) {
        // Calculate unread count based on timestamps
        const lastAccess = this.secureStorage.getChannelLastAccess(channel.streamId) || 0;
        const unreadMessages = channel.messages.filter(m => m.timestamp > lastAccess);
        const unreadCount = unreadMessages.length;
        const hasUnread = unreadCount > 0;
        
        const countClass = hasUnread 
            ? 'text-white bg-[#F6851B]/20 font-medium' 
            : 'text-white/30 bg-white/[0.04]';
        
        // Show "+30" if we hit the initial load limit
        const displayCount = hasUnread ? (unreadCount >= 30 ? '+30' : unreadCount) : '';
        
        // Check if this is the currently active channel
        const isActive = channel.streamId === currentStreamId;
        const activeClass = isActive 
            ? 'border-l-2 border-l-[#F6851B] bg-white/[0.06]' 
            : 'border-l-2 border-l-transparent';

        return `
            <div
                class="channel-item px-3 py-3 mx-2 rounded-xl cursor-pointer bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.06] hover:border-white/[0.08] transition-all duration-200 group ${activeClass}"
                data-stream-id="${escapeAttr(channel.streamId)}"
                draggable="true"
            >
                <div class="flex items-center">
                    <!-- DM icon slot (fixed width for alignment) -->
                    <div class="channel-icon-slot w-5 flex-shrink-0 flex items-center justify-center">
                        ${channel.type === 'dm' ? '<svg class="w-3.5 h-3.5 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>' : ''}
                    </div>
                    <!-- Channel name -->
                    <div class="flex-1 min-w-0 ml-1.5">
                        <h3 class="text-sm font-medium text-white/90 truncate">${escapeHtml(sanitizeText(channel.name))}</h3>
                    </div>
                    <!-- Right side: drag handle + counter + arrow -->
                    <div class="flex items-center gap-1.5 ml-2 flex-shrink-0">
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
                        ${hasUnread 
                            ? `<span class="channel-msg-count text-[10px] ${countClass} px-1.5 py-0.5 rounded-md" data-channel-count="${escapeAttr(channel.streamId)}">${displayCount}</span>` 
                            : `<span class="channel-msg-count text-[10px] text-white/30 bg-white/[0.04] px-1.5 py-0.5 rounded-md hidden" data-channel-count="${escapeAttr(channel.streamId)}">0</span>`
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
        document.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                // Ignore clicks on drag handle
                if (e.target.closest('.drag-handle')) return;
                
                const streamId = e.currentTarget.dataset.streamId;
                Logger.debug('ChannelListUI: Channel clicked:', streamId);
                
                if (this.onChannelSelect) {
                    this.onChannelSelect(streamId);
                }
            });
        });
    }

    /**
     * Setup drag and drop for channel reordering
     * @private
     */
    _setupDragAndDrop() {
        const channelItems = document.querySelectorAll('.channel-item');
        let draggedItem = null;
        let draggedStreamId = null;

        channelItems.forEach(item => {
            // Drag start
            item.addEventListener('dragstart', (e) => {
                draggedItem = item;
                draggedStreamId = item.dataset.streamId;
                item.classList.add('dragging');
                
                // Required for Firefox
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', draggedStreamId);
                
                setTimeout(() => {
                    item.style.opacity = '0.5';
                }, 0);
            });

            // Drag end
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                item.style.opacity = '';
                draggedItem = null;
                draggedStreamId = null;
                
                document.querySelectorAll('.channel-item').forEach(el => {
                    el.classList.remove('drag-over');
                });
            });

            // Drag over
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                if (item !== draggedItem) {
                    item.classList.add('drag-over');
                }
            });

            // Drag leave
            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over');
            });

            // Drop
            item.addEventListener('drop', async (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                
                if (!draggedItem || item === draggedItem) return;
                
                const targetStreamId = item.dataset.streamId;
                await this._handleDrop(draggedStreamId, targetStreamId);
            });
        });
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
        const badge = document.querySelector(`[data-channel-count="${CSS.escape(streamId)}"]`);
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
        document.querySelectorAll('.channel-item').forEach(item => {
            const isActive = item.dataset.streamId === streamId;
            item.classList.toggle('border-l-[#F6851B]', isActive);
            item.classList.toggle('bg-white/[0.06]', isActive);
            item.classList.toggle('border-l-transparent', !isActive);
        });
    }
}

// Export singleton instance
export const channelListUI = new ChannelListUI();
