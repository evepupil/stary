import { describe, expect, it, vi } from 'vitest';

import type { WorkerToMainMessage } from '../../../physics/protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../../../physics/protocol/schemas';
import { createSimulationMessageScheduler } from './simulation-message-scheduler';
import { applyWorkerMessage, createInitialSimulationState } from './simulation-state';
import {
  createTestBody,
  createTestCollisionBatchMessage,
  createTestReplacementMessage,
  createTestStateMessage,
} from './test-helpers';

function replacementMessage(): Extract<WorkerToMainMessage, { type: 'bodiesReplaced' }> {
  return createTestReplacementMessage({
    sequence: 3,
    simulationTimeSeconds: 2,
    replyToSequence: 7,
    bodyRevision: 1,
    bodies: [createTestBody({ id: 'replacement' })],
  });
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

    harness.scheduler.accept(createTestStateMessage(1));
    harness.scheduler.accept(createTestStateMessage(2));

    expect(harness.applied).toHaveLength(0);
    expect(harness.callbacks.size).toBe(1);
    harness.callbacks.get(1)?.(16);
    expect(harness.applied.map((message) => message.sequence)).toEqual([2]);
  });

  it('替换确认即时应用并让已排队的旧 state 在 RAF 执行时失效', () => {
    const harness = createHarness();

    harness.scheduler.accept(createTestStateMessage(2));
    harness.scheduler.accept(replacementMessage());
    expect(harness.applied.map((message) => message.type)).toEqual(['bodiesReplaced']);

    harness.callbacks.get(1)?.(16);
    expect(harness.applied.map((message) => message.type)).toEqual(['bodiesReplaced']);
  });

  it('碰撞批次即时应用，并让已排队的碰前 state 在 RAF 执行时失效', () => {
    const harness = createHarness();
    const collision = createTestCollisionBatchMessage({
      sequence: 3,
      bodyRevisionBefore: 0,
      bodyRevisionAfter: 1,
      replyToSequence: null,
    });

    harness.scheduler.accept(createTestStateMessage(2, { bodyRevision: 0 }));
    const staleCallback = harness.callbacks.get(1);
    harness.scheduler.accept(collision);

    expect(harness.applied).toEqual([collision]);
    staleCallback?.(16);
    expect(harness.applied).toEqual([collision]);
  });

  it('fatal error 按 Worker 顺序落在缓冲 state 之后，残留 RAF 不能恢复 ready', () => {
    const callbacks = new Map<number, (timestampMilliseconds: number) => void>();
    let simulation = createInitialSimulationState([createTestBody({ id: 'earth' })], 1);
    const appliedTypes: WorkerToMainMessage['type'][] = [];
    const scheduler = createSimulationMessageScheduler({
      applyMessage: (message) => {
        appliedTypes.push(message.type);
        simulation = applyWorkerMessage(simulation, message);
      },
      cancelFrame: (frameId) => {
        callbacks.delete(frameId);
      },
      requestFrame: (callback) => {
        callbacks.set(1, callback);
        return 1;
      },
    });

    scheduler.accept(createTestStateMessage(1));
    const staleCallback = callbacks.get(1);
    scheduler.accept({
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId: 'test-session',
      sequence: 2,
      simulationTimeSeconds: 1,
      replyToSequence: null,
      type: 'error',
      code: 'integrationFailed',
      message: '积分失败',
      recoverable: false,
    });

    expect(appliedTypes).toEqual(['state', 'error']);
    expect(simulation.phase).toBe('error');
    staleCallback?.(16);
    expect(appliedTypes).toEqual(['state', 'error']);
    expect(simulation.phase).toBe('error');
  });

  it('dispose 取消待决 RAF 并忽略后续消息和残留回调', () => {
    const harness = createHarness();
    harness.scheduler.accept(createTestStateMessage(1));
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
