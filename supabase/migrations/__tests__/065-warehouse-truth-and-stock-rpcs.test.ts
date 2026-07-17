/**
 * MIGRATION-065-WAREHOUSE-TRUTH-STOCK-RPCS-A
 *
 * Static review guards only. No database connection and no production write.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  REVIEWED_MIGRATION_FILES,
  findUnreviewedMigrationFiles,
} from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const FILE = '065_phoenix_warehouse_truth_and_stock_rpcs.sql';
const sql = readFileSync(join(MIGRATIONS, FILE), 'utf8');

function activeSql(source: string): string {
  return source
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n');
}

function functionSql(name: string): string {
  const pattern = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
  );
  const match = active.match(pattern);
  if (match === null) throw new Error(`Function not found in migration 065: ${name}`);
  return match[0];
}

const active = activeSql(sql);
const verifyMarker = '-- F. VERIFY';
const verifyStart = sql.indexOf(verifyMarker);
const beforeVerify = verifyStart < 0 ? sql : sql.slice(0, verifyStart);
const verify = verifyStart < 0 ? '' : sql.slice(verifyStart);
const receipt = functionSql('phoenix_receive_warehouse_stock');
const adjustment = functionSql('phoenix_apply_warehouse_stock_movement');
const manualWrapper = functionSql('phoenix_apply_availability_movement');
const sourceGuard = functionSql('phoenix_guard_availability_source_kind');

describe('migration 065 — warehouse truth boundary and stock RPCs', () => {
  it('is the one exact reviewed 065 migration and leaves no unreviewed SQL', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(file => file.startsWith('065_'))).toEqual([FILE]);
    // INVENTORY-ONLY-AVAILABILITY-066-A: the former
    // `getMaximumReviewedMigrationNumber() === 65` assertion is DELIBERATELY
    // ABSENT. It is not a property of migration 065 — it is a ceiling on the NEXT
    // phase, so a legitimate, separately-reviewed 066 broke a guard that 066 does
    // not touch. That churn is exactly what the canonical registry exists to
    // remove; the reviewed maximum belongs to reviewed-migration-manifest.test.ts
    // alone. 065's own scope stays covered by every assertion below, and the
    // "no unreviewed SQL on disk" property below is strictly stronger anyway.
    expect(findUnreviewedMigrationFiles(readdirSync(MIGRATIONS))).toEqual([]);
  });

  it('is manual-apply-only and keeps VERIFY inside one top-level transaction', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DO NOT use supabase db push');
    expect(sql.match(/^begin;$/gim)).toHaveLength(1);
    expect(sql.match(/^commit;$/gim)).toHaveLength(1);
    expect(verifyStart).toBeGreaterThan(sql.indexOf('phoenix_apply_warehouse_stock_movement'));
    expect(sql.lastIndexOf('commit;')).toBeGreaterThan(verifyStart);
    expect(verify).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
  });

  it('adds an explicit, additive outlet source discriminator', () => {
    expect(active).toMatch(
      /ALTER TABLE public\.item_availability\s+ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'manual'/,
    );
    expect(active).toContain('item_availability_source_kind_chk');
    expect(active).toMatch(/CHECK \(source_kind IN \('manual', 'warehouse_dispatch'\)\)/);
    expect(active).not.toMatch(/UPDATE\s+public\.item_availability\s+SET\s+source_kind/i);
  });

  it('makes warehouse-dispatch availability server-owned and source kind immutable', () => {
    expect(sourceGuard).toContain('SECURITY INVOKER');
    expect(sourceGuard).not.toContain('SECURITY DEFINER');
    expect(sourceGuard).toContain('SET search_path = public, pg_temp');
    expect(sourceGuard).toContain("current_setting('phoenix.dispatch_write', true)");
    expect(sourceGuard).toContain('current_user = pg_get_userbyid(c.relowner)');
    expect(sourceGuard).toContain('v_trusted_dispatch_write');
    expect(sourceGuard).toContain("TG_OP = 'DELETE'");
    expect(sourceGuard).toContain('warehouse_managed_availability_server_only');
    expect(sourceGuard).toContain('availability_source_kind_immutable');
    expect(sourceGuard).toContain('warehouse_managed_availability_read_only');
    expect(active).toContain('CREATE TRIGGER trg_guard_availability_source_kind');
    expect(active).toMatch(
      /BEFORE INSERT OR UPDATE OR DELETE ON public\.item_availability/,
    );
    expect(active).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_guard_availability_source_kind\(\)\s+FROM PUBLIC, anon, authenticated/,
    );
    expect(beforeVerify).not.toContain('set_config(');
  });

  it('privatizes the old manual movement implementation behind a guarded wrapper', () => {
    expect(active).toContain(
      'RENAME TO phoenix_apply_manual_availability_movement_internal',
    );
    expect(active).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_apply_manual_availability_movement_internal\([\s\S]*?\) FROM PUBLIC, anon, authenticated/,
    );
    expect(manualWrapper).toContain('SECURITY DEFINER');
    expect(manualWrapper).toContain('SET search_path = public, pg_temp');
    expect(manualWrapper).toContain('auth.uid() IS NULL');
    expect(manualWrapper).toContain('FOR UPDATE');
    expect(manualWrapper).toContain("v_source_kind = 'warehouse_dispatch'");
    expect(manualWrapper).toContain('phoenix_apply_manual_availability_movement_internal');
  });

  it('binds each request UUID to exactly one normalized semantic request', () => {
    expect(active).toMatch(
      /ALTER TABLE public\.warehouse_stock_movements\s+ADD COLUMN IF NOT EXISTS request_fingerprint text/,
    );
    expect(active).toContain('warehouse_stock_movements_request_fingerprint_chk');
    expect(active).toContain("reference_type IS DISTINCT FROM 'warehouse_request'");
    expect(active).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'");
    expect(active).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_request_once_uniq\s+ON public\.warehouse_stock_movements \(reference_id\)\s+WHERE reference_type = 'warehouse_request'\s+AND reference_id IS NOT NULL/,
    );
    expect(receipt).toContain(
      'v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(',
    );
    expect(adjustment).toContain(
      'v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(',
    );
    expect(receipt).toContain(
      'v_existing.request_fingerprint IS DISTINCT FROM v_request_fingerprint',
    );
    expect(adjustment).toContain(
      'v_existing.request_fingerprint IS DISTINCT FROM v_request_fingerprint',
    );
  });

  it('defines both warehouse entry points as pinned SECURITY DEFINER RPCs', () => {
    for (const body of [receipt, adjustment]) {
      expect(body).toContain('RETURNS jsonb');
      expect(body).toContain('LANGUAGE plpgsql');
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain('SET search_path = public, pg_temp');
      expect(body).toContain("RAISE EXCEPTION 'not_authenticated'");
      expect(body).toContain("RAISE EXCEPTION 'active_profile_required'");
    }
  });

  it('requires an active warehouse, explicit identity flags, and positive receipt quantity', () => {
    expect(receipt).toContain("w.status = 'active'");
    expect(receipt).toContain('explicit_identity_flags_required');
    expect(receipt).toContain('national_code_flag_mismatch');
    expect(receipt).toContain('batch_number_flag_mismatch');
    expect(receipt).toContain('quantity_must_be_positive');
    expect(receipt).toContain('unit_price_must_be_non_negative');
    expect(receipt).toContain("'warehouse_stock.adjust'");
    expect(receipt).toContain('phoenix_profile_has_scoped_permission');
  });

  it('preserves real no-batch semantics with a private request-derived identity', () => {
    expect(receipt).toContain("THEN 'WSNB-' || replace(p_request_id::text, '-', '')");
    expect(receipt).toContain('batch_number, has_no_batch_number, internal_batch_reference');
    expect(receipt).toContain('COALESCE(s.internal_batch_reference');
    expect(receipt).not.toMatch(/p_batch_number\s*:=\s*['"](N\/A|NONE|-|بلا)/i);
  });

  it('uses one lock order in both RPCs to avoid request/row lock inversion', () => {
    for (const body of [receipt, adjustment]) {
      const advisory = body.indexOf('pg_advisory_xact_lock');
      const rowLock = body.indexOf('FOR UPDATE');
      expect(advisory).toBeGreaterThan(-1);
      expect(rowLock).toBeGreaterThan(advisory);
      expect(body.match(/pg_advisory_xact_lock/g)).toHaveLength(1);
    }
  });

  it('records every receipt in the immutable warehouse ledger and audit log', () => {
    expect(receipt).toContain('warehouse_stock_central_item_conflict');
    expect(receipt).toContain(
      'v_stock.central_item_id IS DISTINCT FROM p_central_item_id',
    );
    expect(receipt).toContain(
      'COALESCE(v_stock.central_item_id, p_central_item_id)',
    );
    expect(receipt).not.toContain(
      'COALESCE(p_central_item_id, central_item_id)',
    );
    expect(receipt).toContain('UPDATE public.warehouse_stock');
    expect(receipt).toContain('INSERT INTO public.warehouse_stock_movements');
    expect(receipt).toContain("'warehouse_receipt', 'warehouse_request'");
    expect(receipt).toContain('request_fingerprint');
    expect(receipt).toContain('INSERT INTO public.audit_logs');
    expect(receipt).toContain("'warehouse_stock.receive'");
    expect(receipt).toContain("'idempotent_replay', true");
    expect(receipt).toContain("'idempotent_replay', false");
  });

  it('separates correction authority from ordinary adjustments', () => {
    expect(adjustment).toContain(
      "p_movement_type NOT IN ('set_exact', 'add', 'subtract', 'correction')",
    );
    expect(adjustment).toContain("'warehouse_stock.correct'");
    expect(adjustment).toContain("'warehouse_stock.adjust'");
    expect(adjustment).toContain('warehouse_correction_reason_required');
    expect(adjustment).toContain('phoenix_profile_has_scoped_permission');
  });

  it('fails closed on impossible warehouse arithmetic', () => {
    expect(adjustment).toContain('warehouse_quantity_cannot_go_negative');
    expect(adjustment).toContain('warehouse_quantity_below_reserved');
    expect(adjustment).toContain('v_after < v_stock.reserved_quantity');
    expect(adjustment).toContain('FOR UPDATE');
  });

  it('records adjustments as new movement and audit rows, never ledger edits', () => {
    expect(adjustment).toContain('INSERT INTO public.warehouse_stock_movements');
    expect(adjustment).toContain('INSERT INTO public.audit_logs');
    expect(adjustment).toContain("'warehouse_stock.' || p_movement_type");
    expect(adjustment).not.toMatch(
      /UPDATE\s+public\.warehouse_stock_movements|DELETE\s+FROM\s+public\.warehouse_stock_movements/i,
    );
  });

  it('exposes mutation RPCs only to authenticated and preserves table write revokes', () => {
    for (const name of [
      'phoenix_receive_warehouse_stock',
      'phoenix_apply_warehouse_stock_movement',
    ]) {
      expect(active).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]{0,700}?\\) FROM PUBLIC, anon;`),
      );
      expect(active).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]{0,700}?\\) TO authenticated;`),
      );
    }
    expect(active).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_(receive_warehouse_stock|apply_warehouse_stock_movement)[\s\S]{0,700}? TO (anon|PUBLIC)/,
    );
    expect(active).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_stock\s+FROM authenticated/,
    );
    expect(active).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_stock_movements\s+FROM authenticated/,
    );
  });

  it('does not add destructive data operations, public writes, or privileged frontend paths', () => {
    const operational = activeSql(beforeVerify);
    expect(operational).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    expect(operational).not.toMatch(/DROP\s+(TABLE|COLUMN)\b/i);
    expect(operational).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[\s\S]*\bTO\s+anon\b/i);
    expect(operational).not.toMatch(/service_role|auth\.admin/i);
    expect(operational).not.toContain('CREATE OR REPLACE FUNCTION public.get_public_qr_payload');
  });

  it('verifies catalog shape, authorization, ledgers, grants, and QR privacy before commit', () => {
    expect(verify).toContain('item_availability.source_kind missing/default/nullable');
    expect(verify).toContain('request idempotency index missing');
    expect(verify).toContain('request fingerprint column missing');
    expect(verify).toContain('request fingerprint constraint missing');
    expect(verify).toContain('source-kind guard must be SECURITY INVOKER');
    expect(verify).toContain('source-kind guard trigger missing, disabled or not DELETE-safe');
    expect(verify).toContain('warehouse_stock_central_item_conflict');
    expect(verify).toContain('phoenix_profile_has_scoped_permission');
    expect(verify).toContain('INSERT INTO public.warehouse_stock_movements');
    expect(verify).toContain('INSERT INTO public.audit_logs');
    expect(verify).toContain('v_def::regprocedure');
    expect(verify).toContain('aclexplode(');
    expect(verify).toContain('acl.grantee = 0');
    expect(verify).toContain("rolname = 'anon'");
    expect(verify).toContain('authenticated retained direct warehouse table writes');
    expect(verify).toContain("v_qr_def NOT ILIKE '%source_kind%'");
    expect(verify).toContain("v_qr_def NOT ILIKE '%internal_batch_reference%'");
  });
});
