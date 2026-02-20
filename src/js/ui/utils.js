/**
 * UI Utility Functions
 * Common helpers for HTML escaping, formatting, and validation
 */

import { getAddressColor } from './AvatarGenerator.js';

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
 * Generate a deterministic color from an Ethereum address
 * Uses the same color as the avatar for consistency
 * @param {string} address - Ethereum address (0x...)
 * @returns {string} - Hex color code
 */
export function addressToColor(address) {
    return getAddressColor(address);
}