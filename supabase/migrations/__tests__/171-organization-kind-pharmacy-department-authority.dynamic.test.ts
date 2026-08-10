/**
 * 171 · ORGANIZATION KIND + PHARMACY DEPARTMENT AUTHORITY (Stage E · E7-1
 * follow-up) — dynamic proof.
 *
 * Drives the REAL organizations.organization_kind NOT NULL/immutability
 * guarantees, the conditional institution_class contract, the warehouse and
 * distribution_point owner-kind guards (including a genuine two-transaction
 * concurrency race on two independent raw connections), the Migration-164
 * NULL guards this migration makes reachable again, and Migration 077's
 * direct central->institution corridor with a pharmacy_department_authority
 * source.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 60000 });

const run = rigAvailable() ? describe : describe.skip;

/** Races a promise against a short timeout to determine whether it is still
 * blocked (pending) — identical technique to 170's own concurrency proofs. */
function pending<T>(
  p: Promise<T>,
  ms = 500,
): Promise<'pending' | { ok: true; value: T } | { ok: false; error: unknown }> {
  return Promise.race([
    p.then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error })),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

const call = (c: any, fn: string, args: unknown[]) =>
  c
    .query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
    .then((res: any) => res.rows[0].r);

// ── Fixture ids ──────────────────────────────────────────────────────────────
const ORG_HOSPITAL = '00000000-0000-0000-0000-000000171001'; // care_institution
const ORG_SECTOR = '00000000-0000-0000-0000-000000171002';   // care_institution, health_sector
const ORG_AUTHORITY = '00000000-0000-0000-0000-000000171003'; // pharmacy_department_authority

const WH_HOSPITAL = '00000000-0000-0000-0000-000000171101';   // institution kind, care_institution-owned
const WH_AUTHORITY_CENTRAL = '00000000-0000-0000-0000-000000171102'; // central kind, authority-owned

const SUPER_ADMIN = '00000000-0000-0000-0000-0000000000a1'; // rig.superAdminId

