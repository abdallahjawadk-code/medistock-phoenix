import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOW = readFileSync(
  join(__dirname, '../../../../.github/workflows/deploy-admin-user-lifecycle.yml'),
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
  });

  it('never applies a migration in this workflow', () => {
    expect(WORKFLOW).not.toContain('supabase db push');
    expect(WORKFLOW).not.toContain('ACCEPTED_MIGRATION_CEILING');
    expect(WORKFLOW).not.toContain('PHOENIX_PRODUCTION_DATABASE_URL');
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
  });
});
