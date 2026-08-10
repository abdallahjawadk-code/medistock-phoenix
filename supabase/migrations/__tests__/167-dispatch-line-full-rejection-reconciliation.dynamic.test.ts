/**
 * 167 · DISPATCH-LINE FULL-REJECTION RECONCILIATION — dynamic proof.
 *
 * Builds a disposable Postgres through 001->167 and drives the REAL RPC chain
 * exactly as the frontend would (central receive -> routed transfer ->
 * dispatch create -> add line -> send -> outlet receive), then proves that a
 * FULL REJECTION now completes end to end.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS EVIDENCE OF
 * ─────────────────────────────────────────────────────────────────────────────
 * Before 167, EVERY zero-quantity receipt aborted with
 *   new row for relation "warehouse_dispatch_lines"
 *   violates check constraint "warehouse_dispatch_lines_decision_chk"
 * because the writer stores received_quantity = 0 (070:443-447, carried into
 * 131:257-261, renamed at 149:1763) while 061:746's decision CHECK required
 * received_quantity IS NULL for status 'rejected'. Full rejection of a warehouse
 * dispatch line was impossible for the entire life of the corridor.
 *
 * The two assertions that matter most are:
 *   • `a full rejection completes` — the call that used to be unreachable.
 *   • `an all-rejected dispatch recomputes its header to rejected` — proof the
 *     terminal state is genuinely reachable through the real recompute
 *     (070:194-207), not just that one row now updates.
 *
 * The rest is the guard rail: 167 moved which received_quantity a rejected line
 * may hold, so the file also proves the NEW value is required, the OLD one is
 * now REFUSED (including via the three-valued-logic route a bare `= 0` would
 * leave open), and every unrelated decision path is unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOLLOW-UP FOR WHOEVER MERGES STAGE E's MIGRATION 166
 * ─────────────────────────────────────────────────────────────────────────────
 * 166's dynamic suite (166-initial-provisioning-invariant.dynamic.test.ts,
 * authored on its own branch) documents this defect and works AROUND it in two
 * places, because on canonical master the rejection path could not commit:
 *
 *   • rule D proves "a rejected lifecycle frees the outlet" by UPDATE-ing the
 *     header to 'rejected' directly, and carries a companion test asserting the
 *     zero-quantity receive is blocked by warehouse_dispatch_lines_decision_chk.
 *     With 167 applied that block is gone: rule D can now drive the real RPC,
 *     and the "is blocked by a baseline constraint" test must be REPLACED (it
 *     will fail — the call now succeeds, which is the point).
 *   • rule F notes that a genuine "one accepted + one rejected" header cannot be
 *     produced end to end. It now can — `a mixed outcome stays
 *     partially_accepted` in section 2 below produces exactly that shape.
 *
 * Neither change belongs in this file: 166 is not in this branch. They are the
 * first thing to do when the two branches meet.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 120000 });

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000167001';
const ORG_INST = '00000000-0000-0000-0000-000000167002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000167101';
const WH_INST = '00000000-0000-0000-0000-000000167102';
const ROUTE = '00000000-0000-0000-0000-000000167501';

/** One destination outlet per scenario, so no test can mask another. */
const DP = {
  FULL: '00000000-0000-0000-0000-000000167301',
  HEADER: '00000000-0000-0000-0000-000000167302',
  MIXED: '00000000-0000-0000-0000-000000167303',
  REPLAY: '00000000-0000-0000-0000-000000167304',
  NEGATIVE: '00000000-0000-0000-0000-000000167305',
  CONSTRAINT: '00000000-0000-0000-0000-000000167306',
  ACCEPT: '00000000-0000-0000-0000-000000167307',
  DIFF: '00000000-0000-0000-0000-000000167308',
  AUDIT: '00000000-0000-0000-0000-000000167309',
  RETURN: '00000000-0000-0000-0000-000000167310',
  CANCEL: '00000000-0000-0000-0000-000000167311',
  // POST-E4-SYNC: combined 166 (initial-provisioning invariant) + 167
  // (full-rejection reconciliation) interaction proof. One outlet per case,
  // same isolation discipline as every entry above.
  INIT_REJECT: '00000000-0000-0000-0000-000000167312',
  INIT_RECEIPT: '00000000-0000-0000-0000-000000167313',
};

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

