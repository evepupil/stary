import { useCallback, useEffect, useRef, useState } from 'react';

import { PhysicsWorkerController } from '../../../physics/controller/physics-worker-controller';
import type {
  BodyState,
  PhysicsDiagnostics,
  WorkerToMainMessage,
} from '../../../physics/protocol/schemas';
import { createCircularSunEarthScenario } from '../../../physics/scenarios/sun-earth';
import {
  applyControllerFatalError,
  applyWorkerMessage,
  createInitialSimulationState,
  type SimulationPhase,
  type SimulationRunState,
  type UniverseSimulationState,
} from './simulation-state';

export const DEFAULT_OBSERVATORY_TIME_SCALE = 86_400;
export const DEFAULT_OBSERVATORY_STEP_SECONDS = 3_600;

const INITIAL_SCENARIO = createCircularSunEarthScenario();
const RESOLVED_COMMAND = Promise.resolve();

type ControllerCommand = (controller: PhysicsWorkerController) => Promise<unknown>;

export interface UniverseSimulation {
  readonly phase: SimulationPhase;
  readonly runState: SimulationRunState;
  readonly bodies: readonly BodyState[];
  readonly diagnostics: PhysicsDiagnostics | null;
  readonly baselineDiagnostics: PhysicsDiagnostics | null;
  readonly simulationTimeSeconds: number;
  readonly timeScale: number;
  readonly error: Error | null;
  readonly commandPending: boolean;
  readonly start: () => void;
  readonly pause: () => void;
  readonly toggle: () => void;
  readonly step: (stepSeconds?: number) => void;
  readonly setTimeScale: (timeScale: number) => void;
  readonly retry: () => void;
}

function describeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('宇宙模拟器发生未知错误');
}

