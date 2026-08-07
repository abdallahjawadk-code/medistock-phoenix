/**
 * 165 · SECTOR ↔ HEALTH-CENTRE SUPPLY AND RETURN (Stage E · E-3) — static proof.
 *
 * Source-level guards that need no database: registration, and — mostly — the
 * NON-GOALS. E-3 widens two security predicates and must change nothing else,
 * so the assertions here are deliberately weighted toward what is ABSENT.
 *
 * Behavioural proof lives in the sibling *.dynamic.test.ts, which exercises
 * both replaced validators and every rejection case on a real 001->165 rig.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '165_phoenix_sector_health_center_supply_and_return.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));

/** Statements that run at apply time (function bodies / DO blocks stripped). */
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');

describe('165 registration and shape', () => {
  it('is registered exactly once, immediately after 164', () => {
    // Position relative to its predecessor, not "is last": asserting last would
    // force the NEXT subphase to edit this file.
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('164_phoenix_facility_identity_and_routing_foundation.sql');
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(code).toContain('165_precondition_failed');
    expect(code).toContain('VERIFY FAILED (165)');
  });

  it('does not edit migration 164 or anything before it', () => {
    // 164 is immutable: 165 may DEPEND on its objects but must not redefine them.
    expect(code).not.toMatch(/CREATE TABLE[^;]*organization_facilities/);
    expect(code).not.toMatch(/CREATE TABLE[^;]*outlet_replenishment_routes/);
    expect(code).not.toMatch(/ALTER TABLE public\.organizations/);
    expect(code).not.toMatch(/ALTER TABLE public\.warehouses/);
    expect(code).not.toMatch(/ALTER TABLE public\.distribution_points/);
  });
});

