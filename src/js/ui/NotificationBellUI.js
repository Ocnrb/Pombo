/**
 * Notification bell: channel invites + active transfers, in one dropdown.
 *
 * The Android app grew this first (invites used to exist on the web only as
 * transient toasts; unanswered ones were unreachable once the toast died).
 * This is the web side of the same menu: the pending-invite list the
 * notificationManager already keeps, plus every download in flight and every
 * file this device is serving, with basic speed figures and a way to cancel
 * either.
 *
 * Placement is CSS-driven (components.css): on desktop the bell sits beside
 * the account button, top right; on the mobile viewport it takes the header
 * slot the Create Channel button uses in Explore — but shows in the Chats
 * view instead.
 */

import { Logger } from '../logger.js';
import { escapeHtml } from './utils.js';
import { sanitizeText } from './sanitizer.js';

class NotificationBellUI {
    constructor() {
        this.deps = {};
        this.open = false;
        this.refreshTimer = null;
    }

    /**
     * @param {Object} deps
     * @param {Object} deps.notificationManager
     * @param {Object} deps.mediaController
     */
    init(deps) {
        this.deps = deps;
        const wrapper = document.getElementById('notif-bell-wrapper');
        const btn = document.getElementById('notif-bell-btn');
        const dropdown = document.getElementById('notif-bell-dropdown');
        if (!wrapper || !btn || !dropdown) {
            Logger.warn('Notification bell markup missing');
            return;
        }

        wrapper.classList.remove('hidden');

        // A reconnect or wallet switch runs the connect flow again; wiring the
        // listeners twice would double-fire every click.
        if (this._wired) {
            this.updateBadge();
            return;
        }
        this._wired = true;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
        dropdown.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => { if (this.open) this.toggle(false); });

