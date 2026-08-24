/**
 * Routing for opening a channel the user has not joined, shared by the
 * Explore card tap and the `#/channel/<streamId>` deep link.
 *
 * The two entry points have to agree: a link now carries nothing but the
 * stream id, so everything that decides where the user lands (type, name,
 * gate address) is read from the channel's on-chain metadata, exactly as
 * Explore already does with the card it rendered.
 *
 * Gated routing is by MODE, not by type: a TOKEN/NFT holder gets preview so
 * they can read before committing, while everyone else — and every PAID gate,
 * where holding is a payment nobody has made yet — goes through the join that
 * answers GATE_ACCESS_DENIED, which is what raises the gate entry modal.
 */

import { Logger } from './logger.js';

/**
 * Open a channel from a card tap or a deep link.
 *
 * @param {string} streamId
 * @param {Object|null} channelInfo - Graph metadata; null is treated as public
 * @param {Object} deps
 * @param {Function} deps.enterPreviewMode - (streamId, channelInfo) => Promise
 * @param {Function} deps.joinPublicChannel - (streamId, channelInfo) => Promise
 */
export async function openUnjoinedChannel(streamId, channelInfo, { enterPreviewMode, joinPublicChannel }) {
    const type = channelInfo?.type || 'public';

    if (type === 'gated') {
        return openGatedChannel(streamId, channelInfo, { enterPreviewMode, joinPublicChannel });
    }

    // Password and native both commit on entry: one needs the password typed,
    // the other a permission check. Preview cannot stand in for either.
    if (type === 'password' || type === 'native') {
        return joinPublicChannel?.(streamId, channelInfo);
    }

    return enterPreviewMode?.(streamId, channelInfo);
}

/**
 * Route a gated channel by its on-chain mode (N-D):
 *  - TOKEN/NFT with access → PREVIEW (browse without committing; the Join
 *    button adds it to the list)
 *  - PAID, no access, or unreadable gate → the join flow, which lands on the
 *    gate entry screen when the gate refuses (paying IS the commitment)
 *
 * @param {string} streamId
 * @param {Object|null} channelInfo
 * @param {Object} deps
 */
export async function openGatedChannel(streamId, channelInfo, { enterPreviewMode, joinPublicChannel }) {
    try {
        const gate = channelInfo?.gateAddress;
        if (gate) {
            const { gateManager, GATE_MODE } = await import('./gate.js');
            const { authManager } = await import('./auth.js');
            const info = await gateManager.getGateInfo(gate);
            const holding = info.mode === GATE_MODE.TOKEN_BALANCE
                || info.mode === GATE_MODE.NFT_OWNERSHIP;
            const me = authManager.getAddress();
            if (holding && me && await gateManager.checkAccess(gate, me)) {
                return enterPreviewMode?.(streamId, channelInfo);
            }
        }
    } catch (e) {
        Logger.debug('Gated routing failed, falling back to join:', e?.message);
    }
    return joinPublicChannel?.(streamId, channelInfo);
}
