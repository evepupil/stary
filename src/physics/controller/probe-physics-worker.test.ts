import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseWorkerToMainMessage } from '../protocol/parse-message';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../protocol/schemas';
import { PhysicsWorkerController, type PhysicsWorkerTarget } from './physics-worker-controller';
import { PHYSICS_PROBE_STEP_SECONDS, probePhysicsWorker } from './probe-physics-worker';

type FakeWorkerMode =
  'error' | 'manualStatus' | 'messageerror' | 'protocolError' | 'silent' | 'success';
type WorkerControllerEventType = 'error' | 'message' | 'messageerror';

const diagnostics = {
  totalEnergyJoules: -1,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
} as const;

class FakePhysicsWorker implements PhysicsWorkerTarget {
  readonly listeners = new Map<WorkerControllerEventType, Set<EventListener>>();
  readonly postedMessages: MainToWorkerMessage[] = [];
  terminated = false;
  #nextResponseSequence = 0;

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
        simulationTimeSeconds: 0,
      });
      return;
    }

    switch (message.type) {
      case 'initialize':
        this.respond({ type: 'ready', simulationTimeSeconds: 0 });
        break;
      case 'step':
        this.respond({
          type: 'state',
          simulationTimeSeconds: message.simulationTimeSeconds + message.stepSeconds,
          bodies: this.initialBodies(),
          diagnostics,
        });
        break;
      case 'dispose':
        this.respond({ type: 'disposed', simulationTimeSeconds: message.simulationTimeSeconds });
        break;
      case 'start':
        this.respond({
          type: 'status',
          simulationTimeSeconds: message.simulationTimeSeconds,
          runState: 'running',
          timeScale: 1,
        });
        break;
      case 'pause':
        this.respond({
          type: 'status',
          simulationTimeSeconds: message.simulationTimeSeconds,
          runState: 'paused',
          timeScale: 1,
        });
        break;
      case 'setTimeScale':
        if (this.mode !== 'manualStatus') {
          this.respond({
            type: 'status',
            simulationTimeSeconds: message.simulationTimeSeconds,
            runState: 'paused',
            timeScale: message.timeScale,
          });
        }
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

  sendStatus(timeScale: number): void {
    this.respond({
      type: 'status',
      simulationTimeSeconds: 0,
      runState: 'running',
      timeScale,
    });
  }

  private emit(type: WorkerControllerEventType, event: Event): void {
    this.listeners.get(type)?.forEach((listener) => {
      listener(event);
    });
  }

  private initialBodies() {
    const initialize = this.postedMessages.find(
      (message): message is Extract<MainToWorkerMessage, { type: 'initialize' }> =>
        message.type === 'initialize',
    );
    return initialize?.bodies ?? [];
  }

  private respond(
    payload:
      | { readonly simulationTimeSeconds: number; readonly type: 'ready' | 'disposed' }
      | {
          readonly bodies: Extract<WorkerToMainMessage, { type: 'state' }>['bodies'];
          readonly diagnostics: Extract<WorkerToMainMessage, { type: 'state' }>['diagnostics'];
          readonly simulationTimeSeconds: number;
          readonly type: 'state';
        }
      | {
          readonly runState: Extract<WorkerToMainMessage, { type: 'status' }>['runState'];
          readonly simulationTimeSeconds: number;
          readonly timeScale: number;
          readonly type: 'status';
        }
      | {
          readonly code: Extract<WorkerToMainMessage, { type: 'error' }>['code'];
          readonly message: string;
          readonly recoverable: boolean;
          readonly simulationTimeSeconds: number;
          readonly type: 'error';
        },
  ): void {
    const sessionId = this.postedMessages[0]?.sessionId ?? 'probe-session';
    const message = parseWorkerToMainMessage({
      version: 1,
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
    await expect(controller.dispose()).rejects.toThrow('尚未初始化');

    expect(worker.postedMessages).toHaveLength(0);
    controller.close();
  });

  it('订阅主动降速 status，待决倍率请求只由各自目标值完成', async () => {
    const worker = new FakePhysicsWorker('manualStatus');
    const controller = new PhysicsWorkerController({
      createWorker: () => worker,
      sessionId: 'probe-session',
    });
    await controller.initialize([
      {
        id: 'body',
        massKg: 1,
        radiusMeters: 0,
        positionMeters: { x: 0, y: 0, z: 0 },
        velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
      },
    ]);
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

    worker.sendStatus(500);
    await Promise.resolve();

    expect(receivedTimeScales).toEqual([500]);
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    worker.sendStatus(1_000);
    await first;
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(false);

    worker.sendStatus(2_000);
    await second;
    expect(secondResolved).toBe(true);
    expect(receivedTimeScales).toEqual([500, 1_000, 2_000]);

    unsubscribe();
    controller.close();
  });
});
