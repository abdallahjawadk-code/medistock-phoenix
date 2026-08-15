/**
 * 184 · CANONICAL SUPPLY CYCLE (R1.3) — dynamic proof against a real 001->184 chain.
 *
 * 165 gave the direct-supply validator two branches. Branch B (same-sector) is
 * precise. Branch A was not: it accepted any destination that was merely
 * `warehouse_kind='institution' AND status='active'`. Because Branch B's SHAPE
 * test demands an INSTITUTION source, a CENTRAL source could never select it
 * and always fell through to Branch A — so `central -> facility-bound health
 * centre depot` was a legal server-side write, and symmetrically a centre depot
 * could return straight to central as if it were an ordinary institution root.
 *
 * This file proves the whole R1.3 matrix behaviourally:
 *
 *   A · EXTERNAL CENTRAL SUPPLY   — which destinations the corridor admits
 *   B · INTERNAL SECTOR CHAIN     — that 180/183's enforcement is undisturbed
 *   C · PROCUREMENT + EXCHANGE    — the entry root, and the third stock writer
 *   D · RETURNS                   — the exact mirror of A, plus provenance
 *
 * Two properties are asserted throughout rather than assumed:
 *
 *   * HISTORY IS NOT REWRITTEN. A legacy `central -> depot` transfer row seeded
 *     before the narrowing keeps existing and keeps its values; only the NEW
 *     write is judged. It also does not license a return.
 *   * A REFUSAL MOVES NOTHING. Proved by measuring row deltas, never by reading
 *     an exception string.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000 });

const run = rigAvailable() ? describe : describe.skip;

let seq = 0;
const uid = () => `00000000-0000-0000-0000-${String(184000000000 + (seq += 1))}`;

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  throw new Error('expected a rejection but the call succeeded');
};

// -- Organizations -----------------------------------------------------------
const ORG_PDA = uid(), ORG_HOSP = uid(), ORG_SPEC = uid();
const ORG_SECTOR = uid(), ORG_SECTOR2 = uid();
// -- Warehouses --------------------------------------------------------------
const WH_CENTRAL = uid();
const WH_HOSP = uid(), WH_HOSP_ALT = uid(), WH_SPEC = uid();
const SECTOR_MAIN = uid(), DEPOT_A = uid(), DEPOT_B = uid();
const SECTOR2_MAIN = uid(), DEPOT_C = uid();
// -- Facilities --------------------------------------------------------------
const FAC_A = uid(), FAC_B = uid(), FAC_C = uid();
// -- Historical transfers (route_id IS NULL = direct) ------------------------
const XFER_C_HOSP = uid(), XFER_C_SPEC = uid(), XFER_C_SECTOR = uid();
const XFER_SEC_A = uid(), XFER_LEGACY_C_DEPOT = uid();
// -- Actors ------------------------------------------------------------------
/** central_warehouse_manager scoped to the central warehouse — the real sender. */
const CWM = uid();

