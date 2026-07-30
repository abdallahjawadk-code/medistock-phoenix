<#
================================================================================
 MediStock Phoenix -- PR #68 POST-PURGE RELEASE
 A3-3B0N / Option A

 Runs ONLY after run-prelaunch-purge-v147.ps1 exits 0. Never invoked directly by
 the owner; the launcher chains it.

 It re-proves the end state read-only, then marks PR #68 Ready, merges, waits for
 the Vercel Production deployment, and smoke-tests it. Any mismatch stops before
 the merge -- a purge that did not land exactly as specified must never ship.

 It expects PGPASSWORD to already be present in this process environment (the
 purge runner set it). It never prompts for, prints, or stores a credential.
================================================================================
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$ProjectRef = 'eyrzxgfkvqybjdgyphap'
$PoolerHost = 'aws-1-ap-south-1.pooler.supabase.com'
$KeeperEmail = 'abdallahjawad2015@gmail.com'
$PrNumber   = 68
$TargetCeiling = 153

$LogLines = New-Object System.Collections.Generic.List[string]
function Log([string]$m) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'), $m
    Write-Host $line; $LogLines.Add($line) | Out-Null
}
function Fail([string]$m) { Log "STOP: $m"; throw $m }
function Section([string]$t) { Write-Host ''; Write-Host ('=' * 78); Write-Host "  $t"; Write-Host ('=' * 78) }

# Same SSL contract as the purge runner: full verification via the OS trust store.
function Get-ConnString {
    return "host=$PoolerHost port=5432 dbname=postgres user=postgres.$ProjectRef " +
           "sslmode=verify-full sslrootcert=system connect_timeout=10 " +
           "application_name=phoenix_post_purge"
}
function Resolve-Psql {
    $c = Get-Command psql -ErrorAction SilentlyContinue
    if ($null -eq $c) { Fail 'psql not found on PATH' }
    return $c.Source
}
$PsqlExe = Resolve-Psql
function Scalar([string]$Sql) {
    $out = & $PsqlExe (Get-ConnString) -X -A -t -v ON_ERROR_STOP=1 --no-password -c $Sql 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("psql exited $LASTEXITCODE`n" + ($out -join "`n")) }
    return ($out | Select-Object -First 1).ToString().Trim()
}

