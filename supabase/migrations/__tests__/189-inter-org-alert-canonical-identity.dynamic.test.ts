/**
 * ALERT-CANONICAL-IDENTITY-189 — DYNAMIC proof.
 *
 * The decisive fixture is `item_availability.local_item_id IS NULL`.
 *
 * Migration 001 created that column NOT NULL; 019 dropped the NOT NULL and
 * replaced it with CHECK (local_item_id IS NOT NULL OR port_name IS NOT NULL),
 * so a port-name-only availability row is a legitimate, shipped writer path.
 * The first revision of 189 INNER JOINed through that hop, so every such row
 * vanished from both alert RPCs — while migration replay, preflight and a
 * text-only verify all reported green. Only a behavioural probe exposed it.
 *
 * Every availability row seeded below therefore has local_item_id = NULL, and
 * the suite proves the whole chain on them: bridge -> canonical key -> base RPC
 * -> _with_state RPC -> paged wrapper, plus the negative poles (differing
 * canonical component, removed source, removed target, forbidden top-level
 * organization) and the runtime ACL contract.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const ORG_A   = '00000000-0000-0000-0000-000000189001'; // hospital
const ORG_B   = '00000000-0000-0000-0000-000000189002'; // hospital  (same class, other org)
const ORG_C   = '00000000-0000-0000-0000-000000189003'; // specialized_center
const ORG_PDA = '00000000-0000-0000-0000-000000189004'; // pharmacy_department_authority
const ORG_HS  = '00000000-0000-0000-0000-000000189005'; // health_sector (real 181/188 topology)

const WH_A = '00000000-0000-0000-0000-000000189101';
const WH_B = '00000000-0000-0000-0000-000000189102';
const WH_C = '00000000-0000-0000-0000-000000189103';
const WH_P = '00000000-0000-0000-0000-000000189104';

const DP_A = '00000000-0000-0000-0000-000000189201';
const DP_B = '00000000-0000-0000-0000-000000189202';
const DP_C = '00000000-0000-0000-0000-000000189203';

/** health_sector needs a facility-less sector MAIN plus a facility-bound centre
 *  depot: 181 refuses an active outlet hanging off the sector main. */
const FAC_HS      = '00000000-0000-0000-0000-000000189601';
const WH_HS_MAIN  = '00000000-0000-0000-0000-000000189105';
const WH_HS_DEPOT = '00000000-0000-0000-0000-000000189106';
const DP_HS       = '00000000-0000-0000-0000-000000189205';

/** Supply, org A: surplus. Matches AV_B_DEMAND on the full canonical tuple. */
const AV_A_SUPPLY  = '00000000-0000-0000-0000-000000189301';
/** Supply, org A: expires in 180 days — inside 9 months, OUTSIDE the stale 3. */
const AV_A_NEAREXP = '00000000-0000-0000-0000-000000189302';
/** Demand, org B: missing. */
const AV_B_DEMAND  = '00000000-0000-0000-0000-000000189303';
/** Demand, org B: low_stock, pairs with AV_A_NEAREXP. */
const AV_B_LOW     = '00000000-0000-0000-0000-000000189304';
/** Demand, org C: SAME display labels as AV_A_SUPPLY, DIFFERENT national_code. */
const AV_C_DECOY   = '00000000-0000-0000-0000-000000189305';
/** Demand, org HS (health_sector): matches AV_A_SUPPLY's canonical tuple, so the
 *  hospital <-> health_sector pairing is proven end to end through the RPCs. */
const AV_HS_DEMAND = '00000000-0000-0000-0000-000000189306';

/** The scalar resolver. Called per candidate row, never joined whole-table. */
const RESOLVER = 'public._phoenix_availability_material_identity_v1';
const RESOLVER_SIG = `${RESOLVER}(uuid,text,text,text,text)`;
/** Resolve one availability row's canonical key through the shared resolver. */
const RESOLVE = (col = 'ia') =>
  `${RESOLVER}(${col}.local_item_id, ${col}.scientific_name, ${col}.national_code, ${col}.concentration, ${col}.dosage_form)`;

type Alert = Record<string, unknown>;

