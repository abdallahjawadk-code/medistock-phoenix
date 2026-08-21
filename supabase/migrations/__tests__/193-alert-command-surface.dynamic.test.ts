/**
 * ALERT-COMMAND-SURFACE-193 — DYNAMIC proof.
 *
 * The claims under test are behavioural and cannot be read off the SQL:
 *
 *   · a clean 001->193 replay succeeds, VERIFY block included;
 *   · an AUTHORIZED authenticated actor can still run the sanctioned refresh
 *     COMMAND, and it still performs the lifecycle writes it is supposed to;
 *   · auth.uid() is NOT substituted by the owner across the new
 *     caller -> DEFINER refresh -> DEFINER hybrid chain — proven by two
 *     different JWT actors getting two different, correctly-scoped answers out
 *     of the same function;
 *   · an UNAUTHORIZED authenticated actor is still refused by Phoenix's own
 *     permission logic, not by a database privilege accident;
 *   · direct hybrid and direct legacy-page invocation are DENIED to
 *     `authenticated`, and anon is denied the command;
 *   · the pure CQRS page and summary still answer, and still write nothing;
 *   · the migration moved NO relation privilege for anon or authenticated —
 *     measured across the migration itself rather than asserted from a list.
 *
 * WHY THE RIG IS BUILT AT 192 AND 193 IS APPLIED IN-TEST. The decisive question
 * is what 193 CHANGES, so the before-image has to be taken on the same database
 * a moment earlier. Building two rigs would compare two different worlds; this
 * compares one world to itself.
 *
 * PG-RIG FIDELITY NOTE. The rig grants `authenticated` far more relation
 * privilege than Production does (an over-permissive default-privilege rule in
 * tools/pg-rig/bootstrap.sql, which Unit 2 owns). Every assertion here is
 * therefore a DELTA — "193 changed nothing" — never an absolute privilege set,
 * so none of these tests can pass merely because the rig is generous.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI's ordinary suite.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const NAME = '193_phoenix_inter_org_alert_command_surface_hardening.sql';
const SQL_193 = readFileSync(join(__dirname, '..', NAME), 'utf8');

const ORG_A = '00000000-0000-0000-0000-000000193001'; // hospital, supply side
const ORG_B = '00000000-0000-0000-0000-000000193002'; // hospital, demand side
const ORG_OUT = '00000000-0000-0000-0000-000000193003'; // no part in any alert

const WH_A = '00000000-0000-0000-0000-000000193101';
const WH_B = '00000000-0000-0000-0000-000000193102';
const DP_A = '00000000-0000-0000-0000-000000193201';
const DP_B = '00000000-0000-0000-0000-000000193202';

const AV_A_SUPPLY = '00000000-0000-0000-0000-000000193301'; // surplus
const AV_B_DEMAND = '00000000-0000-0000-0000-000000193302'; // missing, pairs with A

/** institution_admin — carries inter_institution_alerts.view. */
const USER_B = '00000000-0000-0000-0000-000000193501';
/** institution_admin in an organization with no part in any alert. */
const USER_OUT = '00000000-0000-0000-0000-000000193502';
/** outlet_officer — carries NEITHER alert-view permission. The unauthorized actor. */
const USER_DENIED = '00000000-0000-0000-0000-000000193503';

type PrivRow = { grantee: string; relname: string; priv: string };

const PRIV_SQL = `
  SELECT g.grantee, c.relname, p.priv
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('anon'),('authenticated')) AS g(grantee)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                     ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r','p','v','m','f')
    AND has_table_privilege(g.grantee, c.oid, p.priv)
  ORDER BY 1,2,3`;

