/**
 * TRANSACTIONAL-OUTBOX-FOUNDATION-158 — static SQL contract tests.
 *
 * The dynamic proof (a real disposable-Postgres replay, actual helper calls
 * proving replay/conflict/concurrency/rollback) is in
 * 158-transactional-outbox-foundation.dynamic.test.ts (gated on a live
 * Postgres). These pin the properties that must not regress in review: the
 * D2-1 scope boundary (zero triggers, zero wiring, zero grants to any role),
 * the exact table/helper contract, and that no existing object is touched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '158_phoenix_transactional_outbox_foundation.sql';
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
  it('aborts if it has already been applied (idempotent-apply guard)', () => {
    expect(code).toMatch(/phoenix_outbox_events already exists \(158 already applied\?\)/);
    expect(code).toMatch(/phoenix_append_outbox_event_internal already exists \(158 already applied\?\)/);
  });
});

describe('the outbox table — exact 15-column contract', () => {
  it('creates phoenix_outbox_events with every approved column', () => {
    expect(code).toMatch(/CREATE TABLE public\.phoenix_outbox_events/);
    for (const col of [
      'id', 'stream_position', 'event_key', 'event_fingerprint', 'event_type',
      'event_version', 'aggregate_type', 'aggregate_id', 'organization_id',
      'actor_id', 'correlation_id', 'causation_id', 'request_id', 'payload', 'occurred_at',
    ]) {
      expect(code).toContain(col);
    }
  });
  it('stream_position is identity-backed and unique, not a plain serial or a business sequence', () => {
    expect(code).toMatch(/stream_position\s+bigint GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE/);
  });
  it('event_key is unique', () => {
    expect(code).toMatch(/event_key\s+text NOT NULL UNIQUE/);
  });
  it('organization_id is a real FK with RESTRICT delete behavior, matching phoenix_movement_events', () => {
    expect(code).toMatch(/organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE RESTRICT/);
  });
  it('actor_id has no auth.users foreign key, mirroring phoenix_movement_events.actor_id exactly', () => {
    expect(code).toMatch(/actor_id\s+uuid NULL,/);
    expect(code).not.toMatch(/actor_id\s+uuid NULL\s+REFERENCES/);
  });
  it('correlation_id, causation_id, and request_id are plain nullable uuid with no FK', () => {
    expect(code).toMatch(/correlation_id\s+uuid NULL,/);
    expect(code).toMatch(/causation_id\s+uuid NULL,/);
    expect(code).toMatch(/request_id\s+uuid NULL,/);
  });
  it('declares all five required CHECK constraints', () => {
    expect(code).toMatch(/CONSTRAINT poe_event_key_chk\s+CHECK \(btrim\(event_key\) = event_key AND event_key <> ''\)/);
    expect(code).toMatch(/CONSTRAINT poe_event_type_chk\s+CHECK \(btrim\(event_type\) = event_type AND event_type <> ''\)/);
    expect(code).toMatch(/CONSTRAINT poe_aggregate_type_chk\s+CHECK \(btrim\(aggregate_type\) = aggregate_type AND aggregate_type <> ''\)/);
    expect(code).toMatch(/CONSTRAINT poe_event_version_chk\s+CHECK \(event_version > 0\)/);
    expect(code).toMatch(/CONSTRAINT poe_payload_object_chk\s+CHECK \(jsonb_typeof\(payload\) = 'object'\)/);
  });
});

describe('security contract: RLS enabled, zero policies, ALL revoked from every non-owner role', () => {
  it('enables RLS on the outbox table', () => {
    expect(code).toMatch(/ALTER TABLE public\.phoenix_outbox_events ENABLE ROW LEVEL SECURITY/);
  });
  it('creates no CREATE POLICY of any kind for the outbox table', () => {
    expect(code).not.toMatch(/CREATE POLICY[^;]*phoenix_outbox_events/i);
  });
  it('revokes ALL table privileges from PUBLIC, authenticated, and anon', () => {
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.phoenix_outbox_events FROM PUBLIC, authenticated, anon;/);
  });
  it('revokes ALL EXECUTE on the helper from PUBLIC, authenticated, and anon, and grants it to no one', () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_append_outbox_event_internal\([^)]*\) FROM PUBLIC, authenticated, anon;/,
    );
    expect(code).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_append_outbox_event_internal/);
  });
});

describe('the internal append helper — exact signature and idempotency mechanism', () => {
  const SIG = 'text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid';
  it('creates exactly the documented 11-parameter signature', () => {
    expect(code).toMatch(/CREATE FUNCTION public\.phoenix_append_outbox_event_internal\(/);
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.phoenix_append_outbox_event_internal'));
    const header = fn.slice(0, fn.indexOf('RETURNS TABLE'));
    expect(header).toMatch(/p_event_key\s+text/);
    expect(header).toMatch(/p_event_type\s+text/);
    expect(header).toMatch(/p_event_version\s+smallint/);
    expect(header).toMatch(/p_aggregate_type\s+text/);
    expect(header).toMatch(/p_aggregate_id\s+uuid/);
    expect(header).toMatch(/p_organization_id\s+uuid/);
    expect(header).toMatch(/p_payload\s+jsonb/);
    expect(header).toMatch(/p_actor_id\s+uuid DEFAULT NULL/);
    expect(header).toMatch(/p_correlation_id\s+uuid DEFAULT NULL/);
    expect(header).toMatch(/p_causation_id\s+uuid DEFAULT NULL/);
    expect(header).toMatch(/p_request_id\s+uuid DEFAULT NULL/);
  });
  it('is SECURITY DEFINER with pinned search_path', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.phoenix_append_outbox_event_internal'));
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path = public, pg_temp/);
  });
  it('validates every required value before touching the table', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.phoenix_append_outbox_event_internal'));
    for (const err of [
      'outbox_event_key_required', 'outbox_event_type_required', 'outbox_event_version_must_be_positive',
      'outbox_aggregate_type_required', 'outbox_aggregate_id_required', 'outbox_organization_id_required',
      'outbox_payload_must_be_object',
    ]) {
      expect(fn).toContain(err);
    }
  });
  it('computes a sha256 fingerprint over every field that defines the event, including all four identity/correlation fields', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.phoenix_append_outbox_event_internal'));
    const fpBlock = fn.slice(fn.indexOf('v_fp := encode'), fn.indexOf('hashtextextended'));
    for (const key of [
      'event_key', 'event_type', 'event_version', 'aggregate_type', 'aggregate_id',
      'organization_id', 'actor_id', 'correlation_id', 'causation_id', 'request_id', 'payload',
    ]) {
      expect(fpBlock).toContain(key);
    }
  });
  it('uses advisory-lock salt 158158, distinct from every other salt already in this repository', () => {
    expect(code).toContain('hashtextextended(p_event_key, 158158)');
    for (const otherSalt of ['106106', '156156', '157157']) {
      expect(code).not.toContain(otherSalt);
    }
  });
  it('replays the existing row on a fingerprint match, and raises outbox_event_key_conflict (23505) on a mismatch', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.phoenix_append_outbox_event_internal'));
    expect(fn).toMatch(/RETURN QUERY SELECT v_existing\.id, v_existing\.stream_position;/);
    const conflictRaises = [...fn.matchAll(/RAISE EXCEPTION 'outbox_event_key_conflict' USING ERRCODE = '23505'/g)];
    expect(conflictRaises.length).toBe(2);
  });
  it('does not rely on bare ON CONFLICT DO NOTHING as the correctness contract', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.phoenix_append_outbox_event_internal'));
    expect(fn).not.toMatch(/ON CONFLICT[^;]*DO NOTHING/i);
  });
  it('wraps the INSERT in an exception block that catches unique_violation as the final correctness guarantee', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.phoenix_append_outbox_event_internal'));
    const insertIdx = fn.indexOf('INSERT INTO public.phoenix_outbox_events');
    const exceptionIdx = fn.indexOf('EXCEPTION WHEN unique_violation THEN');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(exceptionIdx).toBeGreaterThan(insertIdx);
  });
  it('never UPDATEs or DELETEs the outbox table anywhere in its body', () => {
    const fn = code.slice(code.indexOf('CREATE FUNCTION public.phoenix_append_outbox_event_internal'));
    expect(fn).not.toMatch(/UPDATE\s+public\.phoenix_outbox_events/i);
    expect(fn).not.toMatch(/DELETE\s+FROM\s+public\.phoenix_outbox_events/i);
  });
});

describe('D2-1 scope boundary: zero wiring, zero producer changes', () => {
  it('creates no trigger of any kind', () => {
    expect(code).not.toMatch(/CREATE TRIGGER/i);
  });
  it('does not touch any existing capture function', () => {
    for (const fn of [
      'phoenix_capture_lifecycle_event', 'phoenix_capture_movement_posted',
      'phoenix_capture_movement_notification', 'phoenix_capture_stocktake_recorded',
    ]) {
      expect(code).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`));
    }
  });
  it('does not touch any existing business writer RPC', () => {
    for (const fn of [
      'phoenix_send_direct_warehouse_transfer_line', 'phoenix_add_dispatch_line_fefo_guarded',
      'phoenix_add_outlet_return_request_line', 'phoenix_resolve_outlet_return_exception',
      'phoenix_dispense_outlet_stock_with_context',
    ]) {
      expect(code).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
    }
  });
  it('grants/revokes nothing on any pre-existing table', () => {
    const withoutNewObjects = code
      .slice(0, code.indexOf('CREATE TABLE public.phoenix_outbox_events'))
      + code.slice(code.indexOf('-- =========================================================================='));
    for (const table of [
      'warehouse_transfer_requests', 'warehouse_transfers', 'outlet_return_request_lines',
      'warehouse_stock_movements', 'outlet_stock_movements', 'phoenix_movement_events', 'phoenix_notifications',
    ]) {
      expect(withoutNewObjects).not.toMatch(new RegExp(`(GRANT|REVOKE)[^;]*\\bpublic\\.${table}\\b`));
    }
  });
});

describe('proves zero rows are written merely by applying the migration', () => {
  it('the VERIFY block asserts the table is empty immediately after creation', () => {
    expect(code).toMatch(/applying 158 must not itself produce any outbox row/);
  });
});
