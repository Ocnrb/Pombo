/**
 * Epoch Key Manager — protocol state machine for the keys stream (-4).
 *
 * Owns, per native channel: the adopted epoch keys (kid → key), the announces
 * seen so far, and the in-flight KEY_REQUEST. The crypto lives in
 * epochKeyCrypto; the transport (publish as account, resend) in streamr.js.
 *
 * Protocol (UNIFIED_IMPLEMENTATION_PLAN.md §5.4, §7.9, D12–D14):
 *
 *   KEY_ANNOUNCE  { t, epoch, keyId, keyHash, validFrom }
 *     Only the admin set may announce. v1 admin set = the stream's namespace
 *     address — the ONE address that could have created the stream, which is
 *     the only admin claim that cannot be spoofed by an invite payload.
 *     Conflict rule (D13): higher epoch wins; same epoch → older transport
 *     timestamp wins; tie → lower publisher address.
 *
 *   KEY_REQUEST   { t, requestId, pubkey, fromEpoch }
 *     `pubkey` is a fresh per-request keypair (D12) held in memory only —
 *     never persisted, never reused. Answered live AND from storage (N-B):
 *     a member coming online later scans recent stored requests that no wrap
 *     covers yet and answers them — the requester holds the pair while
 *     waiting, so timing no longer has to coincide.
 *
 *   KEY_WRAP      { t, requestId, keyId, epoch, tag, epk, iv, ct }
 *     Any member holding the key may answer (k-of-n), but politely (N-B
 *     anti-stampede, §7.10): rank = hash(identity ‖ requestId) mod N orders
 *     the members without coordination; each waits rank × 2s and stays
 *     silent for epochs some observed wrap already covers. Addressed by
 *     tag = sha256(requestPubkey ‖ keyId) — O(1) match, no membership signal.
 *     The unwrapped key is adopted ONLY if sha256(key) equals the keyHash of
 *     the matching announce: a malicious wrapper can waste bandwidth, never
 *     poison a key.
 *
 * Epoch keys are channel keys, not identities: they persist in secureStorage
 * (encrypted at rest, out of the service worker's reach) so a session restart
 * does not cost a request round-trip. History policy is D14: all retained
 * epochs are handed out (holding access IS the condition) — except PAID
 * gates, which hand out only the current epoch: a subscription buys the
 * future, never the channel's past.
 */

import { Logger } from './logger.js';
import { secureStorage } from './secureStorage.js';
import { epochKeyCrypto } from './epochKeyCrypto.js';
import { streamrController } from './streamr.js';
import { cryptoManager } from './crypto.js';
import { authManager } from './auth.js';
import { CONFIG } from './config.js';
import { KEYS_MSG_TYPE } from './streamConstants.js';
import { gateManager, GATE_MODE } from './gate.js';

/**
 * Channels running the epoch-key protocol: native (N-A) and gated (N-C).
 * Gated channels differ only in transport (the gate clone publishes for
 * everyone, ERC-1271) and in the KEY_REQUEST gate check — the state machine
 * is identical.
 */
export const usesEpochKeys = (channel) =>
    (channel?.type === 'native' || !!channel?.gate?.address) && !!channel?.keysStreamId;

// Re-request backoff: a pending request younger than this is not superseded.
const REQUEST_MIN_INTERVAL_MS = 60 * 1000;

// A KEY_REQUEST from a cold node can miss every live subscriber (§7.2 R2:
// join registers interest, broadcast can still shout into an empty room).
// Waiting the full minute to retry turns that loss into a 60s blank channel
// — measured on Android. Retry fast while the topology warms, then back off.
const REQUEST_RETRY_FAST_MS = 10 * 1000;
const REQUEST_FAST_ATTEMPTS = 4;

// How much -4 history to scan for announces on channel open. Native rotations
// are event-driven (ban/leave); gated channels add the weekly cadence (N-D) —
// ~52 announces/year plus wraps, still inside this window for the storage
// retention that actually bounds what a resend returns.
const KEYS_HISTORY_COUNT = 1000;

// N-B anti-stampede (§7.10): rank × this = how long an answerer waits before
// checking whether someone with a lower rank already covered the request.
const RANK_STEP_MS = 2000;
// Rank domain cap: with member counts beyond this the tail ranks add latency
// without adding meaningful redundancy.
const RANK_MAX = 8;

// N-B stored-request answering: only requests this recent are answered from
// storage — the requester holds the ephemeral pair in memory, so a wrap for a
// long-gone request is dead bytes. Generous enough to cover "opened the
// channel, waited, admin arrived minutes later".
const REQUEST_ANSWER_WINDOW_MS = 10 * 60 * 1000;

// Observed-wrap suppression memory (requestId → Set(keyId)), bounded.
const SEEN_WRAPS_MAX = 100;

// N-D (§7.12): gated channels rotate on a cadence — selling the asset or a
// lapsed subscription only cuts reads at the NEXT rotation, so without a
// schedule the cut never lands. Weekly for every gate mode; native channels
// stay event-driven only.
const ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Failed or not-yet-due scheduled rotations re-check on this fallback.
const ROTATION_RETRY_MS = 60 * 60 * 1000;

class EpochKeyManager {
    constructor() {
        // messageStreamId → channel key state
        this.state = new Map();
        // messageStreamId → Set<callback(kid)> fired when a key is adopted
        this.listeners = new Map();
    }

