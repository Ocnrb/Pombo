/**
 * Message Renderer
 * Handles rendering of messages, content types, and related UI
 */

import { escapeHtml, escapeAttr, formatAddress, addressToColor, linkify, embedYouTubeLinks } from './utils.js';
import { GroupPosition, shouldShowSenderName } from './MessageGrouper.js';
import { getAvatar } from './AvatarGenerator.js';
import { sanitizeMessageHtml, sanitizeText } from './sanitizer.js';

class MessageRenderer {
    constructor() {
        this.deps = {};
    }

    /**
     * Set dependencies
     * @param {Object} deps - { getCurrentAddress, getMessageReactions, registerMedia, getImage, cacheImage, requestImage, getCurrentChannel, getFileUrl, isSeeding, isVideoPlayable }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Check if text is emoji-only (no other characters)
     * @param {string} text - Text to check
     * @returns {boolean|string} - false if not emoji-only, 'true' for 1-3 emojis, 'many' for 4+ emojis
     */
    isEmojiOnly(text) {
        if (!text) return false;
        const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
        const stripped = text.replace(/\s/g, '');
        const emojis = stripped.match(emojiRegex);
        if (!emojis || emojis.length === 0) return false;
        
        const withoutEmojis = stripped.replace(emojiRegex, '').replace(/[\uFE0F\u200D]/g, '');
        if (withoutEmojis.length > 0) return false;
        
        return emojis.length <= 3 ? 'true' : 'many';
    }

    /**
     * Wrap emojis in text with span for styling
     * @param {string} html - Escaped HTML text
     * @returns {string} - HTML with emojis wrapped in spans
     */
    wrapInlineEmojis(html) {
        const emojiRegex = /([\p{Emoji_Presentation}\p{Extended_Pictographic}][\uFE0F\u200D]?)/gu;
        return html.replace(emojiRegex, '<span class="inline-emoji">$1</span>');
    }

    /**
     * Format file size for display
     * @param {number} bytes - File size in bytes
     * @returns {string} - Formatted size string
     */
    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    /**
     * Render date separator pill
     * @param {Date} date - Date for separator
     * @returns {string} - HTML for date separator
     */
    renderDateSeparator(date) {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        let dateText;
        if (date.toDateString() === today.toDateString()) {
            dateText = 'Today';
        } else if (date.toDateString() === yesterday.toDateString()) {
            dateText = 'Yesterday';
        } else {
            const month = date.toLocaleDateString('en-US', { month: 'long' });
            const day = date.getDate();
            const year = date.getFullYear();
            
            if (year === today.getFullYear()) {
                dateText = `${month} ${day}`;
            } else {
                dateText = `${month} ${day}, ${year}`;
            }
        }
        
        return `
            <div class="date-separator">
                <span class="date-pill">${dateText}</span>
            </div>
        `;
    }

    /**
     * Render reactions for a message
     * @param {string} msgId - Message ID
     * @param {boolean} isOwn - Whether message is own
     * @returns {string} - HTML for reactions
     */
    renderReactions(msgId, isOwn) {
        const reactions = this.deps.getMessageReactions?.(msgId);
        if (!reactions || Object.keys(reactions).length === 0) {
            return `<div class="reactions-container" data-reactions-for="${escapeAttr(msgId)}"></div>`;
        }

        const currentAddress = this.deps.getCurrentAddress?.()?.toLowerCase();
        let html = `<div class="reactions-container" data-reactions-for="${escapeAttr(msgId)}">`;
        
        for (const [emoji, users] of Object.entries(reactions)) {
            if (users.length > 0) {
                const userReacted = users.some(u => u.toLowerCase() === currentAddress);
                html += `<span class="reaction-badge ${userReacted ? 'user-reacted' : ''}" data-emoji="${escapeAttr(emoji)}" data-msg-id="${escapeAttr(msgId)}"><span class="reaction-emoji">${emoji}</span>${users.length}</span>`;
            }
        }
        
        html += '</div>';
        return html;
    }

