<#
================================================================================
 MediStock Phoenix -- PRE-LAUNCH RELEASE ENGINE (target-agnostic)

 ONE engine. ONE code path. The target is supplied as a manifest; nothing about
 any specific environment is written into this file.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-prelaunch-release-core.ps1 `
        -TargetManifest ops\targets\<target>.json `
        [-RestoreProofPath <path>] [-StagingProofPath <path>] [-OwnerGoPath <path>] `
        [-StagingManifestPath <path>] `
        [-RestoreRunResultPath <path>] [-StagingRunResultPath <path>]

 Environments (manifest field "environment"):
   rehearsal_clone  local restored PostgreSQL 17 clone. No Supabase CLI, no
                    Management API, no Vercel, no Storage API. Loopback only.
   staging          isolated Supabase project. Same path as production.
   production       the live project. Additionally requires a cryptographically
                     linked evidence chain: restore-proof.json ->
                     staging-rehearsal-proof.json -> owner-go.json.

 EXECUTION POLICY. A manifest carries "execution_policy", one of:
   rehearsal_allowed              -- rehearsal_clone and staging. Proceeds
                                      straight to the credential prompt once
                                      the pre-credential gates pass.
   requires_rehearsal_authorization -- production. Never flipped by hand and
                                      never edited to "unlock" a run: the
                                      engine instead demands the evidence
                                      chain above, re-verified from scratch
                                      every time, before any credential is
                                      requested. production.json stays
                                      byte-identical whether or not a release
                                      is authorized.
   disabled                       -- the target is not runnable at all. The
                                      engine stops after the read-only gates,
                                      before any credential prompt.

 WHY THIS EXISTS. An earlier version hard-coded the Production project ref,
 pooler host, CA path and labels. That made canonical memory's central
 requirement impossible: rehearse on staging, then run THE SAME PATH on
 Production without modification. Editing constants between the rehearsal and
 the real run means the thing you proved is not the thing you ran. A later
 version used a single allow_destructive_execution boolean on production.json,
 which created a different defect: "authorizing" a release meant editing and
 committing the production manifest itself, so the manifest was never
 byte-identical between rehearsal and the real run either. Authorization now
 lives entirely outside the manifest, in a chain of generated, re-verifiable
 evidence files.

 Secrets NEVER live in a manifest or an evidence file. The password is read
 once into process memory, passed only via PGPASSWORD to child processes, and
 zeroed in finally.
================================================================================
#>

param(
    [Parameter(Mandatory = $true)][string]$TargetManifest,
    [string]$RestoreProofPath,
    [string]$StagingProofPath,
    [string]$OwnerGoPath,
    [string]$StagingManifestPath,
    [string]$RestoreRunResultPath,
    [string]$StagingRunResultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BstrPtr  = [IntPtr]::Zero
$LogLines = New-Object System.Collections.Generic.List[string]

$script:PsqlExe     = $null
$script:DumpExe     = $null
$script:PsqlVersion = $null
$script:DumpVersion = $null
$script:PsqlSha256  = $null
$script:DumpSha256  = $null
$script:DumpPath    = $null
$script:DumpSize    = 0
$script:DumpHash    = $null

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

# Get-FileSha256, Get-MigrationRangeSha256, Get-JsonSubsetSha256,
# ConvertTo-UtcDateTime, Get-PgMajor, Get-PgFullVersion, the Test-* field
# validators, and the full evidence-chain checks all come from here -- one
# implementation, shared with ops\record-owner-go.ps1 so the two never
# diverge. Fail/Log/Section above are already defined, so every check below
# reports through this script's own logging.
. (Join-Path $PSScriptRoot 'evidence-chain.ps1')

# ----------------------------------------------------------------- manifest
function Read-TargetManifest([string]$path) {
    if (-not (Test-Path $path)) { Fail "target manifest not found: $path" }
    $raw = Get-Content $path -Raw
    try { $m = $raw | ConvertFrom-Json } catch { Fail "target manifest is not valid JSON: $path" }

    $required = @(
        'environment','project_ref','pooler_host','port','database_name','database_user',
        'expected_initial_ceiling','expected_final_ceiling','keeper_email',
        'ca_certificate_path','ca_sha256_path','purge_sql_path','purge_sql_sha256',
        'execution_policy','ssl_mode','required_pg_major'
    )
    foreach ($k in $required) {
        if ($null -eq $m.PSObject.Properties[$k]) { Fail "target manifest is missing required field: $k" }
    }
    if ($m.environment -notin @('rehearsal_clone','staging','production')) {
        Fail "unknown environment '$($m.environment)' -- expected rehearsal_clone, staging or production"
    }
    if ($m.execution_policy -notin @('rehearsal_allowed','requires_rehearsal_authorization','disabled')) {
        Fail "unknown execution_policy '$($m.execution_policy)' -- expected rehearsal_allowed, requires_rehearsal_authorization or disabled"
    }

    # A manifest must never carry secret material.
    foreach ($forbidden in @('password','db_password','service_role_key','anon_key','access_token','pgpassword')) {
        if ($null -ne $m.PSObject.Properties[$forbidden]) {
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
    $actual = Get-FileSha256 $cert
    if ($actual -ne $expected) {
        Fail ("STOP_CA_CHECKSUM_MISMATCH -- CA certificate does not match its pin.`n  expected $expected`n  actual   $actual")
    }
    Log "CA certificate verified against its pin ($($m.environment))"
}

# ------------------------------------------------------------------ tooling
# Get-PgMajor and Get-PgFullVersion come from evidence-chain.ps1, dot-sourced
# above.
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
    foreach ($p in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path $p)) { continue }
        $d = Join-Path (Split-Path -Parent $p) 'pg_dump.exe'
        if (-not (Test-Path $d)) { continue }
        $mp = Get-PgMajor $p; $md = Get-PgMajor $d
        if ($mp -eq $requiredMajor -and $md -eq $requiredMajor) {
            $script:PsqlExe     = $p
            $script:DumpExe     = $d
            $script:PsqlVersion = Get-PgFullVersion $p
            $script:DumpVersion = Get-PgFullVersion $d
            $script:PsqlSha256  = Get-FileSha256 $p
            $script:DumpSha256  = Get-FileSha256 $d
            Log "psql     : $p ($($script:PsqlVersion))"
            Log "pg_dump  : $d ($($script:DumpVersion))"
            return
        }
    }
    $seen = @()
    foreach ($p in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path $p)) { continue }
        $d = Join-Path (Split-Path -Parent $p) 'pg_dump.exe'
        if (-not (Test-Path $d)) { continue }
        $seen += ("{0} (psql {1} / pg_dump {2})" -f (Split-Path -Parent $p), (Get-PgMajor $p), (Get-PgMajor $d))
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

