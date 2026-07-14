import { describe, expect, it } from 'vitest';

import { parseWorkerToMainMessage } from '../protocol/parse-message';
import type { BodyState, MainToWorkerMessage, WorkerToMainMessage } from '../protocol/schemas';
import { MAX_TIME_SCALE } from '../protocol/schemas';
import { createCircularSunEarthScenario } from '../scenarios/sun-earth';
import type { PhysicsScheduler, ScheduledPhysicsTask } from './physics-scheduler';
import type { PhysicsSimulation } from './physics-simulation';
import { PhysicsWorkerRuntime } from './physics-worker-runtime';

const diagnostics = {
  totalEnergyJoules: -1,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
} as const;

class FakeScheduler implements PhysicsScheduler {
  now = 0;
  nextTaskId = 1;
  readonly tasks = new Map<number, () => void>();

  cancel(task: ScheduledPhysicsTask): void {
    this.tasks.delete(task as unknown as number);
  }

  nowMilliseconds(): number {
    return this.now;
  }

  schedule(task: () => void): ScheduledPhysicsTask {
    const taskId = this.nextTaskId;
    this.nextTaskId += 1;
    this.tasks.set(taskId, task);
    return taskId as unknown as ScheduledPhysicsTask;
  }

  advanceAndRun(milliseconds: number): void {
    this.elapse(milliseconds);
    const next = this.tasks.entries().next().value as [number, () => void] | undefined;
    if (next === undefined) {
      return;
    }
    this.tasks.delete(next[0]);
    next[1]();
  }

  elapse(milliseconds: number): void {
    this.now += milliseconds;
  }
}

class FakeSimulation implements PhysicsSimulation {
  destroyed = false;
  failIntegration = false;
  timeSeconds = 0;

  constructor(readonly bodies: readonly BodyState[]) {}

  destroy(): void {
    this.destroyed = true;
  }

  integrateTo(targetTimeSeconds: number): void {
    if (this.failIntegration) {
      throw new Error('fake integration failure');
    }
    this.timeSeconds = targetTimeSeconds;
  }

  snapshot() {
    return { bodies: this.bodies, diagnostics };
  }
}

function command(
  sequence: number,
  payload:
    | { readonly bodies: readonly BodyState[]; readonly type: 'initialize' }
    | { readonly type: 'start' | 'pause' | 'dispose' }
    | { readonly stepSeconds: number; readonly type: 'step' }
    | { readonly timeScale: number; readonly type: 'setTimeScale' },
): MainToWorkerMessage {
  return {
    version: 1,
    sessionId: 'session-a',
    sequence,
    simulationTimeSeconds: 0,
    ...payload,
  } as MainToWorkerMessage;
}

function createHarness() {
  const scheduler = new FakeScheduler();
  const simulation = new FakeSimulation(createCircularSunEarthScenario().bodies);
  const messages: WorkerToMainMessage[] = [];
  let closed = false;
  const runtime = new PhysicsWorkerRuntime({
    closeWorker: () => {
      closed = true;
    },
    createSimulation: () => Promise.resolve(simulation),
    postMessage: (message) => {
      messages.push(parseWorkerToMainMessage(message));
    },
    scheduler,
  });
  return {
    get closed() {
      return closed;
    },
    messages,
    runtime,
    scheduler,
    simulation,
  };
}

async function initialize(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.runtime.receive(
    command(0, { type: 'initialize', bodies: createCircularSunEarthScenario().bodies }),
  );
}

