/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  createCollisionKernelWasm,
  type CollisionKernelWasm,
} from '../collisions/collision-kernel-wasm';
import { contactBodies } from '../collisions/test-helpers';
import {
  PHYSICS_PROTOCOL_VERSION,
  type BodyState,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
} from '../protocol/schemas';
import { createReboundSimulation } from '../rebound/rebound-simulation';
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
    | { readonly stepSeconds: number; readonly type: 'step' },
): MainToWorkerMessage {
  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'real-collision-session',
    sequence,
    simulationTimeSeconds: 0,
    ...payload,
  } as MainToWorkerMessage;
}

describe('real collision Worker pipeline', () => {
  it('commits a real contact through both WASM modules and keeps integrating', async () => {
    const bodies = contactBodies({
      targetMassKg: 1e20,
      projectileMassKg: 5e19,
      targetRadiusMeters: 1e6,
      projectileRadiusMeters: 8e5,
      impactSpeedMetersPerSecond: 10,
    });
    const messages: WorkerToMainMessage[] = [];
    const runtime = new PhysicsWorkerRuntime({
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

    await runtime.receive(command(0, { type: 'initialize', bodies }));
    await runtime.receive(command(1, { type: 'step', stepSeconds: 1 }));

    const collision = messages.at(-1);
    expect(collision).toMatchObject({
      type: 'collisionBatchResolved',
      replyToSequence: 1,
      requestedTargetSimulationTimeSeconds: 1,
      bodyRevisionBefore: 0,
      bodyRevisionAfter: 1,
      collisionBatchSequence: 1,
      state: { cumulativeCollisionLedger: { resolvedEventCount: 1 } },
    });
    if (collision?.type !== 'collisionBatchResolved') {
      throw new Error('真实碰撞链没有返回碰撞批次');
    }
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
});
