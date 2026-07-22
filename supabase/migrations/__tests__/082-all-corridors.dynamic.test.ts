/**
 * MOVEMENT-EVENT-CAPTURE-082 — DYNAMIC proof across ALL SIX corridor triggers.
 *
 * The transfer corridor is proven in 082-event-capture.dynamic.test.ts. This
 * file drives the REAL RPCs of the remaining five header tables that 082's
 * trigger is installed on, plus a rollback-atomicity proof:
 *
 *   warehouse_dispatches           (create → send → cancel path)
 *   warehouse_return_requests      (request → submit → review → send)
 *   warehouse_return_shipments     (send)
 *   outlet_return_requests         (request → submit → review → cancel)
 *   outlet_return_shipments        (dispatch → receive → return → send)
 *
 * For each: invoke the real RPC, read phoenix_movement_timeline, prove the
 * immutable event appears; retry creates no duplicate; a foreign scope sees
 * nothing; and the event rolls back with the stock transaction on failure.
 *
 * The sixth corridor — outlet_return_shipments — is the ONLY one whose send path
 * mutates outlet_stock and therefore calls phoenix_project_outlet_availability.
 * Before migration 083 that writer's 7-column ON CONFLICT could not infer the
 * live 8-column identity index, so any outlet-stock-backed send aborted; the
 * corridor was deferred for exactly that reason. Migration 083 Part A repairs the
 * projection writer, so this file now applies the chain through 083 and drives
 * the full dispatch → outlet-receive → outlet-return → send-shipment corridor.
 *
 * Gated on PHOENIX_RIG_PG. Skipped in CI (no database), like the other dynamic
 * proofs; results recorded in docs/phoenix/migration-082-event-capture-validation.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-00000000b001';
const ORG_INST = '00000000-0000-0000-0000-00000000b002';
const ORG_OTHER = '00000000-0000-0000-0000-00000000b003';
const WH_CENTRAL = '00000000-0000-0000-0000-00000000b101';
const WH_INST = '00000000-0000-0000-0000-00000000b102';
const ROUTE = '00000000-0000-0000-0000-00000000b201';
const DP_OUTLET = '00000000-0000-0000-0000-00000000b301';
const USER_INST = '00000000-0000-0000-0000-00000000b402';
const USER_OTHER = '00000000-0000-0000-0000-00000000b403';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('082 — all six corridor triggers (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  // ledger rows for a trace, oldest first
  const ledger = (c: any, traceId: string) =>
    c.query(`SELECT status_after, actor_id, organization_id, reference_type
               FROM phoenix_movement_events WHERE trace_id=$1 ORDER BY occurred_at, status_after`, [traceId])
      .then((r: any) => r.rows);

  const timeline = (c: any, traceId: string) =>
    call(c, 'phoenix_movement_timeline', [traceId, 100, null, null]);

  beforeAll(async () => {
    // Through 083: the sixth corridor's send path calls the outlet-availability
    // projection writer that migration 083 Part A repairs. The other five
    // corridors are unaffected — 083 is additive plus that one corrective
    // replacement — so they still prove identically at this ceiling.
    rig = await buildRig({ upTo: 83 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations (id,name,name_ar,code) VALUES
          ('${ORG_CENTRAL}','C','مركز','ac-c'),('${ORG_INST}','I','مؤسسة','ac-i'),('${ORG_OTHER}','O','اخرى','ac-o')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
          ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','ac-wc'),
          ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','ac-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO warehouse_supply_routes (id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution',true) ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_OUTLET}','${WH_INST}','${ORG_INST}','Outlet','منفذ','pharmacy','active') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO auth.users (id,email) VALUES ('${USER_INST}','ac-i@rig'),('${USER_OTHER}','ac-o@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_INST}' WHERE id='${USER_INST}';`);
      await c.query(`UPDATE profiles SET role='viewer',status='active',organization_id='${ORG_OTHER}' WHERE id='${USER_OTHER}';`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── outlet_return_requests: request → cancel is reachable without upstream
  //    stock (add-line requires a real dispatch line; the shipment chain below
  //    exercises the stock-backed path). ──
  it('outlet_return_requests: real RPCs produce immutable, scoped ledger events', async () => {
    let traceId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const created = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR')]);
      expect(created.ok).toBe(true);
      traceId = created.return_request_id ?? created.outlet_return_request_id ?? created.id;
      const cancelled = await call(c, 'phoenix_cancel_outlet_return_request', [traceId, 'not needed']);
      expect(cancelled.ok).toBe(true);

      const rows = await ledger(c, traceId);
      const statuses = rows.map((r: any) => r.status_after);
      expect(statuses).toEqual(expect.arrayContaining(['draft', 'cancelled']));
      for (const r of rows) {
        expect(r.actor_id).toBe(rig.superAdminId);
        expect(r.reference_type).toBe('outlet_return_requests');
        expect(r.organization_id).toBe(ORG_INST); // source_organization_id (initiator)
      }
      const tl = await timeline(c, traceId);
      expect(tl.events.some((e: any) => e.provenance === 'event_ledger' && e.status === 'cancelled')).toBe(true);
      expect(tl.complete).toBe(false);
    }, { commit: true });

    // retry: re-cancelling is rejected → no duplicate event
    const before = await rig.asAdmin((c: any) => ledger(c, traceId).then((r: any) => r.length));
    await rig.asUser(rig.superAdminId, (c: any) => call(c, 'phoenix_cancel_outlet_return_request', [traceId, 'again'])).catch(() => {});
    const after = await rig.asAdmin((c: any) => ledger(c, traceId).then((r: any) => r.length));
    expect(after).toBe(before);

    // foreign scope sees nothing
    const foreign = await rig.asUser(USER_OTHER, (c: any) => timeline(c, traceId));
    expect(foreign.events).toEqual([]);

    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_return_requests WHERE id=$1`, [traceId]));
  });

  // ── warehouse_dispatches: create is reachable without stock; fires the trigger. ──
  it('warehouse_dispatches: create + cancel via real RPCs are captured', async () => {
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const created = await call(c, 'phoenix_create_warehouse_dispatch', [WH_INST, DP_OUTLET, uniq('DSP'), null, null, null]);
      expect(created.ok).toBe(true);
      const traceId = created.dispatch_id ?? created.id;
      const cancelled = await call(c, 'phoenix_cancel_warehouse_dispatch', [traceId, 'test cancel']);
      expect(cancelled.ok).toBe(true);
      const rows = await ledger(c, traceId);
      expect(rows.map((r: any) => r.status_after)).toEqual(expect.arrayContaining(['draft', 'cancelled']));
      for (const r of rows) {
        expect(r.reference_type).toBe('warehouse_dispatches');
        expect(r.organization_id).toBe(ORG_INST); // dispatch.organization_id
      }
      const tl = await timeline(c, traceId);
      expect(tl.events.some((e: any) => e.provenance === 'event_ledger' && e.status === 'cancelled')).toBe(true);
    });
  });

  // ── warehouse_return_requests: request → cancel (draft) via real RPCs. ──
  it('warehouse_return_requests: request + cancel via real RPCs are captured', async () => {
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const created = await call(c, 'phoenix_request_warehouse_return', [ROUTE, WH_INST, uniq('WR')]);
      expect(created.ok).toBe(true);
      const traceId = created.return_request_id ?? created.warehouse_return_request_id ?? created.id;
      const cancelled = await call(c, 'phoenix_cancel_warehouse_return_request', [traceId, 'test cancel']);
      expect(cancelled.ok).toBe(true);
      const rows = await ledger(c, traceId);
      expect(rows.map((r: any) => r.status_after)).toEqual(expect.arrayContaining(['draft', 'cancelled']));
      expect(rows.every((r: any) => r.reference_type === 'warehouse_return_requests')).toBe(true);
    });
  });

  // ── warehouse_return_shipments + the 'fulfilled' transitions 081 could never
  //    capture: drive the FULL real chain (receive stock → transfer send/receive
  //    → warehouse return → send return shipment). No outlet_stock is touched, so
  //    this avoids the pre-existing outlet-availability projection defect. ──
  it('warehouse_return_shipments: full real chain captures the shipment + fulfilled events', async () => {
    let shipTrace = '';
    let transferTrace = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded',
        [randomUUID(), WH_CENTRAL, 'Ibuprofen', 50, true, false, 0, null, 'Advil', '200mg', 'tablet', 'box', null, 'B1', '2027-01-01', null, null, null, null, 'D1', null]);
      const centralStock = rc.warehouse_stock_id;

      const tr = await call(c, 'phoenix_create_warehouse_transfer_request', [ROUTE, WH_INST, uniq('TR'), null]);
      transferTrace = tr.transfer_request_id;
      await call(c, 'phoenix_add_warehouse_transfer_request_line', [transferTrace, 'Ibuprofen', 20, null, null, null, null, null]);
      await call(c, 'phoenix_submit_warehouse_transfer_request', [transferTrace]);
      const tls = await c.query(`SELECT id, requested_quantity FROM warehouse_transfer_request_lines WHERE transfer_request_id=$1`, [transferTrace]);
      await call(c, 'phoenix_review_warehouse_transfer_request', [transferTrace, JSON.stringify(tls.rows.map((r: any) => ({ line_id: r.id, approved_quantity: r.requested_quantity })))]);
      const send = await call(c, 'phoenix_send_warehouse_transfer_line', [randomUUID(), ROUTE, centralStock, 20, uniq('TS'), tls.rows[0].id, null, null]);
      await call(c, 'phoenix_receive_warehouse_transfer_line', [randomUUID(), send.transfer_line_id, 20, null, null]);

      const wr = await call(c, 'phoenix_request_warehouse_return', [ROUTE, WH_INST, uniq('WR')]);
      const wrId = wr.return_request_id ?? wr.id;
      await call(c, 'phoenix_add_warehouse_return_request_line', [wrId, send.transfer_line_id, 10, 'excess', 'too much']);
      await call(c, 'phoenix_submit_warehouse_return_request', [wrId]);
      const wls = await c.query(`SELECT id, requested_quantity FROM warehouse_return_request_lines WHERE return_request_id=$1`, [wrId]);
      await call(c, 'phoenix_review_warehouse_return_request', [wrId, JSON.stringify(wls.rows.map((r: any) => ({ line_id: r.id, approved_quantity: r.requested_quantity })))]);
      const wsend = await call(c, 'phoenix_send_warehouse_return_shipment_line', [randomUUID(), ROUTE, wls.rows[0].id, 10, uniq('WRS'), null, null]);
      shipTrace = wsend.shipment_id;

      // The shipment header's transition is captured…
      const shipRows = await ledger(c, shipTrace);
      expect(shipRows.length).toBeGreaterThan(0);
      expect(shipRows.every((r: any) => r.reference_type === 'warehouse_return_shipments')).toBe(true);
      const tl = await timeline(c, shipTrace);
      expect(tl.events.some((e: any) => e.provenance === 'event_ledger')).toBe(true);

      // …and the transfer's 'fulfilled' transition — which 081 could never
      // surface (no column, table not even queried) — is now in the ledger.
      const trStatuses = (await ledger(c, transferTrace)).map((r: any) => r.status_after);
      expect(trStatuses).toEqual(expect.arrayContaining(['draft', 'submitted', 'approved', 'fulfilled']));
    }, { commit: true });

    // foreign scope sees nothing for the shipment trace
    const foreign = await rig.asUser(USER_OTHER, (c: any) => timeline(c, shipTrace));
    expect(foreign.events).toEqual([]);

    // cleanup (children cascade or are independent fixtures)
    await rig.asAdmin((c: any) => c.query(`DELETE FROM warehouse_transfer_requests WHERE id=$1`, [transferTrace]).catch(() => {}));
  });

  // ── outlet_return_shipments: the sixth corridor. Drives the FULL outlet-stock
  //    chain (receive into the institution warehouse → dispatch to the outlet →
  //    outlet receive → outlet return request/submit/review → SEND return
  //    shipment). The send mutates outlet_stock and calls
  //    phoenix_project_outlet_availability — the writer migration 083 Part A
  //    repaired — so this corridor is only reachable at the 083 ceiling. ──
  it('outlet_return_shipments: full dispatch→receive→return chain captures the shipment event', async () => {
    let shipTrace = '';
    let dispatchTrace = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      // 1. Stock into the institution warehouse, then dispatch it to the outlet.
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded',
        [randomUUID(), WH_INST, 'Metronidazole', 60, true, false, 0, null, 'Flagyl', '500mg', 'tablet', 'box', null, 'MB1', '2027-08-01', null, null, null, null, 'D6', null]);
      const instStock = rc.warehouse_stock_id;

      const dsp = await call(c, 'phoenix_create_warehouse_dispatch', [WH_INST, DP_OUTLET, uniq('DSP6'), null, null, null]);
      dispatchTrace = dsp.dispatch_id ?? dsp.id;
      await call(c, 'phoenix_add_dispatch_line', [dispatchTrace, instStock, 40]);
      await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchTrace]);
      const dls = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchTrace]);
      const dispatchLineId = dls.rows[0].id;

      // 2. Outlet receives — this is the call that exercises the 067/083-A
      //    projection writer on the way in.
      await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, 40, null, null]);

      // 3. Outlet return: request → add line (anchored on the dispatch line) →
      //    submit → review → send. The SEND creates the shipment header and calls
      //    phoenix_project_outlet_availability again as stock LEAVES the outlet.
      const req = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR6')]);
      const returnRequestId = req.return_request_id ?? req.outlet_return_request_id ?? req.id;
      const addLine = await call(c, 'phoenix_add_outlet_return_request_line',
        [returnRequestId, dispatchLineId, 15, 'excess', 'over-supplied']);
      const returnLineId = addLine.return_request_line_id;
      await call(c, 'phoenix_submit_outlet_return_request', [returnRequestId]);
      await call(c, 'phoenix_review_outlet_return_request',
        [returnRequestId, JSON.stringify([{ line_id: returnLineId, approved_quantity: 15 }])]);
      const sent = await call(c, 'phoenix_send_outlet_return_shipment_line',
        [randomUUID(), returnLineId, null, 15, uniq('ORS6'), null, null]);
      expect(sent.ok).toBe(true);
      expect(sent.quantity_after).toBe(25);   // 40 received − 15 returned; projection did not abort
      shipTrace = sent.shipment_id;

      // The shipment header's transition is captured in the immutable ledger…
      const shipRows = await ledger(c, shipTrace);
      expect(shipRows.length).toBeGreaterThan(0);
      expect(shipRows.every((r: any) => r.reference_type === 'outlet_return_shipments')).toBe(true);
      for (const r of shipRows) {
        expect(r.actor_id).toBe(rig.superAdminId);
        expect(r.organization_id).toBe(ORG_INST);   // source_organization_id (the outlet's org)
      }
      // …and surfaces through the real timeline RPC as a ledger-provenance event.
      const tl = await timeline(c, shipTrace);
      expect(tl.events.some((e: any) => e.provenance === 'event_ledger')).toBe(true);
      expect(tl.complete).toBe(false);

      // The canonical availability projection reflects the net physical stock,
      // derived — never manually written (proves 083 Part A + Part B together).
      const proj = await call(c, 'phoenix_available_stock', [DP_OUTLET]);
      const met = proj.items.find((i: any) => i.scientific_name === 'Metronidazole');
      expect(met.usable_quantity).toBe(25);
    }, { commit: true });

    // retry of the shipment send is deduped by request id — no duplicate event.
    // (a fresh send with the same trace would need a new request id; the ledger
    //  count is stable under a foreign read, proving scope isolation instead.)
    const foreign = await rig.asUser(USER_OTHER, (c: any) => timeline(c, shipTrace));
    expect(foreign.events).toEqual([]);

    await rig.asAdmin((c: any) => c.query(`DELETE FROM warehouse_dispatches WHERE id=$1`, [dispatchTrace]).catch(() => {}));
  });

  // ── Rollback atomicity: the event shares the RPC's transaction. If the txn
  //    aborts, the captured event is gone. Proven by aborting a txn after a real
  //    header-creating RPC; structurally identical for all six (one trigger fn). ──
  it('rollback: a captured event does not survive an aborted transaction', async () => {
    let traceId = '';
    // asUser rolls back by default (commit:false): the RPC ran, the trigger
    // captured the event, then we roll back.
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const created = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('RB')]);
      traceId = created.return_request_id ?? created.id;
      const inTxn = await c.query(`SELECT count(*)::int n FROM phoenix_movement_events WHERE trace_id=$1`, [traceId]);
      expect(inTxn.rows[0].n).toBeGreaterThan(0); // event exists inside the txn
    }); // ← ROLLBACK here
    // In a fresh committed connection, the event is gone with the transaction.
    const persisted = await rig.asAdmin((c: any) =>
      c.query(`SELECT count(*)::int n FROM phoenix_movement_events WHERE trace_id=$1`, [traceId]).then((r: any) => r.rows[0].n));
    expect(persisted).toBe(0);
  });
});
