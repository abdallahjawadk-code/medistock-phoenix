/**
 * RESET MANIFEST COVERAGE — schema 147 (A3-3B0N-R5).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database), like every other
 * *.dynamic.test.ts suite.
 *
 *   PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres \
 *   npx vitest run supabase/migrations/__tests__/ops-purge-v147-manifest-coverage.dynamic.test.ts
 *
 * THIS SUITE EXISTS BECAUSE OF A REAL DEFECT. The historical 090-era plan
 * (supabase/ops/pre_launch_runtime_reset.sql) carries a closed allowlist and
 * verifies emptiness ONLY for tables on that allowlist. Between 090 and 147 ten
 * runtime tables were added and four were renamed, so on a 147 database that
 * plan deletes nothing from them, asserts nothing about them, and still reaches
 * COMMIT reporting a clean zero-state. A false zero-state is far more dangerous
 * than a loud failure, so the manifest is pinned to pg_catalog here in BOTH
 * directions: a new table nobody classified fails, and a classified table that
 * no longer exists fails too.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

// PRE-EXISTING INFRASTRUCTURE FIX (surfaced by the R1.2C run, not caused by it).
// This suite REPLAYS THE MIGRATION CHAIN inside a beforeAll. vitest applies a
// separate 10s budget to HOOKS, which no testTimeout covers, so as the chain has
// grown the hook has crept toward that ceiling; past it, the hook is killed
// mid-replay and surfaces as ECONNRESET rather than as any assertion. An explicit
// hook budget removes that false signal. No assertion is changed or relaxed.
vi.setConfig({ hookTimeout: 240000 });
import {
  PURGE_ORDER as RUNTIME_DELETE_ORDER,
  PRESERVE as STRUCTURAL_PRESERVE,
  KEEPER_SCOPED as KEEPER_SCOPED_DELETE,
  ALL_CLASSIFIED_PUBLIC,
  MANIFEST_MIGRATION_CEILING,
  EXPECTED_PERMISSION_KEYS,
  EXPECTED_ROLE_PERMISSION_DEFAULTS,
} from '../../ops/purge-manifest-v147';

type Row = Record<string, unknown>;
type Client = { query: (q: string, p?: unknown[]) => Promise<{ rows: Row[] }> };

const run = rigAvailable() ? describe : describe.skip;

run('purge manifest v147 (Option A) — pg_catalog coverage', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let livePublic: string[] = [];

  beforeAll(async () => {
    rig = await buildRig({ upTo: MANIFEST_MIGRATION_CEILING });
    await rig.asAdmin(async (c: Client) => {
      const { rows } = await c.query(`
        SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname = 'public'
        ORDER BY 1`);
      livePublic = rows.map((r) => String(r.name));
    });
  }, 900_000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('classifies every public table at 147 — no unclassified table', () => {
    const unclassified = livePublic.filter((t) => !ALL_CLASSIFIED_PUBLIC.includes(t));
    expect(unclassified, `unclassified table(s) at ${MANIFEST_MIGRATION_CEILING}: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('has no classified table that is absent from schema 147', () => {
    const absent = ALL_CLASSIFIED_PUBLIC.filter((t) => !livePublic.includes(t));
    expect(absent, `manifest lists table(s) that do not exist: ${absent.join(', ')}`).toEqual([]);
  });

  it('assigns every table to exactly one category (no duplicates, no overlap)', () => {
    const all = [...RUNTIME_DELETE_ORDER, ...STRUCTURAL_PRESERVE, ...KEEPER_SCOPED_DELETE];
    const dupes = all.filter((t, i) => all.indexOf(t) !== i);
    expect(dupes, `table(s) in more than one category: ${dupes.join(', ')}`).toEqual([]);
  });

  it('covers the ten runtime tables the 090-era plan silently missed', () => {
    // Regression pin: these are exactly the tables added after 090 that the
    // historical allowlist omits. If any drops out of RUNTIME_DELETE_ORDER the
    // original silent-failure defect has been reintroduced.
    for (const t of [
      'phoenix_demo_manifest',
      'phoenix_dispatch_line_requests',
      'phoenix_movement_dispense_context',
      'phoenix_notification_reads',
      'phoenix_notifications',
      'phoenix_paper_references',
      'phoenix_report_snapshots',
      'phoenix_stock_correction_requests',
      'phoenix_warehouse_correction_requests',
      'profile_lifecycle_reservations',
    ]) {
      expect(RUNTIME_DELETE_ORDER, `${t} must be a RUNTIME_DELETE table`).toContain(t);
      expect(livePublic, `${t} must exist at 147`).toContain(t);
    }
  });

  it('does not treat the four renamed 090-era tables as if they still existed', () => {
    // notifications -> phoenix_notifications, etc. The old plan still names the
    // pre-rename tables and skips them via to_regclass, which is the mechanism
    // that made the miss silent.
    for (const gone of ['notifications', 'notification_reads', 'stock_corrections', 'stocktake_counts']) {
      expect(livePublic, `${gone} should not exist at 147`).not.toContain(gone);
      expect(ALL_CLASSIFIED_PUBLIC, `${gone} must not be in the v147 manifest`).not.toContain(gone);
    }
  });

  it('orders RUNTIME_DELETE child-first for every ordering-forcing FK', async () => {
    // Only RESTRICT / NO ACTION force an order; CASCADE and SET NULL do not.
    const { rows } = await rig.asAdmin((c: Client) => c.query(`
      SELECT cl.relname AS child, pl.relname AS parent, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace cn ON cn.oid = cl.relnamespace
      JOIN pg_class pl ON pl.oid = con.confrelid
      JOIN pg_namespace pn ON pn.oid = pl.relnamespace
      WHERE con.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public'`));

    const pos = new Map(RUNTIME_DELETE_ORDER.map((t, i) => [t, i]));
    const violations: string[] = [];
    for (const r of rows) {
      const child = String(r.child), parent = String(r.parent), def = String(r.def);
      if (child === parent) continue;
      if (!pos.has(child) || !pos.has(parent)) continue;
      if (/ON DELETE (CASCADE|SET NULL|SET DEFAULT)/i.test(def)) continue;
      if (pos.get(child)! > pos.get(parent)!) violations.push(`${child} must be deleted before ${parent}`);
    }
    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('pins the reference-row constants the plan asserts by value', async () => {
    const { rows } = await rig.asAdmin((c: Client) => c.query(`
      SELECT (SELECT count(*) FROM public.permission_keys)::int           AS pk,
             (SELECT count(*) FROM public.role_permission_defaults)::int  AS rpd`));
    expect(rows[0].pk).toBe(EXPECTED_PERMISSION_KEYS);
    expect(rows[0].rpd).toBe(EXPECTED_ROLE_PERMISSION_DEFAULTS);
  });
});
