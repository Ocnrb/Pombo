/**
 * Vitest Global Setup
 * Mocks for browser globals and external dependencies
 */

import { vi, beforeEach, afterEach } from 'vitest';

// ============================================
// Browser Globals Mock
// ============================================

// Mock localStorage
const localStorageMock = {
    store: {},
    getItem: vi.fn((key) => localStorageMock.store[key] ?? null),
    setItem: vi.fn((key, value) => { localStorageMock.store[key] = value; }),
    removeItem: vi.fn((key) => { delete localStorageMock.store[key]; }),
    clear: vi.fn(() => { localStorageMock.store = {}; }),
    get length() { return Object.keys(localStorageMock.store).length; },
    key: vi.fn((i) => Object.keys(localStorageMock.store)[i] ?? null),
};

// Mock sessionStorage
const sessionStorageMock = {
    store: {},
    getItem: vi.fn((key) => sessionStorageMock.store[key] ?? null),
    setItem: vi.fn((key, value) => { sessionStorageMock.store[key] = value; }),
    removeItem: vi.fn((key) => { delete sessionStorageMock.store[key]; }),
    clear: vi.fn(() => { sessionStorageMock.store = {}; }),
    get length() { return Object.keys(sessionStorageMock.store).length; },
    key: vi.fn((i) => Object.keys(sessionStorageMock.store)[i] ?? null),
};

// Apply storage mocks
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorageMock, writable: true });

// ============================================
// Crypto API Mock
// ============================================

const cryptoMock = {
    subtle: {
        generateKey: vi.fn(),
        exportKey: vi.fn(),
        importKey: vi.fn(),
        encrypt: vi.fn(),
        decrypt: vi.fn(),
        deriveBits: vi.fn(),
        deriveKey: vi.fn(),
        sign: vi.fn(),
        verify: vi.fn(),
        digest: vi.fn(),
    },
    getRandomValues: vi.fn((arr) => {
        for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
    }),
    randomUUID: vi.fn(() => 'mock-uuid-' + Math.random().toString(36).substring(7)),
};

if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: cryptoMock, writable: true });
}

// ============================================
// IndexedDB Mock (basic)
// ============================================

const indexedDBMock = {
    open: vi.fn(() => ({
        result: {
            createObjectStore: vi.fn(),
            transaction: vi.fn(),
        },
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
    })),
    deleteDatabase: vi.fn(),
};

if (!globalThis.indexedDB) {
    Object.defineProperty(globalThis, 'indexedDB', { value: indexedDBMock, writable: true });
}

// CSS.escape polyfill for test environment
if (!globalThis.CSS) {
    globalThis.CSS = {};
}
if (!globalThis.CSS.escape) {
    globalThis.CSS.escape = function(value) {
        return String(value).replace(/([^\w-])/g, '\\$1');
    };
}

// ============================================
// Clipboard API Mock
// ============================================

const clipboardMock = {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue([]),
};

if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', { value: clipboardMock, writable: true });
}

// ============================================
// Notification API Mock
// ============================================

globalThis.Notification = vi.fn().mockImplementation(() => ({
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
}));
globalThis.Notification.permission = 'default';
globalThis.Notification.requestPermission = vi.fn().mockResolvedValue('granted');

// ============================================
// Web Worker Mock (basic)
// ============================================

globalThis.Worker = vi.fn().mockImplementation(() => ({
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
}));

// ============================================
// Console spy (optional - for debugging)
// ============================================

// Uncomment to suppress console logs during tests:
// vi.spyOn(console, 'log').mockImplementation(() => {});
// vi.spyOn(console, 'warn').mockImplementation(() => {});
// vi.spyOn(console, 'error').mockImplementation(() => {});

// ============================================
// Reset mocks between tests
// ============================================

beforeEach(() => {
    // Clear storage
    localStorageMock.store = {};
    sessionStorageMock.store = {};
    
    // Clear all mock call history
    vi.clearAllMocks();
});

afterEach(() => {
    // Clean up DOM
    document.body.innerHTML = '';
});

// ============================================
// Test Utilities Export
// ============================================

export {
    localStorageMock,
    sessionStorageMock,
    cryptoMock,
    clipboardMock,
};
