import { describe, expect, it } from 'vitest';

import { parseWorkerToMainMessage } from '../protocol/parse-message';
import type { BodyState, MainToWorkerMessage, WorkerToMainMessage } from '../protocol/schemas';
import { MAX_TIME_SCALE, PHYSICS_PROTOCOL_VERSION } from '../protocol/schemas';
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
  destroyCount = 0;
  failIntegration = false;
  failSnapshot = false;
  timeSeconds: number;

  constructor(
    readonly bodies: readonly BodyState[],
    initialTimeSeconds = 0,
  ) {
    this.timeSeconds = initialTimeSeconds;
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  integrateTo(targetTimeSeconds: number): void {
    if (this.failIntegration) {
      throw new Error('fake integration failure');
    }
    this.timeSeconds = targetTimeSeconds;
  }

  snapshot() {
    if (this.failSnapshot) {
      throw new Error('fake snapshot failure');
    }
    return { bodies: this.bodies, diagnostics };
  }
}

function command(
  sequence: number,
  payload:
    | { readonly bodies: readonly BodyState[]; readonly type: 'initialize' }
    | { readonly type: 'start' | 'pause' | 'dispose' }
    | { readonly stepSeconds: number; readonly type: 'step' }
    | { readonly timeScale: number; readonly type: 'setTimeScale' }
    | {
        readonly bodies: readonly BodyState[];
        readonly expectedBodyRevision: number;
        readonly expectedSimulationTimeSeconds: number;
        readonly type: 'replaceBodies';
      },
): MainToWorkerMessage {
  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'session-a',
    sequence,
    simulationTimeSeconds: 0,
    ...payload,
  } as MainToWorkerMessage;
}

function replacementBodies(): readonly BodyState[] {
  const scenarioBodies = createCircularSunEarthScenario().bodies;
  const physicalTemplate = scenarioBodies.find((body) => body.id === 'earth');
  if (physicalTemplate === undefined) {
    throw new Error('太阳地球场景缺少地球资料');
  }
  return [
    ...scenarioBodies,
    {
      ...physicalTemplate,
      id: 'planet',
      massKg: 1e20,
      radiusMeters: 1_000,
      positionMeters: { x: 2e11, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 0, y: 25_000, z: 0 },
    },
  ];
}

