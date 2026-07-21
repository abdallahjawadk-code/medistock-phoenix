/**
 * AVAILABILITY-CATALOGUE-VISIBILITY-084 — DYNAMIC proof.
 *
 * Proves phoenix_set_availability_visibility hides/reactivates a catalogue row
 * by touching ONLY the 053 removed marker — never quantity or condition — and
 * that it is org-scoped and permission-gated. Gated on PHOENIX_RIG_PG; skipped
 * in CI. Recorded in docs/phoenix/migration-084-availability-visibility-validation.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000cd001';
const ORG_OTHER = '00000000-0000-0000-0000-0000000cd009';
const WH = '00000000-0000-0000-0000-0000000cd101';
const DP = '00000000-0000-0000-0000-0000000cd301';
const USER_UPDATER = '00000000-0000-0000-0000-0000000cd402'; // same org, has availability.update
const USER_VIEWER = '00000000-0000-0000-0000-0000000cd403';  // same org, NO availability.update
const USER_OTHER = '00000000-0000-0000-0000-0000000cd404';   // foreign org

run('084 — catalogue-visibility setter (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r: any) => r.rows[0].r);

  const seedRow = (c: any) =>
    c.query(`INSERT INTO item_availability
        (distribution_point_id, organization_id, port_name, scientific_name, quantity, condition, batch_number)
       VALUES ($1,$2,'O','Amoxicillin',42,'available','BV1') RETURNING id`, [DP, ORG]).then((r: any) => r.rows[0].id);

  const readRow = (c: any, id: string) =>
    c.query(`SELECT quantity, condition, removed_at, removed_by, removal_reason FROM item_availability WHERE id=$1`, [id])
      .then((r: any) => r.rows[0]);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 84 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ('${ORG}','I','م','vv-i'),('${ORG_OTHER}','O','م','vv-o') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES ('${WH}','${ORG}','I','I','active','institution','vv-wi') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES ('${DP}','${WH}','${ORG}','O','O','pharmacy','active') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${USER_UPDATER}','vv-u@rig'),('${USER_VIEWER}','vv-v@rig'),('${USER_OTHER}','vv-o@rig') ON CONFLICT DO NOTHING;`);
      // updater gets a role that carries availability.update; viewer does not; other is foreign org.
      await c.query(`UPDATE profiles SET role='hospital_admin',status='active',organization_id='${ORG}' WHERE id='${USER_UPDATER}';`);
      await c.query(`UPDATE profiles SET role='viewer',status='active',organization_id='${ORG}' WHERE id='${USER_VIEWER}';`);
      await c.query(`UPDATE profiles SET role='hospital_admin',status='active',organization_id='${ORG_OTHER}' WHERE id='${USER_OTHER}';`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('reactivate (p_hidden=false) clears the removed marker WITHOUT touching quantity or condition', async () => {
    const id = await rig.asAdmin(async (c: any) => {
      const rid = await seedRow(c);
      await c.query(`UPDATE item_availability SET removed_at=now(), removed_by=$2, removal_reason='was hidden' WHERE id=$1`, [rid, rig.superAdminId]);
      return rid;
    });
    await rig.asUser(rig.superAdminId, (c: any) => call(c, 'phoenix_set_availability_visibility', [id, false, null]), { commit: true });
    const after = await rig.asAdmin((c: any) => readRow(c, id));
    expect(after.removed_at).toBeNull();
    expect(after.removed_by).toBeNull();
    expect(after.removal_reason).toBeNull();
    expect(after.quantity).toBe(42);          // UNCHANGED
    expect(after.condition).toBe('available'); // UNCHANGED
    await rig.asAdmin((c: any) => c.query(`DELETE FROM item_availability WHERE id=$1`, [id]));
  });

  it('hide (p_hidden=true) sets the removed marker WITHOUT touching quantity or condition', async () => {
    const id = await rig.asAdmin((c: any) => seedRow(c));
    const res = await rig.asUser(rig.superAdminId, (c: any) => call(c, 'phoenix_set_availability_visibility', [id, true, 'operator note']), { commit: true });
    expect(res.ok).toBe(true);
    expect(res.hidden).toBe(true);
    expect(res.quantity).toBe(42);
    const after = await rig.asAdmin((c: any) => readRow(c, id));
    expect(after.removed_at).not.toBeNull();
    expect(after.removal_reason).toBe('operator note');
    expect(after.quantity).toBe(42);          // UNCHANGED
    expect(after.condition).toBe('available'); // UNCHANGED
    await rig.asAdmin((c: any) => c.query(`DELETE FROM item_availability WHERE id=$1`, [id]));
  });

  it('a same-org updater (availability.update) may reactivate', async () => {
    const id = await rig.asAdmin(async (c: any) => {
      const rid = await seedRow(c);
      await c.query(`UPDATE item_availability SET removed_at=now(), removed_by=$2 WHERE id=$1`, [rid, rig.superAdminId]);
      return rid;
    });
    const res = await rig.asUser(USER_UPDATER, (c: any) => call(c, 'phoenix_set_availability_visibility', [id, false, null]), { commit: true });
    expect(res.ok).toBe(true);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM item_availability WHERE id=$1`, [id]));
  });

  it('a same-org viewer WITHOUT availability.update is forbidden', async () => {
    const id = await rig.asAdmin((c: any) => seedRow(c));
    await expect(
      rig.asUser(USER_VIEWER, (c: any) => call(c, 'phoenix_set_availability_visibility', [id, true, null])),
    ).rejects.toThrow(/forbidden_availability_update/);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM item_availability WHERE id=$1`, [id]));
  });

  it('a foreign-org actor is forbidden (cross-org), scope taken from the locked row', async () => {
    const id = await rig.asAdmin((c: any) => seedRow(c));
    await expect(
      rig.asUser(USER_OTHER, (c: any) => call(c, 'phoenix_set_availability_visibility', [id, true, null])),
    ).rejects.toThrow(/forbidden_cross_org/);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM item_availability WHERE id=$1`, [id]));
  });

  it('a missing row raises availability_not_found', async () => {
    await expect(
      rig.asUser(rig.superAdminId, (c: any) => call(c, 'phoenix_set_availability_visibility', ['00000000-0000-0000-0000-0000000cdfff', false, null])),
    ).rejects.toThrow(/availability_not_found/);
  });
});
