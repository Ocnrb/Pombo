/**
 * CSP-safe polyfills
 * These polyfills do NOT use inline scripts (safe for strict CSP)
 */

// setImmediate polyfill using MessageChannel (CSP-safe)
// Needed by @streamr/sdk's internal dependencies
if (typeof globalThis.setImmediate === 'undefined') {
    const channel = new MessageChannel();
    const queue = [];
    
    channel.port1.onmessage = () => {
        const fn = queue.shift();
        if (fn) fn();
    };
    
    globalThis.setImmediate = (fn, ...args) => {
        queue.push(() => fn(...args));
        channel.port2.postMessage(0);
        return queue.length;
    };
    
    globalThis.clearImmediate = (id) => {
        // Simple implementation - just mark as cleared
        if (id > 0 && id <= queue.length) {
            queue[id - 1] = null;
        }
    };
}
