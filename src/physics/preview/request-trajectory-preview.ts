import {
  trajectoryPreviewRequestSchema,
  trajectoryPreviewResponseSchema,
  type TrajectoryPreviewRequest,
  type TrajectoryPreviewResult,
} from './schemas';
import { validateTrajectoryPreviewResultForRequest } from './validate-trajectory-preview-result';

type OrbitPreviewWorkerEventType = 'error' | 'message' | 'messageerror';

export interface OrbitPreviewWorkerTarget {
  addEventListener(type: OrbitPreviewWorkerEventType, listener: EventListener): void;
  postMessage(message: TrajectoryPreviewRequest): void;
  removeEventListener(type: OrbitPreviewWorkerEventType, listener: EventListener): void;
  terminate(): void;
}

export interface RequestTrajectoryPreviewOptions {
  readonly signal?: AbortSignal;
  readonly createWorker?: () => OrbitPreviewWorkerTarget;
}

export function requestTrajectoryPreview(
  input: TrajectoryPreviewRequest,
  options: RequestTrajectoryPreviewOptions = {},
): Promise<TrajectoryPreviewResult> {
  const request = trajectoryPreviewRequestSchema.parse(input);
  if (options.signal?.aborted === true) {
    return Promise.reject(createAbortError());
  }

  let worker: OrbitPreviewWorkerTarget;
  try {
    worker = (options.createWorker ?? createOrbitPreviewWorker)();
  } catch (error) {
    return Promise.reject(toError(error, '轨道预览 Worker 创建失败'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      worker.removeEventListener('messageerror', handleMessageError);
      options.signal?.removeEventListener('abort', handleAbort);
      worker.terminate();
    };
    const settle = (operation: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      operation();
    };
    const handleMessage: EventListener = (event) => {
      if (!(event instanceof MessageEvent)) {
        settle(() => {
          reject(new Error('轨道预览 Worker 返回了未知事件'));
        });
        return;
      }
      try {
        const response = trajectoryPreviewResponseSchema.parse(event.data);
        if (
          response.requestId !== null &&
          (response.requestId !== request.requestId ||
            response.draftRevision !== request.draftRevision)
        ) {
          throw new Error('轨道预览 Worker 返回了错误请求的结果');
        }
        if (response.type === 'trajectoryPreviewError') {
          settle(() => {
            reject(new Error(`${response.code}: ${response.message}`));
          });
          return;
        }
        const result = validateTrajectoryPreviewResultForRequest(response, request);
        settle(() => {
          resolve(result);
        });
      } catch (error) {
        settle(() => {
          reject(toError(error, '轨道预览响应处理失败'));
        });
      }
    };
    const handleError: EventListener = (event) => {
      event.preventDefault();
      settle(() => {
        reject(new Error('轨道预览 Worker 运行错误'));
      });
    };
    const handleMessageError: EventListener = () => {
      settle(() => {
        reject(new Error('轨道预览 Worker 消息无法反序列化'));
      });
    };
    const handleAbort = () => {
      settle(() => {
        reject(createAbortError());
      });
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.addEventListener('messageerror', handleMessageError);
    options.signal?.addEventListener('abort', handleAbort, { once: true });

    try {
      worker.postMessage(request);
    } catch (error) {
      settle(() => {
        reject(toError(error, '轨道预览请求发送失败'));
      });
    }
  });
}

function createOrbitPreviewWorker(): Worker {
  return new Worker(new URL('../../workers/orbit-preview.worker.ts', import.meta.url), {
    name: 'stary-orbit-preview',
    type: 'module',
  });
}

function createAbortError(): Error {
  const error = new Error('轨道预览已取消');
  error.name = 'AbortError';
  return error;
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
