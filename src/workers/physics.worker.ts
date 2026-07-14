import { createReboundSimulation } from '../physics/rebound/rebound-simulation';
import { PhysicsWorkerRuntime } from '../physics/runtime/physics-worker-runtime';

interface PhysicsWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'messageerror', listener: () => void): void;
  close(): void;
  postMessage(message: unknown): void;
}

const workerScope = self as unknown as PhysicsWorkerScope;
const runtime = new PhysicsWorkerRuntime({
  closeWorker: () => {
    workerScope.close();
  },
  createSimulation: (bodies, initialTimeSeconds) =>
    createReboundSimulation(bodies, { initialTimeSeconds }),
  postMessage: (message) => {
    workerScope.postMessage(message);
  },
});

workerScope.addEventListener('message', (event) => {
  void runtime.receive(event.data);
});
workerScope.addEventListener('messageerror', () => {
  void runtime.reportMessageError();
});

export {};
