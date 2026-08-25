/**
 * DEMO-PURGE-AUTH-BOUNDARY-200 — DYNAMIC proof against a real disposable
 * Postgres, with the PRODUCTION auth-schema ownership boundary MODELLED
 * EXPLICITLY rather than inherited from the rig.
 *
 * WHY THIS TEST HAS TO FIGHT ITS OWN HARNESS
 * tools/pg-rig/bootstrap.sql creates schema `auth` itself, as the rig's own
 * connecting superuser. That user therefore OWNS auth, so migration 141's
 *     GRANT USAGE ON SCHEMA auth TO phoenix_demo_purger;
 * genuinely succeeds under the rig — while in a real Supabase database `auth`
 * is owned by supabase_admin, the applying role (postgres) holds USAGE WITHOUT
 * grant option, and PostgreSQL answers that GRANT with a WARNING rather than an
 * error. Production therefore ends up with
 *     has_schema_privilege('phoenix_demo_purger','auth','USAGE') = FALSE
 * while every pg-rig-based test sees TRUE. UAT-BUG-001 was invisible to the
 * entire existing suite for exactly that reason.
 *
 * So this file REVOKES that privilege before asserting anything. The revoke is
 * the point: it reproduces the confirmed Production condition on a harness that
 * would otherwise mask it.
 *
 * NON-VACUOUS BY CONSTRUCTION
 * The first block builds 001->199 (pre-fix) under the same revoke and requires
 * the purge to FAIL 42501. If a future change made the purge stop depending on
 * auth traversal for some unrelated reason, that block would fail and this test
 * would stop silently passing for the wrong reason.
 *
 * THE CENTRAL ASSERTION
 * After M200 the purge must work with phoenix_demo_purger holding NO auth
 * USAGE. This test deliberately NEVER requires that grant to become true —
 * requiring it would re-encode the very defect M200 removes.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no database is available.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const DATASET_KEY = 'PHOENIX_DEMO_V1';

const PURGE_FN = 'public.phoenix_demo_purge(text, boolean)';
const EXEC_FN = 'public._phoenix_200_demo_purge_execute(text, boolean)';

/** Reproduce Production: the purge owner cannot traverse schema auth. */
async function modelProductionAuthBoundary(rig: any) {
  await rig.asAdmin(async (c: any) => {
    await c.query('REVOKE USAGE ON SCHEMA auth FROM phoenix_demo_purger');
    const r = await c.query(
      `SELECT has_schema_privilege('phoenix_demo_purger','auth','USAGE') AS u`);
    if (r.rows[0].u !== false) {
      throw new Error('failed to model the Production auth boundary: purger still holds auth USAGE');
    }
  });
}

/** A super_admin the rig already guarantees exists (seeded right after 001). */
async function superAdminId(rig: any): Promise<string> {
  let id = '';
  await rig.asAdmin(async (c: any) => {
    const r = await c.query(
      `SELECT id FROM profiles WHERE role='super_admin' AND status='active' ORDER BY created_at LIMIT 1`);
    id = r.rows[0].id;
  });
  return id;
}

/**
 * Register one organization plus one owned child row through the SAME manifest
 * mechanism the purge itself reads, so the purge has something real to do.
 * Mirrors the focused approach 160's dynamic test already established rather
 * than re-driving the whole seeder.
 */
async function seedMinimalDataset(rig: any, sa: string) {
  const orgId = randomUUID();
  const supplierId = randomUUID();
  await rig.asAdmin(async (c: any) => {
    await c.query(
      `INSERT INTO organizations (id,name,name_ar,code,status,organization_kind,institution_class)
       VALUES ($1,'M200 Demo Org','منظمة اختبار 200','M200-DEMO','active','care_institution','hospital')`,
      [orgId]);
    await c.query(
      `INSERT INTO procurement_suppliers (id,organization_id,name)
       VALUES ($1,$2,'M200 Demo Supplier')`, [supplierId, orgId]);
  });
  await rig.asUser(sa, async (c: any) => {
    await c.query(`SELECT public.phoenix_demo_register($1,$2,$3,$4)`,
      [DATASET_KEY, 'organizations', orgId, 'm200:org']);
    await c.query(`SELECT public.phoenix_demo_register($1,$2,$3,$4)`,
      [DATASET_KEY, 'procurement_suppliers', supplierId, 'm200:supplier']);
  }, { commit: true });
  return { orgId, supplierId };
}

