import type {
  BodyState,
  PhysicsDiagnostics,
  WorkerToMainMessage,
} from '../../../physics/protocol/schemas';

export type SimulationPhase = 'initializing' | 'ready' | 'error';
export type SimulationRunState = Extract<WorkerToMainMessage, { type: 'status' }>['runState'];

export interface UniverseSimulationState {
  readonly phase: SimulationPhase;
  readonly runState: SimulationRunState;
  readonly bodies: readonly BodyState[];
  readonly diagnostics: PhysicsDiagnostics | null;
  readonly baselineDiagnostics: PhysicsDiagnostics | null;
  readonly simulationTimeSeconds: number;
  readonly timeScale: number;
  readonly error: Error | null;
  readonly commandPending: boolean;
}

export function createInitialSimulationState(
  bodies: readonly BodyState[],
  timeScale: number,
): UniverseSimulationState {
  return {
    phase: 'initializing',
    runState: 'idle',
    bodies,
    diagnostics: null,
    baselineDiagnostics: null,
    simulationTimeSeconds: 0,
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
        simulationTimeSeconds: message.simulationTimeSeconds,
        error: null,
      };
    case 'state':
      return {
        ...state,
        phase: 'ready',
        runState: state.runState === 'running' ? 'running' : 'paused',
        bodies: message.bodies,
        diagnostics: message.diagnostics,
        baselineDiagnostics: state.baselineDiagnostics ?? message.diagnostics,
        simulationTimeSeconds: message.simulationTimeSeconds,
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
