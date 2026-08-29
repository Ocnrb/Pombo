/**
 * The channel's moderation state: the ADMIN_STATE snapshot on -3/P0, how it is
 * validated, applied and published, and the moderation actions that patch it.
 * Bans, hidden messages and pins are all one document, published latest-wins,
 * which is why every action goes through the same serialised publish.
 */

import { Logger } from '../logger.js';
import { streamrController, STREAM_CONFIG, deriveEphemeralId, deriveAdminId } from '../streamr.js';
import { authManager } from '../auth.js';
import { adminStatePoller } from '../adminStatePoller.js';

export class AdminState {
    /**
     * Self-calls go through `manager` on purpose: while the manager is still
     * the entry point, anything that replaces one of its methods has to keep
     * intercepting the calls this class makes.
     * @param {Object} manager - the channel manager
     */
    constructor(manager) {
        this.manager = manager;
        // Serialization of ADMIN_STATE publishes per channel. Two concurrent
        // publishes (e.g. rapid ban + pin) would otherwise read the same
        // adminRev and publish colliding revs — latest-wins would then
        // silently drop one of the operations.
        this._adminPublishChain = new Map(); // messageStreamId -> Promise
    }

    /**
     * Create the default admin state shape for a channel.
     * @returns {{bannedMembers: Array, hiddenMessageIds: Array, pins: Array}}
     * @private
     */
    _createEmptyAdminState() {
        return { bannedMembers: [], hiddenMessageIds: [], pins: [] };
    }

    /**
     * Validate the shape of an ADMIN_STATE message before applying it.
     * @private
     */
    _isValidAdminState(msg) {
        if (!msg || typeof msg !== 'object') return false;
        if (msg.type !== 'ADMIN_STATE') return false;
        if (typeof msg.rev !== 'number' || !Number.isFinite(msg.rev) || msg.rev < 0) return false;
        if (!msg.state || typeof msg.state !== 'object') return false;
        return true;
    }

    /**
     * Normalize an ADMIN_STATE.state object into the channel.adminState shape.
     * Drops unknown fields and coerces missing ones to safe defaults.
     * @private
     */
    _normalizeAdminState(state) {
        const banned = Array.isArray(state.bannedMembers) ? state.bannedMembers : [];
        const hidden = Array.isArray(state.hiddenMessageIds) ? state.hiddenMessageIds : [];
        const pins = Array.isArray(state.pins) ? state.pins : [];
        return {
            bannedMembers: banned.filter(a => typeof a === 'string').map(a => a.toLowerCase()),
            hiddenMessageIds: hidden.filter(id => typeof id === 'string'),
            pins: pins.filter(p => p && typeof p === 'object' && typeof p.targetId === 'string')
        };
    }

    /**
     * Apply an admin state snapshot to the channel if its `rev` is higher than
     * the currently applied one (latest-wins).
     * @param {Object} channel - Channel object
     * @param {Object} adminMsg - ADMIN_STATE message ({ type, rev, ts, createdBy, state })
     * @returns {boolean} true if applied, false otherwise
     */
    applyAdminState(channel, adminMsg) {
        if (!channel) return false;
        if (!this.manager._isValidAdminState(adminMsg)) return false;

        // Only the channel creator (admin) is allowed to mutate admin state.
        // Stream-level permissions already enforce this on the network, but we
        // double-check locally in case storage is replayed for any reason.
        if (channel.createdBy && adminMsg.createdBy
            && adminMsg.createdBy.toLowerCase() !== channel.createdBy.toLowerCase()) {
            Logger.warn('Ignoring ADMIN_STATE from non-admin:', adminMsg.createdBy);
            return false;
        }

        const currentRev = typeof channel.adminRev === 'number' ? channel.adminRev : 0;
        const currentTs = typeof channel.adminTs === 'number' ? channel.adminTs : 0;
        const incomingTs = typeof adminMsg.ts === 'number' ? adminMsg.ts : 0;
        // Latest-wins by (rev, ts). Tiebreaker on ts is required because the
        // publisher may republish rev=1 across sessions if its local adminRev
        // wasn't bootstrapped yet — the most recent ts must still win.
        if (channel.adminLoaded) {
            if (adminMsg.rev < currentRev) return false;
            if (adminMsg.rev === currentRev && incomingTs <= currentTs) return false;
        }

        channel.adminState = this.manager._normalizeAdminState(adminMsg.state);
        channel.adminRev = adminMsg.rev;
        channel.adminTs = incomingTs;
        channel.adminLoaded = true;
        Logger.debug('Admin state applied:', {
            streamId: channel.messageStreamId.slice(-20),
            rev: adminMsg.rev,
            ts: incomingTs,
            banned: channel.adminState.bannedMembers.length,
            hidden: channel.adminState.hiddenMessageIds.length,
            pins: channel.adminState.pins.length
        });
        return true;
    }

