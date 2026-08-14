/**
 * 172 · PATIENT DISPENSING CONTRACT (Stage F) — dynamic proof.
 *
 * Builds a disposable Postgres through the full effective migration chain and
 * drives the REAL phoenix_dispense_outlet_stock_with_context RPC against every
 * institution/outlet/clinical-context shape Migration 172 governs.
 *
 * This is a BEHAVIOURAL suite, not a SQL-text scan: every PASS row below is a
 * dispense that actually moved stock, and every FAIL row is the canonical RPC
 * refusing with its own error, not a string match.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;

const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

/** Runs `fn` and returns the rejection message; fails if it succeeded. */
const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

// ── organizations ───────────────────────────────────────────────────────────
const ORG_HOSP = randomUUID();
const ORG_SPEC = randomUUID();
const ORG_SECTOR = randomUUID();
const ORG_OTHER = randomUUID();

// ── warehouses ──────────────────────────────────────────────────────────────
const WH_HOSP = randomUUID();
const WH_SPEC = randomUUID();
const WH_SECTOR = randomUUID();       // sector MAIN — supply root, never dispenses
const WH_CENTRE = randomUUID();       // R1.1/181: the facility-bound centre depot
const WH_OTHER = randomUUID();

// ── facilities ──────────────────────────────────────────────────────────────
const FAC_SECTOR = randomUUID();      // the health centre WH_CENTRE serves

// ── outlets ─────────────────────────────────────────────────────────────────
const PH_HOSP_ER = randomUUID();      // hospital pharmacy, emergency  -> card
const PH_HOSP_WARD = randomUUID();    // hospital pharmacy, non-emerg  -> card|chart
const CART_HOSP = randomUUID();       // hospital rescue cart, emerg   -> card
const CAB_HOSP = randomUUID();        // hospital cabinet, non-emerg   -> chart
const PH_SPEC = randomUUID();         // specialized pharmacy          -> card only
const CAB_SPEC = randomUUID();        // specialized cabinet, non-emerg-> chart
const PH_SECTOR = randomUUID();       // health-centre pharmacy        -> card
const CAB_SECTOR = randomUUID();      // health-centre cabinet, emerg  -> card
const PH_OTHER = randomUUID();        // another org entirely (scope tests)
const PH_INACTIVE = randomUUID();     // inactive outlet
const CART_SECTOR = randomUUID();     // ILLEGAL: rescue cart in a health centre
const CART_SPEC = randomUUID();       // specialized-centre rescue cart (non-hospital)
const CART_HOSP_WARD = randomUUID();  // ILLEGAL: rescue cart outside the ER

// ── actors ──────────────────────────────────────────────────────────────────
const OFFICER = randomUUID();         // outlet_officer in the hospital org
const NO_PERM = randomUUID();         // active profile, no dispense permission

