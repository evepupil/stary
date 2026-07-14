import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_ARTIFACT_PATHS = Object.freeze([
  "dist/rebound.mjs",
  "dist/rebound.wasm",
]);

function normalizeHash(value) {
  return value.toUpperCase();
}

export async function verifyLockedFile({
  baseDirectory,
  relativePath,
  expectedBytes,
  expectedSha256,
}) {
  const filePath = path.resolve(baseDirectory, relativePath);
  const [contents, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);
  if (fileStats.size !== expectedBytes) {
    throw new Error(`${relativePath} size mismatch: expected ${expectedBytes}, got ${fileStats.size}`);
  }
  const actualSha256 = createHash("sha256").update(contents).digest("hex").toUpperCase();
  if (actualSha256 !== normalizeHash(expectedSha256)) {
    throw new Error(
      `${relativePath} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
  return { relativePath, bytes: fileStats.size, sha256: actualSha256 };
}

export function validateArtifactEntries(artifacts) {
  if (!Array.isArray(artifacts)) {
    throw new Error("artifact-lock.json artifacts must be an array");
  }
  const actualPaths = artifacts.map((artifact) => artifact?.path).toSorted();
  const expectedPaths = [...EXPECTED_ARTIFACT_PATHS].toSorted();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((artifactPath, index) => artifactPath !== expectedPaths[index])
  ) {
    throw new Error(
      `artifact-lock.json must contain exactly: ${expectedPaths.join(", ")}`,
    );
  }
}

async function verifyArtifactLock() {
  const spikeRoot = fileURLToPath(new URL("../", import.meta.url));
  const artifactLock = JSON.parse(
    await readFile(path.join(spikeRoot, "artifact-lock.json"), "utf8"),
  );
  const sourceLock = JSON.parse(
    await readFile(path.join(spikeRoot, "source-lock.json"), "utf8"),
  );
  const patch = sourceLock.patches[0];
  const inputPairs = [
    ["sourceCommit", sourceLock.commit],
    ["sourceSha256", sourceLock.sha256],
    ["patchSha256", patch.sha256],
    ["buildImageDigest", sourceLock.buildImageDigest],
  ];
  for (const [name, actual] of inputPairs) {
    if (normalizeHash(String(artifactLock.inputs[name])) !== normalizeHash(String(actual))) {
      throw new Error(`${name} differs between source-lock.json and artifact-lock.json`);
    }
  }

  await verifyLockedFile({
    baseDirectory: spikeRoot,
    relativePath: patch.path,
    expectedBytes: (await stat(path.join(spikeRoot, patch.path))).size,
    expectedSha256: artifactLock.inputs.patchSha256,
  });
  validateArtifactEntries(artifactLock.artifacts);
  for (const artifact of artifactLock.artifacts) {
    await verifyLockedFile({
      baseDirectory: spikeRoot,
      relativePath: artifact.path,
      expectedBytes: artifact.bytes,
      expectedSha256: artifact.sha256,
    });
  }
  console.log("Artifact lock verified: patch, rebound.mjs, rebound.wasm.");
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  await verifyArtifactLock();
}
