/**
 * WAREHOUSE-RECEIPT-EXPECTED-GENERATION-078-A — static SQL contract tests.
 * CRLF-normalized, whitespace-agnostic, DB-free.
 *
 * Proves the migration closes the accumulating-receipt double-post WITHOUT
 * weakening 065: it is additive, creates no overload, keeps the replay
 * short-circuit ahead of the generation check, and delegates the actual write so
 * RBAC / fingerprint idempotency / audit stay single-sourced.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '078_phoenix_warehouse_receipt_expected_generation.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const norm = sql.replace(/\s+/g, ' ').trim();

/** Drop `--` line comments so prose never satisfies a code assertion. */
const stripComments = (s: string) => s.replace(/^[ \t]*--.*$/gm, '').replace(/\s+--.*$/gm, '');

/** Executable SQL only: the transaction body, comments removed. */
const CODE = stripComments(sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')));

/** Body of a function delimited by its own dollar-quote tag, comments removed. */
function fn(name: string, tag: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const open = sql.indexOf(`$${tag}$`, start);
  const close = sql.indexOf(`$${tag}$`, open + tag.length + 2);
  expect(close, `${name} body must be closed`).toBeGreaterThan(open);
  return stripComments(sql.slice(start, close)).replace(/\s+/g, ' ');
}

const RECEIVE = fn('phoenix_receive_warehouse_stock_guarded', 'guarded_receive');
const MOVE = fn('phoenix_apply_warehouse_stock_movement_guarded', 'guarded_movement');
const BUMP = fn('phoenix_warehouse_stock_bump_movement_seq', 'bump');

/** Everything before the first guarded function — the DDL/precondition half. */
const HEAD = sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_stock_guarded'));

describe('registration and manual-apply discipline', () => {
  it('is registered in the canonical reviewed-migration list', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
  });

  it('is marked MANUAL APPLY ONLY and forbids db push', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('states honestly that it was not executed against a database', () => {
    expect(sql).toContain('VERIFICATION STATUS');
    expect(sql).toMatch(/did NOT include execution against a\s*\n?-- disposable PostgreSQL database/);
  });

  it('runs as a single transaction', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('COMMIT;'));
  });
});

describe('preconditions abort on unexpected live state', () => {
  it('aborts when the target tables are missing', () => {
    expect(HEAD).toContain("to_regclass('public.warehouse_stock') IS NULL");
    expect(HEAD).toContain("to_regclass('public.warehouse_stock_movements') IS NULL");
  });

  it('aborts unless each legacy RPC is still exactly ONE overload', () => {
    // If a second overload already exists, resolution is ambiguous and adding a
    // third callable shape would compound it.
    expect(HEAD).toMatch(/proname = 'phoenix_receive_warehouse_stock'\) <> 1/);
    expect(HEAD).toMatch(/proname = 'phoenix_apply_warehouse_stock_movement'\) <> 1/);
  });

  it('is not a silently repeatable data mutation — re-applying aborts', () => {
    expect(HEAD).toContain("column_name = 'movement_seq'");
    expect(HEAD).toMatch(/already exists \(078 already applied\?\)/);
  });

  it('every precondition RAISEs rather than warning', () => {
    const raises = (HEAD.match(/RAISE EXCEPTION 'precondition failed/g) ?? []).length;
    expect(raises).toBeGreaterThanOrEqual(5);
  });
});

