/**
 * W0 (R1 release gate) - database semantics behind the three Central Needs Excel API paths, on the PG rig with the full numbered chain.
 *
 * The API (upload-ticket, finalize-import, source-download) now authorizes through public.phoenix_central_needs_actor_authorized (M224) and,
 * for the two writers, public.phoenix_central_needs_my_capabilities(...).excel_import_open (M226/M229). This file proves, as real
 * authenticated users with RLS enforced:
 *   1. a super_admin of ANOTHER organization, and a super_admin with NO organization, are refused for both keys the paths use;
 *   2. the legacy helper (M092) the paths used to call WOULD have answered true for them - the contrast that justifies W0;
 *   3. the legacy authorized actor (central_warehouse_manager of the organization with the explicit key) still passes; one without the key does not;
 *   4. the batch/revision rows the endpoints read first are invisible to the foreign super_admin (RESTRICTIVE policy), so the API answers 404/403;
 *   5. after the owner activates ONE organization, excel_import_open is false for it and still true for another organization.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const A = '00000000-0000-0000-0000-0000000c0a01', B = '00000000-0000-0000-0000-0000000c0b01', CARE = '00000000-0000-0000-0000-0000000c0c01';
const U = {
  saOther: '00000000-0000-0000-0000-0000000c0a11', saNone: '00000000-0000-0000-0000-0000000c0a12', saHome: '00000000-0000-0000-0000-0000000c0a13',
  importerA: '00000000-0000-0000-0000-0000000c0a14', noKeyA: '00000000-0000-0000-0000-0000000c0a15', viewerA: '00000000-0000-0000-0000-0000000c0a16', importerB: '00000000-0000-0000-0000-0000000c0a17',
};
const PLAN_A = '00000000-0000-0000-0000-0000000c0a21', REV_A = '00000000-0000-0000-0000-0000000c0a22', PLAN_B = '00000000-0000-0000-0000-0000000c0a23', REV_B = '00000000-0000-0000-0000-0000000c0a24';

const run = rigAvailable() ? describe : describe.skip;
run('W0 - Central Needs Excel-path authority on the numbered chain', { timeout: 600_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  beforeAll(async () => {
    rig = await buildRig();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ($1,'W0 PDA A','أ','w0-a','pharmacy_department_authority',NULL),($2,'W0 PDA B','ب','w0-b','pharmacy_department_authority',NULL),($3,'W0 Care','ج','w0-c','care_institution','hospital')`, [A, B, CARE]);
      const mk = async (id: string, email: string, role: string, org: string | null, keys: string[]) => {
        await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,$2)`, [id, email]);
        await c.query(`UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1`, [id, role, org]);
        for (const k of keys) await c.query(`INSERT INTO profile_permission_overrides (profile_id,permission_key,allowed) VALUES ($1,$2,true) ON CONFLICT (profile_id,permission_key) DO UPDATE SET allowed=true`, [id, `central_needs.${k}`]);
      };
      await mk(U.saOther, 'w0-sa-other@rig', 'super_admin', B, []);          // super_admin whose HOME is organization B
      await mk(U.saNone, 'w0-sa-none@rig', 'super_admin', null, []);         // super_admin without any organization
      await mk(U.saHome, 'w0-sa-home@rig', 'super_admin', A, ['view', 'import']);
      await mk(U.importerA, 'w0-imp-a@rig', 'central_warehouse_manager', A, ['view', 'import', 'edit']);
      await mk(U.noKeyA, 'w0-nokey-a@rig', 'central_warehouse_manager', A, ['view']);
      await mk(U.viewerA, 'w0-view-a@rig', 'central_warehouse_manager', A, ['view']);
      await mk(U.importerB, 'w0-imp-b@rig', 'central_warehouse_manager', B, ['view', 'import', 'edit']);
      // fixtures that only a legacy (pre-activation) Excel flow could have created: plans + draft Excel revisions (rig-only bypass of the actor-bound insert gate)
      await c.query('BEGIN'); await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`INSERT INTO central_needs_plans (id, organization_id, plan_year) VALUES ($1,$2,2090),($3,$4,2090)`, [PLAN_A, A, PLAN_B, B]);
      await c.query(`INSERT INTO central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status) VALUES ($1,$2,$3,1,'draft'),($4,$5,$6,1,'draft')`, [REV_A, PLAN_A, A, REV_B, PLAN_B, B]);
      await c.query('COMMIT');
    });
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  const wrapper = (u: string, org: string, key: string) => rig.asUser(u, async (c: any) => (await c.query(`SELECT public.phoenix_central_needs_actor_authorized($1::uuid,$2) AS ok`, [org, key])).rows[0].ok as boolean);
  const legacy = (u: string, org: string, key: string) => rig.asUser(u, async (c: any) => (await c.query(`SELECT public.phoenix_status_center_authorized($1::uuid,$2) AS ok`, [org, key])).rows[0].ok as boolean);
  const caps = (u: string, org: string, rev: string) => rig.asUser(u, async (c: any) => (await c.query(`SELECT * FROM public.phoenix_central_needs_my_capabilities($1::uuid,$2::uuid)`, [org, rev])).rows[0]);

  it('a super_admin of another organization and a super_admin with no organization are refused for import AND view on organization A', async () => {
    for (const key of ['central_needs.import', 'central_needs.view']) {
      expect(await wrapper(U.saOther, A, key), `saOther ${key}`).toBe(false);
      expect(await wrapper(U.saNone, A, key), `saNone ${key}`).toBe(false);
    }
  });

  it('CONTRAST: the legacy helper the API used to call answered TRUE for exactly those two actors (the hole W0 closes)', async () => {
    expect(await legacy(U.saOther, A, 'central_needs.import')).toBe(true);
    expect(await legacy(U.saNone, A, 'central_needs.import')).toBe(true);
  });

  it('legacy-authorized actors are not broken: the organization importer passes, a viewer without the import key does not', async () => {
    expect(await wrapper(U.importerA, A, 'central_needs.import')).toBe(true);
    expect(await wrapper(U.importerA, A, 'central_needs.view')).toBe(true);
    expect(await wrapper(U.noKeyA, A, 'central_needs.import')).toBe(false);
    expect(await wrapper(U.noKeyA, A, 'central_needs.view')).toBe(true);
    expect(await wrapper(U.viewerA, A, 'central_needs.import')).toBe(false);
    expect(await wrapper(U.importerA, B, 'central_needs.import')).toBe(false);          // another organization
  });

  it('a super_admin keeps access ONLY to its own home organization and only with the explicit key (no wildcard)', async () => {
    expect(await wrapper(U.saHome, A, 'central_needs.import')).toBe(true);
    expect(await wrapper(U.saHome, B, 'central_needs.import')).toBe(false);
  });

  it('the foreign super_admin cannot even see organization A\'s revision (the first read of upload-ticket / finalize-import) - RLS RESTRICTIVE policy', async () => {
    const seen = (u: string) => rig.asUser(u, async (c: any) => (await c.query(`SELECT count(*)::int n FROM central_needs_plan_revisions WHERE id = $1`, [REV_A])).rows[0].n as number);
    expect(await seen(U.saOther)).toBe(0);
    expect(await seen(U.saNone)).toBe(0);
    expect(await seen(U.importerA)).toBe(1);
    expect(await seen(U.saHome)).toBe(1);
  });

  it('excel_import_open is true before activation for everyone authorized, and false after the owner activates ONLY organization A', async () => {
    expect((await caps(U.importerA, A, REV_A)).excel_import_open).toBe(true);
    expect((await caps(U.importerB, B, REV_B)).excel_import_open).toBe(true);
    await rig.asAdmin(async (c: any) => {
      await c.query(`DELETE FROM central_needs_plan_revisions WHERE id = $1`, [REV_A]).catch(() => undefined);   // no pending Excel draft may block activation
      await c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1::uuid)`, [A]);
    });
    expect((await caps(U.importerA, A, '00000000-0000-0000-0000-0000000c0aff')).excel_import_open).toBe(false);
    expect((await caps(U.importerB, B, REV_B)).excel_import_open).toBe(true);                // the other organization is untouched
  });
});
