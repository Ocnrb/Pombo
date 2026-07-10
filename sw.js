// sw.js - Service Worker for Push Notifications with Client Verification
// ================================================
// This file MUST be at the root of the site
// to have scope over all pages.
// ================================================

const SW_VERSION = '2.3.0';

// ================================================
// INDEXEDDB CONFIGURATION
// ================================================

const DB_NAME = 'pombo-sw';
const DB_VERSION = 2;
const STORES = {
    CHANNELS: 'channels',
    LAST_SEEN: 'lastSeen',
    CONFIG: 'config',
    DM_PEERS: 'dmPeers'
};

let db = null;

// Default storage endpoints - Pombo official storage node (July 2026)
const DEFAULT_STORAGE_ENDPOINTS = [
    'https://blob-storage-streamr.online',
    'https://vps2.blob-storage-streamr.online',
];

const API_PATH = '/streams/{streamId}/data/partitions/{partition}/last?count=1';

// ================================================
// INDEXEDDB FUNCTIONS
// ================================================

async function openDatabase() {
    if (db) return db;
    
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            console.error('[SW] IndexedDB error:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            console.log('[SW] IndexedDB opened');
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            // Channels store with index on tag
            if (!database.objectStoreNames.contains(STORES.CHANNELS)) {
                const channelsStore = database.createObjectStore(STORES.CHANNELS, { keyPath: 'streamId' });
                channelsStore.createIndex('tag', 'tag', { unique: true });
                console.log('[SW] Created channels store with tag index');
            }
            
            // LastSeen store
            if (!database.objectStoreNames.contains(STORES.LAST_SEEN)) {
                database.createObjectStore(STORES.LAST_SEEN, { keyPath: 'streamId' });
                console.log('[SW] Created lastSeen store');
            }
            
            // Config store
            if (!database.objectStoreNames.contains(STORES.CONFIG)) {
                database.createObjectStore(STORES.CONFIG, { keyPath: 'key' });
                console.log('[SW] Created config store');
            }
            
            // DM Peers store (address -> name mapping)
            if (!database.objectStoreNames.contains(STORES.DM_PEERS)) {
                database.createObjectStore(STORES.DM_PEERS, { keyPath: 'address' });
                console.log('[SW] Created dmPeers store');
            }
        };
    });
}

async function getChannelByTag(tag) {
    if (!db) await openDatabase();
    
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORES.CHANNELS, STORES.LAST_SEEN], 'readonly');
        const channelsStore = tx.objectStore(STORES.CHANNELS);
        const lastSeenStore = tx.objectStore(STORES.LAST_SEEN);
        
        const tagIndex = channelsStore.index('tag');
        const request = tagIndex.get(tag);
        
        request.onsuccess = () => {
            const channel = request.result;
            if (!channel) {
                resolve(null);
                return;
            }
            
            // Get last seen timestamp
            const lastSeenReq = lastSeenStore.get(channel.streamId);
            lastSeenReq.onsuccess = () => {
                resolve({
                    ...channel,
                    lastTimestamp: lastSeenReq.result?.timestamp || 0
                });
            };
            lastSeenReq.onerror = () => {
                resolve({
                    ...channel,
                    lastTimestamp: 0
                });
            };
        };
        
        request.onerror = () => reject(request.error);
    });
}

async function updateLastSeen(streamId, timestamp) {
    if (!db) await openDatabase();
    
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.LAST_SEEN, 'readwrite');
        const store = tx.objectStore(STORES.LAST_SEEN);
        
        store.put({
            streamId,
            timestamp,
            updatedAt: Date.now()
        });
        
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function syncChannelsToIndexedDB(channels) {
    if (!db) await openDatabase();
    
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.CHANNELS, 'readwrite');
        const store = tx.objectStore(STORES.CHANNELS);
        
        // Clear old channels
        const clearReq = store.clear();
        
        clearReq.onsuccess = () => {
            // Add new channels
            for (const channel of channels) {
                store.put({
                    streamId: channel.streamId,
                    type: channel.type,
                    name: channel.name || 'Channel',
                    tag: channel.tag,
                    storageEndpoints: channel.storageEndpoints || [],
                    lastChecked: Date.now()
                });
            }
        };
        
        tx.oncomplete = () => {
            console.log('[SW] Synced', channels.length, 'channels to IndexedDB');
            resolve();
        };
        tx.onerror = () => reject(tx.error);
    });
}

async function syncDMPeersToIndexedDB(dmPeers) {
    if (!db) await openDatabase();
    if (!dmPeers || dmPeers.length === 0) return;
    
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.DM_PEERS, 'readwrite');
        const store = tx.objectStore(STORES.DM_PEERS);
        
        // Clear old peers
        const clearReq = store.clear();
        
        clearReq.onsuccess = () => {
            // Add new peers
            for (const peer of dmPeers) {
                store.put({
                    address: peer.address.toLowerCase(),
                    name: peer.name
                });
            }
        };
        
        tx.oncomplete = () => {
            console.log('[SW] Synced', dmPeers.length, 'DM peers to IndexedDB');
            resolve();
        };
        tx.onerror = () => reject(tx.error);
    });
}