    // ==================== STATE ====================

    _getState(messageStreamId) {
        let s = this.state.get(messageStreamId);
        if (!s) {
            s = {
                // keyId → { keyHex, keyHash, epoch, cryptoKey: Promise<CryptoKey>|null }
                epochs: new Map(),
                // epoch → { keyId, keyHash, validFrom, publisher, timestamp }
                announces: new Map(),
                // epoch → NEWEST valid announce timestamp seen. The conflict
                // rule (D13) deliberately keeps the OLDEST announce, so the
                // TTL re-announce check cannot read s.announces — it would
                // republish on every open. This map tracks freshness instead.
                announceFreshness: new Map(),
                currentEpoch: 0,
                // { requestId, privateKey, publicKey, fromEpoch, sentAt } — memory only (D12)
                pendingRequest: null,
                // Consecutive unanswered requests — drives the retry backoff
                requestAttempts: 0,
                // requestId → Set(keyId) of wraps OBSERVED (live or history) —
                // the N-B suppression signal: stay silent for covered epochs
                seenWraps: new Map(),
                // Addresses seen authoring a KEY_REQUEST (live or -4 history).
                // Every reader of a gated channel must request keys, so this
                // enumerates members for TOKEN/NFT/PAID gates where join()/
                // pay() bypasses the owner — the N-D no-indexer decision.
                seenRequesters: new Set(),
                loaded: false
            };
            this.state.set(messageStreamId, s);
        }
        return s;
    }

    _loadPersisted(messageStreamId, s) {
        const persisted = secureStorage.getEpochKeys(messageStreamId);
        if (!persisted) return;
        for (const [keyId, entry] of Object.entries(persisted.epochs || {})) {
            if (!s.epochs.has(keyId)) {
                s.epochs.set(keyId, { ...entry, cryptoKey: null });
            }
        }
        // Announces persist too (public data): with them AND the keys a
        // restarted session encrypts/decrypts IMMEDIATELY — the -4 resend
        // becomes a background reconcile instead of the open's critical path.
        for (const [epochStr, ann] of Object.entries(persisted.announces || {})) {
            const epoch = parseInt(epochStr, 10);
            if (Number.isInteger(epoch) && !s.announces.has(epoch)) {
                s.announces.set(epoch, ann);
            }
        }
        if (typeof persisted.currentEpoch === 'number' && persisted.currentEpoch > s.currentEpoch) {
            s.currentEpoch = persisted.currentEpoch;
        }
        const maxAnnounced = Math.max(0, ...s.announces.keys());
        if (maxAnnounced > s.currentEpoch) s.currentEpoch = maxAnnounced;
    }

    async _persist(messageStreamId, s) {
        const epochs = {};
        for (const [keyId, entry] of s.epochs) {
            epochs[keyId] = { keyHex: entry.keyHex, keyHash: entry.keyHash, epoch: entry.epoch };
        }
        const announces = {};
        for (const [epoch, ann] of s.announces) {
            announces[epoch] = {
                keyId: ann.keyId, keyHash: ann.keyHash,
                publisher: ann.publisher, timestamp: ann.timestamp, validFrom: ann.validFrom
            };
        }
        await secureStorage.setEpochKeys(messageStreamId, { epochs, announces, currentEpoch: s.currentEpoch });
    }

    /**
     * Load persisted state without any network work — the fast path a channel
     * open uses to decide whether the blocking ensure is needed at all.
     */
    loadPersistedState(messageStreamId) {
        const s = this._getState(messageStreamId);
        if (!s.loaded) {
            this._loadPersisted(messageStreamId, s);
            s.loaded = true;
        }
    }

    /** Does the channel hold a usable current key right now? */
    hasCurrentKey(messageStreamId) {
        const s = this.state.get(messageStreamId);
        if (!s || s.currentEpoch === 0) return false;
        const announce = s.announces.get(s.currentEpoch);
        return !!(announce && s.epochs.has(announce.keyId));
    }

    /**
     * Register a callback fired whenever a key is adopted for a channel —
     * the hook the receive path uses to retro-decrypt "waiting for key"
     * messages (Passo 5).
     */
    onKeyAdopted(messageStreamId, callback) {
        if (!this.listeners.has(messageStreamId)) {
            this.listeners.set(messageStreamId, new Set());
        }
        this.listeners.get(messageStreamId).add(callback);
    }

    _notifyAdopted(messageStreamId, keyId) {
        const subs = this.listeners.get(messageStreamId);
        if (!subs) return;
        for (const cb of subs) {
            try { cb(keyId); } catch (e) { Logger.warn('epoch key listener error:', e.message); }
        }
    }

    /**
     * Drop a channel's runtime and persisted key state (on leave/delete).
     */
    async forgetChannel(messageStreamId) {
        const s = this.state.get(messageStreamId);
        if (s?.rotationTimer) clearTimeout(s.rotationTimer);
        this.state.delete(messageStreamId);
        this.listeners.delete(messageStreamId);
        await secureStorage.clearEpochKeys(messageStreamId);
    }

    /** Clear runtime state (logout). Persisted keys stay encrypted at rest. */
    clear() {
        for (const s of this.state.values()) {
            if (s.rotationTimer) clearTimeout(s.rotationTimer);
        }
        this.state.clear();
        this.listeners.clear();
    }

