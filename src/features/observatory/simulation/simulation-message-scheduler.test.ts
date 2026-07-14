import { describe, expect, it, vi } from 'vitest';

import type { WorkerToMainMessage } from '../../../physics/protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../../../physics/protocol/schemas';
import { createSimulationMessageScheduler } from './simulation-message-scheduler';

const diagnostics = {
  totalEnergyJoules: -1,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
} as const;

function stateMessage(sequence: number): Extract<WorkerToMainMessage, { type: 'state' }> {
  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'test-session',
    sequence,
    simulationTimeSeconds: sequence,
    type: 'state',
    bodyRevision: 0,
    bodies: [],
    diagnostics,
  };
}

function replacementMessage(): Extract<WorkerToMainMessage, { type: 'bodiesReplaced' }> {
  return {
    version: PHYSICS_PROTOCOL_VERSION,
    sessionId: 'test-session',
    sequence: 3,
    simulationTimeSeconds: 2,
    type: 'bodiesReplaced',
    bodyRevision: 1,
    bodies: [],
    diagnostics,
  };
}

function createHarness() {
  const applied: WorkerToMainMessage[] = [];
  const callbacks = new Map<number, (timestampMilliseconds: number) => void>();
  const cancelFrame = vi.fn((frameId: number) => {
    callbacks.delete(frameId);
  });
  let nextFrameId = 1;
  const scheduler = createSimulationMessageScheduler({
    applyMessage: (message) => {
      applied.push(message);
    },
    cancelFrame,
    requestFrame: (callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    },
  });
  return { applied, callbacks, cancelFrame, scheduler };
}

describe('simulation message scheduler', () => {
  it('同一帧只排一次 RAF 并应用最新 state', () => {
    const harness = createHarness();

    harness.scheduler.accept(stateMessage(1));
    harness.scheduler.accept(stateMessage(2));

    expect(harness.applied).toHaveLength(0);
    expect(harness.callbacks.size).toBe(1);
    harness.callbacks.get(1)?.(16);
    expect(harness.applied.map((message) => message.sequence)).toEqual([2]);
  });

  it('替换确认即时应用并让已排队的旧 state 在 RAF 执行时失效', () => {
    const harness = createHarness();

    harness.scheduler.accept(stateMessage(2));
    harness.scheduler.accept(replacementMessage());
    expect(harness.applied.map((message) => message.type)).toEqual(['bodiesReplaced']);

    harness.callbacks.get(1)?.(16);
    expect(harness.applied.map((message) => message.type)).toEqual(['bodiesReplaced']);
  });

  it('dispose 取消待决 RAF 并忽略后续消息和残留回调', () => {
    const harness = createHarness();
    harness.scheduler.accept(stateMessage(1));
    const staleCallback = harness.callbacks.get(1);

    harness.scheduler.dispose();
    harness.scheduler.dispose();
    harness.scheduler.accept(replacementMessage());
    staleCallback?.(16);

    expect(harness.cancelFrame).toHaveBeenCalledOnce();
    expect(harness.cancelFrame).toHaveBeenCalledWith(1);
    expect(harness.applied).toHaveLength(0);
  });
});
