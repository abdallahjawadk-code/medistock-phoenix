/**
 * RETIRE-INTER-ORG-EXCHANGE-STATUS-WRITER-153 — disposable PostgreSQL proof.
 *
 * Runs against a real 001->152 replay, drives every fail-closed branch inside
 * an outer rollback, then applies 153 once and proves the privilege-only delta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe.sequential : describe.skip;
const ROOT = join(__dirname, '../../../');
const MIGRATION = readFileSync(
  join(
    ROOT,
    'supabase/migrations/153_phoenix_retire_inter_org_exchange_status_writer.sql',
  ),
  'utf8',
);
const SIGNATURE =
  'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)';

const ORG_SOURCE = '00000000-0000-0000-0000-000000a21531';
const ORG_TARGET = '00000000-0000-0000-0000-000000a21532';
const DP_SOURCE = '00000000-0000-0000-0000-000000a21541';
const DP_TARGET = '00000000-0000-0000-0000-000000a21542';
const AVAIL_SOURCE = '00000000-0000-0000-0000-000000a21551';
const AVAIL_TARGET = '00000000-0000-0000-0000-000000a21552';
const REQUEST = '00000000-0000-0000-0000-000000a21561';

const DATA_GUARD_TABLES = [
  'organizations',
  'distribution_points',
  'inter_org_exchange_requests',
  'inter_org_exchange_events',
  'item_availability',
  'item_availability_movements',
  'warehouse_stock',
  'warehouse_stock_movements',
  'outlet_stock',
  'outlet_stock_movements',
  'warehouse_quarantine_stock',
  'warehouse_quarantine_stock_movements',
  'phoenix_movement_events',
] as const;

interface FunctionState {
  overload_count: number;
  signature: string;
  body_hash: string;
  definition_hash: string;
  security_definer: boolean;
  config: string[];
}

async function functionState(c: any): Promise<FunctionState> {
  const result = await c.query(
    `SELECT
       count(*) OVER ()::int AS overload_count,
       p.oid::regprocedure::text AS signature,
       md5(p.prosrc) AS body_hash,
       md5(pg_get_functiondef(p.oid)) AS definition_hash,
       p.prosecdef AS security_definer,
       p.proconfig AS config
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'phoenix_update_inter_org_exchange_status'
     ORDER BY p.oid`,
  );
  if (result.rows.length !== 1) {
    throw new Error(`expected one target function, found ${result.rows.length}`);
  }
  return result.rows[0] as FunctionState;
}

async function tableFingerprints(c: any): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const table of DATA_GUARD_TABLES) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table identifier: ${table}`);
    const result = await c.query(
      `SELECT count(*)::int AS row_count,
              md5(COALESCE(
                string_agg(row_text, E'\\n' ORDER BY row_text),
                ''
              )) AS row_hash
       FROM (
         SELECT to_jsonb(t)::text AS row_text
         FROM public.${table} AS t
       ) AS rows`,
    );
    out[table] = result.rows[0];
  }
  return out;
}

async function seedExchangeFixture(c: any, status: 'requested' | 'source_rejected') {
  await c.query(
    `INSERT INTO public.organizations (id, name, name_ar, code)
     VALUES
       ($1, 'A2 Source', 'A2 Source AR', 'A2SRC'),
       ($2, 'A2 Target', 'A2 Target AR', 'A2TGT')`,
    [ORG_SOURCE, ORG_TARGET],
  );
  await c.query(
    `INSERT INTO public.distribution_points (id, organization_id, name, name_ar)
     VALUES
       ($1, $2, 'A2 Source DP', 'A2 Source DP AR'),
       ($3, $4, 'A2 Target DP', 'A2 Target DP AR')`,
    [DP_SOURCE, ORG_SOURCE, DP_TARGET, ORG_TARGET],
  );
  await c.query(
    `INSERT INTO public.item_availability (
       id, distribution_point_id, organization_id, scientific_name,
       port_name, quantity, condition
     )
     VALUES
       ($1, $2, $3, 'A2 Legacy Material', 'A2 Source Port', 10, 'available'),
       ($4, $5, $6, 'A2 Legacy Material', 'A2 Target Port', 0, 'available')`,
    [AVAIL_SOURCE, DP_SOURCE, ORG_SOURCE, AVAIL_TARGET, DP_TARGET, ORG_TARGET],
  );
  await c.query(
    `INSERT INTO public.inter_org_exchange_requests (
       id, alert_key, source_item_availability_id, target_item_availability_id,
       source_organization_id, target_organization_id, scientific_name,
       requested_quantity, status, reason
     )
     VALUES ($1, 'a2-legacy', $2, $3, $4, $5, 'A2 Legacy Material',
             1, $6, $7)`,
    [
      REQUEST,
      AVAIL_SOURCE,
      AVAIL_TARGET,
      ORG_SOURCE,
      ORG_TARGET,
      status,
      status === 'source_rejected' ? 'retired before cutover' : null,
    ],
  );
}

run('153 legacy exchange writer retirement — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let baselineFunction: FunctionState;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 152 });
    baselineFunction = await rig.asAdmin(functionState);
  }, 90000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('fails atomically when the reviewed overload is absent', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await c.query(`DROP FUNCTION ${SIGNATURE}`);
        await expect(c.query(MIGRATION)).rejects.toThrow(
          /expected exactly one phoenix_update_inter_org_exchange_status overload/i,
        );
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await functionState(c)).toEqual(baselineFunction);
    });
  });

  it('fails atomically when an extra overload exists', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await c.query(
          `CREATE FUNCTION public.phoenix_update_inter_org_exchange_status(uuid)
           RETURNS jsonb
           LANGUAGE sql
           AS 'SELECT ''{}''::jsonb'`,
        );
        await expect(c.query(MIGRATION)).rejects.toThrow(
          /expected exactly one phoenix_update_inter_org_exchange_status overload/i,
        );
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await functionState(c)).toEqual(baselineFunction);
    });
  });

  it('refuses a live legacy request and rolls every attempted effect back', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await seedExchangeFixture(c, 'requested');
        await expect(c.query(MIGRATION)).rejects.toThrow(
          /live legacy exchange request\(s\) remain/i,
        );
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await functionState(c)).toEqual(baselineFunction);
      const rows = await c.query(
        'SELECT count(*)::int AS n FROM public.inter_org_exchange_requests',
      );
      expect(rows.rows[0].n).toBe(0);
    });
  });

  it('accepts a schema-defined terminal row and applies only the ACL retirement', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      await seedExchangeFixture(c, 'source_rejected');
      await c.query('COMMIT');

      await c.query(
        `GRANT ALL PRIVILEGES ON FUNCTION ${SIGNATURE}
         TO PUBLIC, anon, authenticated, service_role`,
      );

      const beforeFunction = await functionState(c);
      const beforeData = await tableFingerprints(c);

      await c.query(MIGRATION);

      const afterFunction = await functionState(c);
      const afterData = await tableFingerprints(c);

      expect(afterFunction).toEqual(beforeFunction);
      expect(afterData).toEqual(beforeData);
      expect(afterFunction.signature).toBe(
        'phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)',
      );
      expect(afterFunction.security_definer).toBe(true);
      expect(afterFunction.config).toEqual(['search_path=public']);
    });
  });

  it.each(['anon', 'authenticated', 'service_role'])(
    '%s receives permission denied without entering the body',
    async role => {
      await expect(
        rig.asUser(
          role === 'anon' ? null : rig.superAdminId,
          (c: any) =>
            c.query(
              `SELECT ${SIGNATURE.split('(')[0]}(
                 $1::uuid, $2::text, $3::integer, $4::integer, $5::text, $6::text
               )`,
              [REQUEST, 'requested', null, null, null, null],
            ),
          { role },
        ),
      ).rejects.toThrow(/permission denied for function/i);
    },
  );

  it('retains owner-only execution and no non-owner EXECUTE ACL', async () => {
    await rig.asAdmin(async (c: any) => {
      const result = await c.query(
        `SELECT
           pg_get_userbyid(p.proowner) AS owner,
           has_function_privilege(p.proowner, p.oid, 'EXECUTE') AS owner_exec,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'grantee',
                 CASE WHEN acl.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl.grantee)
                 END,
                 'privilege', acl.privilege_type
               )
               ORDER BY acl.grantee, acl.privilege_type
             ) FILTER (WHERE acl.privilege_type = 'EXECUTE'),
             '[]'::jsonb
           ) AS execute_acl
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl, acldefault('f', p.proowner))
         ) AS acl
         WHERE p.oid = $1::regprocedure
         GROUP BY p.proowner, p.oid`,
        [SIGNATURE],
      );
      expect(result.rows[0].owner_exec).toBe(true);
      expect(result.rows[0].execute_acl).toEqual([
        { grantee: result.rows[0].owner, privilege: 'EXECUTE' },
      ]);
    });
  });
});
