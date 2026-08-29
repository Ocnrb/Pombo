/**
 * Stream retention, read from the chain.
 *
 * The storage node's purge applies each stream's OWN `storageDays`, so a
 * channel's -1, -3 and -4 can age out at different rates: they are set by
 * separate transactions and any of them can fail on its own. The local
 * channel record only ever holds what a client last REQUESTED, so the chain
 * is the system of record and the record is a warm-start cache of it.
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { graphAPI } from './graph.js';

/**
 * Retention of `streamId` from its on-chain metadata, or null when the
 * stream carries none and when the lookup fails.
 *
 * Never throws: an unresolved retention must leave the caller on its
 * fallbacks instead of aborting whatever it was doing.
 *
 * @param {string} streamId
 * @returns {Promise<number|null>}
 */
export async function readStreamRetention(streamId) {
    if (!streamId) return null;
    try {
        const stream = await graphAPI.getStream(streamId);
        const days = JSON.parse(stream?.metadata || '{}').storageDays;
        if (typeof days === 'number' && days > 0) return days;
    } catch (e) {
        Logger.debug('Stream retention lookup failed:', String(streamId).slice(-20), e?.message);
    }
    return null;
}

/**
 * First usable retention among `candidates`, most trusted first, falling
 * back to the configured default.
 *
 * @param {Array<[unknown, string]>} candidates - [value, source] pairs
 * @returns {{storageDays: number, source: string}}
 */
export function pickRetention(candidates) {
    for (const [value, source] of candidates) {
        if (typeof value === 'number' && value > 0) return { storageDays: value, source };
    }
    return { storageDays: CONFIG.storage.defaultRetentionDays, source: 'default' };
}

/**
 * Retention to assume for a gated channel's KEYS stream (-4) without a
 * lookup. The epoch-key sweep evaluates announce freshness every 45s and
 * must never turn that into a network call, so this reads only what the
 * channel record already carries.
 *
 * The -3 value ranks above the configured default because every path that
 * sets a channel's retention sets both streams: it is wrong only when one
 * of those transactions failed on its own.
 *
 * @param {Object} channel
 * @returns {number}
 */
export function keysRetentionDays(channel) {
    return pickRetention([
        [channel?.keysStorageDays, 'keys'],
        [channel?.adminStorageDays, 'admin'],
        [channel?.storageDays, 'message']
    ]).storageDays;
}
