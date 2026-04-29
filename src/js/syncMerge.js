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

export function mergeState(base, incoming, maxSentMessages = CONFIG.dm.maxSentMessages) {
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
        channels: incoming?.channels !== undefined
            ? incoming.channels
            : (base?.channels || []),
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