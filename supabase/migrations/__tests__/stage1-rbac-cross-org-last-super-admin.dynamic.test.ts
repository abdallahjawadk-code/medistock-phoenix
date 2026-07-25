/**
 * STAGE1-RBAC-CROSS-ORG-LAST-SUPER-ADMIN — DYNAMIC proof, against a real
 * disposable Postgres with 001->121 applied in order.
 *
 * Written as part of Stage 1 (reporting recovery / database parity) closing
 * verification, after the remote database was brought to full migration
 * parity through 121 and reduced to exactly one super_admin profile
 * (pre-launch cleanup). Proves three invariants directly, rather than relying
 * on inference from unrelated passing suites:
 *
 *   1. RLS cross-org denial: a profile scoped to one organization cannot
 *      SELECT another organization's warehouse_stock rows.
 *   2. Last-super-admin protection (093): with exactly one active
 *      super_admin, phoenix_lifecycle_reserve refuses to disable/delete them.
 *   3. institution_admin cross-org denial (093): an institution_admin cannot
 *      reserve a lifecycle transition against a profile in a different org.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-0000000fa001';
const ORG_B = '00000000-0000-0000-0000-0000000fa002';
const WH_A = '00000000-0000-0000-0000-0000000fa101';
const WH_B = '00000000-0000-0000-0000-0000000fa102';
const WO_A = '00000000-0000-0000-0000-0000000fa201'; // warehouse_officer, org A
const WO_B = '00000000-0000-0000-0000-0000000fa202'; // warehouse_officer, org B
const IA_A = '00000000-0000-0000-0000-0000000fa301'; // institution_admin, org A
const TARGET_B = '00000000-0000-0000-0000-0000000fa302'; // outlet_officer, org B
// The rig seeds exactly one active super_admin by default — the same
// invariant the real remote is now in (post pre-launch profile cleanup).
// A DB-level trigger (LAST_SUPER_ADMIN_PROTECTED) refuses even a raw UPDATE
// that would suspend/demote them, so this test uses the seeded admin
// directly rather than trying to manufacture a second one and suspend it.
const SOLE_SA = '00000000-0000-0000-0000-0000000000a1';

run('Stage 1 closing verification — cross-org RLS and last-super-admin — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let stockAId = '';
  let stockBId = '';

  beforeAll(async () => {
    rig = await buildRig({ upTo: 121 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_A}','Org A','منظمة أ','p1-orga'), ('${ORG_B}','Org B','منظمة ب','p1-orgb')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH A','مخزن أ','active','institution','p1-wha'),
        ('${WH_B}','${ORG_B}','WH B','مخزن ب','active','institution','p1-whb')
        ON CONFLICT (id) DO NOTHING;`);

      for (const [id, email] of [
        [WO_A, 'p1-woa@rig'], [WO_B, 'p1-wob@rig'], [IA_A, 'p1-iaa@rig'],
        [TARGET_B, 'p1-tb@rig'],
      ]) {
        await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING;`, [id, email]);
      }
      await c.query(`UPDATE profiles SET role='warehouse_officer', status='active', organization_id='${ORG_A}' WHERE id='${WO_A}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer', status='active', organization_id='${ORG_B}' WHERE id='${WO_B}';`);
      await c.query(`UPDATE profiles SET role='institution_admin', status='active', organization_id='${ORG_A}' WHERE id='${IA_A}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer', status='active', organization_id='${ORG_B}' WHERE id='${TARGET_B}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO_A}','${ORG_A}','warehouse','${WH_A}',true), ('${WO_B}','${ORG_B}','warehouse','${WH_B}',true)
        ON CONFLICT DO NOTHING;`);

      stockAId = randomUUID();
      stockBId = randomUUID();
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq, created_by, updated_by)
        VALUES
          ($1,$2,$3,'P1-STOCK-A',true,false,'B-P1A',5,0,0,$7,$7),
          ($4,$5,$6,'P1-STOCK-B',true,false,'B-P1B',5,0,0,$7,$7)`,
        [stockAId, ORG_A, WH_A, stockBId, ORG_B, WH_B, WO_A]);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('1. warehouse_officer in org A cannot SELECT org B warehouse_stock via RLS', async () => {
    await rig.asUser(WO_A, async (c: any) => {
      const r = await c.query(`SELECT id FROM warehouse_stock WHERE id = $1`, [stockBId]);
      expect(r.rows.length).toBe(0);
    });
  });

  it('1b. warehouse_officer in org A CAN SELECT their own org A warehouse_stock', async () => {
    await rig.asUser(WO_A, async (c: any) => {
      const r = await c.query(`SELECT id FROM warehouse_stock WHERE id = $1`, [stockAId]);
      expect(r.rows.length).toBe(1);
    });
  });

  it('2. phoenix_lifecycle_reserve refuses to act on the sole super_admin (target is platform-managed, denied before any last-admin check)', async () => {
    // institution_admin cannot reach the RPC's LAST_SUPER_ADMIN branch at all:
    // any super_admin target is refused earlier as "platform-managed", by
    // design (093). The RPC still returns the generic, non-leaking denial.
    await rig.asUser(IA_A, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_lifecycle_reserve($1, 'disable', $2) AS r`,
        [SOLE_SA, randomUUID()],
      );
      expect(r.rows[0].r.ok).toBe(false);
      expect(r.rows[0].r.error).toBe('REQUEST_DENIED');
    });
  });

  it('2b. a raw UPDATE attempting to suspend/demote the sole active super_admin is rejected by a DB-level trigger', async () => {
    // This is the invariant that actually protects the real remote today
    // (exactly one active super_admin, post pre-launch cleanup). It is
    // stronger than the RPC path: it fires on ANY write attempt, including
    // one that bypasses phoenix_lifecycle_reserve entirely, and does not
    // depend on a same-role actor existing (which — with only one active
    // super_admin — never can, since self-action is separately forbidden and
    // no other role is authorized to touch a super_admin target).
    await rig.asAdmin(async (c: any) => {
      await expect(
        c.query(`UPDATE profiles SET status = 'suspended' WHERE id = $1`, [SOLE_SA]),
      ).rejects.toThrow(/LAST_SUPER_ADMIN_PROTECTED/);
    });
  });

  it('2c. the sole active super_admin remains active and undeleted afterward', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT role, status FROM profiles WHERE id = $1`, [SOLE_SA]);
      expect(r.rows[0].role).toBe('super_admin');
      expect(r.rows[0].status).toBe('active');
    });
  });

  it('3. institution_admin in org A cannot reserve a lifecycle transition against an org B profile', async () => {
    const correlationId = randomUUID();
    // commit: true — the audit_logs row this RPC writes must persist so the
    // follow-up read (a separate asAdmin transaction) can observe it. asUser
    // rolls back by default to keep tests independent.
    await rig.asUser(IA_A, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_lifecycle_reserve($1, 'disable', $2) AS r`,
        [TARGET_B, correlationId],
      );
      expect(r.rows[0].r.ok).toBe(false);
      // _phoenix_lifecycle_deny returns a generic error to the caller and logs
      // the specific reason to audit_logs only (never leaks why to the actor).
      expect(r.rows[0].r.error).toBe('REQUEST_DENIED');
    }, { commit: true });
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT payload->>'reason' AS reason FROM audit_logs
         WHERE action = 'security.access_denied' AND (payload->>'correlation_id') = $1`,
        [correlationId],
      );
      expect(r.rows[0]?.reason).toBe('cross_org');
    });
  });
});
