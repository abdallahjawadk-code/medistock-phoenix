/**
 * 169 · OUTLET REPLENISHMENT REVERSAL (Stage E · E-6) — dynamic proof.
 *
 * Builds a disposable Postgres through the full effective migration chain and
 * drives the REAL phoenix_reverse_outlet_replenishment RPC and
 * phoenix_outlet_replenishment_reversible_batches helper against every
 * authoritative E-5 route shape, negatives, movement-time revalidation,
 * idempotency, concurrency, material identity, RBAC authorize-before-replay,
 * 071 generic-return isolation, and E-4/E-5/167 non-interference.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;

// ── Fixture ids ──────────────────────────────────────────────────────────────
const ORG_SECTOR = '00000000-0000-0000-0000-000000169001';
const ORG_HOSPITAL = '00000000-0000-0000-0000-000000169002';
const ORG_SPECIAL = '00000000-0000-0000-0000-000000169003';
const ORG_SECTOR_2 = '00000000-0000-0000-0000-000000169004';

const FAC_A = '00000000-0000-0000-0000-000000169101';

const WH_FAC_A = '00000000-0000-0000-0000-000000169201';
const WH_HOSPITAL = '00000000-0000-0000-0000-000000169202';
const WH_SPECIAL = '00000000-0000-0000-0000-000000169203';
const WH_SECTOR_2 = '00000000-0000-0000-0000-000000169204';

const PH_A = '00000000-0000-0000-0000-000000169301';
const CAB_A = '00000000-0000-0000-0000-000000169302';
const PH_HOSP = '00000000-0000-0000-0000-000000169303';
const CART_HOSP = '00000000-0000-0000-0000-000000169304';
const CAB_HOSP = '00000000-0000-0000-0000-000000169305';
const PH_SPECIAL = '00000000-0000-0000-0000-000000169306';
const CAB_SPECIAL = '00000000-0000-0000-0000-000000169307';
const PH_SECTOR_2 = '00000000-0000-0000-0000-000000169308';
const CAB_SECTOR_2 = '00000000-0000-0000-0000-000000169309';

const NOBODY = '00000000-0000-0000-0000-000000169901';
const SLEEPER = '00000000-0000-0000-0000-000000169902';
const NO_REVERSE_PERM = '00000000-0000-0000-0000-000000169903';

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

run('169 · outlet replenishment reversal (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const reversalFingerprint = async (
    routeId: string,
    destinationStockId: string,
    quantity: number,
    reason: string | null,
    notes: string | null,
  ) => {
    const r = await rig.asAdmin((c: any) => c.query(
      `SELECT encode(sha256(convert_to(jsonb_build_object(
         'operation', 'reverse_outlet_replenishment',
         'route_id', $1::uuid,
         'destination_outlet_stock_id', $2::uuid,
         'quantity', $3::int,
         'reason', $4::text,
         'notes', $5::text
       )::text, 'UTF8')), 'hex') AS fp`,
      [
        routeId, destinationStockId, quantity,
        reason == null || reason.trim() === '' ? null : reason.trim(),
        notes == null || notes.trim() === '' ? null : notes.trim(),
      ],
    ));
    return r.rows[0].fp as string;
  };

  beforeAll(async () => {
    rig = await buildRig();

    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES
        ('${ORG_SECTOR}','Sector169','Sector169','p169-sector','health_sector'),
        ('${ORG_HOSPITAL}','Hospital169','Hospital169','p169-hospital','hospital'),
        ('${ORG_SPECIAL}','Special169','Special169','p169-special','specialized_center'),
        ('${ORG_SECTOR_2}','Sector169b','Sector169b','p169-sector2','hospital');

      INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}','primary_health_center','Centre A169','Centre A169','active');

      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id) VALUES
        ('${WH_FAC_A}','${ORG_SECTOR}','A Depot169','A Depot169','active','institution','p169-wh-a','${FAC_A}'),
        ('${WH_HOSPITAL}','${ORG_HOSPITAL}','Hosp Depot169','Hosp Depot169','active','institution','p169-wh-hosp',NULL),
        ('${WH_SPECIAL}','${ORG_SPECIAL}','Ctr Depot169','Ctr Depot169','active','institution','p169-wh-ctr',NULL),
        ('${WH_SECTOR_2}','${ORG_SECTOR_2}','Sector2 Depot169','Sector2 Depot169','active','institution','p169-wh-s2',NULL);

      INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PH_A}','${WH_FAC_A}','${ORG_SECTOR}','A Pharmacy169','A Pharmacy169','pharmacy','active','non_emergency'),
        ('${CAB_A}','${WH_FAC_A}','${ORG_SECTOR}','A Cabinet169','A Cabinet169','crash_cabinet','active','emergency'),
        ('${PH_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Pharmacy169','H Pharmacy169','pharmacy','active','non_emergency'),
        ('${CART_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cart169','H Cart169','rescue_cart','active','emergency'),
        ('${CAB_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cabinet169','H Cabinet169','crash_cabinet','active','non_emergency'),
        ('${PH_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Pharmacy169','C Pharmacy169','pharmacy','active','non_emergency'),
        ('${CAB_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Cabinet169','C Cabinet169','crash_cabinet','active','non_emergency'),
        ('${PH_SECTOR_2}','${WH_SECTOR_2}','${ORG_SECTOR_2}','S2 Pharmacy169','S2 Pharmacy169','pharmacy','active','non_emergency'),
        ('${CAB_SECTOR_2}','${WH_SECTOR_2}','${ORG_SECTOR_2}','S2 Cabinet169','S2 Cabinet169','crash_cabinet','active','non_emergency');

      INSERT INTO auth.users (id, email) VALUES ('${NOBODY}', 'nobody169@rig.test')
      ON CONFLICT (id) DO NOTHING;
      UPDATE profiles
         SET role='outlet_officer', status='active', organization_id='${ORG_HOSPITAL}'
       WHERE id='${NOBODY}';

      INSERT INTO auth.users (id, email) VALUES ('${SLEEPER}', 'sleeper169@rig.test')
      ON CONFLICT (id) DO NOTHING;
      UPDATE profiles
         SET role='outlet_officer', status='suspended', organization_id='${ORG_HOSPITAL}'
       WHERE id='${SLEEPER}';

      INSERT INTO auth.users (id, email) VALUES ('${NO_REVERSE_PERM}', 'noreverse169@rig.test')
      ON CONFLICT (id) DO NOTHING;
      UPDATE profiles
         SET role='outlet_officer', status='active', organization_id='${ORG_HOSPITAL}'
       WHERE id='${NO_REVERSE_PERM}';

      -- R1.2 / Migration 180: a FRESH routine replenishment now requires the
      -- destination emergency outlet to have CONSUMED an initial-provisioning
      -- lifecycle. This suite reverses replenishments, so every scenario has to
      -- be able to perform the forward leg first. Each emergency destination is
      -- therefore commissioned here as a FIXTURE — one consumed lifecycle row
      -- each, exactly the state the real commissioning chain leaves behind, and
      -- seeded the same way this file already seeds stock directly.
      --
      -- 169's own subject — the reversal corridor and its aggregate cap — is
      -- untouched by that gate: Migration 180 does not modify
      -- phoenix_reverse_outlet_replenishment at all, which its verify block
      -- asserts. The gate itself is proved in
      -- 180-emergency-initial-provisioning-boundary.dynamic.test.ts (Q1-Q6).
      INSERT INTO warehouse_dispatches (
        organization_id, warehouse_id, destination_distribution_point_id,
        dispatch_number, status, sent_at,
        is_initial_provisioning, initial_provisioning_consumed_at)
      SELECT dp.organization_id, dp.warehouse_id, dp.id,
             'IP169-' || right(dp.id::text, 12), 'accepted', now(), true, now()
        FROM distribution_points dp
       WHERE dp.point_type IN ('crash_cabinet', 'rescue_cart')
         AND dp.organization_id IN
             ('${ORG_SECTOR}', '${ORG_HOSPITAL}', '${ORG_SPECIAL}', '${ORG_SECTOR_2}')
      ON CONFLICT DO NOTHING;
    `));

    // NO_REVERSE_PERM holds outlet_stock.replenish (can do forward ops) but
    // NOT outlet_stock.replenish_reverse — proves the two keys are genuinely
    // independent, not aliases of each other.
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO role_permission_defaults (role, permission_key, allowed)
      SELECT 'outlet_officer', 'outlet_stock.replenish', true
      ON CONFLICT (role, permission_key) DO UPDATE SET allowed = true;
    `));
  });

  afterAll(async () => { if (rig) await rig.end(); });

  async function upsertRoute(src: string, dst: string, active = true): Promise<string> {
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
    const id = opts.id ?? randomUUID();
    const batch = opts.batch ?? uniq('B169');
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
      `, [dispatchId, opts.org, warehouseId, opts.pharmacy, uniq('D169'), rig.superAdminId]);

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

  // Directly seeds a pre-existing "wrong variant" pharmacy stock row — no
  // dispatch chain, never read via FEFO. Only ever used AFTER a forward
  // replenishment has already been performed against the CORRECT variant,
  // so it can never make the source pharmacy's own FEFO lookup ambiguous
  // (150's phoenix_inventory_fefo_batches would fail closed with
  // material_identity_ambiguous if two variants existed at forward time).
  async function seedRawPharmacyVariant(opts: {
    org: string; pharmacy: string; sci: string; unit?: string;
    centralItemId?: string | null; batch: string; expiryDays: number; qty: number;
    supplyType?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO outlet_stock (
        id, organization_id, distribution_point_id, point_type, central_item_id,
        scientific_name, concentration, dosage_form, unit,
        national_code, has_no_national_code,
        batch_number, has_no_batch_number,
        expiry_date, on_hand_quantity, reserved_quantity, movement_seq,
        supply_type, purchase_origin
      ) VALUES (
        $1,$2,$3,'pharmacy',$4,
        $5,'10mg','tablet',$6,
        NULL, true,
        $7, false,
        current_date + $8::int, $9, 0, 1,
        $10, NULL
      )
    `, [
      id, opts.org, opts.pharmacy, opts.centralItemId ?? null,
      opts.sci, opts.unit ?? 'box',
      opts.batch, opts.expiryDays, opts.qty,
      opts.supplyType ?? 'aid',
    ]));
    return id;
  }

  // Canonical destination resolution — material_identity_key + exact
  // lot/provenance tuple (never a partial field list; PR #109 lesson).
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

  async function movementLegs(referenceType: string, requestId: string) {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT movement_type, on_hand_delta, reference_type, reference_id,
             reason_code, request_fingerprint, outlet_stock_id, correlation_id
      FROM outlet_stock_movements
      WHERE reference_type=$1 AND reference_id=$2
      ORDER BY movement_type
    `, [referenceType, requestId]));
    return r.rows;
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

  async function reverse(
    routeId: string,
    destinationStockId: string,
    qty: number,
    requestId = randomUUID(),
    reason: string | null = null,
    notes: string | null = null,
    actor = rig.superAdminId,
  ) {
    return rig.asUser(actor, (c: any) =>
      call(c, 'phoenix_reverse_outlet_replenishment', [
        requestId, routeId, destinationStockId, qty, reason, notes,
      ]), { commit: true });
  }

  async function reversibleBatches(
    org: string,
    destinationPoint: string,
    actor = rig.superAdminId,
  ) {
    const r = await rig.asUser(actor, (c: any) =>
      c.query(
        `SELECT * FROM public.phoenix_outlet_replenishment_reversible_batches($1,$2)`,
        [org, destinationPoint],
      ));
    return r.rows;
  }

  async function forwardThenSnapshot(
    label: string, srcPoint: string, dstPoint: string, org: string, qty: number,
  ) {
    const routeId = await upsertRoute(srcPoint, dstPoint);
    const srcId = await seedPharmacyStock({
      org, pharmacy: srcPoint, sci: uniq(`SCI-${label}`), qty: qty + 20,
      supplyType: 'aid', purchaseOrigin: null,
    });
    const fwdRequestId = randomUUID();
    const fwd = await replenish(routeId, srcId, qty, fwdRequestId, null, `fwd-${label}`);
    expect(fwd.ok, label).toBe(true);
    const dstId = await destStockId(srcId, dstPoint);
    expect(dstId, label).toBeTruthy();
    return { routeId, srcId, dstId: dstId as string, fwdRequestId, qty };
  }

  // ══ Positive matrix — every E-5 route shape, now reversed ═════════════════
  describe('positive matrix — forward then reversal, every route shape', () => {
    async function assertRoundTrip(label: string, srcPoint: string, dstPoint: string, org: string, qty: number) {
      const { routeId, srcId, dstId, fwdRequestId } = await forwardThenSnapshot(label, srcPoint, dstPoint, org, qty);
      const srcAfterForward = await onHand(srcId);
      const dstAfterForward = await onHand(dstId);
      const revQty = Math.min(qty, 2);

      const revRequestId = randomUUID();
      const rev = await reverse(routeId, dstId, revQty, revRequestId, `reason-${label}`, `notes-${label}`);
      expect(rev.ok, label).toBe(true);
      expect(rev.idempotent_replay).toBe(false);
      expect(rev.quantity).toBe(revQty);
      expect(rev.destination_outlet_stock_id).toBe(dstId);
      expect(rev.source_outlet_stock_id).toBe(srcId);

      // Exact conservation.
      expect(await onHand(dstId)).toBe(dstAfterForward - revQty);
      expect(await onHand(srcId)).toBe(srcAfterForward + revQty);

      const legs = await movementLegs('outlet_replenishment_reversal', revRequestId);
      expect(legs).toHaveLength(2);
      const send = legs.find((l: any) => l.movement_type === 'replenish_send');
      const recv = legs.find((l: any) => l.movement_type === 'replenish_receive');
      expect(send.outlet_stock_id).toBe(dstId);
      expect(recv.outlet_stock_id).toBe(srcId);
      expect(Number(send.on_hand_delta)).toBe(-revQty);
      expect(Number(recv.on_hand_delta)).toBe(revQty);
      expect(Number(send.on_hand_delta) + Number(recv.on_hand_delta)).toBe(0);
      expect(send.correlation_id).toBe(recv.correlation_id);
      const expectedFp = await reversalFingerprint(routeId, dstId, revQty, `reason-${label}`, `notes-${label}`);
      expect(send.request_fingerprint).toBe(expectedFp);
      expect(recv.request_fingerprint).toBe(expectedFp);

      // returned_quantity landed on the origin RECEIVE leg only.
      const origin = await rig.asAdmin((c: any) => c.query(
        `SELECT returned_quantity, on_hand_delta FROM outlet_stock_movements
          WHERE reference_type='outlet_replenishment' AND reference_id=$1 AND movement_type='replenish_receive'`,
        [fwdRequestId],
      ));
      expect(origin.rows[0].returned_quantity).toBe(revQty);
      const originSend = await rig.asAdmin((c: any) => c.query(
        `SELECT returned_quantity FROM outlet_stock_movements
          WHERE reference_type='outlet_replenishment' AND reference_id=$1 AND movement_type='replenish_send'`,
        [fwdRequestId],
      ));
      expect(originSend.rows[0].returned_quantity).toBe(0);

      const audit = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int n FROM audit_logs
          WHERE action='outlet_stock.replenish_reverse' AND payload->>'request_id'=$1`,
        [revRequestId],
      ));
      expect(audit.rows[0].n).toBe(1);
    }

    it('Shape H: health-sector same-facility pharmacy <-> crash_cabinet', async () => {
      await assertRoundTrip('H', PH_A, CAB_A, ORG_SECTOR, 5);
    });

    it('Hospital: pharmacy <-> rescue_cart', async () => {
      await assertRoundTrip('I-H-CART', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 6);
    });

    it('Hospital: pharmacy <-> crash_cabinet', async () => {
      await assertRoundTrip('I-H-CAB', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 4);
    });

    it('Specialized center: pharmacy <-> crash_cabinet', async () => {
      await assertRoundTrip('I-S-CAB', PH_SPECIAL, CAB_SPECIAL, ORG_SPECIAL, 7);
    });
  });

  // ══ Negative matrix — zero mutation on reject ═════════════════════════════
  describe('negative matrix — zero mutation on reject', () => {
    async function expectReject(
      name: string,
      setup: () => Promise<{
        routeId: string; dstId: string; srcId: string; qty?: number;
        actor?: string; requestId?: string; reason?: string | null; notes?: string | null;
      }>,
      pattern: RegExp,
    ) {
      const s = await setup();
      const qty = s.qty ?? 1;
      const beforeDst = await onHand(s.dstId);
      const beforeSrc = await onHand(s.srcId);
      const requestId = s.requestId ?? randomUUID();
      const beforeMoveCount = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM outlet_stock_movements`));
      const beforeAudit = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.replenish_reverse'`));

      const msg = await rejects(() =>
        reverse(s.routeId, s.dstId, qty, requestId, s.reason ?? null, s.notes ?? null, s.actor ?? rig.superAdminId));
      expect(msg, name).toMatch(pattern);

      expect(await onHand(s.dstId), `${name} DESTINATION_DELTA`).toBe(beforeDst);
      expect(await onHand(s.srcId), `${name} SOURCE_DELTA`).toBe(beforeSrc);
      const afterMoveCount = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM outlet_stock_movements`));
      expect(afterMoveCount.rows[0].n, `${name} MOVEMENT_DELTA`).toBe(beforeMoveCount.rows[0].n);
      const afterAudit = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.replenish_reverse'`));
      expect(afterAudit.rows[0].n, `${name} AUDIT_DELTA`).toBe(beforeAudit.rows[0].n);
    }

    it('zero / negative quantity reject with zero mutation', async () => {
      const { routeId, srcId, dstId } = await forwardThenSnapshot('NEGQTY', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 10);
      expect(await rejects(() => reverse(routeId, dstId, 0))).toMatch(/quantity_must_be_positive/);
      expect(await rejects(() => reverse(routeId, dstId, -1))).toMatch(/quantity_must_be_positive/);
      void srcId;
    });

    it('quantity greater than remaining reversible cap is rejected', async () => {
      await expectReject('over-cap', async () => {
        const { routeId, srcId, dstId } = await forwardThenSnapshot('OVERCAP', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 3);
        return { routeId, srcId, dstId, qty: 4 };
      }, /reversal_quantity_exceeds_remaining_cap/);
    });

    it('already fully reversed origin cannot be reversed again', async () => {
      const { routeId, srcId, dstId } = await forwardThenSnapshot('FULLREV', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 3);
      const ok = await reverse(routeId, dstId, 3);
      expect(ok.ok).toBe(true);
      const beforeSrc = await onHand(srcId);
      const beforeDst = await onHand(dstId);
      const msg = await rejects(() => reverse(routeId, dstId, 1, randomUUID()));
      expect(msg).toMatch(/no_reversible_origin_for_destination/);
      expect(await onHand(srcId)).toBe(beforeSrc);
      expect(await onHand(dstId)).toBe(beforeDst);
    });

    it('insufficient currently available emergency stock rejects with zero mutation', async () => {
      await expectReject('insufficient-emergency-stock', async () => {
        const { routeId, srcId, dstId } = await forwardThenSnapshot('INSUFF', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 5);
        // Drain the destination via a second, unrelated on_hand reduction so
        // available_quantity < the reversible cap even though the cap itself
        // still allows it.
        await rig.asAdmin((c: any) => c.query(
          `UPDATE outlet_stock SET on_hand_quantity = 1 WHERE id=$1`, [dstId]));
        return { routeId, srcId, dstId, qty: 4 };
      }, /insufficient_emergency_stock_to_reverse/);
    });

    it('wrong route (mismatched destination) is rejected', async () => {
      await expectReject('wrong-route', async () => {
        const { srcId, dstId } = await forwardThenSnapshot('WRONGROUTE-A', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 5);
        const otherRouteId = await upsertRoute(PH_HOSP, CAB_HOSP);
        return { routeId: otherRouteId, srcId, dstId, qty: 1 };
      }, /destination_stock_not_on_route/);
    });

    it('cross-organization route/stock mismatch is rejected', async () => {
      await expectReject('cross-org', async () => {
        const { dstId: dst1 } = await forwardThenSnapshot('XORG-A', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 5);
        const { routeId: route2 } = await forwardThenSnapshot('XORG-B', PH_SECTOR_2, CAB_SECTOR_2, ORG_SECTOR_2, 5);
        return { routeId: route2, srcId: dst1, dstId: dst1, qty: 1 };
      }, /destination_stock_organization_mismatch|destination_stock_not_on_route/);
    });

    // Independent review finding, PR #110: stock conservation alone is
    // insufficient — a currently-active route sharing the SAME destination as
    // a historical, since-deactivated route must never be able to reverse
    // stock that actually originated through the OLD route. The two routes
    // legitimately coexist in sequence because
    // outlet_replenishment_routes_one_source_per_destination only forbids two
    // simultaneously ACTIVE sources for one destination.
    it('same-destination historical cross-route reversal is rejected; the original inactive route remains reversible', async () => {
      // 1-2. Pharmacy A -> Cart X = Route OLD. Legitimate E-5 forward.
      const routeOld = await upsertRoute(PH_HOSP, CART_HOSP, true);
      const pharmacyA = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-XROUTE-A'), qty: 20,
      });
      const fwdRequestId = randomUUID();
      const fwd = await replenish(routeOld, pharmacyA, 6, fwdRequestId, null, 'xroute-fwd');
      expect(fwd.ok).toBe(true);
      const dstX = await destStockId(pharmacyA, CART_HOSP);
      expect(dstX).toBeTruthy();

      // 3. Capture pre-state.
      const originRecvBefore = await rig.asAdmin((c: any) => c.query(
        `SELECT id, returned_quantity FROM outlet_stock_movements
          WHERE reference_type='outlet_replenishment' AND reference_id=$1 AND movement_type='replenish_receive'`,
        [fwdRequestId],
      ));
      const originSendBefore = await rig.asAdmin((c: any) => c.query(
        `SELECT id FROM outlet_stock_movements
          WHERE reference_type='outlet_replenishment' AND reference_id=$1 AND movement_type='replenish_send'`,
        [fwdRequestId],
      ));
      expect(originRecvBefore.rows).toHaveLength(1);
      expect(originSendBefore.rows).toHaveLength(1);
      const dstXBefore = await onHand(dstX!);
      const pharmacyABefore = await onHand(pharmacyA);

      // 4. Deactivate Route OLD (required before a second active route can
      //    target the same destination — one-source-per-destination).
      await rig.asAdmin((c: any) => c.query(
        `UPDATE outlet_replenishment_routes SET is_active=false WHERE id=$1`, [routeOld]));

      // 5. Pharmacy B — a second, independent pharmacy in the same org.
      const pharmacyBPoint = randomUUID();
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES ($1,'${WH_HOSPITAL}','${ORG_HOSPITAL}','H Pharmacy B 169','H Pharmacy B 169','pharmacy','active','non_emergency')
      `, [pharmacyBPoint]));
      const pharmacyB = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: pharmacyBPoint, sci: uniq('SCI-XROUTE-B'), qty: 20,
      });

      // 6. Route NEW: Pharmacy B -> SAME Cart X.
      const routeNew = await upsertRoute(pharmacyBPoint, CART_HOSP, true);

      // Baselines for the delta checks below are captured HERE — after all
      // fixture setup (Pharmacy B's own seeding inserts its own unrelated
      // dispatch_receive movement) and immediately before the actual
      // rejected call, so the deltas isolate exactly what that one call did.
      const totalMovesBefore = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM outlet_stock_movements`));
      const totalAuditBefore = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.replenish_reverse'`));

      // 7. Reversal via Route NEW against the destination stock whose
      //    reversible origin actually came through Route OLD — must be
      //    rejected, zero mutation anywhere.
      const crossRouteMsg = await rejects(() => reverse(routeNew, dstX!, 2, randomUUID(), 'xroute-attempt', null));
      expect(crossRouteMsg).toMatch(/origin_forward_route_mismatch/);

      const dstXAfterReject = await onHand(dstX!);
      const pharmacyAAfterReject = await onHand(pharmacyA);
      const pharmacyBAfterReject = await onHand(pharmacyB);
      const originRecvAfterReject = await rig.asAdmin((c: any) => c.query(
        `SELECT returned_quantity FROM outlet_stock_movements WHERE id=$1`, [originRecvBefore.rows[0].id]));
      const totalMovesAfterReject = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM outlet_stock_movements`));
      const totalAuditAfterReject = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.replenish_reverse'`));

      // CROSS_ROUTE_HISTORICAL_REVERSAL = REJECTED (proven above)
      // CROSS_ROUTE_STOCK_DELTA = 0
      expect(dstXAfterReject, 'CROSS_ROUTE_STOCK_DELTA dst').toBe(dstXBefore);
      expect(pharmacyAAfterReject, 'CROSS_ROUTE_STOCK_DELTA pharmacyA').toBe(pharmacyABefore);
      // NON_ORIGINAL_SOURCE_DELTA = 0 (Pharmacy B never touched)
      expect(pharmacyBAfterReject, 'NON_ORIGINAL_SOURCE_DELTA').toBe(20);
      // CROSS_ROUTE_RETURNED_QUANTITY_DELTA = 0
      expect(originRecvAfterReject.rows[0].returned_quantity, 'CROSS_ROUTE_RETURNED_QUANTITY_DELTA')
        .toBe(originRecvBefore.rows[0].returned_quantity);
      // CROSS_ROUTE_MOVEMENT_DELTA = 0
      expect(totalMovesAfterReject.rows[0].n, 'CROSS_ROUTE_MOVEMENT_DELTA').toBe(totalMovesBefore.rows[0].n);
      // CROSS_ROUTE_AUDIT_DELTA = 0
      expect(totalAuditAfterReject.rows[0].n, 'CROSS_ROUTE_AUDIT_DELTA').toBe(totalAuditBefore.rows[0].n);

      // 8. The SAME legitimate reversal via Route OLD — even inactive —
      //    must still succeed (historical reversibility preserved).
      const revRequestId = randomUUID();
      const rev = await reverse(routeOld, dstX!, 2, revRequestId, 'xroute-legit', null);
      expect(rev.ok, 'INACTIVE_ORIGINAL_ROUTE_REVERSAL').toBe(true);
      expect(rev.idempotent_replay).toBe(false);

      // destination emergency stock -= quantity
      expect(await onHand(dstX!)).toBe(dstXBefore - 2);
      // exact original Pharmacy A stock += quantity
      expect(await onHand(pharmacyA), 'ORIGINAL_SOURCE_CREDIT_RESULT').toBe(pharmacyABefore + 2);
      // Pharmacy B delta = 0
      expect(await onHand(pharmacyB)).toBe(20);
      // origin receive returned_quantity += quantity
      const originRecvAfterSuccess = await rig.asAdmin((c: any) => c.query(
        `SELECT returned_quantity FROM outlet_stock_movements WHERE id=$1`, [originRecvBefore.rows[0].id]));
      expect(originRecvAfterSuccess.rows[0].returned_quantity).toBe(2);

      // exact two-leg reversal ledger
      const legs = await movementLegs('outlet_replenishment_reversal', revRequestId);
      expect(legs).toHaveLength(2);
      const send = legs.find((l: any) => l.movement_type === 'replenish_send');
      const recv = legs.find((l: any) => l.movement_type === 'replenish_receive');
      expect(send.outlet_stock_id).toBe(dstX);
      expect(recv.outlet_stock_id).toBe(pharmacyA);

      // audit route_id = Route OLD
      const audit = await rig.asAdmin((c: any) => c.query(
        `SELECT payload->>'route_id' AS route_id FROM audit_logs
          WHERE action='outlet_stock.replenish_reverse' AND payload->>'request_id'=$1`,
        [revRequestId],
      ));
      expect(audit.rows[0].route_id).toBe(routeOld);
      expect(audit.rows[0].route_id).not.toBe(routeNew);

      // Cleanup: CART_HOSP is a SHARED fixture reused by many other tests in
      // this file via upsertRoute(PH_HOSP, CART_HOSP), which reactivates
      // routeOld by (source, destination) lookup. Leaving routeNew active
      // would leave TWO active routes claiming CART_HOSP as destination,
      // tripping outlet_replenishment_routes_one_source_per_destination for
      // every later test that touches this destination. Restore the
      // one-active-route invariant those tests depend on.
      await rig.asAdmin((c: any) => c.query(
        `UPDATE outlet_replenishment_routes SET is_active=false WHERE id=$1`, [routeNew]));
      await upsertRoute(PH_HOSP, CART_HOSP, true);
    });

    it('wrong material identity: destination stock with no reversible origin is rejected', async () => {
      const { routeId } = await forwardThenSnapshot('WRONGMAT-ROUTE', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 5);
      // A destination stock row that was never replenished (seeded directly,
      // no replenish_receive leg) has no reversible origin at all.
      const unrelatedStockId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-UNRELATED'), qty: 5,
      });
      const msg = await rejects(() => reverse(routeId, unrelatedStockId, 1));
      expect(msg).toMatch(/no_reversible_origin_for_destination|destination_stock_not_on_route/);
    });

    it('generic dispatch_receive provenance can never be used as a reversal origin', async () => {
      // seedPharmacyStock's own outlet_stock row (a dispatch_receive-origin
      // pharmacy stock, never replenished onto any emergency outlet) has zero
      // eligible replenish_receive legs against it.
      const { routeId } = await forwardThenSnapshot('DISPATCHORIGIN-ROUTE', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 5);
      const pharmacyOnlyStock = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-DISPATCHONLY'), qty: 5,
      });
      const msg = await rejects(() => reverse(routeId, pharmacyOnlyStock, 1));
      expect(msg).toMatch(/no_reversible_origin_for_destination|destination_stock_not_on_route/);
    });

    it('inactive caller (suspended profile) is rejected with zero mutation', async () => {
      await expectReject('inactive-caller', async () => {
        const { routeId, srcId, dstId } = await forwardThenSnapshot('INACTIVE', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 5);
        return { routeId, srcId, dstId, qty: 1, actor: SLEEPER };
      }, /active_profile_required/);
    });

    it('unauthorized caller (no outlet_stock.replenish_reverse) is rejected with zero mutation', async () => {
      await expectReject('unauthorized', async () => {
        const { routeId, srcId, dstId } = await forwardThenSnapshot('UNAUTH', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 5);
        return { routeId, srcId, dstId, qty: 1, actor: NOBODY };
      }, /forbidden_outlet_stock_replenish_reverse/);
    });

    it('caller holding only outlet_stock.replenish (not replenish_reverse) is rejected', async () => {
      await expectReject('forward-perm-only', async () => {
        const { routeId, srcId, dstId } = await forwardThenSnapshot('FWDPERMONLY', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 5);
        return { routeId, srcId, dstId, qty: 1, actor: NO_REVERSE_PERM };
      }, /forbidden_outlet_stock_replenish_reverse/);
    });
  });

  // ══ 071 generic-return isolation ═══════════════════════════════════════════
  describe('071 generic-return corridor stays structurally separate', () => {
    it('a replenish_receive movement cannot be inserted as outlet_return_request_lines provenance', async () => {
      const { dstId, fwdRequestId } = await forwardThenSnapshot('RETURNISO', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 5);
      const originRecv = await rig.asAdmin((c: any) => c.query(
        `SELECT id FROM outlet_stock_movements
          WHERE reference_type='outlet_replenishment' AND reference_id=$1 AND movement_type='replenish_receive'`,
        [fwdRequestId],
      ));
      const originRecvId = originRecv.rows[0].id;
      // A real dispatch line exists at CAB_HOSP only if it received via 070 —
      // it never has, so this is intentionally NULL/absent: the composite FK
      // orrl_movement_from_dispatch_line_fk requires original_dispatch_line_id
      // to equal the referenced movement's OWN dispatch_line_id, which is NULL
      // on every replenish_receive row. No real dispatch_line_id can ever
      // satisfy that FK for this movement — proving the same structural
      // closure as the type CHECK, from an independent angle.
      const anyDispatchLine = await rig.asAdmin((c: any) => c.query(
        `SELECT id FROM warehouse_dispatch_lines LIMIT 1`));
      const requestId = randomUUID();
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO outlet_return_requests (
          id, distribution_point_id, source_organization_id,
          destination_warehouse_id, destination_organization_id,
          return_number, status, requested_by_side, requested_by, requested_at
        ) VALUES (
          $1, '${CAB_HOSP}', '${ORG_HOSPITAL}', '${WH_HOSPITAL}', '${ORG_HOSPITAL}',
          $2, 'submitted', 'sender', '${rig.superAdminId}', now()
        )
      `, [requestId, uniq('P169-RETURNISO')]));

      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO outlet_return_request_lines (
          id, return_request_id, source_organization_id,
          original_dispatch_line_id, original_inbound_movement_id, original_inbound_movement_type,
          source_outlet_stock_id, scientific_name, reason_code, requested_quantity
        ) VALUES (
          $1, $2, '${ORG_HOSPITAL}',
          $3, $4, 'replenish_receive',
          '${dstId}', 'x', 'excess', 1
        )
      `, [randomUUID(), requestId, anyDispatchLine.rows[0].id, originRecvId])));
      expect(msg).toMatch(
        /orrl_inbound_movement_type_chk|orrl_movement_from_dispatch_line_fk|violates (check|foreign key) constraint/i,
      );
    });
  });

  // ══ Idempotency / fingerprint ═════════════════════════════════════════════
  describe('idempotency and fingerprint conflict', () => {
    it('same request_id + same payload replays safely without a second mutation', async () => {
      const { routeId, dstId, srcId } = await forwardThenSnapshot('IDEM', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 10);
      const requestId = randomUUID();
      const first = await reverse(routeId, dstId, 3, requestId, 'r', 'idem');
      const midDst = await onHand(dstId);
      const midSrc = await onHand(srcId);
      const midLegs = await movementLegs('outlet_replenishment_reversal', requestId);
      const second = await reverse(routeId, dstId, 3, requestId, 'r', 'idem');
      expect(second.ok).toBe(true);
      expect(second.idempotent_replay).toBe(true);
      expect(second.send_movement_id).toBe(first.send_movement_id);
      expect(await onHand(dstId)).toBe(midDst);
      expect(await onHand(srcId)).toBe(midSrc);
      expect(await movementLegs('outlet_replenishment_reversal', requestId)).toHaveLength(midLegs.length);
    });

    it('same request_id + changed quantity conflicts with zero mutation', async () => {
      const { routeId, dstId } = await forwardThenSnapshot('CONF-QTY', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 10);
      const requestId = randomUUID();
      await reverse(routeId, dstId, 2, requestId, 'r', 'c');
      const after = await onHand(dstId);
      expect(await rejects(() => reverse(routeId, dstId, 3, requestId, 'r', 'c')))
        .toMatch(/request_id_conflict/);
      expect(await onHand(dstId)).toBe(after);
      expect(await movementLegs('outlet_replenishment_reversal', requestId)).toHaveLength(2);
    });

    it('same request_id + changed destination stock conflicts with zero mutation', async () => {
      const { routeId, dstId } = await forwardThenSnapshot('CONF-DST-A', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 10);
      const { dstId: dst2 } = await forwardThenSnapshot('CONF-DST-B', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 10);
      const requestId = randomUUID();
      await reverse(routeId, dstId, 2, requestId, 'r', 'c');
      expect(await rejects(() => reverse(routeId, dst2, 2, requestId, 'r', 'c')))
        .toMatch(/request_id_conflict/);
    });

    it('same request_id + changed reason (effective payload field) conflicts', async () => {
      const { routeId, dstId } = await forwardThenSnapshot('CONF-REASON', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 10);
      const requestId = randomUUID();
      await reverse(routeId, dstId, 2, requestId, 'reason-A', 'c');
      expect(await rejects(() => reverse(routeId, dstId, 2, requestId, 'reason-B', 'c')))
        .toMatch(/request_id_conflict/);
    });
  });

  // ══ Concurrency ═══════════════════════════════════════════════════════════
  describe('concurrency', () => {
    it('two concurrent identical requests do not double debit/credit', async () => {
      const { routeId, dstId, srcId } = await forwardThenSnapshot('CONC-SAME', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 10);
      const requestId = randomUUID();
      const attempt = () =>
        reverse(routeId, dstId, 4, requestId, 'r', 'conc')
          .then((r) => ({ ok: true as const, r }))
          .catch((e: any) => ({ ok: false as const, msg: String(e.message) }));

      const [a, b] = await Promise.all([attempt(), attempt()]);
      expect(a.ok || b.ok).toBe(true);
      expect(await onHand(dstId)).toBe(10 - 4);
      expect(await onHand(srcId)).toBe(20 + 4);
      expect(await movementLegs('outlet_replenishment_reversal', requestId)).toHaveLength(2);
    });

    it('two different requests competing for the same remaining reversible quantity never over-reverse', async () => {
      const { routeId, dstId } = await forwardThenSnapshot('CONC-RACE', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 5);
      const attempt = () =>
        reverse(routeId, dstId, 4, randomUUID(), 'r', 'race')
          .then(() => 'ok')
          .catch((e: any) => String(e.message));
      const results = await Promise.all([attempt(), attempt()]);
      const wins = results.filter(r => r === 'ok').length;
      expect(wins).toBe(1);
      expect(results.some(r => /reversal_quantity_exceeds_remaining_cap|insufficient_emergency_stock_to_reverse/.test(r)))
        .toBe(true);
      const origin = await rig.asAdmin((c: any) => c.query(
        `SELECT returned_quantity FROM outlet_stock_movements
          WHERE outlet_stock_id=$1 AND movement_type='replenish_receive' AND reference_type='outlet_replenishment'`,
        [dstId],
      ));
      expect(origin.rows[0].returned_quantity).toBeLessThanOrEqual(5);
      expect(origin.rows[0].returned_quantity).toBe(4);
    });

    it('forward and reversal do not race into a conservation violation', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-FWDVSREV'), qty: 30,
      });
      const firstFwd = await replenish(routeId, srcId, 10, randomUUID(), null, 'seed');
      expect(firstFwd.ok).toBe(true);
      const dstId = await destStockId(srcId, CART_HOSP);
      expect(dstId).toBeTruthy();

      const totalBefore = (await onHand(srcId)) + (await onHand(dstId!));

      const fwdAttempt = () =>
        replenish(routeId, srcId, 5, randomUUID(), null, 'race-fwd')
          .then(() => 'ok').catch((e: any) => String(e.message));
      const revAttempt = () =>
        reverse(routeId, dstId!, 5, randomUUID(), 'race-rev', null)
          .then(() => 'ok').catch((e: any) => String(e.message));

      const [fwdResult, revResult] = await Promise.all([fwdAttempt(), revAttempt()]);
      // Both amounts fit within their respective caps (the reversal consumes
      // exactly the first forward's full remaining cap; the second forward is
      // a fresh, independent debit/credit) and the two transactions lock the
      // same two outlet_stock rows in the same ascending-id order, so both
      // must serialize and succeed — never deadlock, never a partial/half
      // visible pair either side.
      expect(fwdResult, `forward result: ${fwdResult}`).toBe('ok');
      expect(revResult, `reversal result: ${revResult}`).toBe('ok');
      const totalAfter = (await onHand(srcId)) + (await onHand(dstId!));
      expect(totalAfter).toBe(totalBefore);
    });
  });

  // ══ RBAC / replay authorization ════════════════════════════════════════════
  describe('replay authorization — idempotent replay never bypasses RBAC', () => {
    async function totalAudits(): Promise<number> {
      const r = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.replenish_reverse'`));
      return r.rows[0].n;
    }

    it('CASE A: unauthorized fresh reversal is rejected with zero mutation', async () => {
      const { routeId, dstId, srcId } = await forwardThenSnapshot('RA-A', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 8);
      const beforeDst = await onHand(dstId);
      const beforeSrc = await onHand(srcId);
      const auditsBefore = await totalAudits();
      const msg = await rejects(() => reverse(routeId, dstId, 2, randomUUID(), null, null, NOBODY));
      expect(msg).toMatch(/forbidden_outlet_stock_replenish_reverse/);
      expect(await onHand(dstId)).toBe(beforeDst);
      expect(await onHand(srcId)).toBe(beforeSrc);
      expect(await totalAudits()).toBe(auditsBefore);
    });

    it('CASE B: authorized fresh reversal succeeds', async () => {
      const { routeId, dstId } = await forwardThenSnapshot('RA-B', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 8);
      const result = await reverse(routeId, dstId, 2, randomUUID(), 'ra-b', null);
      expect(result.ok).toBe(true);
      expect(result.idempotent_replay).toBe(false);
    });

    it('CASE C: unauthorized replay of an existing successful reversal is rejected — no details, no mutation', async () => {
      const { routeId, dstId, srcId } = await forwardThenSnapshot('RA-C', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 8);
      const requestId = randomUUID();
      const success = await reverse(routeId, dstId, 2, requestId, 'note-RA-C');
      expect(success.ok).toBe(true);
      const dstAfterSuccess = await onHand(dstId);
      const srcAfterSuccess = await onHand(srcId);
      const legsAfterSuccess = await movementLegs('outlet_replenishment_reversal', requestId);
      const auditsAfterSuccess = await totalAudits();

      const msg = await rejects(() =>
        reverse(routeId, dstId, 2, requestId, 'note-RA-C', null, NOBODY));
      expect(msg).toMatch(/forbidden_outlet_stock_replenish_reverse/);
      expect(msg).not.toMatch(/idempotent_replay/);
      expect(msg).not.toMatch(/movement_id/);

      expect(await onHand(dstId)).toBe(dstAfterSuccess);
      expect(await onHand(srcId)).toBe(srcAfterSuccess);
      expect(await movementLegs('outlet_replenishment_reversal', requestId)).toHaveLength(legsAfterSuccess.length);
      expect(await totalAudits()).toBe(auditsAfterSuccess);
    });

    it('CASE D: inactive-profile replay is rejected with zero mutation', async () => {
      const { routeId, dstId } = await forwardThenSnapshot('RA-D', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 8);
      const requestId = randomUUID();
      const success = await reverse(routeId, dstId, 2, requestId, 'note-RA-D');
      expect(success.ok).toBe(true);
      const dstAfterSuccess = await onHand(dstId);
      const legsAfterSuccess = await movementLegs('outlet_replenishment_reversal', requestId);
      const auditsAfterSuccess = await totalAudits();

      const msg = await rejects(() =>
        reverse(routeId, dstId, 2, requestId, 'note-RA-D', null, SLEEPER));
      expect(msg).toMatch(/active_profile_required/);

      expect(await onHand(dstId)).toBe(dstAfterSuccess);
      expect(await movementLegs('outlet_replenishment_reversal', requestId)).toHaveLength(legsAfterSuccess.length);
      expect(await totalAudits()).toBe(auditsAfterSuccess);
    });

    it('CASE E: authorized exact replay still returns the canonical safe replay', async () => {
      const { routeId, dstId, srcId } = await forwardThenSnapshot('RA-E', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 8);
      const requestId = randomUUID();
      const result = await reverse(routeId, dstId, 3, requestId, 'note-RA-E');
      expect(result.ok).toBe(true);
      const dstAfterSuccess = await onHand(dstId);
      const srcAfterSuccess = await onHand(srcId);
      const legsAfterSuccess = await movementLegs('outlet_replenishment_reversal', requestId);
      const auditsAfterSuccess = await totalAudits();

      const replay = await reverse(routeId, dstId, 3, requestId, 'note-RA-E');
      expect(replay.ok).toBe(true);
      expect(replay.idempotent_replay).toBe(true);
      expect(replay.send_movement_id).toBe(result.send_movement_id);
      expect(replay.receive_movement_id).toBe(result.receive_movement_id);
      expect(replay.quantity).toBe(3);

      expect(await onHand(dstId)).toBe(dstAfterSuccess);
      expect(await onHand(srcId)).toBe(srcAfterSuccess);
      expect(await movementLegs('outlet_replenishment_reversal', requestId)).toHaveLength(legsAfterSuccess.length);
      expect(await totalAudits()).toBe(auditsAfterSuccess);
    });

    it('CASE F: permission revoked after original success — replay by the SAME actor is rejected', async () => {
      // A dedicated actor whose role (institution_admin) holds
      // outlet_stock.replenish_reverse by default (164). Succeeds once, the
      // role default is then revoked, and the exact same actor replays the
      // exact same request_id — must be rejected, not silently honoured.
      const REVOKED_ACTOR = '00000000-0000-0000-0000-000000169904';
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO auth.users (id, email) VALUES ('${REVOKED_ACTOR}', 'revoked169@rig.test')
        ON CONFLICT (id) DO NOTHING;
        UPDATE profiles SET role='institution_admin', status='active', organization_id='${ORG_HOSPITAL}'
         WHERE id='${REVOKED_ACTOR}';
      `));

      const { routeId, dstId, srcId } = await forwardThenSnapshot('RA-F', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 8);
      const requestId = randomUUID();
      const success = await reverse(routeId, dstId, 2, requestId, 'note-RA-F', null, REVOKED_ACTOR);
      expect(success.ok).toBe(true);
      const dstAfterSuccess = await onHand(dstId);
      const srcAfterSuccess = await onHand(srcId);
      const auditsAfterSuccess = await totalAudits();

      await rig.asAdmin((c: any) => c.query(`
        UPDATE role_permission_defaults SET allowed=false
         WHERE role='institution_admin' AND permission_key='outlet_stock.replenish_reverse'
      `));
      try {
        const msg = await rejects(() =>
          reverse(routeId, dstId, 2, requestId, 'note-RA-F', null, REVOKED_ACTOR));
        expect(msg).toMatch(/forbidden_outlet_stock_replenish_reverse/);
        expect(await onHand(dstId)).toBe(dstAfterSuccess);
        expect(await onHand(srcId)).toBe(srcAfterSuccess);
        expect(await totalAudits()).toBe(auditsAfterSuccess);
      } finally {
        await rig.asAdmin((c: any) => c.query(`
          UPDATE role_permission_defaults SET allowed=true
           WHERE role='institution_admin' AND permission_key='outlet_stock.replenish_reverse'
        `));
      }
    });
  });

  // ══ Material identity isolation (PR #109 pattern, applied to reversal) ════
  describe('canonical material identity isolation at the credited pharmacy (reversal)', () => {
    it('a same-lot pharmacy row differing only by unit is never credited by reversal', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP);
      const sci = uniq('SCI-REVMATID-UNIT');
      const batch = uniq('BREVMATID-UNIT');
      const expiryDays = 200;
      const supplyType = 'aid';

      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci, qty: 20, batch, expiryDays,
        supplyType, purchaseOrigin: null, unit: 'box',
      });

      // Forward FIRST, while this scientific_name+national_code combination
      // is still unambiguous at the source pharmacy — 150's FEFO helper fails
      // closed with material_identity_ambiguous if two canonical variants
      // exist there simultaneously, so the "wrong variant" collision must be
      // placed strictly AFTER the forward call (reversal never consults FEFO
      // at all — it resolves via the stored paired-send outlet_stock_id).
      const fwd = await replenish(routeId, srcId, 5, randomUUID(), null, 'seed-unit');
      expect(fwd.ok).toBe(true);
      const dstId = await destStockId(srcId, CART_HOSP);

      // Pre-existing wrong-variant pharmacy stock — same lot, differs by unit.
      const wrongVariantId = await seedRawPharmacyVariant({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci, qty: 9, batch, expiryDays,
        supplyType, unit: 'strip',
      });

      const revRequestId = randomUUID();
      const rev = await reverse(routeId, dstId!, 2, revRequestId, 'r', 'n');
      expect(rev.ok).toBe(true);
      expect(rev.source_outlet_stock_id).toBe(srcId);
      expect(rev.source_outlet_stock_id).not.toBe(wrongVariantId);

      expect(await onHand(srcId)).toBe(20 - 5 + 2);
      // WRONG_VARIANT_DESTINATION_DELTA = 0
      expect(await onHand(wrongVariantId)).toBe(9);

      const legs = await movementLegs('outlet_replenishment_reversal', revRequestId);
      const recv = legs.find((l: any) => l.movement_type === 'replenish_receive');
      expect(recv.outlet_stock_id).toBe(srcId);
      expect(recv.outlet_stock_id).not.toBe(wrongVariantId);
    });

    it('a same-lot, same-unit pharmacy row differing only by central_item_id is never credited by reversal', async () => {
      const routeId = await upsertRoute(PH_SPECIAL, CAB_SPECIAL);
      const sci = uniq('SCI-REVMATID-CENTRAL');
      const batch = uniq('BREVMATID-CENTRAL');
      const expiryDays = 180;
      const supplyType = 'aid';

      const centralA = randomUUID();
      const centralB = randomUUID();
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO central_items (id, name, name_ar) VALUES
          ($1, 'Rev Central A 169', 'Rev Central A 169'),
          ($2, 'Rev Central B 169', 'Rev Central B 169')
      `, [centralA, centralB]));

      const srcId = await seedPharmacyStock({
        org: ORG_SPECIAL, pharmacy: PH_SPECIAL, sci, qty: 20, batch, expiryDays,
        supplyType, purchaseOrigin: null, centralItemId: centralA,
      });

      // Forward FIRST (see the unit-variant test above for why).
      const fwd = await replenish(routeId, srcId, 5, randomUUID(), null, 'seed-central');
      expect(fwd.ok).toBe(true);
      const dstId = await destStockId(srcId, CAB_SPECIAL);

      const wrongVariantId = await seedRawPharmacyVariant({
        org: ORG_SPECIAL, pharmacy: PH_SPECIAL, sci, qty: 9, batch, expiryDays,
        supplyType, centralItemId: centralB,
      });

      const revRequestId = randomUUID();
      const rev = await reverse(routeId, dstId!, 2, revRequestId, 'r', 'n');
      expect(rev.ok).toBe(true);
      expect(rev.source_outlet_stock_id).toBe(srcId);
      expect(rev.source_outlet_stock_id).not.toBe(wrongVariantId);
      expect(await onHand(wrongVariantId)).toBe(9);

      const srcRow = await rig.asAdmin((c: any) => c.query(
        `SELECT central_item_id FROM outlet_stock WHERE id=$1`, [srcId]));
      expect(srcRow.rows[0].central_item_id).toBe(centralA);
    });
  });

  // ══ Reversible-batches helper ═══════════════════════════════════════════════
  describe('phoenix_outlet_replenishment_reversible_batches', () => {
    it('lists only replenish_receive origins, oldest first, with exact remaining quantity', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-RB-ORDER'), qty: 30,
      });
      const first = await replenish(routeId, srcId, 5, randomUUID(), null, 'rb-1');
      expect(first.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      const second = await replenish(routeId, srcId, 4, randomUUID(), null, 'rb-2');
      expect(second.ok).toBe(true);
      const dstId = await destStockId(srcId, CART_HOSP);

      const rows = await reversibleBatches(ORG_HOSPITAL, CART_HOSP);
      const forThisDst = rows.filter((r: any) => r.destination_outlet_stock_id === dstId);
      expect(forThisDst.length).toBeGreaterThanOrEqual(2);
      // Oldest-first: created_at ascending.
      for (let i = 1; i < forThisDst.length; i++) {
        expect(new Date(forThisDst[i].origin_created_at).getTime())
          .toBeGreaterThanOrEqual(new Date(forThisDst[i - 1].origin_created_at).getTime());
      }
      const totalRemaining = forThisDst.reduce((sum: number, r: any) => sum + Number(r.remaining_reversible_quantity), 0);
      expect(totalRemaining).toBe(9);
    });

    it('excludes fully reversed origins', async () => {
      const routeId = await upsertRoute(PH_HOSP, CAB_HOSP);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-RB-EXCLUDE'), qty: 20,
      });
      const fwd = await replenish(routeId, srcId, 5, randomUUID(), null, 'rb-exclude');
      expect(fwd.ok).toBe(true);
      const dstId = await destStockId(srcId, CAB_HOSP);
      const before = await reversibleBatches(ORG_HOSPITAL, CAB_HOSP);
      expect(before.some((r: any) => r.destination_outlet_stock_id === dstId)).toBe(true);

      const rev = await reverse(routeId, dstId!, 5, randomUUID(), 'full', null);
      expect(rev.ok).toBe(true);

      const after = await reversibleBatches(ORG_HOSPITAL, CAB_HOSP);
      expect(after.some((r: any) => r.destination_outlet_stock_id === dstId)).toBe(false);
    });

    it('reports correct returned_quantity subtraction after a partial reversal', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-RB-PARTIAL'), qty: 20,
      });
      const fwd = await replenish(routeId, srcId, 10, randomUUID(), null, 'rb-partial');
      expect(fwd.ok).toBe(true);
      const dstId = await destStockId(srcId, CART_HOSP);
      const rev = await reverse(routeId, dstId!, 3, randomUUID(), 'partial', null);
      expect(rev.ok).toBe(true);

      const rows = await reversibleBatches(ORG_HOSPITAL, CART_HOSP);
      const row = rows.find((r: any) => r.destination_outlet_stock_id === dstId);
      expect(row).toBeTruthy();
      expect(row.returned_quantity).toBe(3);
      expect(row.remaining_reversible_quantity).toBe(7);
      expect(row.original_credited_quantity).toBe(10);
    });

    it('exposes exact material_identity_key and never dispatch provenance', async () => {
      const routeId = await upsertRoute(PH_SPECIAL, CAB_SPECIAL);
      const srcId = await seedPharmacyStock({
        org: ORG_SPECIAL, pharmacy: PH_SPECIAL, sci: uniq('SCI-RB-MATID'), qty: 10,
      });
      const fwd = await replenish(routeId, srcId, 3, randomUUID(), null, 'rb-matid');
      expect(fwd.ok).toBe(true);
      const dstId = await destStockId(srcId, CAB_SPECIAL);
      const dstMaterial = await rig.asAdmin((c: any) => c.query(
        `SELECT material_identity_key FROM outlet_stock WHERE id=$1`, [dstId]));

      const rows = await reversibleBatches(ORG_SPECIAL, CAB_SPECIAL);
      const row = rows.find((r: any) => r.destination_outlet_stock_id === dstId);
      expect(row.material_identity_key).toBe(dstMaterial.rows[0].material_identity_key);
    });

    it('unauthorized caller cannot enumerate another scope', async () => {
      const routeId = await upsertRoute(PH_HOSP, CART_HOSP);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-RB-UNAUTH'), qty: 5,
      });
      const fwd = await replenish(routeId, srcId, 2, randomUUID(), null, 'rb-unauth');
      expect(fwd.ok).toBe(true);
      const msg = await rejects(() =>
        rig.asUser(NOBODY, (c: any) =>
          c.query(`SELECT * FROM public.phoenix_outlet_replenishment_reversible_batches($1,$2)`,
            [ORG_HOSPITAL, CART_HOSP])));
      expect(msg).toMatch(/forbidden_outlet_stock_replenish_reverse/);
    });
  });

  // ══ E-4 / E-5 / 167 non-interference ═══════════════════════════════════════
  describe('E-4, E-5, and Migration-167 non-interference', () => {
    it('successful reversal does not create IP dispatches or flip IP flags', async () => {
      const beforeIp = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int n FROM warehouse_dispatches WHERE is_initial_provisioning IS TRUE
      `));
      const { routeId, dstId } = await forwardThenSnapshot('E4NI', PH_HOSP, CAB_HOSP, ORG_HOSPITAL, 5);
      const rev = await reverse(routeId, dstId, 1, randomUUID(), 'e4ni', null);
      expect(rev.ok).toBe(true);
      const afterIp = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int n FROM warehouse_dispatches WHERE is_initial_provisioning IS TRUE
      `));
      expect(afterIp.rows[0].n).toBe(beforeIp.rows[0].n);
    });

    it('no warehouse_stock_movements row is ever created by a reversal', async () => {
      const { routeId, dstId } = await forwardThenSnapshot('NOWH', PH_HOSP, CART_HOSP, ORG_HOSPITAL, 5);
      const requestId = randomUUID();
      const before = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM warehouse_stock_movements`));
      const rev = await reverse(routeId, dstId, 1, requestId, 'nowh', null);
      expect(rev.ok).toBe(true);
      const after = await rig.asAdmin((c: any) =>
        c.query(`SELECT count(*)::int n FROM warehouse_stock_movements`));
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('warehouse_dispatch_lines_decision_chk still requires rejected => received_quantity = 0', async () => {
      const def = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_constraintdef(oid) AS d
        FROM pg_constraint WHERE conname='warehouse_dispatch_lines_decision_chk'
      `));
      expect(def.rows[0].d).toMatch(/received_quantity IS NOT NULL/);
      expect(def.rows[0].d).toMatch(/received_quantity = 0/);
    });

    it('the E-5 forward RPC still functions unchanged after 169', async () => {
      const routeId = await upsertRoute(PH_HOSP, CAB_HOSP);
      const srcId = await seedPharmacyStock({
        org: ORG_HOSPITAL, pharmacy: PH_HOSP, sci: uniq('SCI-E5STILL'), qty: 10,
      });
      const fwd = await replenish(routeId, srcId, 3, randomUUID(), null, 'e5still');
      expect(fwd.ok).toBe(true);
      expect(fwd.idempotent_replay).toBe(false);
    });
  });

  // ══ Schema objects present ════════════════════════════════════════════════
  describe('migration objects present after replay', () => {
    it('exposes both new functions and the reversal once-index with expected grants', async () => {
      const r = await rig.asAdmin((c: any) => c.query(`
        SELECT
          to_regprocedure('public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)') IS NOT NULL AS rpc,
          to_regprocedure('public.phoenix_outlet_replenishment_reversible_batches(uuid,uuid)') IS NOT NULL AS helper,
          has_function_privilege('authenticated',
            'public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)', 'EXECUTE') AS rpc_grant,
          has_function_privilege('authenticated',
            'public.phoenix_outlet_replenishment_reversible_batches(uuid,uuid)', 'EXECUTE') AS helper_grant,
          EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND indexname='outlet_stock_movements_replenishment_reversal_once_uniq'
          ) AS idx_present
      `));
      expect(r.rows[0].rpc).toBe(true);
      expect(r.rows[0].helper).toBe(true);
      expect(r.rows[0].rpc_grant).toBe(true);
      expect(r.rows[0].helper_grant).toBe(true);
      expect(r.rows[0].idx_present).toBe(true);
    });
  });
});
