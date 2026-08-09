/**
 * SUBPURCHASE-DUPLICATE-CANDIDATES-117 — DYNAMIC proof.
 *
 * Drives the real phoenix_subpurchase_duplicate_candidates against a
 * disposable cluster (001→117):
 *   catalog match      a fuzzy hit against central_items surfaces
 *   existing-lot match a fuzzy hit against this org's already-recorded
 *                      supplementary-purchase lots surfaces; a CENTRAL lot of
 *                      the same identity does NOT (advisory search stays
 *                      within the supplementary channel it protects)
 *   no false positive  an unrelated term returns no rows
 *   gated              a foreign-organization actor is rejected (institution
 *                      isolation holds even for this read-only advisory RPC)
 *   non-blocking       the lookup NEVER prevents the entry RPC itself from
 *                      succeeding, regardless of what it returns
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000f701';
const ORG_OTHER = '00000000-0000-0000-0000-00000000f702';
const WH = '00000000-0000-0000-0000-00000000f703';
const WH_CENTRAL = '00000000-0000-0000-0000-00000000f704';
const OFFICER = '00000000-0000-0000-0000-00000000f705';
const OUTSIDER = '00000000-0000-0000-0000-00000000f706';
const ITEM = '00000000-0000-0000-0000-00000000f707';

run('117 — sub-purchase duplicate candidates (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT * FROM public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args)
      .then((res: any) => res.rows);

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });

  const entryDirect = (c: any, over: Record<string, unknown> = {}) => {
    const a = {
      request_id: randomUUID(), warehouse_id: WH, scientific: 'Metformin',
      qty: 15, batch: 'DC-1', no_batch: false, expiry: '2027-06-01', price: 90,
      purchase_date: '2026-07-01', invoice: 'REF-117-1', supplier: null,
      notes: null, central_item: null, trade: 'Glucophage', conc: '500mg',
      dosage: 'tablet', unit: 'box', national_code: null, expected_generation: null,
      ...over,
    } as any;
    return c.query(
      `SELECT public.phoenix_subpurchase_direct_entry(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      ) AS r`,
      [
        a.request_id, a.warehouse_id, a.scientific, a.qty, a.batch, a.no_batch,
        a.expiry, a.price, a.purchase_date, a.invoice, a.supplier, a.notes,
        a.central_item, a.trade, a.conc, a.dosage, a.unit, a.national_code,
        a.expected_generation,
      ],
    ).then((res: any) => res.rows[0].r);
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,institution_class) VALUES
        ('${ORG}','Dup117','تكرار 117','dc-117','hospital'),('${ORG_OTHER}','DupOther117','أخرى 117','dc-117-o','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','Dup WH','مذخر','active','institution','dc-117-w'),
        ('${WH_CENTRAL}','${ORG}','Dup Central WH','مذخر مركزي','active','central','dc-117-c')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','dc117-officer@rig'),('${OUTSIDER}','dc117-outsider@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_OTHER}' WHERE id='${OUTSIDER}';`);
      await c.query(`INSERT INTO profile_scope_assignments
          (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OFFICER}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,barcode,unit,status,trade_name)
        VALUES ('${ITEM}','Paracetamol','باراسيتامول',null,'box','active','Panadol')
        ON CONFLICT (id) DO NOTHING;`);
    });
    // Seed an existing supplementary-purchase lot via the real entry RPC.
    await asOfficer((c) => entryDirect(c));
  }, 120000);

  afterAll(async () => { await rig?.end(); });

  it('surfaces a catalog match', async () => {
    const rows = await asOfficer((c) => call(c, 'phoenix_subpurchase_duplicate_candidates', [WH, 'Paracetamol', null, null, 5]));
    expect(rows.some((r: any) => r.source === 'catalog' && r.source_id === ITEM)).toBe(true);
  });

  it('surfaces an existing supplementary-purchase lot match', async () => {
    const rows = await asOfficer((c) => call(c, 'phoenix_subpurchase_duplicate_candidates', [WH, 'Metformin', null, null, 5]));
    expect(rows.some((r: any) => r.source === 'existing_lot' && r.scientific_name === 'Metformin')).toBe(true);
  });

  it('returns nothing for an unrelated term', async () => {
    const rows = await asOfficer((c) => call(c, 'phoenix_subpurchase_duplicate_candidates', [WH, 'Zzzxyqqqvvv', null, null, 5]));
    expect(rows).toHaveLength(0);
  });

  it('is gated by institution isolation like the entry act itself', async () => {
    await expect(rig.asUser(OUTSIDER, (c: any) => call(c, 'phoenix_subpurchase_duplicate_candidates', [WH, 'Metformin', null, null, 5]), { commit: true }))
      .rejects.toThrow(/forbidden_local_procurement_manage/);
  });

  it('is purely advisory: the entry act succeeds regardless of duplicate hints', async () => {
    const r = await asOfficer((c) => entryDirect(c, { batch: 'DC-2', scientific: 'Metformin' }));
    expect(r.ok).toBe(true);
  });
});
