/**
 * 180 · EMERGENCY-OUTLET INITIAL-PROVISIONING AUTHORITY BOUNDARY (R1.2)
 * — static proof.
 *
 * Source-level guards that need no database: registration, the exact object
 * inventory, and — heavily — the NON-GOALS. 180 adds ONE internal function and
 * replaces TWO existing public writers. It must create no table, column,
 * constraint, index, policy, trigger, permission key or data, and must not edit
 * migration 166 or 179.
 *
 * The behavioural proof (the A-O matrix, concurrency, RBAC, preservation) lives
 * in the sibling *.dynamic.test.ts, and the pre-180 bypass it closes is
 * reproduced on a real 001->179 rig in
 * 180-pre180-emergency-dispatch-bypass.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '180_phoenix_emergency_initial_provisioning_boundary.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));

/** Statements that run at apply time (function bodies / DO blocks stripped). */
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');

/** Code with SQL line comments removed — absence claims must read code. */
const bare = activeSql(code);

/**
 * Apply-time DDL only, comments stripped.
 *
 * Absence claims about what this migration CREATES, and about which parameters
 * exist, must read this rather than `bare`: the preflight and verify DO blocks
 * legitimately NAME the things they rule out (`CREATE UNIQUE INDEX`,
 * `p_is_initial`, `p_mode`, …) while asserting their absence, so searching the
 * whole file would test the guards instead of the schema change. Function
 * parameter lists survive here because they precede the `AS $$` body.
 */
const applyBare = activeSql(applyTime);

/** The internal core's body only, comments stripped. */
const coreBody = (() => {
  const start = bare.indexOf('CREATE FUNCTION public._phoenix_180_delegate_create_warehouse_dispatch');
  expect(start).toBeGreaterThan(-1);
  const end = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_create_warehouse_dispatch', start);
  expect(end).toBeGreaterThan(start);
  return bare.slice(start, end);
})();

/** The ordinary public writer's declaration + body, comments stripped. */
const ordinaryBody = (() => {
  const start = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_create_warehouse_dispatch');
  const end = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_create_initial_provisioning_dispatch', start);
  expect(end).toBeGreaterThan(start);
  return bare.slice(start, end);
})();

/** The initial-provisioning writer's declaration + body, comments stripped. */
const initialBody = (() => {
  const start = bare.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_create_initial_provisioning_dispatch');
  const end = bare.indexOf('REVOKE ALL ON FUNCTION public._phoenix_180_delegate', start);
  expect(end).toBeGreaterThan(start);
  return bare.slice(start, end);
})();

describe('180 registration and shape', () => {
  it('is registered exactly once, immediately after 179', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('179_phoenix_canonical_authenticated_availability_hardening.sql');
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(code).toContain('180_precondition_failed');
    expect(code).toContain('VERIFY FAILED (180)');
  });

  it('documents a manual rollback that restores both prior bodies', () => {
    expect(sql).toContain('ROLLBACK (manual)');
    expect(sql).toMatch(/DROP FUNCTION public\._phoenix_180_delegate_create_warehouse_dispatch/);
  });
});

describe('180 object inventory is exactly the authority-separation set', () => {
  it('creates exactly ONE new function — the trusted internal core', () => {
    const created = [...bare.matchAll(/CREATE FUNCTION (public\.[a-z_0-9]+)/g)].map(m => m[1]);
    expect(created).toEqual(['public._phoenix_180_delegate_create_warehouse_dispatch']);
  });

  it('replaces exactly TWO existing functions — the two public writers', () => {
    const replaced = [...bare.matchAll(/CREATE OR REPLACE FUNCTION (public\.[a-z_0-9]+)/g)]
      .map(m => m[1])
      .sort();
    expect(replaced).toEqual([
      'public.phoenix_create_initial_provisioning_dispatch',
      'public.phoenix_create_warehouse_dispatch',
    ]);
  });

  it('creates no table, column, constraint, index, policy, trigger, type or sequence', () => {
    expect(applyBare).not.toMatch(/\bCREATE\s+(TABLE|SEQUENCE|TYPE|POLICY|TRIGGER|VIEW|MATERIALIZED)\b/i);
    expect(applyBare).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
    expect(applyBare).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(applyBare).not.toMatch(/\bADD\s+(COLUMN|CONSTRAINT)\b/i);
  });

  it('drops nothing', () => {
    expect(bare).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|FUNCTION|POLICY|TRIGGER)\b/i);
  });

  it('writes no business data', () => {
    // The only INSERT statements are inside function BODIES (the dispatch row
    // and its audit rows), which execute per call, never at apply time.
    expect(applyTime).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(applyTime).not.toMatch(/\bUPDATE\s+public\./i);
    expect(applyTime).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('adds no permission key, movement type, ledger or RLS change', () => {
    expect(bare).not.toMatch(/INSERT INTO public\.permission/i);
    expect(bare).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(bare).not.toMatch(/outlet_stock_movements/);
    expect(bare).not.toMatch(/warehouse_stock_movements/);
  });

  it('does not redefine migration 166 or 179 objects', () => {
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_outlet_dispatch_line/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_outlet_availability_read_model/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_public_qr_payload/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_replenish_emergency_outlet/);
    expect(bare).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_reverse_outlet_replenishment/);
  });
});

