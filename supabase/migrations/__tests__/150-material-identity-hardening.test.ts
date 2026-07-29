import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const NAME = '150_phoenix_material_identity_fefo_provenance_hardening.sql';
const sql = readFileSync(join(__dirname, '..', NAME), 'utf8');

function body(name: string, next?: string): string {
  const start = sql.indexOf(name);
  const end = next ? sql.indexOf(next, start + name.length) : sql.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('150 canonical material identity — static contract', () => {
  it('is the one reviewed migration at ceiling 150', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('150_'))).toEqual([NAME]);
    expect(sql).toMatch(/^\s*--[\s\S]*\nBEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('publishes an immutable, versioned, inspectable tuple and revokes every client role', () => {
    const helper = body(
      'CREATE FUNCTION public._phoenix_material_identity_v1',
      'REVOKE ALL ON FUNCTION public._phoenix_material_identity_component_v1',
    );
    expect(helper).toContain('IMMUTABLE');
    for (const field of [
      'p_central_item_id',
      'p_scientific_name',
      'p_national_code',
      'p_concentration',
      'p_dosage_form',
      'p_unit',
    ]) expect(helper).toContain(field);
    expect(helper).toContain("'material:v1'");
    expect(helper).not.toMatch(/digest|md5|sha/i);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_material_identity_v1[\s\S]*FROM PUBLIC, anon, authenticated/,
    );
  });

  it('normalizes case and whitespace, treats empty as explicit NULL, and retains snapshots beside catalog identity', () => {
    const component = body(
      'CREATE FUNCTION public._phoenix_material_identity_component_v1',
      'CREATE FUNCTION public._phoenix_material_identity_v1',
    );
    expect(component).toContain("NULLIF(btrim(p_value), '') IS NULL");
    expect(component).toContain("THEN 'N'");
    expect(component).toContain('lower(btrim(p_value))');

    const helper = body(
      'CREATE FUNCTION public._phoenix_material_identity_v1',
      'REVOKE ALL ON FUNCTION public._phoenix_material_identity_component_v1',
    );
    expect(helper).toContain('p_central_item_id::text');
    expect(helper).toContain('p_scientific_name');
    expect(helper).toContain('p_national_code');
    expect(helper).toContain('p_concentration');
    expect(helper).toContain('p_dosage_form');
    expect(helper).toContain('p_unit');
  });

  it('keeps material, lot and provenance identities separate and makes unit material-significant', () => {
    expect(sql).toMatch(/warehouse_stock[\s\S]*material_identity_key text GENERATED ALWAYS/i);
    expect(sql).toMatch(/outlet_stock[\s\S]*material_identity_key text GENERATED ALWAYS/i);
    expect(sql).toMatch(/warehouse_quarantine_stock[\s\S]*material_identity_key text GENERATED ALWAYS/i);
    expect(sql).toMatch(
      /_phoenix_material_identity_v1\([\s\S]*central_item_id,\s*scientific_name,\s*national_code,\s*concentration,\s*dosage_form,\s*unit/,
    );
    for (const index of [
      'warehouse_stock_identity_v150_uniq',
      'outlet_stock_identity_v150_uniq',
      'wqs_identity_v150_uniq',
    ]) {
      expect(sql).toContain(`CREATE UNIQUE INDEX ${index}`);
    }
    expect(sql).toContain('quarantine_reason');
    expect(sql).toContain('COALESCE(internal_batch_reference');
    expect(sql).toContain('COALESCE(supply_type');
    expect(sql).toContain('COALESCE(purchase_origin');
  });

  it('runs a stable collision preflight before replacing indexes and never merges/deletes', () => {
    const preflight = body('DO $collision_preflight$', 'CREATE UNIQUE INDEX warehouse_stock_identity_v150_uniq');
    expect(preflight).toContain('150_material_identity_collision: warehouse_stock');
    expect(preflight).toContain('150_material_identity_collision: outlet_stock');
    expect(preflight).toContain('150_material_identity_collision: warehouse_quarantine_stock');
    expect(preflight).not.toMatch(/\bDELETE\b|\bMERGE\b/i);
    expect(sql.indexOf('DO $collision_preflight$')).toBeLessThan(
      sql.indexOf('DROP INDEX public.warehouse_stock_identity_uniq'),
    );
  });

  it('keeps threshold CRUD/schema intact while applying wildcard policy per resolved variant', () => {
    expect(sql).not.toMatch(/ALTER TABLE public\.inventory_signal_thresholds/i);
    const recompute = body(
      'CREATE OR REPLACE FUNCTION public.phoenix_recompute_inventory_alerts',
      'REVOKE ALL ON FUNCTION public.phoenix_recompute_inventory_alerts',
    );
    expect(recompute).toContain('GROUP BY scope_kind,scope_id,material_identity_key');
    expect(recompute).toContain('(t.national_code IS NULL OR t.national_code=a.national_code)');
    expect(recompute).toContain(
      "ORDER BY (t.scope_id IS NOT NULL) DESC,(t.national_code IS NOT NULL) DESC",
    );
    expect(recompute).toContain("'legacy_unresolved'");
  });

  it('isolates quantity/date alerts and fingerprints an exact lot', () => {
    const recompute = body(
      'CREATE OR REPLACE FUNCTION public.phoenix_recompute_inventory_alerts',
      'REVOKE ALL ON FUNCTION public.phoenix_recompute_inventory_alerts',
    );
    expect(recompute).toContain("|| '|' || a.material_identity_key || '||'");
    expect(recompute).toContain("|| '|stock:' || s.stock_id::text");
    expect(recompute).toContain('GROUP BY scope_kind,scope_id,material_identity_key');
    expect(recompute).not.toContain('GROUP BY scope_kind, scope_id, lower(scientific_name), national_code');
  });

  it('isolates deficits, headroom, batches, commitments and fingerprints', () => {
    const generator = body(
      'CREATE OR REPLACE FUNCTION public.phoenix_suggest_inventory_transfers',
      'CREATE OR REPLACE FUNCTION public.phoenix_suggest_cross_org_inventory_transfer',
    );
    expect(generator).toContain('s.material_identity_key=a.material_identity_key');
    expect(generator).toContain('b.material_identity_key=v_src.material_identity_key');
    expect(generator).toContain('s.material_identity_key=a.material_identity_key');
    expect(generator).toContain("a.material_identity_state='resolved'");
    expect(generator).toContain("v_need.material_identity_key");
  });

  it('fails closed on ambiguous cross-org identity and validates Draft source and line', () => {
    const cross = body(
      'CREATE OR REPLACE FUNCTION public.phoenix_suggest_cross_org_inventory_transfer',
      'ALTER FUNCTION public.phoenix_create_transfer_draft_from_suggestion',
    );
    expect(cross).toContain("RAISE EXCEPTION 'material_identity_ambiguous'");
    expect(cross).toContain('sa.material_identity_key');

    const draft = body(
      'CREATE FUNCTION public.phoenix_create_transfer_draft_from_suggestion',
      'REVOKE ALL ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion',
    );
    expect(draft).toContain("RAISE EXCEPTION 'suggestion_material_identity_unresolved'");
    expect(draft).toContain("RAISE EXCEPTION 'suggestion_source_material_identity_mismatch'");
    expect(draft).toContain("RAISE EXCEPTION 'draft_line_material_identity_mismatch'");
    expect(draft).toContain("set_config('phoenix.material_identity_v1'");
  });

  it('backfills only deterministic legacy rows and keeps ambiguity fail-closed', () => {
    const backfill = body(
      '-- Alerts are mapped only when the live scope has exactly one material identity',
      '-- Material-isolated alert recompute.',
    );
    expect(backfill).toContain('HAVING count(DISTINCT x.material_identity_key) = 1');
    expect(backfill).toContain('x.id = s.source_stock_id');
    expect(backfill).toContain("material_identity_state = 'resolved'");
    expect(backfill).toContain('legacy_unresolved');

    const guard = body(
      'CREATE FUNCTION public._phoenix_inventory_suggestion_identity_guard_v1',
      'DROP TRIGGER IF EXISTS a150_inventory_suggestion_identity_guard',
    );
    expect(guard).toContain("RAISE EXCEPTION 'guard_150_material_identity_unresolved'");
    expect(guard).toContain("NEW.status IN ('open','accepted')");
  });

  it('does not enter the deferred FEFO/return-cap/report/RBAC scopes', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_send_/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_add_dispatch_line/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_review_outlet_return/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_movement_(timeline|ledger_report)/i);
    expect(sql).not.toMatch(/INSERT INTO public\.(permissions|role_permissions)/i);
    for (const fn of [
      body(
        'CREATE OR REPLACE FUNCTION public.phoenix_recompute_inventory_alerts',
        'REVOKE ALL ON FUNCTION public.phoenix_recompute_inventory_alerts',
      ),
      body(
        'CREATE OR REPLACE FUNCTION public.phoenix_suggest_inventory_transfers',
        'CREATE OR REPLACE FUNCTION public.phoenix_suggest_cross_org_inventory_transfer',
      ),
      body(
        'CREATE FUNCTION public.phoenix_create_transfer_draft_from_suggestion',
        'REVOKE ALL ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion',
      ),
    ]) {
      expect(fn).not.toMatch(/INSERT INTO public\.(warehouse|outlet)_stock_movements/i);
    }
  });

  it('preserves public signatures and anon denial in the deployment self-check', () => {
    for (const signature of [
      'phoenix_recompute_inventory_alerts(uuid,text,uuid)',
      'phoenix_suggest_inventory_transfers(uuid)',
      'phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)',
      'phoenix_create_transfer_draft_from_suggestion(uuid,text)',
    ]) expect(sql).toContain(signature);
    expect(sql).toContain('150_verify_failed: anon_execute_regression');
    expect(sql).toContain('150_verify_failed: report_or_rbac_contract_missing');
  });
});
