/**
 * OUTLET-RETURN-LINE-IDEMPOTENCY-156 — static SQL contract tests.
 *
 * The dynamic proof (a real disposable-Postgres replay, actual RPC calls
 * proving replay/conflict/concurrency) is in
 * 156-outlet-return-line-idempotency.dynamic.test.ts (gated on a live
 * Postgres). These pin the properties that must not regress in review: the
 * same DROP-then-CREATE overload discipline 106 established, the dedup
 * ledger's own shape and grants, and that no unrelated permission/RLS/
 * validation logic was touched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '156_phoenix_outlet_return_line_idempotency.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql
  .slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'))
  .replace(/^[ \t]*--.*$/gm, '');

describe('registration and discipline', () => {
  it('is registered', () => expect(REVIEWED_MIGRATION_FILES).toContain(NAME));
  it('is manual-apply only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });
  it('is a single transaction', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
  it('aborts if 148 has not been applied', () => {
    expect(code).toMatch(/phoenix_add_outlet_return_request_line.*is missing/s);
  });
});

describe('overload discipline: DROP the old 5-arg signature before CREATE-ing the 6-arg one', () => {
  it('drops the exact old signature first', () => {
    expect(code).toMatch(
      /DROP FUNCTION IF EXISTS public\.phoenix_add_outlet_return_request_line\(uuid, uuid, integer, text, text\);/,
    );
  });
  it('creates exactly the new 6-arg signature, p_request_id last and DEFAULT NULL', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line'));
    const header = fn.slice(0, fn.indexOf('RETURNS jsonb'));
    expect(header).toMatch(/p_return_request_id\s+uuid/);
    expect(header).toMatch(/p_original_dispatch_line_id\s+uuid DEFAULT NULL/);
    expect(header).toMatch(/p_requested_quantity\s+integer DEFAULT NULL/);
    expect(header).toMatch(/p_reason_code\s+text DEFAULT NULL/);
    expect(header).toMatch(/p_reason_text\s+text DEFAULT NULL/);
    expect(header).toMatch(/p_request_id\s+uuid DEFAULT NULL/);
  });
  it('grants EXECUTE on the new 6-arg signature to authenticated only, never anon/PUBLIC', () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_add_outlet_return_request_line\(uuid, uuid, integer, text, text, uuid\) FROM PUBLIC, anon;/,
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_add_outlet_return_request_line\(uuid, uuid, integer, text, text, uuid\) TO authenticated;/,
    );
  });
});

describe('dedup ledger table', () => {
  it('creates phoenix_outlet_return_line_requests with the 106-shaped columns', () => {
    expect(code).toMatch(/CREATE TABLE public\.phoenix_outlet_return_line_requests/);
    for (const col of ['request_id', 'organization_id', 'return_request_id', 'payload_fingerprint', 'result', 'return_request_line_id', 'actor_id']) {
      expect(code).toContain(col);
    }
  });
  it('enables RLS, org-scoped SELECT for authenticated, no direct write grants', () => {
    expect(code).toMatch(/ALTER TABLE public\.phoenix_outlet_return_line_requests ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.phoenix_outlet_return_line_requests FROM authenticated/);
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.phoenix_outlet_return_line_requests TO authenticated/);
  });
});

describe('idempotency gate mirrors 106 exactly, with a distinct advisory-lock salt', () => {
  it('computes a sha256 fingerprint over every mutation-relevant input including the actor', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line'));
    const fpBlock = fn.slice(fn.indexOf('v_fp := encode'), fn.indexOf('hashtextextended'));
    for (const key of ['return_request_id', 'original_dispatch_line_id', 'requested_quantity', 'reason_code', 'reason_text', 'actor']) {
      expect(fpBlock).toContain(key);
    }
  });
  it('uses advisory-lock salt 156156, distinct from 106s 106106', () => {
    expect(code).toContain('hashtextextended(p_request_id::text, 156156)');
    expect(code).not.toContain('106106');
  });
  it('replays the stored result on a same-fingerprint hit, and raises request_id_conflict (23505) on a mismatch', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line'));
    expect(fn).toMatch(/RETURN v_existing\.result;/);
    expect(fn).toMatch(/RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505'/);
  });
  it('is skipped entirely when p_request_id IS NULL (backward compatible, no dedup read/write)', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line'));
    const gateOpen = fn.indexOf('IF p_request_id IS NOT NULL THEN');
    const gateClose = fn.indexOf('END IF;', gateOpen);
    expect(gateOpen).toBeGreaterThan(-1);
    expect(gateClose).toBeGreaterThan(gateOpen);
  });
  it('records the dedup row in the SAME transaction as the mutation, only when p_request_id was supplied', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line'));
    // The second (final) "IF p_request_id IS NOT NULL" gate is the post-insert
    // dedup-record write; the first is the pre-mutation replay/conflict check.
    const gates = [...fn.matchAll(/IF p_request_id IS NOT NULL THEN/g)];
    expect(gates.length).toBe(2);
    const secondGateIdx = gates[1].index!;
    const tail = fn.slice(secondGateIdx, secondGateIdx + 200);
    expect(tail).toMatch(/IF p_request_id IS NOT NULL THEN\s+INSERT INTO public\.phoenix_outlet_return_line_requests/);
  });
});

describe('all pre-existing validation/permission/audit logic is untouched', () => {
  const fn = () => code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line'));
  it('still checks outlet_stock.return_request scoped to the destination distribution point', () => {
    expect(fn()).toContain("public.phoenix_profile_has_scoped_permission(\n    v_actor, 'outlet_stock.return_request'");
  });
  it('still enforces the provenance material/batch/expiry match and the returnable cap/availability checks', () => {
    expect(fn()).toContain('provenance_material_batch_expiry_mismatch');
    expect(fn()).toContain('requested_quantity_exceeds_returnable_cap');
    expect(fn()).toContain('requested_quantity_exceeds_current_availability');
  });
  it('still writes the outlet_stock.return_line_added audit_logs row', () => {
    expect(fn()).toContain("'outlet_stock.return_line_added'");
  });
  it('still takes the 148 advisory lock on the dispatch-line provenance key', () => {
    expect(fn()).toContain("_phoenix_lock_inventory_resources(ARRAY[\n    'inv_provline:' || p_original_dispatch_line_id::text\n  ])");
  });
  it('is still SECURITY DEFINER with pinned search_path', () => {
    expect(fn()).toMatch(/SECURITY DEFINER/);
    expect(fn()).toMatch(/SET search_path = public, pg_temp/);
  });
});

describe('scope discipline: no RLS policy or privilege grant/revoke on any pre-existing table', () => {
  it('touches no CREATE/DROP POLICY and no ALTER TABLE ... ROW LEVEL SECURITY beyond the new table', () => {
    const withoutNewTableBlock = code.replace(
      code.slice(code.indexOf('CREATE TABLE public.phoenix_outlet_return_line_requests'), code.indexOf('-- ── B.')),
      '',
    );
    expect(withoutNewTableBlock).not.toMatch(/CREATE POLICY|DROP POLICY/i);
    expect(withoutNewTableBlock).not.toMatch(/ROW LEVEL SECURITY/i);
  });
  it('grants/revokes nothing on outlet_return_request_lines, outlet_return_requests, or any other pre-existing table', () => {
    for (const table of ['outlet_return_request_lines', 'outlet_return_requests', 'outlet_stock', 'warehouse_dispatch_lines']) {
      expect(code).not.toMatch(new RegExp(`(GRANT|REVOKE)[^;]*\\bpublic\\.${table}\\b`));
    }
  });
});
