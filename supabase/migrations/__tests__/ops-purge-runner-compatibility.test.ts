/**
 * PURGE RUNNER COMPATIBILITY — ops/run-prelaunch-purge-v147.ps1
 *
 * Runs everywhere (no rig, no database), so CI protects the owner-run command.
 *
 * WHY THIS EXISTS. The runner originally contained nine em dashes (U+2014) and
 * was saved as UTF-8 WITHOUT a BOM. Windows PowerShell 5.1 falls back to the
 * ANSI code page (CP1252) when there is no BOM, so each em dash decoded as
 * "a-EUR-<0x94>" and that trailing 0x94 is U+201D RIGHT DOUBLE QUOTATION MARK --
 * which PowerShell accepts as a STRING DELIMITER. Nine spurious delimiters is an
 * odd count, so the parser was left mid-string and every later statement was
 * mis-parsed; the first reported error landed on an unrelated `SELECT` more than
 * 200 lines below the actual cause. The file never executed a single line.
 *
 * Keeping the runner pure ASCII makes it encoding-proof: identical bytes under
 * UTF-8, CP1252 and any other ANSI code page, so it parses the same on Windows
 * PowerShell 5.1 and PowerShell 7+ regardless of BOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUNNER = join(REPO, 'ops', 'run-prelaunch-purge-v147.ps1');

describe('purge runner — PowerShell compatibility', () => {
  it('contains no non-ASCII bytes (the actual 5.1 parse-break cause)', () => {
    const bytes = readFileSync(RUNNER);
    const offenders: string[] = [];
    let line = 1;
    for (const b of bytes) {
      if (b === 0x0a) line++;
      else if (b > 127) offenders.push(`byte 0x${b.toString(16)} on line ${line}`);
    }
    expect(offenders, `runner must stay pure ASCII:\n${offenders.slice(0, 20).join('\n')}`).toEqual([]);
  });

  it('has no characters PowerShell would treat as smart-quote delimiters', () => {
    const src = readFileSync(RUNNER, 'utf8');
    for (const ch of ['\u2018', '\u2019', '\u201C', '\u201D', '\u2013', '\u2014', '\u2192']) {
      expect(src.includes(ch), `must not contain U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`).toBe(false);
    }
  });

  it('closes every here-string with "@ at column 0', () => {
    // A here-string terminator indented by even one space is not a terminator,
    // which produces the same class of cascading mis-parse.
    const lines = readFileSync(RUNNER, 'utf8').split(/\r?\n/);
    let open = false;
    const bad: string[] = [];
    lines.forEach((l, i) => {
      if (!open && /@["']\s*$/.test(l)) { open = true; return; }
      if (open) {
        if (/^["']@/.test(l)) { open = false; return; }
        if (/^\s+["']@/.test(l)) bad.push(`line ${i + 1}: terminator is indented`);
      }
    });
    expect(bad, bad.join('\n')).toEqual([]);
    expect(open, 'a here-string was never closed').toBe(false);
  });

  it('keeps the safety contract verbatim', () => {
    const src = readFileSync(RUNNER, 'utf8');
    for (const needle of [
      'I HAVE A RESTORABLE BACKUP',
      'PURGE PRODUCTION NOW',
      'abdallahjawad2015@gmail.com',
      'I_ATTEST_PRODUCTION_FULL_PURGE_V147_OPTION_A',
      'STOP_KEEPER_ACCOUNT_UNVERIFIED',
      'STOP_RESTORABLE_BACKUP_UNVERIFIED',
      'ZeroFreeBSTR',
    ]) {
      expect(src, `${needle} must be present`).toContain(needle);
    }
  });

  it('never auto-answers its own confirmations', () => {
    const src = readFileSync(RUNNER, 'utf8');
    // Each phrase must appear only in a Read-Host prompt and an inequality
    // comparison -- never assigned into the variable that is being checked.
    for (const [phrase, v] of [['I HAVE A RESTORABLE BACKUP', 'ok'], ['PURGE PRODUCTION NOW', 'go']] as const) {
      expect(src, `${phrase} must be compared with -ne`).toMatch(
        new RegExp(`\\$${v}\\s+-ne\\s+'${phrase}'`),
      );
      expect(src, `${phrase} must not be assigned to $${v}`).not.toMatch(
        new RegExp(`\\$${v}\\s*=\\s*'${phrase}'`),
      );
    }
    expect(src).toMatch(/Read-Host 'Enter Supabase Database Password' -AsSecureString/);
  });

  it('contains no forbidden construct, credential or retry', () => {
    const src = readFileSync(RUNNER, 'utf8');
    for (const bad of [
      'DISABLE TRIGGER ALL',
      'session_replication_role',
      'DELETE FROM storage.objects',
      'ConvertFrom-SecureString',
      'Start-Transcript',
    ]) {
      expect(src, `${bad} must not appear`).not.toContain(bad);
    }
    // No password may ever reach argv or a file.
    expect(src).not.toMatch(/--password\s+["']?\$plain/);
    expect(src).not.toMatch(/Set-Content[^\n]*\$env:PGPASSWORD/);
  });

  it('verifies TLS against an explicit pinned CA, not the OS trust store', () => {
    // Canonical memory v11 3.2: an explicit, checksum-pinned Supabase CA is the
    // approved trust root. sslrootcert=system was the PREVIOUS approach and is
    // demoted to unproven -- an unverifiable trust root fails silently open,
    // which is worse than a missing one that fails closed.
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).toContain('sslmode=verify-full');
    expect(src).toMatch(/sslrootcert=\$ca/);
    expect(src, 'the connection must not fall back to the OS trust store').not.toMatch(
      /return\s+"[^"]*sslrootcert=system/,
    );
    for (const weak of ['sslmode=require', 'sslmode=prefer', 'sslmode=allow', 'sslmode=disable']) {
      expect(src, `${weak} encrypts without authenticating the server`).not.toContain(weak);
    }
  });

  it('proves the CA file and its pinned checksum before any credential', () => {
    const src = readFileSync(RUNNER, 'utf8');
    for (const stop of [
      'STOP_CA_CERTIFICATE_MISSING',
      'STOP_CA_CERTIFICATE_INVALID',
      'STOP_CA_CHECKSUM_MISSING',
      'STOP_CA_CHECKSUM_MISMATCH',
    ]) {
      expect(src, `${stop} must be enforced`).toContain(stop);
    }
    expect(src).toMatch(/Get-FileHash -Path \$CaCertPath -Algorithm SHA256/);
    const caGate = src.indexOf('Assert-CaCertificate\n');
    const prompt = src.indexOf("Read-Host 'Enter Supabase Database Password'");
    expect(caGate, 'the CA gate must be invoked').toBeGreaterThan(-1);
    expect(caGate, 'CA verification must precede the password prompt').toBeLessThan(prompt);
  });

  it('requires a client toolchain matching the Production major, not merely newer', () => {
    // v11 3.4: Production is PostgreSQL 17.x. A newer pg_dump can emit archive
    // features a 17 server cannot restore, which would make the backup unusable
    // exactly when it is needed -- so equality, not >=.
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).toMatch(/\$RequiredPgMajor\s*=\s*17/);
    expect(src).toMatch(/\$mp -eq \$RequiredPgMajor -and \$md -eq \$RequiredPgMajor/);
    expect(src, 'a >= comparison would admit an 18.x toolchain').not.toMatch(/\$mp -ge 16/);
  });

  it('drives psql and pg_dump from one connection builder', () => {
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).toMatch(/function Get-ConnString/);
    // Exactly one place constructs host=..., so the two tools cannot drift.
    const hostLiterals = src.match(/host=\$PoolerHost/g) ?? [];
    expect(hostLiterals.length, 'only Get-ConnString may build the connection string').toBe(1);
    expect(src, 'pg_dump must use the shared builder').toMatch(/\$script:DumpExe \(Get-ConnString\)/);
    expect(src, 'psql must use the shared builder').toMatch(/\$script:PsqlExe \(Get-ConnString\)/);
  });

  it('rejects a mismatched toolchain BEFORE prompting for a password', () => {
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).toContain('STOP_POSTGRES_CLIENT_VERSION_UNSUPPORTED');
    const gateAt = src.indexOf('Resolve-PgClientTools\n');
    const promptAt = src.indexOf("Read-Host 'Enter Supabase Database Password'");
    expect(gateAt, 'the version gate must be invoked').toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(-1);
    expect(gateAt, 'version gate must run before the password prompt').toBeLessThan(promptAt);
    // Same-distribution pairing, not PATH roulette.
    expect(src).toMatch(/pg_dump\.exe/);
  });

  it('never claims a backup it did not write', () => {
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).toContain('No local dump was created.');
    // The success message must be guarded by an existence check.
    expect(src).toMatch(/if \(\$script:DumpPath -and \(Test-Path \$script:DumpPath\)\)/);
    // A failed or undersized dump is deleted rather than left to look like one.
    expect(src).toMatch(/Remove-Item \$dump -Force/);
    // Size and checksum are reported on success.
    expect(src).toMatch(/Get-FileHash -Path \$dump -Algorithm SHA256/);
    expect(src).toMatch(/SHA-256\s*:/);
  });

  it('parses cleanly under the real Windows PowerShell parser', () => {
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    if (process.platform !== 'win32' || !existsSync(ps)) return; // Linux CI: byte guard above is the protection
    const script = `
$t=$null;$e=$null
[System.Management.Automation.Language.Parser]::ParseFile('${RUNNER.replace(/\\/g, '\\\\')}',[ref]$t,[ref]$e)|Out-Null
if ($e.Count -ne 0) { $e | ForEach-Object { Write-Output ("line " + $_.Extent.StartLineNumber + ": " + $_.Message) } }
Write-Output ("ERRORS=" + $e.Count)`;
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    expect(out, `parser reported errors:\n${out}`).toMatch(/ERRORS=0\s*$/);
  });
});