        // The manager pings on every invite arrival/accept/dismiss, so the
        // badge stays honest without the bell polling for it.
        deps.notificationManager.onChanged = () => {
            this.updateBadge();
            if (this.open) this.render();
        };
        this.updateBadge();
    }

    toggle(force) {
        const dropdown = document.getElementById('notif-bell-dropdown');
        if (!dropdown) return;
        this.open = force !== undefined ? force : !this.open;
        dropdown.classList.toggle('hidden', !this.open);
        if (this.open) {
            this.render();
            // Speeds move while the menu is open; once a second is enough for
            // a rate readout and cheap enough to not matter.
            this.refreshTimer = setInterval(() => this.render(), 1000);
        } else if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    updateBadge() {
        const badge = document.getElementById('notif-bell-badge');
        if (!badge) return;
        const count = this.deps.notificationManager?.getPendingInvites?.().length || 0;
        badge.classList.toggle('hidden', count === 0);
        badge.textContent = count > 9 ? '9+' : String(count);
    }

    formatBytes(bytes) {
        if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
        return bytes + ' B';
    }

    formatSpeed(bytesPerSec) {
        if (!bytesPerSec || bytesPerSec <= 0) return '';
        return this.formatBytes(bytesPerSec) + '/s';
    }

    render() {
        this.renderInvites();
        this.renderTransfers();
        this.updateBadge();
    }

    renderInvites() {
        const list = document.getElementById('notif-invites-list');
        if (!list) return;
        const invites = this.deps.notificationManager?.getPendingInvites?.() || [];
        if (invites.length === 0) {
            list.innerHTML = '<div class="px-3.5 pb-2 text-[13px] text-white/40">No pending invites</div>';
            return;
        }
        list.innerHTML = invites.map(invite => `
            <div class="px-3.5 py-1.5" data-invite-id="${escapeHtml(invite.inviteId)}">
                <div class="text-[13px] font-medium text-white/90">${escapeHtml(sanitizeText(invite.channel?.name || 'Channel'))}</div>
                <div class="text-[11px] text-white/40">From: ${escapeHtml((invite.from || '').slice(0, 6))}…${escapeHtml((invite.from || '').slice(-4))}</div>
                <div class="mt-1.5 mb-1 flex gap-2">
                    <button class="notif-invite-accept bg-white/90 hover:bg-white text-[#0a0a0a] px-3 py-1 rounded-md text-[11px] font-medium transition">Accept</button>
                    <button class="notif-invite-dismiss bg-white/10 hover:bg-white/20 text-white/70 px-3 py-1 rounded-md text-[11px] font-medium transition">Dismiss</button>
                </div>
            </div>
        `).join('');
        list.querySelectorAll('[data-invite-id]').forEach(row => {
            const id = row.dataset.inviteId;
            row.querySelector('.notif-invite-accept')?.addEventListener('click', () => {
                this.toggle(false);
                this.deps.notificationManager.acceptInvite(id);
            });
            row.querySelector('.notif-invite-dismiss')?.addEventListener('click', () => {
                this.deps.notificationManager.dismissInvite(id);
                this.render();
            });
        });
    }

    renderTransfers() {
        const list = document.getElementById('notif-transfers-list');
        const media = this.deps.mediaController;
        if (!list || !media) return;

        const rows = [];

        // Downloads in flight
        for (const [fileId, transfer] of media.incomingFiles) {
            const p = media.getDownloadProgress(fileId);
            if (!p || !transfer.metadata) continue;
            const transferred = p.total > 0 ? (p.received / p.total) * p.fileSize : 0;
            const speed = this.formatSpeed(p.bytesPerSec);
            rows.push(`
                <div class="px-3.5 py-1.5 flex items-center gap-2" data-transfer-dl="${escapeHtml(fileId)}">
                    <svg class="w-3.5 h-3.5 flex-shrink-0 text-[#F6851B]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m0 0 6-6m-6 6-6-6"/>
                    </svg>
                    <div class="min-w-0 flex-1">
                        <div class="text-[12px] text-white/90 truncate">${escapeHtml(sanitizeText(transfer.metadata.fileName || fileId))}</div>
                        <div class="text-[10px] text-white/40 truncate">${this.formatBytes(transferred)} of ${this.formatBytes(p.fileSize)}${speed ? ` · ${speed}` : ''}</div>
                    </div>
                    <button class="notif-cancel-dl flex-shrink-0 text-white/45 hover:text-white transition" title="Cancel download">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>
            `);
        }

        // Files this device serves. localFiles also holds transient hashing
        // entries under a temp key — a real seed's key matches its fileId.
        for (const [fileId, info] of media.localFiles) {
            if (!info?.metadata || info.metadata.fileId !== fileId) continue;
            const { bytesPerSec, leechers } = media.getUploadStats(fileId);
            const rate = this.formatSpeed(bytesPerSec);
            const peers = leechers > 0 ? `${leechers} peer${leechers === 1 ? '' : 's'}` : '';
            const stats = [this.formatBytes(info.metadata.fileSize), rate && `↑ ${rate}`, peers]
                .filter(Boolean).join(' · ');
            rows.push(`
                <div class="px-3.5 py-1.5 flex items-center gap-2" data-transfer-seed="${escapeHtml(fileId)}">
                    <svg class="w-3.5 h-3.5 flex-shrink-0 text-green-400/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19.5v-15m0 0-6 6m6-6 6 6"/>
                    </svg>
                    <div class="min-w-0 flex-1">
                        <div class="text-[12px] text-white/90 truncate">${escapeHtml(sanitizeText(info.metadata.fileName || fileId))}</div>
                        <div class="text-[10px] text-white/40 truncate">${stats}</div>
                    </div>
                    <button class="notif-stop-seed flex-shrink-0 text-white/45 hover:text-white transition" title="Stop seeding">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>
            `);
        }

        list.innerHTML = rows.length
            ? rows.join('')
            : '<div class="px-3.5 pb-2 text-[13px] text-white/40">No active transfers</div>';

        list.querySelectorAll('[data-transfer-dl]').forEach(row => {
            row.querySelector('.notif-cancel-dl')?.addEventListener('click', () => {
                this.deps.mediaController.cancelDownload(row.dataset.transferDl);
                this.render();
            });
        });
        list.querySelectorAll('[data-transfer-seed]').forEach(row => {
            row.querySelector('.notif-stop-seed')?.addEventListener('click', async () => {
                try {
                    await this.deps.mediaController.removeSeedFile(row.dataset.transferSeed);
                } catch (e) {
                    Logger.warn('Stop seeding failed:', e.message);
                }
                this.render();
            });
        });
    }
}

export const notificationBellUI = new NotificationBellUI();
