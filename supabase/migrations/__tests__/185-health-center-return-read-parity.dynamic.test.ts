/**
 * 185 · R1.5-D HEALTH-CENTRE FACILITY READ PARITY — proven as a 184-vs-185
 * DELTA, not as an absolute.
 *
 * The delta framing matters. Several D surfaces are already org-wide at 184:
 * phoenix_warehouse_correction_requests_select_scoped admits any same-org actor
 * that is NOT a health_center_manager, so an unscoped central_warehouse_manager
 * legitimately reads every correction row of its organization. Asserting DENY
 * for such a role would assert a behaviour the product never had, and "fixing"
 * it would be an unrelated narrowing smuggled into R1.5.
 *
 * So the identical fixture is built twice - once on a rig at 184, once at 185 -
 * and the VISIBLE ID SETS are compared per role, per surface. The requirement is
 * ZERO UNINTENDED DELTA, never a particular shape of visibility.
 *
 * Topology:
 *   Health Sector
 *   ├── Sector Main            (facility_id IS NULL -> unreachable by facility scope)
 *   ├── Facility A → Depot A, Outlet A
 *   └── Facility B → Depot B, Outlet B
 *   HCM-A: active, assigned ONLY Facility A.
 *
 * Every identifier is a module-level constant, so both rigs receive identical
 * fixtures and the two ID sets are directly comparable.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

let seq = 0;
const uid = () => `00000000-0000-0000-0000-${String(185500000000 + (seq += 1))}`;

const ORG_PDA = uid(), ORG_SECTOR = uid();
const WH_CENTRAL = uid(), SECTOR_MAIN = uid();
const FAC_A = uid(), FAC_B = uid();
const DEPOT_A = uid(), DEPOT_B = uid();
const OUTLET_A = uid(), OUTLET_B = uid();
const HCM_A = uid();
const PROPOSER = uid();
const QS_A = uid(), QS_B = uid(), QS_MAIN = uid();
// Explicit ids: the movement rows are compared as ID SETS across two
// independent rig builds, so an auto-generated id would differ by construction.
const QM = { ['a']: uid(), ['b']: uid(), ['m']: uid() } as Record<string,string>;
const WR_A = uid(), WR_B = uid(), WR_MAIN = uid();
const CORR_A = uid(), CORR_B = uid(), CORR_MAIN = uid();
const CS_A = uid(), CS_B = uid(), CS_MAIN = uid();

const EXISTING_ROLES = [
  'central_warehouse_manager', 'institution_admin', 'warehouse_officer', 'outlet_officer',
] as const;
const ACTORS: Record<string, string> = Object.fromEntries(
  EXISTING_ROLES.map((r) => [r, uid()]));

/** Every surface family D touches. Compared as ID SETS between 184 and 185. */
const SURFACES: Record<string, string> = {
  warehouse_quarantine_stock: 'SELECT id FROM warehouse_quarantine_stock',
  warehouse_quarantine_stock_movements: 'SELECT id FROM warehouse_quarantine_stock_movements',
  warehouse_return_requests: 'SELECT id FROM warehouse_return_requests',
  warehouse_return_request_lines: 'SELECT id FROM warehouse_return_request_lines',
  phoenix_warehouse_correction_requests: 'SELECT id FROM phoenix_warehouse_correction_requests',
  outlet_return_shipments: 'SELECT id FROM outlet_return_shipments',
  phoenix_outlet_return_exception_resolutions:
    'SELECT id FROM phoenix_outlet_return_exception_resolutions',
};

