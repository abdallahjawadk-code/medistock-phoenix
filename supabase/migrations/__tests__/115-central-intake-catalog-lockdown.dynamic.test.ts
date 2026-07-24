/**
 * CENTRAL-INTAKE-MANUAL-IDENTITY-118 — dynamic final-state proof.
 *
 * Runs against the full migration replay and proves the corrected contract:
 * Pharmacy Department central warehouses accept manual identity only,
 * central purchases stay separate from supplementary purchases, institution
 * warehouses remain receive-only, and the unguarded writer remains sealed.
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

run('118 — Pharmacy Department manual central intake (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const receive = (c: any, over: Record<string, unknown> = {}) => {
    const a = {
      request_id: randomUUID(), warehouse_id: WH_CENTRAL,
      scientific: 'Manual Scientific', qty: 10,
      no_national: false, no_batch: false, expected_generation: 0,
      central_item: null,
      trade: 'Manual Trade', conc: '250mg', dosage: 'tablet',
      unit: 'box', national: 'MANUAL-NC-1', batch: 'MANUAL-B-1',
      expiry: '2028-01-31', price: 125, price_basis: null, currency: 'IQD',
      supply_type_text: null, source_doc: 'BOOK-118', notes: 'manual central intake',
      supply_type: 'purchase', origin: null,
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

  const asOfficer = (fn: (c: any) => Promise<any>) =>
    rig.asUser(OFFICER, fn, { commit: true });

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Central118','مركزية 118','ci-118') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','Central WH','مخزن قسم الصيدلة','active','central','ci-118-c'),
        ('${WH_INSTITUTION}','${ORG}','Institution WH','مذخر مؤسسة','active','institution','ci-118-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','ci118-officer@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`INSERT INTO profile_scope_assignments
          (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES
          ('${OFFICER}','${ORG}','warehouse','${WH_CENTRAL}',true),
          ('${OFFICER}','${ORG}','warehouse','${WH_INSTITUTION}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,barcode,unit,status)
        VALUES ('${ITEM}','Catalog Item','مادة كتالوج','CAT-118','box','active')
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => { await rig?.end(); });

  it('accepts a manually entered central purchase and stamps purchase_origin=central', async () => {
    const requestId = randomUUID();
    const first = await asOfficer(c => receive(c, { request_id: requestId }));
    expect(first.ok).toBe(true);

    const stock = await rig.asAdmin((c: any) => c.query(
      `SELECT scientific_name,trade_name,concentration,dosage_form,national_code,
              central_item_id,supply_type,purchase_origin,on_hand_quantity
         FROM warehouse_stock WHERE id=$1`,
      [first.warehouse_stock_id],
    ).then((x: any) => x.rows[0]));

    expect(stock).toMatchObject({
      scientific_name: 'Manual Scientific',
      trade_name: 'Manual Trade',
      concentration: '250mg',
      dosage_form: 'tablet',
      national_code: 'MANUAL-NC-1',
      central_item_id: null,
      supply_type: 'purchase',
      purchase_origin: 'central',
      on_hand_quantity: 10,
    });

    const replay = await asOfficer(c => receive(c, { request_id: requestId }));
    expect(replay.ok).toBe(true);
    expect(replay.idempotent_replay ?? replay.replayed).toBe(true);

    const movementCount = await rig.asAdmin((c: any) => c.query(
      `SELECT count(*)::int AS n FROM warehouse_stock_movements
        WHERE reference_type='warehouse_request' AND reference_id=$1`,
      [requestId],
    ).then((x: any) => x.rows[0].n));
    expect(movementCount).toBe(1);
  });

  it('rejects an optional catalog selection before any ledger mutation', async () => {
    const requestId = randomUUID();
    await expect(asOfficer(c => receive(c, {
      request_id: requestId,
      central_item: ITEM,
      national: 'CAT-NC-118',
      batch: 'CAT-B-118',
    })))
      .rejects.toThrow(/central_catalog_selection_forbidden/);
    const n = await rig.asAdmin((c: any) => c.query(
      `SELECT count(*)::int AS n FROM warehouse_stock_movements WHERE reference_id=$1`,
      [requestId],
    ).then((x: any) => x.rows[0].n));
    expect(n).toBe(0);
  });

  it('rejects supplementary origin in the central corridor without changing stock', async () => {
    const before = await rig.asAdmin((c: any) => c.query(
      `SELECT COALESCE(sum(on_hand_quantity),0)::int AS q FROM warehouse_stock WHERE warehouse_id=$1`,
      [WH_CENTRAL],
    ).then((x: any) => x.rows[0].q));
    await expect(asOfficer(c => receive(c, {
      request_id: randomUUID(), origin: 'supplementary', national: 'MANUAL-NC-2', batch: 'MANUAL-B-2',
    }))).rejects.toThrow(/central_intake_supplementary_origin_forbidden/);
    const after = await rig.asAdmin((c: any) => c.query(
      `SELECT COALESCE(sum(on_hand_quantity),0)::int AS q FROM warehouse_stock WHERE warehouse_id=$1`,
      [WH_CENTRAL],
    ).then((x: any) => x.rows[0].q));
    expect(after).toBe(before);
  });

  it('requires a closed supply type and consistent explicit identity flags', async () => {
    await expect(asOfficer(c => receive(c, { request_id: randomUUID(), supply_type: null })))
      .rejects.toThrow(/supply_type_required/);
    await expect(asOfficer(c => receive(c, {
      request_id: randomUUID(), no_national: true, national: 'SHOULD-BE-EMPTY',
    }))).rejects.toThrow(/national_code_flag_mismatch/);
  });

  it('keeps institution warehouses receive-only (103 preserved)', async () => {
    await expect(asOfficer(c => receive(c, {
      request_id: randomUUID(), warehouse_id: WH_INSTITUTION,
    }))).rejects.toThrow(/institution_warehouse_direct_receipt_forbidden/);
  });

  it('keeps the raw writer sealed and the guarded writer available', async () => {
    const acl = await rig.asAdmin((c: any) => c.query(`
      SELECT
        has_function_privilege(
          'authenticated',
          'public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text,text,text)',
          'EXECUTE'
        ) AS raw_exec,
        has_function_privilege(
          'authenticated',
          'public.phoenix_receive_warehouse_stock_guarded(uuid,uuid,text,integer,boolean,boolean,bigint,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text,text,text)',
          'EXECUTE'
        ) AS guarded_exec,
        (
          SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='phoenix_receive_warehouse_stock'
        ) AS raw_overloads
    `).then((x: any) => x.rows[0]));
    expect(acl).toEqual({ raw_exec: false, guarded_exec: true, raw_overloads: 1 });
  });
});