describe('180 the authority boundary itself', () => {
  it('the gate refuses BOTH emergency outlet types', () => {
    expect(coreBody).toMatch(/point_type IN \('crash_cabinet', 'rescue_cart'\)/);
  });

  it('the gate applies to ORDINARY authority only', () => {
    expect(coreBody).toMatch(/p_authority = 'ordinary'\s*\n?\s*AND v_point\.point_type IN/);
  });

  it('uses a precise corridor error, never the outlet-type error', () => {
    // The outlet type IS approved for stock (066/067); the SUPPLY AUTHORITY is
    // what is wrong, so reusing outlet_type_not_approved_for_stock would
    // mis-describe the refusal.
    expect(coreBody).toContain('emergency_outlet_requires_initial_provisioning');
    // 070's own type gate is still present and still raises its own error —
    // for genuinely unapproved types only, which is a different refusal.
    expect(coreBody).toContain('outlet_type_not_approved_for_stock');
    expect(coreBody).not.toMatch(
      /point_type IN \('crash_cabinet', 'rescue_cart'\)[\s\S]{0,200}outlet_type_not_approved_for_stock/,
    );
  });

  it('the gate is HISTORICAL: it reads no lifecycle column', () => {
    // This is the structural refusal of the weaker "consumed-only" guard.
    expect(coreBody).not.toMatch(/initial_provisioning_consumed_at/);
    expect(coreBody).not.toMatch(/is_initial_provisioning/);
  });

  it('the gate reads no balance', () => {
    expect(coreBody).not.toMatch(/on_hand/);
    expect(coreBody).not.toMatch(/outlet_stock/);
    expect(coreBody).not.toMatch(/available_quantity/);
  });

  it('the gate is keyed on point_type, never on clinical_location_kind', () => {
    // An ER pharmacy is clinical_location_kind='emergency' and must stay a
    // legal ordinary dispatch destination — it is the SOURCE of Migration 168
    // rescue-cart replenishment.
    expect(coreBody).not.toMatch(/clinical_location_kind/);
  });

  it('refuses before any dispatch row is created', () => {
    const gate = coreBody.indexOf('emergency_outlet_requires_initial_provisioning');
    const insert = coreBody.indexOf('INSERT INTO public.warehouse_dispatches');
    expect(gate).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(insert);
  });

  it('refuses AFTER the permission gate, so an unauthorised caller learns nothing', () => {
    const perm = coreBody.indexOf('forbidden_warehouse_dispatch_create');
    const gate = coreBody.indexOf('emergency_outlet_requires_initial_provisioning');
    expect(perm).toBeGreaterThan(-1);
    expect(perm).toBeLessThan(gate);
  });

  it('reads point_type from the LOCKED destination row', () => {
    const lock = coreBody.indexOf('FROM public.distribution_points WHERE id = p_destination_distribution_point_id FOR SHARE');
    const gate = coreBody.indexOf('emergency_outlet_requires_initial_provisioning');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(gate);
  });

  it('rejects an unrecognised or NULL authority, fail-closed, before anything is read', () => {
    expect(coreBody).toContain('dispatch_authority_unrecognised');
    const authCheck = coreBody.indexOf('dispatch_authority_unrecognised');
    const advisory = coreBody.indexOf('pg_advisory_xact_lock');
    expect(authCheck).toBeLessThan(advisory);
    // No DEFAULT on the authority parameter: a caller that names no authority
    // does not get one.
    expect(coreBody).not.toMatch(/p_authority\s+text\s+DEFAULT/);
  });
});

