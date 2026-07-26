import { ZodError } from 'zod';

import {
  loadCollisionKernelWasm,
  type CollisionKernelWasm,
} from '../collisions/collision-kernel-wasm';
import { parseMainToWorkerMessage, parseWorkerToMainMessage } from '../protocol/parse-message';
import { createPhysicsStateFromSnapshot } from '../protocol/physics-state';
import type {
  BodyState,
  MainToWorkerMessage,
  PhysicsState,
  WorkerToMainMessage,
} from '../protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../protocol/schemas';
import { SessionSequenceGate } from '../protocol/session-sequence-gate';
import {
  browserPhysicsScheduler,
  MAX_SIMULATION_ADVANCE_PER_SLICE_SECONDS,
  SIMULATION_SECONDS_PER_REAL_SECOND_AT_1X,
  type PhysicsScheduler,
  type ScheduledPhysicsTask,
} from './physics-scheduler';
import type { CreatePhysicsSimulation, PhysicsSimulation } from './physics-simulation';
import { CollisionTransactionError, resolveCollisionTransaction } from './collision-transaction';
import { advancePhysicsStateToSnapshot, replacePhysicsStateAssets } from './passive-assets';

type RuntimeRunState = 'initialized' | 'paused' | 'running';
type WorkerErrorCode = Extract<WorkerToMainMessage, { type: 'error' }>['code'];
type RuntimeResponsePayload<Message extends WorkerToMainMessage = WorkerToMainMessage> =
  Message extends WorkerToMainMessage
    ? Omit<Message, 'version' | 'sessionId' | 'sequence' | 'simulationTimeSeconds'>
    : never;

export interface PhysicsWorkerRuntimeOptions {
  readonly collisionKernelWasmUrl?: string;
  readonly closeWorker?: () => void;
  readonly createSimulation: CreatePhysicsSimulation;
  readonly loadCollisionKernel?: (url: string | null) => Promise<CollisionKernelWasm>;
  readonly postMessage: (message: WorkerToMainMessage) => void;
  readonly scheduler?: PhysicsScheduler;
}

function describeProtocolError(error: unknown): string {
  if (error instanceof ZodError) {
    return '命令未通过物理协议校验';
  }
  return error instanceof Error ? error.message : '未知物理运行时错误';
}

function boundedErrorMessage(message: string): string {
  return message.slice(0, 1_024) || '未知物理运行时错误';
}

function isContactSetOverflow(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    (error as Error & { readonly status?: unknown }).status === -7
  );
}

function assertRestoredSnapshotMatches(
  snapshotBodies: readonly BodyState[],
  state: PhysicsState,
): void {
  if (snapshotBodies.length !== state.majorBodies.length) {
    throw new Error('候选物理模拟的天体数量与快照不一致');
  }
  for (const [index, expected] of state.majorBodies.entries()) {
    const actual = snapshotBodies[index];
    if (actual === undefined) {
      throw new Error(`候选物理模拟缺少快照天体 ${expected.id}`);
    }
    const matches =
      actual.id === expected.id &&
      actual.massKg === expected.massKg &&
      actual.radiusMeters === expected.radiusMeters &&
      actual.positionMeters.x === expected.positionMeters.x &&
      actual.positionMeters.y === expected.positionMeters.y &&
      actual.positionMeters.z === expected.positionMeters.z &&
      actual.velocityMetersPerSecond.x === expected.velocityMetersPerSecond.x &&
      actual.velocityMetersPerSecond.y === expected.velocityMetersPerSecond.y &&
      actual.velocityMetersPerSecond.z === expected.velocityMetersPerSecond.z;
    if (!matches) {
      throw new Error(`候选物理模拟的天体 ${expected.id} 首帧与快照不一致`);
    }
  }
}

export class PhysicsWorkerRuntime {
  public readonly collisionKernelWasmUrl: string | null;
  readonly #closeWorker: () => void;
  readonly #createSimulation: CreatePhysicsSimulation;
  readonly #postMessage: (message: WorkerToMainMessage) => void;
  readonly #scheduler: PhysicsScheduler;
  readonly #loadCollisionKernel: (() => Promise<CollisionKernelWasm>) | undefined;
  #activeRequestSequence: number | null = null;
  #commandGate: SessionSequenceGate | undefined;
  #bodyRevision = 0;
  #collisionBatchSequence = 0;
  #collisionKernel: CollisionKernelWasm | undefined;
  #disposed = false;
  #lastRealTimeMilliseconds: number | undefined;
  #nextResponseSequence = 0;
  #operationQueue: Promise<void> = Promise.resolve();
  #physicsState: PhysicsState | undefined;
  #runState: RuntimeRunState | undefined;
  #scheduledTask: ScheduledPhysicsTask | undefined;
  #sessionId: string | undefined;
  #simulation: PhysicsSimulation | undefined;
  #timeScale = 1;