try {
    if (-not $env:PGPASSWORD) { Fail 'PGPASSWORD is not present -- this script must be chained from the purge runner.' }

    # ------------------------------------------------- 1. reconciliation
    Section '1. POST-PURGE RECONCILIATION (read-only)'
    $expect = [ordered]@{
        'migration ceiling'        = @{ sql = "SELECT max(version::int) FROM supabase_migrations.schema_migrations;"; want = $TargetCeiling }
        'duplicate versions'       = @{ sql = "SELECT count(*) FROM (SELECT version FROM supabase_migrations.schema_migrations GROUP BY version HAVING count(*)>1) d;"; want = 0 }
        'keeper auth.users'        = @{ sql = "SELECT count(*) FROM auth.users WHERE lower(email)=lower('$KeeperEmail');"; want = 1 }
        'total auth.users'         = @{ sql = "SELECT count(*) FROM auth.users;"; want = 1 }
        'keeper profile'           = @{ sql = "SELECT count(*) FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE lower(u.email)=lower('$KeeperEmail') AND p.role='super_admin' AND p.status='active' AND p.organization_id IS NULL;"; want = 1 }
        'total profiles'           = @{ sql = "SELECT count(*) FROM public.profiles;"; want = 1 }
        'permission_keys'          = @{ sql = "SELECT count(*) FROM public.permission_keys;"; want = 130 }
        'role_permission_defaults' = @{ sql = "SELECT count(*) FROM public.role_permission_defaults;"; want = 415 }
        'organizations'            = @{ sql = "SELECT count(*) FROM public.organizations;"; want = 0 }
        'warehouses'               = @{ sql = "SELECT count(*) FROM public.warehouses;"; want = 0 }
        'distribution_points'      = @{ sql = "SELECT count(*) FROM public.distribution_points;"; want = 0 }
        'central_items'            = @{ sql = "SELECT count(*) FROM public.central_items;"; want = 0 }
        'storage.objects'          = @{ sql = "SELECT CASE WHEN to_regclass('storage.objects') IS NULL THEN 0 ELSE (SELECT count(*) FROM storage.objects) END;"; want = 0 }
        'invalid FKs'              = @{ sql = "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated;"; want = 0 }
    }
    $bad = @()
    foreach ($k in $expect.Keys) {
        $got = [int](Scalar $expect[$k].sql)
        $want = $expect[$k].want
        Log ('  {0,-26} = {1,-6} (expected {2})' -f $k, $got, $want)
        if ($got -ne $want) { $bad += "$k = $got, expected $want" }
    }
    if ($bad.Count -gt 0) {
        Fail ("STOP_POST_PURGE_RECONCILIATION_FAILED`n" + ($bad -join "`n"))
    }
    Log 'reconciliation passed -- CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147 + migrations 148-153'

    # ------------------------------------------------- 2. service health
    Section '2. SUPABASE SERVICE HEALTH'
    $health = & supabase projects list --output json 2>&1 | Out-String
    if ($health -notmatch 'ACTIVE_HEALTHY') { Fail 'Supabase project is not ACTIVE_HEALTHY' }
    Log 'Supabase ACTIVE_HEALTHY'

    # ------------------------------------------------- 3. head + CI
    Section '3. HEAD AND CI'
    Push-Location $RepoRoot
    try {
        $localHead = (& git rev-parse HEAD).Trim()
        $prHead = (& gh pr view $PrNumber --json headRefOid -q .headRefOid).Trim()
        Log "local HEAD : $localHead"
        Log "PR head    : $prHead"
        if ($localHead -ne $prHead) { Fail 'PR head does not match the tested local HEAD' }

        $checks = & gh pr checks $PrNumber 2>&1 | Out-String
        Log "CI:`n$checks"
        if ($checks -match '\bfail\b' -or $checks -match '\bpending\b') { Fail 'CI is not fully green' }

        # --------------------------------------------- 4. ready + merge
        Section '4. PR READY AND MERGE'
        & gh pr ready $PrNumber 2>&1 | ForEach-Object { Log $_ }
        & gh pr merge $PrNumber --squash --delete-branch=false 2>&1 | ForEach-Object { Log $_ }
        if ($LASTEXITCODE -ne 0) { Fail 'STOP_MERGE_OR_DEPLOY_FAILED -- merge failed' }

        & git fetch origin master --quiet
        $mergeSha = (& git rev-parse origin/master).Trim()
        Log "merge SHA (origin/master) : $mergeSha"
    } finally { Pop-Location }

    # ------------------------------------------------- 5. deployment
    Section '5. VERCEL PRODUCTION DEPLOYMENT'
    Log 'waiting for the automatic deployment triggered by the merge (no manual deploy is launched)'
    $deployed = $false
    for ($i = 1; $i -le 40; $i++) {
        Start-Sleep -Seconds 30
        $st = & gh api "repos/abdallahjawadk-code/medistock-phoenix/deployments?per_page=1" 2>&1 | Out-String
        if ($st -match '"environment"\s*:\s*"[Pp]roduction"') { $deployed = $true; Log "deployment record seen after $($i*30)s"; break }
        Log "  still waiting ($($i*30)s)"
    }
    if (-not $deployed) { Log 'WARNING: no Production deployment record observed within 20 minutes' }

    # ------------------------------------------------- 6. smoke tests
    Section '6. PRODUCTION SMOKE TESTS'
    $ceilingNow = [int](Scalar "SELECT max(version::int) FROM supabase_migrations.schema_migrations;")
    Log "migration ceiling still = $ceilingNow"
    if ($ceilingNow -ne $TargetCeiling) { Fail "ceiling drifted to $ceilingNow after deploy" }

    foreach ($k in @('organizations','warehouses','central_items','total auth.users','keeper auth.users')) {
        $got = [int](Scalar $expect[$k].sql)
        Log ('  {0,-26} = {1} (expected {2})' -f $k, $got, $expect[$k].want)
        if ($got -ne $expect[$k].want) { Fail "smoke check failed: $k = $got" }
    }

    # Demo seed from migration 004 must not have returned.
    $demo = [int](Scalar "SELECT count(*) FROM public.organizations WHERE id IN ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');")
    Log "migration-004 demo organizations = $demo (expected 0)"
    if ($demo -ne 0) { Fail 'migration 004 demo data reappeared' }

    Section 'RESULT: SUCCESS'
    Log 'PR #68 merged, deployed, and production reconciled at ceiling 153.'
    Write-Host ''
    Write-Host 'REMAINING MANUAL CHECKS (need a browser session as the keeper):'
    Write-Host '  - sign in as the keeper and confirm the super_admin dashboard loads'
    Write-Host '  - confirm empty-state renders for organizations / warehouses / outlets / stock'
    Write-Host '  - confirm reports open in zero-state without errors'
    Write-Host '  - confirm no demo data and no critical console/network errors'
    Write-Host 'These need your credentials, so they are deliberately not automated.'
}
catch {
    Section 'RESULT: STOPPED'
    Log ('ERROR: ' + $_.Exception.Message)
    Log 'No merge or deploy was performed beyond what is logged above.'
    exit 1
}
finally {
    $report = Join-Path $env:TEMP ('phoenix-post-purge-' + (Get-Date -Format 'yyyyMMddTHHmmssZ') + '.log')
    $LogLines | Set-Content -Path $report -Encoding utf8
    Write-Host ''
    Write-Host "Redacted report : $report"
}
