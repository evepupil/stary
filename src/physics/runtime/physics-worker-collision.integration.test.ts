/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  createCollisionKernelWasm,
  type CollisionKernelWasm,
} from '../collisions/collision-kernel-wasm';
import { computeGendaCriticalVelocityRatio } from '../collisions/classification';
import { computeContactQuantities } from '../collisions/contact-quantities';
import { computeDisruptionScaling } from '../collisions/disruption-scaling';
import { MAX_COLLISION_PASSIVE_ASSETS } from '../collisions/model-sources';
import { collisionBody, contactBodies } from '../collisions/test-helpers';
import {
  PHYSICS_PROTOCOL_VERSION,
  type BodyState,
  type MainToWorkerMessage,
  type PhysicsState,
  type WorkerToMainMessage,
} from '../protocol/schemas';
import { createReboundSimulation } from '../rebound/rebound-simulation';
import { createTestBodyState } from '../../test/fixtures/body-state';
import { resolveCollisionTransaction } from './collision-transaction';
import { PhysicsWorkerRuntime } from './physics-worker-runtime';

let collisionKernel: CollisionKernelWasm;
let reboundWasmPath: string;

beforeAll(async () => {
  const collisionWasmPath = path.resolve(
    'crates',
    'stary-collision',
    'dist',
    'stary_collision.wasm',
  );
  const collisionBytes = await readFile(collisionWasmPath);
  const collisionInstance = await WebAssembly.instantiate(collisionBytes, {});
  collisionKernel = createCollisionKernelWasm(collisionInstance.instance.exports);
  reboundWasmPath = path.resolve('spikes', 'rebound-wasm', 'dist', 'rebound.wasm');
});

function command(
  sequence: number,
  payload:
    | { readonly bodies: readonly BodyState[]; readonly type: 'initialize' }
    | { readonly type: 'dispose' }
    | { readonly stepSeconds: number; readonly type: 'step' }
    | {
        readonly expectedBodyRevision: number;
        readonly expectedSimulationTimeSeconds: number;
        readonly snapshotSimulationTimeSeconds: number;
        readonly state: PhysicsState;
        readonly type: 'restoreSnapshot';
      },
): MainToWorkerMessage {
  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'real-collision-session',
    sequence,
    simulationTimeSeconds: 0,
    ...payload,
  } as MainToWorkerMessage;
}

function createRuntime(messages: WorkerToMainMessage[]): PhysicsWorkerRuntime {
  return new PhysicsWorkerRuntime({
    createSimulation: (candidateBodies, initialTimeSeconds, options) =>
      createReboundSimulation(candidateBodies, {
        initialTimeSeconds,
        initialTimestepSeconds: 0.01,
        locateFile: () => reboundWasmPath,
        moveToCenterOfMass: options?.preserveReferenceFrame !== true,
      }),
    loadCollisionKernel: () => Promise.resolve(collisionKernel),
    postMessage: (message) => messages.push(message),
  });
}

async function runCollision(bodies: readonly BodyState[]): Promise<{
  readonly collision: Extract<WorkerToMainMessage, { type: 'collisionBatchResolved' }>;
  readonly messages: WorkerToMainMessage[];
  readonly runtime: PhysicsWorkerRuntime;
}> {
  const messages: WorkerToMainMessage[] = [];
  const runtime = createRuntime(messages);
  await runtime.receive(command(0, { type: 'initialize', bodies }));
  await runtime.receive(command(1, { type: 'step', stepSeconds: 1 }));
  const collision = messages.at(-1);
  if (collision?.type !== 'collisionBatchResolved') {
    throw new Error('真实碰撞链没有返回碰撞批次');
  }
  return { collision, messages, runtime };
}

function totalBodyMassKg(bodies: readonly { readonly massKg: number }[]): number {
  return bodies.reduce((sum, body) => sum + body.massKg, 0);
}

