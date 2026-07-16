import { describe, expect, it } from 'vitest';

import {
  bufferSimulationMessage,
  EMPTY_SIMULATION_MESSAGE_BUFFER,
  flushSimulationMessageBuffer,
} from './simulation-message-buffer';
import {
  createTestBody,
  createTestCollisionBatchMessage,
  createTestReplacementMessage,
  createTestStateMessage,
} from './test-helpers';

describe('simulation message buffer', () => {
  it('同一动画帧只保留序号最新的 state', () => {
    const first = bufferSimulationMessage(
      EMPTY_SIMULATION_MESSAGE_BUFFER,
      createTestStateMessage(1),
    );
    const second = bufferSimulationMessage(first, createTestStateMessage(2));
    const stale = bufferSimulationMessage(second, createTestStateMessage(1));

    expect(stale.stateMessage?.sequence).toBe(2);
  });

  it('替换确认会清除已缓存的旧 state，随后 RAF 不再应用旧世界', () => {
    const buffered = bufferSimulationMessage(
      EMPTY_SIMULATION_MESSAGE_BUFFER,
      createTestStateMessage(2),
    );
    const afterReplacement = bufferSimulationMessage(
      buffered,
      createTestReplacementMessage({
        sequence: 3,
        simulationTimeSeconds: 2,
        replyToSequence: 7,
        bodyRevision: 1,
        bodies: [createTestBody({ id: 'replacement' })],
      }),
    );
    const flushed = flushSimulationMessageBuffer(afterReplacement);

    expect(flushed.message).toBeNull();
    expect(flushed.buffer).toBe(EMPTY_SIMULATION_MESSAGE_BUFFER);
  });

  it('碰撞批次清除已缓存的碰前 state，阻止旧 RAF 世界回写', () => {
    const buffered = bufferSimulationMessage(
      EMPTY_SIMULATION_MESSAGE_BUFFER,
      createTestStateMessage(5, { bodyRevision: 0 }),
    );
    const collision = createTestCollisionBatchMessage({
      sequence: 6,
      bodyRevisionBefore: 0,
      bodyRevisionAfter: 1,
      replyToSequence: null,
    });

    const afterCollision = bufferSimulationMessage(buffered, collision);
    const flushed = flushSimulationMessageBuffer(afterCollision);

    expect(collision.replyToSequence).toBeNull();
    expect(flushed.message).toBeNull();
    expect(flushed.buffer).toBe(EMPTY_SIMULATION_MESSAGE_BUFFER);
  });
});
