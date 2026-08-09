/**
 * PHOENIX-DEMO-IMMUTABLE-EXEMPTION-141 — blocked-parent preflight.
 *
 * An organization is deleted only when NOTHING references it any more --
 * manifest-owned or not. An owned child that is still present is itself
 * evidence the purge is incomplete, so it must block its parent rather than
 * be ignored. The check runs BEFORE the delete is attempted, so a deferred
 * FK error at COMMIT is never relied upon.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const DS = 'PHOENIX_DEMO_V1';
const HOME_ORG = '00000000-0000-0000-0000-00000014b001';
const SA = '00000000-0000-0000-0000-00000014b401';

run('141 organization blocked-parent preflight (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const register = (c: any, table: string, id: string) =>
    c.query(`SELECT public.phoenix_demo_register($1,$2,$3,NULL)`, [DS, table, id]);
  const mark = (c: any, table: string, id: string) =>
    c.query(`SELECT public.phoenix_demo_mark_row($1,$2,$3)`, [DS, table, id]);
  const purge = (c: any, dry = false) =>
    c.query(`SELECT * FROM public.phoenix_demo_purge($1,$2)`, [DS, dry]).then((r: any) => r.rows);

  const orgExists = async (id: string) => {
    let n = -1;
    await rig.asAdmin(async (c: any) => {
      n = (await c.query(`SELECT count(*)::int AS n FROM organizations WHERE id=$1`, [id])).rows[0].n;
    });
    return n === 1;
  };
  const manifestHasOrg = async (id: string) => {
    let n = -1;
    await rig.asAdmin(async (c: any) => {
      n = (await c.query(
        `SELECT count(*)::int AS n FROM phoenix_demo_manifest
          WHERE dataset_key=$1 AND table_name='organizations' AND row_id=$2`, [DS, id])).rows[0].n;
    });
    return n === 1;
  };

  /** A fresh demo organization, registered as demo-owned. */
  async function makeDemoOrg(tag: string) {
    const id = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,institution_class) VALUES ($1,$2,'تجريبي',$3,'hospital')`,
        [id, `Demo ${tag}`, `bp-${tag}-${Date.now()}`]);
    });
    await rig.asUser(SA, async (c: any) => { await register(c, 'organizations', id); }, { commit: true });
    return id;
  }

  async function makeSnapshot(orgId: string) {
    const id = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO phoenix_report_snapshots
           (id, organization_id, report_type, request_id, request_fingerprint,
            filters, source_as_of, payload, qr_payload, created_by, created_by_role)
         VALUES ($1,$2,'executive_overview',$3,$4,'{}'::jsonb, now(), '{}'::jsonb, $5, $6,'super_admin')`,
        [id, orgId, randomUUID(), createHash('sha256').update(id).digest('hex'), `qr-${id}`, SA]);
    });
    return id;
  }

  const blockedRow = (rows: any[]) => rows.find(r => r.table_name === 'organizations:blocked');
  const deletedRow = (rows: any[]) => rows.find(r => r.table_name === 'organizations');

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,institution_class) VALUES ($1,'Home','الرئيسية','bp-home','hospital')
        ON CONFLICT (id) DO NOTHING`, [HOME_ORG]);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,'bp-sa@rig') ON CONFLICT (id) DO NOTHING`, [SA]);
      // The super_admin lives OUTSIDE the demo orgs, so its own profile never
      // blocks a demo organization.
      await c.query(`UPDATE profiles SET role='super_admin',status='active',organization_id=$1 WHERE id=$2`,
        [HOME_ORG, SA]);
    });
  }, 180000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('1. a CLEAN demo organization (nothing references it) is deleted', async () => {
    const org = await makeDemoOrg('clean');
    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c, false); }, { commit: true });

    expect(deletedRow(rows)).toBeDefined();
    expect(deletedRow(rows).executed).toBe(true);
    expect(await orgExists(org)).toBe(false);
    expect(await manifestHasOrg(org)).toBe(false);
  });

  it('2. a GENUINE (unowned) snapshot blocks deletion, and the org survives', async () => {
    const org = await makeDemoOrg('genuine-child');
    const genuine = await makeSnapshot(org);   // never registered, never marked

    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c, false); }, { commit: true });

    const blocked = blockedRow(rows);
    expect(blocked).toBeDefined();
    expect(blocked.executed).toBe(false);
    expect(Number(blocked.affected)).toBeGreaterThanOrEqual(1);
    expect(await orgExists(org)).toBe(true);
    // Resumable: the ownership record is retained.
    expect(await manifestHasOrg(org)).toBe(true);

    await rig.asAdmin(async (c: any) => {
      await c.query(`DELETE FROM phoenix_demo_manifest WHERE dataset_key=$1 AND row_id=$2`, [DS, org]);
      await c.query(`DELETE FROM phoenix_report_snapshots WHERE id=$1`, [genuine])
        .catch(() => {});   // immutable; leaving it is fine for later tests
    });
  });

  it('3. a MANIFEST-OWNED snapshot that unexpectedly remains ALSO blocks deletion', async () => {
    const org = await makeDemoOrg('owned-remains');
    const owned = await makeSnapshot(org);
    // Owned and marked, but we deliberately withhold it from the purge by
    // removing only its manifest row AFTER marking, simulating a partial
    // previous run that left an owned child behind.
    await rig.asUser(SA, async (c: any) => {
      await register(c, 'phoenix_report_snapshots', owned);
      await mark(c, 'phoenix_report_snapshots', owned);
    }, { commit: true });
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `DELETE FROM phoenix_demo_manifest WHERE dataset_key=$1 AND table_name='phoenix_report_snapshots' AND row_id=$2`,
        [DS, owned]);
    });

    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c, false); }, { commit: true });

    expect(blockedRow(rows)).toBeDefined();
    expect(blockedRow(rows).executed).toBe(false);
    expect(await orgExists(org)).toBe(true);
    expect(await manifestHasOrg(org)).toBe(true);
  });

  it('4. a NON-snapshot child (a warehouse) also blocks deletion', async () => {
    const org = await makeDemoOrg('warehouse-child');
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'W','مخزن','active','institution',$3)`,
        [randomUUID(), org, `bp-wh-${Date.now()}`]);
    });

    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c, false); }, { commit: true });

    expect(blockedRow(rows)).toBeDefined();
    expect(await orgExists(org)).toBe(true);
  });

  it('5. one blocked organization does NOT stop an independent demo organization from purging', async () => {
    const blockedOrg = await makeDemoOrg('blocked-peer');
    await makeSnapshot(blockedOrg);                 // blocks this one
    const cleanOrg = await makeDemoOrg('clean-peer');   // nothing references this one

    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c, false); }, { commit: true });

    expect(blockedRow(rows)).toBeDefined();          // the blocked one reported
    expect(deletedRow(rows)).toBeDefined();          // the clean one still deleted
    expect(await orgExists(blockedOrg)).toBe(true);
    expect(await orgExists(cleanOrg)).toBe(false);
  });

  it('6. RETRY succeeds once the blocking child is removed (purge is resumable)', async () => {
    const org = await makeDemoOrg('retry');
    const wh = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'W','مخزن','active','institution',$3)`,
        [wh, org, `bp-retry-${Date.now()}`]);
    });

    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });
    expect(await orgExists(org)).toBe(true);
    expect(await manifestHasOrg(org)).toBe(true);    // ownership retained

    // Remove the blocker, then retry the SAME purge.
    await rig.asAdmin(async (c: any) => {
      await c.query(`DELETE FROM warehouses WHERE id=$1`, [wh]);
    });

    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c, false); }, { commit: true });

    expect(deletedRow(rows)).toBeDefined();
    expect(deletedRow(rows).executed).toBe(true);
    expect(await orgExists(org)).toBe(false);
    expect(await manifestHasOrg(org)).toBe(false);
  });

  it('7. dry-run never deletes an organization and never reports one as blocked-executed', async () => {
    const org = await makeDemoOrg('dryrun');
    let rows: any[] = [];
    await rig.asUser(SA, async (c: any) => { rows = await purge(c, true); }, { commit: true });
    expect(rows.every(r => r.executed === false)).toBe(true);
    expect(await orgExists(org)).toBe(true);

    await rig.asUser(SA, async (c: any) => { await purge(c, false); }, { commit: true });
    expect(await orgExists(org)).toBe(false);
  });
});
