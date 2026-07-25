/**
 * MONTHLY-STATUS-DIRECT-WRITE-LOCKDOWN — DYNAMIC proof for migration 113,
 * against a real disposable Postgres with 001->113 applied in order.
 *
 * 113 closes the exact bug 108 already fixed for stocktakes/
 * stocktake_count_lines, but for 092's other three tables
 * (inventory_status_reports, inventory_status_report_lines,
 * inventory_status_report_amendments), and separately closes PUBLIC's
 * unrevoked default EXECUTE grant on 11 of 092's own RPC functions.
 *
 * This suite proves it LIVE, not just by reading the migration text:
 *   1. The exact privilege matrix after 001->113: authenticated has ONLY
 *      SELECT on the three tables; anon/PUBLIC have nothing on them.
 *   2. A genuine `SET LOCAL ROLE authenticated` session (no superuser
 *      escape hatch) is REJECTED attempting INSERT/UPDATE/DELETE/TRUNCATE on
 *      each of the three tables directly.
 *   3. The SAME authenticated session can still successfully complete the
 *      canonical RPC path (phoenix_status_prepare_report /
 *      phoenix_status_classify_lines) — the lockdown closes the bypass
 *      without breaking the intended, RPC-only write path.
 *   4. PUBLIC/anon EXECUTE is gone from every one of the 11 functions, while
 *      authenticated's EXECUTE remains.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no disposable Postgres is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000100003';
const WH = '00000000-0000-0000-0000-000000100103';
const WO = '00000000-0000-0000-0000-000000100403';

const LOCKED_TABLES = [
  'inventory_status_reports',
  'inventory_status_report_lines',
  'inventory_status_report_amendments',
];

const LOCKED_FUNCTIONS: Array<[string, string]> = [
  ['phoenix_status_center_authorized', '(uuid, text)'],
  ['phoenix_set_inventory_threshold_planning', '(uuid, integer, integer)'],
  ['phoenix_status_record_stocktake', '(uuid, text, uuid, text, jsonb)'],
  ['phoenix_status_prepare_report', '(uuid)'],
  ['phoenix_status_classify_lines', '(uuid, jsonb)'],
  ['phoenix_status_confirm_missing', '(uuid)'],
  ['phoenix_status_submit_report', '(uuid)'],
  ['phoenix_status_return_for_clarification', '(uuid, text)'],
  ['phoenix_status_approve_lock_report', '(uuid)'],
  ['phoenix_status_create_amendment', '(uuid, text)'],
  ['phoenix_status_get_outlet_contribution', '(uuid, uuid)'],
];

run('113 monthly-status direct-write lockdown — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 113 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p113-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p113-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${WO}','p113-wo@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('table privilege matrix: authenticated has ONLY SELECT on all three tables; anon/PUBLIC have nothing', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const table of LOCKED_TABLES) {
        const r = await c.query(
          `SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
             FROM information_schema.table_privileges
             WHERE table_schema='public' AND table_name=$1 AND grantee IN ('authenticated','anon','PUBLIC')
             GROUP BY grantee`,
          [table],
        );
        const byGrantee = Object.fromEntries(r.rows.map((row: any) => [row.grantee, row.privs]));
        expect(byGrantee.authenticated, `authenticated privileges on ${table}`).toBe('SELECT');
        expect(byGrantee.anon, `anon should have no rows for ${table}`).toBeUndefined();
        expect(byGrantee.PUBLIC, `PUBLIC should have no rows for ${table}`).toBeUndefined();
      }
    });
  });

  it('function EXECUTE matrix: authenticated retains EXECUTE; PUBLIC/anon do not, on every one of the 11 functions', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const [name, args] of LOCKED_FUNCTIONS) {
        const r = await c.query(
          `SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS auth_exec`,
          [`public.${name}${args}`],
        );
        expect(r.rows[0].auth_exec, `authenticated EXECUTE on ${name}`).toBe(true);

        const acl = await c.query(
          `SELECT a.grantee::regrole::text AS grantee, a.privilege_type
             FROM pg_proc p
             CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
             WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE'`,
          [`public.${name}${args}`],
        );
        const grantees = acl.rows.map((row: any) => row.grantee);
        expect(grantees, `no PUBLIC/anon EXECUTE grantee on ${name}`).not.toContain('anon');
        expect(grantees, `no PUBLIC/anon EXECUTE grantee on ${name}`).not.toContain('-'); // '-' = PUBLIC
      }
    });
  });

  it('live bypass attempt: a real authenticated session cannot INSERT/UPDATE/DELETE/TRUNCATE any of the three tables directly', async () => {
    for (const table of LOCKED_TABLES) {
      await rig.asUser(WO, async (c: any) => {
        await expect(
          c.query(`INSERT INTO ${table} DEFAULT VALUES`),
        ).rejects.toThrow(/permission denied/i);
      }, { commit: false });

      await rig.asUser(WO, async (c: any) => {
        // `id` is the one column every one of the three tables has (not all
        // three carry `updated_at`) — a self-assignment is a harmless no-op
        // value-wise, purely exercising the UPDATE privilege check itself.
        await expect(
          c.query(`UPDATE ${table} SET id = id`),
        ).rejects.toThrow(/permission denied/i);
      }, { commit: false });

      await rig.asUser(WO, async (c: any) => {
        await expect(
          c.query(`DELETE FROM ${table}`),
        ).rejects.toThrow(/permission denied/i);
      }, { commit: false });

      await rig.asUser(WO, async (c: any) => {
        await expect(
          c.query(`TRUNCATE TABLE ${table}`),
        ).rejects.toThrow(/permission denied/i);
      }, { commit: false });
    }
  });

  it('the canonical RPC path still succeeds for the same authenticated session the direct-write bypass rejected', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
         VALUES (gen_random_uuid(),$1,$2,'P113-rpc-still-works',true,false,'B-113',50,0,current_date + 30,0)`,
        [ORG, WH],
      );
    });
    const result = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_status_prepare_report($1) AS r`, [ORG]);
      return r.rows[0].r;
    }, { commit: true });
    expect(result.ok).toBe(true);

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM inventory_status_report_lines WHERE report_id = $1 AND scientific_name = 'P113-rpc-still-works'`,
        [result.report_id],
      );
      expect(r.rows[0].n).toBe(1);
    });
  });
});
