/**
 * 162 CRLF-PORTABILITY HOTFIX — regression proof for the real Production
 * failure (2026-08-05, P0004: "both call sites must pass p_request_id as
 * the final (request_id) argument"). Migration 162's own in-transaction
 * VERIFY block contained one assertion anchored to a bare LF immediately
 * after the final p_request_id argument on each PERFORM call site. Postgres
 * stores a dollar-quoted function body byte-for-byte as submitted (no
 * line-ending normalization of its own) — the Supabase Production SQL
 * Editor preserved CRLF from the pasted Windows-authored source, so
 * pg_get_functiondef() returned 'p_request_id\r\n' instead of
 * 'p_request_id\n', the assertion's contiguous-LF search matched zero
 * occurrences instead of two, and the whole migration rolled back cleanly
 * (independently proven by the owner's own read-only rollback-verification
 * query at the time — Production was never left in a partial state).
 *
 * These tests build a disposable Postgres up to 161 (Production's exact
 * ceiling at incident time), then apply hand-transformed variants of
 * migration 162's own current on-disk text directly against that
 * connection — proving: the pre-hotfix assertion logic genuinely fails
 * under CRLF (reconstructed by mechanically stripping the two lines this
 * hotfix adds, never a separately-maintained frozen copy), the corrected
 * migration succeeds under both LF and CRLF with the exact right
 * postconditions, and the fix has not weakened the assertion's ability to
 * fail closed on a genuine defect.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freshRigDb, migrationFiles, shimSql, MIGRATIONS_DIR, rigAvailable, SEED_SUPER_ADMIN_ID } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const NAME = '162_phoenix_stocktake_and_exception_outbox_producers.sql';
const currentSql = readFileSync(join(MIGRATIONS_DIR, NAME), 'utf8');

// The exact line this hotfix adds, twice — immediately after each of the two
// `SELECT pg_get_functiondef(oid) INTO v_fn_src ...` fetches in the VERIFY
// block. Stripping it out of the CURRENT (fixed) on-disk source
// deterministically reconstructs the ORIGINAL pre-hotfix text that actually
// failed on Production — no separately-maintained frozen copy to drift out
// of sync with the real file.
const NORMALIZATION_LINE = "  v_fn_src := replace(v_fn_src, chr(13), '');\n";

function reconstructPreHotfixSql(sql: string): string {
  const occurrences = sql.split(NORMALIZATION_LINE).length - 1;
  if (occurrences !== 2) {
    throw new Error(
      `expected exactly 2 CRLF-normalization lines to strip, found ${occurrences} — ` +
      'has the hotfix been edited? Update NORMALIZATION_LINE to match.',
    );
  }
  return sql.split(NORMALIZATION_LINE).join('');
}

function toCrlf(sql: string): string {
  if (sql.includes('\r')) throw new Error('source already contains CR — refusing to double-convert');
  return sql.replace(/\n/g, '\r\n');
}

const SEED_AFTER_001 = `
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES ('${SEED_SUPER_ADMIN_ID}', 'root@rig.local',
          jsonb_build_object('full_name','Rig Root','role','super_admin'))
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.profiles SET role='super_admin', status='active'
   WHERE id='${SEED_SUPER_ADMIN_ID}';
`;

/** Builds a disposable Postgres through migration 161 only (Production's
 * exact ceiling at incident time) and returns the raw connected client,
 * matching buildRig()'s own internal loop but stopping short of applying
 * 162 itself so each test can apply its own hand-transformed variant. */
async function buildTo161() {
  const c = await freshRigDb();
  for (const f of migrationFiles(161)) {
    const raw = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    await c.query(shimSql(f, raw));
    if (f.startsWith('001_')) await c.query(SEED_AFTER_001);
  }
  return c;
}

async function helperReferenceCounts(c: any) {
  const r = await c.query(`
    SELECT
      (SELECT (LENGTH(src) - LENGTH(REPLACE(src, 'phoenix_append_outbox_event_internal', '')))
              / LENGTH('phoenix_append_outbox_event_internal')
       FROM (SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = 'phoenix_capture_stocktake_recorded') s) AS stocktake,
      (SELECT (LENGTH(src) - LENGTH(REPLACE(src, 'phoenix_append_outbox_event_internal', '')))
              / LENGTH('phoenix_append_outbox_event_internal')
       FROM (SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = 'phoenix_resolve_outlet_return_exception') s) AS exception
  `);
  return { stocktake: r.rows[0].stocktake as number, exception: r.rows[0].exception as number };
}

