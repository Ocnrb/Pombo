/**
 * Media Controller
 * Handles image and video file sharing via Streamr
 * 
 * Image: Direct base64 encoding (for small images)
 * Video: Chunked P2P transfer with hash verification
 */

import { Logger } from './logger.js';
import { streamrController } from './streamr.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { channelManager } from './channels.js';

// === CONFIGURATION ===
const CONFIG = {
    // Image settings
    IMAGE_MAX_WIDTH: 1280,
    IMAGE_MAX_HEIGHT: 720,
    IMAGE_QUALITY: 0.8,
    ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    
    // Video/File settings
    // Note: video/quicktime (.mov) is only supported in Safari, not Chrome/Firefox
    // We allow upload but may need to show download link instead of player
    ALLOWED_VIDEO_TYPES: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg'],
    // Browser-playable formats (for showing player vs download link)
    PLAYABLE_VIDEO_TYPES: ['video/mp4', 'video/webm', 'video/ogg'],
    PIECE_SIZE: 128 * 1024, // 128KB chunks
    MAX_CONCURRENT_REQUESTS: 8,
    PIECE_REQUEST_TIMEOUT: 10000, // 10 seconds
    MAX_FILE_SIZE: 500 * 1024 * 1024, // 500MB max
    
    // Seeder Discovery settings
    MIN_SEEDERS: 1,                    // Minimum seeders before starting download
    PREFERRED_SEEDERS: 3,              // Preferred number of seeders for faster downloads
    SEEDER_REQUEST_INTERVAL: 2000,     // Time between seeder requests (ms)
    SEEDER_DISCOVERY_TIMEOUT: 30000,   // Max time to wait for initial seeders (ms)
    SEEDER_REFRESH_INTERVAL: 10000,    // Re-request seeders every X ms during download
    MAX_SEEDER_REQUESTS: 10,           // Max seeder request attempts
    
    // Seeding Persistence settings
    MAX_SEED_STORAGE: 500 * 1024 * 1024,  // 500MB max persistent storage
    SEED_FILES_EXPIRE_DAYS: 7,             // Auto-clean after 7 days
    AUTO_SEED_ON_JOIN: true,               // Re-announce as seeder when joining channel
    PERSIST_PUBLIC_CHANNELS: true,         // Persist files from public channels
    PERSIST_PRIVATE_CHANNELS: false,       // Don't persist files from private channels (privacy)
    
    // Partitions
    PARTITIONS: {
        MESSAGES: 0,  // Text messages (stored)
        CONTROL: 1,   // Presence, typing (ephemeral)
        MEDIA: 2      // Images, file chunks
    }
};

class MediaController {
    constructor() {
        // Image cache: imageId -> base64 data
        this.imageCache = new Map();
        
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
    }

    /**
     * Initialize media controller
     */
    async init() {
        await this.initIndexedDB();
        this.initFileWorker();
        await this.loadPersistedSeedFiles();
        Logger.info('Media controller initialized');
    }

