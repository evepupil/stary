import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const spikeRoot = fileURLToPath(new URL("../", import.meta.url));
const fetchScript = path.join(spikeRoot, "scripts", "fetch-source.ps1");
const sourceRoot = path.join(
  spikeRoot,
  ".cache",
  "rebound-cabb68a03ebb4f3f1c71c6ff8cde33a1476ac417",
);
const tamperMarker = path.join(sourceRoot, "STARY-TAMPERED-SOURCE");
const simulationSource = path.join(sourceRoot, "src", "simulation.c");
const workerPatch = path.join(
  spikeRoot,
  "patches",
  "rebound-5.0.1-worker-no-emscripten-sleep.patch",
);
const containerBuildScript = path.join(spikeRoot, "scripts", "build-in-container.sh");

function fetchSource() {
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fetchScript],
    { stdio: "pipe" },
  );
}

test("fetch script recreates a clean source tree from the verified archive", async () => {
  fetchSource();
  await writeFile(tamperMarker, "tampered", "utf8");
  try {
    fetchSource();
    await assert.rejects(access(tamperMarker), { code: "ENOENT" });
  } finally {
    await rm(tamperMarker, { force: true });
  }
});

test("build flow includes the audited dedicated-worker patch", async () => {
  const patchText = await readFile(workerPatch, "utf8");
  assert.match(patchText, /^-\s*emscripten_sleep\(0\); \/\/ allow drawing and event handling$/mu);
  assert.doesNotMatch(patchText, /^\+.*reb_simulation_/mu);

  fetchSource();
  const sourceText = await readFile(simulationSource, "utf8");
  const buildScript = await readFile(containerBuildScript, "utf8");
  assert.match(sourceText, /while\(reb_check_exit\(/u);
  assert.match(sourceText, /emscripten_sleep\(0\); \/\/ allow drawing and event handling/u);
  assert.match(
    buildScript,
    /patch --forward --batch --fuzz=0 --directory="\$\{source_dir\}" -p1/u,
  );
});
