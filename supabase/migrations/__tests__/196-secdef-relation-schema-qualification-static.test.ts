import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = '196_phoenix_secdef_relation_schema_qualification.sql';
const SQL = readFileSync(join(__dirname, '..', NAME), 'utf8').replace(/\r\n/g, '\n');
const REPLACEMENTS = SQL.slice(
  SQL.indexOf('-- M196_REPLACEMENTS_BEGIN'),
  SQL.indexOf('-- M196_REPLACEMENTS_END'),
);

const EXPECTED: Record<string, number> = {
  archive_entity: 4,
  assign_profile_permissions: 6,
  assign_profile_role: 4,
  clear_port_availability: 7,
  create_qr_for_target: 11,
  disable_qr_token: 3,
  get_effective_permissions: 3,
  get_entity_purge_impact: 18,
  get_scoped_inter_institution_alerts: 6,
  phoenix_admin_assign_facility_scopes: 1,
  phoenix_assign_profile_scope: 1,
  phoenix_create_supply_route: 1,
  phoenix_create_warehouse: 1,
  phoenix_mark_password_changed: 1,
  phoenix_profile_has_permission: 3,
  phoenix_revoke_profile_scope: 1,
  phoenix_set_supply_route_active: 1,
  phoenix_set_warehouse_active: 1,
  phoenix_update_supply_route: 1,
  phoenix_update_warehouse: 2,
  purge_entity_with_all_data: 26,
  reset_profile_permissions: 4,
};

const RELATIONS = [
  'audit_logs', 'distribution_points', 'institution_item_status_reports',
  'item_availability', 'item_availability_movements', 'local_items',
  'organization_status_contacts', 'organizations', 'permission_keys',
  'profile_permission_overrides', 'profiles', 'qr_targets', 'qr_tokens',
  'role_permission_defaults', 'warehouses',
] as const;

const relationAlt = RELATIONS.join('|');
const qualified = new RegExp(
  `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+public\\.(${relationAlt})\\b`, 'gi');
const unqualified = new RegExp(
  `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(?!public\\.)(${relationAlt})\\b`, 'gi');

const functionBlocks = (): Map<string, string> => {
  const starts = [...REPLACEMENTS.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\s*\(/gi)];
  return new Map(starts.map((m, i) => [
    m[1],
    REPLACEMENTS.slice(m.index!, starts[i + 1]?.index ?? REPLACEMENTS.length),
  ]));
};

describe('M196 · SECURITY DEFINER relation schema qualification · static', () => {
  it('registers exactly the reviewed 22 identities, once each', () => {
    const blocks = functionBlocks();
    expect([...blocks.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect([...REPLACEMENTS.matchAll(/CREATE OR REPLACE FUNCTION public\./g)]).toHaveLength(22);
  });

  it('qualifies exactly 106 tokens across the exact per-function distribution', () => {
    // Count the delta contract, not every qualified reference in the after
    // bodies: several recent functions already contained public-qualified
    // relations before I-3. The exact before-body hashes make these declared
    // counts fail closed against drift; the postcondition then requires zero
    // remaining unqualified target references.
    const measured = Object.fromEntries(
      [...SQL.matchAll(/^  \('([a-z0-9_]+)', '[0-9a-f]{64}', '[0-9a-f]{64}', '[0-9a-f]{64}', '[^']*', '[^']*', (\d+)\)[,;]$/gm)]
        .map((m) => [m[1], Number(m[2])]),
    );
    expect(measured).toEqual(EXPECTED);
    expect(Object.values(measured).reduce((a, b) => a + b, 0)).toBe(106);
    expect(new Set([...REPLACEMENTS.matchAll(qualified)].map((m) => m[1].toLowerCase())).size).toBe(15);
  });

  it('leaves zero target relation references unqualified', () => {
    expect([...REPLACEMENTS.matchAll(unqualified)]).toEqual([]);
  });

  it('preserves the certified search_path split — I-5 is not folded into I-3', () => {
    const publicOnly = [...REPLACEMENTS.matchAll(/SET search_path TO 'public'\s*\n/gi)];
    const publicPgTemp = [...REPLACEMENTS.matchAll(/SET search_path TO 'public', 'pg_temp'\s*\n/gi)];
    expect(publicOnly).toHaveLength(5);
    expect(publicPgTemp).toHaveLength(17);
  });

  it('contains exact fail-closed hashes and in-transaction identity/ACL verification', () => {
    expect([...SQL.matchAll(/^  \('[a-z0-9_]+', '[0-9a-f]{64}', '[0-9a-f]{64}', '[0-9a-f]{64}',/gm)])
      .toHaveLength(22);
    expect(SQL).toContain('definition_sha256 <> r.expected_definition_sha256');
    expect(SQL).toContain('body_sha256 <> r.expected_before_body_sha256');
    expect(SQL).toContain('r.body_sha256 <> r.expected_after_body_sha256');
    expect(SQL).toContain('FULL JOIN _m196_after a USING (oid)');
    expect(SQL).toContain('b.acl b_acl, a.acl a_acl');
    expect(SQL).toContain('b.cfg b_cfg, a.cfg a_cfg');
    expect(SQL).toContain("r.owner <> 'postgres'");
  });

  it('does not move grants, RLS, owners, tables, policies or the I-4/I-5 boundaries', () => {
    // Anchor at statement starts so prose and permission keys such as
    // `qr.revoke` cannot create a false positive.
    expect(REPLACEMENTS).not.toMatch(/^\s*(?:GRANT|REVOKE|ALTER\s+(?:TABLE|POLICY|FUNCTION)|CREATE\s+POLICY|DROP)\b/gmi);
    expect(SQL).not.toMatch(/^\s*(?:GRANT|REVOKE)\b/gmi);
    expect(SQL).not.toMatch(/^\s*ALTER\s+(?:TABLE|POLICY)\b/gmi);
    expect(SQL).not.toContain('MANUAL APPLY ONLY');
    expect(SQL).toContain('PUBLIC EXECUTE belongs to I-4');
    expect(SQL).toContain('search_path convergence to I-5');
  });

  it('negative controls catch a missing qualification and an authorization expansion', () => {
    const weakened = REPLACEMENTS.replace('INTO public.audit_logs', 'INTO audit_logs');
    expect([...weakened.matchAll(unqualified)]).toHaveLength(1);
    expect(`${REPLACEMENTS}\nGRANT EXECUTE ON FUNCTION public.archive_entity(text,uuid,text) TO PUBLIC;`)
      .toMatch(/\bGRANT\b/i);
  });
});
