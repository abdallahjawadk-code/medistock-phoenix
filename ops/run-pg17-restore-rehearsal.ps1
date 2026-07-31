<#
================================================================================
 Restore rehearsal on a local, disposable PostgreSQL 17 clone -- the ONE tool
 that produces restore-run-result.json. Nothing else may write that file, and
 this file itself only writes it after every step below has genuinely passed.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-pg17-restore-rehearsal.ps1 `
        -BackupPath <path to a pg_dump --format=custom backup> `
        -CloneTargetManifest ops\targets\rehearsal-clone.json `
        -OutputDirectory ops\evidence

 Only three inputs are accepted: the backup to restore, the manifest of the
 LOCAL loopback clone to restore it onto, and where to write evidence. There
 is no parameter for a boolean, an exit code, or a server version -- every
 field of restore-run-result.json is extracted from real commands run against
 the clone itself, in this order:

     1. create/verify a clean PG17 clone database (drop + recreate; the clone
        is disposable by definition, loopback-only, never Production/Staging)
     2. pg_restore the backup into it
     3. probe the restored database (connectivity, server major = 17)
     4. verify migration ceiling = 147
     5. verify the keeper account
     6. verify RBAC = 130/415
     7. capture the six immutability trigger definitions (before)
     8. run a deliberate, self-contained rollback test
     9. capture the six immutability trigger definitions (after) and require
        them byte-identical to step 7
    10. run reconciliation (duplicate migration versions, unvalidated FKs)
    11. write restore-run-result.json -- reached ONLY if every step above
        passed; any failure throws before this point and no file is written

 The manifest must declare environment=rehearsal_clone, a loopback host, and
 ssl_mode=disable -- the engine refuses anything else, so this script can
 never be pointed at Production or Staging by manifest substitution.

 No credential is requested: a loopback rehearsal clone is expected to run
 with trust authentication, exactly like ops/release-stages.ps1's clone path.
================================================================================
#>

param(
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [Parameter(Mandatory = $true)][string]$CloneTargetManifest,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogLines = New-Object System.Collections.Generic.List[string]

function Log([string]$m) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'), $m
    Write-Host $line; $LogLines.Add($line) | Out-Null
}
function Fail([string]$m) { Log "STOP: $m"; throw $m }
function Section([string]$t) { Write-Host ''; Write-Host ('=' * 78); Write-Host "  $t"; Write-Host ('=' * 78) }

# Get-FileSha256, Get-PgMajor, Get-PgFullVersion.
. (Join-Path $PSScriptRoot 'evidence-chain.ps1')
# Invoke-PsqlOn, ScalarOn -- reused as-is; dot-sourcing this file defines
# functions only, it has no top-level side effects.
. (Join-Path $PSScriptRoot 'release-stages.ps1')

if (-not (Test-Path $CloneTargetManifest)) { Fail "clone target manifest not found: $CloneTargetManifest" }
$M = Get-Content $CloneTargetManifest -Raw | ConvertFrom-Json
if ($M.environment -ne 'rehearsal_clone') { Fail "manifest at $CloneTargetManifest is not a rehearsal_clone manifest (environment=$($M.environment))" }
if ($M.pooler_host -notin @('127.0.0.1', 'localhost', '::1')) { Fail "clone target host '$($M.pooler_host)' is not loopback -- this script only ever touches a local disposable clone" }
if ($M.ssl_mode -ne 'disable') { Fail "clone target manifest must set ssl_mode=disable for a local rehearsal clone" }
if ([int]$M.required_pg_major -ne 17) { Fail 'clone target manifest must require PostgreSQL major 17' }

if (-not (Test-Path $BackupPath)) { Fail "backup not found: $BackupPath" }
if ((Get-Item $BackupPath).Length -eq 0) { Fail "backup is empty: $BackupPath" }

if (-not (Test-Path $OutputDirectory)) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }

# No failed attempt may leave a stale SUCCESS result behind: delete both the
# final file and any leftover .tmp from a prior attempt before this one does
# anything else. On any failure below, the same two paths are removed again
# in the catch block, so a partial or failed attempt never leaves a result a
# downstream consumer could mistake for this attempt's outcome.
$RestoreResultPath = Join-Path $OutputDirectory 'restore-run-result.json'
$RestoreResultTmpPath = "$RestoreResultPath.tmp"
foreach ($stale in @($RestoreResultPath, $RestoreResultTmpPath)) {
    if (Test-Path $stale) {
        Remove-Item $stale -Force
        Log "removed stale evidence before attempt: $stale"
    }
}

function Resolve-Pg17RestoreTools {
    $candidates = @()
    $candidates += (Get-Command psql -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    foreach ($root in @("$env:ProgramFiles\PostgreSQL", "${env:ProgramFiles(x86)}\PostgreSQL",
                        "$env:USERPROFILE\scoop\apps\postgresql", "$env:LOCALAPPDATA\Programs\PostgreSQL")) {
        if ($root -and (Test-Path $root)) {
            $candidates += (Get-ChildItem $root -Filter 'psql.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
                            Where-Object { $_.FullName -notlike '*pgAdmin*' } | ForEach-Object { $_.FullName })
        }
    }
    foreach ($p in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path $p)) { continue }
        $dir = Split-Path -Parent $p
        $r = Join-Path $dir 'pg_restore.exe'
        if (-not (Test-Path $r)) { continue }
        if ((Get-PgMajor $p) -eq 17 -and (Get-PgMajor $r) -eq 17) {
            $script:PsqlExe = $p
            $script:PgRestoreExe = $r
            Log "psql       : $p ($(Get-PgFullVersion $p))"
            Log "pg_restore : $r ($(Get-PgFullVersion $r))"
            return
        }
    }
    Fail 'STOP_POSTGRES_CLIENT_VERSION_UNSUPPORTED -- need psql AND pg_restore both major 17 from one distribution.'
}
Resolve-Pg17RestoreTools

$Conn = "host=$($M.pooler_host) port=$($M.port) dbname=$($M.database_name) user=$($M.database_user) connect_timeout=10 application_name=phoenix_restore_rehearsal sslmode=disable"
$MaintConn = "host=$($M.pooler_host) port=$($M.port) dbname=postgres user=$($M.database_user) connect_timeout=10 application_name=phoenix_restore_rehearsal_maint sslmode=disable"

# PostgreSQL double-quoted identifier: double any embedded double-quote. The
# database_name has already been rejected by Assert-CloneDropSafety unless it
# matches ^phoenix_rehearsal_[a-z0-9_]+$, so this never actually encounters a
# quote -- it is applied unconditionally anyway, so no DROP/CREATE DATABASE
# statement in this file is ever built by raw string interpolation.
function Get-SafePgIdentifier([string]$name) {
    return '"' + ($name -replace '"', '""') + '"'
}

# Every gate below must pass, in this exact order, before a single
# destructive statement (terminate/DROP/CREATE) runs against the clone. Each
# check is independent of the others so a defect in one cannot silently
# satisfy another: syntax and identity are checked before any connection is
# used, the live server major is queried (not merely read from the manifest)
# right before the drop, and the operator must type a phrase that names the
# exact database about to be destroyed.
function Assert-CloneDropSafety($m, [string]$maintConn) {
    if ($m.pooler_host -notin @('127.0.0.1', 'localhost', '::1')) {
        Fail "STOP_CLONE_GUARD -- refusing DROP DATABASE: host '$($m.pooler_host)' is not loopback"
    }
    if ($m.ssl_mode -ne 'disable') {
        Fail "STOP_CLONE_GUARD -- refusing DROP DATABASE: ssl_mode must be 'disable' for a local clone, got '$($m.ssl_mode)'"
    }

    $name = $m.database_name
    if ([string]::IsNullOrWhiteSpace($name)) { Fail 'STOP_CLONE_GUARD -- refusing DROP DATABASE: database_name is empty' }
    # Character-level rejection first, independent of the regex below -- an
    # explicit defence against space/quote/semicolon/comment/SQL syntax ever
    # reaching a DROP/CREATE DATABASE statement.
    if ($name -match '[\s''";]' -or $name.Contains('--') -or $name.Contains('/*') -or $name.Contains('*/')) {
        Fail "STOP_CLONE_GUARD -- refusing DROP DATABASE: database_name contains a disallowed character: $name"
    }
    if ($name -notmatch '^phoenix_rehearsal_[a-z0-9_]+$') {
        Fail "STOP_CLONE_GUARD -- refusing DROP DATABASE: database_name '$name' does not match ^phoenix_rehearsal_[a-z0-9_]+`$"
    }
    if ($name -in @('postgres', 'template0', 'template1')) {
        Fail "STOP_CLONE_GUARD -- refusing DROP DATABASE: '$name' is a protected system database"
    }

    # The maintenance server's ACTUAL major version, queried live -- not the
    # manifest's required_pg_major, which is only a request, not a fact.
    $maintMajor = [int]((ScalarOn $maintConn "SELECT split_part(current_setting('server_version'),'.',1);"))
    if ($maintMajor -ne 17) {
        Fail "STOP_CLONE_GUARD -- refusing DROP DATABASE: maintenance server is PostgreSQL major $maintMajor, expected 17"
    }

    $expectedPhrase = "RESET LOCAL PG17 CLONE $name"
    Write-Host ''
    Write-Host "This will DROP and recreate the local, disposable PG17 rehearsal clone database '$name'."
    Write-Host 'This is loopback-only and is never Production or Staging.'
    $typed = Read-Host "Type EXACTLY  $expectedPhrase  to proceed"
    if ($typed -ne $expectedPhrase) { Fail 'STOP_CLONE_GUARD -- clone reset not confirmed by operator' }

    return $name
}

