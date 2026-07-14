/// <reference types="node" />

import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { BodyState, MainToWorkerMessage, WorkerToMainMessage } from '../protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../protocol/schemas';
import type { PhysicsScheduler, ScheduledPhysicsTask } from '../runtime/physics-scheduler';
import { PhysicsWorkerRuntime } from '../runtime/physics-worker-runtime';
import {
  ASTRONOMICAL_UNIT_METERS,
  createCircularSunEarthScenario,
  createEllipticalSunEarthScenario,
} from '../scenarios/sun-earth';
import { createReboundSimulation, type ReboundSimulation } from './rebound-simulation';

const ORBIT_RELATIVE_TOLERANCE = 1e-9;
const RADIUS_RELATIVE_TOLERANCE = 1e-10;
const LONG_TERM_RELATIVE_TOLERANCE = 1e-9;

let reboundWasmPath: string;

beforeAll(() => {
  reboundWasmPath = path.resolve('spikes', 'rebound-wasm', 'dist', 'rebound.wasm');
});

function bodyById(bodies: readonly BodyState[], id: string): BodyState {
  const body = bodies.find((candidate) => candidate.id === id);
  if (body === undefined) {
    throw new Error(`缺少天体 ${id}`);
  }
  return body;
}

function relativePosition(bodies: readonly BodyState[]) {
  const sun = bodyById(bodies, 'sun').positionMeters;
  const earth = bodyById(bodies, 'earth').positionMeters;
  return { x: earth.x - sun.x, y: earth.y - sun.y, z: earth.z - sun.z };
}

function relativeVelocity(bodies: readonly BodyState[]) {
  const sun = bodyById(bodies, 'sun').velocityMetersPerSecond;
  const earth = bodyById(bodies, 'earth').velocityMetersPerSecond;
  return { x: earth.x - sun.x, y: earth.y - sun.y, z: earth.z - sun.z };
}

