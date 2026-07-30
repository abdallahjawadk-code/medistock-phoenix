<#
================================================================================
 Generate staging-rehearsal-proof.json -- run ONLY after a real, successful
 run of ops\run-prelaunch-release-core.ps1 against the staging target.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\generate-staging-rehearsal-proof.ps1 `
        -StagingManifestPath ops\targets\staging.json `
        -RestoreProofPath ops\evidence\restore-proof.json `
        -BackupPath <path to the staging run's pre-purge.dump> `
        -StagingServerVersion <full "SELECT version()" style string, must start with the required major> `
        -PsqlExecutablePath <the exact psql.exe the staging run resolved and logged> `
        -PgDumpExecutablePath <the exact pg_dump.exe the staging run resolved and logged>

 Every value in the output is either read verbatim from the manifests already
 committed to this repository, or recomputed by hashing a file on disk right
 now -- nothing is typed in by hand as a hash. This script never connects to
 a database and never runs a rehearsal; it only assembles evidence from a
 rehearsal the operator already completed with the one release engine.
================================================================================
#>

param(
    [Parameter(Mandatory = $true)][string]$StagingManifestPath,
    [Parameter(Mandatory = $true)][string]$RestoreProofPath,
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [Parameter(Mandatory = $true)][string]$StagingServerVersion,
    [Parameter(Mandatory = $true)][string]$PsqlExecutablePath,
    [Parameter(Mandatory = $true)][string]$PgDumpExecutablePath,
    [string]$ProductionManifestPath,
    [string]$OutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ProductionManifestPath) { $ProductionManifestPath = Join-Path $RepoRoot 'ops\targets\production.json' }
if (-not $OutPath) { $OutPath = Join-Path $RepoRoot 'ops\evidence\staging-rehearsal-proof.json' }

function Fail([string]$m) { Write-Host "STOP: $m" -ForegroundColor Red; throw $m }
function Get-FileSha256([string]$path) { return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }
function Require-File([string]$path, [string]$label) { if (-not (Test-Path $path)) { Fail "$label not found: $path" } }
function Resolve-RepoPath([string]$p) { if ([IO.Path]::IsPathRooted($p)) { return $p }; return (Join-Path $RepoRoot $p) }

Require-File $StagingManifestPath 'staging manifest'
Require-File $ProductionManifestPath 'production manifest'
Require-File $RestoreProofPath 'restore proof'
Require-File $BackupPath 'staging backup'
Require-File $PsqlExecutablePath 'psql executable'
Require-File $PgDumpExecutablePath 'pg_dump executable'

$staging = Get-Content $StagingManifestPath -Raw | ConvertFrom-Json
$prod    = Get-Content $ProductionManifestPath -Raw | ConvertFrom-Json

if ($staging.environment -ne 'staging') { Fail "manifest at $StagingManifestPath is not a staging manifest (environment=$($staging.environment))" }
if ($prod.environment -ne 'production') { Fail "manifest at $ProductionManifestPath is not the production manifest (environment=$($prod.environment))" }
if ($staging.project_ref -eq $prod.project_ref) { Fail 'staging project_ref must not equal the production project_ref' }
if ($staging.purge_sql_sha256 -ne $prod.purge_sql_sha256) { Fail 'staging and production manifests disagree on purge_sql_sha256 -- they must reference the identical purge SQL' }

$requiredMajor = [int]$prod.required_pg_major
if ($StagingServerVersion -notmatch "^$([regex]::Escape([string]$requiredMajor))\.") {
    Fail "StagingServerVersion '$StagingServerVersion' does not start with the required major $requiredMajor"
}

Push-Location $RepoRoot
try {
    $head = (& git rev-parse HEAD).Trim()
    $dirty = @(& git status --porcelain | Where-Object { $_ -notmatch 'supabase/\.temp' })
    if ($dirty.Count -gt 0) { Fail ("worktree is dirty -- rehearsal proof must be generated from a clean, committed tree:`n" + ($dirty -join "`n")) }
} finally { Pop-Location }

