/**
 * AdminStatePoller
 *
 * Resend-based admin (-3/P0) state propagation. There is no live websocket
 * subscription on -3 in this model. Strategy:
 *   - On channel open: caller fetches the snapshot via streamrController.resendAdminState
 *     and applies it via channelManager.applyAdminState / equivalent.
 *   - This module fires periodic background refreshes via the supplied
 *     `refreshFn` (e.g. once every CONFIG.subscriptions.adminPollIntervalMs)
 *     so admins/bans/pins eventually converge even if a low-latency signal
 *     is missed.
 *   - Real-time updates while the channel is active are delivered out-of-band
 *     by the `admin_invalidate` ephemeral signal on -2/P0 (handled by
 *     channelManager.handleControlMessage / subscriptionManager
 *     ._handlePreviewEphemeral) which embeds the canonical ADMIN_STATE
 *     snapshot and is applied inline. After applying, those handlers call
 *     `markFresh()` so the next interval tick is exactly one period away.
 *   - When the document is hidden, polling pauses; on resume, an immediate
 *     `pollNow()` is fired so the user sees fresh state on their first
 *     interaction.
 *
 * Only one channel polls at a time (the active or preview channel), matching
 * the dual-stream model used by `subscriptionManager` for -1/-2.
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';

class AdminStatePoller {
    constructor() {
        this._streamId = null;          // active streamId (active OR preview)
        this._refreshFn = null;         // async () => void supplied at start()
        this._intervalHandle = null;
        this._pollPending = false;      // coalescing flag for pollNow()
        this._coalesceHandle = null;
        this._inFlight = false;         // re-entrancy guard (one refresh at a time)
        this._paused = false;
        this._visibilityHandler = null;
    }

    /**
     * Start polling for a channel. Replaces any existing polling target.
     * Does NOT call refresh immediately — the caller already does that
     * via the explicit on-open resend.
     *
     * @param {string} streamId
     * @param {() => Promise<void>|void} refreshFn
     */
    start(streamId, refreshFn) {
        if (!streamId || typeof refreshFn !== 'function') {
            Logger.warn('AdminStatePoller.start: invalid args');
            return;
        }
        // If switching channels, stop previous timer first.
        if (this._streamId && this._streamId !== streamId) {
            this._clearTimers();
        }

        this._streamId = streamId;
        this._refreshFn = refreshFn;
        this._paused = document.hidden === true;

        this._installVisibilityListener();
        if (!this._paused) {
            this._startInterval();
        }
        Logger.debug('AdminStatePoller started for', String(streamId).slice(-30), {
            paused: this._paused,
            intervalMs: this._intervalMs()
        });
    }

    /**
     * Stop polling completely. Call on downgradeToBackground / clearPreviewChannel.
     */
    stop() {
        this._clearTimers();
        this._removeVisibilityListener();
        this._streamId = null;
        this._refreshFn = null;
        this._paused = false;
        this._pollPending = false;
        this._inFlight = false;
        Logger.debug('AdminStatePoller stopped');
    }

    /**
     * Force an immediate refresh. Coalesces calls within a 50ms window so
     * a burst of invalidation signals only triggers a single resend.
     */
    pollNow() {
        if (!this._streamId || !this._refreshFn) return;
        if (this._pollPending) return;
        this._pollPending = true;
        this._coalesceHandle = setTimeout(() => {
            this._coalesceHandle = null;
            this._pollPending = false;
            this._runRefresh('pollNow');
        }, 50);
    }

    /**
     * Reset the periodic timer — called after a local publish so the next
     * scheduled refresh is exactly one interval away (no redundant poll
     * right after an already-applied optimistic update).
     */
    markFresh() {
        if (!this._streamId || !this._refreshFn) return;
        this._restartInterval();
    }

    /**
     * @returns {string|null} The streamId currently being polled.
     */
    getStreamId() {
        return this._streamId;
    }

    // -- internals ---------------------------------------------------------

    _intervalMs() {
        const v = CONFIG?.subscriptions?.adminPollIntervalMs;
        return typeof v === 'number' && v > 0 ? v : 30000;
    }

    _startInterval() {
        this._clearInterval();
        this._intervalHandle = setInterval(() => {
            this._runRefresh('interval');
        }, this._intervalMs());
    }

    _restartInterval() {
        if (this._paused) return;
        this._startInterval();
    }

    _clearInterval() {
        if (this._intervalHandle) {
            clearInterval(this._intervalHandle);
            this._intervalHandle = null;
        }
    }

    _clearTimers() {
        this._clearInterval();
        if (this._coalesceHandle) {
            clearTimeout(this._coalesceHandle);
            this._coalesceHandle = null;
        }
    }

    async _runRefresh(reason) {
        if (!this._refreshFn || !this._streamId) return;
        if (this._inFlight) return; // skip overlapping ticks
        this._inFlight = true;
        try {
            await this._refreshFn();
        } catch (e) {
            Logger.debug(`AdminStatePoller refresh failed (${reason}):`, e?.message || e);
        } finally {
            this._inFlight = false;
        }
    }

    _installVisibilityListener() {
        if (this._visibilityHandler) return;
        if (typeof document === 'undefined' || !document.addEventListener) return;

        this._visibilityHandler = () => {
            if (!this._streamId) return;
            if (document.hidden) {
                this._paused = true;
                this._clearInterval();
                Logger.debug('AdminStatePoller paused (document hidden)');
            } else {
                if (!this._paused) return;
                this._paused = false;
                Logger.debug('AdminStatePoller resumed (document visible) — pollNow');
                this._startInterval();
                this.pollNow();
            }
        };
        document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    _removeVisibilityListener() {
        if (!this._visibilityHandler) return;
        if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
        }
        this._visibilityHandler = null;
    }
}

export const adminStatePoller = new AdminStatePoller();
