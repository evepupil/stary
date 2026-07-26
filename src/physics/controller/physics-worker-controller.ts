import {
  advanceCollisionLedgerSummary,
  collisionLedgerSummariesEqual,
  createEmptyCollisionLedgerSummary,
  type CollisionLedgerSummaryLike,
} from '../protocol/collision-ledger-summary';
import { parseMainToWorkerMessage, parseWorkerToMainMessage } from '../protocol/parse-message';
import type {
  BodyState,
  MainToWorkerMessage,
  PhysicsAdvanceResult,
  PhysicsState,
  WorkerToMainMessage,
} from '../protocol/schemas';
import {
  bodyRevisionSchema,
  bodyStatesSchema,
  PHYSICS_PROTOCOL_VERSION,
  physicsStateSchema,
  simulationTimeSecondsSchema,
} from '../protocol/schemas';
import { SessionSequenceGate } from '../protocol/session-sequence-gate';
import { createPhysicsWorker } from './create-physics-worker';

export const PHYSICS_WORKER_OPERATION_TIMEOUT_MS = 15_000;

type WorkerControllerEventType = 'error' | 'message' | 'messageerror';
type WorkerResponseOfType<Type extends WorkerToMainMessage['type']> = Extract<
  WorkerToMainMessage,
  { type: Type }
>;
type WorkerResponseOfTypes<Types extends WorkerToMainMessage['type']> = Extract<
  WorkerToMainMessage,
  { type: Types }
>;
type WorkerErrorMessage = Extract<WorkerToMainMessage, { type: 'error' }>;

export class PhysicsWorkerCommandError extends Error {
  readonly code: WorkerErrorMessage['code'];

  constructor(message: WorkerErrorMessage) {
    super(`${message.code}: ${message.message}`);
    this.name = 'PhysicsWorkerCommandError';
    this.code = message.code;
  }
}

export interface PhysicsWorkerTarget {
  addEventListener(type: WorkerControllerEventType, listener: EventListener): void;
  postMessage(message: MainToWorkerMessage): void;
  removeEventListener(type: WorkerControllerEventType, listener: EventListener): void;
  terminate(): void;
}

interface PendingResponse {
  readonly accept: (message: WorkerToMainMessage) => boolean;
  readonly expectedDescription: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (message: WorkerToMainMessage) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

type ControllerCommandPayload =
  | { readonly bodies: BodyState[]; readonly type: 'initialize' }
  | { readonly type: 'start' | 'pause' | 'dispose' }
  | { readonly stepSeconds: number; readonly type: 'step' }
  | { readonly timeScale: number; readonly type: 'setTimeScale' }
  | {
      readonly bodies: BodyState[];
      readonly expectedBodyRevision: number;
      readonly expectedSimulationTimeSeconds: number;
      readonly type: 'replaceBodies';
    }
  | {
      readonly expectedBodyRevision: number;
      readonly expectedSimulationTimeSeconds: number;
      readonly snapshotSimulationTimeSeconds: number;
      readonly state: PhysicsState;
      readonly type: 'restoreSnapshot';
    };

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

function haveSameBodyIds(bodies: readonly BodyState[], expectedIds: ReadonlySet<string>): boolean {
  return bodies.length === expectedIds.size && bodies.every((body) => expectedIds.has(body.id));
}

export class PhysicsWorkerController {
  readonly #fatalListeners = new Set<(error: Error) => void>();
  readonly #inboundGate: SessionSequenceGate;
  readonly #listeners = new Set<(message: WorkerToMainMessage) => void>();
  readonly #operationTimeoutMs: number;
  readonly #pendingResponses = new Map<number, PendingResponse>();
  readonly #sessionId: string;
  readonly #worker: PhysicsWorkerTarget;
  #closed = false;
  #bodyReplacementQueue: Promise<void> = Promise.resolve();
  #bodyIds = new Set<string>();
  #bodyRevision = 0;
  #collisionBatchSequence = 0;
  #collisionLedgerSummary: CollisionLedgerSummaryLike = createEmptyCollisionLedgerSummary();
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

  get bodyRevision(): number {
    return this.#bodyRevision;
  }

