/**
 * 170 · ORGANIZATION CLASS + WAREHOUSE FACILITY ASSIGNMENT (Stage E · E7-1) —
 * dynamic proof.
 *
 * PR #111 replay + concurrency correction: the primary success path is now a
 * genuine, unmodified clean replay of the real chain — buildRig({upTo:170})
 * — with NO external test-side workaround. Migration 170's own preflight now
 * performs CANONICAL_DEMO_FIXTURE_RECONCILIATION: it reconciles ONLY the two
 * fixed-UUID Migration-004 demo-seed organizations (both unambiguously named
 * hospitals in 004 itself) from NULL to 'hospital', and only when found with
 * a byte-identical Migration-004 identity fingerprint; every other
 * organization is untouched, and a single remaining NULL row anywhere still
 * fails the whole migration closed (proved in describe blocks F and G below,
 * each on its own isolated fresh rig at ceiling 169).
 *
 * Drives the REAL organizations.institution_class NOT NULL/immutability
 * guarantees and the REAL phoenix_assign_warehouse_facility RPC + its hard
 * trigger boundary against every case the E7-1 gate requires: class
 * create/reject/immutable, facility PASS/REJECT, raw-UPDATE bypass
 * regression, the full 19-table operational-dependency guard, exactly-once
 * audit semantics, and (describe block E) genuine two-transaction
 * concurrency races proving the trigger-local row lock makes the raw-UPDATE
 * path no weaker than the RPC path against a concurrently-created dependency,
 * in both possible commit orderings.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildRig, rigAvailable, MIGRATIONS_DIR,
  freshRigDb, migrationFiles, shimSql,
} from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;

const MIGRATION_170_SQL = readFileSync(
  join(MIGRATIONS_DIR, '170_phoenix_organization_class_and_warehouse_facility_assignment.sql'),
  'utf8',
);

const SEED_AFTER_001 = `
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES ('00000000-0000-0000-0000-0000000000a1', 'root@rig.local',
          jsonb_build_object('full_name','Rig Root','role','super_admin'))
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.profiles SET role='super_admin', status='active'
   WHERE id='00000000-0000-0000-0000-0000000000a1';
`;

/** A dedicated, isolated fresh rig at ceiling 169 (its own throwaway
 * database, matching the established technique in e.g.
 * 163-verification-hardening.dynamic.test.ts's buildTo162()) — used only by
 * describe blocks F and G below, which each apply migration 170's raw SQL
 * text directly and need full manual transaction control (an explicit
 * ROLLBACK after an expected rejection) rather than the shared pool-based
 * `rig` used everywhere else in this file. */
async function buildTo169() {
  const c = await freshRigDb();
  for (const f of migrationFiles(169)) {
    const raw = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    await c.query(shimSql(f, raw));
    if (f.startsWith('001_')) await c.query(SEED_AFTER_001);
  }
  return c;
}

/** Races a promise against a short timeout to determine whether it is still
 * blocked (pending) — used by describe block E's concurrency proofs to
 * assert that one side of a race is genuinely waiting on a Postgres row
 * lock before resolving the other side. Catches rejections too, so a query
 * that fails fast is never misreported as "pending". */
