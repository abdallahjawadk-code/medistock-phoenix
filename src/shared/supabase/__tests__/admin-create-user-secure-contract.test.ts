import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(__dirname, '../../../../supabase/functions/admin-create-user/index.ts'),
  'utf8',
);
const SCREEN = readFileSync(
  join(__dirname, '../../../features/users/UserManagementScreen.tsx'),
  'utf8',
);

describe('admin-create-user secure provisioning contract', () => {
  it('uses the service client for migration 146 and never calls the legacy RPC', () => {
    expect(SOURCE).toContain("admin.rpc('phoenix_admin_provision_profile'");
    expect(SOURCE).not.toContain("caller.rpc('phoenix_provision_profile'");
  });

  it('binds every new Auth user to an unguessable provisioning nonce and actor', () => {
    expect(SOURCE).toContain('const provisioningNonce = crypto.randomUUID()');
    expect(SOURCE).toContain('phoenix_provisioning_nonce: provisioningNonce');
    expect(SOURCE).toContain('phoenix_provisioning_actor_id: userData.user.id');
    expect(SOURCE).toContain('p_provisioning_nonce: provisioningNonce');
    expect(SOURCE).toContain('p_actor_id: userData.user.id');
  });

  it('requires an active supported administrator and both dangerous permissions', () => {
    expect(SOURCE).toContain(".select('role, organization_id, status')");
    expect(SOURCE).toContain("callerProfile.status !== 'active'");
    expect(SOURCE).toContain("callerProfile.role === 'institution_admin'");
    expect(SOURCE).toContain("p_key: 'users.create'");
    expect(SOURCE).toContain("p_key: 'users.assign_role'");
  });

  it('handles rollback failure explicitly instead of hiding an orphan Auth user', () => {
    expect(SOURCE).toContain('const { error: rollbackErr } = await admin.auth.admin.deleteUser(newId)');
    expect(SOURCE).toContain("error: 'ROLLBACK_FAILED'");
    expect(SOURCE).toContain("event: 'admin-create-user.rollback-failed'");
  });

  it('never logs credentials or service configuration', () => {
    const consoleCalls = SOURCE.match(/console\.(?:log|warn|error)\([\s\S]*?\);/g) ?? [];
    // R1.1-U added a SECOND rollback log, for the facility-scope failure path.
    // The guarantee is unchanged and is now asserted over EVERY call instead of
    // a single one: each must carry the correlation id, and none may name a
    // secret.
    expect(consoleCalls.length).toBeGreaterThan(0);
    for (const call of consoleCalls) {
      expect(call).toContain('correlation_id');
      expect(call).not.toMatch(/password|serviceKey|service_role|email/i);
    }
    // The logged events are pinned by EXACT name, so relaxing the count cannot
    // let a new, unreviewed log appear silently.
    const events = [...SOURCE.matchAll(/event:\s*'([^']+)'/g)].map(m => m[1]).sort();
    expect(events).toEqual([
      'admin-create-user.facility-scope-rollback-failed',
      'admin-create-user.rollback-failed',
    ]);
  });

  it('normalizes an invalid client correlation id before passing it to UUID SQL', () => {
    expect(SOURCE).toContain('UUID_PATTERN.test(suppliedCorrelationId)');
    expect(SOURCE).toContain(': crypto.randomUUID()');
  });

  it('surfaces authorization and rollback outcomes without exposing internals', () => {
    expect(SCREEN).toContain("'REQUEST_DENIED'");
    expect(SCREEN).toContain("'ACTOR_NOT_ACTIVE'");
    expect(SCREEN).toContain("msg = t('um_request_denied', lang)");
    expect(SCREEN).toContain("'ROLLBACK_FAILED'");
    expect(SCREEN).toContain("msg = t('um_create_failed', lang)");
  });

  it('does not misclassify an unexpected form exception as a missing Edge deployment', () => {
    const createForm = SCREEN.slice(
      SCREEN.indexOf('function CreateUserForm('),
      SCREEN.indexOf('function DisableConfirmModal('),
    );
    expect(createForm).toContain("if (res.edgeMissing) { setError(withSupportRef(t('um_edge_disabled'");
    expect(createForm).toContain("if (res.unknownError) { setError(withSupportRef(t('um_unknown_error'");
    expect(createForm).toMatch(
      /catch\s*\{\s*\/\/[\s\S]*?setError\(t\('um_unknown_error', lang\)\);/,
    );
    expect(createForm).not.toMatch(
      /catch\s*\{\s*setError\(t\('um_edge_disabled', lang\)\);/,
    );
  });
});
