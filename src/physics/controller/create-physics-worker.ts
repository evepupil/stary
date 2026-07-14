export function createPhysicsWorker(): Worker {
  return new Worker(new URL('../../workers/physics.worker.ts', import.meta.url), {
    name: 'stary-physics',
    type: 'module',
  });
}
