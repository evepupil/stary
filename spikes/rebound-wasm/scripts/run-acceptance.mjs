import { readFile } from "node:fs/promises";

import { createReboundClient } from "../web/rebound-client.mjs";
import {
  ACCEPTANCE_LIMITS,
  createSunEarthScenario,
} from "../web/sun-earth-scenario.mjs";

async function run(kind) {
  const wasmBinary = await readFile(new URL("../dist/rebound.wasm", import.meta.url));
  const rebound = await createReboundClient({ wasmBinary });
  const scenario = createSunEarthScenario(rebound);
  try {
    return kind === "onePeriod"
      ? scenario.runOnePeriod()
      : scenario.runLongTerm(1_000);
  } finally {
    scenario.destroy();
  }
}

const result = {
  limits: ACCEPTANCE_LIMITS,
  onePeriod: await run("onePeriod"),
  longTerm: await run("longTerm"),
};

console.log(JSON.stringify(result, null, 2));
