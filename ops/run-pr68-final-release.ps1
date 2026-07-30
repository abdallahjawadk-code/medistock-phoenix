<#
================================================================================
 MediStock Phoenix -- PR #68 FINAL RELEASE ORCHESTRATOR

 Launched by the desktop shortcut. Chains the whole release:

   preflight -> purge runner -> (on success) post-purge release

 Your only input is the password and the two confirmation phrases, both typed
 into the purge runner's own prompts. This script never answers them for you.

 If the purge runner exits non-zero, nothing downstream runs: no merge, no
 deploy, no retry.
================================================================================
#>

param(
    # The exact commit this release was validated against. Supplied by the
    # desktop shortcut, which is regenerated whenever the head moves. It is a
    # parameter rather than a baked-in constant because a constant would have to
    # change the very commit it names.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$PinnedHead
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$PrNumber   = 68

function Section([string]$t) { Write-Host ''; Write-Host ('=' * 78); Write-Host "  $t"; Write-Host ('=' * 78) }
function Fail([string]$m) { Write-Host ''; Write-Host "STOP: $m" -ForegroundColor Red; throw $m }

try {
    $Host.UI.RawUI.WindowTitle = 'MediStock Phoenix -- Final Production Release'

    Section '0. REPOSITORY'
    Set-Location $RepoRoot
    Write-Host "repo: $RepoRoot"

    Section '1. SYNC'
    & git pull --ff-only 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) { Fail 'git pull --ff-only failed -- resolve manually, do not force.' }

    $head = (& git rev-parse HEAD).Trim()
    Write-Host "HEAD = $head"
    if ($head -ne $PinnedHead) {
        Fail "HEAD is $head but this launcher is pinned to $PinnedHead. Regenerate the launcher rather than running an untested tree."
    }

    Section '2. WORKTREE CLEANLINESS'
    $dirty = @(& git status --porcelain | Where-Object { $_ -notmatch 'supabase/\.temp' })
    if ($dirty.Count -gt 0) { Fail ("worktree has unexpected changes:`n" + ($dirty -join "`n")) }
    Write-Host 'clean (supabase/.temp/ ignored)'

    Section '3. GITHUB AUTH AND CI'
    & gh auth status 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) { Fail 'gh is not authenticated -- run: gh auth login' }

    $prHead = (& gh pr view $PrNumber --json headRefOid -q .headRefOid).Trim()
    if ($prHead -ne $head) { Fail "PR #$PrNumber head ($prHead) does not match local HEAD ($head)" }

    $checks = & gh pr checks $PrNumber 2>&1 | Out-String
    Write-Host $checks
    if ($checks -match '\bfail\b') { Fail 'CI has a failing check' }
    if ($checks -match '\bpending\b') { Fail 'CI is still pending -- wait for it to finish' }
    Write-Host 'CI green for this exact head'

    Section '4. POSTGRESQL CLIENT TOOLS'
    $psql = (Get-Command psql -ErrorAction SilentlyContinue)
    $dump = (Get-Command pg_dump -ErrorAction SilentlyContinue)
    if ($null -eq $psql -or $null -eq $dump) { Fail 'psql and pg_dump must both be on PATH' }
    Write-Host ((& psql --version) + ' @ ' + $psql.Source)
    Write-Host ((& pg_dump --version) + ' @ ' + $dump.Source)

    Section '5. PURGE RUNNER'
    Write-Host 'You will be asked for:'
    Write-Host '  1. the Supabase database password'
    Write-Host '  2. I HAVE A RESTORABLE BACKUP'
    Write-Host '  3. PURGE PRODUCTION NOW'
    Write-Host 'Type them yourself. Nothing is entered on your behalf.'
    Write-Host ''

    & (Join-Path $PSScriptRoot 'run-prelaunch-purge-v147.ps1')
    $purgeExit = $LASTEXITCODE

    if ($purgeExit -ne 0) {
        Section 'RESULT: PURGE DID NOT COMPLETE'
        Write-Host "The purge runner exited $purgeExit." -ForegroundColor Yellow
        Write-Host 'No merge, no deploy, and no retry has been attempted.'
        Write-Host 'Read the runner report above before doing anything else.'
        exit $purgeExit
    }

    Section '6. POST-PURGE RELEASE'
    & (Join-Path $PSScriptRoot 'run-pr68-post-purge-release.ps1')
    $postExit = $LASTEXITCODE
    if ($postExit -ne 0) {
        Section 'RESULT: PURGE SUCCEEDED, RELEASE STOPPED'
        Write-Host 'The database is purged and migrated, but the merge/deploy stage stopped.'
        Write-Host 'Production data state is reconciled; review the report above.'
        exit $postExit
    }

    Section 'RESULT: PR68 RELEASE GATE COMPLETED'
    Write-Host 'Purge, migrations 148-153, merge, deployment and smoke tests all completed.'
}
catch {
    Write-Host ''
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
finally {
    Write-Host ''
    Write-Host 'Press Enter to close this window.'
    [void][System.Console]::ReadLine()
}
