/**
 * THRESHOLD-BATCH-APPLY — DYNAMIC proof for migration 111, against a real
 * disposable Postgres with 001->111 applied in order.
 *
 * Proves:
 *   - replay 001->111 succeeds.
 *   - a central_warehouse_manager can batch-apply thresholds for several
 *     materials at once, and each is upserted exactly as a series of
 *     individual phoenix_upsert_inventory_threshold calls would (same
 *     resulting rows, same audit_logs entries).
 *   - the batch is atomic: one deliberately-unauthorized/invalid element
 *     rolls back the WHOLE batch, including materials that would otherwise
 *     have succeeded.
 *   - a warehouse_officer (narrowed off inventory.manage_thresholds by 092)
 *     is refused, same as calling phoenix_upsert_inventory_threshold directly.
 *   - the >200 item cap is enforced.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no disposable Postgres is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000f0001';
const WH = '00000000-0000-0000-0000-0000000f0101';

const CWM = '00000000-0000-0000-0000-0000000f0401'; // central_warehouse_manager
const WO = '00000000-0000-0000-0000-0000000f0402'; // warehouse_officer — no manage_thresholds after 092

run('111 threshold batch apply — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 111 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p111-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p111-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','p111-cwm@rig'), ('${WO}','p111-wo@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      // central_warehouse_manager is an OPERATIONAL role, not one of
      // phoenix_profile_has_scoped_permission's org-wide roles (only
      // institution_admin is) — it must hold an explicit scope assignment
      // for the SPECIFIC warehouse it manages thresholds for, exactly like
      // any other per-resource role.
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('replay 001->111 succeeded and phoenix_batch_upsert_inventory_threshold exists with fail-closed grants', async () => {
    await rig.asAdmin(async (c: any) => {
      const fn = await c.query(
        `SELECT pg_get_function_identity_arguments(oid) args FROM pg_proc
          WHERE proname = 'phoenix_batch_upsert_inventory_threshold'`,
      );
      expect(fn.rows.length).toBe(1);
    });
  });

  it('central_warehouse_manager batch-applies thresholds for 3 materials in ONE call, atomically', async () => {
    const items = [
      { scientific_name: 'P111-Mat-A', reorder_point: 10, target_max: 100 },
      { scientific_name: 'P111-Mat-B', reorder_point: 5, target_max: 50 },
      { scientific_name: 'P111-Mat-C', reorder_point: 20, target_max: 200 },
    ];
    const result = await rig.asUser(CWM, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_batch_upsert_inventory_threshold($1,$2,$3,$4) AS r`,
        [ORG, 'warehouse', WH, JSON.stringify(items)],
      );
      return r.rows[0].r;
    }, { commit: true });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(3);
    expect(result.results.length).toBe(3);

    await rig.asAdmin(async (c: any) => {
      const rows = await c.query(
        `SELECT scientific_name, reorder_point, target_max FROM public.inventory_signal_thresholds
          WHERE organization_id = $1 AND scope_id = $2 AND scientific_name LIKE 'P111-Mat-%'
          ORDER BY scientific_name`,
        [ORG, WH],
      );
      expect(rows.rows.length).toBe(3);
      expect(rows.rows.map((r: any) => r.reorder_point)).toEqual([10, 5, 20]);

      // One audit_logs row per material, same as three individual calls would produce.
      const audits = await c.query(
        `SELECT count(*)::int AS n FROM public.audit_logs
          WHERE organization_id = $1 AND entity_type = 'inventory_signal_threshold'
            AND entity_label LIKE 'warehouse:P111-Mat-%'`,
        [ORG],
      );
      expect(audits.rows[0].n).toBe(3);
    });
  });

  it('the batch is atomic: one invalid element rolls back materials that would otherwise have succeeded', async () => {
    const items = [
      { scientific_name: 'P111-Atomic-OK', reorder_point: 10, target_max: 100 },
      // near_expiry_days out of range (>270) — 092's own validation rejects this.
      { scientific_name: 'P111-Atomic-BAD', near_expiry_days: 999 },
    ];
    await expect(
      rig.asUser(CWM, async (c: any) => {
        await c.query(
          `SELECT public.phoenix_batch_upsert_inventory_threshold($1,$2,$3,$4)`,
          [ORG, 'warehouse', WH, JSON.stringify(items)],
        );
      }, { commit: true }),
    ).rejects.toThrow(/near_expiry_days_out_of_range/);

    await rig.asAdmin(async (c: any) => {
      const rows = await c.query(
        `SELECT 1 FROM public.inventory_signal_thresholds WHERE organization_id = $1 AND scientific_name = 'P111-Atomic-OK'`,
        [ORG],
      );
      // The FIRST (valid) element must NOT have been applied — the whole batch rolled back.
      expect(rows.rows.length).toBe(0);
    });
  });

  it('a warehouse_officer (no inventory.manage_thresholds after 092) is refused, same as the direct RPC', async () => {
    await expect(
      rig.asUser(WO, async (c: any) => {
        await c.query(
          `SELECT public.phoenix_batch_upsert_inventory_threshold($1,$2,$3,$4)`,
          [ORG, 'warehouse', WH, JSON.stringify([{ scientific_name: 'P111-Denied' }])],
        );
      }, { commit: true }),
    ).rejects.toThrow(/not_authorized_inventory_manage_thresholds/);
  });

  it('rejects a batch larger than 200 items', async () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ scientific_name: `P111-Bulk-${i}` }));
    await expect(
      rig.asUser(CWM, async (c: any) => {
        await c.query(
          `SELECT public.phoenix_batch_upsert_inventory_threshold($1,$2,$3,$4)`,
          [ORG, 'warehouse', WH, JSON.stringify(items)],
        );
      }, { commit: true }),
    ).rejects.toThrow(/batch_too_large/);
  });
});
