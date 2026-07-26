import type { WorkerToMainMessage } from '../../../physics/protocol/schemas';

type StateMessage = Extract<WorkerToMainMessage, { type: 'state' }>;
type AtomicStateMessage = Extract<
  WorkerToMainMessage,
  { type: 'bodiesReplaced' | 'collisionBatchResolved' | 'snapshotRestored' }
>;

function atomicBodyRevision(message: AtomicStateMessage): number {
  return message.type === 'collisionBatchResolved'
    ? message.bodyRevisionAfter
    : message.bodyRevision;
}

export interface SimulationMessageBuffer {
  readonly stateMessage: StateMessage | null;
}

export interface FlushedSimulationMessageBuffer {
  readonly buffer: SimulationMessageBuffer;
  readonly message: StateMessage | null;
}

export const EMPTY_SIMULATION_MESSAGE_BUFFER: SimulationMessageBuffer = {
  stateMessage: null,
};

export function bufferSimulationMessage(
  buffer: SimulationMessageBuffer,
  message: WorkerToMainMessage,
): SimulationMessageBuffer {
  if (message.type === 'state') {
    const current = buffer.stateMessage;
    if (
      current !== null &&
      (message.bodyRevision < current.bodyRevision || message.sequence <= current.sequence)
    ) {
      return buffer;
    }
    return { stateMessage: message };
  }

  if (
    message.type === 'bodiesReplaced' ||
    message.type === 'collisionBatchResolved' ||
    message.type === 'snapshotRestored'
  ) {
    const bufferedState = buffer.stateMessage;
    if (bufferedState === null) {
      return buffer;
    }
    const bodyRevision = atomicBodyRevision(message);
    if (
      bufferedState.bodyRevision < bodyRevision ||
      (bufferedState.bodyRevision === bodyRevision && bufferedState.sequence <= message.sequence)
    ) {
      return EMPTY_SIMULATION_MESSAGE_BUFFER;
    }
  }

  return buffer;
}

export function flushSimulationMessageBuffer(
  buffer: SimulationMessageBuffer,
): FlushedSimulationMessageBuffer {
  return {
    buffer: EMPTY_SIMULATION_MESSAGE_BUFFER,
    message: buffer.stateMessage,
  };
}
