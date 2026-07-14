import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateArtifactEntries,
  verifyLockedFile,
} from "../scripts/verify-artifacts.mjs";

const expectedArtifacts = [
  { path: "dist/rebound.mjs" },
  { path: "dist/rebound.wasm" },
];

test("artifact lock requires exactly the two build outputs", () => {
  assert.doesNotThrow(() => validateArtifactEntries(expectedArtifacts));
  assert.throws(
    () => validateArtifactEntries(expectedArtifacts.slice(0, 1)),
    /must contain exactly/,
  );
  assert.throws(
    () => validateArtifactEntries([...expectedArtifacts, expectedArtifacts[0]]),
    /must contain exactly/,
  );
  assert.throws(
    () =>
      validateArtifactEntries([
        ...expectedArtifacts,
        { path: "dist/unexpected.bin" },
      ]),
    /must contain exactly/,
  );
});

test("artifact lock rejects content that differs from its recorded hash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stary-artifact-lock-"));
  try {
    await writeFile(path.join(directory, "artifact.bin"), "actual", "utf8");
    await assert.rejects(
      verifyLockedFile({
        baseDirectory: directory,
        relativePath: "artifact.bin",
        expectedBytes: 6,
        expectedSha256: "0".repeat(64),
      }),
      /SHA-256 mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
