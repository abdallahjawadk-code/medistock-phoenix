/**
 * R1.1-U / U-B CORRECTIVE CLOSURE — the surfaces an independent U-C audit found
 * after the first safe-activation pass.
 *
 * The sibling suites prove the helpers answer correctly (182 dynamic) and that
 * the stock read surfaces obey them (confidentiality dynamic). This one proves
 * the THIRD class: surfaces that sit beside an already-closed read model and
 * were missed because the earlier passes enumerated by permission key and by
 * policy, never by FUNCTION FAMILY.
 *
 * The canonical example, measured before the correction, for a manager assigned
 * only to centre A while both notifications belonged to centre B / the sector
 * main:
 *
 *   direct SELECT phoenix_notifications   -> 0   (correct)
 *   phoenix_notifications_list()          -> 0   (correct)
 *   phoenix_notifications_unread_count()  -> 2   <-- the whole sector
 *   phoenix_notifications_mark_all_read() -> {"ok": true, "marked": 2}
 *
 * Every assertion runs under a REAL authenticated session (SET LOCAL ROLE
 * authenticated + the JWT sub GUC), so RLS is genuinely enforced rather than
 * bypassed by the suite's own superuser connection, and an institution_admin
 * control runs beside every manager to prove no historical role moved.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000 });
const run = rigAvailable() ? describe : describe.skip;

const SEC_A = randomUUID(), SEC_B = randomUUID();
const FAC_A = randomUUID(), FAC_B = randomUUID(), FAC_C = randomUUID();
const MAIN_A = randomUUID(), DEP_A = randomUUID(), DEP_B = randomUUID();
const MAIN_B = randomUUID(), DEP_C = randomUUID();
const PH_A = randomUUID(), PH_B = randomUUID(), PH_C = randomUUID();
const MGR_A = randomUUID(), MGR_B = randomUUID(), MGR_AB = randomUUID();
const MGR_SEC_B = randomUUID(), ADMIN_A = randomUUID(), OFF_B = randomUUID();
const CI = randomUUID(), ISR = randomUUID(), BROADCAST = randomUUID();
const SUPER_U = randomUUID();
const SUPER = '00000000-0000-0000-0000-0000000000a1';

run('182 U-B corrective · closure of the surfaces U-C found', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const asAdmin = (sql: string, p: unknown[] = []) => rig.asAdmin((c: any) => c.query(sql, p));
  const asUser = (uid: string, sql: string, commit = false) =>
    rig.asUser(uid, (c: any) => c.query(sql), { commit });
  /** First column of every row, sorted — the shape most assertions need. */
  const seen = async (uid: string, sql: string): Promise<string[]> =>
    (await asUser(uid, sql)).rows.map((r: any) => String(Object.values(r)[0])).sort();
  const one = async (uid: string, sql: string): Promise<string> =>
    String(Object.values((await asUser(uid, sql)).rows[0])[0]);
  /** The raised message, or NO_ERROR — C8 asserts on refusal text, not rows. */
  const fails = async (uid: string, sql: string): Promise<string> => {
    try { await asUser(uid, sql); return 'NO_ERROR'; } catch (e: any) { return String(e.message); }
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${SEC_A}','Sector A','قأ','uc-c-a','care_institution','health_sector','active'),
        ('${SEC_B}','Sector B','قب','uc-c-b','care_institution','health_sector','active');
      INSERT INTO organization_facilities (id,organization_id,parent_institution_class,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${SEC_A}','health_sector','primary_health_center','Centre A','أ','active'),
        ('${FAC_B}','${SEC_A}','health_sector','primary_health_center','Centre B','ب','active'),
        ('${FAC_C}','${SEC_B}','health_sector','primary_health_center','Centre C','ج','active');
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${MAIN_A}','${SEC_A}','MAIN_A','ر','institution',NULL,true,'active'),
        ('${DEP_A}','${SEC_A}','DEP_A','دأ','institution','${FAC_A}',false,'active'),
        ('${DEP_B}','${SEC_A}','DEP_B','دب','institution','${FAC_B}',false,'active'),
        ('${MAIN_B}','${SEC_B}','MAIN_B','رب','institution',NULL,true,'active'),
        ('${DEP_C}','${SEC_B}','DEP_C','دج','institution','${FAC_C}',false,'active');
      INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
        ('${PH_A}','${DEP_A}','${SEC_A}','PH_A','صأ','pharmacy','active'),
        ('${PH_B}','${DEP_B}','${SEC_A}','PH_B','صب','pharmacy','active'),
        ('${PH_C}','${DEP_C}','${SEC_B}','PH_C','صج','pharmacy','active');

      INSERT INTO auth.users (id,email) VALUES
        ('${MGR_A}','c-mgr-a@rig.local'),('${MGR_B}','c-mgr-b@rig.local'),
        ('${MGR_AB}','c-mgr-ab@rig.local'),('${MGR_SEC_B}','c-mgr-secb@rig.local'),
        ('${ADMIN_A}','c-admin-a@rig.local'),('${OFF_B}','c-off-b@rig.local')
        ON CONFLICT DO NOTHING;
      UPDATE profiles SET role='health_center_manager', status='active', organization_id='${SEC_A}',
        full_name='MANAGER' WHERE id IN ('${MGR_A}','${MGR_B}','${MGR_AB}');
      UPDATE profiles SET role='health_center_manager', status='active', organization_id='${SEC_B}',
        full_name='MANAGER_SECTOR_B' WHERE id='${MGR_SEC_B}';
      UPDATE profiles SET role='institution_admin', status='active', organization_id='${SEC_A}',
        full_name='ADMIN_A_SECRET' WHERE id='${ADMIN_A}';
      UPDATE profiles SET role='outlet_officer', status='active', organization_id='${SEC_A}',
        full_name='OFFICER_OF_CENTRE_B' WHERE id='${OFF_B}';
      INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active) VALUES
        ('${MGR_A}','${SEC_A}','facility','${FAC_A}',true),
        ('${MGR_B}','${SEC_A}','facility','${FAC_B}',true),
        ('${MGR_AB}','${SEC_A}','facility','${FAC_A}',true),
        ('${MGR_AB}','${SEC_A}','facility','${FAC_B}',true),
        ('${MGR_SEC_B}','${SEC_B}','facility','${FAC_C}',true);
      INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,distribution_point_id,is_active)
        VALUES ('${OFF_B}','${SEC_A}','distribution_point','${PH_B}',true);

      -- Custody notifications that belong to centre B and the sector main only.
      INSERT INTO phoenix_notifications
        (organization_id,event_type,occurred_at,actor_role,status_after,reference_type,reference_label) VALUES
        ('${SEC_A}','dispatch_sent',now(),'warehouse_officer','sent','warehouse_dispatch','CENTRE-B-DOC'),
        ('${SEC_A}','dispatch_sent',now(),'warehouse_officer','sent','warehouse_dispatch','SECTOR-MAIN-DOC');

      -- An override naming CENTRE B's outlet: the measured metadata leak.
      INSERT INTO profile_permission_overrides
        (profile_id,permission_key,allowed,scope_organization_id,scope_point_id)
        VALUES ('${OFF_B}','outlet_stock.view',true,'${SEC_A}','${PH_B}');

      INSERT INTO central_items (id,name,name_ar,unit,status)
        VALUES ('${CI}','CItem','ص','box','active') ON CONFLICT DO NOTHING;
      INSERT INTO phoenix_paper_references
        (organization_id,document_type,document_id,paper_reference_number,paper_reference_date,created_by)
        VALUES ('${SEC_A}','warehouse_dispatch','${randomUUID()}','PAPER-SECRET-1',current_date,'${SUPER}');

      INSERT INTO inventory_status_reports (id,organization_id,status,version,prepared_by,prepared_at)
        VALUES ('${ISR}','${SEC_A}','draft',1,'${SUPER}',now());
      INSERT INTO inventory_status_report_lines
        (report_id,scientific_name,on_hand_qty,suggested_classification,classification)
        VALUES ('${ISR}','SECTOR_WIDE_MATERIAL',9999,'available','available');

      -- C8: the exact measured leak, preserved as a fixture. DrugShared sits in
      -- BOTH centres' outlets, so it survives the RPC's inner join against the
      -- caller's own outlet_stock. Centre A's own batch expires 2030-01-01;
      -- Centre B's expires 2027-03-03, and the SECTOR line therefore carries
      -- 2027-03-03 and a sector classification. 2027-03-03 is the witness value:
      -- Manager A can only learn it by reading across the facility boundary.
      INSERT INTO outlet_stock
        (organization_id,distribution_point_id,point_type,scientific_name,on_hand_quantity,
         unit,batch_number,expiry_date,has_no_national_code,national_code) VALUES
        ('${SEC_A}','${PH_A}','pharmacy','DrugShared',10,'box','BA','2030-01-01',false,'NC-S'),
        ('${SEC_A}','${PH_B}','pharmacy','DrugShared',20,'box','BB','2027-03-03',false,'NC-S');
      INSERT INTO inventory_status_report_lines
        (report_id,scientific_name,national_code,on_hand_qty,
         suggested_classification,classification,nearest_expiry_date)
        VALUES ('${ISR}','DrugShared','NC-S',30,'available','scarce','2027-03-03');

      INSERT INTO item_availability
        (organization_id,distribution_point_id,scientific_name,port_name,condition,quantity,source_kind) VALUES
        ('${SEC_A}','${PH_A}','DrugA','PhA','available',5,'manual'),
        ('${SEC_A}','${PH_B}','DrugB','PhB','available',7,'manual');

      -- C9: an approved correction on MANAGER A's OWN outlet, decided by the
      -- sector administrator. 098 forbids proposer = decider, so decided_by is
      -- ALWAYS a foreign profile — this is how the manager comes by a uuid it
      -- was never shown directly. Kept as a fixture to document WHY hiding the
      -- uuid is not the fix (C9.7): authorization must hold regardless.
      INSERT INTO phoenix_stock_correction_requests
        (organization_id,outlet_stock_id,on_hand_before,counted_quantity,variance,
         reason,status,proposed_by,underlying_request_id,decided_by,decided_at)
        SELECT '${SEC_A}', os.id, 10, 8, -2, 'count', 'approved', '${OFF_B}',
               '${randomUUID()}', '${ADMIN_A}', now()
        FROM outlet_stock os WHERE os.distribution_point_id = '${PH_A}' LIMIT 1;

      INSERT INTO auth.users (id,email) VALUES ('${SUPER_U}','c-super@rig.local') ON CONFLICT DO NOTHING;
      UPDATE profiles SET role='super_admin', status='active', organization_id='${SEC_A}',
        full_name='SUPER' WHERE id='${SUPER_U}';

      INSERT INTO platform_broadcast_messages (id,title,body,severity,target_scope,created_by)
        VALUES ('${BROADCAST}','T','B','info','all','${SUPER}');
      -- One acknowledgement per organization (platform_broadcast_acknowledgements_unique),
      -- recorded by the sector administrator — not by the manager.
      INSERT INTO platform_broadcast_acknowledgements (message_id,organization_id,acknowledged_by)
        VALUES ('${BROADCAST}','${SEC_A}','${ADMIN_A}');
    `);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ══ C1 — the notification family, closed by predicate ══════════════════════
  describe('C1 · notifications: the badge and the writers obey the row denial', () => {
    it('the row denial itself still holds (the part that was already correct)', async () => {
      expect(await one(MGR_A, 'SELECT count(*)::text FROM phoenix_notifications')).toBe('0');
      expect(await one(MGR_A,
        `SELECT jsonb_array_length((phoenix_notifications_list()->'notifications'))::text`)).toBe('0');
    });

    it('unread_count no longer reports the whole sector (was 2)', async () => {
      expect(await one(MGR_A, 'SELECT (phoenix_notifications_unread_count())::text')).toBe('0');
      expect(await one(MGR_AB, 'SELECT (phoenix_notifications_unread_count())::text')).toBe('0');
      expect(await one(MGR_SEC_B, 'SELECT (phoenix_notifications_unread_count())::text')).toBe('0');
    });

    it('institution_admin keeps its historical organization-wide count', async () => {
      // Asserted RELATIVE to what the control can actually see, so an unrelated
      // custody trigger adding a row cannot make this test lie in either
      // direction: the contract is "counts exactly its visible unread rows".
      const visible = await one(ADMIN_A, 'SELECT count(*)::text FROM phoenix_notifications');
      expect(Number(visible)).toBeGreaterThanOrEqual(2);
      expect(await one(ADMIN_A, 'SELECT (phoenix_notifications_unread_count())::text'))
        .toBe(visible);
    });

    it('mark_all_read cannot write a read-receipt against a denied row (was marked:2)', async () => {
      // Committed, so the write is real rather than rolled back underneath us.
      expect(await one(MGR_A,
        `SELECT ((phoenix_notifications_mark_all_read())->>'marked')`)).toBe('0');
      await asUser(MGR_A, 'SELECT phoenix_notifications_mark_all_read()', true);
      // Read back as superuser: `authenticated` holds no direct grant on the
      // receipts table at all, which is itself part of the contract.
      expect((await asAdmin(
        `SELECT count(*)::text AS n FROM phoenix_notification_reads WHERE profile_id='${MGR_A}'`
      )).rows[0].n).toBe('0');
    });

    it('mark_read on a specific foreign notification is a silent no-op', async () => {
      const id = (await asAdmin('SELECT id FROM phoenix_notifications LIMIT 1')).rows[0].id;
      await asUser(MGR_A, `SELECT phoenix_notifications_mark_read('${id}')`, true);
      expect((await asAdmin(
        `SELECT count(*)::text n FROM phoenix_notification_reads WHERE profile_id='${MGR_A}'`
      )).rows[0].n).toBe('0');
    });

    it('institution_admin mark_all_read still marks its organization', async () => {
      const unread = await one(ADMIN_A, 'SELECT (phoenix_notifications_unread_count())::text');
      expect(Number(unread)).toBeGreaterThanOrEqual(2);
      expect(await one(ADMIN_A,
        `SELECT ((phoenix_notifications_mark_all_read())->>'marked')`)).toBe(unread);
    });
  });

  // ══ C3 — administrative suspension is not self-reversible ══════════════════
  //
  // M194 (H Unit 2A) NOTE — why these tests no longer drive `UPDATE profiles`
  // through an `authenticated` session.
  //
  // These cases were written against a rig that granted `authenticated`
  // table-level INSERT/UPDATE/DELETE on `profiles`. Production never did: its
  // authenticated direct-write surface is exactly distribution_points and
  // organizations (INSERT/UPDATE), and every profile mutation the product
  // performs goes through a SECURITY DEFINER RPC (assign_profile_role,
  // assign_profile_permissions, reset_profile_permissions,
  // phoenix_admin_provision_profile) which runs as the function owner. There
  // is no `.from('profiles').update(...)` anywhere in the product source.
  // Migration 194 converged the rig onto that verified Production posture, so
  // a raw authenticated UPDATE is now refused at the TABLE level — before RLS
  // or any trigger is consulted.
  //
  // The C3 invariant is NOT weakened here, it is proven twice over:
  //   * the new outer boundary — no authenticated session reaches the table at
  //     all (asserted first, below); and
  //   * the original guard — `health_center_manager_self_reactivation_forbidden`
  //     is raised by a BEFORE UPDATE TRIGGER
  //     (profiles_health_center_manager_org_guard_trg → 182's
  //     _phoenix_profile_role_organization_guard_v1). Triggers fire for the
  //     table owner too, so the guard is still exercised by running the write
  //     as the owner with `request.jwt.claim.sub` set, which is what makes
  //     auth.uid() resolve to the suspended profile. That is the ONLY way to
  //     reach the trigger now, and it does not re-grant any privilege.
  describe('C3 · suspension is an administrative state, not a self-service one', () => {
    /** Owner session carrying a JWT subject, so auth.uid() resolves and the
     *  BEFORE UPDATE trigger is genuinely evaluated. Grants nothing. */
    const asOwnerActingAs = (uid: string, sql: string, commit = false) =>
      rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid]);
          const out = await c.query(sql);
          await c.query(commit ? 'COMMIT' : 'ROLLBACK');
          return out;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
      });

    it('no authenticated session may write public.profiles at all (M194 outer boundary)', async () => {
      for (const uid of [MGR_B, SUPER, OFF_B]) {
        await expect(
          asUser(uid, `UPDATE profiles SET status='active' WHERE id='${uid}'`, false),
          `profiles must be table-denied for ${uid}`,
        ).rejects.toThrow(/permission denied for table profiles/i);
      }
    });

    it('an administratively suspended manager cannot reactivate itself', async () => {
      await asAdmin(`UPDATE profiles SET status='suspended', disabled_at=now(), disabled_by='${SUPER}'
                     WHERE id='${MGR_B}'`);
      // Reaches the trigger, and the trigger still refuses.
      await expect(
        asOwnerActingAs(MGR_B, `UPDATE profiles SET status='active' WHERE id='${MGR_B}'`, true),
      ).rejects.toThrow(/health_center_manager_self_reactivation_forbidden/);
    });

    it('suspension really is the containment control while it holds', async () => {
      expect(await seen(MGR_B, 'SELECT name FROM warehouses')).toEqual([]);
    });

    it('an authorized administrator can still reactivate the same profile', async () => {
      // A DIFFERENT auth.uid() than the row being rewritten, so the guard's
      // self-reactivation branch does not apply — 093's commit/compensate
      // contract and the authorized reactivation route stay open.
      await asOwnerActingAs(SUPER, `UPDATE profiles SET status='active', disabled_at=NULL, disabled_by=NULL
                                    WHERE id='${MGR_B}'`, true);
      expect((await asAdmin(`SELECT status FROM profiles WHERE id='${MGR_B}'`)).rows[0].status)
        .toBe('active');
      expect(await seen(MGR_B, 'SELECT name FROM warehouses')).toEqual(['DEP_B']);
    });

    it('a historical role is untouched by the guard — the trigger lets it through', async () => {
      await asAdmin(`UPDATE profiles SET status='suspended' WHERE id='${OFF_B}'`);
      // Pre-existing 002 behaviour, deliberately NOT changed by this substage:
      // the guard judges health_center_manager rows only, so the trigger raises
      // nothing here. (The table-level boundary above is what actually stops a
      // real authenticated session; this asserts the guard's own scope.)
      await expect(
        asOwnerActingAs(OFF_B, `UPDATE profiles SET status='active' WHERE id='${OFF_B}'`, true),
      ).resolves.toBeTruthy();
      await asAdmin(`UPDATE profiles SET status='active' WHERE id='${OFF_B}'`);
    });
  });

  // ══ C4 — cross-centre metadata confidentiality ═════════════════════════════
  describe('C4 · foreign-centre metadata', () => {
    it('profiles: a manager sees only itself, never the sector roster', async () => {
      expect(await seen(MGR_A,
        "SELECT full_name FROM profiles WHERE full_name IS NOT NULL")).toEqual(['MANAGER']);
    });

    it('profiles: institution_admin still sees the whole organization', async () => {
      const names = await seen(ADMIN_A, "SELECT full_name FROM profiles WHERE full_name IS NOT NULL");
      expect(names).toContain('ADMIN_A_SECRET');
      expect(names).toContain('OFFICER_OF_CENTRE_B');
    });

    it('profile_permission_overrides no longer discloses centre B outlet ids', async () => {
      expect(await seen(MGR_A, 'SELECT scope_point_id::text FROM profile_permission_overrides'))
        .toEqual([]);
      expect(await seen(ADMIN_A, 'SELECT scope_point_id::text FROM profile_permission_overrides'))
        .toEqual([PH_B]);
    });

    it('paper references are denied by table AND by RPC', async () => {
      expect(await seen(MGR_A, 'SELECT paper_reference_number FROM phoenix_paper_references'))
        .toEqual([]);
      expect(await seen(MGR_A, `SELECT paper_reference_number
                                FROM phoenix_search_paper_reference('PAPER-SECRET-1')`)).toEqual([]);
      expect(await seen(ADMIN_A, 'SELECT paper_reference_number FROM phoenix_paper_references'))
        .toEqual(['PAPER-SECRET-1']);
    });

    it('get_effective_permissions is self-only for a manager, unchanged for others', async () => {
      expect(await one(MGR_A, `SELECT (get_effective_permissions('${ADMIN_A}'))->>'error'`))
        .toBe('OUT_OF_SCOPE');
      expect(await one(MGR_A, `SELECT (get_effective_permissions('${MGR_A}'))->>'ok'`)).toBe('true');
      expect(await one(ADMIN_A, `SELECT (get_effective_permissions('${OFF_B}'))->>'ok'`)).toBe('true');
    });

    it('broadcast acknowledgements are narrowed to the caller\'s own row', async () => {
      // The sector's acknowledgement was recorded by the administrator, so the
      // manager must not learn who acknowledged on the organization's behalf.
      expect(await one(MGR_A, 'SELECT count(*)::text FROM platform_broadcast_acknowledgements'))
        .toBe('0');
      expect(await one(ADMIN_A, 'SELECT count(*)::text FROM platform_broadcast_acknowledgements'))
        .toBe('1');
    });
  });

  // ══ C5 — whole-sector aggregates ═══════════════════════════════════════════
  describe('C5 · assigned facility scope must not become a sector snapshot', () => {
    it('inventory status reports, lines and amendments are denied', async () => {
      expect(await one(MGR_A, 'SELECT count(*)::text FROM inventory_status_reports')).toBe('0');
      expect(await one(MGR_A, 'SELECT count(*)::text FROM inventory_status_report_lines')).toBe('0');
      expect(await one(MGR_A, 'SELECT count(*)::text FROM inventory_status_report_amendments')).toBe('0');
    });

    it('institution_admin keeps the monthly position it always had', async () => {
      // Both sector lines: the original fixture and C8's DrugShared witness line.
      expect(await seen(ADMIN_A, 'SELECT scientific_name FROM inventory_status_report_lines'))
        .toEqual(['DrugShared', 'SECTOR_WIDE_MATERIAL']);
    });

    it('the dashboard condition census no longer spans the sector', async () => {
      // Both centres carry availability rows; the manager must count neither.
      expect(await one(MGR_A,
        `SELECT (phoenix_get_dashboard_condition_counts())->>'available'`)).toBe('0');
      expect(await one(MGR_AB,
        `SELECT (phoenix_get_dashboard_condition_counts())->>'available'`)).toBe('0');
      expect(await one(ADMIN_A,
        `SELECT (phoenix_get_dashboard_condition_counts())->>'available'`)).toBe('2');
    });

    it('the institution condition census returns no row for a manager', async () => {
      expect(await one(MGR_A,
        'SELECT count(*)::text FROM phoenix_get_institution_condition_counts()')).toBe('0');
      expect(await one(ADMIN_A,
        'SELECT count(*)::text FROM phoenix_get_institution_condition_counts()')).toBe('1');
    });

    it('a manager holding EVERY assigned centre still never reaches the sector main', async () => {
      expect(await seen(MGR_AB, 'SELECT name FROM warehouses')).toEqual(['DEP_A', 'DEP_B']);
      expect(await seen(MGR_AB, 'SELECT name FROM distribution_points')).toEqual(['PH_A', 'PH_B']);
    });

    it('the second sector remains invisible throughout', async () => {
      expect(await seen(MGR_SEC_B, 'SELECT name FROM warehouses')).toEqual(['DEP_C']);
      expect(await seen(MGR_A, 'SELECT name FROM organization_facilities')).toEqual(['Centre A']);
    });
  });

  // ══ C7 — the EFFECTIVE policy set, not the migration text ══════════════════
  describe('C7 · no second policy reopens what was closed', () => {
    const CORRECTED = [
      'profiles', 'profile_permission_overrides', 'phoenix_paper_references',
      'platform_broadcast_acknowledgements', 'inventory_status_reports',
      'inventory_status_report_lines', 'inventory_status_report_amendments',
      'phoenix_notifications', 'phoenix_movement_events', 'item_availability',
      'distribution_points', 'warehouses', 'organization_facilities',
    ];

    it('every authenticated SELECT policy on a corrected table carries a role decision', async () => {
      const rows = (await asAdmin(`
        SELECT tablename, policyname, coalesce(qual,'') AS qual
        FROM pg_policies
        WHERE schemaname='public'
          AND tablename = ANY($1)
          AND cmd IN ('SELECT','ALL')
          AND roles::text LIKE '%authenticated%'
        ORDER BY tablename, policyname`, [CORRECTED])).rows as any[];

      // A policy is NOT a reopening when it either carries the explicit role
      // decision, delegates to a facility-aware scope helper, is gated on a
      // role that cannot exist after the 091 five-role cutover, or is
      // super_admin-only.
      const DEAD_ROLES = /hospital_admin|warehouse_manager|point_operator/;
      const SCOPE_HELPER = /has_warehouse_assignment|has_point_assignment|has_facility_assignment|has_scoped_permission|phoenix_can_read_/;
      const reopening = rows.filter(r =>
        !/health_center_manager/.test(r.qual)
        && !SCOPE_HELPER.test(r.qual)
        && !DEAD_ROLES.test(r.qual)
        && !/^\(phoenix_my_role\(\) = 'super_admin'::text\)$/.test(r.qual.trim()));

      expect(reopening.map(r => `${r.tablename}.${r.policyname}`)).toEqual([]);
    });
  });

  // ══ C8 — a safe gate over an unsafe projection ═════════════════════════════
  /**
   * The measured leak, before 9f, for Manager A assigned only to Centre A:
   *
   *   SELECT count(*) FROM inventory_status_reports       -> 0   (9e, correct)
   *   SELECT count(*) FROM inventory_status_report_lines  -> 0   (9e, correct)
   *   phoenix_status_get_outlet_contribution(report, PH_A)
   *              -> classification = 'scarce', nearest_expiry_date = 2027-03-03
   *
   * PH_A is Manager A's OWN outlet, so the gate was satisfied honestly. But
   * 2027-03-03 is Centre B's batch — Centre A's own stock expires 2030-01-01 —
   * so the value could only come from across the facility boundary. The gate was
   * facility-aware; the projection was not.
   */
  describe('C8 · phoenix_status_get_outlet_contribution', () => {
    const CONTRIB = (report: string, point: string) =>
      `SELECT classification, nearest_expiry_date::text FROM
       phoenix_status_get_outlet_contribution('${report}','${point}')`;

    it('the row denial the projection was bypassing still holds', async () => {
      expect(await one(MGR_A, 'SELECT count(*)::text FROM inventory_status_reports')).toBe('0');
      expect(await one(MGR_A, 'SELECT count(*)::text FROM inventory_status_report_lines')).toBe('0');
    });

    it('a manager can no longer read the sector contribution through its OWN outlet', async () => {
      expect(await fails(MGR_A, CONTRIB(ISR, PH_A))).toMatch(/not_authorized/);
    });

    it('Centre B\'s nearest expiry is not obtainable by any means this RPC offers', async () => {
      // The witness value must not appear for the manager through ANY outlet it
      // could name — its own, the foreign one, or the sector main's.
      for (const point of [PH_A, PH_B]) {
        const out = await fails(MGR_A, CONTRIB(ISR, point));
        expect(out).not.toMatch(/2027-03-03/);
        expect(out).toMatch(/not_authorized/);
      }
    });

    it('report existence stays unobservable — a real UUID and a random one are identical', async () => {
      const real = await fails(MGR_A, CONTRIB(ISR, PH_A));
      const fake = await fails(MGR_A, CONTRIB(randomUUID(), PH_A));
      expect(real).toMatch(/not_authorized/);
      // Before 9f these differed: not_authorized vs report_not_found.
      expect(fake).toBe(real);
      expect(fake).not.toMatch(/report_not_found/);
    });

    it('every manager shape is refused, not just the one that was measured', async () => {
      for (const [who, uid, point] of [
        ['manager of centre B', MGR_B, PH_B],
        ['manager of A and B', MGR_AB, PH_A],
        ['manager in the second sector', MGR_SEC_B, PH_C],
      ] as const) {
        const out = await fails(uid, CONTRIB(ISR, point));
        expect(out, who).toMatch(/not_authorized/);
        expect(out, who).not.toMatch(/2027-03-03/);
      }
    });

    it('institution_admin keeps the historical sector result, including 2027-03-03', async () => {
      const r = await asUser(ADMIN_A, CONTRIB(ISR, PH_A));
      expect(r.rows).toEqual([{ classification: 'scarce', nearest_expiry_date: '2027-03-03' }]);
    });

    it('outlet_officer keeps the historical contract for its own outlet', async () => {
      const r = await asUser(OFF_B, CONTRIB(ISR, PH_B));
      expect(r.rows).toEqual([{ classification: 'scarce', nearest_expiry_date: '2027-03-03' }]);
    });

    it('historical roles keep the original diagnostics they rely on', async () => {
      // 9f deliberately did NOT flatten report_not_found for anyone else.
      expect(await fails(ADMIN_A, CONTRIB(randomUUID(), PH_A))).toMatch(/report_not_found/);
    });
  });

  // ══ C9 — a self-only API over a global primitive ═══════════════════════════
  /**
   * 9e-3 made get_effective_permissions self-only and that held. But it is only
   * an aggregation of phoenix_profile_has_permission over permission_keys, and
   * that primitive performed NO caller authorization whatsoever — no auth.uid(),
   * no organization check, no role check. Measured before 9g, with no crafted
   * input:
   *
   *   correction request on the manager's OWN outlet -> decided_by = ADMIN_A
   *   get_effective_permissions(ADMIN_A)             -> OUT_OF_SCOPE   (closed)
   *   count(phoenix_profile_has_permission(ADMIN_A, k)) over permission_keys
   *                                                  -> 69 of 135     (open)
   *
   * The uuid is deliberately NOT treated as the secret: actor and decider ids
   * belong in ledger data, and the fixture keeps that path alive on purpose.
   */
  describe('C9 · cross-profile permission introspection', () => {
    const bits = (target: string) =>
      `SELECT count(*) FILTER (WHERE phoenix_profile_has_permission('${target}', k.key))::text
       FROM permission_keys k`;

    it('the foreign uuid is still obtainable — hiding it was never the fix', async () => {
      // If this ever returns 0 rows the exploit's premise changed, and the
      // assertions below would start passing for the wrong reason.
      expect(await one(MGR_A,
        `SELECT count(*)::text FROM phoenix_stock_correction_requests WHERE decided_by = '${ADMIN_A}'`))
        .toBe('1');
    });

    it('a manager can no longer reconstruct a foreign permission map (was 69/135)', async () => {
      expect(await one(MGR_A, bits(ADMIN_A))).toBe('0');
    });

    it('no individual foreign key leaks, in either polarity', async () => {
      for (const key of ['users.manage_permissions', 'users.view', 'reports.view',
        'warehouses.view', 'outlet_stock.view', 'availability.create']) {
        expect(await one(MGR_A,
          `SELECT phoenix_profile_has_permission('${ADMIN_A}','${key}')::text`), key).toBe('false');
      }
    });

    it('the scoped sibling is closed too, including its super_admin role oracle', async () => {
      // Closing only the primitive would leave these: the sibling answers from
      // three branches that all run BEFORE it consults the primitive.
      expect(await one(MGR_A,
        `SELECT phoenix_profile_has_scoped_permission('${ADMIN_A}','reports.view','${SEC_A}',NULL,NULL)::text`)).toBe('false');
      // With a NULL organization this returned TRUE iff the target was a
      // super_admin — a bare role oracle on any uuid.
      expect(await one(MGR_A,
        `SELECT phoenix_profile_has_scoped_permission('${SUPER_U}','anything',NULL,NULL,NULL)::text`)).toBe('false');
    });

    it('every transitive path to a caller-supplied profile is closed (parity)', async () => {
      // The high-level API and every lower-level primitive that can reconstruct
      // it must agree. A denial upstairs with an open primitive downstairs is
      // the exact shape C9 exists to remove.
      expect(await one(MGR_A, `SELECT (get_effective_permissions('${ADMIN_A}')->>'error')`)).toBe('OUT_OF_SCOPE');
      expect(await one(MGR_A,
        `SELECT phoenix_procurement_org_authority('${ADMIN_A}','local_procurement.manage','${SEC_A}')::text`)).toBe('false');
    });

    it('the manager\'s OWN self-checks are untouched', async () => {
      // The whole app authorizes through this primitive; breaking self-checks
      // would disable the role rather than scope it.
      expect(await one(MGR_A, `SELECT phoenix_profile_has_permission('${MGR_A}','outlet_stock.view')::text`)).toBe('true');
      expect(await one(MGR_A, `SELECT phoenix_profile_has_permission('${MGR_A}','warehouses.view')::text`)).toBe('true');
      expect(await one(MGR_A, `SELECT phoenix_profile_has_permission('${MGR_A}','users.view')::text`)).toBe('false');
      expect(await one(MGR_A,
        `SELECT phoenix_profile_has_scoped_permission('${MGR_A}','outlet_stock.view','${SEC_A}',NULL,'${PH_A}')::text`)).toBe('true');
      expect(await one(MGR_A,
        `SELECT phoenix_profile_has_scoped_permission('${MGR_A}','outlet_stock.view','${SEC_A}',NULL,'${PH_B}')::text`)).toBe('false');
      expect(await one(MGR_A, `SELECT (get_effective_permissions('${MGR_A}')->>'ok')`)).toBe('true');
    });

    it('the RLS surfaces that authorize through this primitive still resolve', async () => {
      // 16 policies and 28 functions call it with auth.uid(); if the guard were
      // mis-shaped they would all silently deny and the role would read nothing.
      expect(await one(MGR_A, 'SELECT count(*)::text FROM organization_facilities')).toBe('1');
      expect(await one(MGR_A, 'SELECT count(*)::text FROM distribution_points')).toBe('1');
      expect(Number(await one(MGR_A, 'SELECT count(*)::text FROM warehouses'))).toBeGreaterThan(0);
    });

    it('historical roles keep 017\'s exact cross-profile semantics', async () => {
      const legacy = await one(ADMIN_A, bits(ADMIN_A));
      expect(Number(legacy)).toBeGreaterThan(0);
      for (const [who, uid] of [['institution_admin', ADMIN_A], ['outlet_officer', OFF_B],
        ['super_admin', SUPER_U]] as const) {
        expect(await one(uid, bits(ADMIN_A)), who).toBe(legacy);
      }
    });

    it('a manager in another sector is equally refused, and still sees itself', async () => {
      expect(await one(MGR_SEC_B, bits(ADMIN_A))).toBe('0');
      expect(Number(await one(MGR_SEC_B, bits(MGR_SEC_B)))).toBeGreaterThan(0);
    });

    it('the service/internal path is untouched — auth.uid() is NULL there', async () => {
      // Provisioning and lifecycle legitimately evaluate another profile from a
      // trusted context; the guard must not be taken when there is no caller.
      const svc = await asAdmin(
        `SELECT count(*) FILTER (WHERE phoenix_profile_has_permission('${ADMIN_A}', k.key))::text n
         FROM permission_keys k`);
      expect(Number((svc.rows[0] as any).n)).toBeGreaterThan(0);
    });

    /**
     * The resolver's own DELEGATES. 9g first guarded the two permission
     * primitives and reasoned UPWARD about their callers; it did not reason
     * DOWNWARD. phoenix_profile_has_*_assignment are SECURITY DEFINER, granted
     * to authenticated, and take a caller-supplied p_profile_id — so a manager
     * skipped the guarded resolver and asked them directly:
     *
     *   scoped_permission(ADMIN_A,...,MY_DEPOT,...)      -> false  (guarded)
     *   has_warehouse_assignment(ADMIN_A, MY_DEPOT)      -> answered
     *
     * A `true` disclosed the subject's active status, organization and scope
     * assignment, and — via the facility branch, which requires
     * p.role='health_center_manager' — its ROLE. That is the same row
     * psa_select_scoped (062) denies this role with "never anyone else's row".
     */
    it('the resolver\'s delegates are guarded too — not just the resolver', async () => {
      for (const [what, sql] of [
        ['facility(MGR_B, FAC_B) — a positive role oracle',
          `SELECT phoenix_profile_has_facility_assignment('${MGR_B}','${FAC_B}')::text`],
        ['facility(MGR_B, FAC_A)',
          `SELECT phoenix_profile_has_facility_assignment('${MGR_B}','${FAC_A}')::text`],
        ['warehouse(MGR_B, DEP_B)',
          `SELECT phoenix_profile_has_warehouse_assignment('${MGR_B}','${DEP_B}')::text`],
        ['point(MGR_B, PH_B)',
          `SELECT phoenix_profile_has_point_assignment('${MGR_B}','${PH_B}')::text`],
        ['facility(ADMIN_A, FAC_A)',
          `SELECT phoenix_profile_has_facility_assignment('${ADMIN_A}','${FAC_A}')::text`],
      ] as const) {
        expect(await one(MGR_A, sql), what).toBe('false');
      }
    });

    it('but the manager\'s OWN reach through those delegates is intact', async () => {
      // If the guard were mis-shaped these would all go false and the role
      // would silently lose every facility-derived surface it legitimately has.
      expect(await one(MGR_A, `SELECT phoenix_profile_has_facility_assignment('${MGR_A}','${FAC_A}')::text`)).toBe('true');
      expect(await one(MGR_A, `SELECT phoenix_profile_has_warehouse_assignment('${MGR_A}','${DEP_A}')::text`)).toBe('true');
      expect(await one(MGR_A, `SELECT phoenix_profile_has_point_assignment('${MGR_A}','${PH_A}')::text`)).toBe('true');
      // Still scoped: a centre it does not hold, and the sector main.
      expect(await one(MGR_A, `SELECT phoenix_profile_has_facility_assignment('${MGR_A}','${FAC_B}')::text`)).toBe('false');
      expect(await one(MGR_A, `SELECT phoenix_profile_has_warehouse_assignment('${MGR_A}','${MAIN_A}')::text`)).toBe('false');
    });

    it('the delegate guard did not change historical roles or the service path', async () => {
      expect(await one(ADMIN_A, `SELECT phoenix_profile_has_facility_assignment('${MGR_B}','${FAC_B}')::text`)).toBe('true');
      expect(await one(OFF_B, `SELECT phoenix_profile_has_facility_assignment('${MGR_B}','${FAC_B}')::text`)).toBe('true');
      const svc = await asAdmin(`SELECT phoenix_profile_has_facility_assignment('${MGR_B}','${FAC_B}')::text t`);
      expect((svc.rows[0] as any).t).toBe('true');
    });

    it('the oracle disclosed nothing RLS does not already deny', async () => {
      // Documents WHY the delegates mattered: these rows are denied, so a
      // boolean answering the same question was a genuine bypass.
      expect(await one(MGR_A,
        `SELECT count(*)::text FROM profile_scope_assignments WHERE profile_id = '${MGR_B}'`)).toBe('0');
      expect(await one(MGR_A, `SELECT count(*)::text FROM profiles WHERE id = '${MGR_B}'`)).toBe('0');
    });

    it('no caller-controlled bypass parameter exists on either primitive', async () => {
      const rows = (await asAdmin(`
        SELECT p.proname, pg_get_function_arguments(p.oid) args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname IN
          ('phoenix_profile_has_permission','phoenix_profile_has_scoped_permission',
           'phoenix_profile_has_facility_assignment',
           'phoenix_profile_has_warehouse_assignment',
           'phoenix_profile_has_point_assignment')`)).rows as any[];
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        expect(r.args, r.proname).not.toMatch(/allow_cross_profile|bypass|as_profile|override_scope/i);
      }
    });
  });

  // ══ U-C — the DIRECT-SCOPE invariant ═══════════════════════════════════════
  /**
   * An independent U-C audit reproduced this end to end:
   *
   *   institution_admin (holds users.edit_scope)
   *     -> phoenix_assign_profile_scope(MGR_A, 'warehouse', <SECTOR MAIN>)  -> ok
   *   MGR_A then reads SECTOR_MAIN_SECRET.
   *
   * The facility branch already refused a facility scope to every OTHER role;
   * nothing refused the opposite. The manager cannot do this to itself (it holds
   * no users.* key), so it is an over-grant by an authorized administrator — and
   * that is exactly why it had to close: a facility-scoped role's isolation
   * cannot rest on every administrator remembering not to create a scope row the
   * model has no meaning for.
   *
   * The invariant is positive and structural, not a blocklist of the main's id:
   * for this role the ONLY assignable operational scope is 'facility'.
   */
  describe('U-C · direct warehouse/point scope is refused for this role', () => {
    const assign = (target: string, type: string, id: string) =>
      `SELECT phoenix_assign_profile_scope('${target}','${type}','${id}')::text`;
    const err = async (uid: string, sql: string) => {
      try { await asUser(uid, sql); return 'NO_ERROR'; } catch (e: any) { return String(e.message); }
    };

    it('refuses a direct SECTOR MAIN warehouse scope — the reproduced escape', async () => {
      expect(await err(ADMIN_A, assign(MGR_A, 'warehouse', MAIN_A)))
        .toMatch(/SCOPE_ASSIGN_ROLE_REQUIRES_FACILITY_SCOPE/);
    });

    it('refuses EVERY direct warehouse/point scope, not only the sector main', async () => {
      // A blocklist of the main's id would let the centre's own depot through,
      // creating a direct row the derived model has no meaning for.
      for (const [what, type, id] of [
        ['own centre depot', 'warehouse', DEP_A],
        ['other centre depot', 'warehouse', DEP_B],
        ['own centre pharmacy', 'distribution_point', PH_A],
        ['other centre pharmacy', 'distribution_point', PH_B],
      ] as const) {
        expect(await err(ADMIN_A, assign(MGR_A, type, id)), what)
          .toMatch(/SCOPE_ASSIGN_ROLE_REQUIRES_FACILITY_SCOPE/);
      }
    });

    it('super_admin is not exempt', async () => {
      expect(await err(SUPER_U, assign(MGR_A, 'warehouse', MAIN_A)))
        .toMatch(/SCOPE_ASSIGN_ROLE_REQUIRES_FACILITY_SCOPE/);
    });

    it('the manager still cannot self-assign anything', async () => {
      expect(await err(MGR_A, assign(MGR_A, 'facility', FAC_B))).toMatch(/NOT_AUTHORIZED_SCOPE_ASSIGN/);
      expect(await err(MGR_A, assign(MGR_A, 'warehouse', MAIN_A))).toMatch(/NOT_AUTHORIZED_SCOPE_ASSIGN/);
    });

    it('legacy roles keep their historical warehouse and point scopes', async () => {
      // The guard keys on the TARGET's role, so nothing pre-182 moves.
      expect(await err(ADMIN_A, assign(OFF_B, 'distribution_point', PH_B))).toBe('NO_ERROR');
    });

    it('an illegal direct row, however it arrived, still grants nothing', async () => {
      // Defence in depth: the writer refuses to create one, and the read helper
      // refuses to honour one. Inserted here from the service/superuser context,
      // which legitimately holds table INSERT.
      await asAdmin(`INSERT INTO profile_scope_assignments
        (profile_id,organization_id,scope_type,warehouse_id,is_active)
        VALUES ('${MGR_A}','${SEC_A}','warehouse','${MAIN_A}',true)`);
      try {
        expect(await one(MGR_A,
          `SELECT phoenix_profile_has_warehouse_assignment('${MGR_A}','${MAIN_A}')::text`)).toBe('false');
        // And the sector main's stock stays invisible.
        expect(await seen(MGR_A,
          `SELECT scientific_name FROM warehouse_stock WHERE warehouse_id = '${MAIN_A}'`)).toEqual([]);
      } finally {
        await asAdmin(`DELETE FROM profile_scope_assignments
          WHERE profile_id='${MGR_A}' AND scope_type='warehouse'`);
      }
    });

    it('a legacy role\'s DIRECT row is still honoured', async () => {
      // The read-side exclusion must not have broken the branch it shares.
      await asAdmin(`INSERT INTO profile_scope_assignments
        (profile_id,organization_id,scope_type,warehouse_id,is_active)
        VALUES ('${OFF_B}','${SEC_A}','warehouse','${MAIN_A}',true)`);
      try {
        expect(await one(OFF_B,
          `SELECT phoenix_profile_has_warehouse_assignment('${OFF_B}','${MAIN_A}')::text`)).toBe('true');
      } finally {
        await asAdmin(`DELETE FROM profile_scope_assignments
          WHERE profile_id='${OFF_B}' AND scope_type='warehouse'`);
      }
    });

    it('derived facility access is untouched by the refusal', async () => {
      expect(await one(MGR_A, `SELECT phoenix_profile_has_facility_assignment('${MGR_A}','${FAC_A}')::text`)).toBe('true');
      expect(await one(MGR_A, `SELECT phoenix_profile_has_warehouse_assignment('${MGR_A}','${DEP_A}')::text`)).toBe('true');
      expect(await one(MGR_A, `SELECT phoenix_profile_has_point_assignment('${MGR_A}','${PH_A}')::text`)).toBe('true');
      expect(await one(MGR_A, `SELECT phoenix_profile_has_warehouse_assignment('${MGR_A}','${MAIN_A}')::text`)).toBe('false');
    });
  });

  // ══ C6 — the systemic guard: close the CLASS, not the instances ════════════
  describe('C6 · no organization-only SECURITY DEFINER reader stays unnoticed', () => {
    /**
     * Every function here has been individually reviewed and is safe for a
     * reason recorded beside it. A function joining this list without review is
     * the exact defect that made this corrective pass necessary, so the test
     * asserts SET EQUALITY: a new org-only reader fails immediately.
     */
    const REVIEWED_ORG_ONLY = [
      // super_admin-only (hospital_admin cannot exist after the 091 cutover).
      'get_entity_purge_impact',
      'purge_entity_with_all_data',
      'phoenix_update_warehouse',
      // Platform -> ORGANIZATION communication, addressed to the org by design.
      'phoenix_ack_platform_broadcast',
      'phoenix_get_pending_platform_broadcasts',
      // Returns the caller's own organization id and nothing else.
      'phoenix_my_org',
      // Role whitelist that does not include health_center_manager.
      'phoenix_set_paper_reference',
    ].sort();

    it('the organization-only SECURITY DEFINER set is exactly the reviewed one', async () => {
      const rows = (await asAdmin(`
        SELECT p.proname, pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public'
          AND p.prosecdef
          AND pg_get_functiondef(p.oid) NOT LIKE '%RETURNS trigger%'
          AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
               OR has_function_privilege('anon', p.oid, 'EXECUTE'))
        ORDER BY p.proname`)).rows as any[];

      const SCOPED = /has_warehouse_assignment|has_point_assignment|has_facility_assignment|has_scoped_permission|phoenix_can_read_|phoenix_procurement_org_authority|phoenix_status_center_authorized|phoenix_inventory_scope_org/;
      const PERMKEY = /phoenix_profile_has_permission|phoenix_my_permissions|get_effective_permissions/;
      const ORGGATE = /phoenix_my_org\(\)|organization_id\s*=\s*v_org|v_org\s*=\s*[a-z_]*organization_id|organization_id\s*=\s*\(\s*SELECT|v_org IS NOT NULL/;

      const orgOnly = [...new Set(rows
        .filter(r => !/health_center_manager/.test(r.def))
        .filter(r => !SCOPED.test(r.def))
        .filter(r => !PERMKEY.test(r.def))
        .filter(r => ORGGATE.test(r.def))
        .map(r => r.proname))].sort();

      expect(orgOnly).toEqual(REVIEWED_ORG_ONLY);
    });

    /**
     * C8/C6 CORRECTION — classify the PROJECTION, not the gate.
     *
     * The census above filters out any function whose definition merely MENTIONS
     * a scope helper (`!SCOPED.test(def)`). That is what let the real leak
     * through: phoenix_status_get_outlet_contribution names
     * phoenix_profile_has_point_assignment in its AUTHORIZATION GATE while its
     * PROJECTION returned inventory_status_report_lines.classification and
     * .nearest_expiry_date — values computed across the whole sector. The gate
     * was facility-safe and the data was not, and a text search for the helper
     * cannot tell those two things apart.
     *
     * So this census is keyed on the property that actually failed: does the
     * function BODY read a table that carries sector / cross-facility identity?
     * Every such reachable function must be explicitly classified. Replacing one
     * fragile regex with a cleverer regex would repeat the mistake, so the
     * classification is a hand-maintained map and the test asserts SET EQUALITY:
     * a new function touching one of these tables fails until a human labels it.
     */
    /**
     * KNOWN AND DELIBERATE LIMIT OF THIS CENSUS — read before trusting it.
     *
     * These are the tables whose SECURITY DEFINER readers C8 audited. They are
     * NOT every table 182 treats as facility-sensitive. Sections 9c/9d also
     * narrow item_availability, qr_targets, qr_tokens, outlet_replenishment_routes,
     * warehouse_supply_routes, stocktakes, stocktake_count_lines,
     * phoenix_movement_events, phoenix_stock_correction_requests,
     * phoenix_warehouse_correction_requests, phoenix_dispatch_line_requests,
     * phoenix_outlet_return_line_requests,
     * phoenix_outlet_return_exception_resolutions and
     * platform_broadcast_acknowledgements; and neither stock truth
     * (warehouse_stock / outlet_stock), neither movement ledger, nor
     * warehouses / distribution_points / organization_facilities is watched by
     * any census at all.
     *
     * Adding them pulls ~36 further SECURITY DEFINER functions into scope, each
     * needing an individual classification. That is a full re-audit, which this
     * corrective patch is explicitly not authorized to perform, so the gap is
     * recorded here rather than papered over: a future reader that projects, say,
     * outlet_stock.expiry_date across the sector — structurally identical to the
     * C8 leak with a different column — would NOT be caught by this test today.
     * Widening this list is the first task of the next audit pass.
     */
    const SENSITIVE_TABLES = [
      'inventory_status_reports',
      'inventory_status_report_lines',
      'inventory_status_report_amendments',
      'phoenix_notifications',
      'phoenix_paper_references',
      'profile_permission_overrides',
    ];

    type Classification =
      /** Body carries an explicit health_center_manager denial. */
      | 'DENIED_FOR_HEALTH_CENTER_MANAGER'
      /** Every returned datum resolves to the caller's own facility. Requires proof. */
      | 'FACILITY_SAFE_PROJECTION'
      /** Gated on a permission key or role whitelist this role does not hold. */
      | 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS'
      /** Reviewed, deliberately org-level, reason recorded, deferred by contract. */
      | 'HISTORICAL_ORG_LEVEL_BY_EXPLICIT_CONTRACT'
      /**
       * Reachable, ungated, and NOT facility- or organization-bounded. A known
       * defect that predates this migration and is deferred to its own patch.
       * Distinct from HISTORICAL_ORG_LEVEL_*: that label claims an organization
       * boundary exists. This one claims none, so nothing here may be read as
       * evidence of safety.
       */
      | 'PREEXISTING_UNGATED_DEFERRED_TO_U_C';

    const CLASSIFIED: Record<string, Classification> = {
      // ── Forward-replaced in 9e/9f; the denial is in the body. ──────────────
      phoenix_notifications_list: 'DENIED_FOR_HEALTH_CENTER_MANAGER',
      phoenix_notifications_unread_count: 'DENIED_FOR_HEALTH_CENTER_MANAGER',
      phoenix_notifications_mark_all_read: 'DENIED_FOR_HEALTH_CENTER_MANAGER',
      phoenix_notifications_mark_read: 'DENIED_FOR_HEALTH_CENTER_MANAGER',
      phoenix_search_paper_reference: 'DENIED_FOR_HEALTH_CENTER_MANAGER',
      // 9f. Permanently listed here BY NAME so it can never again drop out of a
      // census merely because its gate mentions a scope helper.
      phoenix_status_get_outlet_contribution: 'DENIED_FOR_HEALTH_CENTER_MANAGER',

      // ── Monthly-status family: every one gates on phoenix_status_center_authorized,
      //    which demands a status_center.* key. Section 8 grants this role none,
      //    and 182/11l asserts that it never will.
      phoenix_status_prepare_report: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      phoenix_status_submit_report: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      phoenix_status_approve_lock_report: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      phoenix_status_return_for_clarification: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      phoenix_status_create_amendment: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      phoenix_status_classify_lines: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      phoenix_status_confirm_missing: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      // Permission-override writers: require users.manage_permissions.
      assign_profile_permissions: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      reset_profile_permissions: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      // Role whitelists that do not include health_center_manager.
      phoenix_set_paper_reference: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',
      phoenix_clean_availability_data: 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS',

      // ── Known defect, deferred with its blast radius stated honestly. ──────
      // Defined in 017 and granted to authenticated. Its body performs NO
      // authorization at all: no auth.uid(), no organization check, no role
      // check. It answers for ANY profile id in ANY organization, so it is
      // global rather than organization-level, and get_effective_permissions is
      // literally an aggregation of it over permission_keys — meaning C4's
      // self-only narrowing of that RPC is reconstructible key-by-key by anyone
      // holding a target UUID.
      //
      // An earlier revision of this map labelled it HISTORICAL_ORG_LEVEL_* and
      // justified it as "reaching another profile's bit requires that profile's
      // UUID, and 9e-3 closed profiles enumeration". That justification is
      // WRONG and is recorded here so it is not repeated: 9e-3 closed the
      // profiles TABLE, not the actor columns of ledgers this role is
      // deliberately allowed to read. 9d admits a manager to
      // phoenix_stock_correction_requests rows on its OWN outlet, and those
      // rows carry decided_by — an approver who by construction (098) is never
      // the proposer. The movement ledgers' actor_id columns are a second
      // source.
      //
      // It predates 182 and 182 does not widen it. Closing it means changing a
      // predicate every RLS policy in the schema calls, which needs its own
      // migration and its own proof — deliberately NOT bolted onto this patch.
      phoenix_profile_has_permission: 'PREEXISTING_UNGATED_DEFERRED_TO_U_C',
    };

    const sensitiveReaders = async () => {
      const rows = (await asAdmin(`
        SELECT p.proname, pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public'
          AND p.prosecdef
          AND pg_get_functiondef(p.oid) NOT LIKE '%RETURNS trigger%'
          AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
               OR has_function_privilege('anon', p.oid, 'EXECUTE'))
        ORDER BY p.proname`)).rows as any[];
      return rows.filter(r => SENSITIVE_TABLES.some(t => String(r.def).includes(t)));
    };

    it('every reachable SECURITY DEFINER reader of a sector table is explicitly classified', async () => {
      const found = [...new Set((await sensitiveReaders()).map(r => r.proname))].sort();
      // Set equality in BOTH directions: an unclassified new reader fails, and a
      // stale entry for a function that no longer exists fails too.
      expect(found).toEqual(Object.keys(CLASSIFIED).sort());
    });

    it('every DENIED_FOR_HEALTH_CENTER_MANAGER reader actually carries the denial', async () => {
      const rows = await sensitiveReaders();
      const missing = rows
        .filter(r => CLASSIFIED[r.proname] === 'DENIED_FOR_HEALTH_CENTER_MANAGER')
        .filter(r => !/health_center_manager/.test(String(r.def)))
        .map(r => r.proname);
      expect(missing).toEqual([]);
    });

    it('every NOT_REACHABLE_WITH_ROLE_PERMISSIONS reader demands something this role lacks', async () => {
      const granted = new Set(((await asAdmin(`
        SELECT permission_key FROM role_permission_defaults
        WHERE role='health_center_manager' AND allowed`)).rows as any[]).map(r => r.permission_key));

      const rows = await sensitiveReaders();
      const bad: string[] = [];
      for (const r of rows.filter(x => CLASSIFIED[x.proname] === 'NOT_REACHABLE_WITH_ROLE_PERMISSIONS')) {
        const def = String(r.def);
        // Any dotted permission key the body names must NOT be one this role holds.
        const keys = [...def.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]);
        const reachableKey = keys.find(k => granted.has(k));
        // A function naming no key at all must instead carry a role whitelist
        // that cannot match health_center_manager.
        const roleGated = /phoenix_status_center_authorized|'super_admin'|'institution_admin'/.test(def);
        if (reachableKey || (keys.length === 0 && !roleGated)) {
          bad.push(`${r.proname}${reachableKey ? ` (reachable via ${reachableKey})` : ' (no key, no role gate)'}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it('the deferred-defect class is exactly the one known member', () => {
      // PREEXISTING_UNGATED_DEFERRED_TO_U_C is an admission of a hole, not a
      // clearance. Pinning the set means a second one cannot be added quietly:
      // any new entry has to be written here deliberately, in a diff a reviewer
      // reads, rather than inherited by a function happening to match a regex.
      const deferred = Object.entries(CLASSIFIED)
        .filter(([, c]) => c === 'PREEXISTING_UNGATED_DEFERRED_TO_U_C')
        .map(([n]) => n).sort();
      expect(deferred).toEqual(['phoenix_profile_has_permission']);
    });

    it('no reader is classified FACILITY_SAFE_PROJECTION without an executable proof', async () => {
      // 9f rejected the "filter the sector aggregate" shape outright, so this
      // class is currently empty. Should a future reader claim it, the claim must
      // be discharged by a real adversarial probe (the Manager A / Centre B case
      // in the C8 suite), never by inspection. Keeping the assertion here makes
      // an unproved claim fail rather than pass silently.
      const claimed = Object.entries(CLASSIFIED)
        .filter(([, c]) => c === 'FACILITY_SAFE_PROJECTION')
        .map(([n]) => n);
      expect(claimed).toEqual([]);
    });

    it('every phoenix_notifications* reader reachable by a client carries the denial', async () => {
      const open = (await asAdmin(`
        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef
          AND p.proname LIKE 'phoenix_notifications%'
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND pg_get_functiondef(p.oid) NOT LIKE '%health_center_manager%'`)).rows as any[];
      expect(open.map(r => r.proname)).toEqual([]);
    });
  });
});
