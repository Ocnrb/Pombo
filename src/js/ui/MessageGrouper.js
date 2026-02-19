/**
 * Message Grouper
 * Handles grouping of consecutive messages from the same sender
 * for the "Stack Effect" visual pattern (like iMessage/Telegram)
 */

/**
 * Group position types
 * @readonly
 * @enum {string}
 */
export const GroupPosition = {
    SINGLE: 'single',      // Only message from this sender in sequence
    FIRST: 'first',        // First message in a group
    MIDDLE: 'middle',      // Middle message in a group
    LAST: 'last'           // Last message in a group
};

/**
 * Time threshold (in ms) to break groups even from same sender
 * Messages sent more than 2 minutes apart start a new group
 */
const GROUP_TIME_THRESHOLD = 2 * 60 * 1000; // 2 minutes

/**
 * Determine if two messages should be in the same group
 * @param {Object} msg1 - First message
 * @param {Object} msg2 - Second message
 * @returns {boolean} - Whether messages should be grouped
 */
function shouldGroup(msg1, msg2) {
    if (!msg1 || !msg2) return false;
    
    // Different senders = different groups
    if (msg1.sender?.toLowerCase() !== msg2.sender?.toLowerCase()) {
        return false;
    }
    
    // Check time difference
    const timeDiff = Math.abs(msg2.timestamp - msg1.timestamp);
    if (timeDiff > GROUP_TIME_THRESHOLD) {
        return false;
    }
    
    // Different days = different groups (date separator will appear)
    const date1 = new Date(msg1.timestamp).toDateString();
    const date2 = new Date(msg2.timestamp).toDateString();
    if (date1 !== date2) {
        return false;
    }
    
    return true;
}

/**
 * Analyze messages array and determine group position for each message
 * @param {Array<Object>} messages - Array of message objects
 * @returns {Array<GroupPosition>} - Array of group positions matching input indices
 */
export function analyzeMessageGroups(messages) {
    if (!messages || messages.length === 0) {
        return [];
    }
    
    const positions = new Array(messages.length);
    
    for (let i = 0; i < messages.length; i++) {
        const prev = i > 0 ? messages[i - 1] : null;
        const curr = messages[i];
        const next = i < messages.length - 1 ? messages[i + 1] : null;
        
        const groupedWithPrev = shouldGroup(prev, curr);
        const groupedWithNext = shouldGroup(curr, next);
        
        if (!groupedWithPrev && !groupedWithNext) {
            // Standalone message
            positions[i] = GroupPosition.SINGLE;
        } else if (!groupedWithPrev && groupedWithNext) {
            // First in group
            positions[i] = GroupPosition.FIRST;
        } else if (groupedWithPrev && groupedWithNext) {
            // Middle of group
            positions[i] = GroupPosition.MIDDLE;
        } else {
            // Last in group (groupedWithPrev && !groupedWithNext)
            positions[i] = GroupPosition.LAST;
        }
    }
    
    return positions;
}

/**
 * Get CSS class for message group position
 * @param {GroupPosition} position - Position in group
 * @returns {string} - CSS class name
 */
export function getGroupPositionClass(position) {
    switch (position) {
        case GroupPosition.FIRST:
            return 'msg-group-first';
        case GroupPosition.MIDDLE:
            return 'msg-group-middle';
        case GroupPosition.LAST:
            return 'msg-group-last';
        case GroupPosition.SINGLE:
        default:
            return 'msg-group-single';
    }
}

/**
 * Check if sender name should be shown for this message
 * Only show on first message of group or single messages
 * @param {GroupPosition} position - Position in group
 * @returns {boolean} - Whether to show sender name
 */
export function shouldShowSenderName(position) {
    return position === GroupPosition.SINGLE || position === GroupPosition.FIRST;
}

/**
 * Spacing types for margin between messages
 * @readonly
 * @enum {string}
 */
export const SpacingType = {
    STACK: 'stack',           // Same sender consecutive (2-4px)
    PING_PONG: 'ping-pong',   // Different sides (12-16px)
    SAME_SIDE: 'same-side'    // Same side, different sender (16-24px)
};

/**
 * Analyze spacing between messages
 * Returns an array of spacing types for each message (spacing BEFORE the message)
 * @param {Array<Object>} messages - Array of message objects
 * @param {string} currentAddress - Current user's address for own/other detection
 * @returns {Array<SpacingType|null>} - Array of spacing types (null for first message)
 */
export function analyzeSpacing(messages, currentAddress) {
    if (!messages || messages.length === 0) {
        return [];
    }
    
    const spacings = new Array(messages.length);
    const normalizedCurrent = currentAddress?.toLowerCase();
    
    for (let i = 0; i < messages.length; i++) {
        if (i === 0) {
            spacings[i] = null; // First message has no spacing before it
            continue;
        }
        
        const prev = messages[i - 1];
        const curr = messages[i];
        
        const prevIsOwn = prev.sender?.toLowerCase() === normalizedCurrent;
        const currIsOwn = curr.sender?.toLowerCase() === normalizedCurrent;
        const sameSender = prev.sender?.toLowerCase() === curr.sender?.toLowerCase();
        
        // Check if messages are on same side
        const sameSide = prevIsOwn === currIsOwn;
        
        if (sameSender && shouldGroup(prev, curr)) {
            // Stack: same sender, grouped (tight spacing)
            spacings[i] = SpacingType.STACK;
        } else if (!sameSide) {
            // Ping-pong: different sides (medium spacing)
            spacings[i] = SpacingType.PING_PONG;
        } else {
            // Same side, different sender (larger spacing)
            spacings[i] = SpacingType.SAME_SIDE;
        }
    }
    
    return spacings;
}

/**
 * Get CSS class for spacing type
 * @param {SpacingType|null} spacingType - Spacing type
 * @returns {string} - CSS class name
 */
export function getSpacingClass(spacingType) {
    switch (spacingType) {
        case SpacingType.STACK:
            return 'spacing-stack';
        case SpacingType.PING_PONG:
            return 'spacing-ping-pong';
        case SpacingType.SAME_SIDE:
            return 'spacing-same-side';
        default:
            return '';
    }
}
