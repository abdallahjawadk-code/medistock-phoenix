/**
 * DISPENSING-SUSPENSION-ENFORCEMENT-DISPENSE-204 — DYNAMIC proof against a
 * real disposable Postgres with 001->204 applied in order, driving the real
 * phoenix_dispense_outlet_stock RPC.
 *
 * Proves:
 *   1. Dispensing outlet_stock whose central_item is actively suspended
 *      (org-wide) is refused with material_dispensing_suspended, and no
 *      quantity moves (on_hand_quantity is unchanged).
 *   2. Dispensing a DIFFERENT, unsuspended material at the same outlet still
 *      succeeds normally — the check is scoped to the suspended material,
 *      not a blanket freeze of the outlet.
 *   3. Lifting the suspension restores ordinary dispensing for the
 *      previously-blocked stock.
 *   4. A point-scoped suspension (this exact outlet only) does not block a
 *      SIBLING outlet in the same organization.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000204001';
const WH_A = '00000000-0000-0000-0000-000000204101';
const DP_A = '00000000-0000-0000-0000-000000204301'; // suspended-scope outlet
const DP_A2 = '00000000-0000-0000-0000-000000204302'; // sibling outlet, same org

const IA_A = '00000000-0000-0000-0000-000000204401'; // institution_admin, org A — suspends/lifts
const OO_A = '00000000-0000-0000-0000-000000204402';   // dispenses at DP_A
const OO_A2 = '00000000-0000-0000-0000-000000204403';  // dispenses at DP_A2

const ITEM_SUSPENDED = '00000000-0000-0000-0000-000000204501';
const ITEM_OTHER = '00000000-0000-0000-0000-000000204502';

run('204 dispensing-suspension enforcement (phoenix_dispense_outlet_stock) — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 204 });
    await rig.asAdmin(async (c: any) => {
      // institution_class='hospital', not 'health_sector' — see 203's fixture
      // comment: avoids 181's health_sector-only warehouse topology trigger.
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','A','أ','p204-a','care_institution','hospital') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH-A','مخزن أ','active','institution','p204-wa')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_A}','${WH_A}','${ORG_A}','Outlet A','منفذ أ','pharmacy','active'),
               ('${DP_A2}','${WH_A}','${ORG_A}','Outlet A2','منفذ أ2','pharmacy','active')
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,unit,status) VALUES
        ('${ITEM_SUSPENDED}','P204 Suspended Drug','دواء موقوف P204','box','active'),
        ('${ITEM_OTHER}','P204 Other Drug','دواء آخر P204','box','active')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${IA_A}','p204-iaa@rig'),('${OO_A}','p204-ooa@rig'),('${OO_A2}','p204-ooa2@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_A}' WHERE id='${IA_A}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A2}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${IA_A}','${ORG_A}','warehouse','${WH_A}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO_A}','${ORG_A}','distribution_point','${DP_A}',true),
               ('${OO_A2}','${ORG_A}','distribution_point','${DP_A2}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  const seedOutletStock = async (org: string, dp: string, centralItemId: string, name: string) => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock
        (id, organization_id, distribution_point_id, point_type, central_item_id, scientific_name,
         has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy',$4,$5,true,false,$6,100,0,1)`,
        [stockId, org, dp, centralItemId, name, `B-204-${randomUUID()}`]);
    });
    return stockId;
  };

  it('blocks dispensing of a suspended material and moves no quantity; a different material at the same outlet still dispenses', async () => {
    const suspendedStockId = await seedOutletStock(ORG_A, DP_A, ITEM_SUSPENDED, 'P204-Suspended');
    const otherStockId = await seedOutletStock(ORG_A, DP_A, ITEM_OTHER, 'P204-Other');

    let suspensionId = '';
    await rig.asUser(IA_A, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_SUSPENDED, ORG_A, 'regulatory_hold']);
      suspensionId = r.suspension_id;
    }, { commit: true });

    await rig.asUser(OO_A, async (c: any) => {
      await expect(call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), suspendedStockId, 5]),
      ).rejects.toThrow(/material_dispensing_suspended/);
    });

    await rig.asAdmin(async (c: any) => {
      const row = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id = $1`, [suspendedStockId]);
      expect(row.rows[0].on_hand_quantity).toBe(100); // unchanged
    });

    await rig.asUser(OO_A, async (c: any) => {
      const r = await call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), otherStockId, 5]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(95);
    }, { commit: true });

    await rig.asUser(IA_A, async (c: any) => {
      const r = await call(c, 'phoenix_lift_material_dispensing_suspension',
        [randomUUID(), suspensionId, 'hold cleared']);
      expect(r.ok).toBe(true);
    }, { commit: true });

    await rig.asUser(OO_A, async (c: any) => {
      const r = await call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), suspendedStockId, 5]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(95);
    });
  });

  it('a suspension scoped to one outlet does not block a sibling outlet in the same organization', async () => {
    const stockAtA = await seedOutletStock(ORG_A, DP_A, ITEM_SUSPENDED, 'P204-Scoped-A');
    const stockAtA2 = await seedOutletStock(ORG_A, DP_A2, ITEM_SUSPENDED, 'P204-Scoped-A2');

    await rig.asUser(IA_A, async (c: any) => {
      await call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_SUSPENDED, ORG_A, 'clinical_safety_concern', DP_A]);
    }, { commit: true });

    await rig.asUser(OO_A, async (c: any) => {
      await expect(call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), stockAtA, 1]),
      ).rejects.toThrow(/material_dispensing_suspended/);
    });

    await rig.asUser(OO_A2, async (c: any) => {
      const r = await call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), stockAtA2, 1]);
      expect(r.ok).toBe(true);
    });
  });
});
