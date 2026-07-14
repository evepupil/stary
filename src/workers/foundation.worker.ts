import { FOUNDATION_WORKER_READY_MESSAGE } from '../platform/worker/foundation-worker-signal';

self.postMessage(FOUNDATION_WORKER_READY_MESSAGE);

export {};