async function getDMPeerName(address) {
    if (!db) await openDatabase();
    if (!address) return null;
    
    return new Promise((resolve) => {
        const tx = db.transaction(STORES.DM_PEERS, 'readonly');
        const store = tx.objectStore(STORES.DM_PEERS);
        
        const request = store.get(address.toLowerCase());
        
        request.onsuccess = () => {
            resolve(request.result?.name || null);
        };
        request.onerror = () => {
            resolve(null);
        };
    });
}

// ================================================
// HTTP VERIFICATION FUNCTIONS
// ================================================

function buildUrl(endpoint, streamId, partition = 0) {
    const encoded = encodeURIComponent(streamId);
    return endpoint + API_PATH
        .replace('{streamId}', encoded)
        .replace('{partition}', partition);
}

async function fetchWithTimeout(url, timeout = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }
        
        const data = await response.json();
        
        if (!data || data.length === 0) {
            return { success: true, timestamp: 0 };
        }
        
        const msg = data[0];
        return {
            success: true,
            timestamp: msg.timestamp,
            content: msg.content,
            publisherId: msg.publisherId
        };
        
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

async function verifyChannel(channel) {
    const { streamId, lastTimestamp, storageEndpoints } = channel;
    
    const endpoints = storageEndpoints?.length > 0 
        ? storageEndpoints 
        : DEFAULT_STORAGE_ENDPOINTS;
    
    // Try each endpoint until one responds
    for (const endpoint of endpoints) {
        try {
            const url = buildUrl(endpoint, streamId, 0);
            const result = await fetchWithTimeout(url, 5000);
            
            if (result.success) {
                const hasNew = result.timestamp > lastTimestamp;
                return {
                    hasNew,
                    timestamp: result.timestamp,
                    content: hasNew ? result.content : null,
                    publisherId: hasNew ? result.publisherId : null
                };
            }
        } catch (error) {
            console.warn(`[SW] Endpoint ${endpoint} failed:`, error.message);
        }
    }
    
    console.warn('[SW] All storage endpoints failed for', streamId);
    return { hasNew: false, error: 'All endpoints failed' };
}

// ================================================
// MESSAGE PREVIEW FOR NOTIFICATIONS
// ================================================

function getMessagePreview(channel) {
    const { type, content } = channel;
    
    // DM/Private/native channels - content is encrypted
    if (type === 'dm' || type === 'private' || type === 'native') {
        return (type === 'dm' || type === 'native')
            ? 'New direct message' 
            : 'New encrypted message';
    }
    
    // Public channels - show content
    if (!content) {
        return 'New message';
    }
    
    switch (content.type) {
        case 'text':
            const text = content.text || '';
            return text.length > 100 ? text.substring(0, 100) + '...' : text;
        case 'image':
            return '📷 Image';
        case 'file':
            return `📎 ${content.fileName || 'File'}`;
        case 'audio':
            return '🎵 Audio message';
        case 'video':
            return '🎬 Video';
        case 'gif':
            return '🎞️ GIF';
        case 'reaction':
            return `Reacted with ${content.emoji || '👍'}`;
        default:
            return 'New message';
    }
}

// ================================================
// INSTALLATION
// ================================================

self.addEventListener('install', (event) => {
    console.log('[SW] Installed v' + SW_VERSION);
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activated');
    event.waitUntil(
        (async () => {
            await openDatabase();
            await self.clients.claim();
            console.log('[SW] Ready for push verification');
        })()
    );
});

// ================================================
// PUSH NOTIFICATION WITH VERIFICATION
// ================================================

self.addEventListener('push', (event) => {
    console.log('[SW] Push received');
    
    let data = {};
    try {
        if (event.data) {
            data = event.data.json();
        }
    } catch (e) {
        console.warn('[SW] Push data is not JSON:', e);
    }
    
    event.waitUntil(handlePushWithVerification(data));
});

async function handlePushWithVerification(pushData) {
    try {
        if (!db) {
            await openDatabase();
        }
        
        const { tag } = pushData;
        
        // If no tag, can't verify - ignore (K-anonymity noise)
        if (!tag) {
            console.log('[SW] Push without tag - ignoring (K-anonymity noise)');
            return;
        }
        
        // Find channel by tag
        const channel = await getChannelByTag(tag);
        
        if (!channel) {
            console.log('[SW] Channel not found for tag - ignoring (not subscribed)');
            return;
        }
        
        // Verify this channel via HTTP
        console.log('[SW] Verifying channel:', channel.name || channel.streamId);
        const result = await verifyChannel(channel);
        
        if (!result.hasNew) {
            console.log('[SW] No new messages - false positive');
            return;
        }
        
        // Update lastSeen
        await updateLastSeen(channel.streamId, result.timestamp);
        
        // Show notification with real data
        await showVerifiedNotification({
            ...channel,
            newTimestamp: result.timestamp,
            content: result.content,
            publisherId: result.publisherId
        });
        
    } catch (error) {
        console.error('[SW] Verification error:', error);
        // Fallback: show generic notification
        await showFallbackNotification(pushData);
    }
}

