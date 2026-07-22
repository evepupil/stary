import { describe, expect, it } from 'vitest';

import { resolveCollisionKernelReference, type CollisionKernelWasm } from '../collisions';
import { contactBodies } from '../collisions/test-helpers';
import { createPhysicsStateFromSnapshot } from '../protocol/physics-state';
import type { BodyState } from '../protocol/schemas';
import { createTestBodyState } from '../../test/fixtures/body-state';
import { CollisionTransactionError, resolveCollisionTransaction } from './collision-transaction';
import type { CreatePhysicsSimulationOptions, PhysicsSimulation } from './physics-simulation';

const diagnostics = {
  totalEnergyJoules: -1,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
} as const;

const referenceKernel: CollisionKernelWasm = {
  abiVersion: 1,
  liveContextCount: () => 0,
  resolveJson: resolveCollisionKernelReference,
};

class CandidateSimulation implements PhysicsSimulation {
  clearPendingContactCount = 0;
  destroyCount = 0;

  public constructor(
    public readonly bodies: readonly BodyState[],
    public readonly timeSeconds: number,
    private readonly corruptFirstFrame = false,
  ) {}

  advanceUntilEvent(targetTimeSeconds: number) {
    return { type: 'advanced' as const, timeSeconds: targetTimeSeconds };
  }

