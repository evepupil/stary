import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseWorkerToMainMessage } from '../protocol/parse-message';
import { createPhysicsStateFromSnapshot } from '../protocol/physics-state';
import type { BodyState, MainToWorkerMessage, WorkerToMainMessage } from '../protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../protocol/schemas';
import { createTestCollisionBatchMessage } from '../../features/observatory/simulation/test-helpers';
import { PhysicsWorkerController, type PhysicsWorkerTarget } from './physics-worker-controller';
import { PHYSICS_PROBE_STEP_SECONDS, probePhysicsWorker } from './probe-physics-worker';

type FakeWorkerMode =
  | 'error'
  | 'manualStatus'
  | 'manualReplacementError'
  | 'manualStep'
  | 'messageerror'
  | 'protocolError'
  | 'replacementError'
  | 'silent'
  | 'success';
type WorkerControllerEventType = 'error' | 'message' | 'messageerror';
type FakeWorkerResponsePayload<Message extends WorkerToMainMessage = WorkerToMainMessage> =
  Message extends WorkerToMainMessage ? Omit<Message, 'version' | 'sessionId' | 'sequence'> : never;

const diagnostics = {
  totalEnergyJoules: -1,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
} as const;

const testBody: BodyState = {
  id: 'body',
  massKg: 1,
  radiusMeters: 0,
  positionMeters: { x: 0, y: 0, z: 0 },
  velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
  momentOfInertiaFactor: 0.4,
  materialLayers: [{ material: 'silicate', massFraction: 1 }],
  collisionModel: 'gravitySolid',
};

class FakePhysicsWorker implements PhysicsWorkerTarget {
  readonly listeners = new Map<WorkerControllerEventType, Set<EventListener>>();
  readonly postedMessages: MainToWorkerMessage[] = [];
  terminated = false;
  #bodyRevision = 0;
  #currentBodies: BodyState[] = [];
  #nextResponseSequence = 0;
  #simulationTimeSeconds = 0;

  constructor(readonly mode: FakeWorkerMode) {}

