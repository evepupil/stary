import { createCircularSunEarthScenario } from '../scenarios/sun-earth';
import {
  PhysicsWorkerController,
  type PhysicsWorkerControllerOptions,
} from './physics-worker-controller';

export const PHYSICS_PROBE_STEP_SECONDS = 3_600;

export interface PhysicsWorkerProbeOptions extends PhysicsWorkerControllerOptions {
  readonly signal?: AbortSignal;
}

export interface PhysicsWorkerProbeResult {
  readonly bodyCount: number;
  readonly simulationTimeSeconds: number;
  readonly stepSeconds: number;
}

function createAbortError(): Error {
  const error = new Error('Physics Worker 探针已取消');
  error.name = 'AbortError';
  return error;
}

export async function probePhysicsWorker(
  options: PhysicsWorkerProbeOptions = {},
): Promise<PhysicsWorkerProbeResult> {
  if (options.signal?.aborted === true) {
    throw createAbortError();
  }

  const controller = new PhysicsWorkerController(options);
  const handleAbort = () => {
    controller.close(createAbortError());
  };
  options.signal?.addEventListener('abort', handleAbort, { once: true });

  try {
    const scenario = createCircularSunEarthScenario();
    await controller.initialize(scenario.bodies);
    await controller.start();
    await controller.pause();
    const simulationTimeBeforeStep = controller.simulationTimeSeconds;
    const advance = await controller.step(PHYSICS_PROBE_STEP_SECONDS);
    const stepSeconds = advance.simulationTimeSeconds - simulationTimeBeforeStep;
    if (Math.abs(stepSeconds - PHYSICS_PROBE_STEP_SECONDS) > 1e-9) {
      throw new Error(
        `Physics Worker 单步推进量错误：预期 ${String(PHYSICS_PROBE_STEP_SECONDS)} 秒，实际 ${String(stepSeconds)} 秒`,
      );
    }
    await controller.dispose();
    return {
      bodyCount: advance.state.majorBodies.length,
      simulationTimeSeconds: advance.simulationTimeSeconds,
      stepSeconds: PHYSICS_PROBE_STEP_SECONDS,
    };
  } finally {
    options.signal?.removeEventListener('abort', handleAbort);
    controller.close();
  }
}
