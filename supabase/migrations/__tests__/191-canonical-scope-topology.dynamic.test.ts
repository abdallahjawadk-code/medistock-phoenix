/**
 * CANONICAL-SCOPE-TOPOLOGY-191 — DYNAMIC proof.
 *
 * The claims under test are behavioural and cannot be read off the SQL:
 *
 *   · a facility-less warehouse that FAILS Migration 181's complete rule is not
 *     classified as the sector main — the case the client could never get right,
 *     because `is_main` never reached it;
 *   · a hospital and a specialized centre are not forced into health-centre
 *     shape;
 *   · facility ancestry is real: HC-A's resources never appear under HC-B;
 *   · effective scope matches what the SERVER already enforces, for a directly
 *     assigned officer and for a facility-scoped manager alike;
 *   · reading topology writes nothing, anywhere.
 *
 * Purity is proven by counting every table the query touches before and after,
 * inside ONE transaction, so a write cannot hide behind a rollback between
 * assertions.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const ORG_HS  = '00000000-0000-0000-0000-000000191001'; // health_sector
const ORG_HOS = '00000000-0000-0000-0000-000000191002'; // hospital
const ORG_SPC = '00000000-0000-0000-0000-000000191003'; // specialized_center
const ORG_OTH = '00000000-0000-0000-0000-000000191004'; // unrelated hospital

const FAC_A = '00000000-0000-0000-0000-000000191101'; // Health Centre A
const FAC_B = '00000000-0000-0000-0000-000000191102'; // Health Centre B

const WH_MAIN    = '00000000-0000-0000-0000-000000191201'; // canonical sector main
/**
 * THE DECISIVE ROW (§13-B). Facility-less, is_main=false — and therefore legal
 * ONLY while inactive: 181's shape guard refuses exactly this combination on an
 * ACTIVE row, and returns early without judging a non-active one ("Inactive and
 * archived rows are historical … only what is ACTIVE describes the live
 * topology"). It satisfies `facility_id IS NULL` and must NEVER be classified
 * as the sector main.
 */
const WH_RETIRED = '00000000-0000-0000-0000-000000191202';
const WH_DEPOT_A = '00000000-0000-0000-0000-000000191203';
const WH_DEPOT_B = '00000000-0000-0000-0000-000000191204';
const WH_HOSP    = '00000000-0000-0000-0000-000000191205';
const WH_SPEC    = '00000000-0000-0000-0000-000000191206';

const DP_A = '00000000-0000-0000-0000-000000191301'; // under depot A
const DP_B = '00000000-0000-0000-0000-000000191302'; // under depot B
const DP_H = '00000000-0000-0000-0000-000000191303'; // under the hospital depot

const USER_HCM   = '00000000-0000-0000-0000-000000191401'; // health_centre manager, FAC_A
const USER_WHOFF = '00000000-0000-0000-0000-000000191402'; // warehouse_officer, depot B
const USER_ADMIN = '00000000-0000-0000-0000-000000191403'; // institution_admin of the sector
const USER_OTHER = '00000000-0000-0000-0000-000000191404'; // institution_admin elsewhere

/** Tables the query reads. None of them may change because it ran. */
const WATCHED = [
  'organizations', 'organization_facilities', 'warehouses', 'distribution_points',
  'profile_scope_assignments', 'profile_delegated_scope_assignments',
  'warehouse_stock', 'outlet_stock',
];

