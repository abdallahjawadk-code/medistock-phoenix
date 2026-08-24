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
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OPS = join(REPO, 'ops');
const CORE = join(OPS, 'run-prelaunch-release-core.ps1');
const STAGES = join(OPS, 'release-stages.ps1');
const EVIDENCE_CHAIN = join(OPS, 'evidence-chain.ps1');
const RESTORE_PROOF_GEN = join(OPS, 'generate-restore-proof.ps1');
const STAGING_PROOF_GEN = join(OPS, 'generate-staging-rehearsal-proof.ps1');
const OWNER_GO = join(OPS, 'record-owner-go.ps1');
const RESTORE_RIG = join(OPS, 'run-pg17-restore-rehearsal.ps1');
const TARGETS = join(OPS, 'targets');

const PS_FILES = [
  'run-prelaunch-release-core.ps1',
  'release-stages.ps1',
  'evidence-chain.ps1',
  'pin-supabase-ca.ps1',
  'run-pr68-final-release.ps1',
  'run-pr68-post-purge-release.ps1',
  'generate-restore-proof.ps1',
  'generate-staging-rehearsal-proof.ps1',
  'record-owner-go.ps1',
  'run-pg17-restore-rehearsal.ps1',
].map((f) => join(OPS, f));

const readTarget = (n: string) => JSON.parse(readFileSync(join(TARGETS, n), 'utf8'));
const coreSrc = () => readFileSync(CORE, 'utf8');

// Shared by every describe block below that needs to exercise a script for
// real: Windows PowerShell 5.1 only (Linux CI is protected by the byte/parse
// guards above instead), always non-interactive so a script that reaches an
// unanswered Read-Host fails fast rather than hanging.
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const canRun = process.platform === 'win32' && existsSync(PS_EXE);
function runPs(script: string, args: string[]) {
  const res = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}
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

  // I-6: this used to `return` early off Windows, which vitest reports as a
  // PASSED test that asserted nothing -- a green tick for work that never ran.
  // it.runIf(canRun) reports it as SKIPPED instead, so the distinction between
  // "proven" and "not attempted" survives into the CI summary, and the
  // ops-windows-acceptance.yml job runs it for real on windows-latest.
  it.runIf(canRun)('parses cleanly under the real Windows PowerShell parser', () => {
    const ps = PS_EXE;
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
    // The recomputation logic now lives in the shared evidence-chain.ps1,
    // called identically from the Production engine and record-owner-go.ps1
    // (see the "one shared validator" describe block below).
    const src = evidenceChainSrc() + coreSrc();
    expect(src).toContain('STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED');
    for (const field of EVIDENCE_FIELDS) {
      expect(src, `staging proof field ${field} must be verified`).toContain(field);
    }
    // Every pinned value is recomputed and compared, not merely required to be present.
    expect(src).toMatch(/\$staging\.tested_head_sha -ne \$Head/);
    expect(src).toMatch(/\$staging\.purge_sql_sha256 -ne \$M\.purge_sql_sha256/);
    expect(src).toMatch(/\$staging\.purge_manifest_sha256 -ne \$manifestSha/);
    expect(src).toMatch(/\$staging\.migrations_148_153_sha256 -ne \$migSha/);
    expect(src).toMatch(/\$staging\.production_manifest_sha256 -ne \$prodManifestSha/);
    expect(src).toMatch(/\$staging\.restore_proof_sha256 -ne \$restoreProofFileSha/);
    expect(src).toMatch(/\$owner\.staging_proof_sha256 -ne \$stagingProofFileSha/);
    expect(src).toMatch(/\$owner\.decision -ne 'GO'/);
    expect(src).toMatch(/\$owner\.expected_production_head -ne \$Head/);
  });

  it('staging and production CA pins are verified separately, never shared', () => {
    const src = evidenceChainSrc();
    expect(src).toContain('staging_ca_sha256');
    expect(src).toContain('production_ca_sha256');
    expect(src).toMatch(/\$staging\.production_ca_sha256 -ne \$prodCaPin/);
    expect(src).toMatch(/\$staging\.staging_ca_sha256 -eq \$staging\.production_ca_sha256/);
  });

  it('exact tool version, executable path and executable hash must match the rehearsal', () => {
    // Checked twice: once inside the proof itself (Test-ToolBinaryMatchesProof,
    // shared), and again by the Production engine comparing against the
    // binaries THIS run just resolved (engine-only, not shared with owner-go,
    // since owner-go resolves no tools of its own).
    expect(evidenceChainSrc()).toMatch(/function Test-ToolBinaryMatchesProof/);
    const core = coreSrc();
    expect(core).toMatch(/\$chain\.Staging\.exact_psql_version -ne \$script:PsqlVersion/);
    expect(core).toMatch(/\$chain\.Staging\.psql_executable_path -ne \$script:PsqlExe/);
    expect(core).toMatch(/\$chain\.Staging\.psql_executable_sha256 -ne \$script:PsqlSha256/);
    expect(core).toMatch(/\$chain\.Staging\.pg_dump_executable_sha256 -ne \$script:DumpSha256/);
  });

  it('restore proof must show trigger reconciliation and rollback proven', () => {
    const src = evidenceChainSrc();
    expect(src).toMatch(/Test-BooleanTrue \$restore\.trigger_reconciliation_proven/);
    expect(src).toMatch(/Test-BooleanTrue \$restore\.rollback_proven/);
  });

  it('placeholder, empty or malformed evidence fields never authorize', () => {
    const src = evidenceChainSrc();
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
    const src = restoreProofGenSrc();
    expect(src).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[switch\]\$Confirmed/);
    expect(src).toMatch(/if \(-not \$Confirmed\)/);
    expect(src).toMatch(/Get-FileSha256/);
    expect(evidenceChainSrc()).toMatch(/function Get-FileSha256/);
  });

  it('staging proof generation refuses to build on an unproven restore', () => {
    const src = stagingProofGenSrc();
    expect(src).toMatch(/trigger_reconciliation_proven/);
    expect(src).toMatch(/rollback_proven/);
    expect(src).toMatch(/-not \$restore\.trigger_reconciliation_proven -or -not \$restore\.rollback_proven/);
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

// ============================================================================
// EVIDENCE AUTHENTICITY HARDENING
//
// The chain above proves a proof file exists, is well-formed, and matches
// itself. These tests prove the deeper thing an audit found missing: that a
// proof cannot be produced from a lie. -Confirmed alone must not manufacture
// success; the staging proof must not be typeable by hand; and the exact
// same validator must gate both the owner's Go decision and the Production
// engine, not two versions that could drift apart.
// ============================================================================

const evidenceChainSrc = () => readFileSync(EVIDENCE_CHAIN, 'utf8');
const restoreProofGenSrc = () => readFileSync(RESTORE_PROOF_GEN, 'utf8');
const stagingProofGenSrc = () => readFileSync(STAGING_PROOF_GEN, 'utf8');
const ownerGoSrc = () => readFileSync(OWNER_GO, 'utf8');

describe('one shared validator, called identically by two callers', () => {
  it('the Production engine and record-owner-go.ps1 dot-source the same evidence-chain.ps1', () => {
    for (const src of [coreSrc(), ownerGoSrc(), restoreProofGenSrc(), stagingProofGenSrc()]) {
      expect(src).toMatch(/\.\s*\(Join-Path \$PSScriptRoot 'evidence-chain\.ps1'\)/);
    }
  });

  it('Test-RestoreAndStagingEvidence is defined exactly once, in evidence-chain.ps1', () => {
    const psFiles = readdirSync(OPS).filter((f) => f.endsWith('.ps1'));
    const definers = psFiles.filter((f) => readFileSync(join(OPS, f), 'utf8').includes('function Test-RestoreAndStagingEvidence'));
    expect(definers).toEqual(['evidence-chain.ps1']);
  });

  it('both the Production engine and owner-go call it, with no lighter alternate path', () => {
    expect(coreSrc()).toMatch(/Test-RestoreAndStagingEvidence -M \$m -RepoRoot \$RepoRoot -Head \$head/);
    expect(ownerGoSrc()).toMatch(/Test-RestoreAndStagingEvidence -M \$M -RepoRoot \$RepoRoot -Head \$ExpectedProductionHead/);
  });

  it('the field-level validators (placeholder/sha256/timestamp/required-field) are defined exactly once', () => {
    const psFiles = readdirSync(OPS).filter((f) => f.endsWith('.ps1') && f !== 'evidence-chain.ps1');
    for (const fn of ['function Test-NonPlaceholder', 'function Test-Sha256Hex', 'function Test-Iso8601Utc', 'function Test-RequiredFields', 'function Get-FileSha256', 'function Get-JsonSubsetSha256', 'function Get-MigrationRangeSha256']) {
      for (const f of psFiles) {
        expect(readFileSync(join(OPS, f), 'utf8'), `${f} must not redefine ${fn}`).not.toContain(fn);
      }
      expect(evidenceChainSrc(), `evidence-chain.ps1 must define ${fn}`).toContain(fn);
    }
  });
});

describe('restore proof: -Confirmed alone is not sufficient', () => {
  it('requires a structured, mandatory run report', () => {
    const src = restoreProofGenSrc();
    expect(src).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[string\]\$RestoreRunReportPath/);
    expect(src).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[switch\]\$Confirmed/);
  });

  it('validates the report BEFORE -Confirmed is even checked for effect, and before any proof is assembled', () => {
    const src = restoreProofGenSrc();
    const confirmedGuard = src.indexOf('if (-not $Confirmed)');
    const reportValidation = src.indexOf('Test-RestoreRunReport $report');
    const proofAssembly = src.indexOf('$proof = [ordered]@{');
    expect(confirmedGuard).toBeGreaterThan(-1);
    expect(reportValidation).toBeGreaterThan(-1);
    expect(proofAssembly).toBeGreaterThan(-1);
    expect(reportValidation, 'the report must be validated before the proof is built').toBeLessThan(proofAssembly);
  });

  it('the shared validator checks every required execution fact, not just presence', () => {
    const src = evidenceChainSrc();
    expect(src).toMatch(/Test-ExactValue \(\[int\]\$report\.restore_exit_code\) 0 'restore_exit_code'/);
    expect(src).toMatch(/Test-BooleanTrue \$report\.restored_database_probe_passed/);
    expect(src).toMatch(/Test-ExactValue \(\[int\]\$report\.migration_ceiling\) 147/);
    expect(src).toMatch(/Test-BooleanTrue \$report\.keeper_verified/);
    expect(src).toMatch(/Test-BooleanTrue \$report\.rbac_130_415_verified/);
    expect(src).toMatch(/Test-BooleanTrue \$report\.deliberate_rollback_passed/);
    expect(src).toMatch(/Test-BooleanTrue \$report\.reconciliation_passed/);
    expect(src).toMatch(/Test-ExactValue \(\[int\]\$report\.clone_pg_major\) 17/);
    expect(src).toMatch(/\$report\.trigger_definition_before_sha256 -ne \$report\.trigger_definition_after_sha256/);
  });

  it('self-checks the assembled proof with the same validator downstream consumers use', () => {
    const src = restoreProofGenSrc();
    expect(src).toMatch(/Test-RestoreProofObject \$roundTripped/);
  });
});

