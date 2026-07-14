import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createReboundClient } from "../web/rebound-client.mjs";
import {
  ACCEPTANCE_LIMITS,
  createSunEarthScenario,
} from "../web/sun-earth-scenario.mjs";

test("IAS15 conserves energy and angular momentum over 1000 periods", async () => {
  const wasmBinary = await readFile(
    new URL("../dist/rebound.wasm", import.meta.url),
  );
  const rebound = await createReboundClient({ wasmBinary });
  const scenario = createSunEarthScenario(rebound);

  try {
    const metrics = scenario.runLongTerm(1_000);

    assert.ok(
      metrics.energyRelativeError1000Periods <=
        ACCEPTANCE_LIMITS.energyRelativeError1000Periods,
      `energy relative error ${metrics.energyRelativeError1000Periods}`,
    );
    assert.ok(
      metrics.angularMomentumRelativeError1000Periods <=
        ACCEPTANCE_LIMITS.angularMomentumRelativeError1000Periods,
      `angular momentum relative error ${metrics.angularMomentumRelativeError1000Periods}`,
    );
  } finally {
    scenario.destroy();
  }
});
