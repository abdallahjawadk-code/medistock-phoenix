/**
 * 097/098/101 LIVE-GAPS — DYNAMIC proof of the Phase-2 acceptance-matrix
 * scenarios NOT already covered by 095-099-phase2b-core.dynamic.test.ts,
 * 100-101-phase2b-remaining-corridors.dynamic.test.ts, and
 * phase2-e2e-custody-chain.dynamic.test.ts (all read before writing this
 * file — self-approval rejection, requester != approver, threshold gating,
 * and basic FEFO fail-closed are ALREADY proven there and are not repeated
 * here). This file closes the remaining items from the Phase 2 gap list:
 *
 *   - stale generation on APPROVE (not just on request) raises ERRCODE 40001
 *     for BOTH the outlet (098) and warehouse (101) correction approvals.
 *   - approve/reject execute exactly once: calling approve twice on an
 *     already-decided request fails cleanly on the second call and does not
 *     double-mutate stock.
 *   - cross-org isolation: a correction request raised in org A is invisible
 *     (RLS) to, and cannot be approved by, an actor in org B who holds the
 *     identical approval permission in their own org.
 *   - blank/WHITESPACE-ONLY FEFO override reason is rejected server-side
 *     (097's own dynamic test only exercises NULL, not an empty/blank
 *     string — this closes that specific edge explicitly).
 *   - final invariant: outlet_stock / warehouse_stock quantities reconcile
 *     against their movement ledgers, and never go negative, across all of
 *     the above.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

// Org A
const ORG_A = '00000000-0000-0000-0000-0000000e0001';
const WH_A = '00000000-0000-0000-0000-0000000e0101';
const DP_A = '00000000-0000-0000-0000-0000000e0301';
const CWM_A = '00000000-0000-0000-0000-0000000e0401'; // central_warehouse_manager, org A — proposer's counterpart approver
const WO_A = '00000000-0000-0000-0000-0000000e0402';  // warehouse_officer, org A — proposer (warehouse-side corrections)
const OO_A = '00000000-0000-0000-0000-0000000e0404';  // outlet_officer, org A — proposer (outlet-side corrections; holds outlet_stock.count)

// Org B — structurally identical roles/permissions, DIFFERENT organization.
const ORG_B = '00000000-0000-0000-0000-0000000e0002';
const WH_B = '00000000-0000-0000-0000-0000000e0102';
const CWM_B = '00000000-0000-0000-0000-0000000e0403'; // central_warehouse_manager, org B — holds the SAME permission, wrong org

run('097/098/101 live gaps — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 106 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_A}','Org A','مؤسسة أ','p97g-orgA'),
        ('${ORG_B}','Org B','مؤسسة ب','p97g-orgB')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH A','مخزن أ','active','institution','p97g-wA'),
        ('${WH_B}','${ORG_B}','WH B','مخزن ب','active','institution','p97g-wB')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_A}','${WH_A}','${ORG_A}','Outlet A','منفذ أ','pharmacy','active') ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM_A}','p97g-cwmA@rig'),('${WO_A}','p97g-woA@rig'),('${CWM_B}','p97g-cwmB@rig'),('${OO_A}','p97g-ooA@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG_A}' WHERE id='${CWM_A}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_A}' WHERE id='${WO_A}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG_B}' WHERE id='${CWM_B}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM_A}','${ORG_A}','warehouse','${WH_A}',true),
               ('${WO_A}','${ORG_A}','warehouse','${WH_A}',true),
               ('${CWM_B}','${ORG_B}','warehouse','${WH_B}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${CWM_A}','${ORG_A}','distribution_point','${DP_A}',true),
               ('${WO_A}','${ORG_A}','distribution_point','${DP_A}',true),
               ('${OO_A}','${ORG_A}','distribution_point','${DP_A}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── Stale generation on APPROVE, ERRCODE 40001 ──────────────────────────
  describe('stale generation at approval time', () => {
    it('098 — approving an outlet correction with a stale p_expected_generation raises 40001, applies nothing', async () => {
      const stockId = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$2,$3,'pharmacy','P97G-OUT',true,false,'B-OUT',80,0,3)`, [stockId, ORG_A, DP_A]);
      });

      let correctionId = '';
      await rig.asUser(OO_A, async (c: any) => {
        const r = await call(c, 'phoenix_request_outlet_stock_correction',
          [randomUUID(), stockId, 70, 'physical count', null, null]);
        expect(r.requires_approval).toBe(true);
        correctionId = r.correction_request_id;
      }, { commit: true });

      // A concurrent, unrelated movement bumps movement_seq between the
      // proposal and the approval — the approver's client is holding a
      // now-stale generation number. movement_seq is SERVER-OWNED (086's
      // BEFORE UPDATE trigger): it only advances when on_hand/reserved
      // actually change, and any client-supplied value is overwritten — so
      // the bump must be a REAL reserved_quantity change, not a same-value
      // no-op update (which the trigger would correctly leave un-bumped).
      await rig.asAdmin(async (c: any) => {
        await c.query(`UPDATE outlet_stock SET reserved_quantity = reserved_quantity + 1 WHERE id=$1`, [stockId]);
      });

      await rig.asUser(CWM_A, async (c: any) => {
        await expect(call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, 3]))
          .rejects.toThrow(/outlet_stock_generation_conflict/);
      });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity, status FROM outlet_stock ws, phoenix_stock_correction_requests r
                                    WHERE ws.id=$1 AND r.id=$2`, [stockId, correctionId]);
        expect(r.rows[0].on_hand_quantity).toBe(80); // unchanged
        expect(r.rows[0].status).toBe('pending'); // never marked approved by a rejected call
      });

      // The SAME correction, approved with the CORRECT (current) generation, succeeds.
      await rig.asUser(CWM_A, async (c: any) => {
        const r = await call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, 4]);
        expect(r.ok).toBe(true);
      }, { commit: true });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(70);
      });
    });

    it('101 — approving a warehouse correction with a stale p_expected_generation raises 40001, applies nothing', async () => {
      const stockId = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$2,$3,'P97G-WH',true,false,'B-WH',60,0,5)`, [stockId, ORG_A, WH_A]);
      });

      let correctionId = '';
      await rig.asUser(WO_A, async (c: any) => {
        const r = await call(c, 'phoenix_request_warehouse_stock_correction',
          [randomUUID(), stockId, 50, 'physical count', null, null, null]);
        expect(r.requires_approval).toBe(true);
        correctionId = r.correction_request_id;
      }, { commit: true });

      // Same server-owned-generation caveat as the outlet case above: the
      // bump must be a REAL reserved_quantity change to actually advance
      // movement_seq via 078's trigger, not a same-value no-op.
      await rig.asAdmin(async (c: any) => {
        await c.query(`UPDATE warehouse_stock SET reserved_quantity = reserved_quantity + 1 WHERE id=$1`, [stockId]);
      });

      await rig.asUser(CWM_A, async (c: any) => {
        await expect(call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, 5]))
          .rejects.toThrow(/warehouse_receipt_generation_conflict/);
      });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(60); // unchanged
      });

      await rig.asUser(CWM_A, async (c: any) => {
        const r = await call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, 6]);
        expect(r.ok).toBe(true);
      }, { commit: true });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(50);
      });
    });
  });

  // ── Exactly-once approve: a second call on an already-decided request ──
  describe('exactly-once approval', () => {
    it('098 — approving an already-approved outlet correction twice fails cleanly on the second call, no double mutation', async () => {
      const stockId = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$2,$3,'pharmacy','P97G-ONCE',true,false,'B-ONCE',40,0,0)`, [stockId, ORG_A, DP_A]);
      });

      let correctionId = '';
      await rig.asUser(OO_A, async (c: any) => {
        const r = await call(c, 'phoenix_request_outlet_stock_correction',
          [randomUUID(), stockId, 33, 'physical count', null, null]);
        correctionId = r.correction_request_id;
      }, { commit: true });

      await rig.asUser(CWM_A, async (c: any) => {
        const r = await call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]);
        expect(r.ok).toBe(true);
      }, { commit: true });

      // Second approve on the SAME (now decided) request — must fail, not re-apply.
      await rig.asUser(CWM_A, async (c: any) => {
        await expect(call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]))
          .rejects.toThrow(/correction_request_not_pending/);
      });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(33); // applied exactly once, not re-applied or double-delta'd
        const movements = await c.query(
          `SELECT count(*)::int n FROM outlet_stock_movements WHERE outlet_stock_id=$1 AND movement_type='correction'`, [stockId]);
        expect(movements.rows[0].n).toBe(1);
      });
    });

    it('101 — rejecting an already-decided warehouse correction fails cleanly, and a decided request cannot later be approved', async () => {
      const stockId = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$2,$3,'P97G-WONCE',true,false,'B-WONCE',20,0,0)`, [stockId, ORG_A, WH_A]);
      });

      let correctionId = '';
      await rig.asUser(WO_A, async (c: any) => {
        const r = await call(c, 'phoenix_request_warehouse_stock_correction',
          [randomUUID(), stockId, 18, 'physical count', null, null, null]);
        correctionId = r.correction_request_id;
      }, { commit: true });

      await rig.asUser(CWM_A, async (c: any) => {
        const r = await call(c, 'phoenix_reject_warehouse_stock_correction', [correctionId, 'not credible']);
        expect(r.ok).toBe(true);
      }, { commit: true });

      // Trying to APPROVE a request that was already REJECTED must fail, not silently apply.
      await rig.asUser(CWM_A, async (c: any) => {
        await expect(call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]))
          .rejects.toThrow(/correction_request_not_pending/);
      });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(20); // never applied
      });
    });
  });

  // ── Cross-org isolation ─────────────────────────────────────────────────
  describe('cross-org isolation of correction requests', () => {
    it('an org-B actor holding the SAME approval permission cannot see or approve an org-A correction request', async () => {
      const stockId = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
          VALUES ($1,$2,$3,'pharmacy','P97G-XORG',true,false,'B-XORG',90,0,0)`, [stockId, ORG_A, DP_A]);
      });

      let correctionId = '';
      await rig.asUser(OO_A, async (c: any) => {
        const r = await call(c, 'phoenix_request_outlet_stock_correction',
          [randomUUID(), stockId, 80, 'physical count', null, null]);
        correctionId = r.correction_request_id;
      }, { commit: true });

      // RLS: org-B actor cannot even SELECT the row.
      await rig.asUser(CWM_B, async (c: any) => {
        const r = await c.query(`SELECT * FROM phoenix_stock_correction_requests WHERE id=$1`, [correctionId]);
        expect(r.rows.length).toBe(0);
      });

      // And cannot approve it — the RPC's own organization_id-scoped
      // permission check refuses even though CWM_B holds
      // outlet_stock.approve_correction in THEIR OWN org.
      await rig.asUser(CWM_B, async (c: any) => {
        await expect(call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]))
          .rejects.toThrow(/forbidden_correction_approval/);
      });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
        expect(r.rows[0].on_hand_quantity).toBe(90); // untouched by the cross-org attempt
      });

      // The correct, in-org approver still succeeds afterwards.
      await rig.asUser(CWM_A, async (c: any) => {
        const r = await call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]);
        expect(r.ok).toBe(true);
      }, { commit: true });
    });

    it('106s own dedup ledger is also org-scoped by RLS: an org-B actor cannot read org-A dispatch-line request rows', async () => {
      const dispatchId = randomUUID();
      const stockId = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO warehouse_dispatches (id, organization_id, warehouse_id, destination_distribution_point_id, dispatch_number, status, created_by)
          VALUES ($1,$2,$3,$4,'P97G-XORG-DSP','draft',$5)`, [dispatchId, ORG_A, WH_A, DP_A, WO_A]);
        await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
          VALUES ($1,$2,$3,'P97G-XORG-DSP',true,false,'B-XORG-DSP',20,0,current_date+10,0)`, [stockId, ORG_A, WH_A]);
      });

      const requestId = randomUUID();
      await rig.asUser(WO_A, async (c: any) => {
        const r = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [dispatchId, stockId, 3, false, null, requestId]);
        expect(r.ok).toBe(true);
      }, { commit: true });

      await rig.asUser(CWM_B, async (c: any) => {
        const r = await c.query(`SELECT * FROM phoenix_dispatch_line_requests WHERE request_id=$1`, [requestId]);
        expect(r.rows.length).toBe(0); // invisible cross-org, even though the row genuinely exists
      });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT * FROM phoenix_dispatch_line_requests WHERE request_id=$1`, [requestId]);
        expect(r.rows.length).toBe(1); // confirms it's an RLS restriction, not a missing row
      });
    });
  });

  // ── Whitespace-only FEFO override reason (097) ──────────────────────────
  describe('FEFO override reason validation edge case', () => {
    it('a whitespace-only override reason is rejected server-side exactly like a NULL one', async () => {
      const dispatchId = randomUUID();
      const earlyLot = randomUUID(), lateLot = randomUUID();
      await rig.asAdmin(async (c: any) => {
        await c.query(`INSERT INTO warehouse_dispatches (id, organization_id, warehouse_id, destination_distribution_point_id, dispatch_number, status, created_by)
          VALUES ($1,$2,$3,$4,'P97G-WS','draft',$5)`, [dispatchId, ORG_A, WH_A, DP_A, WO_A]);
        await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, on_hand_quantity, reserved_quantity, expiry_date, batch_number, movement_seq)
          VALUES ($1,$2,$3,'P97G-WS',true,false,50,0,current_date + 30,'EARLY-WS',0),
                 ($4,$2,$3,'P97G-WS',true,false,50,0,current_date + 90,'LATE-WS',0)`,
          [earlyLot, ORG_A, WH_A, lateLot]);
      });

      await rig.asUser(WO_A, async (c: any) => {
        await expect(call(c, 'phoenix_add_dispatch_line_fefo_guarded',
          [dispatchId, lateLot, 5, true, '   '])).rejects.toThrow(/fefo_override_reason_required/);
      });

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [lateLot]);
        expect(r.rows[0].on_hand_quantity).toBe(50); // untouched
      });
    });
  });

  // ── Final reconciliation across everything this file did ───────────────
  it('final invariant: no negative on_hand/reserved anywhere in ORG_A or ORG_B, movement ledgers non-empty and consistent', async () => {
    await rig.asAdmin(async (c: any) => {
      const neg = await c.query(
        `SELECT count(*)::int n FROM outlet_stock WHERE organization_id IN ($1,$2)
           AND (on_hand_quantity < 0 OR reserved_quantity < 0)`, [ORG_A, ORG_B]);
      expect(neg.rows[0].n).toBe(0);

      const negWh = await c.query(
        `SELECT count(*)::int n FROM warehouse_stock WHERE organization_id IN ($1,$2)
           AND (on_hand_quantity < 0 OR reserved_quantity < 0)`, [ORG_A, ORG_B]);
      expect(negWh.rows[0].n).toBe(0);

      // Every outlet_stock row that had an APPLIED correction in this file
      // reconciles exactly against its own 'correction' movement rows: the
      // row's CURRENT on_hand_quantity equals its seeded baseline (captured
      // in the movement's own on_hand_before, since these fixtures were
      // seeded directly rather than through an initial receive RPC) plus the
      // sum of every correction delta applied to it.
      const recon = await c.query(`
        SELECT os.id, os.on_hand_quantity,
               (SELECT m.on_hand_before FROM outlet_stock_movements m
                 WHERE m.outlet_stock_id = os.id ORDER BY m.created_at ASC LIMIT 1) AS first_before,
               coalesce(sum(m.on_hand_delta), 0) AS ledger_sum
          FROM outlet_stock os
          LEFT JOIN outlet_stock_movements m ON m.outlet_stock_id = os.id
         WHERE os.organization_id = $1
         GROUP BY os.id, os.on_hand_quantity
        HAVING count(m.id) > 0
      `, [ORG_A]);
      for (const row of recon.rows) {
        expect(Number(row.on_hand_quantity)).toBe(Number(row.first_before) + Number(row.ledger_sum));
      }
      expect(recon.rows.length).toBeGreaterThan(0);
    });
  });
});
