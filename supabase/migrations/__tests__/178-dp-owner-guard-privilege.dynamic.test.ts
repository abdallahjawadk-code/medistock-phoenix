/**
 * P0 HOTFIX 178 — live regression proof for the outlet-creation failure.
 *
 * The live symptom was: creating a distribution point from Institution
 * Management failed for EVERY authenticated caller, including a real
 * application super_admin, with `42501 permission denied for table warehouses`.
 *
 * Root cause: Migration 171's outlet guard ran SECURITY INVOKER while taking a
 * `SELECT ... FOR SHARE` row lock on public.warehouses. A locking read needs
 * UPDATE/DELETE privilege, not just SELECT. Production grants `authenticated`
 * SELECT only, so the guard aborted before the business rule ran.
 *
 * TWO THINGS MAKE THIS TEST REAL, and both are load-bearing:
 *
 *  1. `buildRig({ upTo: 177 })` for the pre-fix half. buildRig() globs EVERY
 *     NNN_*.sql on disk, so a bare buildRig() would silently apply 178 and the
 *     "pre-fix" assertion would prove nothing. (Observed exactly that while
 *     developing this fix.)
 *
 *  2. `REVOKE UPDATE, DELETE ON public.warehouses FROM authenticated`. The rig's
 *     bootstrap.sql does `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
 *     authenticated`, so in the rig `authenticated` holds UPDATE on every table
 *     and FOR SHARE succeeds. That divergence from Production's real ACL is
 *     precisely why CI never caught this P0. Modelling Production's ACL is what
 *     gives this suite its teeth.
 *
 * SECOND DEFECT (independent review of this hotfix): restoring outlet creation
 * exposed that nothing enforced the OWNERSHIP invariant — an outlet's
 * organization_id was never tied to the organization owning its warehouse. The
 * earlier "cross-organization creation remains denied" case did not prove it:
 * it used a caller lacking ports.create AND a foreign organization_id, so RLS
 * rejected the statement before the mismatch mattered. `dp_insert_perm`
 * constrains organization_id only and never inspects warehouse_id, so an
 * AUTHORIZED caller could attach an outlet to any organization's warehouse.
 * Cases D2-D5, G2-G4, K, H2 and H3 below are that missing proof.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const M178 = readFileSync(
  join(MIGRATIONS_DIR, '178_phoenix_distribution_point_owner_guard_privilege_fix.sql'),
  'utf8',
);

const ORG = '00000000-0000-0000-0000-000000178001';
const ORG_B = '00000000-0000-0000-0000-000000178002';
const AUTHORG = '00000000-0000-0000-0000-000000178003';
const WH = '00000000-0000-0000-0000-000000178101';
const WH_B = '00000000-0000-0000-0000-000000178102';
const WH_A = '00000000-0000-0000-0000-000000178103';
const WH_C = '00000000-0000-0000-0000-000000178104';
/** Dedicated to H2: test H COMMITS WH_C into the authority org, so the reverse
 *  interleave needs its own warehouse that is still owned by ORG. */
const WH_D = '00000000-0000-0000-0000-000000178105';
const SA = '00000000-0000-0000-0000-000000178201';
const OFF = '00000000-0000-0000-0000-000000178202';
/** institution_admin holding an explicit ports.create override — see seed(). */
const PC = '00000000-0000-0000-0000-000000178203';

