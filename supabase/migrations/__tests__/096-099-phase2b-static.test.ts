/**
 * PHASE-2B-STATIC — registration + discipline contract tests for 096-099.
 * The behavioral proof for all of them is
 * 095-099-phase2b-core.dynamic.test.ts (real Postgres, 001->099 replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const FILES = [
  '096_phoenix_bulk_receive_matching_dispatch_lines.sql',
  '097_phoenix_fefo_reasoned_override.sql',
  '098_phoenix_second_person_correction_approval.sql',
  '099_phoenix_notification_wiring_and_quarantine_disposition.sql',
];

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it.each(FILES)('%s is registered and manual-apply-only', (name) => {
    expect(REVIEWED_MIGRATION_FILES).toContain(name);
    const { sql } = load(name);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('096 — bulk receive', () => {
  const { code } = load('096_phoenix_bulk_receive_matching_dispatch_lines.sql');
  it('only auto-receives an EXACT count match; a mismatch is reported, never forced', () => {
    expect(code).toMatch(/v_counted <> v_line\.sent_quantity/);
    expect(code).toMatch(/skipped_mismatch_requires_individual_review/);
  });
  it('delegates the write to 070s existing single-line RPC (no reimplementation)', () => {
    expect(code).toMatch(/public\.phoenix_receive_outlet_dispatch_line\(/);
  });
  it('wraps each line in its own exception block (implicit savepoint)', () => {
    expect(code).toMatch(/EXCEPTION WHEN OTHERS THEN/);
  });
});

describe('097 — FEFO override', () => {
  const { code } = load('097_phoenix_fefo_reasoned_override.sql');
  it('adds an independent scoped permission key, is_dangerous=true', () => {
    expect(code).toMatch(/'inventory\.fefo_override'.*true\)/s);
  });
  it('fails closed without override, requires a reason, and audits before/after', () => {
    expect(code).toMatch(/fefo_override_required/);
    expect(code).toMatch(/fefo_override_reason_required/);
    expect(code).toMatch(/before_fefo_stock_id/);
    expect(code).toMatch(/after_chosen_stock_id/);
  });
});

describe('098 — second-person correction approval', () => {
  const { code } = load('098_phoenix_second_person_correction_approval.sql');
  it('fails closed: the column default is 0, and no migration-time seed row is inserted', () => {
    expect(code).toMatch(/threshold_quantity\s+integer NOT NULL DEFAULT 0/);
    // Section A/B (outside any function body) must not itself INSERT a row —
    // only the phoenix_set_variance_approval_policy RPC ever does, at
    // runtime, on explicit CWM action. Slice off everything from the first
    // CREATE FUNCTION onward before checking for a migration-time seed.
    const beforeFirstFunction = code.slice(0, code.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(beforeFirstFunction).not.toMatch(/INSERT INTO public\.phoenix_variance_approval_policy/);
  });
  it('the proposer can never approve their own request, checked by identity', () => {
    expect(code).toMatch(/v_req\.proposed_by = v_actor/);
    expect(code).toMatch(/proposer_cannot_approve_own_correction/);
  });
});

describe('099 — notification wiring + quarantine disposition', () => {
  const { code } = load('099_phoenix_notification_wiring_and_quarantine_disposition.sql');
  it('reuses the existing generic header trigger for 087/092 (no new trigger logic)', () => {
    expect(code).toMatch(/AFTER INSERT OR UPDATE ON public\.procurement_orders/);
    expect(code).toMatch(/AFTER INSERT OR UPDATE ON public\.inventory_status_reports/);
  });
  it('never passes a literal NULL as a trigger argument (the string-vs-NULL trap)', () => {
    expect(code).not.toMatch(/phoenix_capture_movement_notification\(NULL\)/);
  });
  it('quarantine release requires an existing destination lot with matching identity', () => {
    expect(code).toMatch(/destination_material_batch_expiry_mismatch/);
  });
  it('quarantine destroy never credits any destination (pure debit)', () => {
    const destroyFn = code.slice(
      code.indexOf('FUNCTION public.phoenix_destroy_quarantine_stock'),
    );
    expect(destroyFn).not.toMatch(/UPDATE public\.warehouse_stock SET on_hand_quantity/);
  });
});
