/**
 * INVENTORY-NETWORK-EXPAND-066-A
 *
 * Static SQL-source tests for migration 066 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 052–065.
 *
 * 066 is the EXPAND step of Expand -> Frontend Migration -> Contract. Its whole
 * value is that it is ADDITIVE: it adds the network model without breaking any
 * screen that exists today.
 *
 * So the most important assertions here are the NEGATIVE ones — that 066 does
 * NOT revoke, NOT forbid `manual`, NOT change the source_kind default, and NOT
 * drop a legacy enum value. Those belong to the contract migration, which may
 * only be authored once the frontend has stopped using the manual path.
 *
 * NOTE ON SCOPE: like 060–065, this file carries NO global ceiling assertion.
 * The reviewed maximum belongs to reviewed-migration-manifest.test.ts alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES, isReviewedMigrationFile } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M066_NAME = '066_phoenix_inventory_network_expand.sql';
const P066 = join(MIGRATIONS_DIR, M066_NAME);
const m066 = readFileSync(P066, 'utf8');

/** Active SQL only: strip `--` comments so prose can never satisfy a check. */
function activeSql(sql: string): string {
  return sql
    .split('\n')
    .map(l => l.replace(/--.*$/, ''))
    .join('\n');
}
const active066 = activeSql(m066);
const norm066 = active066.replace(/\s+/g, ' ').trim();

/** Executable SQL with string literals removed, so RAISE prose cannot match. */
const exec066 = active066.replace(/'(?:[^']|'')*'/g, "''");

// ============================================================================
// Presence and registration
// ============================================================================

describe('Migration 066 exists exactly once and is registered', () => {
  it('066_phoenix_inventory_network_expand.sql exists', () => {
    expect(existsSync(P066)).toBe(true);
  });

  it('is the only file named 066_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('066_'))).toEqual([M066_NAME]);
  });

  it('is registered in the reviewed-migration registry by exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M066_NAME);
    expect(isReviewedMigrationFile(M066_NAME)).toBe(true);
  });

  it('is manual-apply-only and wrapped in exactly one transaction', () => {
    expect(m066).toContain('MANUAL APPLY ONLY');
    expect(m066).toContain('DO NOT use supabase db push');
    expect(m066.match(/^begin;$/gim)).toHaveLength(1);
    expect(m066.match(/^commit;$/gim)).toHaveLength(1);
  });
});

// ============================================================================
// THE POINT OF THE EXPAND STEP: it must not break today's frontend
// ============================================================================

