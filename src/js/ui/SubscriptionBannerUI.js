/**
 * SubscriptionBannerUI
 *
 * Paid-channel subscription chrome (N-F): a static strip above the messages
 * list — amber "ends in N days" inside the warning window, red "expired"
 * with a Renew CTA after the cutoff (Q5: no grace period — paidUntil is a
 * hard stop). The time-left line lives in Channel Details / Access
 * (ChannelSettingsUI), not in the chat header.
 *
 * Status reads are cached here for STATUS_TTL_MS on top of gateManager's own
 * 10-min caches, so update() is safe to call on every render. A renewal must
 * go through noteRenewed() to drop both layers at once.
 */

/** Show the renew warning when less than this remains (§7.14). */
export const WARNING_MS = 3 * 24 * 60 * 60 * 1000;
const STATUS_TTL_MS = 60_000;

/** "12 days" / "1 day" / "5h" / "less than an hour" */
export function formatRemaining(msLeft) {
    const days = Math.floor(msLeft / 86_400_000);
    if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`;
    const hours = Math.floor(msLeft / 3_600_000);
    if (hours >= 1) return `${hours}h`;
    return 'less than an hour';
}

class SubscriptionBannerUI {
    constructor() {
        this.deps = {};
        this.elements = null;
        // streamId → { paid, until (unix sec), accessNow, at }
        this._status = new Map();
        // streamIds whose <3-day warning was dismissed this session
        this._dismissedWarn = new Set();
        this._refreshing = new Set();
    }

    /** @param {Object} deps - { channelManager, authManager, Logger, onRenew, onStatusResolved } */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /** @param {Object} elements - { banner, text, renewBtn, dismissBtn } */
    init(elements) {
        this.elements = elements;
        elements?.renewBtn?.addEventListener('click', () => this.renewCurrent());
        elements?.dismissBtn?.addEventListener('click', () => {
            const channel = this._resolveChannel();
            if (channel) this._dismissedWarn.add(channel.streamId);
            this._render();
        });
    }

    _resolveChannel() {
        return this.deps.channelManager?.getCurrentChannel?.() || null;
    }

    /**
     * The last resolved status for a channel, or null while unresolved.
     * Sync by design — ChatAreaUI's empty-state renderer reads it to decide
     * between "waiting for keys" and "subscription expired".
     * @returns {{paid: boolean, until: number, accessNow: boolean}|null}
     */
    getStatus(streamId) {
        return this._status.get(streamId) || null;
    }

    /** Drop the cached status after a renewal so the next render re-reads. */
    noteRenewed(streamId) {
        this._status.delete(streamId);
        this._dismissedWarn.delete(streamId);
        this.update();
    }

    /** Re-render from cached status; kick an async refresh when stale. */
    update() {
        if (!this.elements?.banner) return;
        const channel = this._resolveChannel();
        if (!channel?.gate?.address) {
            this._hideAll();
            return;
        }
        const entry = this._status.get(channel.streamId);
        if (!entry || Date.now() - entry.at > STATUS_TTL_MS) {
            this._refresh(channel);
        }
        this._render();
    }

    async _refresh(channel) {
        const streamId = channel.streamId;
        if (this._refreshing.has(streamId)) return;
        this._refreshing.add(streamId);
        try {
            const { gateManager, GATE_MODE } = await import('../gate.js');
            const me = this.deps.authManager?.getAddress?.();
            if (!me) return;
            const info = await gateManager.getGateInfo(channel.gate.address);
            if (info.mode !== GATE_MODE.PAID || info.owner === me.toLowerCase()) {
                this._status.set(streamId, { paid: false, until: 0, accessNow: true, at: Date.now() });
                return;
            }
            const until = await gateManager.paidUntilCached(channel.gate.address, me);
            if (until === null) return; // chain unreachable — keep the last state
            // until === 0 with access is a moderator (never pays) — no banner
            const accessNow = until * 1000 > Date.now()
                || await gateManager.checkAccess(channel.gate.address, me);
            this._status.set(streamId, { paid: true, until, accessNow, at: Date.now() });
            // The empty-state renderer reads getStatus() synchronously — give
            // it a chance to swap "waiting for keys" for "expired" now
            this.deps.onStatusResolved?.(streamId);
        } catch (error) {
            this.deps.Logger?.debug?.('subscription status refresh failed:', error?.message);
        } finally {
            this._refreshing.delete(streamId);
            this._render();
        }
    }

    _render() {
        const els = this.elements;
        if (!els?.banner) return;
        const channel = this._resolveChannel();
        const entry = channel ? this._status.get(channel.streamId) : null;
        if (!channel?.gate?.address || !entry?.paid) {
            this._hideAll();
            return;
        }

        const msLeft = entry.until * 1000 - Date.now();
        const active = msLeft > 0;

        if (active && msLeft >= WARNING_MS) {
            els.banner.classList.add('hidden');
            return;
        }
        if (active && this._dismissedWarn.has(channel.streamId)) {
            els.banner.classList.add('hidden');
            return;
        }
        if (!active && entry.accessNow) {
            // Moderator on a paid gate — access without a subscription
            els.banner.classList.add('hidden');
            return;
        }

        els.banner.classList.toggle('subscription-banner--expired', !active);
        if (els.text) {
            els.text.textContent = active
                ? `Subscription ends in ${formatRemaining(msLeft)} — renewing extends from the current end`
                : 'Subscription expired — new messages stay locked until you renew';
        }
        // The expired strip is the access state, not a notice — no dismissing it
        els.dismissBtn?.classList.toggle('hidden', !active);
        els.banner.classList.remove('hidden');
    }

    _hideAll() {
        this.elements?.banner?.classList.add('hidden');
    }

    /** Open the renewal flow for the channel being viewed. */
    renewCurrent() {
        const channel = this._resolveChannel();
        if (!channel?.gate?.address) return;
        this.deps.onRenew?.(channel);
    }
}

export const subscriptionBannerUI = new SubscriptionBannerUI();
