/**
 * PHOENIX-DEMO-DATASET-MANIFEST-140 — DYNAMIC operational acceptance against
 * a real disposable Postgres with 001->140 applied in order.
 *
 * 140 is the reversibility contract for the labelled demo dataset. The whole
 * point is that a demo purge can NEVER delete a real row, so these are
 * adversarial proofs, not happy-path ones:
 *   * a real row that is NOT in the manifest survives a purge --execute
 *     even when it sits in the same table, same org, as demo rows;
 *   * a real row whose name matches the demo label survives too (purge is a
 *     set-intersection on the manifest, never a pattern match);
 *   * dry-run is the DEFAULT — an omitted argument reports and deletes
 *     nothing;
 *   * dry-run counts exactly match what execute then deletes;
 *   * registration is idempotent, so a second seed cannot double-count;
 *   * profiles/permission config are not purgeable at all, so the real owner
 *     account and the last-super-admin guard survive by construction;
 *   * a non-super_admin is denied register, summary and purge;
 *   * anon holds no grant on the manifest or any of its functions.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const DATASET = 'PHOENIX_DEMO_V1_TEST';
const ORG_REAL = '00000000-0000-0000-0000-000000140001';
const SA = '00000000-0000-0000-0000-000000140401';   // super_admin
const IA = '00000000-0000-0000-0000-000000140402';   // institution_admin (denied)

run('140 demo dataset manifest — purge isolation (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const register = (c: any, table: string, rowId: string, seedKey?: string) =>
    c.query(`SELECT public.phoenix_demo_register($1,$2,$3,$4) AS id`,
      [DATASET, table, rowId, seedKey ?? null]).then((r: any) => r.rows[0].id);

  const purge = (c: any, dryRun?: boolean) =>
    (dryRun === undefined
      // Deliberately omit the argument to prove the DEFAULT is dry-run.
      ? c.query(`SELECT * FROM public.phoenix_demo_purge($1)`, [DATASET])
      : c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, [DATASET, dryRun])
    ).then((r: any) => r.rows);

  const orgExists = async (id: string) => {
    let n = -1;
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM organizations WHERE id=$1`, [id]);
      n = r.rows[0].n;
    });
    return n === 1;
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 140 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_REAL}','Real Org','مؤسسة حقيقية','p140-real') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${SA}','p140-sa@rig'),('${IA}','p140-ia@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='super_admin',status='active',organization_id='${ORG_REAL}' WHERE id='${SA}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_REAL}' WHERE id='${IA}';`);
    });
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('SAFETY: a real row NOT in the manifest survives purge --execute, even beside demo rows in the same table', async () => {
    const demoOrg = randomUUID();
    const realOrg = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ($1,'Demo Org','مؤسسة تجريبية',$2), ($3,'Untouchable','مؤسسة حقيقية ٢',$4)`,
        [demoOrg, `p140-d-${Date.now()}`, realOrg, `p140-r-${Date.now()}`]);
    });
    await rig.asUser(SA, async (c: any) => {
      await register(c, 'organizations', demoOrg, 'org:demo');
    }, { commit: true });

    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });

    expect(await orgExists(demoOrg)).toBe(false);   // owned -> deleted
    expect(await orgExists(realOrg)).toBe(true);    // unowned -> untouched
    expect(await orgExists(ORG_REAL)).toBe(true);   // pre-existing -> untouched
  });

  it('SAFETY: a real row whose NAME matches the demo label still survives — purge is set-intersection, never a pattern match', async () => {
    const lookalike = randomUUID();
    await rig.asAdmin(async (c: any) => {
      // Named exactly like the demo data, but never registered.
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'PHOENIX_DEMO_V1','تجريبي',$2)`,
        [lookalike, `p140-look-${Date.now()}`]);
    });
    const demoOrg = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'Demo','تجريبي',$2)`,
        [demoOrg, `p140-d2-${Date.now()}`]);
    });
    await rig.asUser(SA, async (c: any) => { await register(c, 'organizations', demoOrg); }, { commit: true });
    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });

    expect(await orgExists(demoOrg)).toBe(false);
    expect(await orgExists(lookalike)).toBe(true);
  });

  it('DEFAULT: calling purge with the argument OMITTED is a dry run — it reports and deletes nothing', async () => {
    const demoOrg = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'DryRun','تجريبي',$2)`,
        [demoOrg, `p140-dry-${Date.now()}`]);
    });
    await rig.asUser(SA, async (c: any) => { await register(c, 'organizations', demoOrg); }, { commit: true });

    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c); }, { commit: true });

    const orgRow = rows.find(r => r.table_name === 'organizations');
    expect(orgRow).toBeDefined();
    expect(orgRow.executed).toBe(false);
    expect(Number(orgRow.affected)).toBeGreaterThanOrEqual(1);
    expect(await orgExists(demoOrg)).toBe(true);   // still there

    // clean up for later tests
    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });
  });

  it('PARITY: dry-run counts exactly match what execute then deletes', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await rig.asAdmin(async (c: any) => {
      for (const [i, id] of ids.entries()) {
        await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,$2,'تجريبي',$3)`,
          [id, `Parity ${i}`, `p140-p${i}-${Date.now()}`]);
      }
    });
    await rig.asUser(SA, async (c: any) => {
      for (const id of ids) await register(c, 'organizations', id);
    }, { commit: true });

    let dry: any[] = []; let exec: any[] = [];
    await rig.asUser(SA, async (c: any) => { dry = await purge(c, true); }, { commit: true });
    await rig.asUser(SA, async (c: any) => { exec = await purge(c, false); }, { commit: true });

    const dryCount = Number(dry.find(r => r.table_name === 'organizations').affected);
    const execCount = Number(exec.find(r => r.table_name === 'organizations').affected);
    expect(dryCount).toBe(3);
    expect(execCount).toBe(dryCount);
    expect(exec.find(r => r.table_name === 'organizations').executed).toBe(true);
  });

  it('IDEMPOTENT: registering the same row twice does not double-count', async () => {
    const demoOrg = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'Idem','تجريبي',$2)`,
        [demoOrg, `p140-i-${Date.now()}`]);
    });
    await rig.asUser(SA, async (c: any) => {
      await register(c, 'organizations', demoOrg, 'k1');
      await register(c, 'organizations', demoOrg, 'k1');
      await register(c, 'organizations', demoOrg, 'k1');
    }, { commit: true });

    let summary: any[] = [];
    await rig.asUser(SA, async (c: any) => {
      summary = await c.query(`SELECT * FROM public.phoenix_demo_manifest_summary($1)`, [DATASET])
        .then((r: any) => r.rows);
    });
    expect(Number(summary.find(r => r.table_name === 'organizations').row_count)).toBe(1);

    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });
  });

  it('PROTECTED: profiles and permission config are not purgeable at all, so the owner account and last-super-admin guard survive by construction', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_demo_purgeable_tables() AS t`);
      const tables: string[] = r.rows[0].t;
      expect(tables).not.toContain('profiles');
      expect(tables).not.toContain('permission_keys');
      expect(tables).not.toContain('role_permission_defaults');
      expect(tables).not.toContain('supabase_migrations');
    });

    // Even if a profile is (wrongly) registered, purge refuses to delete it
    // and reports it as not-purgeable rather than silently skipping.
    await rig.asUser(SA, async (c: any) => { await register(c, 'profiles', IA); }, { commit: true });
    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c, false); }, { commit: true });
    const profileRow = rows.find(r => r.table_name === 'profiles');
    expect(profileRow).toBeDefined();
    expect(profileRow.executed).toBe(false);

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM profiles WHERE id=$1`, [IA]);
      expect(r.rows[0].n).toBe(1);   // profile untouched
      // The manifest entry for a non-purgeable table is retained, not silently dropped.
      const m = await c.query(
        `SELECT count(*)::int AS n FROM phoenix_demo_manifest WHERE dataset_key=$1 AND table_name='profiles'`,
        [DATASET]);
      expect(m.rows[0].n).toBe(1);
      await c.query(`DELETE FROM phoenix_demo_manifest WHERE dataset_key=$1 AND table_name='profiles'`, [DATASET]);
    });
  });

  it('RBAC: a non-super_admin is denied register, summary and purge', async () => {
    await rig.asUser(IA, async (c: any) => {
      await expect(register(c, 'organizations', randomUUID())).rejects.toThrow(/forbidden_demo_manifest_write/);
    });
    await rig.asUser(IA, async (c: any) => {
      await expect(
        c.query(`SELECT * FROM public.phoenix_demo_manifest_summary($1)`, [DATASET]),
      ).rejects.toThrow(/forbidden_demo_manifest_read/);
    });
    await rig.asUser(IA, async (c: any) => {
      await expect(purge(c, true)).rejects.toThrow(/forbidden_demo_purge/);
    });
  });

  it('GRANTS: anon holds no grant on the manifest table or any demo function', async () => {
    await rig.asAdmin(async (c: any) => {
      const t = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.role_table_grants
          WHERE table_schema='public' AND table_name='phoenix_demo_manifest' AND grantee='anon'`);
      expect(t.rows[0].n).toBe(0);
      const f = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.role_routine_grants
          WHERE routine_schema='public' AND grantee='anon'
            AND routine_name IN ('phoenix_demo_register','phoenix_demo_purge',
                                 'phoenix_demo_manifest_summary','phoenix_demo_purgeable_tables')`);
      expect(f.rows[0].n).toBe(0);
    });
  });

  it('RESIDUE: after execute, the dataset owns nothing purgeable and a re-purge is a clean no-op', async () => {
    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });
    let summary: any[] = [];
    await rig.asUser(SA, async (c: any) => {
      summary = await c.query(`SELECT * FROM public.phoenix_demo_manifest_summary($1)`, [DATASET])
        .then((r: any) => r.rows);
    });
    expect(summary.filter(r => r.purgeable === true)).toEqual([]);

    let again: any[] = [];
    await rig.asUser(SA, async (c: any) => { again = await purge(c, false); }, { commit: true });
    expect(again).toEqual([]);
  });
});