function totalStateMassKg(state: PhysicsState): number {
  return (
    totalBodyMassKg(state.majorBodies) +
    totalBodyMassKg(state.tracers) +
    totalBodyMassKg(state.dustCohorts)
  );
}

const SMALL_BASE = {
  targetMassKg: 4e21,
  projectileMassKg: 2e21,
  targetRadiusMeters: 700_000,
  projectileRadiusMeters: 500_000,
} as const;
const GRAZING_BASE = {
  targetMassKg: 4e24,
  projectileMassKg: 2e24,
  targetRadiusMeters: 7e6,
  projectileRadiusMeters: 5e6,
} as const;
const GRAZING_ANGLE = Math.asin(0.8);

const smallContact = computeContactQuantities(
  ...contactBodies({ ...SMALL_BASE, impactSpeedMetersPerSecond: 1 }),
);
const smallCriticalSpeed = computeDisruptionScaling(
  smallContact,
  'gravitySolid',
).criticalImpactSpeedMetersPerSecond;
const grazingContact = computeContactQuantities(
  ...contactBodies({
    ...GRAZING_BASE,
    impactSpeedMetersPerSecond: 1,
    impactAngleRadians: GRAZING_ANGLE,
  }),
);
const grazingEscapeSpeed = grazingContact.mutualEscapeSpeedMetersPerSecond;
const gendaCriticalRatio = computeGendaCriticalVelocityRatio(
  grazingContact.massRatio,
  grazingContact.impactParameter,
);

interface ClassicScenario {
  readonly classification: string;
  readonly input: Parameters<typeof contactBodies>[0];
  readonly majorBodies: number;
  readonly tracers: number;
  readonly dustCohorts: number;
}

const CLASSIC_SCENARIOS: readonly ClassicScenario[] = [
  {
    classification: 'grazeAndMerge',
    input: {
      ...GRAZING_BASE,
      impactSpeedMetersPerSecond: ((1 + gendaCriticalRatio) / 2) * grazingEscapeSpeed,
      impactAngleRadians: GRAZING_ANGLE,
    },
    majorBodies: 1,
    tracers: 0,
    dustCohorts: 0,
  },
  {
    classification: 'hitAndRun',
    input: {
      ...GRAZING_BASE,
      impactSpeedMetersPerSecond: 1.5 * grazingEscapeSpeed,
      impactAngleRadians: GRAZING_ANGLE,
    },
    majorBodies: 2,
    tracers: 0,
    dustCohorts: 0,
  },
  {
    classification: 'partialAccretion',
    input: { ...SMALL_BASE, impactSpeedMetersPerSecond: Math.sqrt(0.2) * smallCriticalSpeed },
    majorBodies: 1,
    tracers: 1,
    dustCohorts: 0,
  },
  {
    classification: 'erosion',
    input: { ...SMALL_BASE, impactSpeedMetersPerSecond: 0.95 * smallCriticalSpeed },
    majorBodies: 1,
    tracers: 1,
    dustCohorts: 0,
  },
  {
    classification: 'catastrophicDisruption',
    input: { ...SMALL_BASE, impactSpeedMetersPerSecond: 1.1 * smallCriticalSpeed },
    majorBodies: 1,
    tracers: 0,
    dustCohorts: 1,
  },
  {
    classification: 'superCatastrophicDisruption',
    input: { ...SMALL_BASE, impactSpeedMetersPerSecond: 1.5 * smallCriticalSpeed },
    majorBodies: 1,
    tracers: 0,
    dustCohorts: 1,
  },
];

