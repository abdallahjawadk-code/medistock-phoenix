import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOW = readFileSync(
  join(__dirname, '../../../../.github/workflows/deploy-admin-create-user.yml'),
  'utf8',
);
const DEMO_WORKFLOW = readFileSync(
  join(__dirname, '../../../../.github/workflows/production-demo-seed.yml'),
  'utf8',
);
const FUNCTION_ONLY_WORKFLOW = readFileSync(
  join(__dirname, '../../../../.github/workflows/deploy-admin-create-user-function-only.yml'),
  'utf8',
);

// The workflow documents, in prose, the commands it deliberately does NOT run.
// Asserting "does not contain 'db push'" over the whole file would therefore
// fail on its own explanation — and, worse, would tempt someone to delete the
// explanation to get green. What actually matters is the EXECUTABLE surface, so
// the negative assertions below run against the file with comment lines
// stripped. (Migration 085 taught the same lesson from the other direction: a
// static assertion written against raw text breaks on how the prose is worded.)
const stripComments = (yaml: string) =>
  yaml.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

const FUNCTION_ONLY_EXECUTABLE = stripComments(FUNCTION_ONLY_WORKFLOW);
// The deprecated workflow's own header now explains the `supabase db push`
// hazard in prose, so ordering must be measured on the executable surface too —
// otherwise indexOf() finds the explanation instead of the step.
const WORKFLOW_EXECUTABLE = stripComments(WORKFLOW);

describe('admin-create-user Production deployment contract', () => {
  it('is manual-only and locked to the exact Production project and migration ceiling', () => {
    expect(WORKFLOW).toMatch(/\bon:\s*\n\s+workflow_dispatch:/);
    expect(WORKFLOW).not.toMatch(/\n\s+(?:push|pull_request|schedule):/);
    expect(WORKFLOW).toContain('PROJECT_REF: eyrzxgfkvqybjdgyphap');
    expect(WORKFLOW).toContain("ACCEPTED_MIGRATION_CEILING: '146'");
    expect(WORKFLOW).toContain('"${{ github.ref_name }}" != "master"');
    expect(WORKFLOW).toContain('"${{ github.sha }}" != "${{ inputs.confirm_sha }}"');
  });

  it('requires explicit authorization and GitHub Production environment approval', () => {
    expect(WORKFLOW).toContain('environment: production');
    expect(WORKFLOW).toContain('DEPLOY_SECURE_USER_PROVISIONING');
    expect(WORKFLOW).toContain('secrets.PHOENIX_PRODUCTION_DATABASE_URL');
    expect(WORKFLOW).toContain('secrets.SUPABASE_ACCESS_TOKEN');
  });

  it('preflights, previews, applies and verifies the database before Edge deployment', () => {
    const preflight = WORKFLOW.indexOf('node tools/phoenix-demo/prod-preflight.mjs');
    const preview = WORKFLOW.indexOf('supabase db push --db-url "$PHOENIX_PRODUCTION_DATABASE_URL" --dry-run');
    const apply = WORKFLOW.lastIndexOf('supabase db push --db-url "$PHOENIX_PRODUCTION_DATABASE_URL"');
    const verify = WORKFLOW.indexOf('node tools/phoenix-demo/verify-migration-ceiling.mjs');
    const deploy = WORKFLOW.indexOf('supabase functions deploy admin-create-user');

    expect(preflight).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(preflight);
    expect(apply).toBeGreaterThan(preview);
    expect(verify).toBeGreaterThan(apply);
    expect(deploy).toBeGreaterThan(verify);
  });

  it('can deploy only admin-create-user and keeps JWT verification enabled', () => {
    const deployCommands = WORKFLOW.match(/supabase functions deploy [^\n]+/g) ?? [];
    expect(deployCommands).toEqual([
      'supabase functions deploy admin-create-user --project-ref "$PROJECT_REF"',
    ]);
    expect(WORKFLOW).not.toContain('--no-verify-jwt');
    expect(WORKFLOW).not.toMatch(
      /^\s*run:.*(?:phoenix_demo_purge|seed-prod|\bpurge\b)/gim,
    );
  });

  it('keeps the existing Production demo workflow aligned with migration 146', () => {
    expect(DEMO_WORKFLOW).toContain("ACCEPTED_MIGRATION_CEILING: '146'");
    expect(DEMO_WORKFLOW).not.toContain("ACCEPTED_MIGRATION_CEILING: '145'");
  });
});

