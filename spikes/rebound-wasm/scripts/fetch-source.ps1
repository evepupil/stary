[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$spikeRoot = Split-Path -Parent $PSScriptRoot
$lock = Get-Content -Raw (Join-Path $spikeRoot "source-lock.json") | ConvertFrom-Json
$cacheRoot = Join-Path $spikeRoot ".cache"
$archivePath = Join-Path $cacheRoot ("rebound-{0}.tar.gz" -f $lock.commit)
$sourcePath = Join-Path $cacheRoot ("rebound-{0}" -f $lock.commit)

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

if (-not (Test-Path -LiteralPath $archivePath)) {
    $downloadPath = "$archivePath.download"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $lock.sourceUrl -OutFile $downloadPath
            break
        }
        catch {
            Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
            if ($attempt -eq 3) { throw }
        }
    }
    Move-Item -LiteralPath $downloadPath -Destination $archivePath
}

$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
if ($actualHash -ne $lock.sha256) {
    throw "REBOUND source SHA-256 mismatch. Expected $($lock.sha256), got $actualHash."
}

$resolvedCacheRoot = [IO.Path]::GetFullPath($cacheRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedSourcePath = [IO.Path]::GetFullPath($sourcePath)
$expectedPrefix = "$resolvedCacheRoot$([IO.Path]::DirectorySeparatorChar)"
if (-not $resolvedSourcePath.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace source outside the spike cache: $resolvedSourcePath"
}

if (Test-Path -LiteralPath $sourcePath) {
    Remove-Item -LiteralPath $sourcePath -Recurse -Force
}
& tar -xzf $archivePath -C $cacheRoot
if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE."
}

$actualVersion = (Get-Content -Raw (Join-Path $sourcePath "version.txt")).Trim()
if ($actualVersion -ne $lock.version) {
    throw "REBOUND version mismatch. Expected $($lock.version), got $actualVersion."
}

$previousGitCeiling = $env:GIT_CEILING_DIRECTORIES
$env:GIT_CEILING_DIRECTORIES = $resolvedCacheRoot
try {
    foreach ($patch in $lock.patches) {
        $patchPath = Join-Path $spikeRoot $patch.path
        if (-not (Test-Path -LiteralPath $patchPath)) {
            throw "Required REBOUND patch is missing: $patchPath"
        }
        $actualPatchHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $patchPath).Hash
        if ($actualPatchHash -ne $patch.sha256) {
            throw "REBOUND patch SHA-256 mismatch for $($patch.path). Expected $($patch.sha256), got $actualPatchHash."
        }

        & git -C $sourcePath apply --check --unidiff-zero --whitespace=nowarn $patchPath
        if ($LASTEXITCODE -ne 0) {
            throw "REBOUND patch check failed for $($patch.path)."
        }
    }
}
finally {
    $env:GIT_CEILING_DIRECTORIES = $previousGitCeiling
}

Write-Output $sourcePath
