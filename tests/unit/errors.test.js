import { describe, it, expect } from 'vitest';
import {
    PomboError,
    StorageError,
    CryptoError,
    NetworkError,
    ValidationError,
    Ok,
    Err
} from '../../src/js/utils/errors.js';

describe('Error Hierarchy', () => {
    describe('PomboError', () => {
        it('should carry message and code', () => {
            const err = new PomboError('something broke', 'SOME_CODE');
            expect(err.message).toBe('something broke');
            expect(err.code).toBe('SOME_CODE');
            expect(err.name).toBe('PomboError');
        });

        it('should be an instance of Error', () => {
            const err = new PomboError('msg', 'CODE');
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(PomboError);
        });

        it('should chain the original cause', () => {
            const original = new TypeError('bad type');
            const err = new PomboError('wrapped', 'WRAP', { cause: original });
            expect(err.cause).toBe(original);
        });
    });

    describe('StorageError', () => {
        it('should extend PomboError', () => {
            const err = new StorageError('decrypt failed');
            expect(err).toBeInstanceOf(PomboError);
            expect(err).toBeInstanceOf(StorageError);
            expect(err.name).toBe('StorageError');
            expect(err.code).toBe('STORAGE_ERROR');
        });

        it('should accept custom code', () => {
            const err = new StorageError('corrupt', 'STORAGE_DECRYPT_FAILED');
            expect(err.code).toBe('STORAGE_DECRYPT_FAILED');
        });
    });

    describe('CryptoError', () => {
        it('should extend PomboError', () => {
            const err = new CryptoError('bad key');
            expect(err).toBeInstanceOf(PomboError);
            expect(err.name).toBe('CryptoError');
            expect(err.code).toBe('CRYPTO_ERROR');
        });
    });

    describe('NetworkError', () => {
        it('should extend PomboError', () => {
            const err = new NetworkError('timeout');
            expect(err).toBeInstanceOf(PomboError);
            expect(err.name).toBe('NetworkError');
            expect(err.code).toBe('NETWORK_ERROR');
        });
    });

    describe('ValidationError', () => {
        it('should extend PomboError', () => {
            const err = new ValidationError('missing field');
            expect(err).toBeInstanceOf(PomboError);
            expect(err.name).toBe('ValidationError');
            expect(err.code).toBe('VALIDATION_ERROR');
        });
    });
});

describe('Result Type', () => {
    describe('Ok()', () => {
        it('should create a success result', () => {
            const r = Ok([1, 2, 3]);
            expect(r.ok).toBe(true);
            expect(r.data).toEqual([1, 2, 3]);
        });

        it('should work with null data', () => {
            const r = Ok(null);
            expect(r.ok).toBe(true);
            expect(r.data).toBeNull();
        });
    });

    describe('Err()', () => {
        it('should create a failure result from PomboError', () => {
            const err = new NetworkError('timeout', 'TIMEOUT');
            const r = Err(err);
            expect(r.ok).toBe(false);
            expect(r.error).toBe(err);
            expect(r.error.code).toBe('TIMEOUT');
        });

        it('should wrap a plain string into PomboError', () => {
            const r = Err('something failed');
            expect(r.ok).toBe(false);
            expect(r.error).toBeInstanceOf(PomboError);
            expect(r.error.message).toBe('something failed');
            expect(r.error.code).toBe('UNKNOWN_ERROR');
        });

        it('should pass through a regular Error', () => {
            const err = new Error('generic');
            const r = Err(err);
            expect(r.ok).toBe(false);
            expect(r.error).toBe(err);
        });
    });

    describe('Usage pattern', () => {
        it('should allow type-safe branching', () => {
            const success = Ok({ name: 'test' });
            const failure = Err(new NetworkError('down', 'API_DOWN'));

            // Success branch
            if (success.ok) {
                expect(success.data.name).toBe('test');
            } else {
                throw new Error('Should not reach here');
            }

            // Failure branch
            if (!failure.ok) {
                expect(failure.error.code).toBe('API_DOWN');
            } else {
                throw new Error('Should not reach here');
            }
        });
    });
});
