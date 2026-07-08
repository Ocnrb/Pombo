import { CONFIG } from './config.js';

export function mergeSentMessages(local, remote, maxSentMessages = CONFIG.dm.maxSentMessages) {
    const result = {};

    for (const [streamId, messages] of Object.entries(local || {})) {
        result[streamId] = messages.map(message => ({ ...message }));
    }

    for (const [streamId, remoteMessages] of Object.entries(remote || {})) {
        if (!result[streamId]) {
            result[streamId] = remoteMessages.map(message => ({ ...message }));
            continue;
        }

        const localById = new Map(result[streamId].map(message => [message.id, message]));
        for (const message of remoteMessages) {
            const existing = localById.get(message.id);
            if (!existing) {
                result[streamId].push({ ...message });
            } else if (message.type === 'image' && message.imageData && !existing.imageData) {
                existing.imageData = message.imageData;
            }
        }

        result[streamId].sort((a, b) => a.timestamp - b.timestamp);
        if (result[streamId].length > maxSentMessages) {
            result[streamId] = result[streamId].slice(-maxSentMessages);
        }
    }

    return result;
}

export function mergeSentReactions(local, remote) {
    const result = {};
    const allStreamIds = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);

    for (const streamId of allStreamIds) {
        const localStream = local?.[streamId] || {};
        const remoteStream = remote?.[streamId] || {};
        result[streamId] = {};

        const allMessageIds = new Set([...Object.keys(localStream), ...Object.keys(remoteStream)]);
        for (const messageId of allMessageIds) {
            if (messageId in remoteStream) {
                const remoteReactions = remoteStream[messageId];
                if (Object.keys(remoteReactions).length > 0) {
                    result[streamId][messageId] = remoteReactions;
                }
            } else {
                result[streamId][messageId] = localStream[messageId];
            }
        }

        if (Object.keys(result[streamId]).length === 0) {
            delete result[streamId];
        }
    }

    return result;
}

/**
 * Merge channel lists as an LWW-element-set (per-channel latest-wins).
 *
 * A channel's membership is decided by comparing its join timestamp
 * (`joinedAt`, falling back to `createdAt`) against its leave tombstone in
 * `channelsLeftAt`. The most recent action wins; on a tie, Join wins.
 * This replaces whole-array snapshot replacement, which could delete a
 * fresh local Join when an older remote snapshot arrived (or vice versa).
 *
 * @param {Array} baseChannels - Base channel entries
 * @param {Array} incomingChannels - Incoming channel entries
 * @param {Object} baseLeftAt - Base leave tombstones { messageStreamId: ts }
 * @param {Object} incomingLeftAt - Incoming leave tombstones
 * @returns {{channels: Array, channelsLeftAt: Object}}
 */
export function mergeChannels(baseChannels, incomingChannels, baseLeftAt, incomingLeftAt) {
    const joinTs = (ch) => ch?.joinedAt || ch?.createdAt || 0;

    // Merge tombstones: max timestamp per channel wins
    const channelsLeftAt = {};
    for (const source of [baseLeftAt || {}, incomingLeftAt || {}]) {
        for (const [streamId, ts] of Object.entries(source)) {
            if (typeof ts !== 'number') continue;
            if (!(streamId in channelsLeftAt) || ts > channelsLeftAt[streamId]) {
                channelsLeftAt[streamId] = ts;
            }
        }
    }

    // Union channel entries: entry with the newest join timestamp wins;
    // incoming wins ties (newer snapshot has fresher metadata).
    const byId = new Map();
    for (const channel of baseChannels || []) {
        if (channel?.messageStreamId) byId.set(channel.messageStreamId, channel);
    }
    for (const channel of incomingChannels || []) {
        if (!channel?.messageStreamId) continue;
        const existing = byId.get(channel.messageStreamId);
        if (!existing || joinTs(channel) >= joinTs(existing)) {
            byId.set(channel.messageStreamId, channel);
        }
    }

    // Membership: last action wins. Join persists unless a strictly newer
    // leave tombstone exists.
    const channels = [];
    for (const channel of byId.values()) {
        const leftTs = channelsLeftAt[channel.messageStreamId];
        if (leftTs !== undefined && leftTs > joinTs(channel)) continue;
        channels.push(channel);
        // Prune tombstones superseded by a re-join to keep the map small
        if (leftTs !== undefined) {
            delete channelsLeftAt[channel.messageStreamId];
        }
    }

    return { channels, channelsLeftAt };
}

export function mergeState(base, incoming, maxSentMessages = CONFIG.dm.maxSentMessages) {
    const { channels, channelsLeftAt } = mergeChannels(
        base?.channels,
        incoming?.channels,
        base?.channelsLeftAt,
        incoming?.channelsLeftAt
    );

    return {
        sentMessages: mergeSentMessages(
            base?.sentMessages || {},
            incoming?.sentMessages || {},
            maxSentMessages
        ),
        sentReactions: mergeSentReactions(
            base?.sentReactions || {},
            incoming?.sentReactions || {}
        ),
        channels,
        channelsLeftAt,
        blockedPeers: incoming?.blockedPeers !== undefined
            ? incoming.blockedPeers
            : (base?.blockedPeers || []),
        dmLeftAt: incoming?.dmLeftAt !== undefined
            ? incoming.dmLeftAt
            : (base?.dmLeftAt || {}),
        trustedContacts: incoming?.trustedContacts !== undefined
            ? incoming.trustedContacts
            : (base?.trustedContacts || {}),
        ensCache: {
            ...(base?.ensCache || {}),
            ...(incoming?.ensCache || {})
        },
        username: incoming?.username !== undefined
            ? (incoming.username || null)
            : (base?.username || null),
        graphApiKey: incoming?.graphApiKey || base?.graphApiKey
    };
}

export function mergePayloadSeries(base, payloads, maxSentMessages = CONFIG.dm.maxSentMessages) {
    let merged = base;
    for (const payload of payloads) {
        merged = mergeState(merged, payload, maxSentMessages);
    }
    return merged;
}