const purgeAs = (rig: any, actor: string, dry: boolean) =>
  rig.asUser(actor, (c: any) =>
    c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, [DATASET_KEY, dry])
      .then((r: any) => r.rows), { commit: true });

/* ────────────────────────────────────────────────────────────────────────── */

run('200 demo-purge auth boundary — the defect is real (negative control, 001→199)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 199 });
    await modelProductionAuthBoundary(rig);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('pre-M200, the purge cannot even reach its own authorization check', async () => {
    const sa = await superAdminId(rig);
    await expect(purgeAs(rig, sa, true)).rejects.toThrow(/permission denied for schema auth/i);
  });
});

run('200 demo-purge auth boundary — dynamic (001→200)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let sa = '';

  beforeAll(async () => {
    rig = await buildRig({ upTo: 200 });
    await modelProductionAuthBoundary(rig);
    sa = await superAdminId(rig);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  describe('the structural contract', () => {
    it('splits authorization (wrapper, owned by postgres) from execution (executor, owned by phoenix_demo_purger)', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT p.proname,
                 pg_get_userbyid(p.proowner) AS owner,
                 p.prosecdef,
                 array_to_string(p.proconfig, ', ') AS cfg
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public'
             AND p.proname IN ('phoenix_demo_purge','_phoenix_200_demo_purge_execute')
           ORDER BY p.proname`);
        const exec = r.rows.find((x: any) => x.proname === '_phoenix_200_demo_purge_execute');
        const wrap = r.rows.find((x: any) => x.proname === 'phoenix_demo_purge');

        expect(wrap.owner).toBe('postgres');
        expect(exec.owner).toBe('phoenix_demo_purger');
        expect(wrap.prosecdef).toBe(true);
        expect(exec.prosecdef).toBe(true);
        // M198's convergence must hold for anything added after it.
        expect(wrap.cfg).toBe('search_path=public, pg_temp');
        expect(exec.cfg).toBe('search_path=public, pg_temp');
      });
    });

    it('keeps the public signature and return shape callers already depend on', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_function_identity_arguments($1::regprocedure) AS args,
                  pg_get_function_result($1::regprocedure) AS result`, [PURGE_FN]);
        expect(r.rows[0].args).toBe('p_dataset_key text, p_dry_run boolean');
        expect(r.rows[0].result)
          .toBe('TABLE(table_name text, affected bigint, executed boolean)');
      });
    });

    it('the executor contains no reference to schema auth at all', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT pg_get_functiondef($1::regprocedure) AS def`, [EXEC_FN]);
        expect(r.rows[0].def).not.toMatch(/auth\./);
      });
    });

    it('the wrapper still performs every caller check, with its original SQLSTATEs', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT pg_get_functiondef($1::regprocedure) AS def`, [PURGE_FN]);
        const def: string = r.rows[0].def;
        expect(def).toMatch(/auth\.uid\(\)/);
        expect(def).toMatch(/phoenix_my_role\(\)/);
        for (const code of ['28000', '42501', '23514', '22023']) {
          expect(def).toContain(`'${code}'`);
        }
      });
    });
  });

  describe('the executor is not client-callable (§4 — ACL, never obscurity)', () => {
    it('grants no EXECUTE to PUBLIC, anon, authenticated or service_role', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT has_function_privilege('anon',          $1, 'EXECUTE') AS anon,
                 has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                 has_function_privilege('service_role',  $1, 'EXECUTE') AS service_role,
                 EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                          WHERE p.oid = $1::regprocedure AND a.grantee = 0) AS public_acl`,
          [EXEC_FN]);
        expect(r.rows[0]).toEqual({
          anon: false, authenticated: false, service_role: false, public_acl: false,
        });
      });
    });

    it('refuses a direct call from an authenticated super_admin', async () => {
      await expect(
        rig.asUser(sa, (c: any) =>
          c.query(`SELECT * FROM public._phoenix_200_demo_purge_execute($1,$2)`, [DATASET_KEY, true])),
      ).rejects.toThrow(/permission denied for function/i);
    });

    it('leaves no client-facing role a member of phoenix_demo_purger', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT pg_has_role('anon','phoenix_demo_purger','MEMBER')          AS anon,
                 pg_has_role('authenticated','phoenix_demo_purger','MEMBER') AS authenticated,
                 pg_has_role('service_role','phoenix_demo_purger','MEMBER')  AS service_role`);
        expect(r.rows[0]).toEqual({ anon: false, authenticated: false, service_role: false });
      });
    });

    it('keeps the public entry point reachable by authenticated and not by anon', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                  has_function_privilege('anon',          $1, 'EXECUTE') AS anon`, [PURGE_FN]);
        expect(r.rows[0]).toEqual({ authenticated: true, anon: false });
      });
    });
  });

  describe('caller authorization survives the split', () => {
    it('refuses an unauthenticated caller (28000)', async () => {
      await expect(purgeAs(rig, '', true)).rejects.toThrow(/not_authenticated/);
    });

    it('refuses a non-super_admin (42501)', async () => {
      const other = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(
          `INSERT INTO auth.users (id,email) VALUES ($1,$2)`, [other, `m200-${other}@rig.local`]);
        await c.query(
          `UPDATE profiles SET role='institution_admin', status='active' WHERE id=$1`, [other]);
      });
      await expect(purgeAs(rig, other, true)).rejects.toThrow(/forbidden_demo_purge/);
    });

    it('refuses an unknown dataset key (22023) and an empty one (23514)', async () => {
      await expect(
        rig.asUser(sa, (c: any) =>
          c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, ['NOT_THE_DATASET', true])),
      ).rejects.toThrow(/invalid_demo_dataset_key/);
      await expect(
        rig.asUser(sa, (c: any) =>
          c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, ['   ', true])),
      ).rejects.toThrow(/dataset_key_required/);
    });
  });

  describe('the purge itself, with phoenix_demo_purger holding NO auth USAGE', () => {
    it('completes a full dry-run -> purge -> verify-zero lifecycle', async () => {
      // The condition this whole migration exists for. Asserted immediately
      // before the purge so the result cannot be attributed to anything else.
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT has_schema_privilege('phoenix_demo_purger','auth','USAGE') AS u`);
        expect(r.rows[0].u).toBe(false);
      });

      const { orgId, supplierId } = await seedMinimalDataset(rig, sa);

      const dry = await purgeAs(rig, sa, true);
      expect(dry.length).toBeGreaterThan(0);
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT count(*)::int n FROM organizations WHERE id=$1`, [orgId]);
        expect(r.rows[0].n).toBe(1);          // dry run deleted nothing
      });

      const real = await purgeAs(rig, sa, false);
      expect(real.some((r: any) => r.table_name === 'organizations' && r.executed === true)).toBe(true);

      await rig.asAdmin(async (c: any) => {
        const org = await c.query(`SELECT count(*)::int n FROM organizations WHERE id=$1`, [orgId]);
        const sup = await c.query(`SELECT count(*)::int n FROM procurement_suppliers WHERE id=$1`, [supplierId]);
        const man = await c.query(
          `SELECT count(*)::int n FROM phoenix_demo_manifest
            WHERE dataset_key=$1 AND table_name IN ('organizations','procurement_suppliers')`, [DATASET_KEY]);
        expect(org.rows[0].n).toBe(0);
        expect(sup.rows[0].n).toBe(0);
        expect(man.rows[0].n).toBe(0);
      });
    }, 120000);

    it('deletes an IMMUTABLE-family demo row, and still refuses the identical genuine row', async () => {
      const orgId = randomUUID();
      const whId = randomUUID();
      const supplierId = randomUUID();
      const demoOrder = randomUUID();
      const genuineOrder = randomUUID();

      await rig.asAdmin(async (c: any) => {
        await c.query(
          `INSERT INTO organizations (id,name,name_ar,code,status,organization_kind,institution_class)
           VALUES ($1,'M200 Immutable Org','منظمة 200','M200-IMM','active','care_institution','hospital')`,
          [orgId]);
        await c.query(
          `INSERT INTO warehouses (id,organization_id,name,name_ar,status)
           VALUES ($1,$2,'M200 WH','مخزن 200','active')`, [whId, orgId]);
        await c.query(
          `INSERT INTO procurement_suppliers (id,organization_id,name)
           VALUES ($1,$2,'M200 Supplier')`, [supplierId, orgId]);
        for (const [id, num] of [[demoOrder, 'M200-DEMO-1'], [genuineOrder, 'M200-GENUINE-1']]) {
          await c.query(
            `INSERT INTO procurement_orders (id,organization_id,warehouse_id,supplier_id,order_number,created_by)
             VALUES ($1,$2,$3,$4,$5,$6)`, [id, orgId, whId, supplierId, num, sa]);
        }
      });

      await rig.asUser(sa, async (c: any) => {
        for (const [table, id, key] of [
          ['organizations', orgId, 'm200:imm:org'],
          ['warehouses', whId, 'm200:imm:wh'],
          ['procurement_suppliers', supplierId, 'm200:imm:sup'],
          ['procurement_orders', demoOrder, 'm200:imm:order'],
        ] as const) {
          await c.query(`SELECT public.phoenix_demo_register($1,$2,$3,$4)`, [DATASET_KEY, table, id, key]);
        }
        // 141/142: registration alone never exempts an immutable-family row.
        await c.query(`SELECT public.phoenix_demo_mark_row($1,$2,$3)`,
          [DATASET_KEY, 'procurement_orders', demoOrder]);
      }, { commit: true });

      await purgeAs(rig, sa, false);

      await rig.asAdmin(async (c: any) => {
        const demo = await c.query(`SELECT count(*)::int n FROM procurement_orders WHERE id=$1`, [demoOrder]);
        const genuine = await c.query(`SELECT count(*)::int n FROM procurement_orders WHERE id=$1`, [genuineOrder]);
        // The demo-marked immutable row is gone...
        expect(demo.rows[0].n).toBe(0);
        // ...and the genuine one, never registered and never marked, survives:
        // the purge only ever touches ids the manifest names.
        expect(genuine.rows[0].n).toBe(1);
      });
    }, 120000);

    it('never touches a row the dataset does not own', async () => {
      const strangerOrg = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(
          `INSERT INTO organizations (id,name,name_ar,code,status,organization_kind,institution_class)
           VALUES ($1,'M200 Stranger','غريب 200','M200-STRANGER','active','care_institution','hospital')`,
          [strangerOrg]);
      });

      const { orgId } = await seedMinimalDataset(rig, sa);
      await purgeAs(rig, sa, false);

      await rig.asAdmin(async (c: any) => {
        const owned = await c.query(`SELECT count(*)::int n FROM organizations WHERE id=$1`, [orgId]);
        const stranger = await c.query(`SELECT count(*)::int n FROM organizations WHERE id=$1`, [strangerOrg]);
        expect(owned.rows[0].n).toBe(0);
        expect(stranger.rows[0].n).toBe(1);
      });
    }, 120000);
  });
});
