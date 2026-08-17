import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findUnreviewedMigrationFiles } from './helpers/reviewed-migrations';

const MIGRATIONS_DIR = join(__dirname, '..');
const sql = readFileSync(join(MIGRATIONS_DIR, '188_phoenix_public_qr_facility_context.sql'), 'utf8');

/**
 * The EXECUTABLE QR implementation only — everything between `AS $function$`
 * and its closing `$function$;`. Same isolation rationale as the 177 static
 * suite: the migration's own runtime VERIFY block legitimately contains the
 * forbidden expressions as ILIKE patterns in order to REJECT them.
 */
const fnBody = (() => {
  const open = sql.indexOf('AS $function$');
  const close = sql.indexOf('$function$;', open + 1);
  if (open === -1 || close === -1) throw new Error('188: could not isolate the $function$ body');
  return sql.slice(open, close);
})();

const dpBranch = fnBody.slice(
  fnBody.indexOf("WHEN 'distribution_point' THEN"),
  fnBody.indexOf("WHEN 'warehouse' THEN"),
);
const whBranch = fnBody.slice(
  fnBody.indexOf("WHEN 'warehouse' THEN"),
  fnBody.indexOf("WHEN 'local_item' THEN"),
);
const liBranch = fnBody.slice(fnBody.indexOf("WHEN 'local_item' THEN"));