    /**
     * Handle an ADMIN_STATE message arriving on the admin stream.
     * @param {string} messageStreamId - Channel key (-1 stream id)
     * @param {Object} data - Decoded ADMIN_STATE payload
     */
    handleAdminMessage(messageStreamId, data) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) return;
        const applied = this.manager.applyAdminState(channel, data);
        if (applied) {
            this.manager.notifyHandlers('admin_state_updated', {
                streamId: messageStreamId,
                adminState: channel.adminState,
                rev: channel.adminRev
            });
        }
    }

    /**
     * Bootstrap admin state via a one-shot resend of -3/P0 (no live
     * websocket subscription). Picks the snapshot with the highest `rev`
     * from the resend window before the channel content stream is
     * subscribed. Always resolves quickly — if the storage node is
     * unreachable the call returns with `adminLoaded=true` and an empty
     * state so the UI never blocks.
     *
     * Live updates while the channel remains active are delivered via:
     *   1. AdminStatePoller (periodic resend tick — convergence safety net)
     *   2. ADMIN_INVALIDATE control message on -2/P0 carrying the full
     *      snapshot (instant, applied inline by handleControlMessage)
     *
     * @param {string} messageStreamId - Channel key (-1)
     * @param {string} adminStreamId - Admin stream id (-3)
     * @param {string|null} password - Channel password for encrypted channels
     */
    async bootstrapAdminState(messageStreamId, adminStreamId, password = null) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) return;

        try {
            const latest = await streamrController.resendAdminState(adminStreamId, {
                historyCount: STREAM_CONFIG.ADMIN_HISTORY_COUNT,
                password
            });
            if (latest) {
                this.manager.handleAdminMessage(messageStreamId, latest);
            }
        } catch (e) {
            Logger.warn('Admin bootstrap resend failed (continuing without admin state):', e.message);
        } finally {
            // Mark loaded even if no message arrived or the resend failed,
            // so subsequent publishAdminState calls compute a sane next rev
            // and the timeline is not held back waiting for moderation data.
            channel.adminLoaded = true;
            Logger.debug('Admin state bootstrap complete', {
                streamId: messageStreamId.slice(-20),
                rev: channel.adminRev || 0
            });
        }
    }

    /**
     * Periodic / on-demand refresh of admin state via resend on -3/P0.
     * Used by AdminStatePoller and by ADMIN_INVALIDATE handlers.
     * Applies the latest snapshot only if its (rev, ts) beats the current
     * one — relies on `applyAdminState` for latest-wins comparison.
     *
     * @param {string} messageStreamId - Channel key (-1)
     * @returns {Promise<boolean>} true if a newer snapshot was applied
     */
    async refreshAdminState(messageStreamId) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) return false;
        const adminStreamId = channel.adminStreamId || deriveAdminId(messageStreamId);
        if (!adminStreamId) return false;

        try {
            const latest = await streamrController.resendAdminState(adminStreamId, {
                // Smaller window for cheap polling — only the most recent
                // snapshot wins regardless of how many entries we fetch.
                historyCount: 5,
                password: channel.password || null
            });
            if (!latest) return false;
            const incomingRev = typeof latest.rev === 'number' ? latest.rev : 0;
            const currentRev = channel.adminRev || 0;
            if (incomingRev <= currentRev) return false;
            const applied = this.manager.applyAdminState(channel, latest);
            if (applied) {
                this.manager.notifyHandlers('admin_state_updated', {
                    streamId: messageStreamId,
                    adminState: channel.adminState,
                    rev: channel.adminRev
                });
            }
            return applied;
        } catch (e) {
            Logger.debug('refreshAdminState error (ignored):', e.message);
            return false;
        }
    }

    /**
     * Publish a new ADMIN_STATE snapshot. Caller may pass either a full
     * `state` object or a `patch` object (merged onto the current state).
     * Only the channel admin (creator) should call this — the stream
     * permissions reject non-admin publishes at network level.
     *
     * @param {string} messageStreamId - Channel key (-1)
     * @param {Object} update - Either { state } (full snapshot) or { patch } (partial update)
     * @returns {Promise<{rev: number, state: Object}>} The published snapshot
     */
    async publishAdminState(messageStreamId, update = {}) {
        // Serialize publishes per channel: concurrent calls (e.g. rapid ban +
        // pin) would read the same adminRev and publish colliding revs.
        const prev = this._adminPublishChain.get(messageStreamId) || Promise.resolve();
        const run = prev
            .catch(() => { /* previous failure must not block the queue */ })
            .then(() => this.manager._publishAdminStateInner(messageStreamId, update));
        this._adminPublishChain.set(messageStreamId, run);
        try {
            return await run;
        } finally {
            if (this._adminPublishChain.get(messageStreamId) === run) {
                this._adminPublishChain.delete(messageStreamId);
            }
        }
    }

    /** @private Actual ADMIN_STATE publish — always called serialized per channel. */
    async _publishAdminStateInner(messageStreamId, update = {}) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) {
            throw new Error('Channel not found');
        }
        const adminStreamId = channel.adminStreamId || deriveAdminId(messageStreamId);
        if (!adminStreamId) {
            throw new Error('Channel has no admin stream');
        }

        const senderAddress = authManager.getAddress();
        if (!senderAddress) {
            throw new Error('Not authenticated');
        }
        if (channel.createdBy && senderAddress.toLowerCase() !== channel.createdBy.toLowerCase()) {
            throw new Error('Only the channel admin can publish admin state');
        }

        // Ensure we know the latest rev before publishing — otherwise on a fresh
        // session we'd republish rev=1 and collide with prior snapshots.
        if (!channel.adminLoaded) {
            try {
                await this.manager.bootstrapAdminState(messageStreamId, adminStreamId, channel.password || null);
            } catch (e) {
                Logger.warn('Bootstrap before publish failed (may publish stale rev):', e.message);
            }
        }

        // Compose new state: full replace if `state` provided, otherwise merge `patch`.
        const current = channel.adminState || { bannedMembers: [], hiddenMessageIds: [], pins: [] };
        const next = update.state
            ? this.manager._normalizeAdminState(update.state)
            : this.manager._normalizeAdminState({
                bannedMembers: update.patch?.bannedMembers ?? current.bannedMembers,
                hiddenMessageIds: update.patch?.hiddenMessageIds ?? current.hiddenMessageIds,
                pins: update.patch?.pins ?? current.pins
            });

        const newRev = (channel.adminRev || 0) + 1;
        const adminMsg = {
            type: 'ADMIN_STATE',
            v: 1,
            rev: newRev,
            ts: Date.now(),
            createdBy: senderAddress,
            state: next
        };

        await streamrController.publishAdminState(adminStreamId, adminMsg, channel.password || null);

        // Optimistically apply locally so UI reflects the change immediately.
        this.manager.applyAdminState(channel, adminMsg);
        this.manager.notifyHandlers('admin_state_updated', {
            streamId: messageStreamId,
            adminState: channel.adminState,
            rev: channel.adminRev
        });

        // Reset the poller window so we don't redundantly re-fetch our own
        // freshly-applied state on the very next interval tick.
        if (adminStatePoller.getStreamId() === messageStreamId) {
            adminStatePoller.markFresh();
        }

        // Fire-and-forget invalidation signal on the ephemeral -2/P0 control
        // partition so other clients with the channel active update immediately
        // (instead of waiting for the next 30s poller tick). The signal embeds
        // the full ADMIN_STATE snapshot so receivers can apply it inline
        // without a -3/P0 resend round-trip. The canonical resend path on
        // -3/P0 (bootstrap-on-open + periodic poll + on-demand fallback)
        // remains as a convergence safety net for clients that miss the
        // ephemeral signal. Best-effort: failure here is non-fatal.
        try {
            const ephemeralStreamId = channel.ephemeralStreamId || deriveEphemeralId(messageStreamId);
            if (ephemeralStreamId) {
                const signal = {
                    type: 'admin_invalidate',
                    rev: newRev,
                    ts: adminMsg.ts,
                    snapshot: adminMsg
                };
                streamrController.publishControl(
                    ephemeralStreamId,
                    signal,
                    channel.password || null
                ).catch(e => Logger.debug('admin_invalidate publish failed (non-fatal):', e.message));
            }
        } catch (e) {
            Logger.debug('admin_invalidate prepare failed (non-fatal):', e.message);
        }

        Logger.info('Published ADMIN_STATE rev', newRev, 'for', messageStreamId.slice(-20));
        return { rev: newRev, state: next };
    }

    // High-level convenience helpers built on top of publishAdminState ----------

    /** @returns {Promise<{rev:number, state:Object}>} */
    async banMember(messageStreamId, address) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        const lower = String(address).toLowerCase();
        const set = new Set((channel.adminState?.bannedMembers || []).map(a => a.toLowerCase()));
        set.add(lower);
        return this.manager.publishAdminState(messageStreamId, { patch: { bannedMembers: Array.from(set) } });
    }

    /** @returns {Promise<{rev:number, state:Object}>} */
    async unbanMember(messageStreamId, address) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        const lower = String(address).toLowerCase();
        const next = (channel.adminState?.bannedMembers || []).filter(a => a.toLowerCase() !== lower);
        return this.manager.publishAdminState(messageStreamId, { patch: { bannedMembers: next } });
    }

    /** @returns {Promise<{rev:number, state:Object}>} */
    async hideMessage(messageStreamId, targetId) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        const set = new Set(channel.adminState?.hiddenMessageIds || []);
        set.add(targetId);
        return this.manager.publishAdminState(messageStreamId, { patch: { hiddenMessageIds: Array.from(set) } });
    }

    /** @returns {Promise<{rev:number, state:Object}>} */
    async pinMessage(messageStreamId, targetId, snapshot = null) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        const existing = (channel.adminState?.pins || []).filter(p => p.targetId !== targetId);
        const msg = !snapshot ? channel.messages.find(m => m.id === targetId) : null;
        const pin = {
            targetId,
            pinnedAt: Date.now(),
            snapshot: snapshot || (msg ? {
                sender: msg.sender,
                senderName: msg.senderName || null,
                ensName: msg.verified?.ensName || null,
                text: msg.text,
                timestamp: msg.timestamp
            } : null)
        };
        return this.manager.publishAdminState(messageStreamId, { patch: { pins: [...existing, pin] } });
    }

    /** @returns {Promise<{rev:number, state:Object}>} */
    async unpinMessage(messageStreamId, targetId) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        const next = (channel.adminState?.pins || []).filter(p => p.targetId !== targetId);
        return this.manager.publishAdminState(messageStreamId, { patch: { pins: next } });
    }
}
