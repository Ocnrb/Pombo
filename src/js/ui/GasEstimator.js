/**
 * Gas Estimator for Polygon Network
 * Handles gas price estimation and balance queries
 */

import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';

export const GasEstimator = {
    // RPC endpoints from centralized config
    RPC_URLS: CONFIG.network.rpcEndpoints,
    currentRpcIndex: 0,
    
    // Approximate gas units for Streamr operations (based on real tx data)
    GAS_UNITS: {
        createStream: 420000,           // Creating a new stream
        setPublicPermissions: 80000,    // Public permissions (single assignment)
        setPermissionsBatch: 210000,    // Batch setPermissions (multiple members)
        addStorageNode: 165000,         // Adding stream to storage node
    },
    
    cachedGasPrice: null,
    cacheTime: 0,
    CACHE_DURATION: 60000, // 1 minute
    
    async rpcCall(method, params = []) {
        let lastError = null;
        const startIndex = this.currentRpcIndex;
        
        // Try each RPC in sequence, starting from the last successful one
        for (let i = 0; i < this.RPC_URLS.length; i++) {
            const index = (startIndex + i) % this.RPC_URLS.length;
            const rpcUrl = this.RPC_URLS[index];
            
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), CONFIG.network.rpcTimeoutMs);
                
                const response = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: method,
                        params: params,
                        id: 1
                    }),
                    signal: controller.signal
                });
                
                clearTimeout(timeout);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                
                if (data.error) {
                    throw new Error(data.error.message || 'RPC error');
                }
                
                // Success - remember this RPC for next time
                this.currentRpcIndex = index;
                return data;
            } catch (error) {
                lastError = error;
                Logger.debug(`RPC ${rpcUrl} failed: ${error.message}`);
                continue;
            }
        }
        
        throw lastError || new Error('All RPCs failed');
    },
    
    async getGasPrice() {
        const now = Date.now();
        if (this.cachedGasPrice && (now - this.cacheTime) < this.CACHE_DURATION) {
            return this.cachedGasPrice;
        }
        
        try {
            const data = await this.rpcCall('eth_gasPrice');
            const gasPriceWei = parseInt(data.result, 16);
            this.cachedGasPrice = gasPriceWei;
            this.cacheTime = now;
            return gasPriceWei;
        } catch (error) {
            Logger.warn('Failed to fetch gas price:', error);
            // Fallback gas price if all RPCs fail
            return CONFIG.network.fallbackGasPriceGwei * 1e9;
        }
    },
    
    formatPOL(wei) {
        const pol = wei / 1e18;
        if (pol < 0.0001) return '< 0.0001 POL';
        if (pol < 0.01) return `~${pol.toFixed(4)} POL`;
        return `~${pol.toFixed(3)} POL`;
    },
    
    formatGwei(wei) {
        const gwei = wei / 1e9;
        return `${gwei.toFixed(1)} gwei`;
    },
    
    async estimateCosts() {
        const gasPrice = await this.getGasPrice();
        
        // All channels create 2 streams (message + ephemeral) + set permissions on both + storage on message stream
        // Public/Password: 2× createStream + 2× setPublicPermissions + 1× addStorageNode
        const publicCost = gasPrice * (2 * this.GAS_UNITS.createStream + 2 * this.GAS_UNITS.setPublicPermissions + this.GAS_UNITS.addStorageNode);
        // Native: 2× createStream + 2× setPermissionsBatch + 1× addStorageNode
        const nativeCost = gasPrice * (2 * this.GAS_UNITS.createStream + 2 * this.GAS_UNITS.setPermissionsBatch + this.GAS_UNITS.addStorageNode);
        // DM Inbox: same as public (2 streams + 2 public permissions + 1 storage node)
        const dmInboxCost = publicCost;
        
        return {
            public: publicCost,
            password: publicCost,
            native: nativeCost,
            dmInbox: dmInboxCost,
            gasPrice: gasPrice,
            formatted: {
                public: this.formatPOL(publicCost),
                password: this.formatPOL(publicCost),
                native: this.formatPOL(nativeCost),
                dmInbox: this.formatPOL(dmInboxCost),
                gasPrice: this.formatGwei(gasPrice)
            }
        };
    },

    async getBalance(address) {
        try {
            const data = await this.rpcCall('eth_getBalance', [address, 'latest']);
            const balanceWei = parseInt(data.result, 16);
            return balanceWei;
        } catch (error) {
            Logger.warn('Failed to fetch balance:', error);
            return null;
        }
    },

    formatBalancePOL(wei) {
        if (wei === null || wei === undefined) return 'Error';
        const pol = wei / 1e18;
        if (pol === 0) return '0 POL';
        if (pol < 0.0001) return '< 0.0001 POL';
        if (pol < 1) return `${pol.toFixed(4)} POL`;
        if (pol < 100) return `${pol.toFixed(3)} POL`;
        return `${pol.toFixed(2)} POL`;
    }
};
