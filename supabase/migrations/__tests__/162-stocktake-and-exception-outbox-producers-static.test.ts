/**
 * STOCKTAKE-AND-EXCEPTION-OUTBOX-PRODUCERS-162 — static SQL contract tests.
 *
 * The dynamic proof (a real disposable-Postgres replay, real stocktake and
 * outlet-return-exception-resolution INSERTs proving one/two outbox rows per
 * accepted action, idempotent replay, fail-closed conflict, org isolation,
 * demo seed/purge, and zero regression across every attached table) is in
 * 162-stocktake-and-exception-outbox-producers.dynamic.test.ts (gated on a
 * live Postgres). These pin the properties that must not regress in review:
 * every pre-existing statement from 123's/157's own bodies is preserved, the
 * new PERFORM calls sit exactly where the migration's own header/VERIFY
 * documents them, each new payload carries exactly its seven approved
 * fields (byte-exact ordering, explicit reason-exclusion), and no unrelated
 * object is touched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '162_phoenix_stocktake_and_exception_outbox_producers.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql
  .slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'))
  .replace(/^[ \t]*--.*$/gm, '');

const fnStock = () => code.slice(
  code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_capture_stocktake_recorded'),
  code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_resolve_outlet_return_exception'),
);
const fnExc = () => code.slice(
  code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_resolve_outlet_return_exception'),
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
  it('aborts if the stocktake producer or exception RPC is missing', () => {
    expect(code).toMatch(/phoenix_capture_stocktake_recorded\(\) is missing — apply 123 first/);
    expect(code).toMatch(/phoenix_resolve_outlet_return_exception\(\.\.\.\) is missing — apply 157 first/);
    expect(code).toMatch(/phoenix_outlet_return_exception_resolutions is missing — apply 157 first/);
  });
  it('aborts if it has already been applied (idempotent-apply guard, both functions)', () => {
    expect(code).toMatch(/phoenix_capture_stocktake_recorded\(\) already references the outbox \(162 already applied\?\)/);
    expect(code).toMatch(/phoenix_resolve_outlet_return_exception\(\.\.\.\) already references the outbox \(162 already applied\?\)/);
  });
  it('preconditions require exactly 1 pre-existing stocktake attachment, row-level AFTER INSERT', () => {
    expect(code).toMatch(/expected exactly 1 phoenix_capture_stocktake_recorded attachment, found/);
    expect(code).toMatch(/phoenix_capture_stocktake_recorded must be a row-level AFTER INSERT trigger on stocktakes/);
  });
  it('preconditions require the exception RPC\'s exact 6-arg signature', () => {
    expect(code).toMatch(/phoenix_resolve_outlet_return_exception\(uuid,uuid,text,text,integer,text\)/);
  });
  it('preconditions require both pre-existing UNIQUE constraints on the exception table', () => {
    expect(code).toMatch(/phoenix_outlet_return_exception_resolutions_request_id_key/);
    expect(code).toMatch(/phoenix_outlet_return_exception_res_return_shipment_line_id_key/);
  });
  it('preconditions require authenticated/anon to lack direct INSERT on the exception table', () => {
    expect(code).toMatch(/authenticated must not have direct INSERT on phoenix_outlet_return_exception_resolutions/);
    expect(code).toMatch(/anon must not have direct INSERT on phoenix_outlet_return_exception_resolutions/);
  });
  it('preconditions require 158\'s lockdown intact and 159/161 present', () => {
    expect(code).toMatch(/158''s privilege lockdown on phoenix_outbox_events no longer holds/);
    expect(code).toMatch(/158''s privilege lockdown on the append helper no longer holds/);
    expect(code).toMatch(/phoenix_capture_lifecycle_event\(\) is missing — apply 159 first/);
    expect(code).toMatch(/phoenix_capture_movement_posted\(\) is missing — apply 161 first/);
  });
});

describe('scope boundary: exactly two functions redefined, nothing else', () => {
  it('contains exactly two CREATE OR REPLACE FUNCTION statements', () => {
    const matches = [...code.matchAll(/CREATE OR REPLACE FUNCTION/g)];
    expect(matches.length).toBe(2);
  });
  it('the two redefined functions are the stocktake producer and the exception RPC', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_capture_stocktake_recorded\(\)/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_resolve_outlet_return_exception\(/);
  });
  it('creates no trigger of any kind', () => {
    expect(code).not.toMatch(/CREATE TRIGGER/i);
    expect(code).not.toMatch(/DROP TRIGGER/i);
  });
  it('does not touch the other two capture functions', () => {
    for (const other of ['phoenix_capture_movement_notification', 'phoenix_capture_movement_posted', 'phoenix_capture_lifecycle_event']) {
      expect(code).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${other}`));
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

describe('stocktake producer: every pre-existing statement from 123 is preserved', () => {
  it('preserves the exact function signature: no-arg, RETURNS trigger, plpgsql, SECURITY DEFINER, pinned search_path', () => {
    const header = fnStock().slice(0, fnStock().indexOf('AS $capture$'));
    expect(header).toContain('RETURNS trigger');
    expect(header).toContain('LANGUAGE plpgsql');
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toContain('SET search_path = public, pg_temp');
  });
  it('preserves the actor role/name lookup exactly', () => {
    expect(fnStock()).toContain('IF NEW.performed_by IS NOT NULL THEN');
    expect(fnStock()).toContain('SELECT p.role, p.full_name INTO v_role, v_name');
    expect(fnStock()).toContain('FROM public.profiles p WHERE p.id = NEW.performed_by;');
  });
  it('preserves the exact phoenix_movement_events INSERT column list and dedupe_key, unchanged', () => {
    const body = fnStock();
    expect(body).toContain('INSERT INTO public.phoenix_movement_events (');
    expect(body).toContain("'stocktakes.recorded',");
    expect(body).toContain("NEW.id::text || ':recorded'");
    expect(body).toContain('ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;');
  });
  it('the sink INSERT now references v_occurred instead of an independent now() literal', () => {
    const body = fnStock();
    const insertBlock = body.slice(body.indexOf('INSERT INTO public.phoenix_movement_events'), body.indexOf('ON CONFLICT'));
    expect(insertBlock).toMatch(/v_occurred,/);
    expect(insertBlock).not.toMatch(/\bnow\(\)/);
  });
  it('declares v_occurred once, defaulted to now(), and never recomputes it', () => {
    const body = fnStock();
    expect(body).toContain('v_occurred timestamptz := now();');
    const occurrences = [...body.matchAll(/\bnow\(\)/g)];
    expect(occurrences.length).toBe(1);
  });
});

describe('stocktake producer: the one additive change — the outbox PERFORM call', () => {
  it('the PERFORM call appears exactly once and after the existing INSERT, before RETURN NEW', () => {
    const body = fnStock();
    const insertIdx = body.indexOf('INSERT INTO public.phoenix_movement_events');
    const performIdx = body.indexOf('PERFORM public.phoenix_append_outbox_event_internal(');
    const returnIdx = body.lastIndexOf('RETURN NEW;');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(performIdx).toBeGreaterThan(insertIdx);
    expect(returnIdx).toBeGreaterThan(performIdx);
    const occurrences = [...body.matchAll(/phoenix_append_outbox_event_internal/g)];
    expect(occurrences.length).toBe(1);
  });
  it("passes the namespaced event-key expression: 'stocktake:' || NEW.id::text || ':recorded'", () => {
    expect(fnStock()).toContain("'stocktake:' || NEW.id::text || ':recorded',");
  });
  it('passes the fixed event_type literal, event_version 1, aggregate_type/aggregate_id', () => {
    const performBlock = fnStock().slice(fnStock().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toContain("'stocktakes.recorded',");
    expect(performBlock).toContain('1::smallint,');
    expect(performBlock).toContain('TG_TABLE_NAME,\n    NEW.id,');
  });
  it('passes organization_id = NEW.organization_id and actor_id = NEW.performed_by', () => {
    const performBlock = fnStock().slice(fnStock().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    expect(performBlock).toMatch(/NEW\.organization_id,\s*\n\s*jsonb_strip_nulls/);
    expect(performBlock).toMatch(/\)\),\s*\n\s*NEW\.performed_by,/);
  });
  it('passes NULL for correlation_id, causation_id, and request_id (stocktakes has none of these columns)', () => {
    const performBlock = fnStock().slice(fnStock().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    const tail = performBlock.slice(performBlock.indexOf('NEW.performed_by,'));
    const nullCount = [...tail.matchAll(/NULL::uuid/g)].length;
    expect(nullCount).toBe(3);
  });
  it('the payload contains exactly the six approved fields, built from already-resolved values, in order', () => {
    const performBlock = fnStock().slice(fnStock().indexOf('PERFORM public.phoenix_append_outbox_event_internal('));
    const payloadBlock = performBlock.slice(
      performBlock.indexOf('jsonb_strip_nulls(jsonb_build_object('),
      performBlock.indexOf('NEW.performed_by,'),
    );
    const keysInOrder = [...payloadBlock.matchAll(/'(\w+)',/g)].map(m => m[1]);
    expect(keysInOrder).toEqual(['source_table', 'scope_kind', 'scope_id', 'trace_id', 'reference_id', 'occurred_at']);
    expect(payloadBlock).toContain("'source_table', TG_TABLE_NAME");
    expect(payloadBlock).toContain("'scope_kind', NEW.scope_kind");
    expect(payloadBlock).toContain("'scope_id', NEW.scope_id");
    expect(payloadBlock).toContain("'trace_id', NEW.id");
    expect(payloadBlock).toContain("'reference_id', NEW.id");
    expect(payloadBlock).toContain("'occurred_at', v_occurred");
    expect(payloadBlock).not.toContain('NEW.notes');
    for (const forbidden of ['notes', 'actor_name', 'actor_role', 'v_name', 'v_role']) {
      expect(payloadBlock).not.toContain(`'${forbidden}'`);
    }
  });
  it('the outbox call is not wrapped in its own exception handler', () => {
    const performBlock = fnStock().slice(
      fnStock().indexOf('PERFORM public.phoenix_append_outbox_event_internal('),
      fnStock().indexOf('RETURN NEW;', fnStock().indexOf('PERFORM public.phoenix_append_outbox_event_internal(')),
    );
    expect(performBlock).not.toMatch(/EXCEPTION WHEN/);
  });
});

describe('exception RPC: every pre-existing statement from 157 is preserved', () => {
  it('preserves the exact 6-argument signature, SECURITY DEFINER, pinned search_path', () => {
    const header = fnExc().slice(0, fnExc().indexOf('AS $$'));
    expect(header).toContain('p_request_id                uuid,');
    expect(header).toContain('p_return_shipment_line_id     uuid,');
    expect(header).toContain('p_resolution_kind               text,');
    expect(header).toContain('p_reason                          text,');
    expect(header).toContain('p_corrected_quantity                integer DEFAULT NULL,');
    expect(header).toContain('p_disposition_decision                text    DEFAULT NULL');
    expect(header).toContain('RETURNS jsonb');
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toContain('SET search_path = public, pg_temp');
  });
  it('preserves the fingerprint computation, advisory lock salt 157157, and idempotent-replay/conflict paths', () => {
    const body = fnExc();
    expect(body).toContain("'operation', 'resolve_outlet_return_exception',");
    expect(body).toContain('pg_advisory_xact_lock(hashtextextended(p_request_id::text, 157157));');
    expect(body).toContain("RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',");
    expect(body).toContain('RETURN v_existing.result;');
  });
  it('preserves the permission check, active-profile lookup, and both branches\' validation', () => {
    const body = fnExc();
    expect(body).toContain("public.phoenix_profile_has_scoped_permission(");
    expect(body).toContain("'outlet_stock.resolve_return_exception'");
    expect(body).toContain("RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';");
  });
  it('preserves both branches\' resolution-row INSERT column lists unchanged (only RETURNING is additive)', () => {
    const body = fnExc();
    expect(body).toContain('request_id, return_shipment_line_id, organization_id, resolution_kind, reason,\n      payload_fingerprint, result, actor_id, actor_role');
    expect(body).toContain('corrected_quantity, disposition,\n    resulting_warehouse_stock_id, resulting_quarantine_stock_id,');
  });
  it('preserves the compensating warehouse_stock_movements/warehouse_quarantine_stock_movements INSERTs unchanged', () => {
    const body = fnExc();
    expect(body).toContain("'correction',");
    expect(body).toContain("'quarantine_correction',");
    expect(body).toContain("'outlet_return_exception_resolve', p_request_id, v_fp,");
  });
  it('preserves both audit_logs INSERTs unchanged', () => {
    const body = fnExc();
    const occurrences = [...body.matchAll(/INSERT INTO public\.audit_logs/g)];
    expect(occurrences.length).toBe(2);
  });
  it('adds RETURNING id, resolved_at INTO v_new_resolution_id, v_new_resolved_at to both resolution-row INSERTs, nowhere else', () => {
    const body = fnExc();
    const occurrences = [...body.matchAll(/RETURNING id, resolved_at INTO v_new_resolution_id, v_new_resolved_at;/g)];
    expect(occurrences.length).toBe(2);
  });
});

describe('exception RPC: the additive change — two branch-local outbox PERFORM calls', () => {
  it('the append helper is referenced exactly twice', () => {
    const occurrences = [...fnExc().matchAll(/phoenix_append_outbox_event_internal/g)];
    expect(occurrences.length).toBe(2);
  });
  it('the confirmed_no_stock PERFORM sits after that branch\'s own INSERT/RETURNING and before that branch\'s own RETURN', () => {
    const body = fnExc();
    const insertIdx = body.indexOf("INSERT INTO public.phoenix_outlet_return_exception_resolutions (\n      request_id, return_shipment_line_id, organization_id, resolution_kind, reason,\n      payload_fingerprint, result, actor_id, actor_role");
    const performIdx = body.indexOf('PERFORM public.phoenix_append_outbox_event_internal(');
    const returnIdx = body.indexOf('RETURN v_result;', performIdx);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(performIdx).toBeGreaterThan(insertIdx);
    expect(returnIdx).toBeGreaterThan(performIdx);
  });
  it('the corrected_receipt PERFORM sits after that branch\'s own INSERT/RETURNING and before the function\'s final RETURN', () => {
    const body = fnExc();
    const secondPerformIdx = body.indexOf('PERFORM public.phoenix_append_outbox_event_internal(', body.indexOf('PERFORM public.phoenix_append_outbox_event_internal(') + 1);
    const secondInsertIdx = body.lastIndexOf('INSERT INTO public.phoenix_outlet_return_exception_resolutions (', secondPerformIdx);
    const finalReturnIdx = body.lastIndexOf('RETURN v_result;');
    expect(secondPerformIdx).toBeGreaterThan(secondInsertIdx);
    expect(finalReturnIdx).toBeGreaterThan(secondPerformIdx);
  });
  it("both call sites use the exact event-key expression: 'outlet-return-exception-resolution:' || p_request_id::text", () => {
    const occurrences = [...fnExc().matchAll(/'outlet-return-exception-resolution:' \|\| p_request_id::text,/g)];
    expect(occurrences.length).toBe(2);
  });
  it('both call sites use the exact fixed event_type literal', () => {
    const occurrences = [...fnExc().matchAll(/'phoenix_outlet_return_exception_resolutions\.resolved',/g)];
    expect(occurrences.length).toBe(2);
  });
  it('both call sites pass event_version 1 and aggregate_type = the literal table name', () => {
    const occurrences = [...fnExc().matchAll(/1::smallint,\s*\n\s*'phoenix_outlet_return_exception_resolutions',/g)];
    expect(occurrences.length).toBe(2);
  });
  it('both call sites pass aggregate_id = v_new_resolution_id and organization_id = v_shipment.destination_organization_id', () => {
    const occurrences = [...fnExc().matchAll(/'phoenix_outlet_return_exception_resolutions',\s*\n\s*v_new_resolution_id,\s*\n\s*v_shipment\.destination_organization_id,/g)];
    expect(occurrences.length).toBe(2);
  });
  it('both call sites pass actor_id = v_actor and correlation_id = v_correlation_id (reused, never manufactured)', () => {
    const body = fnExc();
    const occurrences = [...body.matchAll(/\)\),\s*\n\s*v_actor,\s*\n\s*v_correlation_id,/g)];
    expect(occurrences.length).toBe(2);
  });
  it('both call sites pass NULL::uuid for causation_id and p_request_id as the trailing request_id argument', () => {
    const body = fnExc();
    const occurrences = [...body.matchAll(/v_correlation_id,\s*\n\s*NULL::uuid,\s*\n\s*p_request_id\s*\n\s*\);/g)];
    expect(occurrences.length).toBe(2);
  });
  it('neither PERFORM call is wrapped in its own exception handler', () => {
    const body = fnExc();
    for (const m of body.matchAll(/PERFORM public\.phoenix_append_outbox_event_internal\(/g)) {
      const nextReturn = body.indexOf('RETURN', m.index!);
      const slice = body.slice(m.index!, nextReturn);
      expect(slice).not.toMatch(/EXCEPTION WHEN/);
    }
  });
});

describe('exception RPC: each new payload carries exactly its seven approved fields, in order, excluding reason', () => {
  const payloadAt = (afterText: string) => {
    const body = fnExc();
    const performIdx = body.indexOf(afterText);
    const payloadStart = body.indexOf('jsonb_strip_nulls(jsonb_build_object(', performIdx);
    const payloadEnd = body.indexOf('v_actor,', payloadStart);
    return body.slice(payloadStart, payloadEnd);
  };

  it('confirmed_no_stock payload: exact 7 keys in exact order, no reason', () => {
    const payload = payloadAt('-- ── 162: the fourth outbox producer (confirmed_no_stock branch)');
    const keysInOrder = [...payload.matchAll(/'(\w+)',/g)].map(m => m[1]);
    expect(keysInOrder).toEqual([
      'resolution_kind', 'return_shipment_line_id', 'disposition',
      'corrected_quantity', 'trace_id', 'reference_id', 'occurred_at',
    ]);
    expect(payload).not.toMatch(/'reason'/);
    expect(payload).not.toContain('v_reason');
    expect(payload).not.toContain('p_reason');
  });

  it('corrected_receipt payload: exact 7 keys in exact order, no reason', () => {
    const payload = payloadAt('-- ── 162: the fourth outbox producer (corrected_receipt branch)');
    const keysInOrder = [...payload.matchAll(/'(\w+)',/g)].map(m => m[1]);
    expect(keysInOrder).toEqual([
      'resolution_kind', 'return_shipment_line_id', 'disposition',
      'corrected_quantity', 'trace_id', 'reference_id', 'occurred_at',
    ]);
    expect(payload).not.toMatch(/'reason'/);
    expect(payload).not.toContain('v_reason');
    expect(payload).not.toContain('p_reason');
  });

  it('neither payload includes organization name, actor name/role, or any full row dump', () => {
    for (const marker of ['-- ── 162: the fourth outbox producer (confirmed_no_stock branch)', '-- ── 162: the fourth outbox producer (corrected_receipt branch)']) {
      const payload = payloadAt(marker);
      for (const forbidden of ['v_actor_name', 'v_actor_role', 'organization_name', 'o.name', 'v_line.scientific_name', 'to_jsonb']) {
        expect(payload).not.toContain(forbidden);
      }
    }
  });
});

describe('VERIFY block proves the D2-4 boundary in-transaction', () => {
  it('asserts stocktake producer identity, security, and trigger shape', () => {
    expect(code).toMatch(/phoenix_capture_stocktake_recorded\(\) must still exist/);
    expect(code).toMatch(/phoenix_capture_stocktake_recorded must remain SECURITY DEFINER/);
    expect(code).toMatch(/phoenix_capture_stocktake_recorded must keep search_path pinned/);
    expect(code).toMatch(/expected exactly one reference to phoenix_append_outbox_event_internal in phoenix_capture_stocktake_recorded/);
    expect(code).toMatch(/expected exactly 1 phoenix_capture_stocktake_recorded attachment after 162/);
    expect(code).toMatch(/stocktakes must still carry a row-level AFTER INSERT phoenix_capture_stocktake_recorded trigger/);
  });
  it('asserts the exact stocktake event-key/type/payload text is present', () => {
    expect(code).toMatch(/the exact stocktake event-key expression must be present/);
    expect(code).toMatch(/the fixed stocktake event_type literal must be present/);
    expect(code).toMatch(/the exact six-field stocktake payload must be present/);
  });
  it('asserts neither redefined function directly INSERTs into the outbox table', () => {
    expect(code).toMatch(/phoenix_capture_stocktake_recorded must never INSERT into phoenix_outbox_events directly/);
    expect(code).toMatch(/phoenix_resolve_outlet_return_exception must never INSERT into phoenix_outbox_events directly/);
  });
  it('asserts the exception RPC identity, security, and exactly-two-call-site shape', () => {
    expect(code).toMatch(/phoenix_resolve_outlet_return_exception\(\.\.\.\) must still exist with its exact signature/);
    expect(code).toMatch(/phoenix_resolve_outlet_return_exception must remain SECURITY DEFINER/);
    expect(code).toMatch(/expected exactly two branch-local references to phoenix_append_outbox_event_internal/);
  });
  it('asserts both call sites\' exact namespace, event_type, correlation/causation/request_id shape', () => {
    expect(code).toMatch(/both call sites must use the exact outlet-return-exception-resolution: namespace with p_request_id/);
    expect(code).toMatch(/both call sites must use the exact fixed event_type literal/);
    expect(code).toMatch(/both call sites must pass v_correlation_id/);
    expect(code).toMatch(/both call sites must pass a NULL::uuid causation_id argument/);
    expect(code).toMatch(/both call sites must pass p_request_id as the final \(request_id\) argument/);
  });
  it('asserts the exception table carries zero triggers of any kind', () => {
    expect(code).toMatch(/phoenix_outlet_return_exception_resolutions must carry no trigger of any kind/);
  });
  it("asserts 159's lifecycle and 161's movement producers are completely unchanged", () => {
    expect(code).toMatch(/159''s lifecycle producer must still contain exactly one outbox-helper reference/);
    expect(code).toMatch(/159''s 11 lifecycle trigger attachments must remain unchanged/);
    expect(code).toMatch(/161''s movement producer must still contain exactly one outbox-helper reference/);
    expect(code).toMatch(/161''s 3 movement-posted trigger attachments must remain unchanged/);
  });
  it('asserts phoenix_capture_movement_notification remains unwired', () => {
    expect(code).toMatch(/phoenix_capture_movement_notification must remain unwired from the outbox/);
  });
  it('asserts no client role gained outbox access', () => {
    expect(code).toMatch(/authenticated must still lack SELECT on phoenix_outbox_events after 162/);
    expect(code).toMatch(/authenticated must still lack EXECUTE on the append helper after 162/);
    expect(code).toMatch(/anon must still lack SELECT on phoenix_outbox_events after 162/);
  });
  it('asserts applying 162 alone creates zero outbox rows', () => {
    expect(code).toMatch(/applying 162 must not itself produce any outbox row/);
  });
  it('asserts no D3 consumer/processing column exists on the outbox table', () => {
    expect(code).toMatch(/phoenix_outbox_events must carry no D3 consumer\/processing column/);
  });
});
