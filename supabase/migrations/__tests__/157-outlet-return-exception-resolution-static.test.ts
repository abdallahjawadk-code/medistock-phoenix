/**
 * OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — static SQL contract tests.
 *
 * The dynamic proof (a real disposable-Postgres replay, actual RPC calls
 * proving both resolution paths, idempotency, double-resolution rejection,
 * and permission/read-policy parity) is in
 * 157-outlet-return-exception-resolution.dynamic.test.ts (gated on a live
 * Postgres). These pin the properties that must not regress in review: the
 * additive-only design (the original exception_pending row is never
 * touched), the owner-mandated two-path shape, and that no existing
 * table/RPC/permission was altered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '157_phoenix_outlet_return_exception_resolution.sql';
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
  it('aborts if 135 or 071s phoenix_can_read_outlet_return has not been applied', () => {
    expect(code).toMatch(/phoenix_receive_outlet_return_shipment_line.*is missing/s);
    expect(code).toMatch(/phoenix_can_read_outlet_return.*is missing/s);
  });
});

describe('the original outlet_return_shipment_lines row is never touched', () => {
  it('contains no UPDATE statement against outlet_return_shipment_lines', () => {
    expect(code).not.toMatch(/UPDATE\s+public\.outlet_return_shipment_lines/);
  });
  it('contains no ALTER TABLE / DROP CONSTRAINT against outlet_return_shipment_lines', () => {
    expect(code).not.toMatch(/ALTER TABLE\s+public\.outlet_return_shipment_lines/i);
  });
});

describe('resolution ledger table', () => {
  it('creates phoenix_outlet_return_exception_resolutions with the required columns', () => {
    expect(code).toMatch(/CREATE TABLE public\.phoenix_outlet_return_exception_resolutions/);
    for (const col of [
      'request_id', 'return_shipment_line_id', 'organization_id', 'resolution_kind', 'reason',
      'corrected_quantity', 'disposition',
      'resulting_warehouse_stock_id', 'resulting_quarantine_stock_id',
      'resulting_warehouse_movement_id', 'resulting_quarantine_movement_id',
      'payload_fingerprint', 'result', 'actor_id',
    ]) {
      expect(code).toContain(col);
    }
  });
  it('enforces at-most-one-resolution-per-line via UNIQUE(return_shipment_line_id)', () => {
    const table = code.slice(code.indexOf('CREATE TABLE public.phoenix_outlet_return_exception_resolutions'));
    const decl = table.slice(0, table.indexOf('CONSTRAINT porer_kind_chk'));
    expect(decl).toMatch(/return_shipment_line_id\s+uuid NOT NULL UNIQUE/);
  });
  it('enforces idempotent replay via UNIQUE(request_id)', () => {
    const table = code.slice(code.indexOf('CREATE TABLE public.phoenix_outlet_return_exception_resolutions'));
    const decl = table.slice(0, table.indexOf('return_shipment_line_id'));
    expect(decl).toMatch(/request_id\s+uuid NOT NULL UNIQUE/);
  });
  it('requires a non-blank reason', () => {
    expect(code).toMatch(/CONSTRAINT porer_reason_chk\s+CHECK \(btrim\(reason\) = reason AND reason <> ''\)/);
  });
  it('ties resolution_kind to exactly the owner-mandated two values', () => {
    expect(code).toMatch(/CONSTRAINT porer_kind_chk\s+CHECK \(resolution_kind IN \('corrected_receipt', 'confirmed_no_stock'\)\)/);
  });
  it('the decision CHECK requires confirmed_no_stock to leave every stock/movement column NULL', () => {
    const check = code.slice(code.indexOf('CONSTRAINT porer_decision_chk'), code.indexOf('CREATE INDEX phoenix_outlet_return_exception_resolutions_org_idx'));
    const confirmedBranch = check.slice(check.indexOf("WHEN 'confirmed_no_stock'"));
    expect(confirmedBranch).toMatch(/corrected_quantity IS NULL AND disposition IS NULL/);
    expect(confirmedBranch).toMatch(/resulting_warehouse_stock_id IS NULL AND resulting_quarantine_stock_id IS NULL/);
    expect(confirmedBranch).toMatch(/resulting_warehouse_movement_id IS NULL AND resulting_quarantine_movement_id IS NULL/);
  });
  it('enables RLS, org-scoped SELECT for authenticated, no direct write grants', () => {
    expect(code).toMatch(/ALTER TABLE public\.phoenix_outlet_return_exception_resolutions ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.phoenix_outlet_return_exception_resolutions FROM authenticated/);
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.phoenix_outlet_return_exception_resolutions TO authenticated/);
  });
});

describe('permission: a new, distinct key — not reused from an adjacent one', () => {
  it('registers outlet_stock.resolve_return_exception in permission_keys', () => {
    expect(code).toMatch(/INSERT INTO public\.permission_keys[\s\S]*?'outlet_stock\.resolve_return_exception'/);
  });
  it('defaults warehouse_officer to allowed, and lists no other explicit role default', () => {
    const block = code.slice(
      code.indexOf('INSERT INTO public.role_permission_defaults'),
      code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_can_read_outlet_return'),
    );
    expect(block).toContain("('warehouse_officer', 'outlet_stock.resolve_return_exception', true)");
    // Only ONE role row for this key — every other role fails closed by
    // absence, matching 098's own precedent for a brand-new key.
    expect((block.match(/outlet_stock\.resolve_return_exception/g) ?? []).length).toBe(1);
  });
});

describe('read-policy parity: avoids the 105-class read/write mismatch', () => {
  it('phoenix_can_read_outlet_return gains a third OR-branch for the new key, keeping the original two', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_can_read_outlet_return'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    expect(body).toContain("'outlet_stock.return_request'");
    expect(body).toContain("'outlet_stock.review_return'");
    expect(body).toContain("'outlet_stock.resolve_return_exception'");
  });
});

describe('the resolution RPC', () => {
  const fn = () => code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_resolve_outlet_return_exception'));

  it('takes a MANDATORY p_request_id (no DEFAULT), unlike 106/156s optional design', () => {
    const header = fn().slice(0, fn().indexOf('RETURNS jsonb'));
    expect(header).toMatch(/p_request_id\s+uuid,/);
    expect(header).not.toMatch(/p_request_id\s+uuid\s+DEFAULT/);
  });
  it('rejects a missing/invalid resolution_kind and a missing reason', () => {
    expect(fn()).toContain("RAISE EXCEPTION 'invalid_resolution_kind'");
    expect(fn()).toContain("RAISE EXCEPTION 'reason_required'");
  });
  it('requires custody_state=exception_pending before doing anything else', () => {
    expect(fn()).toContain("RAISE EXCEPTION 'line_not_exception_pending'");
  });
  it('raises a distinct exception_already_resolved error for a different request_id on an already-resolved line', () => {
    expect(fn()).toContain("RAISE EXCEPTION 'exception_already_resolved'");
  });
  it('checks the new permission key, scoped to the lines own organization/warehouse', () => {
    expect(fn()).toContain("'outlet_stock.resolve_return_exception', v_shipment.destination_organization_id");
  });
  it('uses advisory-lock salt 157157, distinct from 106s and 156s', () => {
    expect(code).toContain('hashtextextended(p_request_id::text, 157157)');
    expect(code).not.toContain('106106');
    expect(code).not.toContain('156156');
  });
  it('reuses the existing movement_type enum values (never widens warehouse_stock_movements_type_chk / wqsm_type_chk)', () => {
    // 070's own header comment documents this repo's convention: never
    // widen these two CHECK constraints. 'correction' / 'quarantine_correction'
    // are pre-existing allowed values (060/069), reused here rather than
    // inventing a new one that would need a schema change.
    expect(fn()).toMatch(/warehouse_id, 'correction',/);
    expect(fn()).toMatch(/warehouse_id, 'quarantine_correction',/);
  });
  it('uses a reference_type distinct from an ordinary receive as the actual distinguishing marker', () => {
    expect(fn()).toContain("'outlet_return_exception_resolve'");
    // Never the ordinary-receive reference_type, which would make a
    // correction indistinguishable from (and double-counted against) a
    // real receive's own idempotency ledger.
    expect(fn()).not.toContain("'outlet_return_receive'");
  });
  it('updates warehouse_dispatch_lines.return_received_quantity only on the corrected_receipt path', () => {
    const confirmedBranch = fn().slice(
      fn().indexOf("IF p_resolution_kind = 'confirmed_no_stock' THEN"),
      fn().indexOf("IF p_disposition_decision = 'restockable' THEN"),
    );
    expect(confirmedBranch).not.toContain('return_received_quantity');
    expect(fn()).toContain('return_received_quantity = return_received_quantity + p_corrected_quantity');
  });
  it('is SECURITY DEFINER with pinned search_path, EXECUTE for authenticated only', () => {
    expect(fn()).toMatch(/SECURITY DEFINER/);
    expect(fn()).toMatch(/SET search_path = public, pg_temp/);
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_resolve_outlet_return_exception\(uuid, uuid, text, text, integer, text\) FROM PUBLIC, anon;/,
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_resolve_outlet_return_exception\(uuid, uuid, text, text, integer, text\) TO authenticated;/,
    );
  });
});

describe('scope discipline: no other existing table/RPC is touched', () => {
  it('never UPDATEs warehouse_stock_movements, warehouse_quarantine_stock_movements, or audit_logs (INSERT-only ledgers)', () => {
    for (const table of ['warehouse_stock_movements', 'warehouse_quarantine_stock_movements', 'audit_logs']) {
      expect(code).not.toMatch(new RegExp(`UPDATE\\s+public\\.${table}\\b`));
    }
  });
  it('135s receive RPC signature is re-verified, not redefined', () => {
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_outlet_return_shipment_line/);
  });
});
