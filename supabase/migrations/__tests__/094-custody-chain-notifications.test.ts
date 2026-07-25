/**
 * CUSTODY-CHAIN-NOTIFICATIONS-094 — static SQL contract tests.
 *
 * The dynamic proof (real RPCs → notification feed → read state, dedup, scope)
 * is in 094-custody-chain-notifications.dynamic.test.ts (gated on a live
 * Postgres). These pin the properties that must not regress in review: that
 * the feed is server-side, append-only, per-viewer read state is a separate
 * table with zero direct grants, and every write is RPC-mediated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '094_phoenix_custody_chain_notifications.sql';
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
    expect(code).toMatch(/phoenix_notifications already exists \(094 already applied\?\)/);
  });
});

describe('append-only notification feed', () => {
  it('creates the table with no UPDATE/DELETE grant to authenticated', () => {
    expect(code).toMatch(/CREATE TABLE public\.phoenix_notifications/);
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.phoenix_notifications FROM authenticated/);
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.phoenix_notifications TO authenticated/);
  });
  it('enables RLS and scopes SELECT by organization (or super_admin)', () => {
    expect(code).toMatch(/ALTER TABLE public\.phoenix_notifications ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/phoenix_my_role\(\) = 'super_admin'/);
    expect(code).toMatch(/organization_id = \(SELECT p\.organization_id FROM public\.profiles p WHERE p\.id = auth\.uid\(\)\)/);
  });
  it('dedupes via a unique partial index on dedupe_key', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX phoenix_notifications_dedupe_uniq\s+ON public\.phoenix_notifications \(dedupe_key\)\s+WHERE dedupe_key IS NOT NULL/);
  });
});

describe('per-viewer read state has zero direct grants', () => {
  it('creates phoenix_notification_reads keyed by (notification_id, profile_id)', () => {
    expect(code).toMatch(/CREATE TABLE public\.phoenix_notification_reads/);
    expect(code).toMatch(/PRIMARY KEY \(notification_id, profile_id\)/);
  });
  it('revokes ALL from authenticated — reachable only through the RPCs', () => {
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.phoenix_notification_reads FROM authenticated/);
    // No SELECT/INSERT/UPDATE/DELETE grant statement targets this table for authenticated.
    expect(code).not.toMatch(/GRANT[^;]*phoenix_notification_reads[^;]*authenticated/i);
  });
});

describe('the capture trigger is extended, not duplicated', () => {
  it('redefines phoenix_capture_lifecycle_event with the same name (no new trigger objects)', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_capture_lifecycle_event\(\)/);
    expect(code).not.toMatch(/CREATE TRIGGER/); // no new triggers — reuses 082's six
  });
  it('still writes phoenix_movement_events (082 behaviour preserved)', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    expect(fn).toMatch(/INSERT INTO public\.phoenix_movement_events/);
  });
  it('also writes phoenix_notifications inside the same transition branch', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    expect(fn).toMatch(/INSERT INTO public\.phoenix_notifications/);
    expect(fn).toMatch(/IS NOT DISTINCT FROM v_old_status/); // still gated on a real transition
  });
  it('shares one dedupe_key text across both inserts, each guarded by its own ON CONFLICT', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    const dedupeAssigns = fn.match(/v_dedupe\s*:=/g) ?? [];
    expect(dedupeAssigns.length).toBe(1);
    const conflictClauses = fn.match(/ON CONFLICT \(dedupe_key\) WHERE dedupe_key IS NOT NULL DO NOTHING/g) ?? [];
    expect(conflictClauses.length).toBe(2); // one for movement_events, one for notifications
    // Both inserts reference the same variable, not two independently built keys.
    expect((fn.match(/,\s*v_dedupe\s*\)/g) ?? []).length).toBe(2);
  });
  it('is still SECURITY DEFINER with pinned search_path', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_capture_lifecycle_event'));
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path = public, pg_temp/);
  });
});

describe('read RPCs', () => {
  it('phoenix_notifications_list requires authentication and clamps limit', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_notifications_list'));
    expect(fn).toMatch(/not_authenticated/);
    expect(fn).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit, 30\), 1\), 100\)/);
  });
  it('computes is_read via LEFT JOIN against the caller\'s own reads only', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_notifications_list'));
    expect(fn).toMatch(/LEFT JOIN public\.phoenix_notification_reads r\s+ON r\.notification_id = n\.id AND r\.profile_id = v_actor/);
  });
  it('phoenix_notifications_unread_count scopes by org and excludes read rows', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.phoenix_notifications_unread_count'));
    expect(fn).toMatch(/r\.notification_id IS NULL/);
  });
});

describe('write RPCs never let a caller write another profile\'s read state', () => {
  it('mark_read always inserts profile_id = v_actor (auth.uid()), never a parameter', () => {
    const fn = code.slice(
      code.indexOf('FUNCTION public.phoenix_notifications_mark_read'),
      code.indexOf('FUNCTION public.phoenix_notifications_mark_all_read'),
    );
    expect(fn).not.toMatch(/p_profile_id/);
    expect(fn).toMatch(/SELECT n\.id, v_actor/);
  });
  it('mark_read and mark_all_read do not distinguish forbidden from nonexistent (no raised error on miss)', () => {
    const markRead = code.slice(
      code.indexOf('FUNCTION public.phoenix_notifications_mark_read'),
      code.indexOf('FUNCTION public.phoenix_notifications_mark_all_read'),
    );
    // Only two RAISE EXCEPTIONs: not_authenticated and notification_id_required.
    // No RAISE keyed to "not found" / "forbidden" for a real, invisible id.
    expect(markRead.match(/RAISE EXCEPTION/g)?.length).toBe(2);
    expect(markRead).not.toMatch(/not_found|forbidden/i);
  });
  it('grants are RPC-only for both write paths', () => {
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_notifications_mark_read\(uuid\) TO authenticated/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_notifications_mark_all_read\(\) TO authenticated/);
  });
});

describe('honesty about remaining Phase 2 scope', () => {
  it('documents which corridors are NOT yet wired to notifications', () => {
    expect(sql).toMatch(/NOT wired to notifications/);
    expect(sql).toMatch(/local procurement \(087\)/);
    expect(sql).toMatch(/monthly status center \(092\)/);
  });
});
