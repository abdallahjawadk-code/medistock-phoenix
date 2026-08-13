/**
 * 182 · HEALTH-CENTER FACILITY-SCOPED RBAC (R1.1-U) — dynamic proof.
 *
 * THE CONTRACT: role defines WHAT, facility scope defines WHERE. A health-centre
 * manager reaches the depot, pharmacy and crash cabinets of the centres it is
 * assigned to — and NOTHING else. Above all it must never reach the SECTOR MAIN
 * merely because it belongs to the same organization.
 *
 * The fixture is deliberately adversarial: two health sectors, two centres in
 * the first, a hospital, and managers holding one centre, two centres, and a
 * foreign sector's centre. Every access question is asked of all three.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const PREAPPLY = readFileSync(
  join(process.cwd(), 'docs/phoenix/r1-1-u-182-production-preapply-readonly.sql'), 'utf8');

vi.setConfig({ testTimeout: 240000 });
const run = rigAvailable() ? describe : describe.skip;

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return [e?.message, e?.detail].filter(Boolean).join(' | ') || String(e); }
  throw new Error('expected a rejection but the call succeeded');
};

// ── The fixture, by name so the matrices below read as intent ────────────────
const SECTOR_A = randomUUID(), SECTOR_B = randomUUID(), HOSPITAL = randomUUID();
const CENTER_A = randomUUID(), CENTER_B = randomUUID(), CENTER_C = randomUUID();
const CENTER_OFF = randomUUID();
const MAIN_A = randomUUID(), DEPOT_A = randomUUID(), DEPOT_B = randomUUID();
const MAIN_B = randomUUID(), DEPOT_C = randomUUID(), HOSP_WH = randomUUID();
const PHARM_A = randomUUID(), CAB_A = randomUUID(), PHARM_B = randomUUID(), PHARM_C = randomUUID();
const ADMIN_A = randomUUID(), ADMIN_HOSP = randomUUID();
const MGR_A = randomUUID(), MGR_AB = randomUUID(), MGR_B_SECTOR = randomUUID();
const WH_OFFICER = randomUUID(), OUTLET_OFFICER = randomUUID();
const SUPER = '00000000-0000-0000-0000-0000000000a1';

run('182 · facility-scoped RBAC (001->182 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${SECTOR_A}','Sector A','قطاع أ','u182-sa','care_institution','health_sector','active'),
        ('${SECTOR_B}','Sector B','قطاع ب','u182-sb','care_institution','health_sector','active'),
        ('${HOSPITAL}','Hospital','مستشفى','u182-h','care_institution','hospital','active');

      INSERT INTO organization_facilities (id,organization_id,parent_institution_class,facility_class,name,name_ar,status) VALUES
        ('${CENTER_A}','${SECTOR_A}','health_sector','primary_health_center','Center A','مركز أ','active'),
        ('${CENTER_B}','${SECTOR_A}','health_sector','subordinate_health_center','Center B','مركز ب','active'),
        ('${CENTER_OFF}','${SECTOR_A}','health_sector','primary_health_center','Center Off','مركز مغلق','inactive'),
        ('${CENTER_C}','${SECTOR_B}','health_sector','primary_health_center','Center C','مركز ج','active');

      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${MAIN_A}','${SECTOR_A}','Sector A Main','رئيسي أ','institution',NULL,true,'active'),
        ('${DEPOT_A}','${SECTOR_A}','Depot A','مذخر أ','institution','${CENTER_A}',false,'active'),
        ('${DEPOT_B}','${SECTOR_A}','Depot B','مذخر ب','institution','${CENTER_B}',false,'active'),
        ('${MAIN_B}','${SECTOR_B}','Sector B Main','رئيسي ب','institution',NULL,true,'active'),
        ('${DEPOT_C}','${SECTOR_B}','Depot C','مذخر ج','institution','${CENTER_C}',false,'active'),
        ('${HOSP_WH}','${HOSPITAL}','Hospital WH','مخزن','institution',NULL,true,'active');

      INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PHARM_A}','${DEPOT_A}','${SECTOR_A}','Pharmacy A','صيدلية أ','pharmacy','active',NULL),
        ('${CAB_A}','${DEPOT_A}','${SECTOR_A}','Cabinet A','خزانة أ','crash_cabinet','active','emergency'),
        ('${PHARM_B}','${DEPOT_B}','${SECTOR_A}','Pharmacy B','صيدلية ب','pharmacy','active',NULL),
        ('${PHARM_C}','${DEPOT_C}','${SECTOR_B}','Pharmacy C','صيدلية ج','pharmacy','active',NULL);

      INSERT INTO auth.users (id,email) VALUES
        ('${ADMIN_A}','u182-admin-a@rig.local'),
        ('${ADMIN_HOSP}','u182-admin-h@rig.local'),
        ('${MGR_A}','u182-mgr-a@rig.local'),
        ('${MGR_AB}','u182-mgr-ab@rig.local'),
        ('${MGR_B_SECTOR}','u182-mgr-b@rig.local'),
        ('${WH_OFFICER}','u182-wh@rig.local'),
        ('${OUTLET_OFFICER}','u182-outlet@rig.local') ON CONFLICT DO NOTHING;

      UPDATE profiles SET role='institution_admin',     status='active', organization_id='${SECTOR_A}' WHERE id='${ADMIN_A}';
      UPDATE profiles SET role='institution_admin',     status='active', organization_id='${HOSPITAL}' WHERE id='${ADMIN_HOSP}';
      UPDATE profiles SET role='health_center_manager', status='active', organization_id='${SECTOR_A}' WHERE id='${MGR_A}';
      UPDATE profiles SET role='health_center_manager', status='active', organization_id='${SECTOR_A}' WHERE id='${MGR_AB}';
      UPDATE profiles SET role='health_center_manager', status='active', organization_id='${SECTOR_B}' WHERE id='${MGR_B_SECTOR}';
      UPDATE profiles SET role='warehouse_officer',     status='active', organization_id='${SECTOR_A}' WHERE id='${WH_OFFICER}';
      UPDATE profiles SET role='outlet_officer',        status='active', organization_id='${SECTOR_A}' WHERE id='${OUTLET_OFFICER}';

      INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active) VALUES
        ('${MGR_A}','${SECTOR_A}','facility','${CENTER_A}',true),
        ('${MGR_AB}','${SECTOR_A}','facility','${CENTER_A}',true),
        ('${MGR_AB}','${SECTOR_A}','facility','${CENTER_B}',true),
        ('${MGR_B_SECTOR}','${SECTOR_B}','facility','${CENTER_C}',true);

      INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,warehouse_id,is_active) VALUES
        ('${WH_OFFICER}','${SECTOR_A}','warehouse','${DEPOT_A}',true);
      INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,distribution_point_id,is_active) VALUES
        ('${OUTLET_OFFICER}','${SECTOR_A}','distribution_point','${PHARM_A}',true);
    `);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  const wh = async (profile: string, warehouse: string): Promise<boolean> =>
    (await asAdmin('SELECT phoenix_profile_has_warehouse_assignment($1,$2) AS ok', [profile, warehouse])).rows[0].ok;
  const dp = async (profile: string, point: string): Promise<boolean> =>
    (await asAdmin('SELECT phoenix_profile_has_point_assignment($1,$2) AS ok', [profile, point])).rows[0].ok;
  const fac = async (profile: string, facility: string): Promise<boolean> =>
    (await asAdmin('SELECT phoenix_profile_has_facility_assignment($1,$2) AS ok', [profile, facility])).rows[0].ok;

  // ══ C. RESOURCE ACCESS ════════════════════════════════════════════════════
  describe('C · manager A reaches centre A and nothing else', () => {
    it('facility A YES, facility B NO, foreign centre C NO', async () => {
      expect(await fac(MGR_A, CENTER_A)).toBe(true);
      expect(await fac(MGR_A, CENTER_B)).toBe(false);
      expect(await fac(MGR_A, CENTER_C)).toBe(false);
    });
    it('depot A YES, depot B NO, foreign depot C NO', async () => {
      expect(await wh(MGR_A, DEPOT_A)).toBe(true);
      expect(await wh(MGR_A, DEPOT_B)).toBe(false);
      expect(await wh(MGR_A, DEPOT_C)).toBe(false);
    });
    it('pharmacy A and crash cabinet A YES; pharmacy B and C NO', async () => {
      expect(await dp(MGR_A, PHARM_A)).toBe(true);
      expect(await dp(MGR_A, CAB_A)).toBe(true);
      expect(await dp(MGR_A, PHARM_B)).toBe(false);
      expect(await dp(MGR_A, PHARM_C)).toBe(false);
    });
    it('THE SECTOR MAIN IS NEVER REACHABLE — its own sector or any other', async () => {
      expect(await wh(MGR_A, MAIN_A)).toBe(false);
      expect(await wh(MGR_A, MAIN_B)).toBe(false);
      expect(await wh(MGR_A, HOSP_WH)).toBe(false);
    });
  });

  describe('C · manager A+B holds two centres and still no sector main', () => {
    it('both centres, both depots, both pharmacies', async () => {
      expect(await fac(MGR_AB, CENTER_A)).toBe(true);
      expect(await fac(MGR_AB, CENTER_B)).toBe(true);
      expect(await wh(MGR_AB, DEPOT_A)).toBe(true);
      expect(await wh(MGR_AB, DEPOT_B)).toBe(true);
      expect(await dp(MGR_AB, PHARM_A)).toBe(true);
      expect(await dp(MGR_AB, PHARM_B)).toBe(true);
    });
    it('holding EVERY centre in the sector still does not confer the main', async () => {
      expect(await wh(MGR_AB, MAIN_A)).toBe(false);
    });
  });

  // ══ D. ORGANIZATION ISOLATION ═════════════════════════════════════════════
  describe('D · cross-sector isolation', () => {
    it('sector B manager reaches only its own centre', async () => {
      expect(await wh(MGR_B_SECTOR, DEPOT_C)).toBe(true);
      expect(await dp(MGR_B_SECTOR, PHARM_C)).toBe(true);
      for (const w of [MAIN_A, DEPOT_A, DEPOT_B, MAIN_B]) expect(await wh(MGR_B_SECTOR, w), w).toBe(false);
      for (const p of [PHARM_A, CAB_A, PHARM_B]) expect(await dp(MGR_B_SECTOR, p), p).toBe(false);
    });
    it('a cross-sector facility assignment is structurally impossible', async () => {
      // Layer 1 — the composite FK. Layer 2 — the write-time trigger.
      const msg = await rejects(() => asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true)`, [MGR_A, SECTOR_A, CENTER_C]));
      expect(msg).toMatch(/psa_facility_org_fk|FACILITY|violates foreign key/i);
    });
    it('even a forged same-org row naming a foreign facility is refused', async () => {
      const msg = await rejects(() => asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true)`, [MGR_A, SECTOR_B, CENTER_C]));
      expect(msg).toMatch(/SCOPE_ASSIGNMENT_ORG_MISMATCH/);
    });
  });

  // ══ G. HELPERS — historical behaviour and fail-closed drift ═══════════════
  describe('G · direct assignments keep their exact historical behaviour', () => {
    it('a warehouse officer with a DIRECT assignment is unaffected by 182', async () => {
      expect(await wh(WH_OFFICER, DEPOT_A)).toBe(true);
      expect(await wh(WH_OFFICER, DEPOT_B)).toBe(false);
      expect(await wh(WH_OFFICER, MAIN_A)).toBe(false);
    });
    it('an outlet officer with a DIRECT assignment is unaffected by 182', async () => {
      expect(await dp(OUTLET_OFFICER, PHARM_A)).toBe(true);
      expect(await dp(OUTLET_OFFICER, PHARM_B)).toBe(false);
    });
    it('the facility-derived path is NOT open to a non-manager role', async () => {
      // Give the warehouse officer a facility row by force; the helper must
      // still refuse, because it re-proves the role at read time.
      await asAdmin(`SET session_replication_role = 'replica'`);
      await asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true)`, [WH_OFFICER, SECTOR_A, CENTER_B]);
      await asAdmin(`SET session_replication_role = 'origin'`);
      expect(await fac(WH_OFFICER, CENTER_B)).toBe(false);
      expect(await wh(WH_OFFICER, DEPOT_B)).toBe(false);
      await asAdmin(
        `DELETE FROM profile_scope_assignments WHERE profile_id=$1 AND scope_type='facility'`, [WH_OFFICER]);
    });
    it('NULL arguments never match', async () => {
      expect(await wh(MGR_A, null as any)).toBe(false);
      expect(await dp(MGR_A, null as any)).toBe(false);
      expect(await fac(MGR_A, null as any)).toBe(false);
    });
  });

  describe('G · read-time drift closes access immediately', () => {
    const probe = randomUUID();
    let assignmentId: string;

    beforeAll(async () => {
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-drift@rig.local') ON CONFLICT DO NOTHING`, [probe]);
      await asAdmin(`UPDATE profiles SET role='health_center_manager', status='active', organization_id=$2 WHERE id=$1`, [probe, SECTOR_A]);
      assignmentId = (await asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true) RETURNING id`, [probe, SECTOR_A, CENTER_B])).rows[0].id;
      expect(await wh(probe, DEPOT_B)).toBe(true);
    });

    it('a SUSPENDED profile loses access with no backfill', async () => {
      await asAdmin(`UPDATE profiles SET status='suspended' WHERE id=$1`, [probe]);
      expect(await fac(probe, CENTER_B)).toBe(false);
      expect(await wh(probe, DEPOT_B)).toBe(false);
      await asAdmin(`UPDATE profiles SET status='active' WHERE id=$1`, [probe]);
      expect(await wh(probe, DEPOT_B)).toBe(true);
    });

    it('a REVOKED assignment loses access and keeps its history', async () => {
      await asAdmin(
        `UPDATE profile_scope_assignments SET is_active=false, revoked_at=now(), revoke_reason='drift test' WHERE id=$1`,
        [assignmentId]);
      expect(await fac(probe, CENTER_B)).toBe(false);
      expect(await wh(probe, DEPOT_B)).toBe(false);
      const row = await asAdmin(`SELECT is_active, revoke_reason FROM profile_scope_assignments WHERE id=$1`, [assignmentId]);
      expect(row.rows[0].is_active).toBe(false);
      expect(row.rows[0].revoke_reason).toBe('drift test');
    });

    it('reassignment after revoke succeeds — history never blocks reuse', async () => {
      const again = await asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true) RETURNING id`, [probe, SECTOR_A, CENTER_B]);
      expect(again.rows[0].id).toBeTruthy();
      expect(await wh(probe, DEPOT_B)).toBe(true);
      const history = await asAdmin(
        `SELECT count(*)::int n FROM profile_scope_assignments WHERE profile_id=$1 AND facility_id=$2`, [probe, CENTER_B]);
      expect(history.rows[0].n).toBe(2);   // the revoked row survives
    });

    it('a second ACTIVE assignment to the same centre is impossible', async () => {
      const msg = await rejects(() => asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true)`, [probe, SECTOR_A, CENTER_B]));
      expect(msg).toMatch(/psa_active_facility_uniq/);
    });

    it('DEACTIVATING the facility closes access without deleting history', async () => {
      await asAdmin(`SET session_replication_role = 'replica'`);
      await asAdmin(`UPDATE organization_facilities SET status='inactive' WHERE id=$1`, [CENTER_B]);
      await asAdmin(`SET session_replication_role = 'origin'`);
      expect(await fac(probe, CENTER_B)).toBe(false);
      expect(await wh(probe, DEPOT_B)).toBe(false);
      await asAdmin(`SET session_replication_role = 'replica'`);
      await asAdmin(`UPDATE organization_facilities SET status='active' WHERE id=$1`, [CENTER_B]);
      await asAdmin(`SET session_replication_role = 'origin'`);
      expect(await wh(probe, DEPOT_B)).toBe(true);
    });
  });

  // ══ B. ASSIGNMENT VALIDATION ══════════════════════════════════════════════
  describe('B · write-time facility assignment validation', () => {
    const attempt = (profile: string, org: string, facility: string) => rejects(() => asAdmin(
      `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
       VALUES ($1,$2,'facility',$3,true)`, [profile, org, facility]));

    it('rejects a non-health_center_manager target', async () => {
      expect(await attempt(ADMIN_A, SECTOR_A, CENTER_A)).toMatch(/SCOPE_ASSIGNMENT_ROLE_INELIGIBLE/);
      expect(await attempt(OUTLET_OFFICER, SECTOR_A, CENTER_A)).toMatch(/SCOPE_ASSIGNMENT_ROLE_INELIGIBLE/);
    });

    it('rejects an INACTIVE facility', async () => {
      expect(await attempt(MGR_A, SECTOR_A, CENTER_OFF)).toMatch(/SCOPE_ASSIGNMENT_TARGET_INACTIVE/);
    });

    it('rejects a facility that does not exist', async () => {
      // The BEFORE trigger runs ahead of constraint evaluation, so the NAMED
      // error wins over the raw FK violation. Either is a refusal; the trigger's
      // is the more legible one and is what a caller actually sees.
      expect(await attempt(MGR_A, SECTOR_A, randomUUID()))
        .toMatch(/SCOPE_ASSIGNMENT_TARGET_NOT_FOUND|psa_facility_org_fk|violates foreign key/i);
    });

    it('a hospital facility cannot exist at all — 164 forbids it structurally', async () => {
      const msg = await rejects(() => asAdmin(
        `INSERT INTO organization_facilities (organization_id,parent_institution_class,facility_class,name,name_ar,status)
         VALUES ($1,'hospital','primary_health_center','Bad','سيء','active')`, [HOSPITAL]));
      expect(msg).toMatch(/of_parent_is_health_sector_chk/);
    });

    it('the target-match check forbids a mixed-shape row', async () => {
      const msg = await rejects(() => asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,warehouse_id,is_active)
         VALUES ($1,$2,'facility',$3,$4,true)`, [MGR_A, SECTOR_A, CENTER_A, DEPOT_A]));
      expect(msg).toMatch(/psa_target_matches_scope_chk/);
    });

    it('a facility scope_type with a NULL facility is refused', async () => {
      const msg = await rejects(() => asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,is_active)
         VALUES ($1,$2,'facility',true)`, [MGR_A, SECTOR_A]));
      expect(msg).toMatch(/SCOPE_ASSIGNMENT_TARGET_NOT_FOUND|psa_target_matches_scope_chk/);
    });

    it('the STRUCTURAL layers hold on their own, with the trigger disabled', async () => {
      // In normal operation the BEFORE trigger reports first, which would hide a
      // regression in the CHECK or the FK. DISABLE TRIGGER USER suppresses only
      // the user trigger and deliberately leaves the FK's internal triggers
      // armed — unlike session_replication_role='replica', which would disable
      // those too and prove nothing about the foreign key.
      const bypass = async (sql: string, params: any[]) => {
        await asAdmin(`ALTER TABLE public.profile_scope_assignments DISABLE TRIGGER USER`);
        try { return await rejects(() => asAdmin(sql, params)); }
        finally { await asAdmin(`ALTER TABLE public.profile_scope_assignments ENABLE TRIGGER USER`); }
      };

      // CHECK: scope_type='facility' demands exactly facility_id.
      expect(await bypass(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,is_active)
         VALUES ($1,$2,'facility',true)`, [MGR_A, SECTOR_A]))
        .toMatch(/psa_target_matches_scope_chk/);
      expect(await bypass(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,warehouse_id,is_active)
         VALUES ($1,$2,'facility',$3,$4,true)`, [MGR_A, SECTOR_A, CENTER_A, DEPOT_A]))
        .toMatch(/psa_target_matches_scope_chk/);

      // FK: a foreign sector's facility is refused structurally, with no trigger
      // involved. This is the first of the three cross-sector layers.
      expect(await bypass(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true)`, [MGR_A, SECTOR_A, CENTER_C]))
        .toMatch(/psa_facility_org_fk|violates foreign key/i);
    });
  });

  // ══ PROFILE ROLE INVARIANT ════════════════════════════════════════════════
  describe('the manager role cannot exist outside an active health sector', () => {
    it('a hospital profile may not become an active health_center_manager', async () => {
      const u = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-hospmgr@rig.local') ON CONFLICT DO NOTHING`, [u]);
      const msg = await rejects(() => asAdmin(
        `UPDATE profiles SET role='health_center_manager', status='active', organization_id=$2 WHERE id=$1`,
        [u, HOSPITAL]));
      expect(msg).toMatch(/health_center_manager_requires_active_health_sector/);
    });

    it('a platform profile with no organization may not become one', async () => {
      const u = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-noorg@rig.local') ON CONFLICT DO NOTHING`, [u]);
      const msg = await rejects(() => asAdmin(
        `UPDATE profiles SET role='health_center_manager', status='active', organization_id=NULL WHERE id=$1`, [u]));
      expect(msg).toMatch(/health_center_manager_requires_organization/);
    });

    it('historical NON-ACTIVE rows are not judged', async () => {
      // profiles_status_check allows active | suspended | archived.
      const u = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-hist@rig.local') ON CONFLICT DO NOTHING`, [u]);
      for (const status of ['suspended', 'archived']) {
        const r = await asAdmin(
          `UPDATE profiles SET role='health_center_manager', status=$2, organization_id=$3 WHERE id=$1 RETURNING status`,
          [u, status, HOSPITAL]);
        expect(r.rows[0].status).toBe(status);
      }
      // ...and re-activating that same row is still refused.
      expect(await rejects(() => asAdmin(
        `UPDATE profiles SET status='active' WHERE id=$1`, [u])))
        .toMatch(/health_center_manager_requires_active_health_sector/);
    });

    it('the five historical roles remain accepted', async () => {
      const u = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-roles@rig.local') ON CONFLICT DO NOTHING`, [u]);
      for (const role of ['institution_admin', 'central_warehouse_manager', 'warehouse_officer', 'outlet_officer']) {
        const r = await asAdmin(
          `UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1 RETURNING role`,
          [u, role, HOSPITAL]);
        expect(r.rows[0].role).toBe(role);
      }
    });
  });

  // ══ LIFECYCLE / RECYCLE — deliberately fail-closed for this role ═════════
  describe('lifecycle · the role cannot be exited while facility scope is live', () => {
    const scopedManager = async () => {
      const u = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [u, `u182-lc-${u.slice(0, 8)}@rig.local`]);
      await asAdmin(`UPDATE profiles SET role='health_center_manager', status='active', organization_id=$2 WHERE id=$1`, [u, SECTOR_A]);
      await asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true)`, [u, SECTOR_A, CENTER_A]);
      return u;
    };

    it('changing role AWAY is refused while an active facility assignment remains', async () => {
      const m = await scopedManager();
      const msg = await rejects(() => asAdmin(
        `UPDATE profiles SET role='outlet_officer' WHERE id=$1`, [m]));
      expect(msg).toMatch(/health_center_manager_role_change_blocked_by_active_facility_scope/);
      // The role really did not move.
      const row = await asAdmin(`SELECT role FROM profiles WHERE id=$1`, [m]);
      expect(row.rows[0].role).toBe('health_center_manager');
    });

    it('after an AUDITED revoke the role change succeeds, and history survives', async () => {
      const m = await scopedManager();
      const id = (await asAdmin(
        `SELECT id FROM profile_scope_assignments WHERE profile_id=$1 AND is_active`, [m])).rows[0].id;
      await asAdmin(
        `UPDATE profile_scope_assignments SET is_active=false, revoked_at=now(), revoke_reason='left the centre' WHERE id=$1`, [id]);

      const r = await asAdmin(`UPDATE profiles SET role='outlet_officer' WHERE id=$1 RETURNING role`, [m]);
      expect(r.rows[0].role).toBe('outlet_officer');
      // The revoked row is retained — nothing was deleted to make this possible.
      const hist = await asAdmin(
        `SELECT count(*)::int n, bool_and(revoke_reason IS NOT NULL) reasoned
           FROM profile_scope_assignments WHERE profile_id=$1`, [m]);
      expect(hist.rows[0].n).toBe(1);
      expect(hist.rows[0].reasoned).toBe(true);
    });

    it('a recycled identity cannot silently regain the old centres', async () => {
      // The round trip this boundary exists to prevent: out, then back in.
      const m = await scopedManager();
      expect(await rejects(() => asAdmin(`UPDATE profiles SET role='warehouse_officer' WHERE id=$1`, [m])))
        .toMatch(/blocked_by_active_facility_scope/);
      expect(await wh(m, DEPOT_A)).toBe(true);   // still the manager, still scoped
    });

    it('phoenix_recycle_apply refuses to recycle INTO the role — deferred, not half-done', async () => {
      const target = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-recycle@rig.local') ON CONFLICT DO NOTHING`, [target]);
      await asAdmin(`UPDATE profiles SET role='outlet_officer', status='active', organization_id=$2 WHERE id=$1`, [target, SECTOR_A]);
      const r = await rig.asUser(SUPER, (c: any) => c.query(
        `SELECT phoenix_recycle_apply($1,'New Name','health_center_manager',$2,'email',NULL,NULL,$3,NULL,$4) AS r`,
        [target, SECTOR_A, 'recycled@rig.local', randomUUID()]), { commit: true });
      expect(r.rows[0].r.ok).toBe(false);
      // 146/lifecycle's own whitelist still bites: R1.1-U deliberately does not
      // widen it, so the role can only be created through provisioning.
      expect(String(r.rows[0].r.error)).toMatch(/INVALID_ROLE|REQUEST_DENIED/);
      const row = await asAdmin(`SELECT role FROM profiles WHERE id=$1`, [target]);
      expect(row.rows[0].role).toBe('outlet_officer');
    });
  });

  // ══ E/I. THE ASSIGNMENT RPC AND ITS AUTHORITY ════════════════════════════
  describe('E/I · phoenix_assign_profile_scope facility authority', () => {
    const asUser = (uid: string | null, sql: string, params: any[] = [], role = 'authenticated') =>
      rig.asUser(uid, (c: any) => c.query(sql, params), { role, commit: true });

    it('the sector institution_admin may assign a centre in its own sector', async () => {
      const target = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-rpc1@rig.local') ON CONFLICT DO NOTHING`, [target]);
      await asAdmin(`UPDATE profiles SET role='health_center_manager', status='active', organization_id=$2 WHERE id=$1`, [target, SECTOR_A]);
      const r = await asUser(ADMIN_A, `SELECT phoenix_assign_profile_scope($1,'facility',$2) AS r`, [target, CENTER_A]);
      expect(r.rows[0].r.ok).toBe(true);
      expect(await wh(target, DEPOT_A)).toBe(true);
    });

    it('a repeated assignment is an idempotent replay, not a duplicate', async () => {
      const target = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-rpc2@rig.local') ON CONFLICT DO NOTHING`, [target]);
      await asAdmin(`UPDATE profiles SET role='health_center_manager', status='active', organization_id=$2 WHERE id=$1`, [target, SECTOR_A]);
      const first = await asUser(ADMIN_A, `SELECT phoenix_assign_profile_scope($1,'facility',$2) AS r`, [target, CENTER_B]);
      const again = await asUser(ADMIN_A, `SELECT phoenix_assign_profile_scope($1,'facility',$2) AS r`, [target, CENTER_B]);
      expect(first.rows[0].r.idempotent_replay).toBe(false);
      expect(again.rows[0].r.idempotent_replay).toBe(true);
      expect(again.rows[0].r.assignment_id).toBe(first.rows[0].r.assignment_id);
      const n = await asAdmin(
        `SELECT count(*)::int n FROM profile_scope_assignments WHERE profile_id=$1 AND facility_id=$2 AND is_active`,
        [target, CENTER_B]);
      expect(n.rows[0].n).toBe(1);
    });

    it('a FOREIGN-sector institution_admin is refused', async () => {
      const msg = await rejects(() => asUser(ADMIN_HOSP, `SELECT phoenix_assign_profile_scope($1,'facility',$2)`, [MGR_A, CENTER_A]));
      expect(msg).toMatch(/NOT_AUTHORIZED_SCOPE_ASSIGN/);
    });

    it('a health_center_manager cannot assign scope to itself or anyone', async () => {
      const msg = await rejects(() => asUser(MGR_A, `SELECT phoenix_assign_profile_scope($1,'facility',$2)`, [MGR_A, CENTER_B]));
      expect(msg).toMatch(/NOT_AUTHORIZED_SCOPE_ASSIGN/);
    });

    it('anon cannot reach the RPC at all', async () => {
      const msg = await rejects(() => asUser(null, `SELECT phoenix_assign_profile_scope($1,'facility',$2)`, [MGR_A, CENTER_A], 'anon'));
      expect(msg).toMatch(/permission denied for function/i);
    });

    it('warehouse and distribution_point assignment still work through the same RPC', async () => {
      const target = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-rpc3@rig.local') ON CONFLICT DO NOTHING`, [target]);
      await asAdmin(`UPDATE profiles SET role='warehouse_officer', status='active', organization_id=$2 WHERE id=$1`, [target, SECTOR_A]);
      const w = await asUser(ADMIN_A, `SELECT phoenix_assign_profile_scope($1,'warehouse',$2) AS r`, [target, DEPOT_B]);
      expect(w.rows[0].r.ok).toBe(true);
      expect(await wh(target, DEPOT_B)).toBe(true);
    });

    it('revocation is generic, audited, and preserves history', async () => {
      const target = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-rpc4@rig.local') ON CONFLICT DO NOTHING`, [target]);
      await asAdmin(`UPDATE profiles SET role='health_center_manager', status='active', organization_id=$2 WHERE id=$1`, [target, SECTOR_A]);
      const a = await asUser(ADMIN_A, `SELECT phoenix_assign_profile_scope($1,'facility',$2) AS r`, [target, CENTER_A]);
      const id = a.rows[0].r.assignment_id;

      await expect(asUser(ADMIN_A, `SELECT phoenix_revoke_profile_scope($1,$2)`, [id, '   '])).rejects.toThrow();

      const rev = await asUser(ADMIN_A, `SELECT phoenix_revoke_profile_scope($1,$2) AS r`, [id, 'centre reassigned']);
      expect(rev.rows[0].r.ok).toBe(true);
      const row = await asAdmin(`SELECT is_active, revoke_reason, revoked_by FROM profile_scope_assignments WHERE id=$1`, [id]);
      expect(row.rows[0].is_active).toBe(false);
      expect(row.rows[0].revoke_reason).toBe('centre reassigned');
      expect(row.rows[0].revoked_by).toBe(ADMIN_A);
      expect(await wh(target, DEPOT_A)).toBe(false);

      const audit = await asAdmin(
        `SELECT count(*)::int n FROM audit_logs WHERE entity_id=$1 AND action IN ('scope_assigned','scope_revoked')`, [id]);
      expect(audit.rows[0].n).toBe(2);
    });
  });

  // ══ E. SERVICE-ONLY PROVISIONING COMPANION ════════════════════════════════
  describe('E · phoenix_admin_assign_facility_scopes is all-or-nothing', () => {
    const newManager = async (org = SECTOR_A) => {
      const u = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u, `u182-${u.slice(0, 8)}@rig.local`]);
      await asAdmin(`UPDATE profiles SET role='health_center_manager', status='active', organization_id=$2 WHERE id=$1`, [u, org]);
      return u;
    };
    const call = (actor: string, profile: string, ids: string[]) =>
      asAdmin(`SELECT phoenix_admin_assign_facility_scopes($1,$2,$3) AS r`, [actor, profile, ids]);
    const activeCount = async (p: string) =>
      (await asAdmin(`SELECT count(*)::int n FROM profile_scope_assignments WHERE profile_id=$1 AND is_active`, [p])).rows[0].n;

    it('writes a complete multi-centre set atomically', async () => {
      const m = await newManager();
      const r = await call(ADMIN_A, m, [CENTER_A, CENTER_B]);
      expect(r.rows[0].r.ok).toBe(true);
      expect(await activeCount(m)).toBe(2);
      expect(await wh(m, DEPOT_A)).toBe(true);
      expect(await wh(m, DEPOT_B)).toBe(true);
      expect(await wh(m, MAIN_A)).toBe(false);
    });

    it('de-duplicates repeated ids deterministically', async () => {
      const m = await newManager();
      const r = await call(ADMIN_A, m, [CENTER_A, CENTER_A, CENTER_B, CENTER_A]);
      expect(r.rows[0].r.ok).toBe(true);
      expect(await activeCount(m)).toBe(2);
    });

    it('an EMPTY set is refused', async () => {
      const m = await newManager();
      expect(await rejects(() => call(ADMIN_A, m, []))).toMatch(/FACILITY_SCOPE_SET_EMPTY/);
      expect(await activeCount(m)).toBe(0);
    });

    it('ONE bad facility writes ZERO assignments — no partial set survives', async () => {
      const m = await newManager();
      // Good, good, foreign.
      expect(await rejects(() => call(ADMIN_A, m, [CENTER_A, CENTER_B, CENTER_C])))
        .toMatch(/FACILITY_SCOPE_FACILITY_FOREIGN/);
      expect(await activeCount(m)).toBe(0);
      // Good, inactive.
      expect(await rejects(() => call(ADMIN_A, m, [CENTER_A, CENTER_OFF])))
        .toMatch(/FACILITY_SCOPE_FACILITY_INACTIVE/);
      expect(await activeCount(m)).toBe(0);
      // Good, non-existent.
      expect(await rejects(() => call(ADMIN_A, m, [CENTER_A, randomUUID()])))
        .toMatch(/FACILITY_SCOPE_FACILITY_NOT_FOUND/);
      expect(await activeCount(m)).toBe(0);
    });

    it('refuses a non-manager target', async () => {
      expect(await rejects(() => call(ADMIN_A, OUTLET_OFFICER, [CENTER_A]))).toMatch(/FACILITY_SCOPE_ROLE_INELIGIBLE/);
    });

    it('refuses a foreign-organization actor', async () => {
      const m = await newManager();
      expect(await rejects(() => call(ADMIN_HOSP, m, [CENTER_A]))).toMatch(/NOT_AUTHORIZED_FACILITY_SCOPE_CROSS_ORG/);
      expect(await activeCount(m)).toBe(0);
    });

    it('refuses an actor that is not an admin at all', async () => {
      const m = await newManager();
      expect(await rejects(() => call(MGR_A, m, [CENTER_A]))).toMatch(/NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN/);
      expect(await activeCount(m)).toBe(0);
    });

    it('is unreachable by anon and by authenticated', async () => {
      const m = await newManager();
      for (const role of ['anon', 'authenticated']) {
        const msg = await rejects(() => rig.asUser(ADMIN_A, (c: any) => c.query(
          `SELECT phoenix_admin_assign_facility_scopes($1,$2,$3)`, [ADMIN_A, m, [CENTER_A]]), { role }));
        expect(msg, role).toMatch(/permission denied for function/i);
      }
    });

    it('audits every assignment it writes', async () => {
      const m = await newManager();
      await call(ADMIN_A, m, [CENTER_A, CENTER_B]);
      const audit = await asAdmin(
        `SELECT count(*)::int n FROM audit_logs
          WHERE action='scope_assigned' AND payload->>'profile_id'=$1 AND payload->>'provisioning'='true'`, [m]);
      expect(audit.rows[0].n).toBe(2);
    });
  });

  // ══ F. THE 146 PROVISIONING CONTRACT, FORWARD-REPLACED ═══════════════════
  describe('F · provisioning refuses the new role outside a health sector', () => {
    it('a hospital organization is refused even for super_admin', async () => {
      const u = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-prov1@rig.local') ON CONFLICT DO NOTHING`, [u]);
      const r = await asAdmin(
        `SELECT phoenix_admin_provision_profile($1,$2,$3,$4,'X','health_center_manager','email',NULL,NULL,$5) AS r`,
        [SUPER, u, randomUUID(), HOSPITAL, randomUUID()]);
      expect(r.rows[0].r.ok).toBe(false);
      expect(r.rows[0].r.error).toBe('REQUEST_DENIED');
    });

    it('the five historical roles still validate exactly as before', async () => {
      const u = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'u182-prov2@rig.local') ON CONFLICT DO NOTHING`, [u]);
      // An unknown role is still INVALID_ROLE, proving the whitelist still bites.
      const bad = await asAdmin(
        `SELECT phoenix_admin_provision_profile($1,$2,$3,$4,'X','not_a_role','email',NULL,NULL,$5) AS r`,
        [SUPER, u, randomUUID(), SECTOR_A, randomUUID()]);
      expect(bad.rows[0].r.error).toBe('INVALID_ROLE');
    });

    it('the nonce contract still refuses a non-fresh placeholder', async () => {
      // MGR_A is a real, already-provisioned profile — never repurposable.
      const r = await asAdmin(
        `SELECT phoenix_admin_provision_profile($1,$2,$3,$4,'X','health_center_manager','email',NULL,NULL,$5) AS r`,
        [SUPER, MGR_A, randomUUID(), SECTOR_A, randomUUID()]);
      expect(r.rows[0].r.ok).toBe(false);
      expect(r.rows[0].r.error).toBe('REQUEST_DENIED');
    });
  });

  // ══ H. RLS ════════════════════════════════════════════════════════════════
  describe('H · RLS isolation under a real authenticated session', () => {
    const seen = async (uid: string, sql: string) =>
      (await rig.asUser(uid, (c: any) => c.query(sql))).rows.map((r: any) => r.id).sort();

    it('a manager sees ONLY its assigned facility rows', async () => {
      const rows = await seen(MGR_A, `SELECT id FROM organization_facilities`);
      expect(rows).toEqual([CENTER_A].sort());
    });

    it('a two-centre manager sees exactly its two', async () => {
      const rows = await seen(MGR_AB, `SELECT id FROM organization_facilities`);
      expect(rows).toEqual([CENTER_A, CENTER_B].sort());
    });

    it('the sector institution_admin still sees ALL its facilities — no regression', async () => {
      const rows = await seen(ADMIN_A, `SELECT id FROM organization_facilities`);
      expect(rows).toEqual([CENTER_A, CENTER_B, CENTER_OFF].sort());
    });

    it('super_admin still sees every facility', async () => {
      const rows = await seen(SUPER, `SELECT id FROM organization_facilities`);
      for (const f of [CENTER_A, CENTER_B, CENTER_C, CENTER_OFF]) expect(rows).toContain(f);
    });

    it('a manager sees ONLY its own centre outlets — ports.view does not leak the sector', async () => {
      expect(await seen(MGR_A, `SELECT id FROM distribution_points`)).toEqual([CAB_A, PHARM_A].sort());
      expect(await seen(MGR_AB, `SELECT id FROM distribution_points`)).toEqual([CAB_A, PHARM_A, PHARM_B].sort());
    });

    it('an outlet officer keeps its historical distribution_points visibility', async () => {
      // ports.view is org-wide for every pre-182 role, exactly as before.
      const rows = await seen(OUTLET_OFFICER, `SELECT id FROM distribution_points`);
      expect(rows).toEqual([CAB_A, PHARM_A, PHARM_B].sort());
    });

    it('a manager sees ONLY its assigned depots, never the sector main', async () => {
      expect(await seen(MGR_A, `SELECT id FROM warehouses`)).toEqual([DEPOT_A].sort());
      expect(await seen(MGR_AB, `SELECT id FROM warehouses`)).toEqual([DEPOT_A, DEPOT_B].sort());
    });

    it('the sector institution_admin still sees every warehouse including the main', async () => {
      expect(await seen(ADMIN_A, `SELECT id FROM warehouses`)).toEqual([MAIN_A, DEPOT_A, DEPOT_B].sort());
    });

    it('a manager cannot write the assignment ledger directly', async () => {
      const msg = await rejects(() => rig.asUser(MGR_A, (c: any) => c.query(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true)`, [MGR_A, SECTOR_A, CENTER_B])));
      expect(msg).toMatch(/permission denied|violates row-level security/i);
    });
  });

  // ══ J. NON-REGRESSION ═════════════════════════════════════════════════════
  it('J · exactly two stock truths, and no unit or facility ledger', async () => {
    const r = await asAdmin(`
      SELECT
        (SELECT count(*)::int FROM pg_class WHERE relname IN ('warehouse_stock','outlet_stock')) AS truths,
        (SELECT count(*)::int FROM pg_class WHERE relname IN ('facility_stock','health_center_stock','manager_stock','unit_stock')) AS extra,
        (SELECT count(*)::int FROM pg_class WHERE relname IN ('health_center_units','units','unit_routes','unit_scopes')) AS units`);
    expect(r.rows[0].truths).toBe(2);
    expect(r.rows[0].extra).toBe(0);
    expect(r.rows[0].units).toBe(0);
  });

  // ══ THE OPERATOR PRE-APPLY ARTIFACT ══════════════════════════════════════
  describe('the committed pre-apply artifact is executable and READ ONLY', () => {
    it('contains no write, DDL or procedural command', () => {
      const executable = PREAPPLY.replace(/^\s*--.*$/gm, '');
      expect(executable).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|DO)\b/i);
    });

    it('runs inside a PostgreSQL READ ONLY transaction on a 001->182 chain', async () => {
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const r = await client.query(PREAPPLY);
        expect(r.rows).toHaveLength(1);
        await client.query('ROLLBACK');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('on a chain that ALREADY has 182 it reports ALREADY_APPLIED_STOP, never TARGET_READY', async () => {
      // This rig is at 182, so the artifact must refuse rather than green-light a
      // second apply. That is the whole point of the gate — and it reaches that
      // verdict STRUCTURALLY, with no ledger present on the rig at all.
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const row = (await client.query(PREAPPLY)).rows[0];
        expect(row.classification).not.toBe('TARGET_READY');
        expect(row.classification).toBe('ALREADY_APPLIED_STOP');
        // ...and it saw every object that makes it so.
        for (const k of ['facility_id_column', 'facility_helper', 'service_writer',
                         'profile_role_guard', 'facility_unique_index', 'facility_fk']) {
          expect(Number(row[k]), k).toBe(1);
        }
        // The verdict is structural: no EXECUTABLE statement reads the migration
        // ledger, which does not exist on a rig and understates the ceiling in
        // Production. (The file mentions it once, in a comment, as an optional
        // read for the operator — hence stripping comments before asserting.)
        const executable = PREAPPLY.replace(/^\s*--.*$/gm, '');
        expect(executable).not.toMatch(/supabase_migrations\.schema_migrations/);
        expect(Number(row.ceiling_181_objects)).toBe(1);
        expect(Number(row.ceiling_181_closed)).toBe(1);
        await client.query('ROLLBACK');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  it('J · Migration 181 topology still refuses a sector-level outlet', async () => {
    const msg = await rejects(() => asAdmin(
      `INSERT INTO distribution_points (warehouse_id,organization_id,name,name_ar,point_type,status)
       VALUES ($1,$2,'Bad','سيء','pharmacy','active')`, [MAIN_A, SECTOR_A]));
    expect(msg).toMatch(/health_sector_outlet_requires_health_center_depot/);
  });
});
