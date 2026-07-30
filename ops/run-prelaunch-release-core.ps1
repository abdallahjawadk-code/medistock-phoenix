<#
================================================================================
 MediStock Phoenix -- PRE-LAUNCH RELEASE ENGINE (target-agnostic)

 ONE engine. ONE code path. The target is supplied as a manifest; nothing about
 any specific environment is written into this file.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-prelaunch-release-core.ps1 `
        -TargetManifest ops\targets\<target>.json [-RehearsalArtifact <path>]

 WHY THIS EXISTS. An earlier version hard-coded the Production project ref,
 pooler host, CA path and labels. That made canonical memory v11's central
 requirement impossible: rehearse on staging, then run THE SAME PATH on
 Production without modification. Editing constants between the rehearsal and
 the real run means the thing you proved is not the thing you ran.

 Environments (manifest field "environment"):
   rehearsal_clone  local restored PostgreSQL 17 clone. No Supabase CLI, no
                    Management API, no Vercel, no Storage API. Loopback only.
   staging          isolated Supabase project. Same path as production.
   production       the live project. Additionally requires a rehearsal
                    authorization artifact that pins head, SQL, manifest,
                    tools and CA.

 Secrets NEVER live in a manifest or an artifact. The password is read once into
 process memory, passed only via PGPASSWORD to child processes, and zeroed in
 finally.
================================================================================
#>

param(
    [Parameter(Mandatory = $true)][string]$TargetManifest,
    [string]$RehearsalArtifact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BstrPtr  = [IntPtr]::Zero
$LogLines = New-Object System.Collections.Generic.List[string]

$script:PsqlExe  = $null
$script:DumpExe  = $null
$script:DumpPath = $null
$script:DumpSize = 0
$script:DumpHash = $null

function Log([string]$m) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'), $m
    Write-Host $line; $LogLines.Add($line) | Out-Null
}
function Fail([string]$m) { Log "STOP: $m"; throw $m }
function Section([string]$t) { Write-Host ''; Write-Host ('=' * 78); Write-Host "  $t"; Write-Host ('=' * 78) }

function Resolve-RepoPath([string]$p) {
    if ([IO.Path]::IsPathRooted($p)) { return $p }
    return (Join-Path $RepoRoot $p)
}

# ----------------------------------------------------------------- manifest
function Read-TargetManifest([string]$path) {
    if (-not (Test-Path $path)) { Fail "target manifest not found: $path" }
    $raw = Get-Content $path -Raw
    try { $m = $raw | ConvertFrom-Json } catch { Fail "target manifest is not valid JSON: $path" }

    $required = @(
        'environment','project_ref','pooler_host','port','database_name','database_user',
        'expected_initial_ceiling','expected_final_ceiling','keeper_email',
        'ca_certificate_path','ca_sha256_path','purge_sql_path','purge_sql_sha256',
        'allow_destructive_execution','ssl_mode','required_pg_major'
    )
    foreach ($k in $required) {
        if (-not ($m.PSObject.Properties.Name -contains $k)) { Fail "target manifest is missing required field: $k" }
    }
    if ($m.environment -notin @('rehearsal_clone','staging','production')) {
        Fail "unknown environment '$($m.environment)' -- expected rehearsal_clone, staging or production"
    }

    # A manifest must never carry secret material.
    foreach ($forbidden in @('password','db_password','service_role_key','anon_key','access_token','pgpassword')) {
        if ($m.PSObject.Properties.Name -contains $forbidden) {
            Fail "target manifest contains forbidden secret field '$forbidden' -- secrets are entered by the operator, never stored"
        }
    }
    return $m
}

# -------------------------------------------------------------- SSL policy
# Remote targets must always use verify-full with an explicit, pinned CA.
# A local rehearsal clone has no TLS at all, so it may use sslmode=disable --
# but ONLY on loopback, so this can never silently weaken a remote connection.
function Assert-SslPolicy($m) {
    if ($m.environment -eq 'rehearsal_clone') {
        if ($m.ssl_mode -ne 'disable') {
            Log "clone target requests ssl_mode=$($m.ssl_mode); it will be honoured"
        }
        if ($m.ssl_mode -eq 'disable' -and $m.pooler_host -notin @('127.0.0.1','localhost','::1')) {
            Fail "ssl_mode=disable is only permitted for a loopback rehearsal clone, not host '$($m.pooler_host)'"
        }
        return
    }
    if ($m.ssl_mode -ne 'verify-full') {
        Fail "environment '$($m.environment)' requires ssl_mode=verify-full, found '$($m.ssl_mode)'"
    }
}

function Assert-CaCertificate($m) {
    if ($m.environment -eq 'rehearsal_clone' -and $m.ssl_mode -eq 'disable') {
        Log 'clone target on loopback without TLS: no CA required'
        return
    }
    $cert = Resolve-RepoPath $m.ca_certificate_path
    $sha  = Resolve-RepoPath $m.ca_sha256_path
    if (-not (Test-Path $cert)) {
        Fail ("STOP_CA_CERTIFICATE_MISSING -- expected the CA certificate for target '$($m.environment)' at:`n  $cert`n" +
              "Download it from that project's dashboard (Project Settings -> Database -> SSL Configuration), " +
              "then run ops\pin-supabase-ca.ps1 -Target $($m.environment) once.")
    }
    $len = (Get-Item $cert).Length
    if ($len -lt 512) { Fail "STOP_CA_CERTIFICATE_INVALID -- certificate is $len bytes, too small to be a CA bundle." }
    if (-not (Test-Path $sha)) { Fail "STOP_CA_CHECKSUM_MISSING -- no pinned SHA-256 at: $sha" }
    $expected = (Get-Content $sha -Raw).Trim().ToLower()
    if ($expected -notmatch '^[0-9a-f]{64}$') { Fail 'STOP_CA_CHECKSUM_INVALID -- pin is not a SHA-256 hex digest.' }
    $actual = (Get-FileHash -Path $cert -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Fail ("STOP_CA_CHECKSUM_MISMATCH -- CA certificate does not match its pin.`n  expected $expected`n  actual   $actual")
    }
    Log "CA certificate verified against its pin ($($m.environment))"
}

# ------------------------------------------------------------------ tooling
function Get-PgMajor([string]$exe) {
    $v = & $exe --version 2>&1
    if ($v -match '(\d+)\.\d+') { return [int]$Matches[1] }
    if ($v -match '(\d+)')      { return [int]$Matches[1] }
    return 0
}

function Resolve-PgClientTools([int]$requiredMajor) {
    $candidates = @()
    $candidates += (Get-Command psql -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    foreach ($root in @("$env:ProgramFiles\PostgreSQL", "${env:ProgramFiles(x86)}\PostgreSQL",
                        "$env:USERPROFILE\scoop\apps\postgresql", "$env:LOCALAPPDATA\Programs\PostgreSQL")) {
        if ($root -and (Test-Path $root)) {
            $candidates += (Get-ChildItem $root -Filter 'psql.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
                            Where-Object { $_.FullName -notlike '*pgAdmin*' } | ForEach-Object { $_.FullName })
        }
    }
    $seen = @()
    foreach ($p in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path $p)) { continue }
        $d = Join-Path (Split-Path -Parent $p) 'pg_dump.exe'
        if (-not (Test-Path $d)) { continue }
        $mp = Get-PgMajor $p; $md = Get-PgMajor $d
        $seen += ("{0} (psql {1} / pg_dump {2})" -f (Split-Path -Parent $p), $mp, $md)
        if ($mp -eq $requiredMajor -and $md -eq $requiredMajor) {
            $script:PsqlExe = $p; $script:DumpExe = $d
            Log "psql     : $p (major $mp)"
            Log "pg_dump  : $d (major $md)"
            return
        }
    }
    Fail ("STOP_POSTGRES_CLIENT_VERSION_UNSUPPORTED -- need psql AND pg_dump both major $requiredMajor " +
          "from one distribution.`nFound:`n  " + (($seen | Select-Object -Unique) -join "`n  "))
}