    // ==================== ADMIN SET (D13) ====================

    /**
     * v1 admin set: the stream's namespace address, and nothing else.
     * `createdBy` can be empty AND arrives via invite payloads, which an
     * inviter controls — the namespace is the only claim bound on-chain
     * (nobody else can create streams under that address).
     * Multi-admin later = widening this set; the message format is untouched.
     */
    _adminSet(channel) {
        const ns = (channel.messageStreamId?.split('/')[0] || '').toLowerCase();
        return ns.length === 42 ? new Set([ns]) : new Set();
    }

    _isAdmin(channel, address) {
        return !!address && this._adminSet(channel).has(address.toLowerCase());
    }

    /** Is the current account this channel's admin? */
    isOwnAdmin(channel) {
        return this._isAdmin(channel, authManager.getAddress());
    }

    // ==================== LIFECYCLE ====================

    /**
     * Bring a native channel's key state up to date. Called on channel
     * open/subscribe. Pulls announces from -4 storage, bootstraps epoch 1 if
     * we are the admin of a virgin channel, or requests missing keys.
     * @param {Object} channel - Channel object (messageStreamId, keysStreamId, type)
     */
    async ensureChannelKeys(channel) {
        if (!usesEpochKeys(channel)) return;
        const s = this._getState(channel.messageStreamId);
        s.gated = !!channel.gate?.address;   // arms the kid-freshness rule

        if (!s.loaded) {
            this._loadPersisted(channel.messageStreamId, s);
            s.loaded = true;
        }

        // Reconcile with -4 storage (announces are public; the storage node is
        // their system of record — persisted copies are a warm-start cache).
        const entries = await streamrController.resendKeysMessages(
            channel.keysStreamId, { last: KEYS_HISTORY_COUNT });
        let changed = false;
        const storedRequests = [];
        for (const { data, publisherId, timestamp } of entries) {
            if (data.t === KEYS_MSG_TYPE.KEY_ANNOUNCE) {
                if (this._applyAnnounce(channel, s, data, publisherId, timestamp)) changed = true;
            } else if (data.t === KEYS_MSG_TYPE.KEY_WRAP) {
                // Coverage bookkeeping: a stored wrap means someone already
                // answered — its epochs need no re-answering from us
                if (typeof data.requestId === 'string' && typeof data.keyId === 'string') {
                    this._recordSeenWrap(s, data.requestId, data.keyId);
                }
            } else if (data.t === KEYS_MSG_TYPE.KEY_REQUEST) {
                storedRequests.push({ data, publisherId, timestamp });
                this._recordRequester(s, publisherId);
            }
        }
        if (changed) await this._persist(channel.messageStreamId, s);

        // N-B: answer RECENT stored requests that no wrap covers yet — a
        // member arriving later serves whoever is still waiting, so requester
        // and key-holder no longer have to coincide in time. Older requests
        // are dead: the requester's ephemeral pair lives in memory only.
        if (s.epochs.size > 0) {
            const me = (authManager.getAddress() || '').toLowerCase();
            const now = Date.now();
            for (const { data, publisherId, timestamp } of storedRequests) {
                if ((publisherId || '').toLowerCase() === me) continue;
                if (now - (timestamp || 0) > REQUEST_ANSWER_WINDOW_MS) continue;
                if (typeof data.pubkey !== 'string' || typeof data.requestId !== 'string') continue;
                const rank = await this._rankFor(data.requestId, (channel.members || []).length);
                this._scheduleAnswer(channel, {
                    requestId: data.requestId, pubkey: data.pubkey, fromEpoch: data.fromEpoch,
                    requester: publisherId
                }, rank * RANK_STEP_MS);
            }
        }

        if (s.announces.size === 0) {
            if (this.isOwnAdmin(channel)) {
                await this._bootstrapFirstEpoch(channel, s);
                this._armScheduledRotation(channel, s);
            } else {
                Logger.info('epochKeys: no announce yet on', channel.keysStreamId.slice(-30),
                    '— waiting for the admin');
            }
            return;
        }

        if (this.isOwnAdmin(channel)) {
            await this._maybeReannounceAging(channel, s);
            this._armScheduledRotation(channel, s);
        }

        if (this._missingEpochs(s).length > 0) {
            await this._sendKeyRequest(channel, s);
        }
    }

    /**
     * TTL-aware re-announce (same pattern as the -3 artifacts' ttlRepublish):
     * the CURRENT epoch's announce ages out of storage retention if no
     * rotation happens for that long, and a joiner then has no keyHash anchor
     * even with every member online. Republish the SAME keyId/keyHash when
     * the freshest retained copy nears the TTL — idempotent by construction.
     */
    async _maybeReannounceAging(channel, s) {
        const announce = s.announces.get(s.currentEpoch);
        if (!announce) return;
        const entry = s.epochs.get(announce.keyId);
        if (!entry) return;                                  // no key held — nothing to anchor
        // freshest == 0: the announce exists only in OUR persisted state — the
        // storage lost it (or the resend failed; republishing then is a
        // harmless duplicate). Otherwise republish when nearing the TTL.
        const freshest = s.announceFreshness.get(s.currentEpoch) || 0;
        const retentionMs = (channel.storageDays || CONFIG.storage.defaultRetentionDays) * 86_400_000;
        if (freshest && Date.now() - freshest < retentionMs * CONFIG.storage.ttlRepublishAgeFraction) return;

        // CONSISTENT BY CONSTRUCTION across the admin's devices: this only
        // ever republishes the PERSISTED keyId/keyHash — two devices doing it
        // concurrently emit identical content. Minting happens nowhere here.
        await streamrController.publishKeysMessage(channel.keysStreamId, {
            t: KEYS_MSG_TYPE.KEY_ANNOUNCE,
            epoch: s.currentEpoch,
            keyId: announce.keyId,
            keyHash: entry.keyHash,
            validFrom: Date.now()
        });
        s.announceFreshness.set(s.currentEpoch, Date.now());
        Logger.info(`epochKeys: re-announced epoch ${s.currentEpoch} (announce ${freshest ? 'nearing storage TTL' : 'missing from storage'}) on`,
            channel.keysStreamId.slice(-30));
    }

