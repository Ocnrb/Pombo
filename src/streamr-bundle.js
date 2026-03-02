/**
 * Streamr SDK Bundle Entry Point
 * This file bundles the Streamr SDK and Ethers.js, exposing them globally
 */

// CSP-safe polyfills (must be first!)
import './polyfills.js';

import { StreamrClient, StreamPermission, STREAMR_STORAGE_NODE_ADDRESS } from '@streamr/sdk';
import * as ethers from 'ethers';
import QRCode from 'qrcode';

// Expose to window for browser usage
if (typeof window !== 'undefined') {
    window.StreamrClient = StreamrClient;
    window.StreamPermission = StreamPermission;
    window.STREAMR_STORAGE_NODE_ADDRESS = STREAMR_STORAGE_NODE_ADDRESS;
    window.ethers = ethers;
    window.QRCode = QRCode;
}

export { StreamrClient, StreamPermission, STREAMR_STORAGE_NODE_ADDRESS, ethers, QRCode };
