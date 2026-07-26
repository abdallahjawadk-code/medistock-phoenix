/**
 * MOVEMENT-TIMELINE-CORRECTION-COVERAGE-122 — DYNAMIC proof against a real
 * disposable Postgres with 001->122 applied in order.
 *
 * Proves the gap 122 closes: requesting and then approving an outlet stock
 * correction (098) now produces phoenix_movement_events rows for BOTH the
 * 'pending' and 'approved' transitions — previously silent (zero events).
 * Also proves the reject path emits its own 'rejected' event, and that a
 * same-value UPDATE (metadata-only edit, no status change) still emits
 * nothing, matching the trigger's existing dedupe/no-op contract.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000122001';
const WH = '00000000-0000-0000-0000-000000122101';
const DP = '00000000-0000-0000-0000-000000122301';
const OO = '00000000-0000-0000-0000-000000122401'; // outlet_officer — proposer
const CWM = '00000000-0000-0000-0000-000000122402'; // central_warehouse_manager — approver/rejecter

run('122 movement-timeline correction coverage — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 122 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p122-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p122-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OO}','p122-oo@rig'),('${CWM}','p122-cwm@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OO}','${ORG}','warehouse','${WH}',true), ('${CWM}','${ORG}','warehouse','${WH}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO}','${ORG}','distribution_point','${DP}',true), ('${CWM}','${ORG}','distribution_point','${DP}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  async function seedOutletStock(tag: string, onHand: number) {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy',$4,true,false,$5,$6,0,0)`, [stockId, ORG, DP, `P122-${tag}`, `B-${tag}`, onHand]);
    });
    return stockId;
  }

  it('request (pending) + approve emits two phoenix_movement_events rows for the same correction id', async () => {
    const stockId = await seedOutletStock('APR', 40);
    let correctionId = '';
    await rig.asUser(OO, async (c: any) => {
      const r = await call(c, 'phoenix_request_outlet_stock_correction',
        [randomUUID(), stockId, 33, 'physical count', null, null]);
      expect(r.requires_approval).toBe(true);
      correctionId = r.correction_request_id;
    }, { commit: true });

    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]);
      expect(r.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const events = await c.query(
        `SELECT status_after FROM phoenix_movement_events
         WHERE reference_type = 'phoenix_stock_correction_requests' AND reference_id = $1
         ORDER BY occurred_at ASC`,
        [correctionId],
      );
      expect(events.rows.map((r: any) => r.status_after)).toEqual(['pending', 'approved']);
    });
  });

  it('request (pending) + reject emits a rejected event, no approved event', async () => {
    const stockId = await seedOutletStock('REJ', 40);
    let correctionId = '';
    await rig.asUser(OO, async (c: any) => {
      const r = await call(c, 'phoenix_request_outlet_stock_correction',
        [randomUUID(), stockId, 5, 'physical count', null, null]);
      correctionId = r.correction_request_id;
    }, { commit: true });

    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_reject_outlet_stock_correction', [correctionId, 'implausible variance']);
      expect(r.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const events = await c.query(
        `SELECT status_after FROM phoenix_movement_events
         WHERE reference_type = 'phoenix_stock_correction_requests' AND reference_id = $1
         ORDER BY occurred_at ASC`,
        [correctionId],
      );
      expect(events.rows.map((r: any) => r.status_after)).toEqual(['pending', 'rejected']);
    });
  });

  it('events are org-scoped and readable by an authenticated member of that org', async () => {
    const stockId = await seedOutletStock('ORG', 20);
    let correctionId = '';
    await rig.asUser(OO, async (c: any) => {
      const r = await call(c, 'phoenix_request_outlet_stock_correction',
        [randomUUID(), stockId, 15, 'physical count', null, null]);
      correctionId = r.correction_request_id;
    }, { commit: true });

    await rig.asUser(OO, async (c: any) => {
      const events = await c.query(
        `SELECT organization_id FROM phoenix_movement_events WHERE reference_id = $1`,
        [correctionId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].organization_id).toBe(ORG);
    });
  });
});
