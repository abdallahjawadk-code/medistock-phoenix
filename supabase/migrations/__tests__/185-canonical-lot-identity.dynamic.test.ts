/**
 * 185 · R1.5-A CANONICAL LOT IDENTITY — dynamic proof against a real 001->185 chain.
 *
 * 150 made material identity canonical and rebuilt the identity indexes on the
 * GENERATED material_identity_key. Four functions still resolved their
 * destination row with a RAW SUBSET of that identity, so two legitimately
 * distinct lots could both match and an arbitrary one was credited.
 *
 * This file proves the closure where it is cheapest to prove it EXACTLY:
 * phoenix_release_quarantine_stock takes the destination row id directly, so
 * the whole matrix can be exercised without any shipment scaffolding standing
 * between the assertion and the identity predicate.
 *
 * Every rejection is proved by MEASURING quantities, never by reading an
 * exception string alone: a guard that raised but still moved stock would pass
 * a message-only assertion.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000, hookTimeout: 300000 });

const run = rigAvailable() ? describe : describe.skip;

let seq = 0;
const uid = () => `00000000-0000-0000-0000-${String(185000000000 + (seq += 1))}`;

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  throw new Error('expected a rejection but the call succeeded');
};

const ORG = uid(), WH = uid(), FAC_USER = uid();

/** One quarantined lot, and a family of destination rows that differ from it
 *  in exactly ONE canonical component each. */
const Q_ROW = uid();
const DEST_EXACT = uid();
const DEST_WRONG_UNIT = uid();
const DEST_WRONG_CENTRAL = uid();
const DEST_WRONG_SUPPLY = uid();
const DEST_WRONG_ORIGIN = uid();
const CENTRAL_A = uid(), CENTRAL_B = uid();

