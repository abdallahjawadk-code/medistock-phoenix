<#
================================================================================
 Shared evidence-chain validation.

 Dot-sourced by ops\run-prelaunch-release-core.ps1, ops\record-owner-go.ps1,
 ops\generate-restore-proof.ps1 and ops\generate-staging-rehearsal-proof.ps1,
 so there is exactly ONE implementation of what makes a piece of evidence
 real. In particular Test-RestoreAndStagingEvidence is called identically by
 the Production engine and by record-owner-go.ps1 -- the owner is shown the Go
 prompt only after the exact same checks the Production engine will re-run
 before a credential is ever requested.

 Every function here calls Fail(...) on any problem. Callers must define their
 own Fail([string]$m) function BEFORE dot-sourcing this file (dot-sourcing
 merges into the caller's scope, so an unqualified call to Fail resolves to
 the caller's own definition -- this lets each script keep its own logging
 style while sharing one validation implementation).

 This file never connects to a database and never prompts for anything.
================================================================================
#>

function Get-FileSha256([string]$path) {
    return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
}

function Get-PgMajor([string]$exe) {
    $v = & $exe --version 2>&1
    if ($v -match '(\d+)\.\d+') { return [int]$Matches[1] }
    if ($v -match '(\d+)')      { return [int]$Matches[1] }
    return 0
}

function Get-PgFullVersion([string]$exe) {
    return (& $exe --version 2>&1 | Select-Object -First 1).ToString().Trim()
}

function Get-MigrationRangeSha256([string]$repoRoot, [int]$from, [int]$to) {
    $dir = Join-Path $repoRoot 'supabase\migrations'
    $bytes = New-Object System.Collections.Generic.List[byte]
    for ($n = $from; $n -le $to; $n++) {
        $pat = '{0:d3}_*.sql' -f $n
        $f = Get-ChildItem $dir -Filter $pat -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
        if (-not $f) { Fail "migration $n not found in $dir -- cannot compute migrations digest" }
        $bytes.AddRange([IO.File]::ReadAllBytes($f.FullName))
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes.ToArray())
        return ([BitConverter]::ToString($hash) -replace '-', '').ToLower()
    } finally { $sha.Dispose() }
}

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

function ConvertTo-UtcDateTime([string]$iso, [string]$label) {
    if ($iso -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- $label is not ISO-8601 UTC (expected YYYY-MM-DDTHH:MM:SSZ): $iso"
    }
    return [DateTime]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
}

