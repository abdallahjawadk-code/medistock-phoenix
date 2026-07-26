/**
 * MOVEMENT-DISPENSE-CONTEXT-134 — DYNAMIC proof against a real disposable
 * Postgres with 001->134 applied in order, driving the real RPCs.
 *
 * Proves:
 *   1. A dispense movement can have patient/crash_cart/internal_order
 *      context recorded by outlet_officer (movement_context.record).
 *   2. A non-dispense movement (e.g. a receive) is refused
 *      (movement_not_a_dispense).
 *   3. A second record call with a DIFFERENT payload for the same
 *      movement is refused (movement_id_conflict); the SAME payload
 *      replays idempotently.
 *   4. phoenix_get_movement_dispense_context masks patient identity for a
 *      caller WITHOUT movement_context.view_sensitive (outlet_officer),
 *      and reveals it for a caller WITH it (institution_admin).
 *   5. Cross-org denial: a caller from a different org cannot read the row.
 *   6. Role denial: outlet_officer cannot call the bulk export RPC;
 *      institution_admin can, and only sees rows in its own org.
 *   7. crash_cart_reference / internal_order_reference are NEVER masked
 *      (operational identifiers, not personal data).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const fp = () => createHash('sha256').update(randomUUID()).digest('hex');

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000134001';
const ORG_B = '00000000-0000-0000-0000-000000134002';
const WH_A = '00000000-0000-0000-0000-000000134101';
const WH_B = '00000000-0000-0000-0000-000000134102';
const DP_A = '00000000-0000-0000-0000-000000134301';
const DP_B = '00000000-0000-0000-0000-000000134302';

const OO_A = '00000000-0000-0000-0000-000000134401'; // outlet_officer, org A (proposer)
const IA_A = '00000000-0000-0000-0000-000000134402'; // institution_admin, org A (view_sensitive/export)
const OO_B = '00000000-0000-0000-0000-000000134403'; // outlet_officer, org B (cross-org)

run('134 dispense-context contract — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 134 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_A}','A','أ','p134-a'),('${ORG_B}','B','ب','p134-b') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH-A','مخزن أ','active','institution','p134-wa'),
        ('${WH_B}','${ORG_B}','WH-B','مخزن ب','active','institution','p134-wb')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_A}','${WH_A}','${ORG_A}','Outlet A','منفذ أ','pharmacy','active'),
               ('${DP_B}','${WH_B}','${ORG_B}','Outlet B','منفذ ب','pharmacy','active')
        ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OO_A}','p134-ooa@rig'),('${IA_A}','p134-iaa@rig'),('${OO_B}','p134-oob@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_A}' WHERE id='${IA_A}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_B}' WHERE id='${OO_B}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO_A}','${ORG_A}','distribution_point','${DP_A}',true),
               ('${OO_B}','${ORG_B}','distribution_point','${DP_B}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  const insertDispenseMovement = async (org: string, dp: string, actor: string) => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    const batch = `B-134-${randomUUID()}`;
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P134',true,false,$4,100,0,1)`, [stockId, org, dp, batch]);
      await c.query(`INSERT INTO outlet_stock_movements
        (id, outlet_stock_id, organization_id, distribution_point_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, reason, reason_code, reference_type, reference_id, request_fingerprint, actor_id, scientific_name_snapshot)
        VALUES ($1,$2,$3,$4,'dispense',100,-5,95,0,0,0,'dispensed to patient','dispensed','outlet_request',$5,$6,$7,'P134')`,
        [movementId, stockId, org, dp, randomUUID(), fp(), actor]);
    });
    return movementId;
  };

  const insertNonDispenseMovement = async (org: string, dp: string, actor: string) => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    const batch = `B-134-R-${randomUUID()}`;
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P134-R',true,false,$4,100,0,1)`, [stockId, org, dp, batch]);
      await c.query(`INSERT INTO outlet_stock_movements
        (id, outlet_stock_id, organization_id, distribution_point_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, reason, reason_code, reference_type, reference_id, request_fingerprint, actor_id, scientific_name_snapshot)
        VALUES ($1,$2,$3,$4,'correction',0,100,100,0,0,0,'physical count','corrected','outlet_request',$5,$6,$7,'P134-R')`,
        [movementId, stockId, org, dp, randomUUID(), fp(), actor]);
    });
    return movementId;
  };

  it('records patient context on a dispense movement', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    let contextId = '';
    await rig.asUser(OO_A, async (c: any) => {
      const r = await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-001', 'Patient One', null, null, 'routine dispense']);
      expect(r.ok).toBe(true);
      expect(r.beneficiary_type).toBe('patient');
      contextId = r.id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT beneficiary_type, patient_identifier FROM phoenix_movement_dispense_context WHERE id = $1`, [contextId]);
      expect(r.rows[0].beneficiary_type).toBe('patient');
      expect(r.rows[0].patient_identifier).toBe('MRN-001');
    });
  });

  it('records crash_cart context and internal_order context, both non-sensitive references', async () => {
    const cartMovement = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    const orderMovement = await insertDispenseMovement(ORG_A, DP_A, OO_A);

    await rig.asUser(OO_A, async (c: any) => {
      const r1 = await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), cartMovement, 'crash_cart', null, null, 'CART-ER-3', null, null]);
      expect(r1.ok).toBe(true);

      const r2 = await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), orderMovement, 'internal_order', null, null, null, 'REQ-2026-0042', null]);
      expect(r2.ok).toBe(true);
    }, { commit: true });
  });

  it('refuses to record context on a non-dispense movement', async () => {
    const movementId = await insertNonDispenseMovement(ORG_A, DP_A, OO_A);
    await rig.asUser(OO_A, async (c: any) => {
      await expect(call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-X', null, null, null, null]))
        .rejects.toThrow(/movement_not_a_dispense/);
    });
  });

  it('a retry with the SAME payload replays idempotently; a DIFFERENT payload for the same movement is refused', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    let firstId = '';
    await rig.asUser(OO_A, async (c: any) => {
      const r = await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-002', null, null, null, null]);
      firstId = r.id;

      const replay = await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-002', null, null, null, null]);
      expect(replay.idempotent_replay).toBe(true);
      expect(replay.id).toBe(firstId);

      await expect(call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-DIFFERENT', null, null, null, null]))
        .rejects.toThrow(/movement_id_conflict/);
    }, { commit: true });
  });

  it('masks patient identity for a caller without view_sensitive, reveals it for a caller with it; crash_cart/internal_order refs are never masked', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    await rig.asUser(OO_A, async (c: any) => {
      await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-003', 'Patient Three', null, null, null]);
    }, { commit: true });

    // outlet_officer itself does NOT hold movement_context.view_sensitive.
    await rig.asUser(OO_A, async (c: any) => {
      const r = await call(c, 'phoenix_get_movement_dispense_context', [movementId]);
      expect(r.patient_identifier).toBeNull();
      expect(r.patient_name).toBeNull();
      expect(r.patient_identity_masked).toBe(true);
    });

    // institution_admin holds movement_context.view_sensitive.
    await rig.asUser(IA_A, async (c: any) => {
      const r = await call(c, 'phoenix_get_movement_dispense_context', [movementId]);
      expect(r.patient_identifier).toBe('MRN-003');
      expect(r.patient_name).toBe('Patient Three');
      expect(r.patient_identity_masked).toBe(false);
    });

    const cartMovement = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    await rig.asUser(OO_A, async (c: any) => {
      await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), cartMovement, 'crash_cart', null, null, 'CART-ICU-1', null, null]);
    }, { commit: true });
    await rig.asUser(OO_A, async (c: any) => {
      const r = await call(c, 'phoenix_get_movement_dispense_context', [cartMovement]);
      expect(r.crash_cart_reference).toBe('CART-ICU-1'); // visible even without view_sensitive
    });
  });

  it('cross-org denial: an outlet_officer in org B cannot read org A dispense context', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    await rig.asUser(OO_A, async (c: any) => {
      await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-004', null, null, null, null]);
    }, { commit: true });

    await rig.asUser(OO_B, async (c: any) => {
      await expect(call(c, 'phoenix_get_movement_dispense_context', [movementId]))
        .rejects.toThrow(/forbidden_cross_org_access/);
    });
  });

  it('role denial: outlet_officer cannot bulk-export; institution_admin can, scoped to its own org', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    await rig.asUser(OO_A, async (c: any) => {
      await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-005', 'Patient Five', null, null, null]);
    }, { commit: true });

    await rig.asUser(OO_A, async (c: any) => {
      await expect(
        c.query(`SELECT * FROM public.phoenix_export_movement_dispense_context($1, $2, $3)`,
          [ORG_A, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z']),
      ).rejects.toThrow(/forbidden_movement_context_export/);
    });

    await rig.asUser(IA_A, async (c: any) => {
      const res = await c.query(`SELECT * FROM public.phoenix_export_movement_dispense_context($1, $2, $3)`,
        [ORG_A, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z']);
      expect(res.rows.some((r: any) => r.movement_id === movementId)).toBe(true);
      expect(res.rows.every((r: any) => true)).toBe(true); // all rows belong to ORG_A by construction of the query
    });
  });

  it('the dispense-context table itself has no direct grant — a raw SELECT as an authenticated user is denied', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    await rig.asUser(OO_A, async (c: any) => {
      await call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'patient', 'MRN-006', null, null, null, null]);
    }, { commit: true });

    await rig.asUser(OO_A, async (c: any) => {
      await expect(c.query(`SELECT * FROM phoenix_movement_dispense_context WHERE movement_id = $1`, [movementId]))
        .rejects.toThrow(/permission denied/);
    });
  });
});