describe('the generation is server-owned', () => {
  it('adds movement_seq as NOT NULL DEFAULT 0, so no backfill can leave a gap', () => {
    expect(norm).toContain('ADD COLUMN movement_seq bigint NOT NULL DEFAULT 0');
  });

  it('advances only on a real quantity change', () => {
    expect(BUMP).toContain('NEW.on_hand_quantity IS DISTINCT FROM OLD.on_hand_quantity');
    expect(BUMP).toContain('NEW.reserved_quantity IS DISTINCT FROM OLD.reserved_quantity');
    expect(BUMP).toContain('NEW.movement_seq := OLD.movement_seq + 1');
  });

  it('does NOT advance on a metadata-only update', () => {
    // Otherwise an unrelated edit would invalidate a receipt mid-post.
    expect(BUMP).toContain('ELSE NEW.movement_seq := OLD.movement_seq');
  });

  it('overwrites any client-supplied value, so the generation cannot be spoofed', () => {
    // Both branches assign NEW.movement_seq — no path preserves client input.
    const assigns = (BUMP.match(/NEW\.movement_seq :=/g) ?? []).length;
    expect(assigns).toBe(2);
  });

  it('fires BEFORE UPDATE FOR EACH ROW, in the same statement as the change', () => {
    expect(norm).toContain('CREATE TRIGGER warehouse_stock_bump_movement_seq BEFORE UPDATE ON public.warehouse_stock FOR EACH ROW');
  });
});

