/**
 * Streamr SDK Bundle Entry Point
 * This file bundles the Streamr SDK and Ethers.js, exposing them globally
 */

// CSP-safe polyfills (must be first!)
import './polyfills.js';

import { StreamrClient, StreamPermission, STREAMR_STORAGE_NODE_GERMANY } from '@streamr/sdk';
import * as ethers from 'ethers';
import QRCode from 'qrcode';

// Expose to window for browser usage
if (typeof window !== 'undefined') {
    window.StreamrClient = StreamrClient;
    window.StreamPermission = StreamPermission;
    window.STREAMR_STORAGE_NODE_GERMANY = STREAMR_STORAGE_NODE_GERMANY;
    window.ethers = ethers;
    window.QRCode = QRCode;
}

export { StreamrClient, StreamPermission, STREAMR_STORAGE_NODE_GERMANY, ethers, QRCode };
