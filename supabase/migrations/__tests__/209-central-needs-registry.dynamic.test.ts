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
 *   8. Source-file immutability: even a superuser/service-role UPDATE is
 *      rejected by the trigger itself (defense-in-depth beyond the REVOKE).
 *   9. An override row referencing a revision leaves the source-file row's
 *      original filename/hash byte-identical.
 *  10. Schema integrity: organization_id+plan_year unique, plan_id+
 *      revision_number unique, plan_revision_id+file_hash unique, and the
 *      approval-pair CHECK rejects an 'approved' revision with no approver
 *      while allowing a 'superseded' one to keep its prior approval record.
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

run('CN-1A/209 central-needs-registry domain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let planId = '';
  let revisionId = '';
  let sourceFileId = '';

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

  it('a central_warehouse_manager granted the key in a DIFFERENT organization cannot see org A\'s plan', async () => {
    const rows = await visiblePlans(CWM_B_GRANTED);
    expect(rows).toEqual([]);
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

  it('an override row referencing the revision leaves the source-file row byte-identical', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO central_needs_field_overrides
           (plan_revision_id, organization_id, target_entity, field_name, previous_value, final_value, override_reason, actor_id)
         VALUES ($1,$2,'line-placeholder','quantity','10','12','manual correction',$3)`,
        [revisionId, ORG_A, CWM_A_GRANTED],
      );
      const row = (await c.query(
        `SELECT original_filename, file_hash FROM central_needs_source_files WHERE id = $1`, [sourceFileId],
      )).rows[0];
      expect(row.original_filename).toBe('annual-needs-2027.xls');
      expect(row.file_hash).toBe(SOURCE_HASH);
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
});
