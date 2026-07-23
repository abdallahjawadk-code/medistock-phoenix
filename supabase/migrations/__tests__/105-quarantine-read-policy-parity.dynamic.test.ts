/**
 * QUARANTINE-READ-POLICY-DISPOSITION-PARITY — DYNAMIC proof for migration
 * 105, against a real disposable Postgres with 001->105 applied in order.
 *
 * Proves the gap: a warehouse_officer who CAN release/destroy quarantine
 * stock (099, gated on warehouse_transfer.return_request) could not
 * previously SELECT it via RLS at all (069's policy only recognized
 * warehouse_transfer.return_receive/review_return, both central-side keys).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000f1001';
const WH_INST = '00000000-0000-0000-0000-0000000f1102';
const WO = '00000000-0000-0000-0000-0000000f1402'; // warehouse_officer, scoped to WH_INST

run('105 quarantine read-policy parity — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let quarantineId = '';

  beforeAll(async () => {
    rig = await buildRig({ upTo: 105 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p105-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_INST}','${ORG}','Inst WH','مخزن مؤسسة','active','institution','p105-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${WO}','p105-wo@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO}','${ORG}','warehouse','${WH_INST}',true) ON CONFLICT DO NOTHING;`);

      quarantineId = randomUUID();
      await c.query(`INSERT INTO warehouse_quarantine_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, quarantine_reason, quantity, created_by, updated_by)
        VALUES ($1,$2,$3,'P105-MAT',true,false,'B-P105','damaged',10,$4,$4)`,
        [quarantineId, ORG, WH_INST, WO]);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('warehouse_officer (return_request holder, NOT return_receive/review_return) can now read the quarantine row via RLS', async () => {
    await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT id, quantity FROM warehouse_quarantine_stock WHERE id=$1`, [quarantineId]);
      expect(r.rows.length).toBe(1);
      expect(r.rows[0].quantity).toBe(10);
    });
  });

  it('and the SAME actor can actually release it (099s gate, unaffected by this migration)', async () => {
    const destId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P105-MAT',true,false,'B-P105',0,0,0)`, [destId, ORG, WH_INST]);
    });

    await rig.asUser(WO, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_release_quarantine_stock($1,$2,$3,$4,$5) AS r`,
        [randomUUID(), quarantineId, 10, 'inspection cleared', destId],
      );
      expect(r.rows[0].r.ok).toBe(true);
    });
  });
});
