import type { BodyState, PhysicsDiagnostics } from '../protocol/schemas';

export interface PhysicsSnapshot {
  readonly bodies: readonly BodyState[];
  readonly diagnostics: PhysicsDiagnostics;
}

export interface PhysicsSimulation {
  readonly timeSeconds: number;
  destroy(): void;
  integrateTo(targetTimeSeconds: number): void;
  snapshot(): PhysicsSnapshot;
}

export type CreatePhysicsSimulation = (
  bodies: readonly BodyState[],
  initialTimeSeconds: number,
) => Promise<PhysicsSimulation>;
