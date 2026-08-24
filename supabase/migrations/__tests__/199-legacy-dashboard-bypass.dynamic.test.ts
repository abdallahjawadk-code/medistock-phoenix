import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 120000, hookTimeout: 420000 });
const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000199501';
const POINT = '00000000-0000-0000-0000-000000199502';
const IA = '00000000-0000-0000-0000-000000199511';
const OO = '00000000-0000-0000-0000-000000199512';
const CWM = '00000000-0000-0000-0000-000000199513';
const HCM = '00000000-0000-0000-0000-000000199514';

run('199 legacy dashboard RPC bypass closure — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const admin = (sql: string, params: unknown[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const asUser = (user: string, sql: string, params: unknown[] = []) =>
    rig.asUser(user, (c: any) => c.query(sql, params), { commit: true });
  const rejects = async (work: () => Promise<unknown>) => {
    try { await work(); } catch (error: any) { return `${error.code ?? ''}:${error.message}`; }
    throw new Error('expected rejection');
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await admin(`
      INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class,status)
      VALUES ('${ORG}','RAC2 legacy gate','بوابة راك','rac2-gate','care_institution','hospital','active');
      INSERT INTO distribution_points(id,organization_id,name,name_ar,point_type,status)
      VALUES ('${POINT}','${ORG}','RAC2 pharmacy','صيدلية راك','pharmacy','active');
      INSERT INTO auth.users(id,email) VALUES
        ('${IA}','rac2-gate-ia@rig.local'),
        ('${OO}','rac2-gate-oo@rig.local'),
        ('${CWM}','rac2-gate-cwm@rig.local'),
        ('${HCM}','rac2-gate-hcm@rig.local');
      UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG}' WHERE id='${IA}';
      UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO}';
      UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';
      UPDATE profiles SET role='health_center_manager',status='active',organization_id='${ORG}' WHERE id='${HCM}';
      INSERT INTO item_availability(distribution_point_id,organization_id,quantity,condition,scientific_name)
      VALUES ('${POINT}','${ORG}',5,'available','RAC2 gated material');
    `);
  });

  afterAll(async () => { if (rig) await rig.end(); });

  it('keeps authorized institution_admin behavior and response shape', async () => {
    const counts = await asUser(
      IA,
      `SELECT public.phoenix_get_dashboard_condition_counts($1) AS r`,
      [ORG],
    );
    expect(counts.rows[0].r).toMatchObject({
      available: 1,
      low_stock: 0,
      missing: 0,
      near_expiry: 0,
      surplus: 0,
    });

    const institutions = await asUser(
      IA,
      `SELECT * FROM public.phoenix_get_institution_condition_counts()`,
    );
    expect(institutions.rows).toHaveLength(1);
    expect(institutions.rows[0].organization_id).toBe(ORG);
  });

  it('denies the old condition-count RPC to authenticated roles without dashboard.view', async () => {
    for (const actor of [OO, CWM]) {
      expect(await rejects(() => asUser(
        actor,
        `SELECT public.phoenix_get_dashboard_condition_counts($1)`,
        [ORG],
      ))).toMatch(/^42501:dashboard_view_forbidden/);
    }
  });

  it('denies the old institution-count RPC to authenticated roles without dashboard.view', async () => {
    for (const actor of [OO, CWM]) {
      expect(await rejects(() => asUser(
        actor,
        `SELECT * FROM public.phoenix_get_institution_condition_counts()`,
      ))).toMatch(/^42501:dashboard_view_forbidden/);
    }
  });

  it('preserves health_center_manager legacy empty/zero compatibility without leaking data', async () => {
    const counts = await asUser(
      HCM,
      `SELECT public.phoenix_get_dashboard_condition_counts($1) AS r`,
      [ORG],
    );
    expect(counts.rows[0].r).toEqual({
      available: 0,
      low_stock: 0,
      missing: 0,
      near_expiry: 0,
      surplus: 0,
    });

    const institutions = await asUser(
      HCM,
      `SELECT * FROM public.phoenix_get_institution_condition_counts()`,
    );
    expect(institutions.rows).toEqual([]);
  });
});