describe('066 is additive and backward compatible', () => {
  it('revokes nothing on any pre-existing object', () => {
    // A single REVOKE on an existing client path would break production screens.
    // The only REVOKEs permitted are on the brand-new table created here.
    const revokes = [...exec066.matchAll(/REVOKE[^;]*;/gi)].map(m => m[0].replace(/\s+/g, ' '));
    for (const r of revokes) {
      expect(r, `unexpected REVOKE on an existing object: ${r}`).toMatch(/warehouse_supply_routes/i);
    }
  });

  it('does not touch the manual availability RPCs', () => {
    for (const fn of [
      'phoenix_upsert_availability',
      'clear_port_availability',
      'phoenix_clean_availability_data',
    ]) {
      expect(exec066, `${fn} must not be re-privileged in the expand step`).not.toMatch(
        new RegExp(`(REVOKE|GRANT)[^;]*${fn}`, 'i'),
      );
    }
  });

  it('asserts the manual path still works after apply', () => {
    // The migration proves its own non-breakingness rather than assuming it.
    expect(norm066).toMatch(/phoenix_upsert_availability lost authenticated EXECUTE/i);
    expect(norm066).toMatch(/clear_port_availability lost authenticated EXECUTE/i);
  });

  it('does not forbid source_kind = manual', () => {
    expect(active066).not.toMatch(/CHECK\s*\(\s*source_kind\s*=\s*'warehouse'\s*\)/i);
  });

  it('does not change the source_kind default', () => {
    expect(active066).not.toMatch(/ALTER COLUMN source_kind SET DEFAULT/i);
    expect(norm066).toMatch(/source_kind default changed\. That belongs to the contract step/i);
  });

  it('drops or renames no existing structure', () => {
    for (const forbidden of [
      /\bDROP\s+TABLE\b/i,
      /\bDROP\s+FUNCTION\b/i,
      /\bDROP\s+COLUMN\b/i,
      /\bDROP\s+INDEX\b/i,
      /\bRENAME\s+TO\b/i,
    ]) {
      expect(active066, `${forbidden} must not appear in an expand migration`).not.toMatch(forbidden);
    }
  });

  it('deletes and truncates nothing', () => {
    expect(active066).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(active066).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('retains every legacy point_type value', () => {
    for (const legacy of ['dispensing', 'storage', 'returns', 'emergency']) {
      expect(norm066, `legacy point_type ${legacy} must survive`).toContain(`'${legacy}'`);
    }
  });

  it('retains every legacy role', () => {
    for (const legacy of ['hospital_admin', 'warehouse_manager', 'point_operator', 'transfer_manager']) {
      expect(norm066, `legacy role ${legacy} must survive`).toContain(`'${legacy}'`);
    }
  });

  it('retains every legacy availability condition', () => {
    for (const legacy of ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired']) {
      expect(norm066, `legacy condition ${legacy} must survive`).toContain(`'${legacy}'`);
    }
  });
});

// ============================================================================
// The network model it adds
// ============================================================================

describe('066 adds the three-level network model', () => {
  it('adds warehouse_kind with central/institution and a compatible default', () => {
    expect(norm066).toMatch(
      /ADD COLUMN IF NOT EXISTS warehouse_kind text NOT NULL DEFAULT 'institution'/i,
    );
    expect(norm066).toMatch(/CHECK \(warehouse_kind IN \('central', 'institution'\)\)/i);
  });

  it('adds exactly the three approved outlet types', () => {
    for (const t of ['pharmacy', 'crash_cabinet', 'rescue_cart']) {
      expect(norm066).toContain(`'${t}'`);
    }
  });

  it('adds no unapproved outlet type', () => {
    // The brief is explicit: no clinic, no generic dispensing_point.
    expect(norm066).not.toMatch(/'clinic'/i);
    expect(norm066).not.toMatch(/'dispensing_point'/i);
  });

  it('adds the two new roles', () => {
    expect(norm066).toContain("'central_warehouse_manager'");
    expect(norm066).toContain("'outlet_officer'");
  });

  it('models supply routing as its own table, not a scalar parent', () => {
    expect(norm066).toMatch(/CREATE TABLE IF NOT EXISTS public\.warehouse_supply_routes/i);
    expect(norm066).toMatch(/source_warehouse_id/i);
    expect(norm066).toMatch(/target_warehouse_id/i);
    expect(norm066).toMatch(/priority/i);
    // A scalar parent_warehouse_id could not express primary + fallback.
    expect(active066).not.toMatch(/parent_warehouse_id/i);
  });

  it('forbids a warehouse supplying itself', () => {
    expect(norm066).toMatch(/CHECK \(source_warehouse_id <> target_warehouse_id\)/i);
  });

  it('enforces central -> institution direction in the database, not by convention', () => {
    // A CHECK cannot query another table, so direction is pinned with a composite
    // FK against warehouses(id, warehouse_kind). This holds against ANY writer,
    // including service_role — it is not merely an application-layer rule.
    expect(norm066).toMatch(/CHECK \(source_warehouse_kind = 'central'\)/i);
    expect(norm066).toMatch(/CHECK \(target_warehouse_kind = 'institution'\)/i);
    expect(norm066).toMatch(
      /FOREIGN KEY \(source_warehouse_id, source_warehouse_kind\) REFERENCES public\.warehouses\(id, warehouse_kind\)/i,
    );
    expect(norm066).toMatch(
      /FOREIGN KEY \(target_warehouse_id, target_warehouse_kind\) REFERENCES public\.warehouses\(id, warehouse_kind\)/i,
    );
    expect(norm066).toMatch(/ADD CONSTRAINT warehouses_id_kind_uniq UNIQUE \(id, warehouse_kind\)/i);
    expect(norm066).toMatch(/supply direction \(central -> institution\) is not enforced by composite FK/i);
  });

  it('allows at most one primary source per institution, with unlimited fallbacks', () => {
    expect(norm066).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_supply_routes_one_primary_per_target ON public\.warehouse_supply_routes \(target_warehouse_id\) WHERE is_active AND priority = 1/i,
    );
    // Fallbacks (priority >= 2) must NOT be constrained to one.
    expect(norm066).toMatch(/CHECK \(priority >= 1\)/i);
    expect(norm066).toMatch(/one-primary-per-institution index is missing/i);
  });

  it('prevents duplicate active routes between the same pair', () => {
    expect(norm066).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_supply_routes_active_pair_uniq ON public\.warehouse_supply_routes \(source_warehouse_id, target_warehouse_id\) WHERE is_active/i,
    );
  });

  it('adds the outlet assignment scope while keeping the legacy scope', () => {
    expect(norm066).toMatch(
      /CHECK \(scope_type IN \('warehouse', 'distribution_point', 'outlet'\)\)/i,
    );
  });

  it('adds unknown and not_stocked availability states', () => {
    expect(norm066).toContain("'unknown'");
    expect(norm066).toContain("'not_stocked'");
  });
});

