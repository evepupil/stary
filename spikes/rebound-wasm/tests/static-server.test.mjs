import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  contentTypeFor,
  resolveAssetPath,
} from "../scripts/static-server.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname.slice(1));

test("static server assigns executable MIME types to modules and WebAssembly", () => {
  assert.equal(
    contentTypeFor("rebound.mjs"),
    "application/javascript; charset=utf-8",
  );
  assert.equal(contentTypeFor("rebound.wasm"), "application/wasm");
});

test("static server resolves only web and dist assets inside the spike", () => {
  assert.equal(
    resolveAssetPath(root, "/web/physics-worker.mjs?run=1"),
    path.join(root, "web", "physics-worker.mjs"),
  );
  assert.equal(
    resolveAssetPath(root, "/dist/rebound.wasm"),
    path.join(root, "dist", "rebound.wasm"),
  );
  assert.throws(() => resolveAssetPath(root, "/.cache/source.tar.gz"), /not exposed/);
});

test("static server rejects encoded and backslash path traversal", () => {
  assert.throws(
    () => resolveAssetPath(root, "/web/%2e%2e/%2e%2e/LICENSE"),
    /path traversal/,
  );
  assert.throws(
    () => resolveAssetPath(root, "/web%5c..%5c..%5cLICENSE"),
    /path traversal/,
  );
});