describe('no ambiguous overload is created', () => {
  it('the guarded RPCs use NEW names, never a new parameter on the legacy names', () => {
    expect(sql).toContain('phoenix_receive_warehouse_stock_guarded');
    expect(sql).toContain('phoenix_apply_warehouse_stock_movement_guarded');
    // The legacy names must never be redefined here.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_warehouse_stock\s*\(/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_apply_warehouse_stock_movement\s*\(/);
  });

  it('drops no function and revokes no existing grant — safe to apply while live', () => {
    // Scoped to EXECUTABLE sql: the rollback plan is documented as comments and
    // legitimately contains DROP statements that never run on apply.
    expect(CODE).not.toMatch(/DROP FUNCTION/);
    expect(CODE).not.toMatch(/REVOKE[^;]*phoenix_receive_warehouse_stock\s*\(/);
    expect(CODE).not.toMatch(/REVOKE[^;]*phoenix_apply_warehouse_stock_movement\s*\(/);
    // The one permitted DROP is the idempotent trigger re-create.
    expect((CODE.match(/DROP TRIGGER/g) ?? []).length).toBe(1);
  });

  it('documents why a new parameter on the existing name was rejected', () => {
    expect(sql).toContain('creates a SECOND, overloaded');
  });
});

describe('idempotency is preserved — replay outranks the generation check', () => {
  for (const [label, body] of [['receive', RECEIVE], ['movement', MOVE]] as const) {
    it(`${label}: the request-id replay check comes BEFORE the generation check`, () => {
      const replay = body.indexOf('reference_id = p_request_id');
      const check = body.indexOf('p_expected_generation IS NOT NULL');
      expect(replay).toBeGreaterThan(-1);
      expect(check).toBeGreaterThan(-1);
      expect(replay).toBeLessThan(check);
    });

    it(`${label}: a replay delegates and returns without reaching the check`, () => {
      const replayBlock = body.slice(body.indexOf('IF EXISTS ('), body.indexOf('p_expected_generation IS NOT NULL'));
      expect(replayBlock).toContain('RETURN public.phoenix_');
    });

    it(`${label}: takes the SAME advisory lock key as 065, before any row lock`, () => {
      expect(body).toContain('pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065))');
      expect(body.indexOf('pg_advisory_xact_lock')).toBeLessThan(body.indexOf('FOR UPDATE'));
    });

    it(`${label}: locks the canonical target deterministically with FOR UPDATE`, () => {
      expect(body).toContain('FOR UPDATE');
    });

    it(`${label}: raises the stable conflict code 40001 on a stale generation`, () => {
      expect(body).toContain("RAISE EXCEPTION 'warehouse_receipt_generation_conflict'");
      expect(body).toContain("ERRCODE = '40001'");
    });

    it(`${label}: never reuses 23505, which already means request-id conflict`, () => {
      const conflictStmt = body.slice(body.indexOf("'warehouse_receipt_generation_conflict'"));
      expect(conflictStmt.slice(0, 200)).not.toContain('23505');
    });

    it(`${label}: p_expected_generation is optional, so legacy callers still work`, () => {
      expect(body).toContain('p_expected_generation IS NOT NULL');
    });

    it(`${label}: delegates the write instead of reimplementing it`, () => {
      // Exactly two delegations: the replay path and the accepted path.
      const legacy = label === 'receive'
        ? 'RETURN public.phoenix_receive_warehouse_stock('
        : 'RETURN public.phoenix_apply_warehouse_stock_movement(';
      expect((body.split(legacy).length - 1)).toBe(2);
    });

    it(`${label}: writes no table directly`, () => {
      expect(body).not.toMatch(/INSERT INTO|UPDATE public\.|DELETE FROM/);
    });
  }
});

describe('a brand-new lot is generation 0', () => {
  it('an absent row is treated as 0, so the race loser conflicts instead of double-posting', () => {
    expect(RECEIVE).toContain('v_seq := COALESCE(v_seq, 0)');
  });

  it('resolves the target on the SAME identity columns the legacy RPC uses', () => {
    for (const col of [
      's.warehouse_id = p_warehouse_id',
      's.scientific_name = v_scientific',
      'COALESCE(s.concentration',
      'COALESCE(s.dosage_form',
      'COALESCE(s.national_code',
      'COALESCE(s.batch_number',
      'COALESCE(s.expiry_date',
      'COALESCE(s.internal_batch_reference',
    ]) {
      expect(RECEIVE).toContain(col);
    }
  });

  it('reconstructs the no-batch internal reference exactly as 065 does', () => {
    expect(RECEIVE).toContain("'WSNB-' || replace(p_request_id::text, '-', '')");
  });
});

describe('security posture', () => {
  it('both guarded RPCs are SECURITY DEFINER with a pinned search_path', () => {
    const defs = (sql.match(/SECURITY DEFINER\s+SET search_path = public, pg_temp/g) ?? []).length;
    expect(defs).toBe(2);
  });

  it('the trigger function also pins search_path', () => {
    expect(BUMP).toContain('SET search_path = public, pg_temp');
  });

  it('revokes PUBLIC and grants EXECUTE only to authenticated', () => {
    expect((sql.match(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC;/g) ?? []).length).toBe(3);
    expect((sql.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO authenticated;/g) ?? []).length).toBe(2);
  });

  it('grants nothing to anon, and does not depend on service_role', () => {
    expect(sql).not.toMatch(/TO anon\b/);
    expect(sql).not.toMatch(/GRANT[^;]*TO service_role/);
    expect(sql).not.toContain('service_role_key');
  });

  it('re-checks nothing itself — RBAC stays with the delegated legacy RPC', () => {
    // The guarded wrappers must not fork the permission decision.
    expect(RECEIVE).not.toContain('phoenix_profile_has_scoped_permission');
    expect(MOVE).not.toContain('phoenix_profile_has_scoped_permission');
  });

  it('the by-id guard cannot become an existence oracle', () => {
    // A row the caller cannot see yields no conflict here; the legacy RPC
    // reports absence, so authorized-missing and unauthorized look identical.
    expect(MOVE).toContain('COALESCE(v_found, false)');
    expect(sql).toContain('cannot become an existence oracle');
  });
});

describe('operational documentation', () => {
  it('ships post-apply verification SQL', () => {
    expect(sql).toContain('POST-CONDITIONS');
    expect(sql).toContain('SELECT tgname, tgenabled FROM pg_trigger');
  });

  it('ships before/after reconciliation SQL', () => {
    expect(sql).toContain('RECONCILIATION');
    expect(sql).toMatch(/sum\(on_hand_quantity\)/);
  });

  it('ships a rollback and a containment plan', () => {
    expect(sql).toContain('ROLLBACK / CONTAINMENT');
    expect(sql).toContain('DROP COLUMN IF EXISTS movement_seq');
    expect(sql).toContain('CONTAINMENT (preferred, no schema change)');
  });

  it('defers retiring the legacy callable to a later contract migration', () => {
    expect(sql).toContain('FOLLOW-UP (NOT part of this migration)');
    expect(sql).toMatch(/REVOKE EXECUTE on the two legacy RPCs/);
  });
});
