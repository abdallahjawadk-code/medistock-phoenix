/**
 * CENTRAL-INTAKE-CATALOG-LOCKDOWN-115 — DYNAMIC proof.
 *
 * Drives the real phoenix_receive_warehouse_stock against a disposable
 * cluster (001→115):
 *   catalog-only    a central-warehouse receipt WITHOUT p_central_item_id is
 *                   refused (central_item_required); manual identity entry
 *                   is reserved for supplementary purchases only
 *   server-owned    when a valid catalog item is given, ANY client-sent free
 *                   text for scientific_name/trade_name/concentration/
 *                   dosage_form/national_code is IGNORED — the catalog row's
 *                   values are what actually land in warehouse_stock
 *   still gated     an inactive/unknown central_item_id is refused
 *   103 preserved   institution warehouses remain forbidden outright
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000f501';
const WH_CENTRAL = '00000000-0000-0000-0000-00000000f502';
const WH_INSTITUTION = '00000000-0000-0000-0000-00000000f503';
const OFFICER = '00000000-0000-0000-0000-00000000f504';
const ITEM = '00000000-0000-0000-0000-00000000f505';
const ITEM_INACTIVE = '00000000-0000-0000-0000-00000000f506';

run('115 — central intake catalog lockdown (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  // The real frontend never calls phoenix_receive_warehouse_stock directly —
  // it always goes through the 078/088 guarded wrapper (which is granted to
  // authenticated; the raw function's EXECUTE is intentionally revoked from
  // clients, matching 088's ACL, and 115 does not change that). The guarded
  // wrapper delegates straight into the 115 body, so the lock applies
  // identically through it.
  const receive = (c: any, over: Record<string, unknown> = {}) => {
    const a = {
      request_id: randomUUID(), warehouse_id: WH_CENTRAL,
      scientific: 'client-typed-name-should-be-ignored', qty: 10,
      no_national: false, no_batch: false, expected_generation: 0,
      central_item: ITEM,
      trade: 'client-typed-trade', conc: 'client-conc', dosage: 'client-dosage',
      unit: 'box', national: 'CLIENT-CODE', batch: 'B-1', expiry: '2027-01-01',
      price: 100, price_basis: null, currency: null, supply_type_text: null,
      source_doc: null, notes: null, supply_type: 'kimadia', origin: null,
      ...over,
    } as any;
    return c.query(
      `SELECT public.phoenix_receive_warehouse_stock_guarded(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
      ) AS r`,
      [
        a.request_id, a.warehouse_id, a.scientific, a.qty, a.no_national, a.no_batch,
        a.expected_generation, a.central_item, a.trade, a.conc, a.dosage, a.unit,
        a.national, a.batch, a.expiry, a.price, a.price_basis, a.currency,
        a.supply_type_text, a.source_doc, a.notes, a.supply_type, a.origin,
      ],
    ).then((res: any) => res.rows[0].r);
  };

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Central115','مركزية 115','ci-115') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','Central WH','مذخر مركزي','active','central','ci-115-c'),
        ('${WH_INSTITUTION}','${ORG}','Inst WH','مذخر مؤسسة','active','institution','ci-115-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','ci115-officer@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`INSERT INTO profile_scope_assignments
          (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES
          ('${OFFICER}','${ORG}','warehouse','${WH_CENTRAL}',true),
          ('${OFFICER}','${ORG}','warehouse','${WH_INSTITUTION}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,barcode,unit,status,trade_name,concentration,dosage_form)
        VALUES ('${ITEM}','Catalog Scientific','الاسم القياسي','CAT-BARCODE-1','box','active','Catalog Trade','200mg','tablet')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,barcode,unit,status)
        VALUES ('${ITEM_INACTIVE}','Inactive Item','مادة غير فعالة',null,'box','inactive')
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => { await rig?.end(); });

  it('refuses a central receipt with no central_item_id — manual identity entry is not available here', async () => {
    await expect(asOfficer((c) => receive(c, { central_item: null })))
      .rejects.toThrow(/central_item_required/);
  });

  it('refuses an inactive/unknown catalog item', async () => {
    await expect(asOfficer((c) => receive(c, { central_item: ITEM_INACTIVE, request_id: randomUUID() })))
      .rejects.toThrow(/central_item_not_found_or_inactive/);
    await expect(asOfficer((c) => receive(c, { central_item: randomUUID(), request_id: randomUUID() })))
      .rejects.toThrow(/central_item_not_found_or_inactive/);
  });

  it('a valid catalog item ignores ALL client free text and writes the CATALOG identity', async () => {
    const r = await asOfficer((c) => receive(c, { request_id: randomUUID() }));
    expect(r.ok).toBe(true);
    const stock = await rig.asAdmin((c: any) => c.query(
      `SELECT scientific_name, trade_name, concentration, dosage_form, national_code, central_item_id
         FROM warehouse_stock WHERE id=$1`, [r.warehouse_stock_id])
      .then((x: any) => x.rows[0]));
    expect(stock.scientific_name).toBe('Catalog Scientific');
    expect(stock.trade_name).toBe('Catalog Trade');
    expect(stock.concentration).toBe('200mg');
    expect(stock.dosage_form).toBe('tablet');
    expect(stock.national_code).toBe('CAT-BARCODE-1');
    expect(stock.central_item_id).toBe(ITEM);
  });

  it('institution warehouses remain forbidden outright (103 preserved)', async () => {
    await expect(asOfficer((c) => receive(c, { warehouse_id: WH_INSTITUTION, request_id: randomUUID() })))
      .rejects.toThrow(/institution_warehouse_direct_receipt_forbidden/);
  });
});
