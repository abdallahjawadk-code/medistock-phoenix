import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 120000, hookTimeout: 420000 });
const run = rigAvailable() ? describe : describe.skip;

const A = '00000000-0000-0000-0000-000000199001';
const B = '00000000-0000-0000-0000-000000199002';
const WA = '00000000-0000-0000-0000-000000199101';
const WB = '00000000-0000-0000-0000-000000199102';
const PA = '00000000-0000-0000-0000-000000199201';
const PB = '00000000-0000-0000-0000-000000199202';
const SUPER = '00000000-0000-0000-0000-000000199301';
const IA = '00000000-0000-0000-0000-000000199302';
const WO = '00000000-0000-0000-0000-000000199303';
const OO = '00000000-0000-0000-0000-000000199304';
const CWM = '00000000-0000-0000-0000-000000199305';
const HCM = '00000000-0000-0000-0000-000000199306';

run('199 command center read contract — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const admin = (sql: string, params: unknown[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const rpc = (user: string, args: unknown[] = []) => rig.asUser(user, async (c: any) => {
    await c.query(`SET LOCAL statement_timeout='15s'`);
    return c.query(
      `SELECT public.phoenix_command_center_read_contract($1,$2,$3) AS r`,
      args,
    ).then((r: any) => r.rows[0].r);
  }, { commit: true });
  const call = (user: string, org: string | null, wh: string | null, point: string | null) =>
    rpc(user, [org, wh, point]);
  const rejects = async (work: () => Promise<unknown>) => {
    try { await work(); } catch (error: any) { return `${error.code ?? ''}:${error.message}`; }
    throw new Error('expected rejection');
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await admin(`
      INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${A}','RAC2 A','راك ٢ أ','rac2-a','care_institution','hospital','active'),
        ('${B}','RAC2 B','راك ٢ ب','rac2-b','care_institution','hospital','active');

      INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,is_main,status,code) VALUES
        ('${WA}','${A}','RAC2 A warehouse','مخزن راك أ','institution',true,'active','rac2-wa'),
        ('${WB}','${B}','RAC2 B warehouse','مخزن راك ب','institution',true,'active','rac2-wb');

      INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status) VALUES
        ('${PA}','${A}','${WA}','RAC2 A pharmacy','صيدلية راك أ','pharmacy','active'),
        ('${PB}','${B}','${WB}','RAC2 B pharmacy','صيدلية راك ب','pharmacy','active');

      INSERT INTO auth.users(id,email) VALUES
        ('${SUPER}','rac2-super@rig.local'),
        ('${IA}','rac2-ia@rig.local'),
        ('${WO}','rac2-wo@rig.local'),
        ('${OO}','rac2-oo@rig.local'),
        ('${CWM}','rac2-cwm@rig.local'),
        ('${HCM}','rac2-hcm@rig.local');

      UPDATE profiles SET role='super_admin',status='active',organization_id=NULL WHERE id='${SUPER}';
      UPDATE profiles SET role='institution_admin',status='active',organization_id='${A}' WHERE id='${IA}';
      UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${A}' WHERE id='${WO}';
      UPDATE profiles SET role='outlet_officer',status='active',organization_id='${A}' WHERE id='${OO}';
      UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${A}' WHERE id='${CWM}';
      UPDATE profiles SET role='health_center_manager',status='active',organization_id='${A}' WHERE id='${HCM}';

      INSERT INTO profile_scope_assignments(profile_id,organization_id,scope_type,warehouse_id,is_active)
        VALUES ('${WO}','${A}','warehouse','${WA}',true);
      INSERT INTO profile_scope_assignments(profile_id,organization_id,scope_type,distribution_point_id,is_active)
        VALUES ('${WO}','${A}','distribution_point','${PA}',true),
               ('${OO}','${A}','distribution_point','${PA}',true);

      INSERT INTO item_availability(
        distribution_point_id,organization_id,quantity,condition,scientific_name
      ) VALUES
        ('${PA}','${A}',12,'available','RAC2 A available'),
        ('${PA}','${A}',0,'missing','RAC2 A missing'),
        ('${PB}','${B}',7,'available','RAC2 B available');

      INSERT INTO warehouse_stock(
        organization_id,warehouse_id,scientific_name,
        has_no_national_code,has_no_batch_number,internal_batch_reference,
        expiry_date,on_hand_quantity,reserved_quantity
      ) VALUES
        ('${A}','${WA}','RAC2 warehouse near',true,true,'RAC2-WA-NEAR',current_date+30,10,2),
        ('${A}','${WA}','RAC2 warehouse expired',true,true,'RAC2-WA-EXPIRED',current_date-1,5,0),
        ('${B}','${WB}','RAC2 foreign warehouse',true,true,'RAC2-WB',current_date+400,20,0);

      INSERT INTO outlet_stock(
        organization_id,distribution_point_id,point_type,scientific_name,
        has_no_national_code,has_no_batch_number,internal_batch_reference,
        expiry_date,on_hand_quantity,reserved_quantity
      ) VALUES
        ('${A}','${PA}','pharmacy','RAC2 outlet near',true,true,'RAC2-PA-NEAR',current_date+40,8,1),
        ('${B}','${PB}','pharmacy','RAC2 foreign outlet',true,true,'RAC2-PB',current_date+400,9,0);
    `);
  });

  afterAll(async () => { if (rig) await rig.end(); });

  it('allows institution_admin only at its authorized organization and prevents organization counting leakage', async () => {
    const own = await call(IA, A, null, null);
    expect(own.scope.kind).toBe('organization');
    expect(own.scope.organization_id).toBe(A);
    expect(own.capabilities.dashboard_view).toBe(true);
    expect(Number(own.summary.availability_rows)).toBe(2);
    expect(Number(own.summary.available)).toBe(1);
    expect(Number(own.summary.missing)).toBe(1);
    expect(Number(own.network.organizations)).toBe(1);

    expect(await rejects(() => call(IA, B, null, null)))
      .toMatch(/^42501:command_center_forbidden/);
  });

  it('allows warehouse_officer only for an assigned warehouse and returns warehouse-only stock', async () => {
    const own = await call(WO, A, WA, null);
    expect(own.scope.kind).toBe('warehouse');
    expect(own.scope.warehouse_id).toBe(WA);
    expect(Number(own.summary.stock_lines)).toBe(2);
    expect(Number(own.summary.on_hand_units)).toBe(15);
    expect(Number(own.summary.available_units)).toBe(13);
    expect(Number(own.summary.expired_lines)).toBe(1);
    expect(Number(own.summary.near_expiry_lines)).toBe(1);
    expect(Number(own.network.organizations)).toBe(1);
    expect(Number(own.network.warehouses)).toBe(1);

    expect(await rejects(() => call(WO, B, WB, null)))
      .toMatch(/^42501:command_center_forbidden/);
  });

  it('supports an exactly assigned distribution-point scope without exposing sibling/foreign outlets', async () => {
    const own = await call(WO, A, null, PA);
    expect(own.scope.kind).toBe('distribution_point');
    expect(own.scope.distribution_point_id).toBe(PA);
    expect(Number(own.summary.stock_lines)).toBe(1);
    expect(Number(own.summary.on_hand_units)).toBe(8);
    expect(Number(own.network.organizations)).toBe(1);
    expect(Number(own.network.distribution_points)).toBe(1);

    expect(await rejects(() => call(WO, B, null, PB)))
      .toMatch(/^42501:command_center_forbidden/);
  });

  it('keeps outlet_officer, central_warehouse_manager and health_center_manager fail-closed under current defaults', async () => {
    for (const actor of [OO, CWM, HCM]) {
      const args: [string, string | null, string | null] =
        actor === OO ? [A, null, PA] : [A, null, null];
      expect(await rejects(() => call(actor, args[0], args[1], args[2])))
        .toMatch(/^42501:command_center_forbidden/);
    }
  });

  it('keeps dashboard authority non-delegable unless dashboard.view is explicitly reviewed into the delegation firewall', async () => {
    await rig.asUser(SUPER, (c: any) => c.query(
      `SELECT public.phoenix_admin_grant_delegated_scope($1,$2,'warehouse',$3,NULL,false)`,
      [WO, B, WB],
    ), { commit: true });

    expect(await rejects(() => call(WO, B, WB, null)))
      .toMatch(/^42501:command_center_forbidden/);
  });

  it('allows super_admin global and pins trend as explicitly deferred', async () => {
    const global = await call(SUPER, null, null, null);
    expect(global.scope.kind).toBe('global');
    expect(global.capabilities.dashboard_view).toBe(true);
    expect(Number(global.network.organizations)).toBeGreaterThanOrEqual(2);
    expect(global.trend).toBeNull();
    expect(global.trend_status).toBe('deferred_pending_measurement');
    expect(Number(global.near_expiry_days)).toBe(270);
  });

  it('rejects ambiguous scope and structurally rejects an unknown stored role', async () => {
    expect(await rejects(() => call(WO, A, WA, PA))).toMatch(/^22023:command_center_invalid_scope/);
    expect(await rejects(() => admin(`UPDATE profiles SET role='rac2_unknown_role' WHERE id=$1`, [WO])))
      .toMatch(/check constraint|profiles_role_check/i);
  });

  it('has hardened ACL/search_path and no PUBLIC/anon execute', async () => {
    const r = await admin(`SELECT
      p.prosecdef AS secdef,
      p.provolatile AS volatility,
      p.proconfig @> ARRAY['search_path=public, pg_temp']::text[] AS hardened_path,
      has_function_privilege('PUBLIC', p.oid, 'EXECUTE') AS public_exec,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
    FROM pg_proc p
    WHERE p.oid='public.phoenix_command_center_read_contract(uuid,uuid,uuid)'::regprocedure`);
    expect(r.rows[0]).toEqual({
      secdef: true,
      volatility: 's',
      hardened_path: true,
      public_exec: false,
      anon_exec: false,
      authenticated_exec: true,
    });
  });
});