describe('staging proof: nothing is typed by hand', () => {
  it('accepts only a staging run result, not a manual backup path or server version', () => {
    const src = stagingProofGenSrc();
    expect(src).toMatch(/\[Parameter\(Mandatory = \$true\)\]\[string\]\$StagingRunResultPath/);
    expect(src).not.toMatch(/\$BackupPath\b/);
    expect(src).not.toMatch(/\$StagingServerVersion\b/);
    expect(src).not.toMatch(/\$PsqlExecutablePath\b/);
    expect(src).not.toMatch(/\$PgDumpExecutablePath\b/);
  });

  it('re-verifies the backup and both tool executables instead of trusting the run result', () => {
    const src = stagingProofGenSrc();
    expect(src).toMatch(/\$actualBackupSha = Get-FileSha256 \$result\.backup_path/);
    expect(src).toMatch(/\$actualBackupSha -ne \$result\.backup_sha256/);
    expect(src).toMatch(/\(Get-FileSha256 \$pair\.Path\) -ne \$pair\.Sha/);
    expect(src).toMatch(/\(Get-PgFullVersion \$pair\.Path\) -ne \$pair\.Version/);
  });

  it('the engine writes staging-run-result.json automatically, only after a real staging success', () => {
    expect(coreSrc()).toMatch(/function New-StagingRunResult/);
    const stages = stagesSrc();
    const postApply = stages.indexOf('post-apply verification passed');
    const stagingBranch = stages.indexOf("elseif (\$M.environment -eq 'staging')");
    const newResultCall = stages.indexOf('New-StagingRunResult -M $M -Head $Head');
    expect(postApply).toBeGreaterThan(-1);
    expect(stagingBranch).toBeGreaterThan(postApply);
    expect(newResultCall).toBeGreaterThan(stagingBranch);
  });

  it('New-StagingRunResult writes to a fixed path, never one the operator supplies', () => {
    // -StagingRunResultPath does exist as an engine parameter now (Production
    // reads an already-written result as evidence), but the function that
    // WRITES the file during a staging run must never consult it -- the
    // write path stays hard-coded so the operator cannot redirect what a
    // staging run produces.
    const src = coreSrc();
    const start = src.indexOf('function New-StagingRunResult');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    expect(body).not.toContain('$StagingRunResultPath');
    expect(body).toMatch(/Join-Path \$RepoRoot 'ops\\evidence\\staging-run-result\.json'/);
  });
});

