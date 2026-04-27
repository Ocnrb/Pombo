import { mergePayloadSeries } from '../syncMerge.js';

self.onmessage = async (event) => {
    const { id, type, payload } = event.data;

    try {
        let result;

        switch (type) {
            case 'MERGE_SYNC_PAYLOADS':
                result = mergePayloadSeries(
                    payload.baseState,
                    payload.payloads,
                    payload.maxSentMessages
                );
                break;

            case 'PING':
                result = 'PONG';
                break;

            default:
                throw new Error(`Unknown sync worker task: ${type}`);
        }

        self.postMessage({ id, success: true, result });
    } catch (error) {
        self.postMessage({ id, success: false, error: error.message });
    }
};

self.postMessage({ type: 'READY' });