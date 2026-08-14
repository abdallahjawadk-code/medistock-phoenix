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
  describe('C3 · suspension is an administrative state, not a self-service one', () => {
    it('an administratively suspended manager cannot reactivate itself', async () => {
      await asAdmin(`UPDATE profiles SET status='suspended', disabled_at=now(), disabled_by='${SUPER}'
                     WHERE id='${MGR_B}'`);
      await expect(
        asUser(MGR_B, `UPDATE profiles SET status='active' WHERE id='${MGR_B}'`, true),
      ).rejects.toThrow(/health_center_manager_self_reactivation_forbidden/);
    });

    it('suspension really is the containment control while it holds', async () => {
      expect(await seen(MGR_B, 'SELECT name FROM warehouses')).toEqual([]);
    });

    it('an authorized administrator can still reactivate the same profile', async () => {
      await asUser(SUPER, `UPDATE profiles SET status='active', disabled_at=NULL, disabled_by=NULL
                           WHERE id='${MGR_B}'`, true);
      expect((await asAdmin(`SELECT status FROM profiles WHERE id='${MGR_B}'`)).rows[0].status)
        .toBe('active');
      expect(await seen(MGR_B, 'SELECT name FROM warehouses')).toEqual(['DEP_B']);
    });

    it('a historical role is untouched by the guard — it may still self-update', async () => {
      await asAdmin(`UPDATE profiles SET status='suspended' WHERE id='${OFF_B}'`);
      // Pre-existing 002 behaviour, deliberately NOT changed by this substage.
      await expect(
        asUser(OFF_B, `UPDATE profiles SET status='active' WHERE id='${OFF_B}'`, true),
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
      | 'HISTORICAL_ORG_LEVEL_BY_EXPLICIT_CONTRACT';

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

      // ── Reviewed, left unchanged, reason recorded. ─────────────────────────
      // RLS-internal predicate helper: returns ONE boolean for an explicitly
      // supplied (profile_id, key). It has no facility dimension by construction
      // and every RLS policy in the schema depends on it, so it is not narrowed
      // here. Reaching another profile's bit requires that profile's UUID, and
      // 9e-3 closed profiles enumeration to the caller's own row. Recorded for
      // fresh U-C rather than redesigned inside this corrective patch.
      phoenix_profile_has_permission: 'HISTORICAL_ORG_LEVEL_BY_EXPLICIT_CONTRACT',
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
