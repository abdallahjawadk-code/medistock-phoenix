/**
 * MOVEMENT-REASON-CODE-GROUP-A-WAREHOUSE-INTAKE-126 — DYNAMIC proof against
 * a real disposable Postgres with 001->126 applied in order.
 *
 * Proves, for the two Group A root writers:
 *   1. phoenix_receive_warehouse_stock_guarded (the real client entry point,
 *      unaffected signature) still works end-to-end and its movement row
 *      lands on reason_code='received' with a freshly generated, non-null
 *      correlation_id and a NULL causation_id.
 *   2. phoenix_apply_warehouse_stock_movement (internal-only; called
 *      directly via asAdmin since it stays EXECUTE-revoked from
 *      authenticated -- unchanged, confirmed no regression) defaults
 *      reason_code to 'corrected' for add/subtract when the caller omits
 *      it, honors an explicit valid reason_code, rejects an invalid one,
 *      requires reason_code for set_exact/correction (mirroring the
 *      existing free-text reason requirement), and generates a distinct
 *      fresh correlation_id per call with causation_id always NULL.
 *   3. The old 7-argument bare-function overload no longer exists (the
 *      DROP genuinely took effect, not just the new 8-argument one).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000126001';
const WH = '00000000-0000-0000-0000-000000126101';
const CWM = '00000000-0000-0000-0000-000000126401'; // central_warehouse_manager, scoped to WH

run('126 Group A warehouse intake reason_code/correlation_id — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 126 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p126-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','Central','مركزي','active','central','p126-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${CWM}','p126-cwm@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('phoenix_receive_warehouse_stock_guarded still works and lands on reason_code=received, fresh correlation_id, NULL causation_id', async () => {
    let movementId: string;
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        // p_request_id, p_warehouse_id, p_scientific_name, p_quantity,
        // p_has_no_national_code, p_has_no_batch_number, p_expected_generation,
        randomUUID(), WH, 'P126-A', 20, true, true, 0,
        // p_central_item_id, p_trade_name, p_concentration, p_dosage_form,
        // p_unit, p_national_code, p_batch_number, p_expiry_date,
        // p_unit_price, p_price_basis, p_currency, p_supply_type_text,
        // p_source_document_number, p_notes (14 nulls)
        null, null, null, null, null, null, null, null, null, null, null, null, null, null,
        // p_supply_type ('aid', 118's post-088 requirement), p_purchase_origin
        'aid', null,
      ]);
      expect(r.ok).toBe(true);
      movementId = r.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const row = await c.query(
        `SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`,
        [movementId],
      );
      expect(row.rows[0].reason_code).toBe('received');
      expect(row.rows[0].correlation_id).not.toBeNull();
      expect(row.rows[0].causation_id).toBeNull();
    });
  });

  it('phoenix_apply_warehouse_stock_movement defaults reason_code to corrected for add when omitted', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P126-B',true,false,'B-B',10,0,0)`, [stockId, ORG, WH]);
    });

    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_apply_warehouse_stock_movement', [
        randomUUID(), stockId, 'add', 5, null, null, null,
      ]);
      expect(r.ok).toBe(true);

      const row = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [r.movement_id]);
      expect(row.rows[0].reason_code).toBe('corrected');
      expect(row.rows[0].correlation_id).not.toBeNull();
      expect(row.rows[0].causation_id).toBeNull();
    }, { role: 'postgres', commit: true });
  });

  it('phoenix_apply_warehouse_stock_movement honors an explicit valid reason_code', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P126-C',true,false,'B-C',10,0,0)`, [stockId, ORG, WH]);
    });

    // The internal function checks auth.uid() itself (not just an ACL gate),
    // so it must be called with the JWT-claim GUC set even though we also
    // need superuser privilege to bypass its EXECUTE-revoked-from-authenticated
    // ACL -- `role: 'postgres'` gives both in one connection.
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_apply_warehouse_stock_movement', [
        randomUUID(), stockId, 'subtract', 3, 'found short', null, null, 'damaged',
      ]);
      expect(r.ok).toBe(true);

      const row = await c.query(`SELECT reason_code, reason FROM warehouse_stock_movements WHERE id = $1`, [r.movement_id]);
      expect(row.rows[0].reason_code).toBe('damaged');
      expect(row.rows[0].reason).toBe('found short');
    }, { role: 'postgres', commit: true });
  });

  it('phoenix_apply_warehouse_stock_movement rejects an invalid reason_code', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P126-D',true,false,'B-D',10,0,0)`, [stockId, ORG, WH]);
    });

    await rig.asUser(CWM, async (c: any) => {
      await expect(call(c, 'phoenix_apply_warehouse_stock_movement', [
        randomUUID(), stockId, 'add', 2, null, null, null, 'received',
      ])).rejects.toThrow(/invalid_warehouse_movement_reason_code/);
    }, { role: 'postgres' });
  });

  it('phoenix_apply_warehouse_stock_movement requires reason_code for set_exact (mirrors the existing free-text reason requirement)', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P126-E',true,false,'B-E',10,0,0)`, [stockId, ORG, WH]);
    });

    await rig.asUser(CWM, async (c: any) => {
      await expect(call(c, 'phoenix_apply_warehouse_stock_movement', [
        randomUUID(), stockId, 'set_exact', 12, 'recount', null, null, null,
      ])).rejects.toThrow(/warehouse_correction_reason_code_required/);
    }, { role: 'postgres' });
  });

  it('two distinct calls generate two distinct correlation_ids (each is genuinely fresh, never reused across unrelated movements)', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P126-F',true,false,'B-F',10,0,0)`, [stockId, ORG, WH]);
    });

    await rig.asUser(CWM, async (c: any) => {
      const r1 = await call(c, 'phoenix_apply_warehouse_stock_movement', [randomUUID(), stockId, 'add', 1, null, null, null]);
      const r2 = await call(c, 'phoenix_apply_warehouse_stock_movement', [randomUUID(), stockId, 'add', 1, null, null, null]);

      const rows = await c.query(
        `SELECT id, correlation_id FROM warehouse_stock_movements WHERE id IN ($1, $2)`,
        [r1.movement_id, r2.movement_id],
      );
      const ids = rows.rows.map((r: any) => r.correlation_id);
      expect(ids[0]).not.toBeNull();
      expect(ids[1]).not.toBeNull();
      expect(ids[0]).not.toBe(ids[1]);
    }, { role: 'postgres', commit: true });
  });

  it('the old 7-argument bare overload no longer exists (DROP genuinely took effect, not shadowed by the new 8-argument one)', async () => {
    await rig.asAdmin(async (c: any) => {
      const res = await c.query(
        `SELECT pg_get_function_arguments(p.oid) AS args
           FROM pg_proc p
          WHERE p.proname = 'phoenix_apply_warehouse_stock_movement'
            AND p.pronamespace = 'public'::regnamespace`,
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].args).toContain('p_reason_code');
    });
  });
});