run('184 · canonical supply cycle (001->184 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  /** Direct validator call: supply (src, dst, optional named destination org). */
  const fwd = (src: string, dst: string, org: string | null = null) =>
    asAdmin(`SELECT * FROM public.phoenix_assert_direct_supply_endpoints($1,$2,$3)`, [src, dst, org])
      .then((r: any) => r.rows[0]);

  /** Direct validator call: return (arg1 = return SOURCE, arg2 = return DESTINATION). */
  const ret = (src: string, dst: string) =>
    asAdmin(`SELECT * FROM public.phoenix_assert_direct_return_endpoints($1,$2)`, [src, dst])
      .then((r: any) => r.rows[0]);

  /** The canonical procurement-root decision, called directly. */
  const procRoot = (wh: string) =>
    asAdmin(`SELECT public._phoenix_assert_local_procurement_root_v1($1)`, [wh]);

  const countRows = async (table: string): Promise<number> => {
    const r: any = await asAdmin(`SELECT count(*)::int AS n FROM public.${table}`);
    return r.rows[0].n;
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${ORG_PDA}',    'PDA184',   'دائرة',  'r13-pda','pharmacy_department_authority',NULL,'active'),
        ('${ORG_HOSP}',   'Hosp184',  'مستشفى', 'r13-h',  'care_institution','hospital','active'),
        ('${ORG_SPEC}',   'Spec184',  'تخصصي',  'r13-s',  'care_institution','specialized_center','active'),
        ('${ORG_SECTOR}', 'Sector184','قطاع',   'r13-q',  'care_institution','health_sector','active'),
        ('${ORG_SECTOR2}','Sect2-184','قطاع٢',  'r13-q2', 'care_institution','health_sector','active');

      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}', 'primary_health_center',    'A','أ','active'),
        ('${FAC_B}','${ORG_SECTOR}', 'subordinate_health_center','B','ب','active'),
        ('${FAC_C}','${ORG_SECTOR2}','primary_health_center',    'C','ج','active');

      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${WH_CENTRAL}',  '${ORG_PDA}',    'Central',    'مركزي',  'central',    NULL,      true, 'active'),
        ('${WH_HOSP}',     '${ORG_HOSP}',   'Hosp WH',    'مخزن م', 'institution',NULL,      true, 'active'),
        ('${WH_HOSP_ALT}', '${ORG_HOSP}',   'Hosp Alt',   'مخزن م٢','institution',NULL,      false,'active'),
        ('${WH_SPEC}',     '${ORG_SPEC}',   'Spec WH',    'مخزن ت', 'institution',NULL,      true, 'active'),
        ('${SECTOR_MAIN}', '${ORG_SECTOR}', 'Sector Main','رئيسي',  'institution',NULL,      true, 'active'),
        ('${DEPOT_A}',     '${ORG_SECTOR}', 'Depot A',    'مذخر أ', 'institution','${FAC_A}',false,'active'),
        ('${DEPOT_B}',     '${ORG_SECTOR}', 'Depot B',    'مذخر ب', 'institution','${FAC_B}',false,'active'),
        ('${SECTOR2_MAIN}','${ORG_SECTOR2}','Sector2 Main','رئيسي٢','institution',NULL,      true, 'active'),
        ('${DEPOT_C}',     '${ORG_SECTOR2}','Depot C',    'مذخر ج', 'institution','${FAC_C}',false,'active');

      -- Direct forward provenance (route_id IS NULL) for the legal return paths.
      -- These four are all LEGAL shapes, so they pass the direct boundary the
      -- same way the real RPCs do.
      INSERT INTO warehouse_transfers
        (id,route_id,source_warehouse_id,source_organization_id,
         destination_warehouse_id,destination_organization_id,transfer_number,status,sent_at) VALUES
        ('${XFER_C_HOSP}',  NULL,'${WH_CENTRAL}','${ORG_PDA}',   '${WH_HOSP}',  '${ORG_HOSP}',  'R13-X1','received',now()),
        ('${XFER_C_SPEC}',  NULL,'${WH_CENTRAL}','${ORG_PDA}',   '${WH_SPEC}',  '${ORG_SPEC}',  'R13-X2','received',now()),
        ('${XFER_C_SECTOR}',NULL,'${WH_CENTRAL}','${ORG_PDA}',   '${SECTOR_MAIN}','${ORG_SECTOR}','R13-X3','received',now()),
        ('${XFER_SEC_A}',   NULL,'${SECTOR_MAIN}','${ORG_SECTOR}','${DEPOT_A}', '${ORG_SECTOR}','R13-X4','received',now());`);

    // A LEGACY row of the shape 184 now forbids. It can only be created with the
    // boundary DISABLED — which is the point: after 184 that shape is not
    // writable, so the pre-184 state has to be simulated exactly the way the
    // legacy-route case is. Seeding it with a plain INSERT would have proved the
    // opposite of what this file claims.
    await asAdmin(`ALTER TABLE warehouse_transfers DISABLE TRIGGER phoenix_routed_forward_topology_guard`);
    try {
      await asAdmin(
        `INSERT INTO warehouse_transfers
           (id,route_id,source_warehouse_id,source_organization_id,
            destination_warehouse_id,destination_organization_id,transfer_number,status,sent_at)
         VALUES ($1,NULL,$2,$3,$4,$5,'R13-X5','received',now())`,
        [XFER_LEGACY_C_DEPOT, WH_CENTRAL, ORG_PDA, DEPOT_A, ORG_SECTOR]);
    } finally {
      await asAdmin(`ALTER TABLE warehouse_transfers ENABLE TRIGGER phoenix_routed_forward_topology_guard`);
    }

    await asAdmin(`

      -- A REAL sender. The routed-send proof must run as an authenticated
      -- principal holding warehouse_transfer.send on the central warehouse,
      -- because the RPC requires auth.uid() and its own scoped-permission gate
      -- would otherwise refuse before topology is ever reached.
      INSERT INTO auth.users (id,email) VALUES ('${CWM}','r13-cwm@rig')
        ON CONFLICT (id) DO NOTHING;
      UPDATE profiles SET role='central_warehouse_manager', status='active',
             organization_id='${ORG_PDA}' WHERE id='${CWM}';
      INSERT INTO profile_scope_assignments
        (profile_id, organization_id, scope_type, warehouse_id, is_active)
      VALUES ('${CWM}','${ORG_PDA}','warehouse','${WH_CENTRAL}',true)
        ON CONFLICT DO NOTHING;`);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ==========================================================================
  // A · EXTERNAL CENTRAL SUPPLY
  // ==========================================================================
  describe('A · external central supply', () => {
    it('PASS central -> hospital', async () => {
      const r = await fwd(WH_CENTRAL, WH_HOSP);
      expect(r.o_source_organization_id).toBe(ORG_PDA);
      expect(r.o_destination_organization_id).toBe(ORG_HOSP);
    });

    it('PASS central -> specialized center', async () => {
      const r = await fwd(WH_CENTRAL, WH_SPEC);
      expect(r.o_destination_organization_id).toBe(ORG_SPEC);
    });

    it('PASS central -> health-sector MAIN', async () => {
      const r = await fwd(WH_CENTRAL, SECTOR_MAIN);
      expect(r.o_destination_organization_id).toBe(ORG_SECTOR);
    });

    it('REJECT central -> health-centre depot (THE R1.3-A closure)', async () => {
      expect(await rejects(() => fwd(WH_CENTRAL, DEPOT_A)))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);
    });

    it('REJECT central -> a subordinate health-centre depot too', async () => {
      expect(await rejects(() => fwd(WH_CENTRAL, DEPOT_B)))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);
    });

    it('a PDA cannot own an institution warehouse at all (171), so it can never be a destination', async () => {
      // 171 confines a pharmacy_department_authority to CENTRAL warehouses, so
      // the "PDA as a corridor destination" shape is unconstructible. The
      // capsule's external_corridor_requires_care_institution branch is
      // therefore DEFENCE IN DEPTH — asserted here so relaxing that guard fails
      // this test instead of quietly admitting the PDA as a destination.
      const msg = await rejects(() => asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES (gen_random_uuid(),'${ORG_PDA}','PDA Inst','مخزن د','institution',NULL,false,'active')`));
      expect(msg).toMatch(/pharmacy_department_authority_requires_central_warehouse/);
    });

    it('an UNCLASSIFIED care institution cannot exist at all (171), so the corridor cannot meet one', async () => {
      // 171's organizations_kind_institution_class_chk already guarantees
      // care_institution => institution_class IS NOT NULL. The capsule's
      // organization_institution_class_required branch is therefore
      // DEFENCE IN DEPTH, not a reachable path — asserted here so a future
      // migration that relaxes the constraint fails this test rather than
      // silently opening the corridor to an unclassified destination.
      const msg = await rejects(() => asAdmin(
        `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
         VALUES (gen_random_uuid(),'Uncl184','غير','r13-u','care_institution',NULL,'active')`));
      expect(msg).toMatch(/organizations_kind_institution_class_chk/);
    });

    it('PASS sector main -> its own centre depot (Branch B, preserved)', async () => {
      const r = await fwd(SECTOR_MAIN, DEPOT_A);
      expect(r.o_source_organization_id).toBe(ORG_SECTOR);
      expect(r.o_destination_organization_id).toBe(ORG_SECTOR);
    });

    it('REJECT sector main -> a FOREIGN sector centre depot', async () => {
      // Different organizations, so Branch B's shape test cannot select it and
      // it falls to Branch A, where the source is not central.
      expect(await rejects(() => fwd(SECTOR_MAIN, DEPOT_C)))
        .toMatch(/source_must_be_active_central_warehouse/);
    });

    it('REJECT sibling centre -> centre forward supply', async () => {
      expect(await rejects(() => fwd(DEPOT_A, DEPOT_B)))
        .toMatch(/source_must_be_active_central_warehouse/);
    });

    it('REJECT centre depot -> its own sector main as a FORWARD supply', async () => {
      expect(await rejects(() => fwd(DEPOT_A, SECTOR_MAIN)))
        .toMatch(/source_must_be_active_central_warehouse/);
    });

    it('THE ROUTED CORRIDOR: a supply route to a centre depot is refused', async () => {
      // _phoenix_authorize_transfer_request_write only calls the direct
      // validator when route_id IS NULL, so a route was the other door to the
      // forbidden shape. The route validator now shares the same capsule.
      expect(await rejects(() => asAdmin(
        `SELECT public.phoenix_supply_route_assert_endpoints($1,$2)`, [WH_CENTRAL, DEPOT_A])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);
    });

    it('a raw supply-route INSERT to a centre depot is refused', async () => {
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_supply_routes (source_warehouse_id, target_warehouse_id, is_active)
         VALUES ($1,$2,true)`, [WH_CENTRAL, DEPOT_A])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);
    });

    it('a DORMANT legacy route survives, but REACTIVATING it is refused', async () => {
      // History is preserved: the inactive row keeps existing and keeps its
      // values. Only the transition INTO an active state is judged.
      const route = uid();
      await asAdmin(
        `INSERT INTO warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id, is_active)
         VALUES ($1,$2,$3,false)`, [route, WH_CENTRAL, DEPOT_A]);

      const stored: any = await asAdmin(
        `SELECT target_warehouse_id, is_active FROM warehouse_supply_routes WHERE id=$1`, [route]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].target_warehouse_id).toBe(DEPOT_A);
      expect(stored.rows[0].is_active).toBe(false);

      expect(await rejects(() => asAdmin(
        `UPDATE warehouse_supply_routes SET is_active=true WHERE id=$1`, [route])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);

      const after: any = await asAdmin(
        `SELECT is_active FROM warehouse_supply_routes WHERE id=$1`, [route]);
      expect(after.rows[0].is_active).toBe(false);
    });

    it('a route to a legal institution root is still accepted, and retargeting to a depot is refused', async () => {
      const route = uid();
      await asAdmin(
        `INSERT INTO warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id, is_active)
         VALUES ($1,$2,$3,true)`, [route, WH_CENTRAL, WH_HOSP]);
      const ok: any = await asAdmin(`SELECT is_active FROM warehouse_supply_routes WHERE id=$1`, [route]);
      expect(ok.rows[0].is_active).toBe(true);

      expect(await rejects(() => asAdmin(
        `UPDATE warehouse_supply_routes SET target_warehouse_id=$2 WHERE id=$1`, [route, DEPOT_A])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);

      // Released so the active-pair uniqueness constraint stays free for the
      // routed-request tests below.
      await asAdmin(`DELETE FROM warehouse_supply_routes WHERE id=$1`, [route]);
    });

    it('A PRE-EXISTING ACTIVE route cannot be USED, however it got there', async () => {
      // THE case the route-row trigger alone cannot cover: a route that was
      // already active when 184 was applied is never re-judged by that trigger,
      // and 077 validates topology only when route_id IS NULL. So the rule is
      // enforced where it is USED. Simulated faithfully by disabling the row
      // guard for the INSERT, which is exactly the state a 164->183 chain
      // could leave behind.
      const route = uid();
      await asAdmin(`ALTER TABLE warehouse_supply_routes DISABLE TRIGGER phoenix_supply_route_topology_guard`);
      try {
        await asAdmin(
          `INSERT INTO warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id, is_active)
           VALUES ($1,$2,$3,true)`, [route, WH_CENTRAL, DEPOT_A]);
      } finally {
        await asAdmin(`ALTER TABLE warehouse_supply_routes ENABLE TRIGGER phoenix_supply_route_topology_guard`);
      }

      // The legacy row survives untouched — history is not rewritten.
      const stored: any = await asAdmin(
        `SELECT is_active, target_warehouse_id FROM warehouse_supply_routes WHERE id=$1`, [route]);
      expect(stored.rows[0].is_active).toBe(true);
      expect(stored.rows[0].target_warehouse_id).toBe(DEPOT_A);

      // ...but it authorizes nothing. FORWARD, via the REQUEST table:
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_transfer_requests
           (route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id, request_number, status)
         VALUES ($1,$2,$3,$4,$5,'R13-ROUTED-1','draft')`,
        [route, WH_CENTRAL, ORG_PDA, DEPOT_A, ORG_SECTOR])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);

      // ...and via the MOVEMENT table, which is the one that actually carries
      // stock. The routed send (127) writes this header DIRECTLY with
      // transfer_request_id NULL, so a request-only boundary would never fire
      // for it — the exact shape of the bypass this closes.
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_transfers
           (route_id, transfer_request_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            transfer_number, status, sent_at)
         VALUES ($1,NULL,$2,$3,$4,$5,'R13-ROUTED-SEND','in_transit',now())`,
        [route, WH_CENTRAL, ORG_PDA, DEPOT_A, ORG_SECTOR])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);

      // ...and the return SHIPMENT table, symmetrically.
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_return_shipments
           (route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            shipment_number, status, sent_at)
         VALUES ($1,$2,$3,$4,$5,'R13-ROUTED-SHIP','in_transit',now())`,
        [route, DEPOT_A, ORG_SECTOR, WH_CENTRAL, ORG_PDA])))
        .toMatch(/central_return_source_must_not_be_facility_bound/);

      // ...and RETURN, which deactivating the route would NOT have closed
      // because the routed return path deliberately ignores is_active.
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_return_requests
           (route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id, return_number, status)
         VALUES ($1,$2,$3,$4,$5,'R13-ROUTED-2','draft')`,
        [route, DEPOT_A, ORG_SECTOR, WH_CENTRAL, ORG_PDA])))
        .toMatch(/central_return_source_must_not_be_facility_bound/);

      // THE REAL RPC. Raw INSERTs prove the boundary exists; only driving
      // phoenix_send_warehouse_transfer_line proves the corridor is actually
      // shut, because that function takes the ROUTE id directly, treats the
      // request line as optional, and reads both endpoints off the route row.
      const stock = uid();
      await asAdmin(
        `INSERT INTO warehouse_stock
           (id, organization_id, warehouse_id, scientific_name,
            has_no_national_code, has_no_batch_number, batch_number, expiry_date,
            on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'R13-ATTACK',true,false,'R13-B1','2030-01-01',100,0,0)`,
        [stock, ORG_PDA, WH_CENTRAL]);

      // The routed SEND, driven as the REAL scoped central_warehouse_manager so
      // the RPC's own auth.uid() and scoped-permission gates are genuinely
      // satisfied.
      //
      // p_request_id MUST be a real value. It is the idempotency key, and 150
      // raises request_id_required on a NULL one BEFORE any topology work — so
      // passing NULL here (and accepting that identifier as an alternative)
      // would abort at argument validation and prove nothing whatsoever about
      // 184. With a real key the RPC runs to the header INSERT it performs —
      // route_id set, transfer_request_id NULL, destination read off the route
      // row = the depot — and is refused by the boundary on warehouse_transfers.
      // The expected identifier is therefore asserted EXACTLY, with no
      // alternative that a non-topology failure could satisfy.
      const sendMsg = await rejects(() => rig.asUser(CWM, (c: any) => c.query(
        `SELECT public.phoenix_send_warehouse_transfer_line($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uid(), route, stock, 40, 'R13-ATTACK-XFER', null, null, null]), { commit: true }));
      expect(sendMsg).toMatch(/central_supply_destination_must_not_be_facility_bound/);

      // No stock may have reached the depot and no transfer header may exist
      // for this route.
      const moved: any = await asAdmin(
        `SELECT count(*)::int AS n FROM warehouse_stock WHERE warehouse_id=$1`, [DEPOT_A]);
      expect(moved.rows[0].n).toBe(0);
      const headers: any = await asAdmin(
        `SELECT count(*)::int AS n FROM warehouse_transfers WHERE route_id=$1`, [route]);
      expect(headers.rows[0].n).toBe(0);

      await asAdmin(`DELETE FROM warehouse_stock WHERE id=$1`, [stock]);
      await asAdmin(`DELETE FROM warehouse_supply_routes WHERE id=$1`, [route]);
    });

    it('a ROUTED request to a legal institution root is still accepted', async () => {
      // The routed boundary must narrow the corridor, not close it.
      const route = uid(), req = uid();
      await asAdmin(
        `INSERT INTO warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id, is_active)
         VALUES ($1,$2,$3,true)`, [route, WH_CENTRAL, WH_HOSP]);
      await asAdmin(
        `INSERT INTO warehouse_transfer_requests
           (id, route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id, request_number, status)
         VALUES ($1,$2,$3,$4,$5,$6,'R13-ROUTED-3','draft')`,
        [req, route, WH_CENTRAL, ORG_PDA, WH_HOSP, ORG_HOSP]);
      const r: any = await asAdmin(`SELECT count(*)::int AS n FROM warehouse_transfer_requests WHERE id=$1`, [req]);
      expect(r.rows[0].n).toBe(1);

      await asAdmin(`DELETE FROM warehouse_transfer_requests WHERE id=$1`, [req]);
      await asAdmin(`DELETE FROM warehouse_supply_routes WHERE id=$1`, [route]);
    });

    it('BRANCH B is untouched by the boundary — a DIRECT depot request still works', async () => {
      // Branch B writes warehouse_transfer_requests with route_id IS NULL and a
      // FACILITY-BOUND destination. The direct branch of the boundary delegates
      // to phoenix_assert_direct_supply_endpoints, of which Branch B IS a
      // branch — so the one corridor 184 exists to preserve stays open, and it
      // stays open for the right reason rather than because nothing looked.
      const req = uid();
      await asAdmin(
        `INSERT INTO warehouse_transfer_requests
           (id, route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id, request_number, status)
         VALUES ($1,NULL,$2,$3,$4,$5,'R13-BRANCHB-1','draft')`,
        [req, SECTOR_MAIN, ORG_SECTOR, DEPOT_A, ORG_SECTOR]);
      const r: any = await asAdmin(`SELECT count(*)::int AS n FROM warehouse_transfer_requests WHERE id=$1`, [req]);
      expect(r.rows[0].n).toBe(1);
      await asAdmin(`DELETE FROM warehouse_transfer_requests WHERE id=$1`, [req]);
    });

    // ------------------------------------------------------------------------
    // THE DIRECT CORRIDOR, AT THE TABLE.
    //
    // A route was one door to the forbidden shape; a DIRECT row is the other,
    // and it is the wider one. phoenix_assert_direct_supply_endpoints is only
    // ever reached from inside an RPC body — _phoenix_authorize_transfer_request_
    // write is a plain function five RPCs PERFORM, not a trigger — and across
    // 001-183 these tables carry no authorization trigger at all. A raw INSERT
    // of `route_id NULL, central -> depot` therefore had to be refused BY THE
    // TABLE or it was not refused at all. The composite route FK cannot help: a
    // NULL route_id switches it off.
    // ------------------------------------------------------------------------
    it('a DIRECT raw request central -> centre depot is refused at the table', async () => {
      const before = await countRows('warehouse_transfer_requests');
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_transfer_requests
           (route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id, request_number, status)
         VALUES (NULL,$1,$2,$3,$4,'R13-DIRECT-1','draft')`,
        [WH_CENTRAL, ORG_PDA, DEPOT_A, ORG_SECTOR])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);
      expect(await countRows('warehouse_transfer_requests')).toBe(before);
    });

    it('a DIRECT raw TRANSFER central -> centre depot is refused — the table that carries stock', async () => {
      // The movement table, not the request table. This is the row that moves
      // stock, and 129's direct send writes it with route_id NULL.
      const before = await countRows('warehouse_transfers');
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_transfers
           (route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            transfer_number, status, sent_at)
         VALUES (NULL,$1,$2,$3,$4,'R13-DIRECT-2','in_transit',now())`,
        [WH_CENTRAL, ORG_PDA, DEPOT_A, ORG_SECTOR])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);
      expect(await countRows('warehouse_transfers')).toBe(before);
    });

    it('a DIRECT raw RETARGET of a legal transfer onto a centre depot is refused', async () => {
      // An UPDATE is a new authorization when it moves an endpoint. Walking the
      // legal central -> hospital row onto the depot must not succeed.
      expect(await rejects(() => asAdmin(
        `UPDATE warehouse_transfers SET destination_warehouse_id=$2, destination_organization_id=$3
          WHERE id=$1`, [XFER_C_HOSP, DEPOT_A, ORG_SECTOR])))
        .toMatch(/central_supply_destination_must_not_be_facility_bound/);
      const still: any = await asAdmin(
        `SELECT destination_warehouse_id FROM warehouse_transfers WHERE id=$1`, [XFER_C_HOSP]);
      expect(still.rows[0].destination_warehouse_id).toBe(WH_HOSP);
    });

    it('a DIRECT raw write from central to a LEGAL root is still accepted', async () => {
      // The boundary must narrow the corridor, not close it. Same shape the
      // seeded provenance rows use, proving they pass the guard rather than
      // predating it.
      const id = uid();
      await asAdmin(
        `INSERT INTO warehouse_transfers
           (id, route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            transfer_number, status, sent_at)
         VALUES ($1,NULL,$2,$3,$4,$5,'R13-DIRECT-OK','in_transit',now())`,
        [id, WH_CENTRAL, ORG_PDA, WH_HOSP, ORG_HOSP]);
      const r: any = await asAdmin(`SELECT count(*)::int AS n FROM warehouse_transfers WHERE id=$1`, [id]);
      expect(r.rows[0].n).toBe(1);
      await asAdmin(`DELETE FROM warehouse_transfers WHERE id=$1`, [id]);
    });

    it('the LEGACY central -> depot row keeps its full, reversible lifecycle', async () => {
      // History is preserved in the only sense that matters operationally: an
      // UPDATE that moves no endpoint is never re-judged, so a legacy row can
      // still be corrected, cancelled and re-corrected after 184.
      await asAdmin(
        `UPDATE warehouse_transfers SET notes='r13-lifecycle' WHERE id=$1`, [XFER_LEGACY_C_DEPOT]);
      await asAdmin(
        `UPDATE warehouse_transfers SET status='received', notes=NULL WHERE id=$1`, [XFER_LEGACY_C_DEPOT]);
      const r: any = await asAdmin(
        `SELECT status, destination_warehouse_id FROM warehouse_transfers WHERE id=$1`,
        [XFER_LEGACY_C_DEPOT]);
      expect(r.rows[0].status).toBe('received');
      expect(r.rows[0].destination_warehouse_id).toBe(DEPOT_A);
    });

    it('the route endpoint validator is INTERNAL — not a cross-tenant oracle', async () => {
      // 075 made it an internal helper with no client execution at all. It is
      // SECURITY DEFINER over public.warehouses, so an authenticated grant
      // would leak warehouse existence/kind/status/facility-boundness/class
      // across tenants.
      const r: any = await asAdmin(`
        SELECT count(*)::int AS n FROM pg_roles r
        WHERE r.rolname IN ('anon','authenticated','service_role')
          AND has_function_privilege(
                r.oid,
                'public.phoenix_supply_route_assert_endpoints(uuid,uuid)'::regprocedure::oid,
                'EXECUTE')`);
      expect(r.rows[0].n).toBe(0);
    });

    it('keeps the IDOR gate on the named destination organization', async () => {
      expect(await rejects(() => fwd(WH_CENTRAL, WH_HOSP, ORG_SPEC)))
        .toMatch(/destination_warehouse_not_in_named_organization/);
    });

    it('still refuses an inactive destination with the ORIGINAL identifier', async () => {
      // A non-main warehouse: warehouses_main_requires_active_chk forbids
      // deactivating an is_main row.
      await asAdmin(`UPDATE warehouses SET status='inactive' WHERE id=$1`, [WH_HOSP_ALT]);
      try {
        expect(await rejects(() => fwd(WH_CENTRAL, WH_HOSP_ALT)))
          .toMatch(/destination_must_be_active_institution_warehouse/);
      } finally {
        await asAdmin(`UPDATE warehouses SET status='active' WHERE id=$1`, [WH_HOSP_ALT]);
      }
    });
  });

  // ==========================================================================
  // B · INTERNAL HEALTH-SECTOR CHAIN — 180/183 must be undisturbed
  // ==========================================================================
  describe('B · internal sector chain is preserved, not rebuilt', () => {
    /** Every overload's body for a function name — no signature guessing. */
    const bodies = async (name: string): Promise<string[]> => {
      const r: any = await asAdmin(
        `SELECT p.prosrc AS src FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname='public' AND p.proname=$1`, [name]);
      expect(r.rows.length, `${name} must exist`).toBeGreaterThan(0);
      return r.rows.map((x: any) => x.src);
    };

    it('184 defines none of the emergency lifecycle functions', async () => {
      // R1.3 explicitly forbids rebuilding or duplicating these.
      const r: any = await asAdmin(`
        SELECT p.proname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname IN (
          'phoenix_upsert_outlet_replenishment_route',
          'phoenix_replenish_emergency_outlet',
          'phoenix_reverse_outlet_replenishment',
          'phoenix_create_initial_provisioning_dispatch')
        ORDER BY p.proname`);
      expect(r.rows.map((x: any) => x.proname)).toEqual([
        'phoenix_create_initial_provisioning_dispatch',
        'phoenix_replenish_emergency_outlet',
        'phoenix_reverse_outlet_replenishment',
        'phoenix_upsert_outlet_replenishment_route',
      ]);
    });

    it('replenishment still requires a PHARMACY source', async () => {
      for (const src of await bodies('phoenix_replenish_emergency_outlet')) {
        expect(src).toMatch(/pharmacy/);
      }
    });

    it('the reversal still DERIVES the original pharmacy and takes no pharmacy argument', async () => {
      // The proven provenance model: credit the EXACT original pharmacy stock
      // row derived from the original paired replenish_send/replenish_receive
      // movements. A client-selected replacement pharmacy must be impossible by
      // SIGNATURE, not merely by convention.
      const r: any = await asAdmin(`
        SELECT pg_get_function_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='phoenix_reverse_outlet_replenishment'`);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].args).not.toMatch(/pharmacy/i);

      // ...and the body derives the credit target from the original movement pair.
      for (const src of await bodies('phoenix_reverse_outlet_replenishment')) {
        expect(src).toMatch(/replenish_send|replenish_receive/);
      }
    });

    it('183s active-outlet topology validator is still the single author', async () => {
      const r: any = await asAdmin(`
        SELECT count(*)::int AS n FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='phoenix_assert_active_outlet_topology_v1'`);
      expect(r.rows[0].n).toBe(1);
    });

    it('the same-sector corridor still refuses an inactive centre depot', async () => {
      await asAdmin(`UPDATE warehouses SET status='inactive' WHERE id=$1`, [DEPOT_B]);
      try {
        expect(await rejects(() => fwd(SECTOR_MAIN, DEPOT_B)))
          .toMatch(/health_center_warehouse_not_active/);
      } finally {
        await asAdmin(`UPDATE warehouses SET status='active' WHERE id=$1`, [DEPOT_B]);
      }
    });

    it('181 still refuses deactivating a facility that has an active depot', async () => {
      // The operational-dependency guard 181 introduced. 184 replaced neither
      // the guard nor its trigger, and this proves it still fires — which is
      // also why the corridor cannot meet an active depot on a dead facility.
      expect(await rejects(() => asAdmin(
        `UPDATE organization_facilities SET status='inactive' WHERE id=$1`, [FAC_B])))
        .toMatch(/health_center_facility_change_blocked_by_active_depot/);
    });
  });

  // ==========================================================================
  // C · LOCAL PROCUREMENT + INTER-ORG EXCHANGE
  // ==========================================================================
  describe('C · procurement root and stock truth', () => {
    it('PASS health-sector procurement -> the Sector Main', async () => {
      await expect(procRoot(SECTOR_MAIN)).resolves.toBeTruthy();
    });

    it('REJECT health-sector procurement -> a centre depot (THE R1.3-C closure)', async () => {
      expect(await rejects(() => procRoot(DEPOT_A)))
        .toMatch(/local_procurement_root_must_be_sector_main/);
    });

    it('THE SECOND WRITER: a raw procurement_orders INSERT into a centre depot is refused', async () => {
      // phoenix_procurement_create_order is not the only writer —
      // phoenix_subpurchase_direct_entry carries the identical pre-R1.3 check
      // and posts stock as well as an order. The boundary is on the TABLE, so
      // every writer and a raw service_role INSERT obey the same rule.
      const supplier = uid();
      await asAdmin(
        `INSERT INTO procurement_suppliers (id,organization_id,name,name_ar,status)
         VALUES ($1,$2,'S184','مورد','active') ON CONFLICT (id) DO NOTHING`,
        [supplier, ORG_SECTOR]);

      const msg = await rejects(() => asAdmin(
        `INSERT INTO procurement_orders
           (organization_id, warehouse_id, supplier_id, order_number, status)
         VALUES ($1,$2,$3,'R13-RAW-1','draft')`,
        [ORG_SECTOR, DEPOT_A, supplier]));
      expect(msg).toMatch(/local_procurement_root_must_be_sector_main/);
    });

    it('the same raw INSERT into the Sector Main is accepted', async () => {
      const supplier = uid(), order = uid();
      await asAdmin(
        `INSERT INTO procurement_suppliers (id,organization_id,name,name_ar,status)
         VALUES ($1,$2,'S184b','مورد٢','active') ON CONFLICT (id) DO NOTHING`,
        [supplier, ORG_SECTOR]);
      await asAdmin(
        `INSERT INTO procurement_orders
           (id, organization_id, warehouse_id, supplier_id, order_number, status, created_by)
         VALUES ($1,$2,$3,$4,'R13-RAW-2','draft',$5)`,
        [order, ORG_SECTOR, SECTOR_MAIN, supplier, rig.superAdminId]);
      const r: any = await asAdmin(`SELECT count(*)::int AS n FROM procurement_orders WHERE id=$1`, [order]);
      expect(r.rows[0].n).toBe(1);
    });

    it('exactly ONE trigger enforces the procurement root', async () => {
      const r: any = await asAdmin(`
        SELECT t.tgname FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname='procurement_orders'
          AND NOT t.tgisinternal
          AND pg_get_triggerdef(t.oid) LIKE '%_phoenix_procurement_order_root_guard_v1%'`);
      expect(r.rows.map((x: any) => x.tgname)).toEqual(['phoenix_procurement_order_root_guard']);
    });

    it('PRESERVES hospital and specialized-center procurement behaviour', async () => {
      await expect(procRoot(WH_HOSP)).resolves.toBeTruthy();
      await expect(procRoot(WH_SPEC)).resolves.toBeTruthy();
    });

    it('still refuses a non-institution or inactive procurement root with 087s identifier', async () => {
      expect(await rejects(() => procRoot(WH_CENTRAL)))
        .toMatch(/destination_must_be_active_institution_warehouse/);
    });

    it('the item_availability.quantity write surface has not grown', async () => {
      // The two stock truths are warehouse_stock and outlet_stock;
      // item_availability is a PROJECTION with its own legacy maintainers.
      // Earlier hardening already revoked external EXECUTE from
      // phoenix_upsert_availability and phoenix_apply_availability_movement,
      // leaving exactly one legacy port-clearing RPC reachable. R1.3 pins that
      // set: a second writer appearing is a regression, and the retired
      // exchange completion writer must never be among them.
      const r: any = await asAdmin(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public'
          AND p.prokind='f'
          AND p.prosrc ~* 'UPDATE\\s+(public\\.)?item_availability\\s+SET\\s+quantity'
          AND EXISTS (
            SELECT 1 FROM pg_roles r
            WHERE r.rolname IN ('anon','authenticated','service_role')
              AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
        ORDER BY p.proname`);
      const names = r.rows.map((x: any) => x.proname);
      expect(names).toEqual(['clear_port_availability']);
      expect(names).not.toContain('phoenix_update_inter_org_exchange_status');
    });

    it('NO R1.3 path mutates item_availability.quantity', async () => {
      const R13_FUNCTIONS = [
        '_phoenix_assert_external_corridor_institution_root_v1',
        '_phoenix_assert_local_procurement_root_v1',
        '_phoenix_procurement_order_root_guard_v1',
        '_phoenix_supply_route_topology_guard_v1',
        'phoenix_assert_direct_supply_endpoints',
        'phoenix_assert_direct_return_endpoints',
        'phoenix_procurement_create_order',
        'phoenix_supply_route_assert_endpoints',
      ];

      // Prove they EXIST first — otherwise the emptiness assertion below would
      // pass just as happily if 184 had never been applied.
      const present: any = await asAdmin(`
        SELECT DISTINCT p.proname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname = ANY($1) ORDER BY p.proname`, [R13_FUNCTIONS]);
      expect(present.rows.map((x: any) => x.proname)).toEqual([...R13_FUNCTIONS].sort());

      const r: any = await asAdmin(`
        SELECT p.proname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname = ANY($1)
          AND p.prosrc ~* 'item_availability'
        ORDER BY p.proname`, [R13_FUNCTIONS]);
      expect(r.rows.map((x: any) => x.proname)).toEqual([]);
    });

    it('the legacy exchange completion writer is owner-only and still retired', async () => {
      const r: any = await asAdmin(`
        SELECT
          (SELECT count(*)::int FROM pg_roles rr
             WHERE rr.rolname IN ('anon','authenticated','service_role')
               AND has_function_privilege(
                     rr.oid,
                     'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)'::regprocedure::oid,
                     'EXECUTE')) AS external_grants,
          (SELECT count(*)::int FROM pg_proc p
             WHERE p.oid = 'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)'::regprocedure::oid
               AND p.prosrc ~* 'UPDATE\\s+public\\.item_availability') AS body_intact`);
      // Zero external principals reach it...
      expect(r.rows[0].external_grants).toBe(0);
      // ...and its body was deliberately NOT rewritten by 184.
      expect(r.rows[0].body_intact).toBe(1);
    });

    it('a health-centre facility is not an independent exchange or procurement actor', async () => {
      // Prove the permission families EXIST before proving this role holds none
      // of them — a count of 0 over an empty vocabulary asserts nothing.
      const families: any = await asAdmin(`
        SELECT count(*)::int AS n FROM public.role_permission_defaults
        WHERE permission_key LIKE 'inter_org_exchange.%'
           OR permission_key LIKE 'local_procurement.%'`);
      expect(families.rows[0].n).toBeGreaterThan(0);

      const r: any = await asAdmin(`
        SELECT count(*)::int AS n
        FROM public.role_permission_defaults
        WHERE role = 'health_center_manager'
          AND (permission_key LIKE 'inter_org_exchange.%'
               OR permission_key LIKE 'local_procurement.%')
          AND allowed`);
      expect(r.rows[0].n).toBe(0);
    });

    it('exchange requests are organization-scoped — facilities are not organizations', async () => {
      const r: any = await asAdmin(`
        SELECT count(*)::int AS n
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='inter_org_exchange_requests'
          AND column_name LIKE '%facility%'`);
      expect(r.rows[0].n).toBe(0);
    });
  });

  // ==========================================================================
  // D · RETURNS AND REVERSALS
  // ==========================================================================
  describe('D · return topology', () => {
    it('PASS hospital -> central with provenance', async () => {
      const r = await ret(WH_HOSP, WH_CENTRAL);
      expect(r.o_institution_organization_id).toBe(ORG_HOSP);
      expect(r.o_central_organization_id).toBe(ORG_PDA);
    });

    it('PASS specialized center -> central with provenance', async () => {
      const r = await ret(WH_SPEC, WH_CENTRAL);
      expect(r.o_institution_organization_id).toBe(ORG_SPEC);
    });

    it('PASS health-sector MAIN -> central with provenance', async () => {
      const r = await ret(SECTOR_MAIN, WH_CENTRAL);
      expect(r.o_institution_organization_id).toBe(ORG_SECTOR);
    });

    it('PASS centre depot -> its own sector main with provenance (Branch B)', async () => {
      const r = await ret(DEPOT_A, SECTOR_MAIN);
      expect(r.o_institution_organization_id).toBe(ORG_SECTOR);
      expect(r.o_central_organization_id).toBe(ORG_SECTOR);
    });

    it('REJECT centre depot -> central as an ordinary return root (THE R1.3-D closure)', async () => {
      // A legacy central -> DEPOT_A transfer EXISTS, so provenance alone would
      // have admitted this. The topology refusal must come first.
      expect(await rejects(() => ret(DEPOT_A, WH_CENTRAL)))
        .toMatch(/central_return_source_must_not_be_facility_bound/);
    });

    it('REJECT a return with NO forward provenance', async () => {
      // SECTOR2_MAIN is a legal corridor root but was never supplied.
      expect(await rejects(() => ret(SECTOR2_MAIN, WH_CENTRAL)))
        .toMatch(/no_direct_forward_provenance_between_warehouses/);
    });

    it('REJECT a centre depot returning to a FOREIGN sector main', async () => {
      expect(await rejects(() => ret(DEPOT_C, SECTOR_MAIN)))
        .toMatch(/central_return_source_must_not_be_facility_bound/);
    });

    // The same table-level closure as the forward half, mirrored. Calling the
    // validator proves the DECISION; these prove the BOUNDARY — that a writer
    // which never calls it is refused anyway.
    it('a DIRECT raw return REQUEST depot -> central is refused at the table', async () => {
      const before = await countRows('warehouse_return_requests');
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_return_requests
           (route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            return_number, status, requested_by_side)
         VALUES (NULL,$1,$2,$3,$4,'R13-DIRECT-R1','draft','sender')`,
        [DEPOT_A, ORG_SECTOR, WH_CENTRAL, ORG_PDA])))
        .toMatch(/central_return_source_must_not_be_facility_bound/);
      expect(await countRows('warehouse_return_requests')).toBe(before);
    });

    it('a DIRECT raw return SHIPMENT depot -> central is refused — the table that carries stock', async () => {
      const before = await countRows('warehouse_return_shipments');
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_return_shipments
           (route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            shipment_number, status, sent_at)
         VALUES (NULL,$1,$2,$3,$4,'R13-DIRECT-R2','in_transit',now())`,
        [DEPOT_A, ORG_SECTOR, WH_CENTRAL, ORG_PDA])))
        .toMatch(/central_return_source_must_not_be_facility_bound/);
      expect(await countRows('warehouse_return_shipments')).toBe(before);
    });

    it('a DIRECT raw return INVENTED without forward provenance is refused', async () => {
      // Delegating to the direct validator restores its provenance proof on the
      // raw path too: SECTOR2_MAIN is a legal root that was never supplied.
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouse_return_requests
           (route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            return_number, status, requested_by_side)
         VALUES (NULL,$1,$2,$3,$4,'R13-DIRECT-R3','draft','sender')`,
        [SECTOR2_MAIN, ORG_SECTOR2, WH_CENTRAL, ORG_PDA])))
        .toMatch(/no_direct_forward_provenance_between_warehouses/);
    });

    it('a DIRECT raw return along a LEGAL corridor is still accepted', async () => {
      const id = uid();
      await asAdmin(
        `INSERT INTO warehouse_return_requests
           (id, route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            return_number, status, requested_by_side)
         VALUES ($1,NULL,$2,$3,$4,$5,'R13-DIRECT-ROK','draft','sender')`,
        [id, WH_HOSP, ORG_HOSP, WH_CENTRAL, ORG_PDA]);
      const r: any = await asAdmin(
        `SELECT count(*)::int AS n FROM warehouse_return_requests WHERE id=$1`, [id]);
      expect(r.rows[0].n).toBe(1);
      await asAdmin(`DELETE FROM warehouse_return_requests WHERE id=$1`, [id]);
    });

    it('BRANCH B return (depot -> its own sector main) still writes directly', async () => {
      const id = uid();
      await asAdmin(
        `INSERT INTO warehouse_return_requests
           (id, route_id, source_warehouse_id, source_organization_id,
            destination_warehouse_id, destination_organization_id,
            return_number, status, requested_by_side)
         VALUES ($1,NULL,$2,$3,$4,$5,'R13-BRANCHB-R','draft','sender')`,
        [id, DEPOT_A, ORG_SECTOR, SECTOR_MAIN, ORG_SECTOR]);
      const r: any = await asAdmin(
        `SELECT count(*)::int AS n FROM warehouse_return_requests WHERE id=$1`, [id]);
      expect(r.rows[0].n).toBe(1);
      await asAdmin(`DELETE FROM warehouse_return_requests WHERE id=$1`, [id]);
    });
  });

  // ==========================================================================
  // HISTORY AND SIDE-EFFECT FREEDOM
  // ==========================================================================
  describe('history is preserved and refusals move nothing', () => {
    it('the legacy central -> depot transfer row still exists, unchanged', async () => {
      const r: any = await asAdmin(
        `SELECT source_warehouse_id, destination_warehouse_id, transfer_number, status
         FROM warehouse_transfers WHERE id=$1`, [XFER_LEGACY_C_DEPOT]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].source_warehouse_id).toBe(WH_CENTRAL);
      expect(r.rows[0].destination_warehouse_id).toBe(DEPOT_A);
      expect(r.rows[0].transfer_number).toBe('R13-X5');
      expect(r.rows[0].status).toBe('received');
    });

    it('a refused supply and a refused return write nothing anywhere', async () => {
      const before = {
        transfers: await countRows('warehouse_transfers'),
        stock: await countRows('warehouse_stock'),
        outlet: await countRows('outlet_stock'),
        audit: await countRows('audit_logs'),
      };

      await rejects(() => fwd(WH_CENTRAL, DEPOT_A));
      await rejects(() => ret(DEPOT_A, WH_CENTRAL));
      await rejects(() => procRoot(DEPOT_A));

      expect({
        transfers: await countRows('warehouse_transfers'),
        stock: await countRows('warehouse_stock'),
        outlet: await countRows('outlet_stock'),
        audit: await countRows('audit_logs'),
      }).toEqual(before);
    });

    it('the internal capsules are unreachable by every external principal', async () => {
      const r: any = await asAdmin(`
        SELECT count(*)::int AS n
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN pg_roles r
        WHERE n.nspname='public'
          AND p.proname IN ('_phoenix_assert_external_corridor_institution_root_v1',
                            '_phoenix_assert_local_procurement_root_v1')
          AND r.rolname IN ('anon','authenticated','service_role')
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`);
      expect(r.rows[0].n).toBe(0);
    });

    it('the two validators remain reachable by authenticated and closed to anon', async () => {
      const r: any = await asAdmin(`
        SELECT
          has_function_privilege('authenticated','public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure::oid,'EXECUTE') AS auth_supply,
          has_function_privilege('authenticated','public.phoenix_assert_direct_return_endpoints(uuid,uuid)'::regprocedure::oid,'EXECUTE') AS auth_return,
          has_function_privilege('anon','public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure::oid,'EXECUTE') AS anon_supply,
          has_function_privilege('anon','public.phoenix_assert_direct_return_endpoints(uuid,uuid)'::regprocedure::oid,'EXECUTE') AS anon_return`);
      expect(r.rows[0]).toEqual({
        auth_supply: true, auth_return: true, anon_supply: false, anon_return: false,
      });
    });
  });
});
