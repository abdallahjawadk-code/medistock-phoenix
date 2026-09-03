/**
 * DISPENSING-SUSPENSION-ENFORCEMENT-FEFO-205 — DYNAMIC proof against a real
 * disposable Postgres with 001->208 applied in order.
 *
 * 205 filters suspended materials out of the ONE shared FEFO candidate
 * engine, _phoenix_inventory_fefo_batches_exact_v1 (150), which backs every
 * automated batch-selection path in the product. This suite proves the
 * filter is real, is SELECTIVE (an eligible sibling material is untouched),
 * respects 205's documented scope semantics exactly, and is reversible.
 *
 * Proves:
 *   1. WAREHOUSE scope — every batch of a suspended material disappears from
 *      the candidate list while a DIFFERENT, non-suspended material at the
 *      same warehouse still returns its batch (the eligible sibling).
 *   2. Lifting the suspension restores every previously-excluded batch,
 *      in the same FEFO order.
 *   3. OUTLET scope — a POINT-scoped suspension excludes candidates at that
 *      exact outlet only, and leaves a second outlet holding the same
 *      material fully eligible (205's "org-wide OR that exact outlet").
 *   4. An ORG-WIDE suspension excludes the material at BOTH outlets.
 *   5. 205's documented carve-out: a row whose central_item_id IS NULL
 *      cannot match any suspension and is returned unchanged.
 *
 * The internal exact_v1 engine is exercised directly (as the rig admin,
 * which owns it) because that is the function 205 actually redefines and it
 * takes the material_identity_key directly — the public
 * phoenix_inventory_fefo_batches wrapper resolves a scientific_name to
 * exactly ONE key and refuses an ambiguous match, which would conflate this
 * suite's subject with 150's identity-resolution contract.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000205001';
const WH = '00000000-0000-0000-0000-000000205101';
const OUTLET_1 = '00000000-0000-0000-0000-000000205301';
const OUTLET_2 = '00000000-0000-0000-0000-000000205302';
const ITEM_SUSPENDED = '00000000-0000-0000-0000-000000205501';
const ITEM_SIBLING = '00000000-0000-0000-0000-000000205502';

run('205 dispensing-suspension enforcement (FEFO candidate engine) — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  /** The candidate list 205 filters, read exactly as every caller sees it. */
  const fefo = (c: any, scopeKind: 'warehouse' | 'outlet', scopeId: string, key: string) =>
    c.query(
      `SELECT stock_id, batch_number, expiry_date
         FROM public._phoenix_inventory_fefo_batches_exact_v1($1,$2,$3,$4)`,
      [ORG, scopeKind, scopeId, key],
    ).then((r: any) => r.rows);

  const suspend = async (centralItemId: string, distributionPointId: string | null) => {
    let id = '';
    // The org-wide form omits p_distribution_point_id entirely (it DEFAULTs to
    // NULL) rather than passing an untyped NULL parameter, so the call is
    // resolved the same way the application's own service layer resolves it.
    const args = distributionPointId === null
      ? [randomUUID(), centralItemId, ORG, 'regulatory_hold']
      : [randomUUID(), centralItemId, ORG, 'regulatory_hold', distributionPointId];
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing', args);
      id = r.suspension_id;
    }, { commit: true });
    return id;
  };

  const lift = async (suspensionId: string) => {
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_lift_material_dispensing_suspension', [
        randomUUID(), suspensionId, 'investigation closed',
      ]);
      expect(r.ok).toBe(true);
    }, { commit: true });
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 208 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG}','FEFO 205','فيفو ٢٠٥','p205-org','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH 205','مخزن ٢٠٥','active','institution','p205-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${OUTLET_1}','${WH}','${ORG}','Outlet 205-1','منفذ ٢٠٥-١','pharmacy','active','non_emergency'),
        ('${OUTLET_2}','${WH}','${ORG}','Outlet 205-2','منفذ ٢٠٥-٢','pharmacy','active','non_emergency')
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,unit,status) VALUES
        ('${ITEM_SUSPENDED}','P205 Suspended','موقوف ٢٠٥','box','active'),
        ('${ITEM_SIBLING}','P205 Sibling','شقيق ٢٠٥','box','active')
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** One warehouse batch. Returns its id and the GENERATED identity key. */
  const seedWarehouseBatch = async (
    centralItemId: string | null, sci: string, expiry: string,
  ): Promise<{ stockId: string; key: string }> => {
    const stockId = randomUUID();
    let key = '';
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `INSERT INTO warehouse_stock(
           id,organization_id,warehouse_id,central_item_id,scientific_name,concentration,
           dosage_form,unit,has_no_national_code,batch_number,has_no_batch_number,
           expiry_date,on_hand_quantity,reserved_quantity,movement_seq
         ) VALUES($1,'${ORG}','${WH}',$2,$3,'10mg','tablet','box',true,$4,false,$5,40,0,1)
         RETURNING material_identity_key`,
        [stockId, centralItemId, sci, `B205-${randomUUID()}`, expiry],
      );
      key = r.rows[0].material_identity_key;
    });
    return { stockId, key };
  };

  /**
   * One outlet batch WITH the full provenance chain the outlet branch of the
   * candidate engine requires (accepted dispatch line + its dispatch_receive
   * movement), mirroring 168's own dynamic fixture.
   */
  const seedOutletBatch = async (
    outletId: string, centralItemId: string, sci: string,
  ): Promise<{ stockId: string; key: string }> => {
    const stockId = randomUUID();
    const whStockId = randomUUID();
    const dispatchId = randomUUID();
    const lineId = randomUUID();
    const batch = `B205-out-${randomUUID()}`;
    let key = '';
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock(
           id,organization_id,warehouse_id,central_item_id,scientific_name,concentration,
           dosage_form,unit,has_no_national_code,batch_number,has_no_batch_number,
           expiry_date,on_hand_quantity,reserved_quantity,movement_seq
         ) VALUES($1,'${ORG}','${WH}',$2,$3,'10mg','tablet','box',true,$4,false,current_date+365,40,0,1)`,
        [whStockId, centralItemId, sci, batch],
      );
      const r = await c.query(
        `INSERT INTO outlet_stock(
           id,organization_id,distribution_point_id,point_type,central_item_id,scientific_name,
           concentration,dosage_form,unit,has_no_national_code,batch_number,has_no_batch_number,
           expiry_date,on_hand_quantity,reserved_quantity,movement_seq
         ) VALUES($1,'${ORG}',$2,'pharmacy',$3,$4,'10mg','tablet','box',true,$5,false,current_date+365,40,0,1)
         RETURNING material_identity_key`,
        [stockId, outletId, centralItemId, sci, batch],
      );
      key = r.rows[0].material_identity_key;
      await c.query(
        `INSERT INTO warehouse_dispatches(
           id,organization_id,warehouse_id,destination_distribution_point_id,dispatch_number,status,sent_by,sent_at
         ) VALUES($1,'${ORG}','${WH}',$2,$3,'sent',$4,now())`,
        [dispatchId, outletId, `D205-${randomUUID()}`, rig.superAdminId],
      );
      await c.query(
        `INSERT INTO warehouse_dispatch_lines(
           id,organization_id,dispatch_id,warehouse_stock_id,scientific_name,concentration,dosage_form,unit,
           has_no_national_code,batch_number,has_no_batch_number,expiry_date,sent_quantity,status,
           received_quantity,accepted_by,accepted_at,resulting_outlet_stock_id
         ) VALUES($1,'${ORG}',$2,$3,$4,'10mg','tablet','box',true,$5,false,current_date+365,40,'accepted',40,$6,now(),$7)`,
        [lineId, dispatchId, whStockId, sci, batch, rig.superAdminId, stockId],
      );
      await c.query(
        `INSERT INTO outlet_stock_movements(
           id,outlet_stock_id,organization_id,distribution_point_id,movement_type,
           on_hand_before,on_hand_delta,on_hand_after,reserved_before,reserved_delta,reserved_after,
           dispatch_line_id,scientific_name_snapshot,reason_code,request_fingerprint
         ) VALUES($1,$2,'${ORG}',$3,'dispatch_receive',0,40,40,0,0,0,$4,$5,'received',repeat('c',64))`,
        [randomUUID(), stockId, outletId, lineId, sci],
      );
    });
    return { stockId, key };
  };

  it('WAREHOUSE scope: every batch of a suspended material leaves the candidate list while an eligible sibling material stays, and lifting restores them in FEFO order', async () => {
    const sci = `P205-WH-${randomUUID()}`;
    const siblingSci = `P205-WH-SIB-${randomUUID()}`;
    // Two batches of the SAME suspended material (same identity key, different
    // lots) — proves the filter removes the MATERIAL, not merely one row.
    const early = await seedWarehouseBatch(ITEM_SUSPENDED, sci, '2029-01-01');
    const late = await seedWarehouseBatch(ITEM_SUSPENDED, sci, '2030-01-01');
    expect(late.key).toBe(early.key);
    // A different, non-suspended material at the SAME warehouse.
    const sibling = await seedWarehouseBatch(ITEM_SIBLING, siblingSci, '2029-06-01');

    await rig.asAdmin(async (c: any) => {
      const before = await fefo(c, 'warehouse', WH, early.key);
      expect(before.map((r: any) => r.stock_id)).toEqual([early.stockId, late.stockId]);
      expect((await fefo(c, 'warehouse', WH, sibling.key)).map((r: any) => r.stock_id))
        .toEqual([sibling.stockId]);
    });

    const suspensionId = await suspend(ITEM_SUSPENDED, null);

    await rig.asAdmin(async (c: any) => {
      // Both batches of the suspended material are gone…
      expect(await fefo(c, 'warehouse', WH, early.key)).toEqual([]);
      // …and the eligible sibling material is completely untouched.
      expect((await fefo(c, 'warehouse', WH, sibling.key)).map((r: any) => r.stock_id))
        .toEqual([sibling.stockId]);
    });

    await lift(suspensionId);

    await rig.asAdmin(async (c: any) => {
      // Restored, and still soonest-expiry-first.
      expect((await fefo(c, 'warehouse', WH, early.key)).map((r: any) => r.stock_id))
        .toEqual([early.stockId, late.stockId]);
    });
  });

  it('OUTLET scope: a POINT-scoped suspension excludes candidates at that outlet only, leaving the same material at a second outlet eligible', async () => {
    const sci = `P205-OUT-${randomUUID()}`;
    const at1 = await seedOutletBatch(OUTLET_1, ITEM_SUSPENDED, sci);
    const at2 = await seedOutletBatch(OUTLET_2, ITEM_SUSPENDED, sci);
    expect(at2.key).toBe(at1.key);

    await rig.asAdmin(async (c: any) => {
      expect((await fefo(c, 'outlet', OUTLET_1, at1.key)).map((r: any) => r.stock_id)).toEqual([at1.stockId]);
      expect((await fefo(c, 'outlet', OUTLET_2, at2.key)).map((r: any) => r.stock_id)).toEqual([at2.stockId]);
    });

    const pointScoped = await suspend(ITEM_SUSPENDED, OUTLET_1);

    await rig.asAdmin(async (c: any) => {
      expect(await fefo(c, 'outlet', OUTLET_1, at1.key)).toEqual([]);
      // The SAME material at a DIFFERENT outlet is untouched — this is the
      // whole point of a point-scoped suspension.
      expect((await fefo(c, 'outlet', OUTLET_2, at2.key)).map((r: any) => r.stock_id)).toEqual([at2.stockId]);
    });

    await lift(pointScoped);

    await rig.asAdmin(async (c: any) => {
      expect((await fefo(c, 'outlet', OUTLET_1, at1.key)).map((r: any) => r.stock_id)).toEqual([at1.stockId]);
    });

    // …and an ORG-WIDE suspension reaches BOTH outlets.
    const orgWide = await suspend(ITEM_SUSPENDED, null);
    await rig.asAdmin(async (c: any) => {
      expect(await fefo(c, 'outlet', OUTLET_1, at1.key)).toEqual([]);
      expect(await fefo(c, 'outlet', OUTLET_2, at2.key)).toEqual([]);
    });
    await lift(orgWide);
    await rig.asAdmin(async (c: any) => {
      expect((await fefo(c, 'outlet', OUTLET_1, at1.key)).map((r: any) => r.stock_id)).toEqual([at1.stockId]);
      expect((await fefo(c, 'outlet', OUTLET_2, at2.key)).map((r: any) => r.stock_id)).toEqual([at2.stockId]);
    });
  });

  it('a row with an unresolved identity (central_item_id IS NULL) cannot match any suspension and is returned unchanged', async () => {
    const sci = `P205-NULLID-${randomUUID()}`;
    const unresolved = await seedWarehouseBatch(null, sci, '2029-03-01');

    // An org-wide suspension of every OTHER material must not touch it, and
    // there is no suspension that could name it — it has no central_item_id.
    const suspensionId = await suspend(ITEM_SUSPENDED, null);
    await rig.asAdmin(async (c: any) => {
      expect((await fefo(c, 'warehouse', WH, unresolved.key)).map((r: any) => r.stock_id))
        .toEqual([unresolved.stockId]);
    });
    await lift(suspensionId);
  });
});