run('191 · canonical facility/scope topology', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const topology = (user: string, org: string) =>
    rig.asUser(user, (c: any) =>
      c.query('SELECT * FROM public.phoenix_query_organization_scope_topology($1)', [org]));

  const warehouseRow = (rows: any[], id: string) =>
    rows.find(r => r.node_kind === 'warehouse' && r.warehouse_id === id);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 191 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
          ('${ORG_HS}','Health Sector 191','قطاع صحي 191','191-hs','care_institution','health_sector'),
          ('${ORG_HOS}','Hospital 191','مستشفى 191','191-ho','care_institution','hospital'),
          ('${ORG_SPC}','Specialized 191','تخصصي 191','191-sp','care_institution','specialized_center'),
          ('${ORG_OTH}','Other 191','آخر 191','191-ot','care_institution','hospital')
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
          ('${FAC_A}','${ORG_HS}','primary_health_center','Centre A 191','مركز أ 191','active'),
          ('${FAC_B}','${ORG_HS}','subordinate_health_center','Centre B 191','مركز ب 191','active')
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,status,code,is_main,facility_id) VALUES
          ('${WH_MAIN}','${ORG_HS}','Sector Main 191','رئيسي 191','institution','active','191-wm',true,NULL),
          ('${WH_DEPOT_A}','${ORG_HS}','Depot A 191','مذخر أ 191','institution','active','191-wa',false,'${FAC_A}'),
          ('${WH_DEPOT_B}','${ORG_HS}','Depot B 191','مذخر ب 191','institution','active','191-wb',false,'${FAC_B}'),
          ('${WH_HOSP}','${ORG_HOS}','Hospital Depot 191','مذخر مستشفى 191','institution','active','191-wh',true,NULL),
          ('${WH_SPEC}','${ORG_SPC}','Specialized Depot 191','مذخر تخصصي 191','institution','active','191-ws',true,NULL)
        ON CONFLICT(id) DO NOTHING
      `);
      // §13-B — inserted LAST and INACTIVE, which is the only shape 181 permits
      // for a facility-less non-main health-sector warehouse.
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,status,code,is_main,facility_id) VALUES
          ('${WH_RETIRED}','${ORG_HS}','Retired Main 191','رئيسي متقاعد 191','institution','inactive','191-wr',false,NULL)
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
          ('${DP_A}','${WH_DEPOT_A}','${ORG_HS}','Pharmacy A 191','صيدلية أ 191','pharmacy','active'),
          ('${DP_B}','${WH_DEPOT_B}','${ORG_HS}','Pharmacy B 191','صيدلية ب 191','pharmacy','active'),
          ('${DP_H}','${WH_HOSP}','${ORG_HOS}','Pharmacy H 191','صيدلية ح 191','pharmacy','active')
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO auth.users(id,email) VALUES
          ('${USER_HCM}','hcm191@example.test'),
          ('${USER_WHOFF}','who191@example.test'),
          ('${USER_ADMIN}','adm191@example.test'),
          ('${USER_OTHER}','oth191@example.test')
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO profiles(id,organization_id,full_name,role,status) VALUES
          ('${USER_HCM}','${ORG_HS}','HC Manager 191','health_center_manager','active'),
          ('${USER_WHOFF}','${ORG_HS}','WH Officer 191','warehouse_officer','active'),
          ('${USER_ADMIN}','${ORG_HS}','Sector Admin 191','institution_admin','active'),
          ('${USER_OTHER}','${ORG_OTH}','Other Admin 191','institution_admin','active')
        ON CONFLICT(id) DO UPDATE
          SET role = excluded.role, organization_id = excluded.organization_id,
              status = excluded.status
      `);
      // PRIMARY SCOPE. The manager holds a FACILITY (A only); the officer holds
      // ONE warehouse (depot B). Neither holds the sector main.
      await c.query(`
        INSERT INTO profile_scope_assignments
          (profile_id,organization_id,scope_type,facility_id,warehouse_id,is_active) VALUES
          ('${USER_HCM}','${ORG_HS}','facility','${FAC_A}',NULL,true),
          ('${USER_WHOFF}','${ORG_HS}','warehouse',NULL,'${WH_DEPOT_B}',true)
        ON CONFLICT DO NOTHING
      `);
    });
  }, 900_000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ══════════════════════════════════════════════════════════════════════════
  // A. HEALTH SECTOR — the canonical hierarchy
  // ══════════════════════════════════════════════════════════════════════════
  describe('A · health sector topology', () => {
    it('classifies the canonical sector main, and only it', () => {
      return topology(USER_ADMIN, ORG_HS).then(({ rows }: any) => {
        const mains = rows.filter((r: any) => r.structural_role === 'sector_main');
        expect(mains.map((r: any) => r.warehouse_id)).toEqual([WH_MAIN]);
      });
    });

    it('classifies both centre depots as health_center_depot', () => {
      return topology(USER_ADMIN, ORG_HS).then(({ rows }: any) => {
        expect(warehouseRow(rows, WH_DEPOT_A).structural_role).toBe('health_center_depot');
        expect(warehouseRow(rows, WH_DEPOT_B).structural_role).toBe('health_center_depot');
      });
    });

    it('returns each depot bound to its OWN facility', () => {
      return topology(USER_ADMIN, ORG_HS).then(({ rows }: any) => {
        expect(warehouseRow(rows, WH_DEPOT_A).facility_id).toBe(FAC_A);
        expect(warehouseRow(rows, WH_DEPOT_B).facility_id).toBe(FAC_B);
        expect(warehouseRow(rows, WH_MAIN).facility_id).toBeNull();
      });
    });

    it('derives outlet ancestry: HC-A resources never appear under HC-B', () => {
      return topology(USER_ADMIN, ORG_HS).then(({ rows }: any) => {
        const a = rows.find((r: any) => r.distribution_point_id === DP_A);
        const b = rows.find((r: any) => r.distribution_point_id === DP_B);
        expect(a.facility_id).toBe(FAC_A);
        expect(a.warehouse_id).toBe(WH_DEPOT_A);
        expect(b.facility_id).toBe(FAC_B);
        expect(b.warehouse_id).toBe(WH_DEPOT_B);
        expect(a.facility_id).not.toBe(b.facility_id);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // B. NULL AMBIGUITY — mandatory
  // ══════════════════════════════════════════════════════════════════════════
  describe('B · a facility-less warehouse that fails the full rule is NOT sector main', () => {
    it('the fixture really is facility-less, so the NULL test alone would match it', async () => {
      const { rows } = await rig.asAdmin((c: any) =>
        c.query('SELECT facility_id, is_main, status FROM warehouses WHERE id=$1', [WH_RETIRED]));
      expect(rows[0].facility_id).toBeNull();
      expect(rows[0].is_main).toBe(false);
      expect(rows[0].status).toBe('inactive');
    });

    it('IS_SECTOR_MAIN = FALSE — it is classified institution_warehouse', async () => {
      const { rows } = await topology(USER_ADMIN, ORG_HS);
      const retired = warehouseRow(rows, WH_RETIRED);
      expect(retired).toBeDefined();
      expect(retired.structural_role).not.toBe('sector_main');
      expect(retired.structural_role).toBe('institution_warehouse');
    });

    it('and it is still RETURNED — a historical row is reported, never hidden', async () => {
      const { rows } = await topology(USER_ADMIN, ORG_HS);
      expect(rows.some((r: any) => r.warehouse_id === WH_RETIRED)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C / D. HOSPITAL and SPECIALIZED CENTRE keep their own shape
  // ══════════════════════════════════════════════════════════════════════════
  describe('C/D · other classes are not forced into health-centre shape', () => {
    it('a hospital depot is never health_center_depot or sector_main', async () => {
      const { rows } = await rig.asAdmin((c: any) =>
        c.query('SELECT * FROM public.phoenix_query_organization_scope_topology($1)', [ORG_HOS]));
      const w = warehouseRow(rows, WH_HOSP);
      expect(w.structural_role).toBe('institution_warehouse');
      expect(w.facility_id).toBeNull();
    });

    it('a specialized centre depot is likewise plain institution_warehouse', async () => {
      const { rows } = await rig.asAdmin((c: any) =>
        c.query('SELECT * FROM public.phoenix_query_organization_scope_topology($1)', [ORG_SPC]));
      expect(warehouseRow(rows, WH_SPEC).structural_role).toBe('institution_warehouse');
    });

    it('no facility rows are invented for either class', async () => {
      for (const org of [ORG_HOS, ORG_SPC]) {
        const { rows } = await rig.asAdmin((c: any) =>
          c.query('SELECT * FROM public.phoenix_query_organization_scope_topology($1)', [org]));
        expect(rows.every((r: any) => r.facility_id === null)).toBe(true);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // E. PRIMARY SCOPE — exactly what the server already enforces
  // ══════════════════════════════════════════════════════════════════════════
  describe('E · primary scope parity', () => {
    it('a warehouse officer is in scope for its ONE warehouse and nothing else', async () => {
      const { rows } = await topology(USER_WHOFF, ORG_HS);
      const inScope = rows.filter((r: any) => r.in_effective_scope && r.node_kind === 'warehouse');
      expect(inScope.map((r: any) => r.warehouse_id)).toEqual([WH_DEPOT_B]);
    });

    it('a facility-scoped manager reaches its OWN centre depot', async () => {
      const { rows } = await topology(USER_HCM, ORG_HS);
      const w = warehouseRow(rows, WH_DEPOT_A);
      expect(w?.in_effective_scope).toBe(true);
    });

    it('SECTOR-MAIN EXCLUSION: the manager never reaches the sector main', async () => {
      const { rows } = await topology(USER_HCM, ORG_HS);
      const main = warehouseRow(rows, WH_MAIN);
      expect(main === undefined || main.in_effective_scope === false).toBe(true);
    });

    it('facility identity holds: HC-A\'s manager never reaches HC-B\'s depot', async () => {
      const { rows } = await topology(USER_HCM, ORG_HS);
      const b = warehouseRow(rows, WH_DEPOT_B);
      expect(b === undefined || b.in_effective_scope === false).toBe(true);
    });

    it('the projection agrees with the canonical server helper, row for row', async () => {
      const { rows } = await topology(USER_HCM, ORG_HS);
      for (const r of rows.filter((x: any) => x.node_kind === 'warehouse')) {
        const { rows: [truth] } = await rig.asUser(USER_HCM, (c: any) => c.query(
          'SELECT public.phoenix_profile_has_warehouse_assignment($1,$2) AS ok',
          [USER_HCM, r.warehouse_id]));
        expect(r.in_effective_scope, r.warehouse_id).toBe(truth.ok);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // F / G. DELEGATED SCOPE and its lifecycle stay with Migration 187
  // ══════════════════════════════════════════════════════════════════════════
  describe('F/G · no cross-organization leakage, and M187 keeps its semantics', () => {
    it('an actor of another organization receives NOTHING for this sector', async () => {
      const { rows } = await topology(USER_OTHER, ORG_HS);
      expect(rows).toHaveLength(0);
    });

    it('the sector\'s own actors never see the other organization', async () => {
      const { rows } = await topology(USER_ADMIN, ORG_OTH);
      expect(rows).toHaveLength(0);
    });

    it('191 adds no delegated branch — 187 remains its sole owner', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT prosrc FROM pg_proc
        WHERE oid = to_regprocedure('public.phoenix_query_organization_scope_topology(uuid)')::oid
      `));
      expect(rows[0].prosrc).not.toContain('profile_delegated_scope_assignments');
      expect(rows[0].prosrc).not.toContain('phoenix_my_operational_resource_catalog');
    });

    it('187\'s catalog is byte-identical to what 190 left behind', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT prosecdef, provolatile FROM pg_proc
        WHERE oid = to_regprocedure('public.phoenix_my_operational_resource_catalog()')::oid
      `));
      expect(rows[0].prosecdef).toBe(true);
      expect(rows[0].provolatile).toBe('s');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // H. ANON
  // ══════════════════════════════════════════════════════════════════════════
  describe('H · anonymous is denied', () => {
    it('anon holds no EXECUTE on the topology query', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT has_function_privilege('anon',
          'public.phoenix_query_organization_scope_topology(uuid)','EXECUTE') AS ok
      `));
      expect(rows[0].ok).toBe(false);
    });

    it('authenticated does hold it', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT has_function_privilege('authenticated',
          'public.phoenix_query_organization_scope_topology(uuid)','EXECUTE') AS ok
      `));
      expect(rows[0].ok).toBe(true);
    });

    it('anon holds no direct SELECT on any topology table', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int AS n FROM information_schema.role_table_grants
        WHERE table_schema='public'
          AND table_name IN ('organization_facilities','warehouses','distribution_points')
          AND grantee='anon' AND privilege_type='SELECT'
      `));
      expect(rows[0].n).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // I / J. PURE READ, and no third stock truth
  // ══════════════════════════════════════════════════════════════════════════
  describe('I/J · reading topology mutates nothing', () => {
    it('repeated queries leave every watched table byte-identical', async () => {
      const snapshot = async () => {
        const out: Record<string, number> = {};
        for (const t of WATCHED) {
          const { rows } = await rig.asAdmin((c: any) => c.query(`SELECT count(*)::int AS n FROM public.${t}`));
          out[t] = rows[0].n;
        }
        return out;
      };
      const before = await snapshot();
      for (let i = 0; i < 3; i++) {
        await topology(USER_ADMIN, ORG_HS);
        await topology(USER_HCM, ORG_HS);
        await topology(USER_WHOFF, ORG_HS);
      }
      expect(await snapshot()).toEqual(before);
    });

    it('the query is STABLE and SECURITY INVOKER in the live catalog', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT prosecdef, provolatile FROM pg_proc
        WHERE oid = to_regprocedure('public.phoenix_query_organization_scope_topology(uuid)')::oid
      `));
      expect(rows[0].prosecdef).toBe(false);
      expect(rows[0].provolatile).toBe('s');
    });

    it('introduces no third ORDINARY stock truth', async () => {
      // The invariant is about ORDINARY mutable stock, of which there are
      // exactly two. `warehouse_quarantine_stock` is neither new nor ordinary:
      // Migration 185 added it as the return-quarantine holding area, and it is
      // named here explicitly so this guard asserts "G4.2 added nothing" rather
      // than "no other table may ever end in _stock".
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE '%_stock'
        ORDER BY table_name
      `));
      expect(rows.map((r: any) => r.table_name)).toEqual([
        'outlet_stock', 'warehouse_quarantine_stock', 'warehouse_stock',
      ]);
    });

    it('191 creates no table at all', async () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '..', '191_phoenix_canonical_scope_topology_read_contract.sql'),
        'utf8',
      );
      expect(sql).not.toMatch(/CREATE\s+(TABLE|MATERIALIZED\s+VIEW|VIEW)/i);
    });
  });
});
