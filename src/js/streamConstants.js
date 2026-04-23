/**
 * Stream Architecture Constants (DUAL-STREAM)
 *
 * These are *protocol* constants, not tunable configuration — changing them
 * breaks interoperability with already-published messages. They live in a
 * dedicated module (separate from `config.js`) to make that distinction
 * explicit and prevent accidental edits.
 *
 * ARCHITECTURE:
 *   Each channel uses 2 streams, derived from a base ID by appending:
 *     -1  → Message stream  (WITH storage)
 *     -2  → Ephemeral stream (NO storage)
 *
 * MESSAGE STREAM (-1):
 *   Regular channels use 2 partitions (content + control overrides).
 *   DM inboxes use 4 partitions (messages + sync + sync_blobs + notifications).
 *
 * EPHEMERAL STREAM (-2):
 *   3 partitions: control (presence/typing), media signals, media data.
 */

export const STREAM_SUFFIX = Object.freeze({
    MESSAGE: '-1',
    EPHEMERAL: '-2'
});

export const MESSAGE_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.MESSAGE,
    PARTITIONS: 2,        // Regular channels: content + control overrides
    DM_PARTITIONS: 4,     // DM inboxes: messages + sync + sync_blobs + notifications

    // Partition indexes
    MESSAGES: 0,          // Text, reactions, images, video announcements
    CONTROL: 1,           // Edit/Delete overrides (regular channels)
    SYNC: 1,              // Cross-device sync payloads (self → self, DM inbox only)
    SYNC_BLOBS: 2,        // Image blobs sync (DM inbox only)
    NOTIFICATIONS: 3      // Channel invites / notifications (DM inbox only)
});

export const EPHEMERAL_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.EPHEMERAL,
    PARTITIONS: 3,

    // Partition indexes
    CONTROL: 0,           // Presence, typing (JSON)
    MEDIA_SIGNALS: 1,     // P2P coordination: piece_request, source_request/announce (JSON)
    MEDIA_DATA: 2         // P2P heavy payloads: file_piece (Binary - Uint8Array)
});

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
