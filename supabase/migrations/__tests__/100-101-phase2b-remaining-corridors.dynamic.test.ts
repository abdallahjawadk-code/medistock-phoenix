/**
 * PHASE-2B-REMAINING-CORRIDORS — DYNAMIC proof for migrations 100-101,
 * against a real disposable Postgres with 001->101 applied in order.
 *
 * Modeled on 095-099-phase2b-core.dynamic.test.ts's style: each migration's
 * OWN new logic is isolated by seeding rows directly (the single-line RPCs
 * these delegate to are already proven by 068/078's own dynamic tests) — this
 * file proves the NEW bulk/approval gates added on top of that already-proven
 * base.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000c0001';
const WH_CENTRAL = '00000000-0000-0000-0000-0000000c0101';
const WH_INST = '00000000-0000-0000-0000-0000000c0102';
const ROUTE = '00000000-0000-0000-0000-0000000c0201';

const CWM = '00000000-0000-0000-0000-0000000c0401'; // central_warehouse_manager
const WO1 = '00000000-0000-0000-0000-0000000c0402'; // warehouse_officer (receives at institution; proposer)
const WO2 = '00000000-0000-0000-0000-0000000c0403'; // warehouse_officer (holds correct, NOT approve_correction)

run('100-101 Phase 2b remaining corridors — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 101 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p2c-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','Central','مركزي','active','central','p2c-wc'),
        ('${WH_INST}','${ORG}','Inst WH','مخزن مؤسسة','active','institution','p2c-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true) ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','p2c-cwm@rig'),('${WO1}','p2c-wo1@rig'),('${WO2}','p2c-wo2@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id IN ('${WO1}','${WO2}');`);

      // WO1/WO2 need a warehouse-scoped assignment on WH_INST — 068's receive
      // permission ('warehouse_transfer.receive', held by warehouse_officer)
      // and 101's request-side permission ('warehouse_stock.correct', also
      // held by warehouse_officer) both check phoenix_profile_has_scoped_
      // permission(..., p_warehouse_id) which for a non-org-wide role falls
      // through to an explicit warehouse assignment.
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO1}','${ORG}','warehouse','${WH_INST}',true),
               ('${WO2}','${ORG}','warehouse','${WH_INST}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── 100: bulk receive remaining corridors (068 — warehouse transfer) ─────
  describe('100 — bulk receive remaining corridors (068 transfer-line corridor)', () => {
    it('auto-receives an exact match, skips a mismatch and an already-decided line, and a retry does not double-post', async () => {
      const transferId = randomUUID();
      const lineMatch = randomUUID();
      const lineMismatch = randomUUID();
      const lineDecided = randomUUID();
      const stockA = randomUUID(), stockB = randomUUID(), stockC = randomUUID();

      await rig.asAdmin(async (c: any) => {
        // Source-side warehouse_stock rows the transfer lines snapshot from
        // (source is CENTRAL — the sending warehouse).
        await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$4,$5,'P2C-A',true,false,'B-A',0,0,0),
                 ($2,$4,$5,'P2C-B',true,false,'B-B',0,0,0),
                 ($3,$4,$5,'P2C-C',true,false,'B-C',0,0,0)`,
          [stockA, stockB, stockC, ORG, WH_CENTRAL]);

        await c.query(`INSERT INTO warehouse_transfers
          (id, route_id, source_warehouse_id, source_organization_id, destination_warehouse_id, destination_organization_id, transfer_number, status, sent_by, sent_at)
          VALUES ($1,$2,$3,$4,$5,$4,'P2C-WT-1','in_transit',$6,now())`,
          [transferId, ROUTE, WH_CENTRAL, ORG, WH_INST, CWM]);

        await c.query(`INSERT INTO warehouse_transfer_lines
          (id, transfer_id, source_organization_id, source_warehouse_stock_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, sent_quantity, status)
          VALUES ($1,$2,$3,$4,'P2C-A',true,false,'B-A',40,'in_transit')`, [lineMatch, transferId, ORG, stockA]);
        await c.query(`INSERT INTO warehouse_transfer_lines
          (id, transfer_id, source_organization_id, source_warehouse_stock_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, sent_quantity, status)
          VALUES ($1,$2,$3,$4,'P2C-B',true,false,'B-B',40,'in_transit')`, [lineMismatch, transferId, ORG, stockB]);
        // Already decided — received in full previously.
        await c.query(`INSERT INTO warehouse_transfer_lines
          (id, transfer_id, source_organization_id, source_warehouse_stock_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, sent_quantity, received_quantity, status, received_at)
          VALUES ($1,$2,$3,$4,'P2C-C',true,false,'B-C',40,40,'received',now())`, [lineDecided, transferId, ORG, stockC]);
      });

      let bulkId = '';
      await rig.asUser(WO1, async (c: any) => {
        bulkId = randomUUID();
        const result = await call(c, 'phoenix_receive_all_matching_transfer_lines', [
          bulkId, transferId,
          JSON.stringify([
            { transfer_line_id: lineMatch, counted_quantity: 40 },     // exact match
            { transfer_line_id: lineMismatch, counted_quantity: 35 },  // mismatch -> skipped
            { transfer_line_id: lineDecided, counted_quantity: 40 },   // already decided -> skipped
          ]),
          null,
        ]);
        expect(result.ok).toBe(true);
        expect(result.received_count).toBe(1);
        expect(result.skipped_count).toBe(2);
        const byLine = Object.fromEntries(result.lines.map((l: any) => [l.transfer_line_id, l.status]));
        expect(byLine[lineMatch]).toBe('received');
        expect(byLine[lineMismatch]).toBe('skipped_mismatch_requires_individual_review');
        expect(byLine[lineDecided]).toBe('skipped_already_decided');

        const mismatchEntry = result.lines.find((l: any) => l.transfer_line_id === lineMismatch);
        expect(mismatchEntry.sent_quantity).toBe(40);
        expect(mismatchEntry.counted_quantity).toBe(35);
      }, { commit: true });

      // The line moved to 'received' at the SQL level.
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT status FROM warehouse_transfer_lines WHERE id=$1`, [lineMatch]);
        expect(r.rows[0].status).toBe('received');
      });

      // A retry of the SAME bulk request id must not double-post: the line's
      // status already moved off 'in_transit', so the retry's own pre-check
      // reports it as already-decided.
      let onHandAfterFirst = 0;
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT on_hand_quantity FROM warehouse_stock WHERE organization_id=$1 AND warehouse_id=$2 AND scientific_name='P2C-A'`,
          [ORG, WH_INST]);
        expect(r.rows.length).toBe(1);
        onHandAfterFirst = r.rows[0].on_hand_quantity;
        expect(onHandAfterFirst).toBe(40);
      });

      await rig.asUser(WO1, async (c: any) => {
        const retry = await call(c, 'phoenix_receive_all_matching_transfer_lines', [
          bulkId, transferId,
          JSON.stringify([{ transfer_line_id: lineMatch, counted_quantity: 40 }]),
          null,
        ]);
        expect(retry.lines[0].status).toBe('skipped_already_decided');
      }, { commit: true });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT on_hand_quantity FROM warehouse_stock WHERE organization_id=$1 AND warehouse_id=$2 AND scientific_name='P2C-A'`,
          [ORG, WH_INST]);
        expect(r.rows[0].on_hand_quantity).toBe(onHandAfterFirst); // unchanged — no double application
      });
    });
  });

  // ── 101: warehouse second-person correction approval, fail-closed ───────
  describe('101 — warehouse second-person correction approval, fail-closed', () => {
    it('a nonzero variance requires approval by default (no policy row = threshold 0), and warehouse_stock is unchanged while pending', async () => {
      const stockId = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$2,$3,'P2C-VAR',true,false,'B-VAR',100,0,0)`, [stockId, ORG, WH_INST]);
      });

      let correctionId = '';
      await rig.asUser(WO1, async (c: any) => {
        const r = await call(c, 'phoenix_request_warehouse_stock_correction',
          [randomUUID(), stockId, 90, 'physical count', null, null, null]);
        expect(r.ok).toBe(true);
        expect(r.requires_approval).toBe(true);
        expect(r.status).toBe('pending');
        correctionId = r.correction_request_id;
      }, { commit: true });

      // warehouse_stock is UNCHANGED while pending.
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(100);
      });

      // The proposer cannot approve their own request — checked by identity,
      // independent of role/permission.
      await rig.asUser(WO1, async (c: any) => {
        await expect(call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]))
          .rejects.toThrow(/proposer_cannot_approve_own_correction/);
      });

      // A different, unauthorized person (WO2 — holds warehouse_stock.correct
      // but NOT warehouse_stock.approve_correction) is refused too.
      await rig.asUser(WO2, async (c: any) => {
        await expect(call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]))
          .rejects.toThrow(/forbidden_correction_approval/);
      });

      // CWM (different person, holds warehouse_stock.approve_correction per
      // THIS migration's own grant) approves -> applies.
      await rig.asUser(CWM, async (c: any) => {
        const r = await call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]);
        expect(r.ok).toBe(true);
        expect(r.status).toBe('approved');
      }, { commit: true });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(90);
      });
    });

    it('a rejected request applies nothing, and reuses the SAME phoenix_variance_approval_policy threshold 098 set for outlet corrections', async () => {
      const stockId = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$2,$3,'P2C-VAR-REJ',true,false,'B-VAR-REJ',60,0,0)`, [stockId, ORG, WH_INST]);
      });

      let correctionId = '';
      await rig.asUser(WO1, async (c: any) => {
        const r = await call(c, 'phoenix_request_warehouse_stock_correction',
          [randomUUID(), stockId, 55, 'physical count', null, null, null]);
        expect(r.requires_approval).toBe(true);
        correctionId = r.correction_request_id;
      }, { commit: true });

      await rig.asUser(CWM, async (c: any) => {
        const r = await call(c, 'phoenix_reject_warehouse_stock_correction', [correctionId, 'variance not credible']);
        expect(r.ok).toBe(true);
        expect(r.status).toBe('rejected');
      }, { commit: true });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(60); // unchanged — a rejection is never applied
      });

      // Now raise the SAME shared threshold (098's own RPC, ORG-scoped) and
      // prove a SMALL warehouse variance applies without approval too — the
      // one policy table genuinely covers both outlet (098) and warehouse
      // (101) corrections, not two independent unsynced knobs.
      const stockId2 = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$2,$3,'P2C-VAR2',true,false,'B-VAR2',50,0,0)`, [stockId2, ORG, WH_INST]);
      });

      await rig.asUser(CWM, async (c: any) => {
        const p = await call(c, 'phoenix_set_variance_approval_policy', [ORG, 5]);
        expect(p.ok).toBe(true);
      }, { commit: true });

      // Within-threshold corrections apply IMMEDIATELY via 078's generation-
      // guarded RPC, which fails closed without an expected generation —
      // fetch the stock row's current movement_seq first.
      let generation = 0;
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT movement_seq FROM warehouse_stock WHERE id=$1`, [stockId2]);
        generation = r.rows[0].movement_seq;
      });

      await rig.asUser(WO1, async (c: any) => {
        const r = await call(c, 'phoenix_request_warehouse_stock_correction',
          [randomUUID(), stockId2, 48, 'physical count', generation, null, null]); // variance=2 <= threshold 5
        expect(r.requires_approval).toBe(false);
        expect(r.ok).toBe(true);
      }, { commit: true });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId2]);
        expect(r.rows[0].on_hand_quantity).toBe(48);
      });
    });
  });
});
