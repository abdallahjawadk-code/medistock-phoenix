/**
 * PHASE-7 — real operational actors + test-only shadow authorization.
 *
 * The shadow decision is deliberately read-only: it asks the exact route
 * permission at the exact source scope and compares that answer with the
 * production draft RPC. It writes no shadow state, audit row, inventory row,
 * or process metadata.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_C = '00000000-0000-0000-0000-000000151001';
const ORG_I = '00000000-0000-0000-0000-000000151002';
const ORG_X = '00000000-0000-0000-0000-000000151003';
const WH_C = '00000000-0000-0000-0000-000000151101';
const WH_C_OTHER = '00000000-0000-0000-0000-000000151102';
const WH_I = '00000000-0000-0000-0000-000000151103';
const WH_I_OTHER = '00000000-0000-0000-0000-000000151104';
const WH_X = '00000000-0000-0000-0000-000000151105';
const DP_I = '00000000-0000-0000-0000-000000151201';
const DP_I_OTHER = '00000000-0000-0000-0000-000000151202';
const DP_X = '00000000-0000-0000-0000-000000151203';

const CWM = '00000000-0000-0000-0000-000000151301';
const CWM_WRONG = '00000000-0000-0000-0000-000000151302';
const CWM_NO_ROUTE = '00000000-0000-0000-0000-000000151303';
const CWM_CROSS_ORG = '00000000-0000-0000-0000-000000151304';
const WO = '00000000-0000-0000-0000-000000151305';
const WO_WRONG = '00000000-0000-0000-0000-000000151306';
const OO = '00000000-0000-0000-0000-000000151307';
const OO_WRONG = '00000000-0000-0000-0000-000000151308';
const OO_SUSPENDED = '00000000-0000-0000-0000-000000151309';
const OO_ACT_ONLY = '00000000-0000-0000-0000-000000151310';
const CWM_SUSPENDED = '00000000-0000-0000-0000-000000151311';
const WO_SUSPENDED = '00000000-0000-0000-0000-000000151312';
const WO_NO_ROUTE = '00000000-0000-0000-0000-000000151313';
const WO_CROSS_ORG = '00000000-0000-0000-0000-000000151314';
const OO_CROSS_ORG = '00000000-0000-0000-0000-000000151315';

type SeededSuggestion = {
  suggestionId: string;
  sourceStockId: string;
  sourceTable: 'warehouse_stock' | 'outlet_stock';
  sourceMovementTable: 'warehouse_stock_movements' | 'outlet_stock_movements';
};

const callDraft = (c: any, suggestionId: string, documentNumber: string) =>
  c.query(
    `SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`,
    [suggestionId, documentNumber],
  ).then((r: any) => r.rows[0].r);

const readActions = (c: any, suggestionIds: string[]) =>
  c.query(
    `SELECT * FROM public.phoenix_get_inventory_suggestion_actions($1::uuid[])`,
    [suggestionIds],
  ).then((r: any) => r.rows);

run('151 real operational roles and scoped route policy gates', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 152 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code) VALUES
          ('${ORG_C}','P151 Central','P151 Central','p151-c'),
          ('${ORG_I}','P151 Institution','P151 Institution','p151-i'),
          ('${ORG_X}','P151 Other','P151 Other','p151-x');

        INSERT INTO warehouses(
          id,organization_id,name,name_ar,status,warehouse_kind,code
        ) VALUES
          ('${WH_C}','${ORG_C}','Central source','Central source','active','central','p151-wc'),
          ('${WH_C_OTHER}','${ORG_C}','Other central','Other central','active','central','p151-wco'),
          ('${WH_I}','${ORG_I}','Institution source','Institution source','active','institution','p151-wi'),
          ('${WH_I_OTHER}','${ORG_I}','Other institution','Other institution','active','institution','p151-wio'),
          ('${WH_X}','${ORG_X}','Foreign institution','Foreign institution','active','institution','p151-wx');

        INSERT INTO distribution_points(
          id,warehouse_id,organization_id,name,name_ar,point_type,status
        ) VALUES
          ('${DP_I}','${WH_I}','${ORG_I}','Assigned outlet','Assigned outlet','pharmacy','active'),
          ('${DP_I_OTHER}','${WH_I_OTHER}','${ORG_I}','Other outlet','Other outlet','pharmacy','active'),
          ('${DP_X}','${WH_X}','${ORG_X}','Foreign outlet','Foreign outlet','pharmacy','active');

        INSERT INTO auth.users(id,email) VALUES
          ('${CWM}','p151-cwm@rig.local'),
          ('${CWM_WRONG}','p151-cwm-wrong@rig.local'),
          ('${CWM_NO_ROUTE}','p151-cwm-no-route@rig.local'),
          ('${CWM_CROSS_ORG}','p151-cwm-cross-org@rig.local'),
          ('${WO}','p151-wo@rig.local'),
          ('${WO_WRONG}','p151-wo-wrong@rig.local'),
          ('${OO}','p151-oo@rig.local'),
          ('${OO_WRONG}','p151-oo-wrong@rig.local'),
          ('${OO_SUSPENDED}','p151-oo-suspended@rig.local'),
          ('${OO_ACT_ONLY}','p151-oo-act-only@rig.local'),
          ('${CWM_SUSPENDED}','p151-cwm-suspended@rig.local'),
          ('${WO_SUSPENDED}','p151-wo-suspended@rig.local'),
          ('${WO_NO_ROUTE}','p151-wo-no-route@rig.local'),
          ('${WO_CROSS_ORG}','p151-wo-cross-org@rig.local'),
          ('${OO_CROSS_ORG}','p151-oo-cross-org@rig.local');

        UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG_C}'
         WHERE id IN ('${CWM}','${CWM_WRONG}','${CWM_NO_ROUTE}');
        UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG_X}'
         WHERE id='${CWM_CROSS_ORG}';
        UPDATE profiles SET role='central_warehouse_manager',status='suspended',organization_id='${ORG_C}'
         WHERE id='${CWM_SUSPENDED}';
        UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_I}'
         WHERE id IN ('${WO}','${WO_WRONG}','${WO_NO_ROUTE}');
        UPDATE profiles SET role='warehouse_officer',status='suspended',organization_id='${ORG_I}'
         WHERE id='${WO_SUSPENDED}';
        UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_X}'
         WHERE id='${WO_CROSS_ORG}';
        UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_I}'
         WHERE id IN ('${OO}','${OO_WRONG}','${OO_ACT_ONLY}');
        UPDATE profiles SET role='outlet_officer',status='suspended',organization_id='${ORG_I}'
         WHERE id='${OO_SUSPENDED}';
        UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_X}'
         WHERE id='${OO_CROSS_ORG}';

        INSERT INTO profile_scope_assignments(
          profile_id,organization_id,scope_type,warehouse_id,is_active
        ) VALUES
          ('${CWM}','${ORG_C}','warehouse','${WH_C}',true),
          ('${CWM_WRONG}','${ORG_C}','warehouse','${WH_C_OTHER}',true),
          ('${CWM_NO_ROUTE}','${ORG_C}','warehouse','${WH_C}',true),
          ('${CWM_CROSS_ORG}','${ORG_X}','warehouse','${WH_X}',true),
          ('${CWM_SUSPENDED}','${ORG_C}','warehouse','${WH_C}',true),
          ('${WO}','${ORG_I}','warehouse','${WH_I}',true),
          ('${WO_WRONG}','${ORG_I}','warehouse','${WH_I_OTHER}',true),
          ('${WO_SUSPENDED}','${ORG_I}','warehouse','${WH_I}',true),
          ('${WO_NO_ROUTE}','${ORG_I}','warehouse','${WH_I}',true),
          ('${WO_CROSS_ORG}','${ORG_X}','warehouse','${WH_X}',true);

        INSERT INTO profile_scope_assignments(
          profile_id,organization_id,scope_type,distribution_point_id,is_active
        ) VALUES
          ('${OO}','${ORG_I}','distribution_point','${DP_I}',true),
          ('${OO_WRONG}','${ORG_I}','distribution_point','${DP_I_OTHER}',true),
          ('${OO_SUSPENDED}','${ORG_I}','distribution_point','${DP_I}',true),
          ('${OO_ACT_ONLY}','${ORG_I}','distribution_point','${DP_I}',true),
          ('${OO_CROSS_ORG}','${ORG_X}','distribution_point','${DP_X}',true);

        INSERT INTO profile_permission_overrides(profile_id,permission_key,allowed) VALUES
          ('${CWM_NO_ROUTE}','inventory.act_on_suggestions',true),
          ('${CWM_NO_ROUTE}','warehouse_transfer.send',false),
          ('${WO_NO_ROUTE}','inventory.act_on_suggestions',true),
          ('${WO_NO_ROUTE}','warehouse_dispatch.create',false),
          ('${OO_ACT_ONLY}','inventory.act_on_suggestions',true),
          ('${OO_ACT_ONLY}','outlet_stock.return_request',false)
        ON CONFLICT(profile_id,permission_key)
        DO UPDATE SET allowed=excluded.allowed;
      `);
    });
  }, 120_000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  async function recompute(orgId: string) {
    await rig.asUser(rig.superAdminId, (c: any) =>
      c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [orgId]),
    { commit: true });
  }

  async function seedCentral(tag: string): Promise<SeededSuggestion> {
    const sourceStockId = randomUUID();
    const targetStockId = randomUUID();
    const scientificName = `P151 Central ${tag}`;
    const nationalCode = `P151-C-${tag}`;
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO warehouse_stock(
          id,organization_id,warehouse_id,scientific_name,concentration,dosage_form,unit,
          national_code,has_no_national_code,batch_number,has_no_batch_number,expiry_date,
          on_hand_quantity,reserved_quantity,movement_seq
        ) VALUES
          ($1,$2,$3,$4,'10 mg','tablet','box',$5,false,$6,false,current_date+365,100,0,1),
          ($7,$8,$9,$4,'10 mg','tablet','box',$5,false,$10,false,current_date+365,5,0,1)
      `, [
        sourceStockId, ORG_C, WH_C, scientificName, nationalCode, `${tag}-SRC`,
        targetStockId, ORG_I, WH_I, `${tag}-TGT`,
      ]);
      await c.query(`
        INSERT INTO inventory_signal_thresholds(
          organization_id,scope_kind,scope_id,scientific_name,national_code,
          reorder_point,target_max,is_active
        ) VALUES
          ($1,'warehouse',$2,$3,$4,NULL,20,true),
          ($5,'warehouse',$6,$3,$4,50,NULL,true)
      `, [ORG_C, WH_C, scientificName, nationalCode, ORG_I, WH_I]);
    });
    await recompute(ORG_C);
    await recompute(ORG_I);
    let suggestionId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(
        `SELECT public.phoenix_suggest_cross_org_inventory_transfer($1,$2,$3,$4,$5,$6)`,
        [ORG_C, WH_C, ORG_I, WH_I, scientificName, nationalCode],
      );
      suggestionId = (await c.query(
        `SELECT id FROM inventory_transfer_suggestions
          WHERE source_stock_id=$1 AND route_kind='central_to_institution' AND status='open'`,
        [sourceStockId],
      )).rows[0].id;
    }, { commit: true });
    return {
      suggestionId,
      sourceStockId,
      sourceTable: 'warehouse_stock',
      sourceMovementTable: 'warehouse_stock_movements',
    };
  }

  async function seedDispatch(tag: string): Promise<SeededSuggestion> {
    const sourceStockId = randomUUID();
    const targetStockId = randomUUID();
    const scientificName = `P151 Dispatch ${tag}`;
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO warehouse_stock(
          id,organization_id,warehouse_id,scientific_name,
          national_code,has_no_national_code,batch_number,has_no_batch_number,expiry_date,
          on_hand_quantity,reserved_quantity,movement_seq
        ) VALUES($1,$2,$3,$4,NULL,true,$5,false,current_date+365,60,0,1)
      `, [sourceStockId, ORG_I, WH_I, scientificName, `${tag}-SRC`]);
      await c.query(`
        INSERT INTO outlet_stock(
          id,organization_id,distribution_point_id,point_type,scientific_name,
          national_code,has_no_national_code,batch_number,has_no_batch_number,expiry_date,
          on_hand_quantity,reserved_quantity,movement_seq
        ) VALUES($1,$2,$3,'pharmacy',$4,NULL,true,$5,false,current_date+365,0,0,1)
      `, [targetStockId, ORG_I, DP_I, scientificName, `${tag}-TGT`]);
      await c.query(`
        INSERT INTO inventory_signal_thresholds(
          organization_id,scope_kind,scope_id,scientific_name,national_code,
          reorder_point,target_max,is_active
        ) VALUES
          ($1,'warehouse',$2,$3,NULL,NULL,10,true),
          ($1,'outlet',$4,$3,NULL,20,NULL,true)
      `, [ORG_I, WH_I, scientificName, DP_I]);
    });
    await recompute(ORG_I);
    let suggestionId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG_I]);
      suggestionId = (await c.query(
        `SELECT id FROM inventory_transfer_suggestions
          WHERE source_stock_id=$1 AND route_kind='warehouse_to_outlet' AND status='open'`,
        [sourceStockId],
      )).rows[0].id;
    }, { commit: true });
    return {
      suggestionId,
      sourceStockId,
      sourceTable: 'warehouse_stock',
      sourceMovementTable: 'warehouse_stock_movements',
    };
  }

  async function seedOutletReturn(tag: string): Promise<SeededSuggestion> {
    const warehouseStockId = randomUUID();
    const scientificName = `P151 Return ${tag}`;
    const nationalCode = `P151-R-${tag}`;
    let sourceStockId = '';
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO warehouse_stock(
        id,organization_id,warehouse_id,scientific_name,concentration,dosage_form,unit,
        national_code,has_no_national_code,batch_number,has_no_batch_number,expiry_date,
        on_hand_quantity,reserved_quantity,movement_seq
      ) VALUES($1,$2,$3,$4,'10 mg','tablet','box',$5,false,$6,false,current_date+365,80,0,1)
    `, [warehouseStockId, ORG_I, WH_I, scientificName, nationalCode, `${tag}-SRC`]));

    let dispatchLineId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const dispatch = (await c.query(
        `SELECT public.phoenix_create_warehouse_dispatch($1,$2,$3,NULL,NULL,NULL) AS r`,
        [WH_I, DP_I, `P151-${tag}-PROVENANCE`],
      )).rows[0].r;
      dispatchLineId = (await c.query(
        `SELECT public.phoenix_add_dispatch_line_fefo_guarded($1,$2,50,false,NULL,$3) AS r`,
        [dispatch.dispatch_id, warehouseStockId, randomUUID()],
      )).rows[0].r.dispatch_line_id;
      await c.query(`SELECT public.phoenix_send_warehouse_dispatch($1,$2)`, [
        randomUUID(), dispatch.dispatch_id,
      ]);
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      sourceStockId = (await c.query(
        `SELECT public.phoenix_receive_outlet_dispatch_line($1,$2,50,NULL,NULL) AS r`,
        [randomUUID(), dispatchLineId],
      )).rows[0].r.outlet_stock_id;
    }, { commit: true });

    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO inventory_signal_thresholds(
        organization_id,scope_kind,scope_id,scientific_name,national_code,
        reorder_point,target_max,is_active
      ) VALUES
        ($1,'outlet',$2,$3,$4,NULL,20,true),
        ($1,'warehouse',$5,$3,$4,60,NULL,true)
    `, [ORG_I, DP_I, scientificName, nationalCode, WH_I]));
    await recompute(ORG_I);
    let suggestionId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG_I]);
      suggestionId = (await c.query(
        `SELECT id FROM inventory_transfer_suggestions
          WHERE source_stock_id=$1 AND route_kind='outlet_to_warehouse' AND status='open'`,
        [sourceStockId],
      )).rows[0].id;
    }, { commit: true });
    return {
      suggestionId,
      sourceStockId,
      sourceTable: 'outlet_stock',
      sourceMovementTable: 'outlet_stock_movements',
    };
  }

  async function expectDraftDenied(actorId: string, suggestionId: string, label: string) {
    await expect(rig.asUser(actorId, (c: any) =>
      callDraft(c, suggestionId, label), { commit: true }),
    ).rejects.toThrow(/forbidden|not_authorized|active_profile_required/);
    await rig.asAdmin(async (c: any) => {
      const row = (await c.query(
        `SELECT status FROM inventory_transfer_suggestions WHERE id=$1`,
        [suggestionId],
      )).rows[0];
      expect(row.status).toBe('open');
    });
  }

  async function stockSnapshot(seed: SeededSuggestion) {
    return rig.asAdmin(async (c: any) => {
      const stock = (await c.query(
        `SELECT on_hand_quantity,reserved_quantity FROM ${seed.sourceTable} WHERE id=$1`,
        [seed.sourceStockId],
      )).rows[0];
      const movements = Number((await c.query(
        `SELECT count(*) AS n FROM ${seed.sourceMovementTable}
          WHERE ${seed.sourceTable === 'warehouse_stock' ? 'warehouse_stock_id' : 'outlet_stock_id'}=$1`,
        [seed.sourceStockId],
      )).rows[0].n);
      return { stock, movements };
    });
  }

  it('the final role defaults expose the real gap without granting outlet officers a broad queue key', async () => {
    await rig.asAdmin(async (c: any) => {
      const result = await c.query(`
        SELECT role,permission_key,allowed
        FROM role_permission_defaults
        WHERE role IN ('central_warehouse_manager','warehouse_officer','outlet_officer')
          AND permission_key IN (
            'inventory.act_on_suggestions','warehouse_transfer.send',
            'warehouse_dispatch.create','outlet_stock.return_request'
          )
        ORDER BY role,permission_key
      `);
      const key = (role: string, permission: string) =>
        result.rows.find((r: any) => r.role === role && r.permission_key === permission)?.allowed;
      expect(key('central_warehouse_manager', 'warehouse_transfer.send')).toBe(true);
      expect(key('warehouse_officer', 'warehouse_dispatch.create')).toBe(true);
      expect(key('outlet_officer', 'outlet_stock.return_request')).toBe(true);
      expect(key('outlet_officer', 'inventory.act_on_suggestions')).toBe(false);
    });
  });

  it('central_to_institution uses warehouse_transfer.send at the assigned central source', async () => {
    const seed = await seedCentral('actors');
    const before = await stockSnapshot(seed);

    await expectDraftDenied(CWM_WRONG, seed.suggestionId, 'P151-C-WRONG-WH');
    await expectDraftDenied(CWM_CROSS_ORG, seed.suggestionId, 'P151-C-CROSS-ORG');
    await expectDraftDenied(CWM_SUSPENDED, seed.suggestionId, 'P151-C-SUSPENDED');
    await expectDraftDenied(CWM_NO_ROUTE, seed.suggestionId, 'P151-C-ACT-ONLY');
    await expectDraftDenied(OO, seed.suggestionId, 'P151-C-CROSS-ROUTE');

    const shadowAllowed = await rig.asAdmin(async (c: any) => (await c.query(
      `SELECT public.phoenix_profile_has_scoped_permission(
         $1,'warehouse_transfer.send',$2,$3,NULL) AS allowed`,
      [CWM, ORG_C, WH_C],
    )).rows[0].allowed);
    expect(shadowAllowed).toBe(true);

    const action = (await rig.asUser(CWM, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(action.allowed_actions).toMatchObject({
      createDraft: true,
      openDocument: false,
    });
    const queueOnly = (await rig.asUser(CWM_NO_ROUTE, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(queueOnly.allowed_actions.createDraft).toBe(false);

    const result = await rig.asUser(CWM, (c: any) =>
      callDraft(c, seed.suggestionId, 'P151-C-OK'), { commit: true });
    expect(result.route_kind).toBe('central_to_institution');
    expect(result.warehouse_transfer_request_id).toBeTruthy();
    expect(result.warehouse_transfer_request_line_id).toBeTruthy();
    expect(await stockSnapshot(seed)).toEqual(before);
    const acceptedAction = (await rig.asUser(CWM, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(acceptedAction.allowed_actions.openDocument).toBe(true);
    expect(acceptedAction.document_kind).toBe('warehouse_transfer_request');
    expect(acceptedAction.document_id).toBe(result.warehouse_transfer_request_id);

    await rig.asUser(CWM, async (c: any) => {
      expect((await c.query(
        `SELECT id FROM warehouse_transfer_requests WHERE id=$1`,
        [result.warehouse_transfer_request_id],
      )).rowCount).toBe(1);
    });
  });

  it('warehouse_to_outlet uses warehouse_dispatch.create at the assigned source warehouse', async () => {
    const seed = await seedDispatch('actors');
    const before = await stockSnapshot(seed);

    await expectDraftDenied(WO_WRONG, seed.suggestionId, 'P151-D-WRONG-WH');
    await expectDraftDenied(WO_CROSS_ORG, seed.suggestionId, 'P151-D-CROSS-ORG');
    await expectDraftDenied(WO_SUSPENDED, seed.suggestionId, 'P151-D-SUSPENDED');
    await expectDraftDenied(WO_NO_ROUTE, seed.suggestionId, 'P151-D-ACT-ONLY');
    await expectDraftDenied(CWM, seed.suggestionId, 'P151-D-CROSS-ORG');
    await expectDraftDenied(OO, seed.suggestionId, 'P151-D-CROSS-ROUTE');

    const shadowAllowed = await rig.asAdmin(async (c: any) => (await c.query(
      `SELECT public.phoenix_profile_has_scoped_permission(
         $1,'warehouse_dispatch.create',$2,$3,NULL) AS allowed`,
      [WO, ORG_I, WH_I],
    )).rows[0].allowed);
    expect(shadowAllowed).toBe(true);

    const action = (await rig.asUser(WO, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(action.allowed_actions.createDraft).toBe(true);
    const queueOnly = (await rig.asUser(WO_NO_ROUTE, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(queueOnly.allowed_actions.createDraft).toBe(false);

    const result = await rig.asUser(WO, (c: any) =>
      callDraft(c, seed.suggestionId, 'P151-D-OK'), { commit: true });
    expect(result.route_kind).toBe('warehouse_to_outlet');
    expect(result.warehouse_dispatch_id).toBeTruthy();
    expect(result.warehouse_dispatch_line_id).toBeTruthy();
    expect(await stockSnapshot(seed)).toEqual(before);
    const acceptedAction = (await rig.asUser(WO, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(acceptedAction.allowed_actions.openDocument).toBe(true);
    expect(acceptedAction.document_kind).toBe('warehouse_dispatch');
    expect(acceptedAction.document_id).toBe(result.warehouse_dispatch_id);

    await rig.asUser(WO, async (c: any) => {
      expect((await c.query(
        `SELECT id FROM warehouse_dispatches WHERE id=$1`,
        [result.warehouse_dispatch_id],
      )).rowCount).toBe(1);
    });
  });

  it('outlet_to_warehouse accepts the scoped outlet officer without inventory.act_on_suggestions', async () => {
    const seed = await seedOutletReturn('actors');
    const before = await stockSnapshot(seed);

    await expectDraftDenied(OO_WRONG, seed.suggestionId, 'P151-R-WRONG-OUTLET');
    await expectDraftDenied(OO_CROSS_ORG, seed.suggestionId, 'P151-R-CROSS-ORG');
    await expectDraftDenied(OO_SUSPENDED, seed.suggestionId, 'P151-R-SUSPENDED');
    await expectDraftDenied(OO_ACT_ONLY, seed.suggestionId, 'P151-R-ACT-ONLY');
    await expectDraftDenied(CWM, seed.suggestionId, 'P151-R-CROSS-ORG');

    const shadow = await rig.asAdmin(async (c: any) => (await c.query(`
      SELECT
        public.phoenix_profile_has_scoped_permission(
          $1,'outlet_stock.return_request',$2,NULL,$3) AS route_allowed,
        public.phoenix_profile_has_scoped_permission(
          $1,'inventory.act_on_suggestions',$2,NULL,$3) AS legacy_queue_allowed
    `, [OO, ORG_I, DP_I])).rows[0]);
    expect(shadow).toEqual({ route_allowed: true, legacy_queue_allowed: false });

    const auditBefore = await rig.asAdmin(async (c: any) => Number((await c.query(
      `SELECT count(*) AS n FROM audit_logs`,
    )).rows[0].n));
    const action = (await rig.asUser(OO, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(action.allowed_actions).toMatchObject({
      createDraft: true,
      reject: false,
      openDocument: false,
    });
    const queueOnly = (await rig.asUser(OO_ACT_ONLY, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(queueOnly.allowed_actions).toMatchObject({
      createDraft: false,
      reject: true,
    });
    const suspended = await rig.asUser(OO_SUSPENDED, (c: any) =>
      readActions(c, [seed.suggestionId]));
    expect(suspended.every((r: any) =>
      !r.allowed_actions.createDraft
      && !r.allowed_actions.reject
      && !r.allowed_actions.openDocument
    )).toBe(true);
    const auditAfter = await rig.asAdmin(async (c: any) => Number((await c.query(
      `SELECT count(*) AS n FROM audit_logs`,
    )).rows[0].n));
    expect(auditAfter).toBe(auditBefore);
    expect(await stockSnapshot(seed)).toEqual(before);

    const result = await rig.asUser(OO, (c: any) =>
      callDraft(c, seed.suggestionId, 'P151-R-OK'), { commit: true });
    expect(result.route_kind).toBe('outlet_to_warehouse');
    expect(result.outlet_return_request_id).toBeTruthy();
    expect(result.outlet_return_request_line_id).toBeTruthy();
    expect(await stockSnapshot(seed)).toEqual(before);
    const acceptedAction = (await rig.asUser(OO, (c: any) =>
      readActions(c, [seed.suggestionId])))[0];
    expect(acceptedAction.allowed_actions.openDocument).toBe(true);
    expect(acceptedAction.document_kind).toBe('outlet_return_request');
    expect(acceptedAction.document_id).toBe(result.outlet_return_request_id);
    expect(await rig.asUser(OO_CROSS_ORG, (c: any) =>
      readActions(c, [seed.suggestionId]))).toEqual([]);

    await rig.asUser(OO, async (c: any) => {
      expect((await c.query(
        `SELECT id FROM outlet_return_requests WHERE id=$1`,
        [result.outlet_return_request_id],
      )).rowCount).toBe(1);
    });
  });

  it('super_admin remains a control actor and replay returns the same document and line', async () => {
    const seed = await seedCentral('super-control');
    const first = await rig.asUser(rig.superAdminId, (c: any) =>
      callDraft(c, seed.suggestionId, 'P151-SUPER'), { commit: true });
    const replay = await rig.asUser(rig.superAdminId, (c: any) =>
      callDraft(c, seed.suggestionId, 'P151-SUPER'), { commit: true });
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.warehouse_transfer_request_id).toBe(first.warehouse_transfer_request_id);
    expect(replay.warehouse_transfer_request_line_id).toBe(first.warehouse_transfer_request_line_id);
  });

  it('keeps the public signature authenticated-only and exposes no shadow helper', async () => {
    await rig.asAdmin(async (c: any) => {
      const acl = (await c.query(`
        SELECT
          has_function_privilege(
            'authenticated','public.phoenix_create_transfer_draft_from_suggestion(uuid,text)','EXECUTE'
          ) AS authenticated_execute,
          has_function_privilege(
            'anon','public.phoenix_create_transfer_draft_from_suggestion(uuid,text)','EXECUTE'
          ) AS anon_execute
      `)).rows[0];
      expect(acl).toEqual({ authenticated_execute: true, anon_execute: false });
      expect((await c.query(`
        SELECT count(*)::integer AS n
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE '%shadow_authorization%'
      `)).rows[0].n).toBe(0);
    });
  });
});
