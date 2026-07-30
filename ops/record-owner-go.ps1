<#
================================================================================
 Record the owner's Go decision for a Production release -- run ONLY after
 ops\generate-staging-rehearsal-proof.ps1 produced a passing staging proof.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\record-owner-go.ps1 `
        [-StagingProofPath ops\evidence\staging-rehearsal-proof.json] `
        [-ExpectedProductionHead <40-hex commit sha, defaults to current HEAD>]

 Verifies the staging proof, prints its summary, then asks the owner to type
 an exact confirmation phrase and their identity. Nothing is entered on the
 owner's behalf and no credential of any kind is requested here -- this
 script never connects to a database.
================================================================================
#>

param(
    [string]$StagingProofPath,
    [string]$ExpectedProductionHead,
    [string]$OutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $StagingProofPath) { $StagingProofPath = Join-Path $RepoRoot 'ops\evidence\staging-rehearsal-proof.json' }
if (-not $OutPath)          { $OutPath          = Join-Path $RepoRoot 'ops\evidence\owner-go.json' }

$ConfirmPhrase = 'I AUTHORIZE THE PRODUCTION RELEASE'

function Fail([string]$m) { Write-Host "STOP: $m" -ForegroundColor Red; throw $m }
function Get-FileSha256([string]$path) { return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }
function Section([string]$t) { Write-Host ''; Write-Host ('=' * 78); Write-Host "  $t"; Write-Host ('=' * 78) }
function Require-NonPlaceholder([string]$v, [string]$label) {
    if ([string]::IsNullOrWhiteSpace($v)) { Fail "$label is empty" }
    if ($v -match '(?i)placeholder|\bexample\b|\bTODO\b') { Fail "$label looks like a placeholder: $v" }
}

if (-not (Test-Path $StagingProofPath)) { Fail "staging rehearsal proof not found: $StagingProofPath" }
$staging = Get-Content $StagingProofPath -Raw | ConvertFrom-Json

$requiredFields = @(
    'tested_head_sha','purge_sql_sha256','purge_manifest_sha256','migrations_148_153_sha256',
    'staging_manifest_sha256','production_manifest_sha256','staging_project_ref',
    'staging_ca_sha256','production_ca_sha256','backup_sha256','restore_proof_sha256',
    'trigger_proof_sha256','rollback_proof_sha256','exact_psql_version','exact_pg_dump_version',
    'psql_executable_path','pg_dump_executable_path','psql_executable_sha256','pg_dump_executable_sha256',
    'staging_pg_version','completed_at_utc'
)
foreach ($f in $requiredFields) {
    if (-not ($staging.PSObject.Properties.Name -contains $f)) { Fail "staging proof is missing field: $f" }
    Require-NonPlaceholder $staging.$f "staging proof field '$f'"
}

if (-not $ExpectedProductionHead) {
    Push-Location $RepoRoot
    try { $ExpectedProductionHead = (& git rev-parse HEAD).Trim() } finally { Pop-Location }
}
if ($ExpectedProductionHead -notmatch '^[0-9a-f]{40}$') { Fail "ExpectedProductionHead is not a 40-hex commit sha: $ExpectedProductionHead" }
if ($staging.tested_head_sha -ne $ExpectedProductionHead) {
    Fail ("the staging proof was tested against a different commit than the one about to be released.`n" +
          "  staging proof tested $($staging.tested_head_sha)`n  expected production   $ExpectedProductionHead")
}

Section 'STAGING REHEARSAL PROOF SUMMARY'
Write-Host "tested head          : $($staging.tested_head_sha)"
Write-Host "staging project ref  : $($staging.staging_project_ref)"
Write-Host "staging PG version   : $($staging.staging_pg_version)"
Write-Host "psql                 : $($staging.exact_psql_version)"
Write-Host "pg_dump              : $($staging.exact_pg_dump_version)"
Write-Host "backup SHA-256       : $($staging.backup_sha256)"
Write-Host "restore proof SHA-256: $($staging.restore_proof_sha256)"
Write-Host "completed at (UTC)   : $($staging.completed_at_utc)"
Write-Host ''
Write-Host "This records a GO decision to run the identical, unmodified release path"
Write-Host "against PRODUCTION for commit $ExpectedProductionHead."
Write-Host ''

$typed = Read-Host "Type EXACTLY  $ConfirmPhrase  to record a GO decision"
if ($typed -ne $ConfirmPhrase) { Fail 'owner Go decision not confirmed -- nothing was written' }

$identity = Read-Host 'Type your name or email to attribute this decision (not a secret)'
Require-NonPlaceholder $identity 'owner_identity'

$decision = [ordered]@{
    staging_proof_sha256      = Get-FileSha256 $StagingProofPath
    decision                  = 'GO'
    decision_at_utc           = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    owner_identity            = $identity
    expected_production_head  = $ExpectedProductionHead
}

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
($decision | ConvertTo-Json -Depth 5) | Set-Content -Path $OutPath -Encoding utf8

Section 'RESULT'
Write-Host "owner Go decision written: $OutPath"
Write-Host 'Production may now be run with:'
Write-Host '  ops\run-prelaunch-release-core.ps1 -TargetManifest ops\targets\production.json'
Write-Host "    -RestoreProofPath ops\evidence\restore-proof.json"
Write-Host "    -StagingProofPath $StagingProofPath"
Write-Host "    -OwnerGoPath $OutPath"
