/**
 * SUPPLY-SOURCES-DETAIL-120 — DYNAMIC proof.
 *
 * Drives phoenix_supply_sources_detail against a disposable cluster
 * (001->120):
 *   reconciles with 119    grouped-and-summed detail rows equal
 *                          phoenix_executive_overview's own totals exactly
 *   detail never lost      each physical lot is its own row, not pre-summed
 *   bucket filter           an explicit supply_bucket narrows correctly
 *   RBAC/org isolation      reports.view required; a foreign-org actor is
 *                           rejected and never sees another org's rows
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000f901';
const ORG_OTHER = '00000000-0000-0000-0000-00000000f902';
const WH = '00000000-0000-0000-0000-00000000f903';
const DP = '00000000-0000-0000-0000-00000000f904';
const OFFICER = '00000000-0000-0000-0000-00000000f905';
const OUTSIDER = '00000000-0000-0000-0000-00000000f906';

run('120 — supply sources detail (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });

  const overview = (c: any) =>
    c.query(`SELECT public.phoenix_executive_overview($1) AS r`, [ORG]).then((res: any) => res.rows[0].r);

  const detail = (c: any, bucket: string | null = null) =>
    c.query(`SELECT * FROM public.phoenix_supply_sources_detail($1,$2)`, [ORG, bucket])
      .then((res: any) => res.rows);

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Detail Org','مؤسسة التفصيل','sd-120'),
        ('${ORG_OTHER}','Other Org','أخرى','sd-120-o')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','Central WH','مذخر مركزي','active','central','sd-120-w')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,organization_id,warehouse_id,name,name_ar,point_type,status) VALUES
        ('${DP}','${ORG}','${WH}','Pharmacy','صيدلية','pharmacy','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_stock (
          organization_id, warehouse_id, scientific_name, on_hand_quantity,
          has_no_national_code, has_no_batch_number, internal_batch_reference,
          supply_type, purchase_origin
        ) VALUES
        ('${ORG}','${WH}','Kimadia A',10,true,true,'SD120NB-1','kimadia',NULL),
        ('${ORG}','${WH}','Kimadia B',15,true,true,'SD120NB-2','kimadia',NULL),
        ('${ORG}','${WH}','Central Purchase A',20,true,true,'SD120NB-3','purchase','central')
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO outlet_stock (
          organization_id, distribution_point_id, point_type, scientific_name, on_hand_quantity,
          has_no_national_code, has_no_batch_number, internal_batch_reference,
          supply_type, purchase_origin
        ) VALUES
        ('${ORG}','${DP}','pharmacy','Aid Item',7,true,true,'SD120ONB-1','aid',NULL)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','sd120-officer@rig'),('${OUTSIDER}','sd120-outsider@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_OTHER}' WHERE id='${OUTSIDER}';`);
    });
  }, 120000);

  afterAll(async () => { await rig?.end(); });

  it('each physical lot is its own row — detail is never pre-summed', async () => {
    const rows = await asOfficer((c) => detail(c));
    const kimadiaRows = rows.filter((r: any) => r.supply_bucket === 'kimadia');
    expect(kimadiaRows).toHaveLength(2);
    expect(kimadiaRows.map((r: any) => r.scientific_name).sort()).toEqual(['Kimadia A', 'Kimadia B']);
  });

  it('grouped-and-summed detail reconciles exactly with the 119 executive overview totals', async () => {
    const [live, rows] = await asOfficer(async (c) => [await overview(c), await detail(c)]);
    const summed: Record<string, { warehouse: number; outlet: number }> = {};
    for (const r of rows) {
      summed[r.supply_bucket] ??= { warehouse: 0, outlet: 0 };
      summed[r.supply_bucket][r.location_kind as 'warehouse' | 'outlet'] += r.on_hand_quantity;
    }
    expect(summed.kimadia.warehouse).toBe(live.supply_source_totals.warehouse.kimadia);
    expect(summed.purchase_central.warehouse).toBe(live.supply_source_totals.warehouse.purchase_central);
    expect(summed.aid.outlet).toBe(live.supply_source_totals.outlet.aid);
  });

  it('an explicit bucket filter narrows correctly', async () => {
    const rows = await asOfficer((c) => detail(c, 'kimadia'));
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.supply_bucket === 'kimadia')).toBe(true);
  });

  it('rejects an invalid bucket value', async () => {
    await expect(asOfficer((c) => detail(c, 'not_a_real_bucket'))).rejects.toThrow(/invalid_supply_bucket/);
  });

  it('rejects a caller without reports.view / org membership, and leaks no rows cross-org', async () => {
    await expect(rig.asUser(OUTSIDER, (c: any) => detail(c), { commit: true }))
      .rejects.toThrow(/forbidden_reports_view/);
  });
});