describe('PhysicsWorkerRuntime', () => {
  it('第一条合法协议命令不是 initialize 时返回错误并关闭 Worker', async () => {
    const harness = createHarness();

    await harness.runtime.receive(command(0, { type: 'start' }));

    expect(harness.messages).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'invalidState',
        recoverable: false,
        sequence: 0,
      }),
    ]);
    expect(harness.closed).toBe(true);
  });

  it('REBOUND 初始化失败时返回不可恢复错误并关闭 Worker', async () => {
    const messages: WorkerToMainMessage[] = [];
    let closed = false;
    const runtime = new PhysicsWorkerRuntime({
      closeWorker: () => {
        closed = true;
      },
      createSimulation: () => Promise.reject(new Error('WASM load failed')),
      postMessage: (message) => {
        messages.push(message);
      },
    });

    await runtime.receive(
      command(0, { type: 'initialize', bodies: createCircularSunEarthScenario().bodies }),
    );

    expect(messages).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'initializationFailed',
        recoverable: false,
        sequence: 0,
      }),
    ]);
    expect(closed).toBe(true);
  });

  it('严格按 initialize 后 ready 启动并让 step 精确推进', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'step', stepSeconds: 123.5 }));

    expect(harness.messages.map((message) => message.type)).toEqual(['ready', 'state']);
    expect(harness.messages[0]).toMatchObject({ sequence: 0, simulationTimeSeconds: 0 });
    expect(harness.messages[1]).toMatchObject({ sequence: 1, simulationTimeSeconds: 123.5 });
    expect(harness.simulation.timeSeconds).toBe(123.5);
  });

  it('pause 后取消调度且模拟时间不再推进', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'start' }));
    await harness.runtime.receive(command(2, { type: 'pause' }));
    harness.scheduler.advanceAndRun(10_000);

    expect(harness.simulation.timeSeconds).toBe(0);
    expect(harness.scheduler.tasks.size).toBe(0);
    expect(harness.messages.at(-1)).toMatchObject({ type: 'status', runState: 'paused' });
  });

  it('按真实时间和倍率推进目标时间且每个片段重新调度', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'setTimeScale', timeScale: 3_600 }));
    await harness.runtime.receive(command(2, { type: 'start' }));
    harness.scheduler.advanceAndRun(10_000);

    expect(harness.simulation.timeSeconds).toBe(36_000);
    expect(harness.scheduler.tasks.size).toBe(1);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'state',
      simulationTimeSeconds: 36_000,
    });
  });

  it('重复 start 保持运行并复用当前调度任务', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'start' }));
    const scheduledTaskIds = [...harness.scheduler.tasks.keys()];

    await harness.runtime.receive(command(2, { type: 'start' }));

    expect(harness.scheduler.tasks.size).toBe(1);
    expect([...harness.scheduler.tasks.keys()]).toEqual(scheduledTaskIds);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'status',
      runState: 'running',
    });
    expect(harness.messages.some((message) => message.type === 'error')).toBe(false);

    harness.scheduler.advanceAndRun(1_000);
    expect(harness.simulation.timeSeconds).toBe(1);
  });

  it('极大模拟时间下不可表示的正 step 返回 integrationFailed', async () => {
    const harness = createHarness();
    await initialize(harness);
    harness.simulation.timeSeconds = 1e20;

    await harness.runtime.receive(command(1, { type: 'step', stepSeconds: 1 }));

    expect(harness.messages.map((message) => message.type)).toEqual(['ready', 'error']);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'integrationFailed',
      simulationTimeSeconds: 1e20,
    });
    expect(harness.scheduler.tasks.size).toBe(0);
  });

  it('极大模拟时间下不可表示的连续片段返回错误并停止调度', async () => {
    const harness = createHarness();
    await initialize(harness);
    harness.simulation.timeSeconds = 1e20;
    await harness.runtime.receive(command(1, { type: 'start' }));

    harness.scheduler.advanceAndRun(16);

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'integrationFailed',
      simulationTimeSeconds: 1e20,
    });
    expect(harness.messages.some((message) => message.type === 'state')).toBe(false);
    expect(harness.scheduler.tasks.size).toBe(0);
  });

  it('后台长停顿会主动降低倍率且后续片段不补跑隐形积压', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'setTimeScale', timeScale: MAX_TIME_SCALE }));
    await harness.runtime.receive(command(2, { type: 'start' }));

    harness.scheduler.advanceAndRun(1_000);

    expect(harness.simulation.timeSeconds).toBe(86_400);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'status',
      runState: 'running',
      timeScale: 86_400,
    });

    harness.scheduler.advanceAndRun(16);

    expect(harness.simulation.timeSeconds).toBeCloseTo(87_782.4, 8);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'state',
      simulationTimeSeconds: 87_782.4,
    });
  });

  it('pause 按相同上限结算到暂停瞬间，restart 不补跑旧目标', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'setTimeScale', timeScale: MAX_TIME_SCALE }));
    await harness.runtime.receive(command(2, { type: 'start' }));
    harness.scheduler.elapse(1_000);

    await harness.runtime.receive(command(3, { type: 'pause' }));

    expect(harness.simulation.timeSeconds).toBe(86_400);
    expect(harness.scheduler.tasks.size).toBe(0);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'status',
      runState: 'paused',
      timeScale: 86_400,
    });

    await harness.runtime.receive(command(4, { type: 'start' }));
    harness.scheduler.advanceAndRun(16);

    expect(harness.simulation.timeSeconds).toBeCloseTo(87_782.4, 8);
  });

  it('拒绝乱序和非法命令，运行中发生错误会安全暂停', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'start' }));
    await harness.runtime.receive(command(1, { type: 'pause' }));

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'invalidCommand',
      recoverable: true,
    });
    expect(harness.scheduler.tasks.size).toBe(0);

    await harness.runtime.receive({ type: 'step', stepSeconds: Number.NaN });
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'invalidCommand',
    });
  });

  it('积分异常会安全暂停并发送 integrationFailed', async () => {
    const harness = createHarness();
    await initialize(harness);
    harness.simulation.failIntegration = true;
    await harness.runtime.receive(command(1, { type: 'start' }));
    harness.scheduler.advanceAndRun(1_000);

    expect(harness.scheduler.tasks.size).toBe(0);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'integrationFailed',
      recoverable: false,
    });
  });

  it('dispose 释放实例、发送 disposed、关闭 Worker 并忽略后续消息', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'dispose' }));
    const messageCount = harness.messages.length;
    await harness.runtime.receive(command(2, { type: 'start' }));

    expect(harness.simulation.destroyed).toBe(true);
    expect(harness.closed).toBe(true);
    expect(harness.messages.at(-1)).toMatchObject({ type: 'disposed', sequence: 1 });
    expect(harness.messages).toHaveLength(messageCount);
  });
});
