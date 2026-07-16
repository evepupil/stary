import {
  COLLISION_LEDGER_VERSION,
  COLLISION_MODEL_VERSION,
} from '../../../physics/collisions/model-sources';
import type {
  BodyState,
  PhysicsDiagnostics,
  PhysicsState,
  WorkerToMainMessage,
} from '../../../physics/protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../../../physics/protocol/schemas';

type TestBodyOverrides = Partial<Omit<BodyState, 'id'>> & Pick<BodyState, 'id'>;

export function createTestBody(overrides: TestBodyOverrides): BodyState {
  return {
    id: overrides.id,
    massKg: overrides.massKg ?? 1,
    radiusMeters: overrides.radiusMeters ?? 1,
    positionMeters: { x: 0, y: 0, z: 0, ...overrides.positionMeters },
    velocityMetersPerSecond: {
      x: 0,
      y: 0,
      z: 0,
      ...overrides.velocityMetersPerSecond,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 0,
      y: 0,
      z: 0,
      ...overrides.spinAngularMomentumKgMetersSquaredPerSecond,
    },
    momentOfInertiaFactor:
      overrides.momentOfInertiaFactor === undefined ? 0.4 : overrides.momentOfInertiaFactor,
    materialLayers: (overrides.materialLayers ?? [{ material: 'silicate', massFraction: 1 }]).map(
      (layer) => ({ ...layer }),
    ),
    collisionModel: overrides.collisionModel ?? 'gravitySolid',
  };
}

export function createTestDiagnostics(totalEnergyJoules = -1): PhysicsDiagnostics {
  return {
    totalEnergyJoules,
    totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
    totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
  };
}

export function createTestPhysicsState(
  majorBodies: readonly BodyState[],
  options: {
    readonly resolvedEventCount?: number;
    readonly totalEnergyJoules?: number | undefined;
  } = {},
): PhysicsState {
  return {
    majorBodies: majorBodies.map((body) => structuredClone(body)),
    tracers: [],
    dustCohorts: [],
    cumulativeCollisionLedger: {
      resolvedEventCount: options.resolvedEventCount ?? 0,
      accumulatedDissipation: {
        heatJoules: 0,
        deformationJoules: 0,
        fractureJoules: 0,
        radiationJoules: 0,
      },
    },
    omittedInteractionClasses: [],
    cumulativeOmittedBackreaction: {
      linearImpulseKgMetersPerSecond: { x: 0, y: 0, z: 0 },
      angularImpulseKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
      workJoules: 0,
    },
    diagnostics: {
      activeRebound: createTestDiagnostics(options.totalEnergyJoules),
      passiveAssets: {
        totalMassKg: 0,
        totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
        totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
        totalMechanicalEnergyJoules: 0,
      },
    },
  };
}

interface TestStateMessageOptions {
  readonly bodies?: readonly BodyState[];
  readonly bodyRevision?: number;
  readonly replyToSequence?: number | null;
  readonly simulationTimeSeconds?: number;
  readonly totalEnergyJoules?: number;
}

export function createTestStateMessage(
  sequence: number,
  options: TestStateMessageOptions = {},
): Extract<WorkerToMainMessage, { type: 'state' }> {
  const simulationTimeSeconds = options.simulationTimeSeconds ?? sequence;
  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'test-session',
    sequence,
    simulationTimeSeconds,
    replyToSequence: options.replyToSequence ?? null,
    type: 'state',
    bodyRevision: options.bodyRevision ?? 0,
    requestedTargetSimulationTimeSeconds: simulationTimeSeconds,
    state: createTestPhysicsState(options.bodies ?? [createTestBody({ id: 'earth' })], {
      totalEnergyJoules: options.totalEnergyJoules,
    }),
  };
}

interface TestReplacementMessageOptions {
  readonly bodies: readonly BodyState[];
  readonly bodyRevision: number;
  readonly replyToSequence: number;
  readonly sequence: number;
  readonly simulationTimeSeconds: number;
  readonly totalEnergyJoules?: number;
}

