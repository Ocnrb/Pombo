/**
 * UI Utility Functions
 * Common helpers for HTML escaping, formatting, and validation
 */

/**
 * Escape HTML to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
export function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
}

/**
 * Escape string for use in HTML attributes (alias for escapeHtml)
 * @param {string} str - String to escape
 * @returns {string} - Escaped string safe for attributes
 */
export function escapeAttr(str) {
    return escapeHtml(str);
}

/**
 * Format Ethereum address for display
 * @param {string} address - Full address
 * @returns {string} - Formatted address (e.g., "0x1234...abcd")
 */
export function formatAddress(address) {
    if (!address) return 'Unknown';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Validate URL for safe use in src/href attributes
 * Prevents javascript: and other dangerous protocols
 * @param {string} url - URL to validate
 * @returns {boolean} - True if URL is safe
 */
export function isValidMediaUrl(url) {
    if (!url || typeof url !== 'string') return false;
    // Allow data URIs (base64 images/video), blob URLs, and http(s)
    if (url.startsWith('data:image/') || url.startsWith('data:video/')) return true;
    if (url.startsWith('blob:')) return true;
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}

/**
 * Minimalist color palette for username colors
 * Carefully selected for readability on dark backgrounds (#161616)
 * Excludes green (badge color) and orange (UI accent)
 */
const USERNAME_COLORS = [
    '#E879F9', // Fuchsia
    '#818CF8', // Indigo
    '#38BDF8', // Sky
    '#FBBF24', // Amber
    '#F87171', // Red
    '#A78BFA', // Violet
    '#2DD4BF', // Teal
    '#F472B6', // Pink
    '#60A5FA', // Blue
    '#67E8F9', // Cyan
    '#FDA4AF', // Rose
];

/**
 * Generate a deterministic color from an Ethereum address
 * Uses a simple hash to consistently map addresses to colors
 * @param {string} address - Ethereum address (0x...)
 * @returns {string} - Hex color code
 */
export function addressToColor(address) {
    if (!address || typeof address !== 'string') {
        return USERNAME_COLORS[0];
    }
    
    // Use last 8 characters of address for hash (most entropy)
    const hashPart = address.slice(-8).toLowerCase();
    let hash = 0;
    for (let i = 0; i < hashPart.length; i++) {
        hash = ((hash << 5) - hash) + hashPart.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit integer
    }
    
    const index = Math.abs(hash) % USERNAME_COLORS.length;
    return USERNAME_COLORS[index];
}


