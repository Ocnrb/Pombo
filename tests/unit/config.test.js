/**
 * Configuration Module Tests
 * Tests for centralized application configuration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CONFIG, getRpcEndpoints, getNetworkParams, RPC_PRESETS, DEFAULT_RPC_ENDPOINTS } from '../../src/js/config.js';

describe('config', () => {
    describe('CONFIG object', () => {
        it('should have network configuration', () => {
            expect(CONFIG.network).toBeDefined();
            expect(CONFIG.network.chainId).toBe(137);
            expect(CONFIG.network.name).toBe('Polygon Mainnet');
        });

        it('should have valid currency config', () => {
            expect(CONFIG.network.currency.symbol).toBe('POL');
            expect(CONFIG.network.currency.decimals).toBe(18);
        });

        it('should have at least one RPC endpoint', () => {
            expect(CONFIG.network.rpcEndpoints).toBeDefined();
            expect(Array.isArray(CONFIG.network.rpcEndpoints)).toBe(true);
            expect(CONFIG.network.rpcEndpoints.length).toBeGreaterThan(0);
        });

        it('should have retry configuration', () => {
            expect(CONFIG.retry).toBeDefined();
            expect(CONFIG.retry.maxAttempts).toBeGreaterThan(0);
            expect(CONFIG.retry.baseDelayMs).toBeGreaterThan(0);
        });

        it('should have stream configuration', () => {
            expect(CONFIG.stream).toBeDefined();
            expect(CONFIG.stream.initialMessages).toBeGreaterThan(0);
            expect(CONFIG.stream.loadMoreCount).toBeGreaterThan(0);
        });

        it('should have storage configuration', () => {
            expect(CONFIG.storage).toBeDefined();
            expect(['streamr', 'custom']).toContain(CONFIG.storage.defaultProvider);
            expect(CONFIG.storage.defaultRetentionDays).toBeGreaterThan(0);
        });

        it('should have app metadata', () => {
            expect(CONFIG.app).toBeDefined();
            expect(CONFIG.app.name).toBe('pombo');
            expect(CONFIG.app.version).toBeDefined();
        });
    });

    describe('getRpcEndpoints', () => {
        it('should return array of objects with url property', () => {
            const endpoints = getRpcEndpoints();
            expect(Array.isArray(endpoints)).toBe(true);
            endpoints.forEach(endpoint => {
                expect(endpoint).toHaveProperty('url');
                expect(typeof endpoint.url).toBe('string');
            });
        });

        it('should return valid HTTP(S) URLs', () => {
            const endpoints = getRpcEndpoints();
            endpoints.forEach(endpoint => {
                expect(endpoint.url).toMatch(/^https?:\/\//);
            });
        });

        it('should return dRPC as default endpoint', () => {
            const endpoints = getRpcEndpoints();
            expect(endpoints.length).toBe(1);
            expect(endpoints[0].url).toContain('drpc.org');
        });
    });

    describe('getNetworkParams', () => {
        it('should return correctly formatted chainId', () => {
            const params = getNetworkParams();
            expect(params.chainId).toBe('0x89'); // 137 in hex
        });

        it('should include chain name', () => {
            const params = getNetworkParams();
            expect(params.chainName).toBe(CONFIG.network.name);
        });

        it('should include native currency', () => {
            const params = getNetworkParams();
            expect(params.nativeCurrency).toEqual(CONFIG.network.currency);
        });

        it('should include RPC URLs array', () => {
            const params = getNetworkParams();
            expect(Array.isArray(params.rpcUrls)).toBe(true);
            expect(params.rpcUrls).toEqual(CONFIG.network.rpcEndpoints);
        });

        it('should include block explorer URLs', () => {
            const params = getNetworkParams();
            expect(Array.isArray(params.blockExplorerUrls)).toBe(true);
            expect(params.blockExplorerUrls).toContain(CONFIG.network.blockExplorer);
        });
    });

    describe('RPC_PRESETS', () => {
        it('should have an auto preset', () => {
            expect(RPC_PRESETS).toHaveProperty('auto');
            expect(RPC_PRESETS.auto.name).toBe('Auto (try all)');
            expect(Array.isArray(RPC_PRESETS.auto.urls)).toBe(true);
            expect(RPC_PRESETS.auto.urls.length).toBeGreaterThan(0);
        });

        it('should have multiple presets', () => {
            const presetKeys = Object.keys(RPC_PRESETS);
            expect(presetKeys.length).toBeGreaterThan(3);
        });

        it('should have valid URLs in all presets', () => {
            Object.entries(RPC_PRESETS).forEach(([key, preset]) => {
                expect(preset).toHaveProperty('name');
                expect(preset).toHaveProperty('urls');
                expect(Array.isArray(preset.urls)).toBe(true);
                preset.urls.forEach(url => {
                    expect(url).toMatch(/^https:\/\//);
                });
            });
        });

        it('should have drpc preset (recommended)', () => {
            expect(RPC_PRESETS).toHaveProperty('drpc');
            expect(RPC_PRESETS.drpc.urls[0]).toContain('drpc.org');
        });

        it('should not include deprecated endpoints', () => {
            // polygon-rpc.com now requires auth
            // blastapi has CORS issues
            Object.values(RPC_PRESETS).forEach(preset => {
                preset.urls.forEach(url => {
                    expect(url).not.toContain('polygon-rpc.com');
                    expect(url).not.toContain('blastapi');
                });
            });
        });
    });

    describe('DEFAULT_RPC_ENDPOINTS', () => {
        it('should match auto preset urls', () => {
            expect(DEFAULT_RPC_ENDPOINTS).toEqual(RPC_PRESETS.auto.urls);
        });

        it('should have multiple fallback endpoints', () => {
            expect(DEFAULT_RPC_ENDPOINTS.length).toBeGreaterThan(3);
        });
    });

    describe('getRpcEndpoints with localStorage', () => {
        const STORAGE_KEY = 'pombo_rpc_preference';

        beforeEach(() => {
            // Clear localStorage before each test
            localStorage.removeItem(STORAGE_KEY);
        });

        afterEach(() => {
            // Clean up after each test
            localStorage.removeItem(STORAGE_KEY);
        });

        it('should return dRPC endpoints when no preference saved', () => {
            const endpoints = getRpcEndpoints();
            expect(endpoints.length).toBe(1);
            expect(endpoints[0].url).toContain('drpc.org');
        });

        it('should return preset endpoints when preference is saved', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'drpc' }));
            const endpoints = getRpcEndpoints();
            expect(endpoints.length).toBe(1);
            expect(endpoints[0].url).toContain('drpc.org');
        });

        it('should return custom URL when custom preset is saved', () => {
            const customUrl = 'https://my-custom-rpc.com';
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ 
                preset: 'custom', 
                customUrl: customUrl 
            }));
            const endpoints = getRpcEndpoints();
            expect(endpoints.length).toBe(1);
            expect(endpoints[0].url).toBe(customUrl);
        });

        it('should fall back to dRPC on invalid JSON', () => {
            localStorage.setItem(STORAGE_KEY, 'invalid json');
            const endpoints = getRpcEndpoints();
            expect(endpoints.length).toBe(1);
            expect(endpoints[0].url).toContain('drpc.org');
        });

        it('should fall back to dRPC for unknown preset', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'unknown-preset' }));
            const endpoints = getRpcEndpoints();
            expect(endpoints.length).toBe(1);
            expect(endpoints[0].url).toContain('drpc.org');
        });
    });
});
