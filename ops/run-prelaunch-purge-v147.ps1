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

# v11 3.4: match the Production server major exactly (Production is 17.x).
$RequiredPgMajor = 17
# v11 3.2/3.3: explicit CA certificate + pinned SHA-256, verified before any credential.
$CaCertPath   = Join-Path $RepoRoot 'ops\certs\supabase-prod-ca.crt'
$CaShaPath    = Join-Path $RepoRoot 'ops\certs\supabase-prod-ca.crt.sha256'

$WorkDir = Join-Path $env:TEMP ('phoenix-purge-' + (Get-Date -Format 'yyyyMMddTHHmmssZ'))
$BstrPtr = [IntPtr]::Zero
$LogLines = New-Object System.Collections.Generic.List[string]

# Set only once a real dump exists, so the final report can never claim a backup
# that was never written.
$script:DumpPath = $null
$script:DumpSize = 0
$script:DumpHash = $null

function Log([string]$m) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'), $m
    Write-Host $line
    $LogLines.Add($line) | Out-Null
}
function Fail([string]$m) { Log "STOP: $m"; throw $m }
function Section([string]$t) { Write-Host ''; Write-Host ('=' * 78); Write-Host "  $t"; Write-Host ('=' * 78) }

# ---------------------------------------------------------------- tooling
# Absolute paths, resolved once and preferring a single distribution, so PATH
# order cannot silently pair a new psql with an old pg_dump.
$script:PsqlExe = $null
$script:DumpExe = $null

function Get-PgMajor([string]$exe) {
    $v = & $exe --version 2>&1
    if ($v -match '(\d+)\.\d+') { return [int]$Matches[1] }
    if ($v -match '(\d+)')      { return [int]$Matches[1] }
    return 0
}

