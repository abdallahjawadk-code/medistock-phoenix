/**
 * 185 · R1.5-F2 DOWNSTREAM WAREHOUSE RECALL — current-holder propagation.
 *
 * F1 created an obligation only at the IMMEDIATE receiver. When the recalled
 * stock had already moved onward, that obligation was sized to whatever was left
 * there — correctly — and the stock actually sitting downstream was reached by
 * nobody. F2 follows the real provenance one warehouse hop and binds every
 * CURRENT holder.
 *
 * THE GRAPH EDGE IS PROVENANCE, NOT IDENTITY:
 *     root line -> resulting_warehouse_stock_id = S1
 *     onward line WHERE source_warehouse_stock_id = S1 -> its own S2
 * material_identity_key is a VALIDATION invariant across the hop, never the edge.
 *
 * DEPTH: 181 forces every health-sector warehouse to warehouse_kind
 * 'institution' and 184's endpoint guards allow only
 *     central -> sector main -> facility-bound depot
 * so a depot can never be a supply source and the canonical warehouse graph is a
 * strict 3-level DAG — exactly ONE downstream hop. A deeper historical
 * descendant that still holds custody fails the recall closed rather than being
 * silently dropped.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_PDA = '00000000-0000-0000-0000-0000001852a1';
const ORG_SEC = '00000000-0000-0000-0000-0000001852a2';
const ORG_OTH = '00000000-0000-0000-0000-0000001852a3';
const W0   = '00000000-0000-0000-0000-0000001852b1';  // central, PDA
const W1   = '00000000-0000-0000-0000-0000001852b2';  // sector main
const W2   = '00000000-0000-0000-0000-0000001852b3';  // depot 1
const W3   = '00000000-0000-0000-0000-0000001852b4';  // depot 2
const WOTH = '00000000-0000-0000-0000-0000001852b5';  // unrelated hospital warehouse
const FAC1 = '00000000-0000-0000-0000-0000001852c1';
const FAC2 = '00000000-0000-0000-0000-0000001852c2';
const RECALLER = '00000000-0000-0000-0000-0000001852e1';  // PDA: recall + review_return
const SEC_A    = '00000000-0000-0000-0000-0000001852e2';  // sector operator
const SEC_B    = '00000000-0000-0000-0000-0000001852e3';  // sector second person
const OUTSIDER = '00000000-0000-0000-0000-0000001852e4';  // unrelated org

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('185 · R1.5-F2 downstream warehouse recall (001->185 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);
  const asSuper = <T>(fn: (c: any) => Promise<T>) =>
    rig.asUser(rig.superAdminId, fn, { commit: true }) as Promise<T>;
  const asUser = <T>(id: string, fn: (c: any) => Promise<T>) =>
    rig.asUser(id, fn, { commit: true }) as Promise<T>;
  const admin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const one = async (sql: string, params: any[] = []) => (await admin(sql, params)).rows[0];
  const rows = async (sql: string, params: any[] = []) => (await admin(sql, params)).rows;
  const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
    throw new Error('expected a rejection but the call succeeded');
  };

  const recall = (num: string, transferLineId: string, who: string = RECALLER) =>
    asUser(who, (c: any) =>
      call(c, 'phoenix_recall_warehouse_transfer_line', [transferLineId, num, null]));

  /** Every recall line raised against one transfer line, with its corridor. */
  const linesFor = (transferLineId: string) => rows(
    `SELECT l.requested_quantity AS qty, l.status, l.reason_code,
            r.source_warehouse_id AS src, r.destination_warehouse_id AS dst,
            r.source_organization_id AS srcorg, btrim(r.return_number) AS num, r.id AS hdr
       FROM warehouse_return_request_lines l
       JOIN warehouse_return_requests r ON r.id = l.return_request_id
      WHERE l.original_transfer_line_id = $1
      ORDER BY l.created_at`, [transferLineId]);

  const custody = async (stockId: string) => {
    const s = await one(
      `SELECT on_hand_quantity AS oh, reserved_quantity AS rv FROM warehouse_stock WHERE id=$1`,
      [stockId]);
    return s.oh - s.rv;
  };
  /** What can still consume this lot, through the CLOSED shared predicate. */
  const obligated = async (stockId: string) => (await one(
    `SELECT public._phoenix_warehouse_return_outstanding_v1($1,NULL,NULL,'committed_or_recall') AS q`,
    [stockId])).q;

  const census = () => one(
    `SELECT (SELECT COALESCE(sum(on_hand_quantity),0) FROM warehouse_stock)::int AS ws,
            (SELECT COALESCE(sum(reserved_quantity),0) FROM warehouse_stock)::int AS wr,
            (SELECT COALESCE(sum(quantity),0) FROM warehouse_quarantine_stock)::int AS wq,
            (SELECT count(*)::int FROM warehouse_stock_movements) AS wm,
            (SELECT COALESCE(sum(on_hand_quantity),0) FROM outlet_stock)::int AS os,
            (SELECT count(*)::int FROM outlet_stock_movements) AS om`);

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_PDA}','PDA','دائرة','f2-pda','pharmacy_department_authority',NULL),
        ('${ORG_SEC}','Sector','قطاع','f2-sec','care_institution','health_sector'),
        ('${ORG_OTH}','Other','مستشفى','f2-oth','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,code,status) VALUES
        ('${FAC1}','${ORG_SEC}','primary_health_center','HC1','مركز','f2-hc1','active'),
        ('${FAC2}','${ORG_SEC}','subordinate_health_center','HC2','مركز','f2-hc2','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id,is_main) VALUES
        ('${W0}','${ORG_PDA}','Central','مركزي','active','central','f2-w0',NULL,false),
        ('${W1}','${ORG_SEC}','SectorMain','رئيسي','active','institution','f2-w1',NULL,true),
        ('${W2}','${ORG_SEC}','Depot1','مستودع','active','institution','f2-w2','${FAC1}',false),
        ('${W3}','${ORG_SEC}','Depot2','مستودع','active','institution','f2-w3','${FAC2}',false),
        ('${WOTH}','${ORG_OTH}','OtherWh','مخزن','active','institution','f2-woth',NULL,true)
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${RECALLER}','f2-recaller@rig'),('${SEC_A}','f2-seca@rig'),
        ('${SEC_B}','f2-secb@rig'),('${OUTSIDER}','f2-out@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active',
        organization_id='${ORG_PDA}' WHERE id='${RECALLER}';`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active',
        organization_id='${ORG_SEC}' WHERE id IN ('${SEC_A}','${SEC_B}');`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active',
        organization_id='${ORG_OTH}' WHERE id='${OUTSIDER}';`);
      await c.query(`INSERT INTO profile_permission_overrides (profile_id,permission_key,allowed) VALUES
        ('${RECALLER}','warehouse_transfer.recall',true),
        ('${RECALLER}','warehouse_transfer.review_return',true),
        ('${SEC_A}','warehouse_stock.correct',true),
        ('${SEC_A}','warehouse_transfer.return_request',true),
        ('${SEC_A}','warehouse_transfer.return_send',true),
        ('${SEC_A}','warehouse_transfer.review_return',true),
        -- A downstream recall header is requested_by_side='sender', so 069's
        -- submit path asks for warehouse_transfer.recall at the header's
        -- DESTINATION - the Sector Main. That is the right domain shape: the
        -- sector owns the recall toward its own depot. It grants the initiating
        -- central actor nothing here.
        ('${SEC_A}','warehouse_transfer.recall',true),
        ('${SEC_B}','warehouse_stock.correct',true),
        ('${SEC_B}','warehouse_stock.approve_correction',true)
        ON CONFLICT (profile_id,permission_key) DO UPDATE SET allowed=true;`);
    });
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** One DIRECT supply hop through the genuine request/approve/send/receive chain. */
  async function hop(src: string, dstOrg: string, dst: string, qty: number,
                     material: string, fromStockId: string | null) {
    return asSuper(async (c: any) => {
      let stockId = fromStockId;
      if (!stockId) {
        const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
          randomUUID(), src, material, qty, true, true, 0,
          null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
        ]);
        stockId = rc.warehouse_stock_id;
      }
      const req = await call(c, 'phoenix_create_direct_warehouse_transfer_request',
        [src, dstOrg, dst, uniq('DREQ'), null]);
      const reqId = req.transfer_request_id ?? req.id;
      const ln = await call(c, 'phoenix_add_warehouse_transfer_request_line',
        [reqId, material, qty, null, null, null, null, null]);
      const lnId = ln.transfer_request_line_id ?? ln.id;
      await call(c, 'phoenix_submit_warehouse_transfer_request', [reqId]);
      await call(c, 'phoenix_review_warehouse_transfer_request',
        [reqId, JSON.stringify([{ line_id: lnId, approved_quantity: qty }])]);
      const s = await call(c, 'phoenix_send_direct_warehouse_transfer_line',
        [randomUUID(), reqId, stockId, qty, uniq('DTR'), lnId, null, null]);
      const r = await call(c, 'phoenix_receive_warehouse_transfer_line',
        [randomUUID(), s.transfer_line_id, qty, null, null]);
      return { tl: s.transfer_line_id as string, stock: r.warehouse_stock_id as string };
    });
  }

  /** Move a lot's custody through the REAL two-person correction contract. */
  async function correctTo(stockId: string, qty: number) {
    const req: any = await asUser(SEC_A, (c: any) =>
      call(c, 'phoenix_request_warehouse_stock_correction',
        [randomUUID(), stockId, qty, 'physical count adjustment', null, null, null]));
    if (req.requires_approval) {
      await asUser(SEC_B, (c: any) =>
        call(c, 'phoenix_approve_warehouse_stock_correction', [req.correction_request_id, null]));
    }
  }

  // ── A. ROOT ONLY ──────────────────────────────────────────────────────────
  it('F2-A. nothing moved onward: only the immediate receiver is bound', async () => {
    const m = uniq('f2-a');
    const root = await hop(W0, ORG_SEC, W1, 50, m, null);
    const num = uniq('A');
    expect((await recall(num, root.tl)).obligations_created).toBe(1);

    const lines = await linesFor(root.tl);
    expect(lines).toHaveLength(1);
    expect(lines[0].qty).toBe(50);
    expect([lines[0].src, lines[0].dst]).toEqual([W1, W0]);   // holder -> original sender
    expect(lines[0].reason_code).toBe('recalled');
  });

  // ── B. FULL DOWNSTREAM ────────────────────────────────────────────────────
  it('F2-B. everything moved onward: the emptied intermediate gets NOTHING, the depot gets the obligation', async () => {
    const m = uniq('f2-b');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    const down = await hop(W1, ORG_SEC, W2, 100, m, root.stock);
    expect(await custody(root.stock)).toBe(0);
    expect(await custody(down.stock)).toBe(100);

    const num = uniq('B');
    expect((await recall(num, root.tl)).obligations_created).toBe(1);

    // The intermediate holds nothing, so history alone raises no obligation.
    expect(await linesFor(root.tl)).toHaveLength(0);

    // The depot returns to its OWN immediate upstream, on the REAL onward line.
    const dl = await linesFor(down.tl);
    expect(dl).toHaveLength(1);
    expect(dl[0].qty).toBe(100);
    expect([dl[0].src, dl[0].dst]).toEqual([W2, W1]);
    expect(dl[0].num).toBe(num);
  });

  // ── C. SPLIT ──────────────────────────────────────────────────────────────
  it('F2-C. split custody produces two obligations, each bounded by its own lot', async () => {
    const m = uniq('f2-c');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    const down = await hop(W1, ORG_SEC, W2, 60, m, root.stock);
    expect(await custody(root.stock)).toBe(40);
    expect(await custody(down.stock)).toBe(60);

    const num = uniq('C');
    expect((await recall(num, root.tl)).obligations_created).toBe(2);

    const rl = await linesFor(root.tl);
    const dl = await linesFor(down.tl);
    expect(rl[0].qty).toBe(40);
    expect([rl[0].src, rl[0].dst]).toEqual([W1, W0]);
    expect(dl[0].qty).toBe(60);
    expect([dl[0].src, dl[0].dst]).toEqual([W2, W1]);
    // Neither exceeds its own physical stock row, and no double count of the 100.
    expect(await obligated(root.stock)).toBeLessThanOrEqual(await custody(root.stock));
    expect(await obligated(down.stock)).toBeLessThanOrEqual(await custody(down.stock));
    expect(rl[0].qty + dl[0].qty).toBe(100);
  });

  // ── D. BRANCHING ──────────────────────────────────────────────────────────
  it('F2-D. two depots fed from one lot each get their own corridor under ONE reference', async () => {
    const m = uniq('f2-d');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    const d2 = await hop(W1, ORG_SEC, W2, 30, m, root.stock);
    const d3 = await hop(W1, ORG_SEC, W3, 30, m, root.stock);

    const num = uniq('D');
    expect((await recall(num, root.tl)).obligations_created).toBe(3);   // W1, W2, W3

    expect([...(await linesFor(d2.tl))].map(l => [l.src, l.dst])).toEqual([[W2, W1]]);
    expect([...(await linesFor(d3.tl))].map(l => [l.src, l.dst])).toEqual([[W3, W1]]);

    // THREE headers, one external reference, all inside ONE organization for the
    // two depots — exactly what M1's corridor-aware key made representable.
    const hdrs = await rows(
      `SELECT source_warehouse_id AS src, destination_warehouse_id AS dst,
              source_organization_id AS org
         FROM warehouse_return_requests WHERE btrim(return_number)=$1 ORDER BY created_at`, [num]);
    expect(hdrs).toHaveLength(3);
    expect(hdrs.filter((h: any) => h.org === ORG_SEC)).toHaveLength(3);
    expect(new Set(hdrs.map((h: any) => `${h.src}->${h.dst}`)))
      .toEqual(new Set([`${W1}->${W0}`, `${W2}->${W1}`, `${W3}->${W1}`]));
  });

  // ── E. MERGED ROOT PROVENANCE ─────────────────────────────────────────────
  it('F2-E. merged root lot: downstream exposure is CONSERVATIVE and never claims exact attribution', async () => {
    // A and B are two real deliveries of the same canonical material from ONE
    // central lot, so they merge into a single S1. 60 then moves onward. Which
    // units that onward transfer carried is no longer knowable.
    const m = uniq('f2-e');
    const src = await asSuper(async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), W0, m, 100, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null]);
      return rc.warehouse_stock_id as string;
    });
    const a = await hop(W0, ORG_SEC, W1, 20, m, src);
    const b = await hop(W0, ORG_SEC, W1, 80, m, src);
    expect(a.stock).toBe(b.stock);                       // merged at the holder
    const down = await hop(W1, ORG_SEC, W2, 60, m, a.stock);

    const num = uniq('E');
    await recall(num, a.tl);                             // recall the 20-unit line only

    const dl = await linesFor(down.tl);
    expect(dl).toHaveLength(1);
    // The downstream line names the REAL onward transfer, not the root line...
    expect([dl[0].src, dl[0].dst]).toEqual([W2, W1]);
    // ...and is bounded by that transfer's own receipt and the depot's custody -
    // conservative potential exposure, which may exceed A's original 20.
    expect(dl[0].qty).toBeLessThanOrEqual(60);
    expect(dl[0].qty).toBeLessThanOrEqual(await custody(down.stock) + dl[0].qty);
    expect(await obligated(down.stock)).toBeLessThanOrEqual(await custody(down.stock));
    // No obligation was ever anchored to the root line at the depot.
    const anchors = await rows(
      `SELECT DISTINCT l.original_transfer_line_id AS tl
         FROM warehouse_return_request_lines l
         JOIN warehouse_return_requests r ON r.id=l.return_request_id
        WHERE btrim(r.return_number)=$1 AND r.source_warehouse_id=$2`, [num, W2]);
    expect(anchors.map((x: any) => x.tl)).toEqual([down.tl]);
  });

  // ── F. MERGED DOWNSTREAM ──────────────────────────────────────────────────
  it('F2-F. two onward lines merging into ONE depot lot cannot both claim the same units', async () => {
    const m = uniq('f2-f');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    const t1 = await hop(W1, ORG_SEC, W2, 30, m, root.stock);
    const t2 = await hop(W1, ORG_SEC, W2, 30, m, root.stock);
    expect(t1.stock).toBe(t2.stock);                     // merged downstream lot
    await correctTo(t1.stock, 30);                       // only 30 actually there

    const num = uniq('F');
    await recall(num, root.tl);

    // The closed physical budget is keyed by the downstream lot, so the two
    // provenance anchors share it rather than each taking 30.
    expect(await obligated(t1.stock)).toBeLessThanOrEqual(30);
    const total = (await linesFor(t1.tl)).reduce((s: number, l: any) => s + l.qty, 0)
                + (await linesFor(t2.tl)).reduce((s: number, l: any) => s + l.qty, 0);
    expect(total).toBeLessThanOrEqual(30);
  });

  // ── G. MATERIAL SAFETY ────────────────────────────────────────────────────
  it('F2-G. a lineage edge crossing to a different canonical material fails closed', async () => {
    const m = uniq('f2-g');
    const root = await hop(W0, ORG_SEC, W1, 40, m, null);
    const down = await hop(W1, ORG_SEC, W2, 20, m, root.stock);
    // Force the impossible state the assertion exists for: the onward line now
    // claims to have produced a lot of a DIFFERENT canonical material.
    const foreign = await hop(W0, ORG_SEC, W1, 10, uniq('f2-g-other'), null);
    await admin(`UPDATE warehouse_transfer_lines SET resulting_warehouse_stock_id=$2 WHERE id=$1`,
      [down.tl, foreign.stock]);

    expect(await rejects(() => recall(uniq('G'), root.tl)))
      .toMatch(/recall_material_identity_lineage_mismatch/);
    // Fails closed: not one obligation was written.
    expect(await linesFor(root.tl)).toHaveLength(0);
    expect(await linesFor(down.tl)).toHaveLength(0);
  });

  // ── H. RECALL PRIORITY ────────────────────────────────────────────────────
  it('F2-H. a pending DOWNSTREAM recall blocks a conflicting manual approval on the depot lot', async () => {
    const m = uniq('f2-h');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    const down = await hop(W1, ORG_SEC, W2, 40, m, root.stock);
    await recall(uniq('H'), root.tl);
    expect(await obligated(down.stock)).toBe(40);

    // A manual return on the SAME depot lot, reviewed by the sector.
    const man = await asUser(SEC_A, async (c: any) => {
      const req = await call(c, 'phoenix_request_direct_warehouse_return', [W2, W1, uniq('MAN'), null]);
      const id = req.return_request_id ?? req.id;
      const ln = await call(c, 'phoenix_add_warehouse_return_request_line',
        [id, down.tl, 20, 'excess', 'f2-manual']);
      await call(c, 'phoenix_submit_warehouse_return_request', [id]);
      return { id, line: ln.return_request_line_id };
    });
    // Refused by the CLOSED C1/C2 cap model. Which of its two keys fires depends
    // on the manual line's provenance: here it names the same onward transfer the
    // recall is anchored to, so the PROVENANCE cap trips first. Either way the
    // pending downstream recall is counted and the approval cannot proceed.
    expect(await rejects(() => asUser(SEC_A, (c: any) =>
      call(c, 'phoenix_review_warehouse_return_request',
        [man.id, JSON.stringify([{ line_id: man.line, approved_quantity: 20 }])]))))
      .toMatch(/warehouse_return_(physical|aggregate)_cap_exceeded/);
    expect(await obligated(down.stock)).toBeLessThanOrEqual(await custody(down.stock));
  });

  it('F2-H2. manual-vs-manual arbitration on a depot lot is unchanged', async () => {
    const m = uniq('f2-h2');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    const down = await hop(W1, ORG_SEC, W2, 30, m, root.stock);
    const mk = (qty: number) => asUser(SEC_A, async (c: any) => {
      const req = await call(c, 'phoenix_request_direct_warehouse_return', [W2, W1, uniq('MM'), null]);
      const id = req.return_request_id ?? req.id;
      const ln = await call(c, 'phoenix_add_warehouse_return_request_line',
        [id, down.tl, qty, 'excess', 'f2-mm']);
      await call(c, 'phoenix_submit_warehouse_return_request', [id]);
      return { id, line: ln.return_request_line_id };
    });
    const m1 = await mk(20); const m2 = await mk(20);
    const review = (r: any, qty: number) => asUser(SEC_A, (c: any) =>
      call(c, 'phoenix_review_warehouse_return_request',
        [r.id, JSON.stringify([{ line_id: r.line, approved_quantity: qty }])]));
    expect((await review(m1, 20)).ok).toBe(true);                 // first still succeeds
    expect(await rejects(() => review(m2, 20)))
      .toMatch(/warehouse_return_(physical|aggregate)_cap_exceeded/);
    expect((await review(m2, 10)).ok).toBe(true);                 // remainder still approvable
  });

  // ── I. REPLAY ─────────────────────────────────────────────────────────────
  it('F2-I. replay reuses BOTH the root and the downstream obligation', async () => {
    const m = uniq('f2-i');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    const down = await hop(W1, ORG_SEC, W2, 60, m, root.stock);
    const num = uniq('I');
    const first = await recall(num, root.tl);
    expect(first.obligations_created).toBe(2);

    const again = await recall(num, root.tl);
    expect(again.obligations_created).toBe(0);
    expect(again.obligations_reused).toBe(2);
    expect(await linesFor(root.tl)).toHaveLength(1);
    expect(await linesFor(down.tl)).toHaveLength(1);
  });

  it('F2-I2. replay stays safe after review, send and receive', async () => {
    const m = uniq('f2-i2');
    const root = await hop(W0, ORG_SEC, W1, 60, m, null);
    const down = await hop(W1, ORG_SEC, W2, 60, m, root.stock);
    const num = uniq('I2');
    expect((await recall(num, root.tl)).obligations_created).toBe(1);   // depot only
    const line = (await linesFor(down.tl))[0];

    // submit + review the depot's return (sender-side => recall authority at W1)
    await asUser(SEC_A, (c: any) => call(c, 'phoenix_submit_warehouse_return_request', [line.hdr]));
    const lineId = (await one(
      `SELECT id FROM warehouse_return_request_lines WHERE return_request_id=$1`, [line.hdr])).id;
    await asUser(SEC_A, (c: any) => call(c, 'phoenix_review_warehouse_return_request',
      [line.hdr, JSON.stringify([{ line_id: lineId, approved_quantity: 60 }])]));
    let r = await recall(num, root.tl);
    expect(r.obligations_created).toBe(0);
    expect(r.obligations_reused).toBe(1);

    // send it physically
    await asUser(SEC_A, (c: any) => call(c, 'phoenix_send_direct_warehouse_return_shipment_line',
      [line.hdr, lineId, 60, uniq('SHP'), null, null]));
    r = await recall(num, root.tl);
    expect(r.obligations_created).toBe(0);
    expect(r.obligations_reused).toBe(1);
    // and a DIFFERENT reference must not resurrect the exposure either
    expect((await recall(uniq('I2X'), root.tl)).obligations_created).toBe(0);
  });

  // ── J. REFERENCE ──────────────────────────────────────────────────────────
  it('F2-J. one reference spans the corridors it must, and never collides raw', async () => {
    const m = uniq('f2-j');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    await hop(W1, ORG_SEC, W2, 40, m, root.stock);
    const shared = uniq('J');
    expect((await recall(shared, root.tl)).obligations_created).toBe(2);

    // a DIFFERENT organization may reuse the very same external reference
    const other = await hop(W0, ORG_OTH, WOTH, 10, uniq('f2-j-oth'), null);
    expect((await recall(shared, other.tl)).obligations_created).toBe(1);

    const hdrs = await rows(
      `SELECT source_organization_id AS org FROM warehouse_return_requests
        WHERE btrim(return_number)=$1`, [shared]);
    expect(hdrs).toHaveLength(3);
    expect(new Set(hdrs.map((h: any) => h.org))).toEqual(new Set([ORG_SEC, ORG_OTH]));
  });

  // ── K. SECURITY ───────────────────────────────────────────────────────────
  it('F2-K. propagation leaks no downstream topology and needs no downstream permission', async () => {
    const m = uniq('f2-k');
    const root = await hop(W0, ORG_SEC, W1, 100, m, null);
    const down = await hop(W1, ORG_SEC, W2, 50, m, root.stock);
    const res = await recall(uniq('K'), root.tl);

    // aggregate counts only — nothing distinguishes a local from a downstream one
    expect(Object.keys(res).sort())
      .toEqual(['obligations_created', 'obligations_reused', 'ok', 'return_number']);
    const body = JSON.stringify(res);
    for (const secret of [W1, W2, ORG_SEC, FAC1, down.tl, down.stock, root.stock]) {
      expect(body).not.toContain(secret);
    }
    // the recall actor was granted nothing inside the holder organization
    expect((await one(
      `SELECT count(*)::int AS n FROM profile_permission_overrides
        WHERE profile_id=$1 AND permission_key='warehouse_transfer.return_request'`,
      [RECALLER])).n).toBe(0);
    // a foreign actor still gets the same generic denial as a nonexistent selector
    const foreign = await rejects(() => recall(uniq('K2'), root.tl, OUTSIDER));
    const missing = await rejects(() => recall(uniq('K3'), randomUUID(), OUTSIDER));
    expect(foreign).toMatch(/forbidden_warehouse_recall/);
    expect(missing.replace(/[0-9a-f-]{36}/g, '')).toBe(foreign.replace(/[0-9a-f-]{36}/g, ''));
  });

  // ── L. MOVEMENT ───────────────────────────────────────────────────────────
  it('F2-L. propagation moves no stock at all, on creation or replay', async () => {
    const m = uniq('f2-l');
    const root = await hop(W0, ORG_SEC, W1, 90, m, null);
    await hop(W1, ORG_SEC, W2, 45, m, root.stock);
    await hop(W1, ORG_SEC, W3, 20, m, root.stock);

    const before = await census();
    const num = uniq('L');
    expect((await recall(num, root.tl)).obligations_created).toBe(3);
    expect(await census()).toEqual(before);
    await recall(num, root.tl);                       // replay
    expect(await census()).toEqual(before);
  });

  // ── Structural: one writer, root-anchored authority, no new public surface ─
  it('F2-S. one obligation writer, authority checked once, public surface unchanged', async () => {
    const writer = (await one(
      `SELECT pg_get_functiondef(
         'public._phoenix_materialize_warehouse_recall_obligation_v1(uuid,text,text,uuid,text,uuid)'::regprocedure) AS d`)).d;
    // the writer must never re-check authority: that would demand the actor hold
    // permissions inside every downstream organization
    expect(writer).not.toContain('phoenix_profile_has_scoped_permission');

    const rpc = (await one(
      `SELECT pg_get_functiondef(
         'public.phoenix_recall_warehouse_transfer_line(uuid,text,text)'::regprocedure) AS d`)).d;
    expect(rpc.split('phoenix_profile_has_scoped_permission').length - 1).toBe(1);
    // the edge is provenance, and only received descendants bear custody
    expect(rpc).toContain('d.source_warehouse_stock_id = v_root_stock');
    expect(rpc).toContain(`d.status IN ('received', 'received_with_difference')`);
    expect(rpc).toContain('COALESCE(d.received_quantity, 0) > 0');
    // both integrity assertions present
    expect(rpc).toContain('recall_material_identity_lineage_mismatch');
    expect(rpc).toContain('recall_unsupported_warehouse_lineage_depth');

    // THE WHOLE PUBLIC RECALL SURFACE, pinned exactly. The WAREHOUSE half is
    // still exactly the F1 trio - F2 added no entry point of its own and this
    // list is what proves it. R1.5-F3 adds ONE authorized outlet selector RPC,
    // phoenix_recall_outlet_inbound_movement, alongside the pre-existing
    // phoenix_recall_outlet_stock (which F3 forward-replaced to fail closed
    // while preserving its historical signature). The assertion stays exact -
    // any SIXTH phoenix_recall% function, or any change to these five, still
    // fails this test.
    expect((await rows(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'phoenix_recall%'
        ORDER BY p.proname`)).map((r: any) => r.proname))
      .toEqual([
        'phoenix_recall_direct_warehouse_transfer',
        'phoenix_recall_outlet_inbound_movement',
        'phoenix_recall_outlet_stock',
        'phoenix_recall_warehouse_transfer',
        'phoenix_recall_warehouse_transfer_line',
      ]);
    // BOTH legacy header-only entry points remain fail-closed. F3 must not have
    // quietly revived either of them while adding its selector.
    for (const legacy of ['phoenix_recall_warehouse_transfer',
                          'phoenix_recall_direct_warehouse_transfer',
                          'phoenix_recall_outlet_stock']) {
      const def = (await one(
        `SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname='public' AND p.proname = $1`, [legacy])).d;
      expect(def).toContain('recall_selector_required');
      expect(def).not.toContain('INSERT INTO');
    }
    const priv = await one(
      `SELECT has_function_privilege('authenticated',
         'public._phoenix_materialize_warehouse_recall_obligation_v1(uuid,text,text,uuid,text,uuid)'::regprocedure,'EXECUTE') AS a,
              has_function_privilege('anon',
         'public._phoenix_materialize_warehouse_recall_obligation_v1(uuid,text,text,uuid,text,uuid)'::regprocedure,'EXECUTE') AS b`);
    expect(priv.a).toBe(false);
    expect(priv.b).toBe(false);
  });

  it('F2-T. the F3 boundary is recorded, not acted on', async () => {
    const m = uniq('f2-t');
    const root = await hop(W0, ORG_SEC, W1, 30, m, null);
    await recall(uniq('T'), root.tl);
    const audit = await one(
      `SELECT payload FROM audit_logs
        WHERE action='warehouse_transfer.recall_requested'
          AND payload->>'original_transfer_line_id' = $1
        ORDER BY created_at DESC LIMIT 1`, [root.tl]);
    // the fact is recorded for F3, and never surfaced publicly
    expect(audit.payload).toHaveProperty('outlet_descendant_detected');
    expect(typeof audit.payload.outlet_descendant_detected).toBe('boolean');
    // no outlet obligation was created by F2
    expect((await one(
      `SELECT count(*)::int AS n FROM outlet_return_requests`)).n).toBe(0);
  });
});