function pending<T>(
  p: Promise<T>,
  ms = 500,
): Promise<'pending' | { ok: true; value: T } | { ok: false; error: unknown }> {
  return Promise.race([
    p.then((value) => ({ ok: true as const, value })).catch((error) => ({ ok: false as const, error })),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

// ── Fixture ids ──────────────────────────────────────────────────────────────
const ORG_SECTOR = '00000000-0000-0000-0000-000000170001';
const ORG_SECTOR_2 = '00000000-0000-0000-0000-000000170002';
const ORG_HOSPITAL = '00000000-0000-0000-0000-000000170003';
const ORG_SPECIAL = '00000000-0000-0000-0000-000000170004';

const FAC_PRIMARY = '00000000-0000-0000-0000-000000170101';
const FAC_SUBORDINATE = '00000000-0000-0000-0000-000000170102';
const FAC_INACTIVE = '00000000-0000-0000-0000-000000170103';
const FAC_CROSS = '00000000-0000-0000-0000-000000170104';
const FAC_GHOST = '00000000-0000-0000-0000-00000017010f'; // never inserted

const SUPER_ADMIN = '00000000-0000-0000-0000-0000000000a1'; // rig.superAdminId
const INACTIVE_ADMIN = '00000000-0000-0000-0000-000000170901';
const NON_SUPER = '00000000-0000-0000-0000-000000170902';

let seq = 0;
const uniq = (_p: string) => randomUUID();
const code = (p: string) => `${p}-${Date.now()}-${++seq}`.slice(0, 40);

const call = (c: any, fn: string, args: unknown[]) =>
  c
    .query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
    .then((res: any) => res.rows[0].r);

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

run('170 · organization class + warehouse facility assignment (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    // Clean replay of the real chain, unmodified, no external workaround.
    // Migration 170's own preflight now performs
    // CANONICAL_DEMO_FIXTURE_RECONCILIATION: it reconciles ONLY the two
    // fixed-UUID Migration-004 demo-seed organizations ('Babil General
    // Hospital' / 'Al-Hilla Teaching Hospital', ids ...0001/...0002 — both
    // unambiguously named as hospitals in 004 itself) from NULL to
    // 'hospital', and only because they still carry a byte-identical
    // Migration-004 identity fingerprint. No other organization is touched,
    // and the global zero-NULL gate still runs afterward (see describe
    // blocks F and G below for the two ways this still fails closed).
    rig = await buildRig({ upTo: 170 });

    // Shared fixture graph.
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES
        ('${ORG_SECTOR}','Sector170','Sector170','p170-sector','health_sector'),
        ('${ORG_SECTOR_2}','Sector170b','Sector170b','p170-sector2','health_sector'),
        ('${ORG_HOSPITAL}','Hospital170','Hospital170','p170-hospital','hospital'),
        ('${ORG_SPECIAL}','Special170','Special170','p170-special','specialized_center');

      INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_PRIMARY}','${ORG_SECTOR}','primary_health_center','Primary170','Primary170','active'),
        ('${FAC_SUBORDINATE}','${ORG_SECTOR}','subordinate_health_center','Sub170','Sub170','active'),
        ('${FAC_INACTIVE}','${ORG_SECTOR}','primary_health_center','Inactive170','Inactive170','inactive'),
        ('${FAC_CROSS}','${ORG_SECTOR_2}','primary_health_center','Cross170','Cross170','active');
    `));

    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        ('${INACTIVE_ADMIN}', 'inactive170@rig.local', jsonb_build_object('full_name','Inactive170','role','super_admin')),
        ('${NON_SUPER}', 'nonsuper170@rig.local', jsonb_build_object('full_name','NonSuper170','role','outlet_officer'))
      ON CONFLICT (id) DO NOTHING;
      UPDATE profiles SET role='super_admin', status='suspended' WHERE id='${INACTIVE_ADMIN}';
      UPDATE profiles SET role='outlet_officer', status='active' WHERE id='${NON_SUPER}';
    `));
  });

  afterAll(async () => {
    await rig?.end();
  });

  // ── Shared helpers ──────────────────────────────────────────────────────
  async function makeWarehouse(orgId: string, kind = 'institution'): Promise<string> {
    const id = uniq('00000000-0000-0000-0000-0000017a');
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id)
       VALUES ($1,$2,'WH ${id}','WH ${id}','active',$3,$4,NULL)`,
      [id, orgId, kind, code('wh')],
    ));
    return id;
  }

  async function makePoint(warehouseId: string, orgId: string, pointType = 'pharmacy'): Promise<string> {
    const id = uniq('00000000-0000-0000-0000-0000017b');
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status)
       VALUES ($1,$2,$3,'PT ${id}','PT ${id}',$4,'active')`,
      [id, orgId, warehouseId, pointType],
    ));
    return id;
  }

  async function assign(warehouseId: string, facilityId: string | null, actor = SUPER_ADMIN) {
    return rig.asUser(actor, (c: any) =>
      call(c, 'phoenix_assign_warehouse_facility', [warehouseId, facilityId]),
      { commit: true },
    );
  }

  async function auditCount(warehouseId: string): Promise<number> {
    const r = await rig.asAdmin((c: any) => c.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='warehouse' AND entity_id=$1 AND action='warehouse_facility.assigned'`,
      [warehouseId],
    ));
    return r.rows[0].n;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 0. clean replay 001->170 — primary success proof (MIGRATION_REPLAY)
  // ══════════════════════════════════════════════════════════════════════
  describe('0. clean replay 001->170', () => {
    it('MIGRATION_REPLAY_001_TO_170: both Migration-004 canonical demo organizations are reconciled to hospital, institution_class is hard NOT NULL', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT id, name, institution_class FROM organizations
         WHERE id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')
         ORDER BY id`,
      ));
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0].name).toBe('Babil General Hospital');
      expect(r.rows[0].institution_class).toBe('hospital');
      expect(r.rows[1].name).toBe('Al-Hilla Teaching Hospital');
      expect(r.rows[1].institution_class).toBe('hospital');

      const col = await rig.asAdmin((c: any) => c.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='organizations' AND column_name='institution_class'`,
      ));
      expect(col.rows[0].is_nullable).toBe('NO');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // A. organizations.institution_class — NOT NULL + immutability
  // ══════════════════════════════════════════════════════════════════════
  describe('A. organization class', () => {
    it('A. new organization with NULL institution_class is rejected', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES ($1,'X','X',$2,NULL)`,
        [uniq('00000000-0000-0000-0000-0000017c'), code('nullorg')],
      )));
      expect(msg).toMatch(/null value in column "institution_class"|violates not-null constraint/i);
    });

    it('B/C/D. hospital, health_sector, specialized_center are each accepted', async () => {
      for (const cls of ['hospital', 'health_sector', 'specialized_center']) {
        const id = uniq('00000000-0000-0000-0000-0000017d');
        await rig.asAdmin((c: any) => c.query(
          `INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES ($1,'X','X',$2,$3)`,
          [id, code('cls'), cls],
        ));
        const r = await rig.asAdmin((c: any) => c.query(`SELECT institution_class FROM organizations WHERE id=$1`, [id]));
        expect(r.rows[0].institution_class).toBe(cls);
      }
    });

    it('E. a fourth/invalid class is rejected by the preserved CHECK', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES ($1,'X','X',$2,'health_center')`,
        [uniq('00000000-0000-0000-0000-0000017e'), code('invalidorg')],
      )));
      expect(msg).toMatch(/organizations_institution_class_chk|violates check constraint/i);
    });

    describe('immutability', () => {
      let hospOrg: string;
      beforeAll(async () => {
        hospOrg = uniq('00000000-0000-0000-0000-0000017f');
        await rig.asAdmin((c: any) => c.query(
          `INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES ($1,'ImmutTest','ImmutTest',$2,'hospital')`,
          [hospOrg, code('immut')],
        ));
      });

      it('F. hospital -> specialized_center is rejected', async () => {
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `UPDATE organizations SET institution_class='specialized_center' WHERE id=$1`, [hospOrg],
        )));
        expect(msg).toContain('organization_institution_class_immutable');
      });

      it('G. specialized_center -> hospital is rejected (symmetric)', async () => {
        const scOrg = uniq('00000000-0000-0000-0000-000001780');
        await rig.asAdmin((c: any) => c.query(
          `INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES ($1,'X','X',$2,'specialized_center')`,
          [scOrg, code('sc')],
        ));
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `UPDATE organizations SET institution_class='hospital' WHERE id=$1`, [scOrg],
        )));
        expect(msg).toContain('organization_institution_class_immutable');
      });

      it('H. health_sector -> hospital is rejected', async () => {
        const hsOrg = uniq('00000000-0000-0000-0000-000001781');
        await rig.asAdmin((c: any) => c.query(
          `INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES ($1,'X','X',$2,'health_sector')`,
          [hsOrg, code('hs')],
        ));
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `UPDATE organizations SET institution_class='hospital' WHERE id=$1`, [hsOrg],
        )));
        expect(msg).toContain('organization_institution_class_immutable');
      });

      it('I. non-NULL -> NULL is rejected', async () => {
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `UPDATE organizations SET institution_class=NULL WHERE id=$1`, [hospOrg],
        )));
        expect(msg).toMatch(/organization_institution_class_immutable|violates not-null constraint/i);
      });

      it('J. UPDATE re-setting the SAME institution_class is accepted', async () => {
        await expect(rig.asAdmin((c: any) => c.query(
          `UPDATE organizations SET institution_class='hospital' WHERE id=$1`, [hospOrg],
        ))).resolves.toBeDefined();
        const r = await rig.asAdmin((c: any) => c.query(`SELECT institution_class FROM organizations WHERE id=$1`, [hospOrg]));
        expect(r.rows[0].institution_class).toBe('hospital');
      });

      it('K. UPDATE of name/city/email/status without touching institution_class is accepted', async () => {
        await expect(rig.asAdmin((c: any) => c.query(
          `UPDATE organizations SET name='Renamed170', city='Babil', contact_email='x@example.com', status='active' WHERE id=$1`,
          [hospOrg],
        ))).resolves.toBeDefined();
        const r = await rig.asAdmin((c: any) => c.query(`SELECT institution_class, name FROM organizations WHERE id=$1`, [hospOrg]));
        expect(r.rows[0].institution_class).toBe('hospital');
        expect(r.rows[0].name).toBe('Renamed170');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // B. warehouse facility assignment — PASS / REJECT matrix
  // ══════════════════════════════════════════════════════════════════════
  describe('B. warehouse facility assignment', () => {
    it('unused health_sector institution warehouse + same-org active primary_health_center => PASS', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const r = await assign(wh, FAC_PRIMARY);
      expect(r.ok).toBe(true);
      const row = await rig.asAdmin((c: any) => c.query(`SELECT facility_id FROM warehouses WHERE id=$1`, [wh]));
      expect(row.rows[0].facility_id).toBe(FAC_PRIMARY);
      expect(await auditCount(wh)).toBe(1);
    });

    it('unused health_sector institution warehouse + same-org active subordinate_health_center => PASS', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const r = await assign(wh, FAC_SUBORDINATE);
      expect(r.ok).toBe(true);
      expect(await auditCount(wh)).toBe(1);
    });

    it('cross-organization facility => REJECT, audit delta 0', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const msg = await rejects(() => assign(wh, FAC_CROSS));
      expect(msg).toContain('target_facility_organization_mismatch');
      expect(await auditCount(wh)).toBe(0);
    });

    it('hospital warehouse + non-NULL facility => REJECT', async () => {
      const wh = await makeWarehouse(ORG_HOSPITAL);
      const msg = await rejects(() => assign(wh, FAC_PRIMARY));
      expect(msg).toContain('warehouse_organization_not_health_sector');
      expect(await auditCount(wh)).toBe(0);
    });

    it('specialized_center warehouse + non-NULL facility => REJECT', async () => {
      const wh = await makeWarehouse(ORG_SPECIAL);
      const msg = await rejects(() => assign(wh, FAC_PRIMARY));
      expect(msg).toContain('warehouse_organization_not_health_sector');
      expect(await auditCount(wh)).toBe(0);
    });

    it('central warehouse + non-NULL facility => REJECT', async () => {
      const wh = await makeWarehouse(ORG_SECTOR, 'central');
      const msg = await rejects(() => assign(wh, FAC_PRIMARY));
      expect(msg).toContain('warehouse_kind_not_institution');
      expect(await auditCount(wh)).toBe(0);
    });

    it('inactive facility => REJECT', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const msg = await rejects(() => assign(wh, FAC_INACTIVE));
      expect(msg).toContain('facility_not_active');
      expect(await auditCount(wh)).toBe(0);
    });

    it('invalid (non-existent) facility => REJECT', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const msg = await rejects(() => assign(wh, FAC_GHOST));
      expect(msg).toContain('facility_not_found');
      expect(await auditCount(wh)).toBe(0);
    });

    it('unauthenticated => REJECT', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const msg = await rejects(() => rig.asUser(null as any, (c: any) =>
        call(c, 'phoenix_assign_warehouse_facility', [wh, FAC_PRIMARY]), { commit: true }));
      expect(msg).toContain('not_authenticated');
      expect(await auditCount(wh)).toBe(0);
    });

    it('inactive profile => REJECT', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const msg = await rejects(() => assign(wh, FAC_PRIMARY, INACTIVE_ADMIN));
      expect(msg).toContain('active_profile_required');
      expect(await auditCount(wh)).toBe(0);
    });

    it('non-super_admin => REJECT', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const msg = await rejects(() => assign(wh, FAC_PRIMARY, NON_SUPER));
      expect(msg).toContain('forbidden_warehouse_facility_assign');
      expect(await auditCount(wh)).toBe(0);
    });

    it('facility assignment produces EXACTLY one audit row', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      await assign(wh, FAC_PRIMARY);
      expect(await auditCount(wh)).toBe(1);
    });

    it('same-value no-op re-assignment produces audit delta 0', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      await assign(wh, FAC_PRIMARY);
      expect(await auditCount(wh)).toBe(1);
      const r = await assign(wh, FAC_PRIMARY); // same value again
      expect(r.ok).toBe(true);
      expect(await auditCount(wh)).toBe(1); // unchanged — no second row
    });

    it('clearing (facility -> NULL) on an otherwise-unused warehouse => PASS, one more audit row', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      await assign(wh, FAC_PRIMARY);
      const r = await assign(wh, null);
      expect(r.ok).toBe(true);
      const row = await rig.asAdmin((c: any) => c.query(`SELECT facility_id FROM warehouses WHERE id=$1`, [wh]));
      expect(row.rows[0].facility_id).toBeNull();
      expect(await auditCount(wh)).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C. raw-UPDATE bypass regression
  // ══════════════════════════════════════════════════════════════════════
  describe('C. raw UPDATE bypass', () => {
    it('a raw UPDATE by an authenticated non-super_admin is REJECTED — no facility change, no audit row', async () => {
      // No role in this system's role_permission_defaults holds
      // warehouses.manage by default (confirmed read-only against the
      // catalog), so an ordinary non-super_admin outlet_officer fails
      // wh_update_perm's own RLS USING clause before the row is even
      // visible for UPDATE — the statement affects zero rows and returns
      // normally (Postgres does not raise for a WHERE/RLS predicate that
      // matches nothing). This is a STRONGER outcome than a thrown
      // exception: RLS is the first wall, and the trigger below (D.1) is
      // proven as the independent second wall for any actor who DOES hold
      // warehouse-management scope but is still not super_admin.
      const wh = await makeWarehouse(ORG_SECTOR);
      await rig.asUser(NON_SUPER, (c: any) => c.query(
        `UPDATE public.warehouses SET facility_id = $1 WHERE id = $2`, [FAC_PRIMARY, wh],
      ), { commit: true });
      const row = await rig.asAdmin((c: any) => c.query(`SELECT facility_id FROM warehouses WHERE id=$1`, [wh]));
      expect(row.rows[0].facility_id).toBeNull();
      expect(await auditCount(wh)).toBe(0);
    });

    it('a raw super_admin UPDATE hits the identical dependency guard as the RPC — no weaker path', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,has_no_batch_number,has_no_national_code,internal_batch_reference)
         VALUES (gen_random_uuid(),$1,$2,'Paracetamol',true,true,'IBR-C2')`,
        [ORG_SECTOR, wh],
      ));
      const msg = await rejects(() => rig.asUser(SUPER_ADMIN, (c: any) => c.query(
        `UPDATE public.warehouses SET facility_id = $1 WHERE id = $2`, [FAC_PRIMARY, wh],
      ), { commit: true }));
      expect(msg).toContain('warehouse_facility_reassignment_blocked_operational_dependency');
      expect(await auditCount(wh)).toBe(0);
    });

    it('a raw super_admin UPDATE on a genuinely unused warehouse succeeds identically to the RPC (same trigger, same audit)', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      await rig.asUser(SUPER_ADMIN, (c: any) => c.query(
        `UPDATE public.warehouses SET facility_id = $1 WHERE id = $2`, [FAC_PRIMARY, wh],
      ), { commit: true });
      const row = await rig.asAdmin((c: any) => c.query(`SELECT facility_id FROM warehouses WHERE id=$1`, [wh]));
      expect(row.rows[0].facility_id).toBe(FAC_PRIMARY);
      expect(await auditCount(wh)).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // D. the full 19-table operational-dependency guard — parameterized
  // ══════════════════════════════════════════════════════════════════════
  interface DepCase {
    name: string;
    seed: (wh: string, pt: string) => Promise<void>;
    clear: (wh: string, pt: string) => Promise<void>;
    needsPoint?: boolean;
  }

  const q = (c: any, sql: string, params: unknown[] = []) => c.query(sql, params);

  const depCases: DepCase[] = [
    {
      name: '1. warehouse_stock',
      seed: async (wh) => rig.asAdmin((c: any) => q(c,
        `INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,has_no_batch_number,has_no_national_code,internal_batch_reference)
         VALUES (gen_random_uuid(),$1,$2,'X',true,true,'IBR-D1')`,
        [ORG_SECTOR, wh])),
      clear: async (wh) => rig.asAdmin((c: any) => q(c, `DELETE FROM warehouse_stock WHERE warehouse_id=$1`, [wh])),
    },
    {
      name: '2. warehouse_stock_movements',
      seed: async (wh) => rig.asAdmin(async (c: any) => {
        const stockId = (await q(c,
          `INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,has_no_batch_number,has_no_national_code,internal_batch_reference)
           VALUES (gen_random_uuid(),$1,$2,'X',true,true,'IBR-D2') RETURNING id`,
          [ORG_SECTOR, wh])).rows[0].id;
        await q(c,
          `INSERT INTO warehouse_stock_movements(id,warehouse_stock_id,organization_id,warehouse_id,movement_type,
             on_hand_before,on_hand_delta,on_hand_after,reserved_before,reserved_delta,reserved_after,scientific_name_snapshot,reason)
           VALUES (gen_random_uuid(),$1,$2,$3,'set_exact',0,0,0,0,0,0,'X','initial count')`,
          [stockId, ORG_SECTOR, wh]);
      }),
      clear: async (wh) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM warehouse_stock_movements WHERE warehouse_id=$1`, [wh]);
        await q(c, `DELETE FROM warehouse_stock WHERE warehouse_id=$1`, [wh]);
      }),
    },
    {
      name: '3. warehouse_dispatches',
      seed: async (wh, pt) => rig.asAdmin((c: any) => q(c,
        `INSERT INTO warehouse_dispatches(id,organization_id,warehouse_id,destination_distribution_point_id,dispatch_number)
         VALUES (gen_random_uuid(),$1,$2,$3,$4)`,
        [ORG_SECTOR, wh, pt, code('disp')])),
      clear: async (wh) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM warehouse_dispatches WHERE warehouse_id=$1`, [wh]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
    {
      name: '4. warehouse_quarantine_stock',
      seed: async (wh) => rig.asAdmin((c: any) => q(c,
        `INSERT INTO warehouse_quarantine_stock(id,organization_id,warehouse_id,scientific_name,quarantine_reason,has_no_batch_number,has_no_national_code)
         VALUES (gen_random_uuid(),$1,$2,'X','damaged',true,true)`,
        [ORG_SECTOR, wh])),
      clear: async (wh) => rig.asAdmin((c: any) => q(c, `DELETE FROM warehouse_quarantine_stock WHERE warehouse_id=$1`, [wh])),
    },
    {
      name: '5. warehouse_transfers',
      seed: async (wh) => rig.asAdmin(async (c: any) => {
        const other = await makeWarehouse(ORG_SECTOR);
        await q(c,
          `INSERT INTO warehouse_transfers(id,source_warehouse_id,source_organization_id,destination_warehouse_id,
             destination_organization_id,transfer_number)
           VALUES (gen_random_uuid(),$1,$2,$3,$2,$4)`,
          [wh, ORG_SECTOR, other, code('xfer')]);
      }),
      clear: async (wh) => rig.asAdmin((c: any) => q(c,
        `DELETE FROM warehouse_transfers WHERE source_warehouse_id=$1 OR destination_warehouse_id=$1`, [wh])),
    },
    {
      name: '6. warehouse_transfer_requests',
      seed: async (wh) => rig.asAdmin(async (c: any) => {
        const other = await makeWarehouse(ORG_SECTOR);
        await q(c,
          `INSERT INTO warehouse_transfer_requests(id,source_warehouse_id,source_organization_id,destination_warehouse_id,
             destination_organization_id,request_number,status)
           VALUES (gen_random_uuid(),$1,$2,$3,$2,$4,'draft')`,
          [wh, ORG_SECTOR, other, code('xreq')]);
      }),
      clear: async (wh) => rig.asAdmin((c: any) => q(c,
        `DELETE FROM warehouse_transfer_requests WHERE source_warehouse_id=$1 OR destination_warehouse_id=$1`, [wh])),
    },
    {
      name: '7. warehouse_return_shipments',
      seed: async (wh) => rig.asAdmin(async (c: any) => {
        const other = await makeWarehouse(ORG_SECTOR);
        await q(c,
          `INSERT INTO warehouse_return_shipments(id,source_warehouse_id,source_organization_id,destination_warehouse_id,
             destination_organization_id,shipment_number)
           VALUES (gen_random_uuid(),$1,$2,$3,$2,$4)`,
          [wh, ORG_SECTOR, other, code('rship')]);
      }),
      clear: async (wh) => rig.asAdmin((c: any) => q(c,
        `DELETE FROM warehouse_return_shipments WHERE source_warehouse_id=$1 OR destination_warehouse_id=$1`, [wh])),
    },
    {
      name: '8. warehouse_return_requests',
      seed: async (wh) => rig.asAdmin(async (c: any) => {
        const other = await makeWarehouse(ORG_SECTOR);
        await q(c,
          `INSERT INTO warehouse_return_requests(id,source_warehouse_id,source_organization_id,destination_warehouse_id,
             destination_organization_id,return_number,requested_by_side)
           VALUES (gen_random_uuid(),$1,$2,$3,$2,$4,'sender')`,
          [wh, ORG_SECTOR, other, code('rreq')]);
      }),
      clear: async (wh) => rig.asAdmin((c: any) => q(c,
        `DELETE FROM warehouse_return_requests WHERE source_warehouse_id=$1 OR destination_warehouse_id=$1`, [wh])),
    },
    {
      name: '9. warehouse_supply_routes',
      seed: async (wh) => rig.asAdmin(async (c: any) => {
        // warehouse_supply_routes_source_central_fk requires the SOURCE row to
        // actually be a warehouse_kind='central' warehouse — wh (this test's
        // subject) is 'institution', so it must be the TARGET; a fresh
        // 'central' warehouse plays the source.
        const central = await makeWarehouse(ORG_SECTOR, 'central');
        await q(c,
          `INSERT INTO warehouse_supply_routes(id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind)
           VALUES (gen_random_uuid(),$1,$2,'central','institution')`,
          [central, wh]);
      }),
      clear: async (wh) => rig.asAdmin((c: any) => q(c,
        `DELETE FROM warehouse_supply_routes WHERE source_warehouse_id=$1 OR target_warehouse_id=$1`, [wh])),
    },
    {
      name: '10. outlet_return_requests (destination_warehouse_id)',
      seed: async (wh, pt) => rig.asAdmin((c: any) => q(c,
        `INSERT INTO outlet_return_requests(id,distribution_point_id,source_organization_id,destination_warehouse_id,
           destination_organization_id,return_number,requested_by_side)
         VALUES (gen_random_uuid(),$1,$2,$3,$2,$4,'sender')`,
        [pt, ORG_SECTOR, wh, code('oret')])),
      clear: async (wh) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM outlet_return_requests WHERE destination_warehouse_id=$1`, [wh]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
    {
      name: '11. outlet_return_shipments (destination_warehouse_id)',
      seed: async (wh, pt) => rig.asAdmin((c: any) => q(c,
        `INSERT INTO outlet_return_shipments(id,distribution_point_id,source_organization_id,destination_warehouse_id,
           destination_organization_id,shipment_number)
         VALUES (gen_random_uuid(),$1,$2,$3,$2,$4)`,
        [pt, ORG_SECTOR, wh, code('oship')])),
      clear: async (wh) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM outlet_return_shipments WHERE destination_warehouse_id=$1`, [wh]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
    {
      name: '12. procurement_orders',
      seed: async (wh) => rig.asAdmin(async (c: any) => {
        const supplierId = (await q(c,
          `INSERT INTO procurement_suppliers(id,organization_id,name,name_ar) VALUES (gen_random_uuid(),$1,'S','S') RETURNING id`,
          [ORG_SECTOR])).rows[0].id;
        await q(c,
          `INSERT INTO procurement_orders(id,organization_id,warehouse_id,supplier_id,order_number,created_by)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`,
          [ORG_SECTOR, wh, supplierId, code('po'), SUPER_ADMIN]);
      }),
      clear: async (wh) => rig.asAdmin((c: any) => q(c, `DELETE FROM procurement_orders WHERE warehouse_id=$1`, [wh])),
    },
    {
      name: '13. distribution_points existence',
      seed: async (_wh, _pt) => { /* the point created by the harness IS the dependency */ },
      clear: async (wh) => rig.asAdmin((c: any) => q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh])),
      needsPoint: true,
    },
    {
      name: '14. outlet_stock',
      seed: async (_wh, pt) => rig.asAdmin((c: any) => q(c,
        `INSERT INTO outlet_stock(id,organization_id,distribution_point_id,point_type,scientific_name,has_no_batch_number,has_no_national_code,internal_batch_reference)
         VALUES (gen_random_uuid(),$1,$2,'pharmacy','X',true,true,'IBR-D14')`,
        [ORG_SECTOR, pt])),
      clear: async (wh, pt) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
    {
      name: '15. outlet_stock_movements',
      seed: async (_wh, pt) => rig.asAdmin(async (c: any) => {
        const stockId = (await q(c,
          `INSERT INTO outlet_stock(id,organization_id,distribution_point_id,point_type,scientific_name,has_no_batch_number,has_no_national_code,internal_batch_reference)
           VALUES (gen_random_uuid(),$1,$2,'pharmacy','X',true,true,'IBR-D15') RETURNING id`,
          [ORG_SECTOR, pt])).rows[0].id;
        await q(c,
          `INSERT INTO outlet_stock_movements(id,outlet_stock_id,organization_id,distribution_point_id,movement_type,
             on_hand_before,on_hand_delta,on_hand_after,reserved_before,reserved_delta,reserved_after,scientific_name_snapshot,reason)
           VALUES (gen_random_uuid(),$1,$2,$3,'set_exact',0,0,0,0,0,0,'X','initial count')`,
          [stockId, ORG_SECTOR, pt]);
      }),
      clear: async (wh, pt) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM outlet_stock_movements WHERE distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
    {
      name: '16. outlet_replenishment_routes',
      seed: async (_wh, pt) => rig.asAdmin(async (c: any) => {
        const otherWh = await makeWarehouse(ORG_SECTOR);
        const otherPt = await makePoint(otherWh, ORG_SECTOR, 'crash_cabinet');
        await q(c,
          `INSERT INTO outlet_replenishment_routes(id,organization_id,source_point_id,destination_point_id,destination_point_type)
           VALUES (gen_random_uuid(),$1,$2,$3,'crash_cabinet')`,
          [ORG_SECTOR, pt, otherPt]);
      }),
      clear: async (wh, pt) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM outlet_replenishment_routes WHERE source_point_id=$1 OR destination_point_id=$1`, [pt]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
    {
      name: '17. item_availability / item_availability_movements',
      seed: async (_wh, pt) => rig.asAdmin((c: any) => q(c,
        `INSERT INTO item_availability(id,distribution_point_id,organization_id,quantity,condition,port_name)
         VALUES (gen_random_uuid(),$1,$2,0,'available','X')`,
        [pt, ORG_SECTOR])),
      clear: async (wh, pt) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM item_availability WHERE distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
    {
      name: '18. phoenix_movement_dispense_context',
      seed: async (_wh, pt) => rig.asAdmin(async (c: any) => {
        const stockId = (await q(c,
          `INSERT INTO outlet_stock(id,organization_id,distribution_point_id,point_type,scientific_name,has_no_batch_number,has_no_national_code,internal_batch_reference)
           VALUES (gen_random_uuid(),$1,$2,'pharmacy','X',true,true,'IBR-D18') RETURNING id`,
          [ORG_SECTOR, pt])).rows[0].id;
        const movementId = (await q(c,
          `INSERT INTO outlet_stock_movements(id,outlet_stock_id,organization_id,distribution_point_id,movement_type,
             on_hand_before,on_hand_delta,on_hand_after,reserved_before,reserved_delta,reserved_after,scientific_name_snapshot)
           VALUES (gen_random_uuid(),$1,$2,$3,'dispense',0,0,0,0,0,0,'X') RETURNING id`,
          [stockId, ORG_SECTOR, pt])).rows[0].id;
        await q(c,
          `INSERT INTO phoenix_movement_dispense_context(id,movement_id,organization_id,distribution_point_id,
             beneficiary_type,internal_order_reference,recorded_by,request_fingerprint)
           VALUES (gen_random_uuid(),$1,$2,$3,'internal_order','ORD-D18',$4,$5)`,
          [movementId, ORG_SECTOR, pt, SUPER_ADMIN, 'a'.repeat(64)]);
      }),
      clear: async (wh, pt) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM phoenix_movement_dispense_context WHERE distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM outlet_stock_movements WHERE distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
    {
      name: '19. inter_org_exchange_requests',
      seed: async (_wh, pt) => rig.asAdmin(async (c: any) => {
        const srcAvail = (await q(c,
          `INSERT INTO item_availability(id,distribution_point_id,organization_id,quantity,condition,port_name)
           VALUES (gen_random_uuid(),$1,$2,5,'available','X') RETURNING id`,
          [pt, ORG_SECTOR])).rows[0].id;
        const otherWh = await makeWarehouse(ORG_SECTOR_2);
        const otherPt = await makePoint(otherWh, ORG_SECTOR_2, 'pharmacy');
        const dstAvail = (await q(c,
          `INSERT INTO item_availability(id,distribution_point_id,organization_id,quantity,condition,port_name)
           VALUES (gen_random_uuid(),$1,$2,0,'missing','X') RETURNING id`,
          [otherPt, ORG_SECTOR_2])).rows[0].id;
        await q(c,
          `INSERT INTO inter_org_exchange_requests(id,alert_key,source_item_availability_id,target_item_availability_id,
             source_organization_id,target_organization_id,source_distribution_point_id,target_distribution_point_id,
             scientific_name,requested_quantity)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'X',1)`,
          [code('iox'), srcAvail, dstAvail, ORG_SECTOR, ORG_SECTOR_2, pt, otherPt]);
      }),
      clear: async (wh, pt) => rig.asAdmin(async (c: any) => {
        await q(c, `DELETE FROM inter_org_exchange_requests WHERE source_distribution_point_id=$1 OR target_distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM item_availability WHERE distribution_point_id=$1`, [pt]);
        await q(c, `DELETE FROM distribution_points WHERE warehouse_id=$1`, [wh]);
      }),
      needsPoint: true,
    },
  ];

  describe.each(depCases)('D. dependency guard — $name', ({ seed, clear, needsPoint }) => {
    it('blocks reassignment while the dependency exists, then allows it once cleared (regardless of status)', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const pt = needsPoint ? await makePoint(wh, ORG_SECTOR) : '';

      await seed(wh, pt);

      const msg = await rejects(() => assign(wh, FAC_PRIMARY));
      expect(msg).toContain('warehouse_facility_reassignment_blocked_operational_dependency');
      expect(await auditCount(wh)).toBe(0);
      const stillNull = await rig.asAdmin((c: any) => c.query(`SELECT facility_id FROM warehouses WHERE id=$1`, [wh]));
      expect(stillNull.rows[0].facility_id).toBeNull();

      await clear(wh, pt);

      const r = await assign(wh, FAC_PRIMARY);
      expect(r.ok).toBe(true);
      expect(await auditCount(wh)).toBe(1);
    });
  });

  it('the dependency guard is NOT limited to active status — a cancelled/inactive-status row still blocks', async () => {
    const wh = await makeWarehouse(ORG_SECTOR);
    const other = await makeWarehouse(ORG_SECTOR);
    await rig.asAdmin((c: any) => q(c,
      `INSERT INTO warehouse_transfer_requests(id,source_warehouse_id,source_organization_id,destination_warehouse_id,
         destination_organization_id,request_number,status,cancelled_at,cancellation_reason)
       VALUES (gen_random_uuid(),$1,$2,$3,$2,$4,'cancelled',now(),'test cancellation')`,
      [wh, ORG_SECTOR, other, code('cancelled')]));
    const msg = await rejects(() => assign(wh, FAC_PRIMARY));
    expect(msg).toContain('warehouse_facility_reassignment_blocked_operational_dependency');
  });

  it('an inactive outlet_replenishment_route (is_active=false) still blocks — not limited to active routes', async () => {
    const wh = await makeWarehouse(ORG_SECTOR);
    const pt = await makePoint(wh, ORG_SECTOR);
    const otherWh = await makeWarehouse(ORG_SECTOR);
    const otherPt = await makePoint(otherWh, ORG_SECTOR, 'crash_cabinet');
    await rig.asAdmin((c: any) => q(c,
      `INSERT INTO outlet_replenishment_routes(id,organization_id,source_point_id,destination_point_id,destination_point_type,is_active)
       VALUES (gen_random_uuid(),$1,$2,$3,'crash_cabinet',false)`,
      [ORG_SECTOR, pt, otherPt]));
    const msg = await rejects(() => assign(wh, FAC_PRIMARY));
    expect(msg).toContain('warehouse_facility_reassignment_blocked_operational_dependency');
  });

  // ══════════════════════════════════════════════════════════════════════
  // E. warehouse-facility concurrency — trigger-local lock closes the race
  //    (WAREHOUSE_FACILITY_CONCURRENCY_RESULT / RAW_UPDATE_CONCURRENCY_RESULT)
  // ══════════════════════════════════════════════════════════════════════
  // Two genuinely concurrent transactions on two independent raw connections
  // from the shared rig pool — real Postgres row-lock contention, not a
  // simulated race. Required invariant: there is no commit ordering in which
  // a facility assignment observes "unused" AND a concurrently-established
  // operational dependency commits without being respected. Both entry paths
  // (the RPC and a raw super_admin UPDATE) and both orderings (facility
  // mutation first, dependency creation first) are proven for two
  // representative dependency tables: distribution_points (a direct FK to
  // warehouses(id)) and warehouse_stock (a composite FK to warehouses(id,
  // organization_id)).
  interface ConcurrencyCase {
    label: string;
    mutate: (t1: any, wh: string, fac: string) => Promise<unknown>;
    seedDependency: (t2: any, wh: string, org: string) => Promise<unknown>;
  }

  const seedDistributionPoint = (t2: any, wh: string, org: string) => t2.query(
    `INSERT INTO distribution_points(id,organization_id,warehouse_id,name,name_ar,point_type,status)
     VALUES (gen_random_uuid(),$1,$2,'RaceDP','RaceDP','pharmacy','active')`,
    [org, wh],
  );
  const seedWarehouseStock = (t2: any, wh: string, org: string) => t2.query(
    `INSERT INTO warehouse_stock(id,organization_id,warehouse_id,scientific_name,has_no_batch_number,has_no_national_code,internal_batch_reference)
     VALUES (gen_random_uuid(),$1,$2,'RaceStock',true,true,'IBR-RACE')`,
    [org, wh],
  );
  const mutateViaRpc = (t1: any, wh: string, fac: string) => call(t1, 'phoenix_assign_warehouse_facility', [wh, fac]);
  const mutateViaRawUpdate = (t1: any, wh: string, fac: string) => t1.query(
    `UPDATE public.warehouses SET facility_id = $1 WHERE id = $2`, [fac, wh],
  );

  const concurrencyCases: ConcurrencyCase[] = [
    { label: 'A/B1. RPC vs concurrent distribution_point creation', mutate: mutateViaRpc, seedDependency: seedDistributionPoint },
    { label: 'B. RAW super_admin UPDATE vs concurrent distribution_point creation', mutate: mutateViaRawUpdate, seedDependency: seedDistributionPoint },
    { label: 'C. RPC vs concurrent warehouse_stock creation', mutate: mutateViaRpc, seedDependency: seedWarehouseStock },
    { label: 'D. RAW super_admin UPDATE vs concurrent warehouse_stock creation', mutate: mutateViaRawUpdate, seedDependency: seedWarehouseStock },
  ];

  async function rawClient(): Promise<any> {
    return rig.pool.connect();
  }
  async function beginAsUser(userId: string): Promise<any> {
    const c = await rawClient();
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    return c;
  }

  describe.each(concurrencyCases)('E. concurrency — $label', ({ mutate, seedDependency }) => {
    it('facility mutation obtains serialization first: concurrent dependency creation waits, then proceeds only against the new, already-committed facility context', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const t1 = await beginAsUser(SUPER_ADMIN);
      await mutate(t1, wh, FAC_PRIMARY); // runs to completion inside t1's still-open txn; holds FOR UPDATE

      const t2 = await rawClient();
      await t2.query('BEGIN');
      const insertPromise = seedDependency(t2, wh, ORG_SECTOR);
      const race = await pending(insertPromise, 500);
      expect(race).toBe('pending'); // T2 must be blocked on T1's row lock, not free to proceed

      await t1.query('COMMIT');
      t1.release();

      await insertPromise; // now resolves — dependency created strictly after the facility commit
      await t2.query('COMMIT');
      t2.release();

      const row = await rig.asAdmin((c: any) => c.query(`SELECT facility_id FROM warehouses WHERE id=$1`, [wh]));
      expect(row.rows[0].facility_id).toBe(FAC_PRIMARY);
    });

    it('dependency creation obtains serialization first: concurrent facility mutation waits, then is rejected once it resumes and observes the committed dependency', async () => {
      const wh = await makeWarehouse(ORG_SECTOR);
      const t2 = await rawClient();
      await t2.query('BEGIN');
      await seedDependency(t2, wh, ORG_SECTOR); // completes immediately (nothing contends yet), not committed

      const t1 = await beginAsUser(SUPER_ADMIN);
      const mutatePromise = mutate(t1, wh, FAC_PRIMARY);
      const race = await pending(mutatePromise, 500);
      expect(race).toBe('pending'); // T1 must be blocked waiting for T2's FK-driven row lock

      await t2.query('COMMIT');
      t2.release();

      const msg = await rejects(() => mutatePromise);
      expect(msg).toContain('warehouse_facility_reassignment_blocked_operational_dependency');
      await t1.query('ROLLBACK').catch(() => {});
      t1.release();

      const row = await rig.asAdmin((c: any) => c.query(`SELECT facility_id FROM warehouses WHERE id=$1`, [wh]));
      expect(row.rows[0].facility_id).toBeNull(); // no partial/observed-stale assignment ever committed
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// F. unknown NULL organization still fails closed (atomicity)
//    (UNKNOWN_NULL_ORGANIZATION_RESULT / M170_FAILURE_ATOMICITY)
// ════════════════════════════════════════════════════════════════════════
run('170 · F. unknown NULL organization still fails closed', () => {
  it('a third, non-fixture organization with NULL institution_class aborts the whole migration 170 transaction — nothing partial commits', async () => {
    const c = await buildTo169();
    try {
      await c.query(
        `INSERT INTO organizations(id,name,name_ar,code,status,city) VALUES
         ('00000000-0000-0000-0000-000001700f01','Unknown Org','Unknown Org','unknown-170','active','X')`,
      );

      let rejected = false;
      let message = '';
      try {
        await c.query(MIGRATION_170_SQL);
      } catch (e: any) {
        rejected = true;
        message = String(e?.message ?? e);
      }
      expect(rejected).toBe(true);
      expect(message).toMatch(/PREFLIGHT FAILED \(170\).*NULL institution_class/);
      await c.query('ROLLBACK');

      // Atomicity: NOTHING from the aborted migration committed.
      const col = await c.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='organizations' AND column_name='institution_class'`,
      );
      expect(col.rows[0].is_nullable).toBe('YES'); // ALTER ... SET NOT NULL never committed

      const rpc = await c.query(`SELECT to_regprocedure('public.phoenix_assign_warehouse_facility(uuid, uuid)') AS f`);
      expect(rpc.rows[0].f).toBeNull(); // the RPC was never committed

      const guardTrg = await c.query(
        `SELECT 1 FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid
         WHERE cl.relname = 'warehouses' AND t.tgname = 'warehouses_facility_assignment_guard_trg'`,
      );
      expect(guardTrg.rows).toHaveLength(0); // no trigger was committed either

      // The two Migration-004 fixtures were NOT reconciled — rolled back with
      // everything else in the same aborted transaction (no partial commit).
      const fixtures = await c.query(
        `SELECT institution_class FROM organizations WHERE id IN
         ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')
         ORDER BY id`,
      );
      expect(fixtures.rows).toHaveLength(2);
      for (const row of fixtures.rows) expect(row.institution_class).toBeNull();
    } finally {
      await c.end();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// G. tampered canonical fixture identity is rejected (atomicity)
//    (TAMPERED_CANONICAL_FIXTURE_RESULT)
// ════════════════════════════════════════════════════════════════════════
run('170 · G. tampered canonical fixture identity is rejected', () => {
  it('a Migration-004 fixture UUID whose identity no longer matches raises canonical_demo_fixture_identity_mismatch and rolls back entirely — a fixed UUID alone is not sufficient proof', async () => {
    const c = await buildTo169();
    try {
      // Tamper ONE identity-defining field of one fixed fixture UUID, leaving
      // institution_class NULL (as it always is at ceiling 169).
      await c.query(
        `UPDATE organizations SET code = 'tampered-code-170' WHERE id = '00000000-0000-0000-0000-000000000001'`,
      );

      let rejected = false;
      let message = '';
      try {
        await c.query(MIGRATION_170_SQL);
      } catch (e: any) {
        rejected = true;
        message = String(e?.message ?? e);
      }
      expect(rejected).toBe(true);
      expect(message).toContain('canonical_demo_fixture_identity_mismatch');
      await c.query('ROLLBACK');

      // Full rollback: the ALTER never committed either.
      const col = await c.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='organizations' AND column_name='institution_class'`,
      );
      expect(col.rows[0].is_nullable).toBe('YES');

      // The tampered row's institution_class also stayed NULL — not silently
      // reclassified despite carrying the exact fixed UUID.
      const tampered = await c.query(
        `SELECT institution_class, code FROM organizations WHERE id = '00000000-0000-0000-0000-000000000001'`,
      );
      expect(tampered.rows[0].institution_class).toBeNull();
      expect(tampered.rows[0].code).toBe('tampered-code-170');
    } finally {
      await c.end();
    }
  });
});
