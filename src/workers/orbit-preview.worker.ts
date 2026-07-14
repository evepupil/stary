import { OrbitPreviewRuntime } from '../physics/preview/orbit-preview-runtime';
import { createReboundSimulation } from '../physics/rebound/rebound-simulation';

interface OrbitPreviewWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'messageerror', listener: () => void): void;
  close(): void;
  postMessage(message: unknown): void;
}

const workerScope = self as unknown as OrbitPreviewWorkerScope;
const runtime = new OrbitPreviewRuntime({
  closeWorker: () => {
    workerScope.close();
  },
  createSimulation: (bodies) => createReboundSimulation(bodies),
  postMessage: (message) => {
    workerScope.postMessage(message);
  },
});

workerScope.addEventListener('message', (event) => {
  void runtime.receive(event.data);
});
workerScope.addEventListener('messageerror', () => {
  runtime.reportMessageError();
});

export {};
