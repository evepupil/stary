import { ACCEPTANCE_LIMITS } from "./sun-earth-scenario.mjs";

const REQUIRED_METRICS = Object.freeze({
  "one-period": Object.freeze([
    "positionRelativeError",
    "velocityRelativeError",
    "periodRelativeError",
    "radiusRelativeError",
  ]),
  long: Object.freeze([
    "energyRelativeError1000Periods",
    "angularMomentumRelativeError1000Periods",
  ]),
});

export function evaluateAcceptance(kind, metrics) {
  const requiredMetrics = REQUIRED_METRICS[kind];
  if (requiredMetrics === undefined) {
    throw new Error(`Unknown acceptance run: ${kind}`);
  }

  const failures = [];
  for (const name of requiredMetrics) {
    if (!Object.hasOwn(metrics, name)) {
      failures.push(`${name} is missing`);
      continue;
    }
    const value = metrics[name];
    if (!Number.isFinite(value)) {
      failures.push(`${name} must be finite`);
    } else if (value < 0) {
      failures.push(`${name} must not be negative`);
    } else if (value > ACCEPTANCE_LIMITS[name]) {
      failures.push(`${name}=${value} exceeds ${ACCEPTANCE_LIMITS[name]}`);
    }
  }
  return { passed: failures.length === 0, failures };
}