    /**
     * Arm the weekly rotation timer (N-D, gated channels, admin-side). The
     * timer checks the CURRENT epoch's age on fire — a manual rotation (ban)
     * in between simply makes the check a no-op and the timer re-arm. If the
     * admin is offline past the due time, the epoch lives longer and the next
     * channel open rotates.
     */
    _armScheduledRotation(channel, s) {
        if (!channel.gate?.address || s.rotationTimer) return;
        const announce = s.announces.get(s.currentEpoch);
        if (!announce?.validFrom) return;
        const dueIn = Math.max(announce.validFrom + ROTATION_INTERVAL_MS - Date.now(), 0) + 1000;
        s.rotationTimer = setTimeout(async () => {
            s.rotationTimer = null;
            if (!this.state.has(channel.messageStreamId)) return;    // left/deleted
            try {
                const current = s.announces.get(s.currentEpoch);
                if (current?.validFrom
                        && Date.now() - current.validFrom >= ROTATION_INTERVAL_MS
                        && this.isOwnAdmin(channel)) {
                    await this.rotateEpoch(channel);
                }
                this._armScheduledRotation(channel, s);
            } catch (e) {
                Logger.warn('epochKeys: scheduled rotation failed (retrying later):', e.message);
                s.rotationTimer = setTimeout(() => {
                    s.rotationTimer = null;
                    this._armScheduledRotation(channel, s);
                }, ROTATION_RETRY_MS);
            }
        }, Math.min(dueIn, ROTATION_INTERVAL_MS));
    }

    /** Epoch numbers announced but not adopted. */
    _missingEpochs(s) {
        const adoptedEpochs = new Set([...s.epochs.values()].map(e => e.epoch));
        return [...s.announces.keys()].filter(epoch => !adoptedEpochs.has(epoch));
    }

    /**
     * Admin sees no announce in storage. Two cases:
     *
     *  - We hold persisted epoch keys → the announce was LOST (storage not yet
     *    attached at create time, or aged past retention). RE-ANNOUNCE the
     *    highest epoch we hold, same keyId/keyHash — idempotent self-heal, so
     *    existing ciphertext stays readable by everyone.
     *  - Virgin channel → create and announce epoch 1.
     */
    async _bootstrapFirstEpoch(channel, s) {
        if (s.epochs.size > 0) {
            let keyId = null, entry = null;
            for (const [id, e] of s.epochs) {
                if (!entry || e.epoch > entry.epoch) { keyId = id; entry = e; }
            }
            const announce = {
                t: KEYS_MSG_TYPE.KEY_ANNOUNCE,
                epoch: entry.epoch,
                keyId,
                keyHash: entry.keyHash,
                validFrom: Date.now()
            };
            await streamrController.publishKeysMessage(channel.keysStreamId, announce);
            this._applyAnnounce(channel, s, announce, authManager.getAddress(), announce.validFrom);
            Logger.info(`epochKeys: re-announced epoch ${entry.epoch} (announce was missing from storage) on`,
                channel.keysStreamId.slice(-30));
            return;
        }

        // MINT GUARD (admin on two devices): a fresh admin device — no
        // persisted keys — on an ESTABLISHED channel must never mint a new
        // epoch 1: it would fork the channel. And it cannot recover from
        // member wraps either — without an announce there is no keyHash to
        // verify them against, and an admin re-announcing an unverified key
        // would launder it into the trust anchor. Virginity signal is
        // CREATION RECENCY: createdAt travels with the channel via sync, so
        // a second device inherits the original (old) date and refuses.
        const ageMs = Date.now() - (channel.createdAt || 0);
        if (!channel.createdAt || ageMs > 3_600_000) {
            Logger.warn('epochKeys: admin device holds NO epoch keys on an established channel',
                channel.messageStreamId.slice(-30),
                '— NOT minting (would fork the channel). Recover the keys on the original device.');
            return;
        }

        const keyHex = epochKeyCrypto.generateEpochKey();
        const keyHash = await epochKeyCrypto.computeKeyHash(keyHex);
        const keyId = `1.${cryptoManager.generateRandomHex(6)}`;
        const announce = {
            t: KEYS_MSG_TYPE.KEY_ANNOUNCE,
            epoch: 1,
            keyId,
            keyHash,
            validFrom: Date.now()
        };
        await streamrController.publishKeysMessage(channel.keysStreamId, announce);
        this._applyAnnounce(channel, s, announce, authManager.getAddress(), announce.validFrom);
        await this._adopt(channel, s, { keyId, keyHex, keyHash, epoch: 1 });
        Logger.info('epochKeys: bootstrapped epoch 1 on', channel.keysStreamId.slice(-30));
    }

