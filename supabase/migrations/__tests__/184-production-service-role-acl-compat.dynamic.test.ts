import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000, hookTimeout: 300000 });

const MIGRATION_184 = readFileSync(
  join(MIGRATIONS_DIR, '184_phoenix_canonical_supply_cycle.sql'),
  'utf8',
);

const section = (from: string, to: string): string => {
  const start = MIGRATION_184.indexOf(from);
  const end = MIGRATION_184.indexOf(to, start + from.length);
  expect(start, `${from} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${to} must exist after ${from}`).toBeGreaterThan(start);
  return MIGRATION_184.slice(start, end);
};

const executableOnly = (sql: string): string =>
  sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('184 · Production service-role ACL compatibility · static contract', () => {
  const verifyJ = executableOnly(section('-- J. The legacy exchange completion writer', '-- K.'));
  const verifyK = executableOnly(section('-- K.', '-- L.'));

  it('Verify-K pins browser/PostgREST principals only', () => {
    expect(verifyK).toMatch(/r\.rolname IN \('anon', 'authenticated'\)/);
    expect(verifyK).not.toMatch(/r\.rolname IN \([^)]*service_role[^)]*\)/);
    expect(verifyK).toContain("ARRAY['clear_port_availability']::text[]");
    expect(verifyK).toContain('client-reachable item_availability.quantity writers changed');
  });

  it('Verify-J remains stricter and still closes the retired exchange writer to service_role', () => {
    expect(verifyJ).toMatch(/r\.rolname IN \('anon', 'authenticated', 'service_role'\)/);
    expect(verifyJ).toContain('an external principal still reaches the retired exchange completion writer');
  });

  it('the source documents why service_role is intentionally different from a client principal', () => {
    const migration109 = readFileSync(
      join(MIGRATIONS_DIR, '109_phoenix_public_schema_default_privileges_lockdown.sql'),
      'utf8',
    );
    const migration085 = readFileSync(
      join(MIGRATIONS_DIR, '085_phoenix_revoke_manual_availability_writers.sql'),
      'utf8',
    );
    expect(migration109).toMatch(/GRANT EXECUTE ON FUNCTIONS TO service_role/);
    expect(migration085).toMatch(/service_role retains EXECUTE \(trusted server identity/);
  });
});

const run = rigAvailable() ? describe : describe.skip;

run('184 · Production service-role ACL compatibility · real 001→184 rig', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const asAdmin = (sql: string, params: unknown[] = []) =>
    rig.asAdmin((c: any) => c.query(sql, params));

  beforeAll(async () => {
    // Build exactly the already-applied Production ceiling first. The ordinary
    // disposable rig does not reproduce every Supabase platform ACL detail, so
    // explicitly reproduce the one that blocked the first Production apply:
    // service_role may execute the preserved owner/internal manual helper.
    rig = await buildRig({ upTo: 183 });

    await asAdmin(`
      GRANT EXECUTE ON FUNCTION public.phoenix_apply_manual_availability_movement_internal(
        uuid, text, integer, text, text
      ) TO service_role;
    `);

    const before = await asAdmin(`
      SELECT has_function_privilege(
        'service_role',
        'public.phoenix_apply_manual_availability_movement_internal(uuid,text,integer,text,text)'::regprocedure::oid,
        'EXECUTE'
      ) AS service_exec;
    `);
    expect(before.rows[0].service_exec).toBe(true);

    // This is the regression proof: the complete corrected migration must apply
    // successfully over the Production-shaped ACL instead of failing Verify-K.
    await asAdmin(MIGRATION_184);
  }, 300000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('preserves trusted service_role access to the legacy internal helper', async () => {
    const r = await asAdmin(`
      SELECT has_function_privilege(
        'service_role',
        'public.phoenix_apply_manual_availability_movement_internal(uuid,text,integer,text,text)'::regprocedure::oid,
        'EXECUTE'
      ) AS service_exec;
    `);
    expect(r.rows[0].service_exec).toBe(true);
  });

  it('still pins the client-reachable quantity-writer set to clear_port_availability only', async () => {
    const r = await asAdmin(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prokind = 'f'
        AND p.prosrc ~* 'UPDATE\\s+(public\\.)?item_availability\\s+SET\\s+quantity'
        AND EXISTS (
          SELECT 1 FROM pg_roles rr
          WHERE rr.rolname IN ('anon', 'authenticated')
            AND has_function_privilege(rr.oid, p.oid, 'EXECUTE')
        )
      ORDER BY p.proname;
    `);
    expect(r.rows.map((x: any) => x.proname)).toEqual(['clear_port_availability']);
  });

  it('keeps the retired exchange completion writer owner-only including service_role', async () => {
    const r = await asAdmin(`
      SELECT r.rolname,
             has_function_privilege(
               r.oid,
               'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)'::regprocedure::oid,
               'EXECUTE'
             ) AS can_exec
      FROM pg_roles r
      WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      ORDER BY r.rolname;
    `);
    expect(r.rows).toEqual([
      { rolname: 'anon', can_exec: false },
      { rolname: 'authenticated', can_exec: false },
      { rolname: 'service_role', can_exec: false },
    ]);
  });

  it('installs the R1.3 canonical capsules and all six write boundaries', async () => {
    const r = await asAdmin(`
      SELECT
        to_regprocedure('public._phoenix_assert_external_corridor_institution_root_v1(uuid,text)') IS NOT NULL AS external_capsule,
        to_regprocedure('public._phoenix_assert_local_procurement_root_v1(uuid)') IS NOT NULL AS procurement_capsule,
        (SELECT count(*)::int FROM pg_trigger t
          JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND NOT t.tgisinternal
            AND (c.relname,t.tgname) IN (
              ('procurement_orders','phoenix_procurement_order_root_guard'),
              ('warehouse_supply_routes','phoenix_supply_route_topology_guard'),
              ('warehouse_transfer_requests','phoenix_routed_forward_topology_guard'),
              ('warehouse_transfers','phoenix_routed_forward_topology_guard'),
              ('warehouse_return_requests','phoenix_routed_return_topology_guard'),
              ('warehouse_return_shipments','phoenix_routed_return_topology_guard')
            )) AS boundary_count;
    `);
    expect(r.rows[0]).toEqual({
      external_capsule: true,
      procurement_capsule: true,
      boundary_count: 6,
    });
  });
});
