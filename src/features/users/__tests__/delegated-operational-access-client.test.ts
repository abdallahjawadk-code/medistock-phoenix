import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('delegated operational access client boundary', () => {
  const panel = () => read('features/users/DelegatedAccessPanel.tsx');
  const service = () => read('shared/supabase/services/delegated-access.service.ts');

  it('has outer and inner super-admin gates with exact eligible recipients', () => {
    expect(read('features/users/UserManagementScreen.tsx')).toMatch(/isSuper && <DelegatedAccessPanel/);
    expect(panel()).toContain("normalizeRole(actorRole) !== 'super_admin'");
    expect(panel()).toContain("const canGrant = eligible && target.status === 'active'");
    expect(panel()).toMatch(/if \(normalizeRole\(actorRole\) !== 'super_admin'\) return null/);
    expect(panel()).toMatch(/\{canGrant && <div[\s\S]*um_delegated_network_snapshot/);
    expect(service()).toContain("'central_warehouse_manager', 'warehouse_officer', 'outlet_officer'");
    for (const denied of ['health_center_manager', 'institution_admin', 'super_admin']) {
      expect(service().match(new RegExp(`'${denied}'`, 'g')) ?? []).toHaveLength(0);
    }
  });

  it('uses RPC-only mutations with canonical UUID payloads and no privileged client', () => {
    const text = service();
    expect(text).toContain("supabase.rpc('phoenix_admin_grant_delegated_scope'");
    expect(text).toContain('p_target_organization_id: input.targetOrganizationId');
    expect(text).toContain("supabase.rpc('phoenix_admin_grant_delegated_network_snapshot'");
    expect(text).not.toMatch(/\.from\(['"]profile_delegated_scope_assignments|service_role|auth\.admin/i);
    expect(panel()).toContain('getPointsByOrg');
  });

  it('keeps scope separate from permission and requires revoke reason', () => {
    expect(panel()).toContain("t('um_delegated_scope_not_permission'");
    expect(service()).not.toMatch(/assignProfilePermissions|resetProfilePermissions/);
    expect(service()).toContain('DELEGATED_REVOKE_REASON_REQUIRED');
    expect(panel()).toContain("t('um_delegated_revoke_reason'");
  });

  it('states snapshot/current-network and bilingual separation copy exactly', () => {
    const strings = read('shared/i18n/strings.ts');
    expect(strings).toContain('Scope does not grant permissions.');
    expect(strings).toContain('النطاق لا يمنح الصلاحيات.');
    expect(strings).toContain('Organizations created later are not included.');
    expect(strings).toContain('لا تُضمَّن المؤسسات التي تُنشأ لاحقاً.');
  });

  it('uses the hardened server projection for cross-org navigation/resources', () => {
    expect(read('shared/ui/PhoenixOrgScope.tsx')).toContain('getMyOperationalResourceCatalog');
    expect(read('features/inventory/useInventoryScopes.ts')).toContain('getMyOperationalResourceCatalog');
    expect(read('features/inventory/useInventoryScopes.ts')).toContain('delegatedOrganization');
  });
});
