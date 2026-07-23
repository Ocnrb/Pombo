/**
 * Stream Architecture Constants (TRIPLE-STREAM)
 *
 * These are *protocol* constants, not tunable configuration — changing them
 * breaks interoperability with already-published messages. They live in a
 * dedicated module (separate from `config.js`) to make that distinction
 * explicit and prevent accidental edits.
 *
 * ARCHITECTURE:
 *   Each regular channel uses up to 3 streams, derived from a base ID by appending:
 *     -1  → Message stream   (WITH storage) — content (text, reactions, media announces, edit/delete overrides)
 *     -2  → Ephemeral stream (NO storage)   — presence, typing, P2P media coordination
 *     -3  → Admin stream     (WITH storage) — admin-only writes (moderation state)
 *
 * MESSAGE STREAM (-1):
 *   Regular channels use 11 partitions:
 *     P0 content, P1 control overrides, P2-P10 storage-file chunks.
 *   DM inboxes use 13 partitions:
 *     P0 messages, P1 sync, P2 sync_blobs, P3 notifications, P4-P12 storage-file chunks.
 *
 *   The 9 chunk partitions carry Persistent File Sharing payloads (uploaded to the
 *   channel's storage nodes, downloaded via storage resend/HTTP — never subscribed
 *   live). Chunk i goes to partition first + (i % 9). Nine partitions exist for
 *   storage-node resend efficiency (small buckets, parallel per-partition reads),
 *   NOT for throughput — a single partition already saturates the publish path.
 *
 * EPHEMERAL STREAM (-2):
 *   3 partitions: control (presence/typing), media signals, media data.
 *
 * ADMIN STREAM (-3):
 *   3 partitions reserved by protocol; only P0 used in initial scope.
 *     P0: ADMIN_STATE  (moderation: bannedMembers, hiddenMessageIds, pins) — IMPLEMENTED
 *     P1: CHANNEL_IMAGE                                                    — RESERVED
 *     P2: PASSWORD_CHALLENGE                                               — RESERVED
 *   Permissions: only owner publishes; readers vary by channel type
 *   (public/password: public subscribe; native: members-only subscribe).
 */

export const STREAM_SUFFIX = Object.freeze({
    MESSAGE: '-1',
    EPHEMERAL: '-2',
    ADMIN: '-3'
});

export const MESSAGE_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.MESSAGE,
    PARTITIONS: 11,       // Regular channels: content + control + 9 storage-file chunk partitions
    DM_PARTITIONS: 13,    // DM inboxes: messages + sync + sync_blobs + notifications + 9 chunk partitions

    // Partition indexes
    MESSAGES: 0,          // Text, reactions, images, video/file announcements
    CONTROL: 1,           // Edit/Delete overrides (regular channels)
    SYNC: 1,              // Cross-device sync payloads (self → self, DM inbox only)
    SYNC_BLOBS: 2,        // Image blobs sync (DM inbox only)
    NOTIFICATIONS: 3      // Channel invites / notifications (DM inbox only)
});

/**
 * Persistent File Sharing over storage nodes (message stream -1, chunk partitions).
 *
 * Chunks are round-robined over 9 partitions starting right after the last
 * "classic" partition of the stream flavor: P2 on regular channels, P4 on DM
 * inboxes. The announcement is a normal signed chat message on P0
 * (type 'storage_file_announce') and carries firstChunkPartition/chunkPartitions,
 * so readers follow the announce, not these local constants.
 */
export const STORAGE_FILE = Object.freeze({
    CHUNK_PARTITIONS: 9,
    FIRST_CHUNK_PARTITION: 2,     // Regular channels (after P0 messages + P1 control)
    DM_FIRST_CHUNK_PARTITION: 4   // DM inboxes (after P0-P3)
});

/**
 * Partition for storage-file chunk i.
 * @param {number} i - Chunk index
 * @param {number} firstPartition - First chunk partition (2 regular / 4 DM, or from announce)
 * @param {number} [count] - Number of chunk partitions (default 9, or from announce)
 * @returns {number}
 */
export function storageChunkPartition(i, firstPartition, count = STORAGE_FILE.CHUNK_PARTITIONS) {
    return firstPartition + (i % count);
}

export const EPHEMERAL_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.EPHEMERAL,
    PARTITIONS: 3,

    // Partition indexes
    CONTROL: 0,           // Presence, typing (JSON)
    MEDIA_SIGNALS: 1,     // P2P coordination: piece_request, source_request/announce (JSON)
    MEDIA_DATA: 2         // P2P heavy payloads: file_piece (Binary - Uint8Array)
});

export const ADMIN_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.ADMIN,
    PARTITIONS: 3,        // P0 implemented; P1 (channel image) and P2 (password challenge) reserved

    // Partition indexes
    MODERATION: 0,        // ADMIN_STATE: bannedMembers, hiddenMessageIds, pins
    CHANNEL_IMAGE: 1,     // CHANNEL_IMAGE: channel image / profile metadata
    PASSWORD_CHALLENGE: 2 // PASSWORD_CHALLENGE: encrypted magic-plaintext blob for password verification
});

/**
 * Magic plaintext encrypted with the channel password and published to
 * ADMIN_STREAM partition 2 (PASSWORD_CHALLENGE). Successful decryption of the
 * payload's `magic` field with a candidate password proves that password is
 * correct, without revealing it on the network.
 *
 * Treated as an immutable, single-shot challenge per channel (published once
 * at channel creation; no rotation in this scope).
 */
export const PASSWORD_CHALLENGE_MAGIC = 'POMBO_PWD_CHALLENGE_V1';

// ================================================
// ID DERIVATION HELPERS
// ================================================

/**
 * Derive ephemeral stream ID from message stream ID.
 * @param {string} messageStreamId - Message stream ID (ends with -1)
 * @returns {string|null} Ephemeral stream ID (ends with -2) or null
 */
export function deriveEphemeralId(messageStreamId) {
    if (!messageStreamId) return null;
    return messageStreamId.replace(/-1$/, STREAM_SUFFIX.EPHEMERAL);
}

/**
 * Derive message stream ID from ephemeral stream ID.
 * @param {string} ephemeralStreamId - Ephemeral stream ID (ends with -2)
 * @returns {string|null} Message stream ID (ends with -1) or null
 */
export function deriveMessageId(ephemeralStreamId) {
    if (!ephemeralStreamId) return null;
    return ephemeralStreamId.replace(/-2$/, STREAM_SUFFIX.MESSAGE);
}

/**
 * Derive admin stream ID from a message stream ID.
 * @param {string} messageStreamId - Message stream ID (ends with -1)
 * @returns {string|null} Admin stream ID (ends with -3) or null
 */
export function deriveAdminId(messageStreamId) {
    if (!messageStreamId) return null;
    return messageStreamId.replace(/-1$/, STREAM_SUFFIX.ADMIN);
}

/**
 * @param {string} streamId
 * @returns {boolean} true if streamId ends with the message-stream suffix
 */
export function isMessageStream(streamId) {
    return !!streamId && streamId.endsWith(STREAM_SUFFIX.MESSAGE);
}

/**
 * @param {string} streamId
 * @returns {boolean} true if streamId ends with the ephemeral-stream suffix
 */
export function isEphemeralStream(streamId) {
    return !!streamId && streamId.endsWith(STREAM_SUFFIX.EPHEMERAL);
}

/**
 * @param {string} streamId
 * @returns {boolean} true if streamId ends with the admin-stream suffix
 */
export function isAdminStream(streamId) {
    return !!streamId && streamId.endsWith(STREAM_SUFFIX.ADMIN);
}