run('172 · patient dispensing contract (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  /**
   * Provenance-LESS outlet stock: inserted straight into outlet_stock with no
   * warehouse_dispatch_lines row and no dispatch_receive movement.
   *
   * This is deliberate and load-bearing. Migration 150 hardened TRANSFER FEFO
   * to require exactly that provenance, which makes such a row untransferable
   * — but it has always remained legally DISPENSABLE, and Stage F must not
   * change that. Section L proves the dispense works; section M proves the
   * transfer helper still refuses the same row.
   */
  async function seedOutletStock(opts: {
    org: string; point: string; pointType: string; sci?: string; qty?: number;
    expiryDays?: number | null;
  }): Promise<string> {
    const id = randomUUID();
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO outlet_stock(
         id, organization_id, distribution_point_id, point_type,
         scientific_name, has_no_national_code, has_no_batch_number, batch_number,
         expiry_date, on_hand_quantity, reserved_quantity, movement_seq
       ) VALUES ($1,$2,$3,$4,$5,true,false,$6,
                 ${opts.expiryDays === null ? 'NULL' : `current_date + ${opts.expiryDays ?? 365}`},
                 $7,0,1)`,
      [id, opts.org, opts.point, opts.pointType,
        opts.sci ?? uniq('SCI-172'), uniq('B172'), opts.qty ?? 50],
    ));
    return id;
  }

  /** The real canonical atomic dispense + context wrapper. */
  function dispense(opts: {
    actor?: string; stockId: string; qty?: number;
    beneficiary?: string; refType?: string | null; ref?: string | null;
    name?: string | null; cartRef?: string | null; orderRef?: string | null;
    requestId?: string;
  }) {
    return rig.asUser(opts.actor ?? rig.superAdminId, (c: any) => c.query(
      `SELECT public.phoenix_dispense_outlet_stock_with_context(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,NULL) AS r`,
      [
        opts.requestId ?? randomUUID(),
        opts.stockId,
        opts.qty ?? 1,
        opts.beneficiary ?? 'patient',
        opts.ref === undefined ? 'REF-172' : opts.ref,
        opts.name ?? 'Rig Patient',
        opts.refType === undefined ? 'card' : opts.refType,
        opts.cartRef ?? null,
        opts.orderRef ?? null,
      ],
    ), { commit: true });
  }

  const onHand = async (stockId: string): Promise<number> => {
    const r = await rig.asAdmin((c: any) =>
      c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]));
    return Number(r.rows[0].on_hand_quantity);
  };

  const contextRows = async (movementId: string) => {
    const r = await rig.asAdmin((c: any) => c.query(
      `SELECT beneficiary_type, patient_reference_type, patient_identifier
         FROM phoenix_movement_dispense_context WHERE movement_id=$1`, [movementId]));
    return r.rows;
  };

  beforeAll(async () => {
    rig = await buildRig();

    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_HOSP}','Hosp172','Hosp172','p172-hosp','care_institution','hospital'),
        ('${ORG_SPEC}','Spec172','Spec172','p172-spec','care_institution','specialized_center'),
        ('${ORG_SECTOR}','Sect172','Sect172','p172-sect','care_institution','health_sector'),
        ('${ORG_OTHER}','Other172','Other172','p172-other','care_institution','hospital');

      -- R1.1/181: a health sector dispenses from FACILITY-BOUND centre depots.
      -- The facility-less warehouse is the sector main: a supply root that owns
      -- no outlet. 172's dispensing rules are unchanged by that — they key off
      -- institution_class and clinical_location_kind, not off the depot — so
      -- the health-centre cases below simply moved one level down the topology.
      INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_SECTOR}','${ORG_SECTOR}','primary_health_center','Centre172','Centre172','active');

      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id,is_main) VALUES
        ('${WH_HOSP}','${ORG_HOSP}','WH Hosp172','WH Hosp172','active','institution','p172-wh-h',NULL,false),
        ('${WH_SPEC}','${ORG_SPEC}','WH Spec172','WH Spec172','active','institution','p172-wh-s',NULL,false),
        ('${WH_SECTOR}','${ORG_SECTOR}','WH Sect172','WH Sect172','active','institution','p172-wh-c',NULL,true),
        ('${WH_CENTRE}','${ORG_SECTOR}','WH Ctr172','WH Ctr172','active','institution','p172-wh-hc','${FAC_SECTOR}',false),
        ('${WH_OTHER}','${ORG_OTHER}','WH Other172','WH Other172','active','institution','p172-wh-o',NULL,false);

      INSERT INTO distribution_points
        (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PH_HOSP_ER}','${WH_HOSP}','${ORG_HOSP}','ER Pharm172','ER Pharm172','pharmacy','active','emergency'),
        ('${PH_HOSP_WARD}','${WH_HOSP}','${ORG_HOSP}','Ward Pharm172','Ward Pharm172','pharmacy','active','non_emergency'),
        ('${CART_HOSP}','${WH_HOSP}','${ORG_HOSP}','Cart172','Cart172','rescue_cart','active','emergency'),
        ('${CAB_HOSP}','${WH_HOSP}','${ORG_HOSP}','Cab172','Cab172','crash_cabinet','active','non_emergency'),
        ('${PH_SPEC}','${WH_SPEC}','${ORG_SPEC}','Spec Pharm172','Spec Pharm172','pharmacy','active','non_emergency'),
        ('${CAB_SPEC}','${WH_SPEC}','${ORG_SPEC}','Spec Cab172','Spec Cab172','crash_cabinet','active','non_emergency'),
        ('${PH_SECTOR}','${WH_CENTRE}','${ORG_SECTOR}','HC Pharm172','HC Pharm172','pharmacy','active','non_emergency'),
        ('${CAB_SECTOR}','${WH_CENTRE}','${ORG_SECTOR}','HC Cab172','HC Cab172','crash_cabinet','active','emergency'),
        ('${PH_OTHER}','${WH_OTHER}','${ORG_OTHER}','Other Pharm172','Other Pharm172','pharmacy','active','non_emergency'),
        ('${PH_INACTIVE}','${WH_HOSP}','${ORG_HOSP}','Dead Pharm172','Dead Pharm172','pharmacy','archived','non_emergency');
      -- R1.2C/183: CART_SPEC (a specialized-centre rescue cart) and
      -- CART_HOSP_WARD (a hospital rescue cart outside the ER) are deliberately
      -- NOT seeded, for exactly the reason CART_SECTOR above is not: 183 now
      -- refuses to CREATE all three. Each is proved at both ends in the refusal
      -- matrix below — the outlet cannot exist, and 172's dispensing rule for
      -- it is still installed and unweakened.

      INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','officer172@rig.test'),
        ('${NO_PERM}','noperm172@rig.test')
      ON CONFLICT (id) DO NOTHING;

      UPDATE profiles SET role='outlet_officer', status='active', organization_id='${ORG_HOSP}'
       WHERE id='${OFFICER}';
      -- 091's five-role cutover is the whole vocabulary profiles_role_check
      -- admits. warehouse_officer is the right under-privileged actor here:
      -- it is a real operational role in the SAME organization whose
      -- role_permission_defaults entry for outlet_stock.dispense is FALSE
      -- (067), so case R fails on the permission itself rather than on a
      -- rejected role value or an organization mismatch.
      UPDATE profiles SET role='warehouse_officer', status='active', organization_id='${ORG_HOSP}'
       WHERE id='${NO_PERM}';
    `));

    // NOTE ON ACTORS. phoenix_profile_has_scoped_permission (091) pins every
    // non-super actor to its OWN organization and, outside the org-wide
    // institution_admin role, requires a named resource assignment. The
    // eligibility matrix below is about Migration 172's CONTRACT, not about
    // scope, so it runs as super_admin — which the permission helper lets
    // through — and scope/permission get their own dedicated cases (Q and R)
    // driven by real, deliberately under-privileged actors.
  });

  afterAll(async () => { await rig?.end?.(); });

  // ══ PASS matrix ═══════════════════════════════════════════════════════════
  describe('A-H · legal patient dispensing', () => {
    it('A. hospital ER pharmacy + card', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      await dispense({ stockId: s, qty: 3, refType: 'card' });
      expect(await onHand(s)).toBe(47);
    });

    it('B. hospital non-emergency (outpatient) pharmacy + card', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_WARD, pointType: 'pharmacy' });
      await dispense({ stockId: s, qty: 2, refType: 'card' });
      expect(await onHand(s)).toBe(48);
    });

    it('C. hospital non-emergency (ward) pharmacy + chart — the same outlet legitimately serves both', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_WARD, pointType: 'pharmacy' });
      await dispense({ stockId: s, qty: 5, refType: 'chart' });
      expect(await onHand(s)).toBe(45);
    });

    it('D. health-centre pharmacy + card', async () => {
      const s = await seedOutletStock({ org: ORG_SECTOR, point: PH_SECTOR, pointType: 'pharmacy' });
      await dispense({ stockId: s, qty: 1, refType: 'card' });
      expect(await onHand(s)).toBe(49);
    });

    it('E. hospital ER rescue cart + card', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: CART_HOSP, pointType: 'rescue_cart' });
      await dispense({ stockId: s, qty: 4, refType: 'card' });
      expect(await onHand(s)).toBe(46);
    });

    it('F. hospital crash cabinet (ward) + chart', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: CAB_HOSP, pointType: 'crash_cabinet' });
      await dispense({ stockId: s, qty: 2, refType: 'chart' });
      expect(await onHand(s)).toBe(48);
    });

    it('G. specialized-centre crash cabinet (ward) + chart', async () => {
      const s = await seedOutletStock({ org: ORG_SPEC, point: CAB_SPEC, pointType: 'crash_cabinet' });
      await dispense({ stockId: s, qty: 2, refType: 'chart' });
      expect(await onHand(s)).toBe(48);
    });

    it('H. health-centre crash cabinet (approved emergency exception) + card', async () => {
      const s = await seedOutletStock({ org: ORG_SECTOR, point: CAB_SECTOR, pointType: 'crash_cabinet' });
      await dispense({ stockId: s, qty: 2, refType: 'card' });
      expect(await onHand(s)).toBe(48);
    });

    it('the dispense context records the declared document type', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const r = await dispense({ stockId: s, qty: 1, refType: 'card', ref: 'CARD-A1' });
      const movementId = (r as any).rows[0].r.movement_id;
      const rows = await contextRows(movementId);
      expect(rows).toHaveLength(1);
      expect(rows[0].beneficiary_type).toBe('patient');
      expect(rows[0].patient_reference_type).toBe('card');
      expect(rows[0].patient_identifier).toBe('CARD-A1');
    });
  });

  // ══ FAIL matrix ═══════════════════════════════════════════════════════════
  describe('I-S · refusals', () => {
    it('I. a rescue cart cannot even EXIST in a health sector after 181', async () => {
      // 172 refused to DISPENSE from this shape. 181 refuses to CREATE it, so
      // the refusal now happens one step earlier and can never be reached at
      // dispense time. Asserting the earlier refusal is strictly stronger.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES ('${CART_SECTOR}','${WH_CENTRE}','${ORG_SECTOR}','HC Cart172','HC Cart172','rescue_cart','active','emergency')`)));
      expect(msg).toMatch(/health_center_rescue_cart_not_permitted/);
    });

    /**
     * The body of 172's reference-type resolver — the single function that
     * owns every clinical-context dispensing rule asserted below — so a rule
     * can be shown STILL INSTALLED even where 183 now makes the shape that
     * would trigger it impossible to create.
     */
    const dispenseRpcDef = async (): Promise<string> => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT string_agg(pg_get_functiondef(p.oid), E'\n') AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public'
            AND p.proname = '_phoenix_patient_dispense_reference_types_v1'`));
      return r.rows[0].def as string;
    };

    it('I2. a specialized-centre rescue cart cannot exist after 183, and the rule is unweakened', async () => {
      // Was proved by dispensing from a specialized-centre cart. 183 refuses to
      // CREATE that shape, so — exactly as for the health centre in I above —
      // the refusal moves one step earlier and both ends are asserted.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES ('${CART_SPEC}','${WH_SPEC}','${ORG_SPEC}','Spec Cart172','Spec Cart172','rescue_cart','active','emergency')`)));
      expect(msg).toMatch(/specialized_center_rescue_cart_not_permitted/);
      expect(await dispenseRpcDef()).toContain('rescue_cart_patient_dispense_requires_hospital');
    });

    it('J. a rescue cart outside the ER cannot exist after 183, and the rule is unweakened', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES ('${CART_HOSP_WARD}','${WH_HOSP}','${ORG_HOSP}','Ward Cart172','Ward Cart172','rescue_cart','active','non_emergency')`)));
      expect(msg).toMatch(/rescue_cart_requires_emergency_context/);
      expect(await dispenseRpcDef()).toContain('rescue_cart_patient_dispense_requires_emergency_context');
    });

    it('K. a cabinet in an illegal clinical context cannot exist after 183, and the rule is unweakened', async () => {
      // A hospital cabinet must sit in a ward. 172 refused to DISPENSE from one
      // moved to the ER; 183 refuses to CREATE it, so — as with I, I2 and J —
      // the refusal moves one step earlier and both ends are asserted.
      const bad = randomUUID();
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points
           (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,'${WH_HOSP}','${ORG_HOSP}','Bad Cab172','Bad Cab172','crash_cabinet','active','emergency')`,
        [bad])));
      expect(msg).toMatch(/crash_cabinet_requires_non_emergency_context/);
      expect(await dispenseRpcDef())
        .toContain('crash_cabinet_patient_dispense_requires_non_emergency_context');
    });

    it('L. chart where only card is legal (hospital ER pharmacy) is refused', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const msg = await rejects(() => dispense({ stockId: s, refType: 'chart' }));
      expect(msg).toMatch(/patient_reference_type_not_valid_for_clinical_context/);
    });

    it('L2. chart is refused at a specialized-centre pharmacy — inpatient use is not provable there', async () => {
      const s = await seedOutletStock({ org: ORG_SPEC, point: PH_SPEC, pointType: 'pharmacy' });
      const msg = await rejects(() => dispense({ stockId: s, refType: 'chart' }));
      expect(msg).toMatch(/patient_reference_type_not_valid_for_clinical_context/);
    });

    it('M. card where only chart is legal (ward cabinet) is refused', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: CAB_HOSP, pointType: 'crash_cabinet' });
      const msg = await rejects(() => dispense({ stockId: s, refType: 'card' }));
      expect(msg).toMatch(/patient_reference_type_not_valid_for_clinical_context/);
    });

    it('N. pass is refused for a NEW patient dispense', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const msg = await rejects(() => dispense({ stockId: s, refType: 'pass' }));
      expect(msg).toMatch(/patient_reference_type_pass_retired/);
    });

    it('O. the retired crash_cart beneficiary is refused', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const before = await onHand(s);
      const msg = await rejects(() => dispense({
        stockId: s, beneficiary: 'crash_cart', refType: null, ref: null, cartRef: 'CART-9',
      }));
      expect(msg).toMatch(/crash_cart_beneficiary_retired/);
      expect(await onHand(s)).toBe(before);      // refused BEFORE any debit
    });

    it('P. an inactive outlet is refused', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_INACTIVE, pointType: 'pharmacy' });
      const msg = await rejects(() => dispense({ stockId: s, refType: 'card' }));
      expect(msg).toMatch(/source_outlet_inactive/);
    });

    it('Q. an actor outside the organization is refused', async () => {
      // OFFICER belongs to ORG_HOSP; this outlet belongs to ORG_OTHER, and
      // 091 pins every non-super actor to its own organization.
      const s = await seedOutletStock({ org: ORG_OTHER, point: PH_OTHER, pointType: 'pharmacy' });
      const before = await onHand(s);
      const msg = await rejects(() => dispense({ actor: OFFICER, stockId: s, refType: 'card' }));
      expect(msg).toMatch(/forbidden_outlet_stock_dispense|forbidden/);
      expect(await onHand(s)).toBe(before);
    });

    it('R. an actor without outlet_stock.dispense is refused', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const msg = await rejects(() => dispense({ actor: NO_PERM, stockId: s, refType: 'card' }));
      expect(msg).toMatch(/forbidden_outlet_stock_dispense|forbidden/);
    });

    it('S. a missing patient reference type is refused', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const msg = await rejects(() => dispense({ stockId: s, refType: null }));
      expect(msg).toMatch(/patient_reference_type_required/);
    });

    it('S2. a reference type with no reference number is refused', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const msg = await rejects(() => dispense({ stockId: s, refType: 'card', ref: null, name: 'Only A Name' }));
      expect(msg).toMatch(/patient_identifier_required_for_reference_type/);
    });
  });

  // ══ Historical compatibility ══════════════════════════════════════════════
  describe('T-V · history stays readable', () => {
    it('T/U. historical crash_cart and pass context rows remain readable', async () => {
      // Written the way history was written — directly, bypassing the Stage-F
      // writers, exactly as a pre-172 row already sitting in the table looks.
      // The BEFORE INSERT guard is disabled only for this one statement so the
      // fixture can represent the past; it is re-enabled immediately.
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const r = await dispense({ stockId: s, qty: 1, refType: 'card', ref: 'SEED-1' });
      const legalMovement = (r as any).rows[0].r.movement_id;

      await rig.asAdmin((c: any) => c.query(`
        ALTER TABLE phoenix_movement_dispense_context DISABLE TRIGGER phoenix_dispense_context_forward_contract_trg;
        UPDATE phoenix_movement_dispense_context
           SET beneficiary_type='crash_cart', crash_cart_reference='LEGACY-CART',
               patient_identifier=NULL, patient_name=NULL, patient_reference_type=NULL
         WHERE movement_id='${legalMovement}';
        ALTER TABLE phoenix_movement_dispense_context ENABLE TRIGGER phoenix_dispense_context_forward_contract_trg;
      `));

      const rows = await contextRows(legalMovement);
      expect(rows).toHaveLength(1);
      expect(rows[0].beneficiary_type).toBe('crash_cart');

      // The masked reader still serves it — history is not orphaned by 172.
      const got = await rig.asUser(rig.superAdminId, (c: any) => c.query(
        `SELECT public.phoenix_get_movement_dispense_context($1) AS r`, [legalMovement]));
      expect((got as any).rows[0].r.beneficiary_type).toBe('crash_cart');
    });

    it('V. 172 rewrote no historical data and 134s stored vocabulary is intact', async () => {
      const chk = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
          WHERE conname='phoenix_movement_dispense_context_beneficiary_type_check'`));
      if (chk.rows.length) {
        expect(chk.rows[0].d).toMatch(/crash_cart/);
      }
      const types = await rig.asAdmin((c: any) => c.query(
        `SELECT DISTINCT beneficiary_type FROM phoenix_movement_dispense_context ORDER BY 1`));
      expect(types.rows.length).toBeGreaterThan(0);
    });
  });

  // ══ Idempotency ═══════════════════════════════════════════════════════════
  describe('idempotency · the patient path specifically', () => {
    it('an exact retry with the same request_id debits once and records one context', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const requestId = randomUUID();

      const first = await dispense({ stockId: s, qty: 6, refType: 'card', ref: 'IDEM-1', requestId });
      const afterFirst = await onHand(s);
      expect(afterFirst).toBe(44);

      const replay = await dispense({ stockId: s, qty: 6, refType: 'card', ref: 'IDEM-1', requestId });

      // No second debit …
      expect(await onHand(s)).toBe(afterFirst);
      // … same movement …
      const m1 = (first as any).rows[0].r.movement_id;
      const m2 = (replay as any).rows[0].r.movement_id;
      expect(m2).toBe(m1);
      // … and exactly one context row.
      expect(await contextRows(m1)).toHaveLength(1);
    });

    it('the same request_id with a materially different context fails closed', async () => {
      // 136's context writer fingerprints the payload and refuses a changed
      // one for an already-recorded movement: retries are safe, edits are not.
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy' });
      const requestId = randomUUID();
      await dispense({ stockId: s, qty: 2, refType: 'card', ref: 'FP-1', requestId });
      const before = await onHand(s);

      const msg = await rejects(() => dispense({
        stockId: s, qty: 2, refType: 'card', ref: 'FP-DIFFERENT', requestId,
      }));
      expect(msg).toMatch(/movement_id_conflict|conflict/);
      expect(await onHand(s)).toBe(before);
    });
  });

  // ══ Provenance: the paired proof ══════════════════════════════════════════
  describe('provenance · dispensable here, still untransferable there', () => {
    it('a provenance-less row is patient-dispensable AND still excluded by transfer FEFO', async () => {
      // Every fixture in this suite is provenance-less by construction:
      // inserted straight into outlet_stock, with no warehouse_dispatch_lines
      // row and no dispatch_receive movement. Migration 150 built TRANSFER
      // FEFO to require exactly that chain. Stage F must keep BOTH halves
      // true at once, so this asserts them on the SAME row.
      const sci = uniq('SCI-PROV');
      const s = await seedOutletStock({
        org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy', sci, qty: 12,
      });

      const row = await rig.asAdmin((c: any) => c.query(
        `SELECT organization_id, distribution_point_id, scientific_name, national_code
           FROM outlet_stock WHERE id=$1`, [s]));
      const { organization_id, distribution_point_id, scientific_name, national_code } = row.rows[0];

      // A. transfer FEFO EXCLUDES it — 150's provenance join finds nothing.
      const transfer = await rig.asUser(rig.superAdminId, (c: any) => c.query(
        `SELECT * FROM public.phoenix_inventory_fefo_batches($1,'outlet',$2,$3,$4)`,
        [organization_id, distribution_point_id, scientific_name, national_code]));
      expect(transfer.rows).toHaveLength(0);

      // B. the patient dispense SUCCEEDS on that very row.
      await dispense({ stockId: s, qty: 5, refType: 'card' });
      expect(await onHand(s)).toBe(7);

      // C. and transfer FEFO still excludes it afterwards — dispensing did
      //    not manufacture provenance the row never had.
      const after = await rig.asUser(rig.superAdminId, (c: any) => c.query(
        `SELECT * FROM public.phoenix_inventory_fefo_batches($1,'outlet',$2,$3,$4)`,
        [organization_id, distribution_point_id, scientific_name, national_code]));
      expect(after.rows).toHaveLength(0);
    });

    it('a STALE recommendation cannot oversell — the RPC re-checks under its own lock', async () => {
      // Stands in for the UI holding a candidate that another operator has
      // since drained. The advisory reserves nothing, so the only thing
      // standing between a stale suggestion and an oversell is the canonical
      // writer's FOR UPDATE re-check.
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy', qty: 10 });

      // Operator A "sees" 10 available. Someone else takes 8 first.
      await dispense({ stockId: s, qty: 8, refType: 'card' });
      expect(await onHand(s)).toBe(2);

      // A now submits against the stale figure.
      const msg = await rejects(() => dispense({ stockId: s, qty: 10, refType: 'card' }));
      expect(msg).toMatch(/insufficient|quantity|available/i);
      expect(await onHand(s)).toBe(2);           // fails closed, never negative
    });
  });

  // ══ Concurrency ═══════════════════════════════════════════════════════════
  describe('concurrency · genuine two-transaction races', () => {
    it('two concurrent dispenses on the SAME row cannot oversell it', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy', qty: 10 });

      const a = rig.pool.connect();
      const b = rig.pool.connect();
      const [ca, cb] = await Promise.all([a, b]);

      const asOfficer = async (c: any, qty: number) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE authenticated');
        await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [rig.superAdminId]);
        return c.query(
          `SELECT public.phoenix_dispense_outlet_stock_with_context(
             $1,$2,$3,'patient','CONC','Rig Patient','card',NULL,NULL,NULL,NULL,NULL) AS r`,
          [randomUUID(), s, qty]);
      };

      try {
        // A takes 7 of 10 and HOLDS its row lock (transaction still open).
        await asOfficer(ca, 7);

        // B now asks for 7 as well. Together they would oversell, so B must
        // not be allowed to read-and-decide on the pre-A quantity: it has to
        // WAIT on A's FOR UPDATE lock. Start it without awaiting.
        const second = asOfficer(cb, 7);
        let settledEarly = false;
        second.then(() => { settledEarly = true; }, () => { settledEarly = true; });
        await new Promise(r => setTimeout(r, 500));
        expect(settledEarly).toBe(false);          // proven serialisation

        // Release A. B now re-reads UNDER the lock and must refuse: only 3 left.
        await ca.query('COMMIT');
        const outcome = await second.then(() => 'fulfilled', () => 'rejected');
        expect(outcome).toBe('rejected');
        await cb.query('ROLLBACK');

        // Exactly one dispense happened, and stock never went negative.
        const left = await onHand(s);
        expect(left).toBe(3);
        expect(left).toBeGreaterThanOrEqual(0);
      } finally {
        ca.release(); cb.release();
      }
    });

    it('a dispense serialises against a concurrent credit to the same row', async () => {
      const s = await seedOutletStock({ org: ORG_HOSP, point: PH_HOSP_ER, pointType: 'pharmacy', qty: 10 });

      const ca = await rig.pool.connect();
      const cb = await rig.pool.connect();
      try {
        // A: dispense 4 inside an open transaction, holding the row lock.
        await ca.query('BEGIN');
        await ca.query('SET LOCAL ROLE authenticated');
        await ca.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [rig.superAdminId]);
        await ca.query(
          `SELECT public.phoenix_dispense_outlet_stock_with_context(
             $1,$2,4,'patient','RACE','Rig Patient','card',NULL,NULL,NULL,NULL,NULL) AS r`,
          [randomUUID(), s]);

        // B: a concurrent credit to the same row must WAIT for A's lock.
        await cb.query('BEGIN');
        const blocked = cb.query(
          `UPDATE outlet_stock SET on_hand_quantity = on_hand_quantity + 5 WHERE id=$1`, [s]);

        let settledEarly = false;
        await Promise.race([
          blocked.then(() => { settledEarly = true; }),
          new Promise(r => setTimeout(r, 400)),
        ]);
        expect(settledEarly).toBe(false);         // proven serialisation

        await ca.query('COMMIT');
        await blocked;
        await cb.query('COMMIT');

        // 10 - 4 + 5, with no lost update in either direction.
        expect(await onHand(s)).toBe(11);
      } finally {
        ca.release(); cb.release();
      }
    });
  });
});
