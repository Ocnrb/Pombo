import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/js/auth.js', () => ({
    authManager: { getAddress: vi.fn(() => null) }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        ensCache: new Map(),
        getCachedDisplayName: vi.fn((addr) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '')
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { authManager } from '../../src/js/auth.js';
import { identityManager } from '../../src/js/identity.js';
import {
    formatPreviewBody,
    formatPreviewLine,
    formatPreviewSender
} from '../../src/js/ui/channelPreviewFormatter.js';

describe('channelPreviewFormatter', () => {
    beforeEach(() => {
        authManager.getAddress.mockReturnValue(null);
        identityManager.ensCache.clear();
    });

    it('renders text bodies with HTML escaped', () => {
        // sanitizeText strips raw script tags, but the escape contract still
        // applies to ampersands and other HTML-special chars.
        expect(formatPreviewBody({ type: 'text', text: 'Tom & Jerry' }))
            .toBe('Tom &amp; Jerry');
    });

    it('renders [image] / [video] tags for media types', () => {
        expect(formatPreviewBody({ type: 'image' })).toContain('[image]');
        expect(formatPreviewBody({ type: 'video_announce' })).toContain('[video]');
    });

    it('renders reactions with emoji and "reacted with" verb', () => {
        const add = formatPreviewBody({ type: 'reaction', emoji: '🔥', action: 'add' });
        expect(add).toContain('🔥');
        expect(add).toContain('reacted with');
    });

    it('returns empty body for reaction removals (filtered upstream, defensive only)', () => {
        expect(formatPreviewBody({ type: 'reaction', emoji: '🔥', action: 'remove' })).toBe('');
    });

    it('returns empty body for unknown types', () => {
        expect(formatPreviewBody({ type: 'mystery' })).toBe('');
        expect(formatPreviewBody(null)).toBe('');
    });

    it('renders "You" prefix for the local user', () => {
        authManager.getAddress.mockReturnValue('0xMyAddress');
        expect(formatPreviewSender('0xmyaddress')).toBe('You');
    });

    it('renders cached display name for non-self', () => {
        identityManager.getCachedDisplayName.mockReturnValueOnce('alice.eth');
        expect(formatPreviewSender('0xOther')).toBe('alice.eth');
    });

    it('prefers user-set senderName over the cached display name', () => {
        // senderName from message payload wins; identity lookup never happens
        expect(formatPreviewSender('0xOther', 'Alice')).toBe('Alice');
        expect(identityManager.getCachedDisplayName).not.toHaveBeenCalled();
    });

    it('prefers ENS over senderName (ENS is verified, senderName is self-declared)', () => {
        identityManager.ensCache.set('0xother', { name: 'alice.eth' });
        expect(formatPreviewSender('0xOther', 'Alice')).toBe('alice.eth');
    });

    it('falls back to cached display name when senderName is empty', () => {
        identityManager.getCachedDisplayName.mockReturnValueOnce('alice.eth');
        expect(formatPreviewSender('0xOther', '   ')).toBe('alice.eth');
    });

    it('still returns "You" for self even if senderName is provided', () => {
        authManager.getAddress.mockReturnValue('0xMyAddress');
        expect(formatPreviewSender('0xmyaddress', 'WhateverName')).toBe('You');
    });

    it('returns empty for null entry in formatPreviewLine', () => {
        expect(formatPreviewLine(null)).toBe('');
    });

    it('combines sender + body in the preview line', () => {
        identityManager.getCachedDisplayName.mockReturnValueOnce('0xabc…');
        const html = formatPreviewLine({
            type: 'text', text: 'hi', sender: '0xabc'
        });
        expect(html).toContain('hi');
        expect(html).toContain('0xabc');
    });

    it('omits the sender prefix when omitSender is set (DM rows)', () => {
        identityManager.getCachedDisplayName.mockReturnValue('alice.eth');
        const html = formatPreviewLine({
            type: 'text', text: 'hi', sender: '0xother'
        }, { omitSender: true });
        expect(html).toContain('hi');
        expect(html).not.toContain('alice.eth');
        expect(html).not.toContain(': ');
    });
});
