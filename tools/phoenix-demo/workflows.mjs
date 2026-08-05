/**
 * PHOENIX_DEMO_V1 — the operational workflow groups.
 *
 * EVERY function here drives the real, secured corridor RPCs as a real
 * authenticated actor holding the real permission. Nothing in this file
 * INSERTs a ledger, movement, audit, custody or balance row. Where a
 * corridor needs several steps (create → add lines → submit → review →
 * send → receive) the demo performs all of them, so the resulting data has
 * genuine custody transitions and a genuine correlation/causation chain
 * rather than a synthesised end state.
 *
 * Idempotency: every RPC that takes a p_request_id is given a deterministic
 * one derived from the seed key, so a re-run replays instead of duplicating.
 * Steps whose corridor has no request id are made idempotent by checking for
 * the document they would create first.
 */
import { demoRequestId, demoDocRef, demoInt, beneficiary } from './dataset.mjs';

const j = (v) => JSON.stringify(v);

/** Read a single scalar. */
async function one(c, sql, params = []) {
  const r = await c.query(sql, params);
  return r.rows[0] ?? null;
}

/**
 * GROUP B — direct central → institution transfer.
 * Full chain: create request → add line → submit → review(approve) →
 * send line (posts a warehouse movement) → receive line (posts the
 * destination movement). Leaves stock in the institution warehouse.
 */
export async function transferCentralToInstitution(io, ctx, opts) {
  const { centralOfficer, instOfficer, reviewerId, centralWarehouseId, instOrgId, instWarehouseId } = opts;
  const key = opts.key;
  const created = { transferRequests: 0, sent: 0, received: 0 };

  let requestId = null;
  await io.asUser(centralOfficer.id, async (c) => {
    // Idempotent: reuse an existing demo request with the same number.
    const num = demoDocRef('TRF', opts.seq);
    const existing = await one(c,
      `SELECT id, status FROM warehouse_transfer_requests WHERE request_number = $1`, [num]);
    if (existing) { requestId = existing.id; return; }

    const r = await one(c,
      `SELECT public.phoenix_create_direct_warehouse_transfer_request($1,$2,$3,$4,$5) AS r`,
      [centralWarehouseId, instOrgId, instWarehouseId, num, 'مناقلة تجريبية']);
    requestId = r.r?.transfer_request_id ?? r.r?.id ?? r.r;
    created.transferRequests++;
  }, { commit: true });

  if (!requestId) return created;

  // Add a line for each stock lot we intend to move, then submit + approve.
  const lineIds = [];
  await io.asUser(centralOfficer.id, async (c) => {
    const st = await one(c, `SELECT status FROM warehouse_transfer_requests WHERE id=$1`, [requestId]);
    if (st?.status !== 'draft') return;  // already progressed on a previous run
    for (const lot of opts.lots) {
      const r = await one(c,
        `SELECT public.phoenix_add_warehouse_transfer_request_line($1,$2,$3,NULL,$4,$5,'علبة',$6) AS r`,
        [requestId, lot.scientificName, lot.qty, lot.concentration ?? null, lot.dosageForm ?? null, 'سطر تجريبي']);
      const id = r.r?.transfer_request_line_id ?? r.r?.id ?? r.r;
      if (id) lineIds.push(id);
    }
    await c.query(`SELECT public.phoenix_submit_warehouse_transfer_request($1)`, [requestId]);
  }, { commit: true });

  // The DESTINATION side reviews and approves. warehouse_transfer.review is
  // org-scoped, and super_admin is the role that genuinely holds it across
  // organizations — a real authorized actor, never a weakened check.
  await io.asUser(reviewerId ?? instOfficer.id, async (c) => {
    const st = await one(c, `SELECT status FROM warehouse_transfer_requests WHERE id=$1`, [requestId]);
    if (st?.status !== 'submitted') return;
    const lines = await c.query(
      `SELECT id, requested_quantity FROM warehouse_transfer_request_lines WHERE transfer_request_id=$1`,
      [requestId]);
    const decisions = lines.rows.map(l => ({
      line_id: l.id, decision: 'approved', approved_quantity: l.requested_quantity,
    }));
    await c.query(`SELECT public.phoenix_review_warehouse_transfer_request($1,$2::jsonb)`,
      [requestId, j(decisions)]);
  }, { commit: true });

  // The CENTRAL warehouse ships each approved line from a real stock lot.
  const transferLineIds = [];
  await io.asUser(centralOfficer.id, async (c) => {
    const lines = await c.query(
      `SELECT id, approved_quantity, scientific_name FROM warehouse_transfer_request_lines
        WHERE transfer_request_id=$1 AND approved_quantity > 0`, [requestId]);
    for (const [i, l] of lines.rows.entries()) {
      const lot = opts.lots.find(x => x.scientificName === l.scientific_name) ?? opts.lots[0];
      if (!lot) continue;
      try {
        const r = await one(c,
          `SELECT public.phoenix_send_direct_warehouse_transfer_line($1,$2,$3,$4,$5,$6,$7,$8) AS r`,
          [demoRequestId(`${key}:send:${i}`), requestId, lot.stockId,
           Math.min(l.approved_quantity, lot.available), demoDocRef('TRS', opts.seq),
           l.id, demoDocRef('DOC', opts.seq), 'شحن تجريبي']);
        const tid = r.r?.transfer_line_id ?? r.r?.id;
        if (tid) { transferLineIds.push(tid); created.sent++; }
      } catch { /* insufficient lot / already sent — the corridor decides */ }
    }
  }, { commit: true });

  // The INSTITUTION receives them, creating destination stock.
  await io.asUser(instOfficer.id, async (c) => {
    for (const [i, tid] of transferLineIds.entries()) {
      try {
        const line = await one(c, `SELECT sent_quantity FROM warehouse_transfer_lines WHERE id=$1`, [tid]);
        if (!line) continue;
        await c.query(`SELECT public.phoenix_receive_warehouse_transfer_line($1,$2,$3,NULL,$4)`,
          [demoRequestId(`${key}:recv:${i}`), tid, line.sent_quantity, 'استلام تجريبي']);
        created.received++;
      } catch (e) { created.recvError = String(e?.message ?? e); }
    }
  }, { commit: true });

  return created;
}

