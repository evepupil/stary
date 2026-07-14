import { createReboundClient } from "./rebound-client.mjs";
import {
  ACCEPTANCE_LIMITS,
  createSunEarthScenario,
} from "./sun-earth-scenario.mjs";
import { evaluateAcceptance } from "./acceptance-result.mjs";

async function runAcceptance(kind) {
  const rebound = await createReboundClient();
  const scenario = createSunEarthScenario(rebound);
  try {
    const metrics =
      kind === "long" ? scenario.runLongTerm(1_000) : scenario.runOnePeriod();
    const evaluation = evaluateAcceptance(kind, metrics);
    return { kind, metrics, limits: ACCEPTANCE_LIMITS, ...evaluation };
  } finally {
    scenario.destroy();
  }
}

self.addEventListener("message", async (event) => {
  const requestId = event.data?.requestId;
  const kind = event.data?.kind;
  if (kind !== "one-period" && kind !== "long") {
    self.postMessage({ requestId, type: "error", message: "Unknown acceptance run" });
    return;
  }
  try {
    self.postMessage({ requestId, type: "running", kind });
    self.postMessage({ requestId, type: "result", result: await runAcceptance(kind) });
  } catch (error) {
    self.postMessage({
      requestId,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

self.postMessage({ type: "ready" });