async function seed(rig: any) {
  await rig.asAdmin(async (c: any) => {
    await c.query(
      `INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
        ($1,'H178 Inst','H178 Inst','h178-inst','care_institution','hospital'),
        ($2,'H178 B','H178 B','h178-inst-b','care_institution','hospital'),
        ($3,'H178 Auth','H178 Auth','h178-auth','pharmacy_department_authority',NULL)
       ON CONFLICT(id) DO NOTHING`, [ORG, ORG_B, AUTHORG]);
    await c.query(
      `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ($1,$2,'WH','WH','active','institution','h178-wh'),
        ($3,$4,'WHB','WHB','active','institution','h178-wh-b'),
        ($5,$6,'WHA','WHA','active','central','h178-wh-a'),
        ($7,$2,'WHC','WHC','active','central','h178-wh-c'),
        ($8,$2,'WHD','WHD','active','institution','h178-wh-d')
       ON CONFLICT(id) DO NOTHING`, [WH, ORG, WH_B, ORG_B, WH_A, AUTHORG, WH_C, WH_D]);
    await c.query(
      `INSERT INTO auth.users(id,email) VALUES($1,'h178-sa@rig.local'),($2,'h178-off@rig.local'),($3,'h178-pc@rig.local')
       ON CONFLICT(id) DO NOTHING`, [SA, OFF, PC]);
    await c.query(`UPDATE profiles SET role='super_admin',status='active',organization_id=$2 WHERE id=$1`, [SA, ORG]);
    await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id=$2 WHERE id=$1`, [OFF, ORG]);
    await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id=$2 WHERE id=$1`, [PC, ORG]);
    // A genuinely authorized NON-super actor. No non-super DEFAULT role carries
    // ports.create (role_permission_defaults grants it to super_admin only), so
    // the supported way to build one is an explicit per-profile override —
    // exactly what phoenix_profile_has_permission() consults first. This is an
    // existing mechanism, not a policy invented by this test.
    await c.query(
      `INSERT INTO profile_permission_overrides(profile_id,permission_key,allowed)
       VALUES($1,'ports.create',true) ON CONFLICT DO NOTHING`, [PC]);
    // Model Production's real ACL (see file header).
    await c.query(`REVOKE UPDATE, DELETE ON public.warehouses FROM authenticated`);
  });
}

/** Always-rolled-back txn on a dedicated connection: a failing statement can
 *  never leave a pooled connection in aborted state and poison a later case. */
async function inTxn(rig: any, fn: (c: any) => Promise<unknown>) {
  const c = await rig.pool.connect();
  try {
    await c.query('BEGIN');
    try { return await fn(c); } finally { try { await c.query('ROLLBACK'); } catch { /* noop */ } }
  } finally { c.release(); }
}

/** A fresh, VALID outlet on the institution warehouse, for reassignment cases. */
const seedOutlet = async (c: any) => (await c.query(
  `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
   VALUES(gen_random_uuid(),$1,$2,'rz','rz','pharmacy','active','non_emergency') RETURNING id`,
  [WH, ORG])).rows[0].id;

const createOutlet = (rig: any, uid: string | null, wh: string, org: string, label: string, role = 'authenticated') =>
  rig.asUser(uid, (c: any) => c.query(
    `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
     VALUES(gen_random_uuid(),$1,$2,$3,$3,'pharmacy','active','non_emergency')`, [wh, org, label]), { role });

async function errOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'SUCCEEDED'; } catch (e: any) { return `${e.code}:${e.message}`; }
}