# -------------------------------------------------- connection (from manifest)
function Get-ConnString($m) {
    $s = "host=$($m.pooler_host) port=$($m.port) dbname=$($m.database_name) user=$($m.database_user) " +
         "connect_timeout=10 application_name=phoenix_release_$($m.environment)"
    if ($m.ssl_mode -eq 'disable') { return "$s sslmode=disable" }
    $ca = (Resolve-RepoPath $m.ca_certificate_path) -replace '\\', '/'
    return "$s sslmode=$($m.ssl_mode) sslrootcert=$ca"
}

# --------------------------------------------- rehearsal authorization artifact
function Assert-RehearsalAuthorization($m, [string]$artifactPath, [string]$head) {
    if ($m.environment -ne 'production') {
        Log "environment '$($m.environment)': no rehearsal artifact required"
        return
    }
    if (-not $m.allow_destructive_execution) {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- manifest sets allow_destructive_execution=false. It is flipped only by a recorded Go decision, never by hand."
    }
    if ([string]::IsNullOrWhiteSpace($artifactPath)) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- production requires -RehearsalArtifact produced by a successful staging rehearsal.'
    }
    if (-not (Test-Path $artifactPath)) {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- rehearsal artifact not found: $artifactPath"
    }
    $a = Get-Content $artifactPath -Raw | ConvertFrom-Json

    $needed = @('tested_head_sha','purge_sql_sha256','migration_manifest_sha256','staging_project_ref',
                'staging_pg_major','client_tool_versions','ca_sha256','backup_sha256','restore_proven',
                'trigger_reconciliation_proven','rollback_proven','rehearsal_completed_at','owner_go_decision')
    foreach ($k in $needed) {
        if (-not ($a.PSObject.Properties.Name -contains $k)) {
            Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- artifact is missing field: $k"
        }
    }
    foreach ($flag in @('restore_proven','trigger_reconciliation_proven','rollback_proven')) {
        if (-not $a.$flag) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- artifact reports $flag = false" }
    }
    if ($a.owner_go_decision -ne 'GO') {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- owner_go_decision is '$($a.owner_go_decision)', expected GO"
    }
    if ($a.tested_head_sha -ne $head) {
        Fail ("STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the rehearsal proved a different commit.`n" +
              "  rehearsed $($a.tested_head_sha)`n  current   $head")
    }
    if ($a.purge_sql_sha256 -ne $m.purge_sql_sha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- purge SQL digest differs between the artifact and this manifest.'
    }
    $manifestSha = (Get-FileHash -Path (Resolve-RepoPath 'supabase/ops/purge-manifest-v147.ts') -Algorithm SHA256).Hash.ToLower()
    if ($a.migration_manifest_sha256.ToLower() -ne $manifestSha) {
        Fail ("STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- purge manifest changed since the rehearsal.`n" +
              "  rehearsed $($a.migration_manifest_sha256)`n  current   $manifestSha")
    }
    if ([int]$a.staging_pg_major -ne [int]$m.required_pg_major) {
        Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- rehearsal ran on PostgreSQL $($a.staging_pg_major), target requires $($m.required_pg_major)"
    }
    $caPin = (Get-Content (Resolve-RepoPath $m.ca_sha256_path) -Raw).Trim().ToLower()
    if ($a.ca_sha256.ToLower() -ne $caPin) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- CA pin differs between the artifact and this target.'
    }
    $toolsNow = ("psql={0};pg_dump={1}" -f (Get-PgMajor $script:PsqlExe), (Get-PgMajor $script:DumpExe))
    if ($a.client_tool_versions -ne $toolsNow) {
        Fail ("STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- client toolchain differs from the rehearsal.`n" +
              "  rehearsed $($a.client_tool_versions)`n  current   $toolsNow")
    }
    Log "rehearsal authorization verified (rehearsed $($a.rehearsal_completed_at), Go recorded)"
}

