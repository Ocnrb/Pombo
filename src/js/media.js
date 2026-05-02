/**
 * Media Controller
 * Handles image and video file sharing via Streamr
 * 
 * Image: Direct base64 encoding (for small images)
 * Video: Chunked P2P transfer with hash verification
 */

import { Logger } from './logger.js';
import { cryptoManager } from './crypto.js';
import { streamrController, deriveEphemeralId, STREAM_CONFIG } from './streamr.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { channelManager } from './channels.js';
import { secureStorage } from './secureStorage.js';
import { dmManager } from './dm.js';
import { dmCrypto } from './dmCrypto.js';
import { CONFIG as APP_CONFIG } from './config.js';

// === CONFIGURATION ===
const CONFIG = {
    // Image settings
    IMAGE_MAX_WIDTH: APP_CONFIG.media.imageMaxWidth,
    IMAGE_MAX_HEIGHT: APP_CONFIG.media.imageMaxHeight,
    IMAGE_QUALITY: APP_CONFIG.media.imageQuality,
    IMAGE_MAX_ASSEMBLED_BYTES: APP_CONFIG.media.imageMaxAssembledBytes,
    IMAGE_PAYLOAD_MAX_BYTES: APP_CONFIG.media.imagePayloadMaxBytes,
    IMAGE_PAYLOAD_SAFETY_MARGIN_BYTES: APP_CONFIG.media.imagePayloadSafetyMarginBytes,
    IMAGE_CHUNK_INITIAL_RAW_BYTES: APP_CONFIG.media.imageChunkInitialRawBytes,
    IMAGE_CHUNK_MIN_RAW_BYTES: APP_CONFIG.media.imageChunkMinRawBytes,
    IMAGE_ASSEMBLY_TTL_MS: APP_CONFIG.media.imageAssemblyTtlMs,
    JPEG_INITIAL_QUALITY: APP_CONFIG.media.jpegInitialQuality,
    JPEG_MIN_QUALITY: APP_CONFIG.media.jpegMinQuality,
    WEBP_INITIAL_QUALITY: APP_CONFIG.media.webpInitialQuality,
    WEBP_MIN_QUALITY: APP_CONFIG.media.webpMinQuality,
    IMAGE_RESOLUTION_SCALES: APP_CONFIG.media.imageResolutionScales,
    ALLOW_JPEG_TO_WEBP_FALLBACK: APP_CONFIG.media.allowJpegToWebpFallback,
    FORCE_PNG_TO_WEBP_ON_OVERFLOW: APP_CONFIG.media.forcePngToWebpOnOverflow,
    FAIL_GIF_ON_OVERFLOW: APP_CONFIG.media.failGifOnOverflow,
    LEGACY_IMAGE_READ_ENABLED: APP_CONFIG.media.legacyImageReadEnabled,
    LEGACY_INLINE_IMAGE_WRITE_ENABLED: APP_CONFIG.media.legacyInlineImageWriteEnabled,
    ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    
    // Video/File settings
    // Note: video/quicktime (.mov) is only supported in Safari, not Chrome/Firefox
    // We allow upload but may need to show download link instead of player
    ALLOWED_VIDEO_TYPES: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg'],
    // Browser-playable formats (for showing player vs download link)
    PLAYABLE_VIDEO_TYPES: ['video/mp4', 'video/webm', 'video/ogg', 'video/x-m4v', 'video/m4v'],

    PIECE_SIZE: APP_CONFIG.media.pieceSize,
    PIECE_SEND_DELAY: APP_CONFIG.media.pieceSendDelayMs,
    MAX_CONCURRENT_REQUESTS: APP_CONFIG.media.maxConcurrentRequests,
    CONCURRENT_SENDS: APP_CONFIG.media.concurrentSends || 3,
    PIECE_REQUEST_TIMEOUT: APP_CONFIG.media.pieceRequestTimeoutMs,
    MAX_FILE_SIZE: APP_CONFIG.media.maxFileSize,
    
    // Seeder Discovery settings
    MIN_SEEDERS: APP_CONFIG.media.minSeeders,
    PREFERRED_SEEDERS: APP_CONFIG.media.preferredSeeders,
    SEEDER_REQUEST_INTERVAL: APP_CONFIG.media.seederRequestIntervalMs,
    SEEDER_DISCOVERY_TIMEOUT: APP_CONFIG.media.seederDiscoveryTimeoutMs,
    SEEDER_REFRESH_INTERVAL: APP_CONFIG.media.seederRefreshIntervalMs,
    MAX_SEEDER_REQUESTS: APP_CONFIG.media.maxSeederRequests,
    
    // Seeding Persistence settings
    MAX_SEED_STORAGE: APP_CONFIG.media.maxSeedStorage,
    SEED_FILES_EXPIRE_DAYS: APP_CONFIG.media.seedFilesExpireDays,
    AUTO_SEED_ON_JOIN: true,               // Re-announce as seeder when joining channel
    PERSIST_PUBLIC_CHANNELS: true,         // Persist files from public channels
    PERSIST_PRIVATE_CHANNELS: true,       // Don't persist files from private channels (privacy)
    
    // Push-first settings
    PUSH_WATCHDOG_INTERVAL: APP_CONFIG.media.pushWatchdogIntervalMs,
    PUSH_WATCHDOG_START_DELAY: APP_CONFIG.media.pushWatchdogStartDelayMs,
    PUSH_STALL_TIMEOUT: APP_CONFIG.media.pushStallTimeoutMs
};

// ==================== BINARY PROTOCOL ====================
// Binary encoding for MEDIA_DATA partition (partition 2)
// Format: [1 byte type] [header bytes] [payload]
const BINARY_MSG_TYPE = {
    FILE_PIECE: 0x01
};

const STORED_IMAGE_PROTOCOL_VERSION = 2;
const STORED_IMAGE_TRANSPORT = 'chunked';

function isStoredImageChunkMessage(data) {
    return !!(
        data
        && data.type === 'image_chunk'
        && data.v === STORED_IMAGE_PROTOCOL_VERSION
        && typeof data.imageId === 'string'
        && Number.isInteger(data.chunkIndex)
        && data.chunkIndex >= 0
        && typeof data.chunkHash === 'string'
        && typeof data.data === 'string'
    );
}

function isStoredChunkedImageManifest(data) {
    return !!(
        data
        && data.type === 'image'
        && data.transport === STORED_IMAGE_TRANSPORT
        && data.v === STORED_IMAGE_PROTOCOL_VERSION
        && typeof data.imageId === 'string'
        && Number.isInteger(data.chunkCount)
        && data.chunkCount > 0
        && Array.isArray(data.chunkHashes)
        && data.chunkHashes.length === data.chunkCount
        && typeof data.finalMime === 'string'
        && typeof data.assembledSha256 === 'string'
    );
}

/**
 * Encode a file_piece as Uint8Array for binary transport.
 * Format: [1B type=0x01] [36B fileId UTF-8] [4B pieceIndex uint32BE] [N bytes raw data]
 * @param {string} fileId - File ID (UUID, 36 chars)
 * @param {number} pieceIndex - Piece index
 * @param {ArrayBuffer|Uint8Array} data - Raw piece data
 * @returns {Uint8Array}
 */
function encodeFilePiece(fileId, pieceIndex, data) {
    const fileIdBytes = new TextEncoder().encode(fileId); // 36 bytes for UUID
    const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const buf = new Uint8Array(1 + 36 + 4 + dataBytes.byteLength);
    buf[0] = BINARY_MSG_TYPE.FILE_PIECE;
    buf.set(fileIdBytes.slice(0, 36), 1);
    // pieceIndex as uint32 big-endian at offset 37
    const view = new DataView(buf.buffer);
    view.setUint32(37, pieceIndex, false);
    buf.set(dataBytes, 41);
    return buf;
}

/**
 * Decode a file_piece from binary.
 * @param {Uint8Array} buf - Binary buffer
 * @returns {{ type: string, fileId: string, pieceIndex: number, data: Uint8Array }}
 */
function decodeFilePiece(buf) {
    const fileId = new TextDecoder().decode(buf.slice(1, 37));
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const pieceIndex = view.getUint32(37, false);
    const data = buf.slice(41);
    return { type: 'file_piece', fileId, pieceIndex, data };
}



/**
 * Decode any binary media message.
 * @param {Uint8Array} buf - Binary buffer
 * @returns {Object} Decoded message with type field
 */
function decodeBinaryMedia(buf) {
    if (!buf || buf.length === 0) return null;
    switch (buf[0]) {
        case BINARY_MSG_TYPE.FILE_PIECE: return decodeFilePiece(buf);
        default: return null;
    }
}

class MediaController {
    constructor() {
        // Image cache: imageId -> base64 data (LRU eviction when over byte limit)
        this.imageCache = new Map();
        this.imageCacheBytes = 0;
        this.MAX_IMAGE_CACHE_BYTES = APP_CONFIG.media.maxImageCacheBytes;
        this.pendingImageAssemblies = new Map();
        
        // Local files being seeded: fileId -> { file, metadata, streamId }
        this.localFiles = new Map();
        
        // Downloaded file URLs: fileId -> blob URL
        this.downloadedUrls = new Map();
        
        // Incoming file transfers: fileId -> transfer state
        this.incomingFiles = new Map();
        
        // File seeders: fileId -> Set of seeder IDs
        this.fileSeeders = new Map();
        
        // File worker for hashing
        this.fileWorker = null;
        
        // Event handlers
        this.handlers = {
            onImageReceived: null,
            onFileAnnounced: null,
            onFileProgress: null,
            onFileComplete: null,
            onSeederUpdate: null
        };
        
        // IndexedDB for large file storage
        this.db = null;
        
        // Track total persisted storage size
        this.persistedStorageSize = 0;
        
        // Current owner address (for filtering seed files)
        this.currentOwnerAddress = null;
        
        // Piece send queue for throttling
        this.pieceSendQueue = [];
        this.activeSends = 0;
        this.lastPieceSentTime = 0;
        
        // Track files currently being push-sent (prevent duplicate pushes)
        this.activePushes = new Set();
    }

    /**
     * Initialize media controller
     */
    async init() {
        await this.initIndexedDB();
        this.initFileWorker();
        // Note: Don't load seed files here - wait for wallet connection
        // await this.loadPersistedSeedFiles(); 
        Logger.info('Media controller initialized (waiting for wallet connection)');
    }

    /**
     * Set owner address and load their seed files
     * Called when wallet connects
     * @param {string} address - Wallet address
     */
    async setOwner(address) {
        this.currentOwnerAddress = address?.toLowerCase() || null;
        
        if (this.currentOwnerAddress) {
            await this.loadPersistedSeedFiles();
            Logger.info('Media controller: owner set to', this.currentOwnerAddress.slice(0, 8) + '...');
        }
    }

    /**
     * Reset all in-memory state (on disconnect)
     * Does NOT clear persisted files - just unloads from memory
     */
    reset() {
        // Cancel any pending download timers first
        for (const [fileId, transfer] of this.incomingFiles) {
            if (transfer.seederDiscoveryTimer) {
                clearTimeout(transfer.seederDiscoveryTimer);
            }
            if (transfer.pushWatchdogTimer) {
                clearTimeout(transfer.pushWatchdogTimer);
            }
            // Also clear any piece request timeouts
            if (transfer.requestsInFlight) {
                for (const [pieceIndex, request] of transfer.requestsInFlight) {
                    if (request.timeoutId) {
                        clearTimeout(request.timeoutId);
                    }
                }
            }
        }
        
        // Revoke all blob URLs to prevent memory leaks
        for (const url of this.downloadedUrls.values()) {
            URL.revokeObjectURL(url);
        }
        
        // Clear all maps
        this.imageCache.clear();
        this.imageCacheBytes = 0;
        for (const pending of this.pendingImageAssemblies.values()) {
            if (pending.timerId) {
                clearTimeout(pending.timerId);
            }
        }
        this.pendingImageAssemblies.clear();
        this.localFiles.clear();
        this.downloadedUrls.clear();
        this.incomingFiles.clear();
        this.fileSeeders.clear();
        
        // Clear piece send queue
        this.pieceSendQueue = [];
        this.activeSends = 0;
        this.lastPieceSentTime = 0;
        this.activePushes.clear();
        
        // Reset owner
        this.currentOwnerAddress = null;
        this.persistedStorageSize = 0;
        
        Logger.info('Media controller reset');
    }

