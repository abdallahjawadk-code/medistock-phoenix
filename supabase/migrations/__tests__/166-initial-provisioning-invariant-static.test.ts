/**
 * 166 · INITIAL-PROVISIONING INVARIANT (Stage E · E-4) — static proof.
 *
 * Source-level guards that need no database: registration, the exact object
 * inventory, and — heavily — the NON-GOALS. E-4 adds two flag columns, one
 * CHECK, one partial unique index, one new RPC and one CREATE OR REPLACE, and
 * must change nothing else, so the assertions here are deliberately weighted
 * toward what is ABSENT.
 *
 * Behavioural proof (rules A-G, RBAC, idempotency, E-3 preservation) lives in
 * the sibling *.dynamic.test.ts, which exercises the real objects on a
 * 001->166 rig.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '166_phoenix_initial_provisioning_invariant.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));

/** Statements that run at apply time (function bodies / DO blocks stripped). */
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');

/** Code with SQL line comments removed — absence claims must read code. */
const bare = code.replace(/--[^\n]*/g, '');

describe('166 registration and shape', () => {
  it('is registered exactly once, immediately after 165', () => {
    // Position relative to its predecessor, not "is last": asserting last would
    // force the NEXT subphase to edit this file.
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('165_phoenix_sector_health_center_supply_and_return.sql');
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(code).toContain('166_precondition_failed');
    expect(code).toContain('VERIFY FAILED (166)');
  });

  it('does not edit migration 165 or anything before it', () => {
    // 001-165 are immutable: 166 may DEPEND on their objects but must not
    // redefine them.
    expect(bare).not.toMatch(/CREATE TABLE/);
    expect(bare).not.toMatch(/ALTER TABLE public\.organizations\b/);
    expect(bare).not.toMatch(/ALTER TABLE public\.warehouses\b/);
    expect(bare).not.toMatch(/ALTER TABLE public\.distribution_points\b/);
    expect(bare).not.toMatch(/ALTER TABLE public\.outlet_stock_movements\b/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_assert_direct_/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_create_warehouse_dispatch/);
  });

  it('drops nothing', () => {
    expect(bare).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|FUNCTION|POLICY|TRIGGER)\b/i);
  });
});

describe('166 object inventory is exactly the E-4 set', () => {
  it('alters exactly one table, adding exactly the two flag columns', () => {
    const altered = [...bare.matchAll(/ALTER TABLE (public\.[a-z_]+)/g)].map(m => m[1]);
    expect([...new Set(altered)]).toEqual(['public.warehouse_dispatches']);

    const added = [...bare.matchAll(/ADD COLUMN ([a-z_]+)/g)].map(m => m[1]).sort();
    expect(added).toEqual(['initial_provisioning_consumed_at', 'is_initial_provisioning']);
  });

  it('adds exactly one CHECK constraint', () => {
    const cons = [...bare.matchAll(/ADD CONSTRAINT ([a-z_]+)/g)].map(m => m[1]);
    expect(cons).toEqual(['wd_initial_provisioning_consumed_chk']);
    expect(code).toMatch(
      /CHECK \(initial_provisioning_consumed_at IS NULL OR is_initial_provisioning\)/,
    );
  });

  it('creates exactly one index, and it is UNIQUE and partial', () => {
    const idx = [...bare.matchAll(/CREATE (UNIQUE )?INDEX ([a-z_]+)/g)];
    expect(idx.length).toBe(1);
    expect(idx[0][1]).toBe('UNIQUE ');
    expect(idx[0][2]).toBe('warehouse_dispatches_initial_provisioning_once_uniq');
    expect(code).toMatch(/ON public\.warehouse_dispatches \(destination_distribution_point_id\)/);
    expect(code).toMatch(/WHERE is_initial_provisioning/);
  });

  it('creates exactly one NEW function, the initial-provisioning creator', () => {
    const created = [...bare.matchAll(/CREATE FUNCTION (public\.[a-z_0-9]+)/g)].map(m => m[1]);
    expect(created).toEqual(['public.phoenix_create_initial_provisioning_dispatch']);
  });

  it('replaces exactly one EXISTING function, the 149 receive wrapper', () => {
    const replaced = [...bare.matchAll(/CREATE OR REPLACE FUNCTION (public\.[a-z_0-9]+)/g)]
      .map(m => m[1]);
    expect(replaced).toEqual(['public.phoenix_receive_outlet_dispatch_line']);
  });

  it('leaves the 149 receive DELEGATE untouched', () => {
    // The delegate holds the 326-line implementation and the header FOR UPDATE
    // lock. E-4 must extend the wrapper only.
    expect(bare).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION public\._phoenix_149_delegate_receive_outlet_dispatch_line/,
    );
    expect(bare).not.toMatch(/ALTER FUNCTION public\._phoenix_149_delegate_/);
  });
});

