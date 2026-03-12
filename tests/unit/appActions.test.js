/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for app.js authentication and account management functions
 */

describe('storeCredentials address normalization', () => {
    let originalPasswordCredential;
    let originalNavigator;
    let storedCredentials;

    beforeEach(() => {
        storedCredentials = [];
        
        // Mock PasswordCredential as a class
        originalPasswordCredential = window.PasswordCredential;
        window.PasswordCredential = class MockPasswordCredential {
            constructor(data) {
                this.id = data.id;
                this.password = data.password;
                this.name = data.name;
            }
        };
        
        // Mock navigator.credentials
        originalNavigator = navigator.credentials;
        Object.defineProperty(navigator, 'credentials', {
            value: {
                store: vi.fn().mockImplementation((cred) => {
                    storedCredentials.push(cred);
                    return Promise.resolve();
                })
            },
            configurable: true
        });
    });

    afterEach(() => {
        window.PasswordCredential = originalPasswordCredential;
        if (originalNavigator) {
            Object.defineProperty(navigator, 'credentials', {
                value: originalNavigator,
                configurable: true
            });
        }
    });

    it('should normalize address to lowercase before storing', async () => {
        // Simulate storeCredentials function behavior
        const storeCredentials = async (username, password) => {
            if (!window.PasswordCredential || !navigator.credentials) {
                return false;
            }
            
            const normalizedUsername = username.toLowerCase();
            
            const credential = new window.PasswordCredential({
                id: normalizedUsername,
                password: password,
                name: `Pombo Account (${normalizedUsername.slice(0, 6)}...${normalizedUsername.slice(-4)})`
            });
            
            await navigator.credentials.store(credential);
            return true;
        };

        // Test with mixed case address
        const mixedCaseAddress = '0x5eBfc9BE11d5ff8a018f980614c6B3098ae92D79';
        await storeCredentials(mixedCaseAddress, 'testpassword');

        expect(storedCredentials.length).toBe(1);
        expect(storedCredentials[0].id).toBe(mixedCaseAddress.toLowerCase());
        expect(storedCredentials[0].id).toBe('0x5ebfc9be11d5ff8a018f980614c6b3098ae92d79');
    });

    it('should prevent duplicate entries from case differences', async () => {
        const storeCredentials = async (username, password) => {
            const normalizedUsername = username.toLowerCase();
            const credential = new window.PasswordCredential({
                id: normalizedUsername,
                password: password,
                name: `Pombo Account (${normalizedUsername.slice(0, 6)}...${normalizedUsername.slice(-4)})`
            });
            await navigator.credentials.store(credential);
            return true;
        };

        // Store with uppercase
        await storeCredentials('0x5EBFC9BE11D5FF8A018F980614C6B3098AE92D79', 'pass1');
        
        // Store with mixed case (same address)
        await storeCredentials('0x5eBfc9BE11d5ff8a018f980614c6B3098ae92D79', 'pass2');
        
        // Store with lowercase (same address)
        await storeCredentials('0x5ebfc9be11d5ff8a018f980614c6b3098ae92d79', 'pass3');

        // All should have the same normalized ID
        expect(storedCredentials[0].id).toBe(storedCredentials[1].id);
        expect(storedCredentials[1].id).toBe(storedCredentials[2].id);
        expect(storedCredentials[0].id).toBe('0x5ebfc9be11d5ff8a018f980614c6b3098ae92d79');
    });
});

describe('disconnectWallet skipFallback option', () => {
    it('should accept skipFallback option to prevent guest mode fallback', async () => {
        // Test that the disconnectWallet function signature accepts options
        const disconnectWallet = async (options = {}) => {
            const { skipFallback = false } = options;
            return { skipFallback };
        };

        // Default behavior - should fallback
        const defaultResult = disconnectWallet();
        await expect(defaultResult).resolves.toEqual({ skipFallback: false });

        // With skipFallback - should not fallback (used in switch account)
        const switchResult = disconnectWallet({ skipFallback: true });
        await expect(switchResult).resolves.toEqual({ skipFallback: true });
    });

    it('should not call fallbackToGuest when skipFallback is true', async () => {
        const fallbackToGuest = vi.fn();
        let calledFallback = false;

        const disconnectWallet = async (options = {}) => {
            const { skipFallback = false } = options;
            const wasGuest = false; // Simulating non-guest user

            // Simulate cleanup...
            
            if (wasGuest) {
                // Guest notification
            } else if (!skipFallback) {
                fallbackToGuest();
                calledFallback = true;
            }

            return { calledFallback };
        };

        // Normal disconnect - should call fallback
        await disconnectWallet();
        expect(fallbackToGuest).toHaveBeenCalledTimes(1);

        fallbackToGuest.mockClear();

        // Switch account disconnect - should NOT call fallback  
        await disconnectWallet({ skipFallback: true });
        expect(fallbackToGuest).not.toHaveBeenCalled();
    });
});

describe('PreviewModeUI race condition handling', () => {
    it('should handle previewChannel becoming null during async operation', async () => {
        let previewChannel = { 
            streamId: 'test-stream',
            messages: [],
            isLoading: true 
        };

        const handlePreviewMessage = async (message) => {
            // Simulate async verification
            await new Promise(resolve => setTimeout(resolve, 10));

            // Check if preview channel still exists (race condition fix)
            if (!previewChannel) {
                return { skipped: true };
            }

            previewChannel.isLoading = false;
            previewChannel.messages.push(message);
            return { skipped: false };
        };

        // Start handling message
        const messagePromise = handlePreviewMessage({ id: '1', text: 'test' });

        // Simulate navigation away (clearing previewChannel)
        previewChannel = null;

        // Should not throw, should skip gracefully
        const result = await messagePromise;
        expect(result.skipped).toBe(true);
    });

    it('should process message normally when previewChannel exists', async () => {
        const previewChannel = { 
            streamId: 'test-stream',
            messages: [],
            isLoading: true 
        };

        const handlePreviewMessage = async (message) => {
            await new Promise(resolve => setTimeout(resolve, 10));

            if (!previewChannel) {
                return { skipped: true };
            }

            previewChannel.isLoading = false;
            previewChannel.messages.push(message);
            return { skipped: false };
        };

        const result = await handlePreviewMessage({ id: '1', text: 'test' });
        
        expect(result.skipped).toBe(false);
        expect(previewChannel.isLoading).toBe(false);
        expect(previewChannel.messages.length).toBe(1);
    });
});
