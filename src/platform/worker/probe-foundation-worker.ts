import { createFoundationWorker } from './create-foundation-worker';
import { FOUNDATION_WORKER_READY_MESSAGE } from './foundation-worker-signal';

export const FOUNDATION_WORKER_TIMEOUT_MS = 5_000;
export { FOUNDATION_WORKER_READY_MESSAGE } from './foundation-worker-signal';

type WorkerProbeEventType = 'error' | 'message' | 'messageerror';

export interface WorkerProbeTarget {
  addEventListener(type: WorkerProbeEventType, listener: EventListener): void;
  removeEventListener(type: WorkerProbeEventType, listener: EventListener): void;
  terminate(): void;
}

export interface WorkerProbeOptions {
  readonly createWorker?: () => WorkerProbeTarget;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function createAbortError(): Error {
  const error = new Error('Worker 探针已取消');
  error.name = 'AbortError';
  return error;
}

export function probeFoundationWorker(options: WorkerProbeOptions = {}): Promise<void> {
  const createWorker = options.createWorker ?? createFoundationWorker;
  const timeoutMs = options.timeoutMs ?? FOUNDATION_WORKER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let worker: WorkerProbeTarget | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener('abort', handleAbort);
      worker?.removeEventListener('message', handleMessage);
      worker?.removeEventListener('error', handleError);
      worker?.removeEventListener('messageerror', handleMessageError);
      worker?.terminate();
    };

    const settle = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    function handleAbort() {
      settle(createAbortError());
    }

    function handleMessage(event: Event) {
      if (event instanceof MessageEvent && event.data === FOUNDATION_WORKER_READY_MESSAGE) {
        settle();
      }
    }

    function handleError(event: Event) {
      event.preventDefault();
      settle(new Error('模块 Worker 运行错误'));
    }

    function handleMessageError() {
      settle(new Error('模块 Worker 消息无法反序列化'));
    }

    if (options.signal?.aborted === true) {
      settle(createAbortError());
      return;
    }

    try {
      worker = createWorker();
      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);
      worker.addEventListener('messageerror', handleMessageError);
      options.signal?.addEventListener('abort', handleAbort, { once: true });
      timeoutId = setTimeout(() => {
        settle(new Error(`模块 Worker 在 ${String(timeoutMs)}ms 内未就绪`));
      }, timeoutMs);
    } catch (error) {
      settle(error instanceof Error ? error : new Error('模块 Worker 创建失败'));
    }
  });
}
