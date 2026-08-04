/**
 * DEMO-PURGE-OUTBOX-COMPATIBILITY-160 — static SQL contract tests.
 *
 * A narrow prerequisite compatibility correction with three parts, all
 * discovered necessary by proving the fix dynamically (not assumed from
 * static inspection alone):
 *   1. phoenix_outbox_events (158), first populated by 159's lifecycle
 *      producer, is missing from phoenix_demo_purgeable_tables() (143) —
 *      the hand-maintained, dependency-safe deletion order
 *      phoenix_demo_purge() reads dynamically.
 *   2. phoenix_demo_purger (141) — the dedicated role phoenix_demo_purge()
 *      has executed as since 141 — was never granted any privilege on
 *      phoenix_outbox_events, since 141's own per-table GRANT loop ran
 *      before 158 created the table (a one-time snapshot, not a live
 *      mechanism).
 *   3. phoenix_outbox_events has RLS enabled with zero policies (158's own
 *      deliberate design); a GRANT alone is not sufficient for a non-owner
 *      role to see or delete any row, so 141's own per-table RLS-policy-pair
 *      loop (same one-time-snapshot shape as its GRANT loop) must also be
 *      extended for this one table.
 * These tests pin that part 1 is a single array insertion (every other
 * entry and their relative order preserved byte-for-byte), positioned
 * correctly relative to organizations and its sibling ledger
 * phoenix_movement_events; that parts 2 and 3 grant phoenix_demo_purger
 * exactly SELECT, DELETE via exactly the same GRANT/CREATE POLICY shape 141
 * already uses per table, targeting no other role; and that nothing else —
 * phoenix_demo_purge() itself, any trigger, any business RPC, any other
 * table's RLS — is touched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '160_phoenix_demo_purge_outbox_compatibility.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const code = sql
  .slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'))
  .replace(/^[ \t]*--.*$/gm, '');

const NAME_143 = '143_phoenix_demo_purge_restrict_violation_and_ordering.sql';
const sql143 = readFileSync(join(ROOT, 'supabase/migrations', NAME_143), 'utf8').replace(/\r\n?/g, '\n');

const extractArray = (text: string): string[] => {
  const start = text.indexOf('SELECT ARRAY[');
  const end = text.indexOf('];', start);
  const block = text.slice(start, end);
  return [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
};

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
  it('aborts if phoenix_outbox_events is missing', () => {
    expect(code).toMatch(/phoenix_outbox_events is missing — apply 158 first/);
  });
  it('aborts if it has already been applied (idempotent-apply guard)', () => {
    expect(code).toMatch(/phoenix_outbox_events already present in phoenix_demo_purgeable_tables\(\) \(160 already applied\?\)/);
  });
  it('aborts if phoenix_demo_purger is missing or its NOLOGIN/NOINHERIT contract no longer holds', () => {
    expect(code).toMatch(/phoenix_demo_purger is missing or no longer NOLOGIN\/NOINHERIT — apply 141 first/);
  });
  it('aborts if phoenix_demo_purge is no longer owned by phoenix_demo_purger', () => {
    expect(code).toMatch(/phoenix_demo_purge\(text, boolean\) must still be owned by phoenix_demo_purger/);
  });
  it('aborts if phoenix_demo_purger already holds a privilege on phoenix_outbox_events (grant idempotent-apply guard)', () => {
    expect(code).toMatch(/phoenix_demo_purger already holds a privilege on phoenix_outbox_events \(160 already applied\?\)/);
  });
  it('aborts if phoenix_outbox_events does not have RLS enabled, or already carries a policy (policy idempotent-apply guard)', () => {
    expect(code).toMatch(/phoenix_outbox_events must have RLS enabled/);
    expect(code).toMatch(/phoenix_outbox_events must have zero RLS policies before 160/);
  });
});

describe('scope boundary: exactly one function redefined, nothing else', () => {
  it('contains exactly one CREATE OR REPLACE FUNCTION statement', () => {
    const matches = [...code.matchAll(/CREATE OR REPLACE FUNCTION/g)];
    expect(matches.length).toBe(1);
  });
  it('the one redefined function is phoenix_demo_purgeable_tables', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_demo_purgeable_tables\(\)/);
  });
  it('does not touch phoenix_demo_purge itself', () => {
    expect(code).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_demo_purge\(/);
  });
  it('does not touch phoenix_capture_lifecycle_event or any other capture/business function', () => {
    for (const fn of [
      'phoenix_capture_lifecycle_event', 'phoenix_capture_movement_posted',
      'phoenix_capture_movement_notification', 'phoenix_capture_stocktake_recorded',
      'phoenix_append_outbox_event_internal',
    ]) {
      expect(code).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}`));
    }
  });
  it('creates no trigger, no new table, no ALTER TABLE', () => {
    expect(code).not.toMatch(/CREATE TRIGGER/i);
    expect(code).not.toMatch(/CREATE TABLE/i);
    expect(code).not.toMatch(/ALTER TABLE/i);
  });
  it('contains no INSERT, UPDATE, or DELETE statement anywhere (writes no application data)', () => {
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+public\./i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

describe('scope boundary: the RLS policies touched are exactly the two this migration adds, on exactly one table', () => {
  it('creates exactly two policies, both on phoenix_outbox_events', () => {
    const creates = [...code.matchAll(/CREATE POLICY (\S+)\s*\n\s*ON public\.(\S+)/g)].map(m => ({ name: m[1], table: m[2] }));
    expect(creates).toEqual([
      { name: 'phoenix_outbox_events_demo_purger_select', table: 'phoenix_outbox_events' },
      { name: 'phoenix_outbox_events_demo_purger_delete', table: 'phoenix_outbox_events' },
    ]);
  });
  it('drops the same two policies (idempotent-apply style) before creating them, and no others', () => {
    const drops = [...code.matchAll(/DROP POLICY IF EXISTS (\S+) ON public\.([^;\s]+);/g)].map(m => ({ name: m[1], table: m[2] }));
    expect(drops).toEqual([
      { name: 'phoenix_outbox_events_demo_purger_select', table: 'phoenix_outbox_events' },
      { name: 'phoenix_outbox_events_demo_purger_delete', table: 'phoenix_outbox_events' },
    ]);
  });
  it('both policies target only phoenix_demo_purger', () => {
    expect(code).toMatch(/FOR SELECT TO phoenix_demo_purger/);
    expect(code).toMatch(/FOR DELETE TO phoenix_demo_purger/);
    // Scoped to exactly the two DROP/CREATE POLICY statements -- the
    // pre-existing GRANT EXECUTE ... TO authenticated (143's own line,
    // preserved byte-for-byte) legitimately mentions 'authenticated'
    // elsewhere in this file, and must not leak into this check.
    const policyBlockStart = code.indexOf('DROP POLICY IF EXISTS phoenix_outbox_events_demo_purger_select');
    const secondCreateEnd = code.indexOf(
      ';',
      code.indexOf('CREATE POLICY phoenix_outbox_events_demo_purger_delete', policyBlockStart),
    );
    const policyBlock = code.slice(policyBlockStart, secondCreateEnd + 1);
    expect(policyBlock).not.toMatch(/TO authenticated/);
    expect(policyBlock).not.toMatch(/TO anon/);
    expect(policyBlock).not.toMatch(/TO PUBLIC/);
  });
  it('both policies are scoped by phoenix_demo_manifest membership under the fixed dataset key, matching 141s per-table predicate shape', () => {
    const selectPolicy = code.slice(
      code.indexOf('CREATE POLICY phoenix_outbox_events_demo_purger_select'),
      code.indexOf(';', code.indexOf('CREATE POLICY phoenix_outbox_events_demo_purger_select')),
    );
    const deletePolicy = code.slice(
      code.indexOf('CREATE POLICY phoenix_outbox_events_demo_purger_delete'),
      code.indexOf(';', code.indexOf('CREATE POLICY phoenix_outbox_events_demo_purger_delete')),
    );
    for (const p of [selectPolicy, deletePolicy]) {
      expect(p).toMatch(/phoenix_demo_manifest/);
      expect(p).toMatch(/m\.dataset_key = 'PHOENIX_DEMO_V1'/);
      expect(p).toMatch(/m\.table_name = 'phoenix_outbox_events'/);
      expect(p).toMatch(/m\.row_id = phoenix_outbox_events\.id/);
    }
  });
});

describe('scope boundary: the GRANT touched is exactly SELECT, DELETE on phoenix_outbox_events to phoenix_demo_purger, nothing more', () => {
  it('grants exactly SELECT, DELETE on phoenix_outbox_events to phoenix_demo_purger', () => {
    expect(code).toMatch(/GRANT SELECT, DELETE ON public\.phoenix_outbox_events TO phoenix_demo_purger;/);
  });
  it('contains exactly one GRANT statement naming phoenix_demo_purger as grantee (no other table, no wider privilege)', () => {
    const grants = [...code.matchAll(/GRANT [^;]+TO phoenix_demo_purger;/g)];
    expect(grants.length).toBe(1);
    expect(grants[0][0]).not.toMatch(/INSERT|UPDATE|TRUNCATE|REFERENCES|TRIGGER/);
  });
  it('never grants anything to authenticated, anon, or PUBLIC beyond the pre-existing EXECUTE on phoenix_demo_purgeable_tables', () => {
    const grants = [...code.matchAll(/GRANT [^;]+;/g)].map(m => m[0]);
    for (const g of grants) {
      if (/TO authenticated;/.test(g)) {
        expect(g).toMatch(/EXECUTE ON FUNCTION public\.phoenix_demo_purgeable_tables\(\)/);
      }
      expect(g).not.toMatch(/TO anon;/);
      expect(g).not.toMatch(/TO PUBLIC;/);
    }
  });
});

describe('the purgeable-table array: exactly one insertion, everything else byte-for-byte preserved', () => {
  const before = extractArray(sql143);
  const after = extractArray(sql);

  it('the pre-160 baseline (143) has exactly 40 entries, none of them phoenix_outbox_events', () => {
    expect(before.length).toBe(40);
    expect(before).not.toContain('phoenix_outbox_events');
  });

  it('the post-160 array has exactly 41 entries: the original 40 plus phoenix_outbox_events', () => {
    expect(after.length).toBe(41);
    const afterWithoutOutbox = after.filter(t => t !== 'phoenix_outbox_events');
    expect(afterWithoutOutbox).toEqual(before);
  });

  it('phoenix_outbox_events is positioned immediately after phoenix_movement_events', () => {
    const movementIdx = after.indexOf('phoenix_movement_events');
    const outboxIdx = after.indexOf('phoenix_outbox_events');
    expect(outboxIdx).toBe(movementIdx + 1);
  });

  it('phoenix_outbox_events is positioned strictly before organizations', () => {
    const outboxIdx = after.indexOf('phoenix_outbox_events');
    const orgIdx = after.indexOf('organizations');
    expect(outboxIdx).toBeLessThan(orgIdx);
  });

  it('organizations remains the last entry, exactly as in 143', () => {
    expect(after[after.length - 1]).toBe('organizations');
    expect(before[before.length - 1]).toBe('organizations');
  });

  it('every entry appears exactly once (no duplicates introduced)', () => {
    expect(new Set(after).size).toBe(after.length);
  });
});

describe('function contract preserved exactly', () => {
  it('preserves RETURNS text[], LANGUAGE sql, IMMUTABLE, pinned search_path', () => {
    const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_demo_purgeable_tables'));
    const header = fn.slice(0, fn.indexOf('AS $tables$'));
    expect(header).toContain('RETURNS text[]');
    expect(header).toContain('LANGUAGE sql');
    expect(header).toContain('IMMUTABLE');
    expect(header).toContain('SET search_path = public, pg_temp');
  });
  it('preserves the exact REVOKE/GRANT lines from 143', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_demo_purgeable_tables\(\) FROM PUBLIC, anon;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_demo_purgeable_tables\(\) TO authenticated;/);
  });
});

describe('VERIFY block proves the correction in-transaction', () => {
  it('asserts the exact post-160 array length (41) and zero duplicates', () => {
    expect(code).toMatch(/expected exactly 41 purgeable tables after 160, found/);
    expect(code).toMatch(/phoenix_demo_purgeable_tables\(\) must contain no duplicate table name/);
  });
  it('asserts outbox-before-organizations and outbox-immediately-after-movement-events', () => {
    expect(code).toMatch(/phoenix_outbox_events must be purged before organizations/);
    expect(code).toMatch(/phoenix_outbox_events must be positioned immediately after phoenix_movement_events/);
  });
  it('asserts phoenix_demo_purger holds exactly SELECT, DELETE on phoenix_outbox_events, and authenticated/anon are untouched', () => {
    expect(code).toMatch(/phoenix_demo_purger must hold SELECT on phoenix_outbox_events/);
    expect(code).toMatch(/phoenix_demo_purger must hold DELETE on phoenix_outbox_events/);
    expect(code).toMatch(/phoenix_demo_purger must not gain INSERT on phoenix_outbox_events/);
    expect(code).toMatch(/phoenix_demo_purger must not gain UPDATE on phoenix_outbox_events/);
    expect(code).toMatch(/authenticated must still hold no privilege on phoenix_outbox_events/);
    expect(code).toMatch(/anon must still hold no privilege on phoenix_outbox_events/);
  });
  it('asserts exactly two phoenix_demo_purger-only policies exist on phoenix_outbox_events, RLS still enabled', () => {
    expect(code).toMatch(/phoenix_outbox_events must keep RLS enabled/);
    expect(code).toMatch(/phoenix_outbox_events must carry exactly the two phoenix_demo_purger policies this migration adds/);
    expect(code).toMatch(/both phoenix_outbox_events policies must target phoenix_demo_purger only/);
    expect(code).toMatch(/phoenix_outbox_events_demo_purger_select must exist as a SELECT policy/);
    expect(code).toMatch(/phoenix_outbox_events_demo_purger_delete must exist as a DELETE policy/);
  });
});
