/**
 * 164 · FACILITY IDENTITY + ROUTING FOUNDATION (Stage E · E-2) — static proof.
 *
 * Source-level guards that do not need a database: registration, scope
 * containment, and the explicit NON-GOALS of this subphase. The behavioural
 * proofs live in the sibling *.dynamic.test.ts, which exercises the real
 * objects on a disposable rig.
 *
 * The scope assertions matter as much as the feature assertions: E-2 is the
 * metadata foundation, and a later subphase's DDL appearing here would move
 * stock-affecting change into a PR reviewed as "no stock can move yet".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '164_phoenix_facility_identity_and_routing_foundation.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));

/**
 * The migration with every dollar-quoted block removed — i.e. function bodies
 * and DO blocks stripped, leaving only statements that RUN AT APPLY TIME.
 *
 * This distinction is load-bearing for the no-seed guard below: the facility
 * RPC necessarily contains `INSERT INTO organization_facilities ... VALUES`,
 * because inserting a facility is what it does when a user later calls it. That
 * is not a migration-time seed. Only a top-level INSERT would be.
 */
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');

describe('164 registration and shape', () => {
  it('is registered exactly once in the reviewed-migration registry', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
  });

  it('is the highest reviewed migration', () => {
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(NAME);
  });

  it('is a single transaction', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
  });

  it('states MANUAL APPLY ONLY and forbids the automated runner', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and refuses to re-run', () => {
    expect(code).toContain('164_precondition_failed');
    expect(code).toContain('already_applied');
  });

  it('ends with an in-transaction VERIFY block', () => {
    expect(code).toContain('VERIFY FAILED (164)');
  });
});

describe('164 delivers exactly the E-2 objects', () => {
  it('adds the two new tables', () => {
    expect(code).toMatch(/CREATE TABLE public\.organization_facilities/);
    expect(code).toMatch(/CREATE TABLE public\.outlet_replenishment_routes/);
  });

  it('adds the four classification/link columns', () => {
    expect(code).toMatch(/ALTER TABLE public\.organizations\s+ADD COLUMN institution_class/);
    expect(code).toMatch(/ALTER TABLE public\.warehouses\s+ADD COLUMN facility_id/);
    expect(code).toMatch(/ALTER TABLE public\.distribution_points\s+ADD COLUMN clinical_location_kind/);
  });

  it('adds the FK target key on organizations', () => {
    expect(code).toContain('organizations_id_institution_class_uniq UNIQUE (id, institution_class)');
  });

  it('creates the three planned routines and no other public RPC', () => {
    const created = [...code.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (public\.[a-z_0-9]+)/g)]
      .map(m => m[1]).sort();
    expect(created).toEqual([
      'public._phoenix_outlet_facility_context_v1',
      'public.phoenix_upsert_organization_facility',
      'public.phoenix_upsert_outlet_replenishment_route',
    ]);
  });

  it('registers exactly the four planned permission keys', () => {
    for (const key of [
      'organization_facilities.manage',
      'replenishment_routes.manage',
      'outlet_stock.replenish',
      'outlet_stock.replenish_reverse',
    ]) {
      expect(code).toContain(`'${key}'`);
    }
    expect(code).toContain('ON CONFLICT (key) DO NOTHING');
  });
});

describe('164 vocabularies are closed and correct', () => {
  it('institution_class holds exactly the three top-level classes', () => {
    expect(code).toContain("CHECK (institution_class IN ('hospital', 'specialized_center', 'health_sector'))");
  });

  it('a health centre is never an institution class', () => {
    const chk = code.slice(code.indexOf('organizations_institution_class_chk'));
    const line = chk.slice(0, chk.indexOf(';'));
    expect(line).not.toContain('primary_health_center');
    expect(line).not.toContain('subordinate_health_center');
  });

  it('facility_class holds exactly the two health-centre classes', () => {
    expect(code).toContain("CHECK (facility_class IN ('primary_health_center', 'subordinate_health_center'))");
  });

  it('clinical_location_kind holds exactly emergency | non_emergency', () => {
    expect(code).toContain("CHECK (clinical_location_kind IN ('emergency', 'non_emergency'))");
  });

  it('pins the facility parent to health_sector structurally, not by convention', () => {
    expect(code).toContain("CHECK (parent_institution_class = 'health_sector')");
    expect(code).toMatch(/of_parent_class_fk[\s\S]*REFERENCES public\.organizations \(id, institution_class\)/);
  });

  it('pins the warehouse->facility link to the same organization', () => {
    expect(code).toMatch(/warehouses_facility_org_fk[\s\S]*REFERENCES public\.organization_facilities \(id, organization_id\)/);
  });
});

describe('164 security posture', () => {
  it('enables RLS and denies anon on both new tables', () => {
    expect(code).toContain('ALTER TABLE public.organization_facilities ENABLE ROW LEVEL SECURITY');
    expect(code).toContain('ALTER TABLE public.outlet_replenishment_routes ENABLE ROW LEVEL SECURITY');
    expect(code).toContain('REVOKE ALL ON TABLE public.organization_facilities FROM anon');
    expect(code).toContain('REVOKE ALL ON TABLE public.outlet_replenishment_routes FROM anon');
  });

  it('gives authenticated no direct DML on either new table', () => {
    expect(code).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.organization_facilities FROM authenticated');
    expect(code).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.outlet_replenishment_routes FROM authenticated');
  });

  it('keeps the ownership resolver internal', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\._phoenix_outlet_facility_context_v1\(uuid\)\s*\n?\s*FROM PUBLIC, anon, authenticated/);
  });

  it('every new public RPC is SECURITY DEFINER with a pinned search_path', () => {
    const definers = code.match(/SECURITY DEFINER/g) ?? [];
    expect(definers.length).toBeGreaterThanOrEqual(3);
    const paths = code.match(/SET search_path = public, pg_temp/g) ?? [];
    expect(paths.length).toBeGreaterThanOrEqual(3);
  });

  it('never inspects a name to classify anything', () => {
    expect(code).not.toMatch(/ILIKE/i);
    expect(code).not.toMatch(/similar to/i);
    expect(code).not.toMatch(/name\s+LIKE/i);
  });
});