    /**
     * Get ECDH AES key for DM channels (for encrypting media on -2).
     * Returns null for non-DM channels (password encryption handled separately).
     * @param {string} messageStreamId - Channel message stream ID
     * @returns {Promise<CryptoKey|null>}
     */
    async _getDMMediaKey(messageStreamId) {
        const channel = channelManager.getChannel(messageStreamId);
        if (channel?.type !== 'dm' || !channel.peerAddress) return null;

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) return null;

        const peerPubKey = await dmManager.getPeerPublicKey(channel.peerAddress);
        if (!peerPubKey) return null;

        return dmCrypto.getSharedKey(privateKey, channel.peerAddress, peerPubKey);
    }

    /**
     * Initialize IndexedDB for file storage (v2 with seedFiles)
     */
    async initIndexedDB() {
        return new Promise((resolve, reject) => {
            // Upgrade to version 2 for seedFiles store
            const request = indexedDB.open('PomboMediaDB', 2);
            
            request.onerror = () => {
                Logger.warn('IndexedDB not available, using memory only');
                resolve();
            };
            
            request.onsuccess = (event) => {
                this.db = event.target.result;
                Logger.debug('IndexedDB initialized (v2)');
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // v1: pieces store for temporary download storage
                if (!db.objectStoreNames.contains('pieces')) {
                    db.createObjectStore('pieces', { keyPath: ['fileId', 'pieceIndex'] });
                }
                
                // v2: seedFiles store for persistent seeding
                if (!db.objectStoreNames.contains('seedFiles')) {
                    const seedStore = db.createObjectStore('seedFiles', { keyPath: 'fileId' });
                    seedStore.createIndex('streamId', 'streamId', { unique: false });
                    seedStore.createIndex('timestamp', 'timestamp', { unique: false });
                }
                
                Logger.info('IndexedDB upgraded to v2 with seedFiles store');
            };
        });
    }

    /**
     * Initialize Web Worker for file hashing
     */
    initFileWorker() {
        const workerCode = `
            async function calculateSHA256(buffer) {
                const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            }

            self.onmessage = async (event) => {
                const { fileData, tempId } = event.data;
                const PIECE_SIZE = ${CONFIG.PIECE_SIZE};
                const pieceHashes = [];
                
                const arrayBuffer = await fileData.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);
                
                // Process file in chunks
                for (let offset = 0; offset < bytes.length; offset += PIECE_SIZE) {
                    const chunk = bytes.slice(offset, Math.min(offset + PIECE_SIZE, bytes.length));
                    const hash = await calculateSHA256(chunk.buffer);
                    pieceHashes.push(hash);
                }

                const metadata = {
                    fileId: crypto.randomUUID(),
                    fileName: fileData.name,
                    fileSize: fileData.size,
                    fileType: fileData.type,
                    pieceCount: pieceHashes.length,
                    pieceHashes: pieceHashes
                };
                
                self.postMessage({ status: 'complete', metadata, tempId });
            };
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.fileWorker = new Worker(URL.createObjectURL(blob));
        
        this.fileWorker.onmessage = (event) => {
            this.handleWorkerMessage(event.data);
        };
        
        this.fileWorker.onerror = (error) => {
            Logger.error('File worker error:', error);
        };
    }

    /**
     * Handle message from file worker
     */
    async handleWorkerMessage(data) {
        const { status, metadata, tempId } = data;
        
        if (status === 'complete') {
            const tempRef = this.localFiles.get(tempId);
            if (!tempRef) {
                Logger.error('Could not find temp file reference:', tempId);
                return;
            }
            
            // Move from temp to final
            this.localFiles.delete(tempId);
            this.localFiles.set(metadata.fileId, {
                file: tempRef.file,
                metadata,
                streamId: tempRef.streamId,
                isPrivateChannel: tempRef.isPrivateChannel,
                persisted: false,
                callback: tempRef.callback
            });
            
            // Trigger callback to announce file
            if (tempRef.callback) {
                await tempRef.callback(metadata);
            }
            
            // Lazy-subscribe to media partitions P1+P2 (sender needs P1 to receive piece_requests)
            if (tempRef.streamId) {
                const ephemeralStreamId = deriveEphemeralId(tempRef.streamId);
                await streamrController.ensureMediaSubscription(ephemeralStreamId);
            }
            
            // Persist for seeding across sessions (after announcement)
            if (tempRef.streamId) {
                const persisted = await this.persistSeedFile(
                    metadata.fileId,
                    tempRef.file,
                    metadata,
                    tempRef.streamId,
                    tempRef.isPrivateChannel
                );
                if (persisted) {
                    const localFile = this.localFiles.get(metadata.fileId);
                    if (localFile) localFile.persisted = true;
                }
            }
        }
    }

    // ==================== IMAGE HANDLING ====================

    /**
     * Send an image
     * @param {string} messageStreamId - Channel message stream ID
     * @param {File} file - Image file
     * @param {string} password - Channel password (optional)
     * @returns {Promise<Object>} - Image message info
     */
    async sendImage(messageStreamId, file, password = null) {
        if (CONFIG.LEGACY_INLINE_IMAGE_WRITE_ENABLED) {
            return this.sendLegacyInlineImage(messageStreamId, file, password);
        }

        // Validate file type
        if (!CONFIG.ALLOWED_IMAGE_TYPES.includes(file.type)) {
            throw new Error(`Invalid image type. Allowed: ${CONFIG.ALLOWED_IMAGE_TYPES.join(', ')}`);
        }

        const channel = channelManager.getChannel(messageStreamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        let dmAesKey = null;
        if (channel.type === 'dm' && channel.peerAddress) {
            const privateKey = authManager.wallet?.privateKey;
            if (!privateKey) {
                throw new Error('Cannot send DM image: wallet private key not available');
            }
            const peerPubKey = await dmManager.getPeerPublicKey(channel.peerAddress);
            if (!peerPubKey) {
                throw new Error('Cannot send DM image: peer public key not available');
            }
            dmAesKey = await dmCrypto.getSharedKey(privateKey, channel.peerAddress, peerPubKey);
            if (typeof streamrController.setDMPublishKey === 'function') {
                await streamrController.setDMPublishKey(messageStreamId);
            }
        }

        const prepared = await this.prepareImageForStoredTransport(file);
        const imageId = crypto.randomUUID();
        const finalDataUrl = await this.blobToDataURL(prepared.blob);
        const chunkPayloads = await this.createStoredImageChunkPayloads({
            imageId,
            blob: prepared.blob,
            password,
            dmAesKey
        });

        const manifest = await this.createSignedStoredImageManifest({
            imageId,
            channelId: messageStreamId,
            originalMime: prepared.originalMime,
            finalMime: prepared.finalMime,
            finalSizeBytes: prepared.blob.size,
            chunkCount: chunkPayloads.length,
            chunkHashes: chunkPayloads.map(chunk => chunk.chunkHash),
            assembledSha256: prepared.sha256,
            preservedOriginal: prepared.preservedOriginal,
            convertedTo: prepared.convertedTo,
            qualityUsed: prepared.qualityUsed
        });

        await this.assertStoredImagePayloadFits(manifest, password, dmAesKey, 'image manifest');

        for (const chunkPayload of chunkPayloads) {
            await this.publishStoredImagePayload(messageStreamId, chunkPayload, password, dmAesKey);
        }
        await this.publishStoredImagePayload(messageStreamId, manifest, password, dmAesKey);

        this.cacheImage(imageId, finalDataUrl);

        const localMessage = {
            ...manifest,
            imageData: finalDataUrl,
            verified: {
                valid: true,
                trustLevel: await identityManager.getTrustLevel(manifest.sender)
            }
        };

        channel.messages.push(localMessage);
        channelManager.notifyHandlers('message', { streamId: messageStreamId, message: localMessage });

        if (channel.type === 'dm' || channel.writeOnly) {
            await secureStorage.addSentMessage(messageStreamId, localMessage);
        }

        Logger.debug('Chunked image message sent:', imageId, {
            chunkCount: manifest.chunkCount,
            finalMime: manifest.finalMime,
            originalMime: manifest.originalMime,
            finalSizeBytes: manifest.finalSizeBytes
        });

        return {
            messageId: manifest.id,
            imageId,
            data: finalDataUrl,
            originalMime: manifest.originalMime,
            finalMime: manifest.finalMime,
            preservedOriginal: manifest.preservedOriginal,
            convertedTo: manifest.convertedTo,
            chunkCount: manifest.chunkCount,
            finalSizeBytes: manifest.finalSizeBytes
        };
    }

    async sendLegacyInlineImage(messageStreamId, file, password = null) {
        // Validate file type
        if (!CONFIG.ALLOWED_IMAGE_TYPES.includes(file.type)) {
            throw new Error(`Invalid image type. Allowed: ${CONFIG.ALLOWED_IMAGE_TYPES.join(', ')}`);
        }

        // Resize and convert to base64
        const base64Data = await this.resizeImage(file);
        
        // Generate image ID
        const imageId = crypto.randomUUID();
        
        // Cache locally
        this.imageCache.set(imageId, base64Data);
        this.imageCacheBytes += base64Data.length * 2;
        this.evictImageCacheIfNeeded();
        
        // Create image message with data embedded (so storage backends can persist it)
        // This goes to messageStream so it's stored and retrievable from history
        const announcement = await identityManager.createSignedMessage('', messageStreamId);
        announcement.type = 'image';
        announcement.imageId = imageId;
        announcement.imageData = base64Data; // Include data for persistence
        // Keep the id from createSignedMessage (signed)
        const messageId = announcement.id;
        
        // Add verification info for local display
        announcement.verified = {
            valid: true,
            trustLevel: await identityManager.getTrustLevel(announcement.sender)
        };
        
        // Add to local channel messages & notify UI immediately (for sender)
        const channel = channelManager.getChannel(messageStreamId);
        if (channel) {
            channel.messages.push(announcement);
            channelManager.notifyHandlers('message', { streamId: messageStreamId, message: announcement });
        }
        
        // DM channels: E2E encrypt and always persist locally
        if (channel?.type === 'dm' && channel.peerAddress) {
            const privateKey = authManager.wallet?.privateKey;
            if (!privateKey) {
                throw new Error('Cannot send DM image: wallet private key not available');
            }
            const peerPubKey = await dmManager.getPeerPublicKey(channel.peerAddress);
            if (!peerPubKey) {
                throw new Error('Cannot send DM image: peer public key not available');
            }
            const aesKey = await dmCrypto.getSharedKey(privateKey, channel.peerAddress, peerPubKey);
            const { verified, ...cleanAnnouncement } = announcement;
            const encrypted = await dmCrypto.encrypt(cleanAnnouncement, aesKey);
            await streamrController.publishMessage(messageStreamId, encrypted, null);
            await secureStorage.addSentMessage(messageStreamId, announcement);
        } else {
            // Regular channels: publish with optional Streamr-level encryption
            await streamrController.publishMessage(messageStreamId, announcement, password);
            // Persist locally for write-only channels
            if (channel?.writeOnly) {
                await secureStorage.addSentMessage(messageStreamId, announcement);
            }
        }
        
        Logger.debug('Legacy inline image message sent with data:', imageId);
        
        return { messageId, imageId, data: base64Data };
    }

    isStoredImageChunkMessage(data) {
        return isStoredImageChunkMessage(data);
    }

    isStoredChunkedImageManifest(data) {
        return isStoredChunkedImageManifest(data);
    }

    async registerStoredImageChunk(messageStreamId, chunk) {
        if (!isStoredImageChunkMessage(chunk)) {
            return false;
        }

        const pending = this.getOrCreatePendingImageAssembly(chunk.imageId, messageStreamId);
        const existing = pending.chunks.get(chunk.chunkIndex);
        if (!existing || existing.chunkHash !== chunk.chunkHash) {
            pending.chunks.set(chunk.chunkIndex, {
                chunkHash: chunk.chunkHash,
                data: chunk.data,
                timestamp: chunk.timestamp || Date.now()
            });
        }

        this.tryAssembleStoredImage(chunk.imageId).catch(error => {
            Logger.debug('Stored image chunk assembly deferred:', error?.message || error);
        });
        return true;
    }

    async registerStoredImageManifest(messageStreamId, manifest) {
        if (!isStoredChunkedImageManifest(manifest)) {
            return false;
        }

        const pending = this.getOrCreatePendingImageAssembly(manifest.imageId, messageStreamId);
        pending.manifest = manifest;
        pending.streamId = messageStreamId;

        await this.tryAssembleStoredImage(manifest.imageId);
        return true;
    }

    getOrCreatePendingImageAssembly(imageId, streamId = null) {
        let pending = this.pendingImageAssemblies.get(imageId);
        if (!pending) {
            pending = {
                streamId,
                manifest: null,
                chunks: new Map(),
                timerId: null
            };
            this.pendingImageAssemblies.set(imageId, pending);
        }
        if (streamId && !pending.streamId) {
            pending.streamId = streamId;
        }
        this.schedulePendingImageAssemblyExpiry(imageId, pending);
        return pending;
    }

    schedulePendingImageAssemblyExpiry(imageId, pending) {
        if (pending.timerId) {
            clearTimeout(pending.timerId);
        }
        pending.timerId = setTimeout(() => {
            this.clearPendingImageAssembly(imageId);
        }, CONFIG.IMAGE_ASSEMBLY_TTL_MS);
    }

    clearPendingImageAssembly(imageId) {
        const pending = this.pendingImageAssemblies.get(imageId);
        if (pending?.timerId) {
            clearTimeout(pending.timerId);
        }
        this.pendingImageAssemblies.delete(imageId);
    }

    async tryAssembleStoredImage(imageId) {
        const pending = this.pendingImageAssemblies.get(imageId);
        if (!pending?.manifest) {
            return false;
        }
        if (this.imageCache.has(imageId)) {
            this.clearPendingImageAssembly(imageId);
            return true;
        }

        const { manifest, chunks, streamId } = pending;
        if (chunks.size < manifest.chunkCount) {
            return false;
        }

        const chunkBuffers = [];
        let totalBytes = 0;

        for (let chunkIndex = 0; chunkIndex < manifest.chunkCount; chunkIndex++) {
            const expectedHash = manifest.chunkHashes[chunkIndex];
            const chunk = chunks.get(chunkIndex);
            if (!chunk || chunk.chunkHash !== expectedHash) {
                return false;
            }

            const chunkBuffer = this.base64ToArrayBuffer(chunk.data);
            if (!chunkBuffer) {
                Logger.warn('Stored image chunk decode failed:', imageId, chunkIndex);
                return false;
            }

            const actualHash = await this.sha256(chunkBuffer);
            if (actualHash !== expectedHash) {
                Logger.warn('Stored image chunk hash mismatch:', imageId, chunkIndex);
                chunks.delete(chunkIndex);
                return false;
            }

            const chunkBytes = new Uint8Array(chunkBuffer);
            chunkBuffers.push(chunkBytes);
            totalBytes += chunkBytes.byteLength;
        }

        if (totalBytes !== manifest.finalSizeBytes || totalBytes > CONFIG.IMAGE_MAX_ASSEMBLED_BYTES) {
            Logger.warn('Stored image assembled size mismatch:', imageId, totalBytes, manifest.finalSizeBytes);
            return false;
        }

        const assembledBytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunkBytes of chunkBuffers) {
            assembledBytes.set(chunkBytes, offset);
            offset += chunkBytes.byteLength;
        }

        const assembledHash = await this.sha256(assembledBytes.buffer);
        if (assembledHash !== manifest.assembledSha256) {
            Logger.warn('Stored image assembled hash mismatch:', imageId);
            return false;
        }

        const dataUrl = await this.bytesToDataURL(assembledBytes, manifest.finalMime);
        this.handleImageData({ type: 'image_data', imageId, data: dataUrl });

        if (streamId) {
            try {
                await secureStorage.saveImageToLedger(imageId, dataUrl, streamId);
            } catch (error) {
                Logger.debug('Stored image ledger save skipped:', error?.message || error);
            }
        }

        this.clearPendingImageAssembly(imageId);
        return true;
    }

    async prepareImageForStoredTransport(file) {
        const originalMime = String(file.type || '').toLowerCase();
        if (!originalMime) {
            throw new Error('Image MIME type is required');
        }

        if (file.size <= CONFIG.IMAGE_MAX_ASSEMBLED_BYTES) {
            const originalBytes = await this.blobToArrayBuffer(file);
            return {
                blob: file,
                originalMime,
                finalMime: originalMime,
                preservedOriginal: true,
                convertedTo: null,
                qualityUsed: null,
                sha256: await this.sha256(originalBytes)
            };
        }

        if (originalMime === 'image/gif' && CONFIG.FAIL_GIF_ON_OVERFLOW) {
            throw new Error('GIF image exceeds 1MB and cannot be compressed without losing animation');
        }

        const image = await this.loadImageFromBlob(file);
        let encoded = null;

        if (originalMime === 'image/jpeg' || originalMime === 'image/jpg') {
            encoded = await this.compressImageToTarget(image, 'image/jpeg', {
                initialQuality: CONFIG.JPEG_INITIAL_QUALITY,
                minQuality: CONFIG.JPEG_MIN_QUALITY
            });

            if (!encoded && CONFIG.ALLOW_JPEG_TO_WEBP_FALLBACK) {
                encoded = await this.compressImageToTarget(image, 'image/webp', {
                    initialQuality: CONFIG.WEBP_INITIAL_QUALITY,
                    minQuality: CONFIG.WEBP_MIN_QUALITY
                });
            }
        } else if (originalMime === 'image/webp') {
            encoded = await this.compressImageToTarget(image, 'image/webp', {
                initialQuality: CONFIG.WEBP_INITIAL_QUALITY,
                minQuality: CONFIG.WEBP_MIN_QUALITY
            });
        } else if (originalMime === 'image/png' && CONFIG.FORCE_PNG_TO_WEBP_ON_OVERFLOW) {
            encoded = await this.compressImageToTarget(image, 'image/webp', {
                initialQuality: CONFIG.WEBP_INITIAL_QUALITY,
                minQuality: CONFIG.WEBP_MIN_QUALITY
            });
        }

        if (!encoded) {
            throw new Error(`Failed to fit ${originalMime} image under 1MB`);
        }

        const encodedBytes = await this.blobToArrayBuffer(encoded.blob);
        return {
            blob: encoded.blob,
            originalMime,
            finalMime: encoded.mime,
            preservedOriginal: false,
            convertedTo: encoded.mime !== originalMime ? encoded.mime : null,
            qualityUsed: encoded.quality,
            sha256: await this.sha256(encodedBytes)
        };
    }

    async compressImageToTarget(image, outputMime, { initialQuality, minQuality }) {
        if (!this.supportsCanvasMime(outputMime)) {
            return null;
        }

        const limit = CONFIG.IMAGE_MAX_ASSEMBLED_BYTES;
        const maxQuality = Number(Math.min(1, Math.max(initialQuality, minQuality)).toFixed(3));
        const minQ = Number(minQuality.toFixed(3));

        for (const scale of CONFIG.IMAGE_RESOLUTION_SCALES) {
            const minBlob = await this.encodeImageToBlob(image, outputMime, minQ, scale);
            if (minBlob.size > limit) {
                continue;
            }

            const maxBlob = await this.encodeImageToBlob(image, outputMime, maxQuality, scale);
            if (maxBlob.size <= limit) {
                return { blob: maxBlob, mime: outputMime, quality: maxQuality };
            }

            let lo = minQ;
            let hi = maxQuality;
            let best = { blob: minBlob, quality: minQ };
            for (let i = 0; i < 6; i += 1) {
                const mid = Number(((lo + hi) / 2).toFixed(3));
                if (mid <= lo || mid >= hi) {
                    break;
                }
                const blob = await this.encodeImageToBlob(image, outputMime, mid, scale);
                if (blob.size <= limit) {
                    if (blob.size > best.blob.size) {
                        best = { blob, quality: mid };
                    }
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            return { blob: best.blob, mime: outputMime, quality: best.quality };
        }

        return null;
    }

    async encodeImageToBlob(image, outputMime, quality = null, scale = 1) {
        const sourceWidth = image?.naturalWidth || image?.width;
        const sourceHeight = image?.naturalHeight || image?.height;
        if (!sourceWidth || !sourceHeight) {
            throw new Error('Image dimensions unavailable');
        }

        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas 2D context unavailable');
        }

        if (outputMime === 'image/jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(image, 0, 0, width, height);

        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error(`Failed to encode image as ${outputMime}`));
                    return;
                }
                if (blob.type !== outputMime) {
                    reject(new Error(`${outputMime} encoding is not supported in this browser`));
                    return;
                }
                resolve(blob);
            }, outputMime, quality ?? undefined);
        });
    }

    supportsCanvasMime(mime) {
        const canvas = document.createElement('canvas');
        return canvas.toDataURL(mime).startsWith(`data:${mime}`);
    }

    loadImageFromBlob(blob) {
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const image = new Image();
            image.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve(image);
            };
            image.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('Failed to decode image'));
            };
            image.src = objectUrl;
        });
    }

    async createStoredImageChunkPayloads({ imageId, blob, password = null, dmAesKey = null }) {
        const sourceBytes = new Uint8Array(await this.blobToArrayBuffer(blob));
        const payloadLimit = Math.max(
            1024,
            CONFIG.IMAGE_PAYLOAD_MAX_BYTES - CONFIG.IMAGE_PAYLOAD_SAFETY_MARGIN_BYTES
        );
        const chunkPayloads = [];
        let offset = 0;
        let chunkIndex = 0;

        while (offset < sourceBytes.byteLength) {
            const remainingBytes = sourceBytes.byteLength - offset;
            const minRawChunkBytes = Math.min(CONFIG.IMAGE_CHUNK_MIN_RAW_BYTES, remainingBytes);
            let rawChunkBytes = Math.min(CONFIG.IMAGE_CHUNK_INITIAL_RAW_BYTES, remainingBytes);
            let payload = null;

            while (rawChunkBytes >= minRawChunkBytes) {
                const chunkBytes = sourceBytes.slice(offset, offset + rawChunkBytes);
                const candidate = {
                    type: 'image_chunk',
                    v: STORED_IMAGE_PROTOCOL_VERSION,
                    imageId,
                    chunkIndex,
                    timestamp: Date.now(),
                    chunkHash: await this.sha256(chunkBytes.buffer),
                    data: this.arrayBufferToBase64(chunkBytes)
                };

                const payloadBytes = await this.measureStoredImagePayloadBytes(candidate, password, dmAesKey);
                if (payloadBytes <= payloadLimit) {
                    payload = candidate;
                    offset += rawChunkBytes;
                    break;
                }

                const nextChunkBytes = Math.max(
                    minRawChunkBytes,
                    Math.floor(rawChunkBytes * 0.85)
                );
                if (nextChunkBytes === rawChunkBytes) {
                    if (rawChunkBytes === minRawChunkBytes) {
                        break;
                    }
                    rawChunkBytes -= 1;
                } else {
                    rawChunkBytes = nextChunkBytes;
                }
            }

            if (!payload) {
                throw new Error('Failed to fit image chunk inside 220KB payload limit');
            }

            chunkPayloads.push(payload);
            chunkIndex++;
        }

        return chunkPayloads;
    }

    async measureStoredImagePayloadBytes(payload, password = null, dmAesKey = null) {
        if (dmAesKey) {
            const encryptedPayload = await dmCrypto.encrypt(payload, dmAesKey);
            return new TextEncoder().encode(JSON.stringify(encryptedPayload)).length;
        }

        if (password) {
            const encryptedPayload = await cryptoManager.encryptJSON(payload, password);
            return new TextEncoder().encode(encryptedPayload).length;
        }

        return new TextEncoder().encode(JSON.stringify(payload)).length;
    }

    async assertStoredImagePayloadFits(payload, password = null, dmAesKey = null, label = 'image payload') {
        const payloadBytes = await this.measureStoredImagePayloadBytes(payload, password, dmAesKey);
        if (payloadBytes > CONFIG.IMAGE_PAYLOAD_MAX_BYTES) {
            throw new Error(`${label} exceeds ${Math.round(CONFIG.IMAGE_PAYLOAD_MAX_BYTES / 1024)}KB payload limit`);
        }
        return payloadBytes;
    }

    async publishStoredImagePayload(messageStreamId, payload, password = null, dmAesKey = null) {
        await this.assertStoredImagePayloadFits(payload, password, dmAesKey);

        if (dmAesKey) {
            const encryptedPayload = await dmCrypto.encrypt(payload, dmAesKey);
            await streamrController.publishMessage(messageStreamId, encryptedPayload, null);
            return;
        }

        await streamrController.publishMessage(messageStreamId, payload, password);
    }

    blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read blob as data URL'));
            reader.readAsDataURL(blob);
        });
    }

    async blobToArrayBuffer(blob) {
        if (blob?.arrayBuffer instanceof Function) {
            const result = await blob.arrayBuffer();
            if (result instanceof ArrayBuffer) {
                return result;
            }
            if (ArrayBuffer.isView(result)) {
                return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
            }
        }

        if (typeof Response === 'function') {
            try {
                return await new Response(blob).arrayBuffer();
            } catch {
                // Fall through to FileReader.
            }
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                if (reader.result instanceof ArrayBuffer) {
                    resolve(reader.result);
                    return;
                }
                reject(new Error('Failed to read blob as ArrayBuffer'));
            };
            reader.onerror = () => reject(new Error('Failed to read blob as ArrayBuffer'));
            reader.readAsArrayBuffer(blob);
        });
    }

    async createSignedStoredImageManifest(input) {
        if (typeof identityManager.createSignedImageManifest === 'function') {
            return identityManager.createSignedImageManifest(input);
        }

        Logger.warn('identityManager.createSignedImageManifest missing; falling back to legacy message signing');
        const manifest = await identityManager.createSignedMessage('', input.channelId);
        manifest.type = 'image';
        manifest.transport = STORED_IMAGE_TRANSPORT;
        manifest.v = STORED_IMAGE_PROTOCOL_VERSION;
        manifest.imageId = input.imageId;
        manifest.originalMime = input.originalMime;
        manifest.finalMime = input.finalMime;
        manifest.finalSizeBytes = input.finalSizeBytes;
        manifest.chunkCount = input.chunkCount;
        manifest.chunkHashes = input.chunkHashes;
        manifest.assembledSha256 = input.assembledSha256;
        manifest.preservedOriginal = !!input.preservedOriginal;
        manifest.convertedTo = input.convertedTo || null;
        manifest.qualityUsed = Number.isFinite(input.qualityUsed) ? input.qualityUsed : null;
        return manifest;
    }

    async bytesToDataURL(bytes, mime) {
        const blob = new Blob([bytes], { type: mime });
        return this.blobToDataURL(blob);
    }

    /**
     * Legacy inline image resize helper
     * @param {File} file - Image file
     * @returns {Promise<string>} - Base64 data URL
     */
    resizeImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const img = new Image();
                
                img.onload = () => {
                    let { width, height } = img;
                    
                    // Calculate scale if resize needed
                    if (width > CONFIG.IMAGE_MAX_WIDTH || height > CONFIG.IMAGE_MAX_HEIGHT) {
                        const scaleW = CONFIG.IMAGE_MAX_WIDTH / width;
                        const scaleH = CONFIG.IMAGE_MAX_HEIGHT / height;
                        const scale = Math.min(scaleW, scaleH);
                        width = Math.round(width * scale);
                        height = Math.round(height * scale);
                    }
                    
                    // Always re-encode through canvas as JPEG to ensure
                    // consistent format and size (PNGs/WebPs can be huge)
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    // Convert to JPEG
                    resolve(canvas.toDataURL('image/jpeg', CONFIG.IMAGE_QUALITY));
                };
                
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target.result;
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Load an image file into an HTMLImageElement for cropping / preview.
     * Preserves the original alpha-capability decision so callers can render
     * previews and final uploads with the same output format.
     *
     * @param {File} file - Source image file (jpg/png/gif/webp)
     * @returns {Promise<{ image: HTMLImageElement, preserveAlpha: boolean, src: string }>}
     */
    loadImageForCrop(file) {
        return new Promise((resolve, reject) => {
            if (!CONFIG.ALLOWED_IMAGE_TYPES.includes(file.type)) {
                reject(new Error(`Invalid image type. Allowed: ${CONFIG.ALLOWED_IMAGE_TYPES.join(', ')}`));
                return;
            }

            const preserveAlpha = file.type !== 'image/jpeg' && file.type !== 'image/jpg';
            const reader = new FileReader();
            reader.onload = (e) => {
                const src = e.target?.result;
                const img = new Image();
                img.onload = () => resolve({ image: img, preserveAlpha, src });
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = src;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Calculate the square crop framing for a given image size, viewport,
     * zoom factor, and crop center. Used by both the interactive preview and
     * the final encoded upload so they stay pixel-accurate.
     *
     * @param {number} imageWidth - Source image width in px
     * @param {number} imageHeight - Source image height in px
     * @param {number} viewportSize - Square viewport/output size in px
     * @param {number} [zoom=1] - Zoom multiplier, where 1 is the minimum cover fit
     * @param {number|null} [centerX=null] - Crop center X in source-image pixels
     * @param {number|null} [centerY=null] - Crop center Y in source-image pixels
     * @returns {{
     *   zoom: number,
     *   scale: number,
     *   centerX: number,
     *   centerY: number,
     *   minCenterX: number,
     *   maxCenterX: number,
     *   minCenterY: number,
     *   maxCenterY: number,
     *   drawWidth: number,
     *   drawHeight: number,
     *   offsetX: number,
     *   offsetY: number
     * }}
     */
    getSquareCropFrame(imageWidth, imageHeight, viewportSize, zoom = 1, centerX = null, centerY = null) {
        const safeWidth = Number(imageWidth) || 0;
        const safeHeight = Number(imageHeight) || 0;
        const safeViewport = Number(viewportSize) || 0;
        if (!safeWidth || !safeHeight || !safeViewport) {
            throw new Error('Invalid crop frame dimensions');
        }

        const safeZoom = Math.max(0.5, Number.isFinite(zoom) ? zoom : 1);
        const baseScale = safeViewport / Math.min(safeWidth, safeHeight);
        const scale = baseScale * safeZoom;
        const halfViewportInImage = safeViewport / (2 * scale);

        const minCenterX = Math.min(halfViewportInImage, safeWidth - halfViewportInImage);
        const maxCenterX = Math.max(halfViewportInImage, safeWidth - halfViewportInImage);
        const minCenterY = Math.min(halfViewportInImage, safeHeight - halfViewportInImage);
        const maxCenterY = Math.max(halfViewportInImage, safeHeight - halfViewportInImage);

        const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
        const resolvedCenterX = clamp(centerX ?? safeWidth / 2, minCenterX, maxCenterX);
        const resolvedCenterY = clamp(centerY ?? safeHeight / 2, minCenterY, maxCenterY);
        const drawWidth = safeWidth * scale;
        const drawHeight = safeHeight * scale;
        const offsetX = (safeViewport / 2) - (resolvedCenterX * scale);
        const offsetY = (safeViewport / 2) - (resolvedCenterY * scale);

        return {
            zoom: safeZoom,
            scale,
            centerX: resolvedCenterX,
            centerY: resolvedCenterY,
            minCenterX,
            maxCenterX,
            minCenterY,
            maxCenterY,
            drawWidth,
            drawHeight,
            offsetX,
            offsetY
        };
    }

    /**
     * Render an image into a square crop output using an optional zoom/center.
     *
     * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} image - Source image
     * @param {Object} [options]
     * @param {number} [options.size=512] - Output side length in px
     * @param {number} [options.quality=0.85] - JPEG quality 0..1 (ignored for PNG)
     * @param {number} [options.zoom=1] - Zoom multiplier, where 1 is minimum cover fit
     * @param {number|null} [options.centerX=null] - Crop center X in source pixels
     * @param {number|null} [options.centerY=null] - Crop center Y in source pixels
     * @param {boolean} [options.preserveAlpha=false] - Whether to emit PNG instead of JPEG
     * @returns {string} - data:image/(jpeg|png);base64,... URL
     */
    renderSquareCrop(image, {
        size = 512,
        quality = 0.85,
        zoom = 1,
        centerX = null,
        centerY = null,
        preserveAlpha = false
    } = {}) {
        const width = image?.naturalWidth || image?.videoWidth || image?.width;
        const height = image?.naturalHeight || image?.videoHeight || image?.height;
        const frame = this.getSquareCropFrame(width, height, size, zoom, centerX, centerY);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        if (!preserveAlpha) {
            // JPEG output: paint white baseline so any source alpha doesn't
            // bleed through as black.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);
        }

        ctx.drawImage(image, frame.offsetX, frame.offsetY, frame.drawWidth, frame.drawHeight);
        return preserveAlpha
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', quality);
    }

    /**
     * Center-crop image to square and re-encode at fixed size.
     * Preserves transparency for source formats that support alpha
     * (PNG / WebP / GIF) by emitting PNG; opaque sources (JPEG) are
     * re-encoded as JPEG for smaller payloads.
     *
     * @param {File} file - Source image file (jpg/png/gif/webp)
     * @param {number} [size=512] - Output side length in px
     * @param {number} [quality=0.85] - JPEG quality 0..1 (ignored for PNG)
     * @returns {Promise<string>} - data:image/(jpeg|png);base64,... URL
     */
    cropAndResizeSquare(file, size = 512, quality = 0.85) {
        return this.loadImageForCrop(file)
            .then(({ image, preserveAlpha }) => this.renderSquareCrop(image, {
                size,
                quality,
                preserveAlpha
            }));
    }

    /**
     * Handle incoming image data
     * @param {Object} data - Image data message
     */
    handleImageData(data) {
        if (data.type !== 'image_data' || !data.imageId || !data.data) {
            return;
        }
        
        // Cache the image
        this.imageCache.set(data.imageId, data.data);
        this.imageCacheBytes += data.data.length * 2;
        this.evictImageCacheIfNeeded();
        Logger.debug('Image received:', data.imageId);
        
        // Notify handlers
        if (this.handlers.onImageReceived) {
            this.handlers.onImageReceived(data.imageId, data.data);
        }
    }

    /**
     * Get cached image data
     * @param {string} imageId - Image ID
     * @returns {string|null} - Base64 data or null
     */
    getImage(imageId) {
        return this.imageCache.get(imageId) || null;
    }

    /**
     * Cache image data
     * @param {string} imageId - Image ID
     * @param {string} data - Base64 image data
     */
    cacheImage(imageId, data) {
        if (!this.imageCache.has(imageId)) {
            this.imageCache.set(imageId, data);
            this.imageCacheBytes += data.length * 2;
            this.evictImageCacheIfNeeded();
            Logger.debug('Image cached from message:', imageId);
        }
    }

    /**
     * Evict oldest image cache entries when total size exceeds byte limit (LRU by insertion order)
     */
    evictImageCacheIfNeeded() {
        if (this.imageCacheBytes <= this.MAX_IMAGE_CACHE_BYTES) return;
        let evicted = 0;
        for (const [key, value] of this.imageCache) {
            if (this.imageCacheBytes <= this.MAX_IMAGE_CACHE_BYTES) break;
            this.imageCacheBytes -= value.length * 2; // base64 string ~2 bytes/char in JS
            this.imageCache.delete(key);
            evicted++;
        }
        Logger.debug(`Image cache evicted ${evicted} entries, ~${(this.imageCacheBytes / 1024 / 1024).toFixed(1)}MB remaining`);
    }

    /**
     * Get downloaded file URL
     * @param {string} fileId - File ID
     * @returns {string|null} - Blob URL or null
     */
    getDownloadedFile(fileId) {
        return this.downloadedUrls.get(fileId) || null;
    }

    /**
     * Get local file URL (for files we're seeding)
     * @param {string} fileId - File ID
     * @returns {string|null} - Blob URL or null
     */
    getLocalFileUrl(fileId) {
        const localFile = this.localFiles.get(fileId);
        if (!localFile || !localFile.file) return null;
        
        // Create and cache blob URL if not already cached
        if (!this.downloadedUrls.has(fileId)) {
            const url = URL.createObjectURL(localFile.file);
            this.downloadedUrls.set(fileId, url);
        }
        return this.downloadedUrls.get(fileId);
    }

    /**
     * Check if a file download is in progress
     * @param {string} fileId - File ID
     * @returns {boolean}
     */
    isDownloading(fileId) {
        return this.incomingFiles.has(fileId);
    }

    /**
     * Get download progress for an active transfer
     * @param {string} fileId - File ID
     * @returns {{ percent: number, received: number, total: number, fileSize: number }|null}
     */
    getDownloadProgress(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return null;
        const { receivedCount, metadata } = transfer;
        const percent = metadata.pieceCount > 0 ? Math.round(receivedCount / metadata.pieceCount * 100) : 0;
        return { percent, received: receivedCount, total: metadata.pieceCount, fileSize: metadata.fileSize };
    }

    /**
     * Check if we are seeding a file
     * @param {string} fileId - File ID
     * @returns {boolean}
     */
    isSeeding(fileId) {
        return this.localFiles.has(fileId);
    }

    /**
     * Get file URL (either downloaded or local)
     * @param {string} fileId - File ID
     * @returns {string|null} - Blob URL or null
     */
    getFileUrl(fileId) {
        return this.getDownloadedFile(fileId) || this.getLocalFileUrl(fileId);
    }

    /**
     * Check if there are active media transfers (downloads or seeds) for a given channel.
     * Used by subscriptionManager to decide whether to keep P1/P2 alive on channel switch.
     * @param {string} messageStreamId - Channel message stream ID
     * @returns {boolean}
     */
    hasActiveMediaTransfers(messageStreamId) {
        // Check active downloads
        for (const [, transfer] of this.incomingFiles) {
            if (transfer.streamId === messageStreamId) return true;
        }
        // Check active seeds (local files being served)
        for (const [, fileInfo] of this.localFiles) {
            if (fileInfo.streamId === messageStreamId) return true;
        }
        return false;
    }

    // ==================== VIDEO/FILE HANDLING ====================

    /**
     * Send a video file (chunked transfer)
     * @param {string} messageStreamId - Channel message stream ID
     * @param {File} file - Video file
     * @param {string} password - Channel password (optional)
     * @returns {Promise<Object>} - File metadata
     */
    async sendVideo(messageStreamId, file, password = null) {
        // Validate file type
        if (!CONFIG.ALLOWED_VIDEO_TYPES.includes(file.type)) {
            throw new Error(`Invalid video type. Allowed: ${CONFIG.ALLOWED_VIDEO_TYPES.join(', ')}`);
        }
        
        // Validate file size
        if (file.size > CONFIG.MAX_FILE_SIZE) {
            throw new Error(`File too large. Max: ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB`);
        }

        return new Promise((resolve, reject) => {
            const tempId = 'temp-' + crypto.randomUUID();
            const isPrivateChannel = !!password;
            
            // Store temp reference with callback
            this.localFiles.set(tempId, {
                file: file,
                streamId: messageStreamId, // Store messageStreamId for seeding
                isPrivateChannel: isPrivateChannel,
                callback: async (metadata) => {
                    try {
                        // Create file announcement message
                        const announcement = await identityManager.createSignedMessage('', messageStreamId);
                        announcement.type = 'video_announce';
                        announcement.metadata = metadata;
                        // Keep the id from createSignedMessage (signed)
                        
                        // Add verification info for local display
                        announcement.verified = {
                            valid: true,
                            trustLevel: await identityManager.getTrustLevel(announcement.sender)
                        };
                        
                        // Add to local channel messages & notify UI immediately (for sender)
                        const channel = channelManager.getChannel(messageStreamId);
                        if (channel) {
                            channel.messages.push(announcement);
                            channelManager.notifyHandlers('message', { streamId: messageStreamId, message: announcement });
                        }
                        
                        // Publish announcement to messageStream (stored)
                        await streamrController.publishMessage(messageStreamId, announcement, password);
                        
                        // Persist locally for write-only channels
                        if (channel?.writeOnly) {
                            await secureStorage.addSentMessage(messageStreamId, announcement);
                        }
                        
                        Logger.info('Video announced:', metadata.fileId, metadata.fileName);
                        
                        resolve({ messageId: announcement.id, metadata });
                    } catch (error) {
                        reject(error);
                    }
                }
            });
            
            // Send to worker for hashing
            this.fileWorker.postMessage({ fileData: file, tempId });
        });
    }

    /**
     * Handle incoming media message (dispatch to appropriate handler)
     * @param {string} messageStreamId - Channel message stream ID
     * @param {Object} data - Media data
     */
    handleMediaMessage(messageStreamId, data, senderId) {
        // Handle binary data from MEDIA_DATA partition
        if (data instanceof Uint8Array) {
            const decoded = decodeBinaryMedia(data);
            if (!decoded) {
                Logger.debug('Unknown binary media message');
                return;
            }
            if (senderId) decoded.senderId = senderId;
            return this.handleMediaMessage(messageStreamId, decoded);
        }
        
        if (!data || !data.type) return;
        
        switch (data.type) {
            case 'piece_request':
                this.handlePieceRequest(messageStreamId, data);
                break;
                
            case 'file_piece':
                this.handleFilePiece(messageStreamId, data);
                break;
                
            case 'source_request':
                this.handleSourceRequest(messageStreamId, data);
                break;
                
            case 'source_announce':
                this.handleSourceAnnounce(data);
                break;
                
            default:
                Logger.debug('Unknown media type:', data.type);
        }
    }

    /**
     * Start downloading a file
     * @param {string} messageStreamId - Channel message stream ID
     * @param {Object} metadata - File metadata from announcement
     * @param {string} password - Channel password (optional)
     */
    async startDownload(messageStreamId, metadata, password = null) {
        const { fileId, fileName, fileSize, fileType, pieceCount, pieceHashes } = metadata;
        
        if (this.incomingFiles.has(fileId)) {
            Logger.warn('Download already in progress:', fileId);
            return;
        }
        
        // Lazy-subscribe to media partitions P1+P2 (needed for piece_request/file_piece)
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        await streamrController.ensureMediaSubscription(ephemeralStreamId);
        
        // Initialize transfer state
        const transfer = {
            metadata,
            streamId: messageStreamId, // Store messageStreamId for channel lookup and seeding
            password,
            isPrivateChannel: !!password, // Password presence indicates private channel
            pieceStatus: new Array(pieceCount).fill('pending'),
            requestsInFlight: new Map(),
            receivedCount: 0,
            pieces: new Array(pieceCount).fill(null),
            useIndexedDB: this.db && fileSize > 10 * 1024 * 1024, // Use IndexedDB for files > 10MB
            // Seeder discovery tracking
            seederRequestCount: 0,
            lastSeederRequest: 0,
            seederDiscoveryTimer: null,
            downloadStarted: false
        };
        
        this.incomingFiles.set(fileId, transfer);
        this.fileSeeders.set(fileId, new Set());
        
        // Start parallel seeder discovery
        this.startSeederDiscovery(fileId);
        
        Logger.info('Started download:', fileId, fileName);
    }

    /**
     * Start parallel seeder discovery with retries
     */
    async startSeederDiscovery(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        const seeders = this.fileSeeders.get(fileId);
        
        // Request seeders immediately
        await this.requestFileSources(transfer.streamId, fileId, transfer.password);
        transfer.seederRequestCount++;
        transfer.lastSeederRequest = Date.now();
        
        // Setup discovery timer for retries
        const discoveryLoop = async () => {
            const currentTransfer = this.incomingFiles.get(fileId);
            if (!currentTransfer) return; // Download completed or cancelled
            
            // Push-mode already started — no more discovery needed
            if (currentTransfer.downloadStarted) return;
            
            const currentSeeders = this.fileSeeders.get(fileId);
            const seederCount = currentSeeders?.size || 0;
            const now = Date.now();
            
            // Check if we need more seeders
            const needMoreSeeders = seederCount < CONFIG.PREFERRED_SEEDERS;
            const canRequestMore = currentTransfer.seederRequestCount < CONFIG.MAX_SEEDER_REQUESTS;
            const enoughTimePassed = (now - currentTransfer.lastSeederRequest) >= CONFIG.SEEDER_REQUEST_INTERVAL;
            
            if (needMoreSeeders && canRequestMore && enoughTimePassed) {
                Logger.debug(`Requesting more seeders for ${fileId} (current: ${seederCount}, requests: ${currentTransfer.seederRequestCount})`);
                await this.requestFileSources(currentTransfer.streamId, fileId, currentTransfer.password);
                currentTransfer.seederRequestCount++;
                currentTransfer.lastSeederRequest = now;
            }
            
            // Continue discovery if download is in progress (for resilience)
            if (!currentTransfer.downloadStarted || seederCount < CONFIG.PREFERRED_SEEDERS) {
                const discoveryElapsed = now - (currentTransfer.downloadStartTime || now);
                if (discoveryElapsed < CONFIG.SEEDER_DISCOVERY_TIMEOUT) {
                    currentTransfer.seederDiscoveryTimer = setTimeout(discoveryLoop, CONFIG.SEEDER_REQUEST_INTERVAL);
                } else if (!currentTransfer.downloadStarted && seederCount === 0) {
                    Logger.warn(`No seeders found for ${fileId} after ${CONFIG.SEEDER_DISCOVERY_TIMEOUT}ms`);
                    // Try one last time with broadcast
                    await this.requestFileSources(currentTransfer.streamId, fileId, currentTransfer.password);
                }
            }
        };
        
        // Mark download start time
        transfer.downloadStartTime = Date.now();
        
        // Start the discovery loop after initial delay
        transfer.seederDiscoveryTimer = setTimeout(discoveryLoop, CONFIG.SEEDER_REQUEST_INTERVAL);
    }

    /**
     * Manage download - request missing pieces with round-robin load balancing
     */
    manageDownload(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        const seeders = this.fileSeeders.get(fileId);
        if (!seeders || seeders.size === 0) {
            // No seeders yet - seeder discovery will trigger us when ready
            if (transfer.downloadStarted) {
                // We had seeders but lost them - request more
                Logger.debug(`Lost all seeders for ${fileId}, requesting more...`);
                this.requestFileSources(transfer.streamId, fileId, transfer.password);
            }
            setTimeout(() => this.manageDownload(fileId), 1000);
            return;
        }
        
        const seederArray = Array.from(seeders);
        let seederIndex = 0;
        
        // In push-mode retries: use same cap (watchdog handles scheduling)
        // In request-mode: respect MAX_CONCURRENT_REQUESTS
        const maxInFlight = CONFIG.MAX_CONCURRENT_REQUESTS;
        
        // Find pieces to request using round-robin across seeders
        for (let i = 0; i < transfer.pieceStatus.length; i++) {
            if (transfer.requestsInFlight.size >= maxInFlight) break;
            
            if (transfer.pieceStatus[i] === 'pending') {
                // Round-robin seeder selection for better load distribution
                const seederId = seederArray[seederIndex % seederArray.length];
                seederIndex++;
                this.requestPiece(fileId, i, seederId);
            }
        }
        
        // Periodic seeder refresh during slow downloads
        const now = Date.now();
        if (transfer.lastSeederRequest && 
            (now - transfer.lastSeederRequest) > CONFIG.SEEDER_REFRESH_INTERVAL &&
            seeders.size < CONFIG.PREFERRED_SEEDERS &&
            transfer.seederRequestCount < CONFIG.MAX_SEEDER_REQUESTS) {
            Logger.debug(`Refreshing seeders for slow download ${fileId}`);
            this.requestFileSources(transfer.streamId, fileId, transfer.password);
            transfer.seederRequestCount++;
            transfer.lastSeederRequest = now;
        }
    }

    /**
     * Request a specific piece from a seeder
     * Requests go to ephemeralStream (not stored)
     */
    async requestPiece(fileId, pieceIndex, seederId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        transfer.pieceStatus[pieceIndex] = 'requested';
        
        const timeoutId = setTimeout(() => {
            // Request timed out - reset if still waiting or processing
            const status = transfer.pieceStatus[pieceIndex];
            if (status === 'requested' || status === 'processing') {
                Logger.debug(`Piece ${pieceIndex} timed out (was ${status})`);
                transfer.pieceStatus[pieceIndex] = 'pending';
                transfer.requestsInFlight.delete(pieceIndex);
                // In push-mode, watchdog handles retries — don't cascade
                if (!transfer.pushMode) {
                    this.manageDownload(fileId);
                }
            }
        }, CONFIG.PIECE_REQUEST_TIMEOUT);
        
        transfer.requestsInFlight.set(pieceIndex, { seederId, timeoutId });
        
        // Derive ephemeral stream ID for P2P request
        const ephemeralStreamId = deriveEphemeralId(transfer.streamId);
        
        const request = {
            type: 'piece_request',
            fileId,
            pieceIndex,
            targetSeederId: seederId
        };
        
        // DM channels: encrypt signal with ECDH shared key
        const dmKey = await this._getDMMediaKey(transfer.streamId);
        if (dmKey) {
            const encrypted = await dmCrypto.encrypt(request, dmKey);
            await streamrController.publishMediaSignal(ephemeralStreamId, encrypted, null);
        } else {
            await streamrController.publishMediaSignal(ephemeralStreamId, request, transfer.password);
        }
    }

    /**
     * Handle piece request (we are a seeder)
     * Note: Addresses must be normalized to lowercase for comparison
     * because Streamr metadata.publisherId is always lowercase
     * @param {string} messageStreamId - Channel message stream ID
     */
    async handlePieceRequest(messageStreamId, data) {
        const myAddress = authManager.getAddress()?.toLowerCase();
        const targetAddress = data.targetSeederId?.toLowerCase();
        
        if (!myAddress || targetAddress !== myAddress) {
            // Not for us - ignore silently
            return;
        }
        
        const localFile = this.localFiles.get(data.fileId);
        if (!localFile) {
            Logger.warn('piece_request for unknown file:', data.fileId?.slice(0, 8));
            return;
        }
        
        Logger.debug('Sending piece', data.pieceIndex, 'of', data.fileId?.slice(0, 8));
        await this.sendPiece(messageStreamId, data.fileId, data.pieceIndex);
    }

    /**
     * Send a file piece (queued with throttling)
     * Piece data is encrypted with channel password for private channels
     * Pieces go to ephemeralStream (not stored)
     * @param {string} messageStreamId - Channel message stream ID
     */
    async sendPiece(messageStreamId, fileId, pieceIndex) {
        // Queue the piece send request
        return new Promise((resolve) => {
            this.pieceSendQueue.push({ messageStreamId, fileId, pieceIndex, resolve });
            this.processPieceQueue();
        });
    }

    /**
     * Process the piece send queue with bounded concurrency
     * Allows up to CONCURRENT_SENDS parallel Streamr publishes to hide network latency
     */
    async processPieceQueue() {
        while (this.pieceSendQueue.length > 0 && this.activeSends < CONFIG.CONCURRENT_SENDS) {
            const { messageStreamId, fileId, pieceIndex, resolve } = this.pieceSendQueue.shift();
            
            // Throttle: wait for minimum delay since last send
            const now = Date.now();
            const elapsed = now - this.lastPieceSentTime;
            if (elapsed < CONFIG.PIECE_SEND_DELAY) {
                await new Promise(r => setTimeout(r, CONFIG.PIECE_SEND_DELAY - elapsed));
            }
            this.lastPieceSentTime = Date.now();
            
            // Launch send concurrently (don't await)
            this.activeSends++;
            this._sendPieceImmediate(messageStreamId, fileId, pieceIndex)
                .then(() => resolve())
                .catch(() => resolve())
                .finally(() => {
                    this.activeSends--;
                    this.processPieceQueue(); // drain next from queue
                });
        }
    }

    /**
     * Actually send a file piece (internal, called by queue processor)
     * Pieces go to ephemeralStream (not stored)
     * @param {string} messageStreamId - Channel message stream ID
     */
    async _sendPieceImmediate(messageStreamId, fileId, pieceIndex) {
        const localFile = this.localFiles.get(fileId);
        if (!localFile) return;
        
        const { file, metadata } = localFile;
        const start = pieceIndex * CONFIG.PIECE_SIZE;
        const end = Math.min(start + CONFIG.PIECE_SIZE, file.size);
        
        const chunk = file.slice(start, end);
        const arrayBuffer = await chunk.arrayBuffer();
        
        // Get channel password for encryption
        const channel = channelManager.getChannel(messageStreamId);
        const password = channel?.password || null;
        
        // Derive ephemeral stream ID for P2P data
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        
        // Encode as binary for MEDIA_DATA partition (zero base64 overhead)
        let binaryPayload = encodeFilePiece(fileId, pieceIndex, arrayBuffer);
        
        // DM channels: encrypt binary with ECDH shared key (Alice-Bob specific)
        const dmKey = await this._getDMMediaKey(messageStreamId);
        if (dmKey) {
            binaryPayload = await dmCrypto.encryptBinary(binaryPayload, dmKey);
            await streamrController.publishMediaData(ephemeralStreamId, binaryPayload, null);
            Logger.debug('Sent piece (binary+ECDH)', pieceIndex, 'of', fileId);
        } else {
            await streamrController.publishMediaData(ephemeralStreamId, binaryPayload, password);
            Logger.debug('Sent piece (binary)', pieceIndex, 'of', fileId, password ? '(encrypted)' : '');
        }
    }

    /**
     * Handle received file piece
     * @param {string} messageStreamId - Channel message stream ID
     */
    async handleFilePiece(messageStreamId, data) {
        // Skip our own pieces (self-filtering)
        const myAddress = authManager.getAddress()?.toLowerCase();
        const senderAddress = data.senderId?.toLowerCase();
        
        if (senderAddress === myAddress) {
            return;
        }
        
        const transfer = this.incomingFiles.get(data.fileId);
        if (!transfer) {
            return;
        }
        
        const { fileId, pieceIndex } = data;
        
        // Skip if piece already done
        if (transfer.pieceStatus[pieceIndex] === 'done') {
            Logger.debug('Piece already done, skipping:', pieceIndex);
            return;
        }
        // In push-mode, accept pieces that are 'pending' (not yet requested)
        // In request-mode, only accept 'requested' pieces
        const status = transfer.pieceStatus[pieceIndex];
        if (status !== 'requested' && status !== 'pending' && status !== 'processing') {
            Logger.debug('Piece in unexpected state:', pieceIndex, status);
            return;
        }
        
        // Mark as processing to prevent race conditions
        transfer.pieceStatus[pieceIndex] = 'processing';
        
        // Decode piece (Uint8Array from binary protocol, or base64 legacy)
        let pieceBuffer;
        if (data.data instanceof Uint8Array) {
            pieceBuffer = data.data.buffer.byteLength === data.data.length 
                ? data.data.buffer 
                : data.data.buffer.slice(data.data.byteOffset, data.data.byteOffset + data.data.byteLength);
        } else {
            pieceBuffer = this.base64ToArrayBuffer(data.data);
        }
        if (!pieceBuffer) {
            Logger.error('Failed to decode piece:', pieceIndex);
            transfer.pieceStatus[pieceIndex] = 'pending';
            this.manageDownload(fileId);
            return;
        }
        
        // Verify hash
        const receivedHash = await this.sha256(pieceBuffer);
        if (receivedHash !== transfer.metadata.pieceHashes[pieceIndex]) {
            Logger.error('Hash mismatch for piece:', pieceIndex);
            transfer.pieceStatus[pieceIndex] = 'pending';
            this.manageDownload(fileId);
            return;
        }
        
        // Clear timeout
        const request = transfer.requestsInFlight.get(pieceIndex);
        if (request) {
            clearTimeout(request.timeoutId);
            transfer.requestsInFlight.delete(pieceIndex);
        }
        
        // Store piece
        if (transfer.useIndexedDB) {
            await this.savePieceToIndexedDB(fileId, pieceIndex, new Uint8Array(pieceBuffer));
        } else {
            transfer.pieces[pieceIndex] = new Uint8Array(pieceBuffer);
        }
        
        transfer.pieceStatus[pieceIndex] = 'done';
        transfer.receivedCount++;
        transfer.lastPieceReceivedAt = Date.now();
        
        // Notify progress with file size for MB display
        const progress = Math.round((transfer.receivedCount / transfer.metadata.pieceCount) * 100);
        if (this.handlers.onFileProgress) {
            this.handlers.onFileProgress(fileId, progress, transfer.receivedCount, transfer.metadata.pieceCount, transfer.metadata.fileSize);
        }
        
        // Check if complete - verify all pieces are done
        const doneCount = transfer.pieceStatus.filter(s => s === 'done').length;
        if (doneCount === transfer.metadata.pieceCount) {
            // Clear watchdog timer on completion
            if (transfer.pushWatchdogTimer) {
                clearTimeout(transfer.pushWatchdogTimer);
            }
            await this.assembleFile(fileId);
        } else if (!transfer.pushMode) {
            // Request-mode: request next pieces
            this.manageDownload(fileId);
        }
        // Push-mode: watchdog handles retries for missing pieces
    }

    /**
     * Assemble completed file
     */
    async assembleFile(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        // Double-check all pieces are done
        const doneCount = transfer.pieceStatus.filter(s => s === 'done').length;
        const expectedCount = transfer.metadata.pieceCount;
        
        if (doneCount !== expectedCount) {
            Logger.error(`Assembly aborted: only ${doneCount}/${expectedCount} pieces done`);
            // Re-trigger download for missing pieces
            this.manageDownload(fileId);
            return;
        }
        
        Logger.info('Assembling file:', fileId, `(${expectedCount} pieces, ${transfer.metadata.fileSize} bytes)`);
        
        let blob;
        
        if (transfer.useIndexedDB) {
            blob = await this.assembleFromIndexedDB(fileId, transfer.metadata);
        } else {
            // Combine all pieces in order
            const totalSize = transfer.pieces.reduce((sum, p) => sum + (p?.length || 0), 0);
            
            // Verify total size matches expected
            if (totalSize !== transfer.metadata.fileSize) {
                Logger.warn(`Size mismatch: got ${totalSize}, expected ${transfer.metadata.fileSize}`);
            }
            
            const combined = new Uint8Array(totalSize);
            let offset = 0;
            
            for (let i = 0; i < transfer.pieces.length; i++) {
                const piece = transfer.pieces[i];
                if (piece) {
                    combined.set(piece, offset);
                    offset += piece.length;
                } else {
                    Logger.error(`Missing piece at index ${i} during assembly!`);
                }
            }
            
            blob = new Blob([combined], { type: transfer.metadata.fileType });
        }
        
        // Verify blob size
        if (blob.size !== transfer.metadata.fileSize) {
            Logger.error(`Final blob size mismatch: got ${blob.size}, expected ${transfer.metadata.fileSize}`);
        } else {
            Logger.info(`File assembled correctly: ${blob.size} bytes`);
        }
        
        // Create object URL
        const url = URL.createObjectURL(blob);
        
        // Cache the download URL for later access
        this.downloadedUrls.set(fileId, url);
        
        // Notify completion
        if (this.handlers.onFileComplete) {
            this.handlers.onFileComplete(fileId, transfer.metadata, url, blob);
        }
        
        // Now we can seed this file
        this.localFiles.set(fileId, {
            file: blob,
            metadata: transfer.metadata,
            streamId: transfer.streamId,
            persisted: false
        });
        
        // Announce as seeder
        await this.announceFileSource(transfer.streamId, fileId, transfer.password);
        
        // Persist for seeding across sessions
        const persisted = await this.persistSeedFile(
            fileId, 
            blob, 
            transfer.metadata, 
            transfer.streamId,
            transfer.isPrivateChannel
        );
        if (persisted) {
            const localFile = this.localFiles.get(fileId);
            if (localFile) localFile.persisted = true;
        }
        
        // Clean up seeder discovery timer
        if (transfer.seederDiscoveryTimer) {
            clearTimeout(transfer.seederDiscoveryTimer);
        }
        
        // Clean up transfer state
        this.incomingFiles.delete(fileId);
        if (this.db) {
            await this.clearFileFromIndexedDB(fileId);
        }
        
        Logger.info('File complete:', transfer.metadata.fileName);
    }

    /**
     * Request file sources (seeders)
     * Requests go to ephemeralStream (not stored)
     * @param {string} messageStreamId - Channel message stream ID
     */
    async requestFileSources(messageStreamId, fileId, password = null) {
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        const request = {
            type: 'source_request',
            fileId,
            wantPush: true
        };

        // DM channels: encrypt signal with ECDH shared key
        const dmKey = await this._getDMMediaKey(messageStreamId);
        if (dmKey) {
            const encrypted = await dmCrypto.encrypt(request, dmKey);
            await streamrController.publishMediaSignal(ephemeralStreamId, encrypted, null);
        } else {
            await streamrController.publishMediaSignal(ephemeralStreamId, request, password);
        }
        Logger.debug('Requested sources for:', fileId);
    }

    /**
     * Handle source request
     * Respond with seeder announcement (encrypted if private channel)
     * Response goes to ephemeralStream (not stored)
     */
    async handleSourceRequest(messageStreamId, data) {
        if (this.localFiles.has(data.fileId)) {
            // Get channel password for encryption
            const channel = channelManager.getChannel(messageStreamId);
            const password = channel?.password || null;
            await this.announceFileSource(messageStreamId, data.fileId, password);
            
            // Push-first: proactively send ALL pieces
            if (data.wantPush) {
                this.pushAllPieces(messageStreamId, data.fileId);
            }
        }
    }

    /**
     * Push all pieces proactively (seeder-side)
     * Queues every piece into the existing send queue with throttling
     * @param {string} messageStreamId - Channel message stream ID
     * @param {string} fileId - File ID
     */
    pushAllPieces(messageStreamId, fileId) {
        const localFile = this.localFiles.get(fileId);
        if (!localFile) return;
        
        // Prevent duplicate pushes for the same file
        if (this.activePushes.has(fileId)) {
            Logger.debug(`Already pushing ${fileId.slice(0, 8)}, skipping duplicate`);
            return;
        }
        this.activePushes.add(fileId);
        
        const pieceCount = localFile.metadata.pieceCount;
        Logger.info(`Push-sending all ${pieceCount} pieces for ${fileId.slice(0, 8)}`);
        
        for (let i = 0; i < pieceCount; i++) {
            this.sendPiece(messageStreamId, fileId, i);
        }
    }

    /**
     * Announce as file source (seeder)
     * Announcements go to ephemeralStream (not stored)
     * @param {string} messageStreamId - Channel message stream ID
     */
    async announceFileSource(messageStreamId, fileId, password = null) {
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        const localFile = this.localFiles.get(fileId);
        const announce = {
            type: 'source_announce',
            fileId,
            pieceCount: localFile?.metadata?.pieceCount || 0,
            pushMode: true
        };

        // DM channels: encrypt signal with ECDH shared key
        const dmKey = await this._getDMMediaKey(messageStreamId);
        if (dmKey) {
            const encrypted = await dmCrypto.encrypt(announce, dmKey);
            await streamrController.publishMediaSignal(ephemeralStreamId, encrypted, null);
        } else {
            await streamrController.publishMediaSignal(ephemeralStreamId, announce, password);
        }
        Logger.debug('Announced as source for:', fileId);
    }

    /**
     * Handle source announcement
     * Note: Normalize senderId to lowercase for consistent comparison
     */
    handleSourceAnnounce(data) {
        const seeders = this.fileSeeders.get(data.fileId);
        if (seeders && data.senderId) {
            // Normalize to lowercase for consistent address comparison
            const normalizedSenderId = data.senderId.toLowerCase();
            seeders.add(normalizedSenderId);
            
            Logger.debug('Seeder announced for file:', data.fileId, 'seeder:', normalizedSenderId);
            
            if (this.handlers.onSeederUpdate) {
                this.handlers.onSeederUpdate(data.fileId, seeders.size);
            }
            
            // Start download when we have enough seeders
            const transfer = this.incomingFiles.get(data.fileId);
            if (transfer && !transfer.downloadStarted && transfer.pieceStatus && seeders.size >= CONFIG.MIN_SEEDERS) {
                transfer.downloadStarted = true;
                
                // Stop discovery loop — we have a seeder, no need for more source_requests
                if (transfer.seederDiscoveryTimer) {
                    clearTimeout(transfer.seederDiscoveryTimer);
                    transfer.seederDiscoveryTimer = null;
                }
                
                if (data.pushMode) {
                    // Push-mode: seeder is sending all pieces proactively
                    // Just start watchdog to detect and retry missing pieces
                    Logger.info(`Push-mode download started for ${data.fileId} (${data.pieceCount} pieces)`);
                    transfer.pushMode = true;
                    transfer.lastPieceReceivedAt = Date.now();
                    this.startPushWatchdog(data.fileId);
                } else {
                    // Legacy request-response mode
                    Logger.info(`Request-mode download started for ${data.fileId}`);
                    this.manageDownload(data.fileId);
                }
            }
        }
    }

    /**
     * Push-mode watchdog: periodically check for missing pieces and request retries
     * @param {string} fileId - File ID
     */
    startPushWatchdog(fileId) {
        const check = () => {
            const transfer = this.incomingFiles.get(fileId);
            if (!transfer) return; // Download completed or cancelled
            
            const done = transfer.pieceStatus.filter(s => s === 'done').length;
            const total = transfer.pieceStatus.length;
            
            if (done === total) return; // Complete
            
            const timeSinceLastPiece = Date.now() - (transfer.lastPieceReceivedAt || transfer.downloadStartTime);
            
            // Count pieces that are still pending (not received, not already in-flight)
            const pending = transfer.pieceStatus.filter(s => s === 'pending').length;
            
            if (pending > 0 && timeSinceLastPiece > CONFIG.PUSH_STALL_TIMEOUT) {
                // Stall detected — request only the missing pieces
                Logger.info(`Push watchdog: ${pending} missing, ${done}/${total} done — requesting retries`);
                this.manageDownload(fileId);
            }
            
            // Continue watchdog if transfer still active
            if (this.incomingFiles.has(fileId)) {
                transfer.pushWatchdogTimer = setTimeout(check, CONFIG.PUSH_WATCHDOG_INTERVAL);
            }
        };
        
        const transfer = this.incomingFiles.get(fileId);
        if (transfer) {
            transfer.pushWatchdogTimer = setTimeout(check, CONFIG.PUSH_WATCHDOG_START_DELAY);
        }
    }

    /**
     * Cancel a download
     */
    cancelDownload(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        // Clear seeder discovery timer
        if (transfer.seederDiscoveryTimer) {
            clearTimeout(transfer.seederDiscoveryTimer);
        }
        
        // Clear push watchdog timer
        if (transfer.pushWatchdogTimer) {
            clearTimeout(transfer.pushWatchdogTimer);
        }
        
        // Clear all piece request timeouts
        for (const [, request] of transfer.requestsInFlight) {
            clearTimeout(request.timeoutId);
        }
        
        this.incomingFiles.delete(fileId);
        this.fileSeeders.delete(fileId);
        
        // Clean up IndexedDB
        if (this.db) {
            this.clearFileFromIndexedDB(fileId);
        }
        
        Logger.info('Download cancelled:', fileId);
    }

    // ==================== INDEXEDDB HELPERS ====================

    async savePieceToIndexedDB(fileId, pieceIndex, data) {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('pieces', 'readwrite');
            const store = tx.objectStore('pieces');
            const request = store.put({ fileId, pieceIndex, data });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async assembleFromIndexedDB(fileId, metadata) {
        if (!this.db) return null;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('pieces', 'readonly');
            const store = tx.objectStore('pieces');
            const pieces = new Array(metadata.pieceCount).fill(null);
            let foundCount = 0;
            
            const request = store.openCursor();
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.fileId === fileId) {
                        const idx = cursor.value.pieceIndex;
                        if (idx >= 0 && idx < metadata.pieceCount) {
                            pieces[idx] = cursor.value.data;
                            foundCount++;
                        }
                    }
                    cursor.continue();
                } else {
                    // All pieces collected - verify we have them all
                    if (foundCount !== metadata.pieceCount) {
                        Logger.error(`IndexedDB assembly: found ${foundCount}/${metadata.pieceCount} pieces`);
                    }
                    
                    // Calculate total size and assemble
                    const totalSize = pieces.reduce((sum, p) => sum + (p?.length || 0), 0);
                    
                    if (totalSize !== metadata.fileSize) {
                        Logger.warn(`IndexedDB size mismatch: got ${totalSize}, expected ${metadata.fileSize}`);
                    }
                    
                    const combined = new Uint8Array(totalSize);
                    let offset = 0;
                    
                    for (let i = 0; i < pieces.length; i++) {
                        const piece = pieces[i];
                        if (piece) {
                            combined.set(piece, offset);
                            offset += piece.length;
                        } else {
                            Logger.error(`Missing piece at index ${i} in IndexedDB!`);
                        }
                    }
                    
                    Logger.info(`Assembled from IndexedDB: ${totalSize} bytes, ${foundCount} pieces`);
                    resolve(new Blob([combined], { type: metadata.fileType }));
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clearFileFromIndexedDB(fileId) {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('pieces', 'readwrite');
            const store = tx.objectStore('pieces');
            
            const request = store.openCursor();
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.fileId === fileId) {
                        cursor.delete();
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    // ==================== SEEDING PERSISTENCE ====================

    /**
     * Load persisted seed files from IndexedDB
     * Called on setOwner() to restore seeding capabilities for current user
     */
    async loadPersistedSeedFiles() {
        if (!this.db || !this.db.objectStoreNames.contains('seedFiles')) {
            Logger.debug('No seedFiles store available');
            return;
        }
        
        if (!this.currentOwnerAddress) {
            Logger.debug('No owner address set - skipping seed file load');
            return;
        }
        
        try {
            const seedFiles = await this.getAllSeedFiles();
            const now = Date.now();
            const expireMs = CONFIG.SEED_FILES_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
            
            let loadedCount = 0;
            let expiredCount = 0;
            let skippedCount = 0;
            
            for (const record of seedFiles) {
                // Only load files owned by current user
                // Skip if: no owner (legacy file) OR owner is different
                const recordOwner = record.ownerAddress?.toLowerCase();
                if (!recordOwner || recordOwner !== this.currentOwnerAddress) {
                    skippedCount++;
                    continue;
                }
                
                // Check if expired
                if (now - record.timestamp > expireMs) {
                    await this.removeSeedFile(record.fileId);
                    expiredCount++;
                    continue;
                }
                
                // Restore to memory
                const blob = new Blob([record.fileData], { type: record.metadata.fileType });
                const url = URL.createObjectURL(blob);
                
                this.localFiles.set(record.fileId, {
                    file: blob,
                    metadata: record.metadata,
                    streamId: record.streamId,
                    persisted: true
                });
                
                this.downloadedUrls.set(record.fileId, url);
                this.persistedStorageSize += record.metadata.fileSize;
                loadedCount++;
            }
            
            if (loadedCount > 0 || expiredCount > 0 || skippedCount > 0) {
                Logger.info(`Seed files: loaded ${loadedCount}, expired ${expiredCount}, skipped ${skippedCount} (other users/legacy), storage: ${(this.persistedStorageSize / 1024 / 1024).toFixed(2)}MB`);
            }
        } catch (error) {
            Logger.error('Failed to load persisted seed files:', error);
        }
    }

    /**
     * Persist a file for seeding across sessions
     */
    async persistSeedFile(fileId, blob, metadata, streamId, isPrivateChannel = false) {
        if (!this.db || !this.db.objectStoreNames.contains('seedFiles')) {
            return false;
        }
        
        if (!this.currentOwnerAddress) {
            Logger.debug('No owner address set - skipping persistence');
            return false;
        }
        
        // Check if we should persist based on channel type
        if (isPrivateChannel && !CONFIG.PERSIST_PRIVATE_CHANNELS) {
            Logger.debug('Skipping persistence for private channel file:', fileId);
            return false;
        }
        
        if (!isPrivateChannel && !CONFIG.PERSIST_PUBLIC_CHANNELS) {
            Logger.debug('Skipping persistence for public channel file:', fileId);
            return false;
        }
        
        // Check storage quota
        const newTotalSize = this.persistedStorageSize + metadata.fileSize;
        if (newTotalSize > CONFIG.MAX_SEED_STORAGE) {
            // Try to free up space using LRU
            const freedSpace = await this.evictOldestSeedFiles(metadata.fileSize);
            if (freedSpace < metadata.fileSize) {
                Logger.warn(`Cannot persist file ${fileId}: storage quota exceeded`);
                return false;
            }
        }
        
        try {
            // Read blob as ArrayBuffer for storage
            const fileData = await blob.arrayBuffer();
            
            const record = {
                fileId,
                streamId,
                metadata,
                fileData,
                timestamp: Date.now(),
                ownerAddress: this.currentOwnerAddress // Associate with current user
            };
            
            await this.saveSeedFile(record);
            this.persistedStorageSize += metadata.fileSize;
            
            Logger.info(`Persisted seed file: ${metadata.fileName} (${(metadata.fileSize / 1024 / 1024).toFixed(2)}MB)`);
            return true;
        } catch (error) {
            Logger.error('Failed to persist seed file:', error);
            return false;
        }
    }

    /**
     * Save seed file to IndexedDB
     */
    async saveSeedFile(record) {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readwrite');
            const store = tx.objectStore('seedFiles');
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all seed files from IndexedDB
     */
    async getAllSeedFiles() {
        if (!this.db) return [];
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readonly');
            const store = tx.objectStore('seedFiles');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get seed files for a specific stream/channel
     */
    async getSeedFilesByStream(streamId) {
        if (!this.db) return [];
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readonly');
            const store = tx.objectStore('seedFiles');
            const index = store.index('streamId');
            const request = index.getAll(streamId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Remove seed file from IndexedDB
     */
    async removeSeedFile(fileId) {
        if (!this.db) return;
        
        // Update storage size
        const localFile = this.localFiles.get(fileId);
        if (localFile?.metadata?.fileSize) {
            this.persistedStorageSize -= localFile.metadata.fileSize;
        }
        
        // Remove blob URL
        const url = this.downloadedUrls.get(fileId);
        if (url) {
            URL.revokeObjectURL(url);
            this.downloadedUrls.delete(fileId);
        }
        
        // Remove from memory
        this.localFiles.delete(fileId);
        
        // Remove from IndexedDB
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readwrite');
            const store = tx.objectStore('seedFiles');
            const request = store.delete(fileId);
            request.onsuccess = () => {
                Logger.debug('Removed seed file:', fileId);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Evict oldest seed files to free up space (LRU)
     */
    async evictOldestSeedFiles(neededSpace) {
        if (!this.db) return 0;
        
        const seedFiles = await this.getAllSeedFiles();
        
        // Sort by timestamp (oldest first)
        seedFiles.sort((a, b) => a.timestamp - b.timestamp);
        
        let freedSpace = 0;
        
        for (const record of seedFiles) {
            if (freedSpace >= neededSpace) break;
            
            freedSpace += record.metadata.fileSize;
            await this.removeSeedFile(record.fileId);
            Logger.info(`Evicted old seed file: ${record.metadata.fileName}`);
        }
        
        return freedSpace;
    }

    /**
     * Re-announce as seeder for all persisted files in a channel
     * Called when joining a channel
     * @param {string} messageStreamId - Channel message stream ID
     */
    async reannounceForChannel(messageStreamId, password = null) {
        if (!CONFIG.AUTO_SEED_ON_JOIN) return;
        
        // Check if we have any files to seed for this channel
        let hasFiles = false;
        for (const [, fileInfo] of this.localFiles) {
            if (fileInfo.streamId === messageStreamId) { hasFiles = true; break; }
        }
        if (!hasFiles) return;
        
        // Lazy-subscribe to media partitions P1+P2 (seeder needs P1 to receive piece_requests)
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        await streamrController.ensureMediaSubscription(ephemeralStreamId);
        
        let reannounced = 0;
        
        for (const [fileId, fileInfo] of this.localFiles) {
            // Check against messageStreamId (stored as streamId in localFiles)
            if (fileInfo.streamId === messageStreamId) {
                await this.announceFileSource(messageStreamId, fileId, password);
                reannounced++;
            }
        }
        
        if (reannounced > 0) {
            Logger.info(`Re-announced ${reannounced} seed files for channel`);
        }
    }

    /**
     * Get storage stats for UI
     */
    getStorageStats() {
        return {
            usedBytes: this.persistedStorageSize,
            maxBytes: CONFIG.MAX_SEED_STORAGE,
            usedMB: (this.persistedStorageSize / 1024 / 1024).toFixed(2),
            maxMB: (CONFIG.MAX_SEED_STORAGE / 1024 / 1024).toFixed(0),
            percentUsed: Math.round((this.persistedStorageSize / CONFIG.MAX_SEED_STORAGE) * 100),
            fileCount: this.localFiles.size
        };
    }

    /**
     * Clear all persisted seed files
     */
    async clearAllSeedFiles() {
        if (!this.db) return;
        
        const seedFiles = await this.getAllSeedFiles();
        for (const record of seedFiles) {
            await this.removeSeedFile(record.fileId);
        }
        
        this.persistedStorageSize = 0;
        Logger.info('Cleared all persisted seed files');
    }

    /**
     * Clear all persisted seed files for a specific owner (for delete account)
     * @param {string} address - Owner address to clear files for
     */
    async clearSeedFilesForOwner(address) {
        if (!this.db) return;
        
        const targetAddress = address?.toLowerCase();
        if (!targetAddress) return;
        
        const seedFiles = await this.getAllSeedFiles();
        let clearedCount = 0;
        
        for (const record of seedFiles) {
            const recordOwner = record.ownerAddress?.toLowerCase();
            if (recordOwner === targetAddress || !recordOwner) {
                // Clear files owned by this user or legacy files without owner
                await this.removeSeedFile(record.fileId);
                clearedCount++;
            }
        }
        
        if (clearedCount > 0) {
            Logger.info(`Cleared ${clearedCount} seed files for owner: ${targetAddress.slice(0, 8)}...`);
        }
    }

    // ==================== UTILITY FUNCTIONS ====================

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    base64ToArrayBuffer(base64) {
        try {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes.buffer;
        } catch (e) {
            Logger.error('Base64 decode error:', e);
            return null;
        }
    }

    async sha256(buffer) {
        let normalized = buffer;

        if (typeof normalized === 'string') {
            normalized = new TextEncoder().encode(normalized);
        } else if (normalized?.arrayBuffer instanceof Function) {
            normalized = new Uint8Array(await normalized.arrayBuffer());
        }

        if (ArrayBuffer.isView(normalized)) {
            normalized = new Uint8Array(
                normalized.buffer.slice(
                    normalized.byteOffset,
                    normalized.byteOffset + normalized.byteLength
                )
            );
        } else if (
            Object.prototype.toString.call(normalized) === '[object ArrayBuffer]' ||
            Object.prototype.toString.call(normalized) === '[object SharedArrayBuffer]'
        ) {
            normalized = new Uint8Array(normalized);
        } else if (normalized && typeof normalized.byteLength === 'number') {
            normalized = new Uint8Array(normalized);
        } else if (Array.isArray(normalized)) {
            normalized = Uint8Array.from(normalized);
        }

        const hashBuffer = await crypto.subtle.digest('SHA-256', normalized);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ==================== EVENT HANDLERS ====================

    /**
     * Set handler for image received event
     * @param {Function} handler - (imageId, base64Data) => void
     */
    onImageReceived(handler) {
        this.handlers.onImageReceived = handler;
    }

    /**
     * Set handler for file progress event
     * @param {Function} handler - (fileId, percent, received, total) => void
     */
    onFileProgress(handler) {
        this.handlers.onFileProgress = handler;
    }

    /**
     * Set handler for file complete event
     * @param {Function} handler - (fileId, metadata, url, blob) => void
     */
    onFileComplete(handler) {
        this.handlers.onFileComplete = handler;
    }

    /**
     * Set handler for seeder update event
     * @param {Function} handler - (fileId, seederCount) => void
     */
    onSeederUpdate(handler) {
        this.handlers.onSeederUpdate = handler;
    }

    /**
     * Get allowed image types
     */
    getAllowedImageTypes() {
        return CONFIG.ALLOWED_IMAGE_TYPES;
    }

    /**
     * Get allowed video types
     */
    getAllowedVideoTypes() {
        return CONFIG.ALLOWED_VIDEO_TYPES;
    }

    /**
     * Get max file size
     */
    getMaxFileSize() {
        return CONFIG.MAX_FILE_SIZE;
    }

    /**
     * Check if video type is playable in browser
     * @param {string} mimeType - Video MIME type
     * @returns {boolean}
     */
    isVideoPlayable(mimeType) {
        if (!mimeType) {
            Logger.warn('isVideoPlayable called with empty mimeType');
            return true; // Default to trying to play
        }
        
        // Normalize mime type (lowercase, trim)
        const normalizedMime = mimeType.toLowerCase().trim();
        
        // Check against known playable types
        if (CONFIG.PLAYABLE_VIDEO_TYPES.includes(normalizedMime)) {
            Logger.debug('Video playable (known type):', normalizedMime);
            return true;
        }
        
        // MP4 variants that are generally playable
        const mp4Variants = ['video/mp4', 'video/x-m4v', 'video/m4v', 'video/mpeg4'];
        if (mp4Variants.some(v => normalizedMime.includes('mp4') || normalizedMime.includes('m4v'))) {
            Logger.debug('Video playable (MP4 variant):', normalizedMime);
            return true;
        }
        
        // WebM is generally playable
        if (normalizedMime.includes('webm')) {
            Logger.debug('Video playable (WebM variant):', normalizedMime);
            return true;
        }
        
        // Additional browser capability check
        const video = document.createElement('video');
        const canPlay = video.canPlayType(normalizedMime);
        
        Logger.debug('Video playability check:', normalizedMime, 'canPlay:', canPlay);
        
        // Be more permissive - if browser says anything other than empty string, try it
        // Also, if we can't determine, default to trying (let the browser handle it)
        if (canPlay !== '') {
            return true;
        }
        
        // QuickTime (.mov) is NOT playable in most browsers
        if (normalizedMime.includes('quicktime') || normalizedMime.includes('mov')) {
            Logger.debug('Video not playable (QuickTime):', normalizedMime);
            return false;
        }
        
        // Default to trying to play - let the browser figure it out
        Logger.debug('Video playability unknown, defaulting to playable:', normalizedMime);
        return true;
    }

    /**
     * Get playable video types
     */
    getPlayableVideoTypes() {
        return CONFIG.PLAYABLE_VIDEO_TYPES;
    }
}

// Export singleton instance
export const mediaController = new MediaController();
export { CONFIG as MEDIA_CONFIG };
