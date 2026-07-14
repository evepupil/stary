import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createReboundClient } from "../web/rebound-client.mjs";
import {
  ACCEPTANCE_LIMITS,
  createSunEarthScenario,
  evaluateOnePeriod,
} from "../web/sun-earth-scenario.mjs";

test("IAS15 keeps the barycentric Sun-Earth orbit within one-period tolerances", async () => {
  const wasmBinary = await readFile(
    new URL("../dist/rebound.wasm", import.meta.url),
  );
  const rebound = await createReboundClient({ wasmBinary });
  const scenario = createSunEarthScenario(rebound);

  try {
    const metrics = scenario.runOnePeriod();

    assert.ok(
      metrics.positionRelativeError <= ACCEPTANCE_LIMITS.positionRelativeError,
      `position relative error ${metrics.positionRelativeError}`,
    );
    assert.ok(
      metrics.velocityRelativeError <= ACCEPTANCE_LIMITS.velocityRelativeError,
      `velocity relative error ${metrics.velocityRelativeError}`,
    );
    assert.ok(
      metrics.periodRelativeError <= ACCEPTANCE_LIMITS.periodRelativeError,
      `period relative error ${metrics.periodRelativeError}`,
    );
    assert.ok(
      metrics.radiusRelativeError <= ACCEPTANCE_LIMITS.radiusRelativeError,
      `radius relative error ${metrics.radiusRelativeError}`,
    );
    assert.deepEqual(evaluateOnePeriod(metrics).failures, []);
  } finally {
    scenario.destroy();
  }
});
