/**
 * RPC Error Detection Utilities
 * Helps distinguish transient RPC errors from actual permission/existence errors
 */

/**
 * Error indicators that suggest RPC/network issues rather than actual errors
 */
const RPC_ERROR_INDICATORS = [
    // Error codes from ethers.js / blockchain
    'CALL_EXCEPTION',
    'NETWORK_ERROR',
    'SERVER_ERROR',
    'TIMEOUT',
    'BAD_DATA',
    
    // HTTP status codes
    '429',  // Too Many Requests
    '502',  // Bad Gateway
    '503',  // Service Unavailable
    '504',  // Gateway Timeout
    
    // Common RPC error messages
    'Unauthorized',
    'rate limit',
    'Too Many Requests',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'fetch failed',
    'network error',
    'connection refused',
    'request timeout',
    'getaddrinfo',
    'socket hang up'
];

/**
 * Check if an error is a transient RPC/network error
 * These errors should not be treated as definitive "no permission" or "not found"
 * 
 * @param {Error} error - The error to check
 * @returns {boolean} - True if this appears to be an RPC/network error
 */
export function isRpcError(error) {
    if (!error) return false;
    
    // Build a string from all error properties to check
    const errorString = [
        error.code,
        error.message,
        error.reason,
        error.error?.message,
        error.error?.code
    ].filter(Boolean).join(' ').toLowerCase();
    
    return RPC_ERROR_INDICATORS.some(indicator => 
        errorString.includes(indicator.toLowerCase())
    );
}

/**
 * Check if error is a definitive "stream not found" (not an RPC failure)
 * 
 * @param {Error} error - The error to check
 * @returns {boolean} - True if stream definitely doesn't exist
 */
export function isDefinitiveNotFound(error) {
    if (!error) return false;
    
    // If we have a CALL_EXCEPTION, it's likely RPC failure, not definitive
    if (error.code === 'CALL_EXCEPTION') {
        return false;
    }
    
    // STREAM_NOT_FOUND from a successful RPC call is definitive
    if (error.code === 'STREAM_NOT_FOUND' && !isRpcError(error)) {
        return true;
    }
    
    return false;
}

/**
 * Create a standardized permission result object
 * 
 * @param {boolean|null} hasPermission - true/false/null (null = unknown)
 * @param {boolean} rpcError - true if RPC error occurred
 * @param {string} [errorMessage] - optional error message
 * @returns {Object} - Permission result object
 */
export function createPermissionResult(hasPermission, rpcError = false, errorMessage = null) {
    return {
        hasPermission,
        rpcError,
        errorMessage
    };
}
