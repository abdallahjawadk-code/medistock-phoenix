<#
================================================================================
 Generate restore-proof.json -- run ONLY after a real, successful restore of a
 Production backup onto a local PostgreSQL 17 rehearsal clone.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\generate-restore-proof.ps1 `
        -BackupPath <path to pre-purge.dump> `
        -RestoreStartedAtUtc <ISO-8601 UTC> `
        -RestoreCompletedAtUtc <ISO-8601 UTC> `
        -CloneServerVersion <full "postgres --version" style string> `
        -RestoreRunReportPath <path to a structured JSON report from the restore tooling> `
        -Confirmed

 -Confirmed alone proves nothing and no longer suffices on its own: it is the
 operator's acknowledgement, required IN ADDITION to a structured JSON report
 (-RestoreRunReportPath) that the restore tooling itself produced. That report
 must show, and this script verifies every field of:

     restore_exit_code = 0
     restored_database_probe_passed = true
     migration_ceiling = 147
     keeper_verified = true
     rbac_130_415_verified = true
     trigger_definition_before_sha256 == trigger_definition_after_sha256
     deliberate_rollback_passed = true
     reconciliation_passed = true
     clone_pg_major = 17

 A missing field, a false flag, a wrong value, or a report that is not valid
 JSON fails closed -- no proof is written. This script never connects to a
 database and never decides on its own that a restore succeeded; it only
 assembles and hashes evidence that already exists on disk from a run the
 operator already completed.

 No secrets are read, computed, or written by this script.
================================================================================
#>

param(
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [Parameter(Mandatory = $true)][string]$RestoreStartedAtUtc,
    [Parameter(Mandatory = $true)][string]$RestoreCompletedAtUtc,
    [Parameter(Mandatory = $true)][string]$CloneServerVersion,
    [Parameter(Mandatory = $true)][string]$RestoreRunReportPath,
    [Parameter(Mandatory = $true)][switch]$Confirmed,
    [string]$OutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutPath) { $OutPath = Join-Path $RepoRoot 'ops\evidence\restore-proof.json' }

function Fail([string]$m) { Write-Host "STOP: $m" -ForegroundColor Red; throw $m }
function Require-File([string]$path, [string]$label) {
    if (-not (Test-Path $path)) { Fail "$label not found: $path" }
    if ((Get-Item $path).Length -eq 0) { Fail "$label is empty: $path" }
}

. (Join-Path $PSScriptRoot 'evidence-chain.ps1')

if (-not $Confirmed) {
    Fail '-Confirmed is required but is not sufficient on its own -- it must accompany a passing -RestoreRunReportPath. Nothing was written.'
}

Require-File $BackupPath 'backup'
Require-File $RestoreRunReportPath 'restore run report'
if ([string]::IsNullOrWhiteSpace($CloneServerVersion)) { Fail 'CloneServerVersion must not be empty' }
Test-Iso8601Utc $RestoreStartedAtUtc 'RestoreStartedAtUtc'
Test-Iso8601Utc $RestoreCompletedAtUtc 'RestoreCompletedAtUtc'
$startedAt = ConvertTo-UtcDateTime $RestoreStartedAtUtc 'RestoreStartedAtUtc'
$completedAt = ConvertTo-UtcDateTime $RestoreCompletedAtUtc 'RestoreCompletedAtUtc'
if ($completedAt -lt $startedAt) { Fail 'RestoreCompletedAtUtc is before RestoreStartedAtUtc' }

$reportRaw = Get-Content $RestoreRunReportPath -Raw
try { $report = $reportRaw | ConvertFrom-Json } catch { Fail "restore run report is not valid JSON: $RestoreRunReportPath" }

# The single point where a report is judged genuine. Anything short of every
# field matching exactly fails here, before any proof is assembled.
Test-RestoreRunReport $report

$proof = [ordered]@{
    backup_sha256                          = Get-FileSha256 $BackupPath
    backup_size                            = (Get-Item $BackupPath).Length
    restore_started_at_utc                 = $RestoreStartedAtUtc
    restore_completed_at_utc               = $RestoreCompletedAtUtc
    clone_server_version                   = $CloneServerVersion
    clone_pg_major                         = [int]$report.clone_pg_major
    restore_exit_code                      = [int]$report.restore_exit_code
    restored_database_probe_passed         = [bool]$report.restored_database_probe_passed
    migration_ceiling                      = [int]$report.migration_ceiling
    keeper_verified                        = [bool]$report.keeper_verified
    rbac_130_415_verified                  = [bool]$report.rbac_130_415_verified
    pre_purge_reconciliation_report_sha256 = $report.pre_purge_reconciliation_report_sha256
    trigger_definition_before_sha256       = $report.trigger_definition_before_sha256
    trigger_definition_after_sha256        = $report.trigger_definition_after_sha256
    trigger_reconciliation_proven          = $true
    rollback_report_sha256                 = $report.rollback_report_sha256
    rollback_proven                        = $true
    deliberate_rollback_passed             = [bool]$report.deliberate_rollback_passed
    reconciliation_passed                  = [bool]$report.reconciliation_passed
    restore_run_report_sha256              = Get-FileSha256 $RestoreRunReportPath
    proof_generated_at_utc                 = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

# Self-check: the very validator every downstream consumer will run must
# already accept what we are about to write.
$roundTripped = ($proof | ConvertTo-Json -Depth 5) | ConvertFrom-Json
Test-RestoreProofObject $roundTripped

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
($proof | ConvertTo-Json -Depth 5) | Set-Content -Path $OutPath -Encoding utf8

Write-Host "restore proof written: $OutPath"
Write-Host ("SHA-256 of this file : {0}" -f (Get-FileSha256 $OutPath))
Write-Host 'Pass this file to ops\generate-staging-rehearsal-proof.ps1 -RestoreProofPath after a successful staging rehearsal.'
