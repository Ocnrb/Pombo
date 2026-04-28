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
// IndexedDB Mock (functional in-memory)
// ============================================

/**
 * Minimal in-memory IndexedDB mock that supports:
 *  - open / onupgradeneeded / onsuccess
 *  - createObjectStore with keyPath
 *  - createIndex
 *  - transactions (readonly / readwrite)
 *  - put, get, count, delete, openCursor
 *  - index().openCursor(IDBKeyRange.only()), index().getAllKeys()
 */
function createIndexedDBMock() {
    const databases = new Map();

    class MockIDBKeyRange {
        constructor(value) { this._value = value; }
        static only(value) { return new MockIDBKeyRange(value); }
        includes(val) { return val === this._value; }
    }
    if (!globalThis.IDBKeyRange) {
        globalThis.IDBKeyRange = MockIDBKeyRange;
    }

    class MockStore {
        constructor(keyPath) {
            this.keyPath = keyPath;
            this.data = new Map();
            this.indexes = new Map(); // name → { keyPath, records ref }
        }
        createIndex(name, keyPath, _opts) {
            this.indexes.set(name, { keyPath });
            return { keyPath };
        }
        _resolve(req, val) {
            req.result = val;
            if (req.onsuccess) setTimeout(() => req.onsuccess({ target: req }), 0);
        }
        put(value) {
            const key = value[this.keyPath];
            this.data.set(key, structuredClone(value));
            return { onsuccess: null, onerror: null };
        }
        get(key) {
            const req = { result: null, onsuccess: null, onerror: null };
            const val = this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
            Promise.resolve().then(() => this._resolve(req, val));
            return req;
        }
        getAll() {
            const req = { result: null, onsuccess: null, onerror: null };
            const all = Array.from(this.data.values()).map(v => structuredClone(v));
            Promise.resolve().then(() => this._resolve(req, all));
            return req;
        }
        count(key) {
            const req = { result: 0, onsuccess: null, onerror: null };
            const c = key !== undefined ? (this.data.has(key) ? 1 : 0) : this.data.size;
            Promise.resolve().then(() => this._resolve(req, c));
            return req;
        }
        delete(key) {
            this.data.delete(key);
            return { onsuccess: null, onerror: null };
        }
        openCursor() {
            const entries = Array.from(this.data.values());
            let idx = 0;
            const req = { result: null, onsuccess: null, onerror: null };
            const advance = () => {
                if (idx < entries.length) {
                    const value = structuredClone(entries[idx++]);
                    req.result = {
                        value,
                        delete: () => { this.data.delete(value[this.keyPath]); },
                        continue: () => Promise.resolve().then(advance)
                    };
                } else {
                    req.result = null;
                }
                if (req.onsuccess) req.onsuccess({ target: req });
            };
            Promise.resolve().then(advance);
            return req;
        }
        index(name) {
            const idxDef = this.indexes.get(name);
            if (!idxDef) throw new Error(`Index ${name} not found`);
            const store = this;
            return {
                openCursor(range) {
                    const matching = Array.from(store.data.values())
                        .filter(r => range ? range.includes(r[idxDef.keyPath]) : true);
                    let idx = 0;
                    const req = { result: null, onsuccess: null, onerror: null };
                    const advance = () => {
                        if (idx < matching.length) {
                            const value = structuredClone(matching[idx++]);
                            req.result = {
                                value,
                                delete: () => { store.data.delete(value[store.keyPath]); },
                                continue: () => Promise.resolve().then(advance)
                            };
                        } else {
                            req.result = null;
                        }
                        if (req.onsuccess) req.onsuccess({ target: req });
                    };
                    Promise.resolve().then(advance);
                    return req;
                },
                getAllKeys(range) {
                    const req = { result: null, onsuccess: null, onerror: null };
                    const keys = Array.from(store.data.values())
                        .filter(r => range ? range.includes(r[idxDef.keyPath]) : true)
                        .map(r => r[store.keyPath]);
                    Promise.resolve().then(() => {
                        req.result = keys;
                        if (req.onsuccess) req.onsuccess({ target: req });
                    });
                    return req;
                }
            };
        }
    }

    class MockDB {
        constructor(name) {
            this.name = name;
            this.objectStoreNames = { contains: (n) => this.stores.has(n) };
            this.stores = new Map();
        }
        createObjectStore(name, opts) {
            const s = new MockStore(opts?.keyPath || null);
            this.stores.set(name, s);
            return s;
        }
        transaction(storeNames, mode) {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const tx = {
                objectStore: (n) => this.stores.get(n),
                oncomplete: null, onerror: null, error: null
            };
            // Delay oncomplete enough for get→put chains inside the transaction
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 10);
            return tx;
        }
        close() {}
    }

    return {
        _databases: databases,
        open(name, version) {
            const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
            Promise.resolve().then(() => {
                let db = databases.get(name);
                const isNew = !db;
                if (!db) {
                    db = new MockDB(name);
                    databases.set(name, db);
                }
                req.result = db;
                if (isNew && req.onupgradeneeded) {
                    req.onupgradeneeded({ target: req });
                }
                if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
        },
        deleteDatabase(name) {
            databases.delete(name);
            return { onsuccess: null, onerror: null };
        }
    };
}

const indexedDBMock = createIndexedDBMock();
Object.defineProperty(globalThis, 'indexedDB', { value: indexedDBMock, writable: true, configurable: true });

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
    
    // Clear IndexedDB databases
    indexedDBMock._databases.clear();
    
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
    indexedDBMock,
};
