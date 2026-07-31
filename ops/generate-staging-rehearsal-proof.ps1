<#
================================================================================
 Generate staging-rehearsal-proof.json -- run ONLY after a real, successful
 run of ops\run-prelaunch-release-core.ps1 against the staging target.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\generate-staging-rehearsal-proof.ps1 `
        -StagingRunResultPath ops\evidence\staging-run-result.json `
        -StagingManifestPath ops\targets\staging.json `
        -RestoreProofPath ops\evidence\restore-proof.json

 The engine itself writes staging-run-result.json at the end of a real,
 successful staging run (see ops\release-stages.ps1 / New-StagingRunResult in
 ops\run-prelaunch-release-core.ps1) -- this script accepts nothing else as
 the source of the backup path, server version, or tool paths/versions. There
 is no parameter to type any of those in by hand.

 Every value in the output is either read verbatim from the manifests already
 committed to this repository, re-derived by hashing/re-invoking a file on
 disk right now, or copied from that run-result and then INDEPENDENTLY
 RE-VERIFIED against the live filesystem (the backup file's hash is
 recomputed, not trusted; the psql/pg_dump executables are re-hashed and
 re-queried for their version, not trusted). This script never connects to a
 database and never runs a rehearsal; it only assembles and re-verifies
 evidence from a rehearsal the operator already completed with the one
 release engine.
================================================================================
#>

param(
    [Parameter(Mandatory = $true)][string]$StagingRunResultPath,
    [Parameter(Mandatory = $true)][string]$StagingManifestPath,
    [Parameter(Mandatory = $true)][string]$RestoreProofPath,
    [string]$ProductionManifestPath,
    [string]$OutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ProductionManifestPath) { $ProductionManifestPath = Join-Path $RepoRoot 'ops\targets\production.json' }
if (-not $OutPath) { $OutPath = Join-Path $RepoRoot 'ops\evidence\staging-rehearsal-proof.json' }

function Fail([string]$m) { Write-Host "STOP: $m" -ForegroundColor Red; throw $m }
function Require-File([string]$path, [string]$label) { if (-not (Test-Path $path)) { Fail "$label not found: $path" } }
function Resolve-RepoPath([string]$p) { if ([IO.Path]::IsPathRooted($p)) { return $p }; return (Join-Path $RepoRoot $p) }

. (Join-Path $PSScriptRoot 'evidence-chain.ps1')

Require-File $StagingRunResultPath 'staging run result'
Require-File $StagingManifestPath 'staging manifest'
Require-File $ProductionManifestPath 'production manifest'
Require-File $RestoreProofPath 'restore proof'

$result = Get-Content $StagingRunResultPath -Raw | ConvertFrom-Json
Test-StagingRunResult $result

$restore = Get-Content $RestoreProofPath -Raw | ConvertFrom-Json
Test-RestoreProofObject $restore

$staging = Get-Content $StagingManifestPath -Raw | ConvertFrom-Json
$prod    = Get-Content $ProductionManifestPath -Raw | ConvertFrom-Json

if ($staging.environment -ne 'staging') { Fail "manifest at $StagingManifestPath is not a staging manifest (environment=$($staging.environment))" }
if ($prod.environment -ne 'production') { Fail "manifest at $ProductionManifestPath is not the production manifest (environment=$($prod.environment))" }
if ($staging.project_ref -eq $prod.project_ref) { Fail 'staging project_ref must not equal the production project_ref' }
if ($staging.purge_sql_sha256 -ne $prod.purge_sql_sha256) { Fail 'staging and production manifests disagree on purge_sql_sha256 -- they must reference the identical purge SQL' }

$requiredMajor = [int]$prod.required_pg_major
if ($result.server_version -notmatch "^$([regex]::Escape([string]$requiredMajor))\.") {
    Fail "staging run result server_version '$($result.server_version)' does not start with the required major $requiredMajor"
}

# Re-verify the backup this run claims -- never trust the recorded hash.
Require-File $result.backup_path 'staging backup (from staging run result)'
$actualBackupSha = Get-FileSha256 $result.backup_path
if ($actualBackupSha -ne $result.backup_sha256) {
    Fail "the backup file at $($result.backup_path) no longer matches the SHA-256 recorded in the staging run result"
}

# Re-verify both tool executables the same way -- path, hash, and version are
# all independently re-derived, not copied from the run result unchecked.
foreach ($pair in @(
    @{ Path = $result.psql_path; Sha = $result.psql_sha256; Version = $result.psql_version; Label = 'psql' },
    @{ Path = $result.pg_dump_path; Sha = $result.pg_dump_sha256; Version = $result.pg_dump_version; Label = 'pg_dump' }
)) {
    Require-File $pair.Path "$($pair.Label) executable (from staging run result)"
    if ((Get-FileSha256 $pair.Path) -ne $pair.Sha) { Fail "$($pair.Label) executable at $($pair.Path) no longer matches the SHA-256 recorded in the staging run result" }
    if ((Get-PgFullVersion $pair.Path) -ne $pair.Version) { Fail "$($pair.Label) executable at $($pair.Path) no longer reports the version recorded in the staging run result" }
}

if (-not $restore.trigger_reconciliation_proven -or -not $restore.rollback_proven) {
    Fail 'restore proof does not show trigger reconciliation and rollback both proven -- cannot build a staging proof on top of it'
}

$stagingCa = (Get-Content (Resolve-RepoPath $staging.ca_sha256_path) -Raw).Trim().ToLower()
$prodCa    = (Get-Content (Resolve-RepoPath $prod.ca_sha256_path) -Raw).Trim().ToLower()
if ($stagingCa -eq $prodCa) { Fail 'staging and production CA pins must not be identical' }

$proof = [ordered]@{
    tested_head_sha            = $result.head_sha
    purge_sql_sha256           = $staging.purge_sql_sha256
    purge_manifest_sha256      = Get-FileSha256 (Resolve-RepoPath 'supabase/ops/purge-manifest-v147.ts')
    migrations_148_153_sha256  = Get-MigrationRangeSha256 $RepoRoot 148 153
    staging_manifest_sha256    = Get-FileSha256 $StagingManifestPath
    production_manifest_sha256 = Get-FileSha256 $ProductionManifestPath
    staging_project_ref        = $staging.project_ref
    staging_ca_sha256          = $stagingCa
    production_ca_sha256       = $prodCa
    backup_sha256               = $actualBackupSha
    restore_proof_sha256        = Get-FileSha256 $RestoreProofPath
    trigger_proof_sha256        = Get-JsonSubsetSha256 $restore @('trigger_definition_before_sha256', 'trigger_definition_after_sha256', 'trigger_reconciliation_proven')
    rollback_proof_sha256       = Get-JsonSubsetSha256 $restore @('rollback_report_sha256', 'rollback_proven')
    exact_psql_version           = $result.psql_version
    exact_pg_dump_version        = $result.pg_dump_version
    psql_executable_path         = $result.psql_path
    pg_dump_executable_path      = $result.pg_dump_path
    psql_executable_sha256       = $result.psql_sha256
    pg_dump_executable_sha256    = $result.pg_dump_sha256
    staging_pg_version           = $result.server_version
    completed_at_utc             = $result.completed_at_utc
    staging_run_result_sha256    = Get-FileSha256 $StagingRunResultPath
}

# Self-check: the very validator every downstream consumer will run must
# already accept what we are about to write.
$roundTripped = ($proof | ConvertTo-Json -Depth 5) | ConvertFrom-Json
Test-StagingProofObject $roundTripped

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
($proof | ConvertTo-Json -Depth 5) | Set-Content -Path $OutPath -Encoding utf8

Write-Host "staging rehearsal proof written: $OutPath"
Write-Host ("SHA-256 of this file           : {0}" -f (Get-FileSha256 $OutPath))
Write-Host 'Pass this file to ops\record-owner-go.ps1 -StagingProofPath to record the owner Go decision.'
