<#
================================================================================
 Generate restore-proof.json -- run ONLY after ops\run-pg17-restore-rehearsal.ps1
 has written a passing restore-run-result.json.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\generate-restore-proof.ps1 `
        -RestoreRunReportPath ops\evidence\restore-run-result.json `
        -BackupPath <the same backup path the rehearsal restored> `
        -Confirmed

 -Confirmed alone proves nothing and no longer suffices on its own: it is the
 operator's acknowledgement, required IN ADDITION to a structured JSON report
 (-RestoreRunReportPath) that ops\run-pg17-restore-rehearsal.ps1 itself
 produced -- no field of it is typed in by hand. This script verifies every
 field of that report:

     restore_exit_code = 0
     restored_database_probe_passed = true
     migration_ceiling = 147
     keeper_verified = true
     rbac_130_415_verified = true
     trigger_definition_before_sha256 == trigger_definition_after_sha256
     deliberate_rollback_passed = true
     reconciliation_passed = true
     clone_pg_major = 17
     backup_sha256 / backup_size / backup_path / clone_server_version /
       restore_started_at_utc / restore_completed_at_utc all present and valid

 -BackupPath is required for one purpose only: to independently re-hash the
 backup file and confirm it matches what the report claims -- never trusted
 from the report alone, the same pattern
 ops\generate-staging-rehearsal-proof.ps1 uses for its own backup.

 A missing field, a false flag, a wrong value, a backup hash mismatch, or a
 report that is not valid JSON fails closed -- no proof is written. This
 script never connects to a database and never decides on its own that a
 restore succeeded; it only assembles and re-verifies evidence that already
 exists on disk from a rehearsal the operator already completed with the one
 restore tool.

 No secrets are read, computed, or written by this script.
================================================================================
#>

param(
    [Parameter(Mandatory = $true)][string]$RestoreRunReportPath,
    [Parameter(Mandatory = $true)][string]$BackupPath,
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

Require-File $RestoreRunReportPath 'restore run result'
Require-File $BackupPath 'backup'

$reportRaw = Get-Content $RestoreRunReportPath -Raw
try { $report = $reportRaw | ConvertFrom-Json } catch { Fail "restore run result is not valid JSON: $RestoreRunReportPath" }

# The single point where a report is judged genuine. Anything short of every
# field matching exactly fails here, before any proof is assembled.
Test-RestoreRunReport $report

# Re-verify the backup independently -- never trust the report's own claim.
$actualBackupSha = Get-FileSha256 $BackupPath
if ($actualBackupSha -ne $report.backup_sha256) {
    Fail "the backup file at $BackupPath no longer matches the SHA-256 recorded in the restore run result"
}

$proof = [ordered]@{
    backup_sha256                          = $actualBackupSha
    backup_size                            = [int64]$report.backup_size
    restore_started_at_utc                 = $report.restore_started_at_utc
    restore_completed_at_utc               = $report.restore_completed_at_utc
    clone_server_version                   = $report.clone_server_version
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
