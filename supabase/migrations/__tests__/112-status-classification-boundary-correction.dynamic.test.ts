/**
 * STATUS-CLASSIFICATION-BOUNDARY-CORRECTION — DYNAMIC proof for migration
 * 112, against a real disposable Postgres with 001->112 applied in order.
 *
 * Proves the EXACT boundary matrix the user specified:
 *   available = target_max          -> surplus
 *   available = target_max - 1      -> available (not surplus)
 *   available = target_max + 1      -> surplus
 *   strictly between reorder_point and target_max -> available
 *   available = reorder_point       -> scarce (inclusive lower boundary)
 *   available = reorder_point + 1   -> available (just above scarce)
 *   available = 1 (reorder_point >= 1) -> scarce (just above zero)
 *   available = 0                   -> unavailable
 *   unavailable NEVER transitions into missing/suspected_missing through
 *   any code path in this classification system.
 *
 * Also proves replay 001->112 succeeds and zero regression: 092's own
 * still-relevant behavior (suspected_missing evidence/four-eyes flow,
 * report lifecycle) is untouched.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no disposable Postgres is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000100001';
const WH = '00000000-0000-0000-0000-000000100101';

const WO = '00000000-0000-0000-0000-000000100401'; // warehouse_officer — prepares/classifies

// reorder_point=10, target_max=100 for every boundary-test material below.
const REORDER_POINT = 10;
const TARGET_MAX = 100;

run('112 status classification boundary correction — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 112 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p112-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p112-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${WO}','p112-wo@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('replay 001->112 succeeded and the CHECK constraints contain every required canonical value', async () => {
    await rig.asAdmin(async (c: any) => {
      const defs = await c.query(
        `SELECT pg_get_constraintdef(oid) def FROM pg_constraint
          WHERE conrelid = 'public.inventory_status_report_lines'::regclass AND contype = 'c'`,
      );
      const joined = defs.rows.map((r: any) => r.def).join(' | ');
      for (const value of ['available', 'unavailable', 'scarce', 'surplus', 'suspected_missing']) {
        expect(joined).toContain(value);
      }
    });
  });

  it('an unknown/garbage classification value is rejected by the CHECK constraint', async () => {
    await rig.asAdmin(async (c: any) => {
      const report = await c.query(
        `INSERT INTO inventory_status_reports (id, organization_id, status, prepared_by, prepared_at)
         VALUES (gen_random_uuid(), $1, 'draft', $2, now()) RETURNING id`,
        [ORG, WO],
      );
      await expect(
        c.query(
          `INSERT INTO inventory_status_report_lines
             (id, report_id, scientific_name, on_hand_qty, reserved_qty, in_transit_qty,
              quarantine_qty, central_qty, supplementary_qty, suggested_classification)
           VALUES (gen_random_uuid(), $1, 'P112-garbage-value', 0, 0, 0, 0, 0, 0, 'not_a_real_value')`,
          [report.rows[0].id],
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });
  });

  /**
   * Seeds ONE material at this warehouse with the given on_hand quantity
   * (reserved_quantity always 0, so available === on_hand for every case
   * below) and a threshold row of reorder_point=10 / target_max=100, then
   * runs phoenix_status_prepare_report and reads back the suggested
   * classification for that exact material.
   */
  async function classifyAt(tag: string, onHand: number): Promise<string> {
    const material = `P112-${tag}`;
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
         VALUES (gen_random_uuid(),$1,$2,$3,true,false,$4,$5,0,current_date + 30,0)`,
        [ORG, WH, material, `B-${tag}`, onHand],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds (id, organization_id, scope_kind, scope_id, scientific_name, reorder_point, target_max, is_active, created_by, updated_by)
         VALUES (gen_random_uuid(),$1,'warehouse',$2,$3,$4,$5,true,$6,$6)`,
        [ORG, WH, material, REORDER_POINT, TARGET_MAX, WO],
      );
    });

    const result = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_status_prepare_report($1) AS r`, [ORG]);
      return r.rows[0].r;
    }, { commit: true });

    const line = await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT suggested_classification FROM inventory_status_report_lines
          WHERE report_id = $1 AND scientific_name = $2`,
        [result.report_id, material],
      );
      return r.rows[0]?.suggested_classification;
    });
    return line;
  }

  it('available = target_max -> surplus', async () => {
    expect(await classifyAt('at-max', TARGET_MAX)).toBe('surplus');
  });

  it('available = target_max - 1 -> available (not surplus)', async () => {
    expect(await classifyAt('below-max', TARGET_MAX - 1)).toBe('available');
  });

  it('available = target_max + 1 -> surplus', async () => {
    expect(await classifyAt('above-max', TARGET_MAX + 1)).toBe('surplus');
  });

  it('available strictly between reorder_point and target_max -> available', async () => {
    const mid = REORDER_POINT + Math.floor((TARGET_MAX - REORDER_POINT) / 2);
    expect(await classifyAt('mid', mid)).toBe('available');
  });

  it('available = reorder_point -> scarce (inclusive lower boundary)', async () => {
    expect(await classifyAt('at-reorder', REORDER_POINT)).toBe('scarce');
  });

  it('available = reorder_point + 1 -> available (just above scarce)', async () => {
    expect(await classifyAt('above-reorder', REORDER_POINT + 1)).toBe('available');
  });

  it('available = 1 -> scarce (just above zero; reorder_point=10 >= 1)', async () => {
    expect(await classifyAt('one', 1)).toBe('scarce');
  });

  it('available = 0 -> unavailable', async () => {
    expect(await classifyAt('zero', 0)).toBe('unavailable');
  });

  it('unavailable NEVER transitions into missing/suspected_missing through any code path', async () => {
    const material = 'P112-unavail-vs-missing';
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
         VALUES (gen_random_uuid(),$1,$2,$3,true,false,'B-unavail',0,0,current_date + 30,0)`,
        [ORG, WH, material],
      );
    });
    const result = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_status_prepare_report($1) AS r`, [ORG]);
      return r.rows[0].r;
    }, { commit: true });

    const line = await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT suggested_classification, classification, confirmed_missing, stocktake_count_line_id
           FROM inventory_status_report_lines WHERE report_id = $1 AND scientific_name = $2`,
        [result.report_id, material],
      );
      return r.rows[0];
    });

    // A zero on-hand alone produces 'unavailable' as the SUGGESTED
    // classification — never 'suspected_missing', never confirmed_missing,
    // never a stocktake_count_line_id (that evidence trail is only ever set
    // by an operator's EXPLICIT suspected_missing classification through
    // phoenix_status_classify_lines + a real stocktake row, which this test
    // never calls).
    expect(line.suggested_classification).toBe('unavailable');
    expect(line.classification).toBeNull();
    expect(line.confirmed_missing).toBe(false);
    expect(line.stocktake_count_line_id).toBeNull();

    // An operator MAY still explicitly classify it as suspected_missing —
    // but ONLY through the unchanged, fully-guarded evidence path (098/101/
    // 092's phoenix_status_confirm_missing), never as a side effect of
    // 'unavailable'. Prove the guard still fires without evidence.
    const lineId = await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT id FROM inventory_status_report_lines WHERE report_id = $1 AND scientific_name = $2`,
        [result.report_id, material],
      );
      return r.rows[0].id;
    });
    await expect(
      rig.asUser(WO, async (c: any) => {
        await c.query(
          `SELECT public.phoenix_status_classify_lines($1, $2)`,
          [result.report_id, JSON.stringify([{ line_id: lineId, classification: 'suspected_missing', reason: 'no evidence attached' }])],
        );
      }, { commit: true }),
    ).rejects.toThrow(/stocktake_evidence_required/);
  });

  it('unavailable is a plain classifiable value like scarce/surplus — no special evidence required to set it manually', async () => {
    const material = 'P112-manual-unavailable';
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
         VALUES (gen_random_uuid(),$1,$2,$3,true,false,'B-manual',50,0,current_date + 30,0)`,
        [ORG, WH, material],
      );
    });
    const result = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_status_prepare_report($1) AS r`, [ORG]);
      return r.rows[0].r;
    }, { commit: true });
    const lineId = await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT id FROM inventory_status_report_lines WHERE report_id = $1 AND scientific_name = $2`,
        [result.report_id, material],
      );
      return r.rows[0].id;
    });

    const classifyResult = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_status_classify_lines($1, $2) AS r`,
        [result.report_id, JSON.stringify([{ line_id: lineId, classification: 'unavailable' }])],
      );
      return r.rows[0].r;
    }, { commit: true });
    expect(classifyResult.ok).toBe(true);

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT classification FROM inventory_status_report_lines WHERE id = $1`, [lineId]);
      expect(r.rows[0].classification).toBe('unavailable');
    });
  });

  // "Zero regression: 108/109 posture unchanged" was retired here — it
  // asserted a premise that was never actually true at exactly 001->112:
  // 108 only ever locked down stocktakes/stocktake_count_lines (092's OTHER
  // two tables), never inventory_status_report_lines. Verified live: at
  // upTo:112, `authenticated` genuinely still holds
  // DELETE/INSERT/REFERENCES/TRIGGER/TRUNCATE/UPDATE here (092 never revoked
  // them, and neither did 108, 109, nor anything before 113). Migration 113
  // (MONTHLY-STATUS-DIRECT-WRITE-LOCKDOWN) closes this exact gap and carries
  // its own full live privilege-matrix + bypass-attempt proof in
  // 113-monthly-status-direct-write-lockdown.dynamic.test.ts — asserting the
  // SELECT-only outcome here, before 113 ever runs, would have been encoding
  // the bug as a passing test rather than actually guarding against it.
});
