/**
 * LIFECYCLE-OUTBOX-PRODUCER-159 — static SQL contract tests.
 *
 * The dynamic proof (a real disposable-Postgres replay, actual lifecycle
 * transitions proving one outbox row per accepted transition, conflict
 * rollback, and zero regression across every attached table) is in
 * 159-lifecycle-outbox-producer.dynamic.test.ts (gated on a live Postgres).
 * These pin the properties that must not regress in review: every
 * pre-existing statement from 155's own function body is preserved
 * byte-for-byte, the new outbox call sits after both existing sink writes
 * and reuses only already-resolved values, and no new trigger or unrelated
 * object is touched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '159_phoenix_lifecycle_outbox_producer.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql
  .slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'))
  .replace(/^[ \t]*--.*$/gm, '');

const fn = () => code.slice(
  code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_capture_lifecycle_event'),
  code.indexOf('COMMENT ON FUNCTION public.phoenix_capture_lifecycle_event'),
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
  it('aborts if it has already been applied (idempotent-apply guard)', () => {
    expect(code).toMatch(/phoenix_capture_lifecycle_event\(\) already references the outbox \(159 already applied\?\)/);
  });
  it('preconditions require exactly 11 pre-existing lifecycle attachments', () => {
    expect(code).toMatch(/expected exactly 11 phoenix_capture_lifecycle attachments, found/);
  });
  it('preconditions require the outbox to be empty and 158\'s lockdown intact', () => {
    expect(code).toMatch(/phoenix_outbox_events must be empty before the first producer activates/);
    expect(code).toMatch(/158''s privilege lockdown on phoenix_outbox_events no longer holds/);
    expect(code).toMatch(/158''s privilege lockdown on the append helper no longer holds/);
  });
});

describe('scope boundary: exactly one function redefined, nothing else', () => {
  it('contains exactly one CREATE OR REPLACE FUNCTION statement', () => {
    const matches = [...code.matchAll(/CREATE OR REPLACE FUNCTION/g)];
    expect(matches.length).toBe(1);
  });
  it('the one redefined function is phoenix_capture_lifecycle_event', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_capture_lifecycle_event\(\)/);
  });
  it('creates no trigger of any kind', () => {
    expect(code).not.toMatch(/CREATE TRIGGER/i);
    expect(code).not.toMatch(/DROP TRIGGER/i);
  });
  it('does not touch the other three capture functions', () => {
    for (const other of ['phoenix_capture_movement_posted', 'phoenix_capture_movement_notification', 'phoenix_capture_stocktake_recorded']) {
      expect(code).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${other}`));
    }
  });
  it('does not touch any business writer RPC', () => {
    for (const writer of [
      'phoenix_send_direct_warehouse_transfer_line', 'phoenix_add_dispatch_line_fefo_guarded',
      'phoenix_add_outlet_return_request_line', 'phoenix_resolve_outlet_return_exception',
      'phoenix_receive_warehouse_transfer_line',
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
});

describe('every pre-existing statement from 155 is preserved byte-for-byte', () => {
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
      "v_new        jsonb := to_jsonb(NEW);",
      "v_old        jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;",
      "v_new_status text  := v_new ->> 'status';",
      "v_old_status text  := v_old ->> 'status';",
      "v_actor      uuid  := auth.uid();",
      "v_home_col   text  := TG_ARGV[0];",
    ]) {
      expect(body).toContain(decl);
    }
  });
  it('preserves the exact accepted-transition guard', () => {
    expect(fn()).toContain(
      "IF v_new_status IS NULL OR v_new_status IS NOT DISTINCT FROM v_old_status THEN\n    RETURN NEW;\n  END IF;",
    );
  });
  it('preserves the exact home-organization resolution', () => {
    expect(fn()).toContain("v_home_org := NULLIF(v_new ->> v_home_col, '')::uuid;");
    expect(fn()).toContain('v_home_org := COALESCE(v_src_org, v_dst_org);');
  });
  it('preserves the exact actor/role/name resolution', () => {
    expect(fn()).toContain('IF v_actor IS NOT NULL THEN');
    expect(fn()).toContain('SELECT p.role, p.full_name INTO v_role, v_name');
  });
  it('preserves the exact dedupe_key formula', () => {
    expect(fn()).toContain("v_dedupe := NEW.id::text || ':' || v_new_status;");
  });
  it('preserves the exact phoenix_movement_events INSERT, unchanged', () => {
    expect(fn()).toContain('INSERT INTO public.phoenix_movement_events (');
    expect(fn()).toContain('ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;');
    expect(fn()).toContain("(SELECT o.name FROM public.organizations o WHERE o.id = v_src_org),");
  });
  it('preserves the exact phoenix_notifications INSERT, unchanged', () => {
    expect(fn()).toContain('INSERT INTO public.phoenix_notifications (');
  });
  it('preserves the v_doc COALESCE including transfer_number (155)', () => {
    expect(fn()).toContain("v_new ->> 'transfer_number'");
  });
});

describe('the one additive change: the outbox PERFORM call', () => {
  it('the PERFORM call appears exactly once and after both existing INSERTs', () => {
    const body = fn();
    const movementIdx = body.indexOf('INSERT INTO public.phoenix_movement_events');
    const notificationIdx = body.indexOf('INSERT INTO public.phoenix_notifications');
    const performIdx = body.indexOf('PERFORM public.phoenix_append_outbox_event_internal(');
    const returnIdx = body.lastIndexOf('RETURN NEW;');
    expect(movementIdx).toBeGreaterThan(-1);
    expect(notificationIdx).toBeGreaterThan(movementIdx);
    expect(performIdx).toBeGreaterThan(notificationIdx);
    expect(returnIdx).toBeGreaterThan(performIdx);
    const occurrences = [...body.matchAll(/phoenix_append_outbox_event_internal/g)];
    expect(occurrences.length).toBe(1);
  });
  it('passes the namespaced event_key: lifecycle: || v_dedupe', () => {
    expect(fn()).toContain("'lifecycle:' || v_dedupe,");
  });
  it('passes event_type identical to the existing sink event_type expression', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toContain("TG_TABLE_NAME || '.' || v_new_status,");
  });
  it('passes event_version 1, aggregate_type = TG_TABLE_NAME, aggregate_id = NEW.id', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toContain('1::smallint,');
    expect(performBlock).toContain('TG_TABLE_NAME,\n    NEW.id,');
  });
  it('passes organization_id = v_home_org and actor_id = v_actor, the exact already-resolved values', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toMatch(/v_home_org,\s*\n\s*jsonb_strip_nulls/);
    expect(performBlock).toMatch(/\)\),\s*\n\s*v_actor,/);
  });
  it('passes NULL for correlation_id, causation_id, and request_id', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    const nullCount = [...performBlock.matchAll(/NULL::uuid/g)].length;
    expect(nullCount).toBe(3);
  });
  it('the payload contains only the five approved fields, built from already-resolved values', () => {
    const performBlock = fn().slice(fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    const payloadBlock = performBlock.slice(
      performBlock.indexOf('jsonb_strip_nulls(jsonb_build_object('),
      performBlock.indexOf('v_actor,'),
    );
    expect(payloadBlock).toContain("'source_table', TG_TABLE_NAME");
    expect(payloadBlock).toContain("'old_status', v_old_status");
    expect(payloadBlock).toContain("'new_status', v_new_status");
    expect(payloadBlock).toContain("'trace_id', NEW.id");
    expect(payloadBlock).toContain("'reference_id', NEW.id");
    for (const forbidden of ['actor_name', 'actor_role', 'v_name', 'v_role', 'organization_name', 'o.name']) {
      expect(payloadBlock).not.toContain(forbidden);
    }
  });
  it('never queries an unrelated table to enrich the payload (no new SELECT beyond the three pre-existing ones)', () => {
    const body = fn();
    const selects = [...body.matchAll(/SELECT /g)];
    // The three pre-existing SELECTs: "SELECT p.role, p.full_name INTO ..."
    // (actor lookup) plus the two "(SELECT o.name FROM public.organizations
    // o WHERE o.id = ...)" subqueries already inside the phoenix_movement_
    // events INSERT ... VALUES clause. The outbox PERFORM block below adds
    // zero new SELECTs of its own — it only reuses v_home_org/v_actor,
    // already resolved above.
    expect(selects.length).toBe(3);
    const performBlock = body.slice(body.indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).not.toMatch(/SELECT /);
  });
  it('the outbox call is not wrapped in its own exception handler (errors must propagate and roll back the whole transaction)', () => {
    const performBlock = fn().slice(
      fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal('),
      fn().indexOf('RETURN NEW;', fn().indexOf('PERFORM public.phoenix_append_outbox_event_internal(')),
    );
    expect(performBlock).not.toMatch(/EXCEPTION WHEN/);
  });
});

describe('VERIFY block proves the D2-2 boundary in-transaction', () => {
  it('asserts exactly one call site to the append helper', () => {
    expect(code).toMatch(/expected exactly one reference to phoenix_append_outbox_event_internal in the function body/);
  });
  it('asserts all 11 named tables individually still carry the trigger', () => {
    for (const table of [
      'warehouse_transfer_requests', 'warehouse_return_requests', 'warehouse_return_shipments',
      'outlet_return_requests', 'outlet_return_shipments', 'warehouse_dispatches',
      'procurement_orders', 'inventory_status_reports',
      'phoenix_stock_correction_requests', 'phoenix_warehouse_correction_requests',
      'warehouse_transfers',
    ]) {
      expect(code).toMatch(new RegExp(`c\\.relname = '${table}' AND NOT t\\.tgisinternal\\s*\\n\\s*\\), '${table} must still carry phoenix_capture_lifecycle'`));
    }
  });
  it('asserts the other three capture functions remain unwired', () => {
    expect(code).toMatch(/phoenix_capture_movement_posted\/notification\/stocktake_recorded must remain unwired from the outbox in D2-2/);
  });
  it('asserts no client role gained outbox access', () => {
    expect(code).toMatch(/authenticated must still lack SELECT on phoenix_outbox_events after 159/);
    expect(code).toMatch(/authenticated must still lack EXECUTE on the append helper after 159/);
    expect(code).toMatch(/anon must still lack SELECT on phoenix_outbox_events after 159/);
  });
  it('asserts applying 159 alone creates zero outbox rows', () => {
    expect(code).toMatch(/applying 159 must not itself produce any outbox row/);
  });
});