    /**
     * Admin action: rotate to a new epoch (e.g. after removing a member).
     * The new key applies to writes from now on; old epochs stay readable
     * for members (D14) and unreadable epochs stay ciphertext for ex-members.
     */
    async rotateEpoch(channel) {
        if (!usesEpochKeys(channel)) {
            throw new Error('rotateEpoch: channel has no epoch-key protocol');
        }
        if (!this.isOwnAdmin(channel)) {
            throw new Error('rotateEpoch: only the channel admin can announce a new epoch');
        }
        const s = this._getState(channel.messageStreamId);
        const epoch = Math.max(s.currentEpoch, ...[...s.announces.keys(), 0]) + 1;

        const keyHex = epochKeyCrypto.generateEpochKey();
        const keyHash = await epochKeyCrypto.computeKeyHash(keyHex);
        const keyId = `${epoch}.${cryptoManager.generateRandomHex(6)}`;
        const announce = {
            t: KEYS_MSG_TYPE.KEY_ANNOUNCE,
            epoch,
            keyId,
            keyHash,
            validFrom: Date.now()
        };
        await streamrController.publishKeysMessage(channel.keysStreamId, announce);
        this._applyAnnounce(channel, s, announce, authManager.getAddress(), announce.validFrom);
        await this._adopt(channel, s, { keyId, keyHex, keyHash, epoch });
        Logger.info(`epochKeys: rotated to epoch ${epoch} on`, channel.keysStreamId.slice(-30));
        return epoch;
    }

    // ==================== PROTOCOL HANDLERS ====================

    /**
     * Ingest for -4 messages (live subscription).
     * @param {Object} channel
     * @param {Object} data - Parsed protocol message
     * @param {string} publisherId - Authenticated author: the transport
     *   publisher on native (-4 publishes as account by design), the recovered
     *   envelope signer on gated (the clone publishes for everyone; streamr.js
     *   resolveAuthor swaps it in before this handler runs)
     * @param {number} timestamp - Transport timestamp
     */
    async handleKeysMessage(channel, data, publisherId, timestamp) {
        if (!data || typeof data.t !== 'string') return;
        const s = this._getState(channel.messageStreamId);
        s.gated = !!channel.gate?.address;   // arms the kid-freshness rule

        switch (data.t) {
            case KEYS_MSG_TYPE.KEY_ANNOUNCE:
                await this._handleAnnounce(channel, s, data, publisherId, timestamp);
                break;
            case KEYS_MSG_TYPE.KEY_REQUEST:
                await this._handleRequest(channel, s, data, publisherId);
                break;
            case KEYS_MSG_TYPE.KEY_WRAP:
                await this._handleWrap(channel, s, data);
                break;
            default:
                Logger.debug('epochKeys: unknown message type', data.t);
        }
    }

    async _handleAnnounce(channel, s, data, publisherId, timestamp) {
        const changed = this._applyAnnounce(channel, s, data, publisherId, timestamp);
        if (!changed) return;
        // Pull model: a live announce for an epoch we lack triggers a request
        // (unless we just announced it ourselves and already hold the key).
        if (this._missingEpochs(s).length > 0) {
            await this._sendKeyRequest(channel, s);
        }
    }

    /**
     * Validate and apply an announce. Returns true if state changed.
     * D13 conflict rule lives here.
     */
    _applyAnnounce(channel, s, data, publisherId, timestamp) {
        if (!this._isAdmin(channel, publisherId)) {
            Logger.warn('epochKeys: KEY_ANNOUNCE from non-admin REJECTED:',
                publisherId, 'on', channel.messageStreamId.slice(-30));
            return false;
        }
        const epoch = data.epoch;
        if (!Number.isInteger(epoch) || epoch < 1) return false;
        if (typeof data.keyId !== 'string' || typeof data.keyHash !== 'string') return false;

        // Freshness bookkeeping for the TTL re-announce — tracks the NEWEST
        // valid copy even when the conflict rule below keeps an older one
        if ((timestamp || 0) > (s.announceFreshness.get(epoch) || 0)) {
            s.announceFreshness.set(epoch, timestamp || 0);
        }

        const incoming = {
            keyId: data.keyId,
            keyHash: data.keyHash.toLowerCase(),
            validFrom: data.validFrom ?? timestamp,
            publisher: (publisherId || '').toLowerCase(),
            timestamp: timestamp ?? 0
        };

        const existing = s.announces.get(epoch);
        if (existing) {
            // Same epoch: older timestamp wins; tie → lower publisher address
            const keep =
                existing.timestamp < incoming.timestamp
                || (existing.timestamp === incoming.timestamp
                    && existing.publisher <= incoming.publisher);
            if (keep) return false;
        }
        s.announces.set(epoch, incoming);
        if (epoch > s.currentEpoch) {
            s.currentEpoch = epoch;
        }
        return true;
    }

