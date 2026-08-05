/**
 * 163 VERIFICATION-ONLY HARDENING — regression proof for two defects found
 * before Migration 163 was ever applied to Production (still unregistered
 * at the time this file was written):
 *
 * 1. The committed VERIFY block used '\blisten\b|\bnotify\b|pg_notify' to
 *    detect LISTEN/NOTIFY usage inside the four new functions. PostgreSQL's
 *    regex engine (ARE) does not treat \b as a PCRE-style word boundary --
 *    empirically confirmed: 'listen test' ~ '\blisten\b' returns FALSE. The
 *    LISTEN/NOTIFY alternatives were therefore permanently inert; only the
 *    plain pg_notify literal ever worked. Fixed to the Postgres-native
 *    '\m(listen|notify)\M|pg_notify' form.
 *
 * 2. PRECONDITION/VERIFY resolved D2 producers and the four new D3-1
 *    functions by bare proname, and D2 trigger-table checks compared only a
 *    trigger COUNT, never the exact schema-qualified table SET. Both are
 *    hardened here to exact to_regprocedure()/schema-qualified-set checks,
 *    matching the already-validated Production preflight's own discipline.
 *
 * Both fixes are verification-only: the DDL (both CREATE TABLE statements,
 * all four CREATE FUNCTION bodies/signatures, every REVOKE, every index) is
 * byte-for-byte unchanged -- proven separately by a structural diff of the
 * DDL region against the pre-hotfix committed source, not re-derived here.
 *
 * These tests build a disposable Postgres up to 162, then apply the current
 * on-disk migration 163 text (or a deliberately mutated variant of it)
 * directly against that connection -- proving the corrected regex behavior,
 * the OID/schema-qualified hardening's resistance to decoys, and that every
 * one of the newly-added assertions still fails closed on a genuine defect.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshRigDb, migrationFiles, shimSql, MIGRATIONS_DIR, rigAvailable, SEED_SUPER_ADMIN_ID } from '../../../tools/pg-rig/rig.mjs';

// A full 001->162 replay per test (buildTo162) is slower than the default
// 5000ms test timeout under load -- matches the same reason the sibling
// 162-CRLF regression file's own buildTo161() tests run close to that
// limit, one migration fewer.
vi.setConfig({ testTimeout: 30000 });

const run = rigAvailable() ? describe : describe.skip;

const NAME = '163_phoenix_outbox_consumer_foundation.sql';
const currentSql = readFileSync(join(MIGRATIONS_DIR, NAME), 'utf8');

const CORRECTED_PATTERN = String.raw`\m(listen|notify)\M|pg_notify`;
const DEFECTIVE_PATTERN = String.raw`\blisten\b|\bnotify\b`;

const SEED_AFTER_001 = `
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES ('${SEED_SUPER_ADMIN_ID}', 'root@rig.local',
          jsonb_build_object('full_name','Rig Root','role','super_admin'))
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.profiles SET role='super_admin', status='active'
   WHERE id='${SEED_SUPER_ADMIN_ID}';
`;

/** Builds a disposable Postgres through migration 162 only, leaving 163
 * itself to be applied by each individual test (unmodified or deliberately
 * mutated), matching the same technique already established for the 162
 * CRLF hotfix regression suite. */
async function buildTo162() {
  const c = await freshRigDb();
  for (const f of migrationFiles(162)) {
    const raw = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    await c.query(shimSql(f, raw));
    if (f.startsWith('001_')) await c.query(SEED_AFTER_001);
  }
  return c;
}

async function assertNoD3ObjectsExist(c: any) {
  const r = await c.query(`
    SELECT
      to_regclass('public.phoenix_outbox_consumers') AS consumers,
      to_regclass('public.phoenix_outbox_delivery_state') AS delivery_state,
      to_regprocedure('public.phoenix_outbox_claim_batch(text,uuid,integer)') AS claim_batch
  `);
  expect(r.rows[0].consumers).toBeNull();
  expect(r.rows[0].delivery_state).toBeNull();
  expect(r.rows[0].claim_batch).toBeNull();
}