run('167 · dispatch-line full-rejection reconciliation (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c
      .query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  /** Move real stock into the institution warehouse via the real corridor. */
  async function provisionInstitutionStock(tag: string, qty: number): Promise<string> {
    return rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
          randomUUID(), WH_CENTRAL, `P167-${tag}`, qty, true, true, 0,
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

  const createDispatch = (dp: string, tag: string) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) => call(c, 'phoenix_create_warehouse_dispatch', [WH_INST, dp, uniq(tag), null, null, null]),
      { commit: true },
    );

  /** 166's one-shot creator — flags the dispatch is_initial_provisioning=true. */
  const createInitialProvisioningDispatch = (dp: string, tag: string) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) =>
        call(c, 'phoenix_create_initial_provisioning_dispatch', [WH_INST, dp, uniq(tag), null, null, null]),
      { commit: true },
    );

  /** Add one line per quantity, then SEND. Returns line ids ordered by quantity. */
  async function addLinesAndSend(dispatchId: string, stockId: string, qtys: number[]): Promise<string[]> {
    return rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        for (const q of qtys) await call(c, 'phoenix_add_dispatch_line', [dispatchId, stockId, q]);
        await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
        const r = await c.query(
          `SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1 ORDER BY sent_quantity, id`,
          [dispatchId],
        );
        return r.rows.map((x: any) => x.id as string);
      },
      { commit: true },
    );
  }

  /**
   * 131 requires BOTH a free-text difference reason and a closed-vocabulary
   * reason_code whenever the received quantity differs from what was sent
   * (131:211-216) — a full rejection (qty 0) always does. Supplying both is the
   * real contract, not a workaround; 'damaged' is a member of the 131:141-144
   * dispatch-receive vocabulary.
   */
  const receive = (
    lineId: string,
    qty: number,
    opts: { sentQty?: number; reason?: string | null; code?: string | null; requestId?: string } = {},
  ) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) => {
        const differs = opts.sentQty === undefined ? qty === 0 : qty !== opts.sentQty;
        return call(c, 'phoenix_receive_outlet_dispatch_line', [
          opts.requestId ?? randomUUID(),
          lineId,
          qty,
          opts.reason !== undefined ? opts.reason : differs ? '167 probe: consignment refused on arrival' : null,
          null,
          opts.code !== undefined ? opts.code : differs ? 'damaged' : null,
        ]);
      },
      { commit: true },
    );

  const line = (lineId: string) =>
    rig
      .asAdmin((c: any) =>
        c.query(
          `SELECT status, sent_quantity, received_quantity, returned_quantity, rejection_reason,
                  difference_reason, rejected_by, rejected_at, accepted_by, accepted_at,
                  resulting_item_availability_id, resulting_movement_id, resulting_outlet_stock_id
             FROM warehouse_dispatch_lines WHERE id=$1`,
          [lineId],
        ),
      )
      .then((r: any) => r.rows[0]);

  const header = (dispatchId: string) =>
    rig
      .asAdmin((c: any) => c.query(`SELECT status FROM warehouse_dispatches WHERE id=$1`, [dispatchId]))
      .then((r: any) => r.rows[0].status as string);

  /** A sent one-line dispatch ready to be decided. */
  async function sentLine(dp: string, tag: string, qty = 6) {
    const stock = await provisionInstitutionStock(tag, qty);
    const created = await createDispatch(dp, tag);
    const ids = await addLinesAndSend(created.dispatch_id, stock, [qty]);
    return { dispatchId: created.dispatch_id as string, lineId: ids[0], stock, qty };
  }

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_CENTRAL}','C167','مركز','p167-c','pharmacy_department_authority',NULL),
        ('${ORG_INST}','I167','مؤسسة','p167-i','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH167','مخزنC','active','central','p167-wc'),
        ('${WH_INST}','${ORG_INST}','IWH167','مخزنI','active','institution','p167-wi')
        ON CONFLICT (id) DO NOTHING;`);

      const values = Object.entries(DP)
        .map(([k, id]) => `('${id}','${WH_INST}','${ORG_INST}','Outlet ${k}','منفذ','crash_cabinet','active')`)
        .join(',');
      await c.query(`INSERT INTO distribution_points
        (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ${values} ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true)
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 300000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. THE DEFECT IS FIXED — the call that was previously impossible
  // ══════════════════════════════════════════════════════════════════════════

  describe('1. a full rejection completes end to end', () => {
    it('the RPC succeeds and reports the line rejected, delivering nothing', async () => {
      const { lineId } = await sentLine(DP.FULL, 'FULL');

      // On canonical master this threw
      // 'violates check constraint "warehouse_dispatch_lines_decision_chk"'.
      const res: any = await receive(lineId, 0);

      expect(res.ok).toBe(true);
      expect(res.line_status).toBe('rejected');
      expect(res.idempotent_replay).toBe(false);
      // Nothing was delivered: no outlet stock row, no movement, no balance change.
      expect(res.outlet_stock_id).toBeNull();
      expect(res.movement_id).toBeNull();
      expect(res.quantity_before).toBe(0);
      expect(res.quantity_delta).toBe(0);
      expect(res.quantity_after).toBe(0);
    });

    it('the row records the decision: 0 received, a reason, a timestamp, an actor', async () => {
      const { lineId, qty } = await sentLine(DP.CONSTRAINT, 'ROW');
      await receive(lineId, 0);

      const l = await line(lineId);
      expect(l.status).toBe('rejected');
      expect(l.sent_quantity).toBe(qty);
      // The whole point: 0, not NULL. "We decided, and the answer was none" —
      // distinct from pending/cancelled, which use NULL for "never decided".
      expect(l.received_quantity).toBe(0);
      expect(l.rejection_reason).toBe('167 probe: consignment refused on arrival');
      expect(l.rejected_at).not.toBeNull();
      expect(l.rejected_by).toBe(rig.superAdminId);
      // A rejection is not an acceptance and carries no result links.
      expect(l.accepted_by).toBeNull();
      expect(l.accepted_at).toBeNull();
      expect(l.difference_reason).toBeNull();
      expect(l.resulting_item_availability_id).toBeNull();
      expect(l.resulting_movement_id).toBeNull();
    });

    it('creates no outlet stock and no movement for the refused consignment', async () => {
      const { lineId, dispatchId } = await sentLine(DP.NEGATIVE, 'NOSTOCK');
      await receive(lineId, 0);

      await rig.asAdmin(async (c: any) => {
        const stock = await c.query(
          `SELECT count(*)::int AS n FROM outlet_stock WHERE distribution_point_id=$1`,
          [DP.NEGATIVE],
        );
        expect(stock.rows[0].n).toBe(0);

        const mv = await c.query(
          `SELECT count(*)::int AS n FROM outlet_stock_movements WHERE distribution_point_id=$1`,
          [DP.NEGATIVE],
        );
        expect(mv.rows[0].n).toBe(0);

        // And the dispatch itself is terminal-rejected, holding no stock link.
        const d = await c.query(`SELECT status FROM warehouse_dispatches WHERE id=$1`, [dispatchId]);
        expect(d.rows[0].status).toBe('rejected');
      });
    });

    it('writes the audit record the corridor promises', async () => {
      const { lineId } = await sentLine(DP.AUDIT, 'AUDIT');
      await receive(lineId, 0);

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT action, entity_type, actor_id, payload
             FROM audit_logs WHERE entity_id=$1 AND action='outlet_stock.dispatch_rejected'`,
          [lineId],
        );
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0].entity_type).toBe('warehouse_dispatch_lines');
        expect(r.rows[0].actor_id).toBe(rig.superAdminId);
        expect(r.rows[0].payload.received_quantity).toBe(0);
        expect(r.rows[0].payload.reason).toBe('167 probe: consignment refused on arrival');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. THE HEADER REACHES ITS TERMINAL STATE
  // ══════════════════════════════════════════════════════════════════════════

  describe('2. the header recomputes correctly once rejection can commit', () => {
    it('an all-rejected dispatch recomputes its header to rejected', async () => {
      const stock = await provisionInstitutionStock('HDR', 9);
      const created = await createDispatch(DP.HEADER, 'HDR');
      const ids = await addLinesAndSend(created.dispatch_id, stock, [4, 5]);

      expect(await header(created.dispatch_id)).toBe('sent');

      // First of two decided -> some still open.
      await receive(ids[0], 0);
      expect(await header(created.dispatch_id)).toBe('partially_accepted');

      // Both decided, both rejected -> terminal 'rejected' (070:205).
      await receive(ids[1], 0);
      expect(await header(created.dispatch_id)).toBe('rejected');

      for (const id of ids) {
        const l = await line(id);
        expect(l.status).toBe('rejected');
        expect(l.received_quantity).toBe(0);
      }
    });

    it('a mixed outcome stays partially_accepted, with each line telling its own story', async () => {
      const stock = await provisionInstitutionStock('MIX', 11);
      const created = await createDispatch(DP.MIXED, 'MIX');
      const ids = await addLinesAndSend(created.dispatch_id, stock, [4, 7]);

      await receive(ids[0], 0); // refused outright
      await receive(ids[1], 7); // accepted in full

      // 070:206 — all decided, but a mix.
      expect(await header(created.dispatch_id)).toBe('partially_accepted');

      const refused = await line(ids[0]);
      expect(refused.status).toBe('rejected');
      expect(refused.received_quantity).toBe(0);
      // A rejection links to nothing — which is also what the constraint's
      // rejected branch requires.
      expect(refused.resulting_outlet_stock_id).toBeNull();
      expect(refused.resulting_item_availability_id).toBeNull();
      expect(refused.resulting_movement_id).toBeNull();

      const accepted = await line(ids[1]);
      expect(accepted.status).toBe('accepted');
      expect(accepted.received_quantity).toBe(7);
      // The accepted line DID deliver, so it carries the result links the writer
      // actually populates (131:381-383): the outlet stock row and the
      // availability projection. Note resulting_movement_id is NOT among them —
      // no generation of this writer has ever set it, and 167 does not change
      // that; the movement id is returned in the RPC payload instead.
      expect(accepted.resulting_outlet_stock_id).not.toBeNull();
      expect(accepted.resulting_item_availability_id).not.toBeNull();
      expect(accepted.accepted_at).not.toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. THE CONSTRAINT MOVED — it did not merely loosen
  // ══════════════════════════════════════════════════════════════════════════

  describe('3. the reconciled constraint requires 0 and refuses NULL', () => {
    it('is installed with the IS NOT NULL guard on the rejected branch', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname='warehouse_dispatch_lines_decision_chk'`,
        );
        expect(r.rows).toHaveLength(1);
        const def: string = r.rows[0].def;
        expect(def).toContain('(received_quantity IS NOT NULL) AND (received_quantity = 0)');
        // Exactly two branches still require IS NULL: pending and cancelled.
        expect(def.match(/received_quantity IS NULL/g) ?? []).toHaveLength(2);
      });
    });

    /**
     * The three-valued-logic hole, tested directly. A CHECK rejects a row only
     * when its predicate is FALSE — NULL PASSES. Written as a bare
     * `received_quantity = 0`, a NULL quantity would make the comparison NULL,
     * the AND-chain NULL, and the row would be silently ACCEPTED, leaving the
     * branch admitting BOTH NULL and 0. This asserts the guard closes that.
     */
    it('a rejected row with a NULL received_quantity is refused outright', async () => {
      const { lineId } = await sentLine(DP.CANCEL, 'NULLQTY');
      await receive(lineId, 0);

      const msg = await rejects(() =>
        rig.asAdmin((c: any) =>
          c.query(`UPDATE warehouse_dispatch_lines SET received_quantity = NULL WHERE id=$1`, [lineId]),
        ),
      );
      expect(msg).toMatch(/warehouse_dispatch_lines_decision_chk/);

      // Untouched by the refused write.
      expect((await line(lineId)).received_quantity).toBe(0);
    });

    it('a rejected row still cannot carry a blank reason or a positive quantity', async () => {
      const { lineId } = await sentLine(DP.ACCEPT, 'GUARDS');
      await receive(lineId, 0);

      for (const [sql, params] of [
        [`UPDATE warehouse_dispatch_lines SET rejection_reason = '   ' WHERE id=$1`, [lineId]],
        [`UPDATE warehouse_dispatch_lines SET received_quantity = 1 WHERE id=$1`, [lineId]],
        [`UPDATE warehouse_dispatch_lines SET rejected_at = NULL WHERE id=$1`, [lineId]],
        [`UPDATE warehouse_dispatch_lines SET accepted_at = now() WHERE id=$1`, [lineId]],
        [`UPDATE warehouse_dispatch_lines SET difference_reason = 'x' WHERE id=$1`, [lineId]],
      ] as const) {
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(sql, params as any)));
        expect(msg, `expected refusal for: ${sql}`).toMatch(/warehouse_dispatch_lines_decision_chk/);
      }
    });

    it('the retention contract holds: the deciding actor stays deletable', async () => {
      // 061's whole reason for dropping `rejected_by IS NOT NULL`: SET NULL from
      // an auth-user deletion must not violate the CHECK. Now that a rejected row
      // can actually EXIST, that is finally testable against a real one.
      const { lineId } = await sentLine(DP.RETURN, 'RETENTION');
      await receive(lineId, 0);
      expect((await line(lineId)).rejected_by).toBe(rig.superAdminId);

      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          await c.query(`UPDATE warehouse_dispatch_lines SET rejected_by = NULL WHERE id=$1`, [lineId]);
          const r = await c.query(
            `SELECT status, received_quantity, rejected_by FROM warehouse_dispatch_lines WHERE id=$1`,
            [lineId],
          );
          expect(r.rows[0].rejected_by).toBeNull();
          expect(r.rows[0].status).toBe('rejected');
          expect(r.rows[0].received_quantity).toBe(0);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. NOTHING ELSE MOVED
  // ══════════════════════════════════════════════════════════════════════════

  describe('4. every other decision path is unchanged', () => {
    it('a full acceptance still delivers stock and requires received = sent', async () => {
      const { lineId, dispatchId, qty } = await sentLine(DP.DIFF, 'ACCEPT');
      const res: any = await receive(lineId, qty);

      expect(res.line_status).toBe('accepted');
      expect(res.outlet_stock_id).not.toBeNull();
      expect(res.movement_id).not.toBeNull();
      expect(res.quantity_after).toBe(qty);
      expect(await header(dispatchId)).toBe('accepted');

      const l = await line(lineId);
      expect(l.received_quantity).toBe(qty);
      expect(l.rejection_reason).toBeNull();
      expect(l.rejected_at).toBeNull();
    });

    it('a partial acceptance still needs a reason and a reason code', async () => {
      const { lineId, qty } = await sentLine(DP.REPLAY, 'PARTIAL', 8);

      // Reason missing.
      expect(
        await rejects(() => receive(lineId, 5, { sentQty: qty, reason: null, code: 'damaged' })),
      ).toMatch(/difference_reason_required/);
      // Reason code missing.
      expect(
        await rejects(() => receive(lineId, 5, { sentQty: qty, reason: 'short', code: null })),
      ).toMatch(/difference_reason_code_required/);

      const ok: any = await receive(lineId, 5, { sentQty: qty, reason: '3 units short', code: 'shipment_error' });
      expect(ok.line_status).toBe('accepted_with_difference');
      const l = await line(lineId);
      expect(l.received_quantity).toBe(5);
      expect(l.difference_reason).toBe('3 units short');
      expect(l.rejection_reason).toBeNull();
    });

    it('a rejection still requires its own reason and a valid reason code', async () => {
      const a = await sentLine(DP.FULL, 'NOREASON');
      expect(await rejects(() => receive(a.lineId, 0, { reason: null }))).toMatch(
        /difference_reason_required/,
      );

      const b = await sentLine(DP.FULL, 'NOCODE');
      expect(await rejects(() => receive(b.lineId, 0, { code: null }))).toMatch(
        /difference_reason_code_required/,
      );

      const c = await sentLine(DP.FULL, 'BADCODE');
      expect(await rejects(() => receive(c.lineId, 0, { code: 'not_a_real_code' }))).toMatch(
        /invalid_outlet_dispatch_receive_reason_code/,
      );

      // All three refusals left the lines pending — no half-written rejection.
      for (const s of [a, b, c]) expect((await line(s.lineId)).status).toBe('pending');
    });

    it('a rejected line cannot be decided again', async () => {
      // TWO lines, so the header stays 'partially_accepted' and the call gets as
      // far as the LINE check. On a one-line dispatch the header would already be
      // terminal 'rejected' and the guard that fires first is
      // dispatch_not_receivable (131:202) — proven in the next test.
      const stock = await provisionInstitutionStock('TWICE', 7);
      const created = await createDispatch(DP.CANCEL, 'TWICE');
      const ids = await addLinesAndSend(created.dispatch_id, stock, [3, 4]);

      await receive(ids[0], 0);
      expect(await header(created.dispatch_id)).toBe('partially_accepted');

      expect(await rejects(() => receive(ids[0], 0))).toMatch(/dispatch_line_already_decided/);
      // The refused retry changed nothing.
      const l = await line(ids[0]);
      expect(l.status).toBe('rejected');
      expect(l.received_quantity).toBe(0);
    });

    /**
     * A PRE-EXISTING LIMITATION, newly observable and deliberately NOT fixed here.
     *
     * 131's idempotency replay is keyed on an outlet_stock_movements row whose
     * reference_id is the request_id (131:165-182). A rejection creates NO
     * movement — that is the whole point of "delivered nothing" — so a rejection
     * never lands in that ledger and can never be replayed. Re-calling with the
     * same request_id therefore falls through to the ordinary guards instead of
     * returning idempotent_replay: true.
     *
     * This is independent of 167. The constraint reconciliation is what finally
     * lets a rejection commit at all, which is why the gap is visible now; making
     * rejections replayable would mean changing the writer's ledger strategy
     * (a 106-style dedup row, as 156/157 use), which is a separate change with
     * its own design decision. Asserted here as the ACTUAL behaviour so the
     * limitation is recorded rather than discovered again later.
     */
    it('a rejection is not entered in the movement-keyed replay ledger', async () => {
      const { lineId, dispatchId } = await sentLine(DP.MIXED, 'REPLAY');
      const reqId = randomUUID();

      const first: any = await receive(lineId, 0, { requestId: reqId });
      expect(first.idempotent_replay).toBe(false);
      expect(first.line_status).toBe('rejected');

      // No movement row carries this request_id, so there is nothing to replay.
      await rig.asAdmin(async (c: any) => {
        const mv = await c.query(
          `SELECT count(*)::int AS n FROM outlet_stock_movements
            WHERE reference_type='outlet_request' AND reference_id=$1`,
          [reqId],
        );
        expect(mv.rows[0].n).toBe(0);
      });

      // One-line dispatch -> header is terminal 'rejected', so the dispatch guard
      // fires before the line guard.
      expect(await header(dispatchId)).toBe('rejected');
      expect(await rejects(() => receive(lineId, 0, { requestId: reqId }))).toMatch(
        /dispatch_not_receivable/,
      );

      // Crucially: the failed retry did NOT double-write anything.
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE entity_id=$1 AND action='outlet_stock.dispatch_rejected'`,
          [lineId],
        );
        expect(r.rows[0].n).toBe(1);
      });
      const l = await line(lineId);
      expect(l.status).toBe('rejected');
      expect(l.received_quantity).toBe(0);
    });

    it('nothing can be returned from a refused consignment', async () => {
      // 071:212's wdl_returned_qty_chk caps returns at
      // COALESCE(received_quantity, 0) - returned_quantity. A rejected line's cap
      // is 0 either way, which is why storing 0 changes no reader's behaviour.
      const { lineId } = await sentLine(DP.AUDIT, 'RETURNCAP');
      await receive(lineId, 0);

      const l = await line(lineId);
      expect(l.received_quantity).toBe(0);
      expect(l.returned_quantity).toBe(0);

      const msg = await rejects(() =>
        rig.asAdmin((c: any) =>
          c.query(`UPDATE warehouse_dispatch_lines SET returned_quantity = 1 WHERE id=$1`, [lineId]),
        ),
      );
      expect(msg).toMatch(/wdl_returned_qty_chk/);
    });

    it('the sibling corridors still require received_quantity = 0 on rejection', async () => {
      // The parity 167 was chosen for. If either moves, 167's rationale needs
      // revisiting — so it is asserted here rather than assumed.
      await rig.asAdmin(async (c: any) => {
        for (const name of ['wrsl_decision_chk', 'orsl_decision_chk']) {
          const r = await c.query(
            `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname=$1`,
            [name],
          );
          expect(r.rows, `${name} must exist`).toHaveLength(1);
          expect(r.rows[0].def).toContain('received_quantity = 0');
        }
      });
    });

    it('167 left the receive writer itself untouched', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_functiondef(p.oid) AS def
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = '_phoenix_149_delegate_receive_outlet_dispatch_line'`,
        );
        expect(r.rows).toHaveLength(1);
        // Still the 070/131 body: it stores 0, which is now legal.
        expect(r.rows[0].def).toContain("SET status = 'rejected', received_quantity = 0");
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. COMBINED WITH E-4 INITIAL PROVISIONING (166 + 167 INTERACTION) —
  //    POST-SYNC PROOF. Neither migration's own single-migration suite drives
  //    the REAL 166 creator through the REAL 167-reconciled receive RPC in one
  //    effective state; this does. Both cases use the real RPC path only.
  // ══════════════════════════════════════════════════════════════════════════

  describe('5. combined with E-4 initial provisioning (166 + 167 interaction)', () => {
    const provisioningState = (dispatchId: string) =>
      rig
        .asAdmin((c: any) =>
          c.query(
            `SELECT status, is_initial_provisioning, initial_provisioning_consumed_at
               FROM warehouse_dispatches WHERE id=$1`,
            [dispatchId],
          ),
        )
        .then((r: any) => r.rows[0]);

    // ── CASE A — initial provisioning followed by FULL REJECTION ───────────
    it('a fully rejected initial-provisioning lifecycle delivers nothing and does NOT consume the one-shot entitlement', async () => {
      const stock = await provisionInstitutionStock('IPREJ', 5);
      const created = await createInitialProvisioningDispatch(DP.INIT_REJECT, 'IPREJ');
      expect(created.is_initial_provisioning).toBe(true);
      const [lineId] = await addLinesAndSend(created.dispatch_id, stock, [5]);

      // The RPC succeeds — no 23514, no violates check constraint.
      const res: any = await receive(lineId, 0);
      expect(res.ok).toBe(true);
      expect(res.line_status).toBe('rejected');
      expect(res.outlet_stock_id).toBeNull();
      expect(res.movement_id).toBeNull();
      expect(res.quantity_after).toBe(0);

      const l = await line(lineId);
      expect(l.status).toBe('rejected');
      expect(l.received_quantity).toBe(0);
      expect(l.rejection_reason).not.toBeNull();

      // 166's flag survives; consumption was never stamped — nothing arrived.
      const d = await provisioningState(created.dispatch_id);
      expect(d.is_initial_provisioning).toBe(true);
      expect(d.initial_provisioning_consumed_at).toBeNull();
      expect(d.status).toBe('rejected');

      // No delivered stock and no phantom/orphan movement for the refused
      // consignment — identical to the ordinary-dispatch proof in section 1,
      // now proven with an initial-provisioning-flagged header too.
      await rig.asAdmin(async (c: any) => {
        const stockRow = await c.query(
          `SELECT count(*)::int AS n FROM outlet_stock WHERE distribution_point_id=$1`,
          [DP.INIT_REJECT],
        );
        expect(stockRow.rows[0].n).toBe(0);
        const mv = await c.query(
          `SELECT count(*)::int AS n FROM outlet_stock_movements WHERE distribution_point_id=$1`,
          [DP.INIT_REJECT],
        );
        expect(mv.rows[0].n).toBe(0);

        // Both audit trails exist: 166's creation record and 167's rejection
        // record, each exactly once.
        const created166 = await c.query(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE entity_id=$1 AND action='warehouse_dispatch.initial_provisioning_created'`,
          [created.dispatch_id],
        );
        expect(created166.rows[0].n).toBe(1);
        const rejected167 = await c.query(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE entity_id=$1 AND action='outlet_stock.dispatch_rejected'`,
          [lineId],
        );
        expect(rejected167.rows[0].n).toBe(1);
      });

      // A lifecycle that delivered NOTHING did not consume the entitlement —
      // a second initial-provisioning lifecycle for the SAME outlet succeeds.
      const second = await createInitialProvisioningDispatch(DP.INIT_REJECT, 'IPREJ2');
      expect(second.ok).toBe(true);
      expect(second.dispatch_id).not.toBe(created.dispatch_id);
    });

    // ── CASE B — initial provisioning with ACTUAL RECEIPT ───────────────────
    it('an accepted initial-provisioning lifecycle consumes the entitlement and blocks a second one', async () => {
      const stock = await provisionInstitutionStock('IPRCV', 6);
      const created = await createInitialProvisioningDispatch(DP.INIT_RECEIPT, 'IPRCV');
      const [lineId] = await addLinesAndSend(created.dispatch_id, stock, [6]);

      const res: any = await receive(lineId, 6);
      expect(res.ok).toBe(true);
      expect(res.line_status).toBe('accepted');
      expect(res.outlet_stock_id).not.toBeNull();
      expect(res.movement_id).not.toBeNull();
      expect(res.quantity_after).toBe(6);

      const d = await provisioningState(created.dispatch_id);
      expect(d.is_initial_provisioning).toBe(true);
      expect(d.initial_provisioning_consumed_at).not.toBeNull();
      expect(d.status).toBe('accepted');

      // Canonical stock/movement conservation for the delivered quantity.
      await rig.asAdmin(async (c: any) => {
        const stockRow = await c.query(
          `SELECT on_hand_quantity FROM outlet_stock WHERE distribution_point_id=$1`,
          [DP.INIT_RECEIPT],
        );
        expect(stockRow.rows).toHaveLength(1);
        expect(stockRow.rows[0].on_hand_quantity).toBe(6);
        const mv = await c.query(
          `SELECT count(*)::int AS n FROM outlet_stock_movements WHERE distribution_point_id=$1`,
          [DP.INIT_RECEIPT],
        );
        expect(mv.rows[0].n).toBe(1);
      });

      // 166's one-shot rule (rule A / the partial unique index) still refuses
      // a second lifecycle for the same outlet, proving 167 repaired
      // rejection without weakening 166's invariant in the combined state.
      await expect(
        createInitialProvisioningDispatch(DP.INIT_RECEIPT, 'IPRCV2'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('initial_provisioning_already_exists_for_outlet'),
      });
    });
  });
});