  addEventListener(type: WorkerControllerEventType, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: MainToWorkerMessage): void {
    this.postedMessages.push(message);
    if (this.mode === 'silent') {
      return;
    }
    if (this.mode === 'error') {
      this.emit('error', new Event('error', { cancelable: true }));
      return;
    }
    if (this.mode === 'messageerror') {
      this.emit('messageerror', new Event('messageerror'));
      return;
    }
    if (this.mode === 'protocolError') {
      this.respond({
        type: 'error',
        code: 'initializationFailed',
        message: 'WASM 初始化失败',
        recoverable: false,
        replyToSequence: message.sequence,
        simulationTimeSeconds: 0,
      });
      return;
    }

    switch (message.type) {
      case 'initialize':
        this.#currentBodies = [...message.bodies];
        this.respond({
          type: 'ready',
          simulationTimeSeconds: 0,
          replyToSequence: message.sequence,
          bodyRevision: 0,
        });
        break;
      case 'step':
        if (this.mode === 'manualStep') {
          break;
        }
        this.#simulationTimeSeconds = message.simulationTimeSeconds + message.stepSeconds;
        this.respond({
          type: 'state',
          simulationTimeSeconds: this.#simulationTimeSeconds,
          replyToSequence: message.sequence,
          bodyRevision: this.#bodyRevision,
          requestedTargetSimulationTimeSeconds: this.#simulationTimeSeconds,
          state: createPhysicsStateFromSnapshot({ bodies: this.#currentBodies, diagnostics }),
        });
        break;
      case 'dispose':
        this.respond({
          type: 'disposed',
          simulationTimeSeconds: message.simulationTimeSeconds,
          replyToSequence: message.sequence,
        });
        break;
      case 'start':
        this.respond({
          type: 'status',
          simulationTimeSeconds: message.simulationTimeSeconds,
          replyToSequence: message.sequence,
          runState: 'running',
          timeScale: 1,
        });
        break;
      case 'pause':
        if (this.mode !== 'manualStatus') {
          this.respond({
            type: 'status',
            simulationTimeSeconds: message.simulationTimeSeconds,
            replyToSequence: message.sequence,
            runState: 'paused',
            timeScale: 1,
          });
        }
        break;
      case 'setTimeScale':
        if (this.mode !== 'manualStatus' && this.mode !== 'manualReplacementError') {
          this.respond({
            type: 'status',
            simulationTimeSeconds: message.simulationTimeSeconds,
            replyToSequence: message.sequence,
            runState: 'paused',
            timeScale: message.timeScale,
          });
        }
        break;
      case 'replaceBodies':
        if (message.expectedBodyRevision !== this.#bodyRevision) {
          this.respond({
            type: 'error',
            code: 'bodyRevisionConflict',
            message: '修订冲突',
            recoverable: true,
            replyToSequence: message.sequence,
            simulationTimeSeconds: message.simulationTimeSeconds,
          });
          break;
        }
        if (message.expectedSimulationTimeSeconds !== this.#simulationTimeSeconds) {
          this.respond({
            type: 'error',
            code: 'bodySnapshotConflict',
            message: '快照时间冲突',
            recoverable: true,
            replyToSequence: message.sequence,
            simulationTimeSeconds: this.#simulationTimeSeconds,
          });
          break;
        }
        if (this.mode === 'manualReplacementError') {
          break;
        }
        if (this.mode === 'replacementError') {
          this.respond({
            type: 'error',
            code: 'bodyReplacementFailed',
            message: '替换失败',
            recoverable: true,
            replyToSequence: message.sequence,
            simulationTimeSeconds: message.simulationTimeSeconds,
          });
          break;
        }
        this.#bodyRevision += 1;
        this.#currentBodies = [...message.bodies];
        this.respond({
          type: 'bodiesReplaced',
          simulationTimeSeconds: message.simulationTimeSeconds,
          replyToSequence: message.sequence,
          bodyRevision: this.#bodyRevision,
          state: createPhysicsStateFromSnapshot({ bodies: this.#currentBodies, diagnostics }),
        });
        break;
    }
  }

  removeEventListener(type: WorkerControllerEventType, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  sendStatus(
    timeScale: number,
    replyToSequence: number | null = null,
    runState: 'paused' | 'running' = 'running',
  ): void {
    this.respond({
      type: 'status',
      simulationTimeSeconds: this.#simulationTimeSeconds,
      replyToSequence,
      runState,
      timeScale,
    });
  }

  sendReplacementError(): void {
    const replacement = this.postedMessages.findLast(
      (message): message is Extract<MainToWorkerMessage, { type: 'replaceBodies' }> =>
        message.type === 'replaceBodies',
    );
    this.respond({
      type: 'error',
      code: 'bodyReplacementFailed',
      message: '替换失败',
      recoverable: true,
      replyToSequence: replacement?.sequence ?? null,
      simulationTimeSeconds: this.#simulationTimeSeconds,
    });
  }

  sendUncorrelatedError(): void {
    this.respond({
      type: 'error',
      code: 'invalidCommand',
      message: '无法关联的外部消息',
      recoverable: true,
      replyToSequence: null,
      simulationTimeSeconds: this.#simulationTimeSeconds,
    });
  }

  sendBackgroundState(bodyRevision: number): void {
    this.respond({
      type: 'state',
      simulationTimeSeconds: this.#simulationTimeSeconds,
      replyToSequence: null,
      bodyRevision,
      requestedTargetSimulationTimeSeconds: this.#simulationTimeSeconds,
      state: createPhysicsStateFromSnapshot({ bodies: this.#currentBodies, diagnostics }),
    });
  }

  sendCollisionBatch(replyToSequence: number, requestedTargetSimulationTimeSeconds: number): void {
    const batch = createTestCollisionBatchMessage({
      contactTimeSeconds: requestedTargetSimulationTimeSeconds - 1,
      replyToSequence,
      requestedTargetSimulationTimeSeconds,
    });
    const { sequence: _sequence, sessionId: _sessionId, version: _version, ...payload } = batch;
    void _sequence;
    void _sessionId;
    void _version;
    this.respond(payload);
  }

  private emit(type: WorkerControllerEventType, event: Event): void {
    this.listeners.get(type)?.forEach((listener) => {
      listener(event);
    });
  }

  private respond(payload: FakeWorkerResponsePayload): void {
    const sessionId = this.postedMessages[0]?.sessionId ?? 'probe-session';
    const message = parseWorkerToMainMessage({
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId,
      sequence: this.#nextResponseSequence,
      ...payload,
    });
    this.#nextResponseSequence += 1;
    this.emit('message', new MessageEvent('message', { data: message }));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('probePhysicsWorker', () => {
  it('完成 initialize、start、pause、step、dispose 并清理 Worker', async () => {
    const worker = new FakePhysicsWorker('success');

    await expect(
      probePhysicsWorker({ createWorker: () => worker, sessionId: 'probe-session' }),
    ).resolves.toEqual({
      bodyCount: 2,
      simulationTimeSeconds: PHYSICS_PROBE_STEP_SECONDS,
      stepSeconds: PHYSICS_PROBE_STEP_SECONDS,
    });

    expect(worker.postedMessages.map((message) => message.type)).toEqual([
      'initialize',
      'start',
      'pause',
      'step',
      'dispose',
    ]);
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it.each([
    ['error', '运行错误'],
    ['messageerror', '无法反序列化'],
    ['protocolError', 'initializationFailed'],
  ] as const)('%s 会返回明确错误并完整清理', async (mode, message) => {
    const worker = new FakePhysicsWorker(mode);

    await expect(
      probePhysicsWorker({ createWorker: () => worker, sessionId: 'probe-session' }),
    ).rejects.toThrow(message);
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it('操作超时会拒绝并完整清理', async () => {
    vi.useFakeTimers();
    const worker = new FakePhysicsWorker('silent');
    const promise = probePhysicsWorker({
      createWorker: () => worker,
      operationTimeoutMs: 100,
      sessionId: 'probe-session',
    });
    const assertion = expect(promise).rejects.toThrow('100ms 内未返回 ready');

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it('AbortSignal 取消会返回 AbortError 并完整清理', async () => {
    const worker = new FakePhysicsWorker('silent');
    const abortController = new AbortController();
    const promise = probePhysicsWorker({
      createWorker: () => worker,
      sessionId: 'probe-session',
      signal: abortController.signal,
    });

    abortController.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });
});

describe('PhysicsWorkerController', () => {
  it.each([
    ['error', '运行错误'],
    ['messageerror', '无法反序列化'],
  ] as const)('原生 %s 会先通知 fatal 订阅，再关闭控制器', async (mode, message) => {
    const worker = new FakePhysicsWorker(mode);
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'probe-session',
    });
    const fatalErrors: Error[] = [];
    controller.subscribeFatal((error) => {
      expect(worker.terminated).toBe(false);
      fatalErrors.push(error);
    });

    await expect(controller.initialize([testBody])).rejects.toThrow(message);

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]?.message).toContain(message);
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it('fatal 订阅抛错不会阻断后续通知和待决命令清理', async () => {
    const worker = new FakePhysicsWorker('error');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'probe-session',
    });
    const survivingListener = vi.fn();
    controller.subscribeFatal(() => {
      throw new Error('订阅者自身错误');
    });
    controller.subscribeFatal(survivingListener);

    const pendingInitialization = controller.initialize([testBody]);

    await expect(pendingInitialization).rejects.toThrow('运行错误');
    expect(survivingListener).toHaveBeenCalledOnce();
    expect(survivingListener.mock.calls[0]?.[0]).toMatchObject({
      message: 'Physics Worker 运行错误',
    });
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it('initialize 完成前所有运行命令立即拒绝且不会发给 Worker', async () => {
    const worker = new FakePhysicsWorker('silent');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'probe-session',
    });

    await expect(controller.start()).rejects.toThrow('尚未初始化');
    await expect(controller.pause()).rejects.toThrow('尚未初始化');
    await expect(controller.step(1)).rejects.toThrow('尚未初始化');
    await expect(controller.setTimeScale(2)).rejects.toThrow('尚未初始化');
    await expect(controller.replaceBodies([testBody], 0, 0)).rejects.toThrow('尚未初始化');
    await expect(controller.dispose()).rejects.toThrow('尚未初始化');

    expect(worker.postedMessages).toHaveLength(0);
    controller.close();
  });

  it('后台 state 不能跳过未见过的天体修订号', async () => {
    const worker = new FakePhysicsWorker('success');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'revision-session',
    });
    await controller.initialize([testBody]);
    const fatal = vi.fn();
    controller.subscribeFatal(fatal);

    worker.sendBackgroundState(1);

    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({
      message: 'Physics Worker state 的天体修订号与当前状态不一致',
    });
    expect(worker.terminated).toBe(true);
  });

  it('step 遇到提前碰撞时由同请求序号的批次正常完成', async () => {
    const worker = new FakePhysicsWorker('manualStep');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'collision-session',
    });
    await controller.initialize([
      { ...testBody, id: 'first-parent' },
      { ...testBody, id: 'second-parent' },
    ]);

    const advance = controller.step(10);
    const stepCommand = worker.postedMessages.findLast(
      (message): message is Extract<MainToWorkerMessage, { type: 'step' }> =>
        message.type === 'step',
    );
    if (stepCommand === undefined) {
      throw new Error('测试缺少 step 命令');
    }
    worker.sendCollisionBatch(stepCommand.sequence, 10);

    await expect(advance).resolves.toMatchObject({
      type: 'collisionBatchResolved',
      replyToSequence: stepCommand.sequence,
      requestedTargetSimulationTimeSeconds: 10,
      contactTimeSeconds: 9,
      bodyRevisionAfter: 1,
    });
    expect(controller.bodyRevision).toBe(1);
    controller.close();
  });

  it('后台 status 不完成待决倍率请求，命令回执按 replyToSequence 精确配对', async () => {
    const worker = new FakePhysicsWorker('manualStatus');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'probe-session',
    });
    await controller.initialize([testBody]);
    const receivedTimeScales: number[] = [];
    const unsubscribe = controller.subscribe((message) => {
      if (message.type === 'status') {
        receivedTimeScales.push(message.timeScale);
      }
    });
    let firstResolved = false;
    let secondResolved = false;
    const first = controller.setTimeScale(1_000).then(() => {
      firstResolved = true;
    });
    const second = controller.setTimeScale(2_000).then(() => {
      secondResolved = true;
    });
    const timeScaleCommands = worker.postedMessages.filter(
      (message): message is Extract<MainToWorkerMessage, { type: 'setTimeScale' }> =>
        message.type === 'setTimeScale',
    );
    expect(timeScaleCommands).toHaveLength(2);

    worker.sendStatus(500);
    await Promise.resolve();

    expect(receivedTimeScales).toEqual([500]);
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    worker.sendStatus(1_000, timeScaleCommands[0]?.sequence ?? null);
    await first;
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(false);

    worker.sendStatus(2_000, timeScaleCommands[1]?.sequence ?? null);
    await second;
    expect(secondResolved).toBe(true);
    expect(receivedTimeScales).toEqual([500, 1_000, 2_000]);

    unsubscribe();
    controller.close();
  });

  it('pause 与 setTimeScale 只能由自己的回执完成，后台中间帧保持待决', async () => {
    const worker = new FakePhysicsWorker('manualStatus');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'reply-pair-session',
    });
    await controller.initialize([testBody]);

    let pauseResolved = false;
    const pause = controller.pause().then(() => {
      pauseResolved = true;
    });
    const pauseCommand = worker.postedMessages.findLast(
      (message): message is Extract<MainToWorkerMessage, { type: 'pause' }> =>
        message.type === 'pause',
    );
    expect(pauseCommand).toBeDefined();
    worker.sendStatus(1, null, 'paused');
    await Promise.resolve();
    expect(pauseResolved).toBe(false);
    worker.sendStatus(1, pauseCommand?.sequence ?? null, 'paused');
    await pause;
    expect(pauseResolved).toBe(true);

    let scaleResolved = false;
    const scale = controller.setTimeScale(2_000).then(() => {
      scaleResolved = true;
    });
    const scaleCommand = worker.postedMessages.findLast(
      (message): message is Extract<MainToWorkerMessage, { type: 'setTimeScale' }> =>
        message.type === 'setTimeScale',
    );
    expect(scaleCommand).toBeDefined();
    worker.sendStatus(2_000, null, 'paused');
    await Promise.resolve();
    expect(scaleResolved).toBe(false);
    worker.sendStatus(2_000, scaleCommand?.sequence ?? null, 'paused');
    await scale;
    expect(scaleResolved).toBe(true);

    controller.close();
  });

  it('replaceBodies 会先暂停，再按当前修订原子提交完整天体列表', async () => {
    const worker = new FakePhysicsWorker('success');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'replacement-session',
    });
    await controller.initialize([testBody]);
    await controller.start();
    const nextBodies = [
      testBody,
      {
        ...testBody,
        id: 'planet',
        positionMeters: { x: 1, y: 0, z: 0 },
      },
    ];

    const replaced = await controller.replaceBodies(nextBodies, 0, 0);

    expect(worker.postedMessages.map((message) => message.type)).toEqual([
      'initialize',
      'start',
      'pause',
      'replaceBodies',
    ]);
    expect(worker.postedMessages.at(-1)).toMatchObject({
      type: 'replaceBodies',
      expectedBodyRevision: 0,
      expectedSimulationTimeSeconds: 0,
    });
    expect(replaced).toMatchObject({
      type: 'bodiesReplaced',
      bodyRevision: 1,
      state: { majorBodies: nextBodies },
    });
    expect(controller.bodyRevision).toBe(1);
    controller.close();
  });

  it('并发旧草稿会串行提交并拒绝过期修订', async () => {
    const worker = new FakePhysicsWorker('success');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'replacement-session',
    });
    await controller.initialize([testBody]);
    const firstBodies = [{ ...testBody, id: 'first' }];
    const secondBodies = [{ ...testBody, id: 'second' }];

    const first = controller.replaceBodies(firstBodies, 0, 0);
    const stale = controller.replaceBodies(secondBodies, 0, 0);

    await expect(first).resolves.toMatchObject({ bodyRevision: 1 });
    await expect(stale).rejects.toMatchObject({
      code: 'bodyRevisionConflict',
      name: 'PhysicsWorkerCommandError',
    });
    await expect(controller.replaceBodies(secondBodies, 1, 0)).resolves.toMatchObject({
      bodyRevision: 2,
    });

    const replaceCommands = worker.postedMessages.filter(
      (message): message is Extract<MainToWorkerMessage, { type: 'replaceBodies' }> =>
        message.type === 'replaceBodies',
    );
    expect(replaceCommands.map((message) => message.expectedBodyRevision)).toEqual([0, 0, 1]);
    expect(controller.bodyRevision).toBe(2);
    controller.close();
  });

