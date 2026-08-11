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
const SA = '00000000-0000-0000-0000-000000178201';
const OFF = '00000000-0000-0000-0000-000000178202';

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
        ($7,$2,'WHC','WHC','active','central','h178-wh-c')
       ON CONFLICT(id) DO NOTHING`, [WH, ORG, WH_B, ORG_B, WH_A, AUTHORG, WH_C]);
    await c.query(
      `INSERT INTO auth.users(id,email) VALUES($1,'h178-sa@rig.local'),($2,'h178-off@rig.local')
       ON CONFLICT(id) DO NOTHING`, [SA, OFF]);
    await c.query(`UPDATE profiles SET role='super_admin',status='active',organization_id=$2 WHERE id=$1`, [SA, ORG]);
    await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id=$2 WHERE id=$1`, [OFF, ORG]);
    // Model Production's real ACL (see file header).
    await c.query(`REVOKE UPDATE, DELETE ON public.warehouses FROM authenticated`);
  });
}

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

    it('D. cross-organization creation remains denied', async () => {
      const r = await errOf(createOutlet(rig, OFF, WH_B, ORG_B, 'post-D'));
      expect(r).toMatch(/row-level security/i);
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
  });
});
