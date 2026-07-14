import { parseMainToWorkerMessage, parseWorkerToMainMessage } from '../protocol/parse-message';
import type { BodyState, MainToWorkerMessage, WorkerToMainMessage } from '../protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../protocol/schemas';
import { SessionSequenceGate } from '../protocol/session-sequence-gate';
import { createPhysicsWorker } from './create-physics-worker';

export const PHYSICS_WORKER_OPERATION_TIMEOUT_MS = 15_000;

type WorkerControllerEventType = 'error' | 'message' | 'messageerror';
type WorkerResponseOfType<Type extends WorkerToMainMessage['type']> = Extract<
  WorkerToMainMessage,
  { type: Type }
>;

export interface PhysicsWorkerTarget {
  addEventListener(type: WorkerControllerEventType, listener: EventListener): void;
  postMessage(message: MainToWorkerMessage): void;
  removeEventListener(type: WorkerControllerEventType, listener: EventListener): void;
  terminate(): void;
}

interface PendingResponse {
  readonly accept: (message: WorkerToMainMessage) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (message: WorkerToMainMessage) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

export interface PhysicsWorkerControllerOptions {
  readonly createWorker?: () => PhysicsWorkerTarget;
  readonly operationTimeoutMs?: number;
  readonly sessionId?: string;
}

function createSessionId(): string {
  return globalThis.crypto.randomUUID();
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export class PhysicsWorkerController {
  readonly #fatalListeners = new Set<(error: Error) => void>();
  readonly #inboundGate: SessionSequenceGate;
  readonly #listeners = new Set<(message: WorkerToMainMessage) => void>();
  readonly #operationTimeoutMs: number;
  readonly #pendingResponses = new Set<PendingResponse>();
  readonly #sessionId: string;
  readonly #worker: PhysicsWorkerTarget;
  #closed = false;
  #initialized = false;
  #nextCommandSequence = 0;
  #simulationTimeSeconds = 0;

  constructor(options: PhysicsWorkerControllerOptions = {}) {
    this.#sessionId = options.sessionId ?? createSessionId();
    this.#inboundGate = new SessionSequenceGate(this.#sessionId);
    this.#operationTimeoutMs = options.operationTimeoutMs ?? PHYSICS_WORKER_OPERATION_TIMEOUT_MS;
    this.#worker = (options.createWorker ?? createPhysicsWorker)();
    this.#worker.addEventListener('message', this.#handleMessage);
    this.#worker.addEventListener('error', this.#handleError);
    this.#worker.addEventListener('messageerror', this.#handleMessageError);
  }

  get simulationTimeSeconds(): number {
    return this.#simulationTimeSeconds;
  }

  initialize(bodies: readonly BodyState[]): Promise<void> {
    if (this.#initialized || this.#nextCommandSequence !== 0) {
      return Promise.reject(new Error('PhysicsWorkerController 已经初始化'));
    }
    return this.#request('ready', () => {
      this.#postCommand({ type: 'initialize', bodies: [...bodies] });
    }).then(() => {
      this.#initialized = true;
    });
  }

