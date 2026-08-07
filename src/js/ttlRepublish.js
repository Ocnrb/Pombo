/**
 * TTL-aware republish decision (docs/TTL_REPUBLISH_PLAN.md).
 *
 * The -3 artifacts (ADMIN_STATE, CHANNEL_IMAGE, PASSWORD_CHALLENGE) are
 * published once and then only read. The storage node's TTL purge deletes
 * them by message timestamp after `storageDays`, and nothing brings them
 * back — bans/pins vanish, password channels become unjoinable, images
 * disappear. To prevent that, when the OWNER opens a channel we compare
 * each retained artifact's `ts` against the channel's storage TTL and
 * republish anything in the last stretch of its life. Republishing resets
 * the retention clock, so the check naturally stays quiet for the next
 * ~`ageFraction` of the TTL.
 */

import { CONFIG } from './config.js';

/**
 * Should an artifact with payload timestamp `artifactTs` be republished,
 * given the channel's retention of `storageDays`?
 *
 * Pure and side-effect free. Returns false on missing/invalid inputs —
 * an unknown age or TTL must never trigger a publish.
 *
 * @param {number} artifactTs - Payload `ts` (ms epoch) of the retained artifact
 * @param {number} storageDays - Channel retention in days
 * @param {number} [now=Date.now()] - Injectable clock for tests
 * @param {number} [ageFraction] - Override of CONFIG.storage.ttlRepublishAgeFraction
 * @returns {boolean}
 */
export function shouldRepublish(artifactTs, storageDays, now = Date.now(), ageFraction) {
    if (typeof artifactTs !== 'number' || artifactTs <= 0) return false;
    if (typeof storageDays !== 'number' || storageDays <= 0) return false;
    const fraction = typeof ageFraction === 'number'
        ? ageFraction
        : (CONFIG?.storage?.ttlRepublishAgeFraction ?? 0.8);
    const ttlMs = storageDays * 86_400_000;
    return (now - artifactTs) > fraction * ttlMs;
}