# ------------------------------------------------------------ field checks
function Test-NonPlaceholder([string]$v, [string]$fieldName) {
    if ([string]::IsNullOrWhiteSpace($v)) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- field '$fieldName' is empty" }
    if ($v -match '(?i)placeholder|\bexample\b|\bTODO\b|\bFIXME\b|^xxx+$|^0{8,}$') {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- field '$fieldName' looks like a placeholder: $v"
    }
}
function Test-Sha256Hex([string]$v, [string]$fieldName) {
    Test-NonPlaceholder $v $fieldName
    if ($v -notmatch '^[0-9a-f]{64}$') { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- field '$fieldName' is not a lowercase SHA-256 hex digest" }
}
function Test-Iso8601Utc([string]$v, [string]$fieldName) {
    Test-NonPlaceholder $v $fieldName
    if ($v -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- field '$fieldName' is not ISO-8601 UTC (expected YYYY-MM-DDTHH:MM:SSZ)"
    }
}
function Test-RequiredFields($obj, [string[]]$fields, [string]$label) {
    # Indexer access, not member enumeration: under Set-StrictMode -Version
    # Latest, ".PSObject.Properties.Name" throws PropertyNotFoundStrict when
    # $obj has zero properties (e.g. an empty JSON object "{}"), because
    # there is nothing to enumerate. The indexer returns $null instead of
    # throwing, in every case.
    foreach ($f in $fields) {
        if ($null -eq $obj.PSObject.Properties[$f]) {
            Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- $label is missing field: $f"
        }
    }
}
function Test-BooleanTrue($v, [string]$fieldName) {
    if ($v -isnot [bool] -or $v -ne $true) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- field '$fieldName' must be true, got: $v" }
}
function Test-ExactValue($actual, $expected, [string]$fieldName) {
    if ("$actual" -ne "$expected") { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- field '$fieldName' expected '$expected', got '$actual'" }
}

# --------------------------------------------------- raw execution reports
# These validate the RAW reports produced by real execution tooling, before
# a proof file is ever written. A missing field, a false flag, or a report
# that never ran to completion is rejected here -- a proof cannot exist
# without a genuine passing report behind it.
function Test-RestoreRunReport($report) {
    Test-RequiredFields $report @(
        'restore_exit_code', 'restored_database_probe_passed', 'migration_ceiling',
        'keeper_verified', 'rbac_130_415_verified',
        'trigger_definition_before_sha256', 'trigger_definition_after_sha256',
        'deliberate_rollback_passed', 'reconciliation_passed', 'clone_pg_major',
        'pre_purge_reconciliation_report_sha256', 'rollback_report_sha256',
        'restore_started_at_utc', 'restore_completed_at_utc', 'clone_server_version',
        'backup_path', 'backup_sha256', 'backup_size'
    ) 'restore run report'
    Test-ExactValue ([int]$report.restore_exit_code) 0 'restore_exit_code'
    Test-BooleanTrue $report.restored_database_probe_passed 'restored_database_probe_passed'
    Test-ExactValue ([int]$report.migration_ceiling) 147 'migration_ceiling'
    Test-BooleanTrue $report.keeper_verified 'keeper_verified'
    Test-BooleanTrue $report.rbac_130_415_verified 'rbac_130_415_verified'
    Test-BooleanTrue $report.deliberate_rollback_passed 'deliberate_rollback_passed'
    Test-BooleanTrue $report.reconciliation_passed 'reconciliation_passed'
    Test-ExactValue ([int]$report.clone_pg_major) 17 'clone_pg_major'
    Test-Sha256Hex $report.trigger_definition_before_sha256 'trigger_definition_before_sha256'
    Test-Sha256Hex $report.trigger_definition_after_sha256 'trigger_definition_after_sha256'
    if ($report.trigger_definition_before_sha256 -ne $report.trigger_definition_after_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- trigger definitions differ before and after restore; immutability triggers were not restored identically'
    }
    Test-Sha256Hex $report.pre_purge_reconciliation_report_sha256 'pre_purge_reconciliation_report_sha256'
    Test-Sha256Hex $report.rollback_report_sha256 'rollback_report_sha256'
    Test-Iso8601Utc $report.restore_started_at_utc 'restore_started_at_utc'
    Test-Iso8601Utc $report.restore_completed_at_utc 'restore_completed_at_utc'
    if ((ConvertTo-UtcDateTime $report.restore_completed_at_utc 'restore_completed_at_utc') -lt (ConvertTo-UtcDateTime $report.restore_started_at_utc 'restore_started_at_utc')) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- restore_completed_at_utc is before restore_started_at_utc'
    }
    Test-NonPlaceholder $report.clone_server_version 'clone_server_version'
    Test-NonPlaceholder $report.backup_path 'backup_path'
    Test-Sha256Hex $report.backup_sha256 'backup_sha256'
    if ([int]$report.backup_size -le 0) { Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- backup_size must be greater than zero' }
}

function Test-StagingRunResult($result) {
    Test-RequiredFields $result @(
        'result', 'environment', 'head_sha', 'server_version', 'backup_path', 'backup_sha256',
        'psql_path', 'psql_version', 'psql_sha256', 'pg_dump_path', 'pg_dump_version', 'pg_dump_sha256',
        'pre_purge_checks_passed', 'purge_committed', 'post_purge_reconciliation_passed',
        'migrations_148_153_applied', 'final_ceiling', 'post_apply_checks_passed', 'completed_at_utc'
    ) 'staging run result'
    Test-ExactValue $result.result 'SUCCESS' 'staging run result: result'
    Test-ExactValue $result.environment 'staging' 'staging run result: environment'
    if ($result.head_sha -notmatch '^[0-9a-f]{40}$') { Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- staging run result: head_sha is not a 40-hex commit sha' }
    Test-NonPlaceholder $result.server_version 'staging run result: server_version'
    Test-NonPlaceholder $result.backup_path 'staging run result: backup_path'
    Test-Sha256Hex $result.backup_sha256 'staging run result: backup_sha256'
    Test-NonPlaceholder $result.psql_path 'staging run result: psql_path'
    Test-NonPlaceholder $result.psql_version 'staging run result: psql_version'
    Test-Sha256Hex $result.psql_sha256 'staging run result: psql_sha256'
    Test-NonPlaceholder $result.pg_dump_path 'staging run result: pg_dump_path'
    Test-NonPlaceholder $result.pg_dump_version 'staging run result: pg_dump_version'
    Test-Sha256Hex $result.pg_dump_sha256 'staging run result: pg_dump_sha256'
    Test-BooleanTrue $result.pre_purge_checks_passed 'staging run result: pre_purge_checks_passed'
    Test-BooleanTrue $result.purge_committed 'staging run result: purge_committed'
    Test-BooleanTrue $result.post_purge_reconciliation_passed 'staging run result: post_purge_reconciliation_passed'
    Test-BooleanTrue $result.migrations_148_153_applied 'staging run result: migrations_148_153_applied'
    Test-ExactValue ([int]$result.final_ceiling) 153 'staging run result: final_ceiling'
    Test-BooleanTrue $result.post_apply_checks_passed 'staging run result: post_apply_checks_passed'
    Test-Iso8601Utc $result.completed_at_utc 'staging run result: completed_at_utc'
}

# ------------------------------------------------------------- proof shapes
# These validate the FINAL, generated proof files -- used by the generators
# themselves (self-check before writing), and by every downstream consumer
# (owner-go, the Production engine) so a hand-edited or truncated proof file
# is rejected the same way everywhere.
function Test-RestoreProofObject($restore) {
    Test-RequiredFields $restore @(
        'backup_sha256', 'backup_size', 'restore_started_at_utc', 'restore_completed_at_utc',
        'clone_server_version', 'clone_pg_major', 'restore_exit_code', 'restored_database_probe_passed',
        'migration_ceiling', 'keeper_verified', 'rbac_130_415_verified',
        'pre_purge_reconciliation_report_sha256',
        'trigger_definition_before_sha256', 'trigger_definition_after_sha256', 'trigger_reconciliation_proven',
        'rollback_report_sha256', 'rollback_proven', 'deliberate_rollback_passed', 'reconciliation_passed',
        'restore_run_report_sha256', 'proof_generated_at_utc'
    ) 'restore proof'
    Test-ExactValue ([int]$restore.restore_exit_code) 0 'restore proof: restore_exit_code'
    Test-BooleanTrue $restore.restored_database_probe_passed 'restore proof: restored_database_probe_passed'
    Test-ExactValue ([int]$restore.migration_ceiling) 147 'restore proof: migration_ceiling'
    Test-BooleanTrue $restore.keeper_verified 'restore proof: keeper_verified'
    Test-BooleanTrue $restore.rbac_130_415_verified 'restore proof: rbac_130_415_verified'
    Test-BooleanTrue $restore.trigger_reconciliation_proven 'restore proof: trigger_reconciliation_proven'
    Test-BooleanTrue $restore.rollback_proven 'restore proof: rollback_proven'
    Test-BooleanTrue $restore.deliberate_rollback_passed 'restore proof: deliberate_rollback_passed'
    Test-BooleanTrue $restore.reconciliation_passed 'restore proof: reconciliation_passed'
    Test-ExactValue ([int]$restore.clone_pg_major) 17 'restore proof: clone_pg_major'
    Test-Sha256Hex $restore.backup_sha256 'restore proof: backup_sha256'
    Test-Sha256Hex $restore.pre_purge_reconciliation_report_sha256 'restore proof: pre_purge_reconciliation_report_sha256'
    Test-Sha256Hex $restore.trigger_definition_before_sha256 'restore proof: trigger_definition_before_sha256'
    Test-Sha256Hex $restore.trigger_definition_after_sha256 'restore proof: trigger_definition_after_sha256'
    if ($restore.trigger_definition_before_sha256 -ne $restore.trigger_definition_after_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- restore proof trigger definitions differ before and after'
    }
    Test-Sha256Hex $restore.rollback_report_sha256 'restore proof: rollback_report_sha256'
    Test-Sha256Hex $restore.restore_run_report_sha256 'restore proof: restore_run_report_sha256'
    Test-Iso8601Utc $restore.restore_started_at_utc 'restore proof: restore_started_at_utc'
    Test-Iso8601Utc $restore.restore_completed_at_utc 'restore proof: restore_completed_at_utc'
    Test-Iso8601Utc $restore.proof_generated_at_utc 'restore proof: proof_generated_at_utc'
}

function Test-StagingProofObject($staging) {
    Test-RequiredFields $staging @(
        'tested_head_sha', 'purge_sql_sha256', 'purge_manifest_sha256', 'migrations_148_153_sha256',
        'staging_manifest_sha256', 'production_manifest_sha256', 'staging_project_ref',
        'staging_ca_sha256', 'production_ca_sha256', 'backup_sha256', 'restore_proof_sha256',
        'trigger_proof_sha256', 'rollback_proof_sha256', 'exact_psql_version', 'exact_pg_dump_version',
        'psql_executable_path', 'pg_dump_executable_path', 'psql_executable_sha256', 'pg_dump_executable_sha256',
        'staging_pg_version', 'completed_at_utc', 'staging_run_result_sha256'
    ) 'staging rehearsal proof'
    foreach ($f in @('tested_head_sha', 'staging_project_ref', 'exact_psql_version', 'exact_pg_dump_version',
                     'psql_executable_path', 'pg_dump_executable_path', 'staging_pg_version')) {
        Test-NonPlaceholder $staging.$f "staging rehearsal proof: $f"
    }
    foreach ($f in @('purge_sql_sha256', 'purge_manifest_sha256', 'migrations_148_153_sha256', 'staging_manifest_sha256',
                     'production_manifest_sha256', 'staging_ca_sha256', 'production_ca_sha256', 'backup_sha256',
                     'restore_proof_sha256', 'trigger_proof_sha256', 'rollback_proof_sha256',
                     'psql_executable_sha256', 'pg_dump_executable_sha256', 'staging_run_result_sha256')) {
        Test-Sha256Hex $staging.$f "staging rehearsal proof: $f"
    }
    Test-Iso8601Utc $staging.completed_at_utc 'staging rehearsal proof: completed_at_utc'
    if ($staging.tested_head_sha -notmatch '^[0-9a-f]{40}$') { Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- staging rehearsal proof: tested_head_sha is not a 40-hex commit sha' }
}

function Test-OwnerGoObject($owner) {
    Test-RequiredFields $owner @('staging_proof_sha256', 'decision', 'decision_at_utc', 'owner_identity', 'expected_production_head') 'owner Go decision'
    Test-NonPlaceholder $owner.owner_identity 'owner Go decision: owner_identity'
    Test-Iso8601Utc $owner.decision_at_utc 'owner Go decision: decision_at_utc'
    Test-Sha256Hex $owner.staging_proof_sha256 'owner Go decision: staging_proof_sha256'
    if ($owner.expected_production_head -notmatch '^[0-9a-f]{40}$') { Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- owner Go decision: expected_production_head is not a 40-hex commit sha' }
}

# ------------------------------------------------------- binary re-verification
# The staging proof names exact executables. Confirms they still exist, still
# hash the same, and still report the same version -- independent of whether
# the caller trusts the proof's own claims.
function Test-ToolBinaryMatchesProof($staging) {
    foreach ($pair in @(
        @{ Path = $staging.psql_executable_path; Version = $staging.exact_psql_version; Sha = $staging.psql_executable_sha256; Label = 'psql' },
        @{ Path = $staging.pg_dump_executable_path; Version = $staging.exact_pg_dump_version; Sha = $staging.pg_dump_executable_sha256; Label = 'pg_dump' }
    )) {
        if (-not (Test-Path $pair.Path)) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- $($pair.Label) executable referenced by the staging proof no longer exists: $($pair.Path)" }
        if ((Get-FileSha256 $pair.Path) -ne $pair.Sha) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- $($pair.Label) executable changed since the rehearsal (SHA-256 mismatch): $($pair.Path)" }
        if ((Get-PgFullVersion $pair.Path) -ne $pair.Version) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- $($pair.Label) version differs from the rehearsal: $($pair.Path)" }
    }
}

# ------------------------------------------------------- the full chain check
# Called identically by the Production engine and by record-owner-go.ps1.
# Verifies restore-proof.json and staging-rehearsal-proof.json structurally,
# re-verifies every executable and manifest hash against the CURRENT
# repository and filesystem state (never trusting the proof's own claims),
# and cross-checks the two proofs against each other. Returns the parsed
# objects on success; throws (via Fail) on the first problem found.
function Test-RestoreAndStagingEvidence {
    param(
        $M,
        [string]$RepoRoot,
        [string]$Head,
        [string]$RestoreProofPath,
        [string]$StagingProofPath,
        [string]$StagingManifestPath,
        [string]$ProductionManifestPath,
        [string]$RestoreRunResultPath,
        [string]$StagingRunResultPath
    )

    function Resolve-EvidenceLocal([string]$p) {
        if ([IO.Path]::IsPathRooted($p)) { return $p }
        return (Join-Path $RepoRoot $p)
    }

    foreach ($pair in @(
        @{ Name = 'restore proof'; Path = $RestoreProofPath },
        @{ Name = 'staging rehearsal proof'; Path = $StagingProofPath },
        @{ Name = 'staging manifest'; Path = $StagingManifestPath },
        @{ Name = 'restore run result (raw)'; Path = $RestoreRunResultPath },
        @{ Name = 'staging run result (raw)'; Path = $StagingRunResultPath }
    )) {
        if ([string]::IsNullOrWhiteSpace($pair.Path)) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- $($pair.Name) path was not supplied" }
        if (-not (Test-Path $pair.Path)) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- $($pair.Name) not found: $($pair.Path)" }
    }

    $restore = Get-Content $RestoreProofPath -Raw | ConvertFrom-Json
    $staging = Get-Content $StagingProofPath -Raw | ConvertFrom-Json
    $stagingManifest = Get-Content $StagingManifestPath -Raw | ConvertFrom-Json
    $rawRestore = Get-Content $RestoreRunResultPath -Raw | ConvertFrom-Json
    $rawStaging = Get-Content $StagingRunResultPath -Raw | ConvertFrom-Json

    Test-RestoreProofObject $restore
    Test-StagingProofObject $staging
    Test-ToolBinaryMatchesProof $staging

    # The raw execution reports behind each proof are re-validated from
    # scratch here, every time -- not merely trusted because a proof file
    # referencing their hash exists. A proof is only as good as the report
    # it was built from, and that report could have been overwritten after
    # the proof was generated.
    Test-RestoreRunReport $rawRestore
    Test-StagingRunResult $rawStaging

    $rawRestoreSha = Get-FileSha256 $RestoreRunResultPath
    if ($restore.restore_run_report_sha256 -ne $rawRestoreSha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the restore proof does not reference the supplied raw restore run result (SHA-256 mismatch) -- it may have been regenerated or edited since the proof was written.'
    }
    $rawStagingSha = Get-FileSha256 $StagingRunResultPath
    if ($staging.staging_run_result_sha256 -ne $rawStagingSha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the staging proof does not reference the supplied raw staging run result (SHA-256 mismatch) -- it may have been regenerated or edited since the proof was written.'
    }

    # Cross-check the raw facts against what each proof claims about them.
    if ($rawRestore.backup_sha256 -ne $restore.backup_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the raw restore run result backup SHA-256 does not match the restore proof.'
    }
    if ($rawStaging.backup_sha256 -ne $staging.backup_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the raw staging run result backup SHA-256 does not match the staging proof.'
    }
    if ($rawRestore.pre_purge_reconciliation_report_sha256 -ne $restore.pre_purge_reconciliation_report_sha256 -or
        $rawRestore.rollback_report_sha256 -ne $restore.rollback_report_sha256 -or
        $rawRestore.trigger_definition_before_sha256 -ne $restore.trigger_definition_before_sha256 -or
        $rawRestore.trigger_definition_after_sha256 -ne $restore.trigger_definition_after_sha256 -or
        [int]$rawRestore.clone_pg_major -ne [int]$restore.clone_pg_major -or
        [int]$rawRestore.migration_ceiling -ne [int]$restore.migration_ceiling) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the raw restore run result no longer agrees with the restore proof built from it.'
    }
    if ($rawStaging.head_sha -ne $staging.tested_head_sha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the raw staging run result head does not match the staging proof tested head.'
    }
    if ($rawStaging.server_version -ne $staging.staging_pg_version) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the raw staging run result server version does not match the staging proof.'
    }
    if ($rawStaging.psql_path -ne $staging.psql_executable_path -or $rawStaging.psql_version -ne $staging.exact_psql_version -or $rawStaging.psql_sha256 -ne $staging.psql_executable_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the raw staging run result psql path/version/hash does not match the staging proof.'
    }
    if ($rawStaging.pg_dump_path -ne $staging.pg_dump_executable_path -or $rawStaging.pg_dump_version -ne $staging.exact_pg_dump_version -or $rawStaging.pg_dump_sha256 -ne $staging.pg_dump_executable_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the raw staging run result pg_dump path/version/hash does not match the staging proof.'
    }

    if ($staging.tested_head_sha -ne $Head) {
        Fail ("STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the rehearsal proved a different commit.`n" +
              "  rehearsed $($staging.tested_head_sha)`n  current   $Head")
    }
    if ($staging.purge_sql_sha256 -ne $M.purge_sql_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- purge SQL digest differs between the staging proof and this manifest.'
    }
    $manifestSha = Get-FileSha256 (Resolve-EvidenceLocal 'supabase/ops/purge-manifest-v147.ts')
    if ($staging.purge_manifest_sha256 -ne $manifestSha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- purge manifest changed since the rehearsal.'
    }
    $migSha = Get-MigrationRangeSha256 $RepoRoot 148 153
    if ($staging.migrations_148_153_sha256 -ne $migSha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- migrations 148-153 changed since the rehearsal.'
    }
    $prodManifestSha = Get-FileSha256 $ProductionManifestPath
    if ($staging.production_manifest_sha256 -ne $prodManifestSha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- production.json changed since the rehearsal -- it must stay byte-identical.'
    }
    $stagingManifestSha = Get-FileSha256 $StagingManifestPath
    if ($staging.staging_manifest_sha256 -ne $stagingManifestSha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the staging manifest changed since the rehearsal.'
    }
    if ($stagingManifest.project_ref -ne $staging.staging_project_ref) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the staging manifest project_ref no longer matches the staging proof.'
    }
    if ($staging.staging_project_ref -eq $M.project_ref) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- staging_project_ref equals the production project_ref.'
    }

    $prodCaPin = (Get-Content (Resolve-EvidenceLocal $M.ca_sha256_path) -Raw).Trim().ToLower()
    if ($staging.production_ca_sha256 -ne $prodCaPin) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- production CA pin differs between the staging proof and this target.'
    }
    $stagingCaPin = (Get-Content (Resolve-EvidenceLocal $stagingManifest.ca_sha256_path) -Raw).Trim().ToLower()
    if ($staging.staging_ca_sha256 -ne $stagingCaPin) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- staging CA pin differs between the staging proof and the staging manifest.'
    }
    if ($staging.staging_ca_sha256 -eq $staging.production_ca_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- staging and production certificates must be pinned separately, not shared.'
    }

    if ($staging.staging_pg_version -notmatch "^$([regex]::Escape([string][int]$M.required_pg_major))\.") {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- rehearsal ran on PostgreSQL '$($staging.staging_pg_version)', target requires major $($M.required_pg_major)"
    }

    $restoreProofFileSha = Get-FileSha256 $RestoreProofPath
    if ($staging.restore_proof_sha256 -ne $restoreProofFileSha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- staging proof does not reference the supplied restore proof file (SHA-256 mismatch).'
    }

    $triggerSubset = Get-JsonSubsetSha256 $restore @('trigger_definition_before_sha256', 'trigger_definition_after_sha256', 'trigger_reconciliation_proven')
    if ($staging.trigger_proof_sha256 -ne $triggerSubset) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- trigger proof hash does not match the restore proof it claims to summarize.'
    }
    $rollbackSubset = Get-JsonSubsetSha256 $restore @('rollback_report_sha256', 'rollback_proven')
    if ($staging.rollback_proof_sha256 -ne $rollbackSubset) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- rollback proof hash does not match the restore proof it claims to summarize.'
    }
    if ($staging.backup_sha256 -ne $restore.backup_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the staging backup SHA-256 does not match the restore proof backup.'
    }
    if ([int]$restore.clone_pg_major -ne [int]$M.required_pg_major) {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- restore proof clone PostgreSQL major ($($restore.clone_pg_major)) does not match the required major ($($M.required_pg_major))"
    }

    $restoreCompleted = ConvertTo-UtcDateTime $restore.restore_completed_at_utc 'restore proof: restore_completed_at_utc'
    $stagingCompleted = ConvertTo-UtcDateTime $staging.completed_at_utc 'staging proof: completed_at_utc'
    if ($restoreCompleted -gt $stagingCompleted) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the restore proof timestamp is after the staging proof timestamp.'
    }

    return [ordered]@{ Restore = $restore; Staging = $staging }
}

