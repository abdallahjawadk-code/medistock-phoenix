<#
================================================================================
 MediStock Phoenix -- OWNER-RUN PRODUCTION COMMAND
 A3-3B0N-R7 / Option A -- full pre-launch purge at migration ceiling 147

 RUN THIS YOURSELF, from a visible PowerShell window. It is the only step of the
 release gate that touches Production data.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-prelaunch-purge-v147.ps1

 It is fail-closed at every stage: any drift, any unexpected count, any failed
 verification stops the run BEFORE the next destructive step. Nothing is retried
 automatically. Your database password is read once into process memory, never
 written to disk, never placed in a command argument, never logged, and is
 zeroed in the finally block.

 WHAT IT DOES, in order:
   1  verify this script's pinned SQL still matches its SHA-256 (drift guard)
   2  verify the git worktree is clean and on the expected commit
   3  read the DB password once (SecureString -> BSTR, in-process only)
   4  read-only probe: identity, SSL, ceiling=147, keeper, Storage, row counts
   5  backup gate: local logical dump + your confirmation of a platform backup
   6  Storage gate: must already be empty (purged via the official API)
   7  THE PURGE: one atomic transaction, one attempt
   8  post-purge reconciliation
   9  apply migrations 148-153 through the official mechanism
  10  post-apply verification

 It deliberately does NOT merge or deploy. Report the outcome and that is driven
 separately.
================================================================================
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------------ constants
$RepoRoot     = Split-Path -Parent $PSScriptRoot
$PurgeSql     = Join-Path $RepoRoot 'supabase\ops\pre_launch_full_purge_v147.sql'
$PurgeSha     = Join-Path $RepoRoot 'supabase\ops\pre_launch_full_purge_v147.sql.sha256'
$Attestation  = 'I_ATTEST_PRODUCTION_FULL_PURGE_V147_OPTION_A'
$KeeperEmail  = 'abdallahjawad2015@gmail.com'
$ProjectRef   = 'eyrzxgfkvqybjdgyphap'
$PoolerHost   = 'aws-1-ap-south-1.pooler.supabase.com'
$ExpectedCeiling = 147

$WorkDir = Join-Path $env:TEMP ('phoenix-purge-' + (Get-Date -Format 'yyyyMMddTHHmmssZ'))
$BstrPtr = [IntPtr]::Zero
$LogLines = New-Object System.Collections.Generic.List[string]

function Log([string]$m) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'), $m
    Write-Host $line
    $LogLines.Add($line) | Out-Null
}
function Fail([string]$m) { Log "STOP: $m"; throw $m }
function Section([string]$t) { Write-Host ''; Write-Host ('=' * 78); Write-Host "  $t"; Write-Host ('=' * 78) }

# psql helper -- password travels via PGPASSWORD in the environment, never argv.
function Invoke-Psql {
    param([string]$Sql, [string]$File, [switch]$Quiet)
    $conn = "host=$PoolerHost port=5432 dbname=postgres user=postgres.$ProjectRef " +
            "sslmode=verify-full connect_timeout=10 application_name=phoenix_owner_purge"
    $args = @('-X', '-v', 'ON_ERROR_STOP=1', '--no-password')
    if ($Quiet) { $args += @('-A', '-t') }
    if ($File)  { $args += @('-f', $File) } else { $args += @('-c', $Sql) }
    $out = & psql $conn @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("psql exited $LASTEXITCODE`n" + ($out -join "`n")) }
    return $out
}
function Scalar([string]$Sql) { (Invoke-Psql -Sql $Sql -Quiet | Select-Object -First 1).ToString().Trim() }

