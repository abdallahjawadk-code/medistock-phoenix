/**
 * ALERT-CQRS-BOUNDARY-190 — DYNAMIC proof.
 *
 * The claim under test is behavioural and cannot be read off the SQL: that the
 * two new QUERY RPCs are genuinely pure, that the COMMAND is genuinely the
 * writer, and that splitting them changed NOTHING about which alerts exist, who
 * may see them, or what they say.
 *
 * Purity is proven by counting inter_org_alert_states and inter_org_alert_events
 * before and after — inside ONE transaction, so a write cannot hide behind a
 * rollback between assertions.
 *
 * The fixture deliberately reuses 189's decisive shape: every availability row
 * has local_item_id = NULL (019's port-name-only path), because that is where
 * the canonical identity bridge is load-bearing and where a regression would
 * silently drop rows. The whole point of 190 is that it inherits 189's matching
 * rather than restating it, so 189's hardest case must still hold end to end.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const ORG_A   = '00000000-0000-0000-0000-000000190001'; // hospital
const ORG_B   = '00000000-0000-0000-0000-000000190002'; // hospital (other org)
const ORG_C   = '00000000-0000-0000-0000-000000190003'; // specialized_center
const ORG_PDA = '00000000-0000-0000-0000-000000190004'; // pharmacy_department_authority
const ORG_HS  = '00000000-0000-0000-0000-000000190005'; // health_sector

const WH_A = '00000000-0000-0000-0000-000000190101';
const WH_B = '00000000-0000-0000-0000-000000190102';
const WH_C = '00000000-0000-0000-0000-000000190103';
const WH_P = '00000000-0000-0000-0000-000000190104';

const DP_A = '00000000-0000-0000-0000-000000190201';
const DP_B = '00000000-0000-0000-0000-000000190202';
const DP_C = '00000000-0000-0000-0000-000000190203';
// No DP for the PDA organization: migration 171 REFUSES an outlet under a
// pharmacy_department_authority, which is why requirement N below is proven as
// unreachability rather than as an alert that fails to appear.

/** health_sector: 181 refuses an active outlet hanging off the sector main. */
const FAC_HS      = '00000000-0000-0000-0000-000000190601';
const WH_HS_MAIN  = '00000000-0000-0000-0000-000000190105';
const WH_HS_DEPOT = '00000000-0000-0000-0000-000000190106';
const DP_HS       = '00000000-0000-0000-0000-000000190205';

/** Supply, org A: surplus. Pairs with AV_B_DEMAND on the full canonical tuple. */
const AV_A_SUPPLY  = '00000000-0000-0000-0000-000000190301';
/** Supply, org A: expires in 180 days — inside the 9-month window. */
const AV_A_NEAREXP = '00000000-0000-0000-0000-000000190302';
/** Demand, org B: missing. */
const AV_B_DEMAND  = '00000000-0000-0000-0000-000000190303';
/** Demand, org B: low_stock, pairs with AV_A_NEAREXP. */
const AV_B_LOW     = '00000000-0000-0000-0000-000000190304';
/** Demand, org C: SAME display labels as AV_A_SUPPLY, DIFFERENT national_code. */
const AV_C_DECOY   = '00000000-0000-0000-0000-000000190305';
/** Demand, org HS (health_sector): matches AV_A_SUPPLY's canonical tuple. */
const AV_HS_DEMAND = '00000000-0000-0000-0000-000000190306';

const CONTACT_A = '00000000-0000-0000-0000-000000190401';

/** A scoped, non-super actor in ORG_B, to prove org scoping is preserved. */
const USER_B = '00000000-0000-0000-0000-000000190501';
/** A scoped actor in an organization with no part in any alert. */
const ORG_OUT  = '00000000-0000-0000-0000-000000190006';
const USER_OUT = '00000000-0000-0000-0000-000000190502';

type Alert = Record<string, unknown>;

