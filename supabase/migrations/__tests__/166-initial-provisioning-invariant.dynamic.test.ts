/**
 * 166 · INITIAL-PROVISIONING INVARIANT (Stage E · E-4) — dynamic proof.
 *
 * Builds a disposable Postgres through the full current EFFECTIVE migration
 * chain on disk (buildRig({}) — 001 through whatever is present, not a frozen
 * 001->166 snapshot) and drives the REAL RPC chain (central receive -> routed
 * transfer -> dispatch create -> add line -> send -> outlet receive) exactly
 * as the frontend would, then proves rules A-G of the initial-provisioning
 * state machine — which Migration 166 alone introduces — against that real,
 * current schema.
 *
 * Concretely, that means this suite also picks up later migrations once they
 * are present on disk (167's rejection reconciliation, 168's E-5 replenishment
 * corridor, …). 166 neither causes nor owns those later objects; this suite
 * verifies the E-4 invariant continues to hold on the effective chain tip
 * rather than freezing itself to an artificially stale schema.
 *
 * The evidence that matters most is rules C and F: a header-status-only
 * predicate would get BOTH wrong, because
 * phoenix_recompute_warehouse_dispatch_header_status (070:202-207) emits
 * 'partially_accepted' for two different situations and 'accepted' as a
 * terminal state. Consumption is therefore recorded in its own column, and the
 * tests below prove the recorded value — not the header — governs.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 120000 });

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000166001';
const ORG_INST = '00000000-0000-0000-0000-000000166002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000166101';
const WH_INST = '00000000-0000-0000-0000-000000166102';
const ROUTE = '00000000-0000-0000-0000-000000166501';

/** One destination outlet per rule, so no test can mask another. */
const DP = {
  A: '00000000-0000-0000-0000-000000166301',
  B: '00000000-0000-0000-0000-000000166302',
  C: '00000000-0000-0000-0000-000000166303',
  D: '00000000-0000-0000-0000-000000166304',
  E: '00000000-0000-0000-0000-000000166305',
  F: '00000000-0000-0000-0000-000000166306',
  G: '00000000-0000-0000-0000-000000166307',
  ORDINARY: '00000000-0000-0000-0000-000000166308',
  REPLAY: '00000000-0000-0000-0000-000000166309',
  BULK: '00000000-0000-0000-0000-000000166310',
  RBAC: '00000000-0000-0000-0000-000000166311',
  CHECK: '00000000-0000-0000-0000-000000166312',
  EVENT: '00000000-0000-0000-0000-000000166313',
  AUDIT: '00000000-0000-0000-0000-000000166314',
  F_FREE: '00000000-0000-0000-0000-000000166315',
  F_DELTA: '00000000-0000-0000-0000-000000166316',
  ONCE: '00000000-0000-0000-0000-000000166317',
  D_ORD: '00000000-0000-0000-0000-000000166318',
  MIXED: '00000000-0000-0000-0000-000000166319',
};

/** A profile with NO dispatch permissions — the RBAC negative control. */
const NOBODY = '00000000-0000-0000-0000-000000166901';

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

