import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(projectRoot, 'dist');
const reboundSpikeDirectory = path.join(projectRoot, 'spikes', 'rebound-wasm');
const artifactLockPath = path.join(reboundSpikeDirectory, 'artifact-lock.json');
const lockedGluePath = 'dist/rebound.mjs';
const lockedWasmPath = 'dist/rebound.wasm';

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

function readLockedArtifact(artifactLock, artifactPath) {
  if (!Array.isArray(artifactLock?.artifacts)) {
    throw new Error('artifact-lock.json 缺少 artifacts 数组');
  }

  const matches = artifactLock.artifacts.filter((artifact) => artifact?.path === artifactPath);
  if (matches.length !== 1) {
    throw new Error(`artifact-lock.json 应恰好锁定一个 ${artifactPath}`);
  }

  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new Error(`${artifactPath} 的锁定字节数无效`);
  }
  if (typeof artifact.sha256 !== 'string' || !/^[A-F0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`${artifactPath} 的锁定 SHA-256 无效`);
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
const lockedGlueArtifact = readLockedArtifact(artifactLock, lockedGluePath);
const lockedWasmArtifact = readLockedArtifact(artifactLock, lockedWasmPath);
const files = await listFiles(distDirectory);
const relativeFiles = files.map((file) => path.relative(distDirectory, file).replaceAll('\\', '/'));

const sourceMaps = relativeFiles.filter((file) => file.endsWith('.map'));
if (sourceMaps.length > 0) {
  throw new Error(`生产构建包含 source map: ${sourceMaps.join(', ')}`);
}

const workerFiles = relativeFiles.filter(
  (file) => file.includes('physics.worker') && file.endsWith('.js'),
);
if (workerFiles.length !== 1) {
  throw new Error(`应产出一个正式物理模块 Worker，实际为 ${workerFiles.length} 个`);
}
if (relativeFiles.some((file) => file.includes('foundation.worker'))) {
  throw new Error('生产构建仍包含旧 foundation Worker');
}

const wasmFiles = relativeFiles.filter((file) => file.endsWith('.wasm'));
if (wasmFiles.length !== 1) {
  throw new Error(`应产出一个 REBOUND WASM 资源，实际为 ${wasmFiles.length} 个`);
}

const manifest = JSON.parse(
  await readFile(path.join(distDirectory, '.vite', 'manifest.json'), 'utf8'),
);
const sourceWasmPath = path.join(reboundSpikeDirectory, ...lockedWasmPath.split('/'));
const sourceGluePath = path.join(reboundSpikeDirectory, ...lockedGluePath.split('/'));
const sourceGlue = await readFile(sourceGluePath);
const sourceWasm = await readFile(sourceWasmPath);
const builtWasm = await readFile(path.join(distDirectory, wasmFiles[0]));
const builtWorker = await readFile(path.join(distDirectory, workerFiles[0]), 'utf8');
assertLockedWasm('正式层使用的 REBOUND 胶水模块', sourceGlue, lockedGlueArtifact);
assertLockedWasm('原型 REBOUND WASM', sourceWasm, lockedWasmArtifact);
assertLockedWasm('生产 REBOUND WASM', builtWasm, lockedWasmArtifact);
if (!builtWorker.includes('_stary_reb_create') || !builtWorker.includes('_stary_reb_integrate')) {
  throw new Error('正式物理 Worker 没有包含锁定 REBOUND 胶水模块的关键导出');
}
const builtWasmFileName = path.posix.basename(wasmFiles[0]);
if (!builtWorker.includes(builtWasmFileName)) {
  throw new Error(`正式物理 Worker 没有引用唯一 REBOUND WASM 产物 ${builtWasmFileName}`);
}

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
if (!dynamicImports.some((modulePath) => modulePath.endsWith('/observatory-scene.ts'))) {
  throw new Error('生产构建清单缺少按需加载的观测场景模块');
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
