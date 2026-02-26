// sw.js - Service Worker for Push Notifications
// ================================================
// This file MUST be at the root of the site
// to have scope over all pages.
// ================================================

const SW_VERSION = '1.0.0';

// ================================================
// INSTALLATION
// ================================================

self.addEventListener('install', (event) => {
    console.log('[SW] Installed v' + SW_VERSION);
    // skipWaiting allows immediate activation after installation
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activated');
    // clients.claim() takes control of all open pages
    event.waitUntil(self.clients.claim());
});

// ================================================
// PUSH NOTIFICATION
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
    
    // Relay sends { type: 'wake', channelType: 'private'|'public', timestamp: ... }
    // channelType indicates if it's a private or public channel (without revealing which one)
    
    // Message based on channel type
    let body = 'You have new messages';
    if (data.channelType === 'private') {
        body = 'New message in private channel';
    } else if (data.channelType === 'public') {
        body = 'New message in public channel';
    }
    
    const options = {
        body: body,
        icon: '/favicon/web-app-manifest-192x192.png',
        badge: '/favicon/favicon-96x96.png',
        tag: 'pombo-' + (data.timestamp || Date.now()), // Unique tag per notification
        renotify: true, // Vibrate even if one with this tag already exists
        requireInteraction: false, // Does not require user interaction
        silent: false,
        vibrate: [200, 100, 200],
        data: {
            url: self.registration.scope,
            timestamp: data.timestamp || Date.now(),
            channelType: data.channelType
        },
        actions: [
            {
                action: 'open',
                title: 'Open'
            },
            {
                action: 'dismiss',
                title: 'Dismiss'
            }
        ]
    };
    
    event.waitUntil(
        // First, check if we already have an open window
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clients) => {
                // If there's a focused window, don't show notification
                const focusedClient = clients.find(c => c.focused);
                if (focusedClient) {
                    console.log('[SW] App already focused, skipping visual notification');
                    // But still notify the app
                    focusedClient.postMessage({
                        type: 'PUSH_RECEIVED',
                        timestamp: data.timestamp
                    });
                    return;
                }
                
                // Show notification
                return self.registration.showNotification('Pombo', options);
            })
    );
});

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
// CLIENT MESSAGES
// ================================================

self.addEventListener('message', (event) => {
    console.log('[SW] Message received:', event.data);
    
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