  start(): Promise<void> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    return this.#request(
      'status',
      () => {
        this.#postCommand({ type: 'start' });
      },
      (message) => message.runState === 'running',
    ).then(() => undefined);
  }

  pause(): Promise<void> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    return this.#request(
      'status',
      () => {
        this.#postCommand({ type: 'pause' });
      },
      (message) => message.runState === 'paused',
    ).then(() => undefined);
  }

  step(stepSeconds: number): Promise<WorkerResponseOfType<'state'>> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    const expectedTimeSeconds = this.#simulationTimeSeconds + stepSeconds;
    return this.#request(
      'state',
      () => {
        this.#postCommand({ type: 'step', stepSeconds });
      },
      (message) => message.simulationTimeSeconds >= expectedTimeSeconds,
    );
  }

  setTimeScale(timeScale: number): Promise<void> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    return this.#request(
      'status',
      () => {
        this.#postCommand({ type: 'setTimeScale', timeScale });
      },
      (message) => message.timeScale === timeScale,
    ).then(() => undefined);
  }

  dispose(): Promise<void> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    return this.#request('disposed', () => {
      this.#postCommand({ type: 'dispose' });
    }).then(() => {
      this.close();
    });
  }

  subscribe(listener: (message: WorkerToMainMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribeFatal(listener: (error: Error) => void): () => void {
    this.#fatalListeners.add(listener);
    return () => {
      this.#fatalListeners.delete(listener);
    };
  }

  close(reason = new Error('Physics Worker controller 已关闭')): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#worker.removeEventListener('message', this.#handleMessage);
    this.#worker.removeEventListener('error', this.#handleError);
    this.#worker.removeEventListener('messageerror', this.#handleMessageError);
    this.#worker.terminate();
    this.#rejectPending(reason);
    this.#listeners.clear();
    this.#fatalListeners.clear();
  }

  #request<Type extends WorkerToMainMessage['type']>(
    type: Type,
    send: () => void,
    matches: (message: WorkerResponseOfType<Type>) => boolean = () => true,
  ): Promise<WorkerResponseOfType<Type>> {
    if (this.#closed) {
      return Promise.reject(new Error('Physics Worker controller 已关闭'));
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const error = new Error(
          `Physics Worker 在 ${String(this.#operationTimeoutMs)}ms 内未返回 ${type}`,
        );
        this.#fatal(error);
      }, this.#operationTimeoutMs);
      const pending: PendingResponse = {
        accept: (message) =>
          message.type === type && matches(message as WorkerResponseOfType<Type>),
        reject,
        resolve: (message) => {
          resolve(message as WorkerResponseOfType<Type>);
        },
        timeoutId,
      };
      this.#pendingResponses.add(pending);
      try {
        send();
      } catch (error) {
        this.#pendingResponses.delete(pending);
        clearTimeout(timeoutId);
        reject(toError(error, 'Physics Worker 命令发送失败'));
      }
    });
  }

  #postCommand(
    payload:
      | { readonly bodies: BodyState[]; readonly type: 'initialize' }
      | { readonly type: 'start' | 'pause' | 'dispose' }
      | { readonly stepSeconds: number; readonly type: 'step' }
      | { readonly timeScale: number; readonly type: 'setTimeScale' },
  ): void {
    const message = parseMainToWorkerMessage({
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      sequence: this.#nextCommandSequence,
      simulationTimeSeconds: this.#simulationTimeSeconds,
      ...payload,
    });
    this.#nextCommandSequence += 1;
    this.#worker.postMessage(message);
  }

  #initializationError(): Error | undefined {
    return this.#initialized ? undefined : new Error('PhysicsWorkerController 尚未初始化');
  }

  readonly #handleMessage: EventListener = (event) => {
    try {
      if (!(event instanceof MessageEvent)) {
        throw new Error('Physics Worker 返回了未知事件');
      }
      const message = parseWorkerToMainMessage(event.data);
      const decision = this.#inboundGate.accept(message);
      if (!decision.accepted) {
        throw new Error(
          decision.reason === 'sessionMismatch'
            ? 'Physics Worker 返回了错误会话的消息'
            : 'Physics Worker 返回了重复或倒退的消息序号',
        );
      }
      this.#simulationTimeSeconds = message.simulationTimeSeconds;
      this.#listeners.forEach((listener) => {
        listener(message);
      });
      if (message.type === 'error') {
        const error = new Error(`${message.code}: ${message.message}`);
        if (message.recoverable) {
          this.#rejectPending(error);
        } else {
          this.#fatal(error);
        }
        return;
      }
      const pending = [...this.#pendingResponses].find((candidate) => candidate.accept(message));
      if (pending !== undefined) {
        this.#pendingResponses.delete(pending);
        clearTimeout(pending.timeoutId);
        pending.resolve(message);
      }
    } catch (error) {
      this.#fatal(toError(error, 'Physics Worker 响应处理失败'));
    }
  };

  readonly #handleError: EventListener = (event) => {
    event.preventDefault();
    this.#fatal(new Error('Physics Worker 运行错误'));
  };

  readonly #handleMessageError: EventListener = () => {
    this.#fatal(new Error('Physics Worker 消息无法反序列化'));
  };

  #fatal(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#fatalListeners.forEach((listener) => {
      try {
        listener(error);
      } catch {
        // A subscriber failure must not interrupt fatal controller cleanup.
      }
    });
    this.close(error);
  }

  #rejectPending(error: Error): void {
    this.#pendingResponses.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    });
    this.#pendingResponses.clear();
  }
}
