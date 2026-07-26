import type {
  BodyState,
  CollisionEvent,
  PhysicsDiagnostics,
  PhysicsState,
  WorkerToMainMessage,
} from '../../../physics/protocol/schemas';

export type SimulationPhase = 'initializing' | 'ready' | 'error';
export type SimulationRunState = Extract<WorkerToMainMessage, { type: 'status' }>['runState'];

type CollisionBatchResolvedMessage = Extract<
  WorkerToMainMessage,
  { type: 'collisionBatchResolved' }
>;
export type CollisionLedgerDelta = CollisionBatchResolvedMessage['ledgerDelta'][number];

export interface CollisionBatchRecord {
  readonly collisionBatchSequence: number;
  readonly contactTimeSeconds: number;
  readonly requestedTargetSimulationTimeSeconds: number;
  readonly bodyRevisionAfter: number;
  readonly events: readonly CollisionEvent[];
  readonly ledgerDelta: readonly CollisionLedgerDelta[];
  readonly participants: readonly BodyState[];
}

export interface UniverseSimulationState {
  readonly phase: SimulationPhase;
  readonly runState: SimulationRunState;
  readonly bodies: readonly BodyState[];
  readonly physicsState: PhysicsState | null;
  readonly diagnostics: PhysicsDiagnostics | null;
  readonly baselineDiagnostics: PhysicsDiagnostics | null;
  readonly latestCollisionBatch: CollisionBatchRecord | null;
  readonly bodyRevision: number;
  readonly bodySnapshotSimulationTimeSeconds: number;
  readonly simulationTimeSeconds: number;
  readonly latestAppliedSequence: number;
  readonly latestStateSequence: number;
  readonly timeScale: number;
  readonly error: Error | null;
  readonly commandPending: boolean;
}

function captureCollisionParticipants(
  previousState: UniverseSimulationState,
  events: readonly CollisionEvent[],
): readonly BodyState[] {
  const participantIds = new Set(events.flatMap((event) => event.participantBodyIds));
  const previousBodies = previousState.physicsState?.majorBodies ?? previousState.bodies;
  return previousBodies.filter((body) => participantIds.has(body.id));
}

export function createInitialSimulationState(
  bodies: readonly BodyState[],
  timeScale: number,
): UniverseSimulationState {
  return {
    phase: 'initializing',
    runState: 'idle',
    bodies,
    physicsState: null,
    diagnostics: null,
    baselineDiagnostics: null,
    latestCollisionBatch: null,
    bodyRevision: 0,
    bodySnapshotSimulationTimeSeconds: 0,
    simulationTimeSeconds: 0,
    latestAppliedSequence: 0,
    latestStateSequence: 0,
    timeScale,
    error: null,
    commandPending: true,
  };
}

export function applyControllerFatalError(
  state: UniverseSimulationState,
  error: Error,
): UniverseSimulationState {
  return {
    ...state,
    phase: 'error',
    runState: 'paused',
    error,
    commandPending: false,
  };
}

export function applyWorkerMessage(
  state: UniverseSimulationState,
  message: WorkerToMainMessage,
): UniverseSimulationState {
  switch (message.type) {
    case 'ready':
      return {
        ...state,
        phase: 'ready',
        runState: 'initialized',
        latestCollisionBatch: null,
        bodyRevision: message.bodyRevision,
        simulationTimeSeconds: message.simulationTimeSeconds,
        error: null,
      };
    case 'state':
      if (
        message.bodyRevision < state.bodyRevision ||
        message.sequence <= state.latestAppliedSequence
      ) {
        return state;
      }
      return {
        ...state,
        phase: 'ready',
        runState: state.runState === 'running' ? 'running' : 'paused',
        bodies: message.state.majorBodies,
        physicsState: message.state,
        diagnostics: message.state.diagnostics.activeRebound,
        baselineDiagnostics:
          message.bodyRevision === state.bodyRevision
            ? (state.baselineDiagnostics ?? message.state.diagnostics.activeRebound)
            : message.state.diagnostics.activeRebound,
        bodyRevision: message.bodyRevision,
        bodySnapshotSimulationTimeSeconds: message.simulationTimeSeconds,
        simulationTimeSeconds: message.simulationTimeSeconds,
        latestAppliedSequence: message.sequence,
        latestStateSequence: message.sequence,
      };
    case 'bodiesReplaced':
      if (
        message.bodyRevision <= state.bodyRevision ||
        message.sequence <= state.latestAppliedSequence
      ) {
        return state;
      }
      return {
        ...state,
        phase: 'ready',
        runState: 'paused',
        bodies: message.state.majorBodies,
        physicsState: message.state,
        diagnostics: message.state.diagnostics.activeRebound,
        baselineDiagnostics: message.state.diagnostics.activeRebound,
        latestCollisionBatch: null,
        bodyRevision: message.bodyRevision,
        bodySnapshotSimulationTimeSeconds: message.simulationTimeSeconds,
        simulationTimeSeconds: message.simulationTimeSeconds,
        latestAppliedSequence: message.sequence,
        error: null,
      };
    case 'collisionBatchResolved':
      if (
        message.bodyRevisionAfter <= state.bodyRevision ||
        message.sequence <= state.latestAppliedSequence
      ) {
        return state;
      }
      return {
        ...state,
        phase: 'ready',
        runState: 'paused',
        bodies: message.state.majorBodies,
        physicsState: message.state,
        diagnostics: message.state.diagnostics.activeRebound,
        baselineDiagnostics: message.state.diagnostics.activeRebound,
        latestCollisionBatch: {
          collisionBatchSequence: message.collisionBatchSequence,
          contactTimeSeconds: message.contactTimeSeconds,
          requestedTargetSimulationTimeSeconds: message.requestedTargetSimulationTimeSeconds,
          bodyRevisionAfter: message.bodyRevisionAfter,
          events: message.events,
          ledgerDelta: message.ledgerDelta,
          participants: captureCollisionParticipants(state, message.events),
        },
        bodyRevision: message.bodyRevisionAfter,
        bodySnapshotSimulationTimeSeconds: message.simulationTimeSeconds,
        simulationTimeSeconds: message.simulationTimeSeconds,
        latestAppliedSequence: message.sequence,
        latestStateSequence: message.sequence,
        error: null,
      };
    case 'status':
      return {
        ...state,
        phase: 'ready',
        runState: message.runState,
        simulationTimeSeconds: message.simulationTimeSeconds,
        timeScale: message.timeScale,
      };
    case 'error':
      return {
        ...state,
        phase: message.recoverable ? state.phase : 'error',
        runState: 'paused',
        simulationTimeSeconds: message.simulationTimeSeconds,
        error: new Error(`${message.code}: ${message.message}`),
      };
    case 'disposed':
      return state;
  }
}