    /**
     * A live KEY_REQUEST: schedule an answer behind the anti-stampede rank
     * (§7.10). Native: only the SDK-validated permission got this message to
     * us — anyone we hear on -4 passed the channel's access control. Gated:
     * the clone's permission is everyone's, so the CURRENT gate is checked
     * against the requester (envelope signer) just before wrapping.
     */
    async _handleRequest(channel, s, data, publisherId) {
        this._recordRequester(s, publisherId);
        const myAddress = (authManager.getAddress() || '').toLowerCase();
        if ((publisherId || '').toLowerCase() === myAddress) return;      // our own request
        if (typeof data.pubkey !== 'string' || typeof data.requestId !== 'string') return;
        if (s.epochs.size === 0) return;                                  // nothing to offer

        const rank = await this._rankFor(data.requestId, (channel.members || []).length);
        this._scheduleAnswer(channel, {
            requestId: data.requestId, pubkey: data.pubkey, fromEpoch: data.fromEpoch,
            requester: publisherId
        }, rank * RANK_STEP_MS);
    }

    /**
     * Anti-stampede rank (§7.10): hash(identity ‖ requestId) mod N orders the
     * members deterministically WITHOUT coordination — everyone computes their
     * own place in the queue from public data. Rank 0 answers immediately;
     * each higher rank waits one step and stays silent for covered epochs.
     */
    async _rankFor(requestId, memberCount) {
        const n = Math.max(1, Math.min(RANK_MAX, memberCount || 4));
        const me = (authManager.getAddress() || '').toLowerCase();
        const digest = new Uint8Array(await crypto.subtle.digest(
            'SHA-256', new TextEncoder().encode(`${me}|${requestId}`)));
        return digest[0] % n;
    }

    /** Fire-and-forget: NEVER delay inline — the -4 subscription callback must
     *  keep flowing, or the wraps whose arrival should silence us would queue
     *  up BEHIND our own wait. */
    _scheduleAnswer(channel, request, delayMs) {
        setTimeout(() => {
            this._answerRequest(channel, request).catch(e =>
                Logger.warn('epochKeys: scheduled answer failed:', e.message));
        }, delayMs);
    }

    /**
     * Answer with wraps for every epoch we hold that the requester asked for
     * (D14: all retained epochs; PAID gates only the current one) MINUS the
     * epochs an observed wrap already covers — the N-B suppression that turns
     * thirty identical envelopes into one.
     */
    async _answerRequest(channel, request) {
        const s = this.state.get(channel.messageStreamId);
        if (!s || s.epochs.size === 0) return;

        // Gated (N-C): the write-cut for ex-members lives HERE. The requester
        // authenticated as an author (sticky isValidSignature), but the epoch
        // key only goes to whoever passes the CURRENT gate — one cached
        // eth_call. Fail-closed inside checkAccess: RPC trouble means no wrap
        // from us; the requester's retry finds a healthier responder.
        if (channel.gate?.address) {
            if (!request.requester) return;
            const ok = await gateManager.checkAccess(channel.gate.address, request.requester);
            if (!ok) {
                Logger.info('epochKeys: KEY_REQUEST from', request.requester,
                    'refused by gate', channel.gate.address.slice(0, 10));
                return;
            }
        }

        // D14: a PAID gate hands out ONLY the current epoch — the history
        // scope of a subscription is the future. Fail-closed on an unreadable
        // gate config: missing old epochs get re-requested and answered once
        // the RPC heals, leaked ones cannot be taken back.
        let currentEpochOnly = false;
        if (channel.gate?.address) {
            try {
                const info = await gateManager.getGateInfo(channel.gate.address);
                currentEpochOnly = info.mode === GATE_MODE.PAID;
            } catch (e) {
                Logger.warn('epochKeys: gate mode unreadable, answering current epoch only:', e.message);
                currentEpochOnly = true;
            }
        }

        const covered = s.seenWraps.get(request.requestId) || new Set();
        const fromEpoch = Number.isInteger(request.fromEpoch) ? request.fromEpoch : 1;

        let sent = 0;
        for (const [keyId, entry] of s.epochs) {
            if (entry.epoch < fromEpoch || covered.has(keyId)) continue;
            if (currentEpochOnly && entry.epoch !== s.currentEpoch) continue;
            try {
                const tag = await epochKeyCrypto.computeWrapTag(request.pubkey, keyId);
                const wrapped = await epochKeyCrypto.wrapEpochKey(entry.keyHex, request.pubkey);
                await streamrController.publishKeysMessage(channel.keysStreamId, {
                    t: KEYS_MSG_TYPE.KEY_WRAP,
                    requestId: request.requestId,
                    keyId,
                    epoch: entry.epoch,
                    tag,
                    ...wrapped
                });
                this._recordSeenWrap(s, request.requestId, keyId);
                sent += 1;
            } catch (e) {
                Logger.warn(`epochKeys: failed to wrap ${keyId} for request ${request.requestId}:`, e.message);
            }
        }
        if (sent > 0) {
            Logger.debug(`epochKeys: answered request ${request.requestId} with ${sent} wrap(s)`);
        }
    }

    _recordRequester(s, publisherId) {
        const addr = (publisherId || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(addr)) return;
        if (s.seenRequesters.size >= 500 && !s.seenRequesters.has(addr)) return;
        s.seenRequesters.add(addr);
    }

    /**
     * Member candidates observed on -4 (KEY_REQUEST authors) — the candidate
     * source for enumerating TOKEN/NFT/PAID gate members without an indexer.
     * Misses whoever paid/joined but never opened the channel.
     */
    getSeenRequesters(messageStreamId) {
        const s = this.state.get(messageStreamId);
        return s ? Array.from(s.seenRequesters) : [];
    }