export function useUniverseSimulation(): UniverseSimulation {
  const [restartKey, setRestartKey] = useState(0);
  const [simulation, setSimulation] = useState<UniverseSimulationState>(() =>
    createInitialSimulationState(INITIAL_SCENARIO.bodies, DEFAULT_OBSERVATORY_TIME_SCALE),
  );
  const controllerRef = useRef<PhysicsWorkerController | null>(null);
  const commandQueueRef = useRef<Promise<void>>(RESOLVED_COMMAND);
  const generationRef = useRef(0);
  const pendingCommandCountRef = useRef(1);
  const runStateRef = useRef<SimulationRunState>('idle');

  const finishPendingCommand = useCallback((generation: number) => {
    if (generationRef.current !== generation) {
      return;
    }
    pendingCommandCountRef.current = Math.max(0, pendingCommandCountRef.current - 1);
    if (pendingCommandCountRef.current === 0) {
      setSimulation((current) =>
        current.commandPending ? { ...current, commandPending: false } : current,
      );
    }
  }, []);

  const reportError = useCallback((error: unknown, generation: number, fatal: boolean) => {
    if (generationRef.current !== generation) {
      return;
    }
    const describedError = describeError(error);
    setSimulation((current) => ({
      ...current,
      phase: fatal ? 'error' : current.phase,
      error: describedError,
    }));
  }, []);

  const enqueueCommand = useCallback(
    (command: ControllerCommand) => {
      const controller = controllerRef.current;
      const generation = generationRef.current;
      if (controller === null) {
        reportError(new Error('物理 Worker 尚未就绪'), generation, false);
        return;
      }

      pendingCommandCountRef.current += 1;
      setSimulation((current) => ({ ...current, commandPending: true, error: null }));

      const commandResult = commandQueueRef.current.then(async () => {
        if (generationRef.current !== generation || controllerRef.current !== controller) {
          return;
        }
        await command(controller);
      });
      commandQueueRef.current = commandResult
        .then(
          () => {
            if (generationRef.current === generation && controllerRef.current === controller) {
              setSimulation((current) =>
                current.error === null ? current : { ...current, error: null },
              );
            }
          },
          (error: unknown) => {
            reportError(error, generation, false);
          },
        )
        .finally(() => {
          finishPendingCommand(generation);
        });
    },
    [finishPendingCommand, reportError],
  );

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    pendingCommandCountRef.current = 1;
    runStateRef.current = 'idle';

    const controller = new PhysicsWorkerController();
    controllerRef.current = controller;
    let active = true;
    let animationFrame: number | null = null;
    let latestStateMessage: Extract<WorkerToMainMessage, { type: 'state' }> | null = null;

    const flushLatestState = () => {
      animationFrame = null;
      if (!active || generationRef.current !== generation || latestStateMessage === null) {
        return;
      }
      const message = latestStateMessage;
      latestStateMessage = null;
      setSimulation((current) => applyWorkerMessage(current, message));
    };

    const unsubscribe = controller.subscribe((message) => {
      if (!active || generationRef.current !== generation) {
        return;
      }
      if (message.type === 'state') {
        latestStateMessage = message;
        if (runStateRef.current !== 'running') {
          runStateRef.current = 'paused';
        }
        animationFrame ??= requestAnimationFrame(flushLatestState);
        return;
      }
      if (message.type === 'ready') {
        runStateRef.current = 'initialized';
      } else if (message.type === 'status') {
        runStateRef.current = message.runState;
      } else if (message.type === 'error') {
        runStateRef.current = 'paused';
      }
      setSimulation((current) => applyWorkerMessage(current, message));
    });
    const unsubscribeFatal = controller.subscribeFatal((error) => {
      if (!active || generationRef.current !== generation || controllerRef.current !== controller) {
        return;
      }
      controllerRef.current = null;
      pendingCommandCountRef.current = 0;
      runStateRef.current = 'paused';
      setSimulation((current) => applyControllerFatalError(current, error));
    });

    const startup = controller
      .initialize(INITIAL_SCENARIO.bodies)
      .then(() => controller.setTimeScale(DEFAULT_OBSERVATORY_TIME_SCALE))
      .then(() => controller.start());
    commandQueueRef.current = startup
      .then(
        () => {
          if (active && generationRef.current === generation) {
            setSimulation((current) =>
              current.error === null ? current : { ...current, error: null },
            );
          }
        },
        (error: unknown) => {
          if (active) {
            reportError(error, generation, true);
          }
        },
      )
      .finally(() => {
        if (active) {
          finishPendingCommand(generation);
        }
      });

    return () => {
      active = false;
      if (generationRef.current === generation) {
        generationRef.current += 1;
      }
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
      latestStateMessage = null;
      unsubscribe();
      unsubscribeFatal();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      controller.close(new Error('宇宙模拟器已卸载'));
    };
  }, [finishPendingCommand, reportError, restartKey]);

  const start = useCallback(() => {
    enqueueCommand((controller) => controller.start());
  }, [enqueueCommand]);

  const pause = useCallback(() => {
    enqueueCommand((controller) => controller.pause());
  }, [enqueueCommand]);

  const toggle = useCallback(() => {
    enqueueCommand((controller) =>
      runStateRef.current === 'running' ? controller.pause() : controller.start(),
    );
  }, [enqueueCommand]);

  const step = useCallback(
    (stepSeconds = DEFAULT_OBSERVATORY_STEP_SECONDS) => {
      enqueueCommand(async (controller) => {
        if (runStateRef.current === 'running') {
          await controller.pause();
        }
        await controller.step(stepSeconds);
      });
    },
    [enqueueCommand],
  );

  const setTimeScale = useCallback(
    (timeScale: number) => {
      enqueueCommand((controller) => controller.setTimeScale(timeScale));
    },
    [enqueueCommand],
  );

  const retry = useCallback(() => {
    generationRef.current += 1;
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.close(new Error('用户重新初始化宇宙模拟器'));
    pendingCommandCountRef.current = 0;
    commandQueueRef.current = RESOLVED_COMMAND;
    runStateRef.current = 'idle';
    setSimulation(
      createInitialSimulationState(INITIAL_SCENARIO.bodies, DEFAULT_OBSERVATORY_TIME_SCALE),
    );
    setRestartKey((current) => current + 1);
  }, []);

  return {
    ...simulation,
    start,
    pause,
    toggle,
    step,
    setTimeScale,
    retry,
  };
}
