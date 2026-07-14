import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(projectRoot, 'dist');
const reboundSpikeDirectory = path.join(projectRoot, 'spikes', 'rebound-wasm');
const artifactLockPath = path.join(reboundSpikeDirectory, 'artifact-lock.json');
const lockedWasmPath = 'dist/rebound.wasm';
const manifestWasmSource = `spikes/rebound-wasm/${lockedWasmPath}`;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    }),
  );

  return files.flat();
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex').toUpperCase();
}

function readLockedWasmArtifact(artifactLock) {
  if (!Array.isArray(artifactLock?.artifacts)) {
    throw new Error('artifact-lock.json 缺少 artifacts 数组');
  }

  const matches = artifactLock.artifacts.filter((artifact) => artifact?.path === lockedWasmPath);
  if (matches.length !== 1) {
    throw new Error(`artifact-lock.json 应恰好锁定一个 ${lockedWasmPath}`);
  }

  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new Error(`${lockedWasmPath} 的锁定字节数无效`);
  }
  if (typeof artifact.sha256 !== 'string' || !/^[A-F0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`${lockedWasmPath} 的锁定 SHA-256 无效`);
  }

  return artifact;
}

function assertLockedWasm(label, content, lockedArtifact) {
  if (content.byteLength !== lockedArtifact.bytes) {
    throw new Error(
      `${label} 字节数不匹配：预期 ${lockedArtifact.bytes}，实际 ${content.byteLength}`,
    );
  }
  if (sha256(content) !== lockedArtifact.sha256) {
    throw new Error(`${label} SHA-256 与 artifact-lock.json 不一致`);
  }
}

const artifactLock = JSON.parse(await readFile(artifactLockPath, 'utf8'));
const lockedWasmArtifact = readLockedWasmArtifact(artifactLock);
const files = await listFiles(distDirectory);
const relativeFiles = files.map((file) => path.relative(distDirectory, file).replaceAll('\\', '/'));

const sourceMaps = relativeFiles.filter((file) => file.endsWith('.map'));
if (sourceMaps.length > 0) {
  throw new Error(`生产构建包含 source map: ${sourceMaps.join(', ')}`);
}

const workerFiles = relativeFiles.filter(
  (file) => file.includes('foundation.worker') && file.endsWith('.js'),
);
if (workerFiles.length !== 1) {
  throw new Error(`应产出一个模块 Worker，实际为 ${workerFiles.length} 个`);
}

const wasmFiles = relativeFiles.filter((file) => file.endsWith('.wasm'));
if (wasmFiles.length !== 1) {
  throw new Error(`应产出一个 REBOUND WASM 资源，实际为 ${wasmFiles.length} 个`);
}

const manifest = JSON.parse(
  await readFile(path.join(distDirectory, '.vite', 'manifest.json'), 'utf8'),
);
const manifestWasmEntry = manifest[manifestWasmSource];
if (manifestWasmEntry?.src !== manifestWasmSource || manifestWasmEntry.file !== wasmFiles[0]) {
  throw new Error(`生产构建清单没有把 ${manifestWasmSource} 映射到唯一 WASM 产物`);
}

const sourceWasmPath = path.join(reboundSpikeDirectory, ...lockedWasmPath.split('/'));
const sourceWasm = await readFile(sourceWasmPath);
const builtWasm = await readFile(path.join(distDirectory, wasmFiles[0]));
assertLockedWasm('原型 REBOUND WASM', sourceWasm, lockedWasmArtifact);
assertLockedWasm('生产 REBOUND WASM', builtWasm, lockedWasmArtifact);

const dynamicImports = manifest['index.html']?.dynamicImports;
if (!Array.isArray(dynamicImports)) {
  throw new Error('生产构建清单缺少动态渲染模块记录');
}
if (!dynamicImports.some((modulePath) => modulePath.endsWith('/three.webgpu.js'))) {
  throw new Error('生产构建清单缺少 Three.js WebGPU 渲染模块');
}
if (!dynamicImports.some((modulePath) => modulePath.endsWith('/three.module.js'))) {
  throw new Error('生产构建清单缺少 Three.js WebGL 渲染模块');
}

const sizes = await Promise.all(
  files.map(async (file) => {
    const content = await readFile(file);
    return {
      bytes: (await stat(file)).size,
      file: path.relative(distDirectory, file).replaceAll('\\', '/'),
      gzipBytes: gzipSync(content).byteLength,
    };
  }),
);
const totalBytes = sizes.reduce((sum, entry) => sum + entry.bytes, 0);
const totalGzipBytes = sizes.reduce((sum, entry) => sum + entry.gzipBytes, 0);

console.log(JSON.stringify({ files: sizes, totalBytes, totalGzipBytes }, null, 2));
