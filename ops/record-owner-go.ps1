<#
================================================================================
 Record the owner's Go decision for a Production release -- run ONLY after
 ops\generate-staging-rehearsal-proof.ps1 produced a passing staging proof.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\record-owner-go.ps1 `
        [-RestoreProofPath ops\evidence\restore-proof.json] `
        [-StagingProofPath ops\evidence\staging-rehearsal-proof.json] `
        [-StagingManifestPath ops\targets\staging.json] `
        [-ProductionManifestPath ops\targets\production.json] `
        [-ExpectedProductionHead <40-hex commit sha, defaults to current HEAD>]

 Before showing anything or asking for a decision, this script runs the exact
 same evidence-chain validator ops\run-prelaunch-release-core.ps1 will run
 for the real Production release -- Test-RestoreAndStagingEvidence from
 ops\evidence-chain.ps1, dot-sourced by both files, so there is exactly one
 validation implementation. If that validator fails for any reason (a
 placeholder, a stale hash, a tampered manifest, a re-used certificate, a
 backup mismatch, an executable that no longer matches), this script stops
 with the same error the Production engine would raise and NEVER reaches the
 confirmation prompt.

 Nothing is entered on the owner's behalf and no credential of any kind is
 requested here -- this script never connects to a database.
================================================================================
#>

param(
    [string]$RestoreProofPath,
    [string]$StagingProofPath,
    [string]$StagingManifestPath,
    [string]$ProductionManifestPath,
    [string]$ExpectedProductionHead,
    [string]$OutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $RestoreProofPath)      { $RestoreProofPath      = Join-Path $RepoRoot 'ops\evidence\restore-proof.json' }
if (-not $StagingProofPath)      { $StagingProofPath      = Join-Path $RepoRoot 'ops\evidence\staging-rehearsal-proof.json' }
if (-not $StagingManifestPath)   { $StagingManifestPath   = Join-Path $RepoRoot 'ops\targets\staging.json' }
if (-not $ProductionManifestPath) { $ProductionManifestPath = Join-Path $RepoRoot 'ops\targets\production.json' }
if (-not $OutPath)               { $OutPath               = Join-Path $RepoRoot 'ops\evidence\owner-go.json' }

$ConfirmPhrase = 'I AUTHORIZE THE PRODUCTION RELEASE'

function Fail([string]$m) { Write-Host "STOP: $m" -ForegroundColor Red; throw $m }
function Section([string]$t) { Write-Host ''; Write-Host ('=' * 78); Write-Host "  $t"; Write-Host ('=' * 78) }

. (Join-Path $PSScriptRoot 'evidence-chain.ps1')

if (-not (Test-Path $ProductionManifestPath)) { Fail "production manifest not found: $ProductionManifestPath" }
$M = Get-Content $ProductionManifestPath -Raw | ConvertFrom-Json
if ($M.environment -ne 'production') { Fail "manifest at $ProductionManifestPath is not the production manifest" }

if (-not $ExpectedProductionHead) {
    Push-Location $RepoRoot
    try { $ExpectedProductionHead = (& git rev-parse HEAD).Trim() } finally { Pop-Location }
}
if ($ExpectedProductionHead -notmatch '^[0-9a-f]{40}$') { Fail "ExpectedProductionHead is not a 40-hex commit sha: $ExpectedProductionHead" }

# The full evidence-chain validator -- identical to what the Production
# engine runs. No summary is shown and no prompt appears unless this passes.
$chain = Test-RestoreAndStagingEvidence -M $M -RepoRoot $RepoRoot -Head $ExpectedProductionHead `
    -RestoreProofPath $RestoreProofPath -StagingProofPath $StagingProofPath `
    -StagingManifestPath $StagingManifestPath -ProductionManifestPath $ProductionManifestPath

$staging = $chain.Staging
$restore = $chain.Restore

# Sanity-check that "now" (the moment this decision would be recorded) is not
# before the staging rehearsal it is meant to authorize.
$stagingCompleted = ConvertTo-UtcDateTime $staging.completed_at_utc 'staging proof: completed_at_utc'
$now = (Get-Date).ToUniversalTime()
if ($stagingCompleted -gt $now) { Fail 'the staging proof timestamp is in the future relative to this machine clock' }

Section 'STAGING REHEARSAL PROOF SUMMARY (independently re-verified above)'
Write-Host "tested head          : $($staging.tested_head_sha)"
Write-Host "staging project ref  : $($staging.staging_project_ref)"
Write-Host "staging PG version   : $($staging.staging_pg_version)"
Write-Host "psql                 : $($staging.exact_psql_version)"
Write-Host "pg_dump              : $($staging.exact_pg_dump_version)"
Write-Host "backup SHA-256       : $($staging.backup_sha256)"
Write-Host "restore proof SHA-256: $($staging.restore_proof_sha256)"
Write-Host "restore completed    : $($restore.restore_completed_at_utc)"
Write-Host "staging completed    : $($staging.completed_at_utc)"
Write-Host ''
Write-Host "This records a GO decision to run the identical, unmodified release path"
Write-Host "against PRODUCTION for commit $ExpectedProductionHead."
Write-Host ''

$typed = Read-Host "Type EXACTLY  $ConfirmPhrase  to record a GO decision"
if ($typed -ne $ConfirmPhrase) { Fail 'owner Go decision not confirmed -- nothing was written' }

$identity = Read-Host 'Type your name or email to attribute this decision (not a secret)'
Test-NonPlaceholder $identity 'owner_identity'

$decision = [ordered]@{
    staging_proof_sha256     = Get-FileSha256 $StagingProofPath
    decision                 = 'GO'
    decision_at_utc          = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    owner_identity            = $identity
    expected_production_head = $ExpectedProductionHead
}

# Self-check with the same validator the Production engine uses for the
# owner-go half of the chain.
$roundTripped = ($decision | ConvertTo-Json -Depth 5) | ConvertFrom-Json
Test-OwnerGoObject $roundTripped
Test-OwnerGoAgainstStaging $roundTripped $staging $StagingProofPath $ExpectedProductionHead
Test-FullTimestampOrder $restore $staging $roundTripped

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
($decision | ConvertTo-Json -Depth 5) | Set-Content -Path $OutPath -Encoding utf8

Section 'RESULT'
Write-Host "owner Go decision written: $OutPath"
Write-Host 'Production may now be run with:'
Write-Host '  ops\run-prelaunch-release-core.ps1 -TargetManifest ops\targets\production.json'
Write-Host "    -RestoreProofPath $RestoreProofPath"
Write-Host "    -StagingProofPath $StagingProofPath"
Write-Host "    -StagingManifestPath $StagingManifestPath"
Write-Host "    -OwnerGoPath $OutPath"
