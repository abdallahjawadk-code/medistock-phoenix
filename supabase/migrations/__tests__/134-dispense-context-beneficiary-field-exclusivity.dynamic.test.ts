/**
 * 134/172 · DISPENSE-CONTEXT BENEFICIARY FIELD EXCLUSIVITY — dynamic proof.
 *
 * WHY THIS FILE EXISTS. A UAT pass found that DispenseContextDialog did not
 * clear the other beneficiary type's fields when the operator switched type,
 * and submitted them anyway: a patient identifier typed before switching to
 * `internal_order` was sent alongside an `internal_order` discriminator. The
 * client half of that repair lives in DispenseContextDialog.tsx. This file
 * proves the half that governs EVERY client, including a forged request that
 * never goes near the React app:
 *
 *   * the authoritative RPC refuses a mixed payload;
 *   * a DIRECT table INSERT of a contradictory row is refused too, so no
 *     client can route around the RPC;
 *   * a clean patient record and a clean internal_order record both still
 *     succeed, and the stored row carries NULLs in the other type's columns;
 *   * the refusal is a REFUSAL, proved by counting rows — never by reading an
 *     exception string;
 *   * cross-organization authorization is unchanged by any of the above.
 *
 * The exclusivity invariant itself predates the defect: migration 134's
 * `phoenix_movement_dispense_context_type_fields_chk` has enforced it since
 * the table was created, which is why no contradictory row was ever persisted
 * in spite of the client bug. Nothing here relaxes it — this file pins it so
 * it cannot be weakened later without a test failing.
 *
 * PRIVACY: every value below is a synthetic rig constant. No real patient
 * identifier or name exists in this file, and no row contents are printed.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000, hookTimeout: 300000 });

const fp = () => createHash('sha256').update(randomUUID()).digest('hex');
const run = rigAvailable() ? describe : describe.skip;

// Synthetic, obviously-not-real placeholders.
const SYNTH_MRN = 'SYNTHETIC-MRN-NOT-REAL';
const SYNTH_NAME = 'SYNTHETIC-NAME-NOT-REAL';
const SYNTH_ORDER = 'SYNTHETIC-ORDER-REF';

const ORG_A = '00000000-0000-0000-0000-00000134f001';
const ORG_B = '00000000-0000-0000-0000-00000134f002';
const WH_A = '00000000-0000-0000-0000-00000134f101';
const WH_B = '00000000-0000-0000-0000-00000134f102';
const DP_A = '00000000-0000-0000-0000-00000134f301';
const DP_B = '00000000-0000-0000-0000-00000134f302';
const OO_A = '00000000-0000-0000-0000-00000134f401'; // outlet_officer, org A
const OO_B = '00000000-0000-0000-0000-00000134f402'; // outlet_officer, org B

run('134/172 dispense-context beneficiary field exclusivity — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  /** Capture a rejection, or fail loudly if the call unexpectedly succeeded. */
  const rejects = async (fn: () => Promise<unknown>): Promise<{ message: string; code: string }> => {
    try {
      await fn();
    } catch (e: any) {
      return { message: e?.message ?? String(e), code: e?.code ?? '' };
    }
    throw new Error('expected a rejection but the call succeeded');
  };

  const contextRowCount = async (): Promise<number> =>
    rig.asAdmin(async (c: any) => {
      const r = await c.query('SELECT count(*)::int AS n FROM public.phoenix_movement_dispense_context');
      return r.rows[0].n as number;
    });

  beforeAll(async () => {
    rig = await buildRig({ upTo: 172 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations
          (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${ORG_A}','FA','أ','p134f-a','care_institution','hospital','active'),
        ('${ORG_B}','FB','ب','p134f-b','care_institution','hospital','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WH-FA','مخزن أ','active','institution','p134f-wa'),
        ('${WH_B}','${ORG_B}','WH-FB','مخزن ب','active','institution','p134f-wb')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_A}','${WH_A}','${ORG_A}','Outlet FA','منفذ أ','pharmacy','active'),
               ('${DP_B}','${WH_B}','${ORG_B}','Outlet FB','منفذ ب','pharmacy','active')
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OO_A}','p134f-ooa@rig'),('${OO_B}','p134f-oob@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_B}' WHERE id='${OO_B}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO_A}','${ORG_A}','distribution_point','${DP_A}',true),
               ('${OO_B}','${ORG_B}','distribution_point','${DP_B}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  const insertDispenseMovement = async (org: string, dp: string, actor: string) => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P134F',true,false,$4,100,0,1)`, [stockId, org, dp, `B-134F-${randomUUID()}`]);
      await c.query(`INSERT INTO outlet_stock_movements
        (id, outlet_stock_id, organization_id, distribution_point_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, reason, reason_code, reference_type, reference_id, request_fingerprint, actor_id, scientific_name_snapshot)
        VALUES ($1,$2,$3,$4,'dispense',100,-5,95,0,0,0,'dispensed','dispensed','outlet_request',$5,$6,$7,'P134F')`,
        [movementId, stockId, org, dp, randomUUID(), fp(), actor]);
    });
    return movementId;
  };

  // ---------------------------------------------------------------------
  // 1. THE DEFECT'S PAYLOAD: internal_order carrying a patient identifier.
  // ---------------------------------------------------------------------
  it('refuses a mixed payload: internal_order carrying a patient identifier', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    const before = await contextRowCount();

    const err = await rejects(() => rig.asUser(OO_A, (c: any) =>
      call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'internal_order', SYNTH_MRN, null, null, SYNTH_ORDER, null, null])));

    // A check-constraint refusal (23514) — the row never lands.
    expect(err.code).toBe('23514');
    expect(await contextRowCount()).toBe(before);
  });

  it('refuses a mixed payload: internal_order carrying a patient name', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    const before = await contextRowCount();

    const err = await rejects(() => rig.asUser(OO_A, (c: any) =>
      call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'internal_order', null, SYNTH_NAME, null, SYNTH_ORDER, null, null])));

    expect(err.code).toBe('23514');
    expect(await contextRowCount()).toBe(before);
  });

  it('refuses a mixed payload: internal_order carrying a patient reference type', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    const before = await contextRowCount();

    const err = await rejects(() => rig.asUser(OO_A, (c: any) =>
      call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'internal_order', null, null, null, SYNTH_ORDER, null, 'chart'])));

    // This vector has its own named guard in the 172 writer.
    expect(err.message).toContain('patient_reference_type_not_applicable');
    expect(await contextRowCount()).toBe(before);
  });

  // ---------------------------------------------------------------------
  // 2. No client can route around the RPC.
  // ---------------------------------------------------------------------
  it('a DIRECT table INSERT of a contradictory row is refused, so the invariant is not RPC-only', async () => {
    const before = await contextRowCount();
    const err = await rejects(() => rig.asAdmin((c: any) =>
      c.query(`INSERT INTO public.phoenix_movement_dispense_context
          (movement_id, organization_id, distribution_point_id, beneficiary_type,
           patient_identifier, internal_order_reference, recorded_by, request_fingerprint)
         VALUES (gen_random_uuid(), $1, $2, 'internal_order', $3, $4, $5, $6)`,
        [ORG_A, DP_A, SYNTH_MRN, SYNTH_ORDER, OO_A, fp()])));

    expect(err.code).toBe('23514');
    expect(err.message).toContain('phoenix_movement_dispense_context_type_fields_chk');
    expect(await contextRowCount()).toBe(before);
  });

  // ---------------------------------------------------------------------
  // 3. The legitimate flows still work — the guard discriminates.
  // ---------------------------------------------------------------------
  it('a CLEAN internal_order record succeeds through the RPC and stores NULLs in every patient column', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);

    // commit:true — rig.asUser rolls back by default; this row must persist so
    // the stored shape can be inspected.
    const r = await rig.asUser(OO_A, (c: any) =>
      call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'internal_order', null, null, null, SYNTH_ORDER, 'routine', null]),
      { commit: true });
    expect(r.ok).toBe(true);

    await rig.asAdmin(async (c: any) => {
      const row = await c.query(
        `SELECT beneficiary_type, patient_identifier, patient_name, patient_reference_type, internal_order_reference
           FROM public.phoenix_movement_dispense_context WHERE movement_id = $1`, [movementId]);
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].beneficiary_type).toBe('internal_order');
      expect(row.rows[0].patient_identifier).toBeNull();
      expect(row.rows[0].patient_name).toBeNull();
      expect(row.rows[0].patient_reference_type).toBeNull();
      expect(row.rows[0].internal_order_reference).toBe(SYNTH_ORDER);
    });
  });

  /**
   * The PATIENT direction of the same invariant.
   *
   * It is asserted on the constraint's own definition rather than by writing a
   * patient row, deliberately: since migration 172 a patient row must ALSO
   * satisfy the clinical-context oracle
   * (_phoenix_patient_dispense_reference_types_v1, enforced both in the writer
   * and by a table trigger), which depends on the outlet's
   * clinical_location_kind and institution_class. That is a separate contract
   * with its own tests. Writing a patient row here would couple this file to
   * it, so an unrelated clinical-context change would fail this test and an
   * exclusivity regression would be indistinguishable from it. The client-side
   * patient direction is covered independently by
   * src/features/outlet/__tests__/dispense-context-beneficiary-isolation.runtime.test.tsx.
   */
  it('the constraint forbids internal-order/crash-cart references on a patient row', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT pg_get_constraintdef(oid) AS def
          FROM pg_constraint
         WHERE conrelid = 'public.phoenix_movement_dispense_context'::regclass
           AND conname  = 'phoenix_movement_dispense_context_type_fields_chk'`);
      expect(r.rows).toHaveLength(1);
      const def = (r.rows[0].def as string).replace(/\s+/g, ' ');
      // The patient branch must null out BOTH non-patient reference columns.
      expect(def).toMatch(/beneficiary_type = 'patient'[\s\S]*?crash_cart_reference IS NULL/);
      expect(def).toMatch(/beneficiary_type = 'patient'[\s\S]*?internal_order_reference IS NULL/);
    });
  });

  // ---------------------------------------------------------------------
  // 4. Authorization is untouched by any of the above.
  // ---------------------------------------------------------------------
  it('cross-organization denial still holds: org B cannot record context on an org A movement', async () => {
    const movementId = await insertDispenseMovement(ORG_A, DP_A, OO_A);
    const before = await contextRowCount();

    const err = await rejects(() => rig.asUser(OO_B, (c: any) =>
      call(c, 'phoenix_record_movement_dispense_context',
        [randomUUID(), movementId, 'internal_order', null, null, null, SYNTH_ORDER, null, null])));

    expect(err.message).toContain('forbidden_movement_context_record');
    expect(await contextRowCount()).toBe(before);
  });

  it('the exclusivity constraint is present and has not been weakened', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT pg_get_constraintdef(oid) AS def
          FROM pg_constraint
         WHERE conrelid = 'public.phoenix_movement_dispense_context'::regclass
           AND conname  = 'phoenix_movement_dispense_context_type_fields_chk'`);
      expect(r.rows).toHaveLength(1);
      const def = r.rows[0].def as string;
      // internal_order must forbid every patient-only column.
      expect(def).toContain('internal_order');
      expect(def).toContain('patient_identifier IS NULL');
      expect(def).toContain('patient_name IS NULL');
    });
  });
});
