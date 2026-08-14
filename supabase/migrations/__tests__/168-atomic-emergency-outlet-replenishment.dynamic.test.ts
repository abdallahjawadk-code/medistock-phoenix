/**
 * 168 · ATOMIC EMERGENCY OUTLET REPLENISHMENT (Stage E · E-5) — dynamic proof.
 *
 * Builds a disposable Postgres through the full effective migration chain and
 * drives the REAL phoenix_replenish_emergency_outlet RPC against Addendum-F
 * Shape H / Shape I corridors, negatives, movement-time revalidation,
 * idempotency, concurrency, FEFO, RBAC, fingerprint/unique constraints, and
 * E-4 / 167 non-interference.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;

// ── Fixture ids ──────────────────────────────────────────────────────────────
const ORG_SECTOR = '00000000-0000-0000-0000-000000168001';
const ORG_HOSPITAL = '00000000-0000-0000-0000-000000168002';
const ORG_SPECIAL = '00000000-0000-0000-0000-000000168003';
const ORG_SECTOR_2 = '00000000-0000-0000-0000-000000168004';

const FAC_A = '00000000-0000-0000-0000-000000168101';
const FAC_B = '00000000-0000-0000-0000-000000168102';
const FAC_INACTIVE = '00000000-0000-0000-0000-000000168103';

const WH_FAC_A = '00000000-0000-0000-0000-000000168201';
const WH_FAC_B = '00000000-0000-0000-0000-000000168202';
const WH_FAC_INACTIVE = '00000000-0000-0000-0000-000000168203';
const WH_SECTOR = '00000000-0000-0000-0000-000000168204';
const WH_HOSPITAL = '00000000-0000-0000-0000-000000168205';
const WH_SPECIAL = '00000000-0000-0000-0000-000000168206';

const PH_A = '00000000-0000-0000-0000-000000168301';
const CAB_A = '00000000-0000-0000-0000-000000168302';
const PH_B = '00000000-0000-0000-0000-000000168303';
const CAB_B = '00000000-0000-0000-0000-000000168304';
const CART_A = '00000000-0000-0000-0000-000000168305';
const PH_SECTOR = '00000000-0000-0000-0000-000000168306';
const CAB_SECTOR = '00000000-0000-0000-0000-000000168307';
const PH_INACTIVE_FAC = '00000000-0000-0000-0000-000000168308';
const CAB_INACTIVE_FAC = '00000000-0000-0000-0000-000000168309';

const PH_HOSP = '00000000-0000-0000-0000-000000168310';
const CART_HOSP = '00000000-0000-0000-0000-000000168311';
const CART_HOSP_NON = '00000000-0000-0000-0000-000000168312';
const CAB_HOSP = '00000000-0000-0000-0000-000000168313';
const CAB_HOSP_EM = '00000000-0000-0000-0000-000000168314';

const PH_SPECIAL = '00000000-0000-0000-0000-000000168315';
const CART_SPECIAL = '00000000-0000-0000-0000-000000168316';
const CAB_SPECIAL = '00000000-0000-0000-0000-000000168317';

const NOBODY = '00000000-0000-0000-0000-000000168901';
const SLEEPER = '00000000-0000-0000-0000-000000168902';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;

const call = (c: any, fn: string, args: any[]) =>
  c
    .query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
    .then((res: any) => res.rows[0].r);

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

run('168 · atomic emergency outlet replenishment (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const fingerprint = async (
    routeId: string,
    sourceStockId: string,
    quantity: number,
    fefoOverride: string | null,
    notes: string | null,
  ) => {
    const r = await rig.asAdmin((c: any) => c.query(
      `SELECT public._phoenix_replenishment_fingerprint_v1($1,$2,$3,$4,$5) AS fp`,
      [routeId, sourceStockId, quantity, fefoOverride, notes],
    ));
    return r.rows[0].fp as string;
  };

  beforeAll(async () => {
    rig = await buildRig();

    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES
        ('${ORG_SECTOR}','Sector168','Sector168','p168-sector','health_sector'),
        ('${ORG_HOSPITAL}','Hospital168','Hospital168','p168-hospital','hospital'),
        ('${ORG_SPECIAL}','Special168','Special168','p168-special','specialized_center'),
        ('${ORG_SECTOR_2}','Sector168b','Sector168b','p168-sector2','health_sector');

      INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}','primary_health_center','Centre A168','Centre A168','active'),
        ('${FAC_B}','${ORG_SECTOR}','subordinate_health_center','Centre B168','Centre B168','active'),
        ('${FAC_INACTIVE}','${ORG_SECTOR}','primary_health_center','Centre X168','Centre X168','active');

      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id,is_main) VALUES
        ('${WH_FAC_A}','${ORG_SECTOR}','A Depot168','A Depot168','active','institution','p168-wh-a','${FAC_A}',false),
        ('${WH_FAC_B}','${ORG_SECTOR}','B Depot168','B Depot168','active','institution','p168-wh-b','${FAC_B}',false),
        -- R1.1/181: a depot may only be CREATED on an active facility, so this
        -- one is created while Centre X is still active and the facility is
        -- deactivated immediately afterwards — which is exactly how the state
        -- arises in production, and keeps 168's inactive-facility refusal live.
        ('${WH_FAC_INACTIVE}','${ORG_SECTOR}','X Depot168','X Depot168','active','institution','p168-wh-x','${FAC_INACTIVE}',false),
        -- R1.1/181: the facility-less sector warehouse IS the sector main.
        ('${WH_SECTOR}','${ORG_SECTOR}','Sector Depot168','Sector Depot168','active','institution','p168-wh-sec',NULL,true),
        ('${WH_HOSPITAL}','${ORG_HOSPITAL}','Hosp Depot168','Hosp Depot168','active','institution','p168-wh-hosp',NULL,false),
        ('${WH_SPECIAL}','${ORG_SPECIAL}','Ctr Depot168','Ctr Depot168','active','institution','p168-wh-ctr',NULL,false);

      INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PH_A}','${WH_FAC_A}','${ORG_SECTOR}','A Pharmacy168','A Pharmacy168','pharmacy','active','non_emergency'),
        ('${CAB_A}','${WH_FAC_A}','${ORG_SECTOR}','A Cabinet168','A Cabinet168','crash_cabinet','active','emergency'),
        ('${PH_B}','${WH_FAC_B}','${ORG_SECTOR}','B Pharmacy168','B Pharmacy168','pharmacy','active','non_emergency'),
        ('${CAB_B}','${WH_FAC_B}','${ORG_SECTOR}','B Cabinet168','B Cabinet168','crash_cabinet','active','emergency'),
        -- R1.1/181: CART_A, PH_SECTOR and CAB_SECTOR are deliberately NOT
        -- seeded — a health-centre rescue cart and a sector-level outlet are
        -- shapes 181 refuses to create. Both refusals are proved below.
        ('${PH_INACTIVE_FAC}','${WH_FAC_INACTIVE}','${ORG_SECTOR}','X Pharmacy168','X Pharmacy168','pharmacy','active','non_emergency'),
        ('${CAB_INACTIVE_FAC}','${WH_FAC_INACTIVE}','${ORG_SECTOR}','X Cabinet168','X Cabinet168','crash_cabinet','active','emergency'),
        ('${PH_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Pharmacy168','H Pharmacy168','pharmacy','active','non_emergency'),
        ('${CART_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cart168','H Cart168','rescue_cart','active','emergency'),
        ('${CAB_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cabinet168','H Cabinet168','crash_cabinet','active','non_emergency'),
        -- R1.2C/183: CART_HOSP_NON, CAB_HOSP_EM and CART_SPECIAL are likewise
        -- NOT seeded — 183 refuses to create all three. Each is proved at both
        -- ends below: the outlet cannot exist, and 168's runtime refusal is
        -- still installed beneath it.
        ('${PH_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Pharmacy168','C Pharmacy168','pharmacy','active','non_emergency'),
        ('${CAB_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Cabinet168','C Cabinet168','crash_cabinet','active','non_emergency');

      -- Now retire Centre X, leaving its depot attached to an inactive facility.

      INSERT INTO auth.users (id, email) VALUES ('${NOBODY}', 'nobody168@rig.test')
      ON CONFLICT (id) DO NOTHING;
      UPDATE profiles
         SET role='outlet_officer', status='active', organization_id='${ORG_HOSPITAL}'
       WHERE id='${NOBODY}';

      INSERT INTO auth.users (id, email) VALUES ('${SLEEPER}', 'sleeper168@rig.test')
      ON CONFLICT (id) DO NOTHING;
      UPDATE profiles
         SET role='outlet_officer', status='suspended', organization_id='${ORG_HOSPITAL}'
       WHERE id='${SLEEPER}';

      -- R1.2 / Migration 180: routine replenishment is now INITIAL-FIRST — a
      -- fresh execution requires the destination emergency outlet to have
      -- CONSUMED an initial-provisioning lifecycle. This suite owns the E-5
      -- corridor, not commissioning, so every emergency destination is
      -- commissioned here as a FIXTURE: one consumed lifecycle row each,
      -- exactly the state phoenix_create_initial_provisioning_dispatch plus a
      -- positive receipt leaves behind. Seeded the same way this file already
      -- seeds warehouse_stock and outlet_stock directly.
      --
      -- The commissioning path itself, and the refusal when it is missing, are
      -- proved end to end against the real RPCs in
      -- 180-emergency-initial-provisioning-boundary.dynamic.test.ts (Q1-Q6).
      INSERT INTO warehouse_dispatches (
        organization_id, warehouse_id, destination_distribution_point_id,
        dispatch_number, status, sent_at,
        is_initial_provisioning, initial_provisioning_consumed_at)
      SELECT dp.organization_id, dp.warehouse_id, dp.id,
             -- right(), not left(): these fixture UUIDs share their first 24
             -- characters, so a left() slice would collide into one number and
             -- ON CONFLICT would silently commission only the first outlet.
             'IP168-' || right(dp.id::text, 12), 'accepted', now(), true, now()
        FROM distribution_points dp
       WHERE dp.point_type IN ('crash_cabinet', 'rescue_cart')
         AND dp.organization_id IN
             ('${ORG_SECTOR}', '${ORG_HOSPITAL}', '${ORG_SPECIAL}', '${ORG_SECTOR_2}')
      ON CONFLICT DO NOTHING;
    `));
  });

  afterAll(async () => { if (rig) await rig.end(); });

  /**
   * R1.2 / Migration 180 commissioning fixture, per outlet. Mirrors the seed
   * block above so a test that has to park the row can put it back verbatim.
   */
  const commission = (dp: string) => rig.asAdmin((c: any) => c.query(`
    INSERT INTO warehouse_dispatches (
      organization_id, warehouse_id, destination_distribution_point_id,
      dispatch_number, status, sent_at,
      is_initial_provisioning, initial_provisioning_consumed_at)
    SELECT dp.organization_id, dp.warehouse_id, dp.id,
           'IP168-' || right(dp.id::text, 12), 'accepted', now(), true, now()
      FROM distribution_points dp WHERE dp.id = $1
    ON CONFLICT DO NOTHING`, [dp]));

  const decommission = (dp: string) => rig.asAdmin((c: any) => c.query(
    `DELETE FROM warehouse_dispatches
      WHERE destination_distribution_point_id = $1 AND is_initial_provisioning`, [dp]));

  /**
   * R1.2C/183 — the live body of the replenishment RPC. Some shapes it refuses
   * can no longer be created or drifted into at all, so its refusal is proved
   * to be still installed rather than exercised against an impossible outlet.
   */
  const replenishRpcDef = async (): Promise<string> => {
    const { rows } = await rig.asAdmin((c: any) => c.query(
      `SELECT pg_get_functiondef(
         'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)'::regprocedure) AS def`));
    return rows[0].def as string;
  };

  async function upsertRoute(src: string, dst: string, active = true): Promise<string> {
    // Prefer updating an existing pair when present — the active-pair unique
    // index rejects a second INSERT for the same endpoints.
    const existing = await rig.asAdmin((c: any) => c.query(
      `SELECT id FROM outlet_replenishment_routes
        WHERE source_point_id=$1 AND destination_point_id=$2
        ORDER BY created_at DESC LIMIT 1`,
      [src, dst],
    ));
    const routeArg = existing.rows[0]?.id ?? null;
    const r = await rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_upsert_outlet_replenishment_route', [routeArg, src, dst, active, null]),
      { commit: true });
    expect(r.ok).toBe(true);
    expect(r.route_id).toBeTruthy();
    return r.route_id as string;
  }

  async function seedPharmacyStock(opts: {
    id?: string;
    org: string;
    pharmacy: string;
    sci: string;
    qty: number;
    batch?: string;
    expiryDays?: number;
    supplyType?: string | null;
    purchaseOrigin?: string | null;
    unit?: string;
    centralItemId?: string | null;
  }): Promise<string> {
    // phoenix_inventory_fefo_batches (outlet scope) only returns lots that have
    // an accepted dispatch_receive provenance chain (150 exact helper JOIN).
    const id = opts.id ?? randomUUID();
    const batch = opts.batch ?? uniq('B168');
    const expiryDays = opts.expiryDays ?? 365;
    const supplyType = opts.supplyType ?? 'aid';
    const purchaseOrigin = opts.purchaseOrigin ?? null;
    const unit = opts.unit ?? 'box';
    const centralItemId = opts.centralItemId ?? null;
    const whStockId = randomUUID();
    const dispatchId = randomUUID();
    const lineId = randomUUID();
    const inboundId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      const wh = await c.query(
        `SELECT warehouse_id FROM distribution_points WHERE id=$1`, [opts.pharmacy]);
      const warehouseId = wh.rows[0].warehouse_id;
      await c.query(`
        INSERT INTO warehouse_stock (
          id, organization_id, warehouse_id,
          scientific_name, concentration, dosage_form, unit,
          national_code, has_no_national_code,
          batch_number, has_no_batch_number,
          expiry_date, on_hand_quantity, reserved_quantity,
          supply_type, purchase_origin
        ) VALUES (
          $1,$2,$3,
          $4,'10mg','tablet',$10,
          NULL, true,
          $5, false,
          current_date + $6::int, $7, 0,
          $8, $9
        )
      `, [whStockId, opts.org, warehouseId, opts.sci, batch, expiryDays, opts.qty,
        supplyType, purchaseOrigin, unit]);

      await c.query(`
        INSERT INTO outlet_stock (
          id, organization_id, distribution_point_id, point_type, central_item_id,
          scientific_name, concentration, dosage_form, unit,
          national_code, has_no_national_code,
          batch_number, has_no_batch_number,
          expiry_date, on_hand_quantity, reserved_quantity, movement_seq,
          supply_type, purchase_origin
        ) VALUES (
          $1,$2,$3,'pharmacy',$10,
          $4,'10mg','tablet',$11,
          NULL, true,
          $5, false,
          current_date + $6::int, $7, 0, 1,
          $8, $9
        )
      `, [
        id, opts.org, opts.pharmacy, opts.sci, batch, expiryDays, opts.qty,
        supplyType, purchaseOrigin, centralItemId, unit,
      ]);

      await c.query(`
        INSERT INTO warehouse_dispatches (
          id, organization_id, warehouse_id, destination_distribution_point_id,
          dispatch_number, status, sent_by, sent_at
        ) VALUES (
          $1,$2,$3,$4,$5,'sent',$6,now()
        )
      `, [dispatchId, opts.org, warehouseId, opts.pharmacy, uniq('D168'), rig.superAdminId]);

      await c.query(`
        INSERT INTO warehouse_dispatch_lines (
          id, organization_id, dispatch_id, warehouse_stock_id,
          scientific_name, concentration, dosage_form, unit,
          national_code, has_no_national_code, batch_number, has_no_batch_number,
          expiry_date, sent_quantity, status, received_quantity,
          accepted_by, accepted_at, resulting_outlet_stock_id,
          supply_type, purchase_origin
        ) VALUES (
          $1,$2,$3,$4,
          $5,'10mg','tablet','box',
          NULL, true, $6, false,
          current_date + $7::int, $8, 'accepted', $8,
          $9, now(), $10,
          $11, $12
        )
      `, [
        lineId, opts.org, dispatchId, whStockId, opts.sci, batch, expiryDays,
        opts.qty, rig.superAdminId, id, supplyType, purchaseOrigin,
      ]);

      await c.query(`
        INSERT INTO outlet_stock_movements (
          id, outlet_stock_id, organization_id, distribution_point_id, movement_type,
          on_hand_before, on_hand_delta, on_hand_after,
          reserved_before, reserved_delta, reserved_after,
          dispatch_line_id, scientific_name_snapshot, reason_code, request_fingerprint
        ) VALUES (
          $1,$2,$3,$4,'dispatch_receive',
          0,$5,$5,0,0,0,
          $6,$7,'received', repeat('a', 64)
        )
      `, [inboundId, id, opts.org, opts.pharmacy, opts.qty, lineId, opts.sci]);
    });
    return id;
  }

  async function onHand(stockId: string): Promise<number> {
    const r = await rig.asAdmin((c: any) =>
      c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]));
    return Number(r.rows[0]?.on_hand_quantity ?? -1);
  }

  // CORRECTION (independent review, PR #109): this helper used to mirror the
  // migration's original partial destination-identity predicate (scientific
  // name / national code / concentration / dosage form only), which meant a
  // buggy implementation and this test helper could agree on the WRONG
  // destination row and the test would still pass. It now resolves the
  // destination the same canonical way Migration 150 requires: exact
  // material_identity_key equality (which is itself generated from
  // central_item_id, scientific_name, national_code, concentration,
  // dosage_form, unit — see 150) combined with the exact lot/provenance
  // tuple enforced by outlet_stock_identity_v150_uniq.
  async function destStockId(pharmacyStockId: string, destPoint: string): Promise<string | null> {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT d.id
      FROM outlet_stock s
      JOIN outlet_stock d
        ON d.distribution_point_id = $2
       AND d.organization_id = s.organization_id
       AND d.material_identity_key = s.material_identity_key
       AND COALESCE(d.batch_number,'') = COALESCE(s.batch_number,'')
       AND COALESCE(d.expiry_date, DATE '0001-01-01') = COALESCE(s.expiry_date, DATE '0001-01-01')
       AND COALESCE(d.internal_batch_reference,'') = COALESCE(s.internal_batch_reference,'')
       AND COALESCE(d.supply_type,'') = COALESCE(s.supply_type,'')
       AND COALESCE(d.purchase_origin,'') = COALESCE(s.purchase_origin,'')
      WHERE s.id = $1
    `, [pharmacyStockId, destPoint]));
    return r.rows[0]?.id ?? null;
  }

  // Directly seeds a pre-existing destination-side stock row (no dispatch
  // chain — this is only ever used to plant a DIFFERENT canonical material
  // variant at the destination point so a regression can prove the RPC does
  // not pick it by accident. It's never read via FEFO.)
  async function seedDestinationStock(opts: {
    id?: string;
    org: string;
    point: string;
    pointType: string;
    sci: string;
    unit?: string;
    centralItemId?: string | null;
    batch: string;
    expiryDays: number;
    qty: number;
    supplyType?: string | null;
    purchaseOrigin?: string | null;
  }): Promise<string> {
    const id = opts.id ?? randomUUID();
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO outlet_stock (
        id, organization_id, distribution_point_id, point_type, central_item_id,
        scientific_name, concentration, dosage_form, unit,
        national_code, has_no_national_code,
        batch_number, has_no_batch_number,
        expiry_date, on_hand_quantity, reserved_quantity, movement_seq,
        supply_type, purchase_origin
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6,'10mg','tablet',$7,
        NULL, true,
        $8, false,
        current_date + $9::int, $10, 0, 1,
        $11, $12
      )
    `, [
      id, opts.org, opts.point, opts.pointType, opts.centralItemId ?? null,
      opts.sci, opts.unit ?? 'box',
      opts.batch, opts.expiryDays, opts.qty,
      opts.supplyType ?? 'aid', opts.purchaseOrigin ?? null,
    ]));
    return id;
  }

  async function movementLegs(requestId: string) {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT movement_type, on_hand_delta, reference_type, reference_id,
             reason_code, request_fingerprint, outlet_stock_id, correlation_id
      FROM outlet_stock_movements
      WHERE reference_type='outlet_replenishment' AND reference_id=$1
      ORDER BY movement_type
    `, [requestId]));
    return r.rows;
  }

  async function snapshots(srcId: string, dstPoint: string, requestId: string) {
    const srcQty = await onHand(srcId);
    const dstId = await destStockId(srcId, dstPoint);
    const dstQty = dstId ? await onHand(dstId) : 0;
    const legs = await movementLegs(requestId);
    const audits = await rig.asAdmin((c: any) => c.query(`
      SELECT count(*)::int n FROM audit_logs
      WHERE action='outlet_stock.replenish'
        AND payload->>'request_id'=$1
    `, [requestId]));
    const whMoves = await rig.asAdmin((c: any) => c.query(`
      SELECT count(*)::int n FROM warehouse_stock_movements
      WHERE reference_id=$1
    `, [requestId]));
    const ipFlags = await rig.asAdmin((c: any) => c.query(`
      SELECT count(*)::int n FROM warehouse_dispatches
      WHERE is_initial_provisioning IS TRUE
        AND (document_number ILIKE '%168%' OR notes ILIKE '%168%')
    `));
    return {
      srcQty, dstId, dstQty, legs,
      auditN: audits.rows[0].n,
      whMoveN: whMoves.rows[0].n,
      ipN: ipFlags.rows[0].n,
    };
  }

  async function replenish(
    routeId: string,
    sourceStockId: string,
    qty: number,
    requestId = randomUUID(),
    fefoOverride: string | null = null,
    notes: string | null = null,
    actor = rig.superAdminId,
  ) {
    return rig.asUser(actor, (c: any) =>
      call(c, 'phoenix_replenish_emergency_outlet', [
        requestId, routeId, sourceStockId, qty, fefoOverride, notes,
      ]), { commit: true });
  }

  async function assertSuccess(
    label: string,
    srcPoint: string,
    dstPoint: string,
    org: string,
    qty: number,
  ) {
    const routeId = await upsertRoute(srcPoint, dstPoint);
    const srcId = await seedPharmacyStock({
      org, pharmacy: srcPoint, sci: uniq(`SCI-${label}`), qty: qty + 5,
      supplyType: 'aid', purchaseOrigin: null,
    });
    const beforeSrc = await onHand(srcId);
    const requestId = randomUUID();
    const result = await replenish(routeId, srcId, qty, requestId, null, `note-${label}`);
    expect(result.ok, label).toBe(true);
    expect(result.idempotent_replay).toBe(false);
    expect(result.quantity).toBe(qty);

    const after = await snapshots(srcId, dstPoint, requestId);
    expect(after.srcQty, `${label} source debit`).toBe(beforeSrc - qty);
    expect(after.dstQty, `${label} dest credit`).toBe(qty);
    expect(after.legs).toHaveLength(2);
    expect(after.legs.map((l: any) => l.movement_type).sort()).toEqual([
      'replenish_receive', 'replenish_send',
    ]);
    expect(after.legs.every((l: any) => l.reference_type === 'outlet_replenishment')).toBe(true);
    expect(after.legs.every((l: any) => l.reference_id === requestId)).toBe(true);
    expect(after.legs.every((l: any) => l.reason_code === 'transferred')).toBe(true);
    const fp = await fingerprint(routeId, srcId, qty, null, `note-${label}`);
    expect(after.legs.every((l: any) => l.request_fingerprint === fp)).toBe(true);
    const send = after.legs.find((l: any) => l.movement_type === 'replenish_send');
    const recv = after.legs.find((l: any) => l.movement_type === 'replenish_receive');
    expect(Number(send.on_hand_delta)).toBe(-qty);
    expect(Number(recv.on_hand_delta)).toBe(qty);
    expect(Number(send.on_hand_delta) + Number(recv.on_hand_delta)).toBe(0);
    expect(send.correlation_id).toBe(recv.correlation_id);
    expect(after.auditN).toBe(1);
    expect(after.whMoveN).toBe(0);
    expect(after.srcQty).toBeGreaterThanOrEqual(0);
    return { routeId, srcId, requestId, result, after };
  }

  // ══ Positive matrix ═══════════════════════════════════════════════════════
  describe('positive Shape H / Shape I matrix', () => {
    it('Shape H: health_sector same-facility pharmacy → crash_cabinet (emergency)', async () => {
      await assertSuccess('H', PH_A, CAB_A, ORG_SECTOR, 3);
    });

    it('Shape I hospital: pharmacy → rescue_cart (emergency)', async () => {
      await assertSuccess('I-H-CART', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 4);
    });

    it('Shape I hospital: pharmacy → crash_cabinet (non_emergency)', async () => {
      await assertSuccess('I-H-CAB', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 2);
    });

    it('Shape I specialized_center: pharmacy → crash_cabinet (non_emergency)', async () => {
      await assertSuccess('I-S-CAB', PH_SPECIAL, CAB_SPECIAL, ORG_SPECIAL, 5);
    });
  });

  // ══ Negative matrix — zero mutation ═══════════════════════════════════════
  describe('negative matrix — zero mutation on reject', () => {
    async function expectReject(
      name: string,
      setup: () => Promise<{ routeId: string; srcId: string; dstPoint: string; qty?: number; actor?: string; requestId?: string; fefo?: string | null; notes?: string | null }>,
      pattern: RegExp,
    ) {
      const s = await setup();
      const qty = s.qty ?? 1;
      const beforeSrc = await onHand(s.srcId);
      const beforeDstId = await destStockId(s.srcId, s.dstPoint);
      const beforeDst = beforeDstId ? await onHand(beforeDstId) : 0;
      const beforeMoves = (await movementLegs(s.requestId ?? '00000000-0000-0000-0000-000000000000')).length;
      const requestId = s.requestId ?? randomUUID();
      const beforeMoveCount = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM outlet_stock_movements`));
      const beforeAudit = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.replenish'`));

      const msg = await rejects(() =>
        replenish(s.routeId, s.srcId, qty, requestId, s.fefo ?? null, s.notes ?? null, s.actor ?? rig.superAdminId));
      expect(msg, name).toMatch(pattern);

      expect(await onHand(s.srcId), `${name} SOURCE_DELTA`).toBe(beforeSrc);
      const afterDstId = await destStockId(s.srcId, s.dstPoint);
      const afterDst = afterDstId ? await onHand(afterDstId) : 0;
      // Destination may be created at 0 during a failed path only if insert
      // happened before a later reject — RPC creates dest after validation, so
      // reject-before-insert leaves no row; reject-after would be a bug.
      expect(afterDst, `${name} DESTINATION_DELTA`).toBe(beforeDst);
      const afterMoveCount = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM outlet_stock_movements`));
      expect(afterMoveCount.rows[0].n, `${name} MOVEMENT_DELTA`).toBe(beforeMoveCount.rows[0].n);
      const afterAudit = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.replenish'`));
      expect(afterAudit.rows[0].n, `${name} AUDIT_DELTA`).toBe(beforeAudit.rows[0].n);
      void beforeMoves;
    }

    it('wrong source outlet type (cabinet as source) is rejected at route upsert / movement', async () => {
      // Route upsert itself rejects non-pharmacy source; prove movement path
      // also rejects if a stale route row were forced.
      const msg = await rejects(() =>
        rig.asUser(rig.superAdminId, (c: any) =>
          call(c, 'phoenix_upsert_outlet_replenishment_route', [null, CAB_A, PH_A, true, null])));
      expect(msg).toMatch(/source_must_be_pharmacy|pharmacy/i);
    });

    it('health-center rescue_cart cannot exist to BE a destination', async () => {
      // 168 refused to route to one. R1.1/181 refuses to create one, so the
      // destination itself is now impossible — a strictly earlier refusal.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO distribution_points
          (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES ('${CART_A}','${WH_FAC_A}','${ORG_SECTOR}','A Cart168','A Cart168','rescue_cart','active','emergency')`)));
      expect(msg).toMatch(/health_center_rescue_cart_not_permitted/);
      // 168's own refusal must still be installed beneath it.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_upsert_outlet_replenishment_route'`));
      expect(rows[0].def).toContain('health_center_rescue_cart_forbidden');
    });

    /**
     * R1.2C/183 — proved at BOTH ends, exactly as the health-centre rescue cart
     * above and the sector-level outlet below already are: the illegal outlet
     * cannot be created at all, and 168's runtime refusal for it is still
     * installed. Before 183 only the second half was reachable.
     */
    const routeRpcDef = async (): Promise<string> => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_upsert_outlet_replenishment_route'`));
      return rows[0].def as string;
    };

    const refusedOutlet = (id: string, warehouse: string, org: string, type: string, kind: string) =>
      rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points
           (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,$3,'Illegal168','Illegal168',$4,'active',$5)`,
        [id, warehouse, org, type, kind])));

    it('specialized-center rescue_cart destination is rejected', async () => {
      expect(await refusedOutlet(CART_SPECIAL, WH_SPECIAL, ORG_SPECIAL, 'rescue_cart', 'emergency'))
        .toMatch(/specialized_center_rescue_cart_not_permitted/);
      expect(await routeRpcDef()).toContain('rescue_cart_requires_hospital');
    });

    it('hospital rescue_cart with wrong clinical kind is rejected', async () => {
      expect(await refusedOutlet(CART_HOSP_NON, WH_HOSPITAL, ORG_HOSPITAL, 'rescue_cart', 'non_emergency'))
        .toMatch(/rescue_cart_requires_emergency_context/);
      expect(await routeRpcDef()).toContain('rescue_cart_requires_emergency_context');
    });

    it('hospital crash_cabinet with wrong clinical kind is rejected', async () => {
      expect(await refusedOutlet(CAB_HOSP_EM, WH_HOSPITAL, ORG_HOSPITAL, 'crash_cabinet', 'emergency'))
        .toMatch(/crash_cabinet_requires_non_emergency_context/);
      expect(await routeRpcDef()).toContain('crash_cabinet_requires_non_emergency_context');
    });

    it('Shape-H cross-facility is rejected', async () => {
      const msg = await rejects(() =>
        rig.asUser(rig.superAdminId, (c: any) =>
          call(c, 'phoenix_upsert_outlet_replenishment_route', [null, PH_A, CAB_B, true, null])));
      expect(msg).toMatch(/cross_facility_route_forbidden/);
    });

    it('Shape-H sector-level outlet cannot be created to masquerade at all', async () => {
      // Pre-181 a sector-level outlet existed and was refused a route. 181
      // refuses the outlet, so the masquerade has no subject. Both ends proved.
      for (const [id, type, kind] of [
        [PH_SECTOR, 'pharmacy', 'non_emergency'],
        [CAB_SECTOR, 'crash_cabinet', 'emergency'],
      ] as const) {
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `INSERT INTO distribution_points
             (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,$3,'Sector Outlet168','Sector Outlet168',$4,'active',$5)`,
          [id, WH_SECTOR, ORG_SECTOR, type, kind])));
        expect(msg, type).toMatch(/health_sector_outlet_requires_health_center_depot/);
      }
      // Shape H's own facility requirement must still be installed beneath it.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_upsert_outlet_replenishment_route'`));
      expect(rows[0].def).toContain('health_center_route_requires_facility');
    });

    it('inactive route rejects movement with zero mutation', async () => {
      await expectReject('inactive_route', async () => {
        const routeId = await upsertRoute(PH_A, CAB_A, true);
        await rig.asAdmin((c: any) =>
          c.query(`UPDATE outlet_replenishment_routes SET is_active=false WHERE id=$1`, [routeId]));
        const srcId = await seedPharmacyStock({
          org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-INA'), qty: 10,
        });
        return { routeId, srcId, dstPoint: CAB_A };
      }, /route_not_active/);
    });

    it('inactive source rejects with zero mutation', async () => {
      await expectReject('inactive_source', async () => {
        const routeId = await upsertRoute(PH_A, CAB_A, true);
        const srcId = await seedPharmacyStock({
          org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-ISRC'), qty: 10,
        });
        await rig.asAdmin((c: any) =>
          c.query(`UPDATE distribution_points SET status='inactive' WHERE id=$1`, [PH_A]));
        return { routeId, srcId, dstPoint: CAB_A };
      }, /source_outlet_inactive/);
      await rig.asAdmin((c: any) =>
        c.query(`UPDATE distribution_points SET status='active' WHERE id=$1`, [PH_A]));
    });

    it('inactive destination rejects with zero mutation', async () => {
      await expectReject('inactive_dest', async () => {
        const routeId = await upsertRoute(PH_A, CAB_A, true);
        const srcId = await seedPharmacyStock({
          org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-IDST'), qty: 10,
        });
        await rig.asAdmin((c: any) =>
          c.query(`UPDATE distribution_points SET status='inactive' WHERE id=$1`, [CAB_A]));
        return { routeId, srcId, dstPoint: CAB_A };
      }, /destination_outlet_inactive/);
      await rig.asAdmin((c: any) =>
        c.query(`UPDATE distribution_points SET status='active' WHERE id=$1`, [CAB_A]));
    });

    it('R1.1 prevents a facility becoming inactive underneath a live depot', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE organization_facilities SET status='inactive' WHERE id=$1`, [FAC_INACTIVE])));
      expect(msg).toMatch(/health_center_facility_change_blocked_by_active_depot/);
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT status FROM organization_facilities WHERE id=$1`, [FAC_INACTIVE]));
      expect(rows[0].status).toBe('active');
    });

    it('insufficient / zero / negative quantity reject with zero mutation', async () => {
      const routeId = await upsertRoute(PH_A, CAB_A, true);
      const srcId = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-QTY'), qty: 2,
      });
      const before = await onHand(srcId);
      expect(await rejects(() => replenish(routeId, srcId, 5))).toMatch(/insufficient_source_stock/);
      expect(await rejects(() => replenish(routeId, srcId, 0))).toMatch(/quantity_must_be_positive/);
      expect(await rejects(() => replenish(routeId, srcId, -1))).toMatch(/quantity_must_be_positive/);
      expect(await onHand(srcId)).toBe(before);
    });

    it('unauthorized caller cannot execute', async () => {
      await expectReject('unauthorized', async () => {
        const routeId = await upsertRoute(PH_HOSP, CART_HOSP, true);
        const srcId = await seedPharmacyStock({
          org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-RBAC'), qty: 10,
        });
        return { routeId, srcId, dstPoint: CART_HOSP, actor: NOBODY };
      }, /forbidden_outlet_stock_replenish/);
    });
  });

  // ══ Movement-time revalidation ════════════════════════════════════════════
  describe('movement-time route revalidation', () => {
    /**
     * R1.2C/183 — these two cases manufactured their drift by mutating a LIVE
     * outlet's clinical context into an illegal one. 183 refuses exactly that
     * write, so the drift can no longer be injected there — the same situation
     * the Shape-H case below already handles by injecting drift where it can
     * still legitimately occur.
     *
     * Both are therefore proved at both ends: the illegal mutation is refused
     * outright (the stronger guarantee — an ACTIVE outlet can never hold an
     * illegal context at all), and 168's movement-time refusal for it is still
     * installed. The movement path's re-derivation from LIVE topology stays
     * exercised for real by the two tests that follow.
     */
    it('a routed crash cabinet can no longer DRIFT into an emergency context', async () => {
      const routeId = await upsertRoute(PH_HOSP, CAB_HOSP, true);
      expect(routeId).toBeTruthy();
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET clinical_location_kind='emergency' WHERE id=$1`, [CAB_HOSP])));
      expect(msg).toMatch(/crash_cabinet_requires_non_emergency_context/);
      // The row is untouched, so the route it carries stays valid.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT clinical_location_kind FROM distribution_points WHERE id=$1`, [CAB_HOSP]));
      expect(rows[0].clinical_location_kind).toBe('non_emergency');
      expect(await replenishRpcDef()).toContain('crash_cabinet_requires_non_emergency_context');
    });

    it('a routed rescue cart can no longer DRIFT out of its emergency context', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP, true);
      expect(routeId).toBeTruthy();
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET clinical_location_kind='non_emergency' WHERE id=$1`,
        [CART_HOSP])));
      expect(msg).toMatch(/rescue_cart_requires_emergency_context/);
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT clinical_location_kind FROM distribution_points WHERE id=$1`, [CART_HOSP]));
      expect(rows[0].clinical_location_kind).toBe('emergency');
      expect(await replenishRpcDef()).toContain('rescue_cart_requires_emergency_context');
    });

    it('movement-time revalidation is still LIVE — a destination deactivated after routing is refused', async () => {
      // The property the two cases above used to carry: the corridor re-reads
      // the destination at MOVEMENT time and does not trust the stored route.
      // Proved with a drift 183 permits — deactivation is always legal — so the
      // revalidation itself remains exercised against a real mutation.
      const routeId = await upsertRoute(PH_HOSP, CAB_HOSP, true);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-CLK'), qty: 10,
      });
      const before = await onHand(srcId);
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET status='inactive' WHERE id=$1`, [CAB_HOSP]));
      try {
        const msg = await rejects(() => replenish(routeId, srcId, 1));
        expect(msg).toMatch(/destination_outlet_inactive/);
        expect(await onHand(srcId)).toBe(before);   // fail-closed: nothing moved
      } finally {
        await rig.asAdmin((c: any) => c.query(
          `UPDATE distribution_points SET status='active' WHERE id=$1`, [CAB_HOSP]));
      }
    });

    it('rejects Shape-H when the stored route no longer matches the live facts', async () => {
      // Pre-181 this drift was manufactured by MOVING CAB_A onto centre B's
      // depot. R1.1/181 forbids exactly that move once the outlet owns any
      // operational dependency (asserted in the next test), so the drift is
      // injected where it can still legitimately occur: straight into the
      // route table, which carries no shape trigger of its own. That is the
      // stronger framing anyway — it proves the movement path re-derives
      // Shape H from the LIVE topology instead of trusting the stored route,
      // and it mutates no topology at all.
      //
      // CAB_B is DECOMMISSIONED for the duration so the assertion also proves
      // the ordering Migration 180's verify block states: the Shape H/I matrix
      // is evaluated BEFORE the initial-first gate, so a cross-facility route
      // fails with its own accurate diagnosis rather than a lifecycle error.
      const srcId = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-FACREL'), qty: 10,
      });
      await decommission(CAB_B);
      // One ACTIVE route per source pharmacy: park PH_A's before forcing one.
      await rig.asAdmin((c: any) => c.query(
        `UPDATE outlet_replenishment_routes SET is_active=false WHERE source_point_id=$1`, [PH_A]));
      const forced = await rig.asAdmin((c: any) => c.query(
        `INSERT INTO outlet_replenishment_routes
           (organization_id, source_point_id, destination_point_id,
            source_point_type, destination_point_type, is_active)
         VALUES ($1,$2,$3,'pharmacy','crash_cabinet',true) RETURNING id`,
        [ORG_SECTOR, PH_A, CAB_B]));
      const routeId = forced.rows[0].id;
      const before = await onHand(srcId);
      const msg = await rejects(() => replenish(routeId, srcId, 1));
      expect(msg).toMatch(/cross_facility_route_forbidden/);
      expect(await onHand(srcId)).toBe(before);
      await rig.asAdmin((c: any) => c.query(
        `DELETE FROM outlet_replenishment_routes WHERE id=$1`, [routeId]));
      await commission(CAB_B);
    });

    it('R1.1/181 closes the old drift vector: the outlet cannot be re-pointed', async () => {
      // CAB_A owns a commissioning dispatch, routes and movement history by
      // now. Moving it to another centre's depot would re-parent all of it.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [WH_FAC_B, CAB_A])));
      expect(msg).toMatch(/outlet_cross_center_reassignment_blocked_operational_dependency/);
      const still = await rig.asAdmin((c: any) => c.query(
        `SELECT warehouse_id FROM distribution_points WHERE id=$1`, [CAB_A]));
      expect(still.rows[0].warehouse_id).toBe(WH_FAC_A);
    });
  });

  // ══ Idempotency / fingerprint ═════════════════════════════════════════════
  describe('idempotency and fingerprint conflict', () => {
    it('same request_id + same payload replays safely without second debit', async () => {
      const routeId = await upsertRoute(PH_A, CAB_A, true);
      const srcId = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-IDEM'), qty: 20,
      });
      const requestId = randomUUID();
      const first = await replenish(routeId, srcId, 3, requestId, null, 'idem');
      const midSrc = await onHand(srcId);
      const midLegs = await movementLegs(requestId);
      const second = await replenish(routeId, srcId, 3, requestId, null, 'idem');
      expect(second.ok).toBe(true);
      expect(second.idempotent_replay).toBe(true);
      expect(second.send_movement_id).toBe(first.send_movement_id);
      expect(await onHand(srcId)).toBe(midSrc);
      expect(await movementLegs(requestId)).toHaveLength(midLegs.length);
    });

    it('same request_id + changed quantity/source/destination/material conflicts with zero mutation', async () => {
      const routeId = await upsertRoute(PH_A, CAB_A, true);
      const srcId = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-CONF'), qty: 20,
      });
      const other = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-CONF2'), qty: 20,
      });
      const requestId = randomUUID();
      await replenish(routeId, srcId, 2, requestId, null, 'c');
      const after = await onHand(srcId);
      expect(await rejects(() => replenish(routeId, srcId, 3, requestId, null, 'c')))
        .toMatch(/request_id_conflict/);
      expect(await rejects(() => replenish(routeId, other, 2, requestId, null, 'c')))
        .toMatch(/request_id_conflict/);
      expect(await onHand(srcId)).toBe(after);
      expect(await movementLegs(requestId)).toHaveLength(2);
    });
  });

  // ══ Concurrency ═══════════════════════════════════════════════════════════
  describe('concurrency', () => {
    it('two concurrent identical requests do not double debit/credit', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP, true);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-CONC'), qty: 10,
      });
      const requestId = randomUUID();
      const attempt = () =>
        replenish(routeId, srcId, 4, requestId, null, 'conc')
          .then((r) => ({ ok: true as const, r }))
          .catch((e: any) => ({ ok: false as const, msg: String(e.message) }));

      const [a, b] = await Promise.all([attempt(), attempt()]);
      expect(a.ok || b.ok).toBe(true);
      // Winner + safe replay, or one conflict if timing races past probe — never
      // two mutations.
      expect(await onHand(srcId)).toBe(6);
      expect(await movementLegs(requestId)).toHaveLength(2);
    });

    it('competing different requests against limited stock never go negative', async () => {
      const routeId = await upsertRoute(PH_HOSP, CAB_HOSP, true);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-RACE'), qty: 5,
      });
      const attempt = () =>
        replenish(routeId, srcId, 4, randomUUID(), null, 'race')
          .then(() => 'ok')
          .catch((e: any) => String(e.message));
      const results = await Promise.all([attempt(), attempt()]);
      const wins = results.filter(r => r === 'ok').length;
      expect(wins).toBe(1);
      expect(results.some(r => /insufficient_source_stock|outlet_quantity_cannot_go_negative/.test(r))).toBe(true);
      const finalQty = await onHand(srcId);
      expect(finalQty).toBeGreaterThanOrEqual(0);
      expect(finalQty).toBe(1);
    });
  });

  // ══ FEFO / material identity ══════════════════════════════════════════════
  describe('FEFO and material identity', () => {
    it('requires FEFO override when a newer batch is chosen over an older one', async () => {
      const routeId = await upsertRoute(PH_A, CAB_A, true);
      const sci = uniq('SCI-FEFO');
      const older = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci, qty: 10, batch: 'OLD', expiryDays: 30,
      });
      const newer = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci, qty: 10, batch: 'NEW', expiryDays: 300,
      });
      const beforeOld = await onHand(older);
      const beforeNew = await onHand(newer);
      const msg = await rejects(() => replenish(routeId, newer, 1, randomUUID(), null, null));
      expect(msg).toMatch(/fefo_override_required/);
      expect(await onHand(older)).toBe(beforeOld);
      expect(await onHand(newer)).toBe(beforeNew);

      // Choosing the FEFO-first (older) batch succeeds without override.
      const ok = await replenish(routeId, older, 1, randomUUID(), null, null);
      expect(ok.ok).toBe(true);
      expect(await onHand(older)).toBe(beforeOld - 1);
    });

    it('copies supply_type / purchase_origin onto the destination identity', async () => {
      const routeId = await upsertRoute(PH_SPECIAL, CAB_SPECIAL, true);
      const srcId = await seedPharmacyStock({
        org: ORG_SPECIAL, pharmacy: PH_SPECIAL, sci: uniq('SCI-PROV'), qty: 8,
        supplyType: 'purchase', purchaseOrigin: 'supplementary',
      });
      const requestId = randomUUID();
      await replenish(routeId, srcId, 2, requestId);
      const dstId = await destStockId(srcId, CAB_SPECIAL);
      const row = await rig.asAdmin((c: any) => c.query(
        `SELECT supply_type, purchase_origin FROM outlet_stock WHERE id=$1`, [dstId]));
      expect(row.rows[0].supply_type).toBe('purchase');
      expect(row.rows[0].purchase_origin).toBe('supplementary');
    });
  });

  // ══ Canonical material identity isolation (independent review, PR #109) ═══
  // Migration 150 makes material_identity_key — generated from central_item_id,
  // scientific_name, national_code, concentration, dosage_form, unit — the
  // canonical material boundary. outlet_stock_identity_v150_uniq therefore
  // permits two destination rows to legitimately coexist at the SAME
  // distribution_point_id with the SAME lot/provenance tuple when their
  // material_identity_key differs. A destination resolution that only
  // compares scientific_name / national_code / concentration / dosage_form
  // (omitting central_item_id and unit) can match the WRONG variant. These
  // regressions plant a different canonical variant at the destination ONLY
  // (never the source — the source-side FEFO helper fails closed with
  // material_identity_ambiguous on its own if a collision were placed there,
  // which is out of scope for this destination-credit correction).
  describe('canonical material identity isolation at the destination (PR #109)', () => {
    it('UNIT_VARIANT_DYNAMIC_PROOF: a same-lot destination row differing only by unit is never credited', async () => {
      const routeId = await upsertRoute(PH_A, CAB_A, true);
      const sci = uniq('SCI-MATID-UNIT');
      const batch = uniq('BMATID-UNIT');
      const expiryDays = 200;
      const supplyType = 'aid';
      const purchaseOrigin: string | null = null;

      // Variant A — the real source identity (unit = box).
      const srcId = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci, qty: 10, batch, expiryDays,
        supplyType, purchaseOrigin, unit: 'box',
      });

      // Variant B — pre-existing DIFFERENT canonical material at the SAME
      // destination point, with the SAME scientific_name / national_code /
      // concentration / dosage_form / batch / expiry / internal_batch_reference
      // / supply_type / purchase_origin, differing only by unit. Migration 150
      // allows both to coexist because material_identity_key differs.
      const wrongVariantId = await seedDestinationStock({
        org: ORG_SECTOR, point: CAB_A, pointType: 'crash_cabinet', sci,
        unit: 'strip', batch, expiryDays, qty: 7, supplyType, purchaseOrigin,
      });

      const requestId = randomUUID();
      const qty = 3;
      const result = await replenish(routeId, srcId, qty, requestId, null, 'unit-variant');
      expect(result.ok, 'UNIT_VARIANT_DYNAMIC_PROOF').toBe(true);
      expect(result.idempotent_replay).toBe(false);

      const correctDestId = await destStockId(srcId, CAB_A);
      expect(correctDestId).toBeTruthy();
      expect(correctDestId).not.toBe(wrongVariantId);
      expect(result.destination_outlet_stock_id).toBe(correctDestId);

      // Source A debited exactly the requested quantity.
      expect(await onHand(srcId)).toBe(10 - qty);
      // Destination A (exact material_identity_key) credited exactly qty.
      expect(await onHand(correctDestId!)).toBe(qty);
      // WRONG_VARIANT_DESTINATION_DELTA = 0
      expect(await onHand(wrongVariantId)).toBe(7);

      const legs = await movementLegs(requestId);
      expect(legs).toHaveLength(2);
      const send = legs.find((l: any) => l.movement_type === 'replenish_send');
      const recv = legs.find((l: any) => l.movement_type === 'replenish_receive');
      expect(send.outlet_stock_id).toBe(srcId);
      // RECEIVE_MOVEMENT_EXACT_DESTINATION_RESULT
      expect(recv.outlet_stock_id).toBe(correctDestId);
      expect(recv.outlet_stock_id).not.toBe(wrongVariantId);
      expect(Number(send.on_hand_delta) + Number(recv.on_hand_delta)).toBe(0);

      // AUDIT_EXACT_DESTINATION_RESULT
      const audit = await rig.asAdmin((c: any) => c.query(`
        SELECT payload->>'destination_outlet_stock_id' AS dst
        FROM audit_logs
        WHERE action='outlet_stock.replenish' AND payload->>'request_id'=$1
      `, [requestId]));
      expect(audit.rows[0].dst).toBe(correctDestId);
      expect(audit.rows[0].dst).not.toBe(wrongVariantId);
    });

    it('a same-lot, same-unit destination row differing only by central_item_id is never credited', async () => {
      const routeId = await upsertRoute(PH_SPECIAL, CAB_SPECIAL, true);
      const sci = uniq('SCI-MATID-CENTRAL');
      const batch = uniq('BMATID-CENTRAL');
      const expiryDays = 180;
      const supplyType = 'aid';
      const purchaseOrigin: string | null = null;

      const centralA = randomUUID();
      const centralB = randomUUID();
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO central_items (id, name, name_ar) VALUES
          ($1, 'Central A 168', 'Central A 168'),
          ($2, 'Central B 168', 'Central B 168')
      `, [centralA, centralB]));

      // Source pharmacy stock's canonical identity is pinned to centralA.
      const srcId = await seedPharmacyStock({
        org: ORG_SPECIAL, pharmacy: PH_SPECIAL, sci, qty: 10, batch, expiryDays,
        supplyType, purchaseOrigin, centralItemId: centralA,
      });

      // Pre-existing destination variant pinned to centralB — identical in
      // every other lot/provenance field, including unit.
      const wrongVariantId = await seedDestinationStock({
        org: ORG_SPECIAL, point: CAB_SPECIAL, pointType: 'crash_cabinet', sci,
        batch, expiryDays, qty: 9, supplyType, purchaseOrigin,
        centralItemId: centralB,
      });

      const requestId = randomUUID();
      const qty = 2;
      const result = await replenish(routeId, srcId, qty, requestId, null, 'central-variant');
      expect(result.ok).toBe(true);

      const correctDestId = await destStockId(srcId, CAB_SPECIAL);
      expect(correctDestId).toBeTruthy();
      expect(correctDestId).not.toBe(wrongVariantId);
      expect(result.destination_outlet_stock_id).toBe(correctDestId);

      expect(await onHand(srcId)).toBe(10 - qty);
      expect(await onHand(correctDestId!)).toBe(qty);
      expect(await onHand(wrongVariantId)).toBe(9);

      const legs = await movementLegs(requestId);
      const recv = legs.find((l: any) => l.movement_type === 'replenish_receive');
      expect(recv.outlet_stock_id).toBe(correctDestId);
      expect(recv.outlet_stock_id).not.toBe(wrongVariantId);

      const destRow = await rig.asAdmin((c: any) => c.query(
        `SELECT central_item_id FROM outlet_stock WHERE id=$1`, [correctDestId]));
      expect(destRow.rows[0].central_item_id).toBe(centralA);
    });
  });

  // ══ Fingerprint / unique constraint ═══════════════════════════════════════
  describe('fingerprint CHECK and once-unique index', () => {
    it('rejects invalid / wrong-length fingerprints on the replenishment namespace', async () => {
      const srcId = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-FP'), qty: 5,
      });
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO outlet_stock_movements (
          outlet_stock_id, organization_id, distribution_point_id, movement_type,
          on_hand_before, on_hand_delta, on_hand_after,
          reserved_before, reserved_delta, reserved_after,
          reason_code, reference_type, reference_id, request_fingerprint,
          scientific_name_snapshot
        ) VALUES (
          $1,'${ORG_SECTOR}','${PH_A}','replenish_send',
          5,-1,4,0,0,0,
          'transferred','outlet_replenishment',$2,'not-a-hex-fingerprint',
          'x'
        )
      `, [srcId, randomUUID()])));
      expect(msg).toMatch(/osm_replenishment_fingerprint_chk/);
    });

    it('permits one send + one receive and rejects duplicate legs', async () => {
      const routeId = await upsertRoute(PH_A, CAB_A, true);
      const srcId = await seedPharmacyStock({
        org: ORG_SECTOR, pharmacy: PH_A, sci: uniq('SCI-ONCE'), qty: 10,
      });
      const requestId = randomUUID();
      await replenish(routeId, srcId, 1, requestId);
      const legs = await movementLegs(requestId);
      expect(legs).toHaveLength(2);
      const fp = legs[0].request_fingerprint;
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO outlet_stock_movements (
          outlet_stock_id, organization_id, distribution_point_id, movement_type,
          on_hand_before, on_hand_delta, on_hand_after,
          reserved_before, reserved_delta, reserved_after,
          reason_code, reference_type, reference_id, request_fingerprint,
          scientific_name_snapshot
        ) VALUES (
          $1,'${ORG_SECTOR}','${PH_A}','replenish_send',
          1,-1,0,0,0,0,
          'transferred','outlet_replenishment',$2,$3,'x'
        )
      `, [srcId, requestId, fp])));
      expect(msg).toMatch(/outlet_stock_movements_replenishment_once_uniq|duplicate key/i);
    });
  });

  // ══ RBAC / helper revoke ══════════════════════════════════════════════════
  describe('RBAC and helper exposure', () => {
    it('helper EXECUTE is revoked from authenticated', async () => {
      const r = await rig.asAdmin((c: any) => c.query(`
        SELECT has_function_privilege(
          'authenticated',
          'public._phoenix_replenishment_fingerprint_v1(uuid,uuid,integer,text,text)',
          'EXECUTE'
        ) AS allowed
      `));
      expect(r.rows[0].allowed).toBe(false);
    });

    it('authenticated without permission cannot call the RPC', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP, true);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-NO'), qty: 5,
      });
      const before = await onHand(srcId);
      const msg = await rejects(() => replenish(routeId, srcId, 1, randomUUID(), null, null, NOBODY));
      expect(msg).toMatch(/forbidden_outlet_stock_replenish/);
      expect(await onHand(srcId)).toBe(before);
    });
  });

  // ══ Replay authorization (independent review finding, PR #109) ═════════════
  // Every successful return from the SECURITY DEFINER RPC — INCLUDING
  // idempotent_replay = true — must re-prove an active profile holding
  // outlet_stock.replenish. A matching request_id must never leak operation
  // details or success semantics to an unauthorized caller.
  describe('replay authorization — idempotent replay never bypasses RBAC', () => {
    async function totalAudits(): Promise<number> {
      const r = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.replenish'`));
      return r.rows[0].n;
    }

    it('CASE A: unauthorized fresh request is rejected with zero mutation', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP, true);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-RA-A'), qty: 8,
      });
      const requestId = randomUUID();
      const before = await snapshots(srcId, CART_HOSP, requestId);
      const auditsBefore = await totalAudits();
      const msg = await rejects(() =>
        replenish(routeId, srcId, 2, requestId, null, null, NOBODY));
      expect(msg).toMatch(/forbidden_outlet_stock_replenish/);
      const after = await snapshots(srcId, CART_HOSP, requestId);
      expect(after.srcQty).toBe(before.srcQty);
      expect(after.dstQty).toBe(before.dstQty);
      expect(after.legs).toHaveLength(0);
      expect(await totalAudits()).toBe(auditsBefore);
    });

    it('CASE B: unauthorized replay of an existing request is rejected — no details, no mutation', async () => {
      // 1. Authorized caller performs a valid replenishment.
      const { routeId, srcId, requestId } =
        await assertSuccess('RA-B', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 3);
      const srcAfterSuccess = await onHand(srcId);
      const dstId = await destStockId(srcId, CART_HOSP);
      const dstAfterSuccess = await onHand(dstId!);
      const legsAfterSuccess = await movementLegs(requestId);
      const auditsAfterSuccess = await totalAudits();

      // 2. A different authenticated user WITHOUT outlet_stock.replenish
      //    replays the exact same request_id + exact same payload.
      const msg = await rejects(() =>
        replenish(routeId, srcId, 3, requestId, null, 'note-RA-B', NOBODY));

      // 3. Authorization error — never an idempotent_replay success, and no
      //    operation details disclosed as a successful response.
      expect(msg).toMatch(/forbidden_outlet_stock_replenish/);
      expect(msg).not.toMatch(/idempotent_replay/);
      expect(msg).not.toMatch(/movement_id/);

      // Zero new mutations of any kind.
      expect(await onHand(srcId)).toBe(srcAfterSuccess);
      expect(await onHand(dstId!)).toBe(dstAfterSuccess);
      expect(await movementLegs(requestId)).toHaveLength(legsAfterSuccess.length);
      expect(await totalAudits()).toBe(auditsAfterSuccess);
    });

    it('CASE C: inactive-profile replay is rejected with zero mutation', async () => {
      const { routeId, srcId, requestId } =
        await assertSuccess('RA-C', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 2);
      const srcAfterSuccess = await onHand(srcId);
      const legsAfterSuccess = await movementLegs(requestId);
      const auditsAfterSuccess = await totalAudits();

      const msg = await rejects(() =>
        replenish(routeId, srcId, 2, requestId, null, 'note-RA-C', SLEEPER));
      expect(msg).toMatch(/active_profile_required/);

      expect(await onHand(srcId)).toBe(srcAfterSuccess);
      expect(await movementLegs(requestId)).toHaveLength(legsAfterSuccess.length);
      expect(await totalAudits()).toBe(auditsAfterSuccess);
    });

    it('CASE D: authorized exact replay still returns the canonical safe replay', async () => {
      const { routeId, srcId, requestId, result } =
        await assertSuccess('RA-D', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 4);
      const srcAfterSuccess = await onHand(srcId);
      const dstId = await destStockId(srcId, CART_HOSP);
      const dstAfterSuccess = await onHand(dstId!);
      const legsAfterSuccess = await movementLegs(requestId);
      const auditsAfterSuccess = await totalAudits();

      const replay = await replenish(routeId, srcId, 4, requestId, null, 'note-RA-D');
      expect(replay.ok).toBe(true);
      expect(replay.idempotent_replay).toBe(true);
      expect(replay.send_movement_id).toBe(result.send_movement_id);
      expect(replay.receive_movement_id).toBe(result.receive_movement_id);
      expect(replay.quantity).toBe(4);

      // AUTHORIZED_REPLAY_STOCK_DELTA = 0
      expect(await onHand(srcId)).toBe(srcAfterSuccess);
      expect(await onHand(dstId!)).toBe(dstAfterSuccess);
      // AUTHORIZED_REPLAY_MOVEMENT_DELTA = 0
      expect(await movementLegs(requestId)).toHaveLength(legsAfterSuccess.length);
      // AUTHORIZED_REPLAY_AUDIT_DELTA = 0
      expect(await totalAudits()).toBe(auditsAfterSuccess);
    });
  });

  // ══ E-4 / 167 non-interference ════════════════════════════════════════════
  describe('E-4 and Migration-167 non-interference', () => {
    it('successful E-5 movement does not create IP dispatches or flip IP flags', async () => {
      const beforeIp = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int n FROM warehouse_dispatches WHERE is_initial_provisioning IS TRUE
      `));
      await assertSuccess('E4NI', PH_A, CAB_A, ORG_SECTOR, 1);
      const afterIp = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int n FROM warehouse_dispatches WHERE is_initial_provisioning IS TRUE
      `));
      expect(afterIp.rows[0].n).toBe(beforeIp.rows[0].n);
    });

    it('warehouse_dispatch_lines_decision_chk still requires rejected ⇒ received_quantity = 0', async () => {
      const def = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_constraintdef(oid) AS d
        FROM pg_constraint WHERE conname='warehouse_dispatch_lines_decision_chk'
      `));
      expect(def.rows[0].d).toMatch(/received_quantity IS NOT NULL/);
      expect(def.rows[0].d).toMatch(/received_quantity = 0/);
    });
  });

  // ══ Schema objects present ════════════════════════════════════════════════
  describe('migration objects present after replay', () => {
    it('exposes the public RPC and fingerprint helper with expected grants', async () => {
      // This suite drives the full effective chain on disk (buildRig()), which
      // now includes 169 (E-6). The reversal RPC is therefore expected to be
      // present — that reflects the tip advancing, not a 168 behaviour change.
      // 168's OWN static suite is what proves 168 itself does not implement E-6.
      const r = await rig.asAdmin((c: any) => c.query(`
        SELECT
          to_regprocedure('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)') IS NOT NULL AS rpc,
          to_regprocedure('public._phoenix_replenishment_fingerprint_v1(uuid,uuid,integer,text,text)') IS NOT NULL AS helper,
          has_function_privilege('authenticated',
            'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)', 'EXECUTE') AS rpc_grant,
          to_regprocedure('public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)') IS NOT NULL AS reverse_present
      `));
      expect(r.rows[0].rpc).toBe(true);
      expect(r.rows[0].helper).toBe(true);
      expect(r.rows[0].rpc_grant).toBe(true);
      expect(r.rows[0].reverse_present).toBe(true);
    });
  });
});
