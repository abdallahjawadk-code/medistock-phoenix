/**
 * Migration 186 — current-tip dynamic proof for both immediate correction paths.
 * Real default roles and scopes are used; permission overrides stay empty.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 120000, hookTimeout: 420000 });
const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000186001';
const WH = '00000000-0000-0000-0000-000000186101';
const DP = '00000000-0000-0000-0000-000000186201';
const CWM = '00000000-0000-0000-0000-000000186301';
const WO = '00000000-0000-0000-0000-000000186302';
const OO = '00000000-0000-0000-0000-000000186303';
const ORG_FOREIGN = '00000000-0000-0000-0000-000000186011';
const OO_FOREIGN = '00000000-0000-0000-0000-000000186311';
const WO_FOREIGN = '00000000-0000-0000-0000-000000186312';
const OS_EXACT = '00000000-0000-0000-0000-000000186401';
const OS_WITHIN = '00000000-0000-0000-0000-000000186402';
const OS_QUEUED = '00000000-0000-0000-0000-000000186403';
const WS_EXACT = '00000000-0000-0000-0000-000000186501';
const WS_WITHIN = '00000000-0000-0000-0000-000000186502';
const WS_QUEUED = '00000000-0000-0000-0000-000000186503';

run('186 correction reason-code wrapper parity — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let outletExactRequest = '';
  let outletExactMovement = '';
  let outletWithinRequest = '';
  let outletWithinMovement = '';
  let outletQueuedCorrection = '';
  let warehouseExactRequest = '';
  let warehouseExactMovement = '';
  let warehouseWithinRequest = '';
  let warehouseWithinMovement = '';
  let warehouseQueuedCorrection = '';

  const call = (c: any, fn: string, args: any[]) => c.query(
    `SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`, args,
  ).then((r: any) => r.rows[0].r);
  const admin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const rejection = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); } catch (error: any) { return `${error?.code ?? ''}:${error?.message ?? error}`; }
    throw new Error('expected rejection');
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await admin(`
      INSERT INTO organizations
        (id,name,name_ar,code,organization_kind,institution_class,status)
      VALUES
        ('${ORG}','R186 Hospital','مستشفى ١٨٦','r186-hosp','care_institution','hospital','active');
      INSERT INTO organizations
        (id,name,name_ar,code,organization_kind,institution_class,status)
      VALUES
        ('${ORG_FOREIGN}','R186 Foreign','مؤسسة أجنبية','r186-foreign','care_institution','hospital','active');
      INSERT INTO warehouses
        (id,organization_id,name,name_ar,warehouse_kind,is_main,status,code)
      VALUES
        ('${WH}','${ORG}','R186 Store','مخزن ١٨٦','institution',true,'active','r186-wh');
      INSERT INTO distribution_points
        (id,organization_id,warehouse_id,name,name_ar,point_type,clinical_location_kind,status)
      VALUES
        ('${DP}','${ORG}','${WH}','R186 Pharmacy','صيدلية ١٨٦','pharmacy',NULL,'active');

      INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','r186-cwm@rig.local'),
        ('${WO}','r186-wo@rig.local'),
        ('${OO}','r186-oo@rig.local'),
        ('${OO_FOREIGN}','r186-oo-foreign@rig.local'),
        ('${WO_FOREIGN}','r186-wo-foreign@rig.local');
      UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';
      UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';
      UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO}';
      UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_FOREIGN}' WHERE id='${OO_FOREIGN}';
      UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_FOREIGN}' WHERE id='${WO_FOREIGN}';
      INSERT INTO profile_scope_assignments
        (profile_id,organization_id,scope_type,warehouse_id,is_active) VALUES
        ('${CWM}','${ORG}','warehouse','${WH}',true),
        ('${WO}','${ORG}','warehouse','${WH}',true);
      INSERT INTO profile_scope_assignments
        (profile_id,organization_id,scope_type,distribution_point_id,is_active) VALUES
        ('${OO}','${ORG}','distribution_point','${DP}',true);

      INSERT INTO outlet_stock
        (id,organization_id,distribution_point_id,point_type,scientific_name,
         has_no_national_code,has_no_batch_number,batch_number,on_hand_quantity,reserved_quantity,movement_seq)
      VALUES
        ('${OS_EXACT}','${ORG}','${DP}','pharmacy','R186-O-EXACT',true,false,'O-E',50,0,0),
        ('${OS_WITHIN}','${ORG}','${DP}','pharmacy','R186-O-WITHIN',true,false,'O-W',100,0,0),
        ('${OS_QUEUED}','${ORG}','${DP}','pharmacy','R186-O-QUEUED',true,false,'O-Q',100,0,0);
      INSERT INTO warehouse_stock
        (id,organization_id,warehouse_id,scientific_name,
         has_no_national_code,has_no_batch_number,batch_number,on_hand_quantity,reserved_quantity,movement_seq)
      VALUES
        ('${WS_EXACT}','${ORG}','${WH}','R186-W-EXACT',true,false,'W-E',50,0,0),
        ('${WS_WITHIN}','${ORG}','${WH}','R186-W-WITHIN',true,false,'W-W',100,0,0),
        ('${WS_QUEUED}','${ORG}','${WH}','R186-W-QUEUED',true,false,'W-Q',100,0,0);
    `);
  });

  afterAll(async () => { if (rig) await rig.end(); });

  it('O1 — threshold 0 exact count succeeds with the full corrected ledger/audit contract', async () => {
    const authority = await admin(`SELECT
      (SELECT count(*) FROM profile_permission_overrides) AS overrides,
      public.phoenix_profile_has_scoped_permission($1,'outlet_stock.count',$2,NULL,$3) AS allowed`,
    [OO, ORG, DP]);
    expect(Number(authority.rows[0].overrides)).toBe(0);
    expect(authority.rows[0].allowed).toBe(true);
    outletExactRequest = randomUUID();
    const r = await rig.asUser(OO, c => call(c, 'phoenix_request_outlet_stock_correction',
      [outletExactRequest, OS_EXACT, 50, 'exact physical count', 0, 'r186 exact']), { commit: true });
    expect(r.ok).toBe(true);
    expect(r.requires_approval).toBe(false);
    expect(r.quantity_after).toBe(50);
    outletExactMovement = r.movement_id;
    const ledger = await admin(`SELECT movement_type,reason_code,on_hand_before,on_hand_delta,on_hand_after,
        reference_type,reference_id,correlation_id
      FROM outlet_stock_movements WHERE id=$1`, [outletExactMovement]);
    expect(ledger.rows[0]).toMatchObject({ movement_type: 'correction', reason_code: 'corrected',
      on_hand_before: 50, on_hand_delta: 0, on_hand_after: 50,
      reference_type: 'outlet_request', reference_id: outletExactRequest });
    expect(ledger.rows[0].correlation_id).not.toBeNull();
    const evidence = await admin(`SELECT
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1 AND action='outlet_stock.count'
        AND payload->>'request_id'=$2::text AND payload->>'movement_id'=$3::text) AS audits,
      (SELECT count(*) FROM phoenix_movement_events e JOIN outlet_stock_movements m ON m.id=e.reference_id::uuid
        WHERE m.id=$3::uuid AND e.reference_type='outlet_stock_movements'
          AND e.correlation_id=m.correlation_id) AS events`, [OS_EXACT, outletExactRequest, outletExactMovement]);
    expect(Number(evidence.rows[0].audits)).toBe(1);
    expect(Number(evidence.rows[0].events)).toBe(1);
  });

  it('O2 — configured positive threshold applies a small exact stock delta immediately', async () => {
    await rig.asUser(CWM, c => call(c, 'phoenix_set_variance_approval_policy', [ORG, 5]), { commit: true });
    outletWithinRequest = randomUUID();
    const r = await rig.asUser(OO, c => call(c, 'phoenix_request_outlet_stock_correction',
      [outletWithinRequest, OS_WITHIN, 97, 'within threshold', 0, null]), { commit: true });
    expect(r.requires_approval).toBe(false);
    expect(r.quantity_delta).toBe(-3);
    outletWithinMovement = r.movement_id;
    const ledger = await admin(`SELECT reason_code,on_hand_before,on_hand_delta,on_hand_after
      FROM outlet_stock_movements WHERE id=$1`, [outletWithinMovement]);
    expect(ledger.rows[0]).toMatchObject({ reason_code: 'corrected', on_hand_before: 100, on_hand_delta: -3, on_hand_after: 97 });
  });

  it('O3 — over-threshold variance remains pending with no immediate movement', async () => {
    const requestId = randomUUID();
    const r = await rig.asUser(OO, c => call(c, 'phoenix_request_outlet_stock_correction',
      [requestId, OS_QUEUED, 90, 'requires approval', 0, null]), { commit: true });
    expect(r.requires_approval).toBe(true);
    expect(r.status).toBe('pending');
    outletQueuedCorrection = r.correction_request_id;
    const n = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM outlet_stock_movements WHERE reference_id=$2) AS movements
      FROM outlet_stock WHERE id=$1`, [OS_QUEUED, requestId]);
    expect(Number(n.rows[0].on_hand_quantity)).toBe(100);
    expect(Number(n.rows[0].movements)).toBe(0);
  });

  it('O4 — a distinct default approver preserves Migration 133 corrected correlation semantics', async () => {
    const r = await rig.asUser(CWM, c => call(c, 'phoenix_approve_outlet_stock_correction',
      [outletQueuedCorrection, 0]), { commit: true });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('approved');
    const ledger = await admin(`SELECT reason_code,correlation_id,causation_id FROM outlet_stock_movements WHERE id=$1`, [r.movement_id]);
    expect(ledger.rows[0].reason_code).toBe('corrected');
    expect(ledger.rows[0].correlation_id).not.toBeNull();
  });

  it('O5 — lost-response replay returns the same movement and creates no duplicate audit', async () => {
    const r = await rig.asUser(OO, c => call(c, 'phoenix_request_outlet_stock_correction',
      [outletExactRequest, OS_EXACT, 50, 'exact physical count', 0, 'r186 exact']), { commit: true });
    expect(r.idempotent_replay).toBe(true);
    expect(r.movement_id).toBe(outletExactMovement);
    const n = await admin(`SELECT
      (SELECT count(*) FROM outlet_stock_movements WHERE reference_type='outlet_request' AND reference_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$2 AND payload->>'request_id'=$1::text) AS audits`, [outletExactRequest, OS_EXACT]);
    expect(Number(n.rows[0].movements)).toBe(1);
    expect(Number(n.rows[0].audits)).toBe(1);
  });

  it('O6 — same request with conflicting payload keeps canonical request-id conflict behavior', async () => {
    const before = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM outlet_stock_movements WHERE outlet_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM outlet_stock WHERE id=$1`, [OS_EXACT]);
    const message = await rejection(() => rig.asUser(OO, c => call(c, 'phoenix_request_outlet_stock_correction',
      [outletExactRequest, OS_EXACT, 49, 'exact physical count', 0, 'r186 exact']), { commit: true }));
    expect(message).toMatch(/23505:request_id_conflict/);
    const after = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM outlet_stock_movements WHERE outlet_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM outlet_stock WHERE id=$1`, [OS_EXACT]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('O7 — expected-generation mismatch remains 40001 with zero movement/audit mutation', async () => {
    const before = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM outlet_stock_movements WHERE outlet_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM outlet_stock WHERE id=$1`, [OS_WITHIN]);
    const message = await rejection(() => rig.asUser(OO, c => call(c, 'phoenix_request_outlet_stock_correction',
      [randomUUID(), OS_WITHIN, 97, 'stale generation', 0, null]), { commit: true }));
    expect(message).toMatch(/40001:outlet_stock_generation_conflict/);
    const after = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM outlet_stock_movements WHERE outlet_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM outlet_stock WHERE id=$1`, [OS_WITHIN]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('O8 — a foreign default-role actor is denied with zero stock/movement/audit delta', async () => {
    const before = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM outlet_stock_movements WHERE outlet_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM outlet_stock WHERE id=$1`, [OS_EXACT]);
    const message = await rejection(() => rig.asUser(OO_FOREIGN, c => call(c, 'phoenix_request_outlet_stock_correction',
      [randomUUID(), OS_EXACT, 50, 'foreign attempt', null, null]), { commit: true }));
    expect(message).toMatch(/42501:forbidden_outlet_stock_count/);
    const after = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM outlet_stock_movements WHERE outlet_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM outlet_stock WHERE id=$1`, [OS_EXACT]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('W1 — threshold 0 exact correction succeeds with the full corrected ledger/audit contract', async () => {
    const authority = await admin(`SELECT
      (SELECT count(*) FROM profile_permission_overrides) AS overrides,
      public.phoenix_profile_has_scoped_permission($1,'warehouse_stock.correct',$2,$3,NULL) AS allowed`,
    [WO, ORG, WH]);
    expect(Number(authority.rows[0].overrides)).toBe(0);
    expect(authority.rows[0].allowed).toBe(true);
    await rig.asUser(CWM, c => call(c, 'phoenix_set_variance_approval_policy', [ORG, 0]), { commit: true });
    warehouseExactRequest = randomUUID();
    const r = await rig.asUser(WO, c => call(c, 'phoenix_request_warehouse_stock_correction',
      [warehouseExactRequest, WS_EXACT, 50, 'exact physical count', 0, 'R186-W', 'exact']), { commit: true });
    expect(r.ok).toBe(true);
    expect(r.requires_approval).toBe(false);
    warehouseExactMovement = r.movement_id;
    const ledger = await admin(`SELECT movement_type,reason_code,on_hand_before,on_hand_delta,on_hand_after,
        reference_type,reference_id,correlation_id
      FROM warehouse_stock_movements WHERE id=$1`, [warehouseExactMovement]);
    expect(ledger.rows[0]).toMatchObject({ movement_type: 'correction', reason_code: 'corrected',
      on_hand_before: 50, on_hand_delta: 0, on_hand_after: 50,
      reference_type: 'warehouse_request', reference_id: warehouseExactRequest });
    expect(ledger.rows[0].correlation_id).not.toBeNull();
    const evidence = await admin(`SELECT
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1 AND action='warehouse_stock.correction'
        AND payload->>'request_id'=$2::text AND payload->>'movement_id'=$3::text
        AND payload->>'reason_code'='corrected') AS audits,
      (SELECT count(*) FROM phoenix_movement_events e JOIN warehouse_stock_movements m ON m.id=e.reference_id::uuid
        WHERE m.id=$3::uuid AND e.reference_type='warehouse_stock_movements'
          AND e.correlation_id=m.correlation_id) AS events`, [WS_EXACT, warehouseExactRequest, warehouseExactMovement]);
    expect(Number(evidence.rows[0].audits)).toBe(1);
    expect(Number(evidence.rows[0].events)).toBe(1);
  });

  it('W2 — configured positive threshold applies a small exact stock delta immediately', async () => {
    await rig.asUser(CWM, c => call(c, 'phoenix_set_variance_approval_policy', [ORG, 5]), { commit: true });
    warehouseWithinRequest = randomUUID();
    const r = await rig.asUser(WO, c => call(c, 'phoenix_request_warehouse_stock_correction',
      [warehouseWithinRequest, WS_WITHIN, 96, 'within threshold', 0, null, null]), { commit: true });
    expect(r.requires_approval).toBe(false);
    expect(r.quantity_delta).toBe(-4);
    warehouseWithinMovement = r.movement_id;
    const ledger = await admin(`SELECT reason_code,on_hand_before,on_hand_delta,on_hand_after
      FROM warehouse_stock_movements WHERE id=$1`, [warehouseWithinMovement]);
    expect(ledger.rows[0]).toMatchObject({ reason_code: 'corrected', on_hand_before: 100, on_hand_delta: -4, on_hand_after: 96 });
  });

  it('W3 — over-threshold variance remains pending with no immediate movement', async () => {
    const requestId = randomUUID();
    const r = await rig.asUser(WO, c => call(c, 'phoenix_request_warehouse_stock_correction',
      [requestId, WS_QUEUED, 90, 'requires approval', 0, null, null]), { commit: true });
    expect(r.requires_approval).toBe(true);
    expect(r.status).toBe('pending');
    warehouseQueuedCorrection = r.correction_request_id;
    const n = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM warehouse_stock_movements WHERE reference_id=$2) AS movements
      FROM warehouse_stock WHERE id=$1`, [WS_QUEUED, requestId]);
    expect(Number(n.rows[0].on_hand_quantity)).toBe(100);
    expect(Number(n.rows[0].movements)).toBe(0);
  });

  it('W4 — a distinct default approver preserves Migration 133 corrected correlation semantics', async () => {
    const r = await rig.asUser(CWM, c => call(c, 'phoenix_approve_warehouse_stock_correction',
      [warehouseQueuedCorrection, 0]), { commit: true });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('approved');
    const ledger = await admin(`SELECT reason_code,correlation_id,causation_id FROM warehouse_stock_movements WHERE id=$1`, [r.movement_id]);
    expect(ledger.rows[0].reason_code).toBe('corrected');
    expect(ledger.rows[0].correlation_id).not.toBeNull();
  });

  it('W5 — lost-response replay returns the same movement and creates no duplicate audit', async () => {
    const r = await rig.asUser(WO, c => call(c, 'phoenix_request_warehouse_stock_correction',
      [warehouseExactRequest, WS_EXACT, 50, 'exact physical count', 0, 'R186-W', 'exact']), { commit: true });
    expect(r.idempotent_replay).toBe(true);
    expect(r.movement_id).toBe(warehouseExactMovement);
    const n = await admin(`SELECT
      (SELECT count(*) FROM warehouse_stock_movements WHERE reference_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$2 AND payload->>'request_id'=$1::text) AS audits`, [warehouseExactRequest, WS_EXACT]);
    expect(Number(n.rows[0].movements)).toBe(1);
    expect(Number(n.rows[0].audits)).toBe(1);
  });

  it('W6 — same request with conflicting payload keeps canonical request-id conflict behavior', async () => {
    const before = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM warehouse_stock WHERE id=$1`, [WS_EXACT]);
    const message = await rejection(() => rig.asUser(WO, c => call(c, 'phoenix_request_warehouse_stock_correction',
      [warehouseExactRequest, WS_EXACT, 49, 'exact physical count', 0, 'R186-W', 'exact']), { commit: true }));
    expect(message).toMatch(/23505:request_id_conflict/);
    const after = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM warehouse_stock WHERE id=$1`, [WS_EXACT]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('W7 — expected-generation mismatch remains 40001 with zero movement/audit mutation', async () => {
    const before = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM warehouse_stock WHERE id=$1`, [WS_WITHIN]);
    const message = await rejection(() => rig.asUser(WO, c => call(c, 'phoenix_request_warehouse_stock_correction',
      [randomUUID(), WS_WITHIN, 96, 'stale generation', 0, null, null]), { commit: true }));
    expect(message).toMatch(/40001:warehouse_receipt_generation_conflict/);
    const after = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM warehouse_stock WHERE id=$1`, [WS_WITHIN]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('W8 — a foreign default-role actor is denied with zero stock/movement/audit delta', async () => {
    const before = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM warehouse_stock WHERE id=$1`, [WS_EXACT]);
    const message = await rejection(() => rig.asUser(WO_FOREIGN, c => call(c, 'phoenix_request_warehouse_stock_correction',
      [randomUUID(), WS_EXACT, 50, 'foreign attempt', null, null, null]), { commit: true }));
    expect(message).toMatch(/42501:forbidden_warehouse_stock_movement/);
    const after = await admin(`SELECT on_hand_quantity,
      (SELECT count(*) FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) AS movements,
      (SELECT count(*) FROM audit_logs WHERE entity_id=$1) AS audits FROM warehouse_stock WHERE id=$1`, [WS_EXACT]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
