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
    if (str === null || str === undefined) return '';
    // Ensure str is a string (handles objects, numbers, etc.)
    const s = typeof str === 'string' ? str : String(str);
    return s.replace(/&/g, '&amp;')
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

/**
 * Convert URLs in text to clickable links
 * MUST be called on already HTML-escaped text to prevent XSS
 * @param {string} escapedText - HTML-escaped text
 * @returns {string} - Text with URLs converted to anchor tags
 */
export function linkify(escapedText) {
    if (!escapedText) return '';
    
    // URL regex pattern - matches http, https URLs
    // Works on escaped text where < > are already &lt; &gt;
    const urlPattern = /(https?:\/\/[^\s<>"'`()\[\]{}]+)/gi;
    
    return escapedText.replace(urlPattern, (url) => {
        // Decode HTML entities for the href (browser will encode as needed)
        let decodedUrl = url
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
        
        // Validate URL to prevent javascript: or other dangerous protocols
        try {
            const parsed = new URL(decodedUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return url; // Return original escaped text, not a link
            }
        } catch {
            return url; // Invalid URL, return as plain text
        }
        
        // Escape for href attribute (quotes and special chars)
        const safeHref = decodedUrl
            .replace(/"/g, '%22')
            .replace(/'/g, '%27')
            .replace(/</g, '%3C')
            .replace(/>/g, '%3E');
        
        // Truncate display text if too long
        const displayUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;
        
        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="text-[#F6851B] hover:underline break-all">${displayUrl}</a>`;
    });
}