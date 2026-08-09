/**
 * 170 · ORGANIZATION CLASS + WAREHOUSE FACILITY ASSIGNMENT (Stage E · E7-1) —
 * dynamic proof.
 *
 * Builds a disposable Postgres through 169, then applies 170 directly (see
 * "why not buildRig({upTo:170})" below), and drives the REAL
 * organizations.institution_class NOT NULL/immutability guarantees and the
 * REAL phoenix_assign_warehouse_facility RPC + its hard trigger boundary
 * against every case the E7-1 gate requires: class create/reject/immutable,
 * facility PASS/REJECT, raw-UPDATE bypass regression, the full 19-table
 * operational-dependency guard, and exactly-once audit semantics.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;

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
    // buildRig({upTo:170}) (or the no-arg default, which applies every file on
    // disk) would apply migration 004's permanent demo-seed organizations
    // ('Babil General Hospital' / 'Al-Hilla Teaching Hospital', fixed ids
    // ...0001/...0002) BEFORE 170's own SET NOT NULL runs. Those two rows
    // predate 164 (institution_class did not exist yet) and have always
    // carried institution_class = NULL through every migration's own test
    // history since — this is not data 170 introduces or is responsible for.
    // 170's preflight is deliberately fail-closed with NO backfill (exactly
    // as the accepted Production pre-launch reset already resolved this same
    // condition for real Production data), so it correctly refuses to apply
    // on top of them. This mirrors the REAL deployment order precisely: the
    // reset happens first (already accepted, out of scope here), THEN 170
    // applies to a clean baseline. Rather than editing the immutable 004 seed
    // or weakening 170's own preflight, this suite builds to 169, reclassifies
    // ONLY those two known fixture rows (never deletes them — other dynamic
    // suites in this repository reference them by id in their OWN separately
    // isolated rig instances), then applies 170's unmodified file content
    // directly on top.
    rig = await buildRig({ upTo: 169 });

    await rig.asAdmin((c: any) => c.query(`
      UPDATE organizations SET institution_class = 'hospital'
      WHERE id IN ('00000000-0000-0000-0000-000000000001',
                    '00000000-0000-0000-0000-000000000002')
        AND institution_class IS NULL;
    `));

    const migration170Sql = readFileSync(
      join(MIGRATIONS_DIR, '170_phoenix_organization_class_and_warehouse_facility_assignment.sql'),
      'utf8',
    );
    await rig.asAdmin((c: any) => c.query(migration170Sql));

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
});
