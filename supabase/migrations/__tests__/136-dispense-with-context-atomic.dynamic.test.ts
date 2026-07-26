/**
 * DISPENSE-WITH-CONTEXT-ATOMIC-136 — DYNAMIC operational acceptance against a
 * real disposable Postgres with 001->136 applied in order.
 *
 * These are the OPERATIONAL proofs the phase requires, driven through the
 * real RPCs exactly as the UI does — not source scans:
 *   * a real quantity movement for each of the three beneficiary types;
 *   * ATOMICITY: a context that fails validation rolls the DISPENSE back too
 *     (the quantity must not leave the outlet);
 *   * duplicate submission / retry idempotency (no double-dispense);
 *   * concurrency: two simultaneous dispenses cannot overspend stock;
 *   * insufficient stock fails atomically;
 *   * before/after reconciliation on the ledger row;
 *   * source linkage: context.movement_id is the movement actually written;
 *   * role denial, cross-org denial;
 *   * dispense-context privacy (masking on/off) and the separate
 *     export_sensitive gate;
 *   * audit immutability (append-only).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000136001';
const ORG_B = '00000000-0000-0000-0000-000000136002';
const WH_A = '00000000-0000-0000-0000-000000136101';
const WH_B = '00000000-0000-0000-0000-000000136102';
const DP_A = '00000000-0000-0000-0000-000000136301';
const DP_B = '00000000-0000-0000-0000-000000136302';

const OO_A = '00000000-0000-0000-0000-000000136401'; // outlet_officer, org A — dispenses + records
const IA_A = '00000000-0000-0000-0000-000000136402'; // institution_admin, org A — view/export sensitive
const OO_B = '00000000-0000-0000-0000-000000136403'; // outlet_officer, org B — cross-org
const WO_A = '00000000-0000-0000-0000-000000136404'; // warehouse_officer, org A — holds neither key

let seq = 0;
const uniqBatch = () => `B136-${Date.now()}-${seq++}`;

run('136 dispense-with-context — operational acceptance (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 136 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_A}','A','أ','p136-a'),('${ORG_B}','B','ب','p136-b') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_A}','${ORG_A}','WA','مخزنA','active','institution','p136-wa'),
        ('${WH_B}','${ORG_B}','WB','مخزنB','active','institution','p136-wb')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_A}','${WH_A}','${ORG_A}','OA','منفذA','pharmacy','active'),
               ('${DP_B}','${WH_B}','${ORG_B}','OB','منفذB','pharmacy','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OO_A}','p136-ooa@rig'),('${IA_A}','p136-iaa@rig'),('${OO_B}','p136-oob@rig'),('${WO_A}','p136-woa@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_A}' WHERE id='${OO_A}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_A}' WHERE id='${IA_A}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG_B}' WHERE id='${OO_B}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_A}' WHERE id='${WO_A}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO_A}','${ORG_A}','distribution_point','${DP_A}',true),
               ('${OO_B}','${ORG_B}','distribution_point','${DP_B}',true),
               ('${WO_A}','${ORG_A}','distribution_point','${DP_A}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** A fresh outlet_stock lot with a known on-hand quantity. */
  async function seedLot(org: string, dp: string, qty: number): Promise<string> {
    const id = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type,
           scientific_name, has_no_national_code, has_no_batch_number, batch_number,
           expiry_date, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'pharmacy','P136',true,false,$4,current_date + 365,$5,0,1)`,
        [id, org, dp, uniqBatch(), qty],
      );
    });
    return id;
  }

  const onHand = async (lot: string): Promise<number> => {
    let v = -1;
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [lot]);
      v = r.rows[0].on_hand_quantity;
    });
    return v;
  };

  // ── Real quantity movements, one per beneficiary type ───────────────────

  it('PATIENT: moves real quantity, records context atomically, reconciles, and links to the movement', async () => {
    const lot = await seedLot(ORG_A, DP_A, 50);
    let res: any;
    await rig.asUser(OO_A, async (c: any) => {
      res = await call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), lot, 8, 'patient', 'MRN-100', 'Patient One', 'chart', null, null, 'ward round', null, 'bed 4',
      ]);
      expect(res.ok).toBe(true);
    }, { commit: true });

    expect(await onHand(lot)).toBe(42);

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(
        `SELECT reason_code, on_hand_before, on_hand_delta, on_hand_after FROM outlet_stock_movements WHERE id=$1`,
        [res.movement_id],
      );
      expect(mv.rows[0].reason_code).toBe('dispensed');
      expect(mv.rows[0].on_hand_before + mv.rows[0].on_hand_delta).toBe(mv.rows[0].on_hand_after);
      expect(mv.rows[0].on_hand_after).toBe(42);

      // Source linkage: the context row points at the movement actually written.
      const ctx = await c.query(
        `SELECT movement_id, beneficiary_type, patient_identifier, patient_reference_type
           FROM phoenix_movement_dispense_context WHERE id=$1`,
        [res.dispense_context_id],
      );
      expect(ctx.rows[0].movement_id).toBe(res.movement_id);
      expect(ctx.rows[0].beneficiary_type).toBe('patient');
      expect(ctx.rows[0].patient_identifier).toBe('MRN-100');
      expect(ctx.rows[0].patient_reference_type).toBe('chart');
    });
  });

  it('CRASH CART and INTERNAL ORDER both move real quantity and record their own reference', async () => {
    const cartLot = await seedLot(ORG_A, DP_A, 20);
    const orderLot = await seedLot(ORG_A, DP_A, 20);
    await rig.asUser(OO_A, async (c: any) => {
      const cart = await call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), cartLot, 3, 'crash_cart', null, null, null, 'CART-ER-1', null, null, null, null,
      ]);
      expect(cart.ok).toBe(true);
      const order = await call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), orderLot, 4, 'internal_order', null, null, null, null, 'REQ-2026-7', null, null, null,
      ]);
      expect(order.ok).toBe(true);
    }, { commit: true });

    expect(await onHand(cartLot)).toBe(17);
    expect(await onHand(orderLot)).toBe(16);
  });

  // ── ATOMICITY — the whole reason this RPC exists ────────────────────────

  it('ATOMIC: an invalid context rolls the DISPENSE back — no quantity leaves the outlet', async () => {
    const lot = await seedLot(ORG_A, DP_A, 30);

    await rig.asUser(OO_A, async (c: any) => {
      // patient with an identifier but NO reference type -> context validation fails
      await expect(call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), lot, 5, 'patient', 'MRN-BAD', 'Nobody', null, null, null, null, null, null,
      ])).rejects.toThrow(/patient_reference_type_required/);
    });

    // The quantity is untouched AND no orphan movement exists.
    expect(await onHand(lot)).toBe(30);
    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT count(*)::int AS n FROM outlet_stock_movements WHERE outlet_stock_id=$1`, [lot]);
      expect(mv.rows[0].n).toBe(0);
    });
  });

  it('ATOMIC: an invalid beneficiary type is refused BEFORE any quantity moves', async () => {
    const lot = await seedLot(ORG_A, DP_A, 30);
    await rig.asUser(OO_A, async (c: any) => {
      await expect(call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), lot, 5, 'not_a_type', null, null, null, null, null, null, null, null,
      ])).rejects.toThrow(/invalid_beneficiary_type/);
    });
    expect(await onHand(lot)).toBe(30);
  });

  // ── Retries, duplicates, insufficient stock, concurrency ────────────────

  it('RETRY: the same request id replays to the same movement and context — no double-dispense', async () => {
    const lot = await seedLot(ORG_A, DP_A, 40);
    const requestId = randomUUID();
    let first: any; let replay: any;
    await rig.asUser(OO_A, async (c: any) => {
      const args = [requestId, lot, 6, 'crash_cart', null, null, null, 'CART-RETRY', null, null, null, null];
      first = await call(c, 'phoenix_dispense_outlet_stock_with_context', args);
      replay = await call(c, 'phoenix_dispense_outlet_stock_with_context', args);
    }, { commit: true });

    expect(replay.movement_id).toBe(first.movement_id);
    expect(replay.idempotent_replay).toBe(true);
    expect(await onHand(lot)).toBe(34); // 40 - 6, applied ONCE
  });

  it('INSUFFICIENT STOCK fails atomically and writes nothing', async () => {
    const lot = await seedLot(ORG_A, DP_A, 3);
    await rig.asUser(OO_A, async (c: any) => {
      await expect(call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), lot, 99, 'crash_cart', null, null, null, 'CART-OVER', null, null, null, null,
      ])).rejects.toThrow(/outlet_quantity_cannot_go_negative/);
    });
    expect(await onHand(lot)).toBe(3);
    await rig.asAdmin(async (c: any) => {
      const n = await c.query(`SELECT count(*)::int AS n FROM outlet_stock_movements WHERE outlet_stock_id=$1`, [lot]);
      expect(n.rows[0].n).toBe(0);
      const ctx = await c.query(
        `SELECT count(*)::int AS n FROM phoenix_movement_dispense_context c
           JOIN outlet_stock_movements m ON m.id=c.movement_id WHERE m.outlet_stock_id=$1`, [lot]);
      expect(ctx.rows[0].n).toBe(0);
    });
  });

  it('CONCURRENCY: two simultaneous dispenses of the same lot cannot overspend it', async () => {
    const lot = await seedLot(ORG_A, DP_A, 10);
    // Both ask for 6 of 10 — at most one may win; the row lock inside the
    // dispense RPC must serialise them.
    const attempt = () =>
      rig.asUser(OO_A, async (c: any) => {
        return call(c, 'phoenix_dispense_outlet_stock_with_context', [
          randomUUID(), lot, 6, 'crash_cart', null, null, null, 'CART-RACE', null, null, null, null,
        ]);
      }, { commit: true }).then(() => 'ok').catch((e: any) => String(e.message));

    const results = await Promise.all([attempt(), attempt()]);
    const wins = results.filter(r => r === 'ok').length;
    expect(wins).toBe(1);
    expect(results.some(r => /outlet_quantity_cannot_go_negative/.test(r))).toBe(true);
    expect(await onHand(lot)).toBe(4); // exactly one 6-unit dispense applied
  });

  // ── Authorization ───────────────────────────────────────────────────────

  it('ROLE DENIAL: warehouse_officer (holds neither outlet_stock.dispense nor movement_context.record) is refused, and nothing moves', async () => {
    const lot = await seedLot(ORG_A, DP_A, 25);
    await rig.asUser(WO_A, async (c: any) => {
      await expect(call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), lot, 2, 'crash_cart', null, null, null, 'CART-DENY', null, null, null, null,
      ])).rejects.toThrow(/forbidden_outlet_stock_dispense/);
    });
    expect(await onHand(lot)).toBe(25);
  });

  it('CROSS-ORG DENIAL: an org B officer cannot dispense an org A lot', async () => {
    const lot = await seedLot(ORG_A, DP_A, 25);
    await rig.asUser(OO_B, async (c: any) => {
      await expect(call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), lot, 2, 'crash_cart', null, null, null, 'CART-XORG', null, null, null, null,
      ])).rejects.toThrow(/forbidden_outlet_stock_dispense/);
    });
    expect(await onHand(lot)).toBe(25);
  });

  // ── Privacy ─────────────────────────────────────────────────────────────

  it('PRIVACY: patient identity is masked for the recorder, unmasked for view_sensitive; reference TYPE is never masked', async () => {
    const lot = await seedLot(ORG_A, DP_A, 30);
    let res: any;
    await rig.asUser(OO_A, async (c: any) => {
      res = await call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), lot, 2, 'patient', 'MRN-SECRET', 'Sensitive Name', 'card', null, null, null, null, null,
      ]);
    }, { commit: true });

    // The RECORDER does not hold view_sensitive — it cannot read identity back.
    await rig.asUser(OO_A, async (c: any) => {
      const got = await call(c, 'phoenix_get_movement_dispense_context', [res.movement_id]);
      expect(got.patient_identifier).toBeNull();
      expect(got.patient_name).toBeNull();
      expect(got.patient_identity_masked).toBe(true);
      expect(got.patient_reference_type).toBe('card'); // a document KIND is not identity
    });

    await rig.asUser(IA_A, async (c: any) => {
      const got = await call(c, 'phoenix_get_movement_dispense_context', [res.movement_id]);
      expect(got.patient_identifier).toBe('MRN-SECRET');
      expect(got.patient_name).toBe('Sensitive Name');
      expect(got.patient_identity_masked).toBe(false);
    });
  });

  it('PRIVACY: patient identity never lands in the movement ledger, the canonical events, or the audit log', async () => {
    const lot = await seedLot(ORG_A, DP_A, 30);
    const secret = `MRN-LEAK-${randomUUID()}`;
    let res: any;
    await rig.asUser(OO_A, async (c: any) => {
      res = await call(c, 'phoenix_dispense_outlet_stock_with_context', [
        randomUUID(), lot, 2, 'patient', secret, 'Leak Probe', 'pass', null, null, 'routine', null, null,
      ]);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      // The ledger row: no free-text column may carry the identifier.
      const ledger = await c.query(
        `SELECT count(*)::int AS n FROM outlet_stock_movements
          WHERE id=$1 AND (COALESCE(reason,'')                    LIKE '%'||$2||'%'
                        OR COALESCE(source_document_number,'')    LIKE '%'||$2||'%'
                        OR COALESCE(scientific_name_snapshot,'')  LIKE '%'||$2||'%'
                        OR COALESCE(batch_number_snapshot,'')     LIKE '%'||$2||'%')`,
        [res.movement_id, secret],
      );
      expect(ledger.rows[0].n).toBe(0);

      // The canonical read envelope: check EVERY text-bearing column, so a
      // future column cannot start leaking identity without this failing.
      const events = await c.query(
        `SELECT count(*)::int AS n FROM phoenix_movement_events e
          WHERE COALESCE(e.source_label,'')      LIKE '%'||$1||'%'
             OR COALESCE(e.destination_label,'') LIKE '%'||$1||'%'
             OR COALESCE(e.material_label,'')    LIKE '%'||$1||'%'
             OR COALESCE(e.batch_label,'')       LIKE '%'||$1||'%'
             OR COALESCE(e.notes,'')             LIKE '%'||$1||'%'
             OR COALESCE(e.dedupe_key,'')        LIKE '%'||$1||'%'
             OR COALESCE(e.event_type,'')        LIKE '%'||$1||'%'
             OR COALESCE(e.status_after,'')      LIKE '%'||$1||'%'`,
        [secret],
      );
      expect(events.rows[0].n).toBe(0);

      const audit = await c.query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE payload::text LIKE '%'||$1||'%'`,
        [secret],
      );
      expect(audit.rows[0].n).toBe(0);
    });
  });

  it('PRIVACY: bulk export requires the SEPARATE export_sensitive permission', async () => {
    const range = ['2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
    // outlet_officer records context but must not be able to bulk-export it.
    await rig.asUser(OO_A, async (c: any) => {
      await expect(
        c.query(`SELECT * FROM public.phoenix_export_movement_dispense_context($1,$2,$3)`, [ORG_A, ...range]),
      ).rejects.toThrow(/forbidden_movement_context_export/);
    });
    // institution_admin holds it, and sees only its own organization.
    await rig.asUser(IA_A, async (c: any) => {
      const r = await c.query(
        `SELECT * FROM public.phoenix_export_movement_dispense_context($1,$2,$3)`, [ORG_A, ...range]);
      expect(r.rows.length).toBeGreaterThan(0);
      expect(r.rows.every((x: any) => x.patient_reference_type === null
        || ['chart', 'card', 'pass'].includes(x.patient_reference_type))).toBe(true);
    });
    // ...and cannot export another organization at all.
    await rig.asUser(IA_A, async (c: any) => {
      await expect(
        c.query(`SELECT * FROM public.phoenix_export_movement_dispense_context($1,$2,$3)`, [ORG_B, ...range]),
      ).rejects.toThrow(/forbidden_movement_context_export/);
    });
  });

  // ── Immutability ────────────────────────────────────────────────────────

  it('IMMUTABILITY: a recorded context cannot be edited to a different beneficiary', async () => {
    const lot = await seedLot(ORG_A, DP_A, 30);
    const requestId = randomUUID();
    let res: any;
    await rig.asUser(OO_A, async (c: any) => {
      res = await call(c, 'phoenix_dispense_outlet_stock_with_context', [
        requestId, lot, 2, 'crash_cart', null, null, null, 'CART-ORIG', null, null, null, null,
      ]);
    }, { commit: true });

    // The tamper attempt MUST be its own transaction: a raised exception
    // aborts the whole enclosing txn, so sharing one with the dispense above
    // would roll the dispense back and prove nothing about immutability.
    await rig.asUser(OO_A, async (c: any) => {
      // Same movement, DIFFERENT beneficiary payload -> refused outright.
      await expect(call(c, 'phoenix_record_movement_dispense_context', [
        randomUUID(), res.movement_id, 'crash_cart', null, null, 'CART-TAMPERED', null, null, null,
      ])).rejects.toThrow(/movement_id_conflict/);
    });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT crash_cart_reference FROM phoenix_movement_dispense_context WHERE movement_id=$1`,
        [res.movement_id],
      );
      expect(r.rows[0].crash_cart_reference).toBe('CART-ORIG');
    });
  });

  it('IMMUTABILITY: authenticated holds no UPDATE/DELETE on the context table or the ledger', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema='public' AND grantee='authenticated'
            AND table_name IN ('phoenix_movement_dispense_context','outlet_stock_movements')
            AND privilege_type IN ('UPDATE','DELETE')`,
      );
      expect(r.rows).toEqual([]);
    });
  });
});