describe('production verifier and owner-go cross-check the full chain', () => {
  it('rejects a staging backup that does not match the restore proof backup', () => {
    expect(evidenceChainSrc()).toMatch(/\$staging\.backup_sha256 -ne \$restore\.backup_sha256/);
  });

  it('recomputes trigger and rollback subset hashes instead of trusting the staging proof', () => {
    const src = evidenceChainSrc();
    expect(src).toMatch(/\$triggerSubset = Get-JsonSubsetSha256 \$restore/);
    expect(src).toMatch(/\$staging\.trigger_proof_sha256 -ne \$triggerSubset/);
    expect(src).toMatch(/\$rollbackSubset = Get-JsonSubsetSha256 \$restore/);
    expect(src).toMatch(/\$staging\.rollback_proof_sha256 -ne \$rollbackSubset/);
  });

  it('rejects a restore clone that was not PostgreSQL major 17', () => {
    expect(evidenceChainSrc()).toMatch(/\[int\]\$restore\.clone_pg_major -ne \[int\]\$M\.required_pg_major/);
  });

  it('recomputes the staging manifest and staging CA pin against the live filesystem, not just format-checks them', () => {
    const src = evidenceChainSrc();
    expect(src).toMatch(/\$stagingManifestSha = Get-FileSha256 \$StagingManifestPath/);
    expect(src).toMatch(/\$staging\.staging_manifest_sha256 -ne \$stagingManifestSha/);
    expect(src).toMatch(/\$stagingCaPin = /);
    expect(src).toMatch(/\$staging\.staging_ca_sha256 -ne \$stagingCaPin/);
  });

  it('the Production engine accepts an explicit StagingManifestPath rather than trusting the proof alone', () => {
    expect(coreSrc()).toMatch(/\[string\]\$StagingManifestPath/);
    expect(coreSrc()).toMatch(/Assert-RehearsalAuthorization \$M \$head \$RestoreProofPath \$StagingProofPath \$OwnerGoPath \$StagingManifestPath/);
  });

  it('rejects illogical evidence timestamp ordering', () => {
    const src = evidenceChainSrc();
    expect(src).toMatch(/function Test-FullTimestampOrder/);
    expect(src).toMatch(/if \(\$rc -gt \$sc\)/);
    expect(src).toMatch(/if \(\$sc -gt \$oc\)/);
    // Restore-vs-staging ordering is also enforced inside the main chain
    // check, not only in the owner-go-specific pass.
    expect(src).toMatch(/if \(\$restoreCompleted -gt \$stagingCompleted\)/);
  });
});

describe('owner-go: full validation happens before the confirmation prompt', () => {
  it('runs the shared full-chain validator before showing the summary or asking for the phrase', () => {
    const src = ownerGoSrc();
    const validated = src.indexOf('Test-RestoreAndStagingEvidence -M $M');
    const summary = src.indexOf("Section 'STAGING REHEARSAL PROOF SUMMARY");
    const prompt = src.indexOf('Read-Host "Type EXACTLY');
    expect(validated).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(validated);
    expect(prompt).toBeGreaterThan(summary);
  });

  it('never writes owner-go.json before the confirmation phrase is checked', () => {
    const src = ownerGoSrc();
    const prompt = src.indexOf('if ($typed -ne $ConfirmPhrase)');
    const write = src.indexOf('Set-Content -Path $OutPath');
    expect(prompt).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(prompt);
  });

  it('self-checks the decision it is about to write with the same owner-go validators', () => {
    const src = ownerGoSrc();
    expect(src).toMatch(/Test-OwnerGoObject \$roundTripped/);
    expect(src).toMatch(/Test-OwnerGoAgainstStaging \$roundTripped \$staging \$StagingProofPath \$ExpectedProductionHead/);
    expect(src).toMatch(/Test-FullTimestampOrder \$restore \$staging \$roundTripped/);
  });
});

describe('all evidence-chain failures precede the Production password prompt', () => {
  it('the evidence chain call and the owner-go path checks all sit before Read-Host', () => {
    const src = coreSrc();
    const ownerGoPathCheck = src.indexOf("Test-Path \$ownerGoPath");
    const assertCall = src.indexOf('Assert-RehearsalAuthorization $M $head $RestoreProofPath $StagingProofPath $OwnerGoPath $StagingManifestPath');
    const prompt = src.indexOf("Read-Host 'Enter database password'");
    expect(ownerGoPathCheck).toBeGreaterThan(-1);
    expect(assertCall).toBeGreaterThan(-1);
    expect(assertCall).toBeLessThan(prompt);
    expect(ownerGoPathCheck).toBeLessThan(prompt);
  });
});