async function topology(upTo?: number) {
  const rig = await buildRig(upTo ? { upTo } : {});
  const admin = (sql: string, p: any[] = []) => rig.asAdmin((c: any) => c.query(sql, p));

  await admin(`
    INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
      ('${ORG_PDA}','PDA','دائرة','r15d-p','pharmacy_department_authority',NULL,'active'),
      ('${ORG_SECTOR}','Sector','قطاع','r15d-q','care_institution','health_sector','active');

    INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
      ('${FAC_A}','${ORG_SECTOR}','primary_health_center','A','أ','active'),
      ('${FAC_B}','${ORG_SECTOR}','primary_health_center','B','ب','active');

    INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
      ('${WH_CENTRAL}','${ORG_PDA}','C','مركزي','central',NULL,true,'active'),
      ('${SECTOR_MAIN}','${ORG_SECTOR}','Main','رئيسي','institution',NULL,true,'active'),
      ('${DEPOT_A}','${ORG_SECTOR}','DepA','مذخرأ','institution','${FAC_A}',false,'active'),
      ('${DEPOT_B}','${ORG_SECTOR}','DepB','مذخرب','institution','${FAC_B}',false,'active');

    INSERT INTO distribution_points
      (id,organization_id,warehouse_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
      ('${OUTLET_A}','${ORG_SECTOR}','${DEPOT_A}','OutA','منفذأ','pharmacy','active',NULL),
      ('${OUTLET_B}','${ORG_SECTOR}','${DEPOT_B}','OutB','منفذب','pharmacy','active',NULL);

    INSERT INTO auth.users (id,email) VALUES ('${HCM_A}','r15d-hcma@rig'),('${PROPOSER}','r15d-prop@rig')
      ON CONFLICT (id) DO NOTHING;
    UPDATE profiles SET role='health_center_manager', status='active', organization_id='${ORG_SECTOR}'
     WHERE id='${HCM_A}';
    UPDATE profiles SET role='warehouse_officer', status='active', organization_id='${ORG_SECTOR}'
     WHERE id='${PROPOSER}';
    INSERT INTO profile_scope_assignments
      (profile_id, organization_id, scope_type, facility_id, is_active)
    VALUES ('${HCM_A}','${ORG_SECTOR}','facility','${FAC_A}',true)
    ON CONFLICT DO NOTHING;
  `);

  for (const [role, id] of Object.entries(ACTORS)) {
    await admin(`INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
      [id, `r15d-${role}@rig`]);
    await admin(`UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1`,
      [id, role, ORG_SECTOR]);
  }

  for (const [qid, wh, mk] of [[QS_A, DEPOT_A, 'a'], [QS_B, DEPOT_B, 'b'], [QS_MAIN, SECTOR_MAIN, 'm']] as const) {
    await admin(`
      INSERT INTO warehouse_quarantine_stock
        (id, organization_id, warehouse_id, scientific_name, unit, has_no_national_code,
         batch_number, has_no_batch_number, expiry_date, quarantine_reason, quantity, supply_type)
      VALUES ($1,$2,$3,'R15D-MAT','box',true,'B',false,'2030-01-01','damaged',10,'aid')`,
      [qid, ORG_SECTOR, wh]);
    await admin(`
      INSERT INTO warehouse_quarantine_stock_movements
        (id, quarantine_stock_id, organization_id, warehouse_id, movement_type,
         quantity_before, quantity_delta, quantity_after, reason,
         reference_type, reference_id, scientific_name_snapshot)
      VALUES ($4,$1,$2,$3,'quarantine_receive',0,10,10,'seed','warehouse_return',$1,'R15D-MAT')`,
      [qid, ORG_SECTOR, wh, QM[mk]]);
  }

  // 184's direct-corridor boundary demands real forward provenance first.
  await admin(`
    INSERT INTO warehouse_transfers
      (route_id, source_warehouse_id, source_organization_id,
       destination_warehouse_id, destination_organization_id, transfer_number, status, sent_at) VALUES
      (NULL,'${WH_CENTRAL}','${ORG_PDA}','${SECTOR_MAIN}','${ORG_SECTOR}','R15D-F1','received',now()),
      (NULL,'${SECTOR_MAIN}','${ORG_SECTOR}','${DEPOT_A}','${ORG_SECTOR}','R15D-F2','received',now()),
      (NULL,'${SECTOR_MAIN}','${ORG_SECTOR}','${DEPOT_B}','${ORG_SECTOR}','R15D-F3','received',now());`);

  for (const [wr, src] of [[WR_A, DEPOT_A], [WR_B, DEPOT_B], [WR_MAIN, SECTOR_MAIN]] as const) {
    await admin(`
      INSERT INTO warehouse_return_requests
        (id, route_id, source_warehouse_id, source_organization_id,
         destination_warehouse_id, destination_organization_id, return_number, status, requested_by_side)
      VALUES ($1,NULL,$2,$3,$4,$5,$6,'draft','sender')`,
      [wr, src, ORG_SECTOR, src === SECTOR_MAIN ? WH_CENTRAL : SECTOR_MAIN,
       src === SECTOR_MAIN ? ORG_PDA : ORG_SECTOR, 'R15D-' + wr.slice(-4)]);
  }

  // Corrections. proposed_by is a WAREHOUSE OFFICER, never HCM-A: if HCM-A were
  // the proposer, phoenix_approve_warehouse_stock_correction would refuse with
  // proposer_cannot_approve_own_correction and mask the permission boundary
  // this fixture exists to prove.
  for (const [corr, cs, wh] of [
    [CORR_A, CS_A, DEPOT_A], [CORR_B, CS_B, DEPOT_B], [CORR_MAIN, CS_MAIN, SECTOR_MAIN],
  ] as const) {
    await admin(`
      INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, unit, has_no_national_code,
         batch_number, has_no_batch_number, expiry_date,
         on_hand_quantity, reserved_quantity, movement_seq, supply_type)
      VALUES ($1,$2,$3,'R15D-CORR','box',true,'CB',false,'2030-01-01',5,0,0,'aid')`,
      [cs, ORG_SECTOR, wh]);
    await admin(`
      INSERT INTO phoenix_warehouse_correction_requests
        (id, organization_id, warehouse_stock_id, on_hand_before, new_quantity, variance,
         reason, status, proposed_by, underlying_request_id)
      VALUES ($1,$2,$3,5,3,-2,'seed','pending',$4,$5)`,
      [corr, ORG_SECTOR, cs, PROPOSER, uid()]);
  }

  return { rig, admin };
}

/** The visible ID set for one identity across every D surface. */
async function truthTable(rig: any, who: string) {
  const out: Record<string, string[]> = {};
  for (const [name, sql] of Object.entries(SURFACES)) {
    try {
      out[name] = await rig.asUser(who, (c: any) =>
        c.query(sql).then((r: any) => r.rows.map((x: any) => x.id).sort()));
    } catch {
      out[name] = ['<ERROR>'];
    }
  }
  return out;
}

run('185 · R1.5-D facility read parity, proven as a 184->185 delta', () => {
  const pre: Record<string, Record<string, string[]>> = {};
  const post: Record<string, Record<string, string[]>> = {};
  let postRig: any;
  let postAdmin: (sql: string, p?: any[]) => Promise<any>;
  let superId = '';

  beforeAll(async () => {
    const base = await topology(184);
    superId = base.rig.superAdminId;
    for (const who of [superId, HCM_A, ...Object.values(ACTORS)]) {
      pre[who] = await truthTable(base.rig, who);
    }
    await base.rig.end();

    const p = await topology();
    postRig = p.rig;
    postAdmin = p.admin;
    for (const who of [postRig.superAdminId, HCM_A, ...Object.values(ACTORS)]) {
      post[who] = await truthTable(postRig, who);
    }
  }, 900000);

  afterAll(async () => { if (postRig) await postRig.end(); });

  it('D-C · every PRE-185 role keeps identical visibility on every changed surface', () => {
    // Historical org-wide behaviour stays historical behaviour. The requirement
    // is ZERO DELTA, not a narrower or "better" visibility.
    for (const [role, id] of Object.entries(ACTORS)) {
      for (const surface of Object.keys(SURFACES)) {
        expect(post[id][surface], `${role}/${surface}`).toEqual(pre[id][surface]);
      }
    }
  });

  it('D-C · super_admin keeps identical visibility on every changed surface', () => {
    for (const surface of Object.keys(SURFACES)) {
      expect(post[postRig.superAdminId][surface], `super_admin/${surface}`)
        .toEqual(pre[superId][surface]);
    }
  });

  it('D-C · central_warehouse_manager correction visibility is PRE-EXISTING, not introduced', () => {
    // Named explicitly because it is the case that first looked like a
    // regression: the 184 policy already admits any same-org non-HCM actor.
    const id = ACTORS.central_warehouse_manager;
    expect(pre[id].phoenix_warehouse_correction_requests.length).toBe(3);
    expect(post[id].phoenix_warehouse_correction_requests)
      .toEqual(pre[id].phoenix_warehouse_correction_requests);
  });

  it('D · HCM-A saw NOTHING at 184 on any D surface', () => {
    for (const surface of Object.keys(SURFACES)) {
      expect(pre[HCM_A][surface], `184 HCM/${surface}`).toEqual([]);
    }
  });

  it('D · HCM-A at 185 sees its OWN facility only — sibling and Sector Main denied', () => {
    expect(post[HCM_A].warehouse_quarantine_stock).toEqual([QS_A]);
    expect(post[HCM_A].warehouse_quarantine_stock_movements.length).toBe(1);
    expect(post[HCM_A].warehouse_return_requests).toEqual([WR_A]);
    expect(post[HCM_A].phoenix_warehouse_correction_requests).toEqual([CORR_A]);

    for (const surface of Object.keys(SURFACES)) {
      for (const forbidden of [QS_B, QS_MAIN, WR_B, WR_MAIN, CORR_B, CORR_MAIN]) {
        expect(post[HCM_A][surface], `${surface} leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('D-B · HCM-A cannot APPROVE a correction it can see, on its own depot', async () => {
    const snap = () => postAdmin(`
      SELECT ws.on_hand_quantity, ws.reserved_quantity, ws.movement_seq,
             (SELECT count(*)::int FROM warehouse_stock_movements m WHERE m.warehouse_stock_id=ws.id) AS movs,
             (SELECT status FROM phoenix_warehouse_correction_requests WHERE id=$2) AS corr_status,
             (SELECT count(*)::int FROM audit_logs) AS audits
        FROM warehouse_stock ws WHERE ws.id=$1`, [CS_A, CORR_A]);

    const before: any = await snap();
    let msg = '';
    try {
      await postRig.asUser(HCM_A, (c: any) => c.query(
        `SELECT public.phoenix_approve_warehouse_stock_correction($1,$2)`,
        [CORR_A, before.rows[0].movement_seq]), { commit: true });
      msg = 'ALLOWED';
    } catch (e: any) { msg = String(e?.message ?? e); }

    // The correction is real, pending, on a stock row HCM-A can READ, and was
    // proposed by someone else - so nothing but the permission gate can refuse.
    expect(msg).toMatch(/forbidden_correction_approval/);

    const after: any = await snap();
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('D · every new policy is SELECT-only and HCM gains no write path', async () => {
    const pol: any = await postAdmin(`
      SELECT count(*) FILTER (WHERE cmd='SELECT')::int AS selects, count(*)::int AS total
        FROM pg_policies
       WHERE schemaname='public' AND policyname LIKE '%health_center_facility%'`);
    expect(pol.rows[0].total).toBe(4);
    expect(pol.rows[0].selects).toBe(4);

    const denied = async (sql: string) => {
      try {
        await postRig.asUser(HCM_A, (c: any) => c.query(sql), { commit: true });
        return 'ALLOWED';
      } catch { return 'DENIED'; }
    };
    expect(await denied(`UPDATE warehouse_quarantine_stock SET quantity=0 WHERE id='${QS_A}'`)).toBe('DENIED');
    expect(await denied(`DELETE FROM warehouse_quarantine_stock WHERE id='${QS_A}'`)).toBe('DENIED');
    expect(await denied(`UPDATE warehouse_return_requests SET status='submitted' WHERE id='${WR_A}'`)).toBe('DENIED');
    expect(await denied(
      `UPDATE phoenix_warehouse_correction_requests SET status='approved' WHERE id='${CORR_A}'`)).toBe('DENIED');
  });

  it('D · HCM mutation permission defaults are unchanged by 185', async () => {
    const r: any = await postAdmin(`
      SELECT COALESCE(string_agg(permission_key, ',' ORDER BY permission_key),'(none)') AS keys
        FROM role_permission_defaults
       WHERE role='health_center_manager' AND allowed
         AND permission_key ~ '(return|recall|quarantin|correct)'`);
    expect(r.rows[0].keys).toBe('(none)');
  });

  it('D · the HCM exception policy requires BOTH point AND destination assignment', async () => {
    // The behavioural exception fixture needs a full dispatch ancestry and is
    // tracked separately; what is asserted here is the policy's own shape, so a
    // future edit that drops either conjunct fails immediately.
    const r: any = await postAdmin(`
      SELECT qual FROM pg_policies
       WHERE schemaname='public' AND policyname='porer_select_health_center_facility'`);
    const qual = r.rows[0].qual as string;
    expect(qual).toMatch(/phoenix_profile_has_point_assignment/);
    expect(qual).toMatch(/phoenix_profile_has_warehouse_assignment/);
    expect(qual).toMatch(/health_center_manager/);
  });
});
