import type { WorkerToMainMessage } from '../../../physics/protocol/schemas';
import {
  bufferSimulationMessage,
  EMPTY_SIMULATION_MESSAGE_BUFFER,
  flushSimulationMessageBuffer,
} from './simulation-message-buffer';

export interface SimulationMessageScheduler {
  accept(message: WorkerToMainMessage): void;
  dispose(): void;
}

export interface SimulationMessageSchedulerOptions {
  readonly applyMessage: (message: WorkerToMainMessage) => void;
  readonly cancelFrame: (frameId: number) => void;
  readonly requestFrame: (callback: (timestampMilliseconds: number) => void) => number;
}

export function createSimulationMessageScheduler(
  options: SimulationMessageSchedulerOptions,
): SimulationMessageScheduler {
  let buffer = EMPTY_SIMULATION_MESSAGE_BUFFER;
  let disposed = false;
  let frameId: number | null = null;

  const flush = () => {
    frameId = null;
    if (disposed) {
      return;
    }
    const flushed = flushSimulationMessageBuffer(buffer);
    buffer = flushed.buffer;
    if (flushed.message !== null) {
      options.applyMessage(flushed.message);
    }
  };

  return {
    accept(message) {
      if (disposed) {
        return;
      }
      buffer = bufferSimulationMessage(buffer, message);
      if (message.type === 'state') {
        frameId ??= options.requestFrame(flush);
        return;
      }
      options.applyMessage(message);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      buffer = EMPTY_SIMULATION_MESSAGE_BUFFER;
      if (frameId !== null) {
        options.cancelFrame(frameId);
        frameId = null;
      }
    },
  };
}
