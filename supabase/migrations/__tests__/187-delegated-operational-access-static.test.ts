import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = '187_phoenix_delegated_operational_access.sql';
const PATH = join(__dirname, '..', NAME);
const sql = () => readFileSync(PATH, 'utf8');

describe('Migration 187 · delegated operational access (static)', () => {
  it('uses the one authorized migration and a separate scope ledger', () => {
    expect(existsSync(PATH)).toBe(true);
    const text = sql();
    expect(text).toContain('CREATE TABLE public.profile_delegated_scope_assignments');
    expect(text).not.toMatch(/ALTER TABLE public\.profile_scope_assignments\s+(?:ADD|DROP|ALTER)/i);
    expect(existsSync(join(__dirname, '..', '188_phoenix_delegated_operational_access.sql'))).toBe(false);
  });

  it('pins exact scope shapes, composite ancestry, uniqueness, and snapshot semantics', () => {
    const text = sql();
    expect(text).toMatch(/FOREIGN KEY \(warehouse_id, target_organization_id\)[\s\S]*warehouses\(id, organization_id\)/);
    expect(text).toMatch(/FOREIGN KEY \(distribution_point_id, target_organization_id\)[\s\S]*distribution_points\(id, organization_id\)/);
    expect(text.match(/CREATE UNIQUE INDEX pdsa_active_/g)).toHaveLength(3);
    // Only the two origins this migration emits are pre-authorized; a future
    // refresh mode has to arrive through its own reviewed migration.
    expect(text).toContain("grant_origin IN ('direct','network_snapshot')");
    expect(text).not.toContain('network_refresh');
    expect(text).not.toMatch(/scope_type\s*=\s*'network'/);
    expect(text).toContain('LOCK TABLE public.organizations IN SHARE MODE');
    // The snapshot is FOREIGN-only, exactly like the direct grant.
    expect(text).toContain('o.id IS DISTINCT FROM v_target_primary_org');
    expect(text).toContain('array_agg(o.id ORDER BY o.id)');
    expect(text).toContain('v_current := cardinality(v_org_ids)');
    expect(text).toContain("'empty_snapshot',true");
    expect(text).toMatch(/FOREACH v_org_id IN ARRAY v_org_ids LOOP/);
  });

  it('uses a reviewed exact-key firewall with 34 entries and no wildcard matching', () => {
    const text = sql();
    const block = text.slice(text.indexOf('INSERT INTO public.delegated_operational_permission_keys'), text.indexOf('ALTER TABLE public.delegated_operational_permission_keys'));
    const keys = [...block.matchAll(/\('([a-z_]+\.[a-z_]+)'\)/g)].map(match => match[1]).sort();
    expect(keys).toEqual([
      'inventory.act_on_suggestions','inventory.fefo_override','movement_context.record',
      'outlet_stock.count','outlet_stock.dispense','outlet_stock.recall','outlet_stock.receive',
      'outlet_stock.replenish','outlet_stock.replenish_reverse','outlet_stock.resolve_return_exception',
      'outlet_stock.return','outlet_stock.return_receive','outlet_stock.return_request',
      'outlet_stock.review_return','outlet_stock.view','warehouse_dispatch.cancel',
      'warehouse_dispatch.create','warehouse_dispatch.edit_draft','warehouse_dispatch.send',
      'warehouse_dispatch.view','warehouse_stock.adjust','warehouse_stock.correct',
      'warehouse_stock.movements_view','warehouse_stock.view','warehouse_transfer.recall',
      'warehouse_transfer.receive','warehouse_transfer.request','warehouse_transfer.return_receive',
      'warehouse_transfer.return_request','warehouse_transfer.return_send','warehouse_transfer.review',
      'warehouse_transfer.review_return','warehouse_transfer.send','warehouse_transfer.view',
    ]);
    for (const denied of ['users.edit_scope', 'warehouses.manage', 'outlets.manage', 'organization_facilities.manage', 'warehouse_stock.approve_correction']) {
      expect(block).not.toContain(`('${denied}')`);
    }
    expect(text).toContain('WHERE k.permission_key = p_permission_key');
    expect(text).not.toMatch(/split_part\s*\(\s*permission_key/i);
  });

  it('preserves central same-org/HCM behavior and requires permission plus delegated WHERE cross-org', () => {
    const text = sql();
    expect(text.match(/CREATE OR REPLACE FUNCTION public\.phoenix_profile_has_scoped_permission/g)).toHaveLength(1);
    expect(text).toMatch(/phoenix_my_role\(\) = 'health_center_manager'[\s\S]{0,100}p_profile_id IS DISTINCT FROM auth\.uid\(\)/);
    expect(text).toContain('p_organization_id IS NOT DISTINCT FROM v_org');
    expect(text).toContain('public.phoenix_profile_has_permission(p_profile_id, p_permission_key)');
    expect(text).toContain('public._phoenix_profile_has_delegated_scope_v1');
    expect(text).toMatch(/auth\.uid\(\) IS NOT NULL[\s\S]{0,100}p_profile_id IS DISTINCT FROM auth\.uid\(\)/);
  });

  it('adds foreign read paths without replacing historical same-org policies', () => {
    const text = sql();
    for (const preserved of [
      'warehouse_stock_select_scoped',
      'warehouse_stock_mov_select_scoped',
      'warehouse_dispatches_select_scoped',
      'warehouse_dispatch_lines_select_scoped',
    ]) {
      expect(text).not.toContain(`DROP POLICY IF EXISTS "${preserved}"`);
    }
    for (const delegated of [
      'warehouse_stock_delegated_select',
      'warehouse_stock_mov_delegated_select',
      'warehouse_dispatches_delegated_select',
      'warehouse_dispatch_lines_delegated_select',
    ]) {
      expect(text).toContain(`CREATE POLICY "${delegated}"`);
    }
    expect(text.match(/IS DISTINCT FROM public\.phoenix_my_org\(\)/g)).toHaveLength(4);
  });

  it('hard-gates grant/revoke/snapshot, protects helpers, and forbids authenticated writes', () => {
    const text = sql();
    expect(text.match(/v_actor_role IS DISTINCT FROM 'super_admin'/g)?.length).toBeGreaterThanOrEqual(3);
    // Recipient eligibility is stated ONCE in a canonical capsule that every
    // grant path, the WHERE bridge and the resource catalog all consult, so no
    // two surfaces can drift. The capsule requires a NON-NULL primary anchor.
    expect(text).toContain('CREATE FUNCTION public._phoenix_delegated_recipient_is_eligible_v1');
    expect(text).toContain('AND p.organization_id IS NOT NULL');
    expect(text).toContain("p.role IN ('central_warehouse_manager','warehouse_officer','outlet_officer')");
    // Exactly one place still spells the role list for recipients: the capsule.
    expect(text.match(/p\.role IN \('central_warehouse_manager','warehouse_officer','outlet_officer'\)/g))
      .toHaveLength(1);
    expect(text.match(/_phoenix_delegated_recipient_is_eligible_v1\(p_profile_id\)/g)?.length)
      .toBeGreaterThanOrEqual(3);
    expect(text).toMatch(/REVOKE ALL ON FUNCTION public\._phoenix_delegated_recipient_is_eligible_v1[\s\S]*PUBLIC, anon, authenticated, service_role/);
    expect(text).toMatch(/REVOKE ALL ON TABLE public\.profile_delegated_scope_assignments[\s\S]*PUBLIC, anon, authenticated, service_role/);
    expect(text).toMatch(/REVOKE ALL ON FUNCTION public\._phoenix_profile_has_delegated_scope_v1[\s\S]*PUBLIC, anon, authenticated, service_role/);
    expect(text).toMatch(/GRANT SELECT ON TABLE public\.profile_delegated_scope_assignments TO authenticated/);
    expect(text).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*profile_delegated_scope_assignments[\s\S]*authenticated/);
    expect(text).toContain("has_function_privilege('service_role',v_proc,'EXECUTE')");
    expect(text).toContain("NOT has_function_privilege('authenticated',v_proc,'EXECUTE')");
    expect(text).toContain("acl.grantee=0 AND acl.privilege_type='EXECUTE'");
  });

  it('revokes at the profile lifecycle boundary and closes outlet recall inheritance', () => {
    const text = sql();
    expect(text).toMatch(/BEFORE UPDATE OF status,role,organization_id,identity_version OR DELETE\s+ON public\.profiles/);
    expect(text).toContain('identity_recycled');
    expect(text).toContain('v_point.organization_id IS NOT DISTINCT FROM v_actor_org');
    expect(text).toContain("'outlet_stock.recall',v_point.organization_id,NULL,v_point.id");
  });

  it('contains a detailed fail-closed verify section', () => {
    const text = sql();
    expect(text).toContain('187 VERIFY FAILED');
    expect(text).toContain("v_count <> 34");
    expect(text).toContain('primary/facility scope invariant changed');
    expect(text).toContain('HCM role/facility invariant missing');
  });
});
