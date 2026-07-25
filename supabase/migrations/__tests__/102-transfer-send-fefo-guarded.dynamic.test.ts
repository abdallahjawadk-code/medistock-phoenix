/**
 * TRANSFER-SEND-FEFO-GUARDED — DYNAMIC proof for migration 102, against a
 * real disposable Postgres with 001->102 applied in order.
 *
 * Mirrors 097's own shape (FEFO enforcement over a batch-choosing RPC) one
 * corridor up: 068/088's phoenix_send_warehouse_transfer_line, at the
 * central-side send step rather than 070's institution-side add-line step.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000c1001';
const WH_CENTRAL = '00000000-0000-0000-0000-0000000c1101';
const WH_INST = '00000000-0000-0000-0000-0000000c1102';
const ROUTE = '00000000-0000-0000-0000-0000000c1201';

const CWM1 = '00000000-0000-0000-0000-0000000c1401'; // central_warehouse_manager — the sender
const CWM2 = '00000000-0000-0000-0000-0000000c1402'; // central_warehouse_manager — permission explicitly revoked

run('102 transfer-send FEFO guard — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 102 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p2fefo-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','Central','مركزي','active','central','p2fefo-wc'),
        ('${WH_INST}','${ORG}','Inst WH','مخزن مؤسسة','active','institution','p2fefo-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true) ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM1}','p2fefo-cwm1@rig'),('${CWM2}','p2fefo-cwm2@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id IN ('${CWM1}','${CWM2}');`);

      // CWM2's fefo_override permission is explicitly revoked at the
      // profile-override layer, so the role-default grant this migration
      // adds does not, by itself, make the override reachable for them.
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed)
        VALUES ('${CWM2}', 'inventory.fefo_override', false) ON CONFLICT DO NOTHING;`);

      // central_warehouse_manager is an OPERATIONAL role (not in the
      // org-wide-roles allowlist inside phoenix_profile_has_scoped_
      // permission), so both actors need an explicit warehouse-scoped
      // assignment on the SOURCE warehouse to reach warehouse_transfer.send
      // (and, transitively, inventory.fefo_override which is checked with
      // the same warehouse scope).
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM1}','${ORG}','warehouse','${WH_CENTRAL}',true),
               ('${CWM2}','${ORG}','warehouse','${WH_CENTRAL}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('sending the FEFO-earliest lot needs no override and is not audited as one', async () => {
    const stockEarly = randomUUID(), stockLate = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$3,$4,'P2FEFO-A',true,false,'B-EARLY','2028-01-01',50,0,0),
               ($2,$3,$4,'P2FEFO-A',true,false,'B-LATE','2029-01-01',50,0,0)`,
        [stockEarly, stockLate, ORG, WH_CENTRAL]);
    });

    await rig.asUser(CWM1, async (c: any) => {
      const r = await call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, stockEarly, 10, 'P2FEFO-WT-COMPLIANT', null, null, null, false, null,
      ]);
      expect(r.ok).toBe(true);
      expect(r.fefo_override_applied).toBe(false);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockEarly]);
      expect(r.rows[0].on_hand_quantity).toBe(40);
      const noAudit = await c.query(
        `SELECT 1 FROM audit_logs WHERE action='inventory.fefo_overridden' AND entity_id IN
           (SELECT id FROM warehouse_stock_movements WHERE warehouse_stock_id=$1)`, [stockEarly]);
      expect(noAudit.rows.length).toBe(0);
    });
  });

  it('sending a non-earliest lot without override fails closed', async () => {
    const stockEarly = randomUUID(), stockLate = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$3,$4,'P2FEFO-B',true,false,'B-EARLY2','2028-02-01',50,0,0),
               ($2,$3,$4,'P2FEFO-B',true,false,'B-LATE2','2029-02-01',50,0,0)`,
        [stockEarly, stockLate, ORG, WH_CENTRAL]);
    });

    await rig.asUser(CWM1, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, stockLate, 10, 'P2FEFO-WT-NOOVR', null, null, null, false, null,
      ])).rejects.toThrow(/fefo_override_required/);
    });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockLate]);
      expect(r.rows[0].on_hand_quantity).toBe(50); // untouched — the exception rolled the statement back
    });
  });

  it('overriding without a reason fails closed even with override=true', async () => {
    const stockEarly = randomUUID(), stockLate = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$3,$4,'P2FEFO-C',true,false,'B-EARLY3','2028-03-01',50,0,0),
               ($2,$3,$4,'P2FEFO-C',true,false,'B-LATE3','2029-03-01',50,0,0)`,
        [stockEarly, stockLate, ORG, WH_CENTRAL]);
    });

    await rig.asUser(CWM1, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, stockLate, 10, 'P2FEFO-WT-NOREASON', null, null, null, true, null,
      ])).rejects.toThrow(/fefo_override_reason_required/);
    });
  });

  it('a profile whose fefo_override is explicitly revoked is forbidden even though their role default now grants it', async () => {
    const stockEarly = randomUUID(), stockLate = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$3,$4,'P2FEFO-D',true,false,'B-EARLY4','2028-04-01',50,0,0),
               ($2,$3,$4,'P2FEFO-D',true,false,'B-LATE4','2029-04-01',50,0,0)`,
        [stockEarly, stockLate, ORG, WH_CENTRAL]);
    });

    await rig.asUser(CWM2, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, stockLate, 10, 'P2FEFO-WT-FORBIDDEN', null, null, null, true, 'because reasons',
      ])).rejects.toThrow(/forbidden_fefo_override/);
    });
  });

  it('a reasoned, permitted override sends the non-earliest lot and writes an audit row with before/after batch identity', async () => {
    const stockEarly = randomUUID(), stockLate = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$3,$4,'P2FEFO-E',true,false,'B-EARLY5','2028-05-01',50,0,0),
               ($2,$3,$4,'P2FEFO-E',true,false,'B-LATE5','2029-05-01',50,0,0)`,
        [stockEarly, stockLate, ORG, WH_CENTRAL]);
    });

    await rig.asUser(CWM1, async (c: any) => {
      const r = await call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, stockLate, 15, 'P2FEFO-WT-OVERRIDDEN', null, null, null,
        true, 'earliest lot damaged in transit staging',
      ]);
      expect(r.ok).toBe(true);
      expect(r.fefo_override_applied).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const stock = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockLate]);
      expect(stock.rows[0].on_hand_quantity).toBe(35);

      const audit = await c.query(
        `SELECT payload FROM audit_logs WHERE action='inventory.fefo_overridden' AND payload->>'after_chosen_stock_id'=$1`,
        [stockLate]);
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].payload.before_fefo_stock_id).toBe(stockEarly);
      expect(audit.rows[0].payload.after_chosen_stock_id).toBe(stockLate);
      expect(audit.rows[0].payload.reason).toBe('earliest lot damaged in transit staging');
    });
  });

  it('does not modify 068/088s underlying phoenix_send_warehouse_transfer_line — the unguarded RPC still works unchanged', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P2FEFO-F',true,false,'B-PLAIN',20,0,0)`, [stockId, ORG, WH_CENTRAL]);
    });

    await rig.asUser(CWM1, async (c: any) => {
      const r = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, stockId, 5, 'P2FEFO-WT-PLAIN', null, null, null,
      ]);
      expect(r.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
      expect(r.rows[0].on_hand_quantity).toBe(15);
    });
  });
});
