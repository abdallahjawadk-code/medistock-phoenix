/**
 * 165 · SECTOR ↔ HEALTH-CENTRE SUPPLY AND RETURN (Stage E · E-3) — dynamic proof.
 *
 * Builds a disposable Postgres through 001->165 and exercises both replaced
 * endpoint validators against the real schema.
 *
 * The point of this file is the REJECTION matrix. E-3 widens two security
 * predicates, so the evidence that matters is what they still refuse — and that
 * the pre-existing central corridors behave byte-identically, error identifier
 * for error identifier.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 60000 });

const run = rigAvailable() ? describe : describe.skip;

// ── Organizations ────────────────────────────────────────────────────────────
const ORG_CENTRAL = '00000000-0000-0000-0000-000000165001'; // owns the central wh
const ORG_SECTOR = '00000000-0000-0000-0000-000000165002'; // health_sector
const ORG_SECTOR_2 = '00000000-0000-0000-0000-000000165003'; // another health_sector
const ORG_HOSPITAL = '00000000-0000-0000-0000-000000165004';
const ORG_SPECIAL = '00000000-0000-0000-0000-000000165005';
const ORG_UNCLASSIFIED = '00000000-0000-0000-0000-000000165006';

// ── Facilities ───────────────────────────────────────────────────────────────
const FAC_A = '00000000-0000-0000-0000-000000165101'; // primary, sector 1
const FAC_B = '00000000-0000-0000-0000-000000165102'; // subordinate, sector 1
const FAC_INACTIVE = '00000000-0000-0000-0000-000000165103'; // sector 1, inactive
const FAC_S2 = '00000000-0000-0000-0000-000000165104'; // sector 2

// ── Warehouses ───────────────────────────────────────────────────────────────
const WH_CENTRAL = '00000000-0000-0000-0000-000000165201'; // kind=central
const WH_SECTOR = '00000000-0000-0000-0000-000000165202'; // sector-level, facility NULL
const WH_SECTOR_ALT = '00000000-0000-0000-0000-000000165203'; // 2nd sector-level
const WH_FAC_A = '00000000-0000-0000-0000-000000165204';
const WH_FAC_B = '00000000-0000-0000-0000-000000165205';
const WH_FAC_INACTIVE = '00000000-0000-0000-0000-000000165206'; // wh of inactive facility
const WH_FAC_A_INACTIVE = '00000000-0000-0000-0000-000000165207'; // inactive wh, active facility
const WH_SECTOR2 = '00000000-0000-0000-0000-000000165208';
const WH_FAC_S2 = '00000000-0000-0000-0000-000000165209';
const WH_HOSP = '00000000-0000-0000-0000-000000165210';
const WH_HOSP_2 = '00000000-0000-0000-0000-000000165211';
const WH_SPECIAL = '00000000-0000-0000-0000-000000165212';
const WH_SPECIAL_2 = '00000000-0000-0000-0000-000000165213';
const WH_UNCL = '00000000-0000-0000-0000-000000165214'; // unclassified org, sector-shaped
const WH_UNCL_FAC = '00000000-0000-0000-0000-000000165215';
const WH_SECTOR_INACTIVE = '00000000-0000-0000-0000-000000165216';

// ── Provenance fixture (sector -> FAC_A forward transfer) ─────────────────────
const XFER_SECTOR_A = '00000000-0000-0000-0000-000000165301';
const XLINE_SECTOR_A = '00000000-0000-0000-0000-000000165302';
const STOCK_AT_FAC_A = '00000000-0000-0000-0000-000000165303';
const STOCK_AT_SECTOR = '00000000-0000-0000-0000-000000165304';

const call = (c: any, fn: string, args: any[]) =>
  c.query(
    `SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`,
    args,
  ).then((r: any) => r.rows[0].r);

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  throw new Error('expected a rejection but the call succeeded');
};

run('165 · sector ↔ health-centre supply and return (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  /** Direct validator call: forward. */
  const fwd = (src: string, dst: string, org: string | null = null) =>
    rig.asAdmin((c: any) => c.query(
      `SELECT * FROM public.phoenix_assert_direct_supply_endpoints($1,$2,$3)`,
      [src, dst, org],
    ).then((r: any) => r.rows[0]));

  /** Direct validator call: return (arg1 = return SOURCE, arg2 = return DESTINATION). */
  const ret = (src: string, dst: string) =>
    rig.asAdmin((c: any) => c.query(
      `SELECT * FROM public.phoenix_assert_direct_return_endpoints($1,$2)`,
      [src, dst],
    ).then((r: any) => r.rows[0]));

  beforeAll(async () => {
    rig = await buildRig();

    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_CENTRAL}','Central','Central','p165-central','pharmacy_department_authority',NULL),
        ('${ORG_SECTOR}','Sector','Sector','p165-sector','care_institution','health_sector'),
        ('${ORG_SECTOR_2}','Sector2','Sector2','p165-sector2','care_institution','health_sector'),
        ('${ORG_HOSPITAL}','Hospital','Hospital','p165-hospital','care_institution','hospital'),
        ('${ORG_SPECIAL}','Center','Center','p165-special','care_institution','specialized_center'),
        ('${ORG_UNCLASSIFIED}','Uncl','Uncl','p165-uncl','pharmacy_department_authority',NULL);

      INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}','primary_health_center','A','A','active'),
        ('${FAC_B}','${ORG_SECTOR}','subordinate_health_center','B','B','active'),
        ('${FAC_INACTIVE}','${ORG_SECTOR}','primary_health_center','X','X','inactive'),
        ('${FAC_S2}','${ORG_SECTOR_2}','primary_health_center','Z','Z','active');

      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','Central WH','Central WH','active','central','p165-wh-central',NULL),
        ('${WH_SECTOR}','${ORG_SECTOR}','Sector Depot','Sector Depot','active','institution','p165-wh-sector',NULL),
        ('${WH_SECTOR_ALT}','${ORG_SECTOR}','Sector Depot 2','Sector Depot 2','active','institution','p165-wh-sector-alt',NULL),
        ('${WH_SECTOR_INACTIVE}','${ORG_SECTOR}','Sector Depot Off','Sector Depot Off','inactive','institution','p165-wh-sector-off',NULL),
        ('${WH_FAC_A}','${ORG_SECTOR}','A Depot','A Depot','active','institution','p165-wh-a','${FAC_A}'),
        ('${WH_FAC_B}','${ORG_SECTOR}','B Depot','B Depot','active','institution','p165-wh-b','${FAC_B}'),
        ('${WH_FAC_INACTIVE}','${ORG_SECTOR}','X Depot','X Depot','active','institution','p165-wh-x','${FAC_INACTIVE}'),
        ('${WH_FAC_A_INACTIVE}','${ORG_SECTOR}','A Depot Off','A Depot Off','inactive','institution','p165-wh-a-off','${FAC_A}'),
        ('${WH_SECTOR2}','${ORG_SECTOR_2}','Sector2 Depot','Sector2 Depot','active','institution','p165-wh-sector2',NULL),
        ('${WH_FAC_S2}','${ORG_SECTOR_2}','Z Depot','Z Depot','active','institution','p165-wh-z','${FAC_S2}'),
        ('${WH_HOSP}','${ORG_HOSPITAL}','Hosp WH','Hosp WH','active','institution','p165-wh-hosp',NULL),
        ('${WH_HOSP_2}','${ORG_HOSPITAL}','Hosp WH2','Hosp WH2','active','institution','p165-wh-hosp2',NULL),
        ('${WH_SPECIAL}','${ORG_SPECIAL}','Ctr WH','Ctr WH','active','institution','p165-wh-ctr',NULL),
        ('${WH_SPECIAL_2}','${ORG_SPECIAL}','Ctr WH2','Ctr WH2','active','institution','p165-wh-ctr2',NULL),
        ('${WH_UNCL}','${ORG_UNCLASSIFIED}','U WH','U WH','active','central','p165-wh-u',NULL),
        ('${WH_UNCL_FAC}','${ORG_UNCLASSIFIED}','U WH2','U WH2','active','central','p165-wh-u2',NULL);

      -- Provenance fixture: a REAL direct forward transfer sector -> FAC_A,
      -- with a received line whose resulting stock sits at FAC_A. Seeded
      -- directly, exactly as this repo's other corridor dynamic tests do.
      INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,concentration,dosage_form,unit,
                                  national_code,has_no_national_code,batch_number,has_no_batch_number,expiry_date,
                                  on_hand_quantity,reserved_quantity,movement_seq,supply_type,purchase_origin)
      VALUES('${STOCK_AT_SECTOR}','${ORG_SECTOR}','${WH_SECTOR}','Amoxicillin','500 mg','capsule','box',
             'NDC-165',false,'B165',false,current_date+400,100,0,1,'purchase','supplementary'),
            ('${STOCK_AT_FAC_A}','${ORG_SECTOR}','${WH_FAC_A}','Amoxicillin','500 mg','capsule','box',
             'NDC-165',false,'B165',false,current_date+400,40,0,1,'purchase','supplementary');

      INSERT INTO warehouse_transfers(id,route_id,source_warehouse_id,source_organization_id,
                                      destination_warehouse_id,destination_organization_id,
                                      transfer_number,status,sent_at)
      VALUES('${XFER_SECTOR_A}',NULL,'${WH_SECTOR}','${ORG_SECTOR}','${WH_FAC_A}','${ORG_SECTOR}',
             'P165-XFER-1','received',now());

      INSERT INTO warehouse_transfer_lines(id,transfer_id,source_organization_id,source_warehouse_stock_id,
                                           scientific_name,concentration,dosage_form,unit,
                                           national_code,has_no_national_code,batch_number,has_no_batch_number,
                                           expiry_date,sent_quantity,received_quantity,status,received_at,
                                           resulting_warehouse_stock_id,supply_type,purchase_origin)
      VALUES('${XLINE_SECTOR_A}','${XFER_SECTOR_A}','${ORG_SECTOR}','${STOCK_AT_SECTOR}',
             'Amoxicillin','500 mg','capsule','box','NDC-165',false,'B165',false,
             current_date+400,40,40,'received',now(),'${STOCK_AT_FAC_A}','purchase','supplementary');
    `));
  });

  afterAll(async () => { if (rig) await rig.end(); });

  // ══════════════════════════════════════════════════════════════════════════
  // FORWARD — Branch A preserved
  // ══════════════════════════════════════════════════════════════════════════
  describe('forward · Branch A (central → institution) is unchanged', () => {
    it('accepts central → institution and returns both organization ids', async () => {
      const r: any = await fwd(WH_CENTRAL, WH_HOSP);
      expect(r.o_source_organization_id).toBe(ORG_CENTRAL);
      expect(r.o_destination_organization_id).toBe(ORG_HOSPITAL);
    });

    it('accepts central → a sector-level institution warehouse (unchanged)', async () => {
      const r: any = await fwd(WH_CENTRAL, WH_SECTOR);
      expect(r.o_destination_organization_id).toBe(ORG_SECTOR);
    });

    it('still rejects a NON-CENTRAL source with the ORIGINAL error identifier', async () => {
      const msg = await rejects(() => fwd(WH_HOSP, WH_HOSP_2));
      expect(msg).toMatch(/source_must_be_active_central_warehouse/);
    });

    it('still rejects a non-institution destination with the ORIGINAL identifier', async () => {
      // central -> central
      const msg = await rejects(() => fwd(WH_CENTRAL, WH_CENTRAL));
      expect(msg).toMatch(/source_and_destination_must_differ/);
    });

    it('still enforces the IDOR gate with the ORIGINAL identifier', async () => {
      const msg = await rejects(() => fwd(WH_CENTRAL, WH_HOSP, ORG_SECTOR));
      expect(msg).toMatch(/destination_warehouse_not_in_named_organization/);
    });

    it('still rejects NULL and identical endpoints', async () => {
      expect(await rejects(() => fwd(null as any, WH_HOSP))).toMatch(/source_and_destination_required/);
      expect(await rejects(() => fwd(WH_CENTRAL, WH_CENTRAL))).toMatch(/source_and_destination_must_differ/);
    });

    it('still rejects an inactive central source', async () => {
      await rig.asAdmin((c: any) => c.query(`UPDATE warehouses SET status='inactive' WHERE id=$1`, [WH_CENTRAL]));
      const msg = await rejects(() => fwd(WH_CENTRAL, WH_HOSP));
      expect(msg).toMatch(/source_must_be_active_central_warehouse/);
      await rig.asAdmin((c: any) => c.query(`UPDATE warehouses SET status='active' WHERE id=$1`, [WH_CENTRAL]));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // FORWARD — Branch B legal case
  // ══════════════════════════════════════════════════════════════════════════
  describe('forward · Branch B (sector → same-sector health centre) is legal', () => {
    it('accepts sector-level → active primary health-centre warehouse', async () => {
      const r: any = await fwd(WH_SECTOR, WH_FAC_A);
      expect(r.o_source_organization_id).toBe(ORG_SECTOR);
      expect(r.o_destination_organization_id).toBe(ORG_SECTOR);
    });

    it('accepts sector-level → active SUBORDINATE health-centre warehouse', async () => {
      const r: any = await fwd(WH_SECTOR, WH_FAC_B);
      expect(r.o_destination_organization_id).toBe(ORG_SECTOR);
    });

    it('accepts from a SECOND sector-level depot of the same sector', async () => {
      const r: any = await fwd(WH_SECTOR_ALT, WH_FAC_A);
      expect(r.o_destination_organization_id).toBe(ORG_SECTOR);
    });

    it('still applies the IDOR gate on the new branch', async () => {
      const msg = await rejects(() => fwd(WH_SECTOR, WH_FAC_A, ORG_SECTOR_2));
      expect(msg).toMatch(/destination_warehouse_not_in_named_organization/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // FORWARD — the twelve rejection cases (V4 §8)
  // ══════════════════════════════════════════════════════════════════════════
  describe('forward · rejection matrix', () => {
    it('1. health-centre depot → sector depot (reverse direction is not a forward supply)', async () => {
      expect(await rejects(() => fwd(WH_FAC_A, WH_SECTOR))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('2. health-centre A → health-centre B', async () => {
      expect(await rejects(() => fwd(WH_FAC_A, WH_FAC_B))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('3. primary centre → subordinate centre', async () => {
      expect(await rejects(() => fwd(WH_FAC_A, WH_FAC_B))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('4. hospital institution → another hospital institution', async () => {
      expect(await rejects(() => fwd(WH_HOSP, WH_HOSP_2))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('5. specialized centre → another specialized centre', async () => {
      expect(await rejects(() => fwd(WH_SPECIAL, WH_SPECIAL_2))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('6. hospital → health sector', async () => {
      expect(await rejects(() => fwd(WH_HOSP, WH_SECTOR))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('7. health sector → hospital', async () => {
      expect(await rejects(() => fwd(WH_SECTOR, WH_HOSP))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('8. cross-sector: sector 1 depot → sector 2 health centre', async () => {
      expect(await rejects(() => fwd(WH_SECTOR, WH_FAC_S2))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('9. sector depot → health centre owned by another sector (cross-organization)', async () => {
      expect(await rejects(() => fwd(WH_SECTOR2, WH_FAC_A))).toMatch(/source_must_be_active_central_warehouse/);
    });
    it('10. INACTIVE sector depot → health centre', async () => {
      expect(await rejects(() => fwd(WH_SECTOR_INACTIVE, WH_FAC_A))).toMatch(/sector_source_warehouse_not_active/);
    });
    it('11. sector depot → INACTIVE health-centre FACILITY', async () => {
      expect(await rejects(() => fwd(WH_SECTOR, WH_FAC_INACTIVE))).toMatch(/health_center_facility_not_active/);
    });
    it('12. sector depot → INACTIVE health-centre WAREHOUSE', async () => {
      expect(await rejects(() => fwd(WH_SECTOR, WH_FAC_A_INACTIVE))).toMatch(/health_center_warehouse_not_active/);
    });

    it('extra: an UNCLASSIFIED organization can never own a facility at all', async () => {
      // The sector branch needs destination.facility_id IS NOT NULL, and 164's
      // of_parent_class_fk admits only a health_sector parent. So an
      // unclassified organization cannot even construct the shape.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO organization_facilities(organization_id,facility_class,name,name_ar,status)
        VALUES('${ORG_UNCLASSIFIED}','primary_health_center','U','U','active')`)));
      expect(msg).toMatch(/of_parent_class_fk|violates foreign key/i);
    });

    it('extra: a classified sector owning a facility cannot be silently un-classified', async () => {
      // Removing the class would strand the facility, so the same composite FK
      // refuses it — the sector branch cannot be disarmed after the fact.
      // Migration 170 (STAGE-E-E7-1-170, applied after this test was
      // originally written) added institution_class's own immutability
      // trigger, which now intercepts ANY change away from a set class —
      // including this one — before the row ever reaches the FK. Same
      // invariant ("a classified sector cannot be un-classified"), now
      // enforced one layer earlier and unconditionally, not just when a
      // facility happens to exist; both error identifiers prove it.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE organizations SET institution_class=NULL WHERE id=$1`, [ORG_SECTOR])));
      expect(msg).toMatch(/organization_institution_class_immutable|of_parent_class_fk|violates foreign key/i);
    });

    it('extra: a hospital organization can never own a facility either', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO organization_facilities(organization_id,facility_class,name,name_ar,status)
        VALUES('${ORG_HOSPITAL}','primary_health_center','H','H','active')`)));
      expect(msg).toMatch(/of_parent_class_fk|violates foreign key/i);
    });

    it('extra: destination with facility_id NULL never reaches the sector branch', async () => {
      expect(await rejects(() => fwd(WH_SECTOR, WH_SECTOR_ALT)))
        .toMatch(/source_must_be_active_central_warehouse/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETURN — Branch A preserved
  // ══════════════════════════════════════════════════════════════════════════
  describe('return · Branch A (institution → central) is unchanged', () => {
    it('still rejects a non-institution source with the ORIGINAL identifier', async () => {
      expect(await rejects(() => ret(WH_CENTRAL, WH_CENTRAL)))
        .toMatch(/source_and_destination_must_differ/);
    });

    it('still rejects a non-central destination with the ORIGINAL identifier', async () => {
      // hospital institution -> hospital institution: not a sector shape, so it
      // falls through to Branch A and must complain about the destination.
      expect(await rejects(() => ret(WH_HOSP, WH_HOSP_2)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });

    it('still demands forward provenance with the ORIGINAL identifier', async () => {
      expect(await rejects(() => ret(WH_HOSP, WH_CENTRAL)))
        .toMatch(/no_direct_forward_provenance_between_warehouses/);
    });

    it('accepts institution → central when real direct provenance exists', async () => {
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO warehouse_transfers(id,route_id,source_warehouse_id,source_organization_id,
                                        destination_warehouse_id,destination_organization_id,
                                        transfer_number,status,sent_at)
        VALUES('00000000-0000-0000-0000-0000001653FF',NULL,'${WH_CENTRAL}','${ORG_CENTRAL}',
               '${WH_HOSP}','${ORG_HOSPITAL}','P165-XFER-C1','received',now())
        ON CONFLICT (id) DO NOTHING;`));
      const r: any = await ret(WH_HOSP, WH_CENTRAL);
      expect(r.o_institution_organization_id).toBe(ORG_HOSPITAL);
      expect(r.o_central_organization_id).toBe(ORG_CENTRAL);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETURN — Branch B legal case
  // ══════════════════════════════════════════════════════════════════════════
  describe('return · Branch B (health centre → parent sector) is legal', () => {
    it('accepts health-centre → its own sector depot WITH forward provenance', async () => {
      const r: any = await ret(WH_FAC_A, WH_SECTOR);
      expect(r.o_institution_organization_id).toBe(ORG_SECTOR);
      expect(r.o_central_organization_id).toBe(ORG_SECTOR);
    });

    it('rejects health-centre → a sector depot it never received from', async () => {
      // WH_SECTOR_ALT never supplied FAC_A: no provenance row exists.
      expect(await rejects(() => ret(WH_FAC_A, WH_SECTOR_ALT)))
        .toMatch(/no_direct_forward_provenance_between_warehouses/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETURN — the eleven rejection cases (Addendum §G.1)
  // ══════════════════════════════════════════════════════════════════════════
  describe('return · rejection matrix', () => {
    it('1. health-centre A → health-centre B', async () => {
      expect(await rejects(() => ret(WH_FAC_A, WH_FAC_B)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('2. primary centre → subordinate centre', async () => {
      expect(await rejects(() => ret(WH_FAC_A, WH_FAC_B)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('3. health-centre → sector-level warehouse in ANOTHER organization', async () => {
      expect(await rejects(() => ret(WH_FAC_A, WH_SECTOR2)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('4. health-centre in sector 1 → sector 2', async () => {
      expect(await rejects(() => ret(WH_FAC_A, WH_SECTOR2)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('5. sector depot → health centre AS A RETURN (wrong direction)', async () => {
      expect(await rejects(() => ret(WH_SECTOR, WH_FAC_A)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('6. hospital warehouse → hospital warehouse', async () => {
      expect(await rejects(() => ret(WH_HOSP, WH_HOSP_2)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('7. specialized centre → specialized centre', async () => {
      expect(await rejects(() => ret(WH_SPECIAL, WH_SPECIAL_2)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('8. sector-level → another sector-level warehouse', async () => {
      expect(await rejects(() => ret(WH_SECTOR, WH_SECTOR_ALT)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('9. source with facility_id NULL → sector depot', async () => {
      expect(await rejects(() => ret(WH_SECTOR_ALT, WH_SECTOR)))
        .toMatch(/destination_must_be_active_central_warehouse/);
    });
    it('10. health centre whose stock did NOT come from the claimed sector depot', async () => {
      expect(await rejects(() => ret(WH_FAC_B, WH_SECTOR)))
        .toMatch(/no_direct_forward_provenance_between_warehouses/);
    });
    it('11. INACTIVE facility cannot return', async () => {
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO warehouse_transfers(id,route_id,source_warehouse_id,source_organization_id,
                                        destination_warehouse_id,destination_organization_id,
                                        transfer_number,status,sent_at)
        VALUES('00000000-0000-0000-0000-0000001653FE',NULL,'${WH_SECTOR}','${ORG_SECTOR}',
               '${WH_FAC_INACTIVE}','${ORG_SECTOR}','P165-XFER-X','received',now())
        ON CONFLICT (id) DO NOTHING;`));
      expect(await rejects(() => ret(WH_FAC_INACTIVE, WH_SECTOR)))
        .toMatch(/health_center_facility_not_active/);
    });

    it('extra: INACTIVE health-centre warehouse cannot return', async () => {
      expect(await rejects(() => ret(WH_FAC_A_INACTIVE, WH_SECTOR)))
        .toMatch(/health_center_warehouse_not_active/);
    });

    it('extra: INACTIVE sector destination is refused', async () => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET status='inactive' WHERE id=$1`, [WH_SECTOR]));
      expect(await rejects(() => ret(WH_FAC_A, WH_SECTOR)))
        .toMatch(/sector_destination_warehouse_not_active/);
      await rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET status='active' WHERE id=$1`, [WH_SECTOR]));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Callers
  // ══════════════════════════════════════════════════════════════════════════
  describe('callers accept the new branches', () => {
    it('phoenix_create_direct_warehouse_transfer_request opens a sector → centre request', async () => {
      const r: any = await rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_create_direct_warehouse_transfer_request',
          [WH_SECTOR, ORG_SECTOR, WH_FAC_A, 'P165-REQ-1', null]));
      expect(r.ok).toBe(true);
    });

    it('phoenix_create_direct_warehouse_transfer_request still refuses centre → centre', async () => {
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_create_direct_warehouse_transfer_request',
          [WH_FAC_A, ORG_SECTOR, WH_FAC_B, 'P165-REQ-BAD', null])));
      expect(msg).toMatch(/source_must_be_active_central_warehouse/);
    });

    it('phoenix_request_direct_warehouse_return opens a centre → sector return', async () => {
      const r: any = await rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_request_direct_warehouse_return',
          [WH_FAC_A, WH_SECTOR, 'P165-RET-1', null]));
      expect(r.ok).toBe(true);
    });

    it('phoenix_recall_direct_warehouse_transfer lets the SECTOR recall from its own centre', async () => {
      const r: any = await rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_recall_direct_warehouse_transfer',
          [WH_FAC_A, WH_SECTOR, 'P165-RECALL-1', null]));
      expect(r.ok).toBe(true);
    });

    it('recall still refuses a pair with no forward provenance', async () => {
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_recall_direct_warehouse_transfer',
          [WH_FAC_B, WH_SECTOR, 'P165-RECALL-BAD', null])));
      expect(msg).toMatch(/no_direct_forward_provenance_between_warehouses/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Return provenance and cap, end to end
  // ══════════════════════════════════════════════════════════════════════════
  describe('return line provenance and quantity cap', () => {
    const REQ = '00000000-0000-0000-0000-000000165401';

    beforeAll(async () => {
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO warehouse_return_requests(id,route_id,source_warehouse_id,source_organization_id,
                                              destination_warehouse_id,destination_organization_id,
                                              return_number,status,requested_by_side)
        VALUES('${REQ}',NULL,'${WH_FAC_A}','${ORG_SECTOR}','${WH_SECTOR}','${ORG_SECTOR}',
               'P165-RET-LINE','draft','sender')
        ON CONFLICT (id) DO NOTHING;`));
    });

    it('accepts a line pinned to the exact original transfer line, within cap', async () => {
      const r: any = await rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_add_direct_warehouse_return_request_line',
          [REQ, XLINE_SECTOR_A, 10, 'excess', null]));
      expect(r.ok).toBe(true);
    });

    it('refuses a quantity above the remaining returnable cap', async () => {
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_add_direct_warehouse_return_request_line',
          [REQ, XLINE_SECTOR_A, 999, 'excess', null])));
      expect(msg).toMatch(/requested_quantity_exceeds_returnable/);
    });

    it('refuses a line whose original transfer belongs to a DIFFERENT corridor', async () => {
      // A transfer line from the central -> hospital corridor cannot be returned
      // through this sector corridor.
      await rig.asAdmin((c: any) => c.query(`
        -- The line belongs to the CENTRAL -> HOSPITAL transfer, so its
        -- source_organization_id must be the central org (wtl_transfer_org_fk),
        -- and its source stock must live in that org.
        INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,
                                    has_no_national_code,has_no_batch_number,internal_batch_reference,
                                    on_hand_quantity,reserved_quantity,movement_seq)
        VALUES('00000000-0000-0000-0000-000000165502','${ORG_CENTRAL}','${WH_CENTRAL}','Other',
               true,true,'P165-IBR-SRC',5,0,1),
              ('00000000-0000-0000-0000-000000165503','${ORG_HOSPITAL}','${WH_HOSP}','Other',
               true,true,'P165-IBR-DST',5,0,1)
        ON CONFLICT (id) DO NOTHING;
        INSERT INTO warehouse_transfer_lines(id,transfer_id,source_organization_id,source_warehouse_stock_id,
                                             scientific_name,has_no_national_code,has_no_batch_number,
                                             internal_batch_reference,sent_quantity,received_quantity,
                                             status,received_at,resulting_warehouse_stock_id)
        VALUES('00000000-0000-0000-0000-000000165501','00000000-0000-0000-0000-0000001653FF','${ORG_CENTRAL}',
               '00000000-0000-0000-0000-000000165502','Other',true,true,'P165-IBR-SRC',5,5,'received',now(),
               '00000000-0000-0000-0000-000000165503')
        ON CONFLICT (id) DO NOTHING;`));
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_add_direct_warehouse_return_request_line',
          [REQ, '00000000-0000-0000-0000-000000165501', 1, 'excess', null])));
      expect(msg).toMatch(/original_line_not_from_this_direct_corridor/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Non-regression
  // ══════════════════════════════════════════════════════════════════════════
  describe('E-3 changes nothing else', () => {
    it('signatures and OUT parameter names are unchanged', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_function_arguments('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure) AS f,
               pg_get_function_arguments('public.phoenix_assert_direct_return_endpoints(uuid,uuid)'::regprocedure) AS r`));
      expect(rows[0].f).toBe('p_source_warehouse_id uuid, p_destination_warehouse_id uuid, p_destination_organization_id uuid, OUT o_source_organization_id uuid, OUT o_destination_organization_id uuid');
      expect(rows[0].r).toBe('p_institution_warehouse_id uuid, p_central_warehouse_id uuid, OUT o_institution_organization_id uuid, OUT o_central_organization_id uuid');
    });

    it('no generic same-organization shortcut exists in either validator', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_functiondef('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure) AS f,
               pg_get_functiondef('public.phoenix_assert_direct_return_endpoints(uuid,uuid)'::regprocedure) AS r`));
      for (const def of [rows[0].f, rows[0].r]) {
        expect(def).toContain('facility_id IS NULL');
        expect(def).toContain('facility_id IS NOT NULL');
        // No name-based inference: no fuzzy matching operator, and no read of a
        // name column. (The literal word "name" may appear in prose comments;
        // what must not appear is a comparison against a name.)
        expect(def).not.toMatch(/ILIKE|SIMILAR TO/i);
        expect(def).not.toMatch(/\.name\b|\bname\s*(=|LIKE|~)/i);
      }
    });

    it('warehouse_kind, movement vocabulary and Availability are untouched', async () => {
      // E-3 itself never widens outlet_stock_movements_type_chk. The effective
      // chain tip may include Migration 168 (E-5) which adds replenish_*; assert
      // the pre-E-5 core types and warehouse_kind / Availability invariants.
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='warehouses_warehouse_kind_chk') AS wk,
               (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='outlet_stock_movements_type_chk') AS mv,
               (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                 WHERE conrelid='public.item_availability'::regclass
                   AND pg_get_constraintdef(oid) LIKE '%near_expiry%' LIMIT 1) AS av`));
      expect(rows[0].wk).toBe("CHECK ((warehouse_kind = ANY (ARRAY['central'::text, 'institution'::text])))");
      expect(rows[0].mv).toMatch(/dispense/);
      expect(rows[0].mv).toMatch(/dispatch_receive/);
      expect(rows[0].av).not.toMatch(/near_stockout/);
    });

    it('creates no new table and no second balance ledger', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int AS n FROM pg_class
        WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock')`));
      expect(rows[0].n).toBe(0);
    });
  });
});
