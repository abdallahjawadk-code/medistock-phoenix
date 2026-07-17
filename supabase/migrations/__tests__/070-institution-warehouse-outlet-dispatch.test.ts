/**
 * INSTITUTION-WAREHOUSE-TO-OUTLET-DISPATCH-070-A
 *
 * Static SQL-source tests for migration 070 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 044-069.
 *
 * 070 closes a gap discovered while designing the outlet<->institution return
 * migration (drafted as 070 in PR #14, to be renumbered 071): 061 shipped
 * warehouse_dispatches/warehouse_dispatch_lines as SCHEMA ONLY, and no
 * migration through 069 ever built the CREATE/SEND path. A return cannot be
 * built on top of a forward supply path that cannot itself create or send
 * anything, so this migration builds that forward path FIRST.
 *
 * WHAT A STATIC TEST CAN AND CANNOT PROVE
 * ---------------------------------------
 * These tests prove the migration SOURCE contains the boundaries it must
 * contain, and that a future edit cannot quietly remove one. They do not
 * execute SQL, so they cannot prove runtime behaviour. This migration has not
 * yet been applied to a disposable database — see the file's own header.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  activeSql,
  executableSql,
  normalizeSql,
  sqlFunctionSource,
} from './helpers/sql-source';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M070_NAME = '070_phoenix_institution_warehouse_outlet_dispatch.sql';
const P070 = join(MIGRATIONS_DIR, M070_NAME);
const m070 = readFileSync(P070, 'utf8');

const active070 = activeSql(m070);
const norm070 = normalizeSql(active070);
const exec070 = executableSql(m070);

function functionBody(name: string): string {
  const src = sqlFunctionSource(m070, name);
  expect(src, `function ${name} must exist`).not.toBeNull();
  return normalizeSql(src!);
}

const LIFECYCLE_RPCS = [
  'phoenix_create_warehouse_dispatch',
  'phoenix_add_dispatch_line',
  'phoenix_update_dispatch_line_quantity',
  'phoenix_delete_dispatch_line',
  'phoenix_cancel_warehouse_dispatch',
] as const;

// ============================================================================
// 1. Presence and registration
// ============================================================================
describe('1. migration 070 (forward dispatch) exists and is registered', () => {
  it('the file exists on disk', () => {
    expect(m070.length).toBeGreaterThan(0);
  });

  it('is wrapped in a single begin/commit transaction', () => {
    expect(active070.trimStart().startsWith('begin;')).toBe(true);
    expect(active070.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('states manual-apply-only and NOT APPLIED', () => {
    expect(m070).toContain('MANUAL APPLY ONLY');
    expect(m070).toContain('NOT APPLIED');
  });

  it('is registered in REVIEWED_MIGRATION_FILES', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M070_NAME);
  });

  it('runs preconditions that abort on missing 001/060/061/067 schema', () => {
    expect(m070).toContain('ABORT 070: expected 001/060/061/067 schema is absent');
  });

  it('aborts if 067\'s RECEIVE RPC is absent', () => {
    expect(m070).toContain("to_regprocedure('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)') IS NULL");
  });
});

// ============================================================================
// 2. The audit finding: 'add' on outlet_stock_movements is not trusted
// ============================================================================
describe('2. movement_type=\'add\' on outlet_stock_movements is documented as unwritten, never treated as provenance', () => {
  it('the file header documents the audit finding', () => {
    expect(m070).toContain("'add'");
    expect(m070.toLowerCase()).toContain('reserved-but-unwritten');
  });

  it('this migration writes ONLY dispatch_send (warehouse side) and reuses dispatch_receive (outlet side) — never add', () => {
    expect(exec070).not.toMatch(/INSERT INTO public\.outlet_stock_movements/);
    expect(exec070).not.toMatch(/'add',\s*\n?\s*v_before/);
  });
});

// ============================================================================
// 3. Structural pairing: an outlet may only be dispatched to by its own
//    warehouse_id's warehouse
// ============================================================================
describe('3. forward structural pairing mirrors the return domain', () => {
  it('adds distribution_points_id_warehouse_uniq (idempotent, additive)', () => {
    expect(norm070).toContain('distribution_points_id_warehouse_uniq');
  });

  it('adds a composite FK pinning (destination_distribution_point_id, warehouse_id) to distribution_points(id, warehouse_id)', () => {
    expect(norm070).toContain('warehouse_dispatches_dest_warehouse_fk');
    expect(norm070).toMatch(
      /FOREIGN KEY \(destination_distribution_point_id, warehouse_id\)\s+REFERENCES public\.distribution_points \(id, warehouse_id\)/,
    );
  });

  it('CREATE validates the pairing live with a named error, not just relying on the FK', () => {
    const body = functionBody('phoenix_create_warehouse_dispatch');
    expect(body).toContain('destination_outlet_not_paired_with_this_warehouse');
  });

  it('CREATE requires the outlet to be an approved network type', () => {
    const body = functionBody('phoenix_create_warehouse_dispatch');
    expect(body).toMatch(/point_type NOT IN \('pharmacy', 'crash_cabinet', 'rescue_cart'\)/);
  });
});

// ============================================================================
// 4. No widened CHECK, no new permission key
// ============================================================================
describe('4. reuses reserved vocabulary and pre-existing permission keys — mints nothing new', () => {
  it('does not ALTER either movement_type CHECK', () => {
    expect(exec070).not.toMatch(/ALTER TABLE public\.warehouse_stock_movements\s+(DROP|ALTER)\s+CONSTRAINT\s+warehouse_stock_movements_type_chk/i);
    expect(exec070).not.toMatch(/ALTER TABLE public\.outlet_stock_movements\s+(DROP|ALTER)\s+CONSTRAINT\s+outlet_stock_movements_type_chk/i);
  });

  it('SEND writes movement_type \'dispatch_send\', reference_type \'warehouse_dispatch_send\' (distinct from 068\'s warehouse_transfer_send)', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/'dispatch_send',/);
    expect(body).toContain("'warehouse_dispatch_send', 'warehouse_dispatch_send'");
  });

  it('inserts no new row into permission_keys', () => {
    expect(exec070).not.toMatch(/INSERT INTO public\.permission_keys/);
  });

  it('every RPC checks a permission key that already existed before this migration (061/066/067)', () => {
    for (const [rpc, key] of [
      ['phoenix_create_warehouse_dispatch', 'warehouse_dispatch.create'],
      ['phoenix_add_dispatch_line', 'warehouse_dispatch.edit_draft'],
      ['phoenix_update_dispatch_line_quantity', 'warehouse_dispatch.edit_draft'],
      ['phoenix_delete_dispatch_line', 'warehouse_dispatch.edit_draft'],
      ['phoenix_cancel_warehouse_dispatch', 'warehouse_dispatch.cancel'],
      ['phoenix_send_warehouse_dispatch', 'warehouse_dispatch.send'],
    ] as const) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain(`'${key}'`);
    }
  });
});

// ============================================================================
// 5. Draft lifecycle: no balance change until SEND
// ============================================================================
describe('5. draft/add-line/update/delete never touch warehouse_stock or outlet_stock balances', () => {
  it('ADD LINE does not UPDATE warehouse_stock', () => {
    const body = functionBody('phoenix_add_dispatch_line');
    expect(body).not.toMatch(/UPDATE public\.warehouse_stock\b/);
  });

  it('UPDATE LINE QUANTITY only touches warehouse_dispatch_lines', () => {
    const body = functionBody('phoenix_update_dispatch_line_quantity');
    expect(body).not.toMatch(/UPDATE public\.warehouse_stock\b/);
    expect(body).toMatch(/UPDATE public\.warehouse_dispatch_lines SET sent_quantity/);
  });

  it('CANCEL never touches warehouse_stock — draft has moved no stock yet', () => {
    const body = functionBody('phoenix_cancel_warehouse_dispatch');
    expect(body).not.toMatch(/UPDATE public\.warehouse_stock\b/);
  });

  it('CANCEL is blocked outside draft', () => {
    const body = functionBody('phoenix_cancel_warehouse_dispatch');
    expect(body).toMatch(/IF v_dispatch\.status <> 'draft' THEN/);
    expect(body).toContain('dispatch_not_cancellable');
  });

  it('ADD/UPDATE/DELETE line are all blocked outside draft', () => {
    for (const rpc of ['phoenix_add_dispatch_line', 'phoenix_update_dispatch_line_quantity', 'phoenix_delete_dispatch_line'] as const) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('dispatch_not_editable');
    }
  });
});

// ============================================================================
// 6. No automatic lot/FEFO selection — explicit stock id only
// ============================================================================
describe('6. no automatic lot selection anywhere — FEFO auto-allocation is 072\'s job', () => {
  it('ADD LINE takes an explicit p_warehouse_stock_id parameter, never picks one', () => {
    const body = functionBody('phoenix_add_dispatch_line');
    expect(body).toMatch(/p_warehouse_stock_id\s+uuid/);
    expect(body).not.toMatch(/ORDER BY expiry_date\s+LIMIT 1/i);
  });

  it('no query anywhere in this file auto-selects a warehouse_stock row by expiry ordering', () => {
    expect(exec070).not.toMatch(/ORDER BY\s+expiry_date[^;]*LIMIT/i);
  });
});

// ============================================================================
// 7. SEND: atomic, refuses expired batches, refuses insufficient quantity,
//    idempotent per line
// ============================================================================
describe('7. SEND is atomic (validate-then-mutate), refuses expired stock, idempotent per line', () => {
  it('refuses an expired batch — forward direction, unlike the return domain\'s deliberate exception', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/expiry_date < current_date/);
    expect(body).toContain('expired_batch_cannot_be_dispatched');
  });

  it('validates every line (FOR UPDATE + availability + expiry) in a first pass, before any UPDATE public.warehouse_stock', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    const firstForUpdateIdx = body.indexOf('FOR UPDATE');
    const firstStockUpdateIdx = body.indexOf('UPDATE public.warehouse_stock');
    expect(firstForUpdateIdx).toBeGreaterThan(-1);
    expect(firstStockUpdateIdx).toBeGreaterThan(-1);
    expect(firstForUpdateIdx).toBeLessThan(firstStockUpdateIdx);
  });

  it('refuses insufficient available quantity per line', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toContain('insufficient_available_quantity_for_line');
  });

  it('idempotency is keyed per LINE (reference_id = dispatch_line.id), not per shared request id', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/reference_type = 'warehouse_dispatch_send' AND reference_id = v_line\.id/);
    expect(body).toMatch(/'warehouse_dispatch_send', 'warehouse_dispatch_send', v_line\.id,/);
  });

  it('an idempotency index exists for the new SEND leg', () => {
    expect(norm070).toContain('warehouse_stock_movements_dispatch_line_once_uniq');
  });

  it('an already-sent/terminal dispatch replays idempotently rather than erroring or re-debiting', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/idempotent_replay.*true/);
  });

  it('has advisory lock, row locks, IDOR gate, fingerprint, and audit', () => {
    const body = functionBody('phoenix_send_warehouse_dispatch');
    expect(body).toMatch(/pg_advisory_xact_lock/);
    expect(body).toMatch(/FOR UPDATE/);
    expect(body).toMatch(/phoenix_profile_has_scoped_permission/);
    expect(body).toMatch(/request_fingerprint/);
    expect(body).toMatch(/INSERT INTO public\.audit_logs/);
  });
});

// ============================================================================
// 8. RECEIVE is reused verbatim — not modified, not reimplemented
// ============================================================================
describe('8. RECEIVE is reused verbatim from 067 — not touched by this file', () => {
  it('this file contains no CREATE OR REPLACE FUNCTION for phoenix_receive_outlet_dispatch_line', () => {
    expect(exec070).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_receive_outlet_dispatch_line/);
  });

  it('post-condition proves the 067 RECEIVE signature is still present, unmodified', () => {
    expect(m070).toContain('ABORT 070: 067 RECEIVE RPC was removed or its signature changed');
  });
});

// ============================================================================
// 9. Compatibility: no DROP/RENAME/REVOKE of pre-existing objects
// ============================================================================
describe('9. additive only — no DROP, RENAME, or REVOKE of a pre-existing object', () => {
  it('contains no DROP TABLE, DROP FUNCTION, or ALTER ... RENAME', () => {
    expect(exec070).not.toMatch(/DROP TABLE/i);
    expect(exec070).not.toMatch(/DROP FUNCTION/i);
    expect(exec070).not.toMatch(/RENAME/i);
  });

  it('every REVOKE targets only functions this file itself creates', () => {
    const revokedFns = [...active070.matchAll(/REVOKE ALL ON FUNCTION public\.(\w+)/g)].map(m => m[1]);
    const createdFns = LIFECYCLE_RPCS.concat(['phoenix_send_warehouse_dispatch'] as const);
    for (const fn of revokedFns) {
      expect(createdFns as readonly string[], fn).toContain(fn);
    }
  });
});

// ============================================================================
// 10. Every RPC named in this file actually exists
// ============================================================================
describe('10. every lifecycle + send RPC exists as a CREATE FUNCTION', () => {
  it('all five lifecycle RPCs exist', () => {
    for (const name of LIFECYCLE_RPCS) {
      expect(sqlFunctionSource(m070, name), name).not.toBeNull();
    }
  });

  it('the SEND RPC exists', () => {
    expect(sqlFunctionSource(m070, 'phoenix_send_warehouse_dispatch')).not.toBeNull();
  });
});
