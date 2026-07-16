[CmdletBinding()]
param(
    [switch]$RunTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$crateRoot = Split-Path -Parent $PSScriptRoot
$image = "rust:1.96.0-bookworm@sha256:c993d32d95cc146bd12c84d66f0b924a6a96f3988325f39c144f2f9893dea120"
$dockerArguments = @(
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--mount",
    "type=bind,source=$crateRoot,target=/work",
    "--workdir",
    "/work"
)

if ($RunTests) {
    $dockerArguments += @("--env", "STARY_COLLISION_RUN_TESTS=1")
}

$dockerArguments += @($image, "bash", "scripts/build-in-container.sh")
& docker @dockerArguments
if ($LASTEXITCODE -ne 0) {
    throw "Fixed collision WASM build failed with exit code $LASTEXITCODE."
}