describe('166 non-goals — nothing outside E-4 may appear', () => {
  it('adds no permission key and no role default', () => {
    expect(code).not.toContain('permission_keys');
    expect(code).not.toContain('role_permission_defaults');
  });

  it('changes no RLS policy and no trigger', () => {
    expect(bare).not.toMatch(/CREATE POLICY/);
    expect(bare).not.toMatch(/ALTER POLICY/);
    expect(bare).not.toMatch(/CREATE TRIGGER/);
    expect(bare).not.toMatch(/ROW LEVEL SECURITY/);
  });

  it('performs no business DML at all', () => {
    // The only INSERT in the file is the audit row inside the new RPC's body,
    // which is not an apply-time statement.
    expect(applyTime).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(applyTime).not.toMatch(/\bUPDATE\s+public\./i);
    expect(applyTime).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(bare).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('touches no canonical balance table and creates no parallel ledger', () => {
    expect(bare).not.toMatch(/ALTER TABLE public\.(warehouse_stock|outlet_stock)\b/);
    // The candidate parallel-ledger names are NAMED in the VERIFY block as a
    // non-regression read, so assert on the DDL verb, not on the mention.
    expect(bare).not.toMatch(
      /CREATE TABLE[^;]*(pharmacy_stock|rescue_cart_stock|crash_cabinet_stock|facility_stock)/,
    );
    expect(code).toMatch(/a second balance ledger exists/);
  });

  it('adds no movement type and no reference type', () => {
    // The movement-vocabulary CHECK is NAMED in the VERIFY block, deliberately,
    // as a non-regression READ. What must be absent is any attempt to redefine
    // it, so assert on the DDL verbs rather than on the mere mention.
    expect(bare).not.toMatch(/(ADD|DROP)\s+CONSTRAINT\s+outlet_stock_movements_type_chk/);
    expect(bare).not.toMatch(/(ADD|DROP)\s+CONSTRAINT\s+warehouse_stock_movements_type_chk/);
    expect(bare).not.toMatch(/'replenish_send'|'replenish_receive'/);
    // ...and that the only mention sits inside the verify block's guard.
    expect(code).toMatch(/outlet movement vocabulary changed in E-4/);
  });

  it('does not modify Availability', () => {
    // near_stockout may appear ONLY as the negative assertion proving absence.
    const hits = [...code.matchAll(/near_stockout/g)];
    expect(hits.length).toBe(1);
    expect(code).toMatch(/Availability vocabulary changed/);
    expect(bare).not.toMatch(/ALTER TABLE public\.item_availability\b/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_project_/);
  });

  it('implements no Stage-F patient dispensing', () => {
    expect(sql).not.toMatch(/\bpatient\b/i);
    expect(sql).not.toMatch(/visit_card|patient_chart|dispense_to_patient/i);
  });

  it('leaks nothing from E-5 or later', () => {
    // E-5 replenishment / E-6 reversal objects must not appear as definitions.
    expect(bare).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_replenish_emergency_outlet/);
    expect(bare).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_reverse_outlet_replenishment/);
    expect(bare).not.toMatch(/_phoenix_replenishment_fingerprint_v1/);
    expect(bare).not.toMatch(/CREATE TABLE[^;]*outlet_replenishment_routes/);
  });
});

describe('166 encodes rules A-G in the objects themselves', () => {
  it('rule A — an OPEN lifecycle occupies the index', () => {
    expect(code).toMatch(/status IN \('draft', 'sent', 'partially_accepted'\)/);
  });

  it('rules D and E — no terminal-empty status appears in the index predicate', () => {
    const predicate = code
      .slice(code.indexOf('CREATE UNIQUE INDEX'))
      .slice(0, code.slice(code.indexOf('CREATE UNIQUE INDEX')).indexOf(';'))
      .replace(/--[^\n]*/g, '');
    expect(predicate).not.toMatch(/'rejected'/);
    expect(predicate).not.toMatch(/'cancelled'/);
  });

  it('rule C — consumption keeps the row in the index independently of status', () => {
    expect(code).toMatch(/initial_provisioning_consumed_at IS NOT NULL\s*\n?\s*OR status IN/);
  });

  it('rule F — the stamp is driven by quantity_delta, never by the header', () => {
    const wrapper = bare.slice(
      bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_dispatch_line'),
    );
    const body = wrapper.slice(0, wrapper.indexOf('$$;') + 3);
    expect(body).toMatch(/quantity_delta/);
    // The wrapper body must never consult the ambiguous header status.
    expect(body).not.toMatch(/\bstatus\b/);
  });

  it('rule G — no balance column participates in the invariant', () => {
    const idxStmt = code.slice(code.indexOf('CREATE UNIQUE INDEX'));
    const predicate = idxStmt.slice(0, idxStmt.indexOf(';')).replace(/--[^\n]*/g, '');
    expect(predicate).not.toMatch(/quantity|on_hand|stock/);
  });

  it('the stamp is once-only and never cleared', () => {
    expect(code).toMatch(/SET initial_provisioning_consumed_at = now\(\)/);
    expect(code).toMatch(/AND initial_provisioning_consumed_at IS NULL/);
    // is_initial_provisioning is only ever set true, never reset.
    expect(bare).not.toMatch(/is_initial_provisioning\s*=\s*false/);
  });
});

describe('166 reuses the 070 creator rather than duplicating it', () => {
  it('the new RPC delegates creation and introduces no permission check of its own', () => {
    const fn = bare.slice(
      bare.indexOf('CREATE FUNCTION public.phoenix_create_initial_provisioning_dispatch'),
    );
    const body = fn.slice(0, fn.indexOf('$$;') + 3);
    expect(body).toMatch(/public\.phoenix_create_warehouse_dispatch\(/);
    expect(body).not.toMatch(/phoenix_profile_has_scoped_permission/);
    expect(body).toMatch(/initial_provisioning_already_exists_for_outlet/);
  });

  it('both public entry points keep the REVOKE/GRANT idiom', () => {
    for (const fn of [
      'phoenix_create_initial_provisioning_dispatch',
      'phoenix_receive_outlet_dispatch_line',
    ]) {
      expect(code).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*FROM PUBLIC, anon;`),
      );
      expect(code).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*TO authenticated;`),
      );
    }
  });

  it('both functions are SECURITY DEFINER with a pinned search_path', () => {
    const defs = [...code.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.[a-z_0-9]+\([\s\S]*?AS \$\$/g)];
    expect(defs.length).toBe(2);
    for (const d of defs) {
      expect(d[0]).toContain('SECURITY DEFINER');
      expect(d[0]).toContain('SET search_path = public, pg_temp');
    }
  });
});
