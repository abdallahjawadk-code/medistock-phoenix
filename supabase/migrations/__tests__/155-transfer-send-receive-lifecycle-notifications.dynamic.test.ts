/**
 * TRANSFER-SEND-RECEIVE-LIFECYCLE-NOTIFICATIONS-155 — DYNAMIC integration
 * proof, against a real disposable Postgres with 001->155 applied in order.
 *
 * Drives the real direct-corridor RPCs (create -> add-line -> submit ->
 * review -> send -> receive) and proves the SEND and RECEIVE transitions on
 * `warehouse_transfers` now populate phoenix_movement_events and
 * phoenix_notifications, scoped to source_organization_id, exactly like the
 * six pre-existing corridors. Also proves warehouse_transfer_lines stays
 * silent (no notification of its own — the header rollup already covers it)
 * and that migration 154's privilege lockdown survives untouched.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000d155';
const WH_CENTRAL = '00000000-0000-0000-0000-00000001d155';
const WH_INST = '00000000-0000-0000-0000-00000002d155';
const CWM = '00000000-0000-0000-0000-00000003d155'; // central_warehouse_manager, scoped to WH_CENTRAL
const WOF = '00000000-0000-0000-0000-00000004d155'; // warehouse_officer, scoped to WH_INST

run('155 transfer send/receive lifecycle notifications — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 155 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','D155 Org','مؤسسة د155','d155-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','D155 Central','مركزي د155','active','central','d155-wc'),
        ('${WH_INST}','${ORG}','D155 Inst WH','مخزن مؤسسة د155','active','institution','d155-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','d155-cwm@rig'),('${WOF}','d155-wof@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WOF}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM}','${ORG}','warehouse','${WH_CENTRAL}',true),
               ('${WOF}','${ORG}','warehouse','${WH_INST}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('the ten pre-existing phoenix_capture_lifecycle attachments (082, 099, 122) are untouched, plus an eleventh on warehouse_transfers', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT c.relname FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'phoenix_capture_lifecycle' AND NOT t.tgisinternal
        ORDER BY c.relname`);
      const tables = r.rows.map((row: any) => row.relname);
      expect(tables).toEqual([
        'inventory_status_reports',
        'outlet_return_requests',
        'outlet_return_shipments',
        'phoenix_stock_correction_requests',
        'phoenix_warehouse_correction_requests',
        'procurement_orders',
        'warehouse_dispatches',
        'warehouse_return_requests',
        'warehouse_return_shipments',
        'warehouse_transfer_requests',
        'warehouse_transfers',
      ]);
      expect(tables).not.toContain('warehouse_transfer_lines');
    });
  });

  it('SEND then RECEIVE on the direct corridor produces movement_events + notifications for warehouse_transfers, scoped by source org, and warehouse_transfer_lines stays silent', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'D155-Amoxicillin',true,false,'D155-B1','2030-01-01',100,0,0)`,
        [stockId, ORG, WH_CENTRAL]);
    });

    let requestId: string;
    let lineId: string;
    let transferNumber = 'D155-XFER-1';
    await rig.asUser(CWM, async (c: any) => {
      const created = await call(c, 'phoenix_create_direct_warehouse_transfer_request', [
        WH_CENTRAL, ORG, WH_INST, 'D155-REQ-1', null,
      ]);
      expect(created.ok).toBe(true);
      requestId = created.transfer_request_id;

      const added = await call(c, 'phoenix_add_warehouse_transfer_request_line', [
        requestId, 'D155-Amoxicillin', 30, null, null, null, null, null,
      ]);
      expect(added.ok).toBe(true);
      lineId = added.transfer_request_line_id;

      const submitted = await call(c, 'phoenix_submit_warehouse_transfer_request', [requestId]);
      expect(submitted.ok).toBe(true);

      const reviewed = await call(c, 'phoenix_review_warehouse_transfer_request', [
        requestId, JSON.stringify([{ line_id: lineId, approved_quantity: 30 }]),
      ]);
      expect(reviewed.ok).toBe(true);

      const sent = await call(c, 'phoenix_send_direct_warehouse_transfer_line', [
        randomUUID(), requestId, stockId, 30, transferNumber, lineId, null, null,
      ]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    let transferId: string;
    let transferLineId: string;
    await rig.asAdmin(async (c: any) => {
      const t = await c.query(`SELECT id FROM warehouse_transfers WHERE transfer_number = $1`, [transferNumber]);
      expect(t.rows.length).toBe(1);
      transferId = t.rows[0].id;

      const l = await c.query(`SELECT id FROM warehouse_transfer_lines WHERE transfer_id = $1`, [transferId]);
      expect(l.rows.length).toBe(1);
      transferLineId = l.rows[0].id;
    });

    // SEND created the header with status='in_transit' — that INSERT is
    // itself a real transition (NULL -> 'in_transit') and must have fired.
    await rig.asAdmin(async (c: any) => {
      const ev = await c.query(
        `SELECT organization_id, status_after, notes FROM phoenix_movement_events
         WHERE reference_type = 'warehouse_transfers' AND reference_id = $1`,
        [transferId]);
      expect(ev.rows.length).toBe(1);
      expect(ev.rows[0].status_after).toBe('in_transit');
      expect(ev.rows[0].organization_id).toBe(ORG);
      expect(ev.rows[0].notes).toBe(transferNumber); // transfer_number reached v_doc via the new COALESCE branch

      const notif = await c.query(
        `SELECT organization_id, status_after, reference_label FROM phoenix_notifications
         WHERE reference_type = 'warehouse_transfers' AND reference_id = $1`,
        [transferId]);
      expect(notif.rows.length).toBe(1);
      expect(notif.rows[0].status_after).toBe('in_transit');
      expect(notif.rows[0].reference_label).toBe(transferNumber);
    });

    // warehouse_transfer_lines has NO trigger — the line row's own INSERT
    // must never produce a movement_events/notifications row keyed to it.
    await rig.asAdmin(async (c: any) => {
      const ev = await c.query(
        `SELECT 1 FROM phoenix_movement_events WHERE reference_type = 'warehouse_transfer_lines' AND reference_id = $1`,
        [transferLineId]);
      expect(ev.rows.length).toBe(0);
    });

    await rig.asUser(WOF, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), transferLineId, 30, null, null,
      ]);
      expect(received.ok).toBe(true);
    }, { commit: true });

    // RECEIVE rolled the header up to 'received' (068's own RPC, no lines
    // left in_transit) — that UPDATE is a second real transition.
    await rig.asAdmin(async (c: any) => {
      const ev = await c.query(
        `SELECT status_after FROM phoenix_movement_events
         WHERE reference_type = 'warehouse_transfers' AND reference_id = $1
         ORDER BY occurred_at`,
        [transferId]);
      expect(ev.rows.map((r: any) => r.status_after)).toEqual(['in_transit', 'received']);

      const notif = await c.query(
        `SELECT status_after FROM phoenix_notifications
         WHERE reference_type = 'warehouse_transfers' AND reference_id = $1
         ORDER BY occurred_at`,
        [transferId]);
      expect(notif.rows.map((r: any) => r.status_after)).toEqual(['in_transit', 'received']);
    });

    // Visible to a profile in ORG via the existing read RPC (org-scoped, same
    // RLS path proven by 094's own dynamic test).
    await rig.asUser(CWM, async (c: any) => {
      const list = await call(c, 'phoenix_notifications_list', [30, null, null, false]);
      expect(list.ok).toBe(true);
      const mine = list.notifications.filter((n: any) => n.reference_id === transferId);
      expect(mine.length).toBe(2);
    });
  });

  it("migration 154's privilege lockdown on the four transfer-corridor tables survives 155 untouched", async () => {
    await rig.asAdmin(async (c: any) => {
      for (const t of ['warehouse_transfer_requests', 'warehouse_transfer_request_lines', 'warehouse_transfers', 'warehouse_transfer_lines']) {
        for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) {
          const r = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, $2) AS has`, [t, priv]);
          expect(r.rows[0].has, `authenticated must still not have ${priv} on ${t}`).toBe(false);
        }
        const sel = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, 'SELECT') AS has`, [t]);
        expect(sel.rows[0].has, `authenticated must still have SELECT on ${t}`).toBe(true);
      }
    });
  });

  it('re-applying migration 155 a second time is a safe no-op (DROP TRIGGER IF EXISTS / CREATE OR REPLACE)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { MIGRATIONS_DIR } = await import('../../../tools/pg-rig/rig.mjs');
    const sql = readFileSync(join(MIGRATIONS_DIR, '155_phoenix_transfer_send_receive_lifecycle_notifications.sql'), 'utf8')
      // The migration's own precondition guard aborts if the trigger already
      // exists (correct for a first apply) — strip the DO $$ precondition
      // block for this specific re-apply proof, matching how 154's own
      // re-apply test only re-runs the idempotent DDL, not a guard designed
      // to fire exactly once.
      .replace(/DO \$\$ BEGIN\s+IF to_regprocedure[\s\S]*?END \$\$;\n\n/, '');
    await rig.asAdmin(async (c: any) => {
      await c.query(sql);
      const r = await c.query(`
        SELECT count(*)::int n FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_transfers'`);
      expect(r.rows[0].n).toBe(1); // DROP TRIGGER IF EXISTS + CREATE TRIGGER never duplicates
    });
  });
});