function magnitude(vector: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function vectorDifferenceMagnitude(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function relativeError(initial: number, final: number): number {
  return Math.abs((final - initial) / initial);
}

async function loadSimulation(
  bodies: readonly BodyState[],
  initialTimeSeconds = 0,
): Promise<ReboundSimulation> {
  return createReboundSimulation(bodies, {
    initialTimeSeconds,
    locateFile: () => reboundWasmPath,
  });
}

class IntegrationScheduler implements PhysicsScheduler {
  now = 0;
  nextTask: (() => void) | undefined;

  cancel(): void {
    this.nextTask = undefined;
  }

  nowMilliseconds(): number {
    return this.now;
  }

  schedule(task: () => void): ScheduledPhysicsTask {
    this.nextTask = task;
    return 1 as unknown as ScheduledPhysicsTask;
  }

  advanceAndRun(milliseconds: number): void {
    this.now += milliseconds;
    const task = this.nextTask;
    this.nextTask = undefined;
    task?.();
  }
}

async function runWithTimeScale(timeScale: number, realMilliseconds: number) {
  const scenario = createCircularSunEarthScenario();
  const scheduler = new IntegrationScheduler();
  const messages: WorkerToMainMessage[] = [];
  const runtime = new PhysicsWorkerRuntime({
    createSimulation: (bodies, initialTimeSeconds) => loadSimulation(bodies, initialTimeSeconds),
    postMessage: (message) => {
      messages.push(message);
    },
    scheduler,
  });
  const message = (
    sequence: number,
    payload:
      | { readonly bodies: readonly BodyState[]; readonly type: 'initialize' }
      | { readonly type: 'start' | 'dispose' }
      | { readonly timeScale: number; readonly type: 'setTimeScale' },
  ): MainToWorkerMessage =>
    ({
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId: 'time-scale-session',
      sequence,
      simulationTimeSeconds: 0,
      ...payload,
    }) as MainToWorkerMessage;

  await runtime.receive(message(0, { type: 'initialize', bodies: scenario.bodies }));
  await runtime.receive(message(1, { type: 'setTimeScale', timeScale }));
  await runtime.receive(message(2, { type: 'start' }));
  scheduler.advanceAndRun(realMilliseconds);
  const state = messages.findLast(
    (candidate): candidate is Extract<WorkerToMainMessage, { type: 'state' }> =>
      candidate.type === 'state',
  );
  await runtime.receive(message(3, { type: 'dispose' }));
  if (state === undefined) {
    throw new Error('倍率运行没有返回 state');
  }
  return state;
}

describe('正式 REBOUND simulation', () => {
  it('非零时间原点保留当前状态且只积分新增时长', async () => {
    const scenario = createCircularSunEarthScenario();
    const baseline = await loadSimulation(scenario.bodies);
    const timeOriginSeconds = 1_000_000;
    const offset = await loadSimulation(scenario.bodies, timeOriginSeconds);

    try {
      expect(offset.timeSeconds).toBe(timeOriginSeconds);
      expect(
        vectorDifferenceMagnitude(
          relativePosition(offset.snapshot().bodies),
          relativePosition(baseline.snapshot().bodies),
        ),
      ).toBe(0);

      baseline.integrateTo(60);
      offset.integrateTo(timeOriginSeconds + 60);
      expect(offset.timeSeconds).toBe(timeOriginSeconds + 60);
      expect(
        vectorDifferenceMagnitude(
          relativePosition(offset.snapshot().bodies),
          relativePosition(baseline.snapshot().bodies),
        ),
      ).toBe(0);
      expect(
        vectorDifferenceMagnitude(
          relativeVelocity(offset.snapshot().bodies),
          relativeVelocity(baseline.snapshot().bodies),
        ),
      ).toBe(0);
    } finally {
      baseline.destroy();
      offset.destroy();
    }
  });

  it('IAS15 让质心系太阳地球圆轨道一周期回到初始状态', async () => {
    const scenario = createCircularSunEarthScenario();
    const simulation = await loadSimulation(scenario.bodies);

    try {
      const initial = simulation.snapshot();
      const initialPosition = relativePosition(initial.bodies);
      const initialVelocity = relativeVelocity(initial.bodies);
      simulation.integrateTo(scenario.periodSeconds);
      const final = simulation.snapshot();
      const finalPosition = relativePosition(final.bodies);
      const finalVelocity = relativeVelocity(final.bodies);

      expect(
        vectorDifferenceMagnitude(initialPosition, finalPosition) / magnitude(initialPosition),
      ).toBeLessThanOrEqual(ORBIT_RELATIVE_TOLERANCE);
      expect(
        vectorDifferenceMagnitude(initialVelocity, finalVelocity) / magnitude(initialVelocity),
      ).toBeLessThanOrEqual(ORBIT_RELATIVE_TOLERANCE);
      expect(
        relativeError(magnitude(initialPosition), magnitude(finalPosition)),
      ).toBeLessThanOrEqual(RADIUS_RELATIVE_TOLERANCE);
      expect(simulation.timeSeconds).toBeCloseTo(scenario.periodSeconds, 6);
    } finally {
      simulation.destroy();
    }
  });

  it('椭圆轨道在半周期到远日点并在整周期回到近日点', async () => {
    const scenario = createEllipticalSunEarthScenario();
    const simulation = await loadSimulation(scenario.bodies);
    const expectedPeriapsis = ASTRONOMICAL_UNIT_METERS * (1 - scenario.eccentricity);
    const expectedApoapsis = ASTRONOMICAL_UNIT_METERS * (1 + scenario.eccentricity);

    try {
      simulation.integrateTo(scenario.periodSeconds / 2);
      const apoapsis = magnitude(relativePosition(simulation.snapshot().bodies));
      expect(relativeError(expectedApoapsis, apoapsis)).toBeLessThanOrEqual(
        ORBIT_RELATIVE_TOLERANCE,
      );

      simulation.integrateTo(scenario.periodSeconds);
      const periapsis = magnitude(relativePosition(simulation.snapshot().bodies));
      expect(relativeError(expectedPeriapsis, periapsis)).toBeLessThanOrEqual(
        ORBIT_RELATIVE_TOLERANCE,
      );
      expect(simulation.timeSeconds).toBeCloseTo(scenario.periodSeconds, 6);
    } finally {
      simulation.destroy();
    }
  });

  it('1000 周期后总能量和角动量保持在固定容差内', async () => {
    const scenario = createCircularSunEarthScenario();
    const simulation = await loadSimulation(scenario.bodies);

    try {
      const initial = simulation.snapshot().diagnostics;
      for (let completedPeriods = 1; completedPeriods <= 1_000; completedPeriods += 1) {
        simulation.integrateTo(scenario.periodSeconds * completedPeriods);
      }
      const final = simulation.snapshot().diagnostics;
      const initialAngularMomentum = magnitude(
        initial.totalAngularMomentumKgMetersSquaredPerSecond,
      );
      const finalAngularMomentum = magnitude(final.totalAngularMomentumKgMetersSquaredPerSecond);

      expect(relativeError(initial.totalEnergyJoules, final.totalEnergyJoules)).toBeLessThanOrEqual(
        LONG_TERM_RELATIVE_TOLERANCE,
      );
      expect(relativeError(initialAngularMomentum, finalAngularMomentum)).toBeLessThanOrEqual(
        LONG_TERM_RELATIVE_TOLERANCE,
      );
    } finally {
      simulation.destroy();
    }
  });

  it('不同 timeScale 到达同一模拟时刻时产生一致的真实 WASM 状态', async () => {
    const one = await runWithTimeScale(3_600, 10_000);
    const two = await runWithTimeScale(7_200, 5_000);

    expect(one.simulationTimeSeconds).toBe(36_000);
    expect(two.simulationTimeSeconds).toBe(36_000);
    for (const id of ['sun', 'earth']) {
      const bodyOne = bodyById(one.bodies, id);
      const bodyTwo = bodyById(two.bodies, id);
      expect(vectorDifferenceMagnitude(bodyOne.positionMeters, bodyTwo.positionMeters)).toBe(0);
      expect(
        vectorDifferenceMagnitude(bodyOne.velocityMetersPerSecond, bodyTwo.velocityMetersPerSecond),
      ).toBe(0);
    }
  });

  it('运行时原子加入第三颗天体后保持时间连续并继续真实积分', async () => {
    const scenario = createCircularSunEarthScenario();
    const messages: WorkerToMainMessage[] = [];
    const runtime = new PhysicsWorkerRuntime({
      createSimulation: (bodies, initialTimeSeconds) => loadSimulation(bodies, initialTimeSeconds),
      postMessage: (message) => {
        messages.push(message);
      },
    });
    const send = (message: MainToWorkerMessage) => runtime.receive(message);
    const envelope = (sequence: number) => ({
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId: 'replacement-session',
      sequence,
      simulationTimeSeconds: 0,
    });

    await send({
      ...envelope(0),
      type: 'initialize',
      sequence: 0,
      simulationTimeSeconds: 0,
      bodies: [...scenario.bodies],
    });
    await send({ ...envelope(1), type: 'step', stepSeconds: 60 });
    const beforeReplacement = messages.at(-1);
    if (beforeReplacement?.type !== 'state') {
      throw new Error('替换前缺少真实 state');
    }
    const submittedBodies: BodyState[] = [
      ...beforeReplacement.bodies,
      {
        id: 'test-planet',
        massKg: 1e20,
        radiusMeters: 1_000,
        positionMeters: { x: ASTRONOMICAL_UNIT_METERS * 2, y: 0, z: 0 },
        velocityMetersPerSecond: { x: 0, y: 20_000, z: 0 },
      },
    ];

    await send({
      ...envelope(2),
      type: 'replaceBodies',
      expectedBodyRevision: 0,
      expectedSimulationTimeSeconds: 60,
      bodies: submittedBodies,
    });
    const replaced = messages.at(-1);
    expect(replaced).toMatchObject({
      type: 'bodiesReplaced',
      bodyRevision: 1,
      simulationTimeSeconds: 60,
    });
    if (replaced?.type !== 'bodiesReplaced') {
      throw new Error('缺少 bodiesReplaced 确认');
    }
    expect(replaced.bodies).toHaveLength(3);
    const initialPlanet = bodyById(replaced.bodies, 'test-planet');

    await send({ ...envelope(3), type: 'step', stepSeconds: 60 });
    const afterStep = messages.at(-1);
    expect(afterStep).toMatchObject({
      type: 'state',
      bodyRevision: 1,
      simulationTimeSeconds: 120,
    });
    if (afterStep?.type !== 'state') {
      throw new Error('替换后缺少 state');
    }
    expect(afterStep.bodies).toHaveLength(3);
    expect(
      vectorDifferenceMagnitude(
        bodyById(afterStep.bodies, 'test-planet').positionMeters,
        initialPlanet.positionMeters,
      ),
    ).toBeGreaterThan(0);
    expect(Number.isFinite(afterStep.diagnostics.totalEnergyJoules)).toBe(true);
    expect(
      Object.values(afterStep.diagnostics.totalLinearMomentumKgMetersPerSecond).every(
        Number.isFinite,
      ),
    ).toBe(true);
    expect(
      Object.values(afterStep.diagnostics.totalAngularMomentumKgMetersSquaredPerSecond).every(
        Number.isFinite,
      ),
    ).toBe(true);

    await send({ ...envelope(4), type: 'dispose' });
  });
});