    /**
     * Initialize IndexedDB for file storage (v2 with seedFiles)
     */
    async initIndexedDB() {
        return new Promise((resolve, reject) => {
            // Upgrade to version 2 for seedFiles store
            const request = indexedDB.open('MootMediaDB', 2);
            
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
     * @param {string} streamId - Channel stream ID
     * @param {File} file - Image file
     * @param {string} password - Channel password (optional)
     * @returns {Promise<Object>} - Image message info
     */
    async sendImage(streamId, file, password = null) {
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
        
        // Create image message with data embedded (for LogStore persistence)
        // This goes to partition 0 so it's stored and retrievable from history
        const announcement = await identityManager.createSignedMessage('', streamId);
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
        const channel = channelManager.getChannel(streamId);
        if (channel) {
            channel.messages.push(announcement);
            channelManager.notifyHandlers('message', { streamId, message: announcement });
        }
        
        // Publish announcement with embedded data
        await streamrController.publishMessage(streamId, announcement, password);
        Logger.debug('Image message sent with data:', imageId);
        
        return { messageId, imageId, data: base64Data };
    }

    /**
     * Resize image to max dimensions
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
                    
                    // Check if resize needed
                    if (width <= CONFIG.IMAGE_MAX_WIDTH && height <= CONFIG.IMAGE_MAX_HEIGHT) {
                        resolve(e.target.result);
                        return;
                    }
                    
                    // Calculate scale
                    const scaleW = CONFIG.IMAGE_MAX_WIDTH / width;
                    const scaleH = CONFIG.IMAGE_MAX_HEIGHT / height;
                    const scale = Math.min(scaleW, scaleH);
                    
                    width = Math.round(width * scale);
                    height = Math.round(height * scale);
                    
                    // Draw to canvas
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
     * Handle incoming image data
     * @param {Object} data - Image data message
     */
    handleImageData(data) {
        if (data.type !== 'image_data' || !data.imageId || !data.data) {
            return;
        }
        
        // Cache the image
        this.imageCache.set(data.imageId, data.data);
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
            Logger.debug('Image cached from message:', imageId);
        }
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
     * Request image data from network
     * @param {string} streamId - Channel stream ID
     * @param {string} imageId - Image ID to request
     * @param {string} password - Channel password (optional)
     */
    async requestImage(streamId, imageId, password = null) {
        const request = {
            type: 'image_request',
            imageId: imageId
        };
        await streamrController.publishMedia(streamId, request, password);
        Logger.debug('Image requested:', imageId);
    }

    // ==================== VIDEO/FILE HANDLING ====================

    /**
     * Send a video file (chunked transfer)
     * @param {string} streamId - Channel stream ID
     * @param {File} file - Video file
     * @param {string} password - Channel password (optional)
     * @returns {Promise<Object>} - File metadata
     */
    async sendVideo(streamId, file, password = null) {
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
                streamId: streamId,
                isPrivateChannel: isPrivateChannel,
                callback: async (metadata) => {
                    try {
                        // Create file announcement message
                        const announcement = await identityManager.createSignedMessage('', streamId);
                        announcement.type = 'video_announce';
                        announcement.metadata = metadata;
                        // Keep the id from createSignedMessage (signed)
                        
                        // Add verification info for local display
                        announcement.verified = {
                            valid: true,
                            trustLevel: await identityManager.getTrustLevel(announcement.sender)
                        };
                        
                        // Add to local channel messages & notify UI immediately (for sender)
                        const channel = channelManager.getChannel(streamId);
                        if (channel) {
                            channel.messages.push(announcement);
                            channelManager.notifyHandlers('message', { streamId, message: announcement });
                        }
                        
                        // Publish announcement (partition 0 - messages)
                        await streamrController.publishMessage(streamId, announcement, password);
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
     * @param {string} streamId - Channel stream ID
     * @param {Object} data - Media data
     */
    handleMediaMessage(streamId, data) {
        if (!data || !data.type) return;
        
        switch (data.type) {
            case 'image_data':
                this.handleImageData(data);
                break;
                
            case 'image_request':
                this.handleImageRequest(streamId, data);
                break;
                
            case 'piece_request':
                this.handlePieceRequest(streamId, data);
                break;
                
            case 'file_piece':
                this.handleFilePiece(streamId, data);
                break;
                
            case 'source_request':
                this.handleSourceRequest(streamId, data);
                break;
                
            case 'source_announce':
                this.handleSourceAnnounce(data);
                break;
                
            default:
                Logger.debug('Unknown media type:', data.type);
        }
    }

    /**
     * Handle image request (from another peer)
     * Response is encrypted with channel password for private channels
     */
    async handleImageRequest(streamId, data) {
        const imageData = this.imageCache.get(data.imageId);
        if (!imageData) return;
        
        // Get channel password for encryption
        const channel = channelManager.getChannel(streamId);
        const password = channel?.password || null;
        
        // Send the image data (encrypted if password channel)
        const payload = {
            type: 'image_data',
            imageId: data.imageId,
            data: imageData
        };
        await streamrController.publishMedia(streamId, payload, password);
        Logger.debug('Image data sent in response to request:', data.imageId, password ? '(encrypted)' : '');
    }

    /**
     * Start downloading a file
     * @param {string} streamId - Channel stream ID
     * @param {Object} metadata - File metadata from announcement
     * @param {string} password - Channel password (optional)
     */
    async startDownload(streamId, metadata, password = null) {
        const { fileId, fileName, fileSize, fileType, pieceCount, pieceHashes } = metadata;
        
        if (this.incomingFiles.has(fileId)) {
            Logger.warn('Download already in progress:', fileId);
            return;
        }
        
        // Initialize transfer state
        const transfer = {
            metadata,
            streamId,
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
            
            // Start downloading if we have minimum seeders and haven't started yet
            if (seederCount >= CONFIG.MIN_SEEDERS && !currentTransfer.downloadStarted) {
                currentTransfer.downloadStarted = true;
                Logger.info(`Starting piece download with ${seederCount} seeders for ${fileId}`);
                this.manageDownload(fileId);
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
        
        // Find pieces to request using round-robin across seeders
        for (let i = 0; i < transfer.pieceStatus.length; i++) {
            if (transfer.requestsInFlight.size >= CONFIG.MAX_CONCURRENT_REQUESTS) break;
            
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
     */
    async requestPiece(fileId, pieceIndex, seederId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        transfer.pieceStatus[pieceIndex] = 'requested';
        
        const timeoutId = setTimeout(() => {
            // Request timed out
            if (transfer.pieceStatus[pieceIndex] === 'requested') {
                transfer.pieceStatus[pieceIndex] = 'pending';
                transfer.requestsInFlight.delete(pieceIndex);
                this.manageDownload(fileId);
            }
        }, CONFIG.PIECE_REQUEST_TIMEOUT);
        
        transfer.requestsInFlight.set(pieceIndex, { seederId, timeoutId });
        
        const request = {
            type: 'piece_request',
            fileId,
            pieceIndex,
            targetSeederId: seederId
        };
        
        await streamrController.publishMedia(transfer.streamId, request, transfer.password);
    }

    /**
     * Handle piece request (we are a seeder)
     * Note: Addresses must be normalized to lowercase for comparison
     * because Streamr metadata.publisherId is always lowercase
     */
    async handlePieceRequest(streamId, data) {
        const myAddress = authManager.getAddress()?.toLowerCase();
        const targetAddress = data.targetSeederId?.toLowerCase();
        
        if (!myAddress || targetAddress !== myAddress) return;
        
        const localFile = this.localFiles.get(data.fileId);
        if (!localFile) return;
        
        Logger.debug('Responding to piece request:', data.pieceIndex, 'for file:', data.fileId);
        await this.sendPiece(streamId, data.fileId, data.pieceIndex);
    }

    /**
     * Send a file piece
     * Piece data is encrypted with channel password for private channels
     */
    async sendPiece(streamId, fileId, pieceIndex) {
        const localFile = this.localFiles.get(fileId);
        if (!localFile) return;
        
        const { file, metadata } = localFile;
        const start = pieceIndex * CONFIG.PIECE_SIZE;
        const end = Math.min(start + CONFIG.PIECE_SIZE, file.size);
        
        const chunk = file.slice(start, end);
        const arrayBuffer = await chunk.arrayBuffer();
        const base64 = this.arrayBufferToBase64(arrayBuffer);
        
        // Get channel password for encryption
        const channel = channelManager.getChannel(streamId);
        const password = channel?.password || null;
        
        const payload = {
            type: 'file_piece',
            fileId,
            pieceIndex,
            data: base64
        };
        
        await streamrController.publishMedia(streamId, payload, password);
        Logger.debug('Sent piece', pieceIndex, 'of', fileId, password ? '(encrypted)' : '');
    }

    /**
     * Handle received file piece
     */
    async handleFilePiece(streamId, data) {
        // Skip our own pieces (self-filtering)
        const myAddress = authManager.getAddress()?.toLowerCase();
        if (data.senderId?.toLowerCase() === myAddress) return;
        
        const transfer = this.incomingFiles.get(data.fileId);
        if (!transfer) return;
        
        const { fileId, pieceIndex } = data;
        
        if (transfer.pieceStatus[pieceIndex] !== 'requested') return;
        
        // Decode piece
        const pieceBuffer = this.base64ToArrayBuffer(data.data);
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
        
        // Notify progress with file size for MB display
        const progress = Math.round((transfer.receivedCount / transfer.metadata.pieceCount) * 100);
        if (this.handlers.onFileProgress) {
            this.handlers.onFileProgress(fileId, progress, transfer.receivedCount, transfer.metadata.pieceCount, transfer.metadata.fileSize);
        }
        
        // Check if complete
        if (transfer.receivedCount === transfer.metadata.pieceCount) {
            await this.assembleFile(fileId);
        } else {
            this.manageDownload(fileId);
        }
    }

    /**
     * Assemble completed file
     */
    async assembleFile(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        Logger.info('Assembling file:', fileId);
        
        let blob;
        
        if (transfer.useIndexedDB) {
            blob = await this.assembleFromIndexedDB(fileId, transfer.metadata);
        } else {
            // Combine all pieces
            const totalSize = transfer.pieces.reduce((sum, p) => sum + (p?.length || 0), 0);
            const combined = new Uint8Array(totalSize);
            let offset = 0;
            
            for (const piece of transfer.pieces) {
                if (piece) {
                    combined.set(piece, offset);
                    offset += piece.length;
                }
            }
            
            blob = new Blob([combined], { type: transfer.metadata.fileType });
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
     */
    async requestFileSources(streamId, fileId, password = null) {
        const request = {
            type: 'source_request',
            fileId
        };
        await streamrController.publishMedia(streamId, request, password);
        Logger.debug('Requested sources for:', fileId);
    }

    /**
     * Handle source request
     * Respond with seeder announcement (encrypted if private channel)
     */
    async handleSourceRequest(streamId, data) {
        if (this.localFiles.has(data.fileId)) {
            // Get channel password for encryption
            const channel = channelManager.getChannel(streamId);
            const password = channel?.password || null;
            await this.announceFileSource(streamId, data.fileId, password);
        }
    }

    /**
     * Announce as file source (seeder)
     */
    async announceFileSource(streamId, fileId, password = null) {
        const announce = {
            type: 'source_announce',
            fileId
        };
        await streamrController.publishMedia(streamId, announce, password);
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
            const pieces = [];
            
            const request = store.openCursor();
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.fileId === fileId) {
                        pieces[cursor.value.pieceIndex] = cursor.value.data;
                    }
                    cursor.continue();
                } else {
                    // All pieces collected
                    const totalSize = pieces.reduce((sum, p) => sum + (p?.length || 0), 0);
                    const combined = new Uint8Array(totalSize);
                    let offset = 0;
                    
                    for (const piece of pieces) {
                        if (piece) {
                            combined.set(piece, offset);
                            offset += piece.length;
                        }
                    }
                    
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
     * Called on init() to restore seeding capabilities
     */
    async loadPersistedSeedFiles() {
        if (!this.db || !this.db.objectStoreNames.contains('seedFiles')) {
            Logger.debug('No seedFiles store available');
            return;
        }
        
        try {
            const seedFiles = await this.getAllSeedFiles();
            const now = Date.now();
            const expireMs = CONFIG.SEED_FILES_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
            
            let loadedCount = 0;
            let expiredCount = 0;
            
            for (const record of seedFiles) {
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
            
            if (loadedCount > 0 || expiredCount > 0) {
                Logger.info(`Seed files: loaded ${loadedCount}, expired ${expiredCount}, storage: ${(this.persistedStorageSize / 1024 / 1024).toFixed(2)}MB`);
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
                timestamp: Date.now()
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
     */
    async reannounceForChannel(streamId, password = null) {
        if (!CONFIG.AUTO_SEED_ON_JOIN) return;
        
        let reannounced = 0;
        
        for (const [fileId, fileInfo] of this.localFiles) {
            if (fileInfo.streamId === streamId) {
                await this.announceFileSource(streamId, fileId, password);
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
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
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
            return true;
        }
        
        // Additional browser capability check
        const video = document.createElement('video');
        const canPlay = video.canPlayType(normalizedMime);
        
        Logger.debug('Video playability check:', normalizedMime, 'canPlay:', canPlay);
        
        // Be more permissive - if browser says anything other than empty string, try it
        return canPlay !== '';
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
