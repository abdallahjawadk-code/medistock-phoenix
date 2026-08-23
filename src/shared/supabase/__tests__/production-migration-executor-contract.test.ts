/**
 * PINNED PRODUCTION MIGRATION EXECUTOR — workflow contract.
 *
 * Stage I / I-2. The behavioural refusals live in
 * tools/phoenix-demo/__tests__/production-migration-contract.test.ts; this file
 * guards the WORKFLOW's shape — the part no unit test can reach — so the
 * executor cannot be quietly loosened into the unbounded `supabase db push`
 * this repository deliberately does not have.
 *
 * It also re-asserts that the three historical pinned workflows were NOT
 * weakened to make the new one possible: they remain exactly as narrow as they
 * were, and remain the historical evidence of what was applied and how.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const WORKFLOW = read('.github/workflows/apply-production-migration.yml');
const PREFLIGHT = read('tools/phoenix-demo/production-migration-preflight.mjs');
const CONTRACT = read('tools/phoenix-demo/production-migration-contract.mjs');
const DRY_RUN_PROOF = read('tools/phoenix-demo/assert-single-pending-dry-run.mjs');
const VERIFY_APPLIED = read('tools/phoenix-demo/verify-production-migration-applied.mjs');
const VERIFY_AUTHZ = read('tools/phoenix-demo/verify-production-authorization-invariants.mjs');

const ALL_SCRIPTS = { PREFLIGHT, CONTRACT, DRY_RUN_PROOF, VERIFY_APPLIED, VERIFY_AUTHZ };

describe('Production migration executor — dispatch envelope', () => {
  it('is manual-only: no push, pull_request or schedule trigger can ever start it', () => {
    expect(WORKFLOW).toMatch(/\bon:\s*\n\s+workflow_dispatch:/);
    expect(WORKFLOW).not.toMatch(/\n\s+(?:push|pull_request|schedule|repository_dispatch|workflow_call):/);
  });

  it('runs only from master, only at the operator-confirmed commit, only with the exact phrase', () => {
    expect(WORKFLOW).toContain('"${{ github.ref_name }}" != "master"');
    expect(WORKFLOW).toContain('"${{ github.sha }}" != "${{ inputs.confirm_sha }}"');
    expect(WORKFLOW).toContain('"${{ inputs.confirmation }}" != "APPLY_PRODUCTION_MIGRATION"');
    // The authorization gate is the FIRST step, before checkout or install.
    const authIdx = WORKFLOW.indexOf('Verify explicit Production authorization');
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(WORKFLOW.indexOf('Check out repository'));
  });

  it('is locked to the one Production project and takes the GitHub Production environment approval', () => {
    expect(WORKFLOW).toContain('PROJECT_REF: eyrzxgfkvqybjdgyphap');
    expect(WORKFLOW).toContain('environment: production');
    expect(WORKFLOW).toContain('permissions:\n  contents: read');
  });

  it('serializes concurrent runs and never cancels one that may be mid-apply', () => {
    expect(WORKFLOW).toContain('group: production-migration-apply');
    expect(WORKFLOW).toContain('cancel-in-progress: false');
  });

  it('accepts exactly seven pinned inputs — no SQL, no script path, no project ref, no range', () => {
    const inputsBlock = WORKFLOW.slice(WORKFLOW.indexOf('    inputs:'), WORKFLOW.indexOf('permissions:'));
    const declared = [...inputsBlock.matchAll(/^ {6}([a-z0-9_]+):$/gm)].map((m) => m[1]).sort();
    // remote_history_version is the 14-digit Supabase history version this
    // migration will be recorded under. It is PINNED per invocation, never
    // derived at run time, because Production's history namespace is not this
    // repository's canonical numbering.
    expect(declared).toEqual([
      'confirm_sha',
      'confirmation',
      'expected_current_ceiling',
      'expected_next_ceiling',
      'migration_filename',
      'migration_sha256',
      'remote_history_version',
    ]);
    // Nothing that could smuggle in arbitrary work.
    for (const forbidden of ['sql', 'script', 'project_ref', 'range', 'from_version', 'to_version', 'force', 'skip']) {
      expect(declared).not.toContain(forbidden);
    }
  });
});

describe('Production migration executor — the single-pending proof', () => {
  it('proves exactly one pending migration BEFORE any push, from the database and the directory', () => {
    const preflightIdx = WORKFLOW.indexOf('Preflight — prove exactly one pending migration');
    const dryRunIdx = WORKFLOW.indexOf('Preview the push (read-only dry-run)');
    const applyIdx = WORKFLOW.indexOf('Apply the single pending migration');
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(dryRunIdx);
    expect(dryRunIdx).toBeLessThan(applyIdx);
    expect(WORKFLOW).toContain('tools/phoenix-demo/production-migration-preflight.mjs');
    expect(WORKFLOW).toContain('id: preflight');
  });

  it('re-proves it a second time from the CLI\'s own dry-run transcript, before the real push', () => {
    const proofIdx = WORKFLOW.indexOf('Second single-pending proof');
    const applyIdx = WORKFLOW.indexOf('Apply the single pending migration');
    expect(proofIdx).toBeGreaterThan(-1);
    expect(proofIdx).toBeLessThan(applyIdx);
    expect(WORKFLOW).toContain('tools/phoenix-demo/assert-single-pending-dry-run.mjs');
  });

  it('gates the dry-run and the apply on the decision the PREFLIGHT produced, not on an operator claim', () => {
    for (const step of ['Preview the push (read-only dry-run)', 'Second single-pending proof', 'Apply the single pending migration']) {
      const idx = WORKFLOW.indexOf(step);
      expect(idx, `${step} missing`).toBeGreaterThan(-1);
      expect(WORKFLOW.slice(idx, idx + 220)).toContain("if: steps.preflight.outputs.decision == 'APPLY'");
    }
  });

  it('issues exactly three db-push commands — two read-only dry-runs and one apply — and never a sweep', () => {
    // Only real command lines, never the header prose that explains why
    // `supabase db push` is bounded the way it is.
    const pushes = WORKFLOW.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('supabase db push') || l.startsWith('run: supabase db push'))
      .map((l) => l.replace(/^run: /, ''));
    // Both run from the SHADOW workspace via --workdir, never from the
    // canonical migrations directory — pointed there, the CLI would compute a
    // pending set of every migration from 173 onward, because local `173` does
    // not match remote `20260810200846`.
    // The third is the post-apply proof: unconditional, read-only, and
    // expected to report ZERO pending on both the APPLY and the resume-safe
    // ALREADY_APPLIED paths.
    expect(pushes).toEqual([
      'supabase db push --yes --dry-run --db-url "$PHOENIX_PRODUCTION_DATABASE_URL" --workdir "${{ steps.preflight.outputs.shadow_workspace }}" 2>&1 | tee /tmp/db-push-dry-run.txt',
      'supabase db push --yes --db-url "$PHOENIX_PRODUCTION_DATABASE_URL" --workdir "${{ steps.preflight.outputs.shadow_workspace }}"',
      'supabase db push --yes --dry-run --db-url "$PHOENIX_PRODUCTION_DATABASE_URL" --workdir "${{ steps.preflight.outputs.shadow_workspace }}" 2>&1 | tee /tmp/db-push-post-apply.txt',
    ]);
    // Exactly ONE of the three mutates Production: the apply. The other two
    // carry --dry-run.
    expect(pushes.filter((c) => !c.includes('--dry-run'))).toHaveLength(1);
    const wf = WORKFLOW;
    expect((wf.match(/--workdir "\$\{\{ steps\.preflight\.outputs\.shadow_workspace \}\}"/g) ?? []))
      .toHaveLength(3);
    // No COMMAND may pass --debug. The word appears in a comment explaining
    // why (releases 2.101.0-2.109.1 disabled TLS under --debug), so the check
    // is against command lines rather than the whole file.
    for (const cmd of pushes) expect(cmd).not.toContain('--debug');
    const commandLines = wf.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l.startsWith('supabase ') || l.startsWith('run: supabase '));
    for (const l of commandLines) expect(l).not.toContain('--debug');
    // Checked against the COMMAND lines, not the prose: the header comment
    // legitimately names --include-all as something this executor refuses.
    for (const cmd of pushes) {
      expect(cmd).not.toContain('--include-all');
      expect(cmd).not.toContain('--linked');
    }
    expect(WORKFLOW).not.toMatch(/run:.*supabase db (?:reset|dump|remote)/);
  });

  it('never seeds, purges, resets, or deploys anything', () => {
    expect(WORKFLOW).not.toContain('supabase functions deploy');
    expect(WORKFLOW).not.toMatch(/phoenix_demo_purge|seed-prod|seed\.mjs|\bdb reset\b/);
  });
});

describe('Production migration executor — post-apply verification cannot be skipped', () => {
  it('verifies the migration history on a fresh connection AFTER the push, unconditionally', () => {
    const applyIdx = WORKFLOW.indexOf('Apply the single pending migration');
    const verifyIdx = WORKFLOW.indexOf('Verify Production migration history reached exactly the pinned ceiling');
    expect(verifyIdx).toBeGreaterThan(applyIdx);
    // Unconditional: must also run on the resume-safe ALREADY_APPLIED path.
    expect(WORKFLOW.slice(verifyIdx, verifyIdx + 320)).not.toContain('if: steps.preflight');
    expect(WORKFLOW).toContain('tools/phoenix-demo/verify-production-migration-applied.mjs');
  });

  it('re-measures the Major-H authorization invariants afterwards, unconditionally and from a fixed contract', () => {
    const verifyIdx = WORKFLOW.indexOf('Verify Production migration history reached exactly the pinned ceiling');
    const authzIdx = WORKFLOW.indexOf('Verify the Major-H authorization invariants still hold');
    expect(authzIdx).toBeGreaterThan(verifyIdx);
    expect(WORKFLOW.slice(authzIdx, authzIdx + 320)).not.toContain('if: steps.preflight');
    expect(WORKFLOW).toContain('tools/phoenix-demo/verify-production-authorization-invariants.mjs');

    // The contract is FIXED in the script, never selected by a dispatch input.
    expect(VERIFY_AUTHZ).toContain('phoenix_get_live_inter_institution_alerts_with_state(integer)');
    expect(VERIFY_AUTHZ).toContain('phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)');
    expect(VERIFY_AUTHZ).toContain('phoenix_refresh_inter_org_alert_lifecycle(integer)');
    expect(VERIFY_AUTHZ).toContain('prosecdef');
    expect(VERIFY_AUTHZ).toContain('distribution_points INSERT');
    expect(VERIFY_AUTHZ).toContain('organizations UPDATE');
    expect(VERIFY_AUTHZ).toContain("has_table_privilege($1, c.oid, pr.p)");
  });

  it('has no retry, force, or continue-on-error MECHANISM anywhere', () => {
    // The word "retry" does appear — only in prose and in the failure notice,
    // both of which forbid it. What must be absent is any actual mechanism.
    expect(WORKFLOW).not.toContain('continue-on-error');
    expect(WORKFLOW).not.toMatch(/uses:.*retry/i);
    expect(WORKFLOW).not.toMatch(/\|\|\s*true\b/);
    expect(WORKFLOW).not.toMatch(/for\s+\w+\s+in\s+\$\(seq/);
    expect(WORKFLOW).not.toMatch(/\buntil\b.*\bdo\b/);
    for (const [name, src] of Object.entries(ALL_SCRIPTS)) {
      expect(src, `${name} must not retry`).not.toMatch(/setTimeout\(|for\s*\(\s*let\s+attempt|\bretries\b/i);
    }
  });

  it('classifies a failure instead of repairing it', () => {
    const idx = WORKFLOW.indexOf('Classify an apply failure without retrying or repairing');
    expect(idx).toBeGreaterThan(-1);
    const block = WORKFLOW.slice(idx, idx + 900);
    expect(block).toContain('if: failure()');
    expect(block).toContain('FAILED_CLEAN');
    expect(block).toContain('FAILED_PARTIAL');
    expect(block).toContain('AMBIGUOUS');
    expect(block).toContain('exit 1');
  });

  it('is honest that a migration body and its history row are not provably one transaction', () => {
    expect(VERIFY_APPLIED).toContain('BEGIN; ... COMMIT;');
    expect(VERIFY_APPLIED).toMatch(/NOT\s*\n?\/\/ provably one atomic unit|not\s+provably one atomic unit/i);
    expect(VERIFY_APPLIED).toMatch(/fresh connection/i);
    expect(VERIFY_APPLIED).toContain('instead of trusting the');
    expect(WORKFLOW).toContain('TRANSACTION HONESTY');
  });
});

describe('Production migration executor — secret handling', () => {
  it('never echoes a secret and only ever reads the one Production connection secret', () => {
    expect(WORKFLOW).not.toMatch(/echo\s+"?\$\{\{\s*secrets\./);
    expect(WORKFLOW).not.toMatch(/echo\s+"?\$PHOENIX_PRODUCTION_DATABASE_URL/);
    const secretRefs = [...WORKFLOW.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect([...new Set(secretRefs)]).toEqual(['PHOENIX_PRODUCTION_DATABASE_URL']);
  });

  it('pins the project ref from the connection string without ever printing it', () => {
    expect(CONTRACT).toContain('assertProjectRefPinned');
    expect(CONTRACT).toContain('no secret material is shown');
    for (const [name, src] of Object.entries(ALL_SCRIPTS)) {
      expect(src, `${name} must not log the connection string`).not.toMatch(
        /console\.(?:log|error)\([^)]*PHOENIX_PRODUCTION_DATABASE_URL/,
      );
    }
  });
});

describe('the three historical pinned workflows were not weakened to make the executor possible', () => {
  const LIFECYCLE = read('.github/workflows/deploy-admin-user-lifecycle.yml');
  const CREATE_USER = read('.github/workflows/deploy-admin-create-user.yml');
  const DEMO_SEED = read('.github/workflows/production-demo-seed.yml');

  it('deploy-admin-user-lifecycle still knows only 146 -> 147', () => {
    expect(LIFECYCLE).toContain("LOCAL_MIGRATION_CEILING: '147'");
    expect(LIFECYCLE).toContain('!= "146"');
    expect(LIFECYCLE).toContain('!= "147"');
    expect(LIFECYCLE).not.toContain('--include-all');
  });

  it('deploy-admin-create-user stays PERMANENTLY DISABLED, unconditionally, at its first step', () => {
    expect(CREATE_USER).toContain("ACCEPTED_MIGRATION_CEILING: '146'");
    const refuseIdx = CREATE_USER.indexOf('- name: Refuse — this workflow is permanently deprecated');
    expect(refuseIdx).toBeGreaterThan(-1);
    // First step of the job, and unconditional: no `if:` may appear on it.
    const stepsIdx = CREATE_USER.indexOf('    steps:');
    expect(refuseIdx).toBeGreaterThan(stepsIdx);
    expect(CREATE_USER.slice(stepsIdx, refuseIdx)).not.toContain('- name:');
    expect(CREATE_USER.slice(refuseIdx, refuseIdx + 600)).toContain('exit 1');
    expect(CREATE_USER.slice(refuseIdx, refuseIdx + 600)).not.toContain('if:');
  });

  // production-demo-seed.yml's migrate_and_seed mode does contain an unbounded
  // `supabase db push`. It is UNREACHABLE against today's Production: its
  // preflight runs first in every mode and refuses when the applied ceiling
  // exceeds ACCEPTED_MIGRATION_CEILING, which is pinned at 146 while Production
  // is far beyond it. That refusal is what keeps the unbounded push inert, so
  // it is pinned here rather than left to convention.
  it('production-demo-seed stays fail-closed above its accepted ceiling, keeping its unbounded push unreachable', () => {
    const PREFLIGHT_SCRIPT = read('tools/phoenix-demo/prod-preflight.mjs');
    expect(DEMO_SEED).toContain("ACCEPTED_MIGRATION_CEILING: '146'");

    const preflightIdx = DEMO_SEED.indexOf('Preflight (read-only');
    const dryRunIdx = DEMO_SEED.indexOf('Migration preview (dry-run');
    const applyIdx = DEMO_SEED.indexOf('Apply accepted migrations to Production');
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(dryRunIdx);
    expect(preflightIdx).toBeLessThan(applyIdx);
    // Unconditional: the preflight has no mode gate, so it runs before every mode.
    expect(DEMO_SEED.slice(preflightIdx, applyIdx)).toContain('prod-preflight.mjs');

    expect(PREFLIGHT_SCRIPT).toContain('maxApplied > CEILING');
    expect(PREFLIGHT_SCRIPT).toContain('unexplained divergence, stop');
  });

  it('neither historical workflow ever gained an --include-all sweep', () => {
    for (const wf of [LIFECYCLE, CREATE_USER, DEMO_SEED]) {
      expect(wf).not.toContain('--include-all');
    }
  });
});
