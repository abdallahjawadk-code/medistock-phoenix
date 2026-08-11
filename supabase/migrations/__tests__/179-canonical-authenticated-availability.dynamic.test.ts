/**
 * STAGE-G-G3.1 (179) — live proof for the authenticated availability defect.
 *
 * Migration 176 grouped physical rows by RAW material columns and left `unit`
 * out of the grouping entirely, so two canonically DISTINCT materials that
 * differ only by unit were summed:
 *
 *   5 box + 3 strip  ->  ONE row, quantity 8
 *
 * Migration 150 is authoritative for physical identity and includes `unit`, so
 * those are different materials. The read model also published no row-level
 * unit, leaving the UI to label the merged quantity with
 * local_items -> central_items.unit — a CATALOGUE unit that can belong to
 * neither physical identity ("8 tablet").
 *
 * THE PRE-FIX HALF PINS `buildRig({ upTo: 178 })`. buildRig() globs every
 * NNN_*.sql on disk, so a bare buildRig() silently applies 179 and the negative
 * proof asserts nothing. (Observed exactly that while developing this fix.)
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const M179 = readFileSync(
  join(MIGRATIONS_DIR, '179_phoenix_canonical_authenticated_availability_hardening.sql'), 'utf8');

const ORG = '00000000-0000-0000-0000-000000179001';
const ORG_B = '00000000-0000-0000-0000-000000179002';
const WH = '00000000-0000-0000-0000-000000179101';
const WH_B = '00000000-0000-0000-0000-000000179102';
const DP = '00000000-0000-0000-0000-000000179201';
const DP_B = '00000000-0000-0000-0000-000000179202';
const CI = '00000000-0000-0000-0000-000000179301';
const LI = '00000000-0000-0000-0000-000000179401';
const IA = '00000000-0000-0000-0000-000000179501';
const SA = '00000000-0000-0000-0000-000000179601';
const USER_B = '00000000-0000-0000-0000-000000179602';

/** Identical in EVERY identity component except `unit`. */
const B = { sci: 'Amoxicillin', conc: '500mg', form: 'capsule', nc: 'NC-179', exp: '2027-01-01' };
/** Catalogue unit deliberately matches NEITHER physical unit. */
const CATALOGUE_UNIT = 'tablet';

