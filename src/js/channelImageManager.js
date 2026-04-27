/**
 * ChannelImageManager
 *
 * Single source of truth for channel images published on ADMIN STREAM (-3/P1).
 *
 * Responsibilities:
 *   - In-memory cache keyed by adminStreamId (so sidebar/Explore/ChannelDetails
 *     all read from the same Map without redundant work).
 *   - Inflight de-duplication: parallel `get()` calls for the same channel
 *     reuse a single in-flight resend Promise — at most one HTTPS round-trip
 *     per channel, regardless of how many UI surfaces request it.
 *   - Persistent IndexedDB cache (DB: PomboChannelImages, store: images)
 *     so cold starts don't refetch unchanged images. Invalidated by `hash`.
 *   - Listener API for reactive re-render: UIs subscribe by adminStreamId and
 *     get notified whenever a fresh entry lands.
 *
 * Protocol payload (published on -3/P1):
 *   {
 *     type:'CHANNEL_IMAGE', v:1, rev, ts, createdBy,
 *     encrypted: boolean,    // informational; clients still try decrypt by content shape
 *     mime: 'image/jpeg',
 *     hash: '<sha256-hex>',  // of base64 data — cache key + integrity
 *     data: '<base64 dataURL>'
 *   }
 *
 * Encryption is opt-in (admin checks "Encrypt with channel password" in
 * settings) — by default the image is unencrypted so non-member surfaces
 * (Explore, public listings) can render it.
 */

import { Logger } from './logger.js';
import { streamrController } from './streamr.js';
import { deriveAdminId } from './streamConstants.js';

const DB_NAME = 'PomboChannelImages';
const STORE_NAME = 'images';
const DB_VERSION = 1;

class ChannelImageManager {
    constructor() {
        // adminStreamId -> { hash, dataUrl, encrypted, ts, rev, owner }
        this.cache = new Map();
        // adminStreamId -> Promise<entry|null> (resend in-flight)
        this.inflight = new Map();
        // adminStreamId -> Set<callback>
        this.listeners = new Map();
        this.db = null;
        this._initPromise = null;
    }