describe('180 authority is never client-selectable', () => {
  it('only the internal core takes an authority parameter', () => {
    expect(ordinaryBody).not.toMatch(/p_authority/);
    expect(initialBody).not.toMatch(/p_authority/);
    expect(coreBody).toMatch(/p_authority\s+text/);
  });

  it('introduces no p_is_initial / p_mode style parameter anywhere', () => {
    expect(applyBare).not.toMatch(/p_is_initial/);
    expect(applyBare).not.toMatch(/p_mode\b/);
    expect(applyBare).not.toMatch(/p_dispatch_mode/);
    // Exactly ONE function in the whole migration declares an authority
    // parameter, and section "180 authority is never client-selectable" above
    // proves it is the internal core rather than either public writer.
    expect([...applyBare.matchAll(/p_authority\s+text/g)]).toHaveLength(1);
  });

  it('each public writer passes a LITERAL authority it chooses itself', () => {
    expect(ordinaryBody).toMatch(/'ordinary'\s*\n?\s*\);/);
    expect(initialBody).toMatch(/'initial'\s*\n?\s*\);/);
    // Neither wrapper can reach the other's authority.
    expect(ordinaryBody).not.toMatch(/'initial'/);
    expect(initialBody).not.toMatch(/'ordinary'/);
  });

  it('the internal core is revoked from every role a caller can present', () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_180_delegate_create_warehouse_dispatch\(uuid, uuid, text, text, text, text, text\)\s*\n\s*FROM PUBLIC, anon, authenticated, service_role;/,
    );
    // …and is granted to nobody.
    expect(bare).not.toMatch(/GRANT EXECUTE ON FUNCTION public\._phoenix_180_delegate/);
  });

  it('the verify block proves the no-client-authority property over the WHOLE schema', () => {
    expect(code).toContain('a client-reachable RPC lets the caller select an authority');
    expect(code).toMatch(/has_function_privilege\('authenticated', p\.oid, 'EXECUTE'\)/);
  });
});

