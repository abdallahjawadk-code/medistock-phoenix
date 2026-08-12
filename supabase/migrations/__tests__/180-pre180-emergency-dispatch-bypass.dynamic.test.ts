/**
 * 180 · THE PRE-180 BYPASS, REPRODUCED — dynamic evidence.
 *
 * This suite deliberately builds a rig FROZEN at the pre-fix chain
 * (buildRig({ upTo: 179 })) and demonstrates the defect Migration 180 closes,
 * so the fix is justified by a reproduction in the repository rather than by a
 * claim in a PR description. The sibling
 * 180-emergency-initial-provisioning-boundary.dynamic.test.ts runs the same
 * scenarios against the CURRENT chain tip and proves each of them now fails.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS REPRODUCED
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. THE ESCALATION (the R1.0 finding, exactly):
 *      initial provisioning         -> cabinet on_hand = 10
 *      second initial provisioning  -> correctly refused
 *      ORDINARY warehouse dispatch  -> ACCEPTED, 10 -> 17
 *      ORDINARY warehouse dispatch  -> ACCEPTED, 17 -> 20
 *    Migration 166's one-shot invariant is bypassed through the generic writer.
 *
 * 2. THE HOLE A "CONSUMED-ONLY" GUARD WOULD LEAVE OPEN:
 *    a brand-new crash cabinet and a brand-new rescue cart — no
 *    initial-provisioning row of any kind — accept ordinary warehouse dispatch
 *    and are stocked without ever entering the lifecycle. A guard that only
 *    refuses once `initial_provisioning_consumed_at IS NOT NULL` reads "not
 *    consumed" here and admits the dispatch, which is why 180 refuses the
 *    corridor unconditionally instead.
 *
 * These assertions describe the OLD behaviour on purpose. They are pinned to
 * `upTo: 179`, so a later migration can never make them silently vacuous: the
 * rig replays exactly 001-179 whatever the chain tip has become.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 180000 });

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000179001';
const ORG_HOSP = '00000000-0000-0000-0000-000000179002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000179101';
const WH_HOSP = '00000000-0000-0000-0000-000000179102';
const ROUTE = '00000000-0000-0000-0000-000000179501';

const CAB_ESCALATE = '00000000-0000-0000-0000-000000179301';
const CAB_VIRGIN = '00000000-0000-0000-0000-000000179302';
const CART_VIRGIN = '00000000-0000-0000-0000-000000179303';

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

run('180 · the pre-180 emergency-dispatch bypass, reproduced on a 001->179 rig', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c
      .query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  async function provisionWarehouseStock(tag: string, qty: number): Promise<string> {
    return rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
          randomUUID(), WH_CENTRAL, `P179-${tag}`, qty, true, true, 0,
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

  const createOrdinary = (dp: string, tag: string) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) => call(c, 'phoenix_create_warehouse_dispatch', [WH_HOSP, dp, uniq(tag), null, null, null]),
      { commit: true },
    );

  const createInitial = (dp: string, tag: string) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) =>
        call(c, 'phoenix_create_initial_provisioning_dispatch', [WH_HOSP, dp, uniq(tag), null, null, null]),
      { commit: true },
    );

  async function deliver(dispatchId: string, stockId: string, qty: number) {
    const lineId = await rig.asUser(
      rig.superAdminId,
      async (c: any) => {
        await call(c, 'phoenix_add_dispatch_line', [dispatchId, stockId, qty]);
        await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
        const r = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
        return r.rows[0].id as string;
      },
      { commit: true },
    );
    return rig.asUser(
      rig.superAdminId,
      (c: any) => call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), lineId, qty, null, null]),
      { commit: true },
    );
  }

  const onHand = (dp: string): Promise<number> =>
    rig
      .asAdmin((c: any) =>
        c.query(
          `SELECT COALESCE(SUM(on_hand_quantity),0)::int n FROM outlet_stock WHERE distribution_point_id=$1`,
          [dp],
        ),
      )
      .then((r: any) => r.rows[0].n as number);

  /** Ordinary dispatch of `qty` into `dp`, delivered. */
  async function ordinaryDeliver(dp: string, tag: string, qty: number) {
    const stock = await provisionWarehouseStock(tag, qty);
    const created = await createOrdinary(dp, tag);
    await deliver(created.dispatch_id, stock, qty);
    return created;
  }

  beforeAll(async () => {
    // Pinned to the pre-fix ceiling on purpose. Do NOT change to buildRig({}).
    rig = await buildRig({ upTo: 179 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_CENTRAL}','C179','مركز','p179-c','pharmacy_department_authority',NULL),
        ('${ORG_HOSP}','H179','مستشفى','p179-h','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH179','مخزنC','active','central','p179-wc'),
        ('${WH_HOSP}','${ORG_HOSP}','HWH179','مخزنH','active','institution','p179-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points
        (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${CAB_ESCALATE}','${WH_HOSP}','${ORG_HOSP}','Escalate Cabinet179','خزانة','crash_cabinet','active','non_emergency'),
        ('${CAB_VIRGIN}','${WH_HOSP}','${ORG_HOSP}','Virgin Cabinet179','خزانة','crash_cabinet','active','non_emergency'),
        ('${CART_VIRGIN}','${WH_HOSP}','${ORG_HOSP}','Virgin Cart179','عربة','rescue_cart','active','emergency')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_HOSP}','central','institution', true)
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 240000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('the rig really is frozen at 179 — Migration 180 is NOT applied', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT
          to_regprocedure('public._phoenix_180_delegate_create_warehouse_dispatch(uuid,uuid,text,text,text,text,text)') IS NULL AS no_core,
          pg_get_functiondef('public.phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text)'::regprocedure)
            NOT LIKE '%emergency_outlet_requires_initial_provisioning%' AS no_gate,
          pg_get_functiondef('public.phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)'::regprocedure)
            LIKE '%public.phoenix_create_warehouse_dispatch(%' AS old_coupling`);
      expect(r.rows[0]).toEqual({ no_core: true, no_gate: true, old_coupling: true });
    });
  });

  describe('1 · the escalation: the one-shot invariant is bypassable through the generic writer', () => {
    it('initial provisioning delivers 10 and consumes the lifecycle', async () => {
      const stock = await provisionWarehouseStock('ESC-INIT', 10);
      const created = await createInitial(CAB_ESCALATE, 'ESC-INIT');
      await deliver(created.dispatch_id, stock, 10);
      expect(await onHand(CAB_ESCALATE)).toBe(10);

      const h = await rig
        .asAdmin((c: any) =>
          c.query(
            `SELECT is_initial_provisioning, initial_provisioning_consumed_at
               FROM warehouse_dispatches WHERE id=$1`,
            [created.dispatch_id],
          ),
        )
        .then((r: any) => r.rows[0]);
      expect(h.is_initial_provisioning).toBe(true);
      expect(h.initial_provisioning_consumed_at).not.toBeNull();
    });

    it('a SECOND initial provisioning is correctly refused — 166 works as designed', async () => {
      expect(await rejects(() => createInitial(CAB_ESCALATE, 'ESC-2ND')))
        .toMatch(/initial_provisioning_already_exists_for_outlet|once_uniq/);
    });

    it('DEFECT · an ORDINARY warehouse dispatch to the same cabinet is nevertheless ACCEPTED (10 -> 17)', async () => {
      const created = await ordinaryDeliver(CAB_ESCALATE, 'ESC-ORD1', 7);
      expect(created.ok).toBe(true);
      expect(await onHand(CAB_ESCALATE)).toBe(17);
    });

    it('DEFECT · a REPEATED ordinary warehouse dispatch is also accepted (17 -> 20)', async () => {
      await ordinaryDeliver(CAB_ESCALATE, 'ESC-ORD2', 3);
      expect(await onHand(CAB_ESCALATE)).toBe(20);
    });

    it('DEFECT · the bypassing dispatches carry no lifecycle marker at all', async () => {
      // This is why the bypass is invisible to Migration 166: the extra stock
      // arrives on rows the invariant index does not even index.
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*) FILTER (WHERE is_initial_provisioning)::int AS flagged,
                  count(*) FILTER (WHERE NOT is_initial_provisioning)::int AS ordinary
             FROM warehouse_dispatches WHERE destination_distribution_point_id=$1`,
          [CAB_ESCALATE],
        );
        expect(r.rows[0].flagged).toBe(1);
        expect(r.rows[0].ordinary).toBe(2);
      });
    });
  });

  describe('2 · the hole a "consumed-only" guard would leave open', () => {
    it('DEFECT · a brand-new crash cabinet is stocked by ordinary dispatch, lifecycle never entered', async () => {
      expect(await onHand(CAB_VIRGIN)).toBe(0);
      const created = await ordinaryDeliver(CAB_VIRGIN, 'VIRGIN-CAB', 5);
      expect(created.ok).toBe(true);
      expect(await onHand(CAB_VIRGIN)).toBe(5);

      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM warehouse_dispatches
            WHERE destination_distribution_point_id=$1 AND is_initial_provisioning`,
          [CAB_VIRGIN],
        );
        // No initial-provisioning row exists, so "already consumed?" is false
        // and a consumed-only guard would have admitted this dispatch too.
        expect(r.rows[0].n).toBe(0);
      });
    });

    it('DEFECT · a brand-new rescue cart is stocked the same way', async () => {
      const created = await ordinaryDeliver(CART_VIRGIN, 'VIRGIN-CART', 4);
      expect(created.ok).toBe(true);
      expect(await onHand(CART_VIRGIN)).toBe(4);
    });

    it('…and the outlet remains re-provisionable afterwards, so the two paths never meet', async () => {
      // The lifecycle is still open despite the outlet already holding stock:
      // the bypass and the invariant are simply blind to each other.
      const r = await createInitial(CAB_VIRGIN, 'VIRGIN-INIT');
      expect(r.ok).toBe(true);
      expect(r.is_initial_provisioning).toBe(true);
    });
  });
});
