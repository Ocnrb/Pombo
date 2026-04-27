import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';
import { mergePayloadSeries } from '../syncMerge.js';

class SyncWorkerClient {
    constructor() {
        this.worker = null;
        this.pendingTasks = new Map();
        this.taskId = 0;
        this.initialized = false;
        this.initializing = false;
        this.useFallback = false;
    }

    async init() {
        if (this.initialized) return;
        if (this.initializing) {
            await this.waitForInit();
            return;
        }

        this.initializing = true;

        if (typeof Worker === 'undefined') {
            this.useFallback = true;
            this.initialized = true;
            this.initializing = false;
            return;
        }

        try {
            const worker = new Worker('/js/sync.worker.bundle.js');
            worker.onmessage = (event) => this.handleMessage(event.data);
            worker.onerror = (error) => this.handleError(error);

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    worker.removeEventListener('message', handleReady);
                    worker.removeEventListener('error', handleReadyError);
                    reject(new Error('Sync worker initialization timeout'));
                }, 2000);

                const handleReady = (event) => {
                    if (event.data?.type !== 'READY') return;
                    clearTimeout(timeout);
                    worker.removeEventListener('message', handleReady);
                    worker.removeEventListener('error', handleReadyError);
                    resolve();
                };

                const handleReadyError = (event) => {
                    clearTimeout(timeout);
                    worker.removeEventListener('message', handleReady);
                    worker.removeEventListener('error', handleReadyError);
                    reject(event.error || new Error('Sync worker failed to initialize'));
                };

                worker.addEventListener('message', handleReady);
                worker.addEventListener('error', handleReadyError);
            });

            this.worker = worker;
            this.initialized = true;
            this.initializing = false;
            Logger.info('Sync worker initialized');
        } catch (error) {
            Logger.warn('Sync worker unavailable, falling back to main thread:', error.message);
            this.useFallback = true;
            this.initialized = true;
            this.initializing = false;
            this.worker?.terminate();
            this.worker = null;
        }
    }

    waitForInit() {
        return new Promise((resolve) => {
            const check = () => {
                if (this.initialized) {
                    resolve();
                } else {
                    setTimeout(check, 10);
                }
            };
            check();
        });
    }

    async mergePayloads(baseState, payloads, maxSentMessages = CONFIG.dm.maxSentMessages) {
        if (!this.initialized) {
            await this.init();
        }

        if (this.useFallback || !this.worker) {
            return mergePayloadSeries(baseState, payloads, maxSentMessages);
        }

        return this.execute('MERGE_SYNC_PAYLOADS', {
            baseState,
            payloads,
            maxSentMessages
        });
    }

    execute(type, payload) {
        return new Promise((resolve, reject) => {
            if (!this.worker) {
                reject(new Error('Sync worker is not available'));
                return;
            }

            const id = ++this.taskId;
            this.pendingTasks.set(id, { resolve, reject, type });
            this.worker.postMessage({ id, type, payload });
        });
    }

    handleMessage(data) {
        if (data?.type === 'READY') return;

        const { id, success, result, error } = data;
        const task = this.pendingTasks.get(id);
        if (!task) return;

        this.pendingTasks.delete(id);

        if (success) {
            task.resolve(result);
        } else {
            task.reject(new Error(error));
        }
    }

    handleError(error) {
        Logger.error('Sync worker error:', error);

        for (const [, task] of this.pendingTasks) {
            task.reject(new Error('Sync worker execution failed'));
        }
        this.pendingTasks.clear();

        this.worker?.terminate();
        this.worker = null;
        this.useFallback = true;
        this.initialized = true;
        this.initializing = false;
    }
}

export const syncWorkerClient = new SyncWorkerClient();
export default syncWorkerClient;