function createHarness(replacementFailure?: 'create' | 'snapshot' | 'time') {
  const scheduler = new FakeScheduler();
  const simulation = new FakeSimulation(createCircularSunEarthScenario().bodies);
  const simulations: FakeSimulation[] = [simulation];
  let creationCount = 0;
  const messages: WorkerToMainMessage[] = [];
  let closed = false;
  const runtime = new PhysicsWorkerRuntime({
    closeWorker: () => {
      closed = true;
    },
    createSimulation: (bodies, initialTimeSeconds) => {
      creationCount += 1;
      if (creationCount === 1) {
        return Promise.resolve(simulation);
      }
      if (replacementFailure === 'create') {
        return Promise.reject(new Error('fake replacement creation failure'));
      }
      const candidate = new FakeSimulation(bodies, initialTimeSeconds);
      candidate.failSnapshot = replacementFailure === 'snapshot';
      if (replacementFailure === 'time') {
        candidate.timeSeconds += 1;
      }
      simulations.push(candidate);
      return Promise.resolve(candidate);
    },
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
    simulations,
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
    expect(harness.messages[0]).toMatchObject({ replyToSequence: 0 });
    expect(harness.messages[1]).toMatchObject({
      sequence: 1,
      replyToSequence: 1,
      simulationTimeSeconds: 123.5,
      requestedTargetSimulationTimeSeconds: 123.5,
      state: { majorBodies: createCircularSunEarthScenario().bodies },
    });
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
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'status',
      replyToSequence: 2,
      runState: 'paused',
    });
  });

  it('运行中直接替换会安全暂停且不会创建候选实例', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'start' }));

    await harness.runtime.receive(
      command(2, {
        type: 'replaceBodies',
        expectedBodyRevision: 0,
        expectedSimulationTimeSeconds: 0,
        bodies: replacementBodies(),
      }),
    );

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'invalidState',
      replyToSequence: 2,
      recoverable: true,
    });
    expect(harness.scheduler.tasks.size).toBe(0);
    expect(harness.simulations).toHaveLength(1);
    expect(harness.simulation.destroyCount).toBe(0);
  });

  it('刚初始化时直接替换会被拒绝，暂停后才能提交', async () => {
    const harness = createHarness();
    await initialize(harness);

    await harness.runtime.receive(
      command(1, {
        type: 'replaceBodies',
        expectedBodyRevision: 0,
        expectedSimulationTimeSeconds: 0,
        bodies: replacementBodies(),
      }),
    );
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'invalidState',
      recoverable: true,
    });
    expect(harness.simulations).toHaveLength(1);

    await harness.runtime.receive(command(2, { type: 'pause' }));
    await harness.runtime.receive(
      command(3, {
        type: 'replaceBodies',
        expectedBodyRevision: 0,
        expectedSimulationTimeSeconds: 0,
        bodies: replacementBodies(),
      }),
    );
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'bodiesReplaced',
      bodyRevision: 1,
      replyToSequence: 3,
    });
  });

  it('成功替换会保留时间、递增修订并把后续积分切到候选实例', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'step', stepSeconds: 123.5 }));

    await harness.runtime.receive(
      command(2, {
        type: 'replaceBodies',
        expectedBodyRevision: 0,
        expectedSimulationTimeSeconds: 123.5,
        bodies: replacementBodies(),
      }),
    );

    const candidate = harness.simulations[1];
    expect(candidate).toBeDefined();
    expect(candidate?.timeSeconds).toBe(123.5);
    expect(harness.simulation.destroyCount).toBe(1);
    expect(candidate?.destroyCount).toBe(0);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'bodiesReplaced',
      bodyRevision: 1,
      replyToSequence: 2,
      simulationTimeSeconds: 123.5,
      state: { majorBodies: replacementBodies() },
    });

    await harness.runtime.receive(command(3, { type: 'step', stepSeconds: 60 }));
    expect(candidate?.timeSeconds).toBe(183.5);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'state',
      bodyRevision: 1,
      replyToSequence: 3,
      requestedTargetSimulationTimeSeconds: 183.5,
      simulationTimeSeconds: 183.5,
    });

    await harness.runtime.receive(command(4, { type: 'dispose' }));
    expect(candidate?.destroyCount).toBe(1);
  });

  it.each(['create', 'snapshot', 'time'] as const)(
    '候选 %s 失败会销毁候选并保留可继续积分的旧实例',
    async (replacementFailure) => {
      const harness = createHarness(replacementFailure);
      await initialize(harness);
      await harness.runtime.receive(command(1, { type: 'step', stepSeconds: 10 }));

      await harness.runtime.receive(
        command(2, {
          type: 'replaceBodies',
          expectedBodyRevision: 0,
          expectedSimulationTimeSeconds: 10,
          bodies: replacementBodies(),
        }),
      );

      expect(harness.messages.at(-1)).toMatchObject({
        type: 'error',
        code: 'bodyReplacementFailed',
        replyToSequence: 2,
        recoverable: true,
        simulationTimeSeconds: 10,
      });
      expect(harness.simulation.destroyCount).toBe(0);
      if (replacementFailure === 'snapshot' || replacementFailure === 'time') {
        expect(harness.simulations[1]?.destroyCount).toBe(1);
      } else {
        expect(harness.simulations).toHaveLength(1);
      }

      await harness.runtime.receive(command(3, { type: 'step', stepSeconds: 5 }));
      expect(harness.simulation.timeSeconds).toBe(15);
      expect(harness.messages.at(-1)).toMatchObject({
        type: 'state',
        bodyRevision: 0,
        replyToSequence: 3,
        requestedTargetSimulationTimeSeconds: 15,
        simulationTimeSeconds: 15,
      });
    },
  );

  it('修订冲突不创建候选，下一条正确修订命令仍可成功', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'pause' }));

    await harness.runtime.receive(
      command(2, {
        type: 'replaceBodies',
        expectedBodyRevision: 1,
        expectedSimulationTimeSeconds: 0,
        bodies: replacementBodies(),
      }),
    );
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'bodyRevisionConflict',
      replyToSequence: 2,
      recoverable: true,
    });
    expect(harness.simulations).toHaveLength(1);

    await harness.runtime.receive(
      command(3, {
        type: 'replaceBodies',
        expectedBodyRevision: 0,
        expectedSimulationTimeSeconds: 0,
        bodies: replacementBodies(),
      }),
    );
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'bodiesReplaced',
      bodyRevision: 1,
      replyToSequence: 3,
    });
  });

  it('过期模拟时间拒绝旧快照，刷新时间后可以继续替换', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'step', stepSeconds: 10 }));

    await harness.runtime.receive(
      command(2, {
        type: 'replaceBodies',
        expectedBodyRevision: 0,
        expectedSimulationTimeSeconds: 0,
        bodies: replacementBodies(),
      }),
    );
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'bodySnapshotConflict',
      replyToSequence: 2,
      recoverable: true,
      simulationTimeSeconds: 10,
    });
    expect(harness.simulations).toHaveLength(1);
    expect(harness.simulation.destroyCount).toBe(0);

    await harness.runtime.receive(
      command(3, {
        type: 'replaceBodies',
        expectedBodyRevision: 0,
        expectedSimulationTimeSeconds: 10,
        bodies: replacementBodies(),
      }),
    );
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'bodiesReplaced',
      bodyRevision: 1,
      replyToSequence: 3,
      simulationTimeSeconds: 10,
    });
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
      replyToSequence: null,
      requestedTargetSimulationTimeSeconds: 36_000,
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
      replyToSequence: 2,
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
      replyToSequence: null,
      runState: 'running',
      timeScale: 86_400,
    });

    harness.scheduler.advanceAndRun(16);

    expect(harness.simulation.timeSeconds).toBeCloseTo(87_782.4, 8);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'state',
      replyToSequence: null,
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
      replyToSequence: 3,
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
      replyToSequence: 1,
      recoverable: true,
    });
    expect(harness.scheduler.tasks.size).toBe(0);

    await harness.runtime.receive({ type: 'step', stepSeconds: Number.NaN });
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'invalidCommand',
      replyToSequence: null,
    });

    await harness.runtime.reportMessageError();
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'invalidCommand',
      replyToSequence: null,
    });
  });

  it('命令触发的积分错误带请求序号', async () => {
    const harness = createHarness();
    await initialize(harness);
    harness.simulation.failIntegration = true;

    await harness.runtime.receive(command(1, { type: 'step', stepSeconds: 1 }));

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'integrationFailed',
      recoverable: false,
      replyToSequence: 1,
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
      replyToSequence: null,
    });
  });

  it('dispose 释放实例、发送 disposed、关闭 Worker 并忽略后续消息', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'dispose' }));
    const messageCount = harness.messages.length;
    await harness.runtime.receive(command(2, { type: 'start' }));

    expect(harness.simulation.destroyCount).toBe(1);
    expect(harness.closed).toBe(true);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'disposed',
      sequence: 1,
      replyToSequence: 1,
    });
    expect(harness.messages).toHaveLength(messageCount);
  });
});