describe('188 · public QR facility context (static)', () => {
  it('exists exactly once, is registered, and is manual-apply-only', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('188_')))
      .toEqual(['188_phoenix_public_qr_facility_context.sql']);
    expect(findUnreviewedMigrationFiles(readdirSync(MIGRATIONS_DIR))).toEqual([]);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });

  it('is LF-only (162 portability contract)', () => {
    expect(sql).not.toContain('\r');
  });

  it('forward-replaces ONLY the one public resolver, same boundary, all three target types', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_public_qr_payload(p_public_id text)');
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
    expect(sql).toContain("WHEN 'distribution_point' THEN");
    expect(sql).toContain("WHEN 'warehouse' THEN");
    expect(sql).toContain("WHEN 'local_item' THEN");
  });

  it('derives facility ancestry structurally: point → warehouse → organization_facilities, active hops only', () => {
    expect(dpBranch).toContain('JOIN public.warehouses w');
    expect(dpBranch).toContain('ON w.id = dp.warehouse_id');
    expect(dpBranch).toContain("AND w.status = 'active'");
    expect(dpBranch).toContain('JOIN public.organization_facilities f');
    expect(dpBranch).toContain('ON f.id = w.facility_id');
    expect(dpBranch).toContain('AND f.organization_id = w.organization_id');
    expect(dpBranch).toContain("AND f.status = 'active'");
    // Organization pin: defense in depth on top of the composite FKs.
    expect(dpBranch).toContain('AND w.organization_id = v_target.organization_id');
  });

  it('derives warehouse-target facility from warehouses.facility_id with the same structural rules', () => {
    expect(whBranch).toContain('JOIN public.organization_facilities f');
    expect(whBranch).toContain('ON f.id = w.facility_id');
    expect(whBranch).toContain('AND f.organization_id = w.organization_id');
    expect(whBranch).toContain("AND f.status = 'active'");
    expect(whBranch).toContain('AND w.organization_id = v_target.organization_id');
  });

  it('emits facility fields on the two physical targets and NEVER on local_item', () => {
    for (const branch of [dpBranch, whBranch]) {
      expect(branch).toContain("'facility_id',v_facility_id");
      expect(branch).toContain("'facility_name',v_facility_name");
      expect(branch).toContain("'facility_name_ar',v_facility_name_ar");
    }
    expect(liBranch).not.toContain('facility');
  });

  it('never infers hierarchy from names — structural IDs and FKs only', () => {
    expect(fnBody).not.toMatch(/name\s+ILIKE\s+'%/i);
    expect(fnBody).not.toMatch(/name_ar\s+ILIKE\s+'%/i);
    expect(fnBody).not.toMatch(/SIMILAR TO/i);
    // Derived fresh per request — no snapshot/copy of facility labels.
    expect(sql).not.toMatch(/ALTER TABLE[^;]*qr_targets/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.qr_targets/i);
  });

  it('takes ancestry from the server only — the single caller input is unchanged', () => {
    expect(sql).toContain('get_public_qr_payload(p_public_id text)');
    for (const param of ['p_organization_id', 'p_facility_id', 'p_warehouse_id', 'p_distribution_point_id']) {
      expect(sql).not.toContain(param);
    }
  });

  it('fails closed on a non-active qr_target, indistinguishably and before the scan side effect', () => {
    expect(fnBody).toContain("IF v_target.status <> 'active' THEN");
    const statusCheck = fnBody.indexOf("v_target.status <> 'active'");
    const scanUpdate = fnBody.indexOf('scan_count = scan_count + 1');
    expect(statusCheck).toBeGreaterThan(-1);
    expect(statusCheck).toBeLessThan(scanUpdate);
    // Same error as a missing target — no new distinguishable oracle.
    const afterCheck = fnBody.slice(statusCheck, statusCheck + 200);
    expect(afterCheck).toContain("'error','TARGET_NOT_FOUND'");
  });

  it('carries the full 177 canonical-stock contract forward verbatim', () => {
    expect(fnBody).toContain('FROM public.outlet_stock s');
    expect(fnBody).toContain('ia.removed_at IS NOT NULL');
    expect(fnBody).not.toContain('ia.quantity');
    expect(fnBody).not.toContain('ia.condition');
    expect(fnBody).toContain('GROUP BY s.material_identity_key');
    expect(fnBody).toContain('GROUP BY s.distribution_point_id,s.material_identity_key');
    expect(fnBody).toContain('HAVING count(DISTINCT c.material_identity_key)=1');
    expect(fnBody).toContain('m.proven_central_item_id IS NULL');
    expect(fnBody).not.toContain('OR coalesce(ia.scientific_name');
    expect(fnBody).not.toContain('central_unit');
    expect(dpBranch).toContain('min(s.unit) AS unit');
    expect(dpBranch).toContain("NULLIF(v.unit,'') AS row_unit");
    expect(liBranch).toContain("'unit',ci.unit,");
    expect(liBranch).toContain("'unit',NULLIF(s.unit,'')");
    expect(fnBody).toContain('scan_count = scan_count + 1');
    expect(fnBody).toContain('last_scanned_at = now()');
  });

  it('preserves public privacy curation — no private field enters the payload', () => {
    for (const key of ['batch_number', 'national_code', 'price', 'trade_name', 'notes',
      'actor_name_snapshot', 'actor_email_snapshot', 'material_identity_key,',
      'internal_batch_reference,']) {
      expect(fnBody).not.toContain(`'${key.replace(/,$/, '')}',`);
    }
  });

  it('stays independent of Migration 187 delegated access and HCM authorization', () => {
    expect(fnBody).not.toMatch(/delegated/i);
    expect(fnBody).not.toContain('phoenix_profile_has_scoped_permission');
    expect(fnBody).not.toContain('profile_delegated_scope_assignments');
    expect(fnBody).not.toContain('_phoenix_profile_has_delegated_scope_v1');
    expect(fnBody).not.toContain('health_center_manager');
    expect(fnBody).not.toContain('phoenix_my_role');
    expect(fnBody).not.toContain('auth.uid');
  });

  it('closes the anonymous token directory exactly once, with the org policies untouched', () => {
    expect(sql).toContain('DROP POLICY qrtk_select_anon ON public.qr_tokens;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.qr_tokens FROM PUBLIC, anon;');
    expect(sql.match(/DROP POLICY/g)).toHaveLength(1);
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/DROP POLICY[^;]*qrtk_select_org/i);
    expect(sql).not.toMatch(/DROP POLICY[^;]*qrt_select_org/i);
    // Never widens: no table grant to anon anywhere.
    expect(sql).not.toMatch(/GRANT[^;]*ON TABLE[^;]*TO[^;]*anon/i);
  });

  it('keeps the three-role EXECUTE convergence and preflight/verify guards', () => {
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.get_public_qr_payload(text) TO anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.get_public_qr_payload(text) TO authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.get_public_qr_payload(text) TO service_role;');
    expect(sql).toContain('$preflight$');
    expect(sql).toContain('$verify$');
    // The runtime guards that protect the new facility contract.
    expect(sql).toContain("v_def NOT ILIKE '%JOIN public.organization_facilities f%'");
    expect(sql).toContain("v_def NOT ILIKE '%f.status = ''active''%'");
    expect(sql).toContain("v_def NOT ILIKE '%v_target.status <> ''active''%'");
    expect(sql).toContain("policyname='qrtk_select_anon'");
    // Carried-forward 177 runtime guards.
    expect(sql).toContain("v_def NOT ILIKE '%GROUP BY s.material_identity_key%'");
    expect(sql).toContain("v_def ILIKE '%OR coalesce(ia.scientific_name%'");
    expect(sql).toContain("v_def NOT ILIKE '%HAVING count(DISTINCT c.material_identity_key)=1%'");
    expect(sql).toContain("v_def ILIKE '%ia.quantity%'");
    expect(sql).toContain("v_def ILIKE '%central_unit%'");
  });

  it('never mutates inventory, catalogue rows, topology tables, or indexes', () => {
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+public\.(?:outlet_stock|item_availability|organization_facilities|warehouses|distribution_points)\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public\.(?:outlet_stock|item_availability|organization_facilities|warehouses|distribution_points)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP)\s+TABLE\b/i);
  });
});