function Test-OwnerGoAgainstStaging($owner, $staging, [string]$StagingProofPath, [string]$Head) {
    if ($owner.decision -ne 'GO') {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- owner decision is '$($owner.decision)', expected GO"
    }
    if ($owner.expected_production_head -ne $Head) {
        Fail ("STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- owner Go was recorded for a different commit.`n" +
              "  recorded  $($owner.expected_production_head)`n  current   $Head")
    }
    if ($owner.expected_production_head -ne $staging.tested_head_sha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- owner Go head does not match the staging proof tested head.'
    }
    $stagingProofFileSha = Get-FileSha256 $StagingProofPath
    if ($owner.staging_proof_sha256 -ne $stagingProofFileSha) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- owner Go decision does not reference the supplied staging proof file (SHA-256 mismatch).'
    }
}

function Test-FullTimestampOrder($restore, $staging, $owner) {
    $rc = ConvertTo-UtcDateTime $restore.restore_completed_at_utc 'restore proof: restore_completed_at_utc'
    $sc = ConvertTo-UtcDateTime $staging.completed_at_utc 'staging proof: completed_at_utc'
    $oc = ConvertTo-UtcDateTime $owner.decision_at_utc 'owner Go: decision_at_utc'
    if ($rc -gt $sc) { Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the restore proof timestamp is after the staging proof timestamp.' }
    if ($sc -gt $oc) { Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the staging proof timestamp is after the owner Go decision timestamp.' }
}
