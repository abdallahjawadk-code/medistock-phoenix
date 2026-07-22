/**
 * MOVEMENT-EVENT-CAPTURE-082 — static SQL contract tests.
 *
 * The dynamic proof (real RPCs → ledger → timeline, idempotency, scope) is in
 * 082-event-capture.dynamic.test.ts (gated on a live Postgres) and recorded in
 * docs/phoenix/migration-082-event-capture-validation.md. These pin the
 * properties that must not regress in review: that capture is server-side,
 * transactional, idempotent, actor-attributed, and does not weaken 081's ledger
 * lock-down or its honesty about completeness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '082_phoenix_movement_event_capture.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql
  .slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'))
  .replace(/^[ \t]*--.*$/gm, '');

const HEADERS = [
  'warehouse_transfer_requests',
  'warehouse_return_requests',
  'warehouse_return_shipments',
  'outlet_return_requests',
  'outlet_return_shipments',
  'warehouse_dispatches',
];

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
  it('aborts if 081 has not been applied', () => {
    expect(code).toMatch(/phoenix_movement_events.*missing|missing.*apply 081/s);
    expect(code).toMatch(/phoenix_movement_timeline.*missing/s);
  });
});

describe('it names the 081 gap honestly', () => {
  it('states that 081 shipped no writer', () => {
    expect(sql).toMatch(/shipped NO writer|no real server writer|NO writer/);
  });
  it('does not backfill history and keeps completeness false', () => {
    expect(sql).toMatch(/NOT backfilled|not backfilled/);
    expect(code).toContain("'complete', false");
    expect(code).not.toMatch(/'complete',\s*true/);
  });
});

describe('capture is server-side, transactional and immutable', () => {
  it('captures via an AFTER INSERT OR UPDATE trigger on every corridor header', () => {
    for (const t of HEADERS) {
      const re = new RegExp(
        `CREATE TRIGGER phoenix_capture_lifecycle\\s+AFTER INSERT OR UPDATE ON public\\.${t}\\b`, 's');
      expect(code).toMatch(re);
    }
  });
  it('the capture function is SECURITY DEFINER with a pinned search_path', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path = public, pg_temp/);
  });
  it('does not grant the ledger any new write privilege to authenticated', () => {
    // 081's lock-down (REVOKE INSERT/UPDATE/DELETE) must not be undone here.
    expect(code).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[^;]*phoenix_movement_events[^;]*authenticated/i);
  });
});

describe('actor and scope', () => {
  it('records the authenticated actor, not a client-supplied value', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    expect(fn).toMatch(/v_actor\s+uuid\s*:=\s*auth\.uid\(\)/);
    expect(fn).toMatch(/actor_id/);
  });
  it('owns each event by the initiating org passed per-table as a trigger arg', () => {
    expect(code).toMatch(/EXECUTE FUNCTION public\.phoenix_capture_lifecycle_event\('destination_organization_id'\)/);
    expect(code).toMatch(/EXECUTE FUNCTION public\.phoenix_capture_lifecycle_event\('source_organization_id'\)/);
    expect(code).toMatch(/EXECUTE FUNCTION public\.phoenix_capture_lifecycle_event\('organization_id'\)/);
  });
});

describe('idempotency / retry safety', () => {
  it('adds a UNIQUE dedupe key and appends with ON CONFLICT DO NOTHING', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX[^;]*phoenix_movement_events_dedupe_uniq/s);
    expect(code).toMatch(/ON CONFLICT\s*\(dedupe_key\)[^;]*DO NOTHING/s);
  });
  it('only emits on a genuine status transition', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    expect(fn).toMatch(/IS NOT DISTINCT FROM v_old_status/);
  });
});

describe('timeline: no double counting', () => {
  it('suppresses derived-column events once the ledger records the trace', () => {
    // The derived branch is gated on NOT v_has_ledger so a transition captured
    // by the ledger is never also shown from a header column.
    expect(code).toMatch(/v_has_ledger/);
    expect(code).toMatch(/AND NOT v_has_ledger/);
  });
  it('still preserves forbidden==nonexistent indistinguishability', () => {
    // Same empty shape on no-profile and null trace, inherited from 081.
    expect(code).toMatch(/RETURN v_empty/);
  });
});
