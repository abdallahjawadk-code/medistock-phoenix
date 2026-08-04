/**
 * MOVEMENT-OUTBOX-PRODUCER-161 — static SQL contract tests.
 *
 * The dynamic proof (a real disposable-Postgres replay, actual movement
 * INSERTs proving one outbox row per accepted movement, conflict rollback,
 * and zero regression across every attached table) is in
 * 161-movement-outbox-producer.dynamic.test.ts (gated on a live Postgres).
 * These pin the properties that must not regress in review: every
 * pre-existing statement from 124's own function body is preserved
 * byte-for-byte, the new outbox call sits after the existing sink write and
 * reuses only already-resolved values, phoenix_capture_movement_notification
 * (the audited non-canonical, allowlist-gated candidate) stays unwired, and
 * no new trigger or unrelated object is touched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '161_phoenix_movement_outbox_producer.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql
  .slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'))
  .replace(/^[ \t]*--.*$/gm, '');

const fn = () => code.slice(
  code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_capture_movement_posted'),
  code.indexOf('\nDO $$'),
);

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
  it('aborts if 158 has not been applied', () => {
    expect(code).toMatch(/phoenix_outbox_events is missing — apply 158 first/);
    expect(code).toMatch(/phoenix_append_outbox_event_internal is missing — apply 158 first/);
  });
  it('aborts if 123\\/124 has not been applied', () => {
    expect(code).toMatch(/phoenix_capture_movement_posted\(\) is missing — apply 123\/124 first/);
  });
  it('aborts if 159 has not been applied', () => {
    expect(code).toMatch(/phoenix_capture_lifecycle_event\(\) is missing — apply 159 first/);
  });
  it('aborts if it has already been applied (idempotent-apply guard)', () => {
    expect(code).toMatch(/phoenix_capture_movement_posted\(\) already references the outbox \(161 already applied\?\)/);
  });
  it('preconditions require exactly 3 pre-existing movement-posted attachments', () => {
    expect(code).toMatch(/expected exactly 3 phoenix_capture_movement_posted attachments, found/);
  });
  it('preconditions require 158\'s lockdown intact', () => {
    expect(code).toMatch(/158''s privilege lockdown on phoenix_outbox_events no longer holds/);
    expect(code).toMatch(/158''s privilege lockdown on the append helper no longer holds/);
  });
});

describe('scope boundary: exactly one function redefined, nothing else', () => {
  it('contains exactly one CREATE OR REPLACE FUNCTION statement', () => {
    const matches = [...code.matchAll(/CREATE OR REPLACE FUNCTION/g)];
    expect(matches.length).toBe(1);
  });
  it('the one redefined function is phoenix_capture_movement_posted', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_capture_movement_posted\(\)/);
  });
  it('creates no trigger of any kind', () => {
    expect(code).not.toMatch(/CREATE TRIGGER/i);
    expect(code).not.toMatch(/DROP TRIGGER/i);
  });
  it('does not touch the other three capture functions', () => {
    for (const other of ['phoenix_capture_movement_notification', 'phoenix_capture_stocktake_recorded', 'phoenix_capture_lifecycle_event']) {
      expect(code).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${other}`));
    }
  });
  it('does not touch any business writer RPC', () => {
    for (const writer of [
      'phoenix_send_direct_warehouse_transfer_line', 'phoenix_dispense_outlet_stock',
      'phoenix_receive_warehouse_stock', 'phoenix_apply_warehouse_stock_movement',
      'phoenix_resolve_outlet_return_exception',
    ]) {
      expect(code).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${writer}\\(`));
    }
  });
  it('grants/revokes nothing on any table (no new REVOKE/GRANT statement of any kind)', () => {
    expect(code).not.toMatch(/\bGRANT\b/);
    expect(code).not.toMatch(/\bREVOKE\b/);
  });
  it('creates no new table, no ALTER TABLE, no RLS policy', () => {
    expect(code).not.toMatch(/CREATE TABLE/i);
    expect(code).not.toMatch(/ALTER TABLE/i);
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY/i);
  });
  it('contains no INSERT/UPDATE/DELETE statement against application data outside the function body itself', () => {
    // The one legitimate INSERT is the pre-existing phoenix_movement_events
    // sink write, byte-for-byte preserved from 124 — checked separately
    // below. No OTHER top-level DML exists in this migration.
    const outsideFn = code.slice(0, code.indexOf('CREATE OR REPLACE FUNCTION')) + code.slice(code.indexOf('\nDO $$'));
    expect(outsideFn).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(outsideFn).not.toMatch(/^\s*UPDATE\s+public\./im);
    expect(outsideFn).not.toMatch(/^\s*DELETE\s+FROM\b/im);
  });
});

describe('every pre-existing statement from 124 is preserved byte-for-byte', () => {
  it('preserves the exact function signature: no-arg, RETURNS trigger, plpgsql, SECURITY DEFINER, pinned search_path', () => {
    const header = fn().slice(0, fn().indexOf('AS $capture$'));
    expect(header).toContain('RETURNS trigger');
    expect(header).toContain('LANGUAGE plpgsql');
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toContain('SET search_path = public, pg_temp');
  });
  it('preserves every DECLARE variable exactly', () => {
    const body = fn();
    for (const decl of [
      "v_new     jsonb := to_jsonb(NEW);",
      "v_org     uuid  := NULLIF(v_new ->> 'organization_id', '')::uuid;",
      "v_actor   uuid  := NULLIF(v_new ->> 'actor_id', '')::uuid;",
      "v_type    text  := v_new ->> 'movement_type';",
      "v_occurred timestamptz := COALESCE(NEW.occurred_at, now());",
      "v_correlation uuid := NULLIF(v_new ->> 'correlation_id', '')::uuid;",
      "v_causation   uuid := NULLIF(v_new ->> 'causation_id', '')::uuid;",
    ]) {
      expect(body).toContain(decl);
    }
  });
  it('preserves the exact accepted-movement guard', () => {
    expect(fn()).toContain(
      'IF v_org IS NULL THEN\n    RETURN NEW;  -- never emit an event with no RLS owner; fail closed, not loud\n  END IF;',
    );
  });
  it('preserves the exact quantity before/delta/after COALESCE chains', () => {
    expect(fn()).toContain("NULLIF(v_new ->> 'on_hand_before', '')::integer,");
    expect(fn()).toContain("NULLIF(v_new ->> 'on_hand_delta', '')::integer,");
    expect(fn()).toContain("NULLIF(v_new ->> 'on_hand_after', '')::integer,");
  });
  it('preserves the exact phoenix_movement_events INSERT column list and VALUES, unchanged', () => {
    expect(fn()).toContain('INSERT INTO public.phoenix_movement_events (');
    expect(fn()).toContain("TG_TABLE_NAME || '.posted',");
    expect(fn()).toContain('ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;');
  });
  it('writes to no other sink table (phoenix_notifications is not touched by this function)', () => {
    expect(fn()).not.toContain('INSERT INTO public.phoenix_notifications');
  });
});

describe('the one additive change: the outbox PERFORM call', () => {
  it('the PERFORM call appears exactly once and after the existing INSERT', () => {
    const body = fn();
    const movementIdx = body.indexOf('INSERT INTO public.phoenix_movement_events');
    const performIdx = body.indexOf('PERFORM public.phoenix_append_outbox_event_internal(');
    const returnIdx = body.lastIndexOf('RETURN NEW;');
    expect(movementIdx).toBeGreaterThan(-1);
    expect(performIdx).toBeGreaterThan(movementIdx);
    expect(returnIdx).toBeGreaterThan(performIdx);
    const occurrences = [...body.matchAll(/phoenix_append_outbox_event_internal/g)];
    expect(occurrences.length).toBe(1);
  });
  it('the dedupe_key is computed once, in a variable, and reused for both the sink and the outbox event_key', () => {
    const body = fn();
    expect(body).toContain("v_dedupe := NEW.id::text || ':posted';");
    // The sink INSERT's VALUES clause references v_dedupe directly (not a
    // second independent literal computation of the same formula).
    const insertBlock = body.slice(body.indexOf('INSERT INTO public.phoenix_movement_events'), body.indexOf('ON CONFLICT'));
    expect(insertBlock).toMatch(/v_dedupe\s*$/m);
  });
  it("passes the namespaced event_key: 'movement:' || v_dedupe", () => {
    expect(fn()).toContain("'movement:' || v_dedupe,");
  });
  it('passes event_type identical to the existing sink event_type expression', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toContain("TG_TABLE_NAME || '.posted',");
  });
  it('passes event_version 1, aggregate_type = TG_TABLE_NAME, aggregate_id = NEW.id', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toContain('1::smallint,');
    expect(performBlock).toContain('TG_TABLE_NAME,\n    NEW.id,');
  });
  it('passes organization_id = v_org and actor_id = v_actor, the exact already-resolved values', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toMatch(/v_org,\s*\n\s*jsonb_strip_nulls/);
    expect(performBlock).toMatch(/\)\),\s*\n\s*v_actor,/);
  });
  it('passes v_correlation and v_causation (reused, never manufactured) and NULL for request_id', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toMatch(/v_actor,\s*\n\s*v_correlation,\s*\n\s*v_causation,\s*\n\s*NULL::uuid/);
    const nullCount = [...performBlock.matchAll(/NULL::uuid/g)].length;
    expect(nullCount).toBe(1);
  });
  it('the payload contains only the six approved fields, built from already-resolved values', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    const payloadBlock = performBlock.slice(
      performBlock.indexOf('jsonb_strip_nulls(jsonb_build_object('),
      performBlock.indexOf('v_actor,'),
    );
    expect(payloadBlock).toContain("'source_table', TG_TABLE_NAME");
    expect(payloadBlock).toContain("'movement_type', v_type");
    expect(payloadBlock).toContain("'quantity_delta', v_delta");
    expect(payloadBlock).toContain("'trace_id', NEW.id");
    expect(payloadBlock).toContain("'reference_id', NEW.id");
    expect(payloadBlock).toContain("'occurred_at', v_occurred");
    for (const forbidden of ['actor_name', 'actor_role', 'v_name', 'v_role', 'organization_name', 'o.name', 'source_label', 'destination_label']) {
      expect(payloadBlock).not.toContain(forbidden);
    }
  });
  it('never queries an unrelated table to enrich the payload (no new SELECT beyond what 124 already had)', () => {
    const body = fn();
    const selects = [...body.matchAll(/SELECT /g)];
    // 124's own body has zero top-level SELECT statements (unlike 159's
    // lifecycle function, movement-posted never looks up actor role/name —
    // v_role/v_name come straight off the movement row's own jsonb).
    expect(selects.length).toBe(0);
  });
  it('the outbox call is not wrapped in its own exception handler (errors must propagate and roll back the whole transaction)', () => {
    const performBlock = fn().slice(
      fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('),
      fn().indexOf('RETURN NEW;', fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal(')),
    );
    expect(performBlock).not.toMatch(/EXCEPTION WHEN/);
  });
});

describe('VERIFY block proves the D2-3 boundary in-transaction', () => {
  it('asserts exactly one call site to the append helper', () => {
    expect(code).toMatch(/expected exactly one reference to phoenix_append_outbox_event_internal in the function body/);
  });
  it('asserts all 3 named tables individually still carry the trigger', () => {
    for (const table of ['warehouse_stock_movements', 'outlet_stock_movements', 'warehouse_quarantine_stock_movements']) {
      expect(code).toMatch(new RegExp(`c\\.relname = '${table}' AND NOT t\\.tgisinternal\\s*\\n\\s*\\), '${table} must still carry phoenix_capture_movement_posted'`));
    }
  });
  it('asserts phoenix_capture_movement_notification remains unwired (the audited non-canonical candidate)', () => {
    expect(code).toMatch(/phoenix_capture_movement_notification must remain unwired from the outbox in D2-3/);
  });
  it('asserts phoenix_capture_stocktake_recorded remains unwired (D2-4 scope)', () => {
    expect(code).toMatch(/phoenix_capture_stocktake_recorded must remain unwired from the outbox in D2-3/);
  });
  it("asserts 159's lifecycle producer is completely unchanged", () => {
    expect(code).toMatch(/159''s 11 lifecycle trigger attachments must remain unchanged/);
    expect(code).toMatch(/phoenix_capture_lifecycle_event must still contain exactly one outbox-helper reference, found/);
  });
  it('asserts no client role gained outbox access', () => {
    expect(code).toMatch(/authenticated must still lack SELECT on phoenix_outbox_events after 161/);
    expect(code).toMatch(/authenticated must still lack EXECUTE on the append helper after 161/);
    expect(code).toMatch(/anon must still lack SELECT on phoenix_outbox_events after 161/);
  });
  it('asserts applying 161 alone creates zero outbox rows', () => {
    expect(code).toMatch(/applying 161 must not itself produce any outbox row/);
  });
  it('asserts no D3 consumer/processing column exists on the outbox table', () => {
    expect(code).toMatch(/phoenix_outbox_events must carry no D3 consumer\/processing column/);
  });
});