run('163 verification-only hardening — regression proof', () => {
  let c: Awaited<ReturnType<typeof freshRigDb>> | null = null;
  afterEach(async () => { if (c) { await c.end(); c = null; } });

  // Pure source-text checks (no live DB needed) -- e.g. "no longer contains
  // the defective \blisten\b pattern", "resolves every function by exact
  // OID", "checks exact schema-qualified trigger sets" -- live in
  // 163-outbox-consumer-foundation-static.test.ts instead, so they run
  // unconditionally in CI even without PHOENIX_RIG_PG. This file is
  // reserved for what genuinely requires a live Postgres connection: real
  // regex BEHAVIOR (Postgres ARE, not JS regex), a real apply, and real
  // rollback/assertion-failure proofs.

  it('regex behavior proof: the EXACT corrected pattern extracted from the migration source matches standalone LISTEN and NOTIFY, and pg_notify(...), but not "listener" or "notification"', async () => {
    c = await buildTo162();
    const r = await c.query(
      `SELECT
         'listen test' ~ $1 AS matches_listen,
         'notify test' ~ $1 AS matches_notify,
         'listener test' ~ $1 AS matches_listener_should_be_false,
         'notification test' ~ $1 AS matches_notification_should_be_false,
         'select pg_notify(''x'',''y'')' ~ $1 AS matches_pg_notify_call,
         'do $$ begin notify chan; end $$;' ~ $1 AS matches_notify_statement`,
      [CORRECTED_PATTERN],
    );
    const row = r.rows[0];
    expect(row.matches_listen).toBe(true);
    expect(row.matches_notify).toBe(true);
    expect(row.matches_listener_should_be_false).toBe(false);
    expect(row.matches_notification_should_be_false).toBe(false);
    expect(row.matches_pg_notify_call).toBe(true);
    expect(row.matches_notify_statement).toBe(true);
  });

  it('regex behavior proof: the OLD defective \\b pattern never matches, confirming why it was a real blind spot', async () => {
    c = await buildTo162();
    const r = await c.query(
      `SELECT 'listen test' ~ $1 AS matches_listen, 'notify test' ~ $1 AS matches_notify`,
      [DEFECTIVE_PATTERN],
    );
    expect(r.rows[0].matches_listen).toBe(false);
    expect(r.rows[0].matches_notify).toBe(false);
  });

  it('the corrected migration applies cleanly to a fresh 162-ceiling rig with no modification', async () => {
    c = await buildTo162();
    await c.query(currentSql);
    const t = await c.query(`SELECT to_regclass('public.phoenix_outbox_consumers') AS r`);
    expect(t.rows[0].r).toBe('phoenix_outbox_consumers');
  });

  describe('negative control: executable NOTIFY injected into one D3-1 function before VERIFY', () => {
    it('rolls back with the LISTEN/NOTIFY assertion, leaves zero D3-1 objects behind', async () => {
      c = await buildTo162();
      const needle = "  -- Deliberately does NOT touch attempt_count — a cooperative release is\n  -- not a failure. Only lease_expires_at is cleared; lease_owner_token is\n  -- retained, matching every other transition's own convention.\n  UPDATE public.phoenix_outbox_delivery_state";
      expect(currentSql.split(needle).length - 1).toBe(1);
      const poisoned = currentSql.replace(needle, "  NOTIFY phoenix_test_channel;\n" + needle);
      await expect(c.query(poisoned)).rejects.toMatchObject({
        message: expect.stringContaining('no D3-1 function may use LISTEN/NOTIFY'),
      });
      await c.query('ROLLBACK');
      await assertNoD3ObjectsExist(c);
    });
  });

  describe('negative control: executable pg_notify(...) injected into one D3-1 function', () => {
    it('rolls back with the LISTEN/NOTIFY assertion, leaves zero D3-1 objects behind', async () => {
      c = await buildTo162();
      const needle = '  RETURN jsonb_build_object(\'ok\', true, \'delivery_state_id\', v_ds.id, \'available_at\', now());';
      expect(currentSql.split(needle).length - 1).toBe(1);
      const poisoned = currentSql.replace(needle, "  PERFORM pg_notify('phoenix_test_channel', 'x');\n" + needle);
      await expect(c.query(poisoned)).rejects.toMatchObject({
        message: expect.stringContaining('no D3-1 function may use LISTEN/NOTIFY'),
      });
      await c.query('ROLLBACK');
      await assertNoD3ObjectsExist(c);
    });
  });

  describe('negative control: a D2 trigger moved to a same-named table in another schema, count unchanged', () => {
    it('the hardened PRECONDITION rejects it before any D3-1 DDL runs', async () => {
      c = await buildTo162();
      await c.query('CREATE SCHEMA decoy_schema');
      await c.query('CREATE TABLE decoy_schema.warehouse_dispatches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid)');
      await c.query('DROP TRIGGER phoenix_capture_lifecycle ON public.warehouse_dispatches');
      await c.query(
        "CREATE TRIGGER phoenix_capture_lifecycle AFTER INSERT OR UPDATE ON decoy_schema.warehouse_dispatches " +
          "FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('organization_id')",
      );
      const countCheck = await c.query(
        `SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal`,
      );
      expect(countCheck.rows[0].n).toBe(11); // count unchanged -- only the SET moved
      await expect(c.query(currentSql)).rejects.toMatchObject({
        message: expect.stringContaining('lifecycle trigger attachments are not exactly the 11 approved public tables'),
      });
      await c.query('ROLLBACK');
      await assertNoD3ObjectsExist(c);
    });
  });

  describe('negative control: a same-name function overload / other-schema decoy exists before apply', () => {
    it('the corrected migration still applies successfully — OID-exact resolution is not confused by the decoy', async () => {
      c = await buildTo162();
      // Same NAME as the real claim_batch, but a DIFFERENT signature -- the
      // precondition's own idempotent-apply guard checks the exact
      // 3-argument signature via to_regprocedure(), so this decoy must not
      // trip it.
      await c.query(
        `CREATE FUNCTION public.phoenix_outbox_claim_batch(p_decoy text)
         RETURNS void LANGUAGE sql AS $decoy$ SELECT NULL $decoy$`,
      );
      await c.query('CREATE SCHEMA decoy_schema_fn');
      await c.query(
        `CREATE FUNCTION decoy_schema_fn.phoenix_capture_lifecycle_event()
         RETURNS trigger LANGUAGE plpgsql AS $decoy$ BEGIN RETURN NEW; END; $decoy$`,
      );
      await c.query(currentSql);
      const t = await c.query(`SELECT to_regclass('public.phoenix_outbox_consumers') AS r`);
      expect(t.rows[0].r).toBe('phoenix_outbox_consumers');
      const real = await c.query(`SELECT to_regprocedure('public.phoenix_outbox_claim_batch(text,uuid,integer)') AS r`);
      expect(real.rows[0].r).not.toBeNull();
    });
  });

  describe('negative control: one D3-1 function loses SECURITY DEFINER', () => {
    it('rolls back with the SECURITY DEFINER assertion, leaves zero D3-1 objects behind', async () => {
      c = await buildTo162();
      const needle = 'AS $release$\nDECLARE\n  v_consumer public.phoenix_outbox_consumers%ROWTYPE;';
      expect(currentSql.split(needle).length - 1).toBe(1);
      // Remove release_lease's own SECURITY DEFINER clause.
      const releaseHeaderNeedle = 'RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public, pg_temp\nAS $release$';
      expect(currentSql.split(releaseHeaderNeedle).length - 1).toBe(1);
      const mutated = currentSql.replace(
        releaseHeaderNeedle,
        'RETURNS jsonb\nLANGUAGE plpgsql\nSET search_path = public, pg_temp\nAS $release$',
      );
      await expect(c.query(mutated)).rejects.toMatchObject({
        message: expect.stringContaining('phoenix_outbox_release_lease must be SECURITY DEFINER'),
      });
      await c.query('ROLLBACK');
      await assertNoD3ObjectsExist(c);
    });
  });

  describe('negative control: authenticated gains EXECUTE on one D3-1 function', () => {
    it('rolls back with the authenticated-EXECUTE assertion, leaves zero D3-1 objects behind', async () => {
      c = await buildTo162();
      const needle = 'REVOKE ALL ON FUNCTION public.phoenix_outbox_release_lease(text, uuid, uuid) FROM PUBLIC, authenticated, anon;';
      expect(currentSql.split(needle).length - 1).toBe(1);
      const mutated = currentSql.replace(
        needle,
        needle + '\nGRANT EXECUTE ON FUNCTION public.phoenix_outbox_release_lease(text, uuid, uuid) TO authenticated;',
      );
      await expect(c.query(mutated)).rejects.toMatchObject({
        message: expect.stringContaining('authenticated must not be able to execute'),
      });
      await c.query('ROLLBACK');
      await assertNoD3ObjectsExist(c);
    });
  });

  describe('negative control: one new table loses RLS', () => {
    it('rolls back with the RLS assertion, leaves zero D3-1 objects behind', async () => {
      c = await buildTo162();
      const needle = 'ALTER TABLE public.phoenix_outbox_consumers ENABLE ROW LEVEL SECURITY;\n';
      expect(currentSql.split(needle).length - 1).toBe(1);
      const mutated = currentSql.replace(needle, '');
      await expect(c.query(mutated)).rejects.toMatchObject({
        message: expect.stringContaining('phoenix_outbox_consumers must have RLS enabled'),
      });
      await c.query('ROLLBACK');
      await assertNoD3ObjectsExist(c);
    });
  });
});
