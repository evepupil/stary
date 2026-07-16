import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import createReboundModule from '../dist/rebound.mjs';
import { createReboundClient } from '../web/rebound-client.mjs';

const G = 6.6743e-11;

async function loadClient() {
  const wasmBinary = await readFile(new URL('../dist/rebound.wasm', import.meta.url));
  return createReboundClient({ wasmBinary });
}

test('reset returns a live empty simulation at time zero', async () => {
  const rebound = await loadClient();
  rebound.create({ gravitationalConstant: G });
  try {
    rebound.addParticle({
      mass: 1,
      radius: 1,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 4, y: 5, z: 6 },
    });
    rebound.reset({ gravitationalConstant: G });

    assert.deepEqual(rebound.getState(), { timeSeconds: 0, particles: [] });
  } finally {
    rebound.destroy();
  }
});

test('bridge rejects negative mass before it enters REBOUND', async () => {
  const rebound = await loadClient();
  rebound.create({ gravitationalConstant: G });
  try {
    assert.throws(
      () =>
        rebound.addParticle({
          mass: -1,
          radius: 1,
          position: { x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      /addParticle failed with status -2/,
    );
  } finally {
    rebound.destroy();
  }
});

test('stale and repeated raw handles cannot destroy a newer simulation', async () => {
  const wasmBinary = await readFile(new URL('../dist/rebound.wasm', import.meta.url));
  const module = await createReboundModule({ wasmBinary });
  const firstHandle = module._stary_reb_create(G);
  module._stary_reb_destroy(firstHandle);
  module._stary_reb_destroy(firstHandle);

  const secondHandle = module._stary_reb_create(G);
  try {
    assert.notEqual(secondHandle, firstHandle);
    module._stary_reb_destroy(firstHandle);
    assert.equal(module._stary_reb_particle_count(secondHandle), 0);
  } finally {
    module._stary_reb_destroy(secondHandle);
  }
});

test('discarding a malformed read result does not acknowledge the unresolved contact', async () => {
  const wasmBinary = await readFile(new URL('../dist/rebound.wasm', import.meta.url));
  const module = await createReboundModule({ wasmBinary });
  const handle = module._stary_reb_create(G);
  try {
    for (const x of [0, 1]) {
      assert.equal(module._stary_reb_add_particle(handle, 0, 1, x, 0, 0, 0, 0, 0), 0);
    }
    assert.equal(module._stary_reb_set_integrator(handle, 0, 1), 0);
    assert.equal(module._stary_reb_advance_until_event(handle, 0), 1);
    assert.equal(module._stary_reb_discard_contact(handle), 0);
    assert.equal(module._stary_reb_advance_until_event(handle, 0), 1);
  } finally {
    module._stary_reb_destroy(handle);
  }
});
