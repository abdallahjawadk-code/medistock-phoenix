/**
 * OUTLET-STOCK-CORRECTION-086 — DYNAMIC proof.
 *
 * Proves phoenix_count_outlet_stock_guarded is a canonical, guarded lot-level
 * outlet correction: it corrects on_hand on the canonical outlet_stock ledger
 * (never item_availability), advances a server-owned generation, rejects a
 * stale generation with 40001, stays idempotent on the request id, keeps the
 * balance non-negative and reservation-safe, and is outlet-scoped.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI. Recorded in
 * docs/phoenix/migration-086-outlet-correction-validation.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000ce001';
const ORG_OTHER = '00000000-0000-0000-0000-0000000ce009';
const WH = '00000000-0000-0000-0000-0000000ce101';
const DP = '00000000-0000-0000-0000-0000000ce301';
const USER_OTHER = '00000000-0000-0000-0000-0000000ce404'; // foreign org, no scoped count perm here

run('086 — guarded outlet-stock correction (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r: any) => r.rows[0].r);

  const seedLot = (c: any, onHand: number, reserved = 0) =>
    c.query(`INSERT INTO outlet_stock
        (id,organization_id,distribution_point_id,point_type,scientific_name,concentration,dosage_form,national_code,batch_number,expiry_date,on_hand_quantity,reserved_quantity)
        VALUES (gen_random_uuid(),$1,$2,'pharmacy','Amoxicillin','500mg','capsule','NC1','LOT1','2027-05-01',$3,$4) RETURNING id, movement_seq`,
      [ORG, DP, onHand, reserved]).then((r: any) => r.rows[0]);

  const readLot = (c: any, id: string) =>
    c.query(`SELECT on_hand_quantity, movement_seq FROM outlet_stock WHERE id=$1`, [id]).then((r: any) => r.rows[0]);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 86 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ('${ORG}','I','م','oc-i'),('${ORG_OTHER}','O','م','oc-o') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES ('${WH}','${ORG}','I','I','active','institution','oc-wi') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES ('${DP}','${WH}','${ORG}','O','O','pharmacy','active') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${USER_OTHER}','oc-o@rig') ON CONFLICT DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='viewer',status='active',organization_id='${ORG_OTHER}' WHERE id='${USER_OTHER}';`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('a brand-new lot has generation 0, and a correction advances it and writes a correction movement', async () => {
    const lot = await rig.asAdmin((c: any) => seedLot(c, 30));
    expect(Number(lot.movement_seq)).toBe(0);
    const res = await rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [randomUUID(), lot.id, 25, 'stocktake', 0, null]),
      { commit: true });
    expect(res.ok).toBe(true);
    expect(res.quantity_after).toBe(25);
    expect(res.quantity_delta).toBe(-5);
    const after = await rig.asAdmin((c: any) => readLot(c, lot.id));
    expect(after.on_hand_quantity).toBe(25);
    expect(Number(after.movement_seq)).toBe(1);   // generation advanced
    // the correction is an append-only movement on the canonical ledger
    const mv = await rig.asAdmin((c: any) =>
      c.query(`SELECT movement_type, reason FROM outlet_stock_movements WHERE outlet_stock_id=$1 AND movement_type='correction'`, [lot.id]).then((r: any) => r.rows));
    expect(mv.length).toBe(1);
    expect(mv[0].reason).toBe('stocktake');
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock_movements WHERE outlet_stock_id=$1`, [lot.id]));
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE id=$1`, [lot.id]));
  });

  it('a stale expected generation is rejected with 40001, and no write happens', async () => {
    const lot = await rig.asAdmin((c: any) => seedLot(c, 40));
    // advance the generation once (now seq=1)
    await rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [randomUUID(), lot.id, 38, 'first', 0, null]),
      { commit: true });
    // a second correction still carrying expected=0 must conflict
    await expect(rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [randomUUID(), lot.id, 10, 'stale', 0, null]),
      { commit: true })).rejects.toThrow(/outlet_stock_generation_conflict/);
    const after = await rig.asAdmin((c: any) => readLot(c, lot.id));
    expect(after.on_hand_quantity).toBe(38);   // unchanged by the rejected call
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock_movements WHERE outlet_stock_id=$1`, [lot.id]));
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE id=$1`, [lot.id]));
  });

  it('a lost-response retry (same request id) is idempotent and skips the generation check', async () => {
    const lot = await rig.asAdmin((c: any) => seedLot(c, 50));
    const req = randomUUID();
    const first = await rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [req, lot.id, 45, 'count', 0, null]),
      { commit: true });
    expect(first.idempotent_replay).toBe(false);
    // replay with the SAME request id but a now-stale expected generation (0):
    // it must NOT conflict — it short-circuits as a replay.
    const replay = await rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [req, lot.id, 45, 'count', 0, null]),
      { commit: true });
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.quantity_after).toBe(45);
    const after = await rig.asAdmin((c: any) => readLot(c, lot.id));
    expect(after.on_hand_quantity).toBe(45);   // one effect, not two
    expect(Number(after.movement_seq)).toBe(1);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock_movements WHERE outlet_stock_id=$1`, [lot.id]));
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE id=$1`, [lot.id]));
  });

  it('a count below the reserved quantity is refused (reservation-safe)', async () => {
    const lot = await rig.asAdmin((c: any) => seedLot(c, 30, 12));  // 12 reserved
    await expect(rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [randomUUID(), lot.id, 5, 'too low', 0, null]),
      { commit: true })).rejects.toThrow(/outlet_quantity_below_reserved/);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE id=$1`, [lot.id]));
  });

  it('a negative counted quantity is refused', async () => {
    const lot = await rig.asAdmin((c: any) => seedLot(c, 30));
    await expect(rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [randomUUID(), lot.id, -1, 'bad', 0, null]),
      { commit: true })).rejects.toThrow(/counted_quantity_must_be_non_negative/);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE id=$1`, [lot.id]));
  });

  it('a missing reason is refused (a documentless correction must be explained)', async () => {
    const lot = await rig.asAdmin((c: any) => seedLot(c, 30));
    await expect(rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [randomUUID(), lot.id, 20, '  ', 0, null]),
      { commit: true })).rejects.toThrow(/outlet_count_reason_required/);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE id=$1`, [lot.id]));
  });

  it('a foreign-org actor without outlet_stock.count on this outlet is forbidden', async () => {
    const lot = await rig.asAdmin((c: any) => seedLot(c, 30));
    await expect(rig.asUser(USER_OTHER,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [randomUUID(), lot.id, 20, 'x', 0, null]),
      { commit: true })).rejects.toThrow(/forbidden_outlet_stock_count/);
    const after = await rig.asAdmin((c: any) => readLot(c, lot.id));
    expect(after.on_hand_quantity).toBe(30);   // untouched
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE id=$1`, [lot.id]));
  });

  it('with no expected generation supplied, the correction still works (unguarded legacy contract preserved)', async () => {
    const lot = await rig.asAdmin((c: any) => seedLot(c, 30));
    const res = await rig.asUser(rig.superAdminId,
      (c: any) => call(c, 'phoenix_count_outlet_stock_guarded', [randomUUID(), lot.id, 22, 'nogenerationok', null, null]),
      { commit: true });
    expect(res.quantity_after).toBe(22);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock_movements WHERE outlet_stock_id=$1`, [lot.id]));
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE id=$1`, [lot.id]));
  });
});
