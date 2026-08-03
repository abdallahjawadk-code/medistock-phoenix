/**
 * TRANSFER-CORRIDOR-PRIVILEGE-LOCKDOWN — DYNAMIC proof for migration 154,
 * against a real disposable Postgres with 001->154 applied in order.
 *
 * Phase D0's read-only audit found migration 108 (custody-chain lockdown)
 * revoked excess TRUNCATE/TRIGGER/REFERENCES on 15 tables but never touched
 * the four central<->institution transfer-corridor tables (068). 154 closes
 * exactly that gap, for exactly these four tables, with no other change.
 *
 * This file is the durable regression guard (mirrors
 * default-privileges-fail-closed-guard.dynamic.test.ts's shape for 109):
 * catalog-level privilege assertions PLUS live behavioral proof (an actual
 * authenticated session attempting a direct mutation/TRUNCATE), PLUS an
 * end-to-end proof that the canonical RPC path is completely unaffected,
 * PLUS a proof that an actor without the RPC's own permission still fails
 * closed (unrelated to table grants — this guards against 154 accidentally
 * masking or interacting with the RPCs' own authorization checks).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const TABLES = [
  'warehouse_transfer_requests',
  'warehouse_transfer_request_lines',
  'warehouse_transfers',
  'warehouse_transfer_lines',
] as const;

const DANGEROUS_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'] as const;

const CANONICAL_ROUTE1_RPCS = [
  'phoenix_create_direct_warehouse_transfer_request',
  'phoenix_create_warehouse_transfer_request',
  'phoenix_add_warehouse_transfer_request_line',
  'phoenix_update_warehouse_transfer_request_line',
  'phoenix_delete_warehouse_transfer_request_line',
  'phoenix_submit_warehouse_transfer_request',
  'phoenix_cancel_warehouse_transfer_request',
  'phoenix_review_warehouse_transfer_request',
  'phoenix_send_direct_warehouse_transfer_line',
  'phoenix_send_direct_warehouse_transfer_line_fefo_guarded',
  'phoenix_send_warehouse_transfer_line',
  'phoenix_send_warehouse_transfer_line_fefo_guarded',
  'phoenix_receive_warehouse_transfer_line',
  'phoenix_receive_all_matching_transfer_lines',
] as const;

const ORG = '00000000-0000-0000-0000-00000000d154';
const WH_CENTRAL = '00000000-0000-0000-0000-00000001d154';
const WH_INST = '00000000-0000-0000-0000-00000002d154';
const CWM = '00000000-0000-0000-0000-00000003d154'; // central_warehouse_manager, scoped to WH_CENTRAL
const WOF = '00000000-0000-0000-0000-00000004d154'; // warehouse_officer, scoped to WH_INST (receive)
const UNAUTH = '00000000-0000-0000-0000-00000005d154'; // outlet_officer, no scope assignment anywhere — holds no warehouse_transfer.* by default

run('154 transfer-corridor privilege lockdown — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    // Item 8 (replay 001->latest succeeds): buildRig throws on any migration
    // failure, so simply completing this call is the proof.
    rig = await buildRig({ upTo: 154 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','D154 Org','مؤسسة د154','d154-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','D154 Central','مركزي د154','active','central','d154-wc'),
        ('${WH_INST}','${ORG}','D154 Inst WH','مخزن مؤسسة د154','active','institution','d154-wi')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','d154-cwm@rig'),('${WOF}','d154-wof@rig'),('${UNAUTH}','d154-unauth@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WOF}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${UNAUTH}';`);

      // CWM needs a scoped assignment on the SOURCE (central) warehouse to
      // reach warehouse_transfer.{send,review}; WOF needs one on the
      // DESTINATION (institution) warehouse to reach warehouse_transfer.
      // receive. UNAUTH gets no scope assignment anywhere — the negative case.
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM}','${ORG}','warehouse','${WH_CENTRAL}',true),
               ('${WOF}','${ORG}','warehouse','${WH_INST}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => {
    await rig?.end();
  });

  // ==========================================================================
  // Items 9-11: catalog-level privilege assertions (mirrors 108's own VERIFY
  // block and default-privileges-fail-closed-guard.dynamic.test.ts's shape)
  // ==========================================================================

  it('authenticated holds none of the six dangerous privileges on any of the four tables', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const t of TABLES) {
        for (const priv of DANGEROUS_PRIVS) {
          const r = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, $2) AS has`, [t, priv]);
          expect(r.rows[0].has, `authenticated must not have ${priv} on ${t}`).toBe(false);
        }
      }
    });
  });

  it('anon and PUBLIC hold none of the six dangerous privileges, and never held SELECT either', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const t of TABLES) {
        for (const role of ['anon', 'public']) {
          for (const priv of [...DANGEROUS_PRIVS, 'SELECT']) {
            const r = await c.query(`SELECT has_table_privilege($1, 'public.' || $2, $3) AS has`, [role, t, priv]);
            expect(r.rows[0].has, `${role} must not have ${priv} on ${t}`).toBe(false);
          }
        }
      }
    });
  });

  it('SELECT remains granted to authenticated on all four tables (unchanged from the prior contract)', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const t of TABLES) {
        const r = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, 'SELECT') AS has`, [t]);
        expect(r.rows[0].has, `authenticated must still have SELECT on ${t}`).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Items 12-13: canonical RPCs unaffected
  // ==========================================================================

  it('every canonical Route-1 RPC still exists, is SECURITY DEFINER, and keeps its EXECUTE grant to authenticated only', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const fn of CANONICAL_ROUTE1_RPCS) {
        const r = await c.query(
          `SELECT p.oid, p.prosecdef,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
           FROM pg_proc p WHERE p.proname = $1`,
          [fn],
        );
        expect(r.rows.length, `expected RPC missing: ${fn}`).toBeGreaterThan(0);
        for (const row of r.rows) {
          expect(row.prosecdef, `${fn} must be SECURITY DEFINER`).toBe(true);
          expect(row.auth_exec, `${fn} must remain EXECUTE-granted to authenticated`).toBe(true);
          expect(row.anon_exec, `${fn} must not be EXECUTE-granted to anon`).toBe(false);
        }
      }
    });
  });

  // ==========================================================================
  // Item 14: live behavioral proof — a real authenticated session cannot
  // mutate any of the four tables directly (matches 108's own live proof
  // shape: a real SET ROLE authenticated session, not just a catalog read).
  // ==========================================================================

  it('a real authenticated session cannot INSERT, UPDATE, DELETE, or TRUNCATE any of the four tables directly', async () => {
    // Each statement runs in its OWN asUser call (its own transaction) — a
    // failed statement aborts the surrounding transaction in Postgres, so
    // testing multiple failures within one shared transaction would only
    // prove the first; this proves each one independently.
    const attempts: Array<[string, string]> = [
      ['INSERT', `INSERT INTO public.warehouse_transfer_requests
           (route_id, source_warehouse_id, source_organization_id, destination_warehouse_id, destination_organization_id, request_number, status, created_by)
         VALUES (NULL, '${WH_CENTRAL}', '${ORG}', '${WH_INST}', '${ORG}', 'bypass-attempt', 'draft', '${CWM}')`],
      ['UPDATE', `UPDATE public.warehouse_transfers SET status = 'received' WHERE true`],
      ['DELETE', `DELETE FROM public.warehouse_transfer_lines WHERE true`],
      ['TRUNCATE (request lines)', `TRUNCATE TABLE public.warehouse_transfer_request_lines`],
      ['TRUNCATE (requests)', `TRUNCATE TABLE public.warehouse_transfer_requests`],
      ['TRUNCATE (transfers)', `TRUNCATE TABLE public.warehouse_transfers`],
      ['TRUNCATE (transfer lines)', `TRUNCATE TABLE public.warehouse_transfer_lines`],
    ];
    for (const [label, sql] of attempts) {
      await expect(
        rig.asUser(CWM, (c: any) => c.query(sql)),
        `${label} must fail with permission denied`,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  // ==========================================================================
  // Item 15: the authorized canonical RPC path remains fully functional —
  // a real end-to-end create -> add-line -> submit -> review -> send ->
  // receive, proving 154 has zero effect on legitimate operation.
  // ==========================================================================

  it('the full canonical Route-1 lifecycle still works end-to-end for a properly-scoped actor', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'D154-Amoxicillin',true,false,'D154-B1','2030-01-01',100,0,0)`,
        [stockId, ORG, WH_CENTRAL]);
    });

    let requestId: string;
    let lineId: string;
    await rig.asUser(CWM, async (c: any) => {
      const created = await call(c, 'phoenix_create_direct_warehouse_transfer_request', [
        WH_CENTRAL, ORG, WH_INST, 'D154-REQ-1', null,
      ]);
      expect(created.ok).toBe(true);
      requestId = created.transfer_request_id;

      const added = await call(c, 'phoenix_add_warehouse_transfer_request_line', [
        requestId, 'D154-Amoxicillin', 30, null, null, null, null, null,
      ]);
      expect(added.ok).toBe(true);
      lineId = added.transfer_request_line_id;

      const submitted = await call(c, 'phoenix_submit_warehouse_transfer_request', [requestId]);
      expect(submitted.ok).toBe(true);
      expect(submitted.status).toBe('submitted');

      const reviewed = await call(c, 'phoenix_review_warehouse_transfer_request', [
        requestId, JSON.stringify([{ line_id: lineId, approved_quantity: 30 }]),
      ]);
      expect(reviewed.ok).toBe(true);
      expect(reviewed.status).toBe('approved');

      const sent = await call(c, 'phoenix_send_direct_warehouse_transfer_line', [
        randomUUID(), requestId, stockId, 30, 'D154-XFER-1', lineId, null, null,
      ]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const stock = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id = $1`, [stockId]);
      expect(stock.rows[0].on_hand_quantity).toBe(70);
    });

    let transferLineId: string;
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT id FROM warehouse_transfer_lines WHERE transfer_request_line_id = $1`,
        [lineId!],
      );
      expect(r.rows.length).toBe(1);
      transferLineId = r.rows[0].id;
    });

    await rig.asUser(WOF, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), transferLineId, 30, null, null,
      ]);
      expect(received.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const line = await c.query(`SELECT status FROM warehouse_transfer_lines WHERE id = $1`, [transferLineId!]);
      expect(line.rows[0].status).toBe('received');
    });
  });

  // ==========================================================================
  // Item 16: an actor without the RPC's OWN permission still fails closed —
  // unrelated to table grants, this proves 154 does not mask or interact
  // with the RPCs' own authorization checks.
  // ==========================================================================

  it('an actor with no scoped permission is rejected by the RPC itself (business-logic gate, unaffected by 154)', async () => {
    await rig.asUser(UNAUTH, async (c: any) => {
      await expect(
        call(c, 'phoenix_create_direct_warehouse_transfer_request', [
          WH_CENTRAL, ORG, WH_INST, 'D154-REQ-UNAUTH', null,
        ]),
      ).rejects.toThrow(/forbidden_direct_warehouse_transfer/);
    });
  });

  // ==========================================================================
  // Item 17: migration is idempotent under replay (re-applying it a second
  // time against the same database must not error).
  // ==========================================================================

  it('re-applying migration 154 a second time is a safe no-op', async () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '154_phoenix_transfer_corridor_privilege_lockdown.sql'), 'utf8');
    await rig.asAdmin(async (c: any) => {
      await c.query(sql);
      for (const t of TABLES) {
        for (const priv of DANGEROUS_PRIVS) {
          const r = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, $2) AS has`, [t, priv]);
          expect(r.rows[0].has, `authenticated must still not have ${priv} on ${t} after re-apply`).toBe(false);
        }
        const sel = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, 'SELECT') AS has`, [t]);
        expect(sel.rows[0].has, `authenticated must still have SELECT on ${t} after re-apply`).toBe(true);
      }
    });
  });
});