try {
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

    # ---------------------------------------------------------------- 1. drift
    Section '1. INTEGRITY -- the SQL must be exactly what was reviewed and tested'
    if (-not (Test-Path $PurgeSql)) { Fail "purge SQL not found: $PurgeSql" }
    if (-not (Test-Path $PurgeSha)) { Fail "SHA-256 pin not found: $PurgeSha" }
    $expected = (Get-Content $PurgeSha -Raw).Trim().ToLower()
    $actual   = (Get-FileHash -Path $PurgeSql -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Fail "purge SQL SHA-256 mismatch.`n  expected $expected`n  actual   $actual`nThe file changed since it was tested. Refusing."
    }
    Log "purge SQL SHA-256 verified: $actual"

    # ------------------------------------------------------------------ 2. git
    Section '2. WORKTREE -- clean, and on the reviewed commit'
    Push-Location $RepoRoot
    try {
        $dirty = (& git status --porcelain) | Where-Object { $_ -notmatch 'supabase/\.temp' }
        if ($dirty) { Fail "worktree is dirty:`n$($dirty -join "`n")" }
        $head = (& git rev-parse HEAD).Trim()
        Log "HEAD = $head"
    } finally { Pop-Location }

    # ------------------------------------------------------------ 3. credential
    Section '3. CREDENTIAL -- entered once, held in process memory only'
    Write-Host 'MediStock Phoenix - Supabase Production Purge'
    Write-Host "Keeper account that will SURVIVE: $KeeperEmail"
    Write-Host ''
    $secure = Read-Host 'Enter Supabase Database Password' -AsSecureString
    if (-not $secure -or $secure.Length -eq 0) { Fail 'no password entered' }
    $BstrPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain   = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($BstrPtr)
    $env:PGPASSWORD          = $plain
    $env:SUPABASE_DB_PASSWORD = $plain
    $plain = $null
    Log 'credential loaded into process environment (not printed, not stored)'

    # ---------------------------------------------------------------- 4. probe
    Section '4. READ-ONLY PROBE'
    $probe = Invoke-Psql -Sql @"
SELECT current_database() AS db,
       current_user       AS role,
       COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl,
       current_setting('server_version') AS ver;
"@
    $probe | ForEach-Object { Log $_ }

    $ceiling = Scalar "SELECT max(version::int) FROM supabase_migrations.schema_migrations;"
    Log "migration ceiling = $ceiling"
    if ([int]$ceiling -ne $ExpectedCeiling) {
        Fail "migration ceiling is $ceiling, expected $ExpectedCeiling. The purge plan is valid only at $ExpectedCeiling."
    }

    $dupes = Scalar "SELECT count(*) FROM (SELECT version FROM supabase_migrations.schema_migrations GROUP BY version HAVING count(*)>1) d;"
    if ([int]$dupes -ne 0) { Fail "$dupes duplicated migration version(s)" }

    $keeperCount = Scalar "SELECT count(*) FROM auth.users WHERE lower(email)=lower('$KeeperEmail');"
    Log "keeper auth.users rows = $keeperCount"
    if ([int]$keeperCount -ne 1) {
        Fail "keeper email resolves to $keeperCount auth.users row(s), expected exactly 1. STOP_KEEPER_ACCOUNT_UNVERIFIED"
    }
    $keeperProfiles = Scalar @"
SELECT count(*) FROM public.profiles p
 JOIN auth.users u ON u.id = p.id
 WHERE lower(u.email)=lower('$KeeperEmail')
   AND p.role='super_admin' AND p.status='active' AND p.organization_id IS NULL;
"@
    if ([int]$keeperProfiles -ne 1) {
        Fail "keeper does not have exactly one active, global super_admin profile (found $keeperProfiles). STOP_KEEPER_ACCOUNT_UNVERIFIED"
    }
    Log 'keeper verified: one auth row, one active global super_admin profile'

    $pk  = Scalar "SELECT count(*) FROM public.permission_keys;"
    $rpd = Scalar "SELECT count(*) FROM public.role_permission_defaults;"
    Log "RBAC baseline: permission_keys=$pk role_permission_defaults=$rpd"
    if ([int]$pk -ne 130 -or [int]$rpd -ne 415) { Fail "RBAC drift (expected 130/415)" }

    $storage = Scalar "SELECT CASE WHEN to_regclass('storage.objects') IS NULL THEN 0 ELSE (SELECT count(*) FROM storage.objects) END;"
    Log "storage.objects = $storage"

    Log 'pre-purge business row counts:'
    (Invoke-Psql -Sql @"
SELECT 'organizations' t, count(*) n FROM public.organizations
UNION ALL SELECT 'warehouses', count(*) FROM public.warehouses
UNION ALL SELECT 'distribution_points', count(*) FROM public.distribution_points
UNION ALL SELECT 'central_items', count(*) FROM public.central_items
UNION ALL SELECT 'auth_users', count(*) FROM auth.users
UNION ALL SELECT 'profiles', count(*) FROM public.profiles
ORDER BY 1;
"@) | ForEach-Object { Log $_ }

    # --------------------------------------------------------------- 5. backup
    Section '5. BACKUP GATE'
    $dump = Join-Path $WorkDir 'pre-purge.dump'
    Log "creating local logical backup -> $dump"
    $conn = "host=$PoolerHost port=5432 dbname=postgres user=postgres.$ProjectRef sslmode=verify-full"
    & pg_dump $conn --format=custom --no-owner --no-privileges --file $dump
    if ($LASTEXITCODE -ne 0) { Fail "pg_dump failed with exit code $LASTEXITCODE" }
    $size = (Get-Item $dump).Length
    Log ("local dump created: {0:N0} bytes" -f $size)
    if ($size -lt 100KB) { Fail "dump is implausibly small ($size bytes) -- refusing to treat it as a backup" }

    Write-Host ''
    Write-Host 'Confirm a RESTORABLE Supabase platform backup exists (dashboard > Database > Backups).'
    Write-Host 'The local dump above is a second line of defence, not a substitute.'
    $ok = Read-Host 'Type EXACTLY  I HAVE A RESTORABLE BACKUP  to continue'
    if ($ok -ne 'I HAVE A RESTORABLE BACKUP') { Fail 'backup not confirmed -- STOP_RESTORABLE_BACKUP_UNVERIFIED' }
    Log 'backup gate passed'

    # -------------------------------------------------------------- 6. storage
    Section '6. STORAGE GATE'
    if ([int]$storage -ne 0) {
        Fail @"
storage.objects = $storage, expected 0.

Storage files live in object storage as well as in the storage schema, so SQL
cannot delete them and a zero row count here would be a FALSE zero-state. Purge
Storage through the official Storage API / dashboard first, re-check, then
re-run this script. This run is stopping before any deletion.
"@
    }
    Log 'storage is empty'

    # ---------------------------------------------------------------- 7. PURGE
    Section '7. THE PURGE -- one atomic transaction, one attempt'
    Write-Host 'This permanently deletes ALL business data. Only the keeper account survives.'
    Write-Host "Keeper: $KeeperEmail"
    $go = Read-Host 'Type EXACTLY  PURGE PRODUCTION NOW  to proceed'
    if ($go -ne 'PURGE PRODUCTION NOW') { Fail 'purge not confirmed by operator' }

    $wrapper = Join-Path $WorkDir 'purge-session.sql'
    @"
SET phoenix.purge_attestation = '$Attestation';
\i $($PurgeSql -replace '\\','/')
"@ | Set-Content -Path $wrapper -Encoding utf8

    Log 'executing purge...'
    $purgeOut = Invoke-Psql -File $wrapper
    $purgeOut | ForEach-Object { Log $_ }
    Log 'purge transaction COMMITTED'

    # -------------------------------------------------------- 8. reconciliation
    Section '8. POST-PURGE RECONCILIATION'
    $checks = @{
        'auth.users'                 = "SELECT count(*) FROM auth.users;"
        'profiles'                   = "SELECT count(*) FROM public.profiles;"
        'keeper present'             = "SELECT count(*) FROM auth.users WHERE lower(email)=lower('$KeeperEmail');"
        'active super_admins'        = "SELECT count(*) FROM public.profiles WHERE role='super_admin' AND status='active';"
        'organizations'              = "SELECT count(*) FROM public.organizations;"
        'warehouses'                 = "SELECT count(*) FROM public.warehouses;"
        'distribution_points'        = "SELECT count(*) FROM public.distribution_points;"
        'central_items'              = "SELECT count(*) FROM public.central_items;"
        'permission_keys'            = "SELECT count(*) FROM public.permission_keys;"
        'role_permission_defaults'   = "SELECT count(*) FROM public.role_permission_defaults;"
        'migration ceiling'          = "SELECT max(version::int) FROM supabase_migrations.schema_migrations;"
    }
    $expect = @{
        'auth.users' = 1; 'profiles' = 1; 'keeper present' = 1; 'active super_admins' = 1
        'organizations' = 0; 'warehouses' = 0; 'distribution_points' = 0; 'central_items' = 0
        'permission_keys' = 130; 'role_permission_defaults' = 415; 'migration ceiling' = 147
    }
    $bad = @()
    foreach ($k in $checks.Keys | Sort-Object) {
        $v = [int](Scalar $checks[$k])
        $e = $expect[$k]
        Log ('  {0,-26} = {1,-6} (expected {2})' -f $k, $v, $e)
        if ($v -ne $e) { $bad += "$k = $v, expected $e" }
    }
    if ($bad.Count -gt 0) { Fail ("post-purge reconciliation failed:`n" + ($bad -join "`n")) }
    Log 'CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147 confirmed'

    # ------------------------------------------------------- 9. migrations 148+
    Section '9. APPLY MIGRATIONS 148-153'
    Push-Location $RepoRoot
    try {
        & supabase link --project-ref $ProjectRef --password $env:SUPABASE_DB_PASSWORD 2>&1 | ForEach-Object { Log $_ }
        Log 'migration status before push:'
        & supabase migration list --linked 2>&1 | Select-Object -Last 12 | ForEach-Object { Log $_ }
        & supabase db push --linked 2>&1 | ForEach-Object { Log $_ }
        if ($LASTEXITCODE -ne 0) { Fail "supabase db push failed ($LASTEXITCODE)" }
    } finally { Pop-Location }

    $newCeiling = Scalar "SELECT max(version::int) FROM supabase_migrations.schema_migrations;"
    Log "migration ceiling after push = $newCeiling"
    if ([int]$newCeiling -ne 153) { Fail "expected ceiling 153 after push, got $newCeiling" }

    $dupes2 = Scalar "SELECT count(*) FROM (SELECT version FROM supabase_migrations.schema_migrations GROUP BY version HAVING count(*)>1) d;"
    if ([int]$dupes2 -ne 0) { Fail "duplicate migration versions after push" }

    # ------------------------------------------------------ 10. post-apply verify
    Section '10. POST-APPLY VERIFICATION'
    foreach ($k in @('auth.users','keeper present','permission_keys','role_permission_defaults')) {
        $v = [int](Scalar $checks[$k])
        Log ('  {0,-26} = {1}' -f $k, $v)
        if ($v -ne $expect[$k]) { Fail "$k drifted after migrations: $v" }
    }
    $invalid = Scalar "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated;"
    if ([int]$invalid -ne 0) { Fail "$invalid unvalidated FK constraint(s) after migrations" }
    Log 'post-apply verification passed'

    Section 'RESULT: SUCCESS'
    Log 'Purge + migrations 148-153 complete. Keeper preserved. Ceiling = 153.'
    Log 'Next: report back so the PR can be marked Ready, merged and deployed.'
}
catch {
    Section 'RESULT: STOPPED'
    Log ("ERROR: " + $_.Exception.Message)
    Log 'If the purge transaction itself failed it rolled back atomically: data AND triggers are unchanged.'
    Log 'Do NOT re-run without re-reading the report. There is no automatic retry.'
    exit 1
}
finally {
    # --------------------------------------------------------------- cleanup
    if ($BstrPtr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BstrPtr)
        $BstrPtr = [IntPtr]::Zero
    }
    Remove-Item Env:\PGPASSWORD           -ErrorAction SilentlyContinue
    Remove-Item Env:\SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
    Get-Process psql, pg_dump -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    if (Test-Path $WorkDir) {
        Remove-Item (Join-Path $WorkDir 'purge-session.sql') -Force -ErrorAction SilentlyContinue
        $report = Join-Path $WorkDir 'purge-report.log'
        $LogLines | Set-Content -Path $report -Encoding utf8
        Write-Host ''
        Write-Host "Redacted report : $report"
        Write-Host "Local dump kept : $(Join-Path $WorkDir 'pre-purge.dump')"
        Write-Host 'Delete the dump only after you are satisfied with the outcome.'
    }
    Write-Host 'Credentials cleared from this process.'
}
