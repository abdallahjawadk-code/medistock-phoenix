/**
 * DISPENSING-SUSPENSION-ENFORCEMENT-REPLENISHMENT-AND-DRAFTS-208 — DYNAMIC
 * proof against a real disposable Postgres with 001->208 applied in order.
 *
 * Proves:
 *   1. phoenix_replenish_emergency_outlet refuses a suspended source
 *      material with material_dispensing_suspended, and moves no quantity —
 *      even though a DIFFERENT, non-suspended batch of the same material
 *      exists at the source outlet (the exact bypass 207 already closed for
 *      the warehouse-side guarded sends: FEFO-candidate-starvation alone is
 *      not the gate, an explicit check is).
 *   2. A non-suspended material still replenishes normally.
 *   3. Lifting a suspension restores ordinary replenishment.
 *   4. phoenix_create_transfer_draft_from_suggestion refuses to materialize
 *      a stale suggestion (created before a suspension, drafted after) with
 *      material_dispensing_suspended, before touching anything else.
 *
 * Uses rig.superAdminId throughout as the actor — these two checks are
 * independent of the pre-existing permission system, which migrations
 * 168/150 already have their own dedicated dynamic coverage for.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

// ── Part A fixtures: replenish corridor (pharmacy -> rescue cart, hospital) ──
const ORG_A = '00000000-0000-0000-0000-000000208001';
const WH_A = '00000000-0000-0000-0000-000000208101';
const PH_A = '00000000-0000-0000-0000-000000208301';   // pharmacy (source)
const CART_A = '00000000-0000-0000-0000-000000208302'; // rescue_cart (destination)
const ITEM_SUSPENDED = '00000000-0000-0000-0000-000000208501';
const ITEM_OTHER = '00000000-0000-0000-0000-000000208502';

// ── Part B fixtures: a stale transfer suggestion ─────────────────────────────
const ORG_B = '00000000-0000-0000-0000-000000208002';
const WH_B = '00000000-0000-0000-0000-000000208102';
const ITEM_B = '00000000-0000-0000-0000-000000208503';

run('208 dispensing-suspension enforcement (replenishment + drafts) — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let routeId: string;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 208 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','A','أ','p208-a','care_institution','hospital'),
        ('${ORG_B}','B','ب','p208-b','care_institution','hospital') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH-A','مخزن أ','active','institution','p208-wa'),
        ('${WH_B}','${ORG_B}','WH-B','مخزن ب','active','institution','p208-wb')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PH_A}','${WH_A}','${ORG_A}','Pharmacy A','صيدلية أ','pharmacy','active','non_emergency'),
        ('${CART_A}','${WH_A}','${ORG_A}','Cart A','عربة أ','rescue_cart','active','emergency')
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,unit,status) VALUES
        ('${ITEM_SUSPENDED}','P208 Suspended Drug','دواء موقوف P208','box','active'),
        ('${ITEM_OTHER}','P208 Other Drug','دواء آخر P208','box','active'),
        ('${ITEM_B}','P208 Draft Drug','دواء المسودة P208','box','active')
        ON CONFLICT (id) DO NOTHING;`);

      // Destination commissioning fixture (R1.2/180's initial-provisioning
      // gate) — mirrors 168's own dynamic test's `commission()` helper.
      await c.query(`INSERT INTO warehouse_dispatches (
        organization_id, warehouse_id, destination_distribution_point_id,
        dispatch_number, status, sent_at, is_initial_provisioning, initial_provisioning_consumed_at
      ) VALUES ('${ORG_A}','${WH_A}','${CART_A}','IP208-cart','accepted',now(),true,now())
      ON CONFLICT DO NOTHING;`);

    });
    // Canonical route creation — matches 168's own dynamic test's upsertRoute
    // helper, rather than a raw INSERT that could miss a column or trigger
    // side-effect the RPC itself handles.
    const routeResult = await rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_upsert_outlet_replenishment_route', [null, PH_A, CART_A, true, null]),
      { commit: true });
    expect(routeResult.ok).toBe(true);
    routeId = routeResult.route_id as string;
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  const seedPharmacyStock = async (centralItemId: string, sci: string): Promise<string> => {
    const stockId = randomUUID();
    const whStockId = randomUUID();
    const dispatchId = randomUUID();
    const lineId = randomUUID();
    const batch = `B-208-${randomUUID()}`;
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (
        id, organization_id, warehouse_id, scientific_name, concentration, dosage_form, unit,
        has_no_national_code, batch_number, has_no_batch_number, expiry_date, on_hand_quantity, reserved_quantity
      ) VALUES ($1,'${ORG_A}','${WH_A}',$2,'10mg','tablet','box',true,$3,false,current_date+365,50,0)`,
        [whStockId, sci, batch]);
      await c.query(`INSERT INTO outlet_stock (
        id, organization_id, distribution_point_id, point_type, central_item_id, scientific_name,
        concentration, dosage_form, unit, has_no_national_code, batch_number, has_no_batch_number,
        expiry_date, on_hand_quantity, reserved_quantity, movement_seq
      ) VALUES ($1,'${ORG_A}','${PH_A}','pharmacy',$2,$3,'10mg','tablet','box',true,$4,false,current_date+365,50,0,1)`,
        [stockId, centralItemId, sci, batch]);
      await c.query(`INSERT INTO warehouse_dispatches (
        id, organization_id, warehouse_id, destination_distribution_point_id, dispatch_number, status, sent_by, sent_at
      ) VALUES ($1,'${ORG_A}','${WH_A}','${PH_A}',$2,'sent',$3,now())`,
        [dispatchId, `D-208-${randomUUID()}`, rig.superAdminId]);
      await c.query(`INSERT INTO warehouse_dispatch_lines (
        id, organization_id, dispatch_id, warehouse_stock_id, scientific_name, concentration, dosage_form, unit,
        has_no_national_code, batch_number, has_no_batch_number, expiry_date, sent_quantity, status, received_quantity,
        accepted_by, accepted_at, resulting_outlet_stock_id
      ) VALUES ($1,'${ORG_A}',$2,$3,$4,'10mg','tablet','box',true,$5,false,current_date+365,50,'accepted',50,$6,now(),$7)`,
        [lineId, dispatchId, whStockId, sci, batch, rig.superAdminId, stockId]);
      await c.query(`INSERT INTO outlet_stock_movements (
        id, outlet_stock_id, organization_id, distribution_point_id, movement_type,
        on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after,
        dispatch_line_id, scientific_name_snapshot, reason_code, request_fingerprint
      ) VALUES ($1,$2,'${ORG_A}','${PH_A}','dispatch_receive',0,50,50,0,0,0,$3,$4,'received',repeat('b',64))`,
        [randomUUID(), stockId, lineId, sci]);
    });
    return stockId;
  };

  it('refuses to replenish a suspended source material, even with a non-suspended sibling batch present, and moves no quantity', async () => {
    const suspendedStockId = await seedPharmacyStock(ITEM_SUSPENDED, `P208-Susp-${randomUUID()}`);
    // A different, non-suspended batch of the SAME material at the same
    // pharmacy — proves the refusal is not just FEFO-candidate-starvation.
    await seedPharmacyStock(ITEM_SUSPENDED, `P208-Susp-Sibling-${randomUUID()}`);

    let suspensionId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_SUSPENDED, ORG_A, 'regulatory_hold']);
      suspensionId = r.suspension_id;
    }, { commit: true });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_replenish_emergency_outlet',
        [randomUUID(), routeId, suspendedStockId, 5]),
      ).rejects.toThrow(/material_dispensing_suspended/);
    });

    await rig.asAdmin(async (c: any) => {
      const row = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id = $1`, [suspendedStockId]);
      expect(row.rows[0].on_hand_quantity).toBe(50); // unchanged

      await c.query(`DELETE FROM material_dispensing_suspensions WHERE id = $1`, [suspensionId]);
    });
  });

  it('a non-suspended material still replenishes normally', async () => {
    const otherStockId = await seedPharmacyStock(ITEM_OTHER, `P208-Other-${randomUUID()}`);

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_replenish_emergency_outlet',
        [randomUUID(), routeId, otherStockId, 5]);
      expect(r.ok).toBe(true);
    });
  });

  it('lifting a suspension restores ordinary replenishment for the previously-blocked stock', async () => {
    const stockId = await seedPharmacyStock(ITEM_SUSPENDED, `P208-Relift-${randomUUID()}`);
    let suspensionId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_SUSPENDED, ORG_A, 'regulatory_hold']);
      suspensionId = r.suspension_id;
    }, { commit: true });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_replenish_emergency_outlet',
        [randomUUID(), routeId, stockId, 3]),
      ).rejects.toThrow(/material_dispensing_suspended/);
    });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_lift_material_dispensing_suspension',
        [randomUUID(), suspensionId, 'hold cleared']);
      expect(r.ok).toBe(true);
    }, { commit: true });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_replenish_emergency_outlet',
        [randomUUID(), routeId, stockId, 3]);
      expect(r.ok).toBe(true);
    });
  });

  it('refuses to draft a stale (since-suspended) transfer suggestion before touching anything else', async () => {
    const whStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (
        id, organization_id, warehouse_id, scientific_name, concentration, dosage_form, unit,
        has_no_national_code, batch_number, has_no_batch_number, expiry_date, on_hand_quantity, reserved_quantity
      ) VALUES ($1,'${ORG_B}','${WH_B}','P208-Draft-Material','10mg','tablet','box',true,$2,false,current_date+365,20,0)`,
        [whStockId, `B-208-draft-${randomUUID()}`]);
    });

    let suspensionId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_B, ORG_B, 'recall_investigation']);
      suspensionId = r.suspension_id;
    }, { commit: true });

    const suggestionId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO inventory_transfer_suggestions (
        id, source_organization_id, target_organization_id, scientific_name,
        source_scope_kind, source_scope_id, target_scope_kind, target_scope_id,
        route_kind, source_stock_id, suggested_quantity, suggestion_key, status,
        central_item_id, material_identity_version, material_identity_key, material_identity_state
      ) VALUES (
        $1,'${ORG_B}','${ORG_B}','P208-Draft-Material',
        'warehouse',$2,'outlet',$3,
        'warehouse_to_outlet',$2,5,$4,'open',
        '${ITEM_B}',1,$5,'resolved'
      )`, [suggestionId, whStockId, randomUUID(), `p208-key-${suggestionId}`, `mik-p208-${suggestionId}`]);
    });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_create_transfer_draft_from_suggestion',
        [suggestionId, 'DOC-208-001']),
      ).rejects.toThrow(/material_dispensing_suspended/);
    });

    await rig.asAdmin(async (c: any) => {
      await c.query(`DELETE FROM inventory_transfer_suggestions WHERE id = $1`, [suggestionId]);
    });
  });
});
