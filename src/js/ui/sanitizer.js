/**
 * HTML Sanitizer Module
 * Provides defense-in-depth sanitization using DOMPurify
 * Falls back to basic escaping if DOMPurify unavailable
 */

import DOMPurify from 'dompurify';

/**
 * DOMPurify configuration for message content
 * Restrictive whitelist allowing only safe formatting tags
 */
const MESSAGE_CONFIG = {
    ALLOWED_TAGS: [
        'b', 'i', 'em', 'strong', 'u', 's', 'strike',
        'br', 'span', 'a', 'code', 'pre', 'div', 'iframe'
    ],
    ALLOWED_ATTR: [
        'href', 'target', 'rel', 'class', 'style',
        'data-media-id', 'data-msg-id', 'data-reply-to-id',
        'data-emoji', 'data-emoji-only', 'title',
        'src', 'frameborder', 'allow', 'allowfullscreen', 'loading'
    ],
    ALLOW_DATA_ATTR: true,
    // Force all links to open in new tab with security attrs
    ADD_ATTR: ['target', 'rel'],
    // Forbid dangerous protocols
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    // Don't return DOM nodes, return string
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
};

/**
 * DOMPurify configuration for user-provided content (names, descriptions)
 * Very restrictive - strips all HTML
 */
const TEXT_ONLY_CONFIG = {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
};

/**
 * Hook to ensure links have security attributes
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
    // Validate iframe src - only allow YouTube nocookie embeds
    if (node.tagName === 'IFRAME') {
        const src = node.getAttribute('src') || '';
        if (!src.startsWith('https://www.youtube-nocookie.com/embed/')) {
            node.removeAttribute('src');
        }
    }
});

/**
 * Sanitize HTML content for message display
 * Allows limited formatting tags, sanitizes everything else
 * @param {string} html - HTML string to sanitize
 * @returns {string} - Sanitized HTML safe for innerHTML
 */
export function sanitizeMessageHtml(html) {
    if (!html) return '';
    try {
        return DOMPurify.sanitize(html, MESSAGE_CONFIG);
    } catch (error) {
        console.error('DOMPurify error, falling back to escape:', error);
        return escapeHtmlFallback(html);
    }
}

/**
 * Sanitize plain text - strips ALL HTML
 * Use for user-provided names, descriptions, etc.
 * @param {string} text - Text that might contain HTML
 * @returns {string} - Plain text with HTML stripped
 */
export function sanitizeText(text) {
    if (!text) return '';
    try {
        return DOMPurify.sanitize(text, TEXT_ONLY_CONFIG);
    } catch (error) {
        console.error('DOMPurify error, falling back to escape:', error);
        return escapeHtmlFallback(text);
    }
}

/**
 * Sanitize a URL - ensures safe protocol
 * @param {string} url - URL to sanitize
 * @returns {string} - Safe URL or empty string
 */
export function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    
    // Check for safe protocols
    const trimmed = url.trim().toLowerCase();
    if (trimmed.startsWith('javascript:') || 
        trimmed.startsWith('data:text/html') ||
        trimmed.startsWith('vbscript:')) {
        return '';
    }
    
    // Allow data URIs for images/video only
    if (trimmed.startsWith('data:')) {
        if (trimmed.startsWith('data:image/') || trimmed.startsWith('data:video/')) {
            return url;
        }
        return '';
    }
    
    // Allow blob URLs
    if (trimmed.startsWith('blob:')) {
        return url;
    }
    
    // Validate http(s) URLs
    try {
        const parsed = new URL(url);
        if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
            return url;
        }
    } catch {
        // Invalid URL
    }
    
    return '';
}

/**
 * Fallback HTML escaping if DOMPurify fails
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeHtmlFallback(str) {
    if (str === null || str === undefined) return '';
    const s = typeof str === 'string' ? str : String(str);
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

/**
 * Check if DOMPurify is available and working
 * @returns {boolean}
 */
export function isSanitizerAvailable() {
    try {
        return DOMPurify.isSupported;
    } catch {
        return false;
    }
}

export default {
    sanitizeMessageHtml,
    sanitizeText,
    sanitizeUrl,
    isSanitizerAvailable,
};
