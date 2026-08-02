/**
 * INVENTORY-DERIVED-AVAILABILITY-083 — DYNAMIC proof of the read projection.
 *
 * Proves phoenix_available_stock derives physical availability ONLY from
 * canonical outlet_stock, across the Blocker-3 case matrix: zero stock, one
 * batch, repeated receipt, multiple batches, reserved (partial/unresolved
 * return) exclusion, expired exclusion, catalogue-visibility independence,
 * forbidden scope, and a REAL dispatch→receive chain.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI. Recorded in
 * docs/phoenix/migration-083-availability-validation.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000ab001';
const ORG_OTHER = '00000000-0000-0000-0000-0000000ab009';
const WH = '00000000-0000-0000-0000-0000000ab101';
const DP = '00000000-0000-0000-0000-0000000ab301';
const DP_EMPTY = '00000000-0000-0000-0000-0000000ab302';
const USER_OTHER = '00000000-0000-0000-0000-0000000ab403';
const WH_CENTRAL = '00000000-0000-0000-0000-0000000ab102';
const ROUTE = '00000000-0000-0000-0000-0000000ab201';

// CI-484-FIX: these batches must read as comfortably 'available' (never
// 'near_expiry' or 'expired') for as long as this suite exists. A fixed
// absolute date ('2027-05-01') was safely beyond migration 073's fixed
// 270-day near_expiry window when this file was authored, but ages past
// that window as real time passes — proven by CI run #484 (2026-08-01),
// where the same literal had drifted to within 3 days of the boundary and
// tipped 'available' over to 'near_expiry'. No assertion here checks a
// specific expiry_date value, only condition/usable_quantity, so a date
// computed relative to execution time is equivalent and never expires.
const FAR_FUTURE_EXPIRY = new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

run('083 — inventory-derived availability projection (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const project = (uid: string, dp: string) =>
    rig.asUser(uid, (c: any) => c.query(`SELECT public.phoenix_available_stock($1) r`, [dp]).then((r: any) => r.rows[0].r));

  // seed one canonical outlet_stock lot (available_quantity is generated)
  const seedLot = (c: any, dp: string, batch: string, expiry: string, onHand: number, reserved = 0, sci = 'Amoxicillin') =>
    c.query(`INSERT INTO outlet_stock
      (id,organization_id,distribution_point_id,point_type,scientific_name,concentration,dosage_form,national_code,batch_number,expiry_date,on_hand_quantity,reserved_quantity)
      VALUES (gen_random_uuid(),$1,$2,'pharmacy',$3,'500mg','capsule','NC1',$4,$5,$6,$7)`,
      [ORG, dp, sci, batch, expiry, onHand, reserved]);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 83 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ('${ORG}','I','م','pj-i'),('${ORG_OTHER}','O','م','pj-o') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES ('${WH}','${ORG}','I','I','active','institution','pj-wi'),('${WH_CENTRAL}','${ORG}','C','C','active','central','pj-wc') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes (id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active) VALUES ('${ROUTE}','${WH_CENTRAL}','${WH}','central','institution',true) ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES ('${DP}','${WH}','${ORG}','O','O','pharmacy','active'),('${DP_EMPTY}','${WH}','${ORG}','E','E','pharmacy','active') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${USER_OTHER}','pj-o@rig') ON CONFLICT DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='viewer',status='active',organization_id='${ORG_OTHER}' WHERE id='${USER_OTHER}';`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('zero stock: an empty outlet projects no items', async () => {
    const r = await project(rig.superAdminId, DP_EMPTY);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('canonical_projection');
    expect(r.items).toEqual([]);
  });

  it('one usable batch: exact quantity and audited condition', async () => {
    await rig.asAdmin((c: any) => seedLot(c, DP, 'B1', FAR_FUTURE_EXPIRY, 30));
    const r = await project(rig.superAdminId, DP);
    const b1 = r.items.find((i: any) => i.batch_number === 'B1');
    expect(b1.available_quantity).toBe(30);
    expect(b1.usable_quantity).toBe(30);
    expect(b1.condition).toBe('available');
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [DP]));
  });

  it('multiple batches aggregate without double counting; reserved and expired excluded from usable', async () => {
    await rig.asAdmin(async (c: any) => {
      await seedLot(c, DP, 'BA', FAR_FUTURE_EXPIRY, 30, 0);   // usable 30
      await seedLot(c, DP, 'BB', FAR_FUTURE_EXPIRY, 20, 5);   // available 15, usable 15 (reserved excluded)
      await seedLot(c, DP, 'BX', '2020-01-01', 40, 0);   // expired → usable 0
    });
    const r = await project(rig.superAdminId, DP);
    const byBatch = Object.fromEntries(r.items.map((i: any) => [i.batch_number, i]));
    expect(byBatch.BA.usable_quantity).toBe(30);
    expect(byBatch.BB.available_quantity).toBe(15);      // reserved/unresolved netted out
    expect(byBatch.BB.usable_quantity).toBe(15);
    expect(byBatch.BX.condition).toBe('expired');
    expect(byBatch.BX.usable_quantity).toBe(0);
    expect(byBatch.BX.is_usable).toBe(false);
    // material total usable = 30 + 15 + 0 = 45, each lot counted exactly once
    const usable = r.items.reduce((s: number, i: any) => s + i.usable_quantity, 0);
    expect(usable).toBe(45);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [DP]));
  });

  it('repeated receipt of the same batch accumulates into one lot, counted once', async () => {
    // Canonical model: a repeated receipt of the same batch increments the one
    // lot's on_hand (it does not create a second identity row).
    await rig.asAdmin(async (c: any) => {
      await seedLot(c, DP, 'BR', FAR_FUTURE_EXPIRY, 10);
      await c.query(`UPDATE outlet_stock SET on_hand_quantity = on_hand_quantity + 25
                      WHERE distribution_point_id=$1 AND batch_number='BR'`, [DP]);
    });
    const r = await project(rig.superAdminId, DP);
    const br = r.items.filter((i: any) => i.batch_number === 'BR');
    expect(br.length).toBe(1);            // one lot, not two
    expect(br[0].usable_quantity).toBe(35);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [DP]));
  });

  it('catalogue visibility is independent: a hidden item_availability row does not change physical availability', async () => {
    await rig.asAdmin(async (c: any) => {
      await seedLot(c, DP, 'BV', FAR_FUTURE_EXPIRY, 12);
      // A removed/hidden catalogue row must not affect the physical projection.
      await c.query(`INSERT INTO item_availability (distribution_point_id,organization_id,port_name,scientific_name,quantity,condition,batch_number,removed_at,removed_by,removal_reason)
                     VALUES ($1,$2,'O','Amoxicillin',0,'missing','BV',now(),$3,'hidden by operator')`,
                     [DP, ORG, rig.superAdminId]);
    });
    const r = await project(rig.superAdminId, DP);
    const bv = r.items.find((i: any) => i.batch_number === 'BV');
    expect(bv.usable_quantity).toBe(12);  // physical stock stands regardless of the hidden marker
    await rig.asAdmin(async (c: any) => {
      await c.query(`DELETE FROM item_availability WHERE distribution_point_id=$1`, [DP]);
      await c.query(`DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [DP]);
    });
  });

  it('forbidden scope: a foreign org sees the same empty result as a nonexistent point', async () => {
    await rig.asAdmin((c: any) => seedLot(c, DP, 'BF', FAR_FUTURE_EXPIRY, 9));
    const foreign = await project(USER_OTHER, DP);
    expect(foreign.items).toEqual([]);                       // forbidden → empty
    const nonexistent = await project(USER_OTHER, randomUUID());
    expect(nonexistent.items).toEqual([]);                   // nonexistent → same shape
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [DP]));
  });

  it('reflects a REAL dispatch→receive chain (canonical derivation, not a manual write)', async () => {
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const call = (fn: string, a: any[]) => c.query(`SELECT public.${fn}(${a.map((_, i) => `$${i + 1}`).join(',')}) r`, a).then((r: any) => r.rows[0].r);
      const rc = await call('phoenix_receive_warehouse_stock_guarded', [randomUUID(), WH, 'Ceftriaxone', 40, true, false, 0, null, 'Rocephin', '1g', 'vial', 'vial', null, 'RB', FAR_FUTURE_EXPIRY, null, null, null, null, 'DOC', null]);
      const dsp = await call('phoenix_create_warehouse_dispatch', [WH, DP, randomUUID().slice(0, 8), null, null, null]);
      const did = dsp.dispatch_id;
      await call('phoenix_add_dispatch_line', [did, rc.warehouse_stock_id, 25]);
      await call('phoenix_send_warehouse_dispatch', [randomUUID(), did]);
      const dl = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [did]);
      await call('phoenix_receive_outlet_dispatch_line', [randomUUID(), dl.rows[0].id, 25, null, null]);
      const proj = await call('phoenix_available_stock', [DP]);
      const cef = proj.items.find((i: any) => i.scientific_name === 'Ceftriaxone');
      expect(cef.usable_quantity).toBe(25);   // the real received quantity, derived from outlet_stock
    }, { commit: true });
    // leftover canonical rows (movements RESTRICT their stock) are harmless — this
    // is the last case and other cases filter by their own batch/material.
  });
});