export function createTestReplacementMessage(
  options: TestReplacementMessageOptions,
): Extract<WorkerToMainMessage, { type: 'bodiesReplaced' }> {
  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'test-session',
    sequence: options.sequence,
    simulationTimeSeconds: options.simulationTimeSeconds,
    replyToSequence: options.replyToSequence,
    type: 'bodiesReplaced',
    bodyRevision: options.bodyRevision,
    state: createTestPhysicsState(options.bodies, {
      totalEnergyJoules: options.totalEnergyJoules,
    }),
  };
}

interface TestCollisionBatchMessageOptions {
  readonly bodyRevisionAfter?: number;
  readonly bodyRevisionBefore?: number;
  readonly collisionBatchSequence?: number;
  readonly contactTimeSeconds?: number;
  readonly remnant?: BodyState;
  readonly replyToSequence?: number | null;
  readonly requestedTargetSimulationTimeSeconds?: number;
  readonly sequence?: number;
}

export function createTestCollisionBatchMessage(
  options: TestCollisionBatchMessageOptions = {},
): Extract<WorkerToMainMessage, { type: 'collisionBatchResolved' }> {
  const bodyRevisionBefore = options.bodyRevisionBefore ?? 0;
  const contactTimeSeconds = options.contactTimeSeconds ?? 2;
  const remnant =
    options.remnant ??
    createTestBody({
      id: 'collision-remnant',
      massKg: 2,
      radiusMeters: 1,
    });
  const conservationCheck = {
    absoluteError: 0,
    scale: 1,
    normalizedError: 0,
    threshold: 1e-10,
    passed: true,
  } as const;
  const eventTotals = {
    reservoirMasses: { majorKg: 2, tracerKg: 0, dustKg: 0, totalKg: 2 },
    materialMassesKg: { gas: 0, ice: 0, silicate: 2, iron: 0 },
    linearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
    angularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
    energy: {
      translationalJoules: 0,
      spinJoules: 0,
      activeActivePotentialJoules: 0,
      activePassivePotentialJoules: 0,
      selfBindingJoules: -1,
      subgridJoules: 0,
      totalJoules: -1,
    },
  } as const;

  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'test-session',
    sequence: options.sequence ?? 3,
    simulationTimeSeconds: contactTimeSeconds,
    replyToSequence: options.replyToSequence ?? null,
    type: 'collisionBatchResolved',
    collisionBatchSequence: options.collisionBatchSequence ?? 1,
    requestedTargetSimulationTimeSeconds:
      options.requestedTargetSimulationTimeSeconds ?? contactTimeSeconds + 1,
    contactTimeSeconds,
    runState: 'paused',
    bodyRevisionBefore,
    bodyRevisionAfter: options.bodyRevisionAfter ?? bodyRevisionBefore + 1,
    events: [
      {
        eventId: 'collision-event-1',
        modelVersion: COLLISION_MODEL_VERSION,
        participantBodyIds: ['first-parent', 'second-parent'],
        classification: 'merge',
        specificImpactEnergyJoulesPerKg: 0,
        disruptionThresholdJoulesPerKg: 1,
        normalizedImpactEnergy: 0,
        impactAngleRadians: 0,
        modelExtrapolated: false,
        majorRemnantIds: [remnant.id],
        tracerIds: [],
        dustCohortIds: [],
      },
    ],
    ledgerDelta: [
      {
        ledgerVersion: COLLISION_LEDGER_VERSION,
        modelVersion: COLLISION_MODEL_VERSION,
        eventId: 'collision-event-1',
        simulationTimeSeconds: contactTimeSeconds,
        referenceFrame: {
          originMeters: { x: 0, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
        },
        before: eventTotals,
        after: eventTotals,
        dissipation: {
          heatJoules: 0,
          deformationJoules: 0,
          fractureJoules: 0,
          radiationJoules: 0,
        },
        checks: {
          mass: conservationCheck,
          materialMasses: {
            gas: conservationCheck,
            ice: conservationCheck,
            silicate: conservationCheck,
            iron: conservationCheck,
          },
          linearMomentum: conservationCheck,
          angularMomentum: conservationCheck,
          energy: conservationCheck,
        },
        omittedInteractionClasses: [],
        passed: true,
      },
    ],
    state: createTestPhysicsState([remnant], {
      resolvedEventCount: 1,
      totalEnergyJoules: -2,
    }),
  };
}
