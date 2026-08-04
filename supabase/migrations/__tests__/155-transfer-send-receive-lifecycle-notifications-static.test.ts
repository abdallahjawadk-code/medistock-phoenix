/**
 * TRANSFER-SEND-RECEIVE-LIFECYCLE-NOTIFICATIONS-155 — static SQL contract
 * tests.
 *
 * Phase D0 found `warehouse_transfers` / `warehouse_transfer_lines` were the
 * only two of the eight corridor header+line pairs never wired to
 * 082/094's `phoenix_capture_lifecycle` trigger. 155 closes exactly the
 * header gap (see the migration's own header comment for why the line table
 * stays deliberately unwired — the same pattern already used by every other
 * corridor's line table). The dynamic proof (a real SEND/RECEIVE producing
 * feed rows) is in 155-transfer-send-receive-lifecycle-notifications.dynamic.test.ts
 * (gated on a live Postgres).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '155_phoenix_transfer_send_receive_lifecycle_notifications.sql';
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
  it('aborts if 082 has not been applied', () => {
    expect(code).toMatch(/phoenix_capture_lifecycle_event\(\).*missing.*apply 082 first/s);
  });
  it('aborts if already applied', () => {
    expect(code).toMatch(/phoenix_capture_lifecycle already exists on warehouse_transfers \(155 already applied\?\)/);
  });
});

describe('the capture trigger is extended, not duplicated', () => {
  it('redefines phoenix_capture_lifecycle_event with the same name', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_capture_lifecycle_event\(\)/);
  });
  it('adds exactly one new trigger object, on warehouse_transfers', () => {
    const creates = code.match(/CREATE TRIGGER phoenix_capture_lifecycle/g) ?? [];
    expect(creates.length).toBe(1);
    expect(code).toMatch(/CREATE TRIGGER phoenix_capture_lifecycle\s+AFTER INSERT OR UPDATE ON public\.warehouse_transfers/);
  });
  it('never attaches a trigger to warehouse_transfer_lines', () => {
    expect(code).not.toMatch(/ON public\.warehouse_transfer_lines/);
  });
  it('uses source_organization_id as the home column, matching the shipment-shaped corridors', () => {
    expect(code).toMatch(/phoenix_capture_lifecycle_event\('source_organization_id'\)/);
  });
  it('extends the document-label COALESCE additively with transfer_number, keeping every existing key', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    const coalesce = fn.slice(fn.indexOf('v_doc'), fn.indexOf(';', fn.indexOf('v_doc')));
    for (const key of ['request_number', 'return_number', 'shipment_number', 'dispatch_number', 'transfer_number']) {
      expect(coalesce).toContain(`'${key}'`);
    }
  });
  it('still writes both phoenix_movement_events and phoenix_notifications (082/094 behaviour preserved)', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    expect(fn).toMatch(/INSERT INTO public\.phoenix_movement_events/);
    expect(fn).toMatch(/INSERT INTO public\.phoenix_notifications/);
    expect(fn).toMatch(/IS NOT DISTINCT FROM v_old_status/); // still gated on a real transition
  });
  it('shares one dedupe_key text across both inserts, each guarded by its own ON CONFLICT', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    const dedupeAssigns = fn.match(/v_dedupe\s*:=/g) ?? [];
    expect(dedupeAssigns.length).toBe(1);
    const conflictClauses = fn.match(/ON CONFLICT \(dedupe_key\) WHERE dedupe_key IS NOT NULL DO NOTHING/g) ?? [];
    expect(conflictClauses.length).toBe(2);
  });
  it('is still SECURITY DEFINER with pinned search_path', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path = public, pg_temp/);
  });
});

describe('scope discipline: no privilege, RLS, or unrelated object touched', () => {
  it('never grants or revokes any TABLE privilege (the one function-level REVOKE is unchanged from 082/094)', () => {
    expect(code).not.toMatch(/\bGRANT\b/);
    const revokeLines = code.match(/^REVOKE.*$/gm) ?? [];
    for (const line of revokeLines) {
      expect(line).toMatch(/^REVOKE ALL ON FUNCTION public\.phoenix_capture_lifecycle_event\(\) FROM PUBLIC;$/);
    }
  });
  it('never touches RLS (no ALTER TABLE ... ROW LEVEL SECURITY, no CREATE/DROP POLICY)', () => {
    expect(code).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY/i);
  });
  it('touches no table other than attaching a trigger to warehouse_transfers', () => {
    expect(code).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/i);
  });
});