/**
 * GROUP A — institution warehouse → outlet dispatch, then outlet receipt.
 * Produces genuine custody-chain documents plus both ledger sides.
 */
export async function dispatchToOutlet(io, ctx, opts) {
  const { officer, outletOfficer, warehouseId, outletId, key, seq } = opts;
  const created = { dispatches: 0, lines: 0, received: 0 };
  let dispatchId = null;

  await io.asUser(officer.id, async (c) => {
    const num = demoDocRef('DSP', seq);
    const existing = await one(c, `SELECT id FROM warehouse_dispatches WHERE dispatch_number=$1`, [num]);
    if (existing) { dispatchId = existing.id; return; }
    const r = await one(c,
      `SELECT public.phoenix_create_warehouse_dispatch($1,$2,$3,$4,'IQD',$5) AS r`,
      [warehouseId, outletId, num, demoDocRef('DOC', seq), 'تجهيز تجريبي']);
    dispatchId = r.r?.dispatch_id ?? r.r?.id ?? r.r;
    created.dispatches++;
  }, { commit: true });

  if (!dispatchId) return created;

  const lineIds = [];
  await io.asUser(officer.id, async (c) => {
    const st = await one(c, `SELECT status FROM warehouse_dispatches WHERE id=$1`, [dispatchId]);
    if (st?.status !== 'draft') {
      const ex = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      lineIds.push(...ex.rows.map(x => x.id));
      return;
    }
    for (const lot of opts.lots) {
      try {
        const r = await one(c, `SELECT public.phoenix_add_dispatch_line($1,$2,$3) AS r`,
          [dispatchId, lot.stockId, lot.qty]);
        const id = r.r?.dispatch_line_id ?? r.r?.id ?? r.r;
        if (id) { lineIds.push(id); created.lines++; }
      } catch { /* lot exhausted — corridor decides */ }
    }
    if (lineIds.length > 0) {
      await c.query(`SELECT public.phoenix_send_warehouse_dispatch($1,$2)`,
        [demoRequestId(`${key}:send`), dispatchId]);
    }
  }, { commit: true });

  // The OUTLET receives — this is the custody transition plus outlet stock.
  await io.asUser(outletOfficer.id, async (c) => {
    const lines = await c.query(
      `SELECT id, sent_quantity FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
    for (const [i, l] of lines.rows.entries()) {
      try {
        // reason_code is the CLOSED-vocabulary companion to a difference —
        // 'received' is the RPC's own internal default on an exact match,
        // not itself a member of the accepted list; passing it explicitly
        // raises invalid_outlet_dispatch_receive_reason_code.
        await c.query(`SELECT public.phoenix_receive_outlet_dispatch_line($1,$2,$3,NULL,$4,NULL)`,
          [demoRequestId(`${key}:recv:${i}`), l.id, l.sent_quantity, 'استلام تجريبي']);
        created.received++;
      } catch { /* already received */ }
    }
  }, { commit: true });

  return created;
}

/** GROUP C — the three dispense beneficiary types, through the atomic RPC. */
export async function dispenseFromOutlet(io, ctx, opts) {
  const { outletOfficer, outletId, key, count } = opts;
  const created = { dispenses: 0, contexts: 0 };
  await io.asUser(outletOfficer.id, async (c) => {
    const lots = await c.query(
      `SELECT id, on_hand_quantity FROM outlet_stock
        WHERE distribution_point_id=$1 AND on_hand_quantity > 5
        ORDER BY id LIMIT $2`, [outletId, count]);
    const kinds = ['patient', 'crash_cart', 'internal_order'];
    for (const [i, lot] of lots.rows.entries()) {
      const b = beneficiary(kinds[i % 3], demoInt(`${key}:ben:${i}`, 1, 9999));
      const qty = Math.max(1, Math.min(3, lot.on_hand_quantity - 1));
      try {
        const r = await one(c,
          `SELECT public.phoenix_dispense_outlet_stock_with_context(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS r`,
          [demoRequestId(`${key}:disp:${i}`), lot.id, qty, b.beneficiaryType,
           b.patientIdentifier ?? null, b.patientName ?? null, b.patientReferenceType ?? null,
           b.crashCartReference ?? null, b.internalOrderReference ?? null,
           'صرف تجريبي', null, null]);
        if (r.r?.ok) { created.dispenses++; if (!r.r.idempotent_replay) created.contexts++; }
      } catch { /* insufficient / expired lot — corridor decides */ }
    }
  }, { commit: true });
  return created;
}

/**
 * GROUP D/E — outlet return request → shipment → receipt with a disposition
 * decision, so BOTH restockable and quarantine paths are exercised, then
 * quarantine release and destruction.
 */
export async function outletReturnAndQuarantine(io, ctx, opts) {
  const { outletOfficer, instOfficer, outletId, warehouseId, key, seq } = opts;
  const created = { requests: 0, shipments: 0, received: 0, released: 0, destroyed: 0 };
  let reqId = null;

  await io.asUser(outletOfficer.id, async (c) => {
    const num = demoDocRef('RET', seq);
    const ex = await one(c, `SELECT id FROM outlet_return_requests WHERE return_number=$1`, [num]);
    if (ex) { reqId = ex.id; return; }
    const r = await one(c, `SELECT public.phoenix_request_outlet_return($1,$2,$3) AS r`,
      [outletId, num, 'إرجاع تجريبي']);
    reqId = r.r?.return_request_id ?? r.r?.id ?? r.r;
    created.requests++;
  }, { commit: true });
  if (!reqId) return created;

  await io.asUser(outletOfficer.id, async (c) => {
    const st = await one(c, `SELECT status FROM outlet_return_requests WHERE id=$1`, [reqId]);
    if (st?.status !== 'draft') return;
    const lines = await c.query(
      `SELECT l.id, l.received_quantity FROM warehouse_dispatch_lines l
         JOIN warehouse_dispatches h ON h.id=l.dispatch_id
        WHERE h.destination_distribution_point_id=$1 AND l.received_quantity > 2
        ORDER BY l.id LIMIT 2`, [outletId]);
    for (const l of lines.rows) {
      try {
        await c.query(`SELECT public.phoenix_add_outlet_return_request_line($1,$2,$3,$4,$5)`,
          [reqId, l.id, 1, 'excess', 'فائض تجريبي']);
      } catch { /* not returnable */ }
    }
    await c.query(`SELECT public.phoenix_submit_outlet_return_request($1)`, [reqId]);
  }, { commit: true });

  await io.asUser(instOfficer.id, async (c) => {
    const st = await one(c, `SELECT status FROM outlet_return_requests WHERE id=$1`, [reqId]);
    if (st?.status !== 'submitted') return;
    const lines = await c.query(
      `SELECT id, requested_quantity FROM outlet_return_request_lines WHERE return_request_id=$1`, [reqId]);
    const decisions = lines.rows.map(l => ({
      line_id: l.id, decision: 'approved', approved_quantity: l.requested_quantity,
    }));
    if (decisions.length > 0) {
      await c.query(`SELECT public.phoenix_review_outlet_return_request($1,$2::jsonb)`, [reqId, j(decisions)]);
    }
  }, { commit: true });

  const shipmentLineIds = [];
  await io.asUser(outletOfficer.id, async (c) => {
    const lines = await c.query(
      `SELECT id, approved_quantity FROM outlet_return_request_lines
        WHERE return_request_id=$1 AND approved_quantity > 0`, [reqId]);
    for (const [i, l] of lines.rows.entries()) {
      try {
        const r = await one(c,
          `SELECT public.phoenix_send_outlet_return_shipment_line($1,$2,NULL,$3,$4,$5,$6) AS r`,
          [demoRequestId(`${key}:ship:${i}`), l.id, l.approved_quantity,
           demoDocRef('SHP', seq), demoDocRef('DOC', seq), 'شحن إرجاع تجريبي']);
        const id = r.r?.shipment_line_id ?? r.r?.id;
        if (id) { shipmentLineIds.push(id); created.shipments++; }
      } catch { /* already shipped */ }
    }
  }, { commit: true });

  // Receipt with ALTERNATING disposition so both the restock and the
  // quarantine path produce genuine rows.
  await io.asUser(instOfficer.id, async (c) => {
    for (const [i, sid] of shipmentLineIds.entries()) {
      const disposition = i % 2 === 0 ? 'restock' : 'quarantine';
      try {
        const line = await one(c, `SELECT sent_quantity FROM outlet_return_shipment_lines WHERE id=$1`, [sid]);
        if (!line) continue;
        await c.query(
          `SELECT public.phoenix_receive_outlet_return_shipment_line($1,$2,$3,NULL,$4,$5)`,
          [demoRequestId(`${key}:rrecv:${i}`), sid, line.sent_quantity, 'استلام إرجاع تجريبي', disposition]);
        created.received++;
      } catch { /* already received */ }
    }
  }, { commit: true });

  // Quarantine disposition: release part, destroy part.
  await io.asUser(instOfficer.id, async (c) => {
    const q = await c.query(
      `SELECT id, quantity FROM warehouse_quarantine_stock
        WHERE warehouse_id=$1 AND quantity > 1 ORDER BY id LIMIT 2`, [warehouseId]);
    for (const [i, row] of q.rows.entries()) {
      try {
        if (i % 2 === 0) {
          await c.query(`SELECT public.phoenix_destroy_quarantine_stock($1,$2,$3,$4)`,
            [demoRequestId(`${key}:destroy:${i}`), row.id, 1, 'إتلاف تجريبي']);
          created.destroyed++;
        } else {
          await c.query(`SELECT public.phoenix_release_quarantine_stock($1,$2,$3,$4,NULL)`,
            [demoRequestId(`${key}:release:${i}`), row.id, 1, 'إفراج تجريبي']);
          created.released++;
        }
      } catch { /* corridor decides */ }
    }
  }, { commit: true });

  return created;
}

/** GROUP F/G — stocktake, then a second-person correction request + approval. */
export async function stocktakeAndCorrection(io, ctx, opts) {
  const { officer, approver, orgId, warehouseId, key } = opts;
  const created = { stocktakes: 0, corrections: 0, approvals: 0 };

  await io.asUser(officer.id, async (c) => {
    // stocktakes carries no unique/idempotency constraint of any kind beyond
    // its own gen_random_uuid() primary key, and phoenix_status_record_
    // stocktake (092) takes no request_id — a second seed run must check
    // existing state itself (the same convention every other group in this
    // file already uses) or it would record a second, genuinely duplicate
    // stocktake every time seedDemoDataset() re-runs.
    const already = await c.query(
      `SELECT 1 FROM stocktakes WHERE organization_id=$1 AND scope_kind='warehouse' AND scope_id=$2 LIMIT 1`,
      [orgId, warehouseId]);
    if (already.rows.length > 0) return;

    const lots = await c.query(
      `SELECT id, scientific_name, national_code, on_hand_quantity FROM warehouse_stock
        WHERE warehouse_id=$1 ORDER BY id LIMIT 3`, [warehouseId]);
    if (lots.rows.length === 0) return;
    // phoenix_status_record_stocktake (092) reads each line by
    // scientific_name/national_code/counted_qty — not warehouse_stock_id/
    // counted_quantity, which it silently ignores (jsonb ->> on a missing
    // key), previously always raising scientific_name_required underneath
    // the officer-permission bug this same fix corrects above.
    const lines = lots.rows.map(l => ({
      scientific_name: l.scientific_name,
      national_code: l.national_code,
      counted_qty: Math.max(0, l.on_hand_quantity - 1),   // a real discrepancy
    }));
    // A genuine failure here must surface, not disappear — no swallowing
    // catch, matching the "no catch block silently hides this failure"
    // requirement this whole fix was written to satisfy.
    await c.query(`SELECT public.phoenix_status_record_stocktake($1,'warehouse',$2,$3,$4::jsonb)`,
      [orgId, warehouseId, 'جرد تجريبي', j(lines)]);
    created.stocktakes++;
  }, { commit: true });

  // A correction REQUEST by one actor, APPROVED by a different one — the
  // second-person contract is genuinely exercised, never bypassed.
  const requestIds = [];
  await io.asUser(officer.id, async (c) => {
    const lots = await c.query(
      `SELECT id, on_hand_quantity, movement_seq FROM warehouse_stock
        WHERE warehouse_id=$1 AND on_hand_quantity > 3 ORDER BY id LIMIT 2`, [warehouseId]);
    for (const [i, l] of lots.rows.entries()) {
      try {
        const r = await one(c,
          `SELECT public.phoenix_request_warehouse_stock_correction($1,$2,$3,$4,$5,$6,$7) AS r`,
          [demoRequestId(`${key}:corr:${i}`), l.id, l.on_hand_quantity - 1,
           'تصحيح جرد تجريبي', l.movement_seq, demoDocRef('COR', i), 'ملاحظة تجريبية']);
        const id = r.r?.correction_request_id ?? r.r?.id;
        if (id) { requestIds.push(id); created.corrections++; }
      } catch { /* already requested */ }
    }
  }, { commit: true });

  await io.asUser(approver.id, async (c) => {
    for (const id of requestIds) {
      try {
        const st = await one(c,
          `SELECT status, warehouse_stock_id FROM phoenix_warehouse_correction_requests WHERE id=$1`, [id]);
        if (st?.status !== 'pending') continue;
        const stock = await one(c, `SELECT movement_seq FROM warehouse_stock WHERE id=$1`,
          [st.warehouse_stock_id]);
        await c.query(`SELECT public.phoenix_approve_warehouse_stock_correction($1,$2)`,
          [id, stock.movement_seq]);
        created.approvals++;
      } catch { /* second-person rule or generation conflict — corridor decides */ }
    }
  }, { commit: true });

  return created;
}

/**
 * GROUP H — supplementary procurement: supplier → order → receipt → return.
 * 087's real permission matrix, post-091 cutover: institution_admin holds
 * manage+approve, warehouse_officer holds manage+receive+return. decide_order
 * additionally enforces separation of duty (submitted_by <> approver actor,
 * whatever their role) — so submitter and approver must be genuinely
 * different actors, never the same profile calling itself twice.
 */
export async function procurementCycle(io, ctx, opts) {
  const { submitter, approver, receiver, orgId, warehouseId, key, seq } = opts;
  const created = { suppliers: 0, orders: 0, receipts: 0, returns: 0 };
  let supplierId = null;
  let orderId = null;

  await io.asUser(submitter.id, async (c) => {
    const ex = await one(c, `SELECT id FROM procurement_suppliers WHERE organization_id=$1 AND name=$2`,
      [orgId, `مورد تجريبي ${seq}`]);
    if (ex) { supplierId = ex.id; return; }
    const r = await one(c,
      `SELECT public.phoenix_procurement_save_supplier($1,NULL,$2,$3,NULL,NULL,NULL,NULL,NULL,$4,'active') AS r`,
      [orgId, `مورد تجريبي ${seq}`, `مورد تجريبي ${seq}`, 'مورد بيانات تجريبية']);
    supplierId = r.r?.supplier_id ?? r.r?.id ?? r.r;
    created.suppliers++;
  }, { commit: true });
  if (!supplierId) return created;

  await io.asUser(submitter.id, async (c) => {
    const num = demoDocRef('PO', seq);
    const ex = await one(c, `SELECT id FROM procurement_orders WHERE order_number=$1`, [num]);
    if (ex) { orderId = ex.id; return; }
    const r = await one(c,
      `SELECT public.phoenix_procurement_create_order($1,$2,$3,$4,current_date,NULL,'IQD',$5,false) AS r`,
      [warehouseId, supplierId, num, demoDocRef('INV', seq), 'شراء فرعي تجريبي']);
    orderId = r.r?.order_id ?? r.r?.id ?? r.r;
    created.orders++;
  }, { commit: true });
  if (!orderId) return created;

  await io.asUser(submitter.id, async (c) => {
    const st = await one(c, `SELECT status, order_generation FROM procurement_orders WHERE id=$1`, [orderId]);
    if (st?.status !== 'draft') return;
    for (const [i, m] of opts.materials.entries()) {
      await c.query(
        `SELECT public.phoenix_procurement_add_order_line($1,$2,$3,NULL,$4,$5,$6,'علبة',NULL,$7,
           current_date + 400, 1000, 'IQD', $8)`,
        [orderId, m.scientificName, 20 + i, m.tradeName, m.concentration, m.dosageForm,
         `DEMO-PB-${seq}-${i}`, 'سطر شراء تجريبي']);
    }
    const g = await one(c, `SELECT order_generation FROM procurement_orders WHERE id=$1`, [orderId]);
    await c.query(`SELECT public.phoenix_procurement_submit_order($1,$2)`, [orderId, g.order_generation]);
  }, { commit: true });

  // A genuinely DIFFERENT actor decides — separation of duty is enforced by
  // actor identity, not role, so the same institution_admin could never
  // approve its own submission.
  await io.asUser(approver.id, async (c) => {
    const st = await one(c, `SELECT status, order_generation FROM procurement_orders WHERE id=$1`, [orderId]);
    if (st?.status !== 'submitted') return;
    await c.query(`SELECT public.phoenix_procurement_decide_order($1,true,$2,$3)`,
      [orderId, 'موافقة تجريبية', st.order_generation]);
  }, { commit: true });

  // warehouse_officer receives (087: manage+receive+return, not approve).
  await io.asUser(receiver.id, async (c) => {
    const st = await one(c, `SELECT status, order_generation FROM procurement_orders WHERE id=$1`, [orderId]);
    if (!st || !['approved', 'partially_received'].includes(st.status)) return;
    const lines = await c.query(
      `SELECT id, ordered_quantity FROM procurement_order_lines WHERE order_id=$1`, [orderId]);
    const payload = lines.rows.map(l => ({ order_line_id: l.id, received_quantity: l.ordered_quantity }));
    if (payload.length === 0) return;
    try {
      await c.query(`SELECT public.phoenix_procurement_receive_order($1,$2,$3::jsonb,$4,$5)`,
        [demoRequestId(`${key}:recv`), orderId, j(payload), st.order_generation, 'استلام شراء تجريبي']);
      created.receipts++;
    } catch { /* already received */ }
  }, { commit: true });

  // Supplier return on one received line.
  await io.asUser(receiver.id, async (c) => {
    const rl = await one(c,
      `SELECT rl.id, o.order_generation FROM procurement_receipt_lines rl
         JOIN procurement_receipts r ON r.id = rl.receipt_id
         JOIN procurement_orders o ON o.id = r.order_id
        WHERE o.id=$1 AND rl.quantity > 1 ORDER BY rl.id LIMIT 1`, [orderId]);
    if (!rl) return;
    try {
      await c.query(
        `SELECT public.phoenix_procurement_return_to_supplier($1,$2,1,$3,$4,$5,$6)`,
        [demoRequestId(`${key}:sret`), rl.id, 'مرتجع للمورد تجريبي', 'ملاحظة', rl.order_generation, 'damaged']);
      created.returns++;
    } catch { /* corridor decides */ }
  }, { commit: true });

  return created;
}

/** GROUP J — a full monthly inventory position cycle: prepare → classify →
 *  submit → approve+lock. Uses the real 092 three-role persona map, never a
 *  shortcut: preparer=warehouse_officer, submitter=institution_admin,
 *  approver=central_warehouse_manager — each the one role that genuinely
 *  holds the permission for its step. */
export async function monthlyPositionCycle(io, ctx, opts) {
  const { preparer, submitter, approver, orgId } = opts;
  const created = { reports: 0, locked: 0 };
  let reportId = null;
  let prepareFailed = false;

  // A RAISE EXCEPTION inside phoenix_status_prepare_report aborts the whole
  // Postgres transaction — every later statement on THIS SAME connection
  // errors with "current transaction is aborted" until rollback. The
  // fallback lookup must therefore run on a fresh connection/transaction,
  // never on `c` after the catch.
  await io.asUser(preparer.id, async (c) => {
    const r = await one(c, `SELECT public.phoenix_status_prepare_report($1) AS r`, [orgId]);
    reportId = r.r?.report_id ?? r.r?.id ?? r.r;
    if (reportId) created.reports++;
  }, { commit: true }).catch(() => { prepareFailed = true; });

  if (prepareFailed) {
    await io.asAdmin(async (c) => {
      const ex = await one(c,
        `SELECT id FROM inventory_status_reports WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [orgId]);
      reportId = ex?.id ?? null;
    });
  }
  if (!reportId) return created;

  // warehouse_officer classifies (092: only this role holds classify_own).
  await io.asUser(preparer.id, async (c) => {
    const st = await one(c, `SELECT status FROM inventory_status_reports WHERE id=$1`, [reportId]);
    if (st?.status !== 'draft') return;
    const lines = await c.query(
      `SELECT id FROM inventory_status_report_lines WHERE report_id=$1 LIMIT 20`, [reportId]);
    if (lines.rows.length > 0) {
      const payload = lines.rows.map(l => ({ line_id: l.id, classification: 'available' }));
      try {
        await c.query(`SELECT public.phoenix_status_classify_lines($1,$2::jsonb)`, [reportId, j(payload)]);
      } catch { /* classification vocabulary differs — corridor decides */ }
    }
  }, { commit: true });

  // institution_admin submits (092: only this role holds review_submit_own).
  await io.asUser(submitter.id, async (c) => {
    const st = await one(c, `SELECT status FROM inventory_status_reports WHERE id=$1`, [reportId]);
    if (st?.status !== 'draft') return;
    try { await c.query(`SELECT public.phoenix_status_submit_report($1)`, [reportId]); } catch { /* */ }
  }, { commit: true });

  // central_warehouse_manager approves + locks (092: approve_lock).
  await io.asUser(approver.id, async (c) => {
    const st = await one(c, `SELECT status FROM inventory_status_reports WHERE id=$1`, [reportId]);
    if (st?.status !== 'submitted') return;
    try {
      await c.query(`SELECT public.phoenix_status_approve_lock_report($1)`, [reportId]);
      created.locked++;
    } catch { /* second-person / permission rule — corridor decides */ }
  }, { commit: true });

  return created;
}