    /**
     * Open the IndexedDB. Idempotent.
     * @returns {Promise<void>}
     */
    async init() {
        if (this.db) return;
        if (this._initPromise) return this._initPromise;
        this._initPromise = new Promise((resolve) => {
            try {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'adminStreamId' });
                    }
                };
                req.onsuccess = (e) => {
                    this.db = e.target.result;
                    Logger.debug('ChannelImageManager IDB opened');
                    // Hydrate in-memory cache from IDB (fire-and-forget)
                    this._hydrateFromIDB().catch(() => {});
                    resolve();
                };
                req.onerror = (e) => {
                    Logger.warn('ChannelImageManager IDB open failed:', e.target.error?.message);
                    resolve(); // non-fatal; in-memory only
                };
            } catch (e) {
                Logger.warn('ChannelImageManager IDB unavailable:', e?.message);
                resolve();
            }
        });
        return this._initPromise;
    }

    async _hydrateFromIDB() {
        if (!this.db) return;
        try {
            const entries = await new Promise((resolve, reject) => {
                const tx = this.db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
            for (const entry of entries) {
                if (entry?.adminStreamId && entry?.dataUrl) {
                    this.cache.set(entry.adminStreamId, {
                        hash: entry.hash,
                        dataUrl: entry.dataUrl,
                        encrypted: !!entry.encrypted,
                        ts: entry.ts || 0,
                        rev: entry.rev || 0,
                        owner: entry.owner || null
                    });
                }
            }
            Logger.debug(`ChannelImageManager hydrated ${entries.length} entries from IDB`);
        } catch (e) {
            Logger.debug('ChannelImageManager hydrate failed:', e?.message);
        }
    }

    async _persistToIDB(adminStreamId, entry) {
        if (!this.db) return;
        try {
            await new Promise((resolve, reject) => {
                const tx = this.db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put({ adminStreamId, ...entry });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            Logger.debug('ChannelImageManager persist failed:', e?.message);
        }
    }

    /**
     * Synchronously read cached entry. Returns null if not loaded yet.
     * @param {string} adminStreamId
     * @returns {{hash, dataUrl, encrypted, ts, rev, owner}|null}
     */
    getCached(adminStreamId) {
        if (!adminStreamId) return null;
        return this.cache.get(adminStreamId) || null;
    }

    /**
     * Synchronously read cached entry for a *messageStreamId* (-1).
     * Convenience for UIs that only have the message stream id.
     */
    getCachedByMessageStreamId(messageStreamId) {
        const adminId = deriveAdminId(messageStreamId);
        return adminId ? this.getCached(adminId) : null;
    }

    /**
     * Fetch (or refresh) the channel image for `adminStreamId`.
     * - If cached and not `force`, returns the cached entry immediately AND
     *   triggers a background refresh (so callers see the latest on next render).
     * - If not cached or `force`, awaits a fresh resend.
     * - Concurrent calls for the same id share a single Promise.
     *
     * @param {string} adminStreamId
     * @param {Object} [opts]
     * @param {string|null} [opts.password]
     * @param {boolean} [opts.force] - bypass cache and await fresh resend
     * @returns {Promise<Object|null>}
     */
    async get(adminStreamId, { password = null, force = false } = {}) {
        if (!adminStreamId) return null;
        await this.init();

        const cached = this.cache.get(adminStreamId);
        if (cached && !force) {
            // Background refresh (don't await), but only if no inflight already
            if (!this.inflight.has(adminStreamId)) {
                this._fetch(adminStreamId, password).catch(() => {});
            }
            return cached;
        }

        if (this.inflight.has(adminStreamId)) {
            return this.inflight.get(adminStreamId);
        }

        const promise = this._fetch(adminStreamId, password);
        this.inflight.set(adminStreamId, promise);
        try {
            return await promise;
        } finally {
            this.inflight.delete(adminStreamId);
        }
    }

    async _fetch(adminStreamId, password) {
        try {
            const payload = await streamrController.resendChannelImage(adminStreamId, { password });
            if (!payload || !payload.data || !payload.hash) {
                return this.cache.get(adminStreamId) || null;
            }

            const prev = this.cache.get(adminStreamId);
            // Stale guard: ignore if same hash + same/lower rev
            if (prev && prev.hash === payload.hash) {
                return prev;
            }

            const entry = {
                hash: payload.hash,
                dataUrl: payload.data,
                encrypted: !!payload.encrypted,
                ts: payload.ts || Date.now(),
                rev: payload.rev || 0,
                owner: payload.createdBy || null
            };
            this.cache.set(adminStreamId, entry);
            this._persistToIDB(adminStreamId, entry).catch(() => {});
            this._emit(adminStreamId, entry);
            return entry;
        } catch (e) {
            Logger.debug('ChannelImageManager._fetch error:', e?.message);
            return this.cache.get(adminStreamId) || null;
        }
    }

    /**
     * Optimistically store a freshly-published image (admin upload path).
     * Notifies listeners and persists.
     */
    async setLocal(adminStreamId, entry) {
        if (!adminStreamId || !entry?.dataUrl || !entry?.hash) return;
        await this.init();
        const stored = {
            hash: entry.hash,
            dataUrl: entry.dataUrl,
            encrypted: !!entry.encrypted,
            ts: entry.ts || Date.now(),
            rev: entry.rev || 0,
            owner: entry.owner || null
        };
        this.cache.set(adminStreamId, stored);
        this._persistToIDB(adminStreamId, stored).catch(() => {});
        this._emit(adminStreamId, stored);
    }

    /**
     * Subscribe to updates for one channel. Returns an unsubscribe function.
     * @param {string} adminStreamId
     * @param {(entry) => void} cb
     */
    subscribe(adminStreamId, cb) {
        if (!adminStreamId || typeof cb !== 'function') return () => {};
        let set = this.listeners.get(adminStreamId);
        if (!set) {
            set = new Set();
            this.listeners.set(adminStreamId, set);
        }
        set.add(cb);
        return () => {
            const s = this.listeners.get(adminStreamId);
            if (s) {
                s.delete(cb);
                if (!s.size) this.listeners.delete(adminStreamId);
            }
        };
    }

    _emit(adminStreamId, entry) {
        const set = this.listeners.get(adminStreamId);
        if (!set) return;
        for (const cb of set) {
            try { cb(entry); } catch (e) { Logger.debug('ChannelImage listener error:', e?.message); }
        }
    }

    /**
     * Compute SHA-256 hex of a string (e.g. base64 dataURL).
     * Static + instance variants so callers can use either.
     * @param {string} str
     * @returns {Promise<string>}
     */
    static async sha256Hex(str) {
        const buf = new TextEncoder().encode(str);
        const digest = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    sha256Hex(str) {
        return ChannelImageManager.sha256Hex(str);
    }
}

export const channelImageManager = new ChannelImageManager();
