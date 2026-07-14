import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createReboundClient } from "../web/rebound-client.mjs";

const G = 6.6743e-11;

async function loadClient() {
  const wasmBinary = await readFile(
    new URL("../dist/rebound.wasm", import.meta.url),
  );
  return createReboundClient({ wasmBinary });
}

test("reset returns a live empty simulation at time zero", async () => {
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

test("bridge rejects negative mass before it enters REBOUND", async () => {
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
