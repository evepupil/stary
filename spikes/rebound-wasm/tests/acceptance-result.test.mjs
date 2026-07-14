import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAcceptance } from "../web/acceptance-result.mjs";

const validOnePeriod = {
  positionRelativeError: 1e-15,
  velocityRelativeError: 1e-15,
  periodRelativeError: 1e-16,
  radiusRelativeError: 1e-16,
};

test("acceptance requires every metric for the selected run", () => {
  const { periodRelativeError, ...missingPeriod } = validOnePeriod;
  const result = evaluateAcceptance("one-period", missingPeriod);

  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /periodRelativeError is missing/);
});

test("acceptance rejects NaN and infinite metrics", () => {
  for (const invalidValue of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = evaluateAcceptance("one-period", {
      ...validOnePeriod,
      positionRelativeError: invalidValue,
    });
    assert.equal(result.passed, false);
    assert.match(result.failures.join("\n"), /positionRelativeError must be finite/);
  }
});
