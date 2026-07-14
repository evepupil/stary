import { describe, expect, it } from 'vitest';

import type { WorkerToMainMessage } from '../../../physics/protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../../../physics/protocol/schemas';
import {
  bufferSimulationMessage,
  EMPTY_SIMULATION_MESSAGE_BUFFER,
  flushSimulationMessageBuffer,
} from './simulation-message-buffer';

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

describe('simulation message buffer', () => {
  it('同一动画帧只保留序号最新的 state', () => {
    const first = bufferSimulationMessage(EMPTY_SIMULATION_MESSAGE_BUFFER, stateMessage(1));
    const second = bufferSimulationMessage(first, stateMessage(2));
    const stale = bufferSimulationMessage(second, stateMessage(1));

    expect(stale.stateMessage?.sequence).toBe(2);
  });

  it('替换确认会清除已缓存的旧 state，随后 RAF 不再应用旧世界', () => {
    const buffered = bufferSimulationMessage(EMPTY_SIMULATION_MESSAGE_BUFFER, stateMessage(2));
    const afterReplacement = bufferSimulationMessage(buffered, {
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId: 'test-session',
      sequence: 3,
      simulationTimeSeconds: 2,
      type: 'bodiesReplaced',
      bodyRevision: 1,
      bodies: [],
      diagnostics,
    });
    const flushed = flushSimulationMessageBuffer(afterReplacement);

    expect(flushed.message).toBeNull();
    expect(flushed.buffer).toBe(EMPTY_SIMULATION_MESSAGE_BUFFER);
  });
});