describe('evidence generators, exercised for real (Windows PowerShell only)', () => {
  const VALID_HEX = 'a'.repeat(64);
  const OTHER_HEX = 'b'.repeat(64);
  const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

  function validReport(backupPath: string, overrides: Record<string, unknown> = {}) {
    const backupSha256 = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
    return {
      restore_exit_code: 0,
      restored_database_probe_passed: true,
      migration_ceiling: 147,
      keeper_verified: true,
      rbac_130_415_verified: true,
      trigger_definition_before_sha256: VALID_HEX,
      trigger_definition_after_sha256: VALID_HEX,
      deliberate_rollback_passed: true,
      reconciliation_passed: true,
      clone_pg_major: 17,
      pre_purge_reconciliation_report_sha256: VALID_HEX,
      rollback_report_sha256: VALID_HEX,
      restore_started_at_utc: '2026-01-01T00:00:00Z',
      restore_completed_at_utc: '2026-01-01T01:00:00Z',
      clone_server_version: '17.6',
      backup_path: backupPath,
      backup_sha256: backupSha256,
      backup_size: readFileSync(backupPath).length,
      ...overrides,
    };
  }

  it.runIf(canRun)('an empty run report is rejected and no proof file is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-restore-proof-'));
    try {
      const backup = join(dir, 'backup.dump');
      writeFileSync(backup, 'x'.repeat(1024));
      const report = join(dir, 'report.json');
      writeFileSync(report, '{}');
      const out = join(dir, 'restore-proof.json');

      const { status, out: text } = runPs(RESTORE_PROOF_GEN, [
        '-RestoreRunReportPath', report,
        '-BackupPath', backup,
        '-Confirmed',
        '-OutPath', out,
      ]);

      expect(status, text).not.toBe(0);
      expect(text).toContain('missing field');
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canRun)('-Confirmed does not overcome a report that never actually succeeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-restore-proof-'));
    try {
      const backup = join(dir, 'backup.dump');
      writeFileSync(backup, 'x'.repeat(1024));
      const report = join(dir, 'report.json');
      // The lie: claims success elsewhere but the exit code says it failed.
      writeFileSync(report, JSON.stringify(validReport(backup, { restore_exit_code: 1 })));
      const out = join(dir, 'restore-proof.json');

      const { status, out: text } = runPs(RESTORE_PROOF_GEN, [
        '-RestoreRunReportPath', report,
        '-BackupPath', backup,
        '-Confirmed',
        '-OutPath', out,
      ]);

      expect(status, text).not.toBe(0);
      expect(text).toContain('restore_exit_code');
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canRun)('mismatched trigger definitions before/after are rejected even with every other field correct', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-restore-proof-'));
    try {
      const backup = join(dir, 'backup.dump');
      writeFileSync(backup, 'x'.repeat(1024));
      const report = join(dir, 'report.json');
      // Triggers were not restored identically.
      writeFileSync(report, JSON.stringify(validReport(backup, { trigger_definition_after_sha256: OTHER_HEX })));
      const out = join(dir, 'restore-proof.json');

      const { status, out: text } = runPs(RESTORE_PROOF_GEN, [
        '-RestoreRunReportPath', report,
        '-BackupPath', backup,
        '-Confirmed',
        '-OutPath', out,
      ]);

      expect(status, text).not.toBe(0);
      expect(text.toLowerCase()).toContain('trigger');
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canRun)('a backup that no longer matches the report SHA-256 is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-restore-proof-'));
    try {
      const backup = join(dir, 'backup.dump');
      writeFileSync(backup, 'x'.repeat(1024));
      const report = join(dir, 'report.json');
      writeFileSync(report, JSON.stringify(validReport(backup)));
      // Tamper with the backup after the report was written.
      writeFileSync(backup, 'y'.repeat(1024));
      const out = join(dir, 'restore-proof.json');

      const { status, out: text } = runPs(RESTORE_PROOF_GEN, [
        '-RestoreRunReportPath', report,
        '-BackupPath', backup,
        '-Confirmed',
        '-OutPath', out,
      ]);

      expect(status, text).not.toBe(0);
      expect(text).toContain('no longer matches the SHA-256');
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canRun)('a genuinely passing report produces a proof whose fields match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-restore-proof-'));
    try {
      const backup = join(dir, 'backup.dump');
      writeFileSync(backup, 'x'.repeat(1024));
      const report = join(dir, 'report.json');
      writeFileSync(report, JSON.stringify(validReport(backup)));
      const out = join(dir, 'restore-proof.json');

      const { status, out: text } = runPs(RESTORE_PROOF_GEN, [
        '-RestoreRunReportPath', report,
        '-BackupPath', backup,
        '-Confirmed',
        '-OutPath', out,
      ]);

      expect(status, text).toBe(0);
      expect(existsSync(out)).toBe(true);
      // Windows PowerShell 5.1's "Set-Content -Encoding utf8" writes a BOM.
      const proof = JSON.parse(stripBom(readFileSync(out, 'utf8')));
      expect(proof.restore_exit_code).toBe(0);
      expect(proof.clone_pg_major).toBe(17);
      expect(proof.trigger_reconciliation_proven).toBe(true);
      expect(proof.rollback_proven).toBe(true);
      expect(proof.migration_ceiling).toBe(147);
      expect(proof.backup_sha256).toBe(createHash('sha256').update(readFileSync(backup)).digest('hex'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// RAW EVIDENCE AND WORKTREE GATE
//
// Two closing gaps: default evidence output collided with the engine's own
// "worktree must be clean" gate, and the chain proved proofs were internally
// consistent without ever re-deriving them from a genuine restore rehearsal
// tool. This section proves both are closed, plus that the new raw-result
// wiring (Production and owner-go re-validating restore-run-result.json and
// staging-run-result.json, not just the proofs built from them) actually
// works, for real, against this repository's own git state.
// ============================================================================

const restoreRigSrc = () => readFileSync(RESTORE_RIG, 'utf8');

function gitStatusPorcelain(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
}

function spawnSyncGit(args: string[]): { status: number | null; out: string } {
  const res = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

describe('evidence files never dirty the worktree gate', () => {
  it('the default evidence and filled-target paths are git-ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-worktree-gate-'));
    const evidenceDir = join(REPO, 'ops', 'evidence');
    const targetsDir = join(REPO, 'ops', 'targets');
    const created: string[] = [];
    try {
      const before = gitStatusPorcelain();

      for (const name of [
        'restore-proof.json', 'staging-rehearsal-proof.json', 'owner-go.json',
        'restore-run-result.json', 'staging-run-result.json', 'some-report.log', 'a-backup.dump',
        'restore-run-result.json.tmp', 'staging-run-result.json.tmp',
      ]) {
        const p = join(evidenceDir, name);
        writeFileSync(p, '{"marker":"phoenix-worktree-gate-test"}');
        created.push(p);
      }
      for (const name of ['staging.json', 'rehearsal-clone.json']) {
        const p = join(targetsDir, name);
        writeFileSync(p, '{"marker":"phoenix-worktree-gate-test"}');
        created.push(p);
      }

      const after = gitStatusPorcelain();
      expect(after, 'evidence and filled-target files must not appear in git status').toBe(before);
    } finally {
      for (const p of created) rmSync(p, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a genuine new file (a real change) still shows up as dirty', () => {
    // Proves the gate is not simply broken -- ignoring evidence output does
    // not mean the worktree-dirty check stopped working for real changes.
    const marker = join(OPS, 'phoenix-worktree-gate-marker.tmp');
    try {
      const before = gitStatusPorcelain();
      expect(before).not.toContain('phoenix-worktree-gate-marker');

      writeFileSync(marker, 'not ignored -- a real, trackable change');
      const after = gitStatusPorcelain();
      expect(after).toContain('phoenix-worktree-gate-marker.tmp');
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it('ops/evidence/README.md and the manifest examples stay committed, not ignored', () => {
    // git check-ignore exits 1 for a path that is NOT ignored (and 0, with
    // the matching pattern printed, for one that is).
    for (const path of [
      'ops/evidence/README.md', 'ops/targets/production.json',
      'ops/targets/staging.example.json', 'ops/targets/rehearsal-clone.example.json',
    ]) {
      const res = spawnSyncGit(['check-ignore', '-v', path]);
      expect(res.status, `${path} must not be gitignored (matched: ${res.out.trim()})`).toBe(1);
    }
  });

  it('ops/evidence/*.json, ops/targets/staging.json and rehearsal-clone.json ARE ignored', () => {
    for (const path of [
      'ops/evidence/restore-proof.json', 'ops/evidence/staging-run-result.json',
      'ops/targets/staging.json', 'ops/targets/rehearsal-clone.json',
    ]) {
      const res = spawnSyncGit(['check-ignore', path]);
      expect(res.status, `${path} should be gitignored`).toBe(0);
    }
  });

  it('ops/evidence/*.json.tmp is ignored too -- the tmp-then-atomic-rename artifacts never dirty the gate either', () => {
    for (const path of ['ops/evidence/restore-run-result.json.tmp', 'ops/evidence/staging-run-result.json.tmp']) {
      const res = spawnSyncGit(['check-ignore', path]);
      expect(res.status, `${path} should be gitignored`).toBe(0);
    }
  });
});

describe('ops/run-pg17-restore-rehearsal.ps1: the one tool that writes restore-run-result.json', () => {
  it('accepts only backup path, clone manifest and output directory -- no booleans, exit codes or versions', () => {
    const src = restoreRigSrc();
    // The param(...) block contains nested parens (e.g. "[Parameter(Mandatory
    // = $true)]"), so the matching close paren must be found by depth, not
    // by the first ")" (which lands mid-attribute).
    const paramBlockStart = src.indexOf('param(');
    let depth = 0;
    let paramBlockEnd = -1;
    for (let i = paramBlockStart + 'param('.length - 1; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { paramBlockEnd = i; break; } }
    }
    expect(paramBlockEnd, 'param() block must close').toBeGreaterThan(-1);
    const paramBlock = src.slice(paramBlockStart, paramBlockEnd);
    expect(paramBlock).toMatch(/\[string\]\$BackupPath/);
    expect(paramBlock).toMatch(/\[string\]\$CloneTargetManifest/);
    expect(paramBlock).toMatch(/\[string\]\$OutputDirectory/);
    // No parameter for any of the facts the script must derive itself.
    for (const forbidden of [
      '$RestoreExitCode', '$RestoredDatabaseProbePassed', '$MigrationCeiling', '$KeeperVerified',
      '$Rbac130415Verified', '$DeliberateRollbackPassed', '$ReconciliationPassed', '$ClonePgMajor',
      '$ServerVersion', '$CloneServerVersion',
    ]) {
      expect(paramBlock, `${forbidden} must not be a parameter`).not.toContain(forbidden);
    }
    // Exactly three parameters total (matching "[string]$Name" declarations,
    // not incidental "$true" inside the [Parameter(...)] attributes).
    const paramNames = paramBlock.match(/\[string\]\$(\w+)/g) ?? [];
    expect(new Set(paramNames).size).toBe(3);
  });

  it('only commits restore-run-result.json to its final name after every check, atomically', () => {
    const src = restoreRigSrc();
    const commitIdx = src.indexOf('Move-Item -Path $RestoreResultTmpPath -Destination $RestoreResultPath');
    const ceilingCheck = src.indexOf("if ($ceiling -ne 147)");
    const keeperCheck = src.indexOf('STOP_KEEPER_ACCOUNT_UNVERIFIED');
    const rbacCheck = src.indexOf('RBAC drift');
    const rollbackCheck = src.indexOf('the deliberate rollback test did not fail as expected');
    const triggerCompare = src.indexOf('trigger definitions changed across the rollback test');
    const reconciliationCheck = src.indexOf('unvalidated FK constraint');
    const selfValidate = src.indexOf('Test-RestoreRunReport $roundTripped');
    expect(commitIdx).toBeGreaterThan(-1);
    for (const [name, idx] of [
      ['ceiling', ceilingCheck], ['keeper', keeperCheck], ['rbac', rbacCheck],
      ['rollback', rollbackCheck], ['trigger comparison', triggerCompare], ['reconciliation', reconciliationCheck],
      ['self-validation', selfValidate],
    ] as const) {
      expect(idx, `${name} check must exist`).toBeGreaterThan(-1);
      expect(idx, `${name} check must precede the atomic commit to the final name`).toBeLessThan(commitIdx);
    }
  });

  it('a pg_restore failure stops before any tmp or final report is written', () => {
    const src = restoreRigSrc();
    const restoreCall = src.indexOf('& $script:PgRestoreExe');
    const exitCheck = src.indexOf('if ($restoreExitCode -ne 0)');
    const tmpWriteIdx = src.indexOf('Set-Content -Path $RestoreResultTmpPath -Encoding utf8');
    const commitIdx = src.indexOf('Move-Item -Path $RestoreResultTmpPath -Destination $RestoreResultPath');
    expect(restoreCall).toBeGreaterThan(-1);
    expect(exitCheck).toBeGreaterThan(restoreCall);
    expect(exitCheck).toBeLessThan(tmpWriteIdx);
    expect(exitCheck).toBeLessThan(commitIdx);
    expect(src.slice(exitCheck, exitCheck + 200)).toMatch(/Fail "pg_restore failed/);
    // The whole flow is one try{} block; a Fail anywhere throws out of it,
    // so the tmp write (near the end of the block) is never reached.
    const tryStart = src.indexOf('try {');
    const catchStart = src.indexOf('catch {');
    expect(tryStart).toBeGreaterThan(-1);
    expect(tmpWriteIdx).toBeGreaterThan(tryStart);
    expect(tmpWriteIdx).toBeLessThan(catchStart);
    // And the catch block itself removes any evidence the failed attempt
    // left behind, so a Fail AFTER the tmp write (e.g. self-validation)
    // still leaves nothing on disk.
    const finallyStart = src.indexOf('finally {');
    const catchBody = src.slice(catchStart, finallyStart);
    expect(catchBody).toContain('$RestoreResultPath');
    expect(catchBody).toContain('$RestoreResultTmpPath');
    expect(catchBody).toMatch(/Remove-Item \$stale -Force -ErrorAction SilentlyContinue/);
  });

  it('the restore rig only ever touches a loopback, disposable, PG17 clone', () => {
    const src = restoreRigSrc();
    expect(src).toMatch(/environment -ne 'rehearsal_clone'/);
    expect(src).toMatch(/pooler_host -notin @\('127\.0\.0\.1', 'localhost', '::1'\)/);
    expect(src).toMatch(/ssl_mode -ne 'disable'/);
    expect(src).toMatch(/required_pg_major -ne 17/);
    expect(src).toMatch(/DROP DATABASE IF EXISTS/);
  });
});

describe('raw evidence re-verification -- tamper and deletion detection', () => {
  it('Production and owner-go both require the raw restore and staging results, re-validate them, and cross-check their hashes against the proofs', () => {
    const chain = evidenceChainSrc();
    expect(chain).toMatch(/\[string\]\$RestoreRunResultPath,\s*\n\s*\[string\]\$StagingRunResultPath/);
    // Existence is required for both raw files, in the same loop as the proofs.
    expect(chain).toMatch(/'restore run result \(raw\)'; Path = \$RestoreRunResultPath/);
    expect(chain).toMatch(/'staging run result \(raw\)'; Path = \$StagingRunResultPath/);
    // Re-validated with the exact same functions the generators use.
    expect(chain).toMatch(/Test-RestoreRunReport \$rawRestore/);
    expect(chain).toMatch(/Test-StagingRunResult \$rawStaging/);
    // The proof must reference the CURRENT hash of the raw file, not a
    // remembered one -- so editing the raw file after the proof exists
    // invalidates the proof.
    expect(chain).toMatch(/\$rawRestoreSha = Get-FileSha256 \$RestoreRunResultPath/);
    expect(chain).toMatch(/\$restore\.restore_run_report_sha256 -ne \$rawRestoreSha/);
    expect(chain).toMatch(/\$rawStagingSha = Get-FileSha256 \$StagingRunResultPath/);
    expect(chain).toMatch(/\$staging\.staging_run_result_sha256 -ne \$rawStagingSha/);
    // Cross-checks: backup, head, server version, and both tool identities.
    expect(chain).toMatch(/\$rawRestore\.backup_sha256 -ne \$restore\.backup_sha256/);
    expect(chain).toMatch(/\$rawStaging\.backup_sha256 -ne \$staging\.backup_sha256/);
    expect(chain).toMatch(/\$rawStaging\.head_sha -ne \$staging\.tested_head_sha/);
    expect(chain).toMatch(/\$rawStaging\.server_version -ne \$staging\.staging_pg_version/);
    expect(chain).toMatch(/\$rawStaging\.psql_path -ne \$staging\.psql_executable_path/);
    expect(chain).toMatch(/\$rawStaging\.pg_dump_path -ne \$staging\.pg_dump_executable_path/);
  });

  it('both the Production engine and owner-go pass the raw result paths into the same call', () => {
    expect(coreSrc()).toMatch(/-RestoreRunResultPath \$restoreRunResultPath -StagingRunResultPath \$stagingRunResultPath/);
    expect(ownerGoSrc()).toMatch(/-RestoreRunResultPath \$RestoreRunResultPath -StagingRunResultPath \$StagingRunResultPath/);
  });

  it('deleting a raw result file is indistinguishable from never having supplied it -- both fail before credentials', () => {
    // The existence check for both raw paths lives in the SAME foreach loop
    // as the proof and manifest paths that were already proven (in the
    // "authorization is checked before the password prompt" test) to run
    // before Read-Host. Confirm the raw-result checks are in that same loop,
    // not a separate later gate that could be reordered independently.
    const chain = evidenceChainSrc();
    // Anchor on the restore-proof entry, which only appears in the
    // path-existence loop inside Test-RestoreAndStagingEvidence (unlike
    // "foreach ($pair in @(", which also opens the unrelated tool-binary
    // loop in Test-ToolBinaryMatchesProof, defined earlier in the file).
    const anchor = chain.indexOf("'restore proof'; Path = $RestoreProofPath");
    expect(anchor, 'the restore proof path-existence entry must exist').toBeGreaterThan(-1);
    const loopStart = chain.lastIndexOf('foreach (', anchor);
    const loopEnd = chain.indexOf('))', anchor);
    const loopBody = chain.slice(loopStart, loopEnd);
    expect(loopBody).toContain('$RestoreProofPath');
    expect(loopBody).toContain('$StagingProofPath');
    expect(loopBody).toContain('$RestoreRunResultPath');
    expect(loopBody).toContain('$StagingRunResultPath');
  });
});

// ============================================================================
// R0: STALE EVIDENCE AND LOCAL CLONE SAFETY
//
// Two closing gaps, both purely local: (1) a failed restore or staging
// attempt could leave a PREVIOUS successful run's result file on disk,
// indistinguishable from a genuine SUCCESS for this attempt, and (2) the one
// script that runs DROP DATABASE -- against a local, disposable clone by
// design -- had no defence of its own if a manifest were ever malformed or
// substituted: no live server-major check, no name-format check, no
// injection guard, no operator confirmation naming the exact database. Both
// gaps are closed with zero real database access: PowerShell parses cleanly
// under the real parser (already proven above), and every DROP-safety check
// is proven either statically (source order/content) or, where it needs no
// database and no interactive prompt, by real, non-interactive execution
// against a manifest engineered to fail deterministically before ever
// reaching a live connection (this machine's/CI's PostgreSQL client tools
// are not major 17 -- Resolve-Pg17RestoreTools / Resolve-PgClientTools stops
// the run before Assert-CloneDropSafety could ever open a socket).
// ============================================================================

describe('ops/run-pg17-restore-rehearsal.ps1: stale restore-run-result.json is never left behind', () => {
  it('deletes stale final and tmp restore-run-result.json before the attempt does anything else', () => {
    const src = restoreRigSrc();
    const staleBlock = src.indexOf('removed stale evidence before attempt');
    const resolveTools = src.indexOf('function Resolve-Pg17RestoreTools');
    const tryStart = src.indexOf('try {');
    expect(staleBlock).toBeGreaterThan(-1);
    expect(staleBlock).toBeLessThan(resolveTools);
    expect(staleBlock).toBeLessThan(tryStart);
    expect(src).toMatch(/\$RestoreResultPath = Join-Path \$OutputDirectory 'restore-run-result\.json'/);
    expect(src).toMatch(/\$RestoreResultTmpPath = "\$RestoreResultPath\.tmp"/);
    expect(src).toMatch(/foreach \(\$stale in @\(\$RestoreResultPath, \$RestoreResultTmpPath\)\)/);
  });

  it.runIf(canRun)('really deletes a stale final and tmp result before doing anything else, for a real (non-interactive) run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-restore-stale-'));
    try {
      const backup = join(dir, 'backup.dump');
      writeFileSync(backup, 'x'.repeat(2048));
      const manifest = join(dir, 'clone-manifest.json');
      writeFileSync(manifest, JSON.stringify({
        environment: 'rehearsal_clone',
        pooler_host: '127.0.0.1',
        port: 19187,
        database_name: 'phoenix_rehearsal_stale_test',
        database_user: 'postgres',
        keeper_email: 'abdallahjawad2015@gmail.com',
        ssl_mode: 'disable',
        required_pg_major: 17,
      }));
      const finalPath = join(dir, 'restore-run-result.json');
      const tmpPath = join(dir, 'restore-run-result.json.tmp');
      writeFileSync(finalPath, JSON.stringify({ marker: 'stale-from-previous-run', restore_exit_code: 0 }));
      writeFileSync(tmpPath, '{"marker":"stale-tmp"}');

      const { status, out } = runPs(RESTORE_RIG, [
        '-BackupPath', backup,
        '-CloneTargetManifest', manifest,
        '-OutputDirectory', dir,
      ]);

      // Expected to stop at client-tool resolution (or, if PG17 tools ever
      // are present, at the next real gate) -- never a genuine restore, and
      // never a connection to anything but loopback. What is proven here is
      // narrower and unconditional: it did not report success, and the
      // stale evidence from a previous attempt is gone.
      expect(status, out).not.toBe(0);
      expect(existsSync(finalPath), 'stale final must be removed before the attempt proceeds').toBe(false);
      expect(existsSync(tmpPath), 'stale tmp must be removed before the attempt proceeds').toBe(false);
      expect(out).toContain('removed stale evidence before attempt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('only commits restore-run-result.json to its final name after every check, atomically', () => {
    // Duplicate of the assertion in the "one tool" describe block above,
    // kept here too as the canonical home for the R0 stale-evidence
    // contract's "atomic tmp-to-final only on success" requirement.
    const src = restoreRigSrc();
    const tmpWrite = src.indexOf('Set-Content -Path $RestoreResultTmpPath -Encoding utf8');
    const selfValidate = src.indexOf('Test-RestoreRunReport $roundTripped');
    const commit = src.indexOf('Move-Item -Path $RestoreResultTmpPath -Destination $RestoreResultPath');
    expect(tmpWrite).toBeGreaterThan(-1);
    expect(selfValidate).toBeGreaterThan(tmpWrite);
    expect(commit).toBeGreaterThan(selfValidate);
  });

  it('the catch block removes both the final and tmp path for this attempt on any failure', () => {
    const src = restoreRigSrc();
    const catchStart = src.indexOf('catch {');
    const finallyStart = src.indexOf('finally {');
    const catchBody = src.slice(catchStart, finallyStart);
    expect(catchBody).toContain('$RestoreResultPath');
    expect(catchBody).toContain('$RestoreResultTmpPath');
    expect(catchBody).toMatch(/Remove-Item \$stale -Force -ErrorAction SilentlyContinue/);
  });
});

describe('ops/run-prelaunch-release-core.ps1: stale staging-run-result.json is never left behind', () => {
  it("deletes stale final and tmp staging-run-result.json at the very start of a staging attempt, before any gate", () => {
    const src = coreSrc();
    const staleBlock = src.indexOf('removed stale evidence before attempt');
    const section0 = src.indexOf('Section "0. TARGET:');
    const worktree = src.indexOf("Section '2. WORKTREE'");
    expect(staleBlock).toBeGreaterThan(-1);
    expect(staleBlock).toBeLessThan(section0);
    expect(staleBlock).toBeLessThan(worktree);
    expect(src).toMatch(/if \(\$M\.environment -eq 'staging'\)/);
    expect(src).toMatch(/\$stagingResultFixedPath = Join-Path \$RepoRoot 'ops\\evidence\\staging-run-result\.json'/);
  });

  it.runIf(canRun)('really deletes a stale final and tmp staging result before doing anything else, for a real (non-interactive) run', () => {
    const evidenceDir = join(OPS, 'evidence');
    const finalPath = join(evidenceDir, 'staging-run-result.json');
    const tmpPath = join(evidenceDir, 'staging-run-result.json.tmp');
    writeFileSync(finalPath, JSON.stringify({ marker: 'stale-from-previous-run', result: 'SUCCESS' }));
    writeFileSync(tmpPath, '{"marker":"stale-tmp"}');
    try {
      const manifest = join(TARGETS, 'staging.example.json');
      const { status, out } = runPs(CORE, ['-TargetManifest', manifest]);
      // The run is expected to stop somewhere in the pre-credential gates
      // (dirty worktree, unsupported client tool major, or missing CA) --
      // never reaching a database. What matters here is unconditional: it
      // did not report success, and the stale evidence is gone.
      expect(status, out).not.toBe(0);
      expect(existsSync(finalPath), 'stale final must be removed before the attempt proceeds').toBe(false);
      expect(existsSync(tmpPath), 'stale tmp must be removed before the attempt proceeds').toBe(false);
      expect(out).toContain('removed stale evidence before attempt');
    } finally {
      rmSync(finalPath, { force: true });
      rmSync(tmpPath, { force: true });
    }
  }, 30_000);

  it('New-StagingRunResult writes to .tmp, self-validates, then commits atomically only after validation passes', () => {
    const src = coreSrc();
    const start = src.indexOf('function New-StagingRunResult');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    const tmpWrite = body.indexOf('Set-Content -Path $tmpPath -Encoding utf8');
    const selfValidate = body.indexOf('Test-StagingRunResult $roundTripped');
    const commit = body.indexOf('Move-Item -Path $tmpPath -Destination $outPath -Force');
    expect(tmpWrite).toBeGreaterThan(-1);
    expect(selfValidate).toBeGreaterThan(tmpWrite);
    expect(commit).toBeGreaterThan(selfValidate);
  });

  it('the outer catch block removes any staging evidence left behind by a failed attempt', () => {
    const src = coreSrc();
    // '\ncatch {' / '\nfinally {' (not the inline try/catch inside
    // Read-TargetManifest's JSON parse, or the inline try/finally around
    // Push-Location) anchor the OUTER main block -- both inline forms are
    // preceded by a space ("} catch {" / "} finally {"), never a newline.
    const catchStart = src.indexOf('\ncatch {');
    const finallyStart = src.indexOf('\nfinally {');
    expect(catchStart).toBeGreaterThan(-1);
    expect(finallyStart).toBeGreaterThan(catchStart);
    const catchBody = src.slice(catchStart, finallyStart);
    expect(catchBody).toMatch(/\$M\.environment -eq 'staging'/);
    expect(catchBody).toContain("Join-Path $RepoRoot 'ops\\evidence\\staging-run-result.json'");
    expect(catchBody).toMatch(/Remove-Item \$stale -Force -ErrorAction SilentlyContinue/);
  });
});

describe('ops/run-pg17-restore-rehearsal.ps1: local clone DROP DATABASE safety guard', () => {
  it('only accepts database_name matching ^phoenix_rehearsal_[a-z0-9_]+$, rejecting everything else', () => {
    const src = restoreRigSrc();
    const match = src.match(/name -notmatch '(\^phoenix_rehearsal_\[[^']+)'/);
    expect(match, 'the database_name regex must be present in source').toBeTruthy();
    const re = new RegExp(match![1]);
    expect(re.test('phoenix_rehearsal_abc123')).toBe(true);
    expect(re.test('phoenix_rehearsal_a')).toBe(true);
    expect(re.test('phoenix_rehearsal_')).toBe(false);
    expect(re.test('phoenix_prod')).toBe(false);
    expect(re.test('postgres')).toBe(false);
    expect(re.test('phoenix_rehearsal_abc; DROP TABLE x;')).toBe(false);
    expect(re.test("phoenix_rehearsal_abc'")).toBe(false);
    expect(re.test('PHOENIX_REHEARSAL_ABC')).toBe(false);

    const nameCheck = src.indexOf("name -notmatch '^phoenix_rehearsal_");
    const dropCall = src.indexOf('DROP DATABASE IF EXISTS $quotedDbName');
    expect(nameCheck).toBeGreaterThan(-1);
    expect(dropCall).toBeGreaterThan(-1);
    expect(nameCheck).toBeLessThan(dropCall);
  });

  it('rejects postgres/template0/template1 by exact name, before any DROP statement', () => {
    const src = restoreRigSrc();
    expect(src).toContain(`$name -in @('postgres', 'template0', 'template1')`);
    const protectedCheck = src.indexOf(`-in @('postgres', 'template0', 'template1')`);
    const dropCall = src.indexOf('DROP DATABASE IF EXISTS $quotedDbName');
    expect(protectedCheck).toBeGreaterThan(-1);
    expect(protectedCheck).toBeLessThan(dropCall);
  });

  it('rejects database names containing whitespace, quotes, semicolons or SQL comment syntax, before any DROP', () => {
    const src = restoreRigSrc();
    // Mirrors the character class in Assert-CloneDropSafety exactly --
    // $name -match '[\s''";]' in PowerShell is the char class [\s'";] (a
    // doubled '' inside a single-quoted PS string is one literal quote).
    expect(src).toContain(`$name -match '[\\s''";]'`);
    const injectionCharClass = /[\s'";]/;
    for (const bad of ['has space', "quote'name", 'double"quote', 'semi;colon', 'tab\tname']) {
      expect(injectionCharClass.test(bad), `${bad} must be rejected`).toBe(true);
    }
    expect(injectionCharClass.test('phoenix_rehearsal_clean_name')).toBe(false);
    expect(src).toContain(`.Contains('--')`);
    expect(src).toContain(`.Contains('/*')`);
    expect(src).toContain(`.Contains('*/')`);

    const charGuard = src.indexOf('database_name contains a disallowed character');
    const dropCall = src.indexOf('DROP DATABASE IF EXISTS $quotedDbName');
    expect(charGuard).toBeGreaterThan(-1);
    expect(charGuard).toBeLessThan(dropCall);
  });

  it('queries the maintenance server live and refuses a non-PG17 server before any DROP', () => {
    const src = restoreRigSrc();
    const majorQuery = src.indexOf(`ScalarOn $maintConn "SELECT split_part(current_setting('server_version'),'.',1);"`);
    const majorCheck = src.indexOf('$maintMajor -ne 17');
    const dropCall = src.indexOf('DROP DATABASE IF EXISTS $quotedDbName');
    expect(majorQuery, 'the live server-major query must exist').toBeGreaterThan(-1);
    expect(majorCheck).toBeGreaterThan(majorQuery);
    expect(majorCheck).toBeLessThan(dropCall);
    expect(src.slice(majorCheck, majorCheck + 150)).toMatch(/Fail "STOP_CLONE_GUARD/);
  });

  it('requires the operator to type RESET LOCAL PG17 CLONE <database_name>, never auto-answered, before any DROP', () => {
    const src = restoreRigSrc();
    expect(src).toMatch(/\$expectedPhrase = "RESET LOCAL PG17 CLONE \$name"/);
    expect(src).toMatch(/if \(\$typed -ne \$expectedPhrase\) \{ Fail 'STOP_CLONE_GUARD -- clone reset not confirmed by operator' \}/);
    expect(src).not.toMatch(/\$typed\s*=\s*\$expectedPhrase/);
    const promptIdx = src.indexOf('Read-Host "Type EXACTLY  $expectedPhrase  to proceed"');
    const dropCall = src.indexOf('DROP DATABASE IF EXISTS $quotedDbName');
    expect(promptIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeLessThan(dropCall);
  });

  it('Assert-CloneDropSafety runs entirely before terminate/DROP/CREATE, and every destructive statement uses a safely quoted identifier', () => {
    const src = restoreRigSrc();
    const guardCall = src.indexOf('Assert-CloneDropSafety $M $MaintConn');
    const terminateCall = src.indexOf('pg_terminate_backend');
    const dropCall = src.indexOf('DROP DATABASE IF EXISTS $quotedDbName');
    const createCall = src.indexOf('CREATE DATABASE $quotedDbName');
    expect(guardCall).toBeGreaterThan(-1);
    expect(guardCall).toBeLessThan(terminateCall);
    expect(terminateCall).toBeLessThan(dropCall);
    expect(dropCall).toBeLessThan(createCall);
    expect(src).toMatch(/function Get-SafePgIdentifier/);
    expect(src).toMatch(/return '"' \+ \(\$name -replace '"', '""'\) \+ '"'/);
  });

  it('re-validates host loopback and ssl_mode=disable again immediately before the drop, not only at manifest load', () => {
    const src = restoreRigSrc();
    const start = src.indexOf('function Assert-CloneDropSafety');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/pooler_host -notin @\('127\.0\.0\.1', 'localhost', '::1'\)/);
    expect(body).toMatch(/ssl_mode -ne 'disable'/);
  });

  it('the clone-reset code path never touches a credential, and the raw result writers never carry one either', () => {
    const restoreSrc = restoreRigSrc();
    const coreSource = coreSrc();

    const guardStart = restoreSrc.indexOf('function Assert-CloneDropSafety');
    const guardEnd = restoreSrc.indexOf('\n}', guardStart);
    const guardBody = restoreSrc.slice(guardStart, guardEnd);
    expect(guardBody).not.toMatch(/PGPASSWORD|password|AsSecureString/i);

    const newResultStart = coreSource.indexOf('function New-StagingRunResult');
    const newResultEnd = coreSource.indexOf('\n}', newResultStart);
    const newResultBody = coreSource.slice(newResultStart, newResultEnd);
    expect(newResultBody).not.toMatch(/PGPASSWORD|password|service_role_key|access_token/i);
  });
});
