import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { readAuthorizationSurface, type AuthorizationSurface } from './helpers/authorization-surface';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;
const SQL_196 = readFileSync(
  join(__dirname, '..', '196_phoenix_secdef_relation_schema_qualification.sql'), 'utf8');

const EXPECTED: Record<string, number> = {
  archive_entity: 4, assign_profile_permissions: 6, assign_profile_role: 4,
  clear_port_availability: 7, create_qr_for_target: 11, disable_qr_token: 3,
  get_effective_permissions: 3, get_entity_purge_impact: 18,
  get_scoped_inter_institution_alerts: 6, phoenix_admin_assign_facility_scopes: 1,
  phoenix_assign_profile_scope: 1, phoenix_create_supply_route: 1,
  phoenix_create_warehouse: 1, phoenix_mark_password_changed: 1,
  phoenix_profile_has_permission: 3, phoenix_revoke_profile_scope: 1,
  phoenix_set_supply_route_active: 1, phoenix_set_warehouse_active: 1,
  phoenix_update_supply_route: 1, phoenix_update_warehouse: 2,
  purge_entity_with_all_data: 26, reset_profile_permissions: 4,
};

const RELATIONS = [
  'audit_logs', 'distribution_points', 'institution_item_status_reports',
  'item_availability', 'item_availability_movements', 'local_items',
  'organization_status_contacts', 'organizations', 'permission_keys',
  'profile_permission_overrides', 'profiles', 'qr_targets', 'qr_tokens',
  'role_permission_defaults', 'warehouses',
];
const relationAlt = RELATIONS.join('|');
const unqualified = new RegExp(
  `\\b(FROM|JOIN|UPDATE|INTO)(\\s+)(${relationAlt})\\b`, 'gi');
const qualify = (body: string): string => body.replace(
  unqualified, (_m, keyword, spacing, relation) => `${keyword}${spacing}public.${relation}`);

const TARGET_NAMES_SQL = Object.keys(EXPECTED).map((n) => `'${n}'`).join(',');
const FACTS_SQL = `
  SELECT p.oid::text, p.proname, p.oid::regprocedure::text signature,
         pg_get_function_identity_arguments(p.oid) ident_args,
         pg_get_function_result(p.oid) result_type,
         l.lanname language, p.provolatile, p.prosecdef, p.proisstrict,
         p.proparallel, p.proleakproof,
         coalesce(array_to_string(p.proconfig, ','), '') cfg,
         pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text, '') acl,
         replace(p.prosrc, chr(13)||chr(10), chr(10)) body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname='public' AND p.proname IN (${TARGET_NAMES_SQL})
  ORDER BY p.proname`;

const POLICIES_SQL = `
  SELECT schemaname, tablename, policyname, permissive, roles::text,
         cmd, coalesce(qual,''), coalesce(with_check,'')
  FROM pg_policies WHERE schemaname='public'
  ORDER BY tablename, policyname`;

run('M196 · SECURITY DEFINER relation schema qualification · dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let before: any[];
  let after: any[];
  let authBefore: AuthorizationSurface;
  let authAfter: AuthorizationSurface;
  let policiesBefore: any[];
  let policiesAfter: any[];
  let behaviorBefore: any;
  let behaviorAfter: any;

  const surface = () => rig.asAdmin((c: any) =>
    readAuthorizationSurface((sql, params) => c.query(sql, params)));

  const behavior = () => rig.asAdmin(async (c: any) => (await c.query(
    `SELECT public.phoenix_profile_has_permission($1,'users.manage_permissions') allowed,
            public.get_effective_permissions($1) permissions`,
    [rig.superAdminId])).rows[0]);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 195 });
    before = (await rig.asAdmin((c: any) => c.query(FACTS_SQL))).rows;
    authBefore = await surface();
    policiesBefore = (await rig.asAdmin((c: any) => c.query(POLICIES_SQL))).rows;
    behaviorBefore = await behavior();

    await rig.asAdmin((c: any) => c.query(SQL_196));

    after = (await rig.asAdmin((c: any) => c.query(FACTS_SQL))).rows;
    authAfter = await surface();
    policiesAfter = (await rig.asAdmin((c: any) => c.query(POLICIES_SQL))).rows;
    behaviorAfter = await behavior();
  }, 900_000);

  afterAll(async () => { await rig?.end(); });

  it('replays 001→195 then applies M196 including its fail-closed VERIFY block', () => {
    expect(before).toHaveLength(22);
    expect(after).toHaveLength(22);
  });

  it('changes exactly the 106 reviewed relation tokens and no other body byte', () => {
    let count = 0;
    for (let i = 0; i < before.length; i += 1) {
      const b = before[i];
      const a = after[i];
      const matches = [...b.body.matchAll(unqualified)].length;
      expect(matches, b.proname).toBe(EXPECTED[b.proname]);
      expect(a.body, b.proname).toBe(qualify(b.body));
      expect([...a.body.matchAll(unqualified)], b.proname).toEqual([]);
      count += matches;
    }
    expect(count).toBe(106);
  });

  it('preserves OID, signature, result, language, security attributes, search_path, owner and ACL', () => {
    const withoutBody = ({ body: _body, ...rest }: any) => rest;
    expect(after.map(withoutBody)).toEqual(before.map(withoutBody));
    expect(after.filter((r) => r.cfg === 'search_path=public')).toHaveLength(5);
    expect(after.filter((r) => r.cfg === 'search_path=public, pg_temp')).toHaveLength(17);
  });

  it('has an empty authorization delta and an empty RLS-policy delta', () => {
    expect(authAfter).toEqual(authBefore);
    expect(policiesAfter).toEqual(policiesBefore);
  });

  it('preserves legitimate permission-helper behavior', () => {
    expect(behaviorAfter).toEqual(behaviorBefore);
    expect(behaviorAfter.allowed).toBe(true);
    expect(behaviorAfter.permissions).toBeTruthy();
  });

  it('preserves the intentionally narrower facility-scope ACL', async () => {
    const { rows } = await rig.asAdmin((c: any) => c.query(`
      SELECT has_function_privilege(
        'authenticated',
        'public.phoenix_admin_assign_facility_scopes(uuid,uuid,uuid[])',
        'EXECUTE') allowed`));
    expect(rows[0].allowed).toBe(false);
  });

  it('fails closed if re-applied; the second run is not a silent no-op', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(SQL_196)).rejects.toThrow(/M196 PRECONDITION: .* body drifted/);
      await c.query('ROLLBACK');
    });
  });
});