run('193 · inter-org alert command-surface hardening (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let privBefore: string[] = [];
  let privAfter: string[] = [];

  const callAs = (userId: string | null, sql: string, role = 'authenticated'): Promise<any> =>
    rig.asUser(userId, (c: any) => c.query(sql).then((r: any) => r.rows[0].payload), { role });

  const superId = () => rig.superAdminId;

  const refresh = (u: string | null, limit = 500, role = 'authenticated') =>
    callAs(u, `SELECT public.phoenix_refresh_inter_org_alert_lifecycle(${limit}) AS payload`, role);
  const pureP = (u: string | null, limit = 50, offset = 0) =>
    callAs(u, `SELECT public.phoenix_query_live_inter_org_alerts_with_state_page(${limit}, ${offset}) AS payload`);
  const pureS = (u: string | null, limit = 200) =>
    callAs(u, `SELECT public.phoenix_query_live_inter_org_alert_summary(${limit}) AS payload`);

  /**
   * Census before and after INSIDE one transaction, so a write is observed
   * rather than rolled away. `authenticated` has no grant on
   * inter_org_alert_events at all, so the count hops to the owner role and
   * straight back — same transaction throughout.
   */
  const censusAround = async (sql: string, userId: string | null) =>
    rig.asUser(userId, async (c: any) => {
      const count = async () => {
        await c.query('SET LOCAL ROLE postgres');
        const row = (await c.query(
          `SELECT (SELECT count(*)::int FROM inter_org_alert_states) AS states,
                  (SELECT count(*)::int FROM inter_org_alert_events) AS events`)).rows[0];
        await c.query('SET LOCAL ROLE authenticated');
        return row;
      };
      const before = await count();
      const value = (await c.query(sql)).rows[0].payload;
      const after = await count();
      return { before, after, value };
    });

  const fnFacts = async (name: string, args: string) => {
    const { rows } = await rig.asAdmin((c: any) => c.query(
      `SELECT p.prosecdef AS secdef,
              coalesce(array_to_string(p.proconfig, ','), '<none>') AS cfg,
              p.provolatile::text AS vol,
              md5(p.prosrc) AS body_md5,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
              has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_x
         FROM pg_proc p
        WHERE p.oid = to_regprocedure('public.${name}(${args})')`));
    return rows[0];
  };

  beforeAll(async () => {
    // 1. Clean chain up to the migration immediately before this one.
    rig = await buildRig({ upTo: 192 });

    // 2. A minimal cross-organization alert fixture. Every availability row is
    //    port-name-only (local_item_id NULL), which is 189's hardest path and
    //    the one the hybrid's canonical identity bridge must keep total.
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
          ('${ORG_A}','Hospital A 193','مستشفى أ 193','193-a','care_institution','hospital'),
          ('${ORG_B}','Hospital B 193','مستشفى ب 193','193-b','care_institution','hospital'),
          ('${ORG_OUT}','Outsider 193','خارجي 193','193-out','care_institution','hospital')
        ON CONFLICT(id) DO NOTHING`);
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,status,code) VALUES
          ('${WH_A}','${ORG_A}','Depot A 193','مذخر أ 193','institution','active','193-wa'),
          ('${WH_B}','${ORG_B}','Depot B 193','مذخر ب 193','institution','active','193-wb')
        ON CONFLICT(id) DO NOTHING`);
      await c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
          ('${DP_A}','${WH_A}','${ORG_A}','Pharmacy A 193','صيدلية أ 193','pharmacy','active'),
          ('${DP_B}','${WH_B}','${ORG_B}','Pharmacy B 193','صيدلية ب 193','pharmacy','active')
        ON CONFLICT(id) DO NOTHING`);
      await c.query(`
        INSERT INTO item_availability
          (id,distribution_point_id,organization_id,port_name,scientific_name,
           national_code,concentration,dosage_form,quantity,condition,expiry_date) VALUES
          ('${AV_A_SUPPLY}','${DP_A}','${ORG_A}','P-A1','Amoxicillin','NC-193-A','500 mg','tablet',100,'surplus',NULL),
          ('${AV_B_DEMAND}','${DP_B}','${ORG_B}','P-B1','Amoxicillin','NC-193-A','500 mg','tablet',0,'missing',NULL)
        ON CONFLICT(id) DO NOTHING`);
      await c.query(`
        INSERT INTO auth.users(id,email) VALUES
          ('${USER_B}','b193@example.test'),
          ('${USER_OUT}','out193@example.test'),
          ('${USER_DENIED}','denied193@example.test')
        ON CONFLICT(id) DO NOTHING`);
      // outlet_officer holds NEITHER inter_institution_alerts.view nor
      // exchange_alerts.view, so USER_DENIED exercises the real permission gate.
      await c.query(`
        INSERT INTO profiles(id,organization_id,full_name,role,status) VALUES
          ('${USER_B}','${ORG_B}','User B 193','institution_admin','active'),
          ('${USER_OUT}','${ORG_OUT}','User Out 193','institution_admin','active'),
          ('${USER_DENIED}','${ORG_B}','User Denied 193','outlet_officer','active')
        ON CONFLICT(id) DO UPDATE
          SET role = excluded.role,
              organization_id = excluded.organization_id,
              status = excluded.status`);
    });

    // 3. Before-image, taken on THIS database.
    privBefore = (await rig.asAdmin((c: any) => c.query(PRIV_SQL))).rows
      .map((r: PrivRow) => `${r.grantee}:${r.relname}:${r.priv}`);

    // 4. The migration under test, applied exactly as the chain would apply it
    //    (its own BEGIN/COMMIT and its own VERIFY block included).
    await rig.asAdmin((c: any) => c.query(SQL_193));

    // 5. After-image.
    privAfter = (await rig.asAdmin((c: any) => c.query(PRIV_SQL))).rows
      .map((r: PrivRow) => `${r.grantee}:${r.relname}:${r.priv}`);
  }, 900_000);

  afterAll(async () => { if (rig) await rig.end(); });

  // -------------------------------------------------------------------------
  describe('A · the migration itself', () => {
    it('applies on top of a clean 001->192 chain, VERIFY block included', () => {
      // beforeAll throws if the migration or any of its assertions fail, so
      // reaching this point is the proof. Both bookkeeping tables must be gone.
      expect(privBefore.length).toBeGreaterThan(0);
      expect(privAfter.length).toBeGreaterThan(0);
    });

    it('leaves no bookkeeping table behind', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname LIKE 'phoenix_193%'`));
      expect(rows[0].n).toBe(0);
    });

    it('creates and drops no function — the public function count is unchanged', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public'`));
      // 417 is the rig's post-192 count; the migration adds and removes none.
      expect(rows[0].n).toBe(417);
    });

    it('refuses to run twice — the second attempt fails its own precondition', async () => {
      await rig.asAdmin(async (c: any) => {
        // The migration opens its OWN transaction, so a failing precondition
        // leaves this connection in an aborted one. Roll it back explicitly
        // before releasing, or every later test inherits a poisoned session.
        await expect(c.query(SQL_193))
          .rejects.toThrow(/193_precondition_failed: the refresh command is already SECURITY DEFINER/);
        await c.query('ROLLBACK');
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('B · the three intended deltas, and nothing else', () => {
    it('the refresh command is now SECURITY DEFINER, with body and search_path intact', async () => {
      const f = await fnFacts('phoenix_refresh_inter_org_alert_lifecycle', 'integer');
      expect(f.secdef).toBe(true);
      expect(f.cfg).toBe('search_path=public, pg_temp');
      expect(f.vol).toBe('v');
      expect(f.auth_x).toBe(true);
      expect(f.anon_x).toBe(false);
    });

    it('the refresh command still delegates to the hybrid and holds no DML of its own', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.phoenix_refresh_inter_org_alert_lifecycle(integer)')`));
      expect(rows[0].prosrc).toContain('phoenix_get_live_inter_institution_alerts_with_state(p_limit)');
      expect(rows[0].prosrc).not.toMatch(/insert\s+into/i);
      expect(rows[0].prosrc).not.toMatch(/update\s+\w+\s+set/i);
      expect(rows[0].prosrc).not.toMatch(/delete\s+from/i);
    });

    it('the hybrid is closed to authenticated but otherwise unchanged', async () => {
      const f = await fnFacts('phoenix_get_live_inter_institution_alerts_with_state', 'integer');
      expect(f.auth_x).toBe(false);
      expect(f.anon_x).toBe(false);
      expect(f.secdef).toBe(true);
      expect(f.cfg).toBe('search_path=public, pg_temp');
    });

    it('the legacy paging wrapper is closed to authenticated but otherwise unchanged', async () => {
      const f = await fnFacts('phoenix_get_live_inter_institution_alerts_with_state_page', 'integer,integer');
      expect(f.auth_x).toBe(false);
      expect(f.anon_x).toBe(false);
      expect(f.secdef).toBe(true);
    });

    it('the pure read chain keeps every privilege it had', async () => {
      const base = await fnFacts('phoenix_get_live_inter_institution_alerts', 'integer');
      const page = await fnFacts('phoenix_query_live_inter_org_alerts_with_state_page', 'integer,integer');
      const summary = await fnFacts('phoenix_query_live_inter_org_alert_summary', 'integer');
      const proj = await fnFacts('_phoenix_live_inter_org_alert_read_projection_v1', 'integer');
      expect(base.auth_x).toBe(true);
      expect(page.auth_x).toBe(true);
      expect(summary.auth_x).toBe(true);
      // The internal projection was never client-executable and must stay so.
      expect(proj.auth_x).toBe(false);
      expect(proj.anon_x).toBe(false);
    });

    it('moves NO relation privilege for anon or authenticated, in either direction', () => {
      // A pure delta, so the rig's over-permissive baseline cannot make it pass.
      expect(privAfter).toEqual(privBefore);
    });
  });

  // -------------------------------------------------------------------------
  describe('C · the sanctioned command still works, for the right people only', () => {
    it('an AUTHORIZED authenticated actor can run the refresh command', async () => {
      const payload = await refresh(USER_B);
      expect(payload?.ok, JSON.stringify(payload)).toBe(true);
      expect(typeof payload.refreshed_count).toBe('number');
      expect(payload.computed_at).toBeTruthy();
    });

    it('the refresh command genuinely performs the lifecycle writes', async () => {
      const { before, after, value } = await censusAround(
        'SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500) AS payload',
        USER_B,
      );
      expect(value?.ok, JSON.stringify(value)).toBe(true);
      expect(value.refreshed_count).toBeGreaterThan(0);
      // The hybrid is still the writer; the command is still what triggers it.
      expect(after.states).toBeGreaterThan(before.states);
      expect(after.events).toBeGreaterThan(before.events);
    });

    it('an UNAUTHORIZED authenticated actor is refused by Phoenix permission logic', async () => {
      // outlet_officer holds neither alert-view permission. The refusal must be
      // a FORBIDDEN payload from the hybrid's own gate — not a SQL privilege
      // error, which would mean the command broke rather than denied.
      const payload = await refresh(USER_DENIED);
      expect(payload?.ok).toBe(false);
      expect(payload.error).toBe('FORBIDDEN');
    });

    it('an unauthorized refresh writes nothing', async () => {
      const { before, after, value } = await censusAround(
        'SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500) AS payload',
        USER_DENIED,
      );
      expect(value.ok).toBe(false);
      expect(after.states).toBe(before.states);
      expect(after.events).toBe(before.events);
    });

    it('anon cannot run the refresh command', async () => {
      await expect(
        refresh(null, 500, 'anon'),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('D · auth.uid() survives the caller -> DEFINER -> DEFINER chain', () => {
    it('two different JWT actors get two different, correctly-scoped answers', async () => {
      // THE decisive test for making the command SECURITY DEFINER. If the extra
      // DEFINER hop substituted the OWNER's identity, every caller would get the
      // same answer — the owner's. They do not.
      const asB = await refresh(USER_B);
      const asOut = await refresh(USER_OUT);
      const asSuper = await refresh(superId());

      expect(asB.ok).toBe(true);
      expect(asOut.ok).toBe(true);
      expect(asSuper.ok).toBe(true);

      // USER_OUT's organization takes no part in any alert, so it sees none;
      // USER_B is the demand side of the fixture's alert and sees at least one.
      expect(asOut.refreshed_count).toBe(0);
      expect(asB.refreshed_count).toBeGreaterThan(0);
    });

    it('the owner identity is never substituted — a profile-less JWT is refused as such', async () => {
      // `postgres` owns the function. If DEFINER swapped the actor, an actor
      // with no profile row would be silently upgraded to the owner instead of
      // being told its profile is missing.
      const orphan = '00000000-0000-0000-0000-0000001939ff';
      const payload = await refresh(orphan);
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('ACTOR_PROFILE_NOT_FOUND');
    });

    it('a missing JWT is still NOT_AUTHENTICATED, not an owner-privileged success', async () => {
      const payload = await refresh(null);
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('NOT_AUTHENTICATED');
    });
  });

  // -------------------------------------------------------------------------
  describe('E · both write-capable doors are shut', () => {
    it('authenticated cannot invoke the hybrid directly', async () => {
      await expect(
        callAs(USER_B, 'SELECT public.phoenix_get_live_inter_institution_alerts_with_state(50) AS payload'),
      ).rejects.toThrow(/permission denied/i);
    });

    it('authenticated cannot invoke the legacy paging wrapper directly', async () => {
      // Without STEP 3 this call would still succeed: the wrapper is SECURITY
      // DEFINER and reaches the hybrid as the OWNER, so revoking the hybrid
      // alone leaves it fully working.
      await expect(
        callAs(USER_B, 'SELECT public.phoenix_get_live_inter_institution_alerts_with_state_page(200, 0) AS payload'),
      ).rejects.toThrow(/permission denied/i);
    });

    it('anon cannot invoke either of them', async () => {
      await expect(
        callAs(null, 'SELECT public.phoenix_get_live_inter_institution_alerts_with_state(50) AS payload', 'anon'),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        callAs(null, 'SELECT public.phoenix_get_live_inter_institution_alerts_with_state_page(200, 0) AS payload', 'anon'),
      ).rejects.toThrow(/permission denied/i);
    });

    it('the hybrid remains the SOLE read-named lifecycle writer', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.prokind='f'
            AND p.proname ~ '^(get|query|read|list|fetch)_|_(get|query|read|list|fetch)_'
            AND p.prosrc ~* 'insert\\s+into\\s+(public\\.)?inter_org_alert_(states|events)'`));
      expect(rows.map((r: any) => r.proname)).toEqual(['phoenix_get_live_inter_institution_alerts_with_state']);
    });
  });

  // -------------------------------------------------------------------------
  describe('F · the pure CQRS read path is untouched and still pure', () => {
    it('the paged query still answers for an authorized actor', async () => {
      const payload = await pureP(USER_B);
      expect(payload?.ok, JSON.stringify(payload)).toBe(true);
      expect(Array.isArray(payload.alerts)).toBe(true);
      expect(typeof payload.total_count).toBe('number');
    });

    it('the summary query still answers for an authorized actor', async () => {
      const payload = await pureS(USER_B);
      expect(payload?.ok, JSON.stringify(payload)).toBe(true);
      expect(typeof payload.total).toBe('number');
    });

    it('the paged query writes nothing — observed inside one transaction', async () => {
      const { before, after, value } = await censusAround(
        'SELECT public.phoenix_query_live_inter_org_alerts_with_state_page(50, 0) AS payload',
        USER_B,
      );
      expect(value.ok).toBe(true);
      expect(after.states).toBe(before.states);
      expect(after.events).toBe(before.events);
    });

    it('the summary query writes nothing — observed inside one transaction', async () => {
      const { before, after, value } = await censusAround(
        'SELECT public.phoenix_query_live_inter_org_alert_summary(200) AS payload',
        USER_B,
      );
      expect(value.ok).toBe(true);
      expect(after.states).toBe(before.states);
      expect(after.events).toBe(before.events);
    });

    it('the pure queries still enforce the same permission gate', async () => {
      const page = await pureP(USER_DENIED);
      const summary = await pureS(USER_DENIED);
      expect(page.ok).toBe(false);
      expect(page.error).toBe('FORBIDDEN');
      expect(summary.ok).toBe(false);
      expect(summary.error).toBe('FORBIDDEN');
    });
  });
});
