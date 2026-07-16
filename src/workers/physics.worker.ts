import { createReboundSimulation } from '../physics/rebound/rebound-simulation';
import { PhysicsWorkerRuntime } from '../physics/runtime/physics-worker-runtime';
import { COLLISION_WASM_URL } from '../platform/wasm/collision-asset';

interface PhysicsWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'messageerror', listener: () => void): void;
  close(): void;
  postMessage(message: unknown): void;
}

const workerScope = self as unknown as PhysicsWorkerScope;
const runtime = new PhysicsWorkerRuntime({
  collisionKernelWasmUrl: COLLISION_WASM_URL,
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