/** GROUP I/K — transfer suggestions, a representative reject, and an official report snapshot. */
export async function suggestionsAndSnapshots(io, ctx, opts) {
  const { admin, orgId, key, includeSnapshots } = opts;
  const created = { suggestions: 0, rejected: 0, snapshots: 0 };

  await io.asUser(admin.id, async (c) => {
    try {
      const r = await one(c, `SELECT public.phoenix_suggest_inventory_transfers($1) AS r`, [orgId]);
      created.suggestions = Array.isArray(r?.r) ? r.r.length : (r?.r?.count ?? 0);
    } catch { /* nothing to suggest */ }
  }, { commit: true });

  // Acceptance is structurally disabled (072: 'accepted' is unreachable for
  // any writer, and the RPC always raises acceptance_disabled_recommendation_
  // only) — reject is the one real corridor a demo scenario can exercise.
  await io.asUser(admin.id, async (c) => {
    try {
      const open = await one(c,
        `SELECT id FROM inventory_transfer_suggestions
          WHERE (source_organization_id=$1 OR target_organization_id=$1) AND status='open'
          ORDER BY id LIMIT 1`, [orgId]);
      if (open?.id) {
        await c.query(`SELECT public.phoenix_reject_inventory_transfer_suggestion($1,$2)`,
          [open.id, 'لا حاجة تجريبية']);
        created.rejected++;
      }
    } catch { /* no scoped permission on this suggestion's endpoints — corridor decides */ }
  }, { commit: true });

  if (includeSnapshots === true) await io.asUser(admin.id, async (c) => {
    try {
      await c.query(
        `SELECT public.phoenix_create_report_snapshot($1,$2,'executive_overview','{}'::jsonb,$3::jsonb)`,
        [demoRequestId(`${key}:snap`), orgId, j({ period: 'demo' })]);
      created.snapshots++;
    } catch { /* already issued (idempotent on request id) */ }
  }, { commit: true });

  return created;
}
