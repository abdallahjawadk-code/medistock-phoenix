/**
 * 180 · EMERGENCY-OUTLET INITIAL-PROVISIONING AUTHORITY BOUNDARY (R1.2)
 * — dynamic proof.
 *
 * Builds a disposable Postgres through the full current EFFECTIVE migration
 * chain on disk (buildRig({}) — 001 through whatever is present) and drives the
 * REAL RPC chain exactly as the frontend would: central receive -> routed
 * warehouse transfer -> dispatch create -> add line -> send -> outlet receive ->
 * outlet return, plus Migration 168's routine replenishment corridor.
 *
 * THE INVARIANT UNDER TEST
 *
 *   Warehouse/depot direct supply to an emergency outlet is legal ONLY through
 *   the dedicated initial-provisioning authority.
 *
 * The evidence that matters most is that the refusal is HISTORICAL, not
 * lifecycle-relative and not balance-derived: cases A/B prove it holds BEFORE
 * any initial-provisioning row exists (which a "reject only once consumed"
 * guard would not), and case F proves it still holds after the outlet has been
 * legally drained back to zero.
 *
 * The pre-180 bypass this closes is reproduced against a real 001->179 chain in
 * the sibling 180-pre180-emergency-dispatch-bypass.dynamic.test.ts.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 180000 });

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000180001';
const ORG_HOSP = '00000000-0000-0000-0000-000000180002';
const ORG_FOREIGN = '00000000-0000-0000-0000-000000180003';

const WH_CENTRAL = '00000000-0000-0000-0000-000000180101';
const WH_HOSP = '00000000-0000-0000-0000-000000180102';
const WH_HOSP_B = '00000000-0000-0000-0000-000000180103';
const WH_FOREIGN = '00000000-0000-0000-0000-000000180104';

const ROUTE = '00000000-0000-0000-0000-000000180501';

/**
 * One destination per proof, so no case can mask another.
 *
 * Hospital topology (Migration 164 "Shape I"): no facility layer, a rescue cart
 * requires clinical_location_kind='emergency', a crash cabinet requires
 * 'non_emergency'. PH_ER is deliberately a PHARMACY carrying 'emergency' — the
 * ER pharmacy — because the boundary must key on point_type and must NOT close
 * the corridor to it.
 */
const PH_MAIN = '00000000-0000-0000-0000-000000180301';
const PH_ER = '00000000-0000-0000-0000-000000180302';
const CAB_NEW = '00000000-0000-0000-0000-000000180303';
const CART_NEW = '00000000-0000-0000-0000-000000180304';
const CAB_LIFE = '00000000-0000-0000-0000-000000180305';
const CAB_ZERO = '00000000-0000-0000-0000-000000180306';
const CART_LIFE = '00000000-0000-0000-0000-000000180307';
const CAB_REPL = '00000000-0000-0000-0000-000000180308';
const CART_REPL = '00000000-0000-0000-0000-000000180309';
const CAB_CC1 = '00000000-0000-0000-0000-000000180310';
const CAB_CC2 = '00000000-0000-0000-0000-000000180311';
const PH_CC = '00000000-0000-0000-0000-000000180312';
const CAB_PAIR_B = '00000000-0000-0000-0000-000000180313';
const PH_PAIR_B = '00000000-0000-0000-0000-000000180314';
const CAB_FOREIGN = '00000000-0000-0000-0000-000000180315';
const CAB_ANON = '00000000-0000-0000-0000-000000180316';
const CAB_RBAC = '00000000-0000-0000-0000-000000180317';

/** A profile with NO dispatch permissions — the RBAC negative control. */
const NOBODY = '00000000-0000-0000-0000-000000180901';

/** Migration 177 public-QR fixtures, so the anonymous read path is exercised. */
const QR_TARGET = '00000000-0000-0000-0000-000000180701';
const QR_TOKEN = '00000000-0000-0000-0000-000000180702';
const QR_PUBLIC_ID = 'r12-180-public-cab';

const CORE = '_phoenix_180_delegate_create_warehouse_dispatch';
const CORE_SIG = `public.${CORE}(uuid,uuid,text,text,text,text,text)`;

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

