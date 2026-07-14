export function createFoundationWorker(): Worker {
  return new Worker(new URL('../../workers/foundation.worker.ts', import.meta.url), {
    name: 'stary-foundation-probe',
    type: 'module',
  });
}
