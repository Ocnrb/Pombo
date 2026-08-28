/**
 * Recovery of chunked image manifests whose chunks fell outside the resend
 * window: paginates history, then re-reads targeted time windows, and gives
 * up loudly so the UI can offer a retry.
 */

import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';
import { mediaController } from '../media.js';
import { secureStorage } from '../secureStorage.js';
import { streamrController, STREAM_CONFIG } from '../streamr.js';

export class ImageRecovery {
    /**
     * Calls that the manager also exposes go through it: anything replacing
     * one of those methods has to keep intercepting the calls made here.
     * @param {Object} manager - the channel manager
     */
    constructor(manager) {
        this.manager = manager;
        // Re-entrance guard per stream: a recovery round already walking the
        // history must not be restarted by a second trigger.
        this._imageRecoveryInFlight = new Set(); // messageStreamId
    }

    /**
     * Recover image manifests whose chunks fell outside the initial resend
     * window. Each chunked image publishes N chunk messages followed by 1
     * manifest; with `INITIAL_MESSAGES = 50` bounded by Streamr `last:N`,
     * multiple historical images cause older manifests to land without all
     * their chunks (the manifest is at the end of the upload run, so the
     * manifest itself usually fits but the head chunks get truncated).
     * Without this, the affected placeholders stay on "Loading…" forever
     * unless the user scrolls back manually.
     *
     * Strategy: scan visible manifests, identify those that haven't been
     * cached, persisted, or fully assembled, and call `loadMoreHistory`
     * in a bounded loop until they are recovered or no more history is
     * available. Chunks that arrive feed `registerStoredImageChunk` →
     * `tryAssembleStoredImage` → `onImageReceived`, which the UI handler
     * in `setupMediaHandlers` uses to swap placeholders in place.
     *
     * @param {string} messageStreamId
     * @param {number} [maxRounds]
     */
    async recoverIncompleteImages(messageStreamId, maxRounds = CONFIG.media.recoveryMaxRounds) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) return;
        if (channel.writeOnly || channel.type === 'dm') return;
        if (typeof mediaController?.isStoredChunkedImageManifest !== 'function') return;
        if (this._imageRecoveryInFlight.has(messageStreamId)) return;

        this._imageRecoveryInFlight.add(messageStreamId);
        try {
            await this.manager._recoverIncompleteImagesInner(messageStreamId, channel, maxRounds);
        } finally {
            this._imageRecoveryInFlight.delete(messageStreamId);
        }
    }

    /** @private Recovery loop body — always called with the in-flight guard held. */
    async _recoverIncompleteImagesInner(messageStreamId, channel, maxRounds) {
        const stagnantLimit = CONFIG.media.recoveryStagnantRoundsLimit;
        const generationAtStart = this.manager.switchGeneration;
        let prevIncompleteCount = -1;
        let stagnantRounds = 0;

        // Sum buffered chunk counts across the given imageIds so we can
        // distinguish "pagination loaded chunks but no manifest completed
        // yet" (real progress) from "pagination found nothing" (stagnant).
        const sumPendingChunks = (ids) => {
            let total = 0;
            for (const id of ids) {
                const pending = mediaController.pendingImageAssemblies?.get?.(id);
                if (pending) total += pending.chunks.size;
            }
            return total;
        };

        // Global view: count chunks across ALL pending assemblies for this
        // stream. Some assemblies may be in `pendingImageAssemblies` without
        // having been re-classified as "incomplete" yet (e.g., manifest just
        // re-registered this round) — counting only the per-id total can
        // misreport stagnation. This catches chunks landing for any pending
        // image owned by this stream.
        const sumAllChunks = (streamId) => {
            let total = 0;
            const map = mediaController.pendingImageAssemblies;
            if (!map || typeof map.forEach !== 'function') return 0;
            map.forEach((pending) => {
                if (pending?.streamId === streamId) total += pending.chunks.size;
            });
            return total;
        };

        for (let round = 0; round < maxRounds; round++) {
            if (this.manager.switchGeneration !== generationAtStart) return;

            const incompleteIds = [];
            for (const msg of channel.messages) {
                if (!mediaController.isStoredChunkedImageManifest(msg)) continue;
                if (msg.verified?.valid === false) continue;
                if (!msg.imageId) continue;
                if (mediaController.deletedImageIds?.has?.(msg.imageId)) continue;

                // Already cached in memory — placeholder will heal via recoverImage()
                if (mediaController.getImage?.(msg.imageId)) {
                    // Re-fire delivery in case the placeholder was rendered
                    // after the cache fill (covers the race where assembly
                    // completed during the same tick as the render).
                    mediaController.recoverImage?.(msg.imageId);
                    continue;
                }

                // Already persisted to ledger — load it and let the placeholder healer fire
                try {
                    const fromLedger = await secureStorage.getImageBlob?.(msg.imageId);
                    if (fromLedger) {
                        mediaController.handleImageData?.({
                            type: 'image_data',
                            imageId: msg.imageId,
                            data: fromLedger
                        });
                        continue;
                    }
                } catch (err) {
                    Logger.debug('recoverIncompleteImages: ledger lookup failed:', err?.message || err);
                }

                // Manifest registered but not yet via assembler (e.g., verified after
                // initial flush, or arrived in pagination without manifest re-register).
                // Force re-registration so any buffered chunks can complete.
                try {
                    if (typeof mediaController.registerStoredImageManifest === 'function') {
                        await mediaController.registerStoredImageManifest(messageStreamId, msg);
                    }
                } catch (err) {
                    Logger.debug('recoverIncompleteImages: manifest re-register failed:', err?.message || err);
                }

                // After re-register the assembly may have completed
                if (mediaController.getImage?.(msg.imageId)) {
                    mediaController.recoverImage?.(msg.imageId);
                    continue;
                }

                // Pending assembly already complete — nudge it to retry
                const pending = mediaController.pendingImageAssemblies?.get?.(msg.imageId);
                if (pending?.manifest && pending.chunks.size >= pending.manifest.chunkCount) {
                    mediaController.recoverImage?.(msg.imageId);
                    continue;
                }

                incompleteIds.push(msg.imageId);
            }

            if (incompleteIds.length === 0) {
                if (round > 0) {
                    Logger.debug(
                        `recoverIncompleteImages: all manifests resolved for ${messageStreamId.slice(-20)} after ${round} round(s)`
                    );
                }
                return;
            }
            if (!channel.hasMoreHistory) {
                // Pagination exhausted — but range resends can be silently
                // truncated, so "not in stored history" may be false. Try a
                // targeted window re-query around each manifest before giving up.
                Logger.warn(
                    `recoverIncompleteImages: ${incompleteIds.length} manifest(s) incomplete after pagination for ${messageStreamId.slice(-20)} — trying targeted window recovery`
                );
                const recoveredIds = await this.manager._recoverChunksViaWindow(
                    messageStreamId, channel, incompleteIds, generationAtStart
                );
                if (this.manager.switchGeneration !== generationAtStart) return;
                const stillIncomplete = incompleteIds.filter(id => !recoveredIds.includes(id));
                if (stillIncomplete.length > 0) {
                    Logger.warn(
                        `recoverIncompleteImages: ${stillIncomplete.length} manifest(s) still incomplete (chunks truly not in stored history) for ${messageStreamId.slice(-20)}`
                    );
                    this.manager._markChannelImagesUnavailable(messageStreamId, stillIncomplete);
                }
                return;
            }

            Logger.debug(
                `recoverIncompleteImages: paginating to recover ${incompleteIds.length} image manifest(s) ` +
                `for ${messageStreamId.slice(-20)} (round ${round + 1}/${maxRounds})`
            );

            // Snapshot pending chunk totals BEFORE pagination so we can detect
            // real progress (chunks arriving) even when no manifest completed
            // this round — a single 5MB GIF can need 25+ chunks across many
            // pagination rounds before the count of incomplete manifests drops.
            const chunksBefore = sumPendingChunks(incompleteIds);
            const allChunksBefore = sumAllChunks(messageStreamId);

            const result = await this.manager.loadMoreHistory(messageStreamId);
            if (this.manager.switchGeneration !== generationAtStart) return;

            const chunksAfter = sumPendingChunks(incompleteIds);
            const allChunksAfter = sumAllChunks(messageStreamId);
            const madeProgress = result.loaded > 0
                || chunksAfter > chunksBefore
                || allChunksAfter > allChunksBefore
                || incompleteIds.length !== prevIncompleteCount;

            // Stagnation guard: only count rounds where nothing changed
            // (no new messages, no new chunks, same incomplete count).
            // Without this, multi-GIF backlogs would bail before later
            // images had a chance to complete their long chunk runs.
            if (madeProgress) {
                stagnantRounds = 0;
                prevIncompleteCount = incompleteIds.length;
            } else {
                stagnantRounds++;
                if (stagnantRounds >= stagnantLimit) {
                    Logger.warn(
                        `recoverIncompleteImages: ${incompleteIds.length} manifest(s) stagnant after ${stagnantRounds} rounds — trying targeted window recovery for ${messageStreamId.slice(-20)}`
                    );
                    const recoveredIds = await this.manager._recoverChunksViaWindow(
                        messageStreamId, channel, incompleteIds, generationAtStart
                    );
                    if (this.manager.switchGeneration !== generationAtStart) return;
                    const stillIncomplete = incompleteIds.filter(id => !recoveredIds.includes(id));
                    if (stillIncomplete.length > 0) {
                        this.manager._markChannelImagesUnavailable(messageStreamId, stillIncomplete);
                    }
                    return;
                }
            }

            // Nothing new fetched and no more history → continue (stagnation
            // counter will catch the dead end after `stagnantLimit` rounds).
            if (result.loaded === 0 && !result.hasMore && chunksAfter === chunksBefore && allChunksAfter === allChunksBefore) {
                continue;
            }
        }

        Logger.debug(
            `recoverIncompleteImages: hit max rounds (${maxRounds}) for ${messageStreamId.slice(-20)}`
        );
    }

    /**
     * Targeted window recovery for incomplete chunked images.
     *
     * Storage range resends can be SILENTLY TRUNCATED (WS drop mid-iteration
     * yields a short response with no error — confirmed against a storage
     * node holding 422 messages while the client received ~106). When that
     * happens, pagination concludes `hasMore: false` and the chunks look
     * "missing" even though they are stored.
     *
     * Since chunks are always published moments before their manifest, we
     * re-query a small window around each incomplete manifest's timestamp,
     * with a few fresh attempts (each opens a new storage connection).
     *
     * @param {string} messageStreamId
     * @param {Object} channel
     * @param {string[]} incompleteIds
     * @param {number} generationAtStart - Switch fence captured by the caller
     * @returns {Promise<string[]>} imageIds recovered (assembled or chunk-complete)
     * @private
     */
    async _recoverChunksViaWindow(messageStreamId, channel, incompleteIds, generationAtStart) {
        const windowMs = CONFIG.media.recoveryWindowMs;
        const forwardMarginMs = CONFIG.media.recoveryWindowForwardMarginMs;
        const maxAttempts = CONFIG.media.recoveryWindowAttempts;
        const recovered = [];
        const incompleteSet = new Set(incompleteIds);

        const chunkDiag = (imageId) => {
            const pending = mediaController.pendingImageAssemblies?.get?.(imageId);
            const total = pending?.manifest?.chunkCount;
            if (!pending || !Number.isInteger(total)) return `${imageId}: no pending assembly`;
            const missing = [];
            for (let i = 0; i < total; i++) {
                if (!pending.chunks.has(i)) missing.push(i);
            }
            return `${imageId}: ${pending.chunks.size}/${total} chunks, missing [${missing.join(',')}]`;
        };

        for (const imageId of incompleteIds) {
            if (this.manager.switchGeneration !== generationAtStart) return recovered;

            const manifestMsg = channel.messages.find(
                (m) => m?.imageId === imageId && mediaController.isStoredChunkedImageManifest?.(m)
            );
            const anchorTs = manifestMsg?.timestamp
                || mediaController.pendingImageAssemblies?.get?.(imageId)?.manifest?.timestamp;
            if (!anchorTs) {
                Logger.debug(`window recovery: no manifest timestamp for ${imageId} — skipping`);
                continue;
            }

            Logger.info(`window recovery: ${chunkDiag(imageId)} — querying ±window around manifest`);

            let done = false;
            for (let attempt = 1; attempt <= maxAttempts && !done; attempt++) {
                if (this.manager.switchGeneration !== generationAtStart) return recovered;
                try {
                    const result = await streamrController.fetchOlderHistoryWindowed(
                        messageStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                        anchorTs + forwardMarginMs,
                        windowMs + forwardMarginMs,
                        this.manager.historyAbortController?.signal ?? null,
                        channel.password || null
                    );

                    for (const item of result.messages || []) {
                        const content = item?.content;
                        if (
                            content
                            && mediaController.isStoredImageChunkMessage?.(content)
                            && incompleteSet.has(content.imageId)
                        ) {
                            await mediaController.registerStoredImageChunk(messageStreamId, content);
                        }
                    }

                    // Re-register the manifest to trigger assembly of buffered chunks
                    if (manifestMsg && typeof mediaController.registerStoredImageManifest === 'function') {
                        await mediaController.registerStoredImageManifest(messageStreamId, manifestMsg);
                    }
                } catch (err) {
                    Logger.debug(`window recovery attempt ${attempt} failed for ${imageId}:`, err?.message || err);
                }

                if (mediaController.getImage?.(imageId)) {
                    mediaController.recoverImage?.(imageId);
                    recovered.push(imageId);
                    done = true;
                } else {
                    const pending = mediaController.pendingImageAssemblies?.get?.(imageId);
                    if (pending?.manifest && pending.chunks.size >= pending.manifest.chunkCount) {
                        mediaController.recoverImage?.(imageId);
                        recovered.push(imageId);
                        done = true;
                    }
                }

                if (!done && attempt < maxAttempts) {
                    Logger.debug(`window recovery: retrying ${imageId} (attempt ${attempt + 1}/${maxAttempts}) — ${chunkDiag(imageId)}`);
                }
            }

            Logger.info(`window recovery: ${done ? 'RECOVERED' : 'still incomplete'} — ${chunkDiag(imageId)}`);
        }

        return recovered;
    }

    /**
     * Mark image placeholders as unavailable (history exhausted or recovery
     * gave up). Emits an event the chat UI can render as an "Image unavailable"
     * tile with a Retry button (handler re-invokes recoverIncompleteImages).
     * @param {string} messageStreamId
     * @param {string[]} imageIds
     * @private
     */
    _markChannelImagesUnavailable(messageStreamId, imageIds) {
        if (!Array.isArray(imageIds) || imageIds.length === 0) return;
        if (typeof window === 'undefined') return;
        try {
            window.dispatchEvent(new CustomEvent('pombo:imageRecoveryGaveUp', {
                detail: { streamId: messageStreamId, imageIds: imageIds.slice() }
            }));
        } catch (err) {
            Logger.debug('_markChannelImagesUnavailable: dispatch failed:', err?.message || err);
        }
    }
}