// =============================================================================
// The function-only deployment path.
//
// Deploying one Edge Function must never carry the authority to apply an
// unrelated migration. The workflow above does — its `supabase db push` is
// unbounded, and the ACCEPTED_MIGRATION_CEILING it declares is never passed to
// the command. This suite pins the safe path structurally, so a future edit
// cannot quietly reintroduce database authority into a function deployment.
// =============================================================================
describe('admin-create-user function-only deployment contract', () => {
  it('is manual-only, master-only, and locked to the Production project', () => {
    expect(FUNCTION_ONLY_WORKFLOW).toMatch(/\bon:\s*\n\s+workflow_dispatch:/);
    expect(FUNCTION_ONLY_WORKFLOW).not.toMatch(/\n\s+(?:push|pull_request|schedule):/);
    expect(FUNCTION_ONLY_WORKFLOW).toContain('PROJECT_REF: eyrzxgfkvqybjdgyphap');
    expect(FUNCTION_ONLY_WORKFLOW).toContain('"${{ github.ref_name }}" != "master"');
    expect(FUNCTION_ONLY_WORKFLOW).toContain('"${{ github.sha }}" != "${{ inputs.confirm_sha }}"');
    expect(FUNCTION_ONLY_WORKFLOW).toContain('environment: production');
    expect(FUNCTION_ONLY_WORKFLOW).toContain('DEPLOY_ADMIN_CREATE_USER_FUNCTION_ONLY');
  });

  it('carries NO database authority of any kind', () => {
    expect(FUNCTION_ONLY_EXECUTABLE).not.toContain('db push');
    expect(FUNCTION_ONLY_EXECUTABLE).not.toContain('db reset');
    expect(FUNCTION_ONLY_EXECUTABLE).not.toMatch(/supabase\s+migration\b/);
    expect(FUNCTION_ONLY_EXECUTABLE).not.toContain('PHOENIX_PRODUCTION_DATABASE_URL');
    expect(FUNCTION_ONLY_EXECUTABLE).not.toContain('--db-url');
    expect(FUNCTION_ONLY_EXECUTABLE).not.toContain('psql');
  });

  it('deploys exactly one function, by literal name, with JWT verification intact', () => {
    const deployCommands = FUNCTION_ONLY_EXECUTABLE.match(/supabase functions deploy [^\n]+/g) ?? [];
    expect(deployCommands).toEqual([
      'supabase functions deploy "$FUNCTION_NAME" --project-ref "$PROJECT_REF"',
    ]);
    expect(FUNCTION_ONLY_EXECUTABLE).toContain('FUNCTION_NAME: admin-create-user');
    expect(FUNCTION_ONLY_EXECUTABLE).not.toContain('--no-verify-jwt');
  });

  it('pins the artifact to a reviewed SHA-256 before deploying', () => {
    expect(FUNCTION_ONLY_WORKFLOW).toContain('confirm_file_sha256');
    expect(FUNCTION_ONLY_WORKFLOW).toContain('sha256sum');
    const pin = FUNCTION_ONLY_WORKFLOW.indexOf('confirm_file_sha256 }}"');
    const deploy = FUNCTION_ONLY_WORKFLOW.indexOf('supabase functions deploy');
    expect(pin).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(pin);
  });

  it('refuses to deploy the stale contract', () => {
    // The four markers whose absence identified the stale Production build.
    expect(FUNCTION_ONLY_WORKFLOW).toContain('health_center_manager FACILITY_SCOPED_ROLES');
    expect(FUNCTION_ONLY_WORKFLOW).toContain('facility_ids phoenix_admin_assign_facility_scopes');
    const guard = FUNCTION_ONLY_WORKFLOW.indexOf('is missing $token');
    const deploy = FUNCTION_ONLY_WORKFLOW.indexOf('supabase functions deploy');
    expect(guard).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(guard);
  });
});