run('162 CRLF-portability hotfix — regression proof', () => {
  let c: Awaited<ReturnType<typeof freshRigDb>> | null = null;
  afterEach(async () => { if (c) { await c.end(); c = null; } });

  it('sanity: the current on-disk migration is pure LF (this suite\'s premise for every hand-transformed variant below)', () => {
    expect(currentSql).not.toContain('\r');
  });

  it('reproduces the real Production incident: the pre-hotfix assertion logic fails with the exact P0004 message when the source is stored with CRLF', async () => {
    c = await buildTo161();
    const preHotfix = reconstructPreHotfixSql(currentSql);
    const crlf = toCrlf(preHotfix);
    await expect(c.query(crlf)).rejects.toMatchObject({
      code: 'P0004',
      message: expect.stringContaining('both call sites must pass p_request_id as the final (request_id) argument'),
    });
    // The failed transaction rolled back completely — zero trace, exactly
    // matching the owner's own read-only rollback-verification on
    // Production (history ceiling 161, zero helper references, zero outbox
    // rows). Must explicitly ROLLBACK first: the script's own BEGIN was
    // never matched by a COMMIT, so this connection is left in an aborted
    // transaction until we do.
    await c.query('ROLLBACK');
    const post = await helperReferenceCounts(c);
    expect(post.stocktake).toBe(0);
    expect(post.exception).toBe(0);
    const outbox = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events');
    expect(outbox.rows[0].n).toBe(0);
  });

  it('the corrected migration applies successfully with LF line endings, exact right postconditions', async () => {
    c = await buildTo161();
    await c.query(currentSql);
    const counts = await helperReferenceCounts(c);
    expect(counts.stocktake).toBe(1);
    expect(counts.exception).toBe(2);
    const trig = await c.query(`
      SELECT
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_stocktake_recorded' AND cl.relname = 'stocktakes' AND NOT t.tgisinternal
            AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4) AS stocktake_trigger,
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.phoenix_outlet_return_exception_resolutions'::regclass AND NOT tgisinternal) AS resolutions_trigger
    `);
    expect(trig.rows[0].stocktake_trigger).toBe(1);
    expect(trig.rows[0].resolutions_trigger).toBe(0);
    const outbox = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events');
    expect(outbox.rows[0].n).toBe(0);
  });

  it('the corrected migration applies successfully with CRLF line endings — the exact fix for the reported Production failure, exact right postconditions', async () => {
    c = await buildTo161();
    await c.query(toCrlf(currentSql));
    const counts = await helperReferenceCounts(c);
    expect(counts.stocktake).toBe(1);
    expect(counts.exception).toBe(2);
    const trig = await c.query(`
      SELECT
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_stocktake_recorded' AND cl.relname = 'stocktakes' AND NOT t.tgisinternal
            AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4) AS stocktake_trigger,
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.phoenix_outlet_return_exception_resolutions'::regclass AND NOT tgisinternal) AS resolutions_trigger
    `);
    expect(trig.rows[0].stocktake_trigger).toBe(1);
    expect(trig.rows[0].resolutions_trigger).toBe(0);
    const outbox = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events');
    expect(outbox.rows[0].n).toBe(0);
  });

  it('still fails closed when one call site does not pass p_request_id as its final argument, proving the fix did not weaken detection', async () => {
    c = await buildTo161();
    // The top-level (corrected_receipt branch) call site, uniquely
    // identified by its 2-space-indented closing paren — the
    // confirmed_no_stock branch's equivalent block is 4-space indented, so
    // this leaves that first call site untouched and correct.
    const needle = '    v_correlation_id,\n    NULL::uuid,\n    p_request_id\n  );';
    const occurrences = currentSql.split(needle).length - 1;
    expect(occurrences).toBe(1);
    const broken = currentSql.replace(needle, '    v_correlation_id,\n    NULL::uuid,\n    NULL::uuid\n  );');
    await expect(c.query(broken)).rejects.toMatchObject({
      code: 'P0004',
      message: expect.stringContaining('both call sites must pass p_request_id as the final (request_id) argument'),
    });
  });
});
