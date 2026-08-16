/**
 * 185 · R1.5-F1 PROVENANCE-FIRST RECALL SELECTOR — dynamic proof against a real
 * 001->185 chain, driving the genuine corridor.
 *
 * WHAT F1 CLOSES
 *   phoenix_recall_warehouse_transfer (069) and
 *   phoenix_recall_direct_warehouse_transfer (077) inserted ONE draft return
 *   header and nothing else — no line, so no obligation and nothing naming the
 *   recalled material. Their signatures carry no selector at all, so there was
 *   nothing to materialize from. F1 adds ONE selector-carrying RPC keyed on a
 *   REAL warehouse_transfer_lines row and makes both legacy paths fail closed.
 *
 * WHY THE SELECTOR IS A TRANSFER LINE AND NOT A MATERIAL KEY
 *   One transfer line derives the whole corridor: transfer -> both warehouses,
 *   both organizations, route_id (NULL = direct), resulting_warehouse_stock_id
 *   and the received/returned ledger. The caller therefore restates NOTHING —
 *   no organization, warehouse, identity, batch or quantity — which is what
 *   removes the IDOR surface rather than merely guarding it.
 *
 * SCOPE: SAME HOLDER ONLY. Onward warehouse legs and outlet descendants are
 * F2/F3 and are deliberately absent here.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000185f01';
const ORG_INST    = '00000000-0000-0000-0000-000000185f02';
const ORG_OTHER   = '00000000-0000-0000-0000-000000185f03';
const WH_CENTRAL  = '00000000-0000-0000-0000-000000185f11';
const WH_INST     = '00000000-0000-0000-0000-000000185f12';
const WH_OTHER    = '00000000-0000-0000-0000-000000185f13';
const WH_CENTRAL2 = '00000000-0000-0000-0000-000000185f14';
const ROUTE       = '00000000-0000-0000-0000-000000185f21';
const RECALLER    = '00000000-0000-0000-0000-000000185f31';
const OUTSIDER    = '00000000-0000-0000-0000-000000185f32';
// R1.5-F1-C1: the holder's own two-person stock-correction pair. Custody is moved
// in the aggregate-budget proofs below ONLY through that real workflow, never by
// a raw UPDATE, so each one rests on state a genuine operator can actually reach.
const CORR_REQ    = '00000000-0000-0000-0000-000000185f33';
const CORR_APP    = '00000000-0000-0000-0000-000000185f34';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('185 · R1.5-F1 provenance-first recall selector (001->185 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const asSuper = <T>(fn: (c: any) => Promise<T>) =>
    rig.asUser(rig.superAdminId, fn, { commit: true }) as Promise<T>;
  const asUser = <T>(id: string, fn: (c: any) => Promise<T>) =>
    rig.asUser(id, fn, { commit: true }) as Promise<T>;
  const admin = (sql: string, params: any[] = []) =>
    rig.asAdmin((c: any) => c.query(sql, params));

  const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
    throw new Error('expected a rejection but the call succeeded');
  };

  /** The RPC under test, as the origin-anchored recall actor. */
  const recall = (who: string, transferLineId: string, number: string, notes: string | null = null) =>
    asUser(who, (c: any) =>
      call(c, 'phoenix_recall_warehouse_transfer_line', [transferLineId, number, notes]));

  const one = async (sql: string, params: any[] = []) =>
    (await admin(sql, params)).rows[0];

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_CENTRAL}','C','مركز','p185f-c','pharmacy_department_authority',NULL),
        ('${ORG_INST}','I','مؤسسة','p185f-i','care_institution','hospital'),
        ('${ORG_OTHER}','O','أخرى','p185f-o','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','p185f-wc'),
        ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','p185f-wi'),
        ('${WH_OTHER}','${ORG_OTHER}','OWH','مخزنO','active','institution','p185f-wo'),
        ('${WH_CENTRAL2}','${ORG_CENTRAL}','CWH2','مخزنC2','active','central','p185f-wc2')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution',true)
        ON CONFLICT (id) DO NOTHING;`);

      // RECALLER holds warehouse_transfer.recall at CENTRAL (the original
      // sender). institution_admin is org-wide, so the scoped check resolves
      // without a per-warehouse assignment. OUTSIDER sits in a third
      // organization and holds nothing.
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${RECALLER}','r15f-recaller@rig'),('${OUTSIDER}','r15f-outsider@rig'),
        ('${CORR_REQ}','r15f-corr-req@rig'),('${CORR_APP}','r15f-corr-app@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active',
        organization_id='${ORG_CENTRAL}' WHERE id='${RECALLER}';`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active',
        organization_id='${ORG_OTHER}' WHERE id='${OUTSIDER}';`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active',
        organization_id='${ORG_INST}' WHERE id IN ('${CORR_REQ}','${CORR_APP}');`);
      // R1.5-F1-C2 additionally needs the MANUAL return workflow driven end to end:
      // the holder requests/sends, central reviews. CORR_REQ doubles as the holder
      // operator so no further fixture identity is introduced.
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed)
        VALUES ('${RECALLER}','warehouse_transfer.recall',true),
               ('${RECALLER}','warehouse_transfer.review_return',true),
               ('${CORR_REQ}','warehouse_stock.correct',true),
               ('${CORR_REQ}','warehouse_transfer.return_request',true),
               ('${CORR_REQ}','warehouse_transfer.return_send',true),
               ('${CORR_APP}','warehouse_stock.correct',true),
               ('${CORR_APP}','warehouse_stock.approve_correction',true)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true;`);
    });
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** Delivers `qty` through the REAL routed corridor and returns its provenance. */
  async function deliverRouted(material: string, qty: number) {
    return asSuper(async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, material, qty, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const send = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, rc.warehouse_stock_id, qty, uniq('WT'), null, null, null]);
      const recv = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), send.transfer_line_id, qty, null, null]);
      return {
        transferLineId: send.transfer_line_id as string,
        stockId: recv.warehouse_stock_id as string,
      };
    });
  }

  /**
   * Same holder, DIFFERENT corridor: a DIRECT delivery from a second central
   * warehouse. warehouse_supply_routes_one_primary_per_target permits only one
   * active route into a target, so a second routed corridor is impossible by
   * design - a direct transfer is the real-world shape here. The line and the
   * resulting stock come from the genuine receive path; only the header's
   * sender is repointed, and route_id goes NULL because a direct transfer has
   * no route (wt_route_endpoints_fk is MATCH SIMPLE).
   */
  async function deliverFromSecondCentral(material: string, qty: number) {
    const d = await deliverRouted(material, qty);
    const tid = (await one(
      `SELECT transfer_id FROM warehouse_transfer_lines WHERE id=$1`, [d.transferLineId])).transfer_id;
    await admin(
      `UPDATE warehouse_transfers
          SET route_id = NULL, source_warehouse_id = $2, source_organization_id = $3
        WHERE id = $1`,
      [tid, WH_CENTRAL2, ORG_CENTRAL]);
    return d;
  }

  /**
   * A DIRECT (route_id IS NULL) delivery. The transfer header is shaped
   * directly because 077's direct send requires a full direct-request fixture
   * that proves nothing extra here; the LINE and the resulting stock are still
   * produced by the real receive path, so the provenance under test is genuine.
   * wt_route_endpoints_fk is MATCH SIMPLE, so a NULL route_id is unconstrained.
   */
  async function deliverDirect(material: string, qty: number) {
    const routed = await deliverRouted(material, qty);
    const tid = (await one(
      `SELECT transfer_id FROM warehouse_transfer_lines WHERE id=$1`, [routed.transferLineId])).transfer_id;
    await admin(`UPDATE warehouse_transfers SET route_id = NULL WHERE id = $1`, [tid]);
    return { ...routed, transferId: tid as string };
  }

  const lineRow = (transferLineId: string, number: string) => one(
    `SELECT l.*, r.route_id, r.source_warehouse_id, r.destination_warehouse_id,
            r.source_organization_id AS req_src_org, r.destination_organization_id AS req_dst_org,
            r.status AS req_status, r.requested_by_side, r.return_number
       FROM warehouse_return_request_lines l
       JOIN warehouse_return_requests r ON r.id = l.return_request_id
      WHERE l.original_transfer_line_id = $1 AND r.return_number = $2`,
    [transferLineId, number]);

  const counts = async (transferLineId: string) => one(
    `SELECT count(*)::int AS lines,
            count(DISTINCT l.return_request_id)::int AS headers
       FROM warehouse_return_request_lines l WHERE l.original_transfer_line_id = $1`,
    [transferLineId]);

  const stockSnapshot = async (stockId: string) => one(
    `SELECT on_hand_quantity, reserved_quantity, material_identity_key
       FROM warehouse_stock WHERE id=$1`, [stockId]);

  // ── R1.5-F1-C1 helpers ─────────────────────────────────────────────────────
  /**
   * TWO independent transfer lines drawn from ONE central lot, so both receipts
   * resolve to the SAME canonical warehouse_stock row at the holder. 150's
   * identity tuple is what merges them; a second SEPARATE central receipt would
   * carry its own internal_batch_reference and never merge, which is precisely
   * why the merge has to be built this way rather than asserted.
   */
  async function deliverTwoLinesOneLot(material: string, total: number, qtyA: number, qtyB: number) {
    return asSuper(async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, material, total, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const out: { transferLineId: string; stockId: string }[] = [];
      for (const q of [qtyA, qtyB]) {
        const s = await call(c, 'phoenix_send_warehouse_transfer_line', [
          randomUUID(), ROUTE, rc.warehouse_stock_id, q, uniq('WT'), null, null, null]);
        const r = await call(c, 'phoenix_receive_warehouse_transfer_line', [
          randomUUID(), s.transfer_line_id, q, null, null]);
        out.push({ transferLineId: s.transfer_line_id, stockId: r.warehouse_stock_id });
      }
      return out;
    });
  }

  /** Move the holder's custody through the REAL two-person correction contract. */
  async function correctCustodyTo(stockId: string, newQuantity: number) {
    const req: any = await asUser(CORR_REQ, (c: any) =>
      call(c, 'phoenix_request_warehouse_stock_correction',
        [randomUUID(), stockId, newQuantity, 'physical count adjustment', null, null, null]));
    if (req.requires_approval) {
      await asUser(CORR_APP, (c: any) =>
        call(c, 'phoenix_approve_warehouse_stock_correction', [req.correction_request_id, null]));
    }
  }

  /** Every LIVE obligation resolving to one canonical lot, from ANY provenance. */
  const liveObligationOnLot = async (stockId: string) => (await one(
    `SELECT COALESCE(sum(GREATEST(l.requested_quantity - l.fulfilled_quantity, 0)), 0)::int AS q
       FROM warehouse_return_request_lines l
       JOIN warehouse_return_requests r ON r.id = l.return_request_id
       JOIN warehouse_transfer_lines otl ON otl.id = l.original_transfer_line_id
      WHERE otl.resulting_warehouse_stock_id = $1
        AND l.status NOT IN ('rejected', 'cancelled', 'fulfilled')
        AND r.status NOT IN ('rejected', 'cancelled')`, [stockId])).q;

  const unreservedCustody = async (stockId: string) => {
    const s = await stockSnapshot(stockId);
    return s.on_hand_quantity - s.reserved_quantity;
  };

  // ── R1.5-F1-C2 helpers ─────────────────────────────────────────────────────
  /** The canonical predicate itself, so tests assert the shipped definition. */
  const outstanding = async (
    stockId: string | null, transferLineId: string | null, scope: string,
  ) => (await one(
    `SELECT public._phoenix_warehouse_return_outstanding_v1($1,$2,NULL,$3) AS q`,
    [stockId, transferLineId, scope])).q;

  /** A real MANUAL warehouse return: holder requests, adds a line, submits. */
  async function manualReturn(transferLineId: string, qty: number) {
    return asUser(CORR_REQ, async (c: any) => {
      const req = await call(c, 'phoenix_request_warehouse_return', [ROUTE, WH_INST, uniq('MAN')]);
      const id = req.return_request_id ?? req.id;
      const ln = await call(c, 'phoenix_add_warehouse_return_request_line',
        [id, transferLineId, qty, 'excess', 'c2-manual']);
      await call(c, 'phoenix_submit_warehouse_return_request', [id]);
      return { requestId: id as string, lineId: ln.return_request_line_id as string };
    });
  }
  const reviewLine = (requestId: string, lineId: string, approved: number) =>
    asUser(RECALLER, (c: any) => call(c, 'phoenix_review_warehouse_return_request',
      [requestId, JSON.stringify([{ line_id: lineId, approved_quantity: approved }])]));

  /** The recall's own draft header + line, submitted so it can be reviewed. */
  async function submittedRecall(transferLineId: string, number: string) {
    await recall(RECALLER, transferLineId, number);
    const row = await one(
      `SELECT l.id AS line_id, r.id AS request_id
         FROM warehouse_return_request_lines l
         JOIN warehouse_return_requests r ON r.id = l.return_request_id
        WHERE l.original_transfer_line_id=$1 AND btrim(r.return_number)=$2`,
      [transferLineId, number]);
    await asUser(RECALLER, (c: any) =>
      call(c, 'phoenix_submit_warehouse_return_request', [row.request_id]));
    return { requestId: row.request_id as string, lineId: row.line_id as string };
  }
  const sendReturn = (requestId: string, lineId: string, qty: number) =>
    asUser(CORR_REQ, (c: any) => call(c, 'phoenix_send_warehouse_return_shipment_line',
      [requestId, ROUTE, lineId, qty, uniq('SHP'), null, null]));

  // ── 1-3. The legacy empty-header paths are closed ──────────────────────────
  describe('F1.1 legacy header-only recalls fail closed', () => {
    it('1+3. routed legacy recall raises the stable selector token', async () => {
      const msg = await rejects(() => asUser(RECALLER, (c: any) =>
        call(c, 'phoenix_recall_warehouse_transfer', [ROUTE, WH_INST, uniq('LEG'), null])));
      expect(msg).toMatch(/recall_selector_required/);
    });

    it('2+3. direct legacy recall raises the stable selector token', async () => {
      const msg = await rejects(() => asUser(RECALLER, (c: any) =>
        call(c, 'phoenix_recall_direct_warehouse_transfer',
          [WH_INST, WH_CENTRAL, uniq('LEG'), null])));
      expect(msg).toMatch(/recall_selector_required/);
    });

    it('1+2. neither legacy path leaves ANY draft header behind', async () => {
      const before = (await one(`SELECT count(*)::int AS n FROM warehouse_return_requests`)).n;
      await rejects(() => asUser(RECALLER, (c: any) =>
        call(c, 'phoenix_recall_warehouse_transfer', [ROUTE, WH_INST, uniq('LEG'), null])));
      await rejects(() => asUser(RECALLER, (c: any) =>
        call(c, 'phoenix_recall_direct_warehouse_transfer', [WH_INST, WH_CENTRAL, uniq('LEG'), null])));
      const after = (await one(`SELECT count(*)::int AS n FROM warehouse_return_requests`)).n;
      expect(after).toBe(before);
    });
  });

  // ── 4-9, 24. Materialization ───────────────────────────────────────────────
  describe('F1.2 selector materializes a real obligation', () => {
    it('5+7+8+24. ROUTED line: header corridor is receiver->sender, line names the real receipt, reason recalled', async () => {
      const d = await deliverRouted(uniq('mat-routed'), 10);
      const num = uniq('RC');
      const res = await recall(RECALLER, d.transferLineId, num);
      expect(res.ok).toBe(true);
      expect(res.obligations_created).toBe(1);

      const row = await lineRow(d.transferLineId, num);
      // corridor: the CURRENT HOLDER returns to the ORIGINAL SENDER
      expect(row.source_warehouse_id).toBe(WH_INST);
      expect(row.destination_warehouse_id).toBe(WH_CENTRAL);
      expect(row.req_src_org).toBe(ORG_INST);
      expect(row.req_dst_org).toBe(ORG_CENTRAL);
      expect(row.route_id).toBe(ROUTE);
      expect(row.original_transfer_line_id).toBe(d.transferLineId);
      expect(row.reason_code).toBe('recalled');
      expect(row.requested_quantity).toBe(10);
      expect(row.req_status).toBe('draft');
      expect(row.requested_by_side).toBe('sender');
    });

    it('4+6. DIRECT line (route_id IS NULL) succeeds through the SAME rpc', async () => {
      const d = await deliverDirect(uniq('mat-direct'), 7);
      const num = uniq('RC');
      const res = await recall(RECALLER, d.transferLineId, num);
      expect(res.obligations_created).toBe(1);

      const row = await lineRow(d.transferLineId, num);
      // A direct corridor carries a NULL route on the return too — one RPC,
      // both corridors, difference DERIVED not declared.
      expect(row.route_id).toBeNull();
      expect(row.source_warehouse_id).toBe(WH_INST);
      expect(row.destination_warehouse_id).toBe(WH_CENTRAL);
      expect(row.requested_quantity).toBe(7);
    });

    it('9. the line snapshot is copied from the locked receipt, and the canonical identity resolves on the resulting stock', async () => {
      const material = uniq('mat-ident');
      const d = await deliverRouted(material, 5);
      const num = uniq('RC');
      await recall(RECALLER, d.transferLineId, num);

      const row = await lineRow(d.transferLineId, num);
      const orig = await one(
        `SELECT scientific_name, batch_number, expiry_date, internal_batch_reference,
                national_code, unit, resulting_warehouse_stock_id
           FROM warehouse_transfer_lines WHERE id=$1`, [d.transferLineId]);
      expect(row.scientific_name).toBe(orig.scientific_name);
      expect(row.batch_number).toBe(orig.batch_number);
      expect(row.internal_batch_reference).toBe(orig.internal_batch_reference);
      expect(String(row.expiry_date ?? '')).toBe(String(orig.expiry_date ?? ''));

      const stock = await stockSnapshot(orig.resulting_warehouse_stock_id);
      expect(stock.material_identity_key).toBeTruthy();
    });

    it('10+11. the public signature accepts ONLY (selector, number, notes) — no identity, org, warehouse or quantity', async () => {
      const sig = await one(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_recall_warehouse_transfer_line'`);
      expect(sig.args).toBe('p_original_transfer_line_id uuid, p_return_number text, p_notes text');
      expect(sig.args).not.toMatch(/organization|warehouse_id|quantity|material|batch/);
    });
  });

  // ── 12-14. Recall creation moves nothing ───────────────────────────────────
  describe('F1.3 recall creation is an instruction, never a movement', () => {
    it('12+13+14. zero delta on stock, quarantine and both movement ledgers', async () => {
      const d = await deliverRouted(uniq('mat-nodelta'), 9);
      const before = await stockSnapshot(d.stockId);
      const q0 = (await one(`SELECT count(*)::int AS n FROM warehouse_quarantine_stock`)).n;
      const m0 = (await one(`SELECT count(*)::int AS n FROM warehouse_stock_movements`)).n;
      const o0 = (await one(`SELECT count(*)::int AS n FROM outlet_stock_movements`)).n;

      await recall(RECALLER, d.transferLineId, uniq('RC'));

      const after = await stockSnapshot(d.stockId);
      expect(after.on_hand_quantity).toBe(before.on_hand_quantity);
      expect(after.reserved_quantity).toBe(before.reserved_quantity);
      expect((await one(`SELECT count(*)::int AS n FROM warehouse_quarantine_stock`)).n).toBe(q0);
      expect((await one(`SELECT count(*)::int AS n FROM warehouse_stock_movements`)).n).toBe(m0);
      expect((await one(`SELECT count(*)::int AS n FROM outlet_stock_movements`)).n).toBe(o0);
    });
  });

  // ── 15-17. Replay ──────────────────────────────────────────────────────────
  describe('F1.4 replay and reference semantics', () => {
    it('15. same selector + same return_number reuses the obligation — no duplicate header or line', async () => {
      const d = await deliverRouted(uniq('mat-replay'), 8);
      const num = uniq('RC');
      const first = await recall(RECALLER, d.transferLineId, num);
      expect(first.obligations_created).toBe(1);
      expect(first.obligations_reused).toBe(0);

      const second = await recall(RECALLER, d.transferLineId, num);
      expect(second.obligations_created).toBe(0);
      expect(second.obligations_reused).toBe(1);

      const c = await counts(d.transferLineId);
      expect(c.lines).toBe(1);
      expect(c.headers).toBe(1);
    });

    it('16. the SAME external reference + a different selector at the SAME holder APPENDS a line to the one header', async () => {
      // wrr_src_org_number_uniq is UNIQUE (source_organization_id,
      // btrim(return_number)): one reference names ONE request per holder. A
      // return request is a many-line document, so a second receipt under the
      // same reference must join it — not collide with a raw unique violation.
      const shared = uniq('RC-SHARED');
      const a = await deliverRouted(uniq('mat-shareA'), 4);
      const b = await deliverRouted(uniq('mat-shareB'), 4);
      expect((await recall(RECALLER, a.transferLineId, shared)).obligations_created).toBe(1);
      expect((await recall(RECALLER, b.transferLineId, shared)).obligations_created).toBe(1);
      expect((await counts(a.transferLineId)).lines).toBe(1);
      expect((await counts(b.transferLineId)).lines).toBe(1);

      // Exactly ONE header carries both obligations.
      const hdr = await one(
        `SELECT count(*)::int AS headers,
                (SELECT count(*)::int FROM warehouse_return_request_lines l
                  WHERE l.return_request_id = r.id) AS lines
           FROM warehouse_return_requests r
          WHERE r.source_organization_id=$1 AND btrim(r.return_number)=$2
          GROUP BY r.id`, [ORG_INST, shared]);
      expect(hdr.headers).toBe(1);
      expect(hdr.lines).toBe(2);
    });

    it('16b. one reference legitimately spans two corridors at the same holder (M1)', async () => {
      // MODEL REPLACED BY R1.5-F2-M1. This case — the same holder received from
      // TWO different central warehouses — used to raise
      // recall_reference_corridor_mismatch, because 069 keyed the reference
      // ORGANIZATION-wide and a second corridor was unrepresentable. That
      // assumption is what blocked F2: a health sector holds stock at both its
      // Sector Main and a Health Centre Depot, one organization, two corridors.
      // wrr_corridor_number_uniq now keys per corridor, so this is TWO headers
      // under ONE operator reference, and no raw unique violation.
      const shared = uniq('RC-CORRIDOR');
      const a = await deliverRouted(uniq('mat-corr'), 4);
      expect((await recall(RECALLER, a.transferLineId, shared)).obligations_created).toBe(1);

      const b = await deliverFromSecondCentral(uniq('mat-corr2'), 4);
      expect((await recall(RECALLER, b.transferLineId, shared)).obligations_created).toBe(1);
      expect((await counts(a.transferLineId)).lines).toBe(1);
      expect((await counts(b.transferLineId)).lines).toBe(1);

      // Two DISTINCT headers, same holder organization, same external reference.
      const hdrs = await admin(
        `SELECT r.id, r.source_warehouse_id, r.destination_warehouse_id, r.route_id
           FROM warehouse_return_requests r
          WHERE btrim(r.return_number)=$1 AND r.source_organization_id=$2
          ORDER BY r.created_at`, [shared, ORG_INST]);
      expect(hdrs.rows).toHaveLength(2);
      expect(hdrs.rows[0].destination_warehouse_id).toBe(WH_CENTRAL);
      expect(hdrs.rows[1].destination_warehouse_id).toBe(WH_CENTRAL2);
      // ...and both are still the SAME holder warehouse returning outward.
      expect(new Set(hdrs.rows.map((r: any) => r.source_warehouse_id))).toEqual(new Set([WH_INST]));
    });

    it('17. same selector + a DIFFERENT reference cannot double-obligate: exposure is already committed', async () => {
      // Documented behaviour: replay keys on provenance + reference + corridor,
      // so a second reference is NOT deduplicated — but CAP B has already
      // consumed the exposure, so it creates nothing rather than a second
      // physical obligation.
      const d = await deliverRouted(uniq('mat-tworef'), 6);
      expect((await recall(RECALLER, d.transferLineId, uniq('RC-1'))).obligations_created).toBe(1);
      const second = await recall(RECALLER, d.transferLineId, uniq('RC-2'));
      expect(second.obligations_created).toBe(0);
      expect((await counts(d.transferLineId)).lines).toBe(1);
    });
  });

  // ── 18-20. Caps ────────────────────────────────────────────────────────────
  describe('F1.5 truthful exposure caps', () => {
    it('19. already-returned quantity reduces exposure', async () => {
      const d = await deliverRouted(uniq('mat-returned'), 10);
      await admin(`UPDATE warehouse_transfer_lines SET returned_quantity=6 WHERE id=$1`,
        [d.transferLineId]);
      const num = uniq('RC');
      await recall(RECALLER, d.transferLineId, num);
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(4);
    });

    it('18. an existing live manual return commitment reduces exposure', async () => {
      const d = await deliverRouted(uniq('mat-commit'), 10);
      await asSuper(async (c: any) => {
        const wr = await call(c, 'phoenix_request_warehouse_return', [ROUTE, WH_INST, uniq('WR')]);
        const wrId = wr.return_request_id ?? wr.id;
        await call(c, 'phoenix_add_warehouse_return_request_line',
          [wrId, d.transferLineId, 7, 'excess', 'f1-commit']);
        await call(c, 'phoenix_submit_warehouse_return_request', [wrId]);
      });
      const num = uniq('RC');
      await recall(RECALLER, d.transferLineId, num);
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(3);
    });

    it('20. zero truthful exposure creates NO header and NO zero-quantity line', async () => {
      const d = await deliverRouted(uniq('mat-zero'), 5);
      await admin(`UPDATE warehouse_transfer_lines SET returned_quantity=5 WHERE id=$1`,
        [d.transferLineId]);
      const before = (await one(`SELECT count(*)::int AS n FROM warehouse_return_requests`)).n;
      const res = await recall(RECALLER, d.transferLineId, uniq('RC'));
      expect(res.ok).toBe(true);
      expect(res.obligations_created).toBe(0);
      expect((await counts(d.transferLineId)).lines).toBe(0);
      expect((await one(`SELECT count(*)::int AS n FROM warehouse_return_requests`)).n).toBe(before);
    });

    it('CAP C. present custody bounds the obligation below the historical remainder', async () => {
      const d = await deliverRouted(uniq('mat-custody'), 10);
      // Physically only 2 remain unreserved, though history says 10 are returnable.
      await admin(`UPDATE warehouse_stock SET on_hand_quantity=2, reserved_quantity=0 WHERE id=$1`,
        [d.stockId]);
      const num = uniq('RC');
      await recall(RECALLER, d.transferLineId, num);
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(2);
    });
  });

  // ── 21-23. Security ────────────────────────────────────────────────────────
  describe('F1.6 authority and IDOR posture', () => {
    it('21. an actor without recall authority on the SENDER is refused', async () => {
      const d = await deliverRouted(uniq('mat-foreign'), 5);
      const msg = await rejects(() => recall(OUTSIDER, d.transferLineId, uniq('RC')));
      expect(msg).toMatch(/forbidden_warehouse_recall/);
      expect((await counts(d.transferLineId)).lines).toBe(0);
    });

    it('21+22. a nonexistent selector is refused with the SAME token — no existence oracle', async () => {
      const real = await deliverRouted(uniq('mat-oracle'), 3);
      const foreign = await rejects(() => recall(OUTSIDER, real.transferLineId, uniq('RC')));
      const missing = await rejects(() => recall(OUTSIDER, randomUUID(), uniq('RC')));
      // Identical token for "exists but not yours" and "does not exist".
      expect(foreign).toMatch(/forbidden_warehouse_recall/);
      expect(missing).toMatch(/forbidden_warehouse_recall/);
      expect(missing.replace(/[0-9a-f-]{36}/g, '')).toBe(foreign.replace(/[0-9a-f-]{36}/g, ''));
    });

    it('22. denial leaks no holder identity', async () => {
      const d = await deliverRouted(uniq('mat-leak'), 3);
      const msg = await rejects(() => recall(OUTSIDER, d.transferLineId, uniq('RC')));
      for (const secret of [ORG_INST, WH_INST, 'IWH', 'مخزنI']) {
        expect(msg).not.toContain(secret);
      }
    });

    it('23. the private cap helper is unreachable by client roles, and no permission key was added', async () => {
      const priv = await one(
        `SELECT has_function_privilege('authenticated',
           'public._phoenix_warehouse_recall_exposure_v1(uuid,uuid)'::regprocedure,'EXECUTE') AS a,
                has_function_privilege('anon',
           'public._phoenix_warehouse_recall_exposure_v1(uuid,uuid)'::regprocedure,'EXECUTE') AS b`);
      expect(priv.a).toBe(false);
      expect(priv.b).toBe(false);

      const keys = await one(
        `SELECT count(*)::int AS n FROM permission_keys
          WHERE key ILIKE '%recall%' AND key NOT IN
            ('warehouse_transfer.recall','outlet_stock.recall','warehouse_transfer.recall_requested','outlet_stock.recalled')`);
      expect(keys.n).toBe(0);
    });

    it('23. health_center_manager gained no recall capability', async () => {
      const hcm = await one(
        `SELECT count(*)::int AS n FROM role_permission_defaults
          WHERE role='health_center_manager' AND allowed = true
            AND permission_key IN ('warehouse_transfer.recall','outlet_stock.recall',
                                   'warehouse_transfer.return_request')`);
      expect(hcm.n).toBe(0);
    });

    it('the response carries counts only — no cross-tenant detail', async () => {
      const d = await deliverRouted(uniq('mat-resp'), 4);
      const res = await recall(RECALLER, d.transferLineId, uniq('RC'));
      expect(Object.keys(res).sort())
        .toEqual(['obligations_created', 'obligations_reused', 'ok', 'return_number']);
      expect(JSON.stringify(res)).not.toContain(WH_INST);
      expect(JSON.stringify(res)).not.toContain(ORG_INST);
    });
  });

  // ── R1.5-F1-C1. THE AGGREGATE PHYSICAL BUDGET ──────────────────────────────
  // The defect these close: the exposure helper deducted live commitments from
  // the PROVENANCE remainder only, while the physical term re-offered the whole
  // shelf (`on_hand - reserved`) on every call. Each individual answer honoured
  // both bounds, so nothing above caught it — the breach only exists in the SUM.
  //
  // Every test here therefore asserts the GLOBAL invariant
  //     SUM(live requested on the lot) <= unreserved custody
  // and not merely the size of the line it just created. The pre-C1 build passes
  // the per-call assertions and fails these.
  //
  // Custody is moved exclusively through the genuine two-person correction RPCs,
  // never a raw UPDATE, so none of this depends on unreachable state.
  describe('F1.7 aggregate physical budget on the canonical lot (C1)', () => {
    it('C1-1. the reproduction: one selector under six documents cannot outrun a short shelf', async () => {
      // received 100, returned 0, but only 30 physically in custody.
      const d = await deliverRouted(uniq('c1-repro'), 100);
      await correctCustodyTo(d.stockId, 30);
      expect(await unreservedCustody(d.stockId)).toBe(30);

      const created: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        created.push((await recall(RECALLER, d.transferLineId, uniq(`DOC${i}`))).obligations_created);
      }
      // Pre-C1 this was [1,1,1,1,0,0] totalling 30+30+30+10 = 100 obligation.
      expect(created).toEqual([1, 0, 0, 0, 0, 0]);
      expect((await counts(d.transferLineId)).lines).toBe(1);
      expect(await liveObligationOnLot(d.stockId)).toBe(30);
      expect(await liveObligationOnLot(d.stockId))
        .toBeLessThanOrEqual(await unreservedCustody(d.stockId));
    });

    it('C1-2. two DIFFERENT provenance anchors merged into ONE lot cannot both claim the shelf', async () => {
      const [a, b] = await deliverTwoLinesOneLot(uniq('c1-merge'), 100, 40, 60);
      expect(a.stockId).toBe(b.stockId);            // the merge is real, not assumed
      await correctCustodyTo(a.stockId, 30);

      expect((await recall(RECALLER, a.transferLineId, uniq('MA'))).obligations_created).toBe(1);
      // B's own history says 60 are returnable and its provenance is untouched by
      // A's recall — only the SHARED shelf stops it.
      expect((await recall(RECALLER, b.transferLineId, uniq('MB'))).obligations_created).toBe(0);

      // No provenance fabrication: A's obligation stays anchored to A.
      expect((await counts(a.transferLineId)).lines).toBe(1);
      expect((await counts(b.transferLineId)).lines).toBe(0);
      expect(await liveObligationOnLot(a.stockId)).toBe(30);
      expect(await liveObligationOnLot(a.stockId))
        .toBeLessThanOrEqual(await unreservedCustody(a.stockId));
    });

    it('C1-3. the provenance cap still binds independently — a full shelf does not widen it', async () => {
      // 100 on the shelf, but this line only ever delivered 30.
      const [a] = await deliverTwoLinesOneLot(uniq('c1-prov'), 100, 30, 70);
      expect(await unreservedCustody(a.stockId)).toBe(100);
      const num = uniq('PV');
      await recall(RECALLER, a.transferLineId, num);
      expect((await lineRow(a.transferLineId, num)).requested_quantity).toBe(30);
    });

    it('C1-4. replay of the SAME reference is decided before sizing — the obligation is never shrunk', async () => {
      // The lot is short, so a naive "subtract every live line" would re-price
      // this obligation down to zero on replay instead of reusing it.
      const d = await deliverRouted(uniq('c1-replay'), 40);
      await correctCustodyTo(d.stockId, 12);
      const num = uniq('RP');
      expect((await recall(RECALLER, d.transferLineId, num)).obligations_created).toBe(1);
      const before = (await lineRow(d.transferLineId, num)).requested_quantity;

      const again = await recall(RECALLER, d.transferLineId, num);
      expect(again.obligations_reused).toBe(1);
      expect(again.obligations_created).toBe(0);
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(before);
      expect(before).toBe(12);
      expect((await counts(d.transferLineId)).lines).toBe(1);
    });

    it('C1-5. capacity is DERIVED, so legitimate custody growth makes it recallable again', async () => {
      const [a, b] = await deliverTwoLinesOneLot(uniq('c1-grow'), 100, 40, 60);
      await correctCustodyTo(a.stockId, 30);
      await recall(RECALLER, a.transferLineId, uniq('GA'));
      expect((await recall(RECALLER, b.transferLineId, uniq('GB'))).obligations_created).toBe(0);

      // A real recount finds 55. The extra 25 becomes recallable — no persisted
      // "already consumed" counter is holding the lot down.
      await correctCustodyTo(a.stockId, 55);
      const num = uniq('GC');
      expect((await recall(RECALLER, b.transferLineId, num)).obligations_created).toBe(1);
      expect((await lineRow(b.transferLineId, num)).requested_quantity).toBe(25);
      expect(await liveObligationOnLot(a.stockId)).toBe(55);
      expect(await liveObligationOnLot(a.stockId))
        .toBeLessThanOrEqual(await unreservedCustody(a.stockId));
    });

    it('C1-6. cancelling a request releases the physical capacity it held', async () => {
      const d = await deliverRouted(uniq('c1-cancel'), 50);
      await correctCustodyTo(d.stockId, 20);
      const first = uniq('CA');
      await recall(RECALLER, d.transferLineId, first);
      expect((await recall(RECALLER, d.transferLineId, uniq('CB'))).obligations_created).toBe(0);

      const hdr = await one(
        `SELECT r.id FROM warehouse_return_requests r WHERE btrim(r.return_number)=$1`, [first]);
      await asUser(RECALLER, (c: any) =>
        call(c, 'phoenix_cancel_warehouse_return_request', [hdr.id, 'operator withdrew the recall']));
      expect(await liveObligationOnLot(d.stockId)).toBe(0);

      const num = uniq('CC');
      expect((await recall(RECALLER, d.transferLineId, num)).obligations_created).toBe(1);
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(20);
      expect(await liveObligationOnLot(d.stockId))
        .toBeLessThanOrEqual(await unreservedCustody(d.stockId));
    });

    it('C1-7. reserved units are excluded AND netted against other live obligations', async () => {
      const [a, b] = await deliverTwoLinesOneLot(uniq('c1-reserved'), 60, 30, 30);
      await correctCustodyTo(a.stockId, 40);
      // 15 of the 40 are promised elsewhere, so only 25 are truly available.
      await admin(`UPDATE warehouse_stock SET reserved_quantity=15 WHERE id=$1`, [a.stockId]);
      expect(await unreservedCustody(a.stockId)).toBe(25);

      const na = uniq('RA');
      await recall(RECALLER, a.transferLineId, na);
      expect((await lineRow(a.transferLineId, na)).requested_quantity).toBe(25);
      expect((await recall(RECALLER, b.transferLineId, uniq('RB'))).obligations_created).toBe(0);
      expect(await liveObligationOnLot(a.stockId)).toBe(25);
    });

    it('C1-8. an emptied shelf yields no obligation even with untouched provenance', async () => {
      const d = await deliverRouted(uniq('c1-empty'), 18);
      await correctCustodyTo(d.stockId, 0);
      const before = (await one(`SELECT count(*)::int AS n FROM warehouse_return_requests`)).n;
      const res = await recall(RECALLER, d.transferLineId, uniq('EM'));
      expect(res.obligations_created).toBe(0);
      expect((await counts(d.transferLineId)).lines).toBe(0);
      expect((await one(`SELECT count(*)::int AS n FROM warehouse_return_requests`)).n).toBe(before);
      // Historical receipt is intact — it is custody, not history, that refused.
      expect((await one(
        `SELECT received_quantity AS q FROM warehouse_transfer_lines WHERE id=$1`,
        [d.transferLineId])).q).toBe(18);
    });

    it('C1-9. the aggregate budget and the lot lock are pinned structurally', async () => {
      const def = await one(
        `SELECT pg_get_functiondef(
           'public._phoenix_warehouse_recall_exposure_v1(uuid,uuid)'::regprocedure) AS d`);
      // C2 moved the census itself into the shared predicate; the exposure helper
      // must take BOTH budgets from it and still net custody down by the physical one.
      expect(def.d).toContain(
        `_phoenix_warehouse_return_outstanding_v1(\n    v_orig.resulting_warehouse_stock_id, NULL, NULL, 'all_actionable')`);
      expect(def.d).toContain(
        `_phoenix_warehouse_return_outstanding_v1(\n    NULL, p_original_transfer_line_id, NULL, 'all_actionable')`);
      expect(def.d).toContain('COALESCE(v_available, 0) - v_other_phys');
      // and the provenance budget survives beside it
      expect(def.d).toContain('LEAST(v_prov, v_phys)');

      // the canonical lot grouping now lives — exactly once — in the predicate
      const pred = await one(
        `SELECT pg_get_functiondef(
           'public._phoenix_warehouse_return_outstanding_v1(uuid,uuid,uuid[],text)'::regprocedure) AS d`);
      expect(pred.d).toContain('otl.resulting_warehouse_stock_id = p_resulting_warehouse_stock_id');
      expect(pred.d).toContain('l.original_transfer_line_id = p_original_transfer_line_id');
      // ONE live-status census for every consumer
      expect(pred.d.split(`l.status NOT IN ('rejected', 'cancelled', 'fulfilled')`).length - 1).toBe(1);
      expect(pred.d.split(`r.status NOT IN ('rejected', 'cancelled')`).length - 1).toBe(1);

      // R1.5-F2 moved obligation writing into the shared materializer, so the lot
      // lock lives there — one place for the root receipt and every downstream one.
      const writer = await one(
        `SELECT pg_get_functiondef(
           'public._phoenix_materialize_warehouse_recall_obligation_v1(uuid,text,text,uuid,text,uuid)'::regprocedure) AS d`);
      // two recalls of different transfer lines share neither the advisory key nor
      // the transfer-line lock; the lot lock is what serializes them.
      expect(writer.d).toContain('WHERE id = v_orig.resulting_warehouse_stock_id FOR UPDATE');
      // ...and the entry point additionally locks the whole descendant set in one
      // deterministic order before any of them is sized.
      const rpc = await one(
        `SELECT pg_get_functiondef(
           'public.phoenix_recall_warehouse_transfer_line(uuid,text,text)'::regprocedure) AS d`);
      expect(rpc.d).toContain('SELECT unnest(v_lines) ORDER BY 1');
      expect(rpc.d).toContain('FROM public.warehouse_stock WHERE id = v_id FOR UPDATE');
    });

    it('C1-11. creating and replaying under the new budget still moves no stock', async () => {
      const d = await deliverRouted(uniq('c1-nodelta'), 24);
      await correctCustodyTo(d.stockId, 10);
      const snap = async () => one(
        `SELECT (SELECT COALESCE(sum(on_hand_quantity),0) FROM warehouse_stock)::int AS ws,
                (SELECT COALESCE(sum(reserved_quantity),0) FROM warehouse_stock)::int AS wr,
                (SELECT COALESCE(sum(quantity),0) FROM warehouse_quarantine_stock)::int AS wq,
                (SELECT count(*)::int FROM warehouse_stock_movements) AS wm,
                (SELECT COALESCE(sum(on_hand_quantity),0) FROM outlet_stock)::int AS os,
                (SELECT count(*)::int FROM outlet_stock_movements) AS om`);
      const before = await snap();
      const num = uniq('ND');
      await recall(RECALLER, d.transferLineId, num);
      expect(await snap()).toEqual(before);
      await recall(RECALLER, d.transferLineId, num);       // replay
      await recall(RECALLER, d.transferLineId, uniq('ND2')); // exhausted budget
      expect(await snap()).toEqual(before);
    });
  });

  // ── R1.5-F1-C2. ONE CANONICAL OUTSTANDING-COMMITMENT CENSUS ────────────────
  // C1 closed recall-vs-recall. It left a CROSS-WORKFLOW hole, because recall
  // sizing and review arbitration each carried their own census: F1 counted
  // PENDING lines, review counted only approved/partially_fulfilled. So a recall
  // could size itself against the whole shelf and a separate manual return could
  // then be approved over the top of it — custody 30, recall pending 30, manual
  // approved 20, i.e. 50 units able to reach SEND against a 30-unit lot.
  //
  // Both callers now derive from _phoenix_warehouse_return_outstanding_v1.
  //
  // THE SCOPES ARE NOT ARBITRARY. Review deliberately does NOT count pending
  // MANUAL lines: a pending manual return is a request, and review is the gate
  // that arbitrates competing requests first-come-first-served. Counting them
  // would refuse the FIRST of two competing 20-unit requests on a 30-unit lot
  // purely because the second exists, and the two would deadlock. A pending
  // RECALL is not a request — it is machine-sized to available custody, so it
  // can neither overdraw the lot nor deadlock, and it outranks a routine return.
  // Test C2-5 pins that arbitration explicitly.
  describe('F1.8 cross-workflow cap consistency (C2)', () => {
    it('C2-1. a PENDING recall cannot be spent by a manual return approval', async () => {
      const d = await deliverRouted(uniq('c2-a'), 100);
      await correctCustodyTo(d.stockId, 30);
      expect((await recall(RECALLER, d.transferLineId, uniq('XA'))).obligations_created).toBe(1);
      expect(await outstanding(d.stockId, null, 'committed_or_recall')).toBe(30);

      const m = await manualReturn(d.transferLineId, 20);
      await expect(reviewLine(m.requestId, m.lineId, 20)).rejects
        .toThrow(/warehouse_return_physical_cap_exceeded/);
      expect(await outstanding(d.stockId, null, 'committed_or_recall'))
        .toBeLessThanOrEqual(await unreservedCustody(d.stockId));
    });

    it('C2-2. a pending MANUAL return still reduces what a recall may size itself to', async () => {
      const d = await deliverRouted(uniq('c2-b'), 100);
      await correctCustodyTo(d.stockId, 30);
      await manualReturn(d.transferLineId, 20);           // submitted, line pending
      const num = uniq('XB');
      await recall(RECALLER, d.transferLineId, num);
      // 30 custody - 20 already requested => the recall may only claim 10.
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(10);
      expect(await outstanding(d.stockId, null, 'all_actionable')).toBe(30);
    });

    it('C2-3. merged lot: a pending recall on A blocks a manual approval on B', async () => {
      const [a, b] = await deliverTwoLinesOneLot(uniq('c2-c'), 100, 20, 80);
      expect(a.stockId).toBe(b.stockId);
      await correctCustodyTo(a.stockId, 30);
      expect((await recall(RECALLER, a.transferLineId, uniq('XC'))).obligations_created).toBe(1);

      const m = await manualReturn(b.transferLineId, 20);
      await expect(reviewLine(m.requestId, m.lineId, 20)).rejects
        .toThrow(/warehouse_return_physical_cap_exceeded/);
      expect(await outstanding(a.stockId, null, 'committed_or_recall'))
        .toBeLessThanOrEqual(await unreservedCustody(a.stockId));
    });

    it('C2-4. the line under review never counts itself — a recall approves in full', async () => {
      // The recall's own line is a PENDING 'recalled' row, which the new census
      // counts. Without the exclusion set every recall review would self-block.
      const d = await deliverRouted(uniq('c2-d'), 100);
      await correctCustodyTo(d.stockId, 30);
      const r = await submittedRecall(d.transferLineId, uniq('XD'));
      const res = await reviewLine(r.requestId, r.lineId, 30);
      expect(res.ok).toBe(true);
      expect((await one(
        `SELECT status, approved_quantity AS aq FROM warehouse_return_request_lines WHERE id=$1`,
        [r.lineId]))).toMatchObject({ status: 'approved', aq: 30 });
    });

    it('C2-5. manual-vs-manual arbitration is UNCHANGED — no mutual blocking', async () => {
      const d = await deliverRouted(uniq('c2-e'), 100);
      await correctCustodyTo(d.stockId, 30);
      const m1 = await manualReturn(d.transferLineId, 20);
      const m2 = await manualReturn(d.transferLineId, 20);

      // First-come-first-served: the FIRST approval must still succeed even though
      // a second 20-unit request is already pending against the same 30 units.
      expect((await reviewLine(m1.requestId, m1.lineId, 20)).ok).toBe(true);
      await expect(reviewLine(m2.requestId, m2.lineId, 20)).rejects
        .toThrow(/warehouse_return_physical_cap_exceeded/);
      // ...and the remainder is still approvable.
      expect((await reviewLine(m2.requestId, m2.lineId, 10)).ok).toBe(true);
      expect(await outstanding(d.stockId, null, 'committed_or_recall')).toBe(30);
    });

    it('C2-6. cancellation releases capacity for both workflows', async () => {
      const d = await deliverRouted(uniq('c2-f'), 100);
      await correctCustodyTo(d.stockId, 30);
      const first = uniq('XF');
      await recall(RECALLER, d.transferLineId, first);
      const hdr = await one(
        `SELECT id FROM warehouse_return_requests WHERE btrim(return_number)=$1`, [first]);
      await asUser(RECALLER, (c: any) =>
        call(c, 'phoenix_cancel_warehouse_return_request', [hdr.id, 'operator withdrew the recall']));
      expect(await outstanding(d.stockId, null, 'committed_or_recall')).toBe(0);
      expect(await outstanding(d.stockId, null, 'all_actionable')).toBe(0);

      const m = await manualReturn(d.transferLineId, 20);
      expect((await reviewLine(m.requestId, m.lineId, 20)).ok).toBe(true);
    });

    it('C2-7. rejection releases capacity', async () => {
      const d = await deliverRouted(uniq('c2-g'), 100);
      await correctCustodyTo(d.stockId, 30);
      const m = await manualReturn(d.transferLineId, 30);
      await reviewLine(m.requestId, m.lineId, 0);          // rejected
      expect((await one(`SELECT status FROM warehouse_return_request_lines WHERE id=$1`,
        [m.lineId])).status).toBe('rejected');
      expect(await outstanding(d.stockId, null, 'committed_or_recall')).toBe(0);
      const num = uniq('XG');
      await recall(RECALLER, d.transferLineId, num);
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(30);
    });

    it('C2-8. an approved line stays counted by BOTH scopes', async () => {
      const d = await deliverRouted(uniq('c2-h'), 100);
      await correctCustodyTo(d.stockId, 30);
      const m = await manualReturn(d.transferLineId, 20);
      await reviewLine(m.requestId, m.lineId, 20);
      expect(await outstanding(d.stockId, null, 'committed_or_recall')).toBe(20);
      expect(await outstanding(d.stockId, null, 'all_actionable')).toBe(20);
      const num = uniq('XH');
      await recall(RECALLER, d.transferLineId, num);
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(10);
    });

    it('C2-9. partially_fulfilled counts only the UNSENT remainder', async () => {
      const d = await deliverRouted(uniq('c2-i'), 100);
      await correctCustodyTo(d.stockId, 30);
      const m = await manualReturn(d.transferLineId, 20);
      await reviewLine(m.requestId, m.lineId, 20);
      await sendReturn(m.requestId, m.lineId, 8);
      expect((await one(`SELECT status FROM warehouse_return_request_lines WHERE id=$1`,
        [m.lineId])).status).toBe('partially_fulfilled');
      // 20 approved - 8 sent = 12 still able to reach SEND.
      expect(await outstanding(d.stockId, null, 'committed_or_recall')).toBe(12);
      expect(await outstanding(d.stockId, null, 'all_actionable')).toBe(12);
    });

    it('C2-10. a fulfilled line reserves nothing — SEND already took the units', async () => {
      const d = await deliverRouted(uniq('c2-j'), 100);
      await correctCustodyTo(d.stockId, 30);
      const m = await manualReturn(d.transferLineId, 20);
      await reviewLine(m.requestId, m.lineId, 20);
      await sendReturn(m.requestId, m.lineId, 20);
      expect((await one(`SELECT status FROM warehouse_return_request_lines WHERE id=$1`,
        [m.lineId])).status).toBe('fulfilled');
      expect(await outstanding(d.stockId, null, 'committed_or_recall')).toBe(0);
      // The shelf itself is what shrank: SEND debited it.
      expect(await unreservedCustody(d.stockId)).toBe(10);
      const num = uniq('XJ');
      await recall(RECALLER, d.transferLineId, num);
      expect((await lineRow(d.transferLineId, num)).requested_quantity).toBe(10);
    });

    it('C2-11. one predicate, two consumers, no private census left behind', async () => {
      const exposure = (await one(
        `SELECT pg_get_functiondef(
           'public._phoenix_warehouse_recall_exposure_v1(uuid,uuid)'::regprocedure) AS d`)).d;
      const caps = (await one(
        `SELECT pg_get_functiondef(
           'public._phoenix_validate_warehouse_return_review_caps_v1(uuid,jsonb)'::regprocedure) AS d`)).d;

      // recall sizing no longer reads the lines table at all
      expect(exposure).not.toContain('warehouse_return_request_lines');
      expect(exposure.split('_phoenix_warehouse_return_outstanding_v1').length - 1).toBe(2);
      // review derives BOTH caps from the predicate and passes the deciding lines
      expect(caps.split('_phoenix_warehouse_return_outstanding_v1').length - 1).toBe(2);
      expect(caps.split('(SELECT array_agg(line_id) FROM proposal)').length - 1).toBe(2);
      expect(caps).not.toContain(`o.status IN ('approved', 'partially_fulfilled')`);

      // the predicate is internal
      const priv = await one(
        `SELECT has_function_privilege('authenticated',
           'public._phoenix_warehouse_return_outstanding_v1(uuid,uuid,uuid[],text)'::regprocedure,'EXECUTE') AS a,
                has_function_privilege('anon',
           'public._phoenix_warehouse_return_outstanding_v1(uuid,uuid,uuid[],text)'::regprocedure,'EXECUTE') AS b`);
      expect(priv.a).toBe(false);
      expect(priv.b).toBe(false);
    });

    it('C2-12. an unkeyed total is refused rather than summing every return line', async () => {
      await expect(admin(
        `SELECT public._phoenix_warehouse_return_outstanding_v1(NULL,NULL,NULL,'all_actionable')`))
        .rejects.toThrow(/warehouse_return_outstanding_requires_a_grouping_key/);
      // The grouping-key guard fires first, so the scope guard needs a real key.
      const d = await deliverRouted(uniq('c2-k'), 5);
      await expect(admin(
        `SELECT public._phoenix_warehouse_return_outstanding_v1($1,NULL,NULL,'whatever')`,
        [d.stockId])).rejects.toThrow(/warehouse_return_outstanding_unknown_scope/);
      await expect(admin(
        `SELECT public._phoenix_warehouse_return_outstanding_v1($1,NULL,NULL,NULL)`,
        [d.stockId])).rejects.toThrow(/warehouse_return_outstanding_unknown_scope/);
    });
  });
});
