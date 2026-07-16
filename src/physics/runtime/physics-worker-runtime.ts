import { ZodError } from 'zod';

import { parseMainToWorkerMessage, parseWorkerToMainMessage } from '../protocol/parse-message';
import { createPhysicsStateFromSnapshot } from '../protocol/physics-state';
import type { MainToWorkerMessage, PhysicsState, WorkerToMainMessage } from '../protocol/schemas';
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

export class PhysicsWorkerRuntime {
  public readonly collisionKernelWasmUrl: string | null;
  readonly #closeWorker: () => void;
  readonly #createSimulation: CreatePhysicsSimulation;
  readonly #postMessage: (message: WorkerToMainMessage) => void;
  readonly #scheduler: PhysicsScheduler;
  #activeRequestSequence: number | null = null;
  #commandGate: SessionSequenceGate | undefined;
  #bodyRevision = 0;
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
        this.#pause();
        break;
      case 'step':
        this.#step(message.stepSeconds);
        break;
      case 'setTimeScale':
        this.#setTimeScale(message.timeScale);
        break;
      case 'replaceBodies':
        await this.#replaceBodies(message);
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
      this.#physicsState = createPhysicsStateFromSnapshot(this.#simulation.snapshot());
      this.#runState = 'initialized';
      this.#send({ type: 'ready', replyToSequence: message.sequence, bodyRevision: 0 });
    } catch (error) {
      this.#runState = undefined;
      this.#simulation?.destroy();
      this.#simulation = undefined;
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

  #pause(): void {
    if (this.#requireLiveSimulation() === undefined) {
      return;
    }
    if (this.#runState === 'running' && !this.#advanceRunningTarget()) {
      return;
    }

    this.#cancelScheduledSlice();
    this.#runState = 'paused';
    this.#lastRealTimeMilliseconds = undefined;
    this.#sendStatus(this.#activeRequestSequence);
  }

  #step(stepSeconds: number): void {
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

    try {
      simulation.integrateTo(targetTimeSeconds);
      this.#runState = 'paused';
      this.#sendState(this.#activeRequestSequence, targetTimeSeconds);
    } catch (error) {
      this.#failSafely('integrationFailed', describeProtocolError(error));
    }
  }

  #setTimeScale(timeScale: number): void {
    if (this.#requireLiveSimulation() === undefined) {
      return;
    }
    if (this.#runState === 'running' && !this.#advanceRunningTarget()) {
      return;
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
      candidateSimulation = await this.#createSimulation(message.bodies, simulationTimeSeconds);
      if (candidateSimulation.timeSeconds !== simulationTimeSeconds) {
        throw new Error('候选物理模拟没有保留当前模拟时间');
      }
      const snapshot = candidateSimulation.snapshot();
      candidateState = createPhysicsStateFromSnapshot(snapshot, this.#physicsState);
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
      if (this.#runState !== 'running') {
        return;
      }
      if (this.#advanceRunningTarget()) {
        this.#scheduleNextSlice();
      }
    });
  }

  #advanceRunningTarget(): boolean {
    if (this.#runState !== 'running') {
      return false;
    }
    const simulation = this.#requireLiveSimulation();
    if (simulation === undefined) {
      return false;
    }

    const previousRealTimeMilliseconds = this.#lastRealTimeMilliseconds;
    const measuredRealTimeMilliseconds = this.#scheduler.nowMilliseconds();
    if (previousRealTimeMilliseconds === undefined) {
      this.#lastRealTimeMilliseconds = measuredRealTimeMilliseconds;
      return true;
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
      return false;
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
      return false;
    }
    if (nextTimeSeconds <= simulation.timeSeconds) {
      if (requestedAdvanceSeconds > 0) {
        this.#failSafely('integrationFailed', '运行片段小于当前模拟时间的可表示精度');
        return false;
      }
      return true;
    }

    try {
      simulation.integrateTo(nextTimeSeconds);
      this.#sendState(null, nextTimeSeconds);
      if (reducedTimeScale) {
        this.#sendStatus(null);
      }
      return true;
    } catch (error) {
      this.#failSafely('integrationFailed', describeProtocolError(error));
      return false;
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

  #sendState(replyToSequence: number | null, requestedTargetSimulationTimeSeconds: number): void {
    const simulation = this.#requireLiveSimulation();
    if (simulation === undefined) {
      return;
    }
    const snapshot = simulation.snapshot();
    const state = createPhysicsStateFromSnapshot(snapshot, this.#physicsState);
    this.#physicsState = state;
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