describe('180 preserves both public contracts', () => {
  it('keeps the ordinary writer signature byte-for-byte compatible', () => {
    expect(ordinaryBody).toMatch(/p_warehouse_id\s+uuid,/);
    expect(ordinaryBody).toMatch(/p_destination_distribution_point_id uuid,/);
    expect(ordinaryBody).toMatch(/p_dispatch_number\s+text,/);
    expect(ordinaryBody).toMatch(/p_document_number\s+text DEFAULT NULL,/);
    expect(ordinaryBody).toMatch(/p_default_currency\s+text DEFAULT NULL,/);
    expect(ordinaryBody).toMatch(/p_notes\s+text DEFAULT NULL/);
    expect(ordinaryBody).toMatch(/RETURNS jsonb/);
  });

  it('keeps the initial-provisioning writer signature byte-for-byte compatible', () => {
    expect(initialBody).toMatch(/p_warehouse_id uuid,/);
    expect(initialBody).toMatch(/p_destination_distribution_point_id uuid,/);
    expect(initialBody).toMatch(/p_dispatch_number text,/);
    expect(initialBody).toMatch(/p_document_number text DEFAULT NULL,/);
    expect(initialBody).toMatch(/p_default_currency text DEFAULT NULL,/);
    expect(initialBody).toMatch(/p_notes text DEFAULT NULL/);
  });

  it('both public writers keep exactly their historical ACL', () => {
    for (const fn of [
      'public.phoenix_create_warehouse_dispatch(uuid, uuid, text, text, text, text)',
      'public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text)',
    ]) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION ${fn}\n  FROM PUBLIC, anon;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${fn}\n  TO authenticated;`);
    }
    expect(bare).not.toMatch(/GRANT[^;]*TO anon/i);
  });

  it('every 070 mechanic is present in the core, not re-implemented in a wrapper', () => {
    for (const mechanic of [
      'auth.uid()',
      'pg_advisory_xact_lock(hashtextextended(p_warehouse_id::text, 70169))',
      'FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE',
      'FROM public.distribution_points WHERE id = p_destination_distribution_point_id FOR SHARE',
      'phoenix_profile_has_scoped_permission',
      "'warehouse_dispatch.create'",
      'destination_outlet_not_paired_with_this_warehouse',
      'warehouse_and_destination_organization_mismatch',
      'active_profile_required',
      'dispatch_number_required',
      'not_authenticated',
      'INSERT INTO public.warehouse_dispatches',
      "'warehouse_dispatch.created'",
    ]) {
      expect(coreBody, mechanic).toContain(mechanic);
    }
    // The ordinary wrapper is a pure delegation — it re-implements nothing.
    expect(ordinaryBody).not.toContain('pg_advisory_xact_lock');
    expect(ordinaryBody).not.toContain('INSERT INTO');
    expect(ordinaryBody).not.toContain('phoenix_profile_has_scoped_permission');
  });

  it('the initial writer keeps every Migration 166 semantic', () => {
    for (const semantic of [
      'initial_provisioning_already_exists_for_outlet',
      'is_initial_provisioning = true',
      'initial_provisioning_consumed_at IS NOT NULL',
      "d.status IN ('draft', 'sent', 'partially_accepted')",
      'initial_provisioning_dispatch_not_created',
      'active_profile_required',
      "'warehouse_dispatch.initial_provisioning_created'",
    ]) {
      expect(initialBody, semantic).toContain(semantic);
    }
    // …and no longer routes through the ordinary PUBLIC writer, which now
    // refuses this very corridor.
    expect(initialBody).not.toContain('public.phoenix_create_warehouse_dispatch(');
    expect(initialBody).toContain('public._phoenix_180_delegate_create_warehouse_dispatch(');
  });
});

describe('180 preflight and verify cover the dependencies that matter', () => {
  it('preflight asserts the pre-180 coupling it is unwinding', () => {
    expect(code).toContain('the initial creator no longer delegates to the ordinary creator');
  });

  it('preflight asserts the 166 invariant objects, semantically', () => {
    expect(code).toContain('warehouse_dispatches_initial_provisioning_once_uniq');
    expect(code).toContain('wd_initial_provisioning_consumed_chk');
    expect(code).toContain('is_initial_provisioning');
  });

  it('preflight asserts every mechanic being relocated still lives in 070', () => {
    expect(code).toContain('no longer takes the 70169 per-warehouse advisory lock');
    expect(code).toContain('no longer raises its expected named errors');
    expect(code).toContain('no longer writes its creation audit');
  });

  it('preflight is not re-runnable', () => {
    expect(code).toContain('the 180 internal core already exists');
    expect(code).toContain('already carries an emergency-corridor gate');
  });

  it('preflight asserts the outlet-type vocabulary rather than a body hash', () => {
    expect(code).toContain('the distribution_points point_type vocabulary changed');
    // No brittle whitespace/body hashing anywhere.
    expect(bare).not.toMatch(/md5\s*\(/i);
    expect(bare).not.toMatch(/sha256/i);
  });

  it('verify proves the internal-helper negative ACL in the migration itself', () => {
    expect(code).toContain('authenticated can execute the internal core');
    expect(code).toContain('anon can execute the internal core');
    expect(code).toContain('service_role can execute the internal core');
    expect(code).toContain('PUBLIC can execute the internal core');
  });

  it('verify proves 166/168 preservation and the two-ledger truth', () => {
    expect(code).toContain('the 166 consumption stamp was disturbed');
    expect(code).toContain('the 166 one-shot invariant index changed');
    expect(code).toContain('the 168 replenishment corridor is missing');
    expect(code).toContain('a second balance ledger exists');
    expect(code).toContain('a warehouse-dispatch function became anon-reachable');
  });
});

describe('180 documents the decisions a reviewer must be able to check', () => {
  it('states why a consumed-only guard is insufficient, in both directions', () => {
    expect(sql).toContain('WHY A "CONSUMED-ONLY" GUARD IS NOT THE FIX');
    expect(sql).toMatch(/BEFORE:/);
    expect(sql).toMatch(/AFTER:/);
    expect(sql).toMatch(/brand-new crash cabinet or rescue cart/);
  });

  it('states the final invariant as permanent, not lifecycle-relative', () => {
    expect(sql).toMatch(/LEGAL ONLY\s*\n--\s*THROUGH THE DEDICATED INITIAL-PROVISIONING AUTHORITY/);
    expect(sql).toMatch(/after the balance returns to zero/);
  });

  it('states why the naive in-place fix would break initial provisioning', () => {
    expect(sql).toMatch(/WHY THE NAIVE FIX IS UNSAFE/);
    expect(sql).toMatch(/DELEGATES to\s*\n--\s*the ordinary creator/);
  });

  it('records the network-wide Production pre-apply gate', () => {
    expect(sql).toContain('PRODUCTION PRE-APPLY GATE');
    expect(sql).toMatch(/no live crash_cabinet \/ rescue_cart would be stranded/);
    expect(sql).toMatch(/ACTIVE 168 replenishment\s*\n--\s*route/);
  });

  it('records the suggestion-bridge consequence rather than special-casing it', () => {
    expect(sql).toMatch(/suggestion-accept bridge/);
    expect(sql).toMatch(/149:1503 \/ 151:441/);
  });
});