// ============================================================================
// Security posture of the new surface
// ============================================================================

describe('066 does not widen access', () => {
  it('enables RLS on the new table', () => {
    expect(norm066).toMatch(
      /ALTER TABLE public\.warehouse_supply_routes ENABLE ROW LEVEL SECURITY/i,
    );
  });

  it('gives the new table only SELECT to authenticated, and nothing to anon', () => {
    expect(norm066).toMatch(/GRANT SELECT ON TABLE public\.warehouse_supply_routes TO authenticated/i);
    expect(norm066).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_supply_routes FROM authenticated/i,
    );
    expect(norm066).toMatch(/REVOKE ALL ON TABLE public\.warehouse_supply_routes FROM anon/i);
  });

  it('grants nothing to anon anywhere', () => {
    const grantsToAnon = [...exec066.matchAll(/GRANT[^;]*TO[^;]*\banon\b[^;]*;/gi)];
    expect(grantsToAnon).toEqual([]);
  });

  it('scopes the new policy by organization or super_admin', () => {
    expect(norm066).toMatch(/CREATE POLICY warehouse_supply_routes_select_scoped/i);
    expect(norm066).toMatch(/phoenix_my_org\(\)/i);
    expect(norm066).toMatch(/phoenix_my_role\(\) = 'super_admin'/i);
  });

  it('creates or drops no policy on any pre-existing table', () => {
    const policies = [...exec066.matchAll(/(CREATE|DROP)\s+POLICY[^;]*;/gi)].map(m => m[0]);
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(p, `policy touches an existing table: ${p}`).toMatch(/warehouse_supply_routes/i);
    }
  });

  it('does not enable RBAC enforcement', () => {
    // Checked against executable SQL with literals stripped, so prose inside a
    // RAISE message cannot trip this.
    expect(exec066).not.toMatch(/\benforce(ment)?\b/i);
    expect(exec066).not.toMatch(/\brbac\b/i);
  });

  it('does not weaken RLS anywhere', () => {
    expect(active066).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(active066).not.toMatch(/NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  it('touches no Auth user data', () => {
    expect(active066).not.toMatch(/\bauth\.users\b/i);
  });
});

// ============================================================================
// Role boundaries required by the brief
// ============================================================================

describe('role boundaries', () => {
  it('keeps warehouse_officer at warehouses.view=true and warehouses.manage=false', () => {
    expect(norm066).toMatch(
      /warehouse_officer must keep warehouses\.view=true and warehouses\.manage=false/i,
    );
  });

  it('uses outlets.manage rather than warehouses.manage for outlet control', () => {
    expect(norm066).toMatch(/\('warehouse_officer', 'outlets\.manage', +true\)/i);
  });

  it('denies outlet_officer any sight of warehouse stock', () => {
    expect(norm066).toMatch(/\('outlet_officer', 'warehouse_stock\.view', +false\)/i);
    expect(norm066).toMatch(/outlet_officer must not have warehouse_stock\.view/i);
  });

  it('denies outlet_officer outlet creation', () => {
    expect(norm066).toMatch(/\('outlet_officer', 'outlets\.manage', +false\)/i);
  });

  it('keeps central_warehouse_manager out of platform-wide user administration', () => {
    expect(norm066).toMatch(/\('central_warehouse_manager', 'users\.create', +false\)/i);
    expect(norm066).toMatch(/\('central_warehouse_manager', 'users\.assign_role', +false\)/i);
  });

  it('does not let central_warehouse_manager manage outlets or supply routes', () => {
    expect(norm066).toMatch(/\('central_warehouse_manager', 'outlets\.manage', +false\)/i);
    expect(norm066).toMatch(/\('central_warehouse_manager', 'supply_routes\.manage', +false\)/i);
  });

  it('explicitly denies the new privileged keys to every legacy role', () => {
    // A new permission key must never widen an old role by omission.
    expect(norm066).toMatch(/CROSS JOIN \(VALUES \('central_warehouse\.manage'\)/i);
  });

  it('gives super_admin every key this migration introduces, and asserts it', () => {
    // A new key super_admin lacks would create an unadministrable surface.
    for (const k of [
      'outlets.view', 'outlets.manage', 'outlets.assign_officer',
      'outlet_stock.view', 'outlet_stock.receive', 'outlet_stock.dispense',
      'outlet_stock.return', 'outlet_stock.count',
      'central_warehouse.view', 'central_warehouse.manage',
      'central_warehouse.receive', 'central_warehouse.fulfil',
      'supply_routes.view', 'supply_routes.manage',
      'warehouse_stock.transfer',
    ]) {
      expect(norm066, `super_admin must be granted ${k}`).toContain(`'${k}'`);
    }
    expect(norm066).toMatch(/super_admin is missing at least one newly introduced permission key/i);
  });

  it('reserves supply_routes.manage to super_admin alone', () => {
    expect(norm066).toMatch(/a non-super_admin role was granted supply_routes\.manage by default/i);
  });
});

// ============================================================================
// Idempotency
// ============================================================================

describe('066 is re-runnable without damage', () => {
  it('uses IF NOT EXISTS / ON CONFLICT for every additive write', () => {
    expect(norm066).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    expect(norm066).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    expect(norm066).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/i);
    const inserts = [...exec066.matchAll(/INSERT INTO[^;]*;/gi)].map(m => m[0]);
    expect(inserts.length).toBeGreaterThan(0);
    for (const i of inserts) {
      expect(i, `INSERT without ON CONFLICT: ${i.slice(0, 60)}`).toMatch(/ON CONFLICT/i);
    }
  });

  it('drops constraints with IF EXISTS before re-adding them', () => {
    const dropCons = [...exec066.matchAll(/DROP CONSTRAINT[^;]*/gi)].map(m => m[0]);
    expect(dropCons.length).toBeGreaterThan(0);
    for (const d of dropCons) {
      expect(d).toMatch(/IF EXISTS/i);
    }
  });

  it('never touches the migration history table', () => {
    expect(active066).not.toMatch(/supabase_migrations/i);
  });
});
