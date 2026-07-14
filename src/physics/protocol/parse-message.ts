import { mainToWorkerMessageSchema, workerToMainMessageSchema } from './schemas';
import type { MainToWorkerMessage, WorkerToMainMessage } from './schemas';

export function parseMainToWorkerMessage(input: unknown): MainToWorkerMessage {
  return mainToWorkerMessageSchema.parse(input);
}

export function parseWorkerToMainMessage(input: unknown): WorkerToMainMessage {
  return workerToMainMessageSchema.parse(input);
}