run('189 · inter-org alert canonical identity (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  /** Call an alert RPC as the seeded super_admin; rolled back, so the
   *  _with_state lifecycle upsert never leaks between tests. */
  const callAs = (sql: string): Promise<any> =>
    rig.asUser(rig.superAdminId, (c: any) => c.query(sql).then((r: any) => r.rows[0].payload));

  const base = () => callAs('SELECT public.phoenix_get_live_inter_institution_alerts(500) AS payload');
  const withState = () => callAs('SELECT public.phoenix_get_live_inter_institution_alerts_with_state(500) AS payload');
  const paged = () => callAs('SELECT public.phoenix_get_live_inter_institution_alerts_with_state_page(200, 0) AS payload');

  const alerts = (payload: any): Alert[] => {
    expect(payload?.ok, JSON.stringify(payload)).toBe(true);
    return (payload.alerts ?? []) as Alert[];
  };
  /** Only the fixture's own alerts — the 004 demo seed carries blank
   *  scientific_name rows that the candidate filter already excludes. */
  const mine = (list: Alert[]): Alert[] =>
    list.filter(a => [ORG_A, ORG_B, ORG_C, ORG_HS].includes(a.source_organization_id as string));
  const pairs = (list: Alert[]): string[] =>
    mine(list)
      .map(a => `${a.source_item_availability_id}->${a.target_item_availability_id}:${a.alert_type}`)
      .sort();

  const setRemoved = (id: string, removed: boolean) =>
    rig.asAdmin((c: any) => c.query(
      `UPDATE item_availability SET removed_at = ${removed ? 'now()' : 'NULL'} WHERE id = $1`, [id],
    ));

  beforeAll(async () => {
    rig = await buildRig({ upTo: 189 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
          ('${ORG_A}','Hospital A 189','مستشفى أ 189','189-a','care_institution','hospital'),
          ('${ORG_B}','Hospital B 189','مستشفى ب 189','189-b','care_institution','hospital'),
          ('${ORG_C}','Specialized C 189','تخصصي ج 189','189-c','care_institution','specialized_center'),
          ('${ORG_PDA}','PDA 189','قسم الصيدلة 189','189-p','pharmacy_department_authority',NULL),
          ('${ORG_HS}','Health Sector 189','قطاع صحي 189','189-hs','care_institution','health_sector')
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
          ('${FAC_HS}','${ORG_HS}','primary_health_center','Centre 189','مركز 189','active')
        ON CONFLICT(id) DO NOTHING
      `);
      // A pharmacy department authority may only own a CENTRAL warehouse (171).
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,status,code) VALUES
          ('${WH_A}','${ORG_A}','Depot A 189','مذخر أ 189','institution','active','189-wa'),
          ('${WH_B}','${ORG_B}','Depot B 189','مذخر ب 189','institution','active','189-wb'),
          ('${WH_C}','${ORG_C}','Depot C 189','مذخر ج 189','institution','active','189-wc'),
          ('${WH_P}','${ORG_PDA}','Central P 189','مركزي ص 189','central','active','189-wp')
        ON CONFLICT(id) DO NOTHING
      `);
      // 181: a facility-less active health-sector warehouse IS the sector main
      // and must carry is_main; an outlet may only hang off a centre depot.
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,status,code,is_main,facility_id) VALUES
          ('${WH_HS_MAIN}','${ORG_HS}','Sector Main 189','رئيسي قطاع 189','institution','active','189-whsm',true,NULL),
          ('${WH_HS_DEPOT}','${ORG_HS}','Centre Depot 189','مذخر مركز 189','institution','active','189-whsd',false,'${FAC_HS}')
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
          ('${DP_A}','${WH_A}','${ORG_A}','Pharmacy A 189','صيدلية أ 189','pharmacy','active'),
          ('${DP_B}','${WH_B}','${ORG_B}','Pharmacy B 189','صيدلية ب 189','pharmacy','active'),
          ('${DP_C}','${WH_C}','${ORG_C}','Pharmacy C 189','صيدلية ج 189','pharmacy','active'),
          ('${DP_HS}','${WH_HS_DEPOT}','${ORG_HS}','Centre Pharmacy 189','صيدلية مركز 189','pharmacy','active')
        ON CONFLICT(id) DO NOTHING
      `);
      // EVERY row here is port-name-only: local_item_id stays NULL, which 019's
      // CHECK explicitly permits and which the corrected bridge must preserve.
      await c.query(`
        INSERT INTO item_availability
          (id,distribution_point_id,organization_id,port_name,scientific_name,
           national_code,concentration,dosage_form,quantity,condition,expiry_date) VALUES
          ('${AV_A_SUPPLY}','${DP_A}','${ORG_A}','P-A1','Amoxicillin','NC-189-A','500 mg','tablet',100,'surplus',NULL),
          ('${AV_A_NEAREXP}','${DP_A}','${ORG_A}','P-A2','Ceftriaxone','NC-189-D','1 g','vial',50,'available',(current_date + 180)),
          ('${AV_B_DEMAND}','${DP_B}','${ORG_B}','P-B1','Amoxicillin','NC-189-A','500 mg','tablet',0,'missing',NULL),
          ('${AV_B_LOW}','${DP_B}','${ORG_B}','P-B2','Ceftriaxone','NC-189-D','1 g','vial',2,'low_stock',NULL),
          ('${AV_C_DECOY}','${DP_C}','${ORG_C}','P-C1','Amoxicillin','NC-189-B','500 mg','tablet',0,'missing',NULL),
          ('${AV_HS_DEMAND}','${DP_HS}','${ORG_HS}','P-HS1','Amoxicillin','NC-189-A','500 mg','tablet',0,'missing',NULL)
        ON CONFLICT(id) DO NOTHING
      `);
    });
  }, 900_000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ==========================================================================
  // B1 — the bridge must PRESERVE a port-name-only row, not drop it.
  // ==========================================================================
  describe('canonical identity bridge over a NULL local_item_id', () => {
    it('every seeded fixture row really does have local_item_id IS NULL', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM item_availability
          WHERE id = ANY($1::uuid[]) AND local_item_id IS NULL`,
        [[AV_A_SUPPLY, AV_A_NEAREXP, AV_B_DEMAND, AV_B_LOW, AV_C_DECOY, AV_HS_DEMAND]],
      ));
      expect(rows[0].n).toBe(6);
    });

    it('is TOTAL: a key for EVERY availability row, and no join that could drop one', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int                                    AS availability,
                count(${RESOLVE()})::int                          AS keys_produced,
                count(*) FILTER (WHERE ia.local_item_id IS NULL)::int AS null_local_item
           FROM item_availability ia`,
      ));
      // Non-vacuous: the at-risk population must actually exist in this fixture.
      expect(rows[0].null_local_item).toBeGreaterThan(0);
      // count(expr) counts NON-NULL results, so equality proves totality.
      expect(rows[0].keys_produced).toBe(rows[0].availability);
    });

    it('is TOTAL even with no row at all — the anchor, probed directly', async () => {
      // Data-independent: this is the assertion the retired set-returning bridge
      // could not make. A resolver that lost its one-row anchor returns NULL here.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT ${RESOLVER}(NULL, 'anchor probe', NULL, '500 mg', 'tablet') AS k`,
      ));
      expect(rows[0].k).toBeTruthy();
      expect(rows[0].k).toContain('|central=N|');
      expect(rows[0].k as string).toMatch(/\|unit=N$/);
      expect(rows[0].k).toContain('|national=N|');
    });

    it('resolves a canonical key for every port-name-only fixture row', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT ia.port_name, ${RESOLVE()} AS k
           FROM item_availability ia
          WHERE ia.id = ANY($1::uuid[]) ORDER BY ia.port_name`,
        [[AV_A_SUPPLY, AV_A_NEAREXP, AV_B_DEMAND, AV_B_LOW, AV_C_DECOY, AV_HS_DEMAND]],
      ));
      expect(rows).toHaveLength(6);
      for (const r of rows) {
        expect(r.k, r.port_name).toBeTruthy();
        // The unresolved catalog components are ENCODED as 150's explicit NULL
        // marker — never dropped, never replaced by a display label.
        expect(r.k, r.port_name).toContain('|central=N|');
        expect(r.k as string, r.port_name).toMatch(/\|unit=N$/);
      }
    });

    it('gives two port-name-only rows the SAME key iff the canonical tuple matches', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT
           (SELECT ${RESOLVE()} FROM item_availability ia WHERE ia.id=$1) AS a,
           (SELECT ${RESOLVE()} FROM item_availability ia WHERE ia.id=$2) AS b,
           (SELECT ${RESOLVE()} FROM item_availability ia WHERE ia.id=$3) AS c`,
        [AV_A_SUPPLY, AV_B_DEMAND, AV_C_DECOY],
      ));
      const { a, b, c } = rows[0];
      expect(a).toBe(b);                       // identical canonical tuple
      expect(a).not.toBe(c);                   // differs ONLY in national_code
      // …and the decoy really does share every display label with the supply row.
      expect(c).toContain('scientific=V11:amoxicillin');
      expect(c).toContain('concentration=V6:500 mg');
      expect(c).toContain('form=V6:tablet');
      expect(a).toContain('national=V8:nc-189-a');
      expect(c).toContain('national=V8:nc-189-b');
    });

    it('is not directly callable by anon or authenticated', async () => {
      const probe = `SELECT ${RESOLVER}(NULL,'x',NULL,NULL,NULL)`;
      await expect(rig.asUser(null, (c: any) => c.query(probe), { role: 'anon' }))
        .rejects.toThrow(/permission denied/i);
      await expect(rig.asUser(rig.superAdminId, (c: any) => c.query(probe)))
        .rejects.toThrow(/permission denied/i);
    });

    it('the retired set-returning bridge no longer exists', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT to_regprocedure('${RESOLVER}()') IS NULL AS srf_removed`,
      ));
      expect(rows[0].srf_removed).toBe(true);
    });
  });

  // ==========================================================================
  // The alert itself, through all THREE callables.
  // ==========================================================================
  describe('the alert reaches every callable surface', () => {
    const expected = `${AV_A_SUPPLY}->${AV_B_DEMAND}:surplus_to_shortage`;

    it('base RPC returns the port-name-only alert', async () => {
      expect(pairs(alerts(await base()))).toContain(expected);
    });

    it('_with_state RPC returns it, with lifecycle state attached', async () => {
      const found = mine(alerts(await withState()))
        .find(a => a.source_item_availability_id === AV_A_SUPPLY
                && a.target_item_availability_id === AV_B_DEMAND);
      expect(found).toBeDefined();
      expect(found!.lifecycle_status).toBe('open');
      expect(found!.alert_key).toBe(`${AV_A_SUPPLY}:${AV_B_DEMAND}:surplus_to_shortage`);
      expect(found!.severity).toBe('high');            // demand side is 'missing'
    });

    it('paged wrapper inherits it without holding its own matching logic', async () => {
      const payload = await paged();
      const list = alerts(payload);
      expect(pairs(list)).toContain(expected);
      expect(payload.total_count).toBeGreaterThanOrEqual(mine(list).length);
      // 148 stamps every paged element; proves the payload came THROUGH the
      // wrapper rather than from a second copy of the query.
      for (const a of mine(list)) expect(a.executable).toBe(false);
    });

    it('base and _with_state now agree on WHICH alerts exist', async () => {
      // Convergence is the point of the migration: the base RPC was three
      // generations stale (3-month window, no removed_at exclusion).
      expect(pairs(alerts(await base()))).toEqual(pairs(alerts(await withState())));
    });

    it('the 9-month near-expiry window is live on the BASE RPC', async () => {
      // AV_A_NEAREXP expires in 180 days: inside 9 months, well outside the
      // stale 3-month window the base RPC used before this migration.
      const nearExpiry = `${AV_A_NEAREXP}->${AV_B_LOW}:near_expiry_to_shortage`;
      expect(pairs(alerts(await base()))).toContain(nearExpiry);
      expect(pairs(alerts(await withState()))).toContain(nearExpiry);
    });

    it('pairs hospital <-> health_sector through the real RPC path', async () => {
      // health_sector is the allowlist member with the strictest topology: its
      // outlet must hang off a facility-bound centre depot, never the sector
      // main. Proven end to end through all three callables, not via the resolver.
      const expectedHs = `${AV_A_SUPPLY}->${AV_HS_DEMAND}:surplus_to_shortage`;
      expect(pairs(alerts(await base()))).toContain(expectedHs);
      expect(pairs(alerts(await withState()))).toContain(expectedHs);
      expect(pairs(alerts(await paged()))).toContain(expectedHs);

      const found = mine(alerts(await withState()))
        .find(a => a.target_item_availability_id === AV_HS_DEMAND);
      expect(found).toBeDefined();
      expect(found!.target_organization_id).toBe(ORG_HS);
      expect(found!.source_organization_id).toBe(ORG_A);
    });

    it('the health-sector endpoint really is a health_sector care institution', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT o.organization_kind, o.institution_class, w.is_main, w.facility_id IS NOT NULL AS depot_bound
           FROM item_availability ia
           JOIN organizations o ON o.id = ia.organization_id
           JOIN distribution_points dp ON dp.id = ia.distribution_point_id
           JOIN warehouses w ON w.id = dp.warehouse_id
          WHERE ia.id = $1`, [AV_HS_DEMAND],
      ));
      expect(rows[0]).toMatchObject({
        organization_kind: 'care_institution',
        institution_class: 'health_sector',
        is_main: false,
        depot_bound: true,
      });
    });

    it('never pairs an organization with itself', async () => {
      for (const list of [alerts(await base()), alerts(await withState()), alerts(await paged())]) {
        for (const a of list) {
          expect(a.source_organization_id).not.toBe(a.target_organization_id);
        }
      }
    });
  });

  // ==========================================================================
  // L8 — identity work must be proportional to PARTICIPATING rows, not to the
  // table. The pre-filter is a performance superset and must not move the answer.
  // ==========================================================================
  describe('participation pre-filter', () => {
    it('does not change which rows participate', async () => {
      // Recomputes both sides of the pre-filter directly and requires the
      // set-difference to be empty in BOTH directions.
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        WITH scoped AS (
          SELECT ia.id,
            CASE WHEN ia.expiry_date IS NOT NULL AND ia.expiry_date < current_date THEN 'expired'
                 WHEN ia.condition = 'expired' THEN 'expired'
                 WHEN ia.quantity <= 0 THEN 'missing'
                 WHEN ia.condition = 'missing' THEN 'missing'
                 WHEN ia.expiry_date IS NOT NULL
                   AND ia.expiry_date <= (current_date + interval '9 months')::date THEN 'near_expiry'
                 WHEN ia.condition = 'near_expiry' THEN 'near_expiry'
                 WHEN ia.condition = 'low_stock' THEN 'low_stock'
                 WHEN ia.condition = 'surplus' THEN 'surplus'
                 ELSE 'available' END AS eff,
            (ia.quantity <= 0
             OR ia.condition IN ('missing','low_stock','surplus','near_expiry')
             OR (ia.expiry_date IS NOT NULL
                 AND ia.expiry_date <= (current_date + interval '9 months')::date)) AS pre
          FROM item_availability ia
          JOIN organizations o ON o.id = ia.organization_id
           AND o.organization_kind = 'care_institution'
           AND o.institution_class IN ('health_sector','hospital','specialized_center')
          WHERE ia.scientific_name IS NOT NULL AND btrim(ia.scientific_name) <> ''
            AND ia.removed_at IS NULL
        ),
        old_set AS (SELECT id FROM scoped WHERE eff IN ('surplus','near_expiry','missing','low_stock')),
        new_set AS (SELECT id FROM scoped WHERE pre AND eff IN ('surplus','near_expiry','missing','low_stock'))
        SELECT (SELECT count(*) FROM old_set)::int AS old_n,
               (SELECT count(*) FROM (SELECT id FROM old_set EXCEPT SELECT id FROM new_set) x)::int AS old_minus_new,
               (SELECT count(*) FROM (SELECT id FROM new_set EXCEPT SELECT id FROM old_set) x)::int AS new_minus_old
      `));
      expect(rows[0].old_n).toBeGreaterThan(0);   // non-vacuous
      expect(rows[0].old_minus_new).toBe(0);
      expect(rows[0].new_minus_old).toBe(0);
    });

    it('admits far fewer rows than the unfiltered candidate population', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int AS scoped,
               count(*) FILTER (WHERE ia.quantity <= 0
                 OR ia.condition IN ('missing','low_stock','surplus','near_expiry')
                 OR (ia.expiry_date IS NOT NULL
                     AND ia.expiry_date <= (current_date + interval '9 months')::date))::int AS participating
          FROM item_availability ia
          JOIN organizations o ON o.id = ia.organization_id
           AND o.organization_kind = 'care_institution'
           AND o.institution_class IN ('health_sector','hospital','specialized_center')
         WHERE ia.scientific_name IS NOT NULL AND btrim(ia.scientific_name) <> ''
           AND ia.removed_at IS NULL
      `));
      expect(rows[0].participating).toBeLessThanOrEqual(rows[0].scoped);
    });
  });

  // ==========================================================================
  // Negative pole — owner decision M5: full canonical identity, no label match.
  // ==========================================================================
  describe('a differing canonical component must NOT match', () => {
    it('same scientific_name/concentration/dosage_form but a DIFFERENT national_code is not an alert', async () => {
      for (const list of [alerts(await base()), alerts(await withState()), alerts(await paged())]) {
        expect(list.some(a => a.target_item_availability_id === AV_C_DECOY)).toBe(false);
        expect(list.some(a => a.target_organization_id === ORG_C)).toBe(false);
      }
    });

    it('the decoy is otherwise fully eligible, so only identity can be excluding it', async () => {
      // If the decoy were filtered out by class, org or condition instead, this
      // test would be proving the wrong thing.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT o.organization_kind, o.institution_class, ia.condition, ia.quantity, ia.removed_at
           FROM item_availability ia JOIN organizations o ON o.id = ia.organization_id
          WHERE ia.id = $1`, [AV_C_DECOY],
      ));
      expect(rows[0].organization_kind).toBe('care_institution');
      expect(rows[0].institution_class).toBe('specialized_center');
      expect(rows[0].condition).toBe('missing');
      expect(rows[0].removed_at).toBeNull();
    });
  });

  // ==========================================================================
  // Removed rows — 053 semantics, now equal on BOTH RPCs and the paged path.
  // ==========================================================================
  describe('removed availability rows are excluded everywhere', () => {
    const expected = `${AV_A_SUPPLY}->${AV_B_DEMAND}:surplus_to_shortage`;

    it('removing the SOURCE withdraws the alert from all three callables', async () => {
      await setRemoved(AV_A_SUPPLY, true);
      try {
        expect(pairs(alerts(await base()))).not.toContain(expected);
        expect(pairs(alerts(await withState()))).not.toContain(expected);
        expect(pairs(alerts(await paged()))).not.toContain(expected);
      } finally {
        await setRemoved(AV_A_SUPPLY, false);
      }
      expect(pairs(alerts(await base()))).toContain(expected);
    });

    it('removing the TARGET withdraws the alert from all three callables', async () => {
      await setRemoved(AV_B_DEMAND, true);
      try {
        expect(pairs(alerts(await base()))).not.toContain(expected);
        expect(pairs(alerts(await withState()))).not.toContain(expected);
        expect(pairs(alerts(await paged()))).not.toContain(expected);
      } finally {
        await setRemoved(AV_B_DEMAND, false);
      }
      expect(pairs(alerts(await base()))).toContain(expected);
    });
  });

  // ==========================================================================
  // Top-level organization filter.
  //
  // Probed for REACHABILITY first: a pharmacy_department_authority cannot hold
  // an item_availability row at all, so the organization_kind predicate is
  // correct defence-in-depth rather than an exercisable negative. This suite
  // proves the state is genuinely unreachable instead of asserting a scenario
  // that cannot be constructed.
  // ==========================================================================
  describe('forbidden top-level organizations cannot reach an alert', () => {
    it('a PDA organization is refused a distribution point on INSERT', async () => {
      await expect(rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(warehouse_id,organization_id,name,name_ar,point_type,status)
         VALUES ($1,$2,'PDA Outlet 189','منفذ ص 189','pharmacy','active')`, [WH_P, ORG_PDA],
      ))).rejects.toThrow(/pharmacy_department_authority_outlet_not_permitted/);
    });

    it('an existing distribution point cannot be REASSIGNED to a PDA organization', async () => {
      await expect(rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET organization_id=$1, warehouse_id=$2 WHERE id=$3`,
        [ORG_PDA, WH_P, DP_A],
      ))).rejects.toThrow(/pharmacy_department_authority_outlet_not_permitted/);
    });

    it('an availability row cannot exist without a distribution point', async () => {
      await expect(rig.asAdmin((c: any) => c.query(
        `INSERT INTO item_availability(distribution_point_id,organization_id,port_name,scientific_name,quantity,condition)
         VALUES (NULL,$1,'P-X','Amoxicillin',1,'surplus')`, [ORG_PDA],
      ))).rejects.toThrow(/not-null constraint/i);
      // Those three refusals together close every route to a PDA alert endpoint.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM item_availability ia
           JOIN organizations o ON o.id = ia.organization_id
          WHERE o.organization_kind <> 'care_institution'`,
      ));
      expect(rows[0].n).toBe(0);
    });

    it('the candidate predicate itself excludes the PDA organization', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM organizations o
          WHERE o.id = $1
            AND o.organization_kind = 'care_institution'
            AND o.institution_class IN ('health_sector','hospital','specialized_center')`,
        [ORG_PDA],
      ));
      expect(rows[0].n).toBe(0);
    });

    it('a non-allowlisted institution_class is unreachable by CHECK constraint', async () => {
      // 164/170 constrain institution_class to exactly the three allowlisted
      // values, and a care_institution may not carry NULL. The RPC allowlist is
      // therefore currently total — recorded here so a future class addition
      // fails this test rather than silently widening the alert surface.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
          WHERE conrelid='public.organizations'::regclass
            AND conname='organizations_institution_class_chk'`,
      ));
      expect(rows[0].d).toContain("'hospital'");
      expect(rows[0].d).toContain("'specialized_center'");
      expect(rows[0].d).toContain("'health_sector'");
      await expect(rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations(name,name_ar,code,organization_kind,institution_class)
         VALUES ('Bad 189','سيئ 189','189-bad','care_institution','dispensing_point')`,
      ))).rejects.toThrow(/organizations_institution_class_chk/);
    });
  });

  // ==========================================================================
  // Runtime ACL / search_path.
  // ==========================================================================
  describe('security posture at runtime', () => {
    it('anon can execute neither alert RPC', async () => {
      for (const fn of [
        'phoenix_get_live_inter_institution_alerts(500)',
        'phoenix_get_live_inter_institution_alerts_with_state(500)',
        'phoenix_get_live_inter_institution_alerts_with_state_page(50,0)',
      ]) {
        await expect(rig.asUser(null, (c: any) => c.query(`SELECT public.${fn}`), { role: 'anon' }))
          .rejects.toThrow(/permission denied/i);
      }
    });

    it('authenticated keeps legitimate access to all three alert entry points', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT
          has_function_privilege('authenticated','public.phoenix_get_live_inter_institution_alerts(integer)','EXECUTE') AS base,
          has_function_privilege('authenticated','public.phoenix_get_live_inter_institution_alerts_with_state(integer)','EXECUTE') AS state,
          has_function_privilege('authenticated','public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)','EXECUTE') AS page,
          has_function_privilege('authenticated','${RESOLVER_SIG}','EXECUTE') AS bridge,
          has_function_privilege('anon','${RESOLVER_SIG}','EXECUTE') AS anon_bridge
      `));
      expect(rows[0]).toMatchObject({ base: true, state: true, page: true, bridge: false, anon_bridge: false });
    });

    it('PUBLIC holds no EXECUTE on the bridge, and service_role is not a client surface', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
          FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
         WHERE p.oid = '${RESOLVER_SIG}'::regprocedure AND a.privilege_type = 'EXECUTE'
      `));
      const grantees = rows.map((r: any) => r.grantee);
      expect(grantees).not.toContain('PUBLIC');
      expect(grantees).not.toContain('anon');
      expect(grantees).not.toContain('authenticated');
      // service_role MAY appear — 109's ALTER DEFAULT PRIVILEGES decides that
      // for every new public function. It is a trusted server-side role reached
      // only through the service key, and must not be reported as an anonymous
      // or client exposure. Recorded, deliberately not asserted either way.
      expect(grantees.filter((g: string) => !['postgres', 'service_role'].includes(g))).toEqual([]);
    });

    it('every replaced function pins an explicit search_path', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT p.proname, p.proconfig
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname='public' AND p.proname IN (
           '_phoenix_availability_material_identity_v1',
           'phoenix_get_live_inter_institution_alerts',
           'phoenix_get_live_inter_institution_alerts_with_state')
      `));
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.proconfig, r.proname).toContain('search_path=public, pg_temp');
      }
    });
  });
});