async function showVerifiedNotification(channelWithNews) {
    // For DM notifications, look up the sender's name
    let title = channelWithNews.name || 'Pombo';
    
    if (channelWithNews.type === 'dm' && channelWithNews.publisherId) {
        const senderName = await getDMPeerName(channelWithNews.publisherId);
        if (senderName) {
            title = senderName;
        }
    }
    
    const body = getMessagePreview(channelWithNews);
    
    const options = {
        body: body,
        icon: '/favicon/web-app-manifest-192x192.png',
        badge: '/favicon/favicon-96x96.png',
        tag: 'pombo-' + Date.now(),
        renotify: true,
        requireInteraction: false,
        silent: false,
        vibrate: [200, 100, 200],
        data: {
            url: '/',
            channelStreamId: channelWithNews.streamId,
            timestamp: channelWithNews.newTimestamp
        },
        actions: [
            { action: 'open', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    };
    
    // Check if app is focused
    const clients = await self.clients.matchAll({ 
        type: 'window', 
        includeUncontrolled: true 
    });
    
    const focusedClient = clients.find(c => c.focused);
    if (focusedClient) {
        console.log('[SW] App already focused - notifying via postMessage');
        focusedClient.postMessage({
            type: 'NEW_MESSAGE',
            streamId: channelWithNews.streamId,
            timestamp: channelWithNews.newTimestamp,
            content: channelWithNews.content
        });
        return;
    }
    
    return self.registration.showNotification(title, options);
}

async function showFallbackNotification(pushData) {
    const options = {
        body: pushData.channelType === 'private' 
            ? 'New message in private channel' 
            : 'You may have new messages',
        icon: '/favicon/web-app-manifest-192x192.png',
        badge: '/favicon/favicon-96x96.png',
        tag: 'pombo-fallback-' + Date.now(),
        renotify: true,
        vibrate: [200, 100, 200],
        data: {
            url: '/'
        }
    };
    
    return self.registration.showNotification('Pombo', options);
}

// ================================================
// NOTIFICATION CLICK
// ================================================

self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification clicked:', event.action);
    
    event.notification.close();
    
    if (event.action === 'dismiss') {
        return;
    }
    
    // Open or focus the app
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clients) => {
                // If we already have a window, focus it
                if (clients.length > 0) {
                    const client = clients[0];
                    client.focus();
                    // Notify that it was clicked
                    client.postMessage({
                        type: 'NOTIFICATION_CLICKED'
                    });
                    return;
                }
                
                // Otherwise, open new window
                return self.clients.openWindow(event.notification.data?.url || '/');
            })
    );
});

// ================================================
// NOTIFICATION CLOSE
// ================================================

self.addEventListener('notificationclose', (event) => {
    console.log('[SW] Notification closed');
});

// ================================================
// WEB SHARE TARGET
// Receives images shared from any Android app (Tenor, Gallery,
// Samsung Keyboard long-press → Share, etc.) when Pombo is installed
// as a PWA. Files are stashed in a Cache and the page is redirected
// to /?share=1 so the SPA can pick them up on boot.
// ================================================

const SHARE_CACHE = 'pombo-share-v1';
const SHARE_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'POST' || url.pathname !== '/share') return;
    event.respondWith(handleShareTarget(event.request));
});

async function handleShareTarget(request) {
    try {
        const formData = await request.formData();
        const files = formData.getAll('shared').filter(f =>
            f instanceof File && SHARE_ALLOWED_MIME.includes(f.type)
        );
        const cache = await caches.open(SHARE_CACHE);
        // Wipe previous shares so we never replay stale files.
        const old = await cache.keys();
        await Promise.all(old.map(req => cache.delete(req)));
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            await cache.put(
                `/__shared/${i}`,
                new Response(file, {
                    headers: {
                        'Content-Type': file.type,
                        'X-Pombo-Filename': encodeURIComponent(file.name || `shared-${i}`)
                    }
                })
            );
        }
    } catch (err) {
        console.warn('[SW] Share target handling failed:', err?.message);
    }
    return Response.redirect('/?share=1', 303);
}

// ================================================
// CLIENT MESSAGES
// ================================================

self.addEventListener('message', async (event) => {
    const { type } = event.data || {};
    
    // Sync channels from app
    if (type === 'SYNC_CHANNELS') {
        console.log('[SW] Syncing channels:', event.data.channels?.length || 0);
        await syncChannelsToIndexedDB(event.data.channels || []);
        
        // Also sync DM peer names if provided
        if (event.data.dmPeers && event.data.dmPeers.length > 0) {
            console.log('[SW] Syncing DM peers:', event.data.dmPeers.length);
            await syncDMPeersToIndexedDB(event.data.dmPeers);
        }
        return;
    }
    
    // Update last seen timestamp
    if (type === 'UPDATE_LAST_SEEN') {
        await updateLastSeen(event.data.streamId, event.data.timestamp);
        return;
    }
    
    // Force update
    if (type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }
    
    console.log('[SW] Unknown message type:', type);
});
