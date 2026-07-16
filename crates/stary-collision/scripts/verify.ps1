[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$crateRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot "build.ps1") -RunTests
if ($LASTEXITCODE -ne 0) { throw "Fixed-container collision build or Rust tests failed." }

Push-Location $crateRoot
try {
    & node scripts/verify-artifacts.mjs
    if ($LASTEXITCODE -ne 0) { throw "Collision WASM artifact verification failed." }
    & node scripts/verify-exports.mjs
    if ($LASTEXITCODE -ne 0) { throw "Collision WASM export verification failed." }
}
finally {
    Pop-Location
}
