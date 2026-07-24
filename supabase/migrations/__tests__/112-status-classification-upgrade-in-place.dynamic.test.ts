/**
 * STATUS-CLASSIFICATION-BOUNDARY-CORRECTION-112 — UPGRADE-IN-PLACE proof.
 *
 * The other 112 dynamic suite (112-status-classification-boundary-correction
 * .dynamic.test.ts) always builds a FRESH rig already including 112 — it never
 * exercises 112 running its DROP CONSTRAINT / ADD CONSTRAINT against a table
 * that already has real rows written under 111's OLD (narrower) constraint.
 * That upgrade-in-place path is exactly where a fragile constraint-lookup bug
 * would hide (see 112's file header: an earlier version of this migration
 * located the CHECK constraint via `pg_get_constraintdef() LIKE '%...IN%'`,
 * which matched nothing on a real Postgres because `x IN (...)` is rewritten
 * to `x = ANY (ARRAY[...])` before storage — caught only once this job
 * actually ran 112 for real).
 *
 * This suite: build the rig to exactly 111, seed rows through 111's own RPCs
 * (so they carry 111's real classification values, no 'unavailable' possible
 * yet), THEN apply 112's own file on top of that already-populated table, and
 * prove: the upgrade succeeds, the pre-existing rows remain valid (they never
 * needed 'unavailable' — a strict superset of allowed values is always
 * backward-compatible), and a FRESH prepare-report call after the upgrade now
 * produces 'unavailable' for a zero-balance material.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no disposable Postgres is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable, MIGRATIONS_DIR, shimSql } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000100002';
const WH = '00000000-0000-0000-0000-000000100102';
const WO = '00000000-0000-0000-0000-000000100402';

const MIGRATION_112_FILE = '112_phoenix_status_classification_boundary_correction.sql';

run('112 upgrade-in-place: apply on top of rows already written under 111', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let preUpgradeReportId: string;
  let preUpgradeLineId: string;

  beforeAll(async () => {
    // 1. Build the rig to 111 ONLY — 112 is not part of this chain yet.
    rig = await buildRig({ upTo: 111 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p112up-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p112up-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${WO}','p112up-wo@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);

      // 2. Seed a row through 111's OWN prepare-report RPC — a real report
      // line written under the OLD constraint, before 112 ever runs. A zero
      // on-hand material under 111 falls into 'scarce' or 'available'
      // (111 has no 'unavailable' branch at all) — whichever it is, it must
      // still be a valid row after 112 widens the list, since 112 only ADDS
      // an allowed value, never removes one.
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
         VALUES (gen_random_uuid(),$1,$2,'P112UP-preexisting',true,false,'B-pre',0,0,current_date + 30,0)`,
        [ORG, WH],
      );
    });

    const result = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_status_prepare_report($1) AS r`, [ORG]);
      return r.rows[0].r;
    }, { commit: true });
    preUpgradeReportId = result.report_id;

    const line = await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT id, suggested_classification FROM inventory_status_report_lines
          WHERE report_id = $1 AND scientific_name = 'P112UP-preexisting'`,
        [preUpgradeReportId],
      );
      return r.rows[0];
    });
    preUpgradeLineId = line.id;
    // Under 111 there is no 'unavailable' — confirm the pre-upgrade value is
    // one of 111's own (narrower) allowed values, not something already wide.
    expect(['available', 'scarce', 'surplus']).toContain(line.suggested_classification);

    // 3. Apply 112 directly on top of this already-populated database — the
    // exact upgrade-in-place path a real deploy performs.
    const raw = readFileSync(join(MIGRATIONS_DIR, MIGRATION_112_FILE), 'utf8');
    await rig.asAdmin(async (c: any) => {
      await c.query(shimSql(MIGRATION_112_FILE, raw));
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('112 applied cleanly on top of pre-existing rows (no constraint-lookup failure)', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT suggested_classification FROM inventory_status_report_lines WHERE id = $1`,
        [preUpgradeLineId],
      );
      expect(r.rows).toHaveLength(1);
    });
  });

  it('the pre-existing row (written under 111) is still valid after the widened constraint applies', async () => {
    await rig.asAdmin(async (c: any) => {
      // A no-op UPDATE re-checks the CHECK constraint against the CURRENT
      // stored value without changing it — proves the old value still
      // satisfies the new (strictly wider) allowed list.
      await expect(
        c.query(
          `UPDATE inventory_status_report_lines SET updated_at = now() WHERE id = $1`,
          [preUpgradeLineId],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('after the upgrade, a FRESH prepare-report call now classifies a zero-balance material as unavailable', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
         VALUES (gen_random_uuid(),$1,$2,'P112UP-postupgrade-zero',true,false,'B-post',0,0,current_date + 30,0)`,
        [ORG, WH],
      );
    });
    const result = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_status_prepare_report($1) AS r`, [ORG]);
      return r.rows[0].r;
    }, { commit: true });
    const line = await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT suggested_classification FROM inventory_status_report_lines
          WHERE report_id = $1 AND scientific_name = 'P112UP-postupgrade-zero'`,
        [result.report_id],
      );
      return r.rows[0];
    });
    expect(line.suggested_classification).toBe('unavailable');
  });

  it('an unknown/garbage classification value is rejected by the widened CHECK constraint, not silently accepted', async () => {
    await rig.asAdmin(async (c: any) => {
      await expect(
        c.query(
          `UPDATE inventory_status_report_lines SET classification = 'not_a_real_value' WHERE id = $1`,
          [preUpgradeLineId],
        ),
      ).rejects.toThrow(/violates check constraint/i);
      await expect(
        c.query(
          `UPDATE inventory_status_report_lines SET suggested_classification = 'also_bogus' WHERE id = $1`,
          [preUpgradeLineId],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });
  });

  it('the post-apply CHECK constraint definitions contain every required canonical value', async () => {
    await rig.asAdmin(async (c: any) => {
      const defs = await c.query(
        `SELECT pg_get_constraintdef(oid) def FROM pg_constraint
          WHERE conrelid = 'public.inventory_status_report_lines'::regclass AND contype = 'c'`,
      );
      const joined = defs.rows.map((r: any) => r.def).join(' | ');
      for (const value of ['available', 'unavailable', 'scarce', 'surplus', 'suspected_missing']) {
        expect(joined).toContain(value);
      }
    });
  });
});
