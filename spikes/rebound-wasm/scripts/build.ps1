[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$spikeRoot = Split-Path -Parent $PSScriptRoot
$lock = Get-Content -Raw (Join-Path $spikeRoot "source-lock.json") | ConvertFrom-Json
$image = "{0}@{1}" -f $lock.buildImage.Split(":")[0], $lock.buildImageDigest

& (Join-Path $PSScriptRoot "fetch-source.ps1") | Out-Host
& docker run --rm `
    --mount "type=bind,source=$spikeRoot,target=/work" `
    --workdir /work `
    $image `
    bash scripts/build-in-container.sh

if ($LASTEXITCODE -ne 0) {
    throw "Docker build failed with exit code $LASTEXITCODE."
}
