import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '../199_phoenix_command_center_read_contract.sql'),
  'utf8',
);

describe('199 command center read contract — static', () => {
  it('creates one additive SECURITY DEFINER read boundary with hardened search_path', () => {
    expect(sql).toContain('CREATE FUNCTION public.phoenix_command_center_read_contract');
    expect(sql).toMatch(/SECURITY DEFINER[\s\S]*SET search_path = public, pg_temp/);
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE|TRUNCATE|DELETE FROM|UPDATE public\.|INSERT INTO public\./);
  });

  it('derives actor server-side and enforces dashboard.view through the canonical scoped helper', () => {
    expect(sql).toContain('v_actor uuid := auth.uid()');
    expect(sql).toContain('public.phoenix_profile_has_scoped_permission');
    expect(sql).toContain("'dashboard.view'");
    expect(sql).toContain("ERRCODE = '42501'");
  });

  it('does not seed roles, alias roles, or widen dashboard permissions', () => {
    expect(sql).not.toMatch(/role_permission_defaults/);
    expect(sql).not.toMatch(/profile_permission_overrides/);
    expect(sql).not.toMatch(/LEGACY_TO_OFFICIAL/);
    expect(sql).not.toMatch(/GRANT\s+.*dashboard\.view/i);
  });

  it('keeps global organization counts super-only and exact-scope summaries bounded', () => {
    expect(sql).toContain("v_role = 'super_admin' AND p_organization_id IS NULL");
    expect(sql).toContain("v_scope_kind := 'warehouse'");
    expect(sql).toContain("v_scope_kind := 'distribution_point'");
    expect(sql).toContain("ELSE 1::bigint END");
    expect(sql).toContain('ws.warehouse_id = p_warehouse_id');
    expect(sql).toContain('os.distribution_point_id = p_distribution_point_id');
  });

  it('pins the existing 270-day near-expiry policy and explicitly defers trend work', () => {
    expect(sql).toContain('current_date + 270');
    expect(sql).toContain("'near_expiry_days', 270");
    expect(sql).toContain("'trend_status', 'deferred_pending_measurement'");
  });

  it('revokes PUBLIC/anon execute and grants authenticated only', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_command_center_read_contract\(uuid,uuid,uuid\)[\s\S]*FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_command_center_read_contract\(uuid,uuid,uuid\)[\s\S]*TO authenticated;/);
  });
});
