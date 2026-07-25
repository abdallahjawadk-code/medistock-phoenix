/**
 * MOVEMENT-REASON-CODE-GROUP-G-QUARANTINE-132 — DYNAMIC proof against a
 * real disposable Postgres with 001->132 applied in order.
 *
 * Proves:
 *   1. Release: BOTH the quarantine-side debit and the warehouse-side
 *      credit land on reason_code = the quarantine lot's own
 *      quarantine_reason (not a client-supplied value). Both rows share
 *      one correlation_id, and the warehouse-side row's causation_id
 *      equals the quarantine-side row's own id (a real, same-transaction
 *      predecessor).
 *   2. Destroy: reason_code = the lot's quarantine_reason.
 *   3. Chaining: when a quarantine lot already has a PRIOR movement (e.g. a
 *      previous partial release), a second release/destroy against the
 *      SAME lot chains its correlation_id from that prior movement and its
 *      causation_id from that prior movement's own id -- a real, queryable
 *      predecessor, not a guess.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000132001';
const WH = '00000000-0000-0000-0000-000000132101';
const WO = '00000000-0000-0000-0000-000000132401';

run('132 Group G quarantine reason_code/correlation chain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 132 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p132-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p132-wh') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${WO}','p132-wo@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('release: both ledger rows land on reason_code=quarantine_reason, share one correlation_id, warehouse-side causation_id = quarantine-side own id', async () => {
    const qStockId = randomUUID();
    const destStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_quarantine_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, quarantine_reason, quantity)
        VALUES ($1,$2,$3,'P132-A',true,false,'Q-A',current_date + 60,'quality_issue',20)`, [qStockId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P132-A',true,false,'Q-A',current_date + 60,5,0,0)`, [destStockId, ORG, WH]);
    });

    let quarantineMovementId = '';
    let warehouseMovementId = '';
    await rig.asUser(WO, async (c: any) => {
      const r = await call(c, 'phoenix_release_quarantine_stock',
        [randomUUID(), qStockId, 8, 'inspection cleared', destStockId]);
      expect(r.ok).toBe(true);
      quarantineMovementId = r.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const qMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_quarantine_stock_movements WHERE id = $1`, [quarantineMovementId]);
      expect(qMv.rows[0].reason_code).toBe('quality_issue');
      expect(qMv.rows[0].correlation_id).not.toBeNull();
      expect(qMv.rows[0].causation_id).toBeNull(); // first-ever movement for this lot: no predecessor

      const whMv = await c.query(
        `SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE reference_type='quarantine_request' AND reference_id = (SELECT reference_id FROM warehouse_quarantine_stock_movements WHERE id = $1)`,
        [quarantineMovementId],
      );
      expect(whMv.rows[0].reason_code).toBe('quality_issue');
      expect(whMv.rows[0].correlation_id).toBe(qMv.rows[0].correlation_id);
      expect(whMv.rows[0].causation_id).toBe(quarantineMovementId);
    });
  });

  it('destroy: reason_code=quarantine_reason', async () => {
    const qStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_quarantine_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, quarantine_reason, quantity)
        VALUES ($1,$2,$3,'P132-B',true,false,'Q-B',current_date - 5,'expired',10)`, [qStockId, ORG, WH]);
    });

    let movementId = '';
    await rig.asUser(WO, async (c: any) => {
      const r = await call(c, 'phoenix_destroy_quarantine_stock', [randomUUID(), qStockId, 10, 'incinerated per protocol']);
      expect(r.ok).toBe(true);
      movementId = r.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT reason_code FROM warehouse_quarantine_stock_movements WHERE id = $1`, [movementId]);
      expect(mv.rows[0].reason_code).toBe('expired');
    });
  });

  it('a second release against the SAME lot chains correlation_id/causation_id from the first release, a real queryable predecessor', async () => {
    const qStockId = randomUUID();
    const destStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_quarantine_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, quarantine_reason, quantity)
        VALUES ($1,$2,$3,'P132-C',true,false,'Q-C',current_date + 60,'damaged',20)`, [qStockId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P132-C',true,false,'Q-C',current_date + 60,0,0,0)`, [destStockId, ORG, WH]);
    });

    let firstMovementId = '';
    let secondMovementId = '';
    await rig.asUser(WO, async (c: any) => {
      const r1 = await call(c, 'phoenix_release_quarantine_stock', [randomUUID(), qStockId, 5, 'first release', destStockId]);
      firstMovementId = r1.movement_id;
      const r2 = await call(c, 'phoenix_release_quarantine_stock', [randomUUID(), qStockId, 5, 'second release', destStockId]);
      secondMovementId = r2.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const firstMv = await c.query(`SELECT correlation_id FROM warehouse_quarantine_stock_movements WHERE id = $1`, [firstMovementId]);
      const secondMv = await c.query(`SELECT correlation_id, causation_id FROM warehouse_quarantine_stock_movements WHERE id = $1`, [secondMovementId]);
      expect(secondMv.rows[0].correlation_id).toBe(firstMv.rows[0].correlation_id);
      expect(secondMv.rows[0].causation_id).toBe(firstMovementId);
    });
  });
});