  initialize(bodies: readonly BodyState[]): Promise<void> {
    if (this.#initialized || this.#nextCommandSequence !== 0) {
      return Promise.reject(new Error('PhysicsWorkerController 已经初始化'));
    }
    let submittedBodies: BodyState[];
    try {
      submittedBodies = bodyStatesSchema.parse(bodies);
    } catch (error) {
      return Promise.reject(toError(error, '初始天体状态无效'));
    }
    return this.#request(['ready'], { type: 'initialize', bodies: submittedBodies }).then(() => {
      this.#bodyIds = new Set(submittedBodies.map((body) => body.id));
      this.#initialized = true;
    });
  }

  start(): Promise<void> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    return this.#request(
      ['status'],
      { type: 'start' },
      (message) => message.runState === 'running',
    ).then(() => undefined);
  }

  pause(): Promise<void> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    return this.#request(
      ['status'],
      { type: 'pause' },
      (message) => message.runState === 'paused',
    ).then(() => undefined);
  }

  step(stepSeconds: number): Promise<PhysicsAdvanceResult> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    const expectedTimeSeconds = this.#simulationTimeSeconds + stepSeconds;
    return this.#request(
      ['state', 'collisionBatchResolved'],
      { type: 'step', stepSeconds },
      (message) => message.requestedTargetSimulationTimeSeconds === expectedTimeSeconds,
    );
  }

  setTimeScale(timeScale: number): Promise<void> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    return this.#request(
      ['status'],
      { type: 'setTimeScale', timeScale },
      (message) => message.timeScale === timeScale,
    ).then(() => undefined);
  }

  replaceBodies(
    bodies: readonly BodyState[],
    expectedBodyRevision: number,
    expectedSimulationTimeSeconds: number,
  ): Promise<WorkerResponseOfType<'bodiesReplaced'>> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    let submittedBodies: BodyState[];
    let submittedBodyRevision: number;
    let submittedSimulationTimeSeconds: number;
    try {
      submittedBodies = bodyStatesSchema.parse(bodies);
      submittedBodyRevision = bodyRevisionSchema.parse(expectedBodyRevision);
      submittedSimulationTimeSeconds = simulationTimeSecondsSchema.parse(
        expectedSimulationTimeSeconds,
      );
    } catch (error) {
      return Promise.reject(toError(error, '天体替换请求无效'));
    }

    const operation = this.#bodyReplacementQueue.then(async () => {
      await this.pause();
      const submittedIds = new Set(submittedBodies.map((body) => body.id));
      return this.#request(
        ['bodiesReplaced'],
        {
          type: 'replaceBodies',
          expectedBodyRevision: submittedBodyRevision,
          expectedSimulationTimeSeconds: submittedSimulationTimeSeconds,
          bodies: submittedBodies,
        },
        (message) =>
          message.bodyRevision === submittedBodyRevision + 1 &&
          haveSameBodyIds(message.state.majorBodies, submittedIds),
      );
    });
    this.#bodyReplacementQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  restoreSnapshot(
    state: PhysicsState,
    snapshotSimulationTimeSeconds: number,
    expectedBodyRevision: number,
    expectedSimulationTimeSeconds: number,
  ): Promise<WorkerResponseOfType<'snapshotRestored'>> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    let submittedState: PhysicsState;
    let submittedSnapshotTimeSeconds: number;
    let submittedBodyRevision: number;
    let submittedSimulationTimeSeconds: number;
    try {
      submittedState = physicsStateSchema.parse(state);
      submittedSnapshotTimeSeconds = simulationTimeSecondsSchema.parse(
        snapshotSimulationTimeSeconds,
      );
      submittedBodyRevision = bodyRevisionSchema.parse(expectedBodyRevision);
      submittedSimulationTimeSeconds = simulationTimeSecondsSchema.parse(
        expectedSimulationTimeSeconds,
      );
    } catch (error) {
      return Promise.reject(toError(error, '快照恢复请求无效'));
    }

    const operation = this.#bodyReplacementQueue.then(async () => {
      await this.pause();
      const submittedIds = new Set(submittedState.majorBodies.map((body) => body.id));
      return this.#request(
        ['snapshotRestored'],
        {
          type: 'restoreSnapshot',
          expectedBodyRevision: submittedBodyRevision,
          expectedSimulationTimeSeconds: submittedSimulationTimeSeconds,
          snapshotSimulationTimeSeconds: submittedSnapshotTimeSeconds,
          state: submittedState,
        },
        (message) =>
          message.bodyRevision === submittedBodyRevision + 1 &&
          message.simulationTimeSeconds === submittedSnapshotTimeSeconds &&
          haveSameBodyIds(message.state.majorBodies, submittedIds),
      );
    });
    this.#bodyReplacementQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  dispose(): Promise<void> {
    const initializationError = this.#initializationError();
    if (initializationError !== undefined) {
      return Promise.reject(initializationError);
    }
    return this.#request(['disposed'], { type: 'dispose' }).then(() => {
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

  #request<Types extends WorkerToMainMessage['type']>(
    types: readonly Types[],
    payload: ControllerCommandPayload,
    matches: (message: WorkerResponseOfTypes<Types>) => boolean = () => true,
  ): Promise<WorkerResponseOfTypes<Types>> {
    if (this.#closed) {
      return Promise.reject(new Error('Physics Worker controller 已关闭'));
    }

    let command: MainToWorkerMessage;
    try {
      command = this.#createCommand(payload);
    } catch (error) {
      return Promise.reject(toError(error, 'Physics Worker 命令无效'));
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const error = new Error(
          `Physics Worker 在 ${String(this.#operationTimeoutMs)}ms 内未返回 ${types.join(' | ')}`,
        );
        this.#fatal(error);
      }, this.#operationTimeoutMs);
      const pending: PendingResponse = {
        accept: (message) =>
          types.includes(message.type as Types) && matches(message as WorkerResponseOfTypes<Types>),
        expectedDescription: types.join(' | '),
        reject,
        resolve: (message) => {
          resolve(message as WorkerResponseOfTypes<Types>);
        },
        timeoutId,
      };
      this.#pendingResponses.set(command.sequence, pending);
      try {
        this.#worker.postMessage(command);
      } catch (error) {
        this.#pendingResponses.delete(command.sequence);
        clearTimeout(timeoutId);
        reject(toError(error, 'Physics Worker 命令发送失败'));
      }
    });
  }

  #createCommand(payload: ControllerCommandPayload): MainToWorkerMessage {
    const message = parseMainToWorkerMessage({
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      sequence: this.#nextCommandSequence,
      simulationTimeSeconds: this.#simulationTimeSeconds,
      ...payload,
    });
    this.#nextCommandSequence += 1;
    return message;
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
      const correlatedPending =
        message.replyToSequence === null
          ? undefined
          : this.#pendingResponses.get(message.replyToSequence);
      if (message.replyToSequence !== null && correlatedPending === undefined) {
        throw new Error('Physics Worker 响应指向未知请求');
      }
      if (
        message.type !== 'error' &&
        correlatedPending !== undefined &&
        !correlatedPending.accept(message)
      ) {
        throw new Error(
          `Physics Worker 请求 ${String(message.replyToSequence)} 的响应与预期 ${correlatedPending.expectedDescription} 不一致`,
        );
      }
      this.#simulationTimeSeconds = message.simulationTimeSeconds;
      if (message.type === 'state' && message.bodyRevision !== this.#bodyRevision) {
        throw new Error('Physics Worker state 的天体修订号与当前状态不一致');
      }
      if (message.type === 'state' && !haveSameBodyIds(message.state.majorBodies, this.#bodyIds)) {
        throw new Error('Physics Worker state 的天体集合与当前修订不一致');
      }
      if (
        (message.type === 'state' || message.type === 'bodiesReplaced') &&
        !collisionLedgerSummariesEqual(
          message.state.cumulativeCollisionLedger,
          this.#collisionLedgerSummary,
        )
      ) {
        throw new Error('Physics Worker state 的累计碰撞摘要与当前状态不一致');
      }
      if (message.type === 'bodiesReplaced') {
        if (message.bodyRevision !== this.#bodyRevision + 1) {
          throw new Error('Physics Worker 原子替换没有连续递增天体修订号');
        }
        this.#bodyRevision = message.bodyRevision;
        this.#bodyIds = new Set(message.state.majorBodies.map((body) => body.id));
      } else if (message.type === 'snapshotRestored') {
        if (message.bodyRevision !== this.#bodyRevision + 1) {
          throw new Error('Physics Worker 快照恢复没有连续递增天体修订号');
        }
        this.#bodyRevision = message.bodyRevision;
        this.#bodyIds = new Set(message.state.majorBodies.map((body) => body.id));
        this.#collisionLedgerSummary = message.state.cumulativeCollisionLedger;
      } else if (message.type === 'collisionBatchResolved') {
        if (
          message.bodyRevisionBefore !== this.#bodyRevision ||
          message.bodyRevisionAfter !== this.#bodyRevision + 1
        ) {
          throw new Error('Physics Worker 碰撞批次的天体修订号与当前状态不连续');
        }
        if (message.collisionBatchSequence !== this.#collisionBatchSequence + 1) {
          throw new Error('Physics Worker 碰撞批次序号必须连续递增');
        }
        const participantIds = message.events.flatMap((collisionEvent) => [
          ...collisionEvent.participantBodyIds,
        ]);
        if (participantIds.some((bodyId) => !this.#bodyIds.has(bodyId))) {
          throw new Error('Physics Worker 碰撞批次引用了当前修订中不存在的参与体');
        }
        const participantIdSet = new Set(participantIds);
        const nextMajorBodyIds = new Set(message.state.majorBodies.map((body) => body.id));
        if (
          [...this.#bodyIds].some(
            (bodyId) => !participantIdSet.has(bodyId) && !nextMajorBodyIds.has(bodyId),
          )
        ) {
          throw new Error('Physics Worker 碰撞批次丢失了未参与碰撞的主要天体');
        }
        for (const collisionEvent of message.events) {
          const eventParticipantIds = new Set(collisionEvent.participantBodyIds);
          const resultIds = [
            ...collisionEvent.majorRemnantIds,
            ...collisionEvent.tracerIds,
            ...collisionEvent.dustCohortIds,
          ];
          if (
            resultIds.some(
              (resultId) => this.#bodyIds.has(resultId) && !eventParticipantIds.has(resultId),
            )
          ) {
            throw new Error('Physics Worker 碰撞结果复用了未参与天体的 id');
          }
        }
        const nextCollisionLedgerSummary = advanceCollisionLedgerSummary(
          this.#collisionLedgerSummary,
          message.ledgerDelta,
        );
        if (
          !collisionLedgerSummariesEqual(
            message.state.cumulativeCollisionLedger,
            nextCollisionLedgerSummary,
          )
        ) {
          throw new Error('Physics Worker 碰撞批次没有正确累计事件数与耗散量');
        }
        this.#bodyRevision = message.bodyRevisionAfter;
        this.#collisionBatchSequence = message.collisionBatchSequence;
        this.#collisionLedgerSummary = nextCollisionLedgerSummary;
        this.#bodyIds = new Set(message.state.majorBodies.map((body) => body.id));
      }
      this.#listeners.forEach((listener) => {
        listener(message);
      });
      if (message.type === 'error') {
        const error = new PhysicsWorkerCommandError(message);
        if (message.recoverable) {
          if (message.replyToSequence === null) {
            return;
          }
          if (correlatedPending === undefined) {
            throw new Error('Physics Worker 可恢复错误缺少待决请求');
          }
          this.#pendingResponses.delete(message.replyToSequence);
          clearTimeout(correlatedPending.timeoutId);
          correlatedPending.reject(error);
        } else {
          this.#fatal(error);
        }
        return;
      }
      if (message.replyToSequence === null) {
        return;
      }
      if (correlatedPending === undefined) {
        throw new Error('Physics Worker 成功响应缺少待决请求');
      }
      this.#pendingResponses.delete(message.replyToSequence);
      clearTimeout(correlatedPending.timeoutId);
      correlatedPending.resolve(message);
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