$TRIGGER_PAIRS = @(
    @{ Table = 'item_availability'; Trigger = 'trg_guard_availability_source_kind' },
    @{ Table = 'phoenix_report_snapshots'; Trigger = 'phoenix_report_snapshots_forbid_mutation' },
    @{ Table = 'procurement_order_events'; Trigger = 'procurement_order_events_immutable' },
    @{ Table = 'procurement_receipt_lines'; Trigger = 'procurement_receipt_lines_immutable' },
    @{ Table = 'procurement_receipts'; Trigger = 'procurement_receipts_immutable' },
    @{ Table = 'procurement_returns'; Trigger = 'procurement_returns_immutable' }
)

function Get-TriggerDefinitions {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($pair in $TRIGGER_PAIRS) {
        $def = ScalarOn $Conn @"
SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE c.relname = '$($pair.Table)' AND t.tgname = '$($pair.Trigger)' AND NOT t.tgisinternal;
"@
        if ([string]::IsNullOrWhiteSpace($def)) { Fail "trigger $($pair.Trigger) on $($pair.Table) not found -- cannot verify immutability" }
        $lines.Add("$($pair.Table).$($pair.Trigger): $def")
    }
    return ($lines -join "`n")
}

try {
    $restoreStartedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $backupSha256 = Get-FileSha256 $BackupPath
    $backupSize = (Get-Item $BackupPath).Length
    Log "backup: $BackupPath ($backupSize bytes, $backupSha256)"

    Section '1. CREATE/VERIFY CLEAN PG17 CLONE'
    $safeDbName = Assert-CloneDropSafety $M $MaintConn
    $quotedDbName = Get-SafePgIdentifier $safeDbName
    Invoke-PsqlOn -Conn $MaintConn -Sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$safeDbName' AND pid <> pg_backend_pid();" | Out-Null
    Invoke-PsqlOn -Conn $MaintConn -Sql "DROP DATABASE IF EXISTS $quotedDbName;" | Out-Null
    Invoke-PsqlOn -Conn $MaintConn -Sql "CREATE DATABASE $quotedDbName;" | Out-Null
    Log "clone database '$safeDbName' dropped and recreated clean"

    Section '2. RESTORE BACKUP'
    & $script:PgRestoreExe -d $Conn --no-owner --no-privileges --exit-on-error $BackupPath 2>&1 | ForEach-Object { Log $_ }
    $restoreExitCode = $LASTEXITCODE
    Log "pg_restore exit code = $restoreExitCode"
    if ($restoreExitCode -ne 0) { Fail "pg_restore failed with exit code $restoreExitCode -- no restore-run-result.json will be written" }

    Section '3. PROBE RESTORED DATABASE'
    $dbName = ScalarOn $Conn 'SELECT current_database();'
    if ($dbName -ne $M.database_name) { Fail "connected to '$dbName', expected '$($M.database_name)'" }
    $serverVersion = ScalarOn $Conn "SELECT current_setting('server_version');"
    $cloneMajor = [int](($serverVersion -split '\.')[0])
    if ($cloneMajor -ne 17) { Fail "restored clone server is PostgreSQL $serverVersion, expected major 17" }
    $probePassed = $true
    Log "probe passed: db=$dbName server_version=$serverVersion"

    Section '4. VERIFY MIGRATION CEILING = 147'
    $ceiling = [int](ScalarOn $Conn 'SELECT max(version::int) FROM supabase_migrations.schema_migrations;')
    if ($ceiling -ne 147) { Fail "restored ceiling is $ceiling, expected 147" }
    Log "ceiling = $ceiling"

    Section '5. VERIFY KEEPER'
    $keeperCount = [int](ScalarOn $Conn "SELECT count(*) FROM auth.users WHERE lower(email)=lower('$($M.keeper_email)');")
    if ($keeperCount -ne 1) { Fail "STOP_KEEPER_ACCOUNT_UNVERIFIED -- keeper email resolves to $keeperCount auth.users row(s)" }
    $keeperProfile = [int](ScalarOn $Conn @"
SELECT count(*) FROM public.profiles p JOIN auth.users u ON u.id = p.id
 WHERE lower(u.email)=lower('$($M.keeper_email)') AND p.role='super_admin' AND p.status='active' AND p.organization_id IS NULL;
"@)
    if ($keeperProfile -ne 1) { Fail "STOP_KEEPER_ACCOUNT_UNVERIFIED -- keeper has $keeperProfile active global super_admin profile(s)" }
    $keeperVerified = $true
    Log 'keeper verified'

    Section '6. VERIFY RBAC 130/415'
    $pk = [int](ScalarOn $Conn 'SELECT count(*) FROM public.permission_keys;')
    $rpd = [int](ScalarOn $Conn 'SELECT count(*) FROM public.role_permission_defaults;')
    if ($pk -ne 130 -or $rpd -ne 415) { Fail "RBAC drift (expected 130/415, got $pk/$rpd)" }
    $rbacVerified = $true
    Log "RBAC verified: permission_keys=$pk role_permission_defaults=$rpd"

    Section '7. CAPTURE TRIGGER DEFINITIONS (BEFORE)'
    $before = Get-TriggerDefinitions
    $beforePath = Join-Path $OutputDirectory 'trigger-definitions-before.txt'
    Set-Content -Path $beforePath -Value $before -Encoding utf8
    $triggerBeforeSha = Get-FileSha256 $beforePath
    Log "trigger definitions (before) captured: $triggerBeforeSha"

    Section '8. DELIBERATE ROLLBACK TEST'
    $probeTable = "phoenix_rollback_probe_$(Get-Date -Format 'yyyyMMddHHmmssfff')"
    $rollbackSql = @"
BEGIN;
CREATE TABLE public.$probeTable (id int);
INSERT INTO public.$probeTable VALUES (1);
DO `$ptag`$ BEGIN RAISE EXCEPTION 'PHOENIX_DELIBERATE_ROLLBACK_TEST'; END `$ptag`$;
COMMIT;
"@
    $rollbackFile = Join-Path $OutputDirectory 'rollback-test.sql'
    Set-Content -Path $rollbackFile -Value $rollbackSql -Encoding utf8
    $rollbackOutput = & $script:PsqlExe $Conn -X -v ON_ERROR_STOP=1 -f $rollbackFile 2>&1
    $rollbackExitCode = $LASTEXITCODE
    # This failure is EXPECTED: the RAISE EXCEPTION must abort the transaction
    # before COMMIT, so a zero exit code here means the test did not run as
    # designed, not that it passed.
    if ($rollbackExitCode -eq 0) { Fail 'the deliberate rollback test did not fail as expected -- the RAISE EXCEPTION did not fire' }
    if ($rollbackOutput -notmatch 'PHOENIX_DELIBERATE_ROLLBACK_TEST') { Fail 'the deliberate rollback test failed for the wrong reason -- expected marker not found in output' }
    $stillExists = ScalarOn $Conn "SELECT (to_regclass('public.$probeTable') IS NOT NULL);"
    if ($stillExists -match 'true') { Fail "the deliberate rollback test table still exists -- ROLLBACK did not discard the change" }
    $deliberateRollbackPassed = $true
    $rollbackReport = [ordered]@{
        probe_table       = $probeTable
        exit_code         = $rollbackExitCode
        marker_seen       = $true
        table_exists_after = $false
        passed            = $true
    }
    $rollbackReportPath = Join-Path $OutputDirectory 'rollback-report.json'
    ($rollbackReport | ConvertTo-Json -Depth 5) | Set-Content -Path $rollbackReportPath -Encoding utf8
    $rollbackReportSha = Get-FileSha256 $rollbackReportPath
    Log "deliberate rollback test passed: $rollbackReportSha"

    Section '9. CAPTURE TRIGGER DEFINITIONS (AFTER)'
    $after = Get-TriggerDefinitions
    $afterPath = Join-Path $OutputDirectory 'trigger-definitions-after.txt'
    Set-Content -Path $afterPath -Value $after -Encoding utf8
    $triggerAfterSha = Get-FileSha256 $afterPath
    if ($before -ne $after) { Fail 'trigger definitions changed across the rollback test -- immutability triggers were not restored identically' }
    Log "trigger definitions (after) captured and identical: $triggerAfterSha"

    Section '10. RECONCILIATION'
    $dupes = [int](ScalarOn $Conn 'SELECT count(*) FROM (SELECT version FROM supabase_migrations.schema_migrations GROUP BY version HAVING count(*)>1) d;')
    if ($dupes -ne 0) { Fail "$dupes duplicated migration version(s)" }
    $invalidFk = [int](ScalarOn $Conn "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated;")
    if ($invalidFk -ne 0) { Fail "$invalidFk unvalidated FK constraint(s)" }
    $reconciliationPassed = $true
    $reconciliationReport = [ordered]@{
        migration_ceiling               = $ceiling
        duplicate_migration_versions    = $dupes
        unvalidated_fk_constraints      = $invalidFk
        keeper_verified                 = $keeperVerified
        rbac_permission_keys            = $pk
        rbac_role_permission_defaults   = $rpd
        passed                          = $true
    }
    $reconciliationReportPath = Join-Path $OutputDirectory 'pre-purge-reconciliation-report.json'
    ($reconciliationReport | ConvertTo-Json -Depth 5) | Set-Content -Path $reconciliationReportPath -Encoding utf8
    $reconciliationReportSha = Get-FileSha256 $reconciliationReportPath
    Log "reconciliation passed: $reconciliationReportSha"

    Section '11. WRITE restore-run-result.json'
    $result = [ordered]@{
        restore_exit_code                       = $restoreExitCode
        restored_database_probe_passed          = $probePassed
        migration_ceiling                       = $ceiling
        keeper_verified                         = $keeperVerified
        rbac_130_415_verified                   = $rbacVerified
        trigger_definition_before_sha256        = $triggerBeforeSha
        trigger_definition_after_sha256         = $triggerAfterSha
        deliberate_rollback_passed              = $deliberateRollbackPassed
        reconciliation_passed                   = $reconciliationPassed
        clone_pg_major                          = $cloneMajor
        pre_purge_reconciliation_report_sha256  = $reconciliationReportSha
        rollback_report_sha256                  = $rollbackReportSha
        restore_started_at_utc                  = $restoreStartedAtUtc
        restore_completed_at_utc                = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        clone_server_version                    = $serverVersion
        backup_path                             = $BackupPath
        backup_sha256                           = $backupSha256
        backup_size                             = $backupSize
    }
    ($result | ConvertTo-Json -Depth 5) | Set-Content -Path $RestoreResultTmpPath -Encoding utf8

    Section '12. SELF-VALIDATE'
    # Re-parse what was actually written to disk (not the in-memory $result)
    # and run it through the exact same validator every downstream consumer
    # uses, before the file is ever visible under its final name.
    $roundTripped = Get-Content $RestoreResultTmpPath -Raw | ConvertFrom-Json
    Test-RestoreRunReport $roundTripped
    Log 'self-validation passed: written result re-parses and satisfies every check'

    Move-Item -Path $RestoreResultTmpPath -Destination $RestoreResultPath -Force

    Section 'RESULT: COMPLETED'
    Log "restore-run-result.json written atomically: $RestoreResultPath"
    Log 'Pass this file to ops\generate-restore-proof.ps1 -RestoreRunReportPath.'
}
catch {
    Section 'RESULT: STOPPED'
    Log ('ERROR: ' + $_.Exception.Message)
    foreach ($stale in @($RestoreResultPath, $RestoreResultTmpPath)) {
        if (Test-Path $stale) {
            Remove-Item $stale -Force -ErrorAction SilentlyContinue
            Log "removed evidence from the failed attempt: $stale"
        }
    }
    Log 'No restore-run-result.json was written.'
    exit 1
}
finally {
    Get-Process psql, pg_restore -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $report = Join-Path $OutputDirectory ('restore-rehearsal-' + (Get-Date -Format 'yyyyMMddTHHmmssZ') + '.log')
    $LogLines | Set-Content -Path $report -Encoding utf8
    Write-Host ''
    Write-Host "Log: $report"
}
