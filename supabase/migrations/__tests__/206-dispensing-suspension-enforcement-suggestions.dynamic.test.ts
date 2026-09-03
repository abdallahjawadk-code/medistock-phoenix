/**
 * DISPENSING-SUSPENSION-ENFORCEMENT-SUGGESTIONS-206 — DYNAMIC proof against a
 * real disposable Postgres with 001->208 applied in order.
 *
 * 206 filters suspended materials out of the SOURCE batch pool of both
 * suggestion engines, so no live transfer suggestion can ever be produced
 * that proposes moving a material that may not be dispensed.
 *
 * Proves, through the real RPCs exactly as the app calls them:
 *   1. INTRA-ORG (phoenix_suggest_inventory_transfers): with an identical
 *      surplus/deficit setup, a NON-suspended material yields a real
 *      warehouse_to_outlet suggestion (the positive control that proves this
 *      fixture genuinely produces suggestions) while a suspended material
 *      yields none — the demand signal still exists, only the source is gone.
 *   2. Lifting the suspension makes the same material suggestible again.
 *   3. CROSS-ORG (phoenix_suggest_cross_org_inventory_transfer): same
 *      contrast on the central_to_institution corridor.
 *
 * Each recompute/suggest call runs in its OWN committed transaction: both
 * engines open TEMP TABLE ... ON COMMIT DROP internally, so two calls sharing
 * one transaction collide on a still-live temp table (the same constraint
 * 148's suite documents).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

// ── intra-org corridor: one warehouse (surplus) → its own outlet (deficit) ──
const ORG_A = '00000000-0000-0000-0000-000000206001';
const WH_A = '00000000-0000-0000-0000-000000206101';
const OUTLET_A = '00000000-0000-0000-0000-000000206301';

// ── cross-org corridor: central org warehouse → institution org warehouse ──
const ORG_C = '00000000-0000-0000-0000-000000206002';
const ORG_I = '00000000-0000-0000-0000-000000206003';
const WH_C = '00000000-0000-0000-0000-000000206102';
const WH_I = '00000000-0000-0000-0000-000000206103';

const ITEM = '00000000-0000-0000-0000-000000206501';

run('206 dispensing-suspension enforcement (transfer suggestions) — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const suspendOrgWide = async (organizationId: string) => {
    let id = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing', [
        randomUUID(), ITEM, organizationId, 'clinical_safety_concern',
      ]);
      id = r.suspension_id;
    }, { commit: true });
    return id;
  };

  const lift = async (suspensionId: string) => {
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_lift_material_dispensing_suspension', [
        randomUUID(), suspensionId, 'safety review closed',
      ]);
      expect(r.ok).toBe(true);
    }, { commit: true });
  };

  /** Each recompute must be its own committed transaction (temp tables). */
  const recompute = (organizationId: string) =>
    rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [organizationId]);
    }, { commit: true });

  const openSuggestionsFor = (organizationId: string, sci: string): Promise<any[]> =>
    rig.asAdmin((c: any) =>
      c.query(
        `SELECT id, route_kind, source_scope_id, target_scope_id, suggested_quantity
           FROM inventory_transfer_suggestions
          WHERE source_organization_id=$1 AND scientific_name=$2 AND status='open'`,
        [organizationId, sci],
      ).then((r: any) => r.rows));

  beforeAll(async () => {
    rig = await buildRig({ upTo: 208 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','Intra 206','داخلي ٢٠٦','p206-a','care_institution','hospital'),
        ('${ORG_I}','Institution 206','مؤسسة ٢٠٦','p206-i','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      // 171 makes the pairing exact: a central warehouse's owner is a
      // pharmacy_department_authority with institution_class NULL (the same
      // shape 165/166/167's own fixtures use), and
      // organizations_kind_institution_class_chk refuses anything else.
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_C}','Central 206','مركزي ٢٠٦','p206-c','pharmacy_department_authority',NULL)
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH A 206','مخزن أ ٢٠٦','active','institution','p206-wa'),
        ('${WH_C}','${ORG_C}','Central WH 206','مخزن مركزي ٢٠٦','active','central','p206-wc'),
        ('${WH_I}','${ORG_I}','Inst WH 206','مخزن مؤسسة ٢٠٦','active','institution','p206-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${OUTLET_A}','${WH_A}','${ORG_A}','Outlet A 206','منفذ أ ٢٠٦','pharmacy','active','non_emergency')
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,unit,status) VALUES
        ('${ITEM}','P206 Material','مادة ٢٠٦','box','active')
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 90000);

  afterAll(async () => { if (rig) await rig.end(); });

  /**
   * Surplus at WH_A (100 on hand, target_max 20) and a deficit at its own
   * outlet (5 on hand, reorder_point 50) — the shape the intra-org engine
   * turns into a warehouse_to_outlet suggestion.
   */
  const seedIntraOrgCorridor = async (sci: string) => {
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock(
           id,organization_id,warehouse_id,central_item_id,scientific_name,concentration,
           dosage_form,unit,has_no_national_code,batch_number,has_no_batch_number,
           expiry_date,on_hand_quantity,reserved_quantity,movement_seq
         ) VALUES($1,'${ORG_A}','${WH_A}','${ITEM}',$2,'10mg','tablet','box',true,$3,false,current_date+365,100,0,1)`,
        [randomUUID(), sci, `B206-src-${randomUUID()}`],
      );
      await c.query(
        `INSERT INTO outlet_stock(
           id,organization_id,distribution_point_id,point_type,central_item_id,scientific_name,
           concentration,dosage_form,unit,has_no_national_code,batch_number,has_no_batch_number,
           expiry_date,on_hand_quantity,reserved_quantity,movement_seq
         ) VALUES($1,'${ORG_A}','${OUTLET_A}','pharmacy','${ITEM}',$2,'10mg','tablet','box',true,$3,false,current_date+365,5,0,1)`,
        [randomUUID(), sci, `B206-tgt-${randomUUID()}`],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds(organization_id,scope_kind,scope_id,scientific_name,target_max,is_active)
         VALUES('${ORG_A}','warehouse','${WH_A}',$1,20,true)`,
        [sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds(organization_id,scope_kind,scope_id,scientific_name,reorder_point,is_active)
         VALUES('${ORG_A}','outlet','${OUTLET_A}',$1,50,true)`,
        [sci],
      );
    });
    await recompute(ORG_A);
  };

  const seedCrossOrgCorridor = async (sci: string) => {
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock(
           id,organization_id,warehouse_id,central_item_id,scientific_name,concentration,
           dosage_form,unit,has_no_national_code,batch_number,has_no_batch_number,
           expiry_date,on_hand_quantity,reserved_quantity,movement_seq
         ) VALUES($1,'${ORG_C}','${WH_C}','${ITEM}',$2,'10mg','tablet','box',true,$3,false,current_date+365,100,0,1)`,
        [randomUUID(), sci, `B206-xsrc-${randomUUID()}`],
      );
      await c.query(
        `INSERT INTO warehouse_stock(
           id,organization_id,warehouse_id,central_item_id,scientific_name,concentration,
           dosage_form,unit,has_no_national_code,batch_number,has_no_batch_number,
           expiry_date,on_hand_quantity,reserved_quantity,movement_seq
         ) VALUES($1,'${ORG_I}','${WH_I}','${ITEM}',$2,'10mg','tablet','box',true,$3,false,current_date+365,5,0,1)`,
        [randomUUID(), sci, `B206-xtgt-${randomUUID()}`],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds(organization_id,scope_kind,scope_id,scientific_name,target_max,is_active)
         VALUES('${ORG_C}','warehouse','${WH_C}',$1,20,true)`,
        [sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds(organization_id,scope_kind,scope_id,scientific_name,reorder_point,is_active)
         VALUES('${ORG_I}','warehouse','${WH_I}',$1,50,true)`,
        [sci],
      );
    });
    await recompute(ORG_C);
    await recompute(ORG_I);
  };

  it('INTRA-ORG: an identical corridor yields a suggestion for a free material and NONE for a suspended one, and lifting restores it', async () => {
    // POSITIVE CONTROL — proves the fixture really does produce suggestions.
    const freeSci = `P206-FREE-${randomUUID()}`;
    await seedIntraOrgCorridor(freeSci);
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await call(c, 'phoenix_suggest_inventory_transfers', [ORG_A]);
    }, { commit: true });
    const free = await openSuggestionsFor(ORG_A, freeSci);
    expect(free).toHaveLength(1);
    expect(free[0].route_kind).toBe('warehouse_to_outlet');
    expect(free[0].source_scope_id).toBe(WH_A);
    expect(free[0].target_scope_id).toBe(OUTLET_A);

    // SUBJECT — same shape, but the material is suspended BEFORE the engine
    // runs, so its source batch is filtered out of the pool entirely.
    const suspendedSci = `P206-SUSP-${randomUUID()}`;
    await seedIntraOrgCorridor(suspendedSci);
    const suspensionId = await suspendOrgWide(ORG_A);
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await call(c, 'phoenix_suggest_inventory_transfers', [ORG_A]);
    }, { commit: true });
    expect(await openSuggestionsFor(ORG_A, suspendedSci)).toHaveLength(0);

    // …and lifting makes the very same corridor suggestible again.
    await lift(suspensionId);
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await call(c, 'phoenix_suggest_inventory_transfers', [ORG_A]);
    }, { commit: true });
    const afterLift = await openSuggestionsFor(ORG_A, suspendedSci);
    expect(afterLift).toHaveLength(1);
    expect(afterLift[0].route_kind).toBe('warehouse_to_outlet');
  });

  it('CROSS-ORG: the central_to_institution engine suggests a free material and refuses to source a suspended one', async () => {
    const freeSci = `P206-XFREE-${randomUUID()}`;
    await seedCrossOrgCorridor(freeSci);
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await call(c, 'phoenix_suggest_cross_org_inventory_transfer',
        [ORG_C, WH_C, ORG_I, WH_I, freeSci, null]);
    }, { commit: true });
    const free = await openSuggestionsFor(ORG_C, freeSci);
    expect(free).toHaveLength(1);
    expect(free[0].route_kind).toBe('central_to_institution');

    const suspendedSci = `P206-XSUSP-${randomUUID()}`;
    await seedCrossOrgCorridor(suspendedSci);
    // The suspension is scoped to the SOURCE organization — that is the
    // organization whose stock 206 filters on this corridor.
    const suspensionId = await suspendOrgWide(ORG_C);
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await call(c, 'phoenix_suggest_cross_org_inventory_transfer',
        [ORG_C, WH_C, ORG_I, WH_I, suspendedSci, null]);
    }, { commit: true });
    expect(await openSuggestionsFor(ORG_C, suspendedSci)).toHaveLength(0);

    await lift(suspensionId);
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await call(c, 'phoenix_suggest_cross_org_inventory_transfer',
        [ORG_C, WH_C, ORG_I, WH_I, suspendedSci, null]);
    }, { commit: true });
    expect(await openSuggestionsFor(ORG_C, suspendedSci)).toHaveLength(1);
  });
});
