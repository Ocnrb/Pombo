/**
 * Owner key-responder — the in-tab half.
 *
 * A gated channel's key requests are only answered while someone holding the
 * keys is around; the responder keeps THIS device around on purpose. While a
 * Pombo tab is open, the marked channels' keys streams (-4) are swept on an
 * interval and every retained, uncovered KEY_REQUEST is answered — whether or
 * not the channel is open. The sweep is ensureChannelKeys, which is
 * idempotent: wrap coverage keeps repeats quiet, and for the admin it doubles
 * as the TTL re-announce / rotation heartbeat.
 *
 * The marked set is LOCAL to this device (per address, plain localStorage —
 * same pattern as the push registration sets): serving keys is a duty of the
 * device the owner chose, not of the account, so it never syncs.
 *
 * A hidden tab is throttled by the browser to roughly one tick per minute —
 * accepted: one to two minutes of worst-case latency, and the Android device
 * is the natural always-on responder.
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { authManager } from './auth.js';
import { epochKeyManager, usesEpochKeys } from './epochKeyManager.js';

const SWEEP_INTERVAL_MS = 45 * 1000;

class KeyResponder {
    constructor() {
        this.timer = null;
        this.sweeping = false;
    }

    _storageKey() {
        const addr = authManager.getAddress();
        return addr ? CONFIG.storageKeys.keyResponderChannels(addr) : null;
    }

    /** Marked message-stream ids for the current account (this device only). */
    getMarkedChannels() {
        const key = this._storageKey();
        if (!key) return [];
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '[]');
            return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
        } catch {
            return [];
        }
    }

    isMarked(messageStreamId) {
        return this.getMarkedChannels().includes(messageStreamId);
    }

    setMarked(messageStreamId, on) {
        const key = this._storageKey();
        if (!key) return;
        const set = new Set(this.getMarkedChannels());
        if (on) set.add(messageStreamId); else set.delete(messageStreamId);
        try {
            localStorage.setItem(key, JSON.stringify(Array.from(set)));
        } catch { /* storage full/blocked — the toggle simply does not stick */ }
        if (on) {
            this.start();
            this.sweepNow();
        }
    }

    /** Idempotent; a no-op until something is marked. */
    start() {
        if (this.timer) return;
        if (this.getMarkedChannels().length === 0) return;
        this.timer = setInterval(() => {
            this._sweep().catch(e => Logger.debug('keyResponder: sweep failed:', e.message));
        }, SWEEP_INTERVAL_MS);
        Logger.info('keyResponder: sweeping', this.getMarkedChannels().length, 'channel(s) every', SWEEP_INTERVAL_MS / 1000, 's');
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** One immediate pass (toggle flips, wake signals). */
    sweepNow() {
        this._sweep().catch(e => Logger.debug('keyResponder: sweep failed:', e.message));
    }

    async _sweep() {
        if (this.sweeping) return;    // a slow pass must not stack
        this.sweeping = true;
        try {
            const marked = this.getMarkedChannels();
            if (marked.length === 0) {
                this.stop();
                return;
            }
            const { channelManager } = await import('./channels.js');
            for (const messageStreamId of marked) {
                const channel = channelManager.channels?.get(messageStreamId);
                if (!usesEpochKeys(channel)) continue;    // gate repair pending, or gone
                try {
                    await epochKeyManager.ensureChannelKeys(channel);
                } catch (e) {
                    Logger.debug('keyResponder: sweep failed on', messageStreamId.slice(-20), ':', e.message);
                }
            }
        } finally {
            this.sweeping = false;
        }
    }
}

export const keyResponder = new KeyResponder();
