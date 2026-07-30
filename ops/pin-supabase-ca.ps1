<#
================================================================================
 Pin the Supabase CA certificate -- run ONCE, by the owner.

     powershell -NoProfile -ExecutionPolicy Bypass -File ops\pin-supabase-ca.ps1

 The release runner refuses to connect unless an explicit CA certificate exists
 at a canonical path AND matches a recorded SHA-256. This records that SHA-256.

 BEFORE running it, place the certificate at:
     ops\certs\supabase-prod-ca.crt
 Get it from the Supabase dashboard:
     Project Settings -> Database -> SSL Configuration -> download certificate

 The certificate is public information, not a secret, but pinning it is what
 makes verify-full meaningful: it fixes WHICH trust root is acceptable, so a
 substituted or corrupted file fails closed instead of silently validating.

 This script never downloads anything, never prints certificate contents, and
 never touches Production.
================================================================================
#>

param(
    # Re-pin over an existing pin. Requires deliberate intent, because silently
    # accepting a changed CA would defeat the entire point of pinning.
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CertPath = Join-Path $RepoRoot 'ops\certs\supabase-prod-ca.crt'
$ShaPath  = Join-Path $RepoRoot 'ops\certs\supabase-prod-ca.crt.sha256'

Write-Host ''
Write-Host '=============================================================================='
Write-Host '  Pin the Supabase CA certificate'
Write-Host '=============================================================================='

if (-not (Test-Path $CertPath)) {
    Write-Host ''
    Write-Host "No certificate found at:" -ForegroundColor Yellow
    Write-Host "  $CertPath"
    Write-Host ''
    Write-Host 'Download it from the Supabase dashboard:'
    Write-Host '  Project Settings -> Database -> SSL Configuration -> download certificate'
    Write-Host 'Save it to the path above, then run this script again.'
    exit 1
}

$len = (Get-Item $CertPath).Length
if ($len -lt 512) {
    Write-Host "Certificate is only $len bytes -- too small to be a CA bundle. Refusing." -ForegroundColor Red
    exit 1
}

# Structural sanity: it must actually look like a PEM certificate.
$head = Get-Content $CertPath -TotalCount 1
if ($head -notmatch 'BEGIN CERTIFICATE') {
    Write-Host 'File does not start with a PEM certificate header. Refusing.' -ForegroundColor Red
    exit 1
}

$hash = (Get-FileHash -Path $CertPath -Algorithm SHA256).Hash.ToLower()

if ((Test-Path $ShaPath) -and -not $Force) {
    $existing = (Get-Content $ShaPath -Raw).Trim().ToLower()
    if ($existing -eq $hash) {
        Write-Host ''
        Write-Host 'Already pinned, and the certificate still matches.' -ForegroundColor Green
        Write-Host "  SHA-256 : $hash"
        exit 0
    }
    Write-Host ''
    Write-Host 'A pin already exists and the certificate does NOT match it.' -ForegroundColor Red
    Write-Host "  pinned : $existing"
    Write-Host "  actual : $hash"
    Write-Host ''
    Write-Host 'This means the certificate changed. Confirm the new file is genuinely from'
    Write-Host 'Supabase before accepting it, then re-run with -Force.'
    exit 1
}

New-Item -ItemType Directory -Path (Split-Path -Parent $ShaPath) -Force | Out-Null
Set-Content -Path $ShaPath -Value $hash -Encoding ascii -NoNewline

Write-Host ''
Write-Host 'Pinned.' -ForegroundColor Green
Write-Host "  certificate : $CertPath"
Write-Host ("  size        : {0:N0} bytes" -f $len)
Write-Host "  SHA-256     : $hash"
Write-Host "  pin file    : $ShaPath"
Write-Host ''
Write-Host 'Commit the .sha256 pin file. Do NOT commit the certificate itself --'
Write-Host 'it is environment-specific and is supplied per machine.'
