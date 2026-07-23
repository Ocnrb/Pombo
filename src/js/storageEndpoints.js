/**
 * Storage Endpoint Resolution (on-chain)
 *
 * Resolves the HTTP endpoints of the storage nodes assigned to a stream from
 * the on-chain registries, replacing the hardcoded node URLs the storage POC
 * used. Two SDK calls do the work:
 *
 *   stream.getStorageNodes()             → node EVM addresses (StreamStorageRegistry)
 *   client.getStorageNodeMetadata(addr)  → { urls: [...] }    (NodeRegistry)
 *
 * Only web-safe URLs (https, hostname, non-localhost) survive filtering — the
 * browser cannot fetch from http:// or IP-literal endpoints on a https origin.
 *
 * The module also tracks per-node health for the session:
 *  - consecutive-failure ejection from the rotation (noteFailure/noteSuccess)
 *  - whether a node supports the Pombo `format=metadata` fast path (probed
 *    lazily by the engine; vanilla storage nodes answer HTTP 400)
 */

import { CONFIG } from './config.js';
import { Logger } from './logger.js';
import { streamrController, isWebSafeStorageNodeUrl } from './streamr.js';

const normalizeUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

class StorageEndpointResolver {
    constructor() {
        // streamId → { at: epochMs, nodes: [{ nodeAddress, urls }] }
        this.cache = new Map();
        // streamId → in-flight promise (dedupe concurrent resolutions)
        this.inFlight = new Map();
        // url → consecutive failure count (session-scoped)
        this.failures = new Map();
        // url → true | false (format=metadata support; unknown = not present)
        this.metaFormat = new Map();
    }

    /**
     * Resolve the storage nodes (and their web-safe HTTP URLs) for a stream.
     * Cached per stream with a TTL; concurrent callers share one resolution.
     *
     * @param {string} streamId - Message stream ID (ends with -1)
     * @param {Object} [options]
     * @param {boolean} [options.force=false] - Bypass the cache
     * @returns {Promise<Array<{nodeAddress: string, urls: string[]}>>} May be empty.
     */
    async resolve(streamId, { force = false } = {}) {
        const ttl = CONFIG.storageMedia.endpointCacheTtlMs;
        const cached = this.cache.get(streamId);
        if (!force && cached && Date.now() - cached.at < ttl) {
            return cached.nodes;
        }

        if (this.inFlight.has(streamId)) {
            return this.inFlight.get(streamId);
        }

        const p = this.resolveUncached(streamId)
            .then((nodes) => {
                this.cache.set(streamId, { at: Date.now(), nodes });
                return nodes;
            })
            .finally(() => this.inFlight.delete(streamId));
        this.inFlight.set(streamId, p);
        return p;
    }

    async resolveUncached(streamId) {
        const client = streamrController.client;
        if (!client) {
            throw new Error('Streamr client not initialized');
        }

        const stream = await client.getStream(streamId);

        // getStorageNodes() has returned different shapes across SDK versions —
        // defensive handling mirrors getStreamStorageInfo() in streamr.js.
        const raw = stream.getStorageNodes();
        let addresses = [];
        if (Array.isArray(raw)) {
            addresses = raw;
        } else if (raw && typeof raw.then === 'function') {
            addresses = await raw;
        } else if (raw && typeof raw[Symbol.asyncIterator] === 'function') {
            for await (const node of raw) addresses.push(node);
        } else if (raw && typeof raw[Symbol.iterator] === 'function') {
            addresses = [...raw];
        }

        const nodes = [];
        for (const address of addresses) {
            try {
                const metadata = await client.getStorageNodeMetadata(address);
                const urls = (Array.isArray(metadata?.urls) ? metadata.urls : [])
                    .filter((u) => typeof u === 'string' && isWebSafeStorageNodeUrl(u))
                    .map(normalizeUrl);
                if (urls.length) {
                    nodes.push({ nodeAddress: String(address).toLowerCase(), urls });
                } else {
                    Logger.debug('Storage node has no web-safe URLs:', address);
                }
            } catch (e) {
                Logger.warn('Storage node metadata read failed:', address, e.message);
            }
        }

        Logger.info(`Storage endpoints for ${streamId.slice(-30)}: ${nodes.length} node(s), ` +
            `${nodes.reduce((n, x) => n + x.urls.length, 0)} URL(s)`);
        return nodes;
    }

    /**
     * Flat rotation list of healthy base URLs for a stream. EVERY healthy URL
     * is a rotation slot — the Pombo cluster registers one node address with
     * two URLs, and taking only the first per node pinned all direct reads to
     * a single server (halved download throughput vs the POC, which
     * round-robined windows across every cluster URL). Slots interleave by URL
     * index so multi-URL nodes and multi-node sets both spread fairly.
     *
     * @param {string} streamId
     * @returns {Promise<string[]>} May be empty (no storage / no web-safe URL / all ejected)
     */
    async rotation(streamId) {
        const nodes = await this.resolve(streamId);
        const limit = CONFIG.storageMedia.nodeFailureLimit;
        const out = [];
        for (let i = 0; ; i++) {
            let any = false;
            for (const node of nodes) {
                const u = node.urls[i];
                if (u === undefined) continue;
                any = true;
                if ((this.failures.get(u) || 0) < limit) out.push(u);
            }
            if (!any) break;
        }
        return out;
    }

    /** Record a failed read against a node URL (ejects after nodeFailureLimit in a row). */
    noteFailure(url) {
        const u = normalizeUrl(url);
        const n = (this.failures.get(u) || 0) + 1;
        this.failures.set(u, n);
        if (n === CONFIG.storageMedia.nodeFailureLimit) {
            Logger.warn(`Storage node ejected from rotation for this session: ${u}`);
        }
    }

    /** Record a successful read (resets the consecutive-failure count). */
    noteSuccess(url) {
        this.failures.delete(normalizeUrl(url));
    }

    /**
     * format=metadata support for a node URL.
     * @returns {boolean|undefined} undefined = not probed yet
     */
    supportsMetaFormat(url) {
        return this.metaFormat.get(normalizeUrl(url));
    }

    setMetaFormatSupport(url, supported) {
        this.metaFormat.set(normalizeUrl(url), !!supported);
    }

    /** Drop the cached node set for a stream (e.g. after add/remove storage node). */
    invalidate(streamId) {
        this.cache.delete(streamId);
    }

    /** Full reset (logout / client re-init). */
    clear() {
        this.cache.clear();
        this.inFlight.clear();
        this.failures.clear();
        this.metaFormat.clear();
    }
}

export const storageEndpoints = new StorageEndpointResolver();
