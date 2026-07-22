import { describe, expect, it } from 'vitest';

import { resolveCollisionKernelReference, type CollisionKernelWasm } from '../collisions';
import { contactBodies } from '../collisions/test-helpers';
import { parseWorkerToMainMessage } from '../protocol/parse-message';
import {
  PHYSICS_PROTOCOL_VERSION,
  type BodyState,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
} from '../protocol/schemas';
import type { PhysicsScheduler, ScheduledPhysicsTask } from './physics-scheduler';
import type { PhysicsContactPair, PhysicsSimulation } from './physics-simulation';
import { PhysicsWorkerRuntime } from './physics-worker-runtime';

const diagnostics = {
  totalEnergyJoules: -1,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
} as const;

const kernel: CollisionKernelWasm = {
  abiVersion: 1,
  liveContextCount: () => 0,
  resolveJson: resolveCollisionKernelReference,
};

class CollisionScheduler implements PhysicsScheduler {
  now = 0;
  nextTaskId = 1;
  readonly tasks = new Map<number, () => void>();

  cancel(task: ScheduledPhysicsTask): void {
    this.tasks.delete(task as unknown as number);
  }

  nowMilliseconds(): number {
    return this.now;
  }

  schedule(task: () => void): ScheduledPhysicsTask {
    const id = this.nextTaskId;
    this.nextTaskId += 1;
    this.tasks.set(id, task);
    return id as unknown as ScheduledPhysicsTask;
  }

  async advanceAndRun(milliseconds: number): Promise<void> {
    this.now += milliseconds;
    const next = this.tasks.entries().next().value as [number, () => void] | undefined;
    if (next === undefined) {
      return;
    }
    this.tasks.delete(next[0]);
    next[1]();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  }
}

class EventSimulation implements PhysicsSimulation {
  clearPendingContactCount = 0;
  destroyCount = 0;
  timeSeconds: number;

  public constructor(
    public readonly bodies: readonly BodyState[],
    initialTimeSeconds: number,
    private readonly contact:
      { readonly pairs: readonly PhysicsContactPair[]; readonly timeSeconds: number } | undefined,
    private readonly corruptSnapshot = false,
  ) {
    this.timeSeconds = initialTimeSeconds;
  }

  advanceUntilEvent(targetTimeSeconds: number) {
    if (
      this.contact !== undefined &&
      this.contact.timeSeconds >= this.timeSeconds &&
      this.contact.timeSeconds <= targetTimeSeconds
    ) {
      this.timeSeconds = this.contact.timeSeconds;
      return {
        type: 'contact' as const,
        timeSeconds: this.timeSeconds,
        pairs: this.contact.pairs,
        snapshot: this.snapshot(),
      };
    }
    this.timeSeconds = targetTimeSeconds;
    return { type: 'advanced' as const, timeSeconds: targetTimeSeconds };
  }

  clearPendingContact(): void {
    this.clearPendingContactCount += 1;
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  integrateTo(targetTimeSeconds: number): void {
    this.timeSeconds = targetTimeSeconds;
  }

  snapshot() {
    return {
      bodies: this.bodies.map((body, index) =>
        this.corruptSnapshot && index === 0
          ? { ...body, positionMeters: { ...body.positionMeters, x: body.positionMeters.x + 1 } }
          : body,
      ),
      diagnostics,
    };
  }
}

function collisionBodies(): readonly [BodyState, BodyState] {
  return contactBodies({
    targetMassKg: 1e20,
    projectileMassKg: 5e19,
    targetRadiusMeters: 1e6,
    projectileRadiusMeters: 8e5,
    impactSpeedMetersPerSecond: 10,
  });
}

function command(
  sequence: number,
  payload:
    | { readonly bodies: readonly BodyState[]; readonly type: 'initialize' }
    | { readonly type: 'start' }
    | { readonly stepSeconds: number; readonly type: 'step' },
): MainToWorkerMessage {
  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'collision-session',
    sequence,
    simulationTimeSeconds: 0,
    ...payload,
  } as MainToWorkerMessage;
}

function createHarness(options: { readonly corruptCandidate?: boolean } = {}) {
  const bodies = collisionBodies();
  const pairs = [{ firstBodyId: bodies[0].id, secondBodyId: bodies[1].id }];
  const initial = new EventSimulation(bodies, 0, { pairs, timeSeconds: 2 });
  const simulations = [initial];
  const scheduler = new CollisionScheduler();
  const messages: WorkerToMainMessage[] = [];
  let creationCount = 0;
  const runtime = new PhysicsWorkerRuntime({
    createSimulation: (candidateBodies, initialTimeSeconds, createOptions) => {
      creationCount += 1;
      if (creationCount === 1) {
        return Promise.resolve(initial);
      }
      expect(createOptions).toEqual({ preserveReferenceFrame: true });
      const candidate = new EventSimulation(
        candidateBodies,
        initialTimeSeconds,
        undefined,
        options.corruptCandidate,
      );
      simulations.push(candidate);
      return Promise.resolve(candidate);
    },
    loadCollisionKernel: () => Promise.resolve(kernel),
    postMessage: (message) => messages.push(parseWorkerToMainMessage(message)),
    scheduler,
  });
  return { bodies, initial, messages, runtime, scheduler, simulations };
}

async function initialize(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.runtime.receive(command(0, { type: 'initialize', bodies: harness.bodies }));
}

describe('PhysicsWorkerRuntime collision flow', () => {
  it('returns an early collision result for step and continues on the candidate instance', async () => {
    const harness = createHarness();
    await initialize(harness);

    await harness.runtime.receive(command(1, { type: 'step', stepSeconds: 10 }));

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'collisionBatchResolved',
      replyToSequence: 1,
      requestedTargetSimulationTimeSeconds: 10,
      contactTimeSeconds: 2,
      simulationTimeSeconds: 2,
      bodyRevisionBefore: 0,
      bodyRevisionAfter: 1,
      collisionBatchSequence: 1,
    });
    expect(harness.initial.destroyCount).toBe(1);
    expect(harness.simulations).toHaveLength(2);

    await harness.runtime.receive(command(2, { type: 'step', stepSeconds: 5 }));
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'state',
      replyToSequence: 2,
      bodyRevision: 1,
      simulationTimeSeconds: 7,
    });
  });

  it('publishes a running collision as a background batch and stops scheduling', async () => {
    const harness = createHarness();
    await initialize(harness);
    await harness.runtime.receive(command(1, { type: 'start' }));

    await harness.scheduler.advanceAndRun(10_000);

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'collisionBatchResolved',
      replyToSequence: null,
      runState: 'paused',
      contactTimeSeconds: 2,
    });
    expect(harness.scheduler.tasks.size).toBe(0);
  });

  it('keeps the contact instance and revision when candidate validation fails', async () => {
    const harness = createHarness({ corruptCandidate: true });
    await initialize(harness);

    await harness.runtime.receive(command(1, { type: 'step', stepSeconds: 10 }));

    expect(harness.messages.at(-2)).toMatchObject({
      type: 'state',
      replyToSequence: null,
      bodyRevision: 0,
      simulationTimeSeconds: 2,
    });
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'collisionResolutionFailed',
      replyToSequence: 1,
      recoverable: true,
      simulationTimeSeconds: 2,
    });
    expect(harness.initial.destroyCount).toBe(0);
    expect(harness.simulations[1]?.destroyCount).toBe(1);
  });
});
