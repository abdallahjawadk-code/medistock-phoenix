/**
 * CN-1A / CENTRAL-NEEDS-REGISTRY-209 — DYNAMIC proof against a real
 * disposable Postgres with 001->209 applied in order.
 *
 * Proves:
 *   1. super_admin sees a plan in any organization.
 *   2. A central_warehouse_manager explicitly granted central_needs.view
 *      (via profile_permission_overrides — no role default exists) sees
 *      their own org's plan.
 *   3. A same-org central_warehouse_manager WITHOUT the grant sees nothing.
 *   4. A central_warehouse_manager granted the key in org B cannot see org
 *      A's plan (wrong organization).
 *   5. institution_admin and outlet_officer see nothing (no default grant
 *      for any role — access is opt-in only, per the CN-1A proposal doc).
 *   6. anon sees nothing.
 *   7. Direct authenticated INSERT/UPDATE/DELETE on every table is rejected
 *      by the table-level REVOKE (permission denied), independent of RLS.
 *   8. Source-file AND source-record immutability: even a superuser/
 *      service-role UPDATE is rejected by the trigger itself (defense-in-
 *      depth beyond the REVOKE).
 *   9. An override row referencing a revision leaves the source-file AND
 *      source-record rows byte-identical.
 *  10. Schema integrity: organization_id+plan_year unique, plan_id+
 *      revision_number unique, plan_revision_id+file_hash unique, and the
 *      approval-pair CHECK rejects an 'approved' revision with no approver
 *      while allowing a 'superseded' one to keep its prior approval record.
 *  A-K. Corrective-round adversarial matrix (remote review Findings A/B):
 *      cross-org parent/child integrity is proven undbreakable via
 *      declarative composite FK, and the structured source_values/
 *      source_provenance contract on central_needs_source_records is
 *      proven to persist arbitrary JSONB and stay immutable.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI when no database is configured to
 * exercise it (mirrors every other *.dynamic.test.ts in this directory).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000209001';
const ORG_B = '00000000-0000-0000-0000-000000209002';

const CWM_A_GRANTED = '00000000-0000-0000-0000-000000209401'; // central_warehouse_manager, org A, granted central_needs.view
const CWM_A_NOPERM = '00000000-0000-0000-0000-000000209402'; // central_warehouse_manager, org A, NOT granted
const CWM_B_GRANTED = '00000000-0000-0000-0000-000000209403'; // central_warehouse_manager, org B, granted — cross-org denial
const IA_A = '00000000-0000-0000-0000-000000209404'; // institution_admin, org A
const OO_A = '00000000-0000-0000-0000-000000209405'; // outlet_officer, org A

const SOURCE_HASH = 'a'.repeat(64);
const SOURCE_HASH_B = 'b'.repeat(64);

run('CN-1A/209 central-needs-registry domain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let planId = '';
  let revisionId = '';
  let sourceFileId = '';
  // A fully legitimate, parallel org-B chain — used only as the "wrong org"
  // side of the cross-org adversarial tests (A-D), never mixed with org A's
  // chain except in the one deliberately-invalid statement each test issues.
  let planIdB = '';
  let revisionIdB = '';
  let sourceFileIdB = '';
  // The one legitimate, fully same-org import session + source record, used
  // for the happy-path (E) and the structured source-contract tests (G-K).
  let importSessionId = '';
  let sourceRecordId = '';

  beforeAll(async () => {
    rig = await buildRig({ upTo: 209 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','CN209-A','أ','p209-a','care_institution','hospital'),
        ('${ORG_B}','CN209-B','ب','p209-b','care_institution','hospital') ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM_A_GRANTED}','p209-cwma-g@rig'),('${CWM_A_NOPERM}','p209-cwma-n@rig'),
        ('${CWM_B_GRANTED}','p209-cwmb-g@rig'),('${IA_A}','p209-iaa@rig'),('${OO_A}','p209-ooa@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG_A}' WHERE id='${CWM_A_GRANTED}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG_A}' WHERE id='${CWM_A_NOPERM}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG_B}' WHERE id='${CWM_B_GRANTED}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_A}' WHERE id='${IA_A}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A}';`);

      // The ONLY two grants that exist anywhere in this fixture — proving
      // access is genuinely opt-in, not role-default (209 seeds no
      // role_permission_defaults row for any central_needs.* key).
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES
        ('${CWM_A_GRANTED}','central_needs.view',true),
        ('${CWM_B_GRANTED}','central_needs.view',true)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true;`);

      const plan = await c.query(
        `INSERT INTO central_needs_plans (organization_id, plan_year, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [ORG_A, 2027, CWM_A_GRANTED],
      );
      planId = plan.rows[0].id;
      const revision = await c.query(
        `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, created_by) VALUES ($1,$2,1,$3) RETURNING id`,
        [planId, ORG_A, CWM_A_GRANTED],
      );
      revisionId = revision.rows[0].id;
      const sourceFile = await c.query(
        `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, uploaded_by)
         VALUES ($1,$2,'annual-needs-2027.xls',$3,$4) RETURNING id`,
        [revisionId, ORG_A, SOURCE_HASH, CWM_A_GRANTED],
      );
      sourceFileId = sourceFile.rows[0].id;

      // The legitimate same-org import session + source record (proof E),
      // and the structured-source-contract fixtures used by G-K below.
      const importSession = await c.query(
        `INSERT INTO central_needs_import_sessions (plan_revision_id, organization_id, source_file_id, started_by)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [revisionId, ORG_A, sourceFileId, CWM_A_GRANTED],
      );
      importSessionId = importSession.rows[0].id;
      const sourceRecord = await c.query(
        `INSERT INTO central_needs_source_records
           (import_session_id, organization_id, target_entity, field_name, source_values, source_provenance, created_by)
         VALUES ($1,$2,'line-1','quantity',$3,$4,$5) RETURNING id`,
        [
          importSessionId, ORG_A,
          JSON.stringify({ raw: '10 boxes', currency: null, nested: [1, 2, 3] }),
          JSON.stringify({ note: 'arbitrary shape', anything: { could: 'go here' } }),
          CWM_A_GRANTED,
        ],
      );
      sourceRecordId = sourceRecord.rows[0].id;

      // A fully legitimate, parallel org-B chain (plan/revision/source file),
      // used ONLY as the wrong-org side of the A-D adversarial tests below.
      const planB = await c.query(
        `INSERT INTO central_needs_plans (organization_id, plan_year, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [ORG_B, 2027, CWM_B_GRANTED],
      );
      planIdB = planB.rows[0].id;
      const revisionB = await c.query(
        `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, created_by) VALUES ($1,$2,1,$3) RETURNING id`,
        [planIdB, ORG_B, CWM_B_GRANTED],
      );
      revisionIdB = revisionB.rows[0].id;
      const sourceFileB = await c.query(
        `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, uploaded_by)
         VALUES ($1,$2,'annual-needs-2027-b.xls',$3,$4) RETURNING id`,
        [revisionIdB, ORG_B, SOURCE_HASH_B, CWM_B_GRANTED],
      );
      sourceFileIdB = sourceFileB.rows[0].id;
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  const visiblePlans = async (userId: string | null, role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query('SELECT id FROM central_needs_plans').then((r: any) => r.rows), { role });

  it('super_admin sees the plan in any organization', async () => {
    const rows = await visiblePlans(rig.superAdminId);
    expect(rows.map((r: any) => r.id)).toContain(planId);
  });

  it('a central_warehouse_manager explicitly granted central_needs.view sees their own org plan', async () => {
    const rows = await visiblePlans(CWM_A_GRANTED);
    expect(rows.map((r: any) => r.id)).toContain(planId);
  });

  it('a same-org central_warehouse_manager WITHOUT the grant sees nothing', async () => {
    const rows = await visiblePlans(CWM_A_NOPERM);
    expect(rows).toEqual([]);
  });

  it('a central_warehouse_manager granted the key in a DIFFERENT organization cannot see org A\'s plan (but does see their own org\'s)', async () => {
    const rows = await visiblePlans(CWM_B_GRANTED);
    const ids = rows.map((r: any) => r.id);
    expect(ids).not.toContain(planId);
    expect(ids).toContain(planIdB);
  });

  it('institution_admin sees nothing — no default grant for any role', async () => {
    const rows = await visiblePlans(IA_A);
    expect(rows).toEqual([]);
  });

  it('outlet_officer sees nothing', async () => {
    const rows = await visiblePlans(OO_A);
    expect(rows).toEqual([]);
  });

  it('anon has no SELECT grant at all — the query itself is refused, not merely filtered to empty by RLS', async () => {
    await expect(visiblePlans(null, 'anon')).rejects.toThrow(/permission denied for table central_needs_plans/i);
  });

  it('direct authenticated INSERT is rejected on central_needs_plans by REVOKE, independent of RLS', async () => {
    await expect(rig.asUser(CWM_A_GRANTED, (c: any) => c.query(
      `INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,2028)`, [ORG_A],
    ))).rejects.toThrow(/permission denied/i);
  });

  it('direct authenticated UPDATE is rejected on central_needs_plans by REVOKE, independent of RLS', async () => {
    await expect(rig.asUser(CWM_A_GRANTED, (c: any) => c.query(
      `UPDATE central_needs_plans SET plan_year = 2099 WHERE id = $1`, [planId],
    ))).rejects.toThrow(/permission denied/i);
  });

  it('direct authenticated DELETE is rejected on central_needs_plans by REVOKE, independent of RLS', async () => {
    await expect(rig.asUser(CWM_A_GRANTED, (c: any) => c.query(
      `DELETE FROM central_needs_plans WHERE id = $1`, [planId],
    ))).rejects.toThrow(/permission denied/i);
  });

  it('direct authenticated UPDATE is rejected on central_needs_source_files by REVOKE, independent of RLS', async () => {
    await expect(rig.asUser(CWM_A_GRANTED, (c: any) => c.query(
      `UPDATE central_needs_source_files SET original_filename = 'tampered.xls' WHERE id = $1`, [sourceFileId],
    ))).rejects.toThrow(/permission denied/i);
  });

  it('source-file immutability: even a superuser UPDATE is rejected by the trigger itself', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `UPDATE central_needs_source_files SET original_filename = 'tampered.xls' WHERE id = $1`, [sourceFileId],
      )).rejects.toThrow(/central_needs_source_file_immutable/);
    });
  });

  it('source-record immutability: even a superuser UPDATE of source_values is rejected by the trigger itself (adversarial I)', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `UPDATE central_needs_source_records SET source_values = '{"tampered":true}'::jsonb WHERE id = $1`, [sourceRecordId],
      )).rejects.toThrow(/central_needs_source_file_immutable/);
    });
  });

  it('source-record immutability: even a superuser UPDATE of source_provenance is rejected by the trigger itself (adversarial J)', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `UPDATE central_needs_source_records SET source_provenance = '{"tampered":true}'::jsonb WHERE id = $1`, [sourceRecordId],
      )).rejects.toThrow(/central_needs_source_file_immutable/);
    });
  });

  it('an override row referencing the revision leaves the source-file AND source-record rows byte-identical (adversarial K)', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO central_needs_field_overrides
           (plan_revision_id, organization_id, target_entity, field_name, previous_value, final_value, override_reason, actor_id)
         VALUES ($1,$2,'line-placeholder','quantity','10','12','manual correction',$3)`,
        [revisionId, ORG_A, CWM_A_GRANTED],
      );
      const fileRow = (await c.query(
        `SELECT original_filename, file_hash FROM central_needs_source_files WHERE id = $1`, [sourceFileId],
      )).rows[0];
      expect(fileRow.original_filename).toBe('annual-needs-2027.xls');
      expect(fileRow.file_hash).toBe(SOURCE_HASH);

      const recordRow = (await c.query(
        `SELECT source_values, source_provenance FROM central_needs_source_records WHERE id = $1`, [sourceRecordId],
      )).rows[0];
      expect(recordRow.source_values).toEqual({ raw: '10 boxes', currency: null, nested: [1, 2, 3] });
      expect(recordRow.source_provenance).toEqual({ note: 'arbitrary shape', anything: { could: 'go here' } });
    });
  });

  it('organization_id + plan_year is unique', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,2027)`, [ORG_A],
      )).rejects.toThrow(/duplicate key|unique constraint/i);
    });
  });

  it('plan_id + revision_number is unique', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number) VALUES ($1,$2,1)`,
        [planId, ORG_A],
      )).rejects.toThrow(/duplicate key|unique constraint/i);
    });
  });

  it('plan_revision_id + file_hash is unique', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash)
         VALUES ($1,$2,'dup.xls',$3)`,
        [revisionId, ORG_A, SOURCE_HASH],
      )).rejects.toThrow(/duplicate key|unique constraint/i);
    });
  });

  it('the approval-pair CHECK rejects an approved revision with no approver', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status) VALUES ($1,$2,2,'approved')`,
        [planId, ORG_A],
      )).rejects.toThrow(/violates check constraint|central_needs_plan_revisions_approval_pair_chk/);
    });
  });

  it('a superseded revision may keep its prior approval record', async () => {
    await rig.asAdmin(async (c: any) => {
      const approvedAt = new Date().toISOString();
      const row = await c.query(
        `INSERT INTO central_needs_plan_revisions
           (plan_id, organization_id, revision_number, status, approved_by, approved_at)
         VALUES ($1,$2,3,'superseded',$3,$4) RETURNING id`,
        [planId, ORG_A, CWM_A_GRANTED, approvedAt],
      );
      expect(row.rows[0].id).toBeTruthy();
    });
  });

  // ==========================================================================
  // CORRECTIVE-ROUND ADVERSARIAL MATRIX (remote review Finding B) — every
  // attempt to make a child row disagree with its parent's organization_id
  // must fail at INSERT time, via a declarative composite FK, never merely
  // "be discouraged". Each test below is the ONE deliberately-invalid
  // statement in an otherwise fully legitimate fixture.
  // ==========================================================================

  it('A: a revision cannot claim a different organization than its parent plan', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number) VALUES ($1,$2,97)`,
        [planId, ORG_B],
      )).rejects.toThrow(/violates foreign key constraint "central_needs_plan_revisions_plan_org_fk"/);
    });
  });

  it('B: a source file cannot claim a different organization than its parent revision', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash)
         VALUES ($1,$2,'cross-org.xls',$3)`,
        [revisionId, ORG_B, 'c'.repeat(64)],
      )).rejects.toThrow(/violates foreign key constraint "central_needs_source_files_revision_org_fk"/);
    });
  });

  it('C: an import session cannot mix an org-A revision with an org-B source file', async () => {
    await rig.asAdmin(async (c: any) => {
      // organization_id=ORG_A agrees with plan_revision_id=revisionId (so the
      // FIRST composite FK is satisfied) but source_file_id=sourceFileIdB
      // actually belongs to (revisionIdB, ORG_B) — the SECOND composite FK,
      // which checks source_file_id together with plan_revision_id AND
      // organization_id, must reject this.
      await expect(c.query(
        `INSERT INTO central_needs_import_sessions (plan_revision_id, organization_id, source_file_id) VALUES ($1,$2,$3)`,
        [revisionId, ORG_A, sourceFileIdB],
      )).rejects.toThrow(/violates foreign key constraint "central_needs_import_sessions_source_revision_org_fk"/);
    });
  });

  it('C2: an import session cannot claim a different organization than its parent revision at all', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_import_sessions (plan_revision_id, organization_id, source_file_id) VALUES ($1,$2,$3)`,
        [revisionId, ORG_B, sourceFileId],
      )).rejects.toThrow(/violates foreign key constraint "central_needs_import_sessions_revision_org_fk"/);
    });
  });

  it('D: a field override cannot claim a different organization than its parent revision', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_field_overrides (plan_revision_id, organization_id, target_entity, field_name, override_reason)
         VALUES ($1,$2,'x','y','cross-org attempt')`,
        [revisionId, ORG_B],
      )).rejects.toThrow(/violates foreign key constraint "central_needs_field_overrides_revision_org_fk"/);
    });
  });

  it('D2: a source record cannot claim a different organization than its parent import session', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(c.query(
        `INSERT INTO central_needs_source_records (import_session_id, organization_id, target_entity, field_name, source_values)
         VALUES ($1,$2,'x','y','{}'::jsonb)`,
        [importSessionId, ORG_B],
      )).rejects.toThrow(/violates foreign key constraint "central_needs_source_records_session_org_fk"/);
    });
  });

  it('E: correct same-org rows insert cleanly end to end (plan -> revision -> source file -> import session -> source record)', async () => {
    // This is exactly the beforeAll fixture chain; re-assert it actually
    // produced real, linked rows rather than merely not throwing.
    await rig.asAdmin(async (c: any) => {
      const row = (await c.query(
        `SELECT p.organization_id AS plan_org, r.organization_id AS revision_org,
                f.organization_id AS file_org, s.organization_id AS session_org,
                rec.organization_id AS record_org
         FROM central_needs_source_records rec
         JOIN central_needs_import_sessions s ON s.id = rec.import_session_id
         JOIN central_needs_source_files f ON f.id = s.source_file_id
         JOIN central_needs_plan_revisions r ON r.id = s.plan_revision_id
         JOIN central_needs_plans p ON p.id = r.plan_id
         WHERE rec.id = $1`,
        [sourceRecordId],
      )).rows[0];
      expect(row).toBeTruthy();
      for (const org of [row.plan_org, row.revision_org, row.file_org, row.session_org, row.record_org]) {
        expect(org).toBe(ORG_A);
      }
    });
  });

  it('F: RLS cannot expose a logically cross-org child because no such row can exist — none of A/B/C/C2/D/D2 left a row behind', async () => {
    await rig.asAdmin(async (c: any) => {
      const revisions = await c.query(`SELECT count(*) FROM central_needs_plan_revisions WHERE organization_id = $1 AND plan_id = $2`, [ORG_B, planId]);
      expect(Number(revisions.rows[0].count)).toBe(0);
      const files = await c.query(`SELECT count(*) FROM central_needs_source_files WHERE organization_id = $1 AND plan_revision_id = $2`, [ORG_B, revisionId]);
      expect(Number(files.rows[0].count)).toBe(0);
      const sessions = await c.query(`SELECT count(*) FROM central_needs_import_sessions WHERE plan_revision_id = $1 AND organization_id <> $2`, [revisionId, ORG_A]);
      expect(Number(sessions.rows[0].count)).toBe(0);
      const overrides = await c.query(`SELECT count(*) FROM central_needs_field_overrides WHERE plan_revision_id = $1 AND organization_id <> $2`, [revisionId, ORG_A]);
      expect(Number(overrides.rows[0].count)).toBe(0);
      const records = await c.query(`SELECT count(*) FROM central_needs_source_records WHERE import_session_id = $1 AND organization_id <> $2`, [importSessionId, ORG_A]);
      expect(Number(records.rows[0].count)).toBe(0);
    });
  });

  it('G: source_values persists arbitrary JSONB exactly as given', async () => {
    await rig.asAdmin(async (c: any) => {
      const arbitrary = { anything: [{ deeply: { nested: true } }], number: 42, text: 'ok', nullish: null };
      const row = await c.query(
        `INSERT INTO central_needs_source_records (import_session_id, organization_id, target_entity, field_name, source_values)
         VALUES ($1,$2,'line-2','material_name',$3) RETURNING source_values`,
        [importSessionId, ORG_A, JSON.stringify(arbitrary)],
      );
      expect(row.rows[0].source_values).toEqual(arbitrary);
    });
  });

  it('H: source_provenance persists arbitrary JSONB with no sheet/row/column requirement', async () => {
    await rig.asAdmin(async (c: any) => {
      // Deliberately contains NONE of sheet/row/column — proving no shape is
      // assumed, per v7.3 section 8.3.
      const provenance = { workbook_family: 'unknown-future-format', freeform_note: 'no schema imposed here' };
      const row = await c.query(
        `INSERT INTO central_needs_source_records (import_session_id, organization_id, target_entity, field_name, source_values, source_provenance)
         VALUES ($1,$2,'line-3','unit',$3,$4) RETURNING source_provenance`,
        [importSessionId, ORG_A, JSON.stringify({ raw: 'box' }), JSON.stringify(provenance)],
      );
      expect(row.rows[0].source_provenance).toEqual(provenance);
    });
  });
});
