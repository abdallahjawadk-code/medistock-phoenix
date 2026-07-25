/**
 * REPORT-SNAPSHOTS-AND-EXECUTIVE-OVERVIEW-119 — DYNAMIC proof.
 *
 * Drives phoenix_executive_overview and phoenix_create_report_snapshot
 * against a disposable cluster (001->119):
 *   canonical aggregate   classification counts come from item_availability,
 *                         supply-source totals from warehouse_stock/
 *                         outlet_stock — no new classification math
 *   snapshot = live       a snapshot's payload matches a same-moment call to
 *                         the live RPC
 *   official numbering    server-generated RP-YYYY-nnnnnn, never client
 *   immutability           UPDATE/DELETE always fails, even for the owner
 *   idempotency            lost-response retry replays; changed payload
 *                          under the same request id fails closed
 *   RBAC/org isolation     reports.view is required; a foreign-org actor is
 *                          rejected and never sees another org's data
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000f801';
const ORG_OTHER = '00000000-0000-0000-0000-00000000f802';
const WH = '00000000-0000-0000-0000-00000000f803';
const DP = '00000000-0000-0000-0000-00000000f804';
const LOCAL_ITEM = '00000000-0000-0000-0000-00000000f805';
const CENTRAL_ITEM = '00000000-0000-0000-0000-00000000f806';
const OFFICER = '00000000-0000-0000-0000-00000000f807';
const OUTSIDER = '00000000-0000-0000-0000-00000000f808';

run('119 — report snapshots and executive overview (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });

  const overview = (c: any, org = ORG) =>
    c.query(`SELECT public.phoenix_executive_overview($1) AS r`, [org]).then((res: any) => res.rows[0].r);

  const snapshot = (c: any, over: Record<string, unknown> = {}) => {
    const a = {
      request_id: randomUUID(), org: ORG, report_type: 'executive_overview',
      filters: {}, period: null,
      ...over,
    } as any;
    return c.query(
      `SELECT public.phoenix_create_report_snapshot($1,$2,$3,$4,$5) AS r`,
      [a.request_id, a.org, a.report_type, a.filters, a.period],
    ).then((res: any) => res.rows[0].r);
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Reports Org','مؤسسة التقارير','rp-119'),
        ('${ORG_OTHER}','Other Org','أخرى','rp-119-o')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','Central WH','مذخر مركزي','active','central','rp-119-w')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,organization_id,warehouse_id,name,name_ar,point_type,status) VALUES
        ('${DP}','${ORG}','${WH}','Pharmacy','صيدلية','pharmacy','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,unit,status) VALUES
        ('${CENTRAL_ITEM}','Reported Item','مادة مُبلَّغة','box','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO local_items (id,central_item_id,organization_id,status) VALUES
        ('${LOCAL_ITEM}','${CENTRAL_ITEM}','${ORG}','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO item_availability (local_item_id,distribution_point_id,organization_id,quantity,condition) VALUES
        ('${LOCAL_ITEM}','${DP}','${ORG}',5,'low_stock')
        ON CONFLICT (local_item_id, distribution_point_id) DO UPDATE SET quantity=5, condition='low_stock';`);
      await c.query(`INSERT INTO warehouse_stock (
          organization_id, warehouse_id, scientific_name, on_hand_quantity,
          has_no_national_code, has_no_batch_number, internal_batch_reference,
          supply_type, purchase_origin
        ) VALUES
        ('${ORG}','${WH}','Kimadia Item',40,true,true,'RP119NB-1','kimadia',NULL),
        ('${ORG}','${WH}','Central Purchase Item',25,true,true,'RP119NB-2','purchase','central')
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','rp119-officer@rig'),('${OUTSIDER}','rp119-outsider@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_OTHER}' WHERE id='${OUTSIDER}';`);
    });
  }, 120000);

  afterAll(async () => { await rig?.end(); });

  it('aggregates classification counts from item_availability and supply totals from warehouse_stock — no new classification math', async () => {
    const r = await asOfficer((c) => overview(c));
    expect(r.organization_id).toBe(ORG);
    expect(r.classification_counts.low_stock).toBe(1);
    expect(r.supply_source_totals.warehouse.kimadia).toBe(40);
    expect(r.supply_source_totals.warehouse.purchase_central).toBe(25);
    expect(r.materials_tracked).toBe(1);
  });

  it('rejects a caller without reports.view / without org membership', async () => {
    await expect(rig.asUser(OUTSIDER, (c: any) => overview(c, ORG), { commit: true }))
      .rejects.toThrow(/forbidden_reports_view/);
  });

  it('a snapshot freezes the SAME payload the live RPC returns for that org', async () => {
    const live = await asOfficer((c) => overview(c));
    const snap = await asOfficer((c) => snapshot(c));
    expect(snap.ok).toBe(true);
    expect(snap.official_number).toMatch(/^RP-\d{4}-\d{6}$/);

    const row = await rig.asAdmin((c: any) => c.query(
      `SELECT payload, qr_payload FROM phoenix_report_snapshots WHERE id=$1`, [snap.id])
      .then((x: any) => x.rows[0]));
    expect(row.payload.classification_counts).toEqual(live.classification_counts);
    expect(row.payload.supply_source_totals).toEqual(live.supply_source_totals);
    expect(row.qr_payload).toBe(`phxrpt:1:xov:${snap.id}`);
  });

  it('a lost-response retry replays the SAME snapshot exactly once', async () => {
    const requestId = randomUUID();
    const first = await asOfficer((c) => snapshot(c, { request_id: requestId }));
    const replay = await asOfficer((c) => snapshot(c, { request_id: requestId }));
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.id).toBe(first.id);
    const n = await rig.asAdmin((c: any) => c.query(
      `SELECT count(*)::int AS n FROM phoenix_report_snapshots WHERE request_id=$1`, [requestId])
      .then((x: any) => x.rows[0].n));
    expect(n).toBe(1);
  });

  it('a changed payload under the same request id fails closed', async () => {
    const requestId = randomUUID();
    await asOfficer((c) => snapshot(c, { request_id: requestId, filters: { a: 1 } }));
    await expect(asOfficer((c) => snapshot(c, { request_id: requestId, filters: { a: 2 } })))
      .rejects.toThrow(/request_id_conflict/);
  });

  it('an official snapshot is immutable — UPDATE and DELETE both fail, even for the table owner', async () => {
    const snap = await asOfficer((c) => snapshot(c, { request_id: randomUUID() }));
    await expect(rig.asAdmin((c: any) =>
      c.query(`UPDATE phoenix_report_snapshots SET official_number='RP-0000-000000' WHERE id=$1`, [snap.id])))
      .rejects.toThrow(/report_snapshot_is_immutable/);
    await expect(rig.asAdmin((c: any) =>
      c.query(`DELETE FROM phoenix_report_snapshots WHERE id=$1`, [snap.id])))
      .rejects.toThrow(/report_snapshot_is_immutable/);
  });

  it('a snapshot from one org is invisible to a foreign-org reader (RLS)', async () => {
    const snap = await asOfficer((c) => snapshot(c, { request_id: randomUUID() }));
    const seenByOutsider = await rig.asUser(OUTSIDER, (c: any) =>
      c.query(`SELECT id FROM phoenix_report_snapshots WHERE id=$1`, [snap.id]).then((x: any) => x.rows),
      { commit: true });
    expect(seenByOutsider).toHaveLength(0);
  });

  it('the act is fully audited', async () => {
    const n = await rig.asAdmin((c: any) => c.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action='reports.snapshot_created' AND organization_id=$1`, [ORG])
      .then((x: any) => x.rows[0].n));
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
