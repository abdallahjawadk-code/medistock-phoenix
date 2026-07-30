<#
================================================================================
 Shared release execution stages.

 Dot-sourced by ops\run-prelaunch-release-core.ps1 so there is exactly ONE
 implementation of the destructive path. There is deliberately no staging copy
 and no production copy: rehearsal_clone, staging and production all execute
 these same functions in this same order, differing only by the target manifest
 and the credentials the operator types.

 Never run this file directly -- it has no gates of its own.
================================================================================
#>

function Invoke-PsqlOn {
    param($Conn, [string]$Sql, [string]$File, [switch]$Quiet)
    $a = @('-X', '-v', 'ON_ERROR_STOP=1', '--no-password')
    if ($Quiet) { $a += @('-A', '-t') }
    if ($File)  { $a += @('-f', $File) } else { $a += @('-c', $Sql) }
    $out = & $script:PsqlExe $Conn @a 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("psql exited $LASTEXITCODE`n" + ($out -join "`n")) }
    return $out
}
function ScalarOn($Conn, [string]$Sql) {
    (Invoke-PsqlOn -Conn $Conn -Sql $Sql -Quiet | Select-Object -First 1).ToString().Trim()
}

function Invoke-ReleaseStages {
    param($M, [string]$Conn, [string]$WorkDir, [string]$PurgeSql)

    $isClone  = ($M.environment -eq 'rehearsal_clone')
    $isProd   = ($M.environment -eq 'production')

    # ------------------------------------------------------------- A. probe
    Section '5. READ-ONLY PROBE'
    (Invoke-PsqlOn -Conn $Conn -Sql @"
SELECT current_database() AS db,
       current_user       AS role,
       COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl,
       current_setting('server_version') AS ver;
"@) | ForEach-Object { Log $_ }

    $serverMajor = [int]((ScalarOn $Conn "SELECT split_part(current_setting('server_version'),'.',1);"))
    Log "server major = $serverMajor"
    if ($serverMajor -ne [int]$M.required_pg_major) {
        Fail "server is PostgreSQL $serverMajor but this target requires $($M.required_pg_major) -- rehearsal parity would be void"
    }

    $ceiling = [int](ScalarOn $Conn "SELECT max(version::int) FROM supabase_migrations.schema_migrations;")
    Log "migration ceiling = $ceiling"
    if ($ceiling -ne [int]$M.expected_initial_ceiling) {
        Fail "STOP_MIGRATION_BASELINE_DRIFT -- ceiling is $ceiling, expected $($M.expected_initial_ceiling)"
    }
    $dupes = [int](ScalarOn $Conn "SELECT count(*) FROM (SELECT version FROM supabase_migrations.schema_migrations GROUP BY version HAVING count(*)>1) d;")
    if ($dupes -ne 0) { Fail "$dupes duplicated migration version(s)" }

    $keeperCount = [int](ScalarOn $Conn "SELECT count(*) FROM auth.users WHERE lower(email)=lower('$($M.keeper_email)');")
    if ($keeperCount -ne 1) { Fail "STOP_KEEPER_ACCOUNT_UNVERIFIED -- keeper email resolves to $keeperCount auth.users row(s)" }
    $keeperProfile = [int](ScalarOn $Conn @"
SELECT count(*) FROM public.profiles p JOIN auth.users u ON u.id = p.id
 WHERE lower(u.email)=lower('$($M.keeper_email)')
   AND p.role='super_admin' AND p.status='active' AND p.organization_id IS NULL;
"@)
    if ($keeperProfile -ne 1) { Fail "STOP_KEEPER_ACCOUNT_UNVERIFIED -- keeper has $keeperProfile active global super_admin profile(s)" }
    Log 'keeper verified'

    $pk  = [int](ScalarOn $Conn "SELECT count(*) FROM public.permission_keys;")
    $rpd = [int](ScalarOn $Conn "SELECT count(*) FROM public.role_permission_defaults;")
    Log "RBAC: permission_keys=$pk role_permission_defaults=$rpd"
    if ($pk -ne 130 -or $rpd -ne 415) { Fail 'RBAC drift (expected 130/415)' }

    $storage = [int](ScalarOn $Conn "SELECT CASE WHEN to_regclass('storage.objects') IS NULL THEN 0 ELSE (SELECT count(*) FROM storage.objects) END;")
    Log "storage.objects = $storage"

    # ------------------------------------------------------------ B. backup
    Section '6. BACKUP GATE'
    $dump = Join-Path $WorkDir 'pre-purge.dump'
    Log "creating logical backup -> $dump"
    & $script:DumpExe $Conn --format=custom --no-owner --no-privileges --file $dump
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $dump) { Remove-Item $dump -Force -ErrorAction SilentlyContinue }
        Fail "pg_dump failed with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path $dump)) { Fail 'pg_dump reported success but produced no file' }
    $size = (Get-Item $dump).Length
    if ($size -lt 100KB) {
        Remove-Item $dump -Force -ErrorAction SilentlyContinue
        Fail "dump is implausibly small ($size bytes) -- refusing to treat it as a backup"
    }
    $script:DumpPath = $dump
    $script:DumpSize = $size
    $script:DumpHash = (Get-FileHash -Path $dump -Algorithm SHA256).Hash.ToLower()
    Log ("dump created: {0:N0} bytes" -f $size)
    Log ("dump SHA-256: $($script:DumpHash)")

    if (-not $isClone) {
        Write-Host ''
        Write-Host 'Confirm a RESTORABLE platform backup exists for this project.'
        Write-Host 'The local dump above is a second line of defence, not a substitute.'
        $ok = Read-Host 'Type EXACTLY  I HAVE A RESTORABLE BACKUP  to continue'
        if ($ok -ne 'I HAVE A RESTORABLE BACKUP') { Fail 'backup not confirmed -- STOP_RESTORABLE_BACKUP_UNVERIFIED' }
    } else {
        Log 'clone target: the clone IS the restore proof, no platform backup confirmation required'
    }

    # ----------------------------------------------------------- C. storage
    Section '7. STORAGE GATE'
    if ($storage -ne 0) {
        Fail @"
storage.objects = $storage, expected 0.

Storage files live in object storage as well as in the storage schema, so SQL
cannot delete them and a zero row count would be a FALSE zero-state. Purge
Storage through the official Storage API first, then re-run.
"@
    }
    Log 'storage is empty'

    # ------------------------------------------------------------- D. purge
    Section '8. PURGE -- one atomic transaction, one attempt'
    Write-Host "This permanently deletes ALL business data on: $($M.environment) / $($M.project_ref)"
    Write-Host "Only $($M.keeper_email) survives."
    $go = Read-Host 'Type EXACTLY  PURGE PRODUCTION NOW  to proceed'
    if ($go -ne 'PURGE PRODUCTION NOW') { Fail 'purge not confirmed by operator' }

    $wrapper = Join-Path $WorkDir 'purge-session.sql'
    @"
SET phoenix.purge_attestation = 'I_ATTEST_PRODUCTION_FULL_PURGE_V147_OPTION_A';
\i $($PurgeSql -replace '\\','/')
"@ | Set-Content -Path $wrapper -Encoding utf8

    Log 'executing purge...'
    (Invoke-PsqlOn -Conn $Conn -File $wrapper) | ForEach-Object { Log $_ }
    Log 'purge transaction COMMITTED'

    # ---------------------------------------------------- E. reconciliation
    Section '9. POST-PURGE RECONCILIATION'
    $checks = [ordered]@{
        'auth.users'               = @{ sql = "SELECT count(*) FROM auth.users;"; want = 1 }
        'profiles'                 = @{ sql = "SELECT count(*) FROM public.profiles;"; want = 1 }
        'keeper present'           = @{ sql = "SELECT count(*) FROM auth.users WHERE lower(email)=lower('$($M.keeper_email)');"; want = 1 }
        'active super_admins'      = @{ sql = "SELECT count(*) FROM public.profiles WHERE role='super_admin' AND status='active';"; want = 1 }
        'organizations'            = @{ sql = "SELECT count(*) FROM public.organizations;"; want = 0 }
        'warehouses'               = @{ sql = "SELECT count(*) FROM public.warehouses;"; want = 0 }
        'distribution_points'      = @{ sql = "SELECT count(*) FROM public.distribution_points;"; want = 0 }
        'central_items'            = @{ sql = "SELECT count(*) FROM public.central_items;"; want = 0 }
        'permission_keys'          = @{ sql = "SELECT count(*) FROM public.permission_keys;"; want = 130 }
        'role_permission_defaults' = @{ sql = "SELECT count(*) FROM public.role_permission_defaults;"; want = 415 }
        'migration ceiling'        = @{ sql = "SELECT max(version::int) FROM supabase_migrations.schema_migrations;"; want = [int]$M.expected_initial_ceiling }
    }
    $bad = @()
    foreach ($k in $checks.Keys) {
        $got = [int](ScalarOn $Conn $checks[$k].sql)
        Log ('  {0,-26} = {1,-6} (expected {2})' -f $k, $got, $checks[$k].want)
        if ($got -ne $checks[$k].want) { $bad += "$k = $got, expected $($checks[$k].want)" }
    }
    if ($bad.Count -gt 0) { Fail ("post-purge reconciliation failed:`n" + ($bad -join "`n")) }
    Log 'CANONICAL_PRELAUNCH_EMPTY_BASELINE confirmed'

    # -------------------------------------------------------- F. migrations
    Section '10. MIGRATIONS -> ceiling ' + $M.expected_final_ceiling
    if ($isClone) {
        # No Supabase CLI on a clone: apply the files directly, in order, and
        # record them exactly as the CLI would.
        Log 'clone target: applying migration files directly (no Supabase CLI)'
        $from = [int]$M.expected_initial_ceiling + 1
        $to   = [int]$M.expected_final_ceiling
        $dir  = Join-Path $RepoRoot 'supabase\migrations'
        for ($n = $from; $n -le $to; $n++) {
            $pat = '{0:d3}_*.sql' -f $n
            $f = Get-ChildItem $dir -Filter $pat -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $f) { Fail "migration $n not found in $dir" }
            Log "applying $($f.Name)"
            Invoke-PsqlOn -Conn $Conn -File $f.FullName | Out-Null
            Invoke-PsqlOn -Conn $Conn -Sql ("INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('{0:d3}');" -f $n) | Out-Null
        }
    } else {
        Push-Location $RepoRoot
        try {
            & supabase link --project-ref $M.project_ref --password $env:PGPASSWORD 2>&1 | ForEach-Object { Log $_ }
            & supabase db push --linked 2>&1 | ForEach-Object { Log $_ }
            if ($LASTEXITCODE -ne 0) { Fail "supabase db push failed ($LASTEXITCODE)" }
        } finally { Pop-Location }
    }

    $finalCeiling = [int](ScalarOn $Conn "SELECT max(version::int) FROM supabase_migrations.schema_migrations;")
    Log "ceiling after migrations = $finalCeiling"
    if ($finalCeiling -ne [int]$M.expected_final_ceiling) {
        Fail "expected ceiling $($M.expected_final_ceiling), got $finalCeiling"
    }
    $dupes2 = [int](ScalarOn $Conn "SELECT count(*) FROM (SELECT version FROM supabase_migrations.schema_migrations GROUP BY version HAVING count(*)>1) d;")
    if ($dupes2 -ne 0) { Fail 'duplicate migration versions after apply' }

    Section '11. POST-APPLY VERIFICATION'
    foreach ($k in @('auth.users','keeper present','permission_keys','role_permission_defaults')) {
        $got = [int](ScalarOn $Conn $checks[$k].sql)
        Log ('  {0,-26} = {1}' -f $k, $got)
        if ($got -ne $checks[$k].want) { Fail "$k drifted after migrations: $got" }
    }
    $invalid = [int](ScalarOn $Conn "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated;")
    if ($invalid -ne 0) { Fail "$invalid unvalidated FK constraint(s)" }
    Log 'post-apply verification passed'

    if ($isProd) {
        Log 'production run complete -- merge and deployment are driven separately.'
    } else {
        Log "rehearsal complete on '$($M.environment)'. Record the results in a rehearsal artifact before any production run."
    }
}
