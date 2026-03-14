/**
 * RPC Errors Module Tests
 * Tests for RPC error detection utilities
 */

import { describe, it, expect } from 'vitest';
import { isRpcError, isDefinitiveNotFound, createPermissionResult } from '../../src/js/utils/rpcErrors.js';

describe('rpcErrors', () => {
    describe('isRpcError', () => {
        describe('should detect RPC errors', () => {
            it('should return true for CALL_EXCEPTION', () => {
                const error = { code: 'CALL_EXCEPTION', message: 'some error' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for NETWORK_ERROR', () => {
                const error = { code: 'NETWORK_ERROR', message: 'network failure' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for SERVER_ERROR', () => {
                const error = { code: 'SERVER_ERROR', message: 'server error' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for TIMEOUT', () => {
                const error = { code: 'TIMEOUT', message: 'request timed out' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for rate limit errors (429)', () => {
                const error = { message: 'HTTP 429 Too Many Requests' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for 502 Bad Gateway', () => {
                const error = { message: 'HTTP error 502' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for 503 Service Unavailable', () => {
                const error = { message: 'HTTP error 503' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for Unauthorized', () => {
                const error = { message: 'Unauthorized access' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for ECONNREFUSED', () => {
                const error = { message: 'connect ECONNREFUSED' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for ETIMEDOUT', () => {
                const error = { message: 'connect ETIMEDOUT' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for fetch failed', () => {
                const error = { message: 'fetch failed' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for network error in message', () => {
                const error = { message: 'A network error occurred' };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for nested error message', () => {
                const error = { 
                    code: 'UNKNOWN_ERROR',
                    error: { message: 'CALL_EXCEPTION' }
                };
                expect(isRpcError(error)).toBe(true);
            });

            it('should return true for socket hang up', () => {
                const error = { message: 'socket hang up' };
                expect(isRpcError(error)).toBe(true);
            });
        });

        describe('should NOT detect non-RPC errors', () => {
            it('should return false for STREAM_NOT_FOUND', () => {
                const error = { code: 'STREAM_NOT_FOUND', message: 'Stream not found' };
                expect(isRpcError(error)).toBe(false);
            });

            it('should return false for permission denied', () => {
                const error = { code: 'PERMISSION_DENIED', message: 'You do not have permission' };
                expect(isRpcError(error)).toBe(false);
            });

            it('should return false for generic error', () => {
                const error = { message: 'Something went wrong' };
                expect(isRpcError(error)).toBe(false);
            });

            it('should return false for null', () => {
                expect(isRpcError(null)).toBe(false);
            });

            it('should return false for undefined', () => {
                expect(isRpcError(undefined)).toBe(false);
            });

            it('should return false for empty object', () => {
                expect(isRpcError({})).toBe(false);
            });
        });
    });

    describe('isDefinitiveNotFound', () => {
        it('should return true for STREAM_NOT_FOUND without RPC error indicators', () => {
            const error = { code: 'STREAM_NOT_FOUND', message: 'Stream not found' };
            expect(isDefinitiveNotFound(error)).toBe(true);
        });

        it('should return false for STREAM_NOT_FOUND with CALL_EXCEPTION', () => {
            // If we get STREAM_NOT_FOUND but also CALL_EXCEPTION, it might be RPC failure
            const error = { code: 'CALL_EXCEPTION', message: 'STREAM_NOT_FOUND' };
            expect(isDefinitiveNotFound(error)).toBe(false);
        });

        it('should return false for CALL_EXCEPTION only', () => {
            const error = { code: 'CALL_EXCEPTION', message: 'some error' };
            expect(isDefinitiveNotFound(error)).toBe(false);
        });

        it('should return false for null', () => {
            expect(isDefinitiveNotFound(null)).toBe(false);
        });

        it('should return false for undefined', () => {
            expect(isDefinitiveNotFound(undefined)).toBe(false);
        });

        it('should return false for generic error', () => {
            const error = { message: 'Something went wrong' };
            expect(isDefinitiveNotFound(error)).toBe(false);
        });
    });

    describe('createPermissionResult', () => {
        it('should create result with hasPermission true', () => {
            const result = createPermissionResult(true, false);
            expect(result).toEqual({
                hasPermission: true,
                rpcError: false,
                errorMessage: null
            });
        });

        it('should create result with hasPermission false', () => {
            const result = createPermissionResult(false, false);
            expect(result).toEqual({
                hasPermission: false,
                rpcError: false,
                errorMessage: null
            });
        });

        it('should create result with rpcError and null permission', () => {
            const result = createPermissionResult(null, true, 'RPC failed');
            expect(result).toEqual({
                hasPermission: null,
                rpcError: true,
                errorMessage: 'RPC failed'
            });
        });

        it('should default rpcError to false', () => {
            const result = createPermissionResult(true);
            expect(result.rpcError).toBe(false);
        });

        it('should default errorMessage to null', () => {
            const result = createPermissionResult(false, true);
            expect(result.errorMessage).toBe(null);
        });

        it('should include all fields even with defaults', () => {
            const result = createPermissionResult(true);
            expect(result).toHaveProperty('hasPermission');
            expect(result).toHaveProperty('rpcError');
            expect(result).toHaveProperty('errorMessage');
        });
    });
});
