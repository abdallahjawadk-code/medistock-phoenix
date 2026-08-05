/**
 * OUTBOX-CONSUMER-STATE-FOUNDATION-163 — static SQL contract tests.
 *
 * The dynamic proof (a real disposable-Postgres replay, real claim/lease/
 * complete/fail/release calls, real concurrency, real organization
 * isolation) is in 163-outbox-consumer-foundation.dynamic.test.ts (gated on
 * a live Postgres). These pin the properties that must not regress in
 * review: exactly two new tables and four new functions, zero D2 producer
 * bodies touched, zero D3-forbidden objects (pg_net/pg_cron/LISTEN-NOTIFY/
 * worker) anywhere in this file, and the exact privilege/RLS posture every
 * D3-1 object must carry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '163_phoenix_outbox_consumer_foundation.sql';
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
  it('aborts if either new table or the claim function already exists (idempotent-apply guard)', () => {
    expect(code).toMatch(/phoenix_outbox_consumers already exists \(163 already applied\?\)/);
    expect(code).toMatch(/phoenix_outbox_delivery_state already exists \(163 already applied\?\)/);
    expect(code).toMatch(/phoenix_outbox_claim_batch already exists \(163 already applied\?\)/);
  });
  it('preconditions snapshot the D2 baseline before touching anything', () => {
    expect(code).toMatch(/159''s 11 lifecycle trigger attachments intact before 163/);
    expect(code).toMatch(/161''s 3 movement trigger attachments intact before 163/);
    expect(code).toMatch(/162''s 1 stocktake trigger attachment intact before 163/);
  });
});

describe('scope boundary: exactly two new tables, four new functions, nothing else', () => {
  it('contains exactly two CREATE TABLE statements', () => {
    const matches = [...code.matchAll(/CREATE TABLE/g)];
    expect(matches.length).toBe(2);
  });
  it('creates exactly phoenix_outbox_consumers and phoenix_outbox_delivery_state', () => {
    expect(code).toMatch(/CREATE TABLE public\.phoenix_outbox_consumers/);
    expect(code).toMatch(/CREATE TABLE public\.phoenix_outbox_delivery_state/);
  });
  it('contains exactly four CREATE FUNCTION statements', () => {
    const matches = [...code.matchAll(/CREATE FUNCTION/g)];
    expect(matches.length).toBe(4);
  });
  it('creates exactly the four approved D3-1 functions', () => {
    expect(code).toMatch(/CREATE FUNCTION public\.phoenix_outbox_claim_batch\(/);
    expect(code).toMatch(/CREATE FUNCTION public\.phoenix_outbox_mark_completed\(/);
    expect(code).toMatch(/CREATE FUNCTION public\.phoenix_outbox_mark_failed\(/);
    expect(code).toMatch(/CREATE FUNCTION public\.phoenix_outbox_release_lease\(/);
  });
  it('does not touch phoenix_outbox_events\' own definition (no ALTER TABLE on it, no trigger on it)', () => {
    expect(code).not.toMatch(/ALTER TABLE (public\.)?phoenix_outbox_events/i);
    expect(code).not.toMatch(/CREATE TRIGGER[\s\S]{0,200}phoenix_outbox_events/i);
  });
  it('does not touch any D2 producer function definition', () => {
    for (const fn of ['phoenix_capture_lifecycle_event', 'phoenix_capture_movement_posted',
                       'phoenix_capture_stocktake_recorded', 'phoenix_resolve_outlet_return_exception',
                       'phoenix_append_outbox_event_internal']) {
      expect(code).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}`));
    }
  });
  it('creates no trigger of any kind anywhere', () => {
    expect(code).not.toMatch(/CREATE TRIGGER/i);
  });
});

describe('forbidden D3 scope — never present inside any of the four new function BODIES', () => {
  // Scoped deliberately to the four function bodies only, extracted by their
  // unique dollar-quote tags — NOT the whole migration file. This file's own
  // header prose and in-transaction ASSERT error-message strings legitimately
  // discuss "pg_net", "pg_cron", and "LISTEN/NOTIFY" AS THE SUBJECT of the
  // very constraint being proven (documentation and the constraint's own
  // error text, not a violation of it) — a whole-file scan would false-
  // positive on the migration's own self-description.
  const functionBodies = {
    claim_batch: code.slice(code.indexOf('AS $claim$'), code.indexOf('$claim$;') + '$claim$;'.length),
    mark_completed: code.slice(code.indexOf('AS $completed$'), code.indexOf('$completed$;') + '$completed$;'.length),
    mark_failed: code.slice(code.indexOf('AS $failed$'), code.indexOf('$failed$;') + '$failed$;'.length),
    release_lease: code.slice(code.indexOf('AS $release$'), code.indexOf('$release$;') + '$release$;'.length),
  };

  it('every function body was actually extracted (sanity check on the tag-based slicing above)', () => {
    for (const [name, body] of Object.entries(functionBodies)) {
      expect(body.length, `${name} body extraction must not be empty`).toBeGreaterThan(50);
    }
  });

  it('never references pg_net or performs HTTP delivery', () => {
    for (const body of Object.values(functionBodies)) {
      expect(body.toLowerCase()).not.toMatch(/pg_net|http_post|http_get|net\.http/);
    }
  });
  it('never references pg_cron or schedules anything', () => {
    for (const body of Object.values(functionBodies)) {
      expect(body.toLowerCase()).not.toMatch(/pg_cron|cron\.schedule/);
    }
  });
  it('never uses LISTEN/NOTIFY', () => {
    for (const body of Object.values(functionBodies)) {
      expect(body.toLowerCase()).not.toMatch(/\blisten\b|\bnotify\b|pg_notify/);
    }
  });
  it('never creates an Edge Function, extension, or foreign server object', () => {
    expect(code.toLowerCase()).not.toMatch(/create extension|create server|create foreign/);
  });
  it('never adds a D3 processing/claim/lease/retry/dead-letter column to phoenix_outbox_events itself', () => {
    // The new tables legitimately use these words for THEIR OWN columns —
    // this assertion is scoped to the phoenix_outbox_events ALTER-absence
    // check above, re-stated here as an explicit no-column-added guard by
    // construction: no ALTER TABLE on that table exists anywhere (proven
    // above), so it is structurally impossible for this file to add a
    // column to it.
    expect(code).not.toMatch(/ALTER TABLE (public\.)?phoenix_outbox_events/i);
  });
});

describe('phoenix_outbox_consumers: registry table contract', () => {
  it('has no secret/credential/endpoint-shaped column', () => {
    // Sliced to end at the CREATE TABLE statement's own closing `);` —
    // deliberately excluding the COMMENT ON TABLE that follows, whose prose
    // legitimately says "no secrets or endpoint credentials belong on this
    // table" (describing the very constraint being proven, not violating it).
    const tableStart = code.indexOf('CREATE TABLE public.phoenix_outbox_consumers');
    const tableEnd = code.indexOf(');', tableStart);
    const tableBlock = code.slice(tableStart, tableEnd);
    expect(tableBlock.toLowerCase()).not.toMatch(/secret|password|token|credential|endpoint|url|webhook|api_key|apikey/);
  });
  it('is RLS-enabled with zero policies and explicit REVOKE from client roles', () => {
    expect(code).toMatch(/ALTER TABLE public\.phoenix_outbox_consumers ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.phoenix_outbox_consumers FROM PUBLIC, authenticated, anon/);
    expect(code).not.toMatch(/CREATE POLICY[\s\S]{0,200}phoenix_outbox_consumers/);
  });
  it('carries an immutable stable consumer_key with a non-empty CHECK', () => {
    expect(code).toMatch(/consumer_key\s+text NOT NULL UNIQUE/);
    expect(code).toMatch(/btrim\(consumer_key\) = consumer_key AND consumer_key <> ''/);
  });
});

describe('phoenix_outbox_delivery_state: state-machine table contract', () => {
  it('is RLS-enabled with zero policies and explicit REVOKE from client roles', () => {
    expect(code).toMatch(/ALTER TABLE public\.phoenix_outbox_delivery_state ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.phoenix_outbox_delivery_state FROM PUBLIC, authenticated, anon/);
    expect(code).not.toMatch(/CREATE POLICY[\s\S]{0,200}phoenix_outbox_delivery_state/);
  });
  it('enforces UNIQUE(consumer_id, outbox_event_id)', () => {
    expect(code).toMatch(/CONSTRAINT pods_consumer_event_unique UNIQUE \(consumer_id, outbox_event_id\)/);
  });
  it('restricts status to exactly the four approved values', () => {
    expect(code).toMatch(/status IN \('pending', 'leased', 'completed', 'dead_letter'\)/);
  });
  it('references phoenix_outbox_events and organizations, never CASCADEs a delete', () => {
    expect(code).toMatch(/outbox_event_id\s+uuid NOT NULL REFERENCES public\.phoenix_outbox_events\(id\) ON DELETE RESTRICT/);
    expect(code).toMatch(/organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE RESTRICT/);
  });
  it('enforces lease/completed/dead_letter consistency at the data level via CHECK constraints', () => {
    expect(code).toMatch(/CONSTRAINT pods_lease_consistency_chk/);
    expect(code).toMatch(/CONSTRAINT pods_completed_consistency_chk/);
    expect(code).toMatch(/CONSTRAINT pods_dead_letter_consistency_chk/);
  });
  it('bounds diagnostic text length', () => {
    expect(code).toMatch(/CONSTRAINT pods_error_code_len_chk[\s\S]{0,80}length\(last_error_code\) <= 100/);
    expect(code).toMatch(/CONSTRAINT pods_error_summary_len_chk[\s\S]{0,100}length\(last_error_summary\) <= 500/);
  });
  it('organization_id is never a table default derived from anything but the join to phoenix_outbox_events at insert time (no DEFAULT clause on it)', () => {
    const tableBlock = code.slice(code.indexOf('CREATE TABLE public.phoenix_outbox_delivery_state'), code.indexOf('COMMENT ON TABLE public.phoenix_outbox_delivery_state'));
    expect(tableBlock).not.toMatch(/organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE RESTRICT DEFAULT/);
  });
});

describe('every new function: security posture and no caller-supplied organization override', () => {
  const fns = ['phoenix_outbox_claim_batch', 'phoenix_outbox_mark_completed', 'phoenix_outbox_mark_failed', 'phoenix_outbox_release_lease'];

  it('all four are SECURITY DEFINER with pinned search_path', () => {
    for (const fn of fns) {
      const idx = code.indexOf(`CREATE FUNCTION public.${fn}`);
      expect(idx, `${fn} must exist`).toBeGreaterThan(-1);
      const nextIdx = code.indexOf('CREATE FUNCTION public.', idx + 1);
      const block = nextIdx === -1 ? code.slice(idx) : code.slice(idx, nextIdx);
      expect(block).toContain('SECURITY DEFINER');
      expect(block).toContain('SET search_path = public, pg_temp');
    }
  });

  it('all four carry an explicit REVOKE ALL from PUBLIC, authenticated, anon', () => {
    for (const fn of fns) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, authenticated, anon`));
    }
  });

  it('none of the four accept any organization-shaped parameter (server-derived only)', () => {
    for (const fn of fns) {
      const idx = code.indexOf(`CREATE FUNCTION public.${fn}`);
      const bodyStart = code.indexOf('RETURNS', idx);
      const paramBlock = code.slice(idx, bodyStart).toLowerCase();
      expect(paramBlock).not.toMatch(/\borg\b|organization/);
    }
  });

  it('mark_failed and release_lease never accept attempt_count or status as a parameter (server-controlled only)', () => {
    const idxFailed = code.indexOf('CREATE FUNCTION public.phoenix_outbox_mark_failed');
    const bodyStartFailed = code.indexOf('RETURNS', idxFailed);
    const paramsFailed = code.slice(idxFailed, bodyStartFailed).toLowerCase();
    expect(paramsFailed).not.toMatch(/attempt_count|p_status|p_available_at/);

    const idxRelease = code.indexOf('CREATE FUNCTION public.phoenix_outbox_release_lease');
    const bodyStartRelease = code.indexOf('RETURNS', idxRelease);
    const paramsRelease = code.slice(idxRelease, bodyStartRelease).toLowerCase();
    expect(paramsRelease).not.toMatch(/attempt_count|p_status/);
  });
});

describe('claim_batch: discovery and claim mechanics', () => {
  const claimFnBlock = () => code.slice(
    code.indexOf('CREATE FUNCTION public.phoenix_outbox_claim_batch'),
    code.indexOf('CREATE FUNCTION public.phoenix_outbox_mark_completed'),
  );

  it('uses FOR UPDATE SKIP LOCKED for the actual claim step', () => {
    expect(claimFnBlock()).toMatch(/FOR UPDATE SKIP LOCKED/);
  });
  it('uses ON CONFLICT DO NOTHING for idempotent delivery-state creation, never raising on a duplicate', () => {
    expect(claimFnBlock()).toMatch(/ON CONFLICT \(consumer_id, outbox_event_id\) DO NOTHING/);
  });
  it('bounds batch_size and rejects an unknown or disabled consumer', () => {
    const block = claimFnBlock();
    expect(block).toMatch(/batch_size_out_of_bounds/);
    expect(block).toMatch(/consumer_not_found/);
    expect(block).toMatch(/consumer_disabled/);
  });
  it('discovery is cursored by stream_position, strictly greater-than only (no gap-free assumption)', () => {
    expect(claimFnBlock()).toMatch(/e\.stream_position > v_consumer\.last_discovered_stream_position/);
  });
  it('never lets the cursor move backward under concurrent execution (GREATEST-guarded update)', () => {
    expect(claimFnBlock()).toMatch(/GREATEST\(last_discovered_stream_position, v_new_cursor\)/);
  });
  it('reclaims expired leases without incrementing attempt_count', () => {
    const block = claimFnBlock();
    // Located by the statement's own real SQL text (comments are stripped
    // from `code`, so a comment-text locator would never be found here).
    const reclaimIdx = block.indexOf("SET status = 'pending', lease_expires_at = NULL, updated_at = now()");
    expect(reclaimIdx).toBeGreaterThan(-1);
    const reclaimStatement = block.slice(reclaimIdx, block.indexOf(';', reclaimIdx) + 1);
    expect(reclaimStatement).toContain("status = 'leased'");
    expect(reclaimStatement).not.toMatch(/attempt_count/);
  });
  it('never inserts into, updates, or deletes phoenix_outbox_events', () => {
    const block = claimFnBlock().toLowerCase();
    expect(block).not.toMatch(/insert\s+into\s+(public\.)?phoenix_outbox_events/);
    expect(block).not.toMatch(/update\s+(public\.)?phoenix_outbox_events/);
    expect(block).not.toMatch(/delete\s+from\s+(public\.)?phoenix_outbox_events/);
  });
});

describe('mark_completed: idempotency and stale-token rejection', () => {
  const block = () => code.slice(
    code.indexOf('CREATE FUNCTION public.phoenix_outbox_mark_completed'),
    code.indexOf('CREATE FUNCTION public.phoenix_outbox_mark_failed'),
  );
  it('checks for an already-completed row with the SAME token before doing anything else', () => {
    expect(block()).toMatch(/already_completed', true/);
    expect(block()).toMatch(/lease_owner_token IS NOT DISTINCT FROM p_lease_token/);
  });
  it('rejects a foreign token and a stale (expired) active lease', () => {
    expect(block()).toMatch(/stale_or_foreign_lease_token/);
    expect(block()).toMatch(/lease_expires_at < now\(\)/);
  });
  it('clears lease_expires_at but never nulls lease_owner_token', () => {
    const updateBlock = block().slice(block().indexOf('UPDATE public.phoenix_outbox_delivery_state\n     SET status = \'completed\''));
    expect(updateBlock).toMatch(/lease_expires_at = NULL/);
    expect(updateBlock).not.toMatch(/lease_owner_token = NULL/);
  });
});

describe('mark_failed: retry/dead-letter boundary and bounded diagnostics', () => {
  const block = () => code.slice(
    code.indexOf('CREATE FUNCTION public.phoenix_outbox_mark_failed'),
    code.indexOf('CREATE FUNCTION public.phoenix_outbox_release_lease'),
  );
  it('increments attempt_count exactly once per call', () => {
    expect(block()).toMatch(/v_new_attempts := v_ds\.attempt_count \+ 1;/);
    const occurrences = [...block().matchAll(/attempt_count = v_new_attempts/g)];
    expect(occurrences.length).toBe(1);
  });
  it('requires an active lease held by the exact same token', () => {
    expect(block()).toMatch(/delivery_state_not_currently_leased/);
    expect(block()).toMatch(/stale_or_foreign_lease_token/);
  });
  it('transitions to dead_letter exactly at max_attempts, computed server-side', () => {
    expect(block()).toMatch(/v_new_attempts >= v_consumer\.max_attempts/);
    expect(block()).toMatch(/v_new_status := 'dead_letter'/);
  });
  it('uses a deterministic, bounded exponential backoff for the retry path', () => {
    expect(block()).toMatch(/LEAST\(30 \* \(2 \^ \(v_new_attempts - 1\)\)::integer, 3600\)/);
  });
  it('truncates error_code/error_summary defensively rather than raising on oversized input', () => {
    expect(block()).toMatch(/left\(p_error_code, 100\)/);
    expect(block()).toMatch(/left\(p_error_summary, 500\)/);
  });
});

describe('release_lease: cooperative release never burns an attempt', () => {
  const block = () => code.slice(code.indexOf('CREATE FUNCTION public.phoenix_outbox_release_lease'));
  it('never references attempt_count anywhere in its body', () => {
    const bodyOnly = block().slice(block().indexOf('AS $release$'), block().indexOf('$release$;', block().indexOf('AS $release$') + 1));
    expect(bodyOnly).not.toMatch(/attempt_count/);
  });
  it('requires the exact active lease token, same as completed/failed', () => {
    expect(block()).toMatch(/stale_or_foreign_lease_token/);
  });
});

describe('VERIFY block proves the D3-1 boundary in-transaction', () => {
  it('asserts phoenix_outbox_events keeps exactly its 158-defined columns and zero triggers', () => {
    expect(code).toMatch(/phoenix_outbox_events must keep exactly its 158-defined 15 columns, no D3 column added/);
    expect(code).toMatch(/phoenix_outbox_events must carry no trigger of any kind after 163/);
  });
  it('asserts every D2 producer is unchanged', () => {
    expect(code).toMatch(/159''s 11 lifecycle trigger attachments must remain unchanged/);
    expect(code).toMatch(/161''s 3 movement trigger attachments must remain unchanged/);
    expect(code).toMatch(/162''s 1 stocktake trigger attachment must remain unchanged/);
    expect(code).toMatch(/162''s exception-resolution RPC must still contain exactly two outbox-helper references/);
  });
  it('asserts zero rows exist in either new table immediately after this migration commits', () => {
    expect(code).toMatch(/applying 163 must not itself produce any delivery-state row/);
    expect(code).toMatch(/applying 163 must not itself produce any consumer row/);
  });
  it('asserts no D3-forbidden object exists inside any new function body', () => {
    expect(code).toMatch(/no D3-1 function may reference pg_net or perform HTTP delivery/);
    expect(code).toMatch(/no D3-1 function may reference pg_cron/);
    expect(code).toMatch(/no D3-1 function may use LISTEN\/NOTIFY/);
  });
  it('asserts service_role retains default access while authenticated/anon do not', () => {
    expect(code).toMatch(/service_role must retain its normal default EXECUTE on/);
    expect(code).toMatch(/authenticated must not be able to execute/);
    expect(code).toMatch(/anon must not be able to execute/);
  });
});