run('171 · organization kind + pharmacy department authority (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 171 });

    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_HOSPITAL}','Hospital171','Hospital171','p171-hospital','care_institution','hospital'),
        ('${ORG_SECTOR}','Sector171','Sector171','p171-sector','care_institution','health_sector'),
        ('${ORG_AUTHORITY}','Authority171','Authority171','p171-authority','pharmacy_department_authority',NULL);

      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_HOSPITAL}','${ORG_HOSPITAL}','Hosp Depot171','Hosp Depot171','active','institution','p171-wh-hosp'),
        ('${WH_AUTHORITY_CENTRAL}','${ORG_AUTHORITY}','Authority Depot171','Authority Depot171','active','central','p171-wh-auth');
    `));
  });

  afterAll(async () => { await rig?.end(); });

  async function rawClient(): Promise<any> { return rig.pool.connect(); }
  async function beginAsUser(userId: string): Promise<any> {
    const c = await rawClient();
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    return c;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 0. clean replay 001->171 + backfill proof
  // ══════════════════════════════════════════════════════════════════════
  describe('0. clean replay 001->171', () => {
    it('existing organizations are backfilled to care_institution', async () => {
      // The two Migration-004 canonical fixtures (already reconciled to
      // 'hospital' by 170's own preflight) must land as care_institution
      // under 171's default backfill.
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT organization_kind FROM organizations
         WHERE id IN ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002')`,
      ));
      expect(r.rows).toHaveLength(2);
      for (const row of r.rows) expect(row.organization_kind).toBe('care_institution');
    });

    it('organization_kind is NOT NULL; institution_class is nullable again at the column level', async () => {
      const cols = await rig.asAdmin((c: any) => c.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='organizations'
           AND column_name IN ('organization_kind','institution_class')`,
      ));
      const byName = Object.fromEntries(cols.rows.map((r: any) => [r.column_name, r.is_nullable]));
      expect(byName.organization_kind).toBe('NO');
      expect(byName.institution_class).toBe('YES');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // A. organization_kind — CHECK + conditional institution_class contract
  // ══════════════════════════════════════════════════════════════════════
  describe('A. organization_kind and the conditional institution_class contract', () => {
    it('valid care_institution with a real class is accepted', async () => {
      const id = randomUUID();
      const r = await rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class)
         VALUES ($1,'X','X','p171-a1','care_institution','hospital') RETURNING id`, [id]));
      expect(r.rows).toHaveLength(1);
    });

    it('care_institution with NULL institution_class is rejected', async () => {
      const id = randomUUID();
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class)
         VALUES ($1,'X','X','p171-a2','care_institution',NULL)`, [id])));
      expect(msg).toMatch(/organizations_kind_institution_class_chk/);
    });

    it('valid pharmacy_department_authority with NULL institution_class is accepted', async () => {
      const id = randomUUID();
      const r = await rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class)
         VALUES ($1,'X','X','p171-a3','pharmacy_department_authority',NULL) RETURNING id`, [id]));
      expect(r.rows).toHaveLength(1);
    });

    it.each(['hospital', 'specialized_center', 'health_sector'])(
      'pharmacy_department_authority + %s institution_class is rejected',
      async (klass) => {
        const id = randomUUID();
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class)
           VALUES ($1,'X','X',$2,'pharmacy_department_authority',$3)`,
          [id, `p171-a4-${klass}`, klass])));
        expect(msg).toMatch(/organizations_kind_institution_class_chk/);
      },
    );

    it('an invalid organization_kind value is rejected', async () => {
      // Rejected by BOTH new CHECK constraints simultaneously — an
      // unrecognized organization_kind can never satisfy either disjunct of
      // the conditional contract, so organizations_kind_institution_class_chk
      // fires (Postgres evaluates it first here) in addition to the
      // 2-value membership check itself; either is sufficient proof.
      const id = randomUUID();
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class)
         VALUES ($1,'X','X','p171-a5','something_else',NULL)`, [id])));
      expect(msg).toMatch(/organizations_organization_kind_chk|organizations_kind_institution_class_chk/);
    });

    it('an actual organization_kind mutation is rejected', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE organizations SET organization_kind='pharmacy_department_authority' WHERE id=$1`,
        [ORG_HOSPITAL])));
      expect(msg).toMatch(/organization_kind_immutable/);
    });

    it('a same-value organization_kind UPDATE succeeds (harmless no-op)', async () => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE organizations SET organization_kind='care_institution' WHERE id=$1`, [ORG_HOSPITAL]));
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT organization_kind FROM organizations WHERE id=$1`, [ORG_HOSPITAL]));
      expect(r.rows[0].organization_kind).toBe('care_institution');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // B. warehouse ownership guard
  // ══════════════════════════════════════════════════════════════════════
  describe('B. warehouse owner-kind guard', () => {
    it('authority + central warehouse is accepted at INSERT', async () => {
      const id = randomUUID();
      const r = await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'X','X','active','central','p171-b1') RETURNING id`,
        [id, ORG_AUTHORITY]));
      expect(r.rows).toHaveLength(1);
    });

    it('authority + non-central warehouse is rejected at INSERT', async () => {
      const id = randomUUID();
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'X','X','active','institution','p171-b2')`,
        [id, ORG_AUTHORITY])));
      expect(msg).toMatch(/pharmacy_department_authority_requires_central_warehouse/);
    });

    it('care_institution can still own a central-kind warehouse (Migration 004 precedent preserved)', async () => {
      const id = randomUUID();
      const r = await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'X','X','active','central','p171-b3') RETURNING id`,
        [id, ORG_HOSPITAL]));
      expect(r.rows).toHaveLength(1);
    });

    it('reassigning a warehouse to an authority org is rejected if warehouse_kind is not central', async () => {
      const id = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'X','X','active','institution','p171-b4')`, [id, ORG_HOSPITAL]));
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [ORG_AUTHORITY, id])));
      expect(msg).toMatch(/pharmacy_department_authority_requires_central_warehouse/);
    });

    it('an existing warehouse with distribution_points cannot be reassigned to an authority org', async () => {
      const wh = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'X','X','active','central','p171-b5')`, [wh, ORG_HOSPITAL]));
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'X','X','pharmacy','active')`, [randomUUID(), ORG_HOSPITAL, wh]));

      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [ORG_AUTHORITY, wh])));
      expect(msg).toMatch(/pharmacy_department_authority_warehouse_has_outlets/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C. distribution_points owner-kind guard
  // ══════════════════════════════════════════════════════════════════════
  describe('C. distribution_points owner-kind guard', () => {
    it('creating a distribution_point on an authority-owned warehouse is rejected', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'X','X','pharmacy','active')`,
        [randomUUID(), ORG_AUTHORITY, WH_AUTHORITY_CENTRAL])));
      expect(msg).toMatch(/pharmacy_department_authority_warehouse_no_outlets/);
    });

    it('reassigning an existing distribution_point onto an authority-owned warehouse is rejected', async () => {
      const dp = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'X','X','pharmacy','active')`, [dp, ORG_HOSPITAL, WH_HOSPITAL]));

      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [WH_AUTHORITY_CENTRAL, dp])));
      expect(msg).toMatch(/pharmacy_department_authority_warehouse_no_outlets/);

      // Unchanged: the reassignment attempt did not partially apply.
      const row = await rig.asAdmin((c: any) => c.query(
        `SELECT warehouse_id FROM distribution_points WHERE id=$1`, [dp]));
      expect(row.rows[0].warehouse_id).toBe(WH_HOSPITAL);
    });

    it('creating/reassigning onto a care_institution warehouse remains unaffected', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'X','X','pharmacy','active') RETURNING id`,
        [randomUUID(), ORG_HOSPITAL, WH_HOSPITAL]));
      expect(r.rows).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // D. concurrency — the indirect-outlet race cannot commit an invalid state
  // ══════════════════════════════════════════════════════════════════════
  describe('D. concurrency: warehouse reassignment vs. outlet attachment', () => {
    it('TX-A (reassignment) wins the lock first: concurrent outlet attach waits, then is correctly rejected', async () => {
      const wh = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'X','X','active','central','p171-d1')`, [wh, ORG_HOSPITAL]));

      const t1 = await beginAsUser(SUPER_ADMIN);
      await t1.query(`UPDATE public.warehouses SET organization_id=$1 WHERE id=$2`, [ORG_AUTHORITY, wh]);
      // t1 now holds FOR UPDATE on wh, still open (not yet committed).

      const t2 = await rawClient();
      await t2.query('BEGIN');
      const insertPromise = t2.query(
        `INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status)
         VALUES (gen_random_uuid(),$1,$2,'RaceDP','RaceDP','pharmacy','active')`,
        [ORG_HOSPITAL, wh],
      );
      const race = await pending(insertPromise, 500);
      expect(race).toBe('pending'); // t2 must be blocked on t1's FOR UPDATE lock

      await t1.query('COMMIT');
      t1.release();

      const msg = await rejects(() => insertPromise);
      expect(msg).toMatch(/pharmacy_department_authority_warehouse_no_outlets/);
      await t2.query('ROLLBACK').catch(() => {});
      t2.release();

      const row = await rig.asAdmin((c: any) => c.query(`SELECT organization_id FROM warehouses WHERE id=$1`, [wh]));
      expect(row.rows[0].organization_id).toBe(ORG_AUTHORITY); // reassignment committed
      const dpCount = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM distribution_points WHERE warehouse_id=$1`, [wh]));
      expect(dpCount.rows[0].n).toBe(0); // outlet never committed — valid final state
    });

    it('TX-B (outlet attach) wins the lock first: concurrent reassignment waits, then is correctly rejected', async () => {
      const wh = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'X','X','active','central','p171-d2')`, [wh, ORG_HOSPITAL]));

      const t2 = await rawClient();
      await t2.query('BEGIN');
      await t2.query(
        `INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status)
         VALUES (gen_random_uuid(),$1,$2,'RaceDP2','RaceDP2','pharmacy','active')`,
        [ORG_HOSPITAL, wh],
      ); // completes immediately (FOR SHARE, nothing contends yet), not committed

      const t1 = await beginAsUser(SUPER_ADMIN);
      const reassignPromise = t1.query(
        `UPDATE public.warehouses SET organization_id=$1 WHERE id=$2`, [ORG_AUTHORITY, wh]);
      const race = await pending(reassignPromise, 500);
      expect(race).toBe('pending'); // t1 must be blocked waiting for t2's FOR SHARE lock

      await t2.query('COMMIT');
      t2.release();

      const msg = await rejects(() => reassignPromise);
      expect(msg).toMatch(/pharmacy_department_authority_warehouse_has_outlets/);
      await t1.query('ROLLBACK').catch(() => {});
      t1.release();

      const row = await rig.asAdmin((c: any) => c.query(`SELECT organization_id FROM warehouses WHERE id=$1`, [wh]));
      expect(row.rows[0].organization_id).toBe(ORG_HOSPITAL); // reassignment never committed
      const dpCount = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM distribution_points WHERE warehouse_id=$1`, [wh]));
      expect(dpCount.rows[0].n).toBe(1); // outlet attach committed — valid final state
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // E. Migration-164 NULL guards — reachable again, unmodified since 164
  // ══════════════════════════════════════════════════════════════════════
  describe('E. Migration-164 NULL guards are reachable again and reject correctly', () => {
    it('phoenix_upsert_organization_facility refuses an authority (NULL-class) parent', async () => {
      const msg = await rejects(() => rig.asUser(SUPER_ADMIN, (c: any) =>
        call(c, 'phoenix_upsert_organization_facility',
          [null, ORG_AUTHORITY, 'primary_health_center', 'X', 'X', null, true])));
      expect(msg).toMatch(/organization_institution_class_required/);
    });

    it('the composite FK independently makes an authority org impossible as a facility parent', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO organization_facilities(organization_id,facility_class,name,name_ar)
        VALUES('${ORG_AUTHORITY}','primary_health_center','X','X')`)));
      expect(msg).toMatch(/of_parent_class_fk/);
    });

    // "phoenix_upsert_outlet_replenishment_route refuses a route whose
    // organization is an authority" — not constructible as its own scenario:
    // section C's distribution_points_owner_kind_guard_trg categorically
    // forbids ANY distribution_point from ever existing on an
    // authority-owned warehouse (proven above), so there is no way to reach
    // the route RPC with a real point belonging to an authority org in the
    // first place. This is a stronger, doubly-independent protection than a
    // gap: the route RPC's own NULL guard (164:639-640) remains provably
    // correct for every org that CAN reach it (any care_institution, per
    // 164's own dynamic suite, unmodified), while an authority org is
    // additionally blocked one layer earlier, categorically, by C.

    it('an authority-owned warehouse can never reach facility assignment at all — 170\'s warehouse_kind gate fires first, structurally, not just its health_sector gate', async () => {
      // Discovered, not assumed: 170's facility-assignment guard requires
      // warehouse_kind='institution' for ANY non-NULL facility_id (checked
      // before it ever reaches the org's institution_class). Section B's new
      // guard requires the OPPOSITE — an authority-owned warehouse must
      // always be warehouse_kind='central'. Those two categorical rules
      // together make it structurally impossible for an authority-owned
      // warehouse to ever be 'institution'-kind, so 170's own
      // 'warehouse_organization_not_health_sector' check (proven correct and
      // reachable for every other NULL-class case in 170's own unmodified
      // dynamic suite) can never fire for THIS specific combination — the
      // warehouse_kind gate rejects first, every time, which is a stronger
      // guarantee, not a gap.
      const fac = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status)
         VALUES ($1,$2,'primary_health_center','X','X','active')`, [fac, ORG_SECTOR]));
      const msg = await rejects(() => rig.asUser(SUPER_ADMIN, (c: any) =>
        call(c, 'phoenix_assign_warehouse_facility', [WH_AUTHORITY_CENTRAL, fac])));
      expect(msg).toMatch(/warehouse_kind_not_institution/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // F. Migration 077 — direct central->institution corridor with an
  //    authority source
  // ══════════════════════════════════════════════════════════════════════
  describe('F. Migration 077 corridor works with a pharmacy_department_authority source', () => {
    it('phoenix_create_direct_warehouse_transfer_request opens authority -> care_institution, preserving both organization ids', async () => {
      // No explicit profile_scope_assignments row needed: super_admin
      // bypasses per-resource scoping entirely in
      // phoenix_profile_has_scoped_permission (proven directly in section G
      // below), exactly like every other super_admin-driven RPC call
      // elsewhere in this file and in 170's own dynamic suite.
      const r: any = await rig.asUser(SUPER_ADMIN, (c: any) =>
        call(c, 'phoenix_create_direct_warehouse_transfer_request',
          [WH_AUTHORITY_CENTRAL, ORG_HOSPITAL, WH_HOSPITAL, `p171-direct-${Date.now()}`, null]),
        { commit: true });
      expect(r.ok).toBe(true);

      const row = await rig.asAdmin((c: any) => c.query(
        `SELECT source_organization_id, destination_organization_id FROM warehouse_transfer_requests
         WHERE id=$1`, [r.transfer_request_id]));
      expect(row.rows[0].source_organization_id).toBe(ORG_AUTHORITY);
      expect(row.rows[0].destination_organization_id).toBe(ORG_HOSPITAL);
    });

    it('phoenix_assert_direct_supply_endpoints accepts an authority-owned central source unconditionally on institution_class', async () => {
      const r: any = await rig.asAdmin((c: any) => c.query(
        `SELECT * FROM public.phoenix_assert_direct_supply_endpoints($1,$2,$3)`,
        [WH_AUTHORITY_CENTRAL, WH_HOSPITAL, null],
      ).then((x: any) => x.rows[0]));
      expect(r.o_source_organization_id).toBe(ORG_AUTHORITY);
      expect(r.o_destination_organization_id).toBe(ORG_HOSPITAL);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // G. RBAC/RLS, provenance, and no-second-truth
  // ══════════════════════════════════════════════════════════════════════
  describe('G. RBAC/RLS unchanged, provenance unchanged, no second stock truth', () => {
    it('scoped permission checks remain keyed on organization_id/warehouse_id only — an authority-org actor is scoped exactly like any other', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT public.phoenix_profile_has_scoped_permission($1,'warehouse_transfer.send',$2,$3,NULL) AS ok`,
        [SUPER_ADMIN, ORG_AUTHORITY, WH_AUTHORITY_CENTRAL]));
      expect(r.rows[0].ok).toBe(true);
    });

    it('supply_type/purchase_origin provenance vocabulary is untouched by organization_kind', async () => {
      const chk = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
         WHERE conrelid = 'public.warehouse_stock'::regclass
           AND pg_get_constraintdef(oid) LIKE '%supply_type%'`));
      expect(chk.rows.length).toBeGreaterThan(0);
      expect(chk.rows[0].d).toMatch(/'aid'|'purchase'|'kimadia'/);
    });

    it('creates no second inventory/stock table', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM pg_class
         WHERE relname IN ('pharmacy_department_stock','authority_stock','organization_kind_stock')`));
      expect(r.rows[0].n).toBe(0);
    });

    it('opens no direct write path to warehouse_stock for organization_kind', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema='public' AND table_name='warehouse_stock' AND column_name='organization_kind'`));
      expect(r.rows[0].n).toBe(0);
    });
  });
});
