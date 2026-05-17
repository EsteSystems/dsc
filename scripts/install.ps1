# Install dsc globally from a local tarball (built by `npm run package`).
#
# Usage:
#   .\scripts\install.ps1                          # auto-find pkg\dsc-*.tgz
#   .\scripts\install.ps1 C:\path\to\dsc-X.Y.Z.tgz
#
# Windows PowerShell. For Linux / macOS, see install.sh.

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if ($args.Count -ge 1 -and $args[0]) {
    $Tarball = $args[0]
} else {
    $candidates = Get-ChildItem -Path (Join-Path $RepoRoot "pkg") -Filter "*.tgz" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if (-not $candidates) {
        Write-Error "no tarball found in $RepoRoot\pkg\. Run ``npm run package`` first."
        exit 1
    }
    $Tarball = $candidates[0].FullName
}

if (-not (Test-Path $Tarball)) {
    Write-Error "tarball not found: $Tarball"
    exit 1
}

Write-Host "▶ installing $Tarball globally"
npm install -g $Tarball
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed"
    exit $LASTEXITCODE
}

$dsc = Get-Command dsc -ErrorAction SilentlyContinue
if ($dsc) {
    Write-Host ""
    Write-Host "✓ dsc installed: $($dsc.Source)"
    Write-Host "  next: run 'dsc' and use '/api-key sk-...' to save your DeepSeek key"
} else {
    Write-Host ""
    Write-Host "✓ install completed but ``dsc`` is not on PATH."
    Write-Host "  bin lives at: $(npm config get prefix)"
    Write-Host "  add that directory to PATH and reopen the terminal."
}
