/**
 * Retry Utility
 * Centralized retry logic with exponential backoff
 */

import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';

/**
 * Execute an async function with retry logic and exponential backoff
 * 
 * @param {string} operationName - Name for logging purposes
 * @param {Function} asyncFn - Async function to execute
 * @param {Object} options - Configuration options
 * @param {number} [options.maxRetries] - Maximum retry attempts (default: CONFIG.retry.maxAttempts)
 * @param {number} [options.baseDelay] - Base delay in ms (default: CONFIG.retry.baseDelayMs)
 * @param {Function} [options.onAttempt] - Callback on each attempt: (attempt, maxRetries) => void
 * @param {Function} [options.onError] - Callback on error: (error, attempt) => void
 * @param {Function} [options.shouldRetry] - Custom retry condition: (error) => boolean
 * @returns {Promise<any>} - Result of asyncFn
 * @throws {Error} - Last error if all retries fail
 */
export async function executeWithRetry(operationName, asyncFn, options = {}) {
    const {
        maxRetries = CONFIG.retry.maxAttempts,
        baseDelay = CONFIG.retry.baseDelayMs,
        onAttempt = null,
        onError = null,
        shouldRetry = () => true
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            Logger.debug(`${operationName} (attempt ${attempt}/${maxRetries})...`);
            
            if (onAttempt) {
                onAttempt(attempt, maxRetries);
            }

            const result = await asyncFn();
            
            if (attempt > 1) {
                Logger.debug(`${operationName} succeeded on attempt ${attempt}`);
            }
            
            return result;

        } catch (error) {
            lastError = error;
            Logger.warn(`${operationName} attempt ${attempt} failed:`, error.message);

            if (onError) {
                onError(error, attempt);
            }

            // Check if we should retry
            if (!shouldRetry(error)) {
                Logger.debug(`${operationName}: not retrying due to error type`);
                throw error;
            }

            if (attempt < maxRetries) {
                const delay = attempt * baseDelay;
                Logger.debug(`Retrying ${operationName} in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    Logger.error(`All ${operationName} attempts failed`);
    throw lastError;
}

/**
 * Execute with retry, checking if resource exists after error
 * Useful for blockchain operations where tx may succeed despite error response
 * 
 * @param {string} operationName - Name for logging
 * @param {Function} asyncFn - Async function to execute
 * @param {Function} checkExistsFn - Function to check if resource was created despite error
 * @param {Object} options - Retry options (same as executeWithRetry)
 * @returns {Promise<any>} - Result of asyncFn or checkExistsFn
 */
export async function executeWithRetryAndVerify(operationName, asyncFn, checkExistsFn, options = {}) {
    const {
        maxRetries = CONFIG.retry.maxAttempts,
        baseDelay = CONFIG.retry.baseDelayMs
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            Logger.debug(`${operationName} (attempt ${attempt}/${maxRetries})...`);
            return await asyncFn();

        } catch (error) {
            lastError = error;
            Logger.warn(`${operationName} attempt ${attempt} failed:`, error.message);

            // Check if operation actually succeeded despite error
            try {
                const existing = await checkExistsFn();
                if (existing) {
                    Logger.info(`${operationName}: resource exists despite error`);
                    return existing;
                }
            } catch (checkError) {
                // Resource doesn't exist, continue retry
            }

            if (attempt < maxRetries) {
                const delay = attempt * baseDelay;
                Logger.debug(`Retrying ${operationName} in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    Logger.error(`All ${operationName} attempts failed`);
    throw lastError;
}