    _recordSeenWrap(s, requestId, keyId) {
        let set = s.seenWraps.get(requestId);
        if (!set) {
            if (s.seenWraps.size >= SEEN_WRAPS_MAX) {
                const oldest = s.seenWraps.keys().next().value;
                s.seenWraps.delete(oldest);
            }
            set = new Set();
            s.seenWraps.set(requestId, set);
        }
        set.add(keyId);
    }

    /**
     * A wrap addressed to our pending request: O(1) tag check, unwrap, verify
     * against the announced keyHash, adopt. Verification failure is a warn and
     * a drop — never adoption.
     */
    async _handleWrap(channel, s, data) {
        // Suppression bookkeeping FIRST, for every well-formed wrap — this is
        // what lets higher-rank answerers stay silent (N-B)
        if (typeof data.requestId === 'string' && typeof data.keyId === 'string') {
            this._recordSeenWrap(s, data.requestId, data.keyId);
        }
        const pending = s.pendingRequest;
        if (!pending) return;
        if (data.requestId !== pending.requestId) return;
        if (typeof data.keyId !== 'string' || typeof data.tag !== 'string') return;
        if (s.epochs.has(data.keyId)) return;                             // already adopted

        const expectedTag = await epochKeyCrypto.computeWrapTag(pending.publicKey, data.keyId);
        if (data.tag.toLowerCase() !== expectedTag.toLowerCase()) return; // not addressed to us

        const announce = s.announces.get(data.epoch);
        if (!announce || announce.keyId !== data.keyId) {
            Logger.warn('epochKeys: wrap for unannounced key ignored:', data.keyId);
            return;
        }

        let keyHex;
        try {
            keyHex = await epochKeyCrypto.unwrapEpochKey(
                { epk: data.epk, iv: data.iv, ct: data.ct }, pending.privateKey);
        } catch (e) {
            Logger.warn('epochKeys: wrap failed to open:', e.message);
            return;
        }

        const keyHash = await epochKeyCrypto.computeKeyHash(keyHex);
        if (keyHash.toLowerCase() !== announce.keyHash) {
            Logger.warn('epochKeys: wrap REJECTED — keyHash mismatch for', data.keyId,
                '(malicious or corrupted wrap)');
            return;
        }

        await this._adopt(channel, s, {
            keyId: data.keyId, keyHex, keyHash: announce.keyHash, epoch: data.epoch
        });
        Logger.info(`epochKeys: adopted epoch ${data.epoch} (${data.keyId}) on`,
            channel.messageStreamId.slice(-30));
    }

    /**
     * Publish a KEY_REQUEST with a fresh request keypair (D12). The keypair
     * lives on the pending request, in memory, until superseded.
     */
    async _sendKeyRequest(channel, s) {
        const interval = s.requestAttempts < REQUEST_FAST_ATTEMPTS
            ? REQUEST_RETRY_FAST_MS : REQUEST_MIN_INTERVAL_MS;
        if (s.pendingRequest && (Date.now() - s.pendingRequest.sentAt) < interval) {
            return;
        }
        const missing = this._missingEpochs(s);
        if (missing.length === 0) return;

        const { privateKey, publicKey } = epochKeyCrypto.generateRequestKeypair();
        const requestId = cryptoManager.generateRandomHex(16);
        const fromEpoch = Math.min(...missing);

        s.requestAttempts += 1;
        s.pendingRequest = { requestId, privateKey, publicKey, fromEpoch, sentAt: Date.now() };

        await streamrController.publishKeysMessage(channel.keysStreamId, {
            t: KEYS_MSG_TYPE.KEY_REQUEST,
            requestId,
            pubkey: publicKey,
            fromEpoch
        });
        Logger.info(`epochKeys: requested epochs ≥${fromEpoch} on`, channel.keysStreamId.slice(-30));
    }

    async _adopt(channel, s, { keyId, keyHex, keyHash, epoch }) {
        s.epochs.set(keyId, { keyHex, keyHash, epoch, cryptoKey: null });
        if (epoch > s.currentEpoch) {
            s.currentEpoch = epoch;
        }
        s.missingKids?.delete(keyId);
        s.requestAttempts = 0;   // future rotations start on the fast retry again
        await this._persist(channel.messageStreamId, s);
        this._notifyAdopted(channel.messageStreamId, keyId);
    }

    /**
     * Requester-side retry while early requests may have been lost to a cold
     * topology (§7.2 R2): re-send, respecting the fast backoff, until the keys
     * land. Returns true while the channel is still waiting.
     */
    async retryRequestIfWaiting(channel) {
        const s = this.state.get(channel.messageStreamId);
        if (!s || this._missingEpochs(s).length === 0) return false;
        await this._sendKeyRequest(channel, s);
        return true;
    }

