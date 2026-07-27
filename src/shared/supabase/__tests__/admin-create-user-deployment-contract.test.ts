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