// =============================================================================
// The deprecated workflow is PERMANENTLY DISABLED.
//
// An earlier revision gated it behind an acknowledgement phrase. That was not
// fail-closed: an escape hatch an operator can type is an escape hatch that
// will eventually be typed, and beyond it lay the historical unbounded
// `supabase db push`. The refusal is now unconditional, and this suite proves
// that no runtime path reaches any database or deployment step.
//
// The historical steps are deliberately RETAINED in the file for audit, so
// these assertions are written against reachability, never against absence of
// the commands themselves.
// =============================================================================
describe('deprecated admin-create-user workflow is permanently disabled', () => {
  /** The first step's `run:` body — everything a dispatch can actually execute. */
  const firstStepBody = (() => {
    const stepsAt = WORKFLOW_EXECUTABLE.indexOf('steps:');
    expect(stepsAt).toBeGreaterThan(-1);
    const after = WORKFLOW_EXECUTABLE.slice(stepsAt);
    // From the first step to the second step marker.
    const firstStep = after.indexOf('- name:');
    const secondStep = after.indexOf('- name:', firstStep + 1);
    return after.slice(firstStep, secondStep === -1 ? undefined : secondStep);
  })();

  it('is visibly deprecated in its name', () => {
    expect(WORKFLOW).toContain('DEPRECATED');
    expect(WORKFLOW.split('\n')[0]).toContain('DEPRECATED');
  });

  it('offers NO input, so there is nothing an operator can type', () => {
    const triggerBlock = WORKFLOW_EXECUTABLE.slice(
      WORKFLOW_EXECUTABLE.indexOf('on:'),
      WORKFLOW_EXECUTABLE.indexOf('permissions:'),
    );
    expect(triggerBlock).toContain('workflow_dispatch:');
    expect(triggerBlock).not.toContain('inputs:');
  });

  it('has NO bypass confirmation phrase', () => {
    expect(WORKFLOW).not.toContain('acknowledge_migration_apply');
    expect(WORKFLOW).not.toContain('I_ACCEPT_THIS_MAY_APPLY_MIGRATIONS');
    // The refusal itself is unconditional: no shell test, no branch, no
    // comparison against any supplied value.
    expect(firstStepBody).not.toMatch(/\bif\s+\[/);
    expect(firstStepBody).not.toContain('inputs.');
    expect(firstStepBody).not.toContain('${{');
  });

  it('always exits non-zero on its very first step', () => {
    expect(firstStepBody).toContain('exit 1');
    expect(firstStepBody).toContain('::error::');
    expect(firstStepBody).toContain('deploy-admin-create-user-function-only.yml');
  });

  it('lets no later step survive the refusal', () => {
    // A step marked `if: always()` or `continue-on-error` would run despite the
    // failure above and reach the historical database commands.
    expect(WORKFLOW_EXECUTABLE).not.toContain('continue-on-error');
    expect(WORKFLOW_EXECUTABLE).not.toMatch(/if:\s*always\(\)/);
    expect(WORKFLOW_EXECUTABLE).not.toMatch(/if:\s*success\(\)\s*\|\|/);
    expect(WORKFLOW_EXECUTABLE).not.toMatch(/^\s*if:/m);
  });

  it('reaches no database or deployment step from a dispatch', () => {
    // The historical commands still exist in the file (retained for audit), but
    // every one of them sits AFTER the unconditional refusal.
    const refusal = WORKFLOW_EXECUTABLE.indexOf('- name: Refuse');
    expect(refusal).toBeGreaterThan(-1);
    for (const command of [
      'supabase db push',
      'supabase functions deploy',
      'prod-preflight.mjs',
      'verify-migration-ceiling.mjs',
    ]) {
      const at = WORKFLOW_EXECUTABLE.indexOf(command);
      expect(at, `${command} must sit after the refusal`).toBeGreaterThan(refusal);
    }
    // Exactly one job, so nothing runs in parallel with the refusal. Counted
    // inside the jobs: block only — a 2-space key elsewhere (workflow_dispatch:
    // under on:) is not a job.
    const jobsBlock = WORKFLOW_EXECUTABLE.slice(WORKFLOW_EXECUTABLE.indexOf('\njobs:'));
    expect(jobsBlock.match(/^ {2}\w[\w-]*:\s*$/gm) ?? []).toHaveLength(1);
    expect(WORKFLOW_EXECUTABLE).not.toContain('needs:');
  });
});