  clearPendingContact(): void {
    this.clearPendingContactCount += 1;
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  integrateTo(targetTimeSeconds: number): void {
    void targetTimeSeconds;
  }

  snapshot() {
    const bodies = this.bodies.map((body, index) =>
      this.corruptFirstFrame && index === 0
        ? { ...body, positionMeters: { ...body.positionMeters, x: body.positionMeters.x + 1 } }
        : body,
    );
    return { bodies, diagnostics };
  }
}

function classicContactBodies(prefix = ''): readonly [BodyState, BodyState] {
  const [first, second] = contactBodies({
    targetMassKg: 1e20,
    projectileMassKg: 5e19,
    targetRadiusMeters: 1e6,
    projectileRadiusMeters: 8e5,
    impactSpeedMetersPerSecond: 10,
  });
  return [
    { ...first, id: `${prefix}target` },
    { ...second, id: `${prefix}projectile` },
  ];
}

function contactState(bodies: readonly BodyState[]) {
  return createPhysicsStateFromSnapshot({ bodies, diagnostics });
}

function transactionHarness(
  bodies: readonly BodyState[],
  options: { readonly corruptFirstFrame?: boolean } = {},
) {
  const simulations: CandidateSimulation[] = [];
  const createOptions: (CreatePhysicsSimulationOptions | undefined)[] = [];
  return {
    createOptions,
    createSimulation: (
      candidateBodies: readonly BodyState[],
      initialTimeSeconds: number,
      candidateOptions?: CreatePhysicsSimulationOptions,
    ) => {
      createOptions.push(candidateOptions);
      const simulation = new CandidateSimulation(
        candidateBodies,
        initialTimeSeconds,
        options.corruptFirstFrame,
      );
      simulations.push(simulation);
      return Promise.resolve(simulation);
    },
    simulations,
    state: contactState(bodies),
  };
}

describe('collision transaction', () => {
  it('recomputes a classic ledger before committing a preserved-frame candidate', async () => {
    const bodies = classicContactBodies();
    const harness = transactionHarness(bodies);

    const result = await resolveCollisionTransaction({
      collisionBatchSequence: 1,
      contactPairs: [{ firstBodyId: bodies[0].id, secondBodyId: bodies[1].id }],
      contactState: harness.state,
      contactTimeSeconds: 42,
      createSimulation: harness.createSimulation,
      kernel: referenceKernel,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.classification).toMatch(/merge/i);
    expect(result.ledgerDelta).toHaveLength(1);
    expect(result.state.cumulativeCollisionLedger.resolvedEventCount).toBe(1);
    expect(result.state.majorBodies).toHaveLength(1);
    expect(harness.createOptions).toEqual([{ preserveReferenceFrame: true }]);
    expect(harness.simulations[0]?.destroyCount).toBe(0);
  });

  it('commits independent simultaneous pairs as one deterministic batch', async () => {
    const firstPair = classicContactBodies('a-');
    const secondPair = classicContactBodies('b-').map((body) => ({
      ...body,
      positionMeters: { ...body.positionMeters, y: body.positionMeters.y + 1e8 },
    })) as unknown as readonly [BodyState, BodyState];
    const bodies = [...firstPair, ...secondPair];
    const harness = transactionHarness(bodies);

    const result = await resolveCollisionTransaction({
      collisionBatchSequence: 2,
      contactPairs: [
        { firstBodyId: secondPair[0].id, secondBodyId: secondPair[1].id },
        { firstBodyId: firstPair[0].id, secondBodyId: firstPair[1].id },
      ],
      contactState: harness.state,
      contactTimeSeconds: 5,
      createSimulation: harness.createSimulation,
      kernel: referenceKernel,
    });

    expect(result.events).toHaveLength(2);
    expect(result.ledgerDelta).toHaveLength(2);
    expect(result.state.cumulativeCollisionLedger.resolvedEventCount).toBe(2);
    expect(result.state.majorBodies).toHaveLength(2);
  });

  it('rejects a shared-body contact component before calling the kernel', async () => {
    const [first, second] = classicContactBodies();
    const third = createTestBodyState({
      id: 'third',
      massKg: 1e19,
      radiusMeters: 1e6,
      positionMeters: { x: 0, y: 2e6, z: 0 },
    });
    const bodies = [first, second, third];
    const harness = transactionHarness(bodies);
    let kernelCalls = 0;
    const kernel: CollisionKernelWasm = {
      ...referenceKernel,
      resolveJson: (request) => {
        kernelCalls += 1;
        return resolveCollisionKernelReference(request);
      },
    };

    await expect(
      resolveCollisionTransaction({
        collisionBatchSequence: 1,
        contactPairs: [
          { firstBodyId: first.id, secondBodyId: second.id },
          { firstBodyId: first.id, secondBodyId: third.id },
        ],
        contactState: harness.state,
        contactTimeSeconds: 0,
        createSimulation: harness.createSimulation,
        kernel,
      }),
    ).rejects.toMatchObject({
      code: 'unsupportedSimultaneousContact',
      contactState: harness.state,
    });
    expect(kernelCalls).toBe(0);
    expect(harness.simulations).toHaveLength(0);
  });

  it('destroys a failed candidate and keeps the contact state available for rollback', async () => {
    const bodies = classicContactBodies();
    const harness = transactionHarness(bodies, { corruptFirstFrame: true });

    await expect(
      resolveCollisionTransaction({
        collisionBatchSequence: 1,
        contactPairs: [{ firstBodyId: bodies[0].id, secondBodyId: bodies[1].id }],
        contactState: harness.state,
        contactTimeSeconds: 1,
        createSimulation: harness.createSimulation,
        kernel: referenceKernel,
      }),
    ).rejects.toBeInstanceOf(CollisionTransactionError);
    expect(harness.simulations[0]?.destroyCount).toBe(1);
  });

  it('accepts the dedicated black-hole ledger and accounts its radiation', async () => {
    const blackHole = createTestBodyState({
      id: 'black-hole',
      massKg: 1e20,
      radiusMeters: 1e6,
      collisionModel: 'blackHole',
      materialLayers: [],
      momentOfInertiaFactor: null,
    });
    const planet = createTestBodyState({
      id: 'planet',
      massKg: 1e10,
      radiusMeters: 1e3,
      positionMeters: { x: blackHole.radiusMeters + 1e3, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -100, y: 0, z: 0 },
    });
    const harness = transactionHarness([blackHole, planet]);

    const result = await resolveCollisionTransaction({
      collisionBatchSequence: 1,
      contactPairs: [{ firstBodyId: blackHole.id, secondBodyId: planet.id }],
      contactState: harness.state,
      contactTimeSeconds: 3,
      createSimulation: harness.createSimulation,
      kernel: referenceKernel,
    });

    expect(result.events[0]).toMatchObject({ classification: 'blackHoleAccretion' });
    expect(result.state.cumulativeCollisionLedger.resolvedEventCount).toBe(1);
    expect(
      result.state.cumulativeCollisionLedger.accumulatedDissipation.radiationJoules,
    ).toBeGreaterThan(0);
  });
});