    /**
     * Render reply preview for a message
     * @param {Object} replyTo - Reply target info
     * @returns {string} - HTML for reply preview
     */
    renderReplyPreview(replyTo) {
        if (!replyTo) return '';
        
        const displayName = replyTo.senderName || formatAddress(replyTo.sender);
        // Defense-in-depth: sanitize network content
        const previewText = replyTo.text 
            ? escapeHtml(sanitizeText(replyTo.text.substring(0, 50))) + (replyTo.text.length > 50 ? '...' : '') 
            : '[Message]';
        
        return `
            <div class="reply-preview" data-reply-to-id="${escapeAttr(replyTo.id)}">
                <span class="reply-preview-name">${escapeHtml(sanitizeText(displayName))}</span>
                <span class="reply-preview-text">${previewText}</span>
            </div>
        `;
    }

    /**
     * Render image message content
     * @param {Object} msg - Message object
     * @returns {string} - HTML for image
     */
    renderImageContent(msg) {
        let imageData = this.deps.getImage?.(msg.imageId);
        
        // If not in cache but embedded in message (from LogStore), use that and cache it
        if (!imageData && msg.imageData) {
            imageData = msg.imageData;
            this.deps.cacheImage?.(msg.imageId, imageData);
        }
        
        if (imageData) {
            const mediaId = this.deps.registerMedia?.(imageData, 'image');
            if (!mediaId) {
                return `<div class="text-red-400 text-sm">Invalid image data</div>`;
            }
            
            return `
                <div class="relative inline-block max-w-xs group">
                    <img src="${imageData}" 
                         class="max-w-full max-h-60 rounded-lg cursor-pointer object-contain lightbox-trigger" 
                         data-media-id="${mediaId}"
                         alt="Image"/>
                    <button class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white p-1 rounded transition opacity-0 group-hover:opacity-100 lightbox-trigger"
                            data-media-id="${mediaId}"
                            title="Maximize">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                        </svg>
                    </button>
                </div>
            `;
        } else {
            // Request image from network
            const channel = this.deps.getCurrentChannel?.();
            if (channel) {
                this.deps.requestImage?.(channel.streamId, msg.imageId, channel.password);
            }
            return `
                <div data-image-id="${escapeAttr(msg.imageId)}" class="bg-[#1a1a1a] rounded-lg p-4 max-w-xs">
                    <div class="flex items-center gap-2">
                        <div class="animate-spin w-4 h-4 border-2 border-gray-600 border-t-white rounded-full"></div>
                        <span class="text-gray-500 text-sm">Loading image...</span>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Render video announcement content
     * @param {Object} msg - Message object
     * @returns {string} - HTML for video
     */
    renderVideoContent(msg) {
        const metadata = msg.metadata;
        if (!metadata) return escapeHtml(msg.text || '');
        
        const currentAddress = this.deps.getCurrentAddress?.();
        const isOwn = msg.sender?.toLowerCase() === currentAddress?.toLowerCase();
        
        const videoUrl = this.deps.getFileUrl?.(metadata.fileId);
        const isSeeding = this.deps.isSeeding?.(metadata.fileId);
        
        const safeFileId = escapeAttr(metadata.fileId);
        // Defense-in-depth: sanitize network-provided metadata
        const safeFileName = escapeHtml(sanitizeText(metadata.fileName));
        const safeFileType = escapeHtml(sanitizeText(metadata.fileType));
        
        if (videoUrl) {
            const isPlayable = this.deps.isVideoPlayable?.(metadata.fileType);
            const videoMediaId = this.deps.registerMedia?.(videoUrl, 'video');
            
            if (isPlayable && videoMediaId) {
                return `
                    <div data-file-id="${safeFileId}" class="video-container">
                        <div class="relative rounded-lg overflow-hidden bg-black">
                            <video src="${videoUrl}" 
                                   class="w-full max-h-56 cursor-pointer video-player-${safeFileId}" 
                                   controls
                                   preload="metadata"
                                   playsinline>
                                <source src="${videoUrl}" type="${safeFileType}">
                            </video>
                            <button class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white p-1 rounded transition lightbox-trigger"
                                    data-media-id="${videoMediaId}"
                                    title="Fullscreen">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                                </svg>
                            </button>
                            ${isSeeding ? `
                            <div class="absolute bottom-1 left-1 bg-green-600/80 text-white text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1">
                                <svg class="w-2.5 h-2.5 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
                                    <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/>
                                </svg>
                                Seeding
                            </div>
                            ` : ''}
                        </div>
                        <div class="flex items-center gap-2 mt-1 px-0.5 text-[11px] text-gray-500">
                            <span class="truncate flex-1">${safeFileName}</span>
                            <span class="text-gray-600">${this.formatFileSize(metadata.fileSize)}</span>
                            <a href="${videoUrl}" download="${safeFileName}" class="text-blue-400 hover:text-blue-300">Save</a>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div data-file-id="${safeFileId}" class="video-container">
                        <div class="flex items-center gap-2 bg-[#1a1a1a] rounded-lg p-2">
                            <svg class="w-8 h-8 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                            </svg>
                            <div class="flex-1 min-w-0">
                                <div class="text-sm text-white truncate">${safeFileName}</div>
                                <div class="text-[10px] text-yellow-500/80">Format not playable · ${this.formatFileSize(metadata.fileSize)}</div>
                            </div>
                            <a href="${videoUrl}" download="${safeFileName}" class="bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1 rounded text-xs flex-shrink-0 transition">
                                Save
                            </a>
                        </div>
                        ${isSeeding ? `
                        <div class="flex items-center gap-1 mt-1 px-0.5">
                            <div class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                            <span class="text-[10px] text-green-400">Seeding</span>
                        </div>
                        ` : ''}
                    </div>
                `;
            }
        }
        
        // Video not available yet - show preview panel
        return `
            <div data-file-id="${safeFileId}" class="video-container">
                <div class="relative rounded-lg overflow-hidden bg-[#1a1a1a] cursor-pointer group"
                     style="aspect-ratio: 16/9; width: 220px;">
                    <div class="absolute inset-0 flex items-center justify-center">
                        <svg class="w-10 h-10 text-purple-500/20" fill="currentColor" viewBox="0 0 24 24">
                            <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                        </svg>
                    </div>
                    <button class="download-file-btn absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-all" 
                            data-file-id="${safeFileId}">
                        <div class="play-btn-container transform group-hover:scale-105 transition-transform">
                            <div class="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/30">
                                <svg class="w-5 h-5 text-white ml-0.5 download-play-icon" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M8 5v14l11-7z"/>
                                </svg>
                                <div class="download-loading-icon hidden">
                                    <div class="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                </div>
                            </div>
                        </div>
                    </button>
                    <div data-progress-overlay="${safeFileId}" class="hidden absolute inset-0 bg-black/70 flex flex-col items-center justify-center">
                        <div class="text-white text-sm font-medium" data-progress-percent="${safeFileId}">0%</div>
                        <div class="w-2/3 bg-gray-700 rounded-full h-1.5 mt-1.5">
                            <div data-progress-fill="${safeFileId}" class="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style="width: 0%"></div>
                        </div>
                        <div class="text-[10px] text-gray-400 mt-1" data-progress-text="${safeFileId}">Starting...</div>
                    </div>
                    <div class="absolute top-1.5 left-1.5 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1">
                        <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zm12.553 1.106A1 1 0 0014 8v4a1 1 0 00.553.894l2 1A1 1 0 0018 13V7a1 1 0 00-1.447-.894l-2 1z"/>
                        </svg>
                        ${this.formatFileSize(metadata.fileSize)}
                    </div>
                    <div class="absolute top-1.5 right-1.5 bg-black/60 text-gray-400 text-[10px] px-1.5 py-0.5 rounded" data-seeder-count="${safeFileId}"></div>
                </div>
                <div class="mt-1 px-0.5 text-[11px] text-gray-500 truncate" title="${escapeHtml(sanitizeText(metadata.fileName))}">
                    ${escapeHtml(sanitizeText(metadata.fileName))}
                </div>
            </div>
        `;
    }

    /**
     * Render message content based on type
     * @param {Object} msg - Message object
     * @returns {string} - HTML for message content
     */
    renderMessageContent(msg) {
        const type = msg.type || 'text';
        
        switch (type) {
            case 'image':
                return this.renderImageContent(msg);
                
            case 'video_announce':
                return this.renderVideoContent(msg);
                
            default:
                const escapedText = escapeHtml(msg.text || '');
                const withLinks = linkify(escapedText);
                const withYouTube = embedYouTubeLinks(withLinks);
                const withLineBreaks = withYouTube.replace(/\n/g, '<br>');
                // Defense-in-depth: sanitize final HTML before rendering
                return sanitizeMessageHtml(this.wrapInlineEmojis(withLineBreaks));
        }
    }

    /**
     * Build HTML for a single message
     * @param {Object} msg - Message object
     * @param {boolean} isOwn - Whether message is own
     * @param {string} time - Formatted time string
     * @param {Object} badge - Verification badge info
     * @param {string} displayName - Display name
     * @param {string} groupClass - CSS class for group position (optional)
     * @param {string} groupPosition - Group position enum value (optional)
     * @param {string} spacingClass - CSS class for spacing (optional)
     * @returns {string} - HTML for message
     */
    buildMessageHTML(msg, isOwn, time, badge, displayName, groupClass = 'msg-group-single', groupPosition = GroupPosition.SINGLE, spacingClass = '') {
        const msgId = msg.id || msg.timestamp;
        const reactionsHtml = this.renderReactions(msgId, isOwn);
        const contentHtml = this.renderMessageContent(msg);
        const replyPreviewHtml = this.renderReplyPreview(msg.replyTo);
        
        const msgType = msg.type || 'text';
        const emojiOnly = msgType === 'text' ? this.isEmojiOnly(msg.text) : false;
        const emojiAttr = emojiOnly ? ` data-emoji-only="${emojiOnly}"` : '';
        
        // Only show sender row for first/single messages in group
        const showSender = shouldShowSenderName(groupPosition);
        const senderColor = addressToColor(msg.sender);
        // Defense-in-depth: sanitize network-provided displayName
        const senderRowHtml = showSender ? `
                    <div class="message-sender-row flex items-center gap-1 mb-1">
                        ${badge.html}
                        <span class="text-xs font-medium" style="color: ${senderColor}">${escapeHtml(sanitizeText(displayName))}</span>
                    </div>` : '';
        
        // Avatar visible only on last/single messages in group, but placeholder for alignment
        const showAvatar = groupPosition === GroupPosition.LAST || groupPosition === GroupPosition.SINGLE;
        const avatarSvg = getAvatar(msg.sender, 46, 0.22);
        const avatarClass = showAvatar ? 'message-avatar' : 'message-avatar message-avatar-hidden';
        const avatarHtml = `<div class="${avatarClass}">${avatarSvg}</div>`;

        return `
            <div class="message-entry ${isOwn ? 'own-message' : 'other-message'} ${groupClass} ${spacingClass}" data-msg-id="${escapeAttr(msgId)}" data-sender="${escapeAttr(msg.sender || '')}" data-type="${escapeAttr(msgType)}"${emojiAttr}>
                ${!isOwn ? avatarHtml : ''}
                <div class="message-bubble">
                    ${senderRowHtml}
                    ${replyPreviewHtml}
                    <div class="message-content">${contentHtml}</div>
                    <div class="message-footer">
                        ${reactionsHtml}
                        <span class="message-time text-xs text-gray-500">${time}</span>
                    </div>
                    ${msg.verified && !msg.verified.valid && msg.signature ? '<div class="text-xs text-red-400 mt-1">⚠️ Invalid signature</div>' : ''}
                    <span class="reply-trigger reply-btn" data-msg-id="${escapeAttr(msgId)}" title="Reply"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M4 12h11a4 4 0 0 1 4 4v4"/></svg></span>
                    <span class="react-trigger react-btn" data-msg-id="${escapeAttr(msgId)}" title="React"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></span>
                </div>
                ${isOwn ? avatarHtml : ''}
            </div>
        `;
    }
}

// Export singleton instance
export const messageRenderer = new MessageRenderer();