    /**
     * Called by the ingest when a message carries a `kid` we do not hold.
     * Not an error (§7.9) — record it for the UI and refresh key state at
     * most once per interval (announce may not have been pulled yet, or the
     * wrap is still on its way).
     */
    noteMissingKid(messageStreamId, kid) {
        const s = this._getState(messageStreamId);
        if (!s.missingKids) s.missingKids = new Set();
        s.missingKids.add(kid);

        const now = Date.now();
        if (s.lastMissingRefresh && (now - s.lastMissingRefresh) < REQUEST_MIN_INTERVAL_MS) return;
        s.lastMissingRefresh = now;

        import('./channels.js').then(({ channelManager }) => {
            const channel = channelManager.channels?.get(messageStreamId)
                ?? (channelManager.previewChannel?.messageStreamId === messageStreamId
                    ? channelManager.previewChannel : null);
            if (usesEpochKeys(channel)) {
                this.ensureChannelKeys(channel).catch(e =>
                    Logger.warn('epochKeys: refresh after missing kid failed:', e.message));
            }
        }).catch(() => { /* channels module unavailable (early boot) */ });
    }

    /**
     * UI state: is this channel waiting for keys, and how many kids are open?
     * @returns {{waiting: boolean, missingKids: number, hasCurrentKey: boolean}}
     */
    getWaitingInfo(messageStreamId) {
        const s = this.state.get(messageStreamId);
        if (!s) return { waiting: false, missingKids: 0, hasCurrentKey: false };
        const announce = s.announces.get(s.currentEpoch);
        const hasCurrentKey = !!(announce && s.epochs.has(announce.keyId));
        const missingKids = s.missingKids?.size || 0;
        return {
            waiting: (!hasCurrentKey && s.announces.size > 0) || missingKids > 0,
            missingKids,
            hasCurrentKey
        };
    }

    // ==================== KEY ACCESS (Passo 5) ====================

    /**
     * Key to encrypt with right now: the current epoch's.
     * @returns {Promise<{kid: string, cryptoKey: CryptoKey}|null>} null while waiting for a key
     */
    async getCurrentKey(messageStreamId) {
        const s = this.state.get(messageStreamId);
        if (!s || s.currentEpoch === 0) return null;
        const announce = s.announces.get(s.currentEpoch);
        if (!announce) return null;
        const entry = s.epochs.get(announce.keyId);
        if (!entry) return null;
        return { kid: announce.keyId, cryptoKey: await this._cryptoKey(entry) };
    }

    /**
     * Key for a received `kid`, or null if not (yet) held — the caller parks
     * the message as "waiting for key" and retries via onKeyAdopted.
     *
     * Returns FALSE (distinct from null) on a kid-freshness violation: the
     * key is held and would open the message, but its use is out of policy —
     * the caller drops the message without requesting anything.
     *
     * Kid freshness (N-C, gated channels only): sticky signatures mean an
     * ex-member still authors valid envelopes; what stops readable spam is
     * that old epoch keys stop being acceptable. Live traffic must use the
     * CURRENT epoch (previous epoch tolerated briefly around a rotation);
     * history must use the epoch that was in force at the message timestamp
     * (the announces' validFrom map). Native channels are exempt: removal
     * revokes the on-chain publish grant, which cuts harder than any kid rule.
     *
     * @param {string} messageStreamId
     * @param {string} kid
     * @param {Object} [context]
     * @param {boolean} [context.live] - true when the message arrived on a live subscription
     * @param {number} [context.timestamp] - transport timestamp of the message
     * @param {boolean} [context.gated] - set by the state (see ensureChannelKeys)
     */
    async getKeyForKid(messageStreamId, kid, context = {}) {
        const s = this.state.get(messageStreamId);
        const entry = s?.epochs.get(kid);
        if (!entry) return null;
        if (s.gated && !this._kidIsFresh(s, kid, entry, context)) return false;
        return this._cryptoKey(entry);
    }

    /** The kid-freshness rule. True = acceptable use of this key. */
    _kidIsFresh(s, kid, entry, { live, timestamp } = {}) {
        const currentAnnounce = s.announces.get(s.currentEpoch);
        if (!currentAnnounce) return true;               // no anchor yet — cannot judge
        if (kid === currentAnnounce.keyId) return true;  // current epoch always fine

        if (live) {
            // Previous epoch tolerated briefly after a rotation (messages in
            // flight, slow adopters). Anything older is stale-key spam.
            const tolerance = CONFIG.gate.kidFreshnessToleranceMs;
            const rotatedAt = currentAnnounce.validFrom ?? currentAnnounce.timestamp ?? 0;
            return entry.epoch === s.currentEpoch - 1
                && Date.now() - rotatedAt < tolerance;
        }

        // History: the kid must be the one in force at the message timestamp —
        // the announce with the highest validFrom that is <= ts. Without a
        // timestamp there is nothing to judge against; reject the odd kid.
        if (!Number.isFinite(timestamp)) return false;
        let epochInForce = 0;
        let bestValidFrom = -Infinity;
        for (const [epoch, announce] of s.announces) {
            const validFrom = announce.validFrom ?? announce.timestamp ?? 0;
            if (validFrom <= timestamp && validFrom > bestValidFrom) {
                bestValidFrom = validFrom;
                epochInForce = epoch;
            }
        }
        return entry.epoch === epochInForce;
    }

    hasKey(messageStreamId, kid) {
        return !!this.state.get(messageStreamId)?.epochs.has(kid);
    }

    _cryptoKey(entry) {
        if (!entry.cryptoKey) {
            entry.cryptoKey = epochKeyCrypto.importEpochKey(entry.keyHex);
        }
        return entry.cryptoKey;
    }
}

export const epochKeyManager = new EpochKeyManager();