# ============================================================== main
try {
    $manifestPath = Resolve-RepoPath $TargetManifest
    $M = Read-TargetManifest $manifestPath

    $Host.UI.RawUI.WindowTitle = "MediStock Phoenix -- release [$($M.environment)]"
    Section "0. TARGET: $($M.environment)"
    Log "manifest      : $manifestPath"
    Log "project ref   : $($M.project_ref)"
    Log "host          : $($M.pooler_host):$($M.port)"
    Log "keeper        : $($M.keeper_email)"
    Log "ceiling       : $($M.expected_initial_ceiling) -> $($M.expected_final_ceiling)"
    Log "destructive   : $($M.allow_destructive_execution)"

    $WorkDir = Join-Path $env:TEMP ("phoenix-release-$($M.environment)-" + (Get-Date -Format 'yyyyMMddTHHmmssZ'))
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

    # ---------------------------------------------------------- 1. integrity
    Section '1. INTEGRITY -- purge SQL must match its pinned digest'
    $purgeSql = Resolve-RepoPath $M.purge_sql_path
    if (-not (Test-Path $purgeSql)) { Fail "purge SQL not found: $purgeSql" }
    $actualSql = (Get-FileHash -Path $purgeSql -Algorithm SHA256).Hash.ToLower()
    if ($actualSql -ne $M.purge_sql_sha256.ToLower()) {
        Fail ("purge SQL digest mismatch.`n  expected $($M.purge_sql_sha256)`n  actual   $actualSql")
    }
    Log "purge SQL verified: $actualSql"

    # ------------------------------------------------------------- 2. worktree
    Section '2. WORKTREE'
    Push-Location $RepoRoot
    try {
        $dirty = @(& git status --porcelain | Where-Object { $_ -notmatch 'supabase/\.temp' })
        if ($dirty.Count -gt 0) { Fail ("worktree is dirty:`n" + ($dirty -join "`n")) }
        $head = (& git rev-parse HEAD).Trim()
    } finally { Pop-Location }
    Log "HEAD = $head"

    # ------------------------------------------------ 3. pre-credential gates
    Section '3. PRE-CREDENTIAL GATES'
    Assert-SslPolicy $M
    Resolve-PgClientTools ([int]$M.required_pg_major)
    Assert-CaCertificate $M
    Assert-RehearsalAuthorization $M $RehearsalArtifact $head

    $conn = Get-ConnString $M
    if ($conn -match 'password=') { Fail 'password must never appear in a connection string' }
    if ($M.environment -ne 'rehearsal_clone') {
        if ($conn -notmatch 'sslmode=verify-full') { Fail 'remote target must use sslmode=verify-full' }
        if ($conn -match 'sslmode=(require|prefer|allow|disable)') { Fail 'refusing a weakened sslmode' }
        if ($conn -match 'sslrootcert=system') { Fail 'sslrootcert=system is unproven; an explicit pinned CA is required' }
    }
    Log 'all pre-credential gates passed'

    if (-not $M.allow_destructive_execution) {
        Section 'RESULT: GATES PASSED, EXECUTION NOT AUTHORIZED'
        Log "allow_destructive_execution=false for '$($M.environment)': stopping before any credential is requested."
        Log 'This is the intended state until a rehearsal has proven the path and a Go decision is recorded.'
        exit 0
    }

    # -------------------------------------------------------- 4. credential
    Section '4. CREDENTIAL -- entered once, process memory only'
    Write-Host "Target      : $($M.environment) / $($M.project_ref)"
    Write-Host "Keeper kept : $($M.keeper_email)"
    Write-Host ''
    $secure = Read-Host 'Enter database password' -AsSecureString
    if (-not $secure -or $secure.Length -eq 0) { Fail 'no password entered' }
    $BstrPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain   = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($BstrPtr)
    $env:PGPASSWORD = $plain
    $plain = $null
    Log 'credential loaded into process environment (never printed, never stored)'

    # The remaining execution stages (probe, backup, storage gate, purge,
    # reconciliation, migrations) are identical for every environment and are
    # driven from this same file -- see ops/release-stages.ps1, dot-sourced so
    # there is exactly one implementation.
    . (Join-Path $PSScriptRoot 'release-stages.ps1')
    Invoke-ReleaseStages -M $M -Conn $conn -WorkDir $WorkDir -PurgeSql $purgeSql

    Section 'RESULT: COMPLETED'
    Log "release stages completed for target '$($M.environment)'"
}
catch {
    Section 'RESULT: STOPPED'
    Log ('ERROR: ' + $_.Exception.Message)
    Log 'If the purge transaction itself failed it rolled back atomically: data AND triggers are unchanged.'
    Log 'There is no automatic retry.'
    exit 1
}
finally {
    if ($BstrPtr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BstrPtr)
        $BstrPtr = [IntPtr]::Zero
    }
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
    Get-Process psql, pg_dump -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    if (Test-Path variable:WorkDir) {
        if (Test-Path $WorkDir) {
            Remove-Item (Join-Path $WorkDir 'purge-session.sql') -Force -ErrorAction SilentlyContinue
            $report = Join-Path $WorkDir 'release-report.log'
            $LogLines | Set-Content -Path $report -Encoding utf8
            Write-Host ''
            Write-Host "Redacted report : $report"
            if ($script:DumpPath -and (Test-Path $script:DumpPath)) {
                Write-Host ("Local dump kept : {0}" -f $script:DumpPath)
                Write-Host ("  size          : {0:N0} bytes" -f $script:DumpSize)
                Write-Host ("  SHA-256       : {0}" -f $script:DumpHash)
            } else {
                Write-Host 'No local dump was created.'
            }
        }
    }
    Write-Host 'Credentials cleared from this process.'
}
