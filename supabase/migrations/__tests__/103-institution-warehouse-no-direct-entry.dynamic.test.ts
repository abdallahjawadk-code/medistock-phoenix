/**
 * INSTITUTION-WAREHOUSE-NO-DIRECT-ENTRY — DYNAMIC proof for migration 103,
 * against a real disposable Postgres with 001->103 applied in order.
 *
 * This IS the "RPC bypass test": it calls the guarded RPCs directly, exactly
 * as the manual IntakeForm / OcrIntakeFlow / BatchRow do, with no frontend in
 * the loop — proving the server refuses an institution-warehouse direct
 * receipt or a raw add/subtract/set_exact adjustment even when the caller
 * holds every permission the frontend gate would have checked.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000d1001';
const WH_CENTRAL = '00000000-0000-0000-0000-0000000d1101';
const WH_INST = '00000000-0000-0000-0000-0000000d1102';

const CWM = '00000000-0000-0000-0000-0000000d1401'; // central_warehouse_manager, scoped to WH_CENTRAL
const WO = '00000000-0000-0000-0000-0000000d1402';  // warehouse_officer, scoped to WH_INST — holds adjust+correct there

run('103 institution-warehouse no-direct-entry — dynamic (RPC bypass proof)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 103 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p103-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','Central','مركزي','active','central','p103-wc'),
        ('${WH_INST}','${ORG}','Inst WH','مخزن مؤسسة','active','institution','p103-wi')
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','p103-cwm@rig'),('${WO}','p103-wo@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);

      // Both hold warehouse_stock.adjust AND warehouse_stock.correct by role
      // default (062/066) — scope assignment is the only remaining gate, and
      // it is granted here on exactly the warehouse this test targets, so a
      // rejection can only come from the NEW warehouse_kind check, not from
      // a missing scope/permission.
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM}','${ORG}','warehouse','${WH_CENTRAL}',true),
               ('${WO}','${ORG}','warehouse','${WH_INST}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // 080 revoked EXECUTE on the BARE (unguarded) function names from
  // `authenticated` — the only entry point a real client can ever reach is
  // the GUARDED wrapper (078). These tests call exactly that, matching what
  // warehouse-intake.service.ts (manual IntakeForm, BatchRow, and OcrIntakeFlow.
  // confirmAndSubmit all alike) actually posts through.

  it('a direct hand-typed/OCR receipt into an institution warehouse is refused, even for a fully-permissioned, correctly-scoped actor', async () => {
    await rig.asUser(WO, async (c: any) => {
      await expect(call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_INST, 'P103-A', 20, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
      ])).rejects.toThrow(/institution_warehouse_direct_receipt_forbidden/);
    });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT count(*) FROM warehouse_stock WHERE warehouse_id=$1 AND scientific_name='P103-A'`, [WH_INST]);
      expect(Number(r.rows[0].count)).toBe(0); // nothing was invented
    });
  });

  it('the SAME receipt call succeeds at a central warehouse — pharmacy-department intake is unaffected', async () => {
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, 'P103-B', 20, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
      ]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(20);
    }, { commit: true });
  });

  it('a caller cannot bypass the check by calling the BARE unguarded function name — 080 already revoked EXECUTE on it', async () => {
    await rig.asUser(WO, async (c: any) => {
      await expect(call(c, 'phoenix_receive_warehouse_stock', [
        randomUUID(), WH_INST, 'P103-BARE', 20, true, true,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
      ])).rejects.toThrow(/permission denied for function/);
    });
  });

  it('add/subtract/set_exact against an institution-warehouse lot are refused, but correction is unaffected', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P103-D',true,false,'B-D',50,0,0)`, [stockId, ORG, WH_INST]);
    });

    // Each failing call gets its OWN transaction: a raised exception poisons
    // the rest of whatever transaction it occurred in (standard Postgres
    // behavior), so three failures cannot share one `asUser` block. The
    // generation stays 0 throughout — nothing here ever actually writes.
    await rig.asUser(WO, async (c: any) => {
      await expect(call(c, 'phoenix_apply_warehouse_stock_movement_guarded', [
        randomUUID(), stockId, 'add', 10, null, 0, null, null,
      ])).rejects.toThrow(/institution_warehouse_direct_adjustment_forbidden/);
    });

    await rig.asUser(WO, async (c: any) => {
      await expect(call(c, 'phoenix_apply_warehouse_stock_movement_guarded', [
        randomUUID(), stockId, 'subtract', 10, null, 0, null, null,
      ])).rejects.toThrow(/institution_warehouse_direct_adjustment_forbidden/);
    });

    await rig.asUser(WO, async (c: any) => {
      await expect(call(c, 'phoenix_apply_warehouse_stock_movement_guarded', [
        randomUUID(), stockId, 'set_exact', 40, 'recount', 0, null, null,
      ])).rejects.toThrow(/institution_warehouse_direct_adjustment_forbidden/);
    });

    // 'correction' is the audited path (098/101) and remains reachable — NOT
    // this migration's concern to close.
    await rig.asUser(WO, async (c: any) => {
      const r = await call(c, 'phoenix_apply_warehouse_stock_movement_guarded', [
        randomUUID(), stockId, 'correction', 45, 'physical count', 0, null, null,
      ]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(45);
    }, { commit: true });
  });

  it('add/subtract/set_exact against a CENTRAL-warehouse lot are unaffected', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P103-E',true,false,'B-E',50,0,0)`, [stockId, ORG, WH_CENTRAL]);
    });

    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_apply_warehouse_stock_movement_guarded', [
        randomUUID(), stockId, 'add', 10, null, 0, null, null,
      ]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(60);
    }, { commit: true });
  });

  it('does not modify 068/069/070/071/100 receive corridors — a canonical transfer receipt into the SAME institution warehouse still works', async () => {
    const ROUTE = randomUUID();
    const stockCentral = randomUUID();

    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ($1,$2,$3,'central','institution', true)`, [ROUTE, WH_CENTRAL, WH_INST]);
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P103-F',true,false,'B-F',30,0,0)`, [stockCentral, ORG, WH_CENTRAL]);
    });

    await rig.asUser(CWM, async (c: any) => {
      const sent = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, stockCentral, 10, 'P103-WT-1', null, null, null,
      ]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const t = await c.query(`SELECT id FROM warehouse_transfers WHERE transfer_number='P103-WT-1'`);
      const l = await c.query(`SELECT id FROM warehouse_transfer_lines WHERE transfer_id=$1`, [t.rows[0].id]);
      expect(l.rows.length).toBe(1);
    });

    let lineIdResolved = '';
    await rig.asAdmin(async (c: any) => {
      const l = await c.query(`SELECT id, transfer_id FROM warehouse_transfer_lines WHERE source_warehouse_stock_id=$1`, [stockCentral]);
      lineIdResolved = l.rows[0].id;
    });

    await rig.asUser(WO, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), lineIdResolved, 10, null, null,
      ]);
      expect(received.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE warehouse_id=$1 AND scientific_name='P103-F'`, [WH_INST]);
      expect(r.rows[0].on_hand_quantity).toBe(10); // the canonical corridor still posts correctly
    });
  });
});
