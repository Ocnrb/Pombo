/**
 * SecureStorage Image Ledger Tests (Fase 1)
 * Tests for IndexedDB ledger: initImageStore, saveImageToLedger,
 * getImageBlob, encryptBlob/decryptBlob, clearImagesForStream,
 * evictOldImagesFromLedger, quota handling, exportForSync strip imageData
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureStorage } from '../../src/js/secureStorage.js';

describe('secureStorage image ledger', () => {
    let originalCache, originalIsUnlocked, originalIsGuestMode, originalAddress,
        originalStorageKey, originalStateDB, originalImageDB, originalImageBlobCache, originalImageBlobCacheBytes;

    beforeEach(async () => {
        originalCache = secureStorage.cache;
        originalIsUnlocked = secureStorage.isUnlocked;
        originalIsGuestMode = secureStorage.isGuestMode;
        originalAddress = secureStorage.address;
        originalStorageKey = secureStorage.storageKey;
        originalStateDB = secureStorage.stateDB;
        originalImageDB = secureStorage.imageDB;
        originalImageBlobCache = secureStorage.imageBlobCache;
        originalImageBlobCacheBytes = secureStorage.imageBlobCacheBytes;
        localStorage.clear();
    });

    afterEach(() => {
        if (secureStorage.stateDB && secureStorage.stateDB !== originalStateDB) {
            secureStorage.stateDB.close();
        }
        secureStorage.cache = originalCache;
        secureStorage.isUnlocked = originalIsUnlocked;
        secureStorage.isGuestMode = originalIsGuestMode;
        secureStorage.address = originalAddress;
        secureStorage.storageKey = originalStorageKey;
        secureStorage.stateDB = originalStateDB;
        secureStorage.imageDB = originalImageDB;
        secureStorage.imageBlobCache = originalImageBlobCache;
        secureStorage.imageBlobCacheBytes = originalImageBlobCacheBytes;
        vi.restoreAllMocks();
    });

    // Helper: set up guest mode with empty cache
    function setupGuest() {
        secureStorage.initAsGuest('0xImageTest');
    }

    // Helper: set up account mode with real AES key + IDB
    async function setupAccount() {
        secureStorage.isGuestMode = false;
        secureStorage.isUnlocked = true;
        secureStorage.address = '0ximagetest';
        secureStorage.cache = { sentMessages: {}, sentReactions: {} };
        secureStorage.storageKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
        await secureStorage.initImageStore();
    }

    // ==================== initImageStore ====================
    describe('initImageStore()', () => {
        it('should skip in guest mode', async () => {
            setupGuest();
            await secureStorage.initImageStore();
            expect(secureStorage.imageDB).toBeNull();
        });

        it('should open PomboImageStore database', async () => {
            secureStorage.isGuestMode = false;
            await secureStorage.initImageStore();
            expect(secureStorage.imageDB).not.toBeNull();
            expect(secureStorage.imageBlobCache).toBeInstanceOf(Map);
            expect(secureStorage.imageBlobCacheBytes).toBe(0);
        });

        it('should create images object store with indexes', async () => {
            secureStorage.isGuestMode = false;
            await secureStorage.initImageStore();
            const db = secureStorage.imageDB;
            expect(db).toBeTruthy();
            // Verify store exists by trying a transaction
            const tx = db.transaction('images', 'readonly');
            expect(tx).toBeTruthy();
            expect(tx.objectStore('images')).toBeTruthy();
        });
    });

    // ==================== encryptBlob / decryptBlob ====================
    describe('encryptBlob / decryptBlob', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should encrypt and decrypt round-trip', async () => {
            const original = 'data:image/jpeg;base64,/9j/4AAQTest123';
            const { encryptedData, iv } = await secureStorage.encryptBlob(original);

            expect(encryptedData).toBeTruthy();
            expect(iv).toBeInstanceOf(Uint8Array);
            expect(iv.length).toBe(12);

            const decrypted = await secureStorage.decryptBlob(encryptedData, iv);
            expect(decrypted).toBe(original);
        });

        it('should produce different ciphertext for same plaintext (unique IV)', async () => {
            const data = 'data:image/png;base64,TEST';
            const enc1 = await secureStorage.encryptBlob(data);
            const enc2 = await secureStorage.encryptBlob(data);

            // IVs should differ
            const iv1 = Array.from(enc1.iv);
            const iv2 = Array.from(enc2.iv);
            expect(iv1).not.toEqual(iv2);
        });
    });

    // ==================== saveImageToLedger ====================
    describe('saveImageToLedger()', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should save image to IndexedDB', async () => {
            await secureStorage.saveImageToLedger('img-1', 'data:image/jpeg;base64,AAA', 'stream-abc');

            // Verify in-memory cache updated
            expect(secureStorage.imageBlobCache.has('img-1')).toBe(true);
            expect(secureStorage.imageBlobCache.get('img-1')).toBe('data:image/jpeg;base64,AAA');
        });

        it('should deduplicate by imageId', async () => {
            await secureStorage.saveImageToLedger('img-dup', 'data1', 'stream-1');
            await secureStorage.saveImageToLedger('img-dup', 'data2', 'stream-1');

            // Should still have original data
            const blob = await secureStorage.getImageBlob('img-dup');
            expect(blob).toBe('data1');
        });

        it('should be non-fatal when imageDB is null', async () => {
            secureStorage.imageDB = null;
            // Should not throw
            await secureStorage.saveImageToLedger('img-x', 'data', 'stream-1');
        });
    });

    // ==================== getImageBlob ====================
    describe('getImageBlob()', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should return from in-memory cache first', async () => {
            secureStorage.imageBlobCache.set('img-mem', 'cached-data');
            const result = await secureStorage.getImageBlob('img-mem');
            expect(result).toBe('cached-data');
        });

        it('should fallback to cache.sentMessages scan', async () => {
            secureStorage.cache.sentMessages = {
                'stream-1': [
                    { id: 'msg-1', imageId: 'img-cache', imageData: 'from-cache', type: 'image' }
                ]
            };
            const result = await secureStorage.getImageBlob('img-cache');
            expect(result).toBe('from-cache');
        });

        it('should fallback to IndexedDB and warm memory cache', async () => {
            // Write directly to IDB via saveImageToLedger
            await secureStorage.saveImageToLedger('img-idb', 'idb-data', 'stream-1');

            // Clear memory cache to force IDB lookup
            secureStorage.imageBlobCache.clear();
            secureStorage.imageBlobCacheBytes = 0;

            const result = await secureStorage.getImageBlob('img-idb');
            expect(result).toBe('idb-data');
            // Should now be in memory cache
            expect(secureStorage.imageBlobCache.has('img-idb')).toBe(true);
        });

        it('should return null when image not found anywhere', async () => {
            const result = await secureStorage.getImageBlob('nonexistent');
            expect(result).toBeNull();
        });

        it('should return null when imageDB is null and not in cache', async () => {
            secureStorage.imageDB = null;
            secureStorage.cache.sentMessages = {};
            const result = await secureStorage.getImageBlob('missing');
            expect(result).toBeNull();
        });
    });

    // ==================== addSentMessage with image flush ====================
    describe('addSentMessage() image flush', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should flush image to ledger when type is image', async () => {
            const spy = vi.spyOn(secureStorage, 'saveImageToLedger');
            await secureStorage.addSentMessage('stream-1', {
                id: 'img-msg-1', sender: '0x1', timestamp: Date.now(), signature: '', channelId: 'stream-1',
                type: 'image', imageId: 'img-flush', imageData: 'data:image/jpeg;base64,FLUSH'
            });

            expect(spy).toHaveBeenCalledWith('img-flush', 'data:image/jpeg;base64,FLUSH', 'stream-1');
        });

        it('should NOT flush for text messages', async () => {
            const spy = vi.spyOn(secureStorage, 'saveImageToLedger');
            await secureStorage.addSentMessage('stream-1', {
                id: 'txt-msg', sender: '0x1', timestamp: Date.now(), signature: '', channelId: 'stream-1',
                text: 'Hello'
            });

            expect(spy).not.toHaveBeenCalled();
        });
    });

    // ==================== clearImagesForStream ====================
    describe('clearImagesForStream()', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should delete all images for a given stream', async () => {
            await secureStorage.saveImageToLedger('img-a', 'dataA', 'stream-1');
            await secureStorage.saveImageToLedger('img-b', 'dataB', 'stream-1');
            await secureStorage.saveImageToLedger('img-c', 'dataC', 'stream-2');

            await secureStorage.clearImagesForStream('stream-1');

            // stream-1 images gone
            expect(await secureStorage.getImageBlob('img-a')).toBeNull();
            expect(await secureStorage.getImageBlob('img-b')).toBeNull();
            // stream-2 untouched
            expect(await secureStorage.getImageBlob('img-c')).toBe('dataC');
        });

        it('should be non-fatal when imageDB is null', async () => {
            secureStorage.imageDB = null;
            await secureStorage.clearImagesForStream('stream-1');
        });
    });

    // ==================== clearSentMessages calls clearImagesForStream ====================
    describe('clearSentMessages() with IDB cleanup', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should also clear images from IndexedDB', async () => {
            const spy = vi.spyOn(secureStorage, 'clearImagesForStream');
            secureStorage.cache.sentMessages = {
                'stream-1': [{ id: 'msg-1', text: 'hi', sender: '0x1', timestamp: 1 }]
            };
            await secureStorage.clearSentMessages('stream-1');

            expect(spy).toHaveBeenCalledWith('stream-1');
        });
    });

    // ==================== evictOldImagesFromLedger ====================
    describe('evictOldImagesFromLedger()', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should not evict when under threshold', async () => {
            await secureStorage.saveImageToLedger('img-1', 'data1', 'stream-1');
            await secureStorage.saveImageToLedger('img-2', 'data2', 'stream-1');

            await secureStorage.evictOldImagesFromLedger(10);

            expect(await secureStorage.getImageBlob('img-1')).toBe('data1');
            expect(await secureStorage.getImageBlob('img-2')).toBe('data2');
        });

        it('should be non-fatal when imageDB is null', async () => {
            secureStorage.imageDB = null;
            await secureStorage.evictOldImagesFromLedger(1);
        });
    });

    // ==================== Quota handling in saveToStorage ====================
    describe('saveToStorage() quota handling', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should trim imageData and retry on QuotaExceededError', async () => {
            // Add image messages to cache
            secureStorage.cache.sentMessages = {
                'stream-1': [
                    { id: 'img-1', type: 'image', imageId: 'i1', imageData: 'big-data-1', timestamp: 1 },
                    { id: 'img-2', type: 'image', imageId: 'i2', imageData: 'big-data-2', timestamp: 2 }
                ]
            };

            let callCount = 0;
            vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    const err = new DOMException('quota exceeded', 'QuotaExceededError');
                    throw err;
                }
                // Second call succeeds
            });

            await secureStorage.saveToStorage();

            // With IDB available, only oldest half should be trimmed
            const msgs = secureStorage.cache.sentMessages['stream-1'];
            expect(msgs[0].imageData).toBeUndefined();  // oldest (ts:1) stripped
            expect(msgs[1].imageData).toBe('big-data-2'); // newer (ts:2) kept
        });

        it('should identify QuotaExceededError by name', () => {
            const err = new DOMException('', 'QuotaExceededError');
            expect(secureStorage._isQuotaError(err)).toBe(true);
        });

        it('should identify quota error by code 22', () => {
            const err = { code: 22 };
            expect(secureStorage._isQuotaError(err)).toBe(true);
        });

        it('should return false for non-quota errors', () => {
            expect(secureStorage._isQuotaError(new Error('other'))).toBe(false);
            expect(secureStorage._isQuotaError(null)).toBe(false);
        });

        it('should escalate to forceAll when half-trim is insufficient', async () => {
            secureStorage.cache.sentMessages = {
                'stream-1': [
                    { id: 'img-1', type: 'image', imageId: 'i1', imageData: 'big-data-1', timestamp: 1 },
                    { id: 'img-2', type: 'image', imageId: 'i2', imageData: 'big-data-2', timestamp: 2 },
                    { id: 'img-3', type: 'image', imageId: 'i3', imageData: 'big-data-3', timestamp: 3 },
                    { id: 'img-4', type: 'image', imageId: 'i4', imageData: 'big-data-4', timestamp: 4 }
                ]
            };

            let callCount = 0;
            vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
                callCount++;
                if (callCount <= 2) {
                    // 1st = original, 2nd = after half-trim — both fail
                    throw new DOMException('quota exceeded', 'QuotaExceededError');
                }
                // 3rd call (after all-trim) succeeds
            });

            await secureStorage.saveToStorage();

            const msgs = secureStorage.cache.sentMessages['stream-1'];
            // All imageData should be stripped after forceAll pass
            expect(msgs.every(m => m.imageData === undefined)).toBe(true);
            // Messages themselves are preserved
            expect(msgs).toHaveLength(4);
            expect(msgs[0].imageId).toBe('i1');
        });
    });

    // _trimImageDataFromCache detailed tests are in secureStorage.extended.test.js

    // ==================== exportForSync strips imageData ====================
    describe('exportForSync() imageData stripping', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should strip imageData from exported image messages', () => {
            secureStorage.cache.sentMessages = {
                'stream-1': [
                    { id: 'img-1', type: 'image', imageId: 'x', imageData: 'should-be-stripped', timestamp: 1 },
                    { id: 'txt-1', text: 'hello', timestamp: 2 }
                ]
            };
            secureStorage.cache.sentReactions = {};

            const exported = secureStorage.exportForSync();

            const imgMsg = exported.sentMessages['stream-1'][0];
            expect(imgMsg.imageId).toBe('x');
            expect(imgMsg.imageData).toBeUndefined();
            expect(imgMsg.type).toBe('image');

            const txtMsg = exported.sentMessages['stream-1'][1];
            expect(txtMsg.text).toBe('hello');
        });

        it('should not modify the original cache', () => {
            secureStorage.cache.sentMessages = {
                'stream-1': [
                    { id: 'img-2', type: 'image', imageId: 'y', imageData: 'keep-in-cache', timestamp: 1 }
                ]
            };
            secureStorage.cache.sentReactions = {};

            secureStorage.exportForSync();

            // Original cache should still have imageData
            expect(secureStorage.cache.sentMessages['stream-1'][0].imageData).toBe('keep-in-cache');
        });
    });

    // ==================== lock() cleans up IDB ====================
    describe('lock() IDB cleanup', () => {
        it('should close imageDB and null fields', async () => {
            await setupAccount();
            expect(secureStorage.imageDB).not.toBeNull();

            secureStorage.lock();

            expect(secureStorage.imageDB).toBeNull();
            expect(secureStorage.imageBlobCache).toBeNull();
            expect(secureStorage.imageBlobCacheBytes).toBe(0);
            expect(secureStorage.isUnlocked).toBe(false);
        });
    });

    // ==================== _warmImageCache (memory cap) ====================
    describe('_warmImageCache()', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should evict oldest when over cap', () => {
            secureStorage.IMAGE_CACHE_MAX_BYTES = 20;
            secureStorage._warmImageCache('a', '1234567890'); // 10 bytes
            secureStorage._warmImageCache('b', '1234567890'); // 10 bytes → 20, at cap
            secureStorage._warmImageCache('c', '12345');      // 5 bytes → 25, over cap

            // 'a' should have been evicted
            expect(secureStorage.imageBlobCache.has('a')).toBe(false);
            expect(secureStorage.imageBlobCache.has('b')).toBe(true);
            expect(secureStorage.imageBlobCache.has('c')).toBe(true);
            expect(secureStorage.imageBlobCacheBytes).toBe(15);
        });

        it('should not add duplicates', () => {
            secureStorage._warmImageCache('a', '12345');
            secureStorage._warmImageCache('a', '12345');
            expect(secureStorage.imageBlobCacheBytes).toBe(5);
        });
    });

    // ==================== getUnsyncedImages / markImageSynced ====================
    describe('getUnsyncedImages / markImageSynced', () => {
        beforeEach(async () => {
            await setupAccount();
        });

        it('should yield unsynced images', async () => {
            await secureStorage.saveImageToLedger('img-u1', 'data1', 'stream-1');
            await secureStorage.saveImageToLedger('img-u2', 'data2', 'stream-1');

            const unsynced = [];
            for await (const record of secureStorage.getUnsyncedImages()) {
                unsynced.push(record);
            }
            expect(unsynced).toHaveLength(2);
            expect(unsynced[0].imageId).toBe('img-u1');
            expect(unsynced[0].synced).toBe(0);
        });

        it('should not yield after markImageSynced', async () => {
            await secureStorage.saveImageToLedger('img-s1', 'data1', 'stream-1');
            await secureStorage.markImageSynced('img-s1');

            const unsynced = [];
            for await (const record of secureStorage.getUnsyncedImages()) {
                unsynced.push(record);
            }
            expect(unsynced).toHaveLength(0);
        });
    });
});