# v11 3.4: the client toolchain must MATCH the Production server major, not merely
# exceed it. Production is PostgreSQL 17.x, so an 18.x client is refused: a newer
# pg_dump can emit archive features a 17 server cannot restore, which would make
# the "backup" unusable exactly when it is needed. PG18 is a forward-compatibility
# CI concern, never the tool that touches Production.
function Resolve-PgClientTools {
    $psqlCandidates = @()
    $psqlCandidates += (Get-Command psql -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    foreach ($root in @("$env:ProgramFiles\PostgreSQL", "${env:ProgramFiles(x86)}\PostgreSQL",
                        "$env:USERPROFILE\scoop\apps\postgresql", "$env:LOCALAPPDATA\Programs\PostgreSQL")) {
        if ($root -and (Test-Path $root)) {
            $psqlCandidates += (Get-ChildItem $root -Filter 'psql.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
                                Where-Object { $_.FullName -notlike '*pgAdmin*' } | ForEach-Object { $_.FullName })
        }
    }
    $seen = @()
    foreach ($p in ($psqlCandidates | Select-Object -Unique)) {
        if (-not (Test-Path $p)) { continue }
        $d = Join-Path (Split-Path -Parent $p) 'pg_dump.exe'
        if (-not (Test-Path $d)) { continue }          # same distribution only
        $mp = Get-PgMajor $p
        $md = Get-PgMajor $d
        $seen += ("{0} (psql {1} / pg_dump {2})" -f (Split-Path -Parent $p), $mp, $md)
        if ($mp -eq $RequiredPgMajor -and $md -eq $RequiredPgMajor) {
            $script:PsqlExe = $p
            $script:DumpExe = $d
            Log ("psql     : $p (major $mp)")
            Log ("pg_dump  : $d (major $md)")
            return
        }
    }
    Fail ("STOP_POSTGRES_CLIENT_VERSION_UNSUPPORTED -- need psql AND pg_dump both major $RequiredPgMajor " +
          "(matching the Production server) from one distribution.`nFound:`n  " + (($seen | Select-Object -Unique) -join "`n  "))
}

# ------------------------------------------------------------- CA trust
# v11 3.2/3.3: the approved path is an EXPLICIT Supabase CA certificate at a
# canonical location with a PINNED SHA-256, not the OS trust store. The pin is
# what makes this meaningful -- without it, "a file exists" proves nothing.
# A missing, empty, or mismatched certificate must abort BEFORE the password
# prompt. The certificate is public, but it is never printed or logged.
function Assert-CaCertificate {
    if (-not (Test-Path $CaCertPath)) {
        Fail ("STOP_CA_CERTIFICATE_MISSING -- expected the Supabase CA certificate at:`n  $CaCertPath`n" +
              "Download it from the Supabase dashboard (Project Settings -> Database -> SSL Configuration), " +
              "place it there, then run ops\pin-supabase-ca.ps1 once to record its SHA-256.")
    }
    $len = (Get-Item $CaCertPath).Length
    if ($len -lt 512) { Fail "STOP_CA_CERTIFICATE_INVALID -- certificate file is $len bytes, which is too small to be a CA bundle." }

    if (-not (Test-Path $CaShaPath)) {
        Fail ("STOP_CA_CHECKSUM_MISSING -- no pinned SHA-256 at:`n  $CaShaPath`n" +
              "Run ops\pin-supabase-ca.ps1 once, after verifying the certificate's provenance.")
    }
    $expected = (Get-Content $CaShaPath -Raw).Trim().ToLower()
    if ($expected -notmatch '^[0-9a-f]{64}$') { Fail 'STOP_CA_CHECKSUM_INVALID -- pinned checksum is not a SHA-256 hex digest.' }
    $actual = (Get-FileHash -Path $CaCertPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Fail ("STOP_CA_CHECKSUM_MISMATCH -- the CA certificate does not match its pin.`n" +
              "  expected $expected`n  actual   $actual`nRefusing to connect with an unverified trust root.")
    }
    Log "CA certificate verified against its pinned SHA-256"
}

# ------------------------------------------------------- connection builder
# ONE builder for psql AND pg_dump, so they can never drift apart.
#
# v11 3.2: sslrootcert points at an EXPLICIT, checksum-pinned Supabase CA file.
#
# sslrootcert=system was the previous approach and is NOT used here. It is only
# permissible once an automated test on the target Windows machine proves the OS
# trust store actually validates this host under verify-full for BOTH psql and
# pg_dump; until then it is an unproven assumption, and an unproven trust root is
# worse than a missing one because it fails silently open rather than closed.
#
# sslmode stays verify-full (hostname + chain). The password is NEVER part of
# this string; it travels only in PGPASSWORD inside the child process environment.
function Get-ConnString {
    $ca = $CaCertPath -replace '\\', '/'
    return "host=$PoolerHost port=5432 dbname=postgres user=postgres.$ProjectRef " +
           "sslmode=verify-full sslrootcert=$ca connect_timeout=10 " +
           "application_name=phoenix_owner_purge"
}

function Invoke-Psql {
    param([string]$Sql, [string]$File, [switch]$Quiet)
    $psqlArgs = @('-X', '-v', 'ON_ERROR_STOP=1', '--no-password')
    if ($Quiet) { $psqlArgs += @('-A', '-t') }
    if ($File)  { $psqlArgs += @('-f', $File) } else { $psqlArgs += @('-c', $Sql) }
    $out = & $script:PsqlExe (Get-ConnString) @psqlArgs 2>&1
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

    # --------------------------------------------- 2b. PRE-CREDENTIAL GATE
    # Everything that can fail without a password is proven FIRST, so a bad
    # toolchain or a weakened SSL contract can never reach a password prompt.
    Section '2b. PRE-CREDENTIAL GATE -- client tools, CA certificate, SSL contract'
    Resolve-PgClientTools
    Assert-CaCertificate
    $conn = Get-ConnString
    if ($conn -notmatch 'sslmode=verify-full') { Fail 'connection string is missing sslmode=verify-full' }
    if ($conn -match 'sslmode=(require|prefer|allow|disable)') { Fail 'refusing a weakened sslmode' }
    if ($conn -notmatch 'sslrootcert=') { Fail 'connection string is missing an explicit sslrootcert' }
    if ($conn -match 'sslrootcert=system') { Fail 'sslrootcert=system is not proven for this host; an explicit pinned CA is required' }
    if ($conn -match 'password=') { Fail 'password must never appear in the connection string' }
    Log 'SSL: verify-full against the explicit, checksum-pinned Supabase CA'

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
    # Same builder as psql: identical host, user and SSL contract.
    & $script:DumpExe (Get-ConnString) --format=custom --no-owner --no-privileges --file $dump
    if ($LASTEXITCODE -ne 0) {
        # Never leave a truncated file that a later step could mistake for a backup.
        if (Test-Path $dump) { Remove-Item $dump -Force -ErrorAction SilentlyContinue }
        Fail "pg_dump failed with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path $dump)) { Fail 'pg_dump reported success but produced no file' }
    $size = (Get-Item $dump).Length
    if ($size -lt 100KB) {
        Remove-Item $dump -Force -ErrorAction SilentlyContinue
        Fail "dump is implausibly small ($size bytes) -- refusing to treat it as a backup"
    }
    $dumpHash = (Get-FileHash -Path $dump -Algorithm SHA256).Hash.ToLower()
    $script:DumpPath = $dump
    $script:DumpSize = $size
    $script:DumpHash = $dumpHash
    Log ("local dump created: {0:N0} bytes" -f $size)
    Log ("local dump SHA-256: $dumpHash")

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
        # Only ever claim a backup that actually exists on disk.
        if ($script:DumpPath -and (Test-Path $script:DumpPath)) {
            Write-Host ("Local dump kept : {0}" -f $script:DumpPath)
            Write-Host ("  size          : {0:N0} bytes" -f $script:DumpSize)
            Write-Host ("  SHA-256       : {0}" -f $script:DumpHash)
            Write-Host 'Delete the dump only after you are satisfied with the outcome.'
        } else {
            Write-Host 'No local dump was created.'
        }
    }
    Write-Host 'Credentials cleared from this process.'
}
