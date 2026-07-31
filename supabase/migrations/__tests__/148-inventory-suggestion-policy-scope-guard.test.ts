/**
 * CROSS-ORG-IDOR-148-FIX — static source guard.
 *
 * Pins the exact shape of phoenix_upsert_inventory_suggestion_policy's
 * authorization block so a future edit cannot silently reintroduce the
 * cross-organization IDOR: the previous version authorized on
 * phoenix_profile_has_permission(v_actor, 'inventory.manage_thresholds')
 * ALONE, an org-unaware check that let any actor holding that permission key
 * rewrite ANY organization's policy by supplying an arbitrary
 * p_organization_id.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname, '..', '148_phoenix_transfer_suggestion_draft_bridge.sql',
);
const sql = readFileSync(MIGRATION_PATH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} must exist in ${MIGRATION_PATH}`).toBeGreaterThan(-1);
  const nextFn = sql.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1);
  return sql.slice(start, nextFn > -1 ? nextFn : sql.length);
}

const body = extractFunctionBody('phoenix_upsert_inventory_suggestion_policy');

describe('phoenix_upsert_inventory_suggestion_policy is organization-scoped (CROSS-ORG-IDOR-148-FIX)', () => {
  it('never authorizes on phoenix_profile_has_permission alone (the old unscoped, cross-org gate)', () => {
    // The exact shape of the pre-fix IF block: super_admin OR the bare,
    // org-unaware permission check, and nothing else.
    const oldVulnerableGate =
      /IF NOT \(\s*public\.phoenix_my_role\(\)\s*=\s*'super_admin'\s*OR public\.phoenix_profile_has_permission\(v_actor,\s*'inventory\.manage_thresholds'\)\s*\)\s*THEN/;
    expect(body).not.toMatch(oldVulnerableGate);
  });

  it('routes authorization through the organization-scoped permission check', () => {
    expect(body).toMatch(/phoenix_profile_has_scoped_permission\(\s*v_actor,\s*'inventory\.manage_thresholds',\s*p_organization_id/);
  });

  it('the central_warehouse_manager carve-out (if present) still pins its own organization', () => {
    if (/phoenix_my_role\(\)\s*=\s*'central_warehouse_manager'/.test(body)) {
      expect(body).toMatch(/phoenix_my_role\(\)\s*=\s*'central_warehouse_manager'\s*\n\s*AND public\.phoenix_my_org\(\)\s*=\s*p_organization_id/);
    }
  });

  it('rejects an inactive actor before any authorization branch runs', () => {
    expect(body).toMatch(/SELECT status INTO v_actor_status FROM public\.profiles WHERE id = v_actor/);
    expect(body).toMatch(/v_actor_status IS DISTINCT FROM 'active'/);
  });

  it('rejects a non-existent target organization', () => {
    expect(body).toMatch(/FROM public\.organizations o WHERE o\.id = p_organization_id/);
    expect(body).toMatch(/organization_not_found/);
  });

  it('preserves the function signature, SECURITY DEFINER, and search_path', () => {
    expect(body).toMatch(/phoenix_upsert_inventory_suggestion_policy\(\s*p_organization_id\s+uuid,\s*p_staleness_minutes\s+integer\s*\)/);
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/SET search_path = public, pg_temp/);
  });

  it('preserves the REVOKE/GRANT posture (no PUBLIC or anon execute)', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_upsert_inventory_suggestion_policy\(uuid, integer\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_upsert_inventory_suggestion_policy\(uuid, integer\) TO authenticated;/);
  });
});
