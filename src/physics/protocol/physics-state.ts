import {
  physicsStateSchema,
  type ActiveReboundDiagnostics,
  type BodyState,
  type PhysicsState,
} from './schemas';
import { createEmptyCollisionLedgerSummary } from './collision-ledger-summary';

const ZERO_VECTOR = { x: 0, y: 0, z: 0 } as const;

export function createPhysicsStateFromSnapshot(
  snapshot: {
    readonly bodies: readonly BodyState[];
    readonly diagnostics: ActiveReboundDiagnostics;
  },
  previousState?: PhysicsState,
): PhysicsState {
  return physicsStateSchema.parse({
    majorBodies: snapshot.bodies,
    tracers: previousState?.tracers ?? [],
    dustCohorts: previousState?.dustCohorts ?? [],
    cumulativeCollisionLedger:
      previousState?.cumulativeCollisionLedger ?? createEmptyCollisionLedgerSummary(),
    omittedInteractionClasses: previousState?.omittedInteractionClasses ?? [
      'tracerTracerGravity',
      'tracerDustGravity',
      'dustDustGravity',
      'passiveBackreaction',
    ],
    cumulativeOmittedBackreaction: previousState?.cumulativeOmittedBackreaction ?? {
      linearImpulseKgMetersPerSecond: ZERO_VECTOR,
      angularImpulseKgMetersSquaredPerSecond: ZERO_VECTOR,
      workJoules: 0,
    },
    diagnostics: {
      activeRebound: snapshot.diagnostics,
      passiveAssets: previousState?.diagnostics.passiveAssets ?? {
        totalMassKg: 0,
        totalLinearMomentumKgMetersPerSecond: ZERO_VECTOR,
        totalAngularMomentumKgMetersSquaredPerSecond: ZERO_VECTOR,
        totalMechanicalEnergyJoules: 0,
      },
    },
  });
}