run('185 · R1.5-A canonical lot identity (001->185 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  const qty = async (table: string, id: string, col: string): Promise<number> => {
    const r: any = await asAdmin(`SELECT ${col} AS q FROM public.${table} WHERE id=$1`, [id]);
    return r.rows[0].q;
  };

  /** Snapshot every ledger a release could possibly touch. */
  const ledgers = async () => {
    const r: any = await asAdmin(`
      SELECT (SELECT count(*) FROM warehouse_stock_movements)            AS ws_mov,
             (SELECT count(*) FROM warehouse_quarantine_stock_movements) AS wq_mov,
             (SELECT COALESCE(sum(on_hand_quantity),0) FROM warehouse_stock)  AS ws_total,
             (SELECT COALESCE(sum(quantity),0) FROM warehouse_quarantine_stock) AS wq_total,
             (SELECT count(*) FROM audit_logs)                            AS audits`);
    return r.rows[0];
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
      VALUES ('${ORG}','R15 Hosp','مستشفى','r15-h','care_institution','hospital','active');

      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
      VALUES ('${WH}','${ORG}','R15 WH','مخزن','institution',NULL,true,'active');

      INSERT INTO central_items (id,name,name_ar,unit,status)
      VALUES ('${CENTRAL_A}','R15-MAT','مادة','box','active'),
             ('${CENTRAL_B}','R15-MAT-2','مادة٢','box','active');
    `);

    // The quarantined lot. Its canonical identity is:
    //   central=CENTRAL_A, scientific=R15-MAT, national=NC-1,
    //   concentration=500mg, form=tab, unit=box
    // ...with batch B-1, expiry 2030-01-01, no internal ref, supply/origin set.
    await asAdmin(`
      INSERT INTO warehouse_quarantine_stock
        (id, organization_id, warehouse_id, central_item_id, scientific_name,
         concentration, dosage_form, unit, national_code, has_no_national_code,
         batch_number, has_no_batch_number, expiry_date, quarantine_reason,
         quantity, supply_type, purchase_origin)
      VALUES ($1,$2,$3,$4,'R15-MAT','500mg','tab','box','NC-1',false,
              'B-1',false,'2030-01-01','damaged',100,'purchase','central')
    `, [Q_ROW, ORG, WH, CENTRAL_A]);

    // Destination candidates. EVERY one shares scientific_name + batch_number +
    // expiry_date with the quarantined lot, which is exactly what the pre-R1.5
    // predicate compared - so before 185 all six were acceptable destinations.
    const mk = (id: string, over: Record<string, unknown>) => {
      const base: Record<string, unknown> = {
        central_item_id: CENTRAL_A, scientific_name: 'R15-MAT', concentration: '500mg',
        dosage_form: 'tab', unit: 'box', national_code: 'NC-1', batch_number: 'B-1',
        expiry_date: '2030-01-01', internal_batch_reference: null,
        supply_type: 'purchase', purchase_origin: 'central', ...over,
      };
      return asAdmin(`
        INSERT INTO warehouse_stock
          (id, organization_id, warehouse_id, central_item_id, scientific_name,
           concentration, dosage_form, unit, national_code, has_no_national_code,
           batch_number, has_no_batch_number, internal_batch_reference,
           expiry_date, on_hand_quantity, reserved_quantity, movement_seq,
           supply_type, purchase_origin)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,false,$11,$12,0,0,0,$13,$14)`,
        [id, ORG, WH, base.central_item_id, base.scientific_name, base.concentration,
         base.dosage_form, base.unit, base.national_code, base.batch_number,
         base.internal_batch_reference, base.expiry_date, base.supply_type,
         base.purchase_origin]);
    };

    await mk(DEST_EXACT, {});
    await mk(DEST_WRONG_UNIT, { unit: 'vial' });
    await mk(DEST_WRONG_CENTRAL, { central_item_id: CENTRAL_B });
    // supply_type='aid' forces purchase_origin NULL (the table couples them),
    // so this row diverges on the supply half of the lot tuple.
    await mk(DEST_WRONG_SUPPLY, { supply_type: 'aid', purchase_origin: null });
    await mk(DEST_WRONG_ORIGIN, { purchase_origin: 'supplementary' });
    // NOT constructible, and deliberately so: warehouse_stock_internal_ref_rule_chk
    // couples internal_batch_reference to has_no_batch_number, so that component
    // cannot diverge while batch_number stays equal. It is still part of the
    // hardened predicate; it simply cannot be isolated in this fixture.

    // The actor: a warehouse officer genuinely scoped to this warehouse, so the
    // RPC's own auth.uid() and scoped-permission gates are really satisfied and
    // the refusal below can only come from the identity check.
    await asAdmin(`
      INSERT INTO auth.users (id,email) VALUES ('${FAC_USER}','r15@rig') ON CONFLICT (id) DO NOTHING;
      UPDATE profiles SET role='warehouse_officer', status='active', organization_id='${ORG}'
       WHERE id='${FAC_USER}';
      INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
      VALUES ('${FAC_USER}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;
    `);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  const release = (dest: string, quantity = 10) =>
    rig.asUser(FAC_USER, (c: any) => c.query(
      `SELECT public.phoenix_release_quarantine_stock($1,$2,$3,$4,$5)`,
      [uid(), Q_ROW, quantity, 'r15 release', dest]), { commit: true });

  describe('the destinations that share scientific_name + batch + expiry', () => {
    // These are the rows the PRE-R1.5 predicate could not tell apart. Each is a
    // different single-component divergence from the quarantined lot's canonical
    // identity, and each must now be refused.
    const wrong: Array<[string, string]> = [
      ['a different UNIT', DEST_WRONG_UNIT],
      ['a different CENTRAL ITEM identity', DEST_WRONG_CENTRAL],
      ['a different SUPPLY TYPE', DEST_WRONG_SUPPLY],
      ['a different PURCHASE ORIGIN', DEST_WRONG_ORIGIN],
    ];

    for (const [label, dest] of wrong) {
      it(`REJECTS release into a lot with ${label}, and moves nothing`, async () => {
        const before = await ledgers();
        expect(await rejects(() => release(dest)))
          .toMatch(/destination_material_batch_expiry_mismatch/);

        // A refusal must be transactionally empty.
        expect(await ledgers()).toEqual(before);
        expect(await qty('warehouse_stock', dest, 'on_hand_quantity')).toBe(0);
        expect(await qty('warehouse_quarantine_stock', Q_ROW, 'quantity')).toBe(100);
      });
    }

    it('ACCEPTS release into the exactly-matching canonical lot', async () => {
      // The narrowing must close the wrong doors, not the right one.
      await release(DEST_EXACT, 10);
      expect(await qty('warehouse_stock', DEST_EXACT, 'on_hand_quantity')).toBe(10);
      expect(await qty('warehouse_quarantine_stock', Q_ROW, 'quantity')).toBe(90);

      // ...and none of the near-miss lots received anything.
      for (const dest of [DEST_WRONG_UNIT, DEST_WRONG_CENTRAL, DEST_WRONG_SUPPLY,
                          DEST_WRONG_ORIGIN]) {
        expect(await qty('warehouse_stock', dest, 'on_hand_quantity')).toBe(0);
      }
    });
  });

  it('the canonical key really does separate these lots', async () => {
    // Proves the fixture is meaningful rather than accidentally identical: the
    // exact lot shares the quarantined row's key and every near-miss differs.
    const r: any = await asAdmin(`
      SELECT s.id, s.material_identity_key = q.material_identity_key AS same
      FROM warehouse_stock s
      CROSS JOIN warehouse_quarantine_stock q
      WHERE q.id = $1 AND s.warehouse_id = $2
      ORDER BY s.id`, [Q_ROW, WH]);
    const same = new Map<string, boolean>(r.rows.map((x: any) => [x.id, x.same]));
    expect(same.get(DEST_EXACT)).toBe(true);
    expect(same.get(DEST_WRONG_UNIT)).toBe(false);
    expect(same.get(DEST_WRONG_CENTRAL)).toBe(false);
    // supply_type / purchase_origin / internal_batch_reference are LOT
    // components, not MATERIAL components, so they legitimately share the
    // material key and are separated by the rest of the tuple instead.
    expect(same.get(DEST_WRONG_SUPPLY)).toBe(true);
    expect(same.get(DEST_WRONG_ORIGIN)).toBe(true);
  });
});