function Get-MigrationRangeSha256([int]$from, [int]$to) {
    $dir = Join-Path $RepoRoot 'supabase\migrations'
    $bytes = New-Object System.Collections.Generic.List[byte]
    for ($n = $from; $n -le $to; $n++) {
        $pat = '{0:d3}_*.sql' -f $n
        $f = Get-ChildItem $dir -Filter $pat -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
        if (-not $f) { Fail "migration $n not found in $dir" }
        $bytes.AddRange([IO.File]::ReadAllBytes($f.FullName))
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes.ToArray())
        return ([BitConverter]::ToString($hash) -replace '-', '').ToLower()
    } finally { $sha.Dispose() }
}

$restore = Get-Content $RestoreProofPath -Raw | ConvertFrom-Json
foreach ($flag in @('trigger_reconciliation_proven', 'rollback_proven')) {
    if (-not $restore.$flag) { Fail "restore proof reports $flag = false -- cannot build a staging proof on top of it" }
}

$stagingCa = (Get-Content (Resolve-RepoPath $staging.ca_sha256_path) -Raw).Trim().ToLower()
$prodCa    = (Get-Content (Resolve-RepoPath $prod.ca_sha256_path) -Raw).Trim().ToLower()
if ($stagingCa -eq $prodCa) { Fail 'staging and production CA pins must not be identical' }

# trigger/rollback proof: hash the exact subset of the restore proof that
# attests each, so a change to either invalidates only that half of the chain.
function Get-JsonSubsetSha256($obj, [string[]]$keys) {
    $subset = [ordered]@{}
    foreach ($k in $keys) { $subset[$k] = $obj.$k }
    $json = $subset | ConvertTo-Json -Depth 5 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes)
        return ([BitConverter]::ToString($hash) -replace '-', '').ToLower()
    } finally { $sha.Dispose() }
}

$proof = [ordered]@{
    tested_head_sha             = $head
    purge_sql_sha256            = $staging.purge_sql_sha256
    purge_manifest_sha256       = Get-FileSha256 (Resolve-RepoPath 'supabase/ops/purge-manifest-v147.ts')
    migrations_148_153_sha256   = Get-MigrationRangeSha256 148 153
    staging_manifest_sha256     = Get-FileSha256 $StagingManifestPath
    production_manifest_sha256  = Get-FileSha256 $ProductionManifestPath
    staging_project_ref         = $staging.project_ref
    staging_ca_sha256           = $stagingCa
    production_ca_sha256        = $prodCa
    backup_sha256               = Get-FileSha256 $BackupPath
    restore_proof_sha256        = Get-FileSha256 $RestoreProofPath
    trigger_proof_sha256        = Get-JsonSubsetSha256 $restore @('trigger_definition_before_sha256', 'trigger_definition_after_sha256', 'trigger_reconciliation_proven')
    rollback_proof_sha256       = Get-JsonSubsetSha256 $restore @('rollback_report_sha256', 'rollback_proven')
    exact_psql_version          = (& $PsqlExecutablePath --version 2>&1 | Select-Object -First 1).ToString().Trim()
    exact_pg_dump_version       = (& $PgDumpExecutablePath --version 2>&1 | Select-Object -First 1).ToString().Trim()
    psql_executable_path        = $PsqlExecutablePath
    pg_dump_executable_path     = $PgDumpExecutablePath
    psql_executable_sha256      = Get-FileSha256 $PsqlExecutablePath
    pg_dump_executable_sha256   = Get-FileSha256 $PgDumpExecutablePath
    staging_pg_version          = $StagingServerVersion
    completed_at_utc            = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
($proof | ConvertTo-Json -Depth 5) | Set-Content -Path $OutPath -Encoding utf8

Write-Host "staging rehearsal proof written: $OutPath"
Write-Host ("SHA-256 of this file           : {0}" -f (Get-FileSha256 $OutPath))
Write-Host 'Pass this file to ops\record-owner-go.ps1 -StagingProofPath to record the owner Go decision.'
