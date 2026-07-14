[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$spikeRoot = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot "build.ps1")
if ($LASTEXITCODE -ne 0) { throw "Fixed-container build failed." }

Push-Location $spikeRoot
try {
    & node --test tests/*.test.mjs
    if ($LASTEXITCODE -ne 0) { throw "Node test gate failed." }
    & node scripts/run-acceptance.mjs
    if ($LASTEXITCODE -ne 0) { throw "Numerical acceptance gate failed." }
    & node scripts/verify-artifacts.mjs
    if ($LASTEXITCODE -ne 0) { throw "Artifact lock gate failed." }
}
finally {
    Pop-Location
}