run('178 · outlet creation privilege regression (dynamic)', () => {
  describe('PRE-FIX — the live P0, reproduced at the exact Production ceiling', () => {
    let rig: any;
    beforeAll(async () => { rig = await buildRig({ upTo: 177 }); await seed(rig); });
    afterAll(async () => { await rig?.end?.(); });

    it('a locking read on warehouses is denied while a plain SELECT is allowed', async () => {
      let plain = '', share = '';
      await rig.asUser(SA, async (c: any) => {
        plain = await errOf(c.query(`SELECT organization_id FROM public.warehouses WHERE id=$1`, [WH]));
        share = await errOf(c.query(`SELECT organization_id FROM public.warehouses WHERE id=$1 FOR SHARE`, [WH]));
      });
      expect(plain).toBe('SUCCEEDED');
      expect(share).toMatch(/^42501:/);
      expect(share).toContain('permission denied for table warehouses');
    });

    it('super_admin CANNOT create an outlet on a legitimate institution warehouse', async () => {
      const r = await errOf(createOutlet(rig, SA, WH, ORG, 'pre-A'));
      expect(r).toMatch(/^42501:/);
      expect(r).toContain('permission denied for table warehouses');
    });

    it('the ownership invariant does not exist at the Production ceiling', async () => {
      // The second defect, reproduced at 177. The ACL bug above masks it for
      // `authenticated`, so drive it with a writer the ACL bug cannot stop: the
      // mismatch is accepted and COMMITS, proving nothing in the 001->177 chain
      // — no FK, no CHECK, no trigger, no RLS policy — ties an outlet's
      // organization_id to the organization that owns its warehouse.
      const r = await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          await c.query(
            `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
             VALUES('00000000-0000-0000-0000-0000001780f1',$1,$2,'gap','gap','pharmacy','active','non_emergency')`,
            [WH_B, ORG]); // warehouse owned by ORG_B, outlet claimed by ORG
          const back = await c.query(`
            SELECT dp.organization_id dp_org, w.organization_id wh_org
              FROM distribution_points dp JOIN warehouses w ON w.id = dp.warehouse_id
             WHERE dp.id = '00000000-0000-0000-0000-0000001780f1'`);
          return back.rows[0];
        } finally { try { await c.query('ROLLBACK'); } catch { /* noop */ } }
      });
      expect(r.dp_org).toBe(ORG);
      expect(r.wh_org).toBe(ORG_B);
      expect(r.dp_org).not.toBe(r.wh_org); // accepted at 177 — this is the gap
    });

    it('the failure is the guard, not RLS/ports.create/payload/organization', async () => {
      // RLS would have allowed it: the caller really is super_admin.
      const role = await rig.asUser(SA, (c: any) =>
        c.query(`SELECT public.phoenix_my_role() r`).then((x: any) => x.rows[0].r));
      expect(role).toBe('super_admin');
      // The same payload is accepted when privileges are not the obstacle,
      // so FK/CHECK/organization/clinical_location_kind are all valid.
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        const r = await errOf(c.query(
          `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES(gen_random_uuid(),$1,$2,'ctl','ctl','pharmacy','active','non_emergency')`, [WH, ORG]));
        expect(r).toBe('SUCCEEDED');
        await c.query('ROLLBACK');
      });
    });
  });

  describe('POST-FIX — 178 applied on top of the same 177 rig', () => {
    let rig: any;
    beforeAll(async () => {
      rig = await buildRig({ upTo: 177 });
      await seed(rig);
      await rig.asAdmin((c: any) => c.query(M178)); // preflight + verify must pass
    });
    afterAll(async () => { await rig?.end?.(); });

    it('the guard is SECURITY DEFINER with a pinned search_path, lock intact', async () => {
      const r = await rig.asAdmin((c: any) => c.query(`
        SELECT p.prosecdef, p.proconfig::text cfg, p.prosrc LIKE '%FOR SHARE%' AS keeps_lock
          FROM pg_proc p
         WHERE p.oid='public._phoenix_distribution_points_owner_kind_guard_v1()'::regprocedure`));
      expect(r.rows[0].prosecdef).toBe(true);
      expect(r.rows[0].cfg).toContain('search_path=public, pg_temp');
      expect(r.rows[0].keeps_lock).toBe(true);
    });

    it('A. super_admin CAN create an outlet on a legitimate institution warehouse', async () => {
      expect(await errOf(createOutlet(rig, SA, WH, ORG, 'post-A'))).toBe('SUCCEEDED');
    });

    it('C. an institution user without ports.create remains denied', async () => {
      const r = await errOf(createOutlet(rig, OFF, WH_C, ORG, 'post-C'));
      expect(r).toMatch(/row-level security/i);
    });

    it('D. cross-organization creation remains denied (ordinary RLS)', async () => {
      // NOTE: this proves ORDINARY cross-org RLS and nothing more — the caller
      // lacks ports.create AND the organization_id is foreign, so RLS rejects
      // before any ownership question is reached. The ownership invariant is
      // proved by the D2/D3 cases below, which keep organization_id AUTHORIZED
      // and make only the WAREHOUSE foreign.
      const r = await errOf(createOutlet(rig, OFF, WH_B, ORG_B, 'post-D'));
      expect(r).toMatch(/row-level security/i);
    });

    it('D2. authorized super_admin CANNOT attach an outlet to a FOREIGN-org warehouse', async () => {
      // The case the first cut of this hotfix missed entirely.
      //   organization_id = ORG   (the caller is fully authorized for it)
      //   warehouse_id    = WH_B  (owned by ORG_B)
      // RLS passes — dp_insert_perm only ever constrains organization_id and
      // never looks at warehouse_id — so only a real ownership invariant can
      // stop this. Before the fix it SUCCEEDED and committed a row whose
      // organization_id disagreed with its warehouse's owner.
      const r = await errOf(createOutlet(rig, SA, WH_B, ORG, 'post-D2'));
      expect(r).toMatch(/^23503:/);
      expect(r).toContain('distribution_points_wh_org_fk');
    });

    it('D3. an authorized NON-super actor is bound by the same invariant', async () => {
      // Same shape as D2 but through the least-privileged caller that is still
      // genuinely allowed to create outlets, so the rule cannot be mistaken for
      // a super_admin-only special case.
      const ok = await errOf(createOutlet(rig, PC, WH, ORG, 'post-D3-own'));
      expect(ok).toBe('SUCCEEDED');
      const bad = await errOf(createOutlet(rig, PC, WH_B, ORG, 'post-D3-foreign'));
      expect(bad).toMatch(/^23503:/);
      expect(bad).toContain('distribution_points_wh_org_fk');
    });

    it('D4. the invariant binds service_role and the superuser too, not just RLS callers', async () => {
      // RLS never runs for these principals, so a policy-level rule would miss
      // them entirely. A structural constraint does not.
      const svc = await errOf(createOutlet(rig, SA, WH_B, ORG, 'post-D4', 'service_role'));
      expect(svc).toMatch(/^23503:/);
      const su = await errOf(inTxn(rig, (c: any) => c.query(
        `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES(gen_random_uuid(),$1,$2,'post-D4b','post-D4b','pharmacy','active','non_emergency')`, [WH_B, ORG])));
      expect(su).toMatch(/^23503:/);
    });

    it('D5. a legacy outlet with NO warehouse is unaffected (MATCH SIMPLE)', async () => {
      // warehouse_id is nullable and such rows predate this hotfix. With no
      // warehouse there is no owner to match, so the FK must not fire.
      const r = await errOf(inTxn(rig, (c: any) => c.query(
        `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status)
         VALUES(gen_random_uuid(),NULL,$1,'post-D5','post-D5','pharmacy','active')`, [ORG])));
      expect(r).toBe('SUCCEEDED');
    });

    it('E. anon remains denied', async () => {
      const r = await errOf(createOutlet(rig, null, WH, ORG, 'post-E', 'anon'));
      expect(r).toMatch(/^42501:/);
      expect(r).toContain('distribution_points');
    });

    it('F. a pharmacy_department_authority warehouse still rejects outlets with 171’s error', async () => {
      const r = await errOf(createOutlet(rig, SA, WH_A, AUTHORG, 'post-F'));
      expect(r).toMatch(/^23514:/);
      expect(r).toContain('pharmacy_department_authority_warehouse_no_outlets');
    });

    it('G. reassigning an existing outlet onto an authority warehouse remains denied', async () => {
      let res = '';
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        const ins = await c.query(
          `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES(gen_random_uuid(),$1,$2,'post-G','post-G','pharmacy','active','non_emergency') RETURNING id`, [WH, ORG]);
        res = await errOf(c.query(
          `UPDATE distribution_points SET warehouse_id=$1, organization_id=$2 WHERE id=$3`,
          [WH_A, AUTHORG, ins.rows[0].id]));
        await c.query('ROLLBACK');
      });
      expect(res).toMatch(/^23514:/);
      expect(res).toContain('pharmacy_department_authority_warehouse_no_outlets');
    });

    it('G2. reassigning an outlet onto a FOREIGN-org warehouse is rejected', async () => {
      const r = await errOf(inTxn(rig, async (c: any) =>
        c.query(`UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [WH_B, await seedOutlet(c)])));
      expect(r).toMatch(/^23503:/);
      expect(r).toContain('distribution_points_wh_org_fk');
    });

    it('G3. moving an outlet to another organization WITHOUT moving its warehouse is rejected', async () => {
      // 171's trigger is BEFORE INSERT OR UPDATE **OF warehouse_id**, so this
      // statement never fires it — a trigger-based ownership test could not see
      // this path at all without recreating 171's trigger. The FK does.
      const r = await errOf(inTxn(rig, async (c: any) =>
        c.query(`UPDATE distribution_points SET organization_id=$1 WHERE id=$2`, [ORG_B, await seedOutlet(c)])));
      expect(r).toMatch(/^23503:/);
      expect(r).toContain('distribution_points_wh_org_fk');
    });

    it('G4. moving an outlet to a CONSISTENT foreign pair is still allowed', async () => {
      // The invariant is about agreement between the two columns, not about
      // immobility. Moving both to (WH_B, ORG_B) keeps the outlet owned by the
      // organization that owns its warehouse, so it must NOT be blocked here —
      // whether a given caller may do it is RLS's question, not the FK's.
      const r = await errOf(inTxn(rig, async (c: any) =>
        c.query(`UPDATE distribution_points SET warehouse_id=$1, organization_id=$2 WHERE id=$3`,
          [WH_B, ORG_B, await seedOutlet(c)])));
      expect(r).toBe('SUCCEEDED');
    });

    it('K. a warehouse that still has outlets cannot be moved to another organization', async () => {
      // The referenced side of the same invariant. Fail-closed: detaching or
      // moving the outlets is a deliberate operator action, and this mirrors the
      // rule 171 already applies to authority reassignment.
      const r = await errOf(inTxn(rig, async (c: any) => {
        await seedOutlet(c);
        return c.query(`UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [ORG_B, WH]);
      }));
      expect(r).toMatch(/^23503:/);
      expect(r).toContain('distribution_points_wh_org_fk');
    });

    it('I/J. authenticated gains NO table privilege and cannot execute the guard directly', async () => {
      const r = await rig.asAdmin((c: any) => c.query(`
        SELECT has_table_privilege('authenticated','public.warehouses','UPDATE') wh_update,
               has_table_privilege('authenticated','public.warehouses','DELETE') wh_delete,
               has_table_privilege('authenticated','public.warehouses','SELECT') wh_select,
               has_function_privilege('authenticated','public._phoenix_distribution_points_owner_kind_guard_v1()','EXECUTE') guard_exec,
               has_function_privilege('anon','public._phoenix_distribution_points_owner_kind_guard_v1()','EXECUTE') guard_anon`));
      expect(r.rows[0]).toEqual({
        wh_update: false, wh_delete: false, wh_select: true,
        guard_exec: false, guard_anon: false,
      });
    });

    it('H. 171’s two-sided serialization still blocks the interleaved race', async () => {
      const a = await rig.pool.connect();
      const b = await rig.pool.connect();
      try {
        await a.query('BEGIN');
        // TX-A takes FOR UPDATE on the warehouse row via 171's warehouse guard.
        await a.query(`UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [AUTHORG, WH_C]);
        const attach = b.query(
          `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES(gen_random_uuid(),$1,$2,'race','race','pharmacy','active','non_emergency')`, [WH_C, ORG]);
        const raced = await Promise.race([
          attach.then(() => 'resolved').catch(() => 'rejected'),
          new Promise<string>((r) => setTimeout(() => r('pending'), 700)),
        ]);
        expect(raced).toBe('pending'); // must block on TX-A's lock
        await a.query('COMMIT');
        // Once TX-A commits, the outlet attach re-reads the LATEST owner and
        // is correctly rejected — the invalid joint state can never commit.
        const after = await errOf(attach);
        expect(after).toMatch(/^23514:/);
        expect(after).toContain('pharmacy_department_authority_warehouse_no_outlets');
      } finally {
        try { await a.query('ROLLBACK'); } catch { /* already committed */ }
        a.release(); b.release();
      }
    });

    it('H2. the ownership invariant survives the REVERSE interleave', async () => {
      // The direction a trigger equality test cannot survive, measured on this
      // rig while choosing the enforcement: TX-A attaches an outlet to a
      // warehouse it legitimately owns; TX-B then reassigns that warehouse to
      // another organization. A BEFORE-trigger check on the outlet has already
      // passed and nothing re-examines the row once its warehouse moves, so the
      // trigger variant let TX-B COMMIT and left a mismatched row behind.
      // Under the FK, TX-B blocks on the RI lock and is then rejected outright.
      const a = await rig.pool.connect();
      const b = await rig.pool.connect();
      try {
        await a.query('BEGIN');
        await a.query(
          `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES(gen_random_uuid(),$1,$2,'race2','race2','pharmacy','active','non_emergency')`, [WH_D, ORG]);
        const move = b.query(`UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [ORG_B, WH_D]);
        const raced = await Promise.race([
          move.then(() => 'resolved').catch(() => 'rejected'),
          new Promise<string>((r) => setTimeout(() => r('pending'), 700)),
        ]);
        expect(raced).toBe('pending'); // must block on the uncommitted outlet
        await a.query('COMMIT');
        const after = await errOf(move);
        expect(after).toMatch(/^23503:/);
        expect(after).toContain('distribution_points_wh_org_fk');
      } finally {
        try { await a.query('ROLLBACK'); } catch { /* already committed */ }
        try { await b.query('ROLLBACK'); } catch { /* noop */ }
        a.release(); b.release();
      }
    });

    it('H3. TERMINAL INVARIANT — no interleave left a committed mismatch', async () => {
      // Whatever the races above did, the database must not hold a single
      // distribution_point whose organization_id disagrees with the committed
      // owner of its warehouse.
      const r = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int n
          FROM distribution_points dp
          JOIN warehouses w ON w.id = dp.warehouse_id
         WHERE dp.organization_id IS DISTINCT FROM w.organization_id`));
      expect(r.rows[0].n).toBe(0);
    });
  });
});