run('180 · emergency-outlet initial-provisioning authority boundary (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c
      .query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  /** Move real stock into the hospital warehouse via the real corridor. */
  async function provisionWarehouseStock(tag: string, qty: number): Promise<string> {
    return rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
          randomUUID(), WH_CENTRAL, `P180-${tag}`, qty, true, true, 0,
          null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
        ]);
        const sent = await call(c, 'phoenix_send_warehouse_transfer_line', [
          randomUUID(), ROUTE, rc.warehouse_stock_id, qty, uniq('WT'), null, null, null,
        ]);
        const got = await call(c, 'phoenix_receive_warehouse_transfer_line', [
          randomUUID(), sent.transfer_line_id, qty, null, null,
        ]);
        return got.warehouse_stock_id as string;
      },
      { commit: true },
    );
  }

  const createOrdinary = (dp: string, tag: string, wh = WH_HOSP, actor?: string) =>
    rig.asUser(
      actor ?? rig.superAdminId,
      (c: any) => call(c, 'phoenix_create_warehouse_dispatch', [wh, dp, uniq(tag), null, null, null]),
      { commit: true },
    );

  const createInitial = (dp: string, tag: string, wh = WH_HOSP, actor?: string) =>
    rig.asUser(
      actor ?? rig.superAdminId,
      (c: any) =>
        call(c, 'phoenix_create_initial_provisioning_dispatch', [wh, dp, uniq(tag), null, null, null]),
      { commit: true },
    );

  /** Add one line of `qty` from `stockId`, then SEND. Returns the line id. */
  async function addLineAndSend(dispatchId: string, stockId: string, qty: number): Promise<string> {
    return rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        await call(c, 'phoenix_add_dispatch_line', [dispatchId, stockId, qty]);
        await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
        const r = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
        return r.rows[0].id as string;
      },
      { commit: true },
    );
  }

  const receive = (lineId: string, qty: number) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) => call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), lineId, qty, null, null]),
      { commit: true },
    );

  const onHand = (dp: string): Promise<number> =>
    rig
      .asAdmin((c: any) =>
        c.query(
          `SELECT COALESCE(SUM(on_hand_quantity),0)::int n FROM outlet_stock WHERE distribution_point_id=$1`,
          [dp],
        ),
      )
      .then((r: any) => r.rows[0].n as number);

  const dispatchCount = (dp: string): Promise<number> =>
    rig
      .asAdmin((c: any) =>
        c.query(
          `SELECT count(*)::int n FROM warehouse_dispatches WHERE destination_distribution_point_id=$1`,
          [dp],
        ),
      )
      .then((r: any) => r.rows[0].n as number);

  const header = (dispatchId: string) =>
    rig
      .asAdmin((c: any) =>
        c.query(
          `SELECT status, is_initial_provisioning, initial_provisioning_consumed_at
             FROM warehouse_dispatches WHERE id=$1`,
          [dispatchId],
        ),
      )
      .then((r: any) => r.rows[0]);

  /** Full one-line initial provisioning, delivered. Returns ids. */
  async function provisionOutlet(dp: string, tag: string, qty = 10) {
    const stock = await provisionWarehouseStock(tag, qty);
    const created = await createInitial(dp, tag);
    const lineId = await addLineAndSend(created.dispatch_id, stock, qty);
    const got = await receive(lineId, qty);
    return { dispatchId: created.dispatch_id as string, lineId, stock, received: got };
  }

  /** One outlet_stock lot at a PHARMACY, with REAL ordinary-dispatch provenance. */
  async function stockPharmacy(dp: string, tag: string, qty: number): Promise<string> {
    const stock = await provisionWarehouseStock(tag, qty);
    const created = await createOrdinary(dp, tag);
    const lineId = await addLineAndSend(created.dispatch_id, stock, qty);
    const got = await receive(lineId, qty);
    return got.outlet_stock_id as string;
  }

  async function upsertRoute(src: string, dst: string): Promise<string> {
    const existing = await rig.asAdmin((c: any) =>
      c.query(
        `SELECT id FROM outlet_replenishment_routes
          WHERE source_point_id=$1 AND destination_point_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [src, dst],
      ),
    );
    const routeArg = existing.rows[0]?.id ?? null;
    const r = await rig.asUser(
      rig.superAdminId,
      (c: any) => call(c, 'phoenix_upsert_outlet_replenishment_route', [routeArg, src, dst, true, null]),
      { commit: true },
    );
    return r.route_id as string;
  }

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_CENTRAL}','C180','مركز','p180-c','pharmacy_department_authority',NULL),
        ('${ORG_HOSP}','H180','مستشفى','p180-h','care_institution','hospital'),
        ('${ORG_FOREIGN}','F180','مستشفى ب','p180-f','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH180','مخزنC','active','central','p180-wc'),
        ('${WH_HOSP}','${ORG_HOSP}','HWH180','مخزنH','active','institution','p180-wh'),
        ('${WH_HOSP_B}','${ORG_HOSP}','HWH180b','مخزنHب','active','institution','p180-whb'),
        ('${WH_FOREIGN}','${ORG_FOREIGN}','FWH180','مخزنF','active','institution','p180-wf')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO distribution_points
        (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PH_MAIN}','${WH_HOSP}','${ORG_HOSP}','Main Pharmacy180','صيدلية','pharmacy','active','non_emergency'),
        ('${PH_ER}','${WH_HOSP}','${ORG_HOSP}','ER Pharmacy180','صيدلية طوارئ','pharmacy','active','emergency'),
        ('${CAB_NEW}','${WH_HOSP}','${ORG_HOSP}','New Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${CART_NEW}','${WH_HOSP}','${ORG_HOSP}','New Cart180','عربة','rescue_cart','active','emergency'),
        ('${CAB_LIFE}','${WH_HOSP}','${ORG_HOSP}','Life Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${CAB_ZERO}','${WH_HOSP}','${ORG_HOSP}','Zero Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${CART_LIFE}','${WH_HOSP}','${ORG_HOSP}','Life Cart180','عربة','rescue_cart','active','emergency'),
        ('${CAB_REPL}','${WH_HOSP}','${ORG_HOSP}','Repl Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${CART_REPL}','${WH_HOSP}','${ORG_HOSP}','Repl Cart180','عربة','rescue_cart','active','emergency'),
        ('${CAB_CC1}','${WH_HOSP}','${ORG_HOSP}','CC1 Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${CAB_CC2}','${WH_HOSP}','${ORG_HOSP}','CC2 Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${PH_CC}','${WH_HOSP}','${ORG_HOSP}','CC Pharmacy180','صيدلية','pharmacy','active','non_emergency'),
        ('${CAB_ANON}','${WH_HOSP}','${ORG_HOSP}','Anon Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${CAB_RBAC}','${WH_HOSP}','${ORG_HOSP}','Rbac Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${CAB_PAIR_B}','${WH_HOSP_B}','${ORG_HOSP}','B Cabinet180','خزانة','crash_cabinet','active','non_emergency'),
        ('${PH_PAIR_B}','${WH_HOSP_B}','${ORG_HOSP}','B Pharmacy180','صيدلية','pharmacy','active','non_emergency'),
        ('${CAB_FOREIGN}','${WH_FOREIGN}','${ORG_FOREIGN}','F Cabinet180','خزانة','crash_cabinet','active','non_emergency')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_HOSP}','central','institution', true)
        ON CONFLICT (id) DO NOTHING;`);

      // Migration 177's public-QR chain for CAB_LIFE, so the anonymous read
      // model is exercised for real rather than asserted only by ACL.
      await c.query(`INSERT INTO qr_targets(id,organization_id,target_type,target_id,label,status)
        VALUES ('${QR_TARGET}','${ORG_HOSP}','distribution_point','${CAB_LIFE}','Life Cabinet180','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO qr_tokens(id,qr_target_id,organization_id,public_id,token_hash,status)
        VALUES ('${QR_TOKEN}','${QR_TARGET}','${ORG_HOSP}','${QR_PUBLIC_ID}','hash-180','active')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${NOBODY}','p180-nobody@rig.local')
        ON CONFLICT (id) DO NOTHING;`);
      // outlet_officer is the RECEIVING side and deliberately does not hold
      // warehouse_dispatch.create — an honest RBAC control, not a synthetic one.
      await c.query(`UPDATE profiles SET role='outlet_officer', status='active', organization_id='${ORG_HOSP}'
        WHERE id='${NOBODY}';`);
    });
  }, 240000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // A / B — the corridor is closed BEFORE any lifecycle row exists.
  //
  // These two cases are what a "reject only once the lifecycle is consumed"
  // guard would get wrong: with no initial-provisioning row at all, that guard
  // reads "not consumed" and admits the dispatch.
  // ══════════════════════════════════════════════════════════════════════════
  describe('A/B · a brand-new emergency outlet refuses ordinary warehouse dispatch', () => {
    it('A · crash cabinet with NO initial-provisioning record refuses ordinary dispatch', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM warehouse_dispatches WHERE destination_distribution_point_id=$1`,
          [CAB_NEW],
        );
        // Precondition: the lifecycle has genuinely never been entered.
        expect(r.rows[0].n).toBe(0);
      });

      const msg = await rejects(() => createOrdinary(CAB_NEW, 'A1'));
      expect(msg).toMatch(/emergency_outlet_requires_initial_provisioning/);
      expect(msg).toContain('crash_cabinet');
      // NOT the outlet-type error: the type is approved for stock; the
      // corridor is what is wrong.
      expect(msg).not.toMatch(/outlet_type_not_approved_for_stock/);
    });

    it('A · the refusal creates no dispatch row and no audit row', async () => {
      expect(await dispatchCount(CAB_NEW)).toBe(0);
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM audit_logs
            WHERE action='warehouse_dispatch.created'
              AND payload->>'distribution_point_id' = $1`,
          [CAB_NEW],
        );
        expect(r.rows[0].n).toBe(0);
      });
    });

    it('B · rescue cart with NO initial-provisioning record refuses ordinary dispatch', async () => {
      expect(await dispatchCount(CART_NEW)).toBe(0);
      const msg = await rejects(() => createOrdinary(CART_NEW, 'B1'));
      expect(msg).toMatch(/emergency_outlet_requires_initial_provisioning/);
      expect(msg).toContain('rescue_cart');
      expect(await dispatchCount(CART_NEW)).toBe(0);
    });

    it('A/B · initial provisioning to the very same outlets is accepted', async () => {
      // Proof that the refusal is about the AUTHORITY, not the destination.
      const cab = await createInitial(CAB_NEW, 'A2');
      expect(cab.ok).toBe(true);
      expect(cab.is_initial_provisioning).toBe(true);
      const cart = await createInitial(CART_NEW, 'B2');
      expect(cart.ok).toBe(true);
      expect(cart.is_initial_provisioning).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C / D / E — the full crash-cabinet lifecycle.
  // ══════════════════════════════════════════════════════════════════════════
  describe('C/D/E · crash-cabinet lifecycle', () => {
    let life: Awaited<ReturnType<typeof provisionOutlet>>;

    it('C · initial provisioning creates, sends, receives and credits stock', async () => {
      life = await provisionOutlet(CAB_LIFE, 'C1', 10);
      const h = await header(life.dispatchId);
      expect(h.is_initial_provisioning).toBe(true);
      expect(h.initial_provisioning_consumed_at).not.toBeNull();
      expect(h.status).toBe('accepted');
      expect(life.received.ok).toBe(true);
      expect(await onHand(CAB_LIFE)).toBe(10);
    });

    it('C · the creation audit records which authority created the row', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT payload->>'authority' AS authority FROM audit_logs
            WHERE action='warehouse_dispatch.created' AND entity_id=$1`,
          [life.dispatchId],
        );
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0].authority).toBe('initial');
      });
    });

    it('D · a SECOND initial provisioning is refused by the 166 one-shot invariant', async () => {
      const msg = await rejects(() => createInitial(CAB_LIFE, 'D1'));
      expect(msg).toMatch(/initial_provisioning_already_exists_for_outlet|once_uniq/);
    });

    it('E · ordinary warehouse dispatch to the SAME cabinet is refused', async () => {
      const before = await dispatchCount(CAB_LIFE);
      const msg = await rejects(() => createOrdinary(CAB_LIFE, 'E1'));
      expect(msg).toMatch(/emergency_outlet_requires_initial_provisioning/);
      expect(await dispatchCount(CAB_LIFE)).toBe(before);
      // …and no stock moved.
      expect(await onHand(CAB_LIFE)).toBe(10);
    });

    it('E · a repeated ordinary attempt is refused identically (the pre-180 escalation)', async () => {
      expect(await rejects(() => createOrdinary(CAB_LIFE, 'E2')))
        .toMatch(/emergency_outlet_requires_initial_provisioning/);
      expect(await onHand(CAB_LIFE)).toBe(10);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // F — the refusal survives the balance returning to zero.
  // ══════════════════════════════════════════════════════════════════════════
  describe('F · a drained emergency outlet does not reopen', () => {
    let drained: Awaited<ReturnType<typeof provisionOutlet>>;

    it('F · a legal outlet return brings the cabinet back to zero', async () => {
      drained = await provisionOutlet(CAB_ZERO, 'F1', 8);
      expect(await onHand(CAB_ZERO)).toBe(8);

      await rig.asUser(
        rig.superAdminId,
        async (c: any) => {
          const req = await call(c, 'phoenix_request_outlet_return', [CAB_ZERO, uniq('OR180')]);
          const requestId = req.return_request_id ?? req.id;
          const added = await call(c, 'phoenix_add_outlet_return_request_line', [
            requestId, drained.lineId, 8, 'excess', 'R1.2 F-case drain',
          ]);
          const lineId = added.return_request_line_id;
          await call(c, 'phoenix_submit_outlet_return_request', [requestId]);
          await call(c, 'phoenix_review_outlet_return_request', [
            requestId, JSON.stringify([{ line_id: lineId, approved_quantity: 8 }]),
          ]);
          const sent = await call(c, 'phoenix_send_outlet_return_shipment_line', [
            randomUUID(), lineId, null, 8, uniq('ORS180'), null, null,
          ]);
          expect(sent.ok).toBe(true);
          // 'excess' is a classified, non-mandatory-quarantine reason, so the
          // receiving warehouse must state the disposition explicitly.
          await call(c, 'phoenix_receive_outlet_return_shipment_line', [
            randomUUID(), sent.shipment_line_id, 8, null, null, 'restockable',
          ]);
        },
        { commit: true },
      );

      expect(await onHand(CAB_ZERO)).toBe(0);
    });

    it('F · ordinary warehouse dispatch is STILL refused at zero balance', async () => {
      const msg = await rejects(() => createOrdinary(CAB_ZERO, 'F2'));
      expect(msg).toMatch(/emergency_outlet_requires_initial_provisioning/);
    });

    it('F · the initial lifecycle does NOT reopen at zero balance', async () => {
      const msg = await rejects(() => createInitial(CAB_ZERO, 'F3'));
      expect(msg).toMatch(/initial_provisioning_already_exists_for_outlet|once_uniq/);
      // The consumption stamp is what holds it closed — not the balance.
      const h = await header(drained.dispatchId);
      expect(h.initial_provisioning_consumed_at).not.toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // G — rescue cart in a legal hospital ER topology.
  // ══════════════════════════════════════════════════════════════════════════
  describe('G · rescue-cart lifecycle', () => {
    it('G · first initial provisioning passes and credits stock', async () => {
      const cart = await provisionOutlet(CART_LIFE, 'G1', 6);
      const h = await header(cart.dispatchId);
      expect(h.is_initial_provisioning).toBe(true);
      expect(await onHand(CART_LIFE)).toBe(6);
    });

    it('G · a second initial provisioning is refused', async () => {
      expect(await rejects(() => createInitial(CART_LIFE, 'G2')))
        .toMatch(/initial_provisioning_already_exists_for_outlet|once_uniq/);
    });

    it('G · ordinary warehouse dispatch is refused', async () => {
      const msg = await rejects(() => createOrdinary(CART_LIFE, 'G3'));
      expect(msg).toMatch(/emergency_outlet_requires_initial_provisioning/);
      expect(msg).toContain('rescue_cart');
      expect(await onHand(CART_LIFE)).toBe(6);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // H — the ordinary pharmacy corridor is untouched.
  // ══════════════════════════════════════════════════════════════════════════
  describe('H · ordinary warehouse -> pharmacy dispatch still works end to end', () => {
    it('H · create, send, receive and credit against a pharmacy outlet', async () => {
      const stock = await provisionWarehouseStock('H1', 12);
      const created = await createOrdinary(PH_MAIN, 'H1');
      expect(created.ok).toBe(true);
      expect(created.status).toBe('draft');
      const lineId = await addLineAndSend(created.dispatch_id, stock, 12);
      const got = await receive(lineId, 12);
      expect(got.ok).toBe(true);
      expect(got.quantity_delta).toBe(12);
      expect(await onHand(PH_MAIN)).toBe(12);
      const h = await header(created.dispatch_id);
      expect(h.is_initial_provisioning).toBe(false);
      expect(h.initial_provisioning_consumed_at).toBeNull();
    });

    it('H · the ordinary creation audit records ORDINARY authority', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT DISTINCT payload->>'authority' AS authority FROM audit_logs
            WHERE action='warehouse_dispatch.created'
              AND payload->>'distribution_point_id' = $1`,
          [PH_MAIN],
        );
        expect(r.rows.map((x: any) => x.authority)).toEqual(['ordinary']);
      });
    });

    it('H · an ER PHARMACY (clinical_location_kind=emergency) is still a legal destination', async () => {
      // The boundary keys on point_type, never on the clinical flag: an ER
      // pharmacy is the SOURCE of rescue-cart replenishment and must keep its
      // own warehouse supply.
      const created = await createOrdinary(PH_ER, 'H2');
      expect(created.ok).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // I / J — routine replenishment (Migration 168) is untouched.
  // ══════════════════════════════════════════════════════════════════════════
  describe('I/J · routine pharmacy -> emergency replenishment still works', () => {
    it('I · legal pharmacy -> crash cabinet replenishment passes', async () => {
      const src = await stockPharmacy(PH_MAIN, 'I1', 20);
      const routeId = await upsertRoute(PH_MAIN, CAB_REPL);
      const before = await onHand(CAB_REPL);
      const r = await rig.asUser(
        rig.superAdminId,
        (c: any) =>
          call(c, 'phoenix_replenish_emergency_outlet', [randomUUID(), routeId, src, 5, null, 'R1.2 I']),
        { commit: true },
      );
      expect(r.ok).toBe(true);
      expect(await onHand(CAB_REPL)).toBe(before + 5);
    });

    it('J · legal ER pharmacy -> rescue cart replenishment passes', async () => {
      const src = await stockPharmacy(PH_ER, 'J1', 15);
      const routeId = await upsertRoute(PH_ER, CART_REPL);
      const before = await onHand(CART_REPL);
      const r = await rig.asUser(
        rig.superAdminId,
        (c: any) =>
          call(c, 'phoenix_replenish_emergency_outlet', [randomUUID(), routeId, src, 4, null, 'R1.2 J']),
        { commit: true },
      );
      expect(r.ok).toBe(true);
      expect(await onHand(CART_REPL)).toBe(before + 4);
    });

    it('I/J · replenishment never sets or consumes an initial-provisioning lifecycle', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM warehouse_dispatches
            WHERE destination_distribution_point_id = ANY($1) AND is_initial_provisioning`,
          [[CAB_REPL, CART_REPL]],
        );
        expect(r.rows[0].n).toBe(0);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // K / L / M — pre-existing refusals are preserved, not replaced.
  // ══════════════════════════════════════════════════════════════════════════
  describe('K/L/M · pre-existing refusals preserved', () => {
    it('K · a wrong-warehouse ordinary dispatch still fails on the PAIRING rule', async () => {
      // The pairing check runs before the corridor gate, so the operator still
      // gets the accurate diagnosis rather than a corridor error.
      const msg = await rejects(() => createOrdinary(CAB_PAIR_B, 'K1', WH_HOSP));
      expect(msg).toMatch(/destination_outlet_not_paired_with_this_warehouse/);
      expect(msg).not.toMatch(/emergency_outlet_requires_initial_provisioning/);
    });

    it('K · a wrong-warehouse INITIAL provisioning still fails on the pairing rule', async () => {
      expect(await rejects(() => createInitial(CAB_PAIR_B, 'K2', WH_HOSP)))
        .toMatch(/destination_outlet_not_paired_with_this_warehouse/);
    });

    it('K · a correctly paired warehouse still reaches the corridor gate', async () => {
      expect(await rejects(() => createOrdinary(CAB_PAIR_B, 'K3', WH_HOSP_B)))
        .toMatch(/emergency_outlet_requires_initial_provisioning/);
      // …and the pharmacy on that same warehouse is unaffected.
      expect((await createOrdinary(PH_PAIR_B, 'K4', WH_HOSP_B)).ok).toBe(true);
    });

    it('L · a cross-organization attempt is still refused', async () => {
      const msg = await rejects(() => createOrdinary(CAB_FOREIGN, 'L1', WH_HOSP));
      expect(msg).toMatch(
        /destination_outlet_not_paired_with_this_warehouse|warehouse_and_destination_organization_mismatch/,
      );
      expect(await rejects(() => createInitial(CAB_FOREIGN, 'L2', WH_HOSP))).toMatch(
        /destination_outlet_not_paired_with_this_warehouse|warehouse_and_destination_organization_mismatch/,
      );
    });

    it('M · anon cannot execute either public writer', async () => {
      for (const fn of [
        'phoenix_create_warehouse_dispatch',
        'phoenix_create_initial_provisioning_dispatch',
      ]) {
        const msg = await rejects(() =>
          rig.asUser(null, (c: any) => call(c, fn, [WH_HOSP, CAB_ANON, uniq('M'), null, null, null]), {
            role: 'anon',
          }),
        );
        expect(msg, fn).toMatch(/permission denied for function/i);
      }
      expect(await dispatchCount(CAB_ANON)).toBe(0);
    });

    it('M · an authenticated caller with no profile is refused before the corridor', async () => {
      const msg = await rejects(() =>
        rig.asUser(null, (c: any) =>
          call(c, 'phoenix_create_warehouse_dispatch', [WH_HOSP, CAB_ANON, uniq('M2'), null, null, null]),
        ),
      );
      expect(msg).toMatch(/not_authenticated/);
    });

    it('M · an authenticated caller without warehouse_dispatch.create never learns the corridor', async () => {
      // Ordering matters: the permission gate runs BEFORE the corridor gate, so
      // an unauthorised caller cannot use the error to probe outlet types.
      const msg = await rejects(() => createOrdinary(CAB_RBAC, 'M3', WH_HOSP, NOBODY));
      expect(msg).toMatch(/forbidden_warehouse_dispatch_create/);
      expect(msg).not.toMatch(/emergency_outlet_requires_initial_provisioning/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // N / O — the internal helper and the authority-confusion prohibition.
  // ══════════════════════════════════════════════════════════════════════════
  describe('N/O · internal-helper security and no client-selectable authority', () => {
    it('N · the internal core exists with the expected security posture', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT prosecdef, proconfig, proacl::text AS acl, pg_get_userbyid(proowner) AS owner
             FROM pg_proc WHERE oid='${CORE_SIG}'::regprocedure`,
        );
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0].prosecdef).toBe(true);
        expect((r.rows[0].proconfig ?? []).join(';')).toMatch(/search_path=public,\s*pg_temp/);
        // Owner parity with the wrappers is what makes a fully-revoked helper
        // reachable from them and from nowhere else.
        const owner = await c.query(
          `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
            WHERE oid='public.phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text)'::regprocedure`,
        );
        expect(r.rows[0].owner).toBe(owner.rows[0].owner);
      });
    });

    it('N · no client-presentable role holds EXECUTE on the internal core', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT
            has_function_privilege('authenticated','${CORE_SIG}','EXECUTE') AS auth,
            has_function_privilege('anon','${CORE_SIG}','EXECUTE')          AS anon,
            has_function_privilege('service_role','${CORE_SIG}','EXECUTE')  AS service,
            EXISTS (
              SELECT 1 FROM pg_proc p,
                LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
               WHERE p.oid='${CORE_SIG}'::regprocedure
                 AND a.grantee = 0 AND a.privilege_type='EXECUTE'
            ) AS public_exec`);
        expect(r.rows[0]).toEqual({ auth: false, anon: false, service: false, public_exec: false });
      });
    });

    it('N · a direct authenticated call to the internal core is DENIED', async () => {
      const msg = await rejects(() =>
        rig.asUser(rig.superAdminId, (c: any) =>
          call(c, CORE, [WH_HOSP, CAB_ANON, uniq('N1'), null, null, null, 'initial']),
        ),
      );
      expect(msg).toMatch(/permission denied for function/i);
      expect(await dispatchCount(CAB_ANON)).toBe(0);
    });

    it('N · a direct anon call to the internal core is DENIED', async () => {
      const msg = await rejects(() =>
        rig.asUser(
          null,
          (c: any) => call(c, CORE, [WH_HOSP, CAB_ANON, uniq('N2'), null, null, null, 'initial']),
          { role: 'anon' },
        ),
      );
      expect(msg).toMatch(/permission denied for function/i);
    });

    it('N · the denial is the ACL, not the argument: even the owner needs a real authority', async () => {
      // Same call, run as the OWNER (which the wrappers effectively are):
      // it reaches the body, and the body still refuses a bogus authority.
      const msg = await rejects(() =>
        rig.asAdmin((c: any) =>
          c.query(
            `SELECT public.${CORE}($1,$2,$3,NULL,NULL,NULL,$4)`,
            [WH_HOSP, PH_MAIN, uniq('N3'), 'emergency'],
          ),
        ),
      );
      expect(msg).toMatch(/dispatch_authority_unrecognised/);
      expect(msg).toContain('emergency');
    });

    it('O · NO function reachable by authenticated or anon takes an authority/mode argument', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT p.oid::regprocedure::text AS fn
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND pg_get_function_arguments(p.oid)
                 ~* '(p_authority|p_is_initial|p_initial_provisioning|p_mode|p_dispatch_mode)'
             AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  OR has_function_privilege('anon', p.oid, 'EXECUTE'))
           ORDER BY 1`);
        expect(r.rows.map((x: any) => x.fn)).toEqual([]);
      });
    });

    it('O · there is exactly ONE overload of each public writer, at the historical signature', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT p.oid::regprocedure::text AS fn
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public'
             AND p.proname IN ('phoenix_create_warehouse_dispatch',
                               'phoenix_create_initial_provisioning_dispatch')
           ORDER BY 1`);
        expect(r.rows.map((x: any) => x.fn)).toEqual([
          'phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)',
          'phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text)',
        ]);
      });
    });

    it('O · both public writers keep authenticated EXECUTE and deny anon', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT p.proname,
                 has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                 has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public'
             AND p.proname IN ('phoenix_create_warehouse_dispatch',
                               'phoenix_create_initial_provisioning_dispatch')
           ORDER BY p.proname`);
        for (const row of r.rows) {
          expect(row.auth, row.proname).toBe(true);
          expect(row.anon, row.proname).toBe(false);
        }
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CONCURRENCY
  // ══════════════════════════════════════════════════════════════════════════
  describe('concurrency', () => {
    it('CASE 1 · initial vs ordinary on the same outlet: ordinary always loses, never both', async () => {
      const initial = () =>
        createInitial(CAB_CC1, 'CC1i').then(
          r => ({ kind: 'initial' as const, ok: true, r }),
          (e: any) => ({ kind: 'initial' as const, ok: false, msg: String(e.message) }),
        );
      const ordinary = () =>
        createOrdinary(CAB_CC1, 'CC1o').then(
          r => ({ kind: 'ordinary' as const, ok: true, r }),
          (e: any) => ({ kind: 'ordinary' as const, ok: false, msg: String(e.message) }),
        );

      const [a, b] = await Promise.all([initial(), ordinary()]);
      const byKind = Object.fromEntries([a, b].map(x => [x.kind, x])) as Record<string, any>;

      expect(byKind.ordinary.ok).toBe(false);
      expect(byKind.ordinary.msg).toMatch(/emergency_outlet_requires_initial_provisioning/);
      expect(byKind.initial.ok).toBe(true);

      // Exactly one dispatch row exists, and it is the initial-provisioning one.
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT id, is_initial_provisioning FROM warehouse_dispatches
            WHERE destination_distribution_point_id=$1`,
          [CAB_CC1],
        );
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0].is_initial_provisioning).toBe(true);
      });
    });

    it('CASE 2 · two concurrent initial provisionings: exactly one succeeds', async () => {
      const attempt = (tag: string) =>
        createInitial(CAB_CC2, tag).then(
          () => 'ok',
          (e: any) => String(e.message),
        );
      const results = await Promise.all([attempt('CC2a'), attempt('CC2b')]);
      expect(results.filter(r => r === 'ok')).toHaveLength(1);
      expect(
        results.some(r => /initial_provisioning_already_exists_for_outlet|once_uniq/.test(r)),
      ).toBe(true);

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM warehouse_dispatches
            WHERE destination_distribution_point_id=$1 AND is_initial_provisioning`,
          [CAB_CC2],
        );
        expect(r.rows[0].n).toBe(1);
      });
    });

    it('CASE 3 · concurrent ordinary pharmacy dispatches keep their pre-180 behaviour', async () => {
      const attempt = (tag: string) =>
        createOrdinary(PH_CC, tag).then(
          () => 'ok',
          (e: any) => String(e.message),
        );
      const results = await Promise.all([attempt('CC3a'), attempt('CC3b')]);
      // Both are legitimate, independent documents — the per-warehouse advisory
      // lock serialises them, it does not reject either.
      expect(results).toEqual(['ok', 'ok']);
      expect(await dispatchCount(PH_CC)).toBe(2);
    });

    it('CASE 3 · the per-warehouse advisory lock and lock ORDER are unchanged', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT pg_get_functiondef('${CORE_SIG}'::regprocedure) AS def`);
        const def: string = r.rows[0].def;
        const advisory = def.indexOf('pg_advisory_xact_lock');
        const warehouse = def.indexOf('FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE');
        const destination = def.indexOf(
          'FROM public.distribution_points WHERE id = p_destination_distribution_point_id FOR SHARE',
        );
        expect(advisory).toBeGreaterThan(-1);
        // advisory lock -> warehouse row -> destination row, exactly as 070.
        expect(advisory).toBeLessThan(warehouse);
        expect(warehouse).toBeLessThan(destination);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PRESERVATION — 166, 168/169, two-ledger truth, 176-179, Public QR.
  // ══════════════════════════════════════════════════════════════════════════
  describe('preservation', () => {
    it('the 166 columns, CHECK and one-shot index are exactly as 166 left them', async () => {
      await rig.asAdmin(async (c: any) => {
        const cols = await c.query(
          `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema='public' AND table_name='warehouse_dispatches'
              AND column_name IN ('is_initial_provisioning','initial_provisioning_consumed_at')
            ORDER BY column_name`,
        );
        expect(cols.rows).toEqual([
          {
            column_name: 'initial_provisioning_consumed_at',
            data_type: 'timestamp with time zone',
            is_nullable: 'YES',
            column_default: null,
          },
          {
            column_name: 'is_initial_provisioning',
            data_type: 'boolean',
            is_nullable: 'NO',
            column_default: 'false',
          },
        ]);

        const idx = await c.query(
          `SELECT indexdef FROM pg_indexes WHERE schemaname='public'
            AND indexname='warehouse_dispatches_initial_provisioning_once_uniq'`,
        );
        expect(idx.rows).toHaveLength(1);
        expect(idx.rows[0].indexdef).toMatch(/^CREATE UNIQUE INDEX/);
        expect(idx.rows[0].indexdef).not.toMatch(/quantity|on_hand/);

        const chk = await c.query(
          `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
            WHERE conname='wd_initial_provisioning_consumed_chk'`,
        );
        expect(chk.rows[0].d).toContain('initial_provisioning_consumed_at IS NULL');
      });
    });

    it('the 166 consumption stamp still lives on the receive wrapper', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_functiondef(
             'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)'::regprocedure) d`,
        );
        expect(r.rows[0].d).toContain('initial_provisioning_consumed_at = now()');
        expect(r.rows[0].d).toContain('_phoenix_149_delegate_receive_outlet_dispatch_line');
      });
    });

    it('an ordinary dispatch can still never carry a consumption stamp', async () => {
      const ordinary = await createOrdinary(PH_MAIN, 'CHK180');
      const msg = await rejects(() =>
        rig.asAdmin((c: any) =>
          c.query(`UPDATE warehouse_dispatches SET initial_provisioning_consumed_at=now() WHERE id=$1`, [
            ordinary.dispatch_id,
          ]),
        ),
      );
      expect(msg).toMatch(/wd_initial_provisioning_consumed_chk/);
    });

    it('exactly two balance truths remain', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM pg_class
            WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock')`,
        );
        expect(r.rows[0].n).toBe(0);
      });
    });

    it('the 168/169 replenishment corridor and its reversal are present and unchanged', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT
            to_regprocedure('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)') IS NOT NULL AS fwd,
            to_regprocedure('public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)') IS NOT NULL AS rev,
            pg_get_functiondef('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)'::regprocedure)
              NOT LIKE '%_phoenix_180_delegate%' AS untouched`);
        expect(r.rows[0]).toEqual({ fwd: true, rev: true, untouched: true });
      });
    });

    it('Stage-F patient dispensing is untouched', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
            WHERE ns.nspname='public' AND p.proname LIKE '%dispense%'
              AND pg_get_functiondef(p.oid) LIKE '%_phoenix_180_delegate%'`,
        );
        expect(r.rows[0].n).toBe(0);
      });
    });

    it('the 176/179 authenticated availability read model still answers for a provisioned outlet', async () => {
      const payload = await rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_outlet_availability_read_model', [CAB_LIFE]),
      );
      expect(payload).toBeTruthy();
      const rows = (payload.items ?? payload.rows ?? []) as any[];
      expect(Array.isArray(rows)).toBe(true);
      const stockRow = rows.find(r => Number(r.quantity ?? 0) > 0);
      expect(stockRow, JSON.stringify(payload).slice(0, 400)).toBeTruthy();
      // 179's additive canonical unit is still published on stock-backed rows.
      expect(Object.keys(stockRow)).toContain('unit');
    });

    it('Public QR still resolves for an anonymous caller', async () => {
      const payload = await rig.asUser(
        null,
        (c: any) => call(c, 'get_public_qr_payload', [QR_PUBLIC_ID]),
        { role: 'anon' },
      );
      expect(payload).toBeTruthy();
      expect(payload.found ?? true).not.toBe(false);
      expect(JSON.stringify(payload)).toContain('Life Cabinet180');
    });

    it('180 expanded no anonymous surface', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT p.oid::regprocedure::text AS fn
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public'
             AND (p.proname LIKE '%warehouse_dispatch%' OR p.proname LIKE '%initial_provisioning%')
             AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
        expect(r.rows.map((x: any) => x.fn)).toEqual([]);
        // 177's public QR remains the intentional anonymous API, unchanged.
        const qr = await c.query(
          `SELECT has_function_privilege('anon','public.get_public_qr_payload(text)','EXECUTE') AS anon`,
        );
        expect(qr.rows[0].anon).toBe(true);
      });
    });

    it('no new stock movement type or ledger was introduced by the core', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT pg_get_functiondef('${CORE_SIG}'::regprocedure) AS def`);
        const def: string = r.rows[0].def;
        expect(def).not.toMatch(/INSERT INTO public\.(outlet|warehouse)_stock/);
        expect(def).not.toMatch(/_movements/);
        // The core creates a DOCUMENT; material, batch, expiry, FEFO and
        // provenance all belong to the line/send/receive path it never touches.
        expect(def).not.toMatch(/material_identity_key|expiry_date|batch_number|fefo/i);
      });
    });
  });
});