  constructor(options: PhysicsWorkerRuntimeOptions) {
    this.collisionKernelWasmUrl = options.collisionKernelWasmUrl ?? null;
    this.#closeWorker = options.closeWorker ?? (() => undefined);
    this.#createSimulation = options.createSimulation;
    this.#postMessage = options.postMessage;
    this.#scheduler = options.scheduler ?? browserPhysicsScheduler;
    const providedCollisionLoader = options.loadCollisionKernel;
    const collisionKernelWasmUrl = this.collisionKernelWasmUrl;
    if (providedCollisionLoader !== undefined) {
      this.#loadCollisionKernel = () => providedCollisionLoader(collisionKernelWasmUrl);
    } else if (collisionKernelWasmUrl !== null) {
      this.#loadCollisionKernel = () => loadCollisionKernelWasm({ url: collisionKernelWasmUrl });
    } else {
      this.#loadCollisionKernel = undefined;
    }
  }

  receive(input: unknown): Promise<void> {
    const operation = this.#operationQueue.then(() => this.#processInput(input));
    this.#operationQueue = operation.catch(() => undefined);
    return operation;
  }

  reportMessageError(): Promise<void> {
    const operation = this.#operationQueue.then(() => {
      this.#failSafely('invalidCommand', 'Worker 收到无法反序列化的消息');
    });
    this.#operationQueue = operation.catch(() => undefined);
    return operation;
  }

  async #processInput(input: unknown): Promise<void> {
    if (this.#disposed) {
      return;
    }

    let message: MainToWorkerMessage;
    try {
      message = parseMainToWorkerMessage(input);
    } catch (error) {
      this.#failSafely('invalidCommand', describeProtocolError(error));
      return;
    }

    this.#activeRequestSequence = message.sequence;
    try {
      await this.#processMessage(message);
    } finally {
      this.#activeRequestSequence = null;
    }
  }

  async #processMessage(message: MainToWorkerMessage): Promise<void> {
    if (this.#commandGate === undefined) {
      if (message.type !== 'initialize') {
        this.#sessionId = message.sessionId;
        this.#sendError('invalidState', 'Physics Worker 的第一条命令必须是 initialize', false);
        this.#disposed = true;
        this.#closeWorker();
        return;
      }
      await this.#initialize(message);
      return;
    }

    const decision = this.#commandGate.accept(message);
    if (!decision.accepted) {
      this.#failSafely(
        'invalidCommand',
        decision.reason === 'sessionMismatch'
          ? '命令 sessionId 与当前 Worker 会话不一致'
          : '命令 sequence 必须严格递增',
      );
      return;
    }

    switch (message.type) {
      case 'initialize':
        this.#failSafely('invalidState', '当前 Worker 已经初始化');
        break;
      case 'start':
        this.#start();
        break;
      case 'pause':
        await this.#pause();
        break;
      case 'step':
        await this.#step(message.stepSeconds);
        break;
      case 'setTimeScale':
        await this.#setTimeScale(message.timeScale);
        break;
      case 'replaceBodies':
        await this.#replaceBodies(message);
        break;
      case 'restoreSnapshot':
        await this.#restoreSnapshot(message);
        break;
      case 'dispose':
        this.#dispose();
        break;
    }
  }

  async #initialize(message: Extract<MainToWorkerMessage, { type: 'initialize' }>): Promise<void> {
    this.#sessionId = message.sessionId;
    this.#commandGate = new SessionSequenceGate(message.sessionId);
    this.#commandGate.accept(message);

    try {
      this.#simulation = await this.#createSimulation(message.bodies, 0);
      this.#collisionKernel = await this.#loadCollisionKernel?.();
      this.#physicsState = createPhysicsStateFromSnapshot(this.#simulation.snapshot());
      this.#runState = 'initialized';
      this.#send({ type: 'ready', replyToSequence: message.sequence, bodyRevision: 0 });
    } catch (error) {
      this.#runState = undefined;
      this.#simulation?.destroy();
      this.#simulation = undefined;
      this.#collisionKernel = undefined;
      this.#sendError('initializationFailed', describeProtocolError(error), false);
      this.#disposed = true;
      this.#closeWorker();
    }
  }

  #start(): void {
    if (this.#runState === 'running') {
      this.#sendStatus(this.#activeRequestSequence);
      return;
    }
    if (this.#requireLiveSimulation() === undefined) {
      return;
    }

    this.#runState = 'running';
    this.#lastRealTimeMilliseconds = this.#scheduler.nowMilliseconds();
    try {
      this.#scheduleNextSlice();
      this.#sendStatus(this.#activeRequestSequence);
    } catch (error) {
      this.#failSafely('internalError', describeProtocolError(error));
    }
  }

  async #pause(): Promise<void> {
    if (this.#requireLiveSimulation() === undefined) {
      return;
    }
    if (this.#runState === 'running') {
      const outcome = await this.#advanceRunningTarget();
      if (outcome === 'failed') {
        return;
      }
    }

    this.#cancelScheduledSlice();
    this.#runState = 'paused';
    this.#lastRealTimeMilliseconds = undefined;
    this.#sendStatus(this.#activeRequestSequence);
  }

  async #step(stepSeconds: number): Promise<void> {
    const simulation = this.#requireLiveSimulation();
    if (simulation === undefined) {
      return;
    }
    if (this.#runState === 'running') {
      this.#failSafely('invalidState', '运行中不能单步推进，请先暂停');
      return;
    }

    const targetTimeSeconds = simulation.timeSeconds + stepSeconds;
    if (!Number.isFinite(targetTimeSeconds)) {
      this.#failSafely('integrationFailed', '单步目标时间超出有限数范围');
      return;
    }
    if (targetTimeSeconds <= simulation.timeSeconds) {
      this.#failSafely('integrationFailed', '单步长度小于当前模拟时间的可表示精度');
      return;
    }

    await this.#advanceToTarget(targetTimeSeconds, this.#activeRequestSequence);
  }

  async #setTimeScale(timeScale: number): Promise<void> {
    if (this.#requireLiveSimulation() === undefined) {
      return;
    }
    if (this.#runState === 'running') {
      const outcome = await this.#advanceRunningTarget();
      if (outcome === 'failed') {
        return;
      }
    }
    this.#timeScale = timeScale;
    this.#sendStatus(this.#activeRequestSequence);
  }

  async #replaceBodies(
    message: Extract<MainToWorkerMessage, { type: 'replaceBodies' }>,
  ): Promise<void> {
    const previousSimulation = this.#requireLiveSimulation();
    if (previousSimulation === undefined) {
      return;
    }
    if (this.#runState !== 'paused') {
      this.#failSafely('invalidState', '只有暂停状态可以修改天体');
      return;
    }
    if (message.expectedBodyRevision !== this.#bodyRevision) {
      this.#sendError(
        'bodyRevisionConflict',
        `天体修订号冲突：预期 ${String(this.#bodyRevision)}，实际 ${String(message.expectedBodyRevision)}`,
        true,
      );
      return;
    }

    const simulationTimeSeconds = previousSimulation.timeSeconds;
    if (message.expectedSimulationTimeSeconds !== simulationTimeSeconds) {
      this.#sendError(
        'bodySnapshotConflict',
        `天体快照时间冲突：预期 ${String(simulationTimeSeconds)}，实际 ${String(message.expectedSimulationTimeSeconds)}`,
        true,
      );
      return;
    }
    let candidateSimulation: PhysicsSimulation | undefined;
    let candidateState: PhysicsState | undefined;
    try {
      candidateSimulation = await this.#createSimulation(message.bodies, simulationTimeSeconds, {
        preserveReferenceFrame: true,
      });
      if (candidateSimulation.timeSeconds !== simulationTimeSeconds) {
        throw new Error('候选物理模拟没有保留当前模拟时间');
      }
      const snapshot = candidateSimulation.snapshot();
      const previousState = this.#physicsState;
      if (previousState === undefined) {
        throw new Error('天体替换缺少当前物理状态');
      }
      candidateState = replacePhysicsStateAssets(
        previousState,
        snapshot,
        previousState.tracers,
        previousState.dustCohorts,
        previousState.cumulativeCollisionLedger,
      );
    } catch (error) {
      if (candidateSimulation !== undefined && candidateSimulation !== previousSimulation) {
        candidateSimulation.destroy();
      }
      this.#sendError('bodyReplacementFailed', describeProtocolError(error), true);
      return;
    }

    this.#simulation = candidateSimulation;
    this.#physicsState = candidateState;
    this.#bodyRevision += 1;
    if (candidateSimulation !== previousSimulation) {
      previousSimulation.destroy();
    }
    this.#send({
      type: 'bodiesReplaced',
      replyToSequence: message.sequence,
      bodyRevision: this.#bodyRevision,
      state: candidateState,
    });
  }

  async #restoreSnapshot(
    message: Extract<MainToWorkerMessage, { type: 'restoreSnapshot' }>,
  ): Promise<void> {
    const previousSimulation = this.#requireLiveSimulation();
    if (previousSimulation === undefined) {
      return;
    }
    if (this.#runState !== 'paused') {
      this.#failSafely('invalidState', '只有暂停状态可以恢复快照');
      return;
    }
    if (message.expectedBodyRevision !== this.#bodyRevision) {
      this.#sendError(
        'bodyRevisionConflict',
        `天体修订号冲突：预期 ${String(this.#bodyRevision)}，实际 ${String(message.expectedBodyRevision)}`,
        true,
      );
      return;
    }
    if (message.expectedSimulationTimeSeconds !== previousSimulation.timeSeconds) {
      this.#sendError(
        'bodySnapshotConflict',
        `天体快照时间冲突：预期 ${String(previousSimulation.timeSeconds)}，实际 ${String(message.expectedSimulationTimeSeconds)}`,
        true,
      );
      return;
    }

    let candidateSimulation: PhysicsSimulation | undefined;
    try {
      candidateSimulation = await this.#createSimulation(
        message.state.majorBodies,
        message.snapshotSimulationTimeSeconds,
        { preserveReferenceFrame: true },
      );
      if (candidateSimulation.timeSeconds !== message.snapshotSimulationTimeSeconds) {
        throw new Error('候选物理模拟没有进入快照时间');
      }
      assertRestoredSnapshotMatches(candidateSimulation.snapshot().bodies, message.state);
    } catch (error) {
      if (candidateSimulation !== undefined && candidateSimulation !== previousSimulation) {
        candidateSimulation.destroy();
      }
      this.#sendError('snapshotRestoreFailed', describeProtocolError(error), true);
      return;
    }

    this.#simulation = candidateSimulation;
    this.#physicsState = message.state;
    this.#bodyRevision += 1;
    if (candidateSimulation !== previousSimulation) {
      previousSimulation.destroy();
    }
    this.#send({
      type: 'snapshotRestored',
      replyToSequence: message.sequence,
      bodyRevision: this.#bodyRevision,
      state: message.state,
    });
  }

  #dispose(): void {
    const simulation = this.#requireLiveSimulation();
    if (simulation === undefined) {
      return;
    }

    this.#cancelScheduledSlice();
    const simulationTimeSeconds = simulation.timeSeconds;
    simulation.destroy();
    this.#simulation = undefined;
    this.#physicsState = undefined;
    this.#runState = undefined;
    this.#disposed = true;
    this.#send(
      { type: 'disposed', replyToSequence: this.#activeRequestSequence ?? 0 },
      simulationTimeSeconds,
    );
    this.#closeWorker();
  }

  #scheduleNextSlice(): void {
    if (this.#runState !== 'running' || this.#scheduledTask !== undefined) {
      return;
    }
    this.#scheduledTask = this.#scheduler.schedule(() => {
      this.#scheduledTask = undefined;
      const operation = this.#operationQueue.then(() => this.#runScheduledSliceSafely());
      this.#operationQueue = operation.catch(() => undefined);
    });
  }

  async #runScheduledSliceSafely(): Promise<void> {
    try {
      await this.#runScheduledSlice();
    } catch (error) {
      this.#failSafely('internalError', describeProtocolError(error));
    }
  }

  async #runScheduledSlice(): Promise<void> {
    if (this.#runState !== 'running') {
      return;
    }
    const outcome = await this.#advanceRunningTarget();
    if (outcome === 'advanced') {
      this.#scheduleNextSlice();
    }
  }

  async #advanceRunningTarget(): Promise<'advanced' | 'collision' | 'failed'> {
    if (this.#runState !== 'running') {
      return 'failed';
    }
    const simulation = this.#requireLiveSimulation();
    if (simulation === undefined) {
      return 'failed';
    }

    const previousRealTimeMilliseconds = this.#lastRealTimeMilliseconds;
    const measuredRealTimeMilliseconds = this.#scheduler.nowMilliseconds();
    if (previousRealTimeMilliseconds === undefined) {
      this.#lastRealTimeMilliseconds = measuredRealTimeMilliseconds;
      return 'advanced';
    }
    const currentRealTimeMilliseconds = Math.max(
      previousRealTimeMilliseconds,
      measuredRealTimeMilliseconds,
    );
    const elapsedRealSeconds = (currentRealTimeMilliseconds - previousRealTimeMilliseconds) / 1_000;
    this.#lastRealTimeMilliseconds = currentRealTimeMilliseconds;
    const requestedAdvanceSeconds =
      elapsedRealSeconds * SIMULATION_SECONDS_PER_REAL_SECOND_AT_1X * this.#timeScale;
    if (!Number.isFinite(requestedAdvanceSeconds)) {
      this.#failSafely('integrationFailed', '时间倍率产生了超出有限数范围的目标时间');
      return 'failed';
    }
    const advanceSeconds = Math.min(
      requestedAdvanceSeconds,
      MAX_SIMULATION_ADVANCE_PER_SLICE_SECONDS,
    );
    const reducedTimeScale = requestedAdvanceSeconds > MAX_SIMULATION_ADVANCE_PER_SLICE_SECONDS;
    if (reducedTimeScale) {
      this.#timeScale = Math.max(
        Number.MIN_VALUE,
        MAX_SIMULATION_ADVANCE_PER_SLICE_SECONDS /
          (elapsedRealSeconds * SIMULATION_SECONDS_PER_REAL_SECOND_AT_1X),
      );
    }

    const nextTimeSeconds = simulation.timeSeconds + advanceSeconds;
    if (!Number.isFinite(nextTimeSeconds)) {
      this.#failSafely('integrationFailed', '时间推进产生了超出有限数范围的目标时间');
      return 'failed';
    }
    if (nextTimeSeconds <= simulation.timeSeconds) {
      if (requestedAdvanceSeconds > 0) {
        this.#failSafely('integrationFailed', '运行片段小于当前模拟时间的可表示精度');
        return 'failed';
      }
      return 'advanced';
    }

    const outcome = await this.#advanceToTarget(nextTimeSeconds, null);
    if (outcome === 'advanced' && reducedTimeScale) {
      this.#sendStatus(null);
    }
    return outcome;
  }

  async #advanceToTarget(
    targetTimeSeconds: number,
    replyToSequence: number | null,
  ): Promise<'advanced' | 'collision' | 'failed'> {
    const simulation = this.#requireLiveSimulation();
    const previousState = this.#physicsState;
    if (simulation === undefined || previousState === undefined) {
      return 'failed';
    }
    const previousTimeSeconds = simulation.timeSeconds;
    let advanceResult;
    try {
      advanceResult = simulation.advanceUntilEvent(targetTimeSeconds);
    } catch (error) {
      this.#failSafely(
        isContactSetOverflow(error) ? 'collisionContactSetOverflow' : 'integrationFailed',
        describeProtocolError(error),
      );
      return 'failed';
    }

    if (advanceResult.type === 'advanced') {
      try {
        this.#physicsState = advancePhysicsStateToSnapshot(
          previousState,
          simulation.snapshot(),
          advanceResult.timeSeconds - previousTimeSeconds,
        );
        if (this.#runState !== 'running') {
          this.#runState = 'paused';
        }
        this.#sendCurrentState(replyToSequence, targetTimeSeconds);
        return 'advanced';
      } catch (error) {
        this.#failSafely('integrationFailed', describeProtocolError(error));
        return 'failed';
      }
    }

    let contactState: PhysicsState;
    try {
      contactState = advancePhysicsStateToSnapshot(
        previousState,
        advanceResult.snapshot,
        advanceResult.timeSeconds - previousTimeSeconds,
      );
    } catch (error) {
      this.#failSafely('collisionResolutionFailed', describeProtocolError(error));
      return 'failed';
    }
    this.#physicsState = contactState;
    const collisionKernel = this.#collisionKernel;
    if (collisionKernel === undefined) {
      this.#runState = 'paused';
      this.#cancelScheduledSlice();
      this.#lastRealTimeMilliseconds = undefined;
      this.#sendCurrentState(null, advanceResult.timeSeconds);
      this.#sendError('collisionResolutionFailed', 'Collision WASM 尚未加载', true);
      return 'failed';
    }

    const nextCollisionBatchSequence = this.#collisionBatchSequence + 1;
    try {
      const transaction = await resolveCollisionTransaction({
        collisionBatchSequence: nextCollisionBatchSequence,
        contactPairs: advanceResult.pairs,
        contactState,
        contactTimeSeconds: advanceResult.timeSeconds,
        createSimulation: this.#createSimulation,
        kernel: collisionKernel,
      });
      const bodyRevisionBefore = this.#bodyRevision;
      this.#simulation = transaction.simulation;
      this.#physicsState = transaction.state;
      this.#bodyRevision += 1;
      this.#collisionBatchSequence = nextCollisionBatchSequence;
      this.#runState = 'paused';
      this.#cancelScheduledSlice();
      this.#lastRealTimeMilliseconds = undefined;
      simulation.destroy();
      this.#send({
        type: 'collisionBatchResolved',
        replyToSequence,
        collisionBatchSequence: this.#collisionBatchSequence,
        requestedTargetSimulationTimeSeconds: targetTimeSeconds,
        contactTimeSeconds: advanceResult.timeSeconds,
        runState: 'paused',
        bodyRevisionBefore,
        bodyRevisionAfter: this.#bodyRevision,
        events: [...transaction.events],
        ledgerDelta: [...transaction.ledgerDelta],
        state: transaction.state,
      });
      return 'collision';
    } catch (error) {
      this.#runState = 'paused';
      this.#cancelScheduledSlice();
      this.#lastRealTimeMilliseconds = undefined;
      if (error instanceof CollisionTransactionError) {
        this.#physicsState = error.contactState;
        this.#sendCurrentState(null, advanceResult.timeSeconds);
        this.#sendError(error.code, error.message, true);
      } else {
        this.#sendCurrentState(null, advanceResult.timeSeconds);
        this.#sendError('collisionResolutionFailed', describeProtocolError(error), true);
      }
      return 'failed';
    }
  }

  #failSafely(code: WorkerErrorCode, message: string): void {
    if (this.#runState === 'running') {
      this.#cancelScheduledSlice();
      this.#runState = 'paused';
      this.#lastRealTimeMilliseconds = undefined;
    }
    if (this.#sessionId !== undefined) {
      this.#sendError(code, message, code === 'invalidCommand' || code === 'invalidState');
    }
  }

  #sendCurrentState(
    replyToSequence: number | null,
    requestedTargetSimulationTimeSeconds: number,
  ): void {
    const state = this.#physicsState;
    if (state === undefined) {
      this.#failSafely('invalidState', '物理状态尚未成功初始化');
      return;
    }
    this.#send({
      type: 'state',
      replyToSequence,
      bodyRevision: this.#bodyRevision,
      requestedTargetSimulationTimeSeconds,
      state,
    });
  }

  #sendStatus(replyToSequence: number | null): void {
    if (this.#runState === undefined) {
      return;
    }
    this.#send({
      type: 'status',
      replyToSequence,
      runState: this.#runState,
      timeScale: this.#timeScale,
    });
  }

  #sendError(code: WorkerErrorCode, message: string, recoverable: boolean): void {
    this.#send({
      type: 'error',
      code,
      message: boundedErrorMessage(message),
      recoverable,
      replyToSequence: this.#activeRequestSequence,
    });
  }

  #send(
    payload: RuntimeResponsePayload,
    simulationTimeSeconds = this.#simulation?.timeSeconds ?? 0,
  ): void {
    if (this.#sessionId === undefined) {
      return;
    }
    const message = parseWorkerToMainMessage({
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      sequence: this.#nextResponseSequence,
      simulationTimeSeconds,
      ...payload,
    });
    this.#nextResponseSequence += 1;
    this.#postMessage(message);
  }

  #cancelScheduledSlice(): void {
    if (this.#scheduledTask !== undefined) {
      this.#scheduler.cancel(this.#scheduledTask);
      this.#scheduledTask = undefined;
    }
  }

  #requireLiveSimulation(): PhysicsSimulation | undefined {
    if (this.#simulation !== undefined && this.#runState !== undefined) {
      return this.#simulation;
    }
    this.#failSafely('invalidState', '物理模拟尚未成功初始化');
    return undefined;
  }
}