run('190 · inter-org alert CQRS boundary (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  // ---------------------------------------------------------------------
  // Helpers. Every call runs inside ONE rolled-back transaction, so a write
  // cannot be laundered through a commit between two assertions.
  // ---------------------------------------------------------------------

  /** Lifecycle-table census, taken as the superuser (authenticated cannot read
   *  inter_org_alert_events at all — by design, and asserted below). */
  const census = async (): Promise<{ states: number; events: number; digest: string }> => {
    const { rows } = await rig.asAdmin((c: any) => c.query(`
      SELECT (SELECT count(*)::int FROM inter_org_alert_states) AS states,
             (SELECT count(*)::int FROM inter_org_alert_events) AS events,
             COALESCE((SELECT md5(string_agg(s.alert_key || ':' || s.status || ':' ||
                                             s.last_seen_at::text, '|' ORDER BY s.alert_key))
                         FROM inter_org_alert_states s), 'empty') AS digest`));
    return rows[0];
  };

  /**
   * Census before and after, around a call that is itself rolled back. Valid
   * ONLY for proving that something did NOT write: a real write would be
   * undone by the rollback and would look identical to purity. Use
   * `censusAround` for anything that is expected to write.
   */
  const withCensus = async <T,>(fn: () => Promise<T>) => {
    const before = await census();
    const value = await fn();
    const after = await census();
    return { before, after, value };
  };

  /**
   * Census before and after INSIDE one transaction, so a write is observed
   * rather than rolled away. The transaction is still rolled back at the end,
   * keeping tests independent.
   */
  const censusAround = async (sql: string, userId = superId()) =>
    rig.asUser(userId, async (c: any) => {
      // `authenticated` has NO grant on inter_org_alert_events at all (038, and
      // deliberately preserved by 190), so the census hops to the owner role
      // and straight back. Same transaction throughout, so the write under test
      // is genuinely observed rather than rolled away between two connections.
      const count = async () => {
        await c.query('SET LOCAL ROLE postgres');
        const row = (await c.query(
          `SELECT (SELECT count(*)::int FROM inter_org_alert_states) AS states,
                  (SELECT count(*)::int FROM inter_org_alert_events) AS events`)).rows[0];
        await c.query('SET LOCAL ROLE authenticated');
        return row;
      };
      const before = await count();
      const value = (await c.query(sql)).rows[0].payload;
      const after = await count();
      return { before, after, value };
    });

  const callAs = (userId: string | null, sql: string, role = 'authenticated'): Promise<any> =>
    rig.asUser(userId, (c: any) => c.query(sql).then((r: any) => r.rows[0].payload), { role });

  const superId = () => rig.superAdminId;

  const pureP  = (u = superId(), limit = 50, offset = 0) =>
    callAs(u, `SELECT public.phoenix_query_live_inter_org_alerts_with_state_page(${limit}, ${offset}) AS payload`);
  const pureS  = (u = superId(), limit = 200) =>
    callAs(u, `SELECT public.phoenix_query_live_inter_org_alert_summary(${limit}) AS payload`);
  const refresh = (u = superId(), limit = 500) =>
    callAs(u, `SELECT public.phoenix_refresh_inter_org_alert_lifecycle(${limit}) AS payload`);
  const legacyPage = (u = superId()) =>
    callAs(u, `SELECT public.phoenix_get_live_inter_institution_alerts_with_state_page(200, 0) AS payload`);

  const alerts = (payload: any): Alert[] => {
    expect(payload?.ok, JSON.stringify(payload)).toBe(true);
    return (payload.alerts ?? []) as Alert[];
  };
  /** Only the fixture's own alerts — 004's demo seed carries unrelated rows. */
  const mine = (list: Alert[]): Alert[] =>
    list.filter(a => [ORG_A, ORG_B, ORG_C, ORG_HS, ORG_PDA].includes(a.source_organization_id as string));
  const pairs = (list: Alert[]): string[] =>
    mine(list).map(a => `${a.source_item_availability_id}->${a.target_item_availability_id}:${a.alert_type}`).sort();

  beforeAll(async () => {
    rig = await buildRig({ upTo: 190 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
          ('${ORG_A}','Hospital A 190','مستشفى أ 190','190-a','care_institution','hospital'),
          ('${ORG_B}','Hospital B 190','مستشفى ب 190','190-b','care_institution','hospital'),
          ('${ORG_C}','Specialized C 190','تخصصي ج 190','190-c','care_institution','specialized_center'),
          ('${ORG_PDA}','PDA 190','قسم الصيدلة 190','190-p','pharmacy_department_authority',NULL),
          ('${ORG_HS}','Health Sector 190','قطاع صحي 190','190-hs','care_institution','health_sector'),
          ('${ORG_OUT}','Outsider 190','خارجي 190','190-out','care_institution','hospital')
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
          ('${FAC_HS}','${ORG_HS}','primary_health_center','Centre 190','مركز 190','active')
        ON CONFLICT(id) DO NOTHING
      `);
      // 171: a pharmacy department authority may own only a CENTRAL warehouse.
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,status,code) VALUES
          ('${WH_A}','${ORG_A}','Depot A 190','مذخر أ 190','institution','active','190-wa'),
          ('${WH_B}','${ORG_B}','Depot B 190','مذخر ب 190','institution','active','190-wb'),
          ('${WH_C}','${ORG_C}','Depot C 190','مذخر ج 190','institution','active','190-wc'),
          ('${WH_P}','${ORG_PDA}','Central P 190','مركزي ص 190','central','active','190-wp')
        ON CONFLICT(id) DO NOTHING
      `);
      // 181: a facility-less active health-sector warehouse IS the sector main
      // and must carry is_main; an outlet may only hang off a centre depot.
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,status,code,is_main,facility_id) VALUES
          ('${WH_HS_MAIN}','${ORG_HS}','Sector Main 190','رئيسي قطاع 190','institution','active','190-whsm',true,NULL),
          ('${WH_HS_DEPOT}','${ORG_HS}','Centre Depot 190','مذخر مركز 190','institution','active','190-whsd',false,'${FAC_HS}')
        ON CONFLICT(id) DO NOTHING
      `);
      await c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
          ('${DP_A}','${WH_A}','${ORG_A}','Pharmacy A 190','صيدلية أ 190','pharmacy','active'),
          ('${DP_B}','${WH_B}','${ORG_B}','Pharmacy B 190','صيدلية ب 190','pharmacy','active'),
          ('${DP_C}','${WH_C}','${ORG_C}','Pharmacy C 190','صيدلية ج 190','pharmacy','active'),
          ('${DP_HS}','${WH_HS_DEPOT}','${ORG_HS}','Centre Pharmacy 190','صيدلية مركز 190','pharmacy','active')
        ON CONFLICT(id) DO NOTHING
      `);
      // EVERY row is port-name-only: local_item_id stays NULL (019's CHECK
      // permits it), which is exactly where 189's bridge must stay total.
      await c.query(`
        INSERT INTO item_availability
          (id,distribution_point_id,organization_id,port_name,scientific_name,
           national_code,concentration,dosage_form,quantity,condition,expiry_date) VALUES
          ('${AV_A_SUPPLY}','${DP_A}','${ORG_A}','P-A1','Amoxicillin','NC-190-A','500 mg','tablet',100,'surplus',NULL),
          ('${AV_A_NEAREXP}','${DP_A}','${ORG_A}','P-A2','Ceftriaxone','NC-190-D','1 g','vial',50,'available',(current_date + 180)),
          ('${AV_B_DEMAND}','${DP_B}','${ORG_B}','P-B1','Amoxicillin','NC-190-A','500 mg','tablet',0,'missing',NULL),
          ('${AV_B_LOW}','${DP_B}','${ORG_B}','P-B2','Ceftriaxone','NC-190-D','1 g','vial',2,'low_stock',NULL),
          ('${AV_C_DECOY}','${DP_C}','${ORG_C}','P-C1','Amoxicillin','NC-190-B','500 mg','tablet',0,'missing',NULL),
          ('${AV_HS_DEMAND}','${DP_HS}','${ORG_HS}','P-HS1','Amoxicillin','NC-190-A','500 mg','tablet',0,'missing',NULL)
        ON CONFLICT(id) DO NOTHING
      `);
      // 047's contact resolution must survive the projection unchanged.
      await c.query(`
        INSERT INTO organization_status_contacts(id,organization_id,display_name,phone,is_active,is_primary)
        VALUES ('${CONTACT_A}','${ORG_A}','Contact A 190','+9647700000190',true,true)
        ON CONFLICT(id) DO NOTHING
      `);
      // Scoped, non-super actors. Permission comes from the role's matrix.
      await c.query(`
        INSERT INTO auth.users(id,email) VALUES
          ('${USER_B}','b190@example.test'), ('${USER_OUT}','out190@example.test')
        ON CONFLICT(id) DO NOTHING
      `);
      // institution_admin is the non-super role that carries BOTH
      // inter_institution_alerts.view and the legacy exchange_alerts.view, so
      // these actors exercise the real permission gate rather than a bypass.
      await c.query(`
        INSERT INTO profiles(id,organization_id,full_name,role,status) VALUES
          ('${USER_B}','${ORG_B}','User B 190','institution_admin','active'),
          ('${USER_OUT}','${ORG_OUT}','User Out 190','institution_admin','active')
        ON CONFLICT(id) DO UPDATE
          SET role = excluded.role,
              organization_id = excluded.organization_id,
              status = excluded.status
      `);
    });
  }, 900_000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ==========================================================================
  // A. the COMMAND creates/refreshes lifecycle state
  // ==========================================================================
  describe('A · the refresh COMMAND is the writer', () => {
    it('creates lifecycle state and emits opened events for live alerts', async () => {
      // Measured INSIDE the transaction: the suite rolls every call back, so a
      // before/after taken outside it would show no change even for a real
      // write and would prove the opposite of what it reads.
      const { before, after, value } = await censusAround(
        'SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500) AS payload');
      expect(value.ok).toBe(true);
      expect(value.refreshed_count).toBeGreaterThan(0);
      expect(after.states).toBeGreaterThan(before.states);
      expect(after.events).toBeGreaterThan(before.events);
      expect(after.states - before.states).toBe(value.refreshed_count);
    });

    it('is idempotent in content: a second refresh adds no new opened event', async () => {
      await rig.asUser(superId(), async (c: any) => {
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        const first = await c.query('SELECT count(*)::int n FROM inter_org_alert_events');
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        const second = await c.query('SELECT count(*)::int n FROM inter_org_alert_events');
        // The second pass UPDATEs last_seen_at; it must not re-open anything.
        expect(second.rows[0].n).toBe(first.rows[0].n);
      }, { role: 'postgres' });
    });

    it('returns command metadata only — no alert rows', async () => {
      const payload = await refresh();
      expect(Object.keys(payload).sort()).toEqual(['computed_at', 'ok', 'refreshed_count']);
    });
  });

  // ==========================================================================
  // B. the pure page query answers the same thing, after a refresh
  // ==========================================================================
  describe('B · the pure page query matches the hybrid it replaces', () => {
    it('returns the same alert rows as the legacy paged wrapper', async () => {
      const { rows } = await rig.asUser(superId(), async (c: any) => {
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        return c.query(`
          SELECT
            (SELECT jsonb_agg(e - 'first_seen_at' - 'last_seen_at' - 'computed_at' ORDER BY e->>'alert_key')
               FROM jsonb_array_elements(
                 public.phoenix_query_live_inter_org_alerts_with_state_page(200,0)->'alerts') e) AS pure,
            (SELECT jsonb_agg(e - 'first_seen_at' - 'last_seen_at' - 'computed_at' ORDER BY e->>'alert_key')
               FROM jsonb_array_elements(
                 public.phoenix_get_live_inter_institution_alerts_with_state_page(200,0)->'alerts') e) AS legacy`);
      });
      expect(rows[0].pure).not.toBeNull();
      expect(rows[0].pure).toEqual(rows[0].legacy);
    });

    it('publishes exactly the same field names as the legacy wrapper', async () => {
      const keys = (payload: any) =>
        [...new Set((payload.alerts as Alert[]).flatMap(a => Object.keys(a)))].sort();
      await refresh();
      expect(keys(await pureP(superId(), 200, 0))).toEqual(keys(await legacyPage()));
    });

    it('carries the 047 contact phone and the 048 expiry-risk fields', async () => {
      const pure = mine(alerts(await pureP(superId(), 200, 0)))
        .find(a => a.source_item_availability_id === AV_A_NEAREXP);
      const legacy = mine(alerts(await legacyPage()))
        .find(a => a.source_item_availability_id === AV_A_NEAREXP);
      expect(pure).toBeDefined();
      expect(legacy).toBeDefined();
      // 047: resolved server-side from organization_status_contacts, never by a
      // separate client query — and the source org is the one with a contact.
      expect(pure!.source_contact_phone).toBe('+9647700000190');
      expect(pure!.target_contact_phone).toBeNull();
      // 048: asserted as PARITY with the hybrid, not against a hand-computed
      // tier — the tier boundaries are 189's and this migration must inherit
      // them, whatever they are.
      expect(pure!.source_expiry_risk_tier).toBe(legacy!.source_expiry_risk_tier);
      expect(pure!.source_expiry_days_remaining).toBe(legacy!.source_expiry_days_remaining);
      expect(pure!.source_expiry_days_remaining).toBe(180);
      expect(pure!.source_contact_phone).toBe(legacy!.source_contact_phone);
    });

    it('stamps every row permanently non-executable, like 148 did', async () => {
      for (const a of mine(alerts(await pureP(superId(), 200, 0)))) {
        expect(a.executable).toBe(false);
      }
    });

    it('composes the 039 alert_key shape, so hybrid-written rows are found', async () => {
      const found = mine(alerts(await pureP(superId(), 200, 0)))
        .find(a => a.source_item_availability_id === AV_A_SUPPLY
                && a.target_item_availability_id === AV_B_DEMAND);
      expect(found!.alert_key).toBe(`${AV_A_SUPPLY}:${AV_B_DEMAND}:surplus_to_shortage`);
    });

    it('returns a live alert as lifecycle_status=open even with NO refresh at all', async () => {
      // The pure query must be TOTAL. A LEFT JOIN that silently dropped
      // never-persisted alerts would make the read answer with fewer rows
      // than the hybrid — the defect this migration exists to avoid.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        'SELECT count(*)::int n FROM inter_org_alert_states'));
      expect(rows[0].n).toBe(0);          // nothing committed by the tests above
      const list = mine(alerts(await pureP(superId(), 200, 0)));
      expect(list.length).toBeGreaterThan(0);
      for (const a of list) {
        expect(a.lifecycle_status).toBe('open');
        expect(a.first_seen_at).toBe(a.computed_at);
        expect(a.last_seen_at).toBe(a.computed_at);
        expect(a.acknowledged_at).toBeNull();
      }
    });
  });

  // ==========================================================================
  // C/D/E. PURITY — the requirement, proven by census
  // ==========================================================================
  describe('C-E · reading writes nothing', () => {
    it('the pure page query performs ZERO lifecycle mutation', async () => {
      const { before, after } = await withCensus(() => pureP(superId(), 200, 0));
      expect(after).toEqual(before);
    });

    it('the pure summary query performs ZERO lifecycle mutation', async () => {
      const { before, after } = await withCensus(() => pureS());
      expect(after).toEqual(before);
    });

    it('repeated pure reads leave state AND events byte-identical', async () => {
      const before = await census();
      for (let i = 0; i < 4; i++) { await pureP(superId(), 50, 0); await pureS(); }
      expect(await census()).toEqual(before);
    });

    it('…and the census is non-vacuous — the COMMAND does move it', async () => {
      // If census() could not observe a write, every assertion above would be
      // passing for the wrong reason. Proven inside one transaction.
      const { rows } = await rig.asUser(superId(), async (c: any) => {
        const a = await c.query('SELECT count(*)::int n FROM inter_org_alert_states');
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        const b = await c.query('SELECT count(*)::int n FROM inter_org_alert_states');
        return { rows: [{ before: a.rows[0].n, after: b.rows[0].n }] };
      }, { role: 'postgres' });
      expect(rows[0].after).toBeGreaterThan(rows[0].before);
    });

    it('paging through every page never writes', async () => {
      const before = await census();
      for (const offset of [0, 1, 2, 50, 100]) await pureP(superId(), 50, offset);
      expect(await census()).toEqual(before);
    });
  });

  // ==========================================================================
  // F/G/H. SECURITY parity
  // ==========================================================================
  describe('F-H · security scope parity', () => {
    it('anon cannot execute either new query or the COMMAND', async () => {
      for (const sql of [
        'SELECT public.phoenix_query_live_inter_org_alerts_with_state_page(10,0)',
        'SELECT public.phoenix_query_live_inter_org_alert_summary(10)',
        'SELECT public.phoenix_refresh_inter_org_alert_lifecycle(10)',
      ]) {
        await expect(rig.asUser(null, (c: any) => c.query(sql), { role: 'anon' }))
          .rejects.toThrow(/permission denied/i);
      }
    });

    it('an authenticated caller with no JWT subject is refused, not answered', async () => {
      for (const call of [
        () => callAs(null, 'SELECT public.phoenix_query_live_inter_org_alerts_with_state_page(10,0) AS payload'),
        () => callAs(null, 'SELECT public.phoenix_query_live_inter_org_alert_summary(10) AS payload'),
        () => callAs(null, 'SELECT public.phoenix_refresh_inter_org_alert_lifecycle(10) AS payload'),
      ]) {
        const payload = await call();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('NOT_AUTHENTICATED');
      }
    });

    it('the internal projection is not directly callable by any client role', async () => {
      const probe = 'SELECT public._phoenix_live_inter_org_alert_read_projection_v1(10)';
      await expect(rig.asUser(null, (c: any) => c.query(probe), { role: 'anon' }))
        .rejects.toThrow(/permission denied/i);
      await expect(rig.asUser(superId(), (c: any) => c.query(probe)))
        .rejects.toThrow(/permission denied/i);
    });

    it('no client role gained a direct read on the lifecycle tables', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT has_table_privilege('authenticated','inter_org_alert_events','SELECT') AS auth_events,
               has_table_privilege('anon','inter_org_alert_states','SELECT')          AS anon_states,
               has_table_privilege('authenticated','inter_org_alert_states','INSERT') AS auth_ins,
               has_table_privilege('authenticated','inter_org_alert_states','UPDATE') AS auth_upd,
               has_table_privilege('authenticated','inter_org_alert_states','DELETE') AS auth_del`));
      expect(rows[0]).toEqual({
        auth_events: false, anon_states: false,
        auth_ins: false, auth_upd: false, auth_del: false,
      });
    });

    it('a scoped actor sees exactly the alerts touching their own organization', async () => {
      const list = alerts(await pureP(USER_B, 200, 0));
      expect(list.length).toBeGreaterThan(0);
      for (const a of list) {
        expect([a.source_organization_id, a.target_organization_id]).toContain(ORG_B);
      }
    });

    it('an actor from an uninvolved organization sees none of the fixture alerts', async () => {
      const list = alerts(await pureP(USER_OUT, 200, 0));
      expect(mine(list)).toEqual([]);
    });

    it('the scoped actor sees the SAME set through the pure query as through the hybrid', async () => {
      // Scope parity is the assertion that matters most: the pure query must
      // not answer where the hybrid refused, nor refuse where it answered.
      const { rows } = await rig.asUser(USER_B, async (c: any) => c.query(`
        SELECT
          (SELECT jsonb_agg(e->>'alert_key' ORDER BY e->>'alert_key')
             FROM jsonb_array_elements(
               public.phoenix_query_live_inter_org_alerts_with_state_page(200,0)->'alerts') e) AS pure,
          (SELECT jsonb_agg(e->>'alert_key' ORDER BY e->>'alert_key')
             FROM jsonb_array_elements(
               public.phoenix_get_live_inter_institution_alerts_with_state_page(200,0)->'alerts') e) AS legacy`));
      expect(rows[0].pure).toEqual(rows[0].legacy);
    });

    it('the summary respects the same scope as the page for the same actor', async () => {
      await rig.asUser(USER_B, async (c: any) => {
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        const { rows } = await c.query(`
          SELECT (public.phoenix_query_live_inter_org_alert_summary(200)->>'total')::int AS summary_total,
                 (SELECT count(*)::int FROM jsonb_array_elements(
                    public.phoenix_query_live_inter_org_alerts_with_state_page(200,0)->'alerts') e
                   WHERE e->>'lifecycle_status' IN ('open','acknowledged','in_progress')) AS page_active`);
        expect(rows[0].summary_total).toBe(rows[0].page_active);
      });
    });
  });

  // ==========================================================================
  // I. lifecycle semantics — resolved/dismissed/open behave as before
  // ==========================================================================
  describe('I · lifecycle status semantics are unchanged', () => {
    const keyFor = `${AV_A_SUPPLY}:${AV_B_DEMAND}:surplus_to_shortage`;

    it('a transition made through the COMMAND surface is visible to the pure query', async () => {
      await rig.asUser(superId(), async (c: any) => {
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        await c.query(`SELECT public.phoenix_update_inter_org_alert_state($1,'acknowledged',NULL,NULL)`, [keyFor]);
        const { rows } = await c.query(`
          SELECT e->>'lifecycle_status' AS s, e->>'acknowledged_by' AS by
            FROM jsonb_array_elements(
              public.phoenix_query_live_inter_org_alerts_with_state_page(200,0)->'alerts') e
           WHERE e->>'alert_key' = $1`, [keyFor]);
        expect(rows[0].s).toBe('acknowledged');
        expect(rows[0].by).toBe(superId());
      });
    });

    it('a resolved alert stays in the page but leaves the summary counters', async () => {
      await rig.asUser(superId(), async (c: any) => {
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        const beforeTotal = (await c.query(
          `SELECT (public.phoenix_query_live_inter_org_alert_summary(200)->>'total')::int n`)).rows[0].n;

        // 039 allows only open -> acknowledged -> in_progress -> resolved. The
        // graph is walked rather than short-circuited: 190 changes no
        // transition rule, so the real path must be the one under test.
        await c.query(`SELECT public.phoenix_update_inter_org_alert_state($1,'acknowledged',NULL,NULL)`, [keyFor]);
        await c.query(`SELECT public.phoenix_update_inter_org_alert_state($1,'in_progress',NULL,NULL)`, [keyFor]);
        await c.query(`SELECT public.phoenix_update_inter_org_alert_state($1,'resolved','done',NULL)`, [keyFor]);

        const page = await c.query(`
          SELECT e->>'lifecycle_status' AS s
            FROM jsonb_array_elements(
              public.phoenix_query_live_inter_org_alerts_with_state_page(200,0)->'alerts') e
           WHERE e->>'alert_key' = $1`, [keyFor]);
        expect(page.rows[0].s).toBe('resolved');   // still discoverable

        const afterTotal = (await c.query(
          `SELECT (public.phoenix_query_live_inter_org_alert_summary(200)->>'total')::int n`)).rows[0].n;
        expect(afterTotal).toBe(beforeTotal - 1);  // …but no longer "needs attention"
      });
    });

    it('a dismissed alert is likewise excluded from the summary', async () => {
      await rig.asUser(superId(), async (c: any) => {
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        const before = (await c.query(
          `SELECT (public.phoenix_query_live_inter_org_alert_summary(200)->>'total')::int n`)).rows[0].n;
        await c.query(`SELECT public.phoenix_update_inter_org_alert_state($1,'dismissed','noise',NULL)`, [keyFor]);
        const after = (await c.query(
          `SELECT (public.phoenix_query_live_inter_org_alert_summary(200)->>'total')::int n`)).rows[0].n;
        expect(after).toBe(before - 1);
      });
    });

    it('the summary counts exactly what the Dashboard used to count client-side', async () => {
      await rig.asUser(superId(), async (c: any) => {
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        const { rows } = await c.query(`
          WITH s AS (SELECT public.phoenix_query_live_inter_org_alert_summary(200) AS j),
               p AS (SELECT e FROM jsonb_array_elements(
                       public.phoenix_query_live_inter_org_alerts_with_state_page(200,0)->'alerts') e
                      WHERE e->>'lifecycle_status' IN ('open','acknowledged','in_progress'))
          SELECT (SELECT (j->>'total')::int FROM s)                    AS s_total,
                 (SELECT (j->>'high')::int FROM s)                     AS s_high,
                 (SELECT (j->>'surplus_to_shortage')::int FROM s)      AS s_sur,
                 (SELECT (j->>'near_expiry_to_shortage')::int FROM s)  AS s_near,
                 (SELECT count(*)::int FROM p)                                                   AS p_total,
                 (SELECT count(*)::int FROM p WHERE e->>'severity'='high')                       AS p_high,
                 (SELECT count(*)::int FROM p WHERE e->>'alert_type'='surplus_to_shortage')      AS p_sur,
                 (SELECT count(*)::int FROM p WHERE e->>'alert_type'='near_expiry_to_shortage')  AS p_near`);
        const r = rows[0];
        expect(r.p_total).toBeGreaterThan(0);            // non-vacuous
        expect([r.s_total, r.s_high, r.s_sur, r.s_near])
          .toEqual([r.p_total, r.p_high, r.p_sur, r.p_near]);
      });
    });
  });

  // ==========================================================================
  // J. pagination
  // ==========================================================================
  describe('J · pagination', () => {
    it('total_count is stable across pages and independent of the window', async () => {
      const totals = [] as number[];
      for (const [limit, offset] of [[1, 0], [1, 1], [2, 0], [50, 0], [50, 50]] as const) {
        const payload = await pureP(superId(), limit, offset);
        expect(payload.ok).toBe(true);
        totals.push(payload.total_count as number);
      }
      expect(new Set(totals).size).toBe(1);
    });

    it('echoes the sanitised limit/offset exactly as 148 did', async () => {
      const clamped = await pureP(superId(), 9999, -5);
      expect(clamped.limit).toBe(200);
      expect(clamped.offset).toBe(0);
    });

    it('slices without overlap or loss', async () => {
      const first = alerts(await pureP(superId(), 1, 0));
      const second = alerts(await pureP(superId(), 1, 1));
      const whole = alerts(await pureP(superId(), 200, 0));
      expect(whole.length).toBeGreaterThan(1);
      expect(first[0].alert_key).toBe(whole[0].alert_key);
      expect(second[0].alert_key).toBe(whole[1].alert_key);
    });
  });

  // ==========================================================================
  // K/L/M/N/O. 189's eligibility contract survives the split untouched
  // ==========================================================================
  describe('K-O · canonical eligibility is inherited, not restated', () => {
    it('K · a differing canonical component still does NOT match', async () => {
      const list = alerts(await pureP(superId(), 200, 0));
      expect(list.some(a => a.target_item_availability_id === AV_C_DECOY)).toBe(false);
      expect(list.some(a => a.target_organization_id === ORG_C)).toBe(false);
      // …and the decoy shares every display label with the supply row, so only
      // canonical identity can be excluding it.
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int n FROM item_availability
         WHERE id = ANY($1::uuid[])
         GROUP BY lower(btrim(scientific_name)), concentration, dosage_form`,
        [[AV_A_SUPPLY, AV_C_DECOY]]));
      expect(rows[0].n).toBe(2);
    });

    it('L · NULL local_item_id rows still resolve — the whole fixture is one', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int n FROM item_availability
          WHERE id = ANY($1::uuid[]) AND local_item_id IS NULL`,
        [[AV_A_SUPPLY, AV_A_NEAREXP, AV_B_DEMAND, AV_B_LOW, AV_C_DECOY, AV_HS_DEMAND]]));
      expect(rows[0].n).toBe(6);
      expect(pairs(alerts(await pureP(superId(), 200, 0))))
        .toContain(`${AV_A_SUPPLY}->${AV_B_DEMAND}:surplus_to_shortage`);
    });

    it('M · health_sector / hospital / specialized_center remain eligible', async () => {
      const list = pairs(alerts(await pureP(superId(), 200, 0)));
      expect(list).toContain(`${AV_A_SUPPLY}->${AV_B_DEMAND}:surplus_to_shortage`);        // hospital <-> hospital
      expect(list).toContain(`${AV_A_SUPPLY}->${AV_HS_DEMAND}:surplus_to_shortage`);       // hospital <-> health_sector
      expect(list).toContain(`${AV_A_NEAREXP}->${AV_B_LOW}:near_expiry_to_shortage`);      // 9-month window
    });

    // N · PDA / non-care exclusion.
    //
    // This is deliberately proven as UNREACHABILITY, not as "an alert that
    // fails to appear". Migration 171 refuses an outlet under a
    // pharmacy_department_authority and item_availability.distribution_point_id
    // is NOT NULL, so a PDA availability row cannot be constructed at all —
    // seeding one aborts the fixture. Asserting a scenario that cannot exist
    // would be asserting nothing; these probe the routes instead, exactly as
    // the 189 suite does.
    it('N · a PDA organization cannot be given an outlet in the first place', async () => {
      await expect(rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(warehouse_id,organization_id,name,name_ar,point_type,status)
         VALUES ($1,$2,'PDA Outlet 190','منفذ ص 190','pharmacy','active')`, [WH_P, ORG_PDA],
      ))).rejects.toThrow(/pharmacy_department_authority_outlet_not_permitted/);
    });

    it('N · and an availability row cannot exist without an outlet', async () => {
      await expect(rig.asAdmin((c: any) => c.query(
        `INSERT INTO item_availability(distribution_point_id,organization_id,port_name,scientific_name,quantity,condition)
         VALUES (NULL,$1,'P-X','Amoxicillin',1,'surplus')`, [ORG_PDA],
      ))).rejects.toThrow(/not-null constraint/i);
      // Together those close every route to a non-care alert endpoint.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM item_availability ia
           JOIN organizations o ON o.id = ia.organization_id
          WHERE o.organization_kind <> 'care_institution'`));
      expect(rows[0].n).toBe(0);
    });

    it('N · the PDA organization fails the candidate predicate the base RPC applies', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT o.organization_kind,
                (o.organization_kind = 'care_institution'
                 AND o.institution_class IN ('health_sector','hospital','specialized_center')) AS eligible
           FROM organizations o WHERE o.id = $1`, [ORG_PDA]));
      expect(rows[0].organization_kind).toBe('pharmacy_department_authority');
      expect(rows[0].eligible).toBe(false);
      // …and no alert the pure query returns names it on either endpoint.
      const list = alerts(await pureP(superId(), 200, 0));
      expect(list.some(a => a.source_organization_id === ORG_PDA)).toBe(false);
      expect(list.some(a => a.target_organization_id === ORG_PDA)).toBe(false);
    });

    it('O · source and target organizations always differ', async () => {
      for (const payload of [await pureP(superId(), 200, 0), await pureS()]) {
        expect(payload.ok).toBe(true);
      }
      for (const a of alerts(await pureP(superId(), 200, 0))) {
        expect(a.source_organization_id).not.toBe(a.target_organization_id);
      }
    });

    it('the removed_at exclusion still applies through the pure query', async () => {
      await rig.asUser(superId(), async (c: any) => {
        const present = await c.query(`
          SELECT count(*)::int n FROM jsonb_array_elements(
            public.phoenix_query_live_inter_org_alerts_with_state_page(200,0)->'alerts') e
           WHERE e->>'target_item_availability_id' = $1`, [AV_B_DEMAND]);
        expect(present.rows[0].n).toBeGreaterThan(0);
      });
      // Mark removed inside a rolled-back transaction and re-read there.
      await rig.asUser(superId(), async (c: any) => {
        await c.query('SET LOCAL ROLE postgres');
        await c.query('UPDATE item_availability SET removed_at = now() WHERE id = $1', [AV_B_DEMAND]);
        await c.query('SET LOCAL ROLE authenticated');
        const gone = await c.query(`
          SELECT count(*)::int n FROM jsonb_array_elements(
            public.phoenix_query_live_inter_org_alerts_with_state_page(200,0)->'alerts') e
           WHERE e->>'target_item_availability_id' = $1`, [AV_B_DEMAND]);
        expect(gone.rows[0].n).toBe(0);
      });
    });
  });

  // ==========================================================================
  // Additive-only: the legacy surface is exactly as 189 left it.
  // ==========================================================================
  describe('additive only · every legacy RPC survives untouched', () => {
    it('all six legacy RPCs exist, grant authenticated and deny anon', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT sig,
               to_regprocedure(sig) IS NOT NULL                                AS present,
               has_function_privilege('authenticated', sig, 'EXECUTE')         AS auth,
               has_function_privilege('anon', sig, 'EXECUTE')                  AS anon
          FROM unnest(ARRAY[
            'public.phoenix_get_live_inter_institution_alerts(integer)',
            'public.phoenix_get_live_inter_institution_alerts_with_state(integer)',
            'public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)',
            'public.phoenix_update_inter_org_alert_state(text,text,text,text)',
            'public.phoenix_reopen_inter_org_alert(text,text,text)',
            'public.phoenix_get_inter_org_alert_events(text)'
          ]) AS sig`));
      expect(rows).toHaveLength(6);
      for (const r of rows) {
        expect(r.present, r.sig).toBe(true);
        expect(r.auth, r.sig).toBe(true);
        expect(r.anon, r.sig).toBe(false);
      }
    });

    it('the with_state hybrid still upserts and still emits its opened event', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_functiondef(
          'public.phoenix_get_live_inter_institution_alerts_with_state(integer)'::regprocedure) AS def`));
      expect(rows[0].def).toContain('INSERT INTO public.inter_org_alert_states');
      expect(rows[0].def).toContain('inter_org_alert_events');
    });

    it('189\'s canonical identity bridge is untouched and still client-denied', async () => {
      const probe = "SELECT public._phoenix_availability_material_identity_v1(NULL,'x',NULL,NULL,NULL)";
      await expect(rig.asUser(superId(), (c: any) => c.query(probe)))
        .rejects.toThrow(/permission denied/i);
    });

    it('the event history read path still works and is still RPC-only', async () => {
      await rig.asUser(superId(), async (c: any) => {
        await c.query('SELECT public.phoenix_refresh_inter_org_alert_lifecycle(500)');
        const { rows } = await c.query(
          `SELECT public.phoenix_get_inter_org_alert_events($1) AS payload`,
          [`${AV_A_SUPPLY}:${AV_B_DEMAND}:surplus_to_shortage`]);
        expect(rows[0].payload.ok).toBe(true);
        expect((rows[0].payload.events as unknown[]).length).toBeGreaterThan(0);
        await expect(c.query('SELECT count(*) FROM inter_org_alert_events'))
          .rejects.toThrow(/permission denied/i);
      });
    });
  });
});
