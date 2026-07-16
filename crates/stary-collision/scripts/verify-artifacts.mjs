import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const crateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(crateRoot, '..', '..');
const lockPath = path.join(crateRoot, 'artifact-lock.json');
const expectedArtifactPath = 'dist/stary_collision.wasm';
const expectedToolchain = {
  cargo: 'cargo 1.96.0 (30a34c682 2026-05-25)',
  channel: '1.96.0',
  rustc: 'rustc 1.96.0 (ac68faa20 2026-05-25)',
  target: 'wasm32-unknown-unknown',
};
const expectedBuildImage = {
  digest: 'sha256:c993d32d95cc146bd12c84d66f0b924a6a96f3988325f39c144f2f9893dea120',
  image: 'rust:1.96.0-bookworm',
  platform: 'linux/amd64',
};

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex').toUpperCase();
}

async function listRustSources(directory, relativeDirectory = 'src') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        return listRustSources(absolutePath, relativePath);
      }
      return entry.isFile() && entry.name.endsWith('.rs') ? [relativePath] : [];
    }),
  );
  return files.flat().toSorted();
}

function resolveLockedPath(relativePath) {
  if (relativePath.startsWith('../../')) {
    return path.resolve(crateRoot, ...relativePath.split('/'));
  }
  return path.resolve(crateRoot, ...relativePath.split('/'));
}

async function verifyLockedFile(entry) {
  if (
    typeof entry?.path !== 'string' ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes <= 0 ||
    typeof entry.sha256 !== 'string' ||
    !/^[A-F0-9]{64}$/.test(entry.sha256)
  ) {
    throw new Error(`Invalid collision lock entry: ${JSON.stringify(entry)}`);
  }
  const absolutePath = resolveLockedPath(entry.path);
  const [contents, fileStats] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  if (fileStats.size !== entry.bytes) {
    throw new Error(`${entry.path} size mismatch: expected ${entry.bytes}, got ${fileStats.size}`);
  }
  const actualHash = sha256(contents);
  if (actualHash !== entry.sha256) {
    throw new Error(`${entry.path} SHA-256 mismatch: expected ${entry.sha256}, got ${actualHash}`);
  }
}

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
if (lock.schemaVersion !== 1) {
  throw new Error(`Collision artifact lock schemaVersion must be 1`);
}
if (JSON.stringify(lock.toolchain) !== JSON.stringify(expectedToolchain)) {
  throw new Error(`Collision artifact lock toolchain does not match the fixed Rust toolchain`);
}
if (JSON.stringify(lock.buildImage) !== JSON.stringify(expectedBuildImage)) {
  throw new Error(`Collision artifact lock build image does not match the fixed digest`);
}

const expectedInputs = [
  'Cargo.lock',
  'Cargo.toml',
  'rust-toolchain.toml',
  'scripts/build-in-container.sh',
  'scripts/build.ps1',
  'scripts/verify-exports.mjs',
  'scripts/verify.ps1',
  ...(await listRustSources(path.join(crateRoot, 'src'))),
  '../../src/physics/collisions/fixtures/collision-golden-v1.json',
].toSorted();
if (!Array.isArray(lock.inputs)) {
  throw new Error(`Collision artifact lock inputs must be an array`);
}
const actualInputs = lock.inputs.map((entry) => entry?.path).toSorted();
if (
  actualInputs.length !== expectedInputs.length ||
  actualInputs.some((entry, index) => entry !== expectedInputs[index])
) {
  throw new Error(
    `Collision artifact lock input inventory mismatch: expected ${expectedInputs.join(', ')}, got ${actualInputs.join(', ')}`,
  );
}
for (const entry of lock.inputs) {
  await verifyLockedFile(entry);
}

if (
  !Array.isArray(lock.artifacts) ||
  lock.artifacts.length !== 1 ||
  lock.artifacts[0]?.path !== expectedArtifactPath
) {
  throw new Error(`Collision artifact lock must contain only ${expectedArtifactPath}`);
}
await verifyLockedFile(lock.artifacts[0]);

const distEntries = await readdir(path.join(crateRoot, 'dist'), { withFileTypes: true });
const distFiles = distEntries
  .filter((entry) => entry.isFile())
  .map((entry) => `dist/${entry.name}`)
  .toSorted();
if (distFiles.length !== 1 || distFiles[0] !== expectedArtifactPath) {
  throw new Error(`Collision dist must contain only ${expectedArtifactPath}`);
}

const artifact = await readFile(
  path.join(repositoryRoot, 'crates', 'stary-collision', expectedArtifactPath),
);
if (!artifact.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
  throw new Error(`${expectedArtifactPath} is missing the WebAssembly magic header`);
}

console.log('Collision artifact lock verified: fixed inputs and one stary_collision.wasm.');