describe('165 replaces exactly the two endpoint validators', () => {
  it('contains exactly two CREATE OR REPLACE FUNCTION statements', () => {
    const created = [...code.matchAll(/CREATE OR REPLACE FUNCTION (public\.[a-z_0-9]+)/g)]
      .map(m => m[1]).sort();
    expect(created).toEqual([
      'public.phoenix_assert_direct_return_endpoints',
      'public.phoenix_assert_direct_supply_endpoints',
    ]);
  });

  it('creates no NEW function, table, column, index or constraint', () => {
    expect(code).not.toMatch(/CREATE FUNCTION /);
    expect(code).not.toMatch(/CREATE TABLE /);
    expect(code).not.toMatch(/CREATE (UNIQUE )?INDEX /);
    expect(code).not.toMatch(/ADD COLUMN /);
    expect(code).not.toMatch(/ADD CONSTRAINT /);
    expect(code).not.toMatch(/CREATE TRIGGER /);
    expect(code).not.toMatch(/CREATE POLICY /);
  });

  it('adds no permission key and no role default', () => {
    expect(code).not.toContain('permission_keys');
    expect(code).not.toContain('role_permission_defaults');
  });

  it('performs no DML at all', () => {
    expect(applyTime).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(applyTime).not.toMatch(/\bUPDATE\s+public\./i);
    expect(applyTime).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('drops nothing', () => {
    expect(code).not.toMatch(/^\s*DROP\s/im);
  });
});

describe('165 preserves the existing central corridors', () => {
  it('keeps every Branch A error identifier on the forward validator', () => {
    for (const id of [
      'source_must_be_active_central_warehouse',
      'destination_must_be_active_institution_warehouse',
      'destination_warehouse_not_in_named_organization',
      'source_and_destination_required',
      'source_and_destination_must_differ',
      'source_warehouse_not_found',
      'destination_warehouse_not_found',
    ]) {
      expect(code).toContain(id);
    }
  });

  it('keeps every Branch A error identifier on the return validator', () => {
    for (const id of [
      'source_must_be_active_institution_warehouse',
      'destination_must_be_active_central_warehouse',
      'no_direct_forward_provenance_between_warehouses',
    ]) {
      expect(code).toContain(id);
    }
  });

  it('keeps the unchanged provenance test shape for returns', () => {
    expect(code).toContain('tr.route_id IS NULL');
    expect(code).toContain('tr.source_warehouse_id = p_central_warehouse_id');
    expect(code).toContain('tr.destination_warehouse_id = p_institution_warehouse_id');
  });

  it('does NOT rename the legacy return parameters', () => {
    // CREATE OR REPLACE cannot rename parameters and every caller selects the
    // OUT columns by name; renaming would need a DROP that cascades.
    expect(code).toContain('p_institution_warehouse_id uuid');
    expect(code).toContain('p_central_warehouse_id     uuid');
    expect(code).toContain('OUT o_institution_organization_id uuid');
    expect(code).toContain('OUT o_central_organization_id     uuid');
    expect(code).toContain('OUT o_source_organization_id      uuid');
    expect(code).toContain('OUT o_destination_organization_id uuid');
  });

  it('asserts both signatures are unchanged in its own VERIFY block', () => {
    expect(code).toContain('forward validator signature changed');
    expect(code).toContain('return validator signature changed');
    expect(code).toContain('Branch A error identifiers lost');
  });

  it('keeps both validators SECURITY DEFINER with a pinned search_path', () => {
    expect((code.match(/SECURITY DEFINER/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((code.match(/SET search_path = public, pg_temp/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('165 new branches are facility-pinned, never a same-org shortcut', () => {
  it('pins facility_id on BOTH endpoints of each new branch', () => {
    expect((code.match(/facility_id IS NULL/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((code.match(/facility_id IS NOT NULL/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('requires health_sector on the owning organization', () => {
    expect((code.match(/'health_sector'/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('requires an ACTIVE facility of a health-centre class', () => {
    expect((code.match(/'primary_health_center', 'subordinate_health_center'/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
    expect(code).toContain('health_center_facility_not_active');
  });

  it('never inspects a name', () => {
    expect(code).not.toMatch(/ILIKE/i);
    expect(code).not.toMatch(/SIMILAR TO/i);
    expect(code).not.toMatch(/\bname\s*(=|LIKE|~)/i);
  });

  it('never uses same-organization as a branch condition on its own', () => {
    // Deliberately NOT a phrase search: this migration's own header and
    // COMMENT ON both NAME the forbidden predicate in order to rule it out, so
    // matching the phrase would test the documentation, not the code.
    //
    // The real property is structural — every same-organization comparison
    // belongs to a branch whose shape test ALSO pins facility_id on both
    // endpoints. Each new branch's IF condition is asserted whole below, which
    // is what makes a lone same-org shortcut impossible.
    const forwardShape =
      /v_src\.warehouse_kind = 'institution'[\s\S]{0,400}?v_src\.facility_id IS NULL[\s\S]{0,200}?v_dst\.facility_id IS NOT NULL[\s\S]{0,200}?v_src\.organization_id = v_dst\.organization_id/;
    const returnShape =
      /v_inst\.warehouse_kind = 'institution'[\s\S]{0,400}?v_inst\.facility_id IS NOT NULL[\s\S]{0,200}?v_cent\.facility_id IS NULL[\s\S]{0,200}?v_inst\.organization_id = v_cent\.organization_id/;

    expect(code).toMatch(forwardShape);
    expect(code).toMatch(returnShape);

    // And every same-org comparison in the file is one of exactly those two.
    const orgEq = [...code.matchAll(/v_\w+\.organization_id\s*=\s*v_\w+\.organization_id/g)];
    expect(orgEq).toHaveLength(2);
  });

  it('verifies its own facility-pinning in the VERIFY block', () => {
    expect(code).toContain('is not facility-pinned');
  });
});

describe('165 non-goals — no later-subphase work leaks in', () => {
  it('does not touch the outlet movement vocabulary', () => {
    expect(code).not.toMatch(/'replenish_send'/);
    expect(code).not.toMatch(/'replenish_receive'/);
    expect(code).not.toMatch(/ADD CONSTRAINT outlet_stock_movements_type_chk/);
  });

  it('does not add the initial-provisioning lifecycle', () => {
    expect(code).not.toContain('is_initial_provisioning');
    expect(code).not.toContain('initial_provisioning_consumed_at');
  });

  it('does not create the corridor, reversal or route RPCs', () => {
    expect(code).not.toContain('phoenix_replenish_emergency_outlet');
    expect(code).not.toContain('phoenix_reverse_outlet_replenishment');
    expect(code).not.toContain('phoenix_outlet_replenishment_reversible_batches');
    expect(code).not.toContain('phoenix_upsert_outlet_replenishment_route');
  });

  it('does not touch crash_cart or Stage-F dispense semantics', () => {
    expect(code).not.toContain('crash_cart');
    expect(code).not.toContain('beneficiary_type');
    expect(code).not.toContain('patient');
  });

  it('does not touch Availability', () => {
    expect(applyTime).not.toContain('near_stockout');
    expect(code).not.toMatch(/ALTER TABLE public\.item_availability/);
    expect(code).not.toContain('phoenix_project_outlet_availability');
  });

  it('does not widen warehouse_kind or reintroduce facility_kind', () => {
    expect(code).not.toMatch(/ADD CONSTRAINT warehouses_warehouse_kind_chk/);
    expect(code).not.toContain('facility_kind text');
    expect(code).toContain('warehouse_kind was widened');
  });

  it('creates no second balance ledger and alters no stock table', () => {
    for (const t of ['pharmacy_stock', 'rescue_cart_stock', 'crash_cabinet_stock', 'facility_stock']) {
      expect(code).not.toMatch(new RegExp(`CREATE TABLE[^;]*${t}`));
    }
    for (const t of ['warehouse_stock', 'outlet_stock', 'outlet_stock_movements',
                     'warehouse_stock_movements', 'warehouse_dispatches']) {
      expect(code).not.toMatch(new RegExp(`ALTER TABLE public\\.${t}\\b`));
    }
  });

  it('does not touch supply provenance vocabulary', () => {
    expect(code).not.toMatch(/'kimadia'/);
    expect(code).not.toMatch(/ADD CONSTRAINT[^;]*purchase_origin/);
  });
});
