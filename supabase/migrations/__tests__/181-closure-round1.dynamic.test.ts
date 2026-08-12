/**
 * Migration 181 independent-closure correction round 1.
 *
 * Proves the exact operator artifact executes read-only on 001->180 and that
 * organization activation alone revalidates every live health-sector child.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 180000 });
const run = rigAvailable() ? describe : describe.skip;

const PREAPPLY = readFileSync(
  join(process.cwd(), 'docs/phoenix/r1-1-181-production-preapply-readonly.sql'),
  'utf8',
);

const errorOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (error: any) { return String(error?.message ?? error); }
  throw new Error('expected the operation to be rejected');
};

run('181 closure round 1 · exact Production pre-apply artifact', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 180 });
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('00000000-0000-0000-0000-810000000001','Ready','جاهز','pre-ready','care_institution','health_sector','active'),
        ('00000000-0000-0000-0000-810000000002','Legacy','قديم','pre-legacy','care_institution','health_sector','active'),
        ('00000000-0000-0000-0000-810000000003','Ambiguous','ملتبس','pre-ambiguous','care_institution','health_sector','active');
      INSERT INTO organization_facilities
        (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('00000000-0000-0000-0000-810000000011','00000000-0000-0000-0000-810000000002','primary_health_center','Legacy centre','مركز','active');
      INSERT INTO warehouses
        (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('00000000-0000-0000-0000-810000000021','00000000-0000-0000-0000-810000000001','Sector main','رئيسي','institution',NULL,true,'active'),
        ('00000000-0000-0000-0000-810000000022','00000000-0000-0000-0000-810000000002','Legacy depot','قديم','institution','00000000-0000-0000-0000-810000000011',true,'active'),
        ('00000000-0000-0000-0000-810000000023','00000000-0000-0000-0000-810000000003','Central','مركزي','central',NULL,true,'active');
    `));
  }, 240000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('executes the exact committed file inside a PostgreSQL READ ONLY transaction', async () => {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const result = await client.query(PREAPPLY);
      expect(Object.fromEntries(result.rows.map((row: any) => [row.code, row.classification])))
        .toEqual({
          'pre-ambiguous': 'AMBIGUOUS_STOP',
          'pre-legacy': 'SAFE_LEGACY_RECONCILABLE',
          'pre-ready': 'TARGET_READY',
        });
      expect(result.rows.find((row: any) => row.code === 'pre-legacy').operational_rows).toBe('0');
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('contains no SQL write/DDL command or procedural invocation', () => {
    const executable = PREAPPLY.replace(/^\s*--.*$/gm, '');
    expect(executable).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|DO)\b/i);
  });
});

type TopologySeed = (ids: Record<string, string>) => string;

run('181 closure round 1 · inactive-sector activation boundary', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => { rig = await buildRig({}); }, 240000);
  afterAll(async () => { if (rig) await rig.end(); });

  const canonicalMain = (ids: Record<string, string>) => `
    INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
    VALUES ('${ids.main}','${ids.org}','Sector main','رئيسي','institution',NULL,true,'active');`;
  const activeFacility = (ids: Record<string, string>, status = 'active') => `
    INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status)
    VALUES ('${ids.facility}','${ids.org}','primary_health_center','Centre','مركز','${status}');`;
  const validDepot = (ids: Record<string, string>) => `
    INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
    VALUES ('${ids.depot}','${ids.org}','Centre depot','مخزن','institution','${ids.facility}',false,'active');`;

  async function activationAttempt(
    seed: TopologySeed,
    options: { dropMainIndex?: boolean; dropDepotIndex?: boolean } = {},
  ): Promise<{ error: string | null; childrenUnchanged: boolean }> {
    const ids = {
      org: randomUUID(), facility: randomUUID(), facility2: randomUUID(),
      main: randomUUID(), depot: randomUUID(), depot2: randomUUID(), point: randomUUID(), point2: randomUUID(),
    };
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      if (options.dropMainIndex) {
        await client.query('DROP INDEX public.warehouses_one_active_main_per_org_uniq');
      }
      if (options.dropDepotIndex) {
        await client.query('DROP INDEX public.warehouses_one_active_depot_per_facility_uniq');
      }
      await client.query(`
        INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
        VALUES ($1,'Dormant sector','قطاع خامل',$2,'care_institution','health_sector','inactive')`,
      [ids.org, `activation-${ids.org.slice(0, 8)}`]);

      // Recreate a pre-181 dormant legacy state without firing the post-181
      // child guards. Constraints remain enabled unless a case explicitly
      // drops one index transactionally, and every change rolls back.
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(seed(ids));
      await client.query("SET LOCAL session_replication_role = 'origin'");

      const before = (await client.query(`
        SELECT jsonb_build_object(
          'facilities', (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]') FROM organization_facilities f WHERE f.organization_id=$1),
          'warehouses', (SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.id),'[]') FROM warehouses w WHERE w.organization_id=$1),
          'outlets', (SELECT coalesce(jsonb_agg(to_jsonb(dp) ORDER BY dp.id),'[]') FROM distribution_points dp WHERE dp.organization_id=$1)
        ) AS children`, [ids.org])).rows[0].children;

      await client.query('SAVEPOINT before_activation');
      let error: string | null = null;
      try {
        await client.query(`UPDATE organizations SET status='active' WHERE id=$1`, [ids.org]);
      } catch (caught: any) {
        error = String(caught?.message ?? caught);
        await client.query('ROLLBACK TO SAVEPOINT before_activation');
      }

      const after = (await client.query(`
        SELECT jsonb_build_object(
          'facilities', (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]') FROM organization_facilities f WHERE f.organization_id=$1),
          'warehouses', (SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.id),'[]') FROM warehouses w WHERE w.organization_id=$1),
          'outlets', (SELECT coalesce(jsonb_agg(to_jsonb(dp) ORDER BY dp.id),'[]') FROM distribution_points dp WHERE dp.organization_id=$1)
        ) AS children`, [ids.org])).rows[0].children;
      return { error, childrenUnchanged: JSON.stringify(before) === JSON.stringify(after) };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  const rejectedCases: Array<{
    label: string;
    seed: TopologySeed;
    options?: { dropMainIndex?: boolean; dropDepotIndex?: boolean };
  }> = [
    {
      label: 'canonical main plus an active central warehouse',
      seed: ids => `${canonicalMain(ids)}
        INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
        VALUES ('${ids.depot}','${ids.org}','Central','مركزي','central',NULL,false,'active');`,
    },
    {
      label: 'canonical main plus a facility-bound main depot',
      options: { dropMainIndex: true },
      seed: ids => `${activeFacility(ids)}${canonicalMain(ids)}
        INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
        VALUES ('${ids.depot}','${ids.org}','Bad main depot','مخزن','institution','${ids.facility}',true,'active');`,
    },
    {
      label: 'canonical main plus a depot on an inactive facility',
      seed: ids => `${activeFacility(ids, 'inactive')}${canonicalMain(ids)}${validDepot(ids)}`,
    },
    {
      label: 'canonical main plus a sector-level pharmacy',
      seed: ids => `${canonicalMain(ids)}
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${ids.point}','${ids.main}','${ids.org}','Pharmacy','صيدلية','pharmacy','active');`,
    },
    {
      label: 'canonical main plus a sector-level crash cabinet',
      seed: ids => `${canonicalMain(ids)}
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES ('${ids.point}','${ids.main}','${ids.org}','Cabinet','خزانة','crash_cabinet','active','emergency');`,
    },
    {
      label: 'canonical main plus a centre rescue cart',
      seed: ids => `${activeFacility(ids)}${canonicalMain(ids)}${validDepot(ids)}
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES ('${ids.point}','${ids.depot}','${ids.org}','Cart','عربة','rescue_cart','active','emergency');`,
    },
    {
      label: 'canonical main plus a crash cabinet without emergency context',
      seed: ids => `${activeFacility(ids)}${canonicalMain(ids)}${validDepot(ids)}
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${ids.point}','${ids.depot}','${ids.org}','Cabinet','خزانة','crash_cabinet','active');`,
    },
    {
      label: 'active centre depot with no sector main',
      seed: ids => `${activeFacility(ids)}${validDepot(ids)}`,
    },
    {
      label: 'duplicate active depots for one facility',
      options: { dropDepotIndex: true },
      seed: ids => `${activeFacility(ids)}${canonicalMain(ids)}${validDepot(ids)}
        INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
        VALUES ('${ids.depot2}','${ids.org}','Duplicate depot','مكرر','institution','${ids.facility}',false,'active');`,
    },
  ];

  for (const testCase of rejectedCases) {
    it(`rejects activation with ${testCase.label}, without rewriting a child row`, async () => {
      const result = await activationAttempt(testCase.seed, testCase.options);
      expect(result.error ?? '').toMatch(/health_sector_activation_requires_valid_topology/);
      expect(result.childrenUnchanged).toBe(true);
    });
  }

  it('allows activation with zero active warehouse topology', async () => {
    const result = await activationAttempt(ids => `
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
      VALUES ('${ids.main}','${ids.org}','Retired history','قديم','central',NULL,false,'inactive');`);
    expect(result.error).toBeNull();
    expect(result.childrenUnchanged).toBe(true);
  });

  it('allows activation with one main, valid depots, a pharmacy, and an emergency cabinet', async () => {
    const result = await activationAttempt(ids => `${activeFacility(ids)}${canonicalMain(ids)}${validDepot(ids)}
      INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${ids.point}','${ids.depot}','${ids.org}','Pharmacy','صيدلية','pharmacy','active',NULL),
        ('${ids.point2}','${ids.depot}','${ids.org}','Cabinet','خزانة','crash_cabinet','active','emergency');`);
    expect(result.error).toBeNull();
    expect(result.childrenUnchanged).toBe(true);
  });

  it('serializes warehouse, outlet, and facility mutations behind in-flight activation', async () => {
    const org = randomUUID(), facility = randomUUID(), main = randomUUID(), depot = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
        VALUES ($1,'Concurrent sector','قطاع متزامن',$2,'care_institution','health_sector','inactive')`,
      [org, `concurrent-${org.slice(0, 8)}`]);
      await c.query(`
        INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status)
        VALUES ($1,$2,'primary_health_center','Centre','مركز','active')`, [facility, org]);
      await c.query(`
        INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ($1,$3,'Main','رئيسي','institution',NULL,true,'active'),
          ($2,$3,'Depot','مخزن','institution',$4,false,'active')`, [main, depot, org, facility]);
    });

    const activating = await rig.pool.connect();
    const child = await rig.pool.connect();
    try {
      await activating.query('BEGIN');
      await activating.query(`UPDATE organizations SET status='active' WHERE id=$1`, [org]);
      const mutations: Array<() => Promise<unknown>> = [
        () => child.query(`
          INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
          VALUES ($1,'Concurrent warehouse','مخزن','central',NULL,false,'inactive')`, [org]),
        () => child.query(`
          INSERT INTO distribution_points (warehouse_id,organization_id,name,name_ar,point_type,status)
          VALUES ($1,$2,'Concurrent pharmacy','صيدلية','pharmacy','active')`, [depot, org]),
        () => child.query(`UPDATE organization_facilities SET status='inactive' WHERE id=$1`, [facility]),
      ];
      for (const mutate of mutations) {
        await child.query('BEGIN');
        await child.query(`SET LOCAL statement_timeout='750ms'`);
        const message = await errorOf(mutate);
        expect(message).toMatch(/statement timeout|canceling statement/i);
        await child.query('ROLLBACK');
      }
    } finally {
      await child.query('ROLLBACK').catch(() => {});
      await activating.query('ROLLBACK').catch(() => {});
      child.release();
      activating.release();
    }
  });
});
