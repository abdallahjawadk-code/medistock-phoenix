/**
 * 185 · R1.5-F3 OUTLET RECALL — provenance-anchored recall at the OUTLET holder.
 *
 * F1 bound the immediate warehouse receiver, F2 followed provenance one warehouse
 * hop to every CURRENT warehouse holder. F3 closes the last leg: stock that has
 * already left the warehouse graph and is sitting on an OUTLET shelf.
 *
 * THE SELECTOR IS THE RECEIPT, NOT THE SHELF:
 *     outlet_stock_movements.id  WHERE movement_type = 'dispatch_receive'
 * Every other id — organization, warehouse, distribution point, outlet_stock,
 * dispatch line, material, quantity — is DERIVED from it server-side, so there is
 * nothing for a caller to substitute. 071's header-only
 * phoenix_recall_outlet_stock, which created an empty unprovenanced draft, now
 * fails closed rather than guessing which receipt an operator meant.
 *
 * TWO BUDGETS, BOTH BINDING (_phoenix_outlet_recall_exposure_v1):
 *   PROVENANCE, keyed by warehouse_dispatch_lines.id — 156's returnable cap
 *     (received - returned) less every live commitment on that same receipt.
 *   PHYSICAL, keyed by outlet_stock.id — available_quantity less every live
 *     obligation resolving to that canonical lot, from ANY provenance and ANY
 *     return number.
 * The exposure is their LEAST. available_quantity is the GENERATED
 * on_hand - reserved, so dispensed, consumed and reserved units are already
 * excluded — patient dispensing is terminal and needs no special case.
 *
 * MERGED LOTS ARE DELIBERATELY CONSERVATIVE. When several dispatch receipts merge
 * into one canonical outlet lot the exact per-unit attribution is genuinely gone,
 * so the physical budget is GLOBAL to the stock row. Total recall exposure across
 * provenances may therefore be smaller than the sum of the selected receipts —
 * never larger than what the outlet physically holds. That is the approved
 * merged-lot policy: under-recall rather than fabricate attribution.
 *
 * REAL DEFAULT ROLES ONLY. This suite seeds ZERO profile_permission_overrides.
 * outlet_stock.recall is a warehouse_officer/institution_admin default under 071
 * scoped at the warehouse that owns the outlet; central_warehouse_manager does not
 * hold it (separation of duty) and health_center_manager holds no mutation at all.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_PDA = '00000000-0000-0000-0000-0000001853a1';
const ORG_SEC = '00000000-0000-0000-0000-0000001853a2';
const ORG_OTH = '00000000-0000-0000-0000-0000001853a3';
const W0   = '00000000-0000-0000-0000-0000001853b0';  // central, PDA
const W1   = '00000000-0000-0000-0000-0000001853b1';  // sector main
const W2   = '00000000-0000-0000-0000-0000001853b2';  // facility-bound depot 1
const W3   = '00000000-0000-0000-0000-0000001853b3';  // facility-bound depot 2
const WOTH = '00000000-0000-0000-0000-0000001853b9';  // unrelated hospital warehouse
const FAC1 = '00000000-0000-0000-0000-0000001853c1';
const FAC2 = '00000000-0000-0000-0000-0000001853c2';

// Profiles — CANONICAL ROLES, zero permission overrides anywhere in this suite.
const CWM0 = '00000000-0000-0000-0000-0000001853d0';  // central_warehouse_manager @PDA, scoped W0
const CWM1 = '00000000-0000-0000-0000-0000001853d1';  // central_warehouse_manager @SEC, scoped W1
const WO1  = '00000000-0000-0000-0000-0000001853d2';  // warehouse_officer         @SEC, scoped W1
const WO2  = '00000000-0000-0000-0000-0000001853d3';  // warehouse_officer         @SEC, scoped W2
const WO3  = '00000000-0000-0000-0000-0000001853d4';  // warehouse_officer         @SEC, scoped W3
const IADM = '00000000-0000-0000-0000-0000001853d5';  // institution_admin         @SEC
const HCM  = '00000000-0000-0000-0000-0000001853d6';  // health_center_manager     @SEC, facility FAC1
const OUT  = '00000000-0000-0000-0000-0000001853d7';  // institution_admin         @OTH (foreign)
const OO1  = '00000000-0000-0000-0000-0000001853d8';  // outlet_officer            @SEC, scoped DP1

const DP1 = '00000000-0000-0000-0000-0000001853e1';   // pharmacy outlet under depot W2
const DP2 = '00000000-0000-0000-0000-0000001853e2';   // pharmacy outlet under depot W3
const DP3 = '00000000-0000-0000-0000-0000001853e3';   // crash_cabinet under depot W2

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

run('185 · R1.5-F3 outlet recall (001->185 rig)', () => {
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

  /** Resolve to the raw error so both message AND sqlstate can be asserted. */
  const failure = async (fn: () => Promise<unknown>): Promise<{ msg: string; code: string }> => {
    try { await fn(); } catch (e: any) { return { msg: String(e?.message ?? e), code: String(e?.code ?? '') }; }
    throw new Error('expected a rejection but the call succeeded');
  };
  const permitted = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try { await fn(); return true; } catch { return false; }
  };

  /** Outlet return lines raised under one external reference, with corridor. */
  const outletLines = (num: string) => rows(
    `SELECT l.requested_quantity::int AS qty, l.reason_code, l.status,
            l.original_dispatch_line_id AS dl, l.original_inbound_movement_id AS mv,
            l.original_inbound_movement_type AS mvtype, l.source_outlet_stock_id AS os,
            l.scientific_name, l.batch_number,
            r.id AS hdr, r.distribution_point_id AS dp, r.destination_warehouse_id AS dw,
            r.source_organization_id AS srcorg, r.requested_by_side AS side, r.status AS hstatus
       FROM outlet_return_request_lines l
       JOIN outlet_return_requests r ON r.id = l.return_request_id
      WHERE btrim(r.return_number) = $1
      ORDER BY r.distribution_point_id, l.created_at`, [num]);

  const outletAvail = async (stockId: string) =>
    (await one(`SELECT COALESCE(available_quantity,0)::int AS a FROM outlet_stock WHERE id=$1`,
      [stockId])).a;

  const custody = async (stockId: string) => {
    const s = await one(
      `SELECT on_hand_quantity AS oh, reserved_quantity AS rv FROM warehouse_stock WHERE id=$1`,
      [stockId]);
    return s.oh - s.rv;
  };

  /** Every live outlet obligation resolving to one canonical outlet lot. */
  const liveOnStock = async (stockId: string) => (await one(
    `SELECT COALESCE(sum(GREATEST(COALESCE(l.approved_quantity,l.requested_quantity)
                                  - l.fulfilled_quantity, 0)),0)::int AS n
       FROM outlet_return_request_lines l
       JOIN outlet_return_requests r ON r.id = l.return_request_id
      WHERE l.source_outlet_stock_id = $1
        AND l.status NOT IN ('rejected','cancelled','fulfilled')
        AND r.status NOT IN ('rejected','cancelled')`, [stockId])).n;

  /** Whole-database physical census — proves a recall moves NOTHING. */
  const census = () => one(
    `SELECT (SELECT COALESCE(sum(on_hand_quantity),0) FROM outlet_stock)::int AS os_oh,
            (SELECT COALESCE(sum(reserved_quantity),0) FROM outlet_stock)::int AS os_rv,
            (SELECT count(*)::int FROM outlet_stock_movements) AS om,
            (SELECT COALESCE(sum(on_hand_quantity),0) FROM warehouse_stock)::int AS ws_oh,
            (SELECT count(*)::int FROM warehouse_stock_movements) AS wm,
            (SELECT COALESCE(sum(quantity),0) FROM warehouse_quarantine_stock)::int AS wq`);

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_PDA}','PDA','دائرة','f3-pda','pharmacy_department_authority',NULL),
        ('${ORG_SEC}','Sector','قطاع','f3-sec','care_institution','health_sector'),
        ('${ORG_OTH}','Other','مستشفى','f3-oth','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,code,status) VALUES
        ('${FAC1}','${ORG_SEC}','primary_health_center','HC1','مركز','f3-hc1','active'),
        ('${FAC2}','${ORG_SEC}','subordinate_health_center','HC2','مركز','f3-hc2','active')
        ON CONFLICT (id) DO NOTHING;`);
      // 181 forces every health-sector warehouse to warehouse_kind 'institution';
      // an outlet may hang only off a facility-bound DEPOT, never the sector main.
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id,is_main) VALUES
        ('${W0}','${ORG_PDA}','Central','مركزي','active','central','f3-w0',NULL,false),
        ('${W1}','${ORG_SEC}','SectorMain','رئيسي','active','institution','f3-w1',NULL,true),
        ('${W2}','${ORG_SEC}','Depot1','مستودع','active','institution','f3-w2','${FAC1}',false),
        ('${W3}','${ORG_SEC}','Depot2','مستودع','active','institution','f3-w3','${FAC2}',false),
        ('${WOTH}','${ORG_OTH}','OtherWh','مخزن','active','institution','f3-woth',NULL,true)
        ON CONFLICT (id) DO NOTHING;`);

      const people: [string, string, string][] = [
        [CWM0, 'central_warehouse_manager', ORG_PDA],
        [CWM1, 'central_warehouse_manager', ORG_SEC],
        [WO1,  'warehouse_officer',         ORG_SEC],
        [WO2,  'warehouse_officer',         ORG_SEC],
        [WO3,  'warehouse_officer',         ORG_SEC],
        [IADM, 'institution_admin',         ORG_SEC],
        [HCM,  'health_center_manager',     ORG_SEC],
        [OUT,  'institution_admin',         ORG_OTH],
        [OO1,  'outlet_officer',            ORG_SEC],
      ];
      for (const [id, role, org] of people) {
        await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING;`,
          [id, `f3-${id.slice(-4)}@rig`]);
        await c.query(`UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1;`,
          [id, role, org]);
      }
      // DIRECT warehouse scope assignments — the canonical operational scope model.
      for (const [pid, wid, org] of [
        [CWM0, W0, ORG_PDA], [CWM1, W1, ORG_SEC],
        [WO1, W1, ORG_SEC], [WO2, W2, ORG_SEC], [WO3, W3, ORG_SEC],
      ] as [string, string, string][]) {
        await c.query(`INSERT INTO profile_scope_assignments
          (id,profile_id,organization_id,scope_type,warehouse_id,is_active)
          VALUES (gen_random_uuid(),$1,$2,'warehouse',$3,true) ON CONFLICT DO NOTHING;`,
          [pid, org, wid]);
      }
      // HCM is FACILITY-scoped — its only legal scope shape under 182.
      await c.query(`INSERT INTO profile_scope_assignments
        (id,profile_id,organization_id,scope_type,facility_id,is_active)
        VALUES (gen_random_uuid(),$1,$2,'facility',$3,true) ON CONFLICT DO NOTHING;`,
        [HCM, ORG_SEC, FAC1]);

      // Outlets hang off the facility-bound depots (181/183 topology).
      await c.query(`INSERT INTO distribution_points
        (id,organization_id,name,name_ar,point_type,status,warehouse_id) VALUES
        ('${DP1}','${ORG_SEC}','HC1 Pharmacy','صيدلية','pharmacy','active','${W2}'),
        ('${DP2}','${ORG_SEC}','HC2 Pharmacy','صيدلية','pharmacy','active','${W3}')
        ON CONFLICT (id) DO NOTHING;`);

      // The outlet officer is DISTRIBUTION_POINT-scoped — its only legal shape.
      // It owns the outlet side of the lifecycle (return_request, return); the
      // warehouse officer owns recall, review_return and return_receive.
      await c.query(`INSERT INTO profile_scope_assignments
        (id,profile_id,organization_id,scope_type,distribution_point_id,is_active)
        VALUES (gen_random_uuid(),$1,$2,'distribution_point',$3,true) ON CONFLICT DO NOTHING;`,
        [OO1, ORG_SEC, DP1]);
    });
  }, 600000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** One DIRECT warehouse supply hop through the genuine chain. */
  async function hop(src: string, dstOrg: string, dst: string, qty: number,
                     material: string, fromStockId: string | null,
                     batch: string | null = null) {
    return asSuper(async (c: any) => {
      let stockId = fromStockId;
      if (!stockId) {
        const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
          randomUUID(), src, material, qty, true, batch === null, 0,
          null, null, null, null, null, null, batch, null,
          null, null, null, null, null, null, 'aid', null,
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

  /** Dispatch from a warehouse lot to an outlet, through the real chain. */
  async function dispatch(wh: string, dp: string, stockId: string, qty: number) {
    return asSuper(async (c: any) => {
      const d = await call(c, 'phoenix_create_warehouse_dispatch',
        [wh, dp, uniq('DSP'), null, null, null]);
      const did = d.dispatch_id ?? d.id;
      const dl = await call(c, 'phoenix_add_dispatch_line_fefo_guarded',
        [did, stockId, qty, false, null, randomUUID()]);
      const dlId = dl.dispatch_line_id ?? dl.id;
      await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), did]);
      await call(c, 'phoenix_receive_outlet_dispatch_line',
        [randomUUID(), dlId, qty, null, null, null]);
      const mv = (await c.query(
        `SELECT id, outlet_stock_id FROM outlet_stock_movements
          WHERE dispatch_line_id=$1 AND movement_type='dispatch_receive'`, [dlId])).rows[0];
      return { dlId: dlId as string, moveId: mv.id as string, outletStock: mv.outlet_stock_id as string };
    });
  }

  /** Root warehouse recall — propagates to every current holder including outlets. */
  const recallRoot = (num: string, transferLineId: string, who: string = CWM0) =>
    asUser(who, (c: any) =>
      call(c, 'phoenix_recall_warehouse_transfer_line', [transferLineId, num, null]));

  /** The standalone F3 selector RPC. */
  const recallOutlet = (who: string, moveId: string, num: string, notes: string | null = null) =>
    asUser(who, (c: any) =>
      call(c, 'phoenix_recall_outlet_inbound_movement', [moveId, num, notes]));

  // ══════════════════════════════════════════════════════════════════════════
  // 0. STRUCTURE AND PRIVILEGE SURFACE
  // ══════════════════════════════════════════════════════════════════════════
  describe('0. structure and privilege surface', () => {
    it('creates the corridor-scoped uniqueness index and retires the org-scoped one', async () => {
      const r = await one(
        `SELECT (SELECT count(*) FROM pg_class WHERE relname='orr_corridor_number_uniq')::int AS neu,
                (SELECT count(*) FROM pg_class WHERE relname='orr_src_org_number_uniq')::int AS alt`);
      expect(r.neu).toBe(1);
      expect(r.alt).toBe(0);
    });

    it('defines the F3 selector RPC and the single shared obligation writer', async () => {
      const r = await one(
        `SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public'
                    AND p.proname='_phoenix_materialize_outlet_recall_obligation_v1')::int AS writer,
                (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public'
                    AND p.proname='phoenix_recall_outlet_inbound_movement')::int AS rpc`);
      expect(r.writer).toBe(1);
      expect(r.rpc).toBe(1);
    });

    it('grants the public F3 RPC to authenticated ONLY — never anon, never PUBLIC', async () => {
      const r = await one(
        `SELECT has_function_privilege('authenticated',
                  'public.phoenix_recall_outlet_inbound_movement(uuid,text,text)'::regprocedure,
                  'EXECUTE') AS auth,
                has_function_privilege('anon',
                  'public.phoenix_recall_outlet_inbound_movement(uuid,text,text)'::regprocedure,
                  'EXECUTE') AS anon`);
      expect(r.auth).toBe(true);
      expect(r.anon).toBe(false);
    });

    it('grants PUBLIC no EXECUTE on the F3 RPC', async () => {
      const r = await rows(
        `SELECT a.grantee
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
                LATERAL aclexplode(p.proacl) a
          WHERE n.nspname='public' AND p.proname='phoenix_recall_outlet_inbound_movement'
            AND a.grantee = 0`);
      expect(r).toEqual([]);
    });

    it.each([
      ['_phoenix_outlet_return_outstanding_v1', 'uuid,uuid,uuid[],text'],
      ['_phoenix_outlet_recall_exposure_v1', 'uuid,uuid'],
      ['_phoenix_materialize_outlet_recall_obligation_v1', 'uuid,text,text,uuid,text,uuid'],
      ['_phoenix_validate_outlet_return_review_cap_v1', 'uuid,jsonb'],
      ['_phoenix_outlet_suggestion_commitment_v1', 'uuid,uuid,uuid[]'],
    ])('keeps private helper %s closed to every browser principal', async (fn, sig) => {
      const r = await one(
        `SELECT EXISTS (
           SELECT 1 FROM pg_roles r
            WHERE r.rolname IN ('anon','authenticated')
              AND has_function_privilege(r.oid,
                    'public.${fn}(${sig})'::regprocedure::oid, 'EXECUTE')) AS leaked,
         EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
                LATERAL aclexplode(p.proacl) a
            WHERE n.nspname='public' AND p.proname='${fn}' AND a.grantee = 0) AS pub`);
      expect(r.leaked).toBe(false);
      expect(r.pub).toBe(false);
    });

    it('closes the NEW H1 suggestion helper to service_role too', async () => {
      // Migration 109 grants EXECUTE to service_role by default on every new
      // function, so a private helper needs its revoke to name service_role
      // explicitly. This one does.
      const r = await one(
        `SELECT has_function_privilege('service_role',
                  'public._phoenix_outlet_suggestion_commitment_v1(uuid,uuid,uuid[])'::regprocedure,
                  'EXECUTE') AS svc`);
      expect(r.svc).toBe(false);
    });

    it('introduces no new permission key — F3 reuses 071 outlet_stock.recall', async () => {
      const keys = await rows(
        `SELECT key FROM permission_keys WHERE key ILIKE '%recall%' ORDER BY key`);
      // EXACTLY the two pre-existing recall keys. F3 adds none.
      expect(keys.map((x: any) => x.key)).toEqual(
        ['outlet_stock.recall', 'warehouse_transfer.recall']);
    });

    it('leaves the canonical outlet_stock.recall role matrix exactly as 071 set it', async () => {
      const d = await rows(
        `SELECT role, allowed FROM role_permission_defaults
          WHERE permission_key='outlet_stock.recall' ORDER BY role`);
      // warehouse_officer holds it; central_warehouse_manager does NOT (separation
      // of duty) and health_center_manager is not in the matrix at all.
      expect(d).toEqual([
        { role: 'central_warehouse_manager', allowed: false },
        { role: 'institution_admin',         allowed: false },
        { role: 'outlet_officer',            allowed: false },
        { role: 'super_admin',               allowed: true  },
        { role: 'warehouse_officer',         allowed: true  },
      ]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. TOPOLOGY — asserted, never forced
  // ══════════════════════════════════════════════════════════════════════════
  describe('1. outlet topology under 181/183', () => {
    it('permits a crash_cabinet at a facility-bound health-centre depot', async () => {
      const ok = await permitted(() => admin(
        `INSERT INTO distribution_points
           (id,organization_id,name,name_ar,point_type,status,warehouse_id,clinical_location_kind)
         VALUES ($1,$2,'HC1 Crash','خزانة','crash_cabinet','active',$3,'emergency')
         ON CONFLICT (id) DO NOTHING`, [DP3, ORG_SEC, W2]));
      expect(ok).toBe(true);
    });

    it('REFUSES a rescue_cart in a health sector — the topology is not forced', async () => {
      const ok = await permitted(() => admin(
        `INSERT INTO distribution_points
           (id,organization_id,name,name_ar,point_type,status,warehouse_id)
         VALUES ($1,$2,'Sector Cart','عربة','rescue_cart','active',$3)`,
        ['00000000-0000-0000-0000-0000001853e4', ORG_SEC, W2]));
      expect(ok).toBe(false);
    });

    it('permits a rescue_cart at a hospital warehouse with emergency context', async () => {
      const ok = await permitted(() => admin(
        `INSERT INTO distribution_points
           (id,organization_id,name,name_ar,point_type,status,warehouse_id,clinical_location_kind)
         VALUES ($1,$2,'Hosp Cart','عربة','rescue_cart','active',$3,'emergency')
         ON CONFLICT (id) DO NOTHING`,
        ['00000000-0000-0000-0000-0000001853e5', ORG_OTH, WOTH]));
      expect(ok).toBe(true);
    });

    it('REFUSES any outlet at the sector MAIN warehouse (181 depot rule)', async () => {
      const ok = await permitted(() => admin(
        `INSERT INTO distribution_points
           (id,organization_id,name,name_ar,point_type,status,warehouse_id)
         VALUES ($1,$2,'Main Pharm','صيدلية','pharmacy','active',$3)`,
        ['00000000-0000-0000-0000-0000001853e6', ORG_SEC, W1]));
      expect(ok).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. WAREHOUSE ROOT -> OUTLET PROPAGATION
  // ══════════════════════════════════════════════════════════════════════════
  describe('2. warehouse-root recall reaches the outlet holder', () => {
    it('binds W1, W2 and the outlet, sized to CURRENT outlet custody, moving nothing', async () => {
      const m = uniq('f3-a');
      const root = await hop(W0, ORG_SEC, W1, 100, m, null);
      const down = await hop(W1, ORG_SEC, W2, 60, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 25);

      expect(await outletAvail(d.outletStock)).toBe(25);
      expect(await custody(down.stock)).toBe(35);

      const before = await census();
      const num = uniq('F3A');
      const res: any = await recallRoot(num, root.tl);
      expect(res.obligations_created).toBe(3);   // W1, W2, outlet

      const ol = await outletLines(num);
      expect(ol).toHaveLength(1);
      expect(ol[0].qty).toBe(25);
      expect(ol[0].reason_code).toBe('recalled');
      // REAL provenance on all three legs — nothing fabricated.
      expect(ol[0].dl).toBe(d.dlId);
      expect(ol[0].mv).toBe(d.moveId);
      expect(ol[0].mvtype).toBe('dispatch_receive');
      expect(ol[0].os).toBe(d.outletStock);
      // The corridor is DERIVED: the outlet returns to its OWN warehouse, not Central.
      expect(ol[0].dp).toBe(DP1);
      expect(ol[0].dw).toBe(W2);
      expect(ol[0].side).toBe('sender');
      expect(ol[0].hstatus).toBe('draft');

      expect(await census()).toEqual(before);    // ZERO physical movement at creation
    });

    it('raises separate headers per outlet corridor under ONE external reference', async () => {
      const m = uniq('f3-b');
      const root = await hop(W0, ORG_SEC, W1, 100, m, null);
      const dw2 = await hop(W1, ORG_SEC, W2, 40, m, root.stock);
      const dw3 = await hop(W1, ORG_SEC, W3, 40, m, root.stock);
      await dispatch(W2, DP1, dw2.stock, 20);
      await dispatch(W3, DP2, dw3.stock, 15);

      const num = uniq('F3B');
      await recallRoot(num, root.tl);            // must not raise a raw 23505

      const ol = await outletLines(num);
      expect(ol).toHaveLength(2);
      expect(new Set(ol.map((x: any) => x.dp)).size).toBe(2);
      expect(ol.find((x: any) => x.dp === DP1).qty).toBe(20);
      expect(ol.find((x: any) => x.dp === DP2).qty).toBe(15);

      const h = await one(
        `SELECT count(*)::int AS n FROM outlet_return_requests WHERE btrim(return_number)=$1`, [num]);
      expect(h.n).toBe(2);                        // same reference, different corridors
    });

    it('recalls only CURRENT custody — dispensed units are terminal', async () => {
      const m = uniq('f3-c');
      const root = await hop(W0, ORG_SEC, W1, 100, m, null);
      const down = await hop(W1, ORG_SEC, W2, 60, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 30);

      await asSuper((c: any) => call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), d.outletStock, 12, 'patient dispensing', null]));
      const avail = await outletAvail(d.outletStock);
      expect(avail).toBe(18);

      const num = uniq('F3C');
      await recallRoot(num, root.tl);
      const ol = await outletLines(num);
      expect(ol[0].qty).toBe(avail);
      expect(ol[0].qty).toBeLessThan(30);
    });

    it('creates no stale obligation when the outlet stock is fully consumed', async () => {
      const m = uniq('f3-d');
      const root = await hop(W0, ORG_SEC, W1, 80, m, null);
      const down = await hop(W1, ORG_SEC, W2, 50, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 20);

      await asSuper((c: any) => call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), d.outletStock, 20, 'fully dispensed', null]));
      expect(await outletAvail(d.outletStock)).toBe(0);

      const num = uniq('F3D');
      await recallRoot(num, root.tl);
      const ol = await outletLines(num);
      // Warehouse holders may still be bound; the exhausted OUTLET must not be.
      expect(ol.filter((x: any) => x.os === d.outletStock)).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. THE STANDALONE SELECTOR RPC, IDOR AND REPLAY
  // ══════════════════════════════════════════════════════════════════════════
  describe('3. standalone selector, authority and replay', () => {
    it('works under a canonical warehouse_officer scope with zero overrides', async () => {
      const m = uniq('f3-e');
      const root = await hop(W0, ORG_SEC, W1, 60, m, null);
      const down = await hop(W1, ORG_SEC, W2, 40, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 18);

      const res: any = await recallOutlet(WO2, d.moveId, uniq('F3E'));
      expect(res.obligations_created).toBe(1);
      // MINIMAL RESPONSE: counts and the caller's own reference only.
      expect(Object.keys(res).sort()).toEqual(
        ['obligations_created', 'obligations_reused', 'ok', 'return_number']);
    });

    it('makes a foreign REAL selector indistinguishable from a nonexistent one', async () => {
      const m = uniq('f3-f');
      const root = await hop(W0, ORG_SEC, W1, 60, m, null);
      const down = await hop(W1, ORG_SEC, W2, 40, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 18);

      const foreign = await failure(() => recallOutlet(OUT, d.moveId, uniq('IDOR')));
      const missing = await failure(() => recallOutlet(OUT, randomUUID(), uniq('IDOR')));
      expect(foreign.msg).toBe('forbidden_outlet_recall');
      expect(foreign.msg).toBe(missing.msg);
      expect(foreign.code).toBe(missing.code);
    });

    it('denies central_warehouse_manager — 071 separation of duty', async () => {
      const m = uniq('f3-g');
      const root = await hop(W0, ORG_SEC, W1, 60, m, null);
      const down = await hop(W1, ORG_SEC, W2, 40, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 18);
      const e = await failure(() => recallOutlet(CWM1, d.moveId, uniq('CWM')));
      expect(e.msg).toBe('forbidden_outlet_recall');
    });

    it('denies health_center_manager — no HCM mutation widening', async () => {
      const m = uniq('f3-h');
      const root = await hop(W0, ORG_SEC, W1, 60, m, null);
      const down = await hop(W1, ORG_SEC, W2, 40, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 18);
      const e = await failure(() => recallOutlet(HCM, d.moveId, uniq('HCM')));
      expect(e.msg).toBe('forbidden_outlet_recall');
    });

    it('reuses on replay of the same selector + reference, and never double-books', async () => {
      const m = uniq('f3-i');
      const root = await hop(W0, ORG_SEC, W1, 50, m, null);
      const down = await hop(W1, ORG_SEC, W2, 30, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 12);

      const ref = uniq('F3I');
      const a: any = await recallOutlet(WO2, d.moveId, ref);
      const b: any = await recallOutlet(WO2, d.moveId, ref);
      expect(a.obligations_created).toBe(1);
      expect(b.obligations_created).toBe(0);
      expect(b.obligations_reused).toBe(1);

      // A DIFFERENT reference cannot manufacture a second claim on the same units.
      const c: any = await recallOutlet(WO2, d.moveId, uniq('F3I2'));
      expect(c.obligations_created).toBe(0);
      expect(await liveOnStock(d.outletStock))
        .toBeLessThanOrEqual(await outletAvail(d.outletStock));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. MERGED PROVENANCE — the conservative policy, stated and proven
  // ══════════════════════════════════════════════════════════════════════════
  describe('4. merged provenance into one canonical outlet lot', () => {
    it('caps total exposure at PHYSICAL custody when two receipts merge', async () => {
      const m = uniq('f3-j');
      const root = await hop(W0, ORG_SEC, W1, 200, m, null);
      const down = await hop(W1, ORG_SEC, W2, 120, m, root.stock);

      // Two genuine dispatch receipts of the SAME canonical material to the SAME
      // outlet — they merge into one outlet_stock row.
      const d1 = await dispatch(W2, DP1, down.stock, 30);
      const d2 = await dispatch(W2, DP1, down.stock, 20);
      expect(d2.outletStock).toBe(d1.outletStock);      // genuinely merged
      expect(d1.dlId).not.toBe(d2.dlId);                // distinct provenance anchors
      const shelf = await outletAvail(d1.outletStock);
      expect(shelf).toBe(50);

      // Recall BOTH provenances under different references.
      const r1: any = await recallOutlet(WO2, d1.moveId, uniq('F3J1'));
      const r2: any = await recallOutlet(WO2, d2.moveId, uniq('F3J2'));
      expect(r1.obligations_created).toBe(1);
      expect(r2.obligations_created).toBe(1);

      // Each obligation retains its OWN real provenance — no attribution invented.
      const l1 = await rows(
        `SELECT original_dispatch_line_id AS dl, original_inbound_movement_id AS mv,
                source_outlet_stock_id AS os, requested_quantity::int AS qty
           FROM outlet_return_request_lines
          WHERE original_inbound_movement_id IN ($1,$2) ORDER BY created_at`,
        [d1.moveId, d2.moveId]);
      expect(l1).toHaveLength(2);
      expect(l1.map((x: any) => x.dl).sort()).toEqual([d1.dlId, d2.dlId].sort());
      expect(new Set(l1.map((x: any) => x.os))).toEqual(new Set([d1.outletStock]));

      // THE INVARIANT: global live obligation never exceeds physical custody.
      const live = await liveOnStock(d1.outletStock);
      expect(live).toBeLessThanOrEqual(shelf);
      expect(live).toBe(50);
    });

    it('under-recalls rather than fabricating attribution once custody is short', async () => {
      const m = uniq('f3-k');
      const root = await hop(W0, ORG_SEC, W1, 200, m, null);
      const down = await hop(W1, ORG_SEC, W2, 120, m, root.stock);
      const d1 = await dispatch(W2, DP1, down.stock, 40);
      const d2 = await dispatch(W2, DP1, down.stock, 40);
      expect(d2.outletStock).toBe(d1.outletStock);

      // Dispense most of the merged shelf: exact per-unit attribution is now gone.
      await asSuper((c: any) => call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), d1.outletStock, 55, 'patient dispensing', null]));
      const shelf = await outletAvail(d1.outletStock);
      expect(shelf).toBe(25);

      const r1: any = await recallOutlet(WO2, d1.moveId, uniq('F3K1'));
      const r2: any = await recallOutlet(WO2, d2.moveId, uniq('F3K2'));

      const live = await liveOnStock(d1.outletStock);
      // Total conservative exposure is capped by the SHELF, strictly below the
      // 80 units originally received across the two selected provenances.
      expect(live).toBe(shelf);
      expect(live).toBeLessThan(80);
      expect(r1.obligations_created + r2.obligations_created).toBeGreaterThanOrEqual(1);
    });

    it('never lets a second provenance overdraw what the first already claimed', async () => {
      const m = uniq('f3-l');
      const root = await hop(W0, ORG_SEC, W1, 120, m, null);
      const down = await hop(W1, ORG_SEC, W2, 90, m, root.stock);
      const d1 = await dispatch(W2, DP1, down.stock, 30);
      const d2 = await dispatch(W2, DP1, down.stock, 30);
      const shelf = await outletAvail(d1.outletStock);

      expect(shelf).toBe(60);

      await recallOutlet(WO2, d1.moveId, uniq('F3L1'));
      const afterFirst = await liveOnStock(d1.outletStock);
      await recallOutlet(WO2, d2.moveId, uniq('F3L2'));
      const afterSecond = await liveOnStock(d1.outletStock);

      // EXACT arithmetic, not a monotonicity tautology: the first recall is
      // capped by its own 30-unit provenance, the second by what the shelf has
      // left after the first already claimed 30.
      expect(afterFirst).toBe(30);
      expect(afterSecond).toBe(60);
      expect(afterSecond).toBeLessThanOrEqual(shelf);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. MATERIAL IDENTITY AND LEGACY FAIL-CLOSED
  // ══════════════════════════════════════════════════════════════════════════
  describe('5. identity and legacy surfaces fail closed', () => {
    it('does not propagate a warehouse recall across a different material identity', async () => {
      const mA = uniq('f3-m1');
      const mB = uniq('f3-m2');
      const rootA = await hop(W0, ORG_SEC, W1, 60, mA, null);
      const downA = await hop(W1, ORG_SEC, W2, 40, mA, rootA.stock);
      const dA = await dispatch(W2, DP1, downA.stock, 15);

      // An unrelated material on the same corridor must never be swept in.
      const rootB = await hop(W0, ORG_SEC, W1, 60, mB, null);
      const downB = await hop(W1, ORG_SEC, W2, 40, mB, rootB.stock);
      const dB = await dispatch(W2, DP1, downB.stock, 15);
      expect(dB.outletStock).not.toBe(dA.outletStock);

      const num = uniq('F3M');
      await recallRoot(num, rootA.tl);
      const ol = await outletLines(num);
      expect(ol.every((x: any) => x.os === dA.outletStock)).toBe(true);
      expect(ol.some((x: any) => x.os === dB.outletStock)).toBe(false);
    });

    it('fails the legacy header-only outlet recall closed, mutating nothing', async () => {
      const before = await one(
        `SELECT (SELECT count(*)::int FROM outlet_return_requests) AS r,
                (SELECT count(*)::int FROM outlet_return_request_lines) AS l,
                (SELECT count(*)::int FROM audit_logs) AS a`);
      const e = await failure(() => asUser(WO2, (c: any) =>
        call(c, 'phoenix_recall_outlet_stock', [DP1, uniq('LEG'), null])));
      expect(e.msg).toBe('recall_selector_required');
      const after = await one(
        `SELECT (SELECT count(*)::int FROM outlet_return_requests) AS r,
                (SELECT count(*)::int FROM outlet_return_request_lines) AS l,
                (SELECT count(*)::int FROM audit_logs) AS a`);
      expect(after).toEqual(before);
    });

    it('preserves the legacy signature rather than dropping a granted public surface', async () => {
      const r = await one(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_recall_outlet_stock'`);
      expect(r.n).toBe(1);
    });

    it('rejects a NULL return number and a NULL selector before any lookup', async () => {
      const a = await failure(() => asUser(WO2, (c: any) =>
        call(c, 'phoenix_recall_outlet_inbound_movement', [null, uniq('X'), null])));
      expect(a.msg).toBe('original_inbound_movement_id_required');
      const b = await failure(() => asUser(WO2, (c: any) =>
        call(c, 'phoenix_recall_outlet_inbound_movement', [randomUUID(), '   ', null])));
      expect(b.msg).toBe('return_number_required');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. FULL LIFECYCLE TO MANDATORY QUARANTINE — canonical roles, zero overrides
  // ══════════════════════════════════════════════════════════════════════════
  describe('6. recalled obligation completes the real lifecycle', () => {
    it('runs recall -> submit -> review -> send -> receive into MANDATORY quarantine', async () => {
      const m = uniq('f3-n');
      const root = await hop(W0, ORG_SEC, W1, 90, m, null);
      const down = await hop(W1, ORG_SEC, W2, 60, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 24);

      // 1. RECALL — warehouse_officer scoped at the outlet's own warehouse.
      const ref = uniq('F3N');
      const rc: any = await recallOutlet(WO2, d.moveId, ref);
      expect(rc.obligations_created).toBe(1);

      const line = await one(
        `SELECT l.id, l.return_request_id AS req, l.requested_quantity::int AS qty, l.reason_code
           FROM outlet_return_request_lines l
           JOIN outlet_return_requests r ON r.id = l.return_request_id
          WHERE btrim(r.return_number)=$1`, [ref]);
      expect(line.reason_code).toBe('recalled');
      expect(line.qty).toBe(24);

      // 2. SUBMIT — a recall header is requested_by_side='sender', so 071 asks for
      // outlet_stock.recall at the header's DESTINATION warehouse, not at the
      // outlet. The warehouse that owns the outlet therefore submits its own
      // recall; the outlet officer's return_request path is the RECEIVER-side
      // voluntary return, which this is not.
      await asUser(WO2, (c: any) =>
        call(c, 'phoenix_submit_outlet_return_request', [line.req]));
      expect((await one(`SELECT status FROM outlet_return_requests WHERE id=$1`, [line.req])).status)
        .toBe('submitted');

      // 3. REVIEW — warehouse_officer at the destination warehouse.
      await asUser(WO2, (c: any) =>
        call(c, 'phoenix_review_outlet_return_request',
          [line.req, JSON.stringify([{ line_id: line.id, approved_quantity: 24 }])]));

      // 4. SEND — the outlet ships the physical units off its shelf. A NULL
      // shipment id opens the shipment from the given shipment_number.
      const sent: any = await asUser(OO1, (c: any) =>
        call(c, 'phoenix_send_outlet_return_shipment_line',
          [randomUUID(), line.id, null, 24, uniq('SHP'), uniq('DOC'), null]));
      const shipLineId = sent.shipment_line_id ?? sent.return_shipment_line_id ?? sent.id;
      expect(shipLineId).toBeTruthy();
      expect(await outletAvail(d.outletStock)).toBe(0);   // custody genuinely left

      const qBefore = (await one(
        `SELECT COALESCE(sum(quantity),0)::int AS q FROM warehouse_quarantine_stock`)).q;

      // 5. RECEIVE at the warehouse — warehouse_officer holds return_receive.
      await asUser(WO2, (c: any) =>
        call(c, 'phoenix_receive_outlet_return_shipment_line',
          [randomUUID(), shipLineId, 24, null, null, null]));

      // MANDATORY QUARANTINE: a recalled return may never re-enter sellable stock.
      const qAfter = (await one(
        `SELECT COALESCE(sum(quantity),0)::int AS q FROM warehouse_quarantine_stock`)).q;
      expect(qAfter - qBefore).toBe(24);

      const custodyState = await one(
        `SELECT custody_state FROM outlet_return_shipment_lines WHERE id=$1`, [shipLineId]);
      expect(custodyState.custody_state).toBe('destination_quarantine');
    });

    it('denies every lifecycle leg to health_center_manager — no mutation widening', async () => {
      const m = uniq('f3-o');
      const root = await hop(W0, ORG_SEC, W1, 60, m, null);
      const down = await hop(W1, ORG_SEC, W2, 40, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 10);
      const ref = uniq('F3O');
      await recallOutlet(WO2, d.moveId, ref);
      const line = await one(
        `SELECT l.id, l.return_request_id AS req
           FROM outlet_return_request_lines l
           JOIN outlet_return_requests r ON r.id = l.return_request_id
          WHERE btrim(r.return_number)=$1`, [ref]);

      const submit = await failure(() => asUser(HCM, (c: any) =>
        call(c, 'phoenix_submit_outlet_return_request', [line.req])));
      expect(submit.code).toBe('42501');

      await asUser(WO2, (c: any) => call(c, 'phoenix_submit_outlet_return_request', [line.req]));
      const review = await failure(() => asUser(HCM, (c: any) =>
        call(c, 'phoenix_review_outlet_return_request',
          [line.req, JSON.stringify([{ line_id: line.id, approved_quantity: 1 }])])));
      expect(review.code).toBe('42501');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. MIGRATION-150 SUGGESTION COMMITMENTS SURVIVE THE F3 EXTENSION
  // ══════════════════════════════════════════════════════════════════════════
  describe('7. inventory suggestion commitments still consume provenance', () => {
    it('reduces the reviewable quantity by exactly the live suggestion commitment', async () => {
      const m = uniq('f3-p');
      const root = await hop(W0, ORG_SEC, W1, 120, m, null);
      const down = await hop(W1, ORG_SEC, W2, 80, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 40);

      // Drive the REAL suggestion generator: outlet holds excess, warehouse is
      // below its reorder point, so 148/149 raise an outlet_to_warehouse
      // suggestion anchored on this very dispatch line.
      await admin(
        `INSERT INTO inventory_signal_thresholds
           (organization_id,scope_kind,scope_id,scientific_name,target_max,is_active)
         VALUES ($1,'outlet',$2,$3,10,true)`, [ORG_SEC, DP1, m]);
      await admin(
        `INSERT INTO inventory_signal_thresholds
           (organization_id,scope_kind,scope_id,scientific_name,reorder_point,is_active)
         VALUES ($1,'warehouse',$2,$3,100,true)`, [ORG_SEC, W2, m]);
      await asSuper(async (c: any) => {
        await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_SEC]);
        await c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG_SEC]);
      });

      const sug = await one(
        `SELECT id, suggested_quantity::int AS q FROM inventory_transfer_suggestions
          WHERE route_kind='outlet_to_warehouse' AND provenance_dispatch_line_id=$1
            AND status IN ('open','accepted')
          ORDER BY created_at DESC LIMIT 1`, [d.dlId]);
      expect(sug?.id).toBeTruthy();

      // The commitment the 150 term will subtract, read through 149's own helper.
      const commitment = (await one(
        `SELECT COALESCE(sum(c.provenance_commitment),0)::int AS n
           FROM inventory_transfer_suggestions s
           CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
          WHERE s.id=$1 AND c.is_active`, [sug.id])).n;
      expect(commitment).toBeGreaterThan(0);

      // Now recall the same provenance and try to approve the WHOLE receipt.
      const ref = uniq('F3P');
      await recallOutlet(WO2, d.moveId, ref);
      const line = await one(
        `SELECT l.id, l.return_request_id AS req, l.requested_quantity::int AS qty
           FROM outlet_return_request_lines l
           JOIN outlet_return_requests r ON r.id = l.return_request_id
          WHERE btrim(r.return_number)=$1`, [ref]);
      await asUser(WO2, (c: any) => call(c, 'phoenix_submit_outlet_return_request', [line.req]));

      const received = (await one(
        `SELECT COALESCE(received_quantity,0)::int AS r, returned_quantity::int AS ret
           FROM warehouse_dispatch_lines WHERE id=$1`, [d.dlId]));
      // 150's provenance budget: received - returned - suggestion commitment.
      const allowable = received.r - received.ret - commitment;

      // R1.5-H1 PARITY. Sizing and the review cap now agree on a commitment that
      // ALREADY existed when the recall was created, so the obligation is not
      // manufactured oversized. Before H1 this was `allowable < line.qty`.
      expect(line.qty).toBe(allowable);

      // One unit above the allowable must be refused...
      const over = await failure(() => asUser(WO2, (c: any) =>
        call(c, 'phoenix_review_outlet_return_request',
          [line.req, JSON.stringify([{ line_id: line.id, approved_quantity: allowable + 1 }])])));
      expect(over.code).toBe('23514');

      // ...and exactly the allowable quantity must pass.
      await asUser(WO2, (c: any) =>
        call(c, 'phoenix_review_outlet_return_request',
          [line.req, JSON.stringify([{ line_id: line.id, approved_quantity: allowable }])]));
      const approved = await one(
        `SELECT approved_quantity::int AS a FROM outlet_return_request_lines WHERE id=$1`, [line.id]);
      expect(approved.a).toBe(allowable);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. REAL TWO-SESSION CONCURRENCY
  // ══════════════════════════════════════════════════════════════════════════
  describe('8. genuine concurrent sessions', () => {
    /** An independent backend session with bounded waits — never hangs the harness. */
    async function openTx(actor: string) {
      const c = await rig.pool.connect();
      await c.query('BEGIN');
      await c.query(`SET LOCAL ROLE authenticated`);
      await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actor]);
      await c.query(`SET LOCAL statement_timeout='15s'`);
      await c.query(`SET LOCAL lock_timeout='12s'`);
      return c;
    }
    const finish = async (c: any, commit: boolean) => {
      try { await c.query(commit ? 'COMMIT' : 'ROLLBACK'); } finally { c.release(); }
    };

    /**
     * A genuine, RESOLVABLE two-session race.
     *
     * Session A runs to completion and keeps its transaction — and therefore its
     * advisory key, dispatch-line and outlet_stock locks — OPEN. Session B is
     * then issued and must block on them. Only once B is confirmed waiting in
     * pg_stat_activity is A committed, which lets B proceed and observe A's
     * committed effect.
     *
     * Firing both statements and awaiting both BEFORE committing either cannot
     * work here: the two sessions genuinely serialize, so the loser would sit on
     * a lock its counterpart never releases and could only ever end in
     * lock_timeout. A test shaped that way reports green while proving nothing.
     */
    async function raceSql(sqlA: string, paramsA: any[], sqlB: string, paramsB: any[],
                           actorA: string = WO2, actorB: string = WO2) {
      const a = await openTx(actorA);
      const b = await openTx(actorB);
      let errA: any = null, errB: any = null, resA: any = null, resB: any = null;
      let blocked = false;
      try {
        try { resA = (await a.query(sqlA, paramsA)).rows[0].r; }
        catch (e: any) { errA = e; }

        const bPid = Number((await b.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
        const pb = b.query(sqlB, paramsB)
          .then((x: any) => { resB = x.rows[0].r; })
          .catch((e: any) => { errB = e; });

        // Confirm B is genuinely WAITING before releasing A.
        for (let i = 0; i < 100 && !blocked; i++) {
          const w = await one(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE pid=$1 AND wait_event_type IN ('Lock','LWLock')`, [bPid]);
          if (w.n > 0) blocked = true; else await new Promise(res => setTimeout(res, 50));
        }

        await a.query('COMMIT');
        await pb;
        await b.query('COMMIT');
      } finally {
        a.release(); b.release();
      }
      return { resA, resB, errA, errB, blocked };
    }

    const RECALL_SQL = `SELECT public.phoenix_recall_outlet_inbound_movement($1,$2,NULL) AS r`;
    const race = (moveA: string, refA: string, moveB: string, refB: string) =>
      raceSql(RECALL_SQL, [moveA, refA], RECALL_SQL, [moveB, refB]);

    it('serializes two selectors racing the SAME point + reference into ONE header', async () => {
      const m = uniq('f3-q');
      const root = await hop(W0, ORG_SEC, W1, 120, m, null);
      const down = await hop(W1, ORG_SEC, W2, 80, m, root.stock);
      // Two DIFFERENT provenances converging on the same outlet corridor.
      const d1 = await dispatch(W2, DP1, down.stock, 20);
      const d2 = await dispatch(W2, DP1, down.stock, 20);

      const ref = uniq('F3Q');
      const r = await race(d1.moveId, ref, d2.moveId, ref);

      // BOTH sessions must genuinely complete — B only after waiting on A.
      expect(r.errA, `session A failed: ${r.errA?.message}`).toBeNull();
      expect(r.errB, `session B failed: ${r.errB?.message}`).toBeNull();
      expect(r.blocked, 'session B did not actually contend for the lock').toBe(true);
      // No raw uniqueness violation, no deadlock, no index name leaking out.
      for (const e of [r.errA, r.errB]) {
        if (e) {
          expect(e.code).not.toBe('23505');
          expect(e.code).not.toBe('40P01');
          expect(String(e.message)).not.toContain('orr_corridor_number_uniq');
        }
      }
      // ONE canonical header for the corridor + reference, carrying BOTH lines.
      const h = await one(
        `SELECT count(*)::int AS n FROM outlet_return_requests
          WHERE btrim(return_number)=$1 AND distribution_point_id=$2`, [ref, DP1]);
      expect(h.n).toBe(1);
      const lines = await one(
        `SELECT count(*)::int AS n FROM outlet_return_request_lines l
           JOIN outlet_return_requests q ON q.id=l.return_request_id
          WHERE btrim(q.return_number)=$1 AND q.distribution_point_id=$2`, [ref, DP1]);
      expect(lines.n).toBe(2);
    });

    it('never lets two concurrent provenances overdraw one outlet lot', async () => {
      const m = uniq('f3-r');
      const root = await hop(W0, ORG_SEC, W1, 200, m, null);
      const down = await hop(W1, ORG_SEC, W2, 150, m, root.stock);
      const d1 = await dispatch(W2, DP1, down.stock, 40);
      const d2 = await dispatch(W2, DP1, down.stock, 40);
      expect(d2.outletStock).toBe(d1.outletStock);

      // Cut physical custody well below the sum of the two receipts.
      await asSuper((c: any) => call(c, 'phoenix_dispense_outlet_stock',
        [randomUUID(), d1.outletStock, 50, 'patient dispensing', null]));
      const shelf = await outletAvail(d1.outletStock);
      expect(shelf).toBe(30);

      const r = await race(d1.moveId, uniq('F3R1'), d2.moveId, uniq('F3R2'));

      // BOTH sessions must genuinely complete, and B must genuinely have waited.
      // Without this the invariant below would be satisfied by ZERO obligations,
      // so a change that made both sessions time out would still report green.
      expect(r.errA, `session A failed: ${r.errA?.message}`).toBeNull();
      expect(r.errB, `session B failed: ${r.errB?.message}`).toBeNull();
      expect(r.blocked, 'session B did not actually contend for the lock').toBe(true);
      expect(r.errA?.code).not.toBe('40P01');   // no deadlock, no lock inversion
      expect(r.errB?.code).not.toBe('40P01');

      // A claims the whole 30-unit shelf; B, re-evaluating AFTER A commits, finds
      // the physical budget exhausted and creates nothing.
      expect(r.resA.obligations_created).toBe(1);
      expect(r.resB.obligations_created).toBe(0);
      // THE PHYSICAL INVARIANT under genuine concurrency: the two provenances
      // together claim EXACTLY the shelf, never more.
      expect(await liveOnStock(d1.outletStock)).toBe(shelf);
    });

    it('serializes two PENDING MANUAL returns on one provenance without deadlock', async () => {
      const m = uniq('f3-s');
      const root = await hop(W0, ORG_SEC, W1, 120, m, null);
      const down = await hop(W1, ORG_SEC, W2, 90, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 30);

      // Two independent RECEIVER-side manual return documents, same provenance.
      const h1: any = await asUser(OO1, (c: any) =>
        call(c, 'phoenix_request_outlet_return', [DP1, uniq('MAN1'), null]));
      const h2: any = await asUser(OO1, (c: any) =>
        call(c, 'phoenix_request_outlet_return', [DP1, uniq('MAN2'), null]));
      const id1 = h1.return_request_id ?? h1.id;
      const id2 = h2.return_request_id ?? h2.id;

      const ADD = `SELECT public.phoenix_add_outlet_return_request_line($1,$2,$3,$4,NULL,$5) AS r`;
      const r = await raceSql(
        ADD, [id1, d.dlId, 15, 'excess', randomUUID()],
        ADD, [id2, d.dlId, 15, 'excess', randomUUID()],
        OO1, OO1);

      // MANUAL-vs-MANUAL ARBITRATION: they serialize on the shared inv_provline
      // key rather than deadlocking, and neither is starved by the other.
      expect(r.blocked, 'second manual add-line did not contend').toBe(true);
      expect(r.errA?.code).not.toBe('40P01');
      expect(r.errB?.code).not.toBe('40P01');
      expect(r.errA, `manual A failed: ${r.errA?.message}`).toBeNull();
      expect(r.errB, `manual B failed: ${r.errB?.message}`).toBeNull();

      // Both fit inside the 30-unit receipt, so both stand — and the shared cap
      // predicate still holds them to the physical shelf.
      expect(await liveOnStock(d.outletStock)).toBeLessThanOrEqual(await outletAvail(d.outletStock));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. REPLAY REMAINS IDEMPOTENT THROUGH EVERY LIFECYCLE STAGE
  // ══════════════════════════════════════════════════════════════════════════
  describe('9. replay after each lifecycle transition', () => {
    it('reuses — never duplicates — after review, after SEND and after RECEIVE', async () => {
      const m = uniq('f3-t');
      const root = await hop(W0, ORG_SEC, W1, 90, m, null);
      const down = await hop(W1, ORG_SEC, W2, 60, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 18);

      const ref = uniq('F3T');
      const first: any = await recallOutlet(WO2, d.moveId, ref);
      expect(first.obligations_created).toBe(1);

      const line = await one(
        `SELECT l.id, l.return_request_id AS req
           FROM outlet_return_request_lines l
           JOIN outlet_return_requests r ON r.id = l.return_request_id
          WHERE btrim(r.return_number)=$1`, [ref]);

      /** A replay must never create a second header or a second line. */
      const assertReplayIsInert = async (stage: string) => {
        const res: any = await recallOutlet(WO2, d.moveId, ref);
        expect(res.obligations_created, `created at ${stage}`).toBe(0);
        expect(res.obligations_reused, `reused at ${stage}`).toBe(1);
        const c = await one(
          `SELECT (SELECT count(*)::int FROM outlet_return_requests
                    WHERE btrim(return_number)=$1 AND distribution_point_id=$2) AS hdrs,
                  (SELECT count(*)::int FROM outlet_return_request_lines l
                     JOIN outlet_return_requests q ON q.id=l.return_request_id
                    WHERE btrim(q.return_number)=$1 AND q.distribution_point_id=$2) AS lines`,
          [ref, DP1]);
        expect(c.hdrs, `headers at ${stage}`).toBe(1);
        expect(c.lines, `lines at ${stage}`).toBe(1);
      };

      await assertReplayIsInert('draft');

      await asUser(WO2, (c: any) => call(c, 'phoenix_submit_outlet_return_request', [line.req]));
      await asUser(WO2, (c: any) =>
        call(c, 'phoenix_review_outlet_return_request',
          [line.req, JSON.stringify([{ line_id: line.id, approved_quantity: 18 }])]));
      await assertReplayIsInert('after review');

      const sent: any = await asUser(OO1, (c: any) =>
        call(c, 'phoenix_send_outlet_return_shipment_line',
          [randomUUID(), line.id, null, 18, uniq('SHP'), uniq('DOC'), null]));
      const shipLineId = sent.shipment_line_id ?? sent.return_shipment_line_id ?? sent.id;
      await assertReplayIsInert('after SEND');

      await asUser(WO2, (c: any) =>
        call(c, 'phoenix_receive_outlet_return_shipment_line',
          [randomUUID(), shipLineId, 18, null, null, null]));
      await assertReplayIsInert('after RECEIVE into quarantine');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 10. R1.5-H1 · SUGGESTION COMMITMENTS PARTICIPATE IN RECALL SIZING
  // ══════════════════════════════════════════════════════════════════════════
  describe('10. suggestion commitments bind recall sizing', () => {
    /** Drive the REAL 148/149 generator into an outlet_to_warehouse suggestion. */
    async function makeSuggestion(material: string, dp: string, wh: string, targetMax: number) {
      await admin(
        `INSERT INTO inventory_signal_thresholds
           (organization_id,scope_kind,scope_id,scientific_name,target_max,is_active)
         VALUES ($1,'outlet',$2,$3,$4,true)`, [ORG_SEC, dp, material, targetMax]);
      await admin(
        `INSERT INTO inventory_signal_thresholds
           (organization_id,scope_kind,scope_id,scientific_name,reorder_point,is_active)
         VALUES ($1,'warehouse',$2,$3,100000,true)`, [ORG_SEC, wh, material]);
      await asSuper(async (c: any) => {
        await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG_SEC]);
        await c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG_SEC]);
      });
      const s = await one(
        `SELECT id, source_stock_id AS stock, provenance_dispatch_line_id AS dl
           FROM inventory_transfer_suggestions
          WHERE route_kind='outlet_to_warehouse' AND scientific_name=$1
            AND status IN ('open','accepted')
          ORDER BY created_at DESC LIMIT 1`, [material]);
      expect(s?.id, 'the real generator produced no outlet_to_warehouse suggestion').toBeTruthy();
      return s;
    }

    /** What the canonical 149 helper says is committed, by each key. */
    const suggestionByProvenance = async (dl: string) => (await one(
      `SELECT public._phoenix_outlet_suggestion_commitment_v1($1,NULL,NULL) AS n`, [dl])).n;
    const suggestionByStock = async (stockId: string) => (await one(
      `SELECT public._phoenix_outlet_suggestion_commitment_v1(NULL,$1,NULL) AS n`, [stockId])).n;

    it('binds source_stock_id to the outlet lot — the physical key is real', async () => {
      const m = uniq('f3-u');
      const root = await hop(W0, ORG_SEC, W1, 120, m, null);
      const down = await hop(W1, ORG_SEC, W2, 90, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 40);
      const s = await makeSuggestion(m, DP1, W2, 10);

      // A2 AUDIT, asserted rather than assumed: an outlet_to_warehouse suggestion
      // names THIS outlet lot as its source, so it is an actionable future debit
      // from that shelf — which is why the physical budget must subtract it.
      expect(s.stock).toBe(d.outletStock);
      expect(s.dl).toBe(d.dlId);
      expect(await suggestionByProvenance(d.dlId)).toBeGreaterThan(0);
      expect(await suggestionByStock(d.outletStock)).toBeGreaterThan(0);
    });

    it('reduces standalone recall sizing by exactly the live commitment', async () => {
      const m = uniq('f3-v');
      const root = await hop(W0, ORG_SEC, W1, 120, m, null);
      const down = await hop(W1, ORG_SEC, W2, 90, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 40);
      await makeSuggestion(m, DP1, W2, 10);

      const commitment = await suggestionByProvenance(d.dlId);
      expect(commitment).toBeGreaterThan(0);
      const shelf = await outletAvail(d.outletStock);

      const ref = uniq('F3V');
      const res: any = await recallOutlet(WO2, d.moveId, ref);
      expect(res.obligations_created).toBe(1);
      const line = await one(
        `SELECT l.requested_quantity::int AS qty FROM outlet_return_request_lines l
           JOIN outlet_return_requests r ON r.id=l.return_request_id
          WHERE btrim(r.return_number)=$1`, [ref]);

      // EXACT: the recall is sized to custody LESS the already-known commitment.
      expect(line.qty).toBe(shelf - commitment);
      // And the physical invariant now includes the suggestion.
      expect(await liveOnStock(d.outletStock) + commitment)
        .toBeLessThanOrEqual(shelf);
    });

    it('applies the same commitment to warehouse-root propagation', async () => {
      const m = uniq('f3-w');
      const root = await hop(W0, ORG_SEC, W1, 120, m, null);
      const down = await hop(W1, ORG_SEC, W2, 90, m, root.stock);
      const d = await dispatch(W2, DP1, down.stock, 40);
      await makeSuggestion(m, DP1, W2, 10);

      const commitment = await suggestionByProvenance(d.dlId);
      const shelf = await outletAvail(d.outletStock);
      expect(commitment).toBeGreaterThan(0);

      const num = uniq('F3W');
      await recallRoot(num, root.tl);
      const ol = (await outletLines(num)).filter((x: any) => x.os === d.outletStock);
      expect(ol).toHaveLength(1);
      // Root propagation shares the SAME writer, so it observes the same cap.
      expect(ol[0].qty).toBe(shelf - commitment);
    });

    it('never lets a suggestion on ONE provenance overdraw a merged shelf', async () => {
      const m = uniq('f3-x');
      const root = await hop(W0, ORG_SEC, W1, 200, m, null);
      const down = await hop(W1, ORG_SEC, W2, 150, m, root.stock);
      const d1 = await dispatch(W2, DP1, down.stock, 30);
      const d2 = await dispatch(W2, DP1, down.stock, 30);
      expect(d2.outletStock).toBe(d1.outletStock);   // genuinely merged
      await makeSuggestion(m, DP1, W2, 10);

      const shelf = await outletAvail(d1.outletStock);
      const stockCommitment = await suggestionByStock(d1.outletStock);
      expect(stockCommitment).toBeGreaterThan(0);

      // Recall BOTH provenances. The suggestion anchors only one of them, but it
      // draws on the shelf they share.
      await recallOutlet(WO2, d1.moveId, uniq('F3X1'));
      await recallOutlet(WO2, d2.moveId, uniq('F3X2'));

      // THE MERGED-LOT INVARIANT: return obligations plus the actionable
      // suggestion never exceed truthful current physical custody.
      const live = await liveOnStock(d1.outletStock);
      expect(live + stockCommitment).toBeLessThanOrEqual(shelf);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 11. R1.5-H1(B) · THE SELECTOR IDOR MATRIX
  // ══════════════════════════════════════════════════════════════════════════
  describe('11. unauthorized callers learn nothing about a selector', () => {
    let activeMove = '', inactiveMove = '', inactivePoint = '';

    beforeAll(async () => {
      // A dedicated outlet we may deactivate without disturbing DP1.
      inactivePoint = '00000000-0000-0000-0000-0000001853e7';
      await admin(
        `INSERT INTO distribution_points
           (id,organization_id,name,name_ar,point_type,status,warehouse_id)
         VALUES ($1,$2,'Closable Pharmacy','صيدلية','pharmacy','active',$3)
         ON CONFLICT (id) DO NOTHING`, [inactivePoint, ORG_SEC, W2]);

      const mA = uniq('f3-idor-a');
      const rA = await hop(W0, ORG_SEC, W1, 60, mA, null);
      const dA = await hop(W1, ORG_SEC, W2, 40, mA, rA.stock);
      activeMove = (await dispatch(W2, DP1, dA.stock, 10)).moveId;

      const mB = uniq('f3-idor-b');
      const rB = await hop(W0, ORG_SEC, W1, 60, mB, null);
      const dB = await hop(W1, ORG_SEC, W2, 40, mB, rB.stock);
      inactiveMove = (await dispatch(W2, inactivePoint, dB.stock, 10)).moveId;

      // Deactivate AFTER the receipt, so the selector is real but its point is not.
      await admin(`UPDATE distribution_points SET status='inactive' WHERE id=$1`,
        [inactivePoint]);
    }, 300000);

    it('gives an unauthorized caller one indistinguishable answer for every case',
      async () => {
        const cases: [string, string][] = [
          ['nonexistent uuid', randomUUID()],
          ['foreign ACTIVE selector', activeMove],
          ['foreign selector at an INACTIVE point', inactiveMove],
        ];
        const seen: string[] = [];
        for (const [label, moveId] of cases) {
          const e = await failure(() => recallOutlet(OUT, moveId, uniq('IDOR')));
          seen.push(`${e.msg}/${e.code}`);
          expect(e.msg, label).toBe('forbidden_outlet_recall');
          expect(e.code, label).toBe('42501');
          // No outlet, point, warehouse, org or status detail may cross back.
          expect(e.msg).not.toContain('inactive');
          expect(e.msg).not.toContain('distribution_point');
        }
        // SQLSTATE + token + shape identical across the whole matrix.
        expect(new Set(seen).size, `distinguishable answers: ${seen.join(' | ')}`).toBe(1);
      });

    it('gives a same-org actor WITHOUT the permission the same generic denial', async () => {
      const e1 = await failure(() => recallOutlet(CWM1, activeMove, uniq('IDOR')));
      const e2 = await failure(() => recallOutlet(CWM1, inactiveMove, uniq('IDOR')));
      const e3 = await failure(() => recallOutlet(CWM1, randomUUID(), uniq('IDOR')));
      for (const e of [e1, e2, e3]) {
        expect(e.msg).toBe('forbidden_outlet_recall');
        expect(e.code).toBe('42501');
      }
    });

    it('still gives the AUTHORIZED caller the specific business-state failure', async () => {
      // Integrity is not weakened for someone who genuinely holds the authority.
      const e = await failure(() => recallOutlet(WO2, inactiveMove, uniq('F3Y')));
      expect(e.msg).toBe('distribution_point_inactive');
      expect(e.code).toBe('23514');
    });

    it('leaves the authorized happy path intact', async () => {
      const res: any = await recallOutlet(WO2, activeMove, uniq('F3Z'));
      expect(res.ok).toBe(true);
      expect(res.obligations_created).toBe(1);
    });
  });
});
