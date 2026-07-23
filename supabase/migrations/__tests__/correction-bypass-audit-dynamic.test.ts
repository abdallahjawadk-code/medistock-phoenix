/**
 * CORRECTION-BYPASS-AUDIT — DYNAMIC proof against a real disposable Postgres
 * with 001->107 applied in order.
 *
 * Closes Phase 2 gap 3: every prior bypass-checking pass was UI/source-grep
 * based ("no reachable call site in src/"). This file proves the SAME
 * property at the PostgreSQL grant/RLS level, as a genuinely authenticated
 * (non-super_admin) session — not a superuser — using the SAME
 * rig.asUser(userId, fn) pattern every other dynamic test in this suite
 * uses (SET LOCAL ROLE authenticated + request.jwt.claim.sub GUC, so
 * auth.uid() and RLS are both genuinely live, not simulated).
 *
 * FINDING (documented, not just asserted): 098/101's approve RPCs INLINE
 * the UPDATE to outlet_stock/warehouse_stock directly inside their own
 * SECURITY DEFINER body — there is no separate internal "raw writer"
 * SECURITY DEFINER function they delegate to. There is therefore no
 * separate-writer bypass surface to test point 4's "attempt to call the
 * internal writer directly" against; this file instead proves the two
 * surfaces that DO exist are both closed:
 *   (a) direct UPDATE on outlet_stock / warehouse_stock as `authenticated`
 *       is denied at the TABLE GRANT level (REVOKE'd from authenticated by
 *       065/078/080/085 — no UPDATE/INSERT/DELETE grant exists at all,
 *       confirmed via information_schema.role_table_grants before writing
 *       this file), so RLS never even needs to be reached.
 *   (b) the only path that changes these quantities is request RPC (creates
 *       a pending row, zero quantity change) -> approve RPC (as a DIFFERENT
 *       authorized profile) -> quantity changes exactly then.
 *
 * Also covers the "attempted direct table bypass" angle of self-approval
 * that prior sessions' RPC-level self-approval tests did not: even if a
 * requester could somehow reach an UPDATE statement, the grant-level denial
 * makes the RPC-level proposer-cannot-approve-own-request check moot as a
 * bypass vector — this test proves the denial happens before any identity
 * check could even be relevant.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000110001';
const WH = '00000000-0000-0000-0000-000000110101';
const DP = '00000000-0000-0000-0000-000000110301';

const OO = '00000000-0000-0000-0000-000000110401';  // outlet_officer — proposer, holds outlet_stock.count
const WO = '00000000-0000-0000-0000-000000110402';  // warehouse_officer — proposer, warehouse-side
const CWM = '00000000-0000-0000-0000-000000110403'; // central_warehouse_manager — the only role holding approve_correction

run('correction bypass audit — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 107 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p-audit-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p-audit-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OO}','p-audit-oo@rig'),('${WO}','p-audit-wo@rig'),('${CWM}','p-audit-cwm@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OO}','${ORG}','warehouse','${WH}',true),
               ('${WO}','${ORG}','warehouse','${WH}',true),
               ('${CWM}','${ORG}','warehouse','${WH}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO}','${ORG}','distribution_point','${DP}',true),
               ('${CWM}','${ORG}','distribution_point','${DP}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── Grant-level evidence ─────────────────────────────────────────────────

  it('EVIDENCE: authenticated has NO UPDATE/INSERT/DELETE grant on outlet_stock or warehouse_stock', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT table_name, privilege_type
          FROM information_schema.role_table_grants
         WHERE grantee = 'authenticated' AND table_name IN ('outlet_stock','warehouse_stock')
         ORDER BY table_name, privilege_type`);
      const privileges = r.rows.map((row: any) => `${row.table_name}:${row.privilege_type}`);
      expect(privileges).not.toContain('outlet_stock:UPDATE');
      expect(privileges).not.toContain('outlet_stock:INSERT');
      expect(privileges).not.toContain('outlet_stock:DELETE');
      expect(privileges).not.toContain('warehouse_stock:UPDATE');
      expect(privileges).not.toContain('warehouse_stock:INSERT');
      expect(privileges).not.toContain('warehouse_stock:DELETE');
    });
  });

  it('EVIDENCE: every correction-related RPC is SECURITY DEFINER and EXECUTE-granted to authenticated ' +
     '(the RPCs self-authorize internally; there is no separate un-gated internal writer function)', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT p.proname,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS can_execute,
               p.prosecdef AS is_security_definer
          FROM pg_proc p
         WHERE p.proname IN (
           'phoenix_request_outlet_stock_correction','phoenix_approve_outlet_stock_correction','phoenix_reject_outlet_stock_correction',
           'phoenix_request_warehouse_stock_correction','phoenix_approve_warehouse_stock_correction','phoenix_reject_warehouse_stock_correction'
         )
         ORDER BY p.proname`);
      expect(r.rows.length).toBe(6);
      for (const row of r.rows) {
        expect(row.can_execute).toBe(true); // reachable — by design, RBAC is checked INSIDE the function
        expect(row.is_security_definer).toBe(true);
      }
    });
  });

  // ── Live bypass attempts as a real authenticated session ────────────────

  it('BYPASS ATTEMPT: direct UPDATE on outlet_stock as authenticated is denied (insufficient privilege), not silently applied', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P-AUDIT-DIRECT',true,false,'B-DIRECT',75,0,0)`, [stockId, ORG, DP]);
    });

    await rig.asUser(OO, async (c: any) => {
      await expect(c.query(`UPDATE outlet_stock SET on_hand_quantity = 999999 WHERE id=$1`, [stockId]))
        .rejects.toThrow(/permission denied/i);
    });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
      expect(r.rows[0].on_hand_quantity).toBe(75); // untouched by the bypass attempt
    });
  });

  it('BYPASS ATTEMPT: direct UPDATE on warehouse_stock as authenticated is denied (insufficient privilege), not silently applied', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P-AUDIT-DIRECT-WH',true,false,'B-DIRECT-WH',90,0,0)`, [stockId, ORG, WH]);
    });

    await rig.asUser(WO, async (c: any) => {
      await expect(c.query(`UPDATE warehouse_stock SET on_hand_quantity = 999999 WHERE id=$1`, [stockId]))
        .rejects.toThrow(/permission denied/i);
    });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
      expect(r.rows[0].on_hand_quantity).toBe(90);
    });
  });

  it('BYPASS ATTEMPT: even a CWM (the role that legitimately approves) cannot directly UPDATE outlet_stock ' +
     'to skip the request/approve flow entirely', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P-AUDIT-CWM-DIRECT',true,false,'B-CWM',30,0,0)`, [stockId, ORG, DP]);
    });

    await rig.asUser(CWM, async (c: any) => {
      await expect(c.query(`UPDATE outlet_stock SET on_hand_quantity = 1 WHERE id=$1`, [stockId]))
        .rejects.toThrow(/permission denied/i);
    });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
      expect(r.rows[0].on_hand_quantity).toBe(30);
    });
  });

  // ── The ONLY successful path ──────────────────────────────────────────────

  it('the ONLY successful path to changing outlet_stock quantity is request (no change) -> approve by a ' +
     'DIFFERENT authorized profile (changes exactly then); requester approving their OWN request is denied ' +
     '— proving the "direct table bypass" and "self-approval" angles are BOTH closed together', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P-AUDIT-ONLYPATH',true,false,'B-ONLYPATH',60,0,0)`, [stockId, ORG, DP]);
    });

    let correctionId = '';
    await rig.asUser(OO, async (c: any) => {
      const r = await call(c, 'phoenix_request_outlet_stock_correction',
        [randomUUID(), stockId, 44, 'physical count', null, null]);
      expect(r.requires_approval).toBe(true); // large variance queues, does not apply
      correctionId = r.correction_request_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
      expect(r.rows[0].on_hand_quantity).toBe(60); // requesting alone changes nothing
    });

    // OO cannot even attempt a direct bypass to shortcut its own pending request.
    await rig.asUser(OO, async (c: any) => {
      await expect(c.query(`UPDATE outlet_stock SET on_hand_quantity = 44 WHERE id=$1`, [stockId]))
        .rejects.toThrow(/permission denied/i);
    });

    // OO also cannot approve its OWN request via the legitimate RPC (self-approval denied).
    await rig.asUser(OO, async (c: any) => {
      await expect(call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]))
        .rejects.toThrow(/proposer_cannot_approve_own_correction/);
    });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
      expect(r.rows[0].on_hand_quantity).toBe(60); // still untouched after both bypass attempts
    });

    // A DIFFERENT authorized profile (CWM) approves — quantity changes exactly then.
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]);
      expect(r.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
      expect(r.rows[0].on_hand_quantity).toBe(44); // ONLY the approve RPC ever changed it
    });
  });
});