  it('提交时固定天体快照，调用方后续修改不会改变发送内容', async () => {
    const worker = new FakePhysicsWorker('success');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'replacement-session',
    });
    await controller.initialize([testBody]);
    const submittedPlanet = {
      ...testBody,
      id: 'planet',
      positionMeters: { x: 1, y: 2, z: 3 },
      spinAngularMomentumKgMetersSquaredPerSecond: {
        ...testBody.spinAngularMomentumKgMetersSquaredPerSecond,
      },
      materialLayers: testBody.materialLayers.map((layer) => ({ ...layer })),
    };
    const submittedBodies = [submittedPlanet];

    const replacement = controller.replaceBodies(submittedBodies, 0, 0);
    submittedPlanet.positionMeters.x = 999;
    submittedPlanet.spinAngularMomentumKgMetersSquaredPerSecond.z = 999;
    const firstLayer = submittedPlanet.materialLayers[0];
    if (firstLayer !== undefined) {
      firstLayer.massFraction = 0.5;
    }
    submittedBodies.push({ ...testBody, id: 'late-body' });

    await expect(replacement).resolves.toMatchObject({ bodyRevision: 1 });
    expect(worker.postedMessages.at(-1)).toMatchObject({
      type: 'replaceBodies',
      bodies: [
        expect.objectContaining({
          id: 'planet',
          positionMeters: { x: 1, y: 2, z: 3 },
          spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
          materialLayers: [{ material: 'silicate', massFraction: 1 }],
        }),
      ],
    });
    controller.close();
  });

  it('可恢复替换错误只拒绝替换请求，并发倍率请求仍由真实 status 完成', async () => {
    const worker = new FakePhysicsWorker('manualReplacementError');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'replacement-session',
    });
    await controller.initialize([testBody]);

    const timeScale = controller.setTimeScale(2_000);
    const replacement = controller.replaceBodies([{ ...testBody, id: 'planet' }], 0, 0);
    await vi.waitFor(() => {
      expect(worker.postedMessages.at(-1)?.type).toBe('replaceBodies');
    });
    const timeScaleCommand = worker.postedMessages.find(
      (message): message is Extract<MainToWorkerMessage, { type: 'setTimeScale' }> =>
        message.type === 'setTimeScale',
    );
    worker.sendReplacementError();
    worker.sendStatus(2_000, timeScaleCommand?.sequence ?? null);

    await expect(replacement).rejects.toThrow('bodyReplacementFailed');
    await expect(timeScale).resolves.toBeUndefined();
    expect(worker.terminated).toBe(false);
    controller.close();
  });

  it('无法关联的可恢复错误不会拒绝普通待决请求', async () => {
    const worker = new FakePhysicsWorker('manualStatus');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'replacement-session',
    });
    await controller.initialize([testBody]);

    const timeScale = controller.setTimeScale(2_000);
    const timeScaleCommand = worker.postedMessages.findLast(
      (message): message is Extract<MainToWorkerMessage, { type: 'setTimeScale' }> =>
        message.type === 'setTimeScale',
    );
    worker.sendUncorrelatedError();
    worker.sendStatus(2_000, timeScaleCommand?.sequence ?? null);

    await expect(timeScale).resolves.toBeUndefined();
    expect(worker.terminated).toBe(false);
    controller.close();
  });

  it('暂停后时间已推进时拒绝过期快照，并允许按最新时间重试', async () => {
    const worker = new FakePhysicsWorker('success');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'replacement-session',
    });
    await controller.initialize([testBody]);
    await controller.step(10);

    await expect(
      controller.replaceBodies([{ ...testBody, id: 'stale' }], 0, 0),
    ).rejects.toMatchObject({
      code: 'bodySnapshotConflict',
      name: 'PhysicsWorkerCommandError',
    });
    expect(controller.bodyRevision).toBe(0);
    await expect(
      controller.replaceBodies([{ ...testBody, id: 'current' }], 0, 10),
    ).resolves.toMatchObject({ bodyRevision: 1, simulationTimeSeconds: 10 });
    controller.close();
  });

  it('可恢复替换失败会拒绝当前操作并保留 controller', async () => {
    const worker = new FakePhysicsWorker('replacementError');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'replacement-session',
    });
    await controller.initialize([testBody]);

    await expect(controller.replaceBodies([{ ...testBody, id: 'planet' }], 0, 0)).rejects.toThrow(
      'bodyReplacementFailed',
    );
    expect(worker.terminated).toBe(false);
    expect(controller.bodyRevision).toBe(0);
    await expect(controller.start()).resolves.toBeUndefined();
    controller.close();
  });
});
