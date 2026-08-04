/**
 * DEMO-PURGE-OUTBOX-COMPATIBILITY-160 — DYNAMIC integration proof, against a
 * real disposable Postgres with 001->160 applied in order.
 *
 * Rather than re-driving the FULL demo dataset seeder (tools/phoenix-demo/
 * seed.mjs, already comprehensively exercised end-to-end — including this
 * exact scenario, an outbox row surviving into a purge attempt — by
 * phoenix-demo-seed-lifecycle.dynamic.test.ts, which this migration's own
 * regression battery re-runs and confirms green), this file proves the
 * narrow correction directly and in isolation: register one organization
 * and one outbox row against the SAME manifest mechanism
 * (phoenix_demo_manifest, 140) phoenix_demo_purge() itself reads, then
 * prove a real purge call removes both with no RESTRICT violation.
 * Duplicating the entire seeder's manifest-tagging machinery here would be
 * redundant engineering for what is, precisely, a one-table addition to a
 * pre-existing, already-proven deletion-order mechanism.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
// phoenix_demo_purge() (143) hard-checks p_dataset_key = 'PHOENIX_DEMO_V1'
// exactly (RAISE EXCEPTION 'invalid_demo_dataset_key' otherwise) — it is not
// an arbitrary caller-supplied label, so this focused test must use the same
// real constant the demo seeder itself uses.
const DATASET_KEY = 'PHOENIX_DEMO_V1';

run('160 demo-purge outbox compatibility — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 160 });
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  describe('the purgeable-table function itself', () => {
    it('includes phoenix_outbox_events exactly once, immediately after phoenix_movement_events, strictly before organizations', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query('SELECT public.phoenix_demo_purgeable_tables() AS tables');
        const tables: string[] = r.rows[0].tables;
        const outboxOccurrences = tables.filter(t => t === 'phoenix_outbox_events').length;
        expect(outboxOccurrences).toBe(1);
        expect(tables.indexOf('phoenix_outbox_events')).toBe(tables.indexOf('phoenix_movement_events') + 1);
        expect(tables.indexOf('phoenix_outbox_events')).toBeLessThan(tables.indexOf('organizations'));
      });
    });

    it('preserves the existing authenticated-only EXECUTE grant', async () => {
      await rig.asAdmin(async (c: any) => {
        const auth = await c.query(`SELECT has_function_privilege('authenticated','public.phoenix_demo_purgeable_tables()','EXECUTE') AS has`);
        const anon = await c.query(`SELECT has_function_privilege('anon','public.phoenix_demo_purgeable_tables()','EXECUTE') AS has`);
        expect(auth.rows[0].has).toBe(true);
        expect(anon.rows[0].has).toBe(false);
      });
    });
  });

  describe('the phoenix_demo_purger access extension this migration adds', () => {
    it('grants phoenix_demo_purger exactly SELECT, DELETE on phoenix_outbox_events -- no more, no less', async () => {
      await rig.asAdmin(async (c: any) => {
        const priv = async (p: string) => {
          const r = await c.query(`SELECT has_table_privilege('phoenix_demo_purger','public.phoenix_outbox_events',$1) AS has`, [p]);
          return r.rows[0].has;
        };
        expect(await priv('SELECT')).toBe(true);
        expect(await priv('DELETE')).toBe(true);
        expect(await priv('INSERT')).toBe(false);
        expect(await priv('UPDATE')).toBe(false);
      });
    });

    it('does not change authenticated/anon privilege on phoenix_outbox_events (158s lockdown intact)', async () => {
      await rig.asAdmin(async (c: any) => {
        const auth = await c.query(`SELECT has_table_privilege('authenticated','public.phoenix_outbox_events','SELECT') AS has`);
        const anon = await c.query(`SELECT has_table_privilege('anon','public.phoenix_outbox_events','SELECT') AS has`);
        expect(auth.rows[0].has).toBe(false);
        expect(anon.rows[0].has).toBe(false);
      });
    });
  });

  describe('a real purge run against a manifest-registered organization with a live outbox row', () => {
    it('removes the outbox row and the organization, with no RESTRICT violation', async () => {
      const orgId = randomUUID();
      const eventKey = `lifecycle:${orgId}:test`;

      await rig.asAdmin(async (c: any) => {
        // 1. A manifest-registered organization — the exact ownership
        // mechanism (140) phoenix_demo_purge() itself reads; never a
        // name/pattern heuristic.
        await c.query(
          `INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'160 Purge Test','160 Purge Test','p160-purge-test')`,
          [orgId],
        );
        await c.query(
          `INSERT INTO phoenix_demo_manifest (dataset_key, table_name, row_id) VALUES ($1,'organizations',$2)`,
          [DATASET_KEY, orgId],
        );

        // 2. A live phoenix_outbox_events row referencing that organization
        // — via the real append helper (158), exactly as 159's trigger
        // would produce one, so its ON DELETE RESTRICT FK is genuinely live.
        const appended = await c.query(
          `SELECT event_id FROM public.phoenix_append_outbox_event_internal(
             $1::text, 'test.event'::text, 1::smallint, 'test_aggregate'::text, $2::uuid, $3::uuid,
             '{}'::jsonb, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
           )`,
          [eventKey, orgId, orgId],
        );
        const outboxRowId = appended.rows[0].event_id;
        await c.query(
          `INSERT INTO phoenix_demo_manifest (dataset_key, table_name, row_id) VALUES ($1,'phoenix_outbox_events',$2)`,
          [DATASET_KEY, outboxRowId],
        );

        // 3. Before purge: both rows genuinely exist.
        const orgBefore = await c.query('SELECT count(*)::int n FROM organizations WHERE id = $1', [orgId]);
        const outboxBefore = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE id = $1', [outboxRowId]);
        expect(orgBefore.rows[0].n).toBe(1);
        expect(outboxBefore.rows[0].n).toBe(1);

        // 4. Without 160, this DELETE-through-purge would hit exactly the
        // RESTRICT violation 143 exists to prevent, for the one table 143
        // never had a chance to include.
        return outboxRowId;
      });

      const purgeResult = await rig.asUser(rig.superAdminId, (c: any) =>
        c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, [DATASET_KEY, false])
          .then((r: any) => r.rows),
        { commit: true },
      );
      expect(Array.isArray(purgeResult)).toBe(true);

      await rig.asAdmin(async (c: any) => {
        const orgAfter = await c.query('SELECT count(*)::int n FROM organizations WHERE id = $1', [orgId]);
        const outboxAfter = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]);
        expect(orgAfter.rows[0].n).toBe(0);
        expect(outboxAfter.rows[0].n).toBe(0);
      });
    });

    it('the outbox table, its identity sequence, and its privilege lockdown all survive the purge unchanged', async () => {
      await rig.asAdmin(async (c: any) => {
        const tableExists = await c.query(`SELECT to_regclass('public.phoenix_outbox_events') IS NOT NULL AS ok`);
        expect(tableExists.rows[0].ok).toBe(true);

        const seqExists = await c.query(`
          SELECT to_regclass('public.phoenix_outbox_events_stream_position_seq') IS NOT NULL AS ok`);
        expect(seqExists.rows[0].ok).toBe(true);

        const rls = await c.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phoenix_outbox_events'::regclass`);
        expect(rls.rows[0].relrowsecurity).toBe(true);

        // 160 itself adds exactly two phoenix_demo_purger-only policies
        // (SELECT + DELETE, manifest-scoped) -- required for the purge role
        // to see/delete through RLS-zero-policy phoenix_outbox_events at
        // all (discovered dynamically; see 160's own WHY comment). Zero
        // policies for every OTHER role remains true, checked below.
        const policies = await c.query(`SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname='public' AND tablename='phoenix_outbox_events' ORDER BY policyname`);
        expect(policies.rows).toEqual([
          { policyname: 'phoenix_outbox_events_demo_purger_delete', cmd: 'DELETE', roles: ['phoenix_demo_purger'] },
          { policyname: 'phoenix_outbox_events_demo_purger_select', cmd: 'SELECT', roles: ['phoenix_demo_purger'] },
        ]);

        const authSelect = await c.query(`SELECT has_table_privilege('authenticated','public.phoenix_outbox_events','SELECT') AS has`);
        expect(authSelect.rows[0].has).toBe(false);
      });
    });
  });

  describe('regression: 159 and 158 remain fully intact through 160', () => {
    it('phoenix_capture_lifecycle_event still contains exactly one outbox call site and all 11 attachments', async () => {
      await rig.asAdmin(async (c: any) => {
        const src = await c.query(`SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event'`);
        const occurrences = [...String(src.rows[0].src).matchAll(/phoenix_append_outbox_event_internal/g)];
        expect(occurrences.length).toBe(1);

        const triggers = await c.query(`
          SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal`);
        expect(triggers.rows[0].n).toBe(11);
      });
    });

    it('phoenix_append_outbox_event_internal still exists with its exact signature, SECURITY DEFINER, pinned search_path', async () => {
      await rig.asAdmin(async (c: any) => {
        const exists = await c.query(
          `SELECT to_regprocedure('public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)') IS NOT NULL AS ok`);
        expect(exists.rows[0].ok).toBe(true);
        const props = await c.query(
          `SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_append_outbox_event_internal'`);
        expect(props.rows[0].prosecdef).toBe(true);
      });
    });
  });
});
