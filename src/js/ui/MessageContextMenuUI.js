/**
 * MessageContextMenuUI
 *
 * Owns the right-click context menu for messages (#message-context-menu).
 * Handles visibility logic per-message (own vs other, DM vs channel,
 * admin vs non-admin) and dispatches actions:
 *   - copy-text / copy-address
 *   - send-dm / add-contact / remove-contact / block-user
 *   - edit-message / delete-message            (own messages)
 *   - admin-delete-message / ban-user          (admin-only, non-DM)
 *   - pin-message / unpin-message              (admin-only, non-DM)
 *
 * Add/Remove contact modals are delegated to ContactsUI via deps.
 */

class MessageContextMenuUI {
    constructor() {
        this.deps = null;
        this.elements = null;
        this.contextMenuTarget = null;
        this._scrollBlocker = null;
    }

    /** Set dependencies from UIController */
    setDependencies(deps) {
        this.deps = deps;
    }

    /**
     * Element references — only `messagesArea` is required; the menu DOM is
     * looked up lazily in `init()` so it works regardless of caller order.
     */
    setElements(elements) {
        this.elements = elements;
    }

    /** Wire up listeners. Idempotent. */
    init() {
        if (!this.elements) this.elements = {};
        this.elements.contextMenu = document.getElementById('message-context-menu');

        if (this.elements.contextMenu && !this._wired) {
            // Hide on outside click
            document.addEventListener('click', () => this.hideContextMenu());
            // Per-item action dispatch
            this.elements.contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
                item.addEventListener('click', (e) => this.handleContextMenuAction(e));
            });
            // Right-click on messages opens the menu (desktop)
            document.addEventListener('contextmenu', (e) => this.handleMessageRightClick(e));
            // Mobile: double-tap on a message opens the menu 
            // Native long-press contextmenu is suppressed below when triggered by touch.
            this._wireTouchHandlers();
            this._wired = true;
        }
    }

    /**
     * Wire touch-based handlers for mobile:
     *   - Double-tap on a message bubble opens the context menu.
     *   - Native long-press contextmenu (Android Chrome fires `contextmenu`
     *     after a long touch) is suppressed so only double-tap triggers it.
     * @private
     */
    _wireTouchHandlers() {
        const DOUBLE_TAP_MS = 350;
        const TAP_MOVE_TOLERANCE = 10; // px
        const LONGPRESS_SUPPRESS_MS = 1000;

        let lastTapTime = 0;
        let lastTapTarget = null;
        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;
        let touchMoved = false;

        document.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) {
                touchMoved = true;
                return;
            }
            const messageDiv = e.target.closest?.('.message-entry');
            if (!messageDiv || !this.elements.messagesArea?.contains(messageDiv)) return;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchStartTime = Date.now();
            touchMoved = false;
            this._lastTouchOnMessage = touchStartTime;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (touchMoved || !e.touches[0]) return;
            const dx = e.touches[0].clientX - touchStartX;
            const dy = e.touches[0].clientY - touchStartY;
            if (Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE) touchMoved = true;
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            if (touchMoved) return;
            const messageDiv = e.target.closest?.('.message-entry');
            if (!messageDiv || !this.elements.messagesArea?.contains(messageDiv)) return;

            // Ignore taps on inner action controls.
            if (e.target.closest?.('.reply-trigger, .react-trigger, .reaction-badge, a, button, img, video')) {
                return;
            }

            const now = Date.now();
            if (lastTapTarget === messageDiv && (now - lastTapTime) < DOUBLE_TAP_MS) {
                e.preventDefault();
                const t = e.changedTouches?.[0];
                this._openMenuForMessage(messageDiv, t?.clientX ?? 0, t?.clientY ?? 0);
                lastTapTime = 0;
                lastTapTarget = null;
                this._lastTouchOnMessage = now;
            } else {
                lastTapTime = now;
                lastTapTarget = messageDiv;
            }
        });

        // Track the suppression window for native long-press contextmenu.
        this._isWithinTouchWindow = () => {
            return this._lastTouchOnMessage
                && (Date.now() - this._lastTouchOnMessage) < LONGPRESS_SUPPRESS_MS;
        };
    }

    /**
     * Right-click handler — decides which menu items to show for the clicked
     * message and positions the menu.
     */
    handleMessageRightClick(e) {
        const { Logger } = this.deps;

        const messageDiv = e.target.closest('.message-entry');
        if (!messageDiv || !this.elements.messagesArea?.contains(messageDiv)) {
            return;
        }

        e.preventDefault();

        // Suppress mobile long-press: if this `contextmenu` was triggered by a
        // recent touch, do not open the menu — only double-tap should.
        if (this._isWithinTouchWindow?.()) {
            return;
        }

        this._openMenuForMessage(messageDiv, e.clientX, e.clientY);
    }

    /**
     * Open the context menu for `messageDiv` at the given viewport coords.
     * @private
     */
    _openMenuForMessage(messageDiv, clientX, clientY) {
        const { Logger } = this.deps;

        const senderAddress = messageDiv.dataset.sender;
        if (!senderAddress) {
            Logger.warn('No sender address found for message');
            return;
        }

        this.contextMenuTarget = {
            element: messageDiv,
            sender: senderAddress,
            msgId: messageDiv.dataset.msgId,
            msgType: messageDiv.dataset.type
        };

        const isSelf = messageDiv.classList.contains('own-message');
        const { channelManager, identityManager } = this.deps;
        const currentChannel = channelManager?.getCurrentChannel?.();

        // Send DM — hide if self or already in DM with this sender
        const sendDMBtn = document.getElementById('context-menu-send-dm-btn');
        if (sendDMBtn) {
            const alreadyInDM = currentChannel?.type === 'dm'
                && currentChannel.peerAddress?.toLowerCase() === senderAddress.toLowerCase();
            sendDMBtn.classList.toggle('hidden', isSelf || alreadyInDM);
        }

        // Add/Remove Contact
        const addContactBtn = document.getElementById('context-menu-add-contact-btn');
        const removeContactBtn = document.getElementById('context-menu-remove-contact-btn');
        const isContact = !!identityManager?.getTrustedContact?.(senderAddress);
        if (addContactBtn) addContactBtn.classList.toggle('hidden', isContact);
        if (removeContactBtn) removeContactBtn.classList.toggle('hidden', !isContact);

        // Block User — only inside a DM channel and not for yourself
        const blockBtn = document.getElementById('context-menu-block-btn');
        const blockDivider = document.getElementById('context-menu-block-divider');
        const isDM = currentChannel?.type === 'dm'
            && senderAddress.toLowerCase() !== identityManager?.getAddress?.()?.toLowerCase();
        if (blockBtn) blockBtn.classList.toggle('hidden', !isDM);
        if (blockDivider) blockDivider.classList.toggle('hidden', !isDM);

        // Edit / Delete (own messages)
        const editBtn = document.getElementById('context-menu-edit-btn');
        const deleteBtn = document.getElementById('context-menu-delete-btn');
        const editDivider = document.getElementById('context-menu-edit-divider');
        const showEdit = isSelf && messageDiv.dataset.type === 'text';
        const showDelete = isSelf;
        if (editBtn) editBtn.classList.toggle('hidden', !showEdit);
        if (deleteBtn) deleteBtn.classList.toggle('hidden', !showDelete);
        if (editDivider) editDivider.classList.toggle('hidden', !showEdit && !showDelete);

        // Admin moderation: Pin / Unpin / Admin Delete / Ban
        this._toggleAdminItems(currentChannel, senderAddress, isSelf);

        this.showContextMenu(clientX, clientY);
    }

    /**
     * Compute and apply visibility for the admin moderation buttons.
     * @private
     */
    _toggleAdminItems(currentChannel, senderAddress, isSelf) {
        const adminDivider = document.getElementById('context-menu-admin-divider');
        const pinBtn = document.getElementById('context-menu-pin-btn');
        const unpinBtn = document.getElementById('context-menu-unpin-btn');
        const adminDeleteBtn = document.getElementById('context-menu-admin-delete-btn');
        const banBtn = document.getElementById('context-menu-ban-btn');

        const { channelManager } = this.deps;
        const isDMChannel = currentChannel?.type === 'dm';
        const isPreview = currentChannel?.isPreview === true;

        let isAdminUser = false;
        if (currentChannel && !isDMChannel && !isPreview && channelManager?.getCachedDeletePermission) {
            const cached = channelManager.getCachedDeletePermission(currentChannel.streamId);
            isAdminUser = !!cached?.canDelete;
        }

        const msgId = this.contextMenuTarget?.msgId;
        const isAlreadyPinned = !!(currentChannel?.adminState?.pins?.some?.(p => p.targetId === msgId));
        const isCreator = currentChannel?.createdBy
            && senderAddress.toLowerCase() === String(currentChannel.createdBy).toLowerCase();

        const showPin = isAdminUser && !!msgId && !isAlreadyPinned;
        const showUnpin = isAdminUser && !!msgId && isAlreadyPinned;
        // Admin delete hides the message for everyone via the admin stream.
        // Skip on own messages where the regular delete already exists.
        const showAdminDelete = isAdminUser && !isSelf && !!msgId;
        // Cannot ban yourself or the channel admin.
        const showBan = isAdminUser && !isSelf && !isCreator;

        if (pinBtn) pinBtn.classList.toggle('hidden', !showPin);
        if (unpinBtn) unpinBtn.classList.toggle('hidden', !showUnpin);
        if (adminDeleteBtn) adminDeleteBtn.classList.toggle('hidden', !showAdminDelete);
        if (banBtn) banBtn.classList.toggle('hidden', !showBan);
        if (adminDivider) adminDivider.classList.toggle('hidden', !(showPin || showUnpin || showAdminDelete || showBan));
    }

    /** Show the menu at viewport coords, clamped to the visible area. */
    showContextMenu(x, y) {
        if (!this.elements.contextMenu) this.init();
        if (!this.elements.contextMenu) return;

        this._blockScroll();

        // Temporarily show to measure dimensions
        this.elements.contextMenu.style.visibility = 'hidden';
        this.elements.contextMenu.classList.remove('hidden');

        const menuWidth = this.elements.contextMenu.offsetWidth;
        const menuHeight = this.elements.contextMenu.offsetHeight;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (x + menuWidth > viewportWidth - 10) x = viewportWidth - menuWidth - 10;
        if (y + menuHeight > viewportHeight - 10) y = viewportHeight - menuHeight - 10;
        x = Math.max(10, x);
        y = Math.max(10, y);

        this.elements.contextMenu.style.left = `${x}px`;
        this.elements.contextMenu.style.top = `${y}px`;
        this.elements.contextMenu.style.visibility = 'visible';
    }

    hideContextMenu() {
        this.elements?.contextMenu?.classList.add('hidden');
        this._unblockScroll();
    }

    /** Block scroll on messages area without changing overflow (avoids reflow). */
    _blockScroll() {
        const messagesArea = document.getElementById('messages-area');
        if (!messagesArea || this._scrollBlocker) return;
        const prevent = (e) => e.preventDefault();
        messagesArea.addEventListener('wheel', prevent, { passive: false });
        messagesArea.addEventListener('touchmove', prevent, { passive: false });
        this._scrollBlocker = { el: messagesArea, handler: prevent };
    }

    _unblockScroll() {
        if (!this._scrollBlocker) return;
        const { el, handler } = this._scrollBlocker;
        el.removeEventListener('wheel', handler);
        el.removeEventListener('touchmove', handler);
        this._scrollBlocker = null;
    }

    /** Dispatch the clicked menu item. */
    async handleContextMenuAction(e) {
        const { showNotification, contactsUI, chatAreaUI, channelManager } = this.deps;

        const action = e.currentTarget.dataset.action;
        const target = this.contextMenuTarget;
        if (!target?.sender) {
            this.hideContextMenu();
            return;
        }

        const address = target.sender;
        this.hideContextMenu();

        switch (action) {
            case 'send-dm':
                this.handleSendDM(address);
                break;

            case 'add-contact':
                contactsUI?.showAddModal(address);
                break;

            case 'copy-text': {
                const msgContent = target.element?.querySelector('.message-content');
                const text = msgContent?.innerText || msgContent?.textContent || '';
                try {
                    await navigator.clipboard.writeText(text);
                    showNotification('Text copied!', 'success');
                } catch {
                    showNotification('Failed to copy', 'error');
                }
                break;
            }

            case 'copy-address':
                try {
                    await navigator.clipboard.writeText(address);
                    showNotification('Address copied!', 'success');
                } catch {
                    showNotification('Failed to copy', 'error');
                }
                break;

            case 'remove-contact':
                contactsUI?.showRemoveModal(address);
                break;

            case 'block-user':
                this.handleBlockUser(address);
                break;

            case 'edit-message':
                if (target.msgId && chatAreaUI) {
                    chatAreaUI.startEdit(target.msgId);
                }
                break;

            case 'delete-message':
                if (target.msgId && confirm('Delete this message?')) {
                    const ch = channelManager?.getCurrentChannel?.();
                    if (ch) channelManager.sendDelete(ch.streamId, target.msgId);
                }
                break;

            case 'admin-delete-message': {
                if (!target.msgId) break;
                if (!confirm('Hide this message for everyone in the channel?')) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                try {
                    await channelManager.hideMessage(ch.streamId, target.msgId);
                    showNotification('Message hidden', 'success');
                } catch (err) {
                    showNotification(err?.message || 'Failed to hide message', 'error');
                }
                break;
            }

            case 'ban-user': {
                if (!confirm('Ban this user from the channel?')) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                try {
                    await channelManager.banMember(ch.streamId, address);
                    showNotification('User banned', 'success');
                } catch (err) {
                    showNotification(err?.message || 'Failed to ban user', 'error');
                }
                break;
            }

            case 'pin-message': {
                if (!target.msgId) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                try {
                    await channelManager.pinMessage(ch.streamId, target.msgId);
                    showNotification('Message pinned', 'success');
                } catch (err) {
                    showNotification(err?.message || 'Failed to pin message', 'error');
                }
                break;
            }

            case 'unpin-message': {
                if (!target.msgId) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                try {
                    await channelManager.unpinMessage(ch.streamId, target.msgId);
                    showNotification('Message unpinned', 'success');
                } catch (err) {
                    showNotification(err?.message || 'Failed to unpin message', 'error');
                }
                break;
            }
        }
    }

    /** Open a DM conversation with the given address. */
    async handleSendDM(address) {
        const { dmManager, showNotification } = this.deps;
        if (!dmManager) {
            showNotification('DM system not available', 'error');
            return;
        }
        try {
            await dmManager.startDM(address);
        } catch (e) {
            showNotification(e.message || 'Failed to start DM', 'error');
        }
    }

    /**
     * Find the DM channel for `address` and leave it with `block: true`,
     * then refresh the channel list and navigate away.
     */
    async handleBlockUser(address) {
        const {
            channelManager, showNotification,
            renderChannelList, selectChannel, showConnectedNoChannelState
        } = this.deps;
        if (!channelManager) return;

        const channels = channelManager.getAllChannels();
        const dmChannel = channels.find(
            ch => ch.type === 'dm' && ch.peerAddress?.toLowerCase() === address.toLowerCase()
        );

        if (!dmChannel) {
            showNotification('Could not find DM conversation', 'error');
            return;
        }

        const short = address.slice(0, 6) + '…' + address.slice(-4);
        if (!confirm(`Block ${short}? All messages from this user will be permanently ignored.`)) {
            return;
        }

        try {
            await channelManager.leaveChannel(dmChannel.messageStreamId || dmChannel.streamId, { block: true });
            showNotification('User blocked', 'info');

            const remaining = channelManager.getAllChannels();
            if (remaining.length > 0) {
                renderChannelList?.();
                await selectChannel?.(remaining[0].streamId);
            } else {
                renderChannelList?.();
                showConnectedNoChannelState?.();
            }
        } catch (err) {
            showNotification('Failed to block user: ' + err.message, 'error');
        }
    }
}

export const messageContextMenuUI = new MessageContextMenuUI();
