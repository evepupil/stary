import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const crateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = path.join(crateRoot, 'dist', 'stary_collision.wasm');
const wasm = await readFile(artifactPath);
const module = await WebAssembly.compile(wasm);
const imports = WebAssembly.Module.imports(module);
if (imports.length !== 0) {
  throw new Error(
    `Collision WASM must not import host functions or memory: ${JSON.stringify(imports)}`,
  );
}

const exports = WebAssembly.Module.exports(module);
const functionExports = exports
  .filter((entry) => entry.kind === 'function')
  .map((entry) => entry.name)
  .toSorted();
const expectedFunctions = [
  'stary_collision_abi_version',
  'stary_collision_alloc',
  'stary_collision_buffer_len',
  'stary_collision_buffer_ptr',
  'stary_collision_create',
  'stary_collision_destroy',
  'stary_collision_live_count',
  'stary_collision_resolve',
].toSorted();
if (
  functionExports.length !== expectedFunctions.length ||
  functionExports.some((name, index) => name !== expectedFunctions[index])
) {
  throw new Error(
    `Collision WASM function exports must be exactly ${expectedFunctions.join(', ')}; found: ${functionExports.join(', ')}`,
  );
}

const memoryExports = exports.filter((entry) => entry.kind === 'memory');
if (memoryExports.length !== 1 || memoryExports[0].name !== 'memory') {
  throw new Error(`Collision WASM must export exactly one memory named memory`);
}
if (exports.some((entry) => entry.kind === 'table' || entry.kind === 'tag')) {
  throw new Error(`Collision WASM must not export tables or exception tags`);
}

const { instance } = await WebAssembly.instantiate(wasm, {});
const {
  memory,
  stary_collision_abi_version: abiVersionFunction,
  stary_collision_alloc: allocate,
  stary_collision_buffer_len: bufferLength,
  stary_collision_buffer_ptr: bufferPointer,
  stary_collision_create: create,
  stary_collision_destroy: destroy,
  stary_collision_live_count: liveCount,
  stary_collision_resolve: resolve,
} = instance.exports;
const abiVersion = abiVersionFunction();
if (abiVersion !== 1) {
  throw new Error(`Collision WASM ABI version mismatch: expected 1, got ${abiVersion}`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const request = encoder.encode('{}');
const token = create();
if (token === 0 || liveCount() !== 1) {
  throw new Error(`Collision WASM failed to create one live context`);
}
if (allocate(token, request.byteLength) !== 0) {
  throw new Error(`Collision WASM failed to allocate a request buffer`);
}
const requestPointer = bufferPointer(token);
if (requestPointer === 0 || bufferLength(token) !== request.byteLength) {
  throw new Error(`Collision WASM request buffer metadata is invalid`);
}
new Uint8Array(memory.buffer, requestPointer, request.byteLength).set(request);
if (resolve(token) !== 0) {
  throw new Error(`Collision WASM failed to resolve a malformed request into an error envelope`);
}
const responsePointer = bufferPointer(token);
const responseLength = bufferLength(token);
const response = JSON.parse(
  decoder.decode(new Uint8Array(memory.buffer, responsePointer, responseLength)),
);
if (response.kind !== 'error' || response.error?.code !== 'malformedInput') {
  throw new Error(`Collision WASM malformed request did not return the fixed error envelope`);
}
if (resolve(token) !== 1) {
  throw new Error(`Collision WASM accepted a repeated resolve`);
}
if (destroy(token) !== 0 || destroy(token) !== 1 || liveCount() !== 0) {
  throw new Error(`Collision WASM destroy lifecycle is not idempotently guarded`);
}
const replacement = create();
if (replacement === 0 || replacement === token || allocate(token, 2) !== 1) {
  throw new Error(`Collision WASM reused or accepted a stale token`);
}
if (destroy(replacement) !== 0 || liveCount() !== 0) {
  throw new Error(`Collision WASM leaked the replacement context`);
}

console.log(
  `Collision WASM exports verified: ABI ${abiVersion}, ${functionExports.length} functions, one memory, guarded lifecycle, no imports.`,
);
