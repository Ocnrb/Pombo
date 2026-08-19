/**
 * Account-backup data import shared by the Connect-modal restore flow
 * (walletFlows) and the Settings import (SettingsUI). `data` is the state
 * object decrypted by secureStorage.importAccountBackup — the same shape the
 * device sync exchanges, produced by exportForBackup() on the web and
 * exportSyncState() on Android.
 *
 * Channels go through the sync's LWW-element-set merge instead of a raw
 * append, so a backup obeys leave tombstones and cannot duplicate entries.
 * The backup is passed as the merge BASE and the live cache as INCOMING:
 * on a join-timestamp tie the state already on this device wins, and the
 * backup only replaces a channel it holds a strictly newer join for.
 *
 * Slice timestamps (`sliceTs`) are deliberately not imported: backup slices
 * enter unstamped, so the next device-sync merge treats them as old and the
 * account's live cross-device state stays authoritative over them.
 */

import { Logger } from './logger.js';
import { mergeChannels } from './syncMerge.js';

/**
 * Apply backup state to the unlocked secure storage and the live channel
 * manager.
 *
 * The cache write and the manager-map reload happen in the same synchronous
 * block, before the first await: saveChannels() persists the manager map
 * wholesale over the cache, so any concurrent caller (an incoming DM creating
 * its conversation row, a metadata refresh) would erase whatever the cache
 * held that the map did not.
 *
 * @param {Object} data - Decrypted backup state (may be null/undefined)
 * @param {Object} deps
 * @param {Object} deps.secureStorage - Unlocked secure storage instance
 * @param {Object} deps.channelManager - Live channel manager instance
 * @returns {Promise<{channelsImported: number, contactsImported: number, dmHistories: number, changed: boolean}>}
 */
export async function importBackupData(data, { secureStorage, channelManager }) {
    const summary = {
        channelsImported: 0,
        contactsImported: 0,
        dmHistories: 0,
        changed: false
    };
    if (!data) return summary;
    if (!secureStorage.isStorageUnlocked()) {
        Logger.warn('Backup import: storage not unlocked, skipping data import');
        return summary;
    }

    const cache = secureStorage.cache;

    // ---- Channels + leave tombstones ----
    const incoming = (Array.isArray(data.channels) ? data.channels : [])
        // Pre-refactor web snapshots keyed channels by `streamId` only.
        .map(ch => (ch && !ch.messageStreamId && ch.streamId)
            ? { ...ch, messageStreamId: ch.streamId }
            : ch)
        .filter(ch => !!ch?.messageStreamId);
    if (incoming.length > 0 || data.channelsLeftAt) {
        const prevIds = new Set((cache.channels || []).map(c => c.messageStreamId));
        const merged = mergeChannels(
            incoming,
            cache.channels || [],
            data.channelsLeftAt || {},
            cache.channelsLeftAt || {}
        );
        summary.channelsImported =
            merged.channels.filter(c => !prevIds.has(c.messageStreamId)).length;
        const channelsChanged =
            summary.channelsImported > 0 ||
            merged.channels.length !== (cache.channels || []).length;
        cache.channels = merged.channels;
        cache.channelsLeftAt = merged.channelsLeftAt;
        channelManager.reloadChannelsFromSync();
        if (channelsChanged) summary.changed = true;
    }

    // ---- Trusted contacts (add missing only) ----
    if (data.trustedContacts) {
        if (!cache.trustedContacts) cache.trustedContacts = {};
        for (const [addr, contact] of Object.entries(data.trustedContacts)) {
            if (!cache.trustedContacts[addr]) {
                cache.trustedContacts[addr] = contact;
                summary.contactsImported++;
                summary.changed = true;
            }
        }
    }

    // ---- Sent DM messages (per stream, only when absent) ----
    if (data.sentMessages) {
        if (!cache.sentMessages) cache.sentMessages = {};
        for (const [streamId, msgs] of Object.entries(data.sentMessages)) {
            if (!cache.sentMessages[streamId]) {
                cache.sentMessages[streamId] = msgs;
                summary.dmHistories++;
                summary.changed = true;
            }
        }
    }

    // ---- Sent DM reactions (per stream, only when absent) ----
    if (data.sentReactions) {
        if (!cache.sentReactions) cache.sentReactions = {};
        for (const [streamId, reactions] of Object.entries(data.sentReactions)) {
            if (!cache.sentReactions[streamId]) {
                cache.sentReactions[streamId] = reactions;
                summary.dmHistories++;
                summary.changed = true;
            }
        }
    }

    // ---- Username (only if not set) ----
    if (data.username && !cache.username) {
        cache.username = data.username;
        summary.changed = true;
    }

    // ---- Blocked peers (union — never lose a block) ----
    if (Array.isArray(data.blockedPeers) && data.blockedPeers.length > 0) {
        if (!cache.blockedPeers) cache.blockedPeers = [];
        for (const addr of data.blockedPeers) {
            const normalized = String(addr).toLowerCase();
            if (!cache.blockedPeers.includes(normalized)) {
                cache.blockedPeers.push(normalized);
                summary.changed = true;
            }
        }
    }

    // ---- DM left-at timestamps (don't overwrite existing) ----
    if (data.dmLeftAt) {
        if (!cache.dmLeftAt) cache.dmLeftAt = {};
        for (const [peer, ts] of Object.entries(data.dmLeftAt)) {
            if (!cache.dmLeftAt[peer]) {
                cache.dmLeftAt[peer] = ts;
                summary.changed = true;
            }
        }
    }

    if (summary.changed) {
        await secureStorage.saveToStorage();
        // Standard post-save hook (app.js wires it to a debounced sync push):
        // the imported state has to reach the storage node, otherwise the
        // newest payload there predates the backup and other devices — and
        // this one, on its next pull — keep converging on the older state.
        channelManager.onChannelsSaved?.();
    }

    Logger.info('Backup import applied', summary);
    return summary;
}
