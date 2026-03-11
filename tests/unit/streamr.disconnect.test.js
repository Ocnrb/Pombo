/**
 * Streamr Controller - disconnect() Tests
 * Tests that disconnect gracefully handles errors in unsubscribe and client.destroy
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// We test the disconnect logic in isolation by importing the module
// and directly manipulating the singleton's internal state.
import { streamrController } from '../../src/js/streamr.js';

describe('streamrController.disconnect()', () => {
    let mockClient;

    beforeEach(() => {
        // Create a mock Streamr client
        mockClient = {
            destroy: vi.fn().mockResolvedValue(undefined),
            unsubscribe: vi.fn().mockResolvedValue(undefined),
        };

        // Inject mock client into streamrController
        streamrController.client = mockClient;
        streamrController.address = '0xtest123';
        streamrController.subscriptions = new Map();
    });

    it('should clear client and address after disconnect', async () => {
        await streamrController.disconnect();

        expect(streamrController.client).toBeNull();
        expect(streamrController.address).toBeNull();
    });

    it('should call client.destroy()', async () => {
        await streamrController.disconnect();

        expect(mockClient.destroy).toHaveBeenCalledTimes(1);
    });

    it('should do nothing if client is null', async () => {
        streamrController.client = null;

        await streamrController.disconnect();

        expect(streamrController.address).toBeNull();
    });

    it('should survive client.destroy() throwing an error', async () => {
        mockClient.destroy.mockRejectedValue(new Error('Cannot read properties of undefined'));

        await streamrController.disconnect();

        // Should still clean up
        expect(streamrController.client).toBeNull();
        expect(streamrController.address).toBeNull();
    });

    it('should survive unsubscribe throwing an error', async () => {
        // Add a subscription that will fail to unsubscribe
        streamrController.subscriptions.set('stream-1', { unsubscribe: vi.fn() });

        // Mock the unsubscribe method on the controller to throw
        const originalUnsubscribe = streamrController.unsubscribe.bind(streamrController);
        streamrController.unsubscribe = vi.fn().mockRejectedValue(new Error('Already unsubscribed'));

        await streamrController.disconnect();

        // Should still clean up and call destroy
        expect(mockClient.destroy).toHaveBeenCalled();
        expect(streamrController.client).toBeNull();

        // Restore
        streamrController.unsubscribe = originalUnsubscribe;
    });

    it('should attempt to unsubscribe all streams before destroying', async () => {
        streamrController.subscriptions.set('stream-a', { sub: true });
        streamrController.subscriptions.set('stream-b', { sub: true });

        // Mock unsubscribe on the controller
        const originalUnsubscribe = streamrController.unsubscribe.bind(streamrController);
        streamrController.unsubscribe = vi.fn().mockResolvedValue(undefined);

        await streamrController.disconnect();

        expect(streamrController.unsubscribe).toHaveBeenCalledTimes(2);
        expect(streamrController.unsubscribe).toHaveBeenCalledWith('stream-a');
        expect(streamrController.unsubscribe).toHaveBeenCalledWith('stream-b');

        // Restore
        streamrController.unsubscribe = originalUnsubscribe;
    });

    it('should continue unsubscribing even if one fails', async () => {
        streamrController.subscriptions.set('stream-ok', { sub: true });
        streamrController.subscriptions.set('stream-fail', { sub: true });
        streamrController.subscriptions.set('stream-ok2', { sub: true });

        const originalUnsubscribe = streamrController.unsubscribe.bind(streamrController);
        let callCount = 0;
        streamrController.unsubscribe = vi.fn().mockImplementation(async (streamId) => {
            callCount++;
            if (streamId === 'stream-fail') {
                throw new Error('Network error');
            }
        });

        await streamrController.disconnect();

        // All 3 should have been attempted
        expect(streamrController.unsubscribe).toHaveBeenCalledTimes(3);
        // Client should still be destroyed
        expect(mockClient.destroy).toHaveBeenCalled();
        expect(streamrController.client).toBeNull();

        // Restore
        streamrController.unsubscribe = originalUnsubscribe;
    });
});