async function seed(rig: any) {
  await rig.asAdmin(async (c: any) => {
    await c.query(`INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
      ($1,'G3','G3','g3-a','care_institution','hospital'),($2,'G3B','G3B','g3-b','care_institution','hospital')
      ON CONFLICT(id) DO NOTHING`, [ORG, ORG_B]);
    await c.query(`INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
      ($1,$2,'W','W','active','institution','g3-wh'),($3,$4,'WB','WB','active','institution','g3-wh-b')
      ON CONFLICT(id) DO NOTHING`, [WH, ORG, WH_B, ORG_B]);
    await c.query(`INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
      ($1,$2,$3,'P','P','pharmacy','active','non_emergency'),($4,$5,$6,'PB','PB','pharmacy','active','non_emergency')
      ON CONFLICT(id) DO NOTHING`, [DP, WH, ORG, DP_B, WH_B, ORG_B]);
    await c.query(`INSERT INTO central_items(id,name,name_ar,unit,status,concentration,dosage_form)
      VALUES($1,'Amox','أموكس',$2,'active','500mg','capsule') ON CONFLICT(id) DO NOTHING`, [CI, CATALOGUE_UNIT]);
    await c.query(`INSERT INTO local_items(id,central_item_id,organization_id,local_name,local_code)
      VALUES($1,$2,$3,'L','LOC-179') ON CONFLICT(id) DO NOTHING`, [LI, CI, ORG]);
    await c.query(`INSERT INTO auth.users(id,email) VALUES($1,'g3-sa@rig.local'),($2,'g3-b@rig.local')
      ON CONFLICT(id) DO NOTHING`, [SA, USER_B]);
    await c.query(`UPDATE profiles SET role='super_admin',status='active',organization_id=$2 WHERE id=$1`, [SA, ORG]);
    await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id=$2 WHERE id=$1`, [USER_B, ORG_B]);
    // Model Production's real warehouse ACL. The rig's bootstrap.sql does
    // `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO authenticated`, so
    // without this the Hotfix-178 preservation assertion in case P would pass
    // vacuously against a posture Production does not have.
    await c.query(`REVOKE UPDATE, DELETE ON public.warehouses FROM authenticated`);
  });
}

/**
 * One canonical stock row. Only `unit`, the lot dimension and `qty` vary.
 *
 * outlet_stock_internal_ref_rule_chk makes batch_number and
 * internal_batch_reference MUTUALLY EXCLUSIVE: a row either carries a
 * batch_number, or sets has_no_batch_number and carries an internal reference.
 * Both shapes are exercised below.
 */
async function stock(rig: any, o: { dp?: string; unit: string | null; qty: number; batch?: string; ref?: string; supply?: string }) {
  const useRef = o.ref !== undefined;
  await rig.asAdmin((c: any) => c.query(
    `INSERT INTO outlet_stock(id,organization_id,distribution_point_id,point_type,central_item_id,
       scientific_name,concentration,dosage_form,unit,national_code,
       batch_number,has_no_batch_number,internal_batch_reference,
       expiry_date,on_hand_quantity,reserved_quantity,supply_type)
     VALUES(gen_random_uuid(),$1,$2,'pharmacy',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14)`,
    [o.dp === DP_B ? ORG_B : ORG, o.dp ?? DP, CI, B.sci, B.conc, B.form, o.unit, B.nc,
     useRef ? null : (o.batch ?? 'B179'), useRef, useRef ? o.ref : null, B.exp, o.qty,
     o.supply ?? null]));
}

const read = (rig: any, uid: string | null, dp: string, role = 'authenticated') =>
  rig.asUser(uid, (c: any) =>
    c.query(`SELECT public.phoenix_outlet_availability_read_model($1) AS r`, [dp]).then((x: any) => x.rows[0].r),
  { role });

run('179 · canonical authenticated availability (dynamic)', () => {
  describe('PRE-179 — the defect, at the exact Production ceiling', () => {
    let rig: any;
    beforeAll(async () => { rig = await buildRig({ upTo: 178 }); await seed(rig); await stock(rig, { unit: 'box', qty: 5 }); await stock(rig, { unit: 'strip', qty: 3 }); });
    afterAll(async () => { await rig?.end?.(); });

    it('the two rows really are DIFFERENT canonical materials under Migration 150', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT count(DISTINCT material_identity_key)::int n FROM outlet_stock WHERE distribution_point_id=$1`, [DP]));
      expect(r.rows[0].n).toBe(2);
    });

    it('REGRESSION: 5 box + 3 strip are flattened into a single quantity 8', async () => {
      const rows = (await read(rig, SA, DP)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(8);
      // …and the row carries no physical unit at all, so the UI could only
      // reach the catalogue unit, which belongs to neither identity.
      expect(rows[0].unit).toBeUndefined();
    });
  });

  describe('POST-179 — applied on top of the same 178 rig', () => {
    let rig: any;
    beforeAll(async () => {
      rig = await buildRig({ upTo: 178 });
      await seed(rig);
      await stock(rig, { unit: 'box', qty: 5 });
      await stock(rig, { unit: 'strip', qty: 3 });
      // ONE catalogue row. item_availability has no unit column, so it cannot
      // distinguish box from strip — both physical rows match it.
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO item_availability(id,local_item_id,distribution_point_id,organization_id,quantity,condition,
           scientific_name,concentration,dosage_form,national_code,batch_number,expiry_date,source_kind)
         VALUES($1,$2,$3,$4,999,'surplus',$5,$6,$7,$8,'B179',$9,'manual') ON CONFLICT(id) DO NOTHING`,
        [IA, LI, DP, ORG, B.sci, B.conc, B.form, B.nc, B.exp]));
      await rig.asAdmin((c: any) => c.query(M179)); // preflight + verify must pass
    });
    afterAll(async () => { await rig?.end?.(); });

    /**
     * The two base rows, selected by BOTH unit and lot.
     *
     * Selecting on `unit` alone is ambiguous: later cases in this suite add
     * further rows that also carry unit 'box' on a different lot, and the
     * read model orders by updated_at DESC, so `find(r => r.unit === 'box')`
     * can return whichever row happens to sort first. CI caught exactly that.
     */
    const BASE_LOT = 'B179';
    const boxStrip = async () => {
      const rows = (await read(rig, SA, DP)).rows;
      const base = rows.filter((r: any) => r.batch_number === BASE_LOT);
      return {
        rows,
        box: base.find((r: any) => r.unit === 'box'),
        strip: base.find((r: any) => r.unit === 'strip'),
      };
    };

    it('A. NEGATIVE REGRESSION — no quantity-8 flattening; 5 is box and 3 is strip', async () => {
      const { rows, box, strip } = await boxStrip();
      expect(rows.some((r: any) => r.quantity === 8)).toBe(false);
      expect(box.quantity).toBe(5);
      expect(strip.quantity).toBe(3);
      // and neither is mislabelled as the other
      expect(box.quantity).not.toBe(3);
      expect(strip.quantity).not.toBe(5);
    });

    it('B. the two rows carry two distinct canonical identities', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT count(DISTINCT material_identity_key)::int n FROM outlet_stock
          WHERE distribution_point_id=$1 AND unit IN ('box','strip')`, [DP]));
      expect(r.rows[0].n).toBe(2);
    });

    it('C. central_items.unit can override NEITHER physical row', async () => {
      const { box, strip } = await boxStrip();
      // The catalogue row is attached to both (same local_item), and its unit is
      // a third value entirely — it must never become the physical unit.
      expect(box.local_items?.central_items?.unit).toBe(CATALOGUE_UNIT);
      expect(strip.local_items?.central_items?.unit).toBe(CATALOGUE_UNIT);
      expect(box.unit).toBe('box');
      expect(strip.unit).toBe('strip');
    });

    it('D. row_key is non-null, distinct per physical row, and deterministic', async () => {
      const first = (await read(rig, SA, DP)).rows;
      const second = (await read(rig, SA, DP)).rows;
      for (const r of first) {
        expect(typeof r.row_key).toBe('string');
        expect(r.row_key.length).toBeGreaterThan(0);
      }
      expect(new Set(first.map((r: any) => r.row_key)).size).toBe(first.length);
      // stable across repeated RPC calls, independent of array ordering
      expect(first.map((r: any) => r.row_key).sort()).toEqual(second.map((r: any) => r.row_key).sort());
      // box and strip share ONE item_availability row, yet stay distinct
      const { box, strip } = await boxStrip();
      expect(box.catalogue_item_availability_id).toBe(strip.catalogue_item_availability_id);
      expect(box.row_key).not.toBe(strip.row_key);
      expect(box.row_key).toMatch(/^stock:/);
      expect(strip.row_key).toMatch(/^stock:/);
    });

    it('E. id and catalogue_item_availability_id keep their previous meaning', async () => {
      const { box } = await boxStrip();
      expect(box.id).toBe(IA);
      expect(box.catalogue_item_availability_id).toBe(IA);
    });

    it('F. NULL unit stays NULL — no invented and no catalogue unit', async () => {
      await stock(rig, { unit: null, qty: 7, batch: 'NULLU' });
      const row = (await read(rig, SA, DP)).rows.find((r: any) => r.batch_number === 'NULLU');
      expect(row.quantity).toBe(7);
      expect(row.unit).toBeNull();
      expect(row.unit).not.toBe(CATALOGUE_UNIT);
    });

    it('G. Migration-150 normalization: case variants are ONE identity', async () => {
      // Two constraints bound what this case can even look like:
      //  * outlet_stock_unit_chk enforces unit IS NULL OR (btrim(unit)=unit AND
      //    unit <> ''), so a padded or empty unit cannot exist at all — CASE is
      //    the only variant Migration 150's lower() has to absorb.
      //  * outlet_stock_identity_uniq forbids two rows sharing one canonical
      //    lot, and 'BOX'/'box' ARE one canonical lot. They can therefore only
      //    coexist across another lot dimension the read model aggregates over
      //    — supply_type, exactly as Migration 176's own suite does (10 kimadia
      //    + 15 aid = 25).
      await stock(rig, { unit: 'BOX', qty: 2, batch: 'CASE1', supply: 'kimadia' });
      await stock(rig, { unit: 'box', qty: 4, batch: 'CASE1', supply: 'aid' });
      const rows = (await read(rig, SA, DP)).rows.filter((r: any) => r.batch_number === 'CASE1');
      // One canonical identity -> one row, quantities summed, and the projected
      // unit is an exact representative of that identity (never invented).
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(6);
      expect(['BOX', 'box']).toContain(rows[0].unit);
      expect(String(rows[0].unit).toLowerCase()).toBe('box');
    });

    it('H. multiple lots of the SAME canonical identity stay separate rows', async () => {
      await stock(rig, { unit: 'vial', qty: 11, batch: 'LOT-A' });
      await stock(rig, { unit: 'vial', qty: 13, batch: 'LOT-B' });
      const rows = (await read(rig, SA, DP)).rows.filter((r: any) => ['LOT-A', 'LOT-B'].includes(r.batch_number));
      expect(rows).toHaveLength(2);
      expect(rows.map((r: any) => r.quantity).sort((a: number, b: number) => a - b)).toEqual([11, 13]);
      expect(new Set(rows.map((r: any) => r.row_key)).size).toBe(2);
      for (const r of rows) expect(r.unit).toBe('vial');
    });

    it('I. separator-bearing lot values in BOTH lot shapes stay distinct', async () => {
      // The two lot shapes the schema actually permits (batch XOR internal ref),
      // each carrying the '|' separator and a date-like substring — the values
      // that make a delimiter-joined row identity ambiguous.
      await stock(rig, { unit: 'amp', qty: 1, batch: 'X|2027-01-01|Y' });
      await stock(rig, { unit: 'amp', qty: 2, batch: 'X' });
      await stock(rig, { unit: 'amp', qty: 4, ref: 'Y|2030-01-01|' });
      await stock(rig, { unit: 'amp', qty: 8, ref: 'Y' });
      const rows = (await read(rig, SA, DP)).rows.filter((r: any) => r.unit === 'amp');
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r: any) => r.row_key)).size).toBe(4);
      // each quantity stayed on its own lot — nothing merged
      expect(rows.map((r: any) => r.quantity).sort((a: number, b: number) => a - b)).toEqual([1, 2, 4, 8]);
    });

    it('J. item_availability is metadata only — never physical quantity/condition', async () => {
      const { box, strip } = await boxStrip();
      expect(box.quantity).toBe(5);
      expect(strip.quantity).toBe(3);
      expect([box.quantity, strip.quantity]).not.toContain(999); // the cache said 999
      // a stale/zeroed cache still cannot hide real canonical stock
      await rig.asAdmin((c: any) => c.query(
        `UPDATE item_availability SET quantity=0, condition='missing' WHERE id=$1`, [IA]));
      const after = await boxStrip();
      expect(after.box.quantity).toBe(5);
      expect(after.strip.quantity).toBe(3);
      expect(after.box.condition).not.toBe('missing');
      await rig.asAdmin((c: any) => c.query(
        `UPDATE item_availability SET quantity=999, condition='surplus' WHERE id=$1`, [IA]));
    });

    it('K. canonical stock with NO cache row is still fully reported', async () => {
      await stock(rig, { unit: 'sachet', qty: 9, batch: 'NOCACHE' });
      const row = (await read(rig, SA, DP)).rows.find((r: any) => r.batch_number === 'NOCACHE');
      expect(row.quantity).toBe(9);
      expect(row.unit).toBe('sachet');
      expect(row.id).toBeNull();
      expect(row.catalogue_item_availability_id).toBeNull();
      expect(row.row_key).toMatch(/^stock:/); // still non-null and usable as a key
    });

    it('L. catalogue-only rows stay canonical-zero with a deterministic row_key', async () => {
      const id = '00000000-0000-0000-0000-0000001795ff';
      await rig.asAdmin((c: any) => c.query(
        // item_availability_identity_chk requires local_item_id OR port_name.
        `INSERT INTO item_availability(id,distribution_point_id,organization_id,quantity,condition,port_name,
           scientific_name,concentration,dosage_form,national_code,batch_number,expiry_date,source_kind)
         VALUES($1,$2,$3,777,'available','G3 Pharmacy','G3 Cache Only','10mg','tablet','G3-CACHE','CACHE-B',$4,'manual')
         ON CONFLICT(id) DO NOTHING`, [id, DP, ORG, B.exp]));
      const row = (await read(rig, SA, DP)).rows.find((r: any) => r.catalogue_item_availability_id === id);
      expect(row.quantity).toBe(0);
      expect(row.condition).toBe('missing');
      expect(row.row_key).toBe(`catalogue:${id}`);
      expect(row.unit).toBeNull(); // no physical stock -> no physical unit
    });

    it('M. removed_at metadata semantics are preserved', async () => {
      await rig.asAdmin((c: any) => c.query(`UPDATE item_availability SET removed_at=now() WHERE id=$1`, [IA]));
      const { box } = await boxStrip();
      expect(box.removed_at).toBeTruthy();
      await rig.asAdmin((c: any) => c.query(`UPDATE item_availability SET removed_at=NULL WHERE id=$1`, [IA]));
    });

    it('N. organization A cannot read organization B availability', async () => {
      const foreign = await read(rig, USER_B, DP);
      const missing = await read(rig, USER_B, '00000000-0000-0000-0000-0000001799ff');
      expect(foreign).toEqual(missing);              // indistinguishable
      expect(foreign.rows).toEqual([]);
      expect(foreign.distribution_point_id).toBeNull();
    });

    it('O. anon cannot invoke the authenticated read model', async () => {
      await expect(read(rig, null, DP, 'anon')).rejects.toMatchObject({ code: '42501' });
    });

    it('P. ACL, Public QR (177) and Hotfix 178 are untouched', async () => {
      const r = await rig.asAdmin((c: any) => c.query(`
        SELECT has_function_privilege('anon','public.phoenix_outlet_availability_read_model(uuid)','EXECUTE') anon_read,
               has_function_privilege('authenticated','public.phoenix_outlet_availability_read_model(uuid)','EXECUTE') auth_read,
               has_function_privilege('service_role','public.phoenix_outlet_availability_read_model(uuid)','EXECUTE') svc_read,
               has_function_privilege('anon','public.get_public_qr_payload(text)','EXECUTE') qr_anon,
               (SELECT count(*)::int FROM pg_constraint
                 WHERE conname='distribution_points_wh_org_fk' AND contype='f') AS hotfix_178,
               (SELECT p.prosecdef FROM pg_proc p
                 WHERE p.oid='public._phoenix_distribution_points_owner_kind_guard_v1()'::regprocedure) AS guard_secdef,
               has_table_privilege('authenticated','public.warehouses','UPDATE') wh_update,
               has_table_privilege('authenticated','public.warehouses','DELETE') wh_delete`));
      expect(r.rows[0]).toEqual({
        anon_read: false, auth_read: true, svc_read: true, qr_anon: true,
        hotfix_178: 1, guard_secdef: true, wh_update: false, wh_delete: false,
      });
    });

    it('Q. the read model still reports exactly two stock truths, writing none', async () => {
      const before = await rig.asAdmin((c: any) => c.query(`SELECT count(*)::int n FROM outlet_stock`));
      await read(rig, SA, DP);
      const after = await rig.asAdmin((c: any) => c.query(`SELECT count(*)::int n FROM outlet_stock`));
      expect(after.rows[0].n).toBe(before.rows[0].n); // a read model writes nothing
      const ia = await rig.asAdmin((c: any) => c.query(`SELECT count(*)::int n FROM item_availability`));
      expect(ia.rows[0].n).toBeGreaterThan(0); // and never manufactures cache rows
    });
  });
});
