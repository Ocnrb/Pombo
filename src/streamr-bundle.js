/**
 * Streamr SDK Bundle Entry Point
 * This file bundles the Streamr SDK and Ethers.js, exposing them globally
 */

// CSP-safe polyfills (must be first!)
import './polyfills.js';

import {
    StreamrClient,
    StreamPermission,
    STREAMR_STORAGE_NODE_ADDRESS,
    EncryptionKey,
    // Message-construction primitives, for publishing under an identity other
    // than the client's own (streamrController.publishAs).
    //
    // client.publish() bakes in two things we need to override: it derives the
    // publisherId from the client identity, and it forces AES whenever the
    // stream is not publicly subscribable. Building the StreamMessage by hand
    // sidesteps both — which is what lets DMs drop the pointless AES layer and
    // lets gated channels publish as their gate contract.
    MessageSigner,
    MessageID,
    MessageRef,
    StreamMessage,
    StreamMessageType,
    EthereumKeyPairIdentity,
    // Re-exported by the SDK from @streamr/trackerless-network
    ContentType,
    EncryptionType,
    SignatureType
} from '@streamr/sdk';
import * as ethers from 'ethers';
import QRCode from 'qrcode';

// Expose to window for browser usage
if (typeof window !== 'undefined') {
    window.StreamrClient = StreamrClient;
    window.StreamPermission = StreamPermission;
    window.STREAMR_STORAGE_NODE_ADDRESS = STREAMR_STORAGE_NODE_ADDRESS;
    window.EncryptionKey = EncryptionKey;
    window.MessageSigner = MessageSigner;
    window.MessageID = MessageID;
    window.MessageRef = MessageRef;
    window.StreamMessage = StreamMessage;
    window.StreamMessageType = StreamMessageType;
    window.EthereumKeyPairIdentity = EthereumKeyPairIdentity;
    window.ContentType = ContentType;
    window.EncryptionType = EncryptionType;
    window.SignatureType = SignatureType;
    window.ethers = ethers;
    window.QRCode = QRCode;
}

export {
    StreamrClient,
    StreamPermission,
    STREAMR_STORAGE_NODE_ADDRESS,
    EncryptionKey,
    MessageSigner,
    MessageID,
    MessageRef,
    StreamMessage,
    StreamMessageType,
    EthereumKeyPairIdentity,
    ContentType,
    EncryptionType,
    SignatureType,
    ethers,
    QRCode
};
