<#
================================================================================
 Generate restore-proof.json -- run ONLY after a real, successful restore of a
 Production backup onto a local PostgreSQL 17 rehearsal clone.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\generate-restore-proof.ps1 `
        -BackupPath <path to pre-purge.dump> `
        -RestoreStartedAtUtc <ISO-8601 UTC> `
        -CloneServerVersion <full "postgres --version" style string> `
        -PrePurgeReconciliationReportPath <path> `
        -TriggerDefinitionBeforePath <path> `
        -TriggerDefinitionAfterPath <path> `
        -RollbackReportPath <path> `
        -Confirmed

 This script never connects to a database, never runs a restore, and never
 decides on its own that a restore succeeded. It only assembles and hashes
 evidence that already exists on disk from a run the operator already
 completed and reviewed. -Confirmed is mandatory and is the operator's
 explicit statement that they reviewed the reconciliation, trigger and
 rollback reports referenced below and that all three proved out -- the
 script will not fabricate a passing proof silently.

 No secrets are read, computed, or written by this script.
================================================================================
#>

param(
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [Parameter(Mandatory = $true)][string]$RestoreStartedAtUtc,
    [Parameter(Mandatory = $true)][string]$CloneServerVersion,
    [Parameter(Mandatory = $true)][string]$PrePurgeReconciliationReportPath,
    [Parameter(Mandatory = $true)][string]$TriggerDefinitionBeforePath,
    [Parameter(Mandatory = $true)][string]$TriggerDefinitionAfterPath,
    [Parameter(Mandatory = $true)][string]$RollbackReportPath,
    [Parameter(Mandatory = $true)][switch]$Confirmed,
    [string]$OutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutPath) { $OutPath = Join-Path $RepoRoot 'ops\evidence\restore-proof.json' }

function Fail([string]$m) { Write-Host "STOP: $m" -ForegroundColor Red; throw $m }
function Get-FileSha256([string]$path) { return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }
function Require-File([string]$path, [string]$label) {
    if (-not (Test-Path $path)) { Fail "$label not found: $path" }
    if ((Get-Item $path).Length -eq 0) { Fail "$label is empty: $path" }
}
function Require-Iso8601Utc([string]$v, [string]$label) {
    if ($v -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') { Fail "$label must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ), got: $v" }
}

if (-not $Confirmed) {
    Fail 'this script only writes a proof after -Confirmed is passed, meaning the operator has reviewed the reconciliation, trigger and rollback reports and confirms they all passed'
}

Require-File $BackupPath 'backup'
Require-File $PrePurgeReconciliationReportPath 'pre-purge reconciliation report'
Require-File $TriggerDefinitionBeforePath 'trigger definition (before)'
Require-File $TriggerDefinitionAfterPath 'trigger definition (after)'
Require-File $RollbackReportPath 'rollback report'
Require-Iso8601Utc $RestoreStartedAtUtc 'RestoreStartedAtUtc'
if ([string]::IsNullOrWhiteSpace($CloneServerVersion)) { Fail 'CloneServerVersion must not be empty' }

$proof = [ordered]@{
    backup_sha256                           = Get-FileSha256 $BackupPath
    backup_size                             = (Get-Item $BackupPath).Length
    restore_started_at_utc                  = $RestoreStartedAtUtc
    restore_completed_at_utc                = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    clone_server_version                    = $CloneServerVersion
    pre_purge_reconciliation_report_sha256  = Get-FileSha256 $PrePurgeReconciliationReportPath
    trigger_definition_before_sha256        = Get-FileSha256 $TriggerDefinitionBeforePath
    trigger_definition_after_sha256         = Get-FileSha256 $TriggerDefinitionAfterPath
    trigger_reconciliation_proven           = $true
    rollback_report_sha256                  = Get-FileSha256 $RollbackReportPath
    rollback_proven                         = $true
    proof_generated_at_utc                  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
($proof | ConvertTo-Json -Depth 5) | Set-Content -Path $OutPath -Encoding utf8

Write-Host "restore proof written: $OutPath"
Write-Host ("SHA-256 of this file : {0}" -f (Get-FileSha256 $OutPath))
Write-Host 'Pass this file to ops\generate-staging-rehearsal-proof.ps1 -RestoreProofPath after a successful staging rehearsal.'
