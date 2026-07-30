/**
 * RELEASE ENGINE CONTRACT -- target-manifest architecture + evidence chain.
 *
 * Runs everywhere (no rig, no database), so CI protects the owner-run path.
 *
 * WHY THIS EXISTS, three times over.
 *
 * 1. The runner once contained nine em dashes (U+2014) and was saved as UTF-8
 *    with no BOM. Windows PowerShell 5.1 falls back to the ANSI code page, so
 *    each em dash decoded to a trailing 0x94 = U+201D, which PowerShell accepts
 *    as a STRING DELIMITER. Nine spurious delimiters is an odd count, so the
 *    parser was left mid-string and the first reported error landed on an
 *    unrelated `SELECT` 200+ lines below the real break. The file never executed.
 *
 * 2. The runner was then hard-coded to Production: project ref, pooler host, CA
 *    path and labels. That made canonical memory's central requirement
 *    impossible -- rehearse on staging, then run THE SAME PATH on Production
 *    unmodified. Editing constants between the two means the thing you proved
 *    is not the thing you ran. The engine is now target-agnostic and reads a
 *    manifest; these tests keep it that way.
 *
 * 3. Production authorization was then a single allow_destructive_execution
 *    boolean on production.json, which meant "authorizing" a release required
 *    editing and committing the production manifest -- so it was never
 *    byte-identical between rehearsal and the real run either, and the
 *    "artifact" that unlocked it was a hand-filled template. execution_policy
 *    now never changes, and authorization lives in a chain of files that are
 *    only ever generated from real evidence and re-verified from scratch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OPS = join(REPO, 'ops');
const CORE = join(OPS, 'run-prelaunch-release-core.ps1');
const STAGES = join(OPS, 'release-stages.ps1');
const TARGETS = join(OPS, 'targets');

const PS_FILES = [
  'run-prelaunch-release-core.ps1',
  'release-stages.ps1',
  'pin-supabase-ca.ps1',
  'run-pr68-final-release.ps1',
  'run-pr68-post-purge-release.ps1',
  'generate-restore-proof.ps1',
  'generate-staging-rehearsal-proof.ps1',
  'record-owner-go.ps1',
].map((f) => join(OPS, f));

const readTarget = (n: string) => JSON.parse(readFileSync(join(TARGETS, n), 'utf8'));
const coreSrc = () => readFileSync(CORE, 'utf8');
const stagesSrc = () => readFileSync(STAGES, 'utf8');

describe('release engine -- encoding and PowerShell compatibility', () => {
  it('every ops PowerShell file is pure ASCII', () => {
    for (const f of PS_FILES) {
      const bytes = readFileSync(f);
      const bad: string[] = [];
      let line = 1;
      for (const b of bytes) {
        if (b === 0x0a) line++;
        else if (b > 127) bad.push(`${f} line ${line}: 0x${b.toString(16)}`);
      }
      expect(bad, bad.slice(0, 10).join('\n')).toEqual([]);
    }
  });

  it('contains no character PowerShell would treat as a smart-quote delimiter', () => {
    for (const f of PS_FILES) {
      const src = readFileSync(f, 'utf8');
      for (const ch of ['\u2018', '\u2019', '\u201C', '\u201D', '\u2013', '\u2014', '\u2192']) {
        expect(src.includes(ch), `${f} contains U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
      }
    }
  });

  it('parses cleanly under the real Windows PowerShell parser', () => {
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    if (process.platform !== 'win32' || !existsSync(ps)) return; // Linux CI: byte guard above protects
    for (const f of PS_FILES) {
      const script = `
$t=$null;$e=$null
[System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/\\/g, '\\\\')}',[ref]$t,[ref]$e)|Out-Null
if ($e.Count -ne 0) { $e | ForEach-Object { Write-Output ("line " + $_.Extent.StartLineNumber + ": " + $_.Message) } }
Write-Output ("ERRORS=" + $e.Count)`;
      const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
      expect(out, `${f}:\n${out}`).toMatch(/ERRORS=0\s*$/);
    }
    // Each powershell.exe spawn costs roughly a second, and there are several
    // files, so this needs more than the default 5s budget.
  }, 120_000);
});

describe('release engine -- target separation', () => {
  it('the engine hard-codes no environment identifier', () => {
    // The whole point: one engine, many targets. A literal project ref, pooler
    // host, or environment-specific CA filename here would reintroduce the
    // "edit constants between rehearsal and production" defect.
    const src = coreSrc() + stagesSrc();
    for (const leak of [
      'eyrzxgfkvqybjdgyphap',
      'aws-1-ap-south-1.pooler.supabase.com',
      'production-ca.crt',
      'staging-ca.crt',
      'abdallahjawad2015@gmail.com',
    ]) {
      expect(src, `${leak} must come from the target manifest, not the engine`).not.toContain(leak);
    }
  });

  it('there is exactly one destructive execution path', () => {
    // No staging-specific or production-specific copy of the runner may exist.
    // "Drives the purge" means owning the confirmation GATE, not merely printing
    // the phrase -- the orchestrator legitimately tells the operator what they
    // will be asked for.
    const psFiles = readdirSync(OPS).filter((f) => f.endsWith('.ps1'));
    const purgers = psFiles.filter((f) => {
      const s = readFileSync(join(OPS, f), 'utf8');
      return /purge not confirmed by operator/.test(s) || /\\i .*purge/.test(s);
    });
    expect(purgers, `only release-stages.ps1 may drive the purge, found: ${purgers.join(', ')}`)
      .toEqual(['release-stages.ps1']);
    // And the retired hard-coded runner must be gone, not merely unused.
    expect(existsSync(join(OPS, 'run-prelaunch-purge-v147.ps1'))).toBe(false);
  });

  it('the engine requires a target manifest', () => {
    const src = coreSrc();
    expect(src).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[string\]\$TargetManifest/);
    expect(src).toMatch(/function Read-TargetManifest/);
  });

  it('the confirmation phrase is target-specific, driven from one implementation', () => {
    const src = stagesSrc();
    expect(src).toMatch(/'PURGE REHEARSAL CLONE NOW'/);
    expect(src).toMatch(/'PURGE STAGING NOW'/);
    expect(src).toMatch(/'PURGE PRODUCTION NOW'/);
    expect(src).toMatch(/\$go -ne \$purgePhrase/);
    // never auto-answered
    expect(src).not.toMatch(/\$go\s*=\s*'PURGE/);
  });
});

describe('target manifests', () => {
  it('no manifest uses the retired allow_destructive_execution boolean', () => {
    for (const f of readdirSync(TARGETS).filter((x) => x.endsWith('.json'))) {
      const obj = readTarget(f);
      expect(Object.keys(obj), `${f} must not contain allow_destructive_execution`).not.toContain(
        'allow_destructive_execution'
      );
      expect(obj.execution_policy, `${f} must declare execution_policy`).toBeTruthy();
      expect(['rehearsal_allowed', 'requires_rehearsal_authorization', 'disabled']).toContain(obj.execution_policy);
    }
  });

  it('production is fail-closed by execution_policy, permanently', () => {
    const p = readTarget('production.json');
    expect(p.environment).toBe('production');
    expect(p.execution_policy, 'production must always require rehearsal authorization').toBe(
      'requires_rehearsal_authorization'
    );
    expect(p.ssl_mode).toBe('verify-full');
    expect(p.required_pg_major).toBe(17);
    expect(p.expected_initial_ceiling).toBe(147);
    expect(p.expected_final_ceiling).toBe(153);
  });

  it('staging cannot borrow production identity or trust material', () => {
    const prod = readTarget('production.json');
    const stg = readTarget('staging.example.json');
    expect(stg.execution_policy).toBe('rehearsal_allowed');
    expect(stg.project_ref).not.toBe(prod.project_ref);
    expect(stg.pooler_host).not.toBe(prod.pooler_host);
    expect(stg.ca_certificate_path).not.toBe(prod.ca_certificate_path);
    expect(stg.ca_sha256_path).not.toBe(prod.ca_sha256_path);
    expect(stg.project_ref, 'the example must not invent a real ref').toMatch(/PLACEHOLDER/);
    expect(stg.ssl_mode).toBe('verify-full');
  });

  it('no manifest carries secret material', () => {
    for (const f of readdirSync(TARGETS).filter((x) => x.endsWith('.json'))) {
      const raw = readFileSync(join(TARGETS, f), 'utf8');
      const obj = JSON.parse(raw);
      for (const k of ['password', 'db_password', 'service_role_key', 'anon_key', 'access_token', 'pgpassword']) {
        expect(Object.keys(obj), `${f} must not contain ${k}`).not.toContain(k);
      }
      expect(raw, `${f} must not embed a JWT`).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    }
  });

  it('the clone target stays local and TLS-free only on loopback', () => {
    const c = readTarget('rehearsal-clone.example.json');
    expect(c.environment).toBe('rehearsal_clone');
    expect(c.execution_policy).toBe('rehearsal_allowed');
    expect(['127.0.0.1', 'localhost', '::1']).toContain(c.pooler_host);
    expect(c.required_pg_major).toBe(17);
    // The engine must reject sslmode=disable for any non-loopback host.
    const src = coreSrc();
    expect(src).toMatch(/ssl_mode=disable is only permitted for a loopback rehearsal clone/);
  });
});

describe('clone mode isolation', () => {
  it('the clone path never invokes live Supabase or Vercel tooling', () => {
    const stages = stagesSrc();
    // supabase link/db push must be reachable only on the non-clone branch.
    const start = stages.indexOf('if ($isClone) {');
    expect(start, 'clone branch must exist').toBeGreaterThan(-1);
    const end = stages.indexOf('} else {', start);
    expect(end, 'clone branch must be closed by an else').toBeGreaterThan(start);
    const cloneBranch = stages.slice(start, end);
    expect(cloneBranch, 'clone branch must not call the Supabase CLI').not.toMatch(/&\s+supabase/);
    expect(cloneBranch).not.toMatch(/vercel/i);
    expect(cloneBranch, 'clone applies migration files directly').toMatch(/applying migration files directly/);
  });

  it('the clone target skips the platform-backup confirmation but not the dump', () => {
    const stages = stagesSrc();
    expect(stages).toMatch(/the clone IS the restore proof/);
    expect(stages, 'a dump is still taken for every target').toMatch(/\$script:DumpExe \$Conn --format=custom/);
  });
});

describe('production authorization -- evidence chain', () => {
  const EVIDENCE_FIELDS = [
    'tested_head_sha', 'purge_sql_sha256', 'purge_manifest_sha256', 'migrations_148_153_sha256',
    'staging_manifest_sha256', 'production_manifest_sha256', 'staging_project_ref',
    'staging_ca_sha256', 'production_ca_sha256', 'backup_sha256', 'restore_proof_sha256',
    'trigger_proof_sha256', 'rollback_proof_sha256', 'exact_psql_version', 'exact_pg_dump_version',
    'psql_executable_path', 'pg_dump_executable_path', 'psql_executable_sha256', 'pg_dump_executable_sha256',
    'staging_pg_version', 'completed_at_utc',
  ];

  it('requires all three evidence files and pins every field to reality', () => {
    const src = coreSrc();
    expect(src).toContain('STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED');
    for (const field of EVIDENCE_FIELDS) {
      expect(src, `staging proof field ${field} must be verified`).toContain(field);
    }
    // Every pinned value is recomputed and compared, not merely required to be present.
    expect(src).toMatch(/\$staging\.tested_head_sha -ne \$head/);
    expect(src).toMatch(/\$staging\.purge_sql_sha256 -ne \$m\.purge_sql_sha256/);
    expect(src).toMatch(/\$staging\.purge_manifest_sha256 -ne \$manifestSha/);
    expect(src).toMatch(/\$staging\.migrations_148_153_sha256 -ne \$migSha/);
    expect(src).toMatch(/\$staging\.production_manifest_sha256 -ne \$prodManifestSha/);
    expect(src).toMatch(/\$staging\.restore_proof_sha256 -ne \$restoreProofFileSha/);
    expect(src).toMatch(/\$owner\.staging_proof_sha256 -ne \$stagingProofFileSha/);
    expect(src).toMatch(/\$owner\.decision -ne 'GO'/);
    expect(src).toMatch(/\$owner\.expected_production_head -ne \$head/);
  });

  it('staging and production CA pins are verified separately, never shared', () => {
    const src = coreSrc();
    expect(src).toContain('staging_ca_sha256');
    expect(src).toContain('production_ca_sha256');
    expect(src).toMatch(/\$staging\.production_ca_sha256 -ne \$prodCaPin/);
    expect(src).toMatch(/\$staging\.staging_ca_sha256 -eq \$staging\.production_ca_sha256/);
  });

  it('exact tool version, executable path and executable hash must match the rehearsal', () => {
    const src = coreSrc();
    expect(src).toMatch(/\$staging\.exact_psql_version -ne \$script:PsqlVersion/);
    expect(src).toMatch(/\$staging\.psql_executable_path -ne \$script:PsqlExe/);
    expect(src).toMatch(/\$staging\.psql_executable_sha256 -ne \$script:PsqlSha256/);
    expect(src).toMatch(/\$staging\.pg_dump_executable_sha256 -ne \$script:DumpSha256/);
  });

  it('restore proof must show trigger reconciliation and rollback proven', () => {
    const src = coreSrc();
    expect(src).toMatch(/trigger_reconciliation_proven/);
    expect(src).toMatch(/rollback_proven/);
    expect(src).toMatch(/if \(-not \$restore\.\$flag\)/);
  });

  it('placeholder, empty or malformed evidence fields never authorize', () => {
    const src = coreSrc();
    expect(src).toMatch(/function Test-NonPlaceholder/);
    expect(src).toMatch(/function Test-Sha256Hex/);
    expect(src).toMatch(/function Test-Iso8601Utc/);
    expect(src).toMatch(/\(\?i\)placeholder/);
  });

  it('authorization is checked before the password prompt', () => {
    const src = coreSrc();
    const auth = src.indexOf('Assert-RehearsalAuthorization $M');
    const ca = src.indexOf('Assert-CaCertificate $M');
    const tools = src.indexOf('Resolve-PgClientTools ([int]$M.required_pg_major)');
    const prompt = src.indexOf("Read-Host 'Enter database password'");
    for (const [name, at] of [['tools', tools], ['CA', ca], ['authorization', auth]] as const) {
      expect(at, `${name} gate must exist`).toBeGreaterThan(-1);
      expect(at, `${name} gate must precede the password prompt`).toBeLessThan(prompt);
    }
  });

  it('a disabled target exits before requesting any credential', () => {
    const src = coreSrc();
    const guard = src.indexOf("$M.execution_policy -eq 'disabled'");
    const prompt = src.indexOf("Read-Host 'Enter database password'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(prompt);
    expect(src).toMatch(/EXECUTION NOT AUTHORIZED/);
  });

  it('rehearsal_allowed targets skip the evidence chain entirely', () => {
    const src = coreSrc();
    expect(src).toMatch(/no evidence chain required/);
  });
});

describe('evidence generator scripts never fabricate success', () => {
  it('restore proof generation requires explicit operator confirmation', () => {
    const src = readFileSync(join(OPS, 'generate-restore-proof.ps1'), 'utf8');
    expect(src).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[switch\]\$Confirmed/);
    expect(src).toMatch(/if \(-not \$Confirmed\)/);
    expect(src).toMatch(/Get-FileHash/);
  });

  it('staging proof generation refuses to build on an unproven restore', () => {
    const src = readFileSync(join(OPS, 'generate-staging-rehearsal-proof.ps1'), 'utf8');
    expect(src).toMatch(/trigger_reconciliation_proven/);
    expect(src).toMatch(/rollback_proven/);
    expect(src).toMatch(/if \(-not \$restore\.\$flag\)/);
    expect(src).toMatch(/staging project_ref must not equal the production project_ref/);
  });

  it('owner Go decision requires an exact typed phrase, never auto-answered', () => {
    const src = readFileSync(join(OPS, 'record-owner-go.ps1'), 'utf8');
    expect(src).toMatch(/if \(\$typed -ne \$ConfirmPhrase\)/);
    expect(src).not.toMatch(/\$typed\s*=\s*\$ConfirmPhrase/);
    expect(src).toMatch(/decision\s*=\s*'GO'/);
  });

  it('no generator script ever connects to a database', () => {
    for (const f of ['generate-restore-proof.ps1', 'generate-staging-rehearsal-proof.ps1', 'record-owner-go.ps1']) {
      const src = readFileSync(join(OPS, f), 'utf8');
      expect(src, `${f} must not use psql/PGPASSWORD`).not.toMatch(/PGPASSWORD/);
      expect(src, `${f} must not connect to a database`).not.toMatch(/sslmode=/);
    }
  });
});

describe('credential and TLS handling', () => {
  it('never lets a secret reach argv, a file, or a report', () => {
    for (const f of PS_FILES) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f}`).not.toMatch(/--password\s+["']?\$plain/);
      expect(src, `${f}`).not.toMatch(/Set-Content[^\n]*\$env:PGPASSWORD/);
      expect(src, `${f}`).not.toContain('ConvertFrom-SecureString');
      expect(src, `${f}`).not.toContain('Start-Transcript');
    }
    const core = coreSrc();
    expect(core).toMatch(/ZeroFreeBSTR/);
    expect(core).toMatch(/Remove-Item Env:\\PGPASSWORD/);
    expect(core).toMatch(/password must never appear in a connection string/);
  });

  it('remote targets keep verify-full with an explicit pinned CA', () => {
    const core = coreSrc();
    expect(core).toMatch(/remote target must use sslmode=verify-full/);
    expect(core).toMatch(/sslrootcert=system is unproven/);
    for (const weak of ["sslmode=require'", "sslmode=prefer'", "sslmode=allow'"]) {
      expect(core, `${weak} must never be produced`).not.toContain(`return "$s ${weak}`);
    }
    for (const stop of ['STOP_CA_CERTIFICATE_MISSING', 'STOP_CA_CHECKSUM_MISSING', 'STOP_CA_CHECKSUM_MISMATCH']) {
      expect(core).toContain(stop);
    }
  });

  it('never auto-answers its own confirmations', () => {
    const stages = stagesSrc();
    expect(stages).toMatch(/\$ok -ne 'I HAVE A RESTORABLE BACKUP'/);
    expect(stages).toMatch(/\$go -ne \$purgePhrase/);
    expect(stages).not.toMatch(/\$ok\s*=\s*'I HAVE A RESTORABLE BACKUP'/);
    expect(stages).not.toMatch(/\$go\s*=\s*'PURGE/);
  });

  it('never disables triggers wholesale or retries a purge', () => {
    for (const f of PS_FILES) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toContain('DISABLE TRIGGER ALL');
      expect(src).not.toContain('session_replication_role');
      expect(src).not.toContain('DELETE FROM storage.objects');
    }
  });
});