# --------------------------------------------- rehearsal evidence chain
# Verified in full, from the current repository and toolchain state, every
# single time, by calling the SAME functions ops\record-owner-go.ps1 already
# called before it would let the owner record a Go decision. Nothing here is
# trusted merely because a file exists: every value inside every evidence
# file is recomputed and compared.
function Assert-RehearsalAuthorization($m, [string]$head, [string]$restoreProofPath, [string]$stagingProofPath, [string]$ownerGoPath, [string]$stagingManifestPath, [string]$restoreRunResultPath, [string]$stagingRunResultPath) {
    if ($m.execution_policy -ne 'requires_rehearsal_authorization') {
        Log "environment '$($m.environment)': execution_policy=$($m.execution_policy), no evidence chain required"
        return
    }

    if ([string]::IsNullOrWhiteSpace($ownerGoPath)) { Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- owner Go decision path was not supplied' }
    if (-not (Test-Path $ownerGoPath)) { Fail "STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- owner Go decision not found: $ownerGoPath" }

    $chain = Test-RestoreAndStagingEvidence -M $m -RepoRoot $RepoRoot -Head $head `
        -RestoreProofPath $restoreProofPath -StagingProofPath $stagingProofPath `
        -StagingManifestPath $stagingManifestPath -ProductionManifestPath (Resolve-RepoPath $TargetManifest) `
        -RestoreRunResultPath $restoreRunResultPath -StagingRunResultPath $stagingRunResultPath

    # Engine-only check, not shared with owner-go: the psql/pg_dump binaries
    # THIS process just resolved -- the ones it is about to use to connect to
    # Production -- must be the identical binaries the staging rehearsal
    # proved, not merely a proof that is internally self-consistent.
    if ($chain.Staging.exact_psql_version -ne $script:PsqlVersion -or $chain.Staging.exact_pg_dump_version -ne $script:DumpVersion) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the exact client toolchain version resolved for this Production run differs from the rehearsal.'
    }
    if ($chain.Staging.psql_executable_path -ne $script:PsqlExe -or $chain.Staging.pg_dump_executable_path -ne $script:DumpExe) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the client executable path resolved for this Production run differs from the rehearsal.'
    }
    if ($chain.Staging.psql_executable_sha256 -ne $script:PsqlSha256 -or $chain.Staging.pg_dump_executable_sha256 -ne $script:DumpSha256) {
        Fail 'STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED -- the client executable SHA-256 resolved for this Production run differs from the rehearsal -- the binaries changed.'
    }

    $owner = Get-Content $ownerGoPath -Raw | ConvertFrom-Json
    Test-OwnerGoObject $owner
    Test-OwnerGoAgainstStaging $owner $chain.Staging $stagingProofPath $head
    Test-FullTimestampOrder $chain.Restore $chain.Staging $owner

    Log "evidence chain verified: restore proof -> staging proof ($($chain.Staging.completed_at_utc)) -> owner Go ($($owner.decision_at_utc))"
}

# ------------------------------------------------------- staging run result
# Written automatically at the end of a real, successful staging rehearsal --
# never hand-constructed, never accepted as an argument. This is the only
# input ops\generate-staging-rehearsal-proof.ps1 trusts for the facts of what
# actually happened during the run.
function New-StagingRunResult($m, [string]$head, [string]$serverVersionFull, [int]$finalCeiling) {
    $result = [ordered]@{
        result                          = 'SUCCESS'
        environment                     = 'staging'
        head_sha                        = $head
        server_version                  = $serverVersionFull
        backup_path                     = $script:DumpPath
        backup_sha256                   = $script:DumpHash
        psql_path                       = $script:PsqlExe
        psql_version                    = $script:PsqlVersion
        psql_sha256                     = $script:PsqlSha256
        pg_dump_path                    = $script:DumpExe
        pg_dump_version                 = $script:DumpVersion
        pg_dump_sha256                  = $script:DumpSha256
        pre_purge_checks_passed         = $true
        purge_committed                 = $true
        post_purge_reconciliation_passed = $true
        migrations_148_153_applied      = $true
        final_ceiling                   = $finalCeiling
        post_apply_checks_passed        = $true
        completed_at_utc                = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    $outPath = Join-Path $RepoRoot 'ops\evidence\staging-run-result.json'
    $dir = Split-Path -Parent $outPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    ($result | ConvertTo-Json -Depth 5) | Set-Content -Path $outPath -Encoding utf8
    Log "staging run result written: $outPath"
}

# ============================================================== main
try {
    $manifestPath = Resolve-RepoPath $TargetManifest
    $M = Read-TargetManifest $manifestPath

    if (-not $RestoreProofPath)      { $RestoreProofPath      = Join-Path $RepoRoot 'ops\evidence\restore-proof.json' }
    if (-not $StagingProofPath)      { $StagingProofPath      = Join-Path $RepoRoot 'ops\evidence\staging-rehearsal-proof.json' }
    if (-not $OwnerGoPath)           { $OwnerGoPath           = Join-Path $RepoRoot 'ops\evidence\owner-go.json' }
    if (-not $StagingManifestPath)   { $StagingManifestPath   = Join-Path $RepoRoot 'ops\targets\staging.json' }
    if (-not $RestoreRunResultPath)  { $RestoreRunResultPath  = Join-Path $RepoRoot 'ops\evidence\restore-run-result.json' }
    if (-not $StagingRunResultPath)  { $StagingRunResultPath  = Join-Path $RepoRoot 'ops\evidence\staging-run-result.json' }

    $Host.UI.RawUI.WindowTitle = "MediStock Phoenix -- release [$($M.environment)]"
    Section "0. TARGET: $($M.environment)"
    Log "manifest      : $manifestPath"
    Log "project ref   : $($M.project_ref)"
    Log "host          : $($M.pooler_host):$($M.port)"
    Log "keeper        : $($M.keeper_email)"
    Log "ceiling       : $($M.expected_initial_ceiling) -> $($M.expected_final_ceiling)"
    Log "execution policy : $($M.execution_policy)"

    $WorkDir = Join-Path $env:TEMP ("phoenix-release-$($M.environment)-" + (Get-Date -Format 'yyyyMMddTHHmmssZ'))
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

    # ---------------------------------------------------------- 1. integrity
    Section '1. INTEGRITY -- purge SQL must match its pinned digest'
    $purgeSql = Resolve-RepoPath $M.purge_sql_path
    if (-not (Test-Path $purgeSql)) { Fail "purge SQL not found: $purgeSql" }
    $actualSql = Get-FileSha256 $purgeSql
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

    if ($M.execution_policy -eq 'disabled') {
        Section 'RESULT: GATES PASSED, EXECUTION NOT AUTHORIZED'
        Log "execution_policy=disabled for '$($M.environment)': stopping before any credential is requested."
        exit 0
    }

    Assert-RehearsalAuthorization $M $head $RestoreProofPath $StagingProofPath $OwnerGoPath $StagingManifestPath $RestoreRunResultPath $StagingRunResultPath

    $conn = Get-ConnString $M
    if ($conn -match 'password=') { Fail 'password must never appear in a connection string' }
    if ($M.environment -ne 'rehearsal_clone') {
        if ($conn -notmatch 'sslmode=verify-full') { Fail 'remote target must use sslmode=verify-full' }
        if ($conn -match 'sslmode=(require|prefer|allow|disable)') { Fail 'refusing a weakened sslmode' }
        if ($conn -match 'sslrootcert=system') { Fail 'sslrootcert=system is unproven; an explicit pinned CA is required' }
    }
    Log 'all pre-credential gates passed'

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
    Invoke-ReleaseStages -M $M -Conn $conn -WorkDir $WorkDir -PurgeSql $purgeSql -Head $head

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