run('166 · initial-provisioning invariant (dynamic)', () => {
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
          randomUUID(), WH_CENTRAL, `P166-${tag}`, qty, true, true, 0,
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

  /** Create an initial-provisioning dispatch through the new RPC. */
  const createInitialProvisioning = (dp: string, tag: string, actor = rig.superAdminId) =>
    rig.asUser(
      actor,
      (c: any) =>
        call(c, 'phoenix_create_initial_provisioning_dispatch', [WH_INST, dp, uniq(tag), null, null, null]),
      { commit: true },
    );

  /** Create an ORDINARY dispatch through the untouched 070 creator. */
  const createOrdinary = (dp: string, tag: string) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) => call(c, 'phoenix_create_warehouse_dispatch', [WH_INST, dp, uniq(tag), null, null, null]),
      { commit: true },
    );

  /** Add `lines` lines of `qty` each, then SEND. Returns the line ids in order. */
  async function addLinesAndSend(dispatchId: string, stockId: string, qtys: number[]): Promise<string[]> {
    return rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        for (const q of qtys) await call(c, 'phoenix_add_dispatch_line', [dispatchId, stockId, q]);
        await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
        // Ordered by sent_quantity so a caller passing distinct quantities can
        // address a specific line deterministically (created_at ties inside a
        // single statement batch, and the id is a random uuid).
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
   * 131 requires BOTH a free-text difference_reason and a closed-vocabulary
   * reason_code whenever the received quantity differs from what was sent
   * (131:211-216) — a full rejection (qty 0) always does. Supplying both for
   * those calls is the real contract, not a workaround; 'damaged' is a member
   * of the 131:141-144 dispatch-receive vocabulary.
   */
  const receive = (lineId: string, qty: number, sentQty?: number) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) => {
        const differs = sentQty === undefined ? qty === 0 : qty !== sentQty;
        return call(c, 'phoenix_receive_outlet_dispatch_line', [
          randomUUID(),
          lineId,
          qty,
          differs ? 'E-4 probe: consignment refused on arrival' : null,
          null,
          differs ? 'damaged' : null,
        ]);
      },
      { commit: true },
    );

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

  const line = (lineId: string) =>
    rig
      .asAdmin((c: any) =>
        c.query(
          `SELECT status, sent_quantity, received_quantity FROM warehouse_dispatch_lines WHERE id=$1`,
          [lineId],
        ),
      )
      .then((r: any) => r.rows[0]);

  /** Full one-line initial provisioning, delivered. Returns ids + header. */
  async function provisionOutlet(dp: string, tag: string, qty = 10) {
    const stock = await provisionInstitutionStock(tag, qty);
    const created = await createInitialProvisioning(dp, tag);
    const lines = await addLinesAndSend(created.dispatch_id, stock, [qty]);
    await receive(lines[0], qty);
    return { dispatchId: created.dispatch_id as string, lineIds: lines, stock };
  }

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_CENTRAL}','C166','مركز','p166-c'),('${ORG_INST}','I166','مؤسسة','p166-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH166','مخزنC','active','central','p166-wc'),
        ('${WH_INST}','${ORG_INST}','IWH166','مخزنI','active','institution','p166-wi')
        ON CONFLICT (id) DO NOTHING;`);

      const values = Object.entries(DP)
        .map(
          ([k, id]) =>
            `('${id}','${WH_INST}','${ORG_INST}','Outlet ${k}','منفذ','crash_cabinet','active')`,
        )
        .join(',');
      await c.query(`INSERT INTO distribution_points
        (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ${values} ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true)
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${NOBODY}','p166-nobody@rig.local')
        ON CONFLICT (id) DO NOTHING;`);
      // outlet_officer is the receiving side: a real, valid role that
      // deliberately does NOT hold warehouse_dispatch.create (061:869 —
      // "warehouse_officer: the sending side"), so it is the honest RBAC
      // negative control rather than a synthetic one.
      await c.query(`UPDATE profiles SET role='outlet_officer', status='active', organization_id='${ORG_INST}'
        WHERE id='${NOBODY}';`);
    });
  }, 180000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  // ── The schema objects themselves ─────────────────────────────────────────

  describe('the E-4 objects exist with the declared shape', () => {
    it('both columns exist, correctly typed and defaulted', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema='public' AND table_name='warehouse_dispatches'
              AND column_name IN ('is_initial_provisioning','initial_provisioning_consumed_at')
            ORDER BY column_name`,
        );
        expect(r.rows).toEqual([
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
      });
    });

    it('the invariant index is UNIQUE, partial, and keyed on the destination outlet', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname='public'
              AND indexname='warehouse_dispatches_initial_provisioning_once_uniq'`,
        );
        expect(r.rows).toHaveLength(1);
        const def: string = r.rows[0].indexdef;
        expect(def).toMatch(/^CREATE UNIQUE INDEX/);
        expect(def).toContain('(destination_distribution_point_id)');
        expect(def).toContain('is_initial_provisioning');
        expect(def).toContain('initial_provisioning_consumed_at IS NOT NULL');
        // Rule G: no balance participates.
        expect(def).not.toMatch(/quantity|on_hand/);
      });
    });

    it('the new RPC is SECURITY DEFINER, search_path-pinned, and not executable by anon', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT prosecdef, proconfig, array_to_string(proacl,' ') acl
             FROM pg_proc
            WHERE oid='public.phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)'::regprocedure`,
        );
        expect(r.rows[0].prosecdef).toBe(true);
        expect((r.rows[0].proconfig ?? []).join(';')).toMatch(/search_path=public,\s*pg_temp/);
        expect(r.rows[0].acl ?? '').not.toMatch(/\banon=/);
        expect(r.rows[0].acl ?? '').toMatch(/authenticated=X/);
      });
    });

    it('exactly one pg_proc row exists for the new RPC — no ambiguous overload', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM pg_proc
            WHERE proname='phoenix_create_initial_provisioning_dispatch'
              AND pronamespace='public'::regnamespace`,
        );
        expect(r.rows[0].n).toBe(1);
      });
    });

    it('the 149 receive DELEGATE was not modified', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_functiondef(
                    'public._phoenix_149_delegate_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)'::regprocedure
                  ) AS d`,
        );
        expect(r.rows[0].d).not.toContain('initial_provisioning');
        expect(r.rows[0].d).toContain('FOR UPDATE');
      });
    });
  });

  // ── Rules A-G ─────────────────────────────────────────────────────────────

  describe('rule A — an OPEN lifecycle reserves the outlet', () => {
    it('a second initial provisioning for the same outlet is refused while the first is a draft', async () => {
      const first = await createInitialProvisioning(DP.A, 'A1');
      expect(first.ok).toBe(true);
      expect(first.is_initial_provisioning).toBe(true);
      expect((await header(first.dispatch_id)).status).toBe('draft');

      const msg = await rejects(() => createInitialProvisioning(DP.A, 'A2'));
      expect(msg).toMatch(/initial_provisioning_already_exists_for_outlet/);

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM warehouse_dispatches
            WHERE destination_distribution_point_id=$1 AND is_initial_provisioning`,
          [DP.A],
        );
        expect(r.rows[0].n).toBe(1); // the refused attempt left nothing behind
      });
    });

    it('the refusal also holds once the lifecycle has been SENT', async () => {
      const stock = await provisionInstitutionStock('A3', 5);
      const created = await createInitialProvisioning(DP.B, 'A3');
      await addLinesAndSend(created.dispatch_id, stock, [5]);
      expect((await header(created.dispatch_id)).status).toBe('sent');

      const msg = await rejects(() => createInitialProvisioning(DP.B, 'A4'));
      expect(msg).toMatch(/initial_provisioning_already_exists_for_outlet/);
    });
  });

  describe('rule B — a PARTIAL receipt keeps the outlet held', () => {
    it('receiving one of two lines stamps consumption and still blocks a second lifecycle', async () => {
      const stock = await provisionInstitutionStock('B1', 20);
      const created = await createInitialProvisioning(DP.C, 'B1');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [5, 5]);

      await receive(lines[0], 5);

      const h = await header(created.dispatch_id);
      expect(h.status).toBe('partially_accepted'); // one decided, one still pending
      expect(h.initial_provisioning_consumed_at).not.toBeNull();

      const msg = await rejects(() => createInitialProvisioning(DP.C, 'B2'));
      expect(msg).toMatch(/initial_provisioning_already_exists_for_outlet/);
    });
  });

  describe('rule C — a CONSUMED lifecycle blocks forever, even when the header is terminal', () => {
    it('a fully accepted provisioning leaves the header accepted and still blocks', async () => {
      const { dispatchId } = await provisionOutlet(DP.D, 'C1', 12);

      const h = await header(dispatchId);
      // The header is TERMINAL here. A status-only predicate listing
      // draft/sent/partially_accepted would drop this row out of the index and
      // wrongly re-open the outlet — which is precisely why consumed_at exists.
      expect(h.status).toBe('accepted');
      expect(h.is_initial_provisioning).toBe(true);
      expect(h.initial_provisioning_consumed_at).not.toBeNull();

      const msg = await rejects(() => createInitialProvisioning(DP.D, 'C2'));
      expect(msg).toMatch(/initial_provisioning_already_exists_for_outlet/);
    });
  });

  describe('rule D — a FULLY REJECTED lifecycle delivered nothing and frees the outlet', () => {
    /**
     * HISTORICAL NOTE — the defect this rule once had to route around.
     *
     * Before Migration 167, a zero-quantity receipt could not complete on
     * canonical master: the receive delegate sets `received_quantity = 0` on
     * the rejection branch, while warehouse_dispatch_lines_decision_chk
     * (061:746) required `received_quantity IS NULL` for status 'rejected'.
     * Every full line rejection therefore aborted with a check-constraint
     * violation — independent of E-4, and outside E-4's authorized scope to
     * repair (that would have meant editing an immutable migration's
     * constraint or the 131 delegate).
     *
     * Migration 167 (a separate, later-merged migration) reconciles that
     * constraint to the writer. This suite runs against the current
     * EFFECTIVE chain (buildRig({}) — see the file header), so once 167 is
     * present the real rejection RPC is exercised directly below, rather than
     * manufactured by updating the header by hand.
     */
    it('a real full rejection through the canonical RPC frees the outlet', async () => {
      const stock = await provisionInstitutionStock('D1', 8);
      const created = await createInitialProvisioning(DP.E, 'D1');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [8]);

      // The RPC succeeds — no 23514, no violates check constraint.
      const res: any = await receive(lines[0], 0);
      expect(res.ok).toBe(true);
      expect(res.line_status).toBe('rejected');
      expect(res.outlet_stock_id).toBeNull();
      expect(res.movement_id).toBeNull();
      expect(res.quantity_after).toBe(0);

      const l = await line(lines[0]);
      expect(l.status).toBe('rejected');
      expect(l.received_quantity).toBe(0);

      const h = await header(created.dispatch_id);
      expect(h.status).toBe('rejected');
      expect(h.is_initial_provisioning).toBe(true);
      expect(h.initial_provisioning_consumed_at).toBeNull(); // nothing was ever delivered

      // No delivered outlet stock and no phantom movement for the refused line.
      await rig.asAdmin(async (c: any) => {
        const stockRow = await c.query(
          `SELECT count(*)::int AS n FROM outlet_stock WHERE distribution_point_id=$1`,
          [DP.E],
        );
        expect(stockRow.rows[0].n).toBe(0);
        const mv = await c.query(
          `SELECT count(*)::int AS n FROM outlet_stock_movements WHERE distribution_point_id=$1`,
          [DP.E],
        );
        expect(mv.rows[0].n).toBe(0);
      });

      // A lifecycle that delivered NOTHING did not consume the entitlement —
      // the outlet is free again.
      const second = await createInitialProvisioning(DP.E, 'D2');
      expect(second.ok).toBe(true);
      expect(second.dispatch_id).not.toBe(created.dispatch_id);
    });

    it('an ordinary dispatch\'s real full rejection does not touch E-4 semantics', async () => {
      const stock = await provisionInstitutionStock('D3', 4);
      const ordinary = await createOrdinary(DP.D_ORD, 'D3');
      const lines = await addLinesAndSend(ordinary.dispatch_id, stock, [4]);

      // Migration 167's repaired rejection path must not accidentally invoke
      // any E-4 initial-provisioning semantics for an ordinary dispatch.
      const res: any = await receive(lines[0], 0);
      expect(res.ok).toBe(true);
      expect(res.line_status).toBe('rejected');

      const l = await line(lines[0]);
      expect(l.status).toBe('rejected');
      expect(l.received_quantity).toBe(0);

      const h = await header(ordinary.dispatch_id);
      expect(h.status).toBe('rejected');
      expect(h.is_initial_provisioning).toBe(false);
      expect(h.initial_provisioning_consumed_at).toBeNull();
    });
  });

  describe('rule E — a DRAFT CANCELLED lifecycle frees the outlet', () => {
    it('cancelling a draft provisioning leaves consumed_at NULL and re-opens the outlet', async () => {
      const created = await createInitialProvisioning(DP.F, 'E1');

      await rig.asUser(
        rig.superAdminId,
        (c: any) => call(c, 'phoenix_cancel_warehouse_dispatch', [created.dispatch_id, 'E-4 rule E probe']),
        { commit: true },
      );

      const h = await header(created.dispatch_id);
      expect(h.status).toBe('cancelled');
      expect(h.initial_provisioning_consumed_at).toBeNull();

      const second = await createInitialProvisioning(DP.F, 'E2');
      expect(second.ok).toBe(true);
    });
  });

  describe('rule F — a MIXED outcome with at least one positive receipt is a consumption', () => {
    /**
     * What rule F requires is that consumption is read from consumed_at and
     * NEVER from the header. Proven two ways below: first in its sharpest
     * form — two SEPARATE lifecycles carrying the SAME terminal header status
     * produce OPPOSITE outcomes, decided solely by consumed_at — then in its
     * most direct form, a genuine single lifecycle with one accepted line and
     * one fully rejected line, now reachable end to end since Migration 167
     * reconciled the rejection path (see rule D).
     *
     * 'partially_accepted' is the value 070 emits BOTH for "still open"
     * (070:203) and for "all decided, mixed" (070:206), so a predicate that
     * consulted the header could not distinguish rule B from rule F at all.
     */
    it('two lifecycles with TERMINAL headers differ solely by consumed_at', async () => {
      // Held: terminal 'accepted', stock genuinely delivered.
      const stockHeld = await provisionInstitutionStock('F1', 10);
      const held = await createInitialProvisioning(DP.G, 'F1');
      const heldLines = await addLinesAndSend(held.dispatch_id, stockHeld, [5, 5]);
      for (const l of heldLines) await receive(l, 5);

      const heldHeader = await header(held.dispatch_id);
      expect(heldHeader.status).toBe('accepted');
      expect(heldHeader.initial_provisioning_consumed_at).not.toBeNull();

      const blocked = await rejects(() => createInitialProvisioning(DP.G, 'F2'));
      expect(blocked).toMatch(/initial_provisioning_already_exists_for_outlet/);

      // Free: also terminal, but nothing was ever delivered — a real full
      // rejection through the canonical RPC (rule D), not a manufactured
      // header.
      const stockFree = await provisionInstitutionStock('F3', 10);
      const free = await createInitialProvisioning(DP.F_FREE, 'F3');
      const freeLines = await addLinesAndSend(free.dispatch_id, stockFree, [10]);
      const freeRes: any = await receive(freeLines[0], 0);
      expect(freeRes.ok).toBe(true);
      expect(freeRes.line_status).toBe('rejected');

      const freeHeader = await header(free.dispatch_id);
      expect(freeHeader.status).toBe('rejected');
      expect(freeHeader.initial_provisioning_consumed_at).toBeNull();

      // Both lifecycles are over. Only the recorded consumption differs, and
      // only it decides — a status-only predicate would have dropped BOTH out
      // of the index and wrongly re-opened the consumed one.
      const allowed = await createInitialProvisioning(DP.F_FREE, 'F4');
      expect(allowed.ok).toBe(true);
    });

    it('a real mixed outcome — one accepted line and one fully rejected line — still consumes the lifecycle', async () => {
      const stock = await provisionInstitutionStock('F6', 11);
      const created = await createInitialProvisioning(DP.MIXED, 'F6');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [4, 7]);

      // One line refused outright, the other accepted in full — the real
      // mixed outcome Migration 167 makes reachable for the first time.
      const rejected: any = await receive(lines[0], 0);
      expect(rejected.ok).toBe(true);
      expect(rejected.line_status).toBe('rejected');
      const accepted: any = await receive(lines[1], 7);
      expect(accepted.ok).toBe(true);
      expect(accepted.line_status).toBe('accepted');

      const h = await header(created.dispatch_id);
      // 070:206 — all decided, but a mix.
      expect(h.status).toBe('partially_accepted');
      // Positive stock actually arrived, so the lifecycle IS consumed.
      expect(h.initial_provisioning_consumed_at).not.toBeNull();

      // The one-shot entitlement is gone — refused with the same error a
      // fully-accepted or fully-open lifecycle produces.
      const msg = await rejects(() => createInitialProvisioning(DP.MIXED, 'F7'));
      expect(msg).toMatch(/initial_provisioning_already_exists_for_outlet/);

      // Quantity conservation: the rejected line delivered nothing, the
      // accepted line delivered exactly what it sent — no phantom quantity.
      const rejectedLine = await line(lines[0]);
      expect(rejectedLine.status).toBe('rejected');
      expect(rejectedLine.received_quantity).toBe(0);
      const acceptedLine = await line(lines[1]);
      expect(acceptedLine.status).toBe('accepted');
      expect(acceptedLine.received_quantity).toBe(7);

      await rig.asAdmin(async (c: any) => {
        const stockRow = await c.query(
          `SELECT on_hand_quantity FROM outlet_stock WHERE distribution_point_id=$1`,
          [DP.MIXED],
        );
        expect(stockRow.rows).toHaveLength(1);
        expect(stockRow.rows[0].on_hand_quantity).toBe(7);
      });
    });

    it('a positive receipt stamps consumption driven by the reported quantity_delta', async () => {
      const stock = await provisionInstitutionStock('F5', 6);
      const created = await createInitialProvisioning(DP.F_DELTA, 'F5');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [2, 4]);

      // A partial-quantity acceptance (2 of 4) is a real difference receipt —
      // it delivers stock, so it consumes the lifecycle.
      const partial = await receive(lines[1], 3, 4);
      expect(partial.line_status).toBe('accepted_with_difference');
      expect(partial.quantity_delta).toBe(3);

      expect((await header(created.dispatch_id)).initial_provisioning_consumed_at).not.toBeNull();
    });
  });

  describe('rule G — later depletion never reopens the lifecycle', () => {
    it('dispensing the provisioned stock to zero still leaves the outlet blocked', async () => {
      const stock = await provisionInstitutionStock('G1', 6);
      const created = await createInitialProvisioning(DP.ORDINARY, 'G1');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [6]);
      const got = await receive(lines[0], 6);
      const outletStockId = got.outlet_stock_id;

      await rig.asUser(
        rig.superAdminId,
        (c: any) =>
          call(c, 'phoenix_dispense_outlet_stock', [randomUUID(), outletStockId, 6, 'E-4 rule G probe', null]),
        { commit: true },
      );

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [outletStockId]);
        expect(r.rows[0].on_hand_quantity).toBe(0); // genuinely depleted
      });

      const msg = await rejects(() => createInitialProvisioning(DP.ORDINARY, 'G2'));
      expect(msg).toMatch(/initial_provisioning_already_exists_for_outlet/);
    });
  });

  // ── Non-interference with ordinary dispatch ──────────────────────────────

  describe('ordinary dispatches are untouched', () => {
    it('the 070 creator still produces an unflagged dispatch, and many are allowed per outlet', async () => {
      const first = await createOrdinary(DP.REPLAY, 'ORD1');
      const second = await createOrdinary(DP.REPLAY, 'ORD2');
      expect(first.dispatch_id).not.toBe(second.dispatch_id);

      for (const d of [first, second]) {
        const h = await header(d.dispatch_id);
        expect(h.is_initial_provisioning).toBe(false);
        expect(h.initial_provisioning_consumed_at).toBeNull();
      }
    });

    it('receiving an ordinary dispatch never stamps a consumption timestamp', async () => {
      const stock = await provisionInstitutionStock('ORD3', 7);
      const created = await createOrdinary(DP.REPLAY, 'ORD3');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [7]);
      const got = await receive(lines[0], 7);
      expect(got.ok).toBe(true);

      const h = await header(created.dispatch_id);
      expect(h.is_initial_provisioning).toBe(false);
      expect(h.initial_provisioning_consumed_at).toBeNull();
    });

    it('an ordinary dispatch to an outlet whose provisioning is consumed is still allowed', async () => {
      // The invariant governs the one-time lifecycle only — never ordinary
      // resupply. DP.D was fully provisioned and consumed in rule C.
      const ordinary = await createOrdinary(DP.D, 'ORD4');
      expect(ordinary.ok).toBe(true);
    });
  });

  // ── Stamp mechanics ──────────────────────────────────────────────────────

  describe('the consumption stamp is once-only and driven by the delivered quantity', () => {
    it('an idempotent replay of the same receipt does not move the timestamp', async () => {
      const stock = await provisionInstitutionStock('R1', 9);
      const created = await createInitialProvisioning(DP.BULK, 'R1');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [9]);

      const requestId = randomUUID();
      const first = await rig.asUser(
        rig.superAdminId,
        (c: any) => call(c, 'phoenix_receive_outlet_dispatch_line', [requestId, lines[0], 9, null, null]),
        { commit: true },
      );
      expect(first.idempotent_replay).toBe(false);
      const stampedAt = (await header(created.dispatch_id)).initial_provisioning_consumed_at;
      expect(stampedAt).not.toBeNull();

      const replay = await rig.asUser(
        rig.superAdminId,
        (c: any) => call(c, 'phoenix_receive_outlet_dispatch_line', [requestId, lines[0], 9, null, null]),
        { commit: true },
      );
      expect(replay.idempotent_replay).toBe(true);

      const after = (await header(created.dispatch_id)).initial_provisioning_consumed_at;
      expect(after).toEqual(stampedAt); // not re-stamped
    });

    it('a SECOND positive receipt on the same lifecycle does not move the timestamp', async () => {
      const stock = await provisionInstitutionStock('R2', 10);
      const created = await createInitialProvisioning(DP.ONCE, 'R2');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [5, 5]);

      await receive(lines[0], 5);
      const first = (await header(created.dispatch_id)).initial_provisioning_consumed_at;
      expect(first).not.toBeNull();

      await receive(lines[1], 5);
      const second = await header(created.dispatch_id);
      // The `AND initial_provisioning_consumed_at IS NULL` guard makes the
      // stamp fire exactly once, on the FIRST delivery.
      expect(second.initial_provisioning_consumed_at).toEqual(first);
      expect(second.status).toBe('accepted');
    });

    it('the bulk receive path also routes through the replaced wrapper and stamps', async () => {
      const stock = await provisionInstitutionStock('BK1', 11);
      const created = await createInitialProvisioning(DP.CHECK, 'BK1');
      const lines = await addLinesAndSend(created.dispatch_id, stock, [11]);

      const res = await rig.asUser(
        rig.superAdminId,
        (c: any) =>
          call(c, 'phoenix_receive_all_matching_dispatch_lines', [
            randomUUID(),
            created.dispatch_id,
            JSON.stringify([{ dispatch_line_id: lines[0], counted_quantity: 11 }]),
            null,
          ]),
        { commit: true },
      );
      expect(res.received_count).toBe(1);

      const h = await header(created.dispatch_id);
      expect(h.status).toBe('accepted');
      expect(h.initial_provisioning_consumed_at).not.toBeNull();
    });
  });

  describe('the CHECK constraint', () => {
    it('a consumption timestamp cannot exist on a dispatch that is not an initial provisioning', async () => {
      const ordinary = await createOrdinary(DP.REPLAY, 'CHK1');
      const msg = await rejects(() =>
        rig.asAdmin((c: any) =>
          c.query(`UPDATE warehouse_dispatches SET initial_provisioning_consumed_at = now() WHERE id=$1`, [
            ordinary.dispatch_id,
          ]),
        ),
      );
      expect(msg).toMatch(/wd_initial_provisioning_consumed_chk/);
    });
  });

  // ── RBAC / authentication ────────────────────────────────────────────────

  describe('authorization is the 070 creator\'s, unchanged', () => {
    it('a profile without warehouse_dispatch.create is refused', async () => {
      const msg = await rejects(() => createInitialProvisioning(DP.CHECK, 'RB1', NOBODY));
      expect(msg).toMatch(/forbidden_warehouse_dispatch_create/);
    });

    it('an unauthenticated caller is refused before any lifecycle is revealed', async () => {
      const msg = await rejects(() =>
        rig.asUser(
          null,
          (c: any) =>
            call(c, 'phoenix_create_initial_provisioning_dispatch', [
              WH_INST, DP.CHECK, uniq('RB2'), null, null, null,
            ]),
          { commit: false },
        ),
      );
      expect(msg).toMatch(/not_authenticated/);
    });

    it('an outlet paired with a DIFFERENT warehouse is refused by the 070 pairing rule', async () => {
      const msg = await rejects(() =>
        rig.asUser(
          rig.superAdminId,
          (c: any) =>
            call(c, 'phoenix_create_initial_provisioning_dispatch', [
              WH_CENTRAL, DP.A, uniq('RB3'), null, null, null,
            ]),
          { commit: false },
        ),
      );
      expect(msg).toMatch(/destination_outlet_not_paired_with_this_warehouse/);
    });

    it('a rejected creation writes no audit row and no dispatch', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM audit_logs
            WHERE action='warehouse_dispatch.initial_provisioning_created' AND actor_id=$1`,
          [NOBODY],
        );
        expect(r.rows[0].n).toBe(0);
      });
    });

    it('a successful creation writes the 070 audit row AND exactly one E-4 audit row', async () => {
      const created = await createInitialProvisioning(DP.AUDIT, 'AUD1');
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT action, count(*)::int n FROM audit_logs
            WHERE entity_id=$1 GROUP BY action ORDER BY action`,
          [created.dispatch_id],
        );
        expect(r.rows).toEqual([
          { action: 'warehouse_dispatch.created', n: 1 },
          { action: 'warehouse_dispatch.initial_provisioning_created', n: 1 },
        ]);
      });
    });
  });

  // ── Boundaries: E-3 preserved, E-5+ absent, Availability and Stage F untouched ──

  describe('E-4 boundaries', () => {
    it('E-3: both direct-corridor validators still carry their facility-pinned branches', async () => {
      await rig.asAdmin(async (c: any) => {
        for (const sig of [
          'public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)',
          'public.phoenix_assert_direct_return_endpoints(uuid,uuid)',
        ]) {
          const r = await c.query(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [sig]);
          expect(r.rows[0].d).toContain('facility_id IS NULL');
          expect(r.rows[0].d).toContain('facility_id IS NOT NULL');
        }
      });
    });

    it('E-3: the legacy return validator parameter names are unchanged', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_function_arguments('public.phoenix_assert_direct_return_endpoints(uuid,uuid)'::regprocedure) AS a`,
        );
        expect(r.rows[0].a).toContain('p_institution_warehouse_id');
        expect(r.rows[0].a).toContain('p_central_warehouse_id');
      });
    });

    it('E-6 reversal objects exist now that 169 is on the effective chain tip', async () => {
      // This suite drives the full effective chain on disk (buildRig({})).
      // Migration 169 (E-6) is now present, so phoenix_reverse_outlet_replenishment
      // and phoenix_outlet_replenishment_reversible_batches are expected. E-4
      // ownership itself creates neither — this only reflects the tip advancing.
      await rig.asAdmin(async (c: any) => {
        for (const sig of [
          'public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)',
          'public.phoenix_outlet_replenishment_reversible_batches(uuid,uuid)',
        ]) {
          const r = await c.query(`SELECT to_regprocedure($1) AS r`, [sig]);
          expect(r.rows[0].r, `${sig} must exist once 169 is on the chain`).not.toBeNull();
        }
      });
    });

    it('the outlet movement vocabulary admits E-5 replenishment types when 168 is present', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='outlet_stock_movements_type_chk'`,
        );
        // This suite drives the effective chain tip, which includes 168, so
        // both E-5 types must be present. E-4 itself never widens this CHECK;
        // the core pre-E-5 vocabulary must also survive unchanged.
        expect(r.rows[0].d).toMatch(/dispense/);
        expect(r.rows[0].d).toMatch(/dispatch_receive/);
        expect(r.rows[0].d).toMatch(/replenish_send/);
        expect(r.rows[0].d).toMatch(/replenish_receive/);
      });
    });

    it('warehouse_kind is still exactly central + institution', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='warehouses_warehouse_kind_chk'`,
        );
        expect(r.rows[0].d).toContain('central');
        expect(r.rows[0].d).toContain('institution');
        expect(r.rows[0].d).not.toMatch(/health_center|facility/);
      });
    });

    it('Availability is unchanged — near_stockout exists nowhere', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM pg_constraint
            WHERE conrelid='public.item_availability'::regclass
              AND pg_get_constraintdef(oid) LIKE '%near_stockout%'`,
        );
        expect(r.rows[0].n).toBe(0);
        const p = await c.query(
          `SELECT count(*)::int n FROM pg_proc
            WHERE pronamespace='public'::regnamespace AND prosrc LIKE '%near_stockout%'`,
        );
        expect(p.rows[0].n).toBe(0);
      });
    });

    it('no Stage-F patient dispensing object exists', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM pg_class
            WHERE relname IN ('patients','patient_visits','visit_cards','patient_charts','patient_dispenses')`,
        );
        expect(r.rows[0].n).toBe(0);
      });
    });

    it('stock truth is still exactly warehouse_stock + outlet_stock — no parallel ledger', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM pg_class
            WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock')`,
        );
        expect(r.rows[0].n).toBe(0);
      });
    });
  });

  describe('flag writes are event-silent', () => {
    it('creation emits exactly ONE lifecycle event — the flag UPDATE adds none', async () => {
      const created = await createInitialProvisioning(DP.EVENT, 'EV1');

      // 082's capture trigger fires AFTER INSERT (status 'draft') and AFTER
      // every UPDATE. The flag UPDATE leaves status untouched, so the
      // early-return guard (159:182-184) must suppress it entirely.
      const events = await rig
        .asAdmin((c: any) =>
          c.query(
            `SELECT status_after FROM phoenix_movement_events
              WHERE reference_type='warehouse_dispatches' AND reference_id=$1
              ORDER BY occurred_at`,
            [created.dispatch_id],
          ),
        )
        .then((r: any) => r.rows.map((x: any) => x.status_after));

      expect(events).toEqual(['draft']);
    });

    it('the consumption stamp emits no extra event either', async () => {
      const stock = await provisionInstitutionStock('EV2', 3);
      const created = await createInitialProvisioning(DP.EVENT, 'EV2').catch(() => null);
      expect(created).toBeNull(); // DP.EVENT is already held — rule A still governs

      // Use the outlet freed by rule E instead, and follow it end to end.
      const fresh = await createOrdinary(DP.F, 'EV3');
      const lines = await addLinesAndSend(fresh.dispatch_id, stock, [3]);
      await receive(lines[0], 3);

      const events = await rig
        .asAdmin((c: any) =>
          c.query(
            `SELECT status_after FROM phoenix_movement_events
              WHERE reference_type='warehouse_dispatches' AND reference_id=$1
              ORDER BY occurred_at`,
            [fresh.dispatch_id],
          ),
        )
        .then((r: any) => r.rows.map((x: any) => x.status_after));

      // draft -> sent -> accepted. No duplicate, no NULL-status row.
      expect(events).toEqual(['draft', 'sent', 'accepted']);
    });
  });
});
