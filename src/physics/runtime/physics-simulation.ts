import type { BodyState, PhysicsDiagnostics } from '../protocol/schemas';

export interface PhysicsSnapshot {
  readonly bodies: readonly BodyState[];
  readonly diagnostics: PhysicsDiagnostics;
}

export interface PhysicsContactPair {
  readonly firstBodyId: string;
  readonly secondBodyId: string;
}

export type PhysicsAdvanceResult =
  | {
      readonly type: 'advanced';
      readonly timeSeconds: number;
    }
  | {
      readonly type: 'contact';
      readonly timeSeconds: number;
      readonly pairs: readonly PhysicsContactPair[];
      readonly snapshot: PhysicsSnapshot;
    };

export interface PhysicsSimulation {
  readonly timeSeconds: number;
  advanceUntilEvent(targetTimeSeconds: number): PhysicsAdvanceResult;
  clearPendingContact(): void;
  destroy(): void;
  integrateTo(targetTimeSeconds: number): void;
  snapshot(): PhysicsSnapshot;
}

export interface CreatePhysicsSimulationOptions {
  readonly preserveReferenceFrame?: boolean;
}

export type CreatePhysicsSimulation = (
  bodies: readonly BodyState[],
  initialTimeSeconds: number,
  options?: CreatePhysicsSimulationOptions,
) => Promise<PhysicsSimulation>;