describe('164 performs no backfill', () => {
  it('never writes a classification onto existing rows', () => {
    expect(code).not.toMatch(/UPDATE public\.organizations[\s\S]{0,200}SET[\s\S]{0,80}institution_class\s*=/);
    expect(code).not.toMatch(/UPDATE public\.warehouses[\s\S]{0,200}SET[\s\S]{0,80}facility_id\s*=/);
    expect(code).not.toMatch(/UPDATE public\.distribution_points[\s\S]{0,200}SET[\s\S]{0,80}clinical_location_kind\s*=/);
  });

  it('never seeds a facility or a route AT APPLY TIME', () => {
    // Function bodies are stripped: an INSERT inside the facility RPC is that
    // RPC doing its job later, not this migration seeding data now.
    expect(applyTime).not.toMatch(/INSERT INTO public\.organization_facilities/);
    expect(applyTime).not.toMatch(/INSERT INTO public\.outlet_replenishment_routes/);
    // The only apply-time INSERTs are the permission registry rows.
    const inserts = [...applyTime.matchAll(/INSERT INTO (public\.[a-z_]+)/g)].map(m => m[1]);
    expect(new Set(inserts)).toEqual(new Set(['public.permission_keys', 'public.role_permission_defaults']));
  });

  it('verifies the no-backfill property in-transaction', () => {
    expect(code).toContain('was backfilled');
    expect(code).toContain('was seeded');
  });
});

describe('164 non-goals — no later-subphase work leaks in', () => {
  it('does not widen the outlet movement vocabulary', () => {
    expect(code).not.toMatch(/'replenish_send'/);
    expect(code).not.toMatch(/'replenish_receive'/);
    expect(code).not.toMatch(/ADD CONSTRAINT outlet_stock_movements_type_chk/);
  });

  it('does not add the replenishment reference-type namespaces', () => {
    expect(code).not.toMatch(/'outlet_replenishment'/);
    expect(code).not.toMatch(/'outlet_replenishment_reversal'/);
  });

  it('does not touch the shared transfer/return endpoint validators', () => {
    expect(code).not.toContain('phoenix_assert_direct_supply_endpoints');
    expect(code).not.toContain('phoenix_assert_direct_return_endpoints');
  });

  it('does not add the initial-provisioning lifecycle', () => {
    expect(code).not.toContain('is_initial_provisioning');
    expect(code).not.toContain('initial_provisioning_consumed_at');
  });

  it('does not create the corridor or reversal RPCs', () => {
    expect(code).not.toContain('phoenix_replenish_emergency_outlet');
    expect(code).not.toContain('phoenix_reverse_outlet_replenishment');
    expect(code).not.toContain('phoenix_outlet_replenishment_reversible_batches');
  });

  it('does not touch crash_cart dispense semantics', () => {
    expect(code).not.toContain('crash_cart');
    expect(code).not.toContain('beneficiary_type');
  });

  it('does not touch Availability', () => {
    expect(applyTime).not.toContain('near_stockout');
    expect(code).not.toMatch(/ALTER TABLE public\.item_availability/);
    expect(code).not.toContain('phoenix_project_outlet_availability');
  });

  it('guards the Availability vocabulary rather than changing it', () => {
    // near_stockout appears exactly once, inside the VERIFY block, as a
    // NEGATIVE assertion that it has not been introduced.
    expect(code).toContain('item_availability condition vocabulary changed');
    expect((code.match(/near_stockout/g) ?? []).length).toBe(1);
  });

  it('does not widen warehouse_kind or reintroduce facility_kind', () => {
    expect(code).not.toMatch(/ADD CONSTRAINT warehouses_warehouse_kind_chk/);
    expect(code).not.toContain('facility_kind text');
    expect(code).toContain('warehouses.facility_kind must not exist');
  });

  it('creates no second balance ledger', () => {
    for (const t of ['pharmacy_stock', 'rescue_cart_stock', 'crash_cabinet_stock', 'facility_stock']) {
      expect(code).not.toMatch(new RegExp(`CREATE TABLE[^;]*${t}`));
    }
  });

  it('alters no stock or movement table', () => {
    for (const t of ['warehouse_stock', 'outlet_stock', 'warehouse_stock_movements',
                     'outlet_stock_movements', 'warehouse_dispatches', 'warehouse_transfers']) {
      expect(code).not.toMatch(new RegExp(`ALTER TABLE public\\.${t}\\b`));
    }
  });

  it('drops nothing that predates it', () => {
    // The only DROPs are the two DROP POLICY IF EXISTS guards for its OWN new
    // policies, which is the established idiom for a re-creatable policy.
    const drops = [...code.matchAll(/^\s*DROP\s+(\w+)/gim)].map(m => m[1].toUpperCase());
    expect(new Set(drops)).toEqual(new Set(['POLICY']));
  });
});