describe('real collision Worker pipeline', () => {
  it('commits a real contact through both WASM modules and keeps integrating', async () => {
    const bodies = contactBodies({
      targetMassKg: 1e20,
      projectileMassKg: 5e19,
      targetRadiusMeters: 1e6,
      projectileRadiusMeters: 8e5,
      impactSpeedMetersPerSecond: 10,
    });
    const { collision, messages, runtime } = await runCollision(bodies);
    expect(collision).toMatchObject({
      replyToSequence: 1,
      requestedTargetSimulationTimeSeconds: 1,
      bodyRevisionBefore: 0,
      bodyRevisionAfter: 1,
      collisionBatchSequence: 1,
      state: { cumulativeCollisionLedger: { resolvedEventCount: 1 } },
    });
    expect(collision.contactTimeSeconds).toBeGreaterThanOrEqual(0);
    expect(collision.contactTimeSeconds).toBeLessThan(1);
    expect(collision.state.majorBodies).toHaveLength(1);
    expect(collisionKernel.liveContextCount()).toBe(0);

    await runtime.receive(command(2, { type: 'step', stepSeconds: 0.5 }));
    expect(messages.at(-1)).toMatchObject({
      type: 'state',
      replyToSequence: 2,
      bodyRevision: 1,
      state: { cumulativeCollisionLedger: { resolvedEventCount: 1 } },
    });
    expect(messages.at(-1)?.simulationTimeSeconds).toBeCloseTo(
      collision.contactTimeSeconds + 0.5,
      12,
    );

    await runtime.receive(command(3, { type: 'dispose' }));
    expect(messages.at(-1)).toMatchObject({ type: 'disposed', replyToSequence: 3 });
  });

  for (const scenario of CLASSIC_SCENARIOS) {
    it(`resolves a real ${scenario.classification} contact and keeps mass closed`, async () => {
      const bodies = contactBodies(scenario.input);
      const initialMassKg = totalBodyMassKg(bodies);
      const { collision, messages, runtime } = await runCollision(bodies);

      expect(collision.events).toHaveLength(1);
      expect(collision.events.at(0)?.classification).toBe(scenario.classification);
      expect(collision.ledgerDelta).toHaveLength(1);
      expect(collision.state.majorBodies).toHaveLength(scenario.majorBodies);
      expect(collision.state.tracers).toHaveLength(scenario.tracers);
      expect(collision.state.dustCohorts).toHaveLength(scenario.dustCohorts);
      const finalMassKg = totalStateMassKg(collision.state);
      expect(Math.abs(finalMassKg - initialMassKg) / initialMassKg).toBeLessThanOrEqual(1e-12);

      await runtime.receive(command(2, { type: 'step', stepSeconds: 0.5 }));
      expect(messages.at(-1)).toMatchObject({ type: 'state', bodyRevision: 1 });
      await runtime.receive(command(3, { type: 'dispose' }));
    });
  }

  it('accretes a planet into a black hole with the dedicated radiation ledger', async () => {
    const blackHole = createTestBodyState({
      id: 'black-hole',
      massKg: 1e24,
      radiusMeters: 1e6,
      collisionModel: 'blackHole',
      materialLayers: [],
      momentOfInertiaFactor: null,
    });
    const planet = createTestBodyState({
      id: 'planet',
      massKg: 1e20,
      radiusMeters: 1e5,
      positionMeters: { x: 1.1e6, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -100, y: 0, z: 0 },
    });

    const { collision, messages, runtime } = await runCollision([blackHole, planet]);

    expect(collision.events.at(0)?.classification).toBe('blackHoleAccretion');
    expect(collision.state.majorBodies).toHaveLength(1);
    const remnant = collision.state.majorBodies.at(0);
    expect(remnant?.collisionModel).toBe('blackHole');
    expect((remnant?.massKg ?? 0) / (blackHole.massKg + planet.massKg)).toBeCloseTo(1, 12);
    expect(
      collision.state.cumulativeCollisionLedger.accumulatedDissipation.radiationJoules,
    ).toBeGreaterThan(0);

    await runtime.receive(command(2, { type: 'step', stepSeconds: 0.5 }));
    expect(messages.at(-1)).toMatchObject({ type: 'state', bodyRevision: 1 });
    await runtime.receive(command(3, { type: 'dispose' }));
  });

  it('commits two independent same-instant contacts as one atomic batch', async () => {
    const pairInput = {
      targetMassKg: 1e20,
      projectileMassKg: 5e19,
      targetRadiusMeters: 1e6,
      projectileRadiusMeters: 8e5,
      impactSpeedMetersPerSecond: 10,
    };
    const pairA: BodyState[] = contactBodies(pairInput).map((body) => ({
      ...body,
      id: `a-${body.id}`,
    }));
    const pairB: BodyState[] = contactBodies(pairInput).map((body) => ({
      ...body,
      id: `b-${body.id}`,
      positionMeters: { ...body.positionMeters, y: body.positionMeters.y + 1e10 },
    }));

    const { collision, messages, runtime } = await runCollision([...pairA, ...pairB]);

    expect(collision.events).toHaveLength(2);
    expect(collision.ledgerDelta).toHaveLength(2);
    expect(collision.bodyRevisionAfter).toBe(1);
    expect(collision.state.majorBodies).toHaveLength(2);
    expect(collision.state.cumulativeCollisionLedger.resolvedEventCount).toBe(2);
    const participantSets = collision.events
      .map((event) => [...event.participantBodyIds].sort().join('+'))
      .sort();
    expect(participantSets).toEqual(['a-projectile+a-target', 'b-projectile+b-target']);

    await runtime.receive(command(2, { type: 'step', stepSeconds: 0.5 }));
    expect(messages.at(-1)).toMatchObject({ type: 'state', bodyRevision: 1 });
    await runtime.receive(command(3, { type: 'dispose' }));
  });

  it('safely pauses on a shared-body simultaneous contact without committing', async () => {
    const left = collisionBody({ id: 'left', massKg: 4e21, radiusMeters: 700_000 });
    const middle = collisionBody({
      id: 'middle',
      massKg: 2e21,
      radiusMeters: 500_000,
      positionMeters: { x: 1_200_000, y: 0, z: 0 },
    });
    const right = collisionBody({
      id: 'right',
      massKg: 4e21,
      radiusMeters: 700_000,
      positionMeters: { x: 2_400_000, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -10, y: 0, z: 0 },
    });
    const bodies: readonly BodyState[] = [
      { ...left, velocityMetersPerSecond: { x: 10, y: 0, z: 0 } },
      middle,
      right,
    ];

    const messages: WorkerToMainMessage[] = [];
    const runtime = createRuntime(messages);
    await runtime.receive(command(0, { type: 'initialize', bodies }));
    await runtime.receive(command(1, { type: 'step', stepSeconds: 1 }));

    expect(messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'unsupportedSimultaneousContact',
      recoverable: true,
    });
    expect(messages.at(-2)).toMatchObject({ type: 'state', bodyRevision: 0 });
    expect(messages.some((message) => message.type === 'collisionBatchResolved')).toBe(false);
    await runtime.receive(command(2, { type: 'dispose' }));
  });

  it('reproduces an identical collision batch when the same scenario runs twice', async () => {
    const run = async () => {
      const { collision, runtime } = await runCollision(
        contactBodies({ ...SMALL_BASE, impactSpeedMetersPerSecond: 1.1 * smallCriticalSpeed }),
      );
      await runtime.receive(command(2, { type: 'dispose' }));
      return collision;
    };

    const first = await run();
    const second = await run();

    expect(second.contactTimeSeconds).toBe(first.contactTimeSeconds);
    expect(second.events).toStrictEqual(first.events);
    expect(second.ledgerDelta).toStrictEqual(first.ledgerDelta);
    expect(second.state).toStrictEqual(first.state);
  });

  it('restores a post-collision snapshot and replays the identical continuation', async () => {
    const bodies = contactBodies({
      ...SMALL_BASE,
      impactSpeedMetersPerSecond: 1.1 * smallCriticalSpeed,
    });
    const { collision, messages, runtime } = await runCollision(bodies);

    await runtime.receive(command(2, { type: 'step', stepSeconds: 0.5 }));
    const firstContinuation = messages.at(-1);
    if (firstContinuation?.type !== 'state') {
      throw new Error('碰撞后的推进没有返回 state');
    }

    await runtime.receive(
      command(3, {
        type: 'restoreSnapshot',
        expectedBodyRevision: collision.bodyRevisionAfter,
        expectedSimulationTimeSeconds: firstContinuation.simulationTimeSeconds,
        snapshotSimulationTimeSeconds: collision.contactTimeSeconds,
        state: collision.state,
      }),
    );
    const restored = messages.at(-1);
    if (restored?.type !== 'snapshotRestored') {
      throw new Error('恢复命令没有返回 snapshotRestored');
    }
    expect(restored.bodyRevision).toBe(collision.bodyRevisionAfter + 1);
    expect(restored.simulationTimeSeconds).toBe(collision.contactTimeSeconds);
    expect(restored.state).toStrictEqual(collision.state);

    await runtime.receive(command(4, { type: 'step', stepSeconds: 0.5 }));
    const replayedContinuation = messages.at(-1);
    if (replayedContinuation?.type !== 'state') {
      throw new Error('恢复后的推进没有返回 state');
    }
    expect(replayedContinuation.simulationTimeSeconds).toBe(
      firstContinuation.simulationTimeSeconds,
    );
    expect(replayedContinuation.state).toStrictEqual(firstContinuation.state);

    await runtime.receive(command(5, { type: 'dispose' }));
  });

  it('rejects a collision when passive-asset capacity is exhausted and keeps the contact state', async () => {
    const bodies = contactBodies({
      ...SMALL_BASE,
      impactSpeedMetersPerSecond: 1.1 * smallCriticalSpeed,
    });
    const zeroVector = { x: 0, y: 0, z: 0 } as const;
    const tracers = Array.from({ length: MAX_COLLISION_PASSIVE_ASSETS }, (_, index) => ({
      id: `capacity-tracer-${String(index)}`,
      massKg: 1,
      positionMeters: { x: 1e13 + index * 1e6, y: 0, z: 0 },
      velocityMetersPerSecond: zeroVector,
      materialLayers: [{ material: 'silicate' as const, massFraction: 1 }],
      subgridMechanicalEnergyJoules: 0,
    }));
    const contactState: PhysicsState = {
      majorBodies: [...bodies],
      tracers,
      dustCohorts: [],
      cumulativeCollisionLedger: {
        resolvedEventCount: 0,
        accumulatedDissipation: {
          heatJoules: 0,
          deformationJoules: 0,
          fractureJoules: 0,
          radiationJoules: 0,
        },
      },
      omittedInteractionClasses: [],
      cumulativeOmittedBackreaction: {
        linearImpulseKgMetersPerSecond: zeroVector,
        angularImpulseKgMetersSquaredPerSecond: zeroVector,
        workJoules: 0,
      },
      diagnostics: {
        activeRebound: {
          totalEnergyJoules: 0,
          totalLinearMomentumKgMetersPerSecond: zeroVector,
          totalAngularMomentumKgMetersSquaredPerSecond: zeroVector,
        },
        passiveAssets: {
          totalMassKg: MAX_COLLISION_PASSIVE_ASSETS,
          totalLinearMomentumKgMetersPerSecond: zeroVector,
          totalAngularMomentumKgMetersSquaredPerSecond: zeroVector,
          totalMechanicalEnergyJoules: 0,
        },
      },
    };
    let candidateRequests = 0;

    await expect(
      resolveCollisionTransaction({
        collisionBatchSequence: 1,
        contactPairs: [{ firstBodyId: 'target', secondBodyId: 'projectile' }],
        contactState,
        contactTimeSeconds: 1,
        createSimulation: () => {
          candidateRequests += 1;
          return Promise.reject(new Error('容量不足时不应创建候选实例'));
        },
        kernel: collisionKernel,
      }),
    ).rejects.toMatchObject({ code: 'collisionCapacityExceeded' });
    expect(candidateRequests).toBe(0);
    expect(collisionKernel.liveContextCount()).toBe(0);
  });
});
