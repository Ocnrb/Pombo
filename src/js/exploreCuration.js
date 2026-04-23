/**
 * Explore Curation
 *
 * Fetches a static curation manifest (curation/explore.json) and applies it
 * to the list of public channels shown in the Explore view:
 *  - `pinned`  : streamIds that should appear at the top, in the order listed.
 *  - `hidden`  : streamIds that should be filtered out from discovery
 *                (users can still join via direct link).
 *
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';

const MANIFEST_URL = CONFIG.explore.manifestUrl;
const CACHE_TTL_MS = CONFIG.explore.cacheTtlMs;

const EMPTY_MANIFEST = Object.freeze({ pinned: [], hidden: [] });

let cachedManifest = null;
let cachedAt = 0;
let inflight = null;

/**
 * Normalize a streamId for case-insensitive comparison.
 * @param {string} id
 * @returns {string}
 */
function normalizeStreamId(id) {
    return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

/**
 * Validate and normalize a manifest entry list.
 * Accepts entries shaped as either `"streamId"` or `{ streamId: "..." }`.
 * Drops invalid/empty entries and de-duplicates while preserving order.
 * @param {Array} list
 * @returns {string[]} normalized streamIds
 */
function normalizeList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of list) {
        const raw = typeof entry === 'string' ? entry : entry?.streamId;
        const id = normalizeStreamId(raw);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * Fetch and cache the curation manifest.
 * @param {Object} [opts]
 * @param {boolean} [opts.force] - Bypass cache.
 * @returns {Promise<{pinned: string[], hidden: string[]}>}
 */
export async function loadCurationManifest({ force = false } = {}) {
    const now = Date.now();
    if (!force && cachedManifest && (now - cachedAt) < CACHE_TTL_MS) {
        return cachedManifest;
    }
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const json = await res.json();
            const manifest = {
                pinned: normalizeList(json.pinned),
                hidden: normalizeList(json.hidden),
            };
            cachedManifest = manifest;
            cachedAt = Date.now();
            Logger.debug(
                `[ExploreCuration] Loaded manifest: ${manifest.pinned.length} pinned, ${manifest.hidden.length} hidden`
            );
            return manifest;
        } catch (err) {
            Logger.warn('[ExploreCuration] Failed to load manifest, continuing without curation:', err.message);
            // Cache the empty fallback briefly to avoid hammering on every load.
            cachedManifest = EMPTY_MANIFEST;
            cachedAt = Date.now();
            return EMPTY_MANIFEST;
        } finally {
            inflight = null;
        }
    })();

    return inflight;
}

/**
 * Apply curation rules to a list of channels.
 * - Removes channels whose streamId is in `manifest.hidden`.
 * - Reorders so that channels matching `manifest.pinned` appear first,
 *   in the order specified by the manifest. Pinned streamIds that don't
 *   exist in the input list are silently ignored.
 *
 * @param {Array<{streamId: string}>} channels
 * @param {{pinned: string[], hidden: string[]}} manifest
 * @returns {Array} a new array (does not mutate input)
 */
export function applyCuration(channels, manifest) {
    if (!Array.isArray(channels) || channels.length === 0) return channels || [];
    if (!manifest) return channels.slice();

    // Normalize defensively: the manifest may have been built by hand (tests,
    // future server feeds) and not pre-normalized by loadCurationManifest.
    const hidden = new Set((manifest.hidden || []).map(normalizeStreamId).filter(Boolean));
    const pinnedOrder = (manifest.pinned || []).map(normalizeStreamId).filter(Boolean);

    // 1) Filter hidden.
    const visible = hidden.size > 0
        ? channels.filter(ch => !hidden.has(normalizeStreamId(ch?.streamId)))
        : channels.slice();

    if (pinnedOrder.length === 0) return visible;

    // 2) Partition into pinned vs. rest, preserving manifest order for pinned.
    const byId = new Map();
    for (const ch of visible) {
        byId.set(normalizeStreamId(ch?.streamId), ch);
    }

    const pinnedList = [];
    const pinnedSeen = new Set();
    for (const id of pinnedOrder) {
        const ch = byId.get(id);
        if (ch && !pinnedSeen.has(id)) {
            pinnedList.push(ch);
            pinnedSeen.add(id);
        }
    }

    const rest = visible.filter(ch => !pinnedSeen.has(normalizeStreamId(ch?.streamId)));
    return [...pinnedList, ...rest];
}
