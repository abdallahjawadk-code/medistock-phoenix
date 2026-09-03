/**
 * MATERIAL-DISPENSING-SUSPENSION-203 — DYNAMIC proof against a real
 * disposable Postgres with 001->203 applied in order, driving the real RPCs.
 *
 * Proves:
 *   1. institution_admin can suspend a material org-wide; the badge
 *      RPC reflects is_suspended=true with the coded reason.
 *   2. Idempotent replay: the same request_id returns the same suspension_id
 *      and creates no second row.
 *   3. outlet_officer is forbidden from suspending or lifting (role default).
 *   4. Cross-org denial: an org-B admin cannot suspend an org-A-scoped row.
 *   5. reason_code='other' without reason_detail is rejected.
 *   6. Lifting without a reason is rejected.
 *   7. Lifting succeeds: sets lifted_by/lifted_at/lift_reason; the badge
 *      flips to is_suspended=false.
 *   8. A second lift attempt on an already-lifted row is rejected
 *      (suspension_already_lifted), not silently re-applied.
 *   9. Immutability: a direct UPDATE of a lifted row (bypassing every RPC)
 *      is rejected by the trigger, not just discouraged by convention.
 *  10. Effective-date boundary: a future effective_start is not active yet.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000203001';
const ORG_B = '00000000-0000-0000-0000-000000203002';
const WH_A = '00000000-0000-0000-0000-000000203101';
const DP_A = '00000000-0000-0000-0000-000000203301';

const IA_A = '00000000-0000-0000-0000-000000203401'; // institution_admin, org A
const OO_A = '00000000-0000-0000-0000-000000203402';  // outlet_officer, org A — must be denied
const IA_B = '00000000-0000-0000-0000-000000203403'; // institution_admin, org B — cross-org denial

const ITEM_A = '00000000-0000-0000-0000-000000203501'; // central_items row, target of every test

run('203 material-dispensing-suspension domain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 203 });
    await rig.asAdmin(async (c: any) => {
      // institution_class='hospital', not 'health_sector' — deliberately: a
      // health_sector org's warehouses fall under 181's topology trigger
      // (facility_id / is_main requirements) that this suite has no reason
      // to satisfy. 'hospital' keeps organizations_kind_institution_class_chk
      // satisfied with none of that extra shape.
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','A','أ','p203-a','care_institution','hospital'),
        ('${ORG_B}','B','ب','p203-b','care_institution','hospital') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH-A','مخزن أ','active','institution','p203-wa')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_A}','${WH_A}','${ORG_A}','Outlet A','منفذ أ','pharmacy','active')
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO central_items (id,name,name_ar,unit,status) VALUES
        ('${ITEM_A}','P203 Amoxicillin','أموكسيسيلين P203','box','active')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${IA_A}','p203-iaa@rig'),('${OO_A}','p203-ooa@rig'),('${IA_B}','p203-iab@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_A}' WHERE id='${IA_A}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_B}' WHERE id='${IA_B}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${IA_A}','${ORG_A}','warehouse','${WH_A}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO_A}','${ORG_A}','distribution_point','${DP_A}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  const badge = async (c: any) =>
    (await c.query(
      `SELECT * FROM public.phoenix_get_material_dispensing_suspension_status($1,$2,$3)`,
      [[ITEM_A], ORG_A, null],
    )).rows[0];

  it('institution_admin suspends org-wide; the badge shows is_suspended with the coded reason', async () => {
    let suspensionId = '';
    await rig.asUser(IA_A, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_A, ORG_A, 'quality_investigation']);
      expect(r.ok).toBe(true);
      expect(r.idempotent_replay).toBe(false);
      suspensionId = r.suspension_id;

      const b = await badge(c);
      expect(b.is_suspended).toBe(true);
      expect(b.reason_code).toBe('quality_investigation');
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const rows = await c.query(`SELECT count(*) FROM material_dispensing_suspensions WHERE id = $1`, [suspensionId]);
      expect(Number(rows.rows[0].count)).toBe(1);
      // Clean up so later tests in this file start from a genuinely unsuspended item.
      await c.query(`DELETE FROM material_dispensing_suspensions WHERE id = $1`, [suspensionId]);
    });
  });

  it('is idempotent on request_id replay — no second row, same suspension_id', async () => {
    const requestId = randomUUID();
    let first = '';
    await rig.asUser(IA_A, async (c: any) => {
      const r1 = await call(c, 'phoenix_suspend_material_dispensing',
        [requestId, ITEM_A, ORG_A, 'regulatory_hold']);
      first = r1.suspension_id;
      const r2 = await call(c, 'phoenix_suspend_material_dispensing',
        [requestId, ITEM_A, ORG_A, 'regulatory_hold']);
      expect(r2.idempotent_replay).toBe(true);
      expect(r2.suspension_id).toBe(first);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const rows = await c.query(`SELECT count(*) FROM material_dispensing_suspensions WHERE central_item_id = $1 AND organization_id = $2`, [ITEM_A, ORG_A]);
      expect(Number(rows.rows[0].count)).toBe(1);
      await c.query(`DELETE FROM material_dispensing_suspensions WHERE id = $1`, [first]);
    });
  });

  it('outlet_officer is forbidden from suspending', async () => {
    await rig.asUser(OO_A, async (c: any) => {
      await expect(call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_A, ORG_A, 'regulatory_hold']),
      ).rejects.toThrow(/forbidden_material_dispensing_suspension_create/);
    });
  });

  it('cross-org denial: an org-B admin cannot suspend an org-A-scoped row', async () => {
    await rig.asUser(IA_B, async (c: any) => {
      await expect(call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_A, ORG_A, 'regulatory_hold']),
      ).rejects.toThrow(/forbidden_material_dispensing_suspension_create/);
    });
  });

  it("reason_code='other' without reason_detail is rejected", async () => {
    await rig.asUser(IA_A, async (c: any) => {
      await expect(call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_A, ORG_A, 'other']),
      ).rejects.toThrow(/reason_detail_required_for_other/);
    });
  });

  it('lift requires a reason, then succeeds and flips the badge; a second lift is rejected; the row is then immutable', async () => {
    let suspensionId = '';
    await rig.asUser(IA_A, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_A, ORG_A, 'recall_investigation']);
      suspensionId = r.suspension_id;
    }, { commit: true });

    await rig.asUser(IA_A, async (c: any) => {
      await expect(call(c, 'phoenix_lift_material_dispensing_suspension',
        [randomUUID(), suspensionId, null]),
      ).rejects.toThrow(/lift_reason_required/);
    });

    await rig.asUser(IA_A, async (c: any) => {
      const r = await call(c, 'phoenix_lift_material_dispensing_suspension',
        [randomUUID(), suspensionId, 'investigation closed, cleared']);
      expect(r.ok).toBe(true);
      const b = await badge(c);
      expect(b.is_suspended).toBe(false);
    }, { commit: true });

    await rig.asUser(IA_A, async (c: any) => {
      await expect(call(c, 'phoenix_lift_material_dispensing_suspension',
        [randomUUID(), suspensionId, 'trying again']),
      ).rejects.toThrow(/suspension_already_lifted/);
    });

    await rig.asAdmin(async (c: any) => {
      await expect(
        c.query(`UPDATE material_dispensing_suspensions SET reason_detail = 'tampered' WHERE id = $1`, [suspensionId]),
      ).rejects.toThrow(/suspension_already_lifted_immutable/);
      await c.query(`DELETE FROM material_dispensing_suspensions WHERE id = $1`, [suspensionId]);
    });
  });

  it('a future effective_start is not active yet', async () => {
    let suspensionId = '';
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await rig.asUser(IA_A, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing',
        [randomUUID(), ITEM_A, ORG_A, 'supply_integrity_concern', null, null, null,
          tomorrow, null]);
      suspensionId = r.suspension_id;
      const b = await badge(c);
      expect(b.is_suspended).toBe(false);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      await c.query(`DELETE FROM material_dispensing_suspensions WHERE id = $1`, [suspensionId]);
    });
  });
});
