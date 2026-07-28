import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOW = readFileSync(
  join(__dirname, '../../../../.github/workflows/deploy-admin-user-lifecycle.yml'),
  'utf8',
);
const CEILING_SCRIPT = readFileSync(
  join(__dirname, '../../../../tools/phoenix-demo/read-migration-ceiling.mjs'),
  'utf8',
);
const CONTRACT_SCRIPT = readFileSync(
  join(__dirname, '../../../../tools/phoenix-demo/verify-delete-history-guard-contract.mjs'),
  'utf8',
);

describe('admin-user-lifecycle / admin-recycle-user Production deployment contract', () => {
  it('is manual-only and locked to the exact Production project', () => {
    expect(WORKFLOW).toMatch(/\bon:\s*\n\s+workflow_dispatch:/);
    expect(WORKFLOW).not.toMatch(/\n\s+(?:push|pull_request|schedule):/);
    expect(WORKFLOW).toContain('PROJECT_REF: eyrzxgfkvqybjdgyphap');
    expect(WORKFLOW).toContain('"${{ github.ref_name }}" != "master"');
    expect(WORKFLOW).toContain('"${{ github.sha }}" != "${{ inputs.confirm_sha }}"');
  });

  it('requires explicit authorization and GitHub Production environment approval', () => {
    expect(WORKFLOW).toContain('environment: production');
    expect(WORKFLOW).toContain('DEPLOY_SECURE_USER_LIFECYCLE');
    expect(WORKFLOW).toContain('secrets.SUPABASE_ACCESS_TOKEN');
    expect(WORKFLOW).toContain('secrets.PHOENIX_PRODUCTION_DATABASE_URL');
  });

  // SECURE-USER-DELETE-HISTORY-GUARD-147: the hard-delete path now depends on
  // migration 147. Deploying the Edge Functions without it first would ship a
  // delete flow whose server-side phoenix_lifecycle_reserve has no
  // operational-history gate at all — so this workflow must apply migration
  // 147 (resume-safe) BEFORE either function deploy step, and refuse to
  // proceed at all if Production's migration state is anything other than the
  // two states it explicitly knows how to handle.
  describe('migration 147: applied conditionally, resume-safely, fail-closed otherwise', () => {
    it('verifies the local checkout is itself exactly at ceiling 147 before touching Production', () => {
      const idx = WORKFLOW.indexOf('Verify this checkout');
      expect(idx).toBeGreaterThan(-1);
      expect(WORKFLOW.slice(idx, idx + 400)).toContain("$LOCAL_MIGRATION_CEILING");
      expect(WORKFLOW).toContain("LOCAL_MIGRATION_CEILING: '147'");
    });

    it('reads Production\'s current migration ceiling read-only, before deciding anything', () => {
      expect(WORKFLOW).toContain('id: read_ceiling');
      expect(WORKFLOW).toContain('tools/phoenix-demo/read-migration-ceiling.mjs');
      // The reader script never asserts an expected value — only the workflow's
      // own next step (the fail-closed gate) makes that decision.
      expect(CEILING_SCRIPT).not.toContain('ACCEPTED_MIGRATION_CEILING');
      expect(CEILING_SCRIPT).toMatch(/throw new Error\(.*gaps/i);
    });

    it('fails closed for any Production ceiling other than 146 or 147, before any migration or deploy step', () => {
      const failClosedIdx = WORKFLOW.indexOf('Fail closed unless Production is at 146');
      const dryRunIdx = WORKFLOW.indexOf('Preview migration 147');
      const applyIdx = WORKFLOW.indexOf('Apply migration 147 only');
      const deployIdx = WORKFLOW.indexOf('Deploy admin-user-lifecycle only');
      expect(failClosedIdx).toBeGreaterThan(-1);
      expect(failClosedIdx).toBeLessThan(dryRunIdx);
      expect(failClosedIdx).toBeLessThan(applyIdx);
      expect(failClosedIdx).toBeLessThan(deployIdx);

      const gateBlock = WORKFLOW.slice(failClosedIdx, failClosedIdx + 700);
      expect(gateBlock).toContain('!= "146"');
      expect(gateBlock).toContain('!= "147"');
      expect(gateBlock).toContain('exit 1');
    });

    it('applies migration 147 only when Production is at 146, and never with --include-all', () => {
      expect(WORKFLOW).not.toContain('--include-all');
      const dryRunIdx = WORKFLOW.indexOf('Preview migration 147');
      const applyIdx = WORKFLOW.indexOf('Apply migration 147 only');
      const verifyIdx = WORKFLOW.indexOf('Verify Production migration history now reaches 147');
      expect(dryRunIdx).toBeGreaterThan(-1);
      expect(applyIdx).toBeGreaterThan(dryRunIdx);
      expect(verifyIdx).toBeGreaterThan(applyIdx);

      for (const idx of [dryRunIdx, applyIdx, verifyIdx]) {
        const step = WORKFLOW.slice(idx - 80, idx + 300);
        expect(step).toContain("if: steps.read_ceiling.outputs.ceiling == '146'");
      }

      expect(WORKFLOW.slice(dryRunIdx, dryRunIdx + 300)).toContain('supabase db push --db-url "$PHOENIX_PRODUCTION_DATABASE_URL" --dry-run');
      expect(WORKFLOW.slice(applyIdx, applyIdx + 300)).toContain('supabase db push --db-url "$PHOENIX_PRODUCTION_DATABASE_URL"');
      expect(WORKFLOW.slice(verifyIdx, verifyIdx + 350)).toContain("ACCEPTED_MIGRATION_CEILING: '147'");
    });

    it('never applies any migration other than 147: only one db-push command target, never a wildcard/sweep', () => {
      const pushCommands = WORKFLOW.match(/supabase db push[^\n]*/g) ?? [];
      // Exactly a dry-run and a real push, both against the SAME db-url flag,
      // no other flag combination (e.g. --linked, --include-all).
      expect(pushCommands).toEqual([
        'supabase db push --db-url "$PHOENIX_PRODUCTION_DATABASE_URL" --dry-run',
        'supabase db push --db-url "$PHOENIX_PRODUCTION_DATABASE_URL"',
      ]);
    });

    it('verifies the delete-history-guard security contract unconditionally, after migration state is settled and before either function is deployed', () => {
      const verifyMigIdx = WORKFLOW.indexOf('Verify Production migration history now reaches 147');
      const contractIdx = WORKFLOW.indexOf('Verify delete-history-guard security contract');
      const deployLifecycleIdx = WORKFLOW.indexOf('Deploy admin-user-lifecycle only');
      const deployRecycleIdx = WORKFLOW.indexOf('Deploy admin-recycle-user only');
      expect(contractIdx).toBeGreaterThan(-1);
      expect(contractIdx).toBeGreaterThan(verifyMigIdx);
      expect(contractIdx).toBeLessThan(deployLifecycleIdx);
      expect(deployLifecycleIdx).toBeLessThan(deployRecycleIdx);

      // Unconditional (no `if:` on the ceiling output) — must run whether
      // migration 147 was just applied or was already there (resume-safe path).
      const stepBlock = WORKFLOW.slice(contractIdx - 40, contractIdx + 250);
      expect(stepBlock).not.toContain('if: steps.read_ceiling');

      expect(WORKFLOW).toContain('tools/phoenix-demo/verify-delete-history-guard-contract.mjs');
    });

    it('the contract-verification script re-checks the migration ceiling AND the live function body, not just grants', () => {
      expect(CONTRACT_SCRIPT).toContain('highest !== 147');
      expect(CONTRACT_SCRIPT).toContain('USER_HAS_OPERATIONAL_HISTORY');
      expect(CONTRACT_SCRIPT).toContain('phoenix_profile_operational_blockers');
      expect(CONTRACT_SCRIPT).toContain('phoenix_lifecycle_reserve');
      expect(CONTRACT_SCRIPT).toContain("has_function_privilege('authenticated'");
      expect(CONTRACT_SCRIPT).toContain("has_function_privilege('anon'");
    });

    it('neither ceiling-reading nor contract-verification script ever logs the connection string', () => {
      for (const src of [CEILING_SCRIPT, CONTRACT_SCRIPT]) {
        expect(src).not.toMatch(/console\.(?:log|error)\([^)]*PHOENIX_PRODUCTION_DATABASE_URL\)/);
      }
    });
  });

  it('deploys exactly admin-user-lifecycle and admin-recycle-user, nothing else', () => {
    const deployCommands = WORKFLOW.match(/supabase functions deploy [^\n]+/g) ?? [];
    expect(deployCommands).toEqual([
      'supabase functions deploy admin-user-lifecycle --project-ref "$PROJECT_REF"',
      'supabase functions deploy admin-recycle-user --project-ref "$PROJECT_REF"',
    ]);
    expect(WORKFLOW).not.toContain('--no-verify-jwt');
    expect(WORKFLOW).not.toMatch(
      /^\s*run:.*(?:phoenix_demo_purge|seed-prod|\bpurge\b|db reset)/gim,
    );
  });

  it('never prints a secret value', () => {
    expect(WORKFLOW).not.toMatch(/echo\s+"?\$\{\{\s*secrets\./);
    expect(WORKFLOW).not.toMatch(/echo\s+"?\$SUPABASE_ACCESS_TOKEN/);
    expect(WORKFLOW).not.toMatch(/echo\s+"?\$PHOENIX_PRODUCTION_DATABASE_URL/);
  });
});
