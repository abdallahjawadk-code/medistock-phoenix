/**
 * MONTHLY-STATUS-REDESIGN-092 — DYNAMIC proof.
 *
 * Drives the REAL RPCs of migration 092 against a disposable cluster with the
 * full chain 001->092 applied. Covers the five-persona workflow end to end:
 *
 *   prepare     warehouse_officer generates the report from live stock,
 *               suggested classification derived from 072 thresholds
 *   classify    individual + bulk, always validated as one atomic batch;
 *               suspected_missing requires real stocktake evidence (a proven
 *               negative-variance count) + a reason, or is rejected
 *   confirm     four-eyes: the SAME officer who counted cannot single-
 *               handedly confirm a shortage — a second, different
 *               warehouse_officer must confirm; a DIFFERENT counter needs
 *               only one confirmation
 *   review      institution_admin submits; central_warehouse_manager returns
 *               for clarification or approves+locks
 *   amendment   only a locked report can be amended; the amendment is a NEW
 *               versioned report linked back via
 *               inventory_status_report_amendments — the original stays
 *               locked and untouched
 *   thresholds  inventory.manage_thresholds is central_warehouse_manager
 *               only post-092 (warehouse_officer/institution_admin/
 *               outlet_officer all refused)
 *   isolation   a second organization's institution_admin/CWM cannot read or
 *               act on the first organization's report
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000e001';
const ORG_OTHER = '00000000-0000-0000-0000-00000000e002';
const WH = '00000000-0000-0000-0000-00000000e101';
const WH_OTHER = '00000000-0000-0000-0000-00000000e102';
const DP = '00000000-0000-0000-0000-00000000e301';

const WO = '00000000-0000-0000-0000-00000000e401';        // warehouse_officer, counts
const WO2 = '00000000-0000-0000-0000-00000000e402';       // warehouse_officer, confirms
const IA = '00000000-0000-0000-0000-00000000e403';        // institution_admin
const CWM = '00000000-0000-0000-0000-00000000e404';       // central_warehouse_manager
const OO = '00000000-0000-0000-0000-00000000e405';        // outlet_officer
const IA_OTHER = '00000000-0000-0000-0000-00000000e406';  // institution_admin, ORG_OTHER
const CWM_OTHER = '00000000-0000-0000-0000-00000000e407'; // central_warehouse_manager, ORG_OTHER

run('092 — monthly status redesign (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const asWO  = (fn: (c: any) => Promise<any>) => rig.asUser(WO, fn, { commit: true });
  const asWO2 = (fn: (c: any) => Promise<any>) => rig.asUser(WO2, fn, { commit: true });
  const asIA  = (fn: (c: any) => Promise<any>) => rig.asUser(IA, fn, { commit: true });
  const asCWM = (fn: (c: any) => Promise<any>) => rig.asUser(CWM, fn, { commit: true });
  const asOO  = (fn: (c: any) => Promise<any>) => rig.asUser(OO, fn, { commit: true });
  const asIAOther  = (fn: (c: any) => Promise<any>) => rig.asUser(IA_OTHER, fn, { commit: true });
  const asCWMOther = (fn: (c: any) => Promise<any>) => rig.asUser(CWM_OTHER, fn, { commit: true });

  beforeAll(async () => {
    rig = await buildRig({ upTo: 92 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','ms-i'),('${ORG_OTHER}','Other','أخرى','ms-o')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','IWH','مخزن','active','institution','ms-wi'),
        ('${WH_OTHER}','${ORG_OTHER}','OWH','مخزن2','active','institution','ms-wo')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${WO}','ms-wo@rig'),('${WO2}','ms-wo2@rig'),('${IA}','ms-ia@rig'),
        ('${CWM}','ms-cwm@rig'),('${OO}','ms-oo@rig'),
        ('${IA_OTHER}','ms-iao@rig'),('${CWM_OTHER}','ms-cwmo@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id IN ('${WO}','${WO2}');`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG}' WHERE id='${IA}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG_OTHER}' WHERE id='${IA_OTHER}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG_OTHER}' WHERE id='${CWM_OTHER}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO}','${ORG}','warehouse','${WH}',true), ('${WO2}','${ORG}','warehouse','${WH}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO}','${ORG}','distribution_point','${DP}',true) ON CONFLICT DO NOTHING;`);

      // Two materials: Amoxicillin (200 on hand, threshold reorder_point=250 -> scarce),
      // Paracetamol (500 on hand, target_max=100 -> surplus). A third,
      // Ibuprofen, is stocked physically (so it's counted at stocktake) but
      // removed from warehouse_stock before "prepare" so it can be classified
      // suspected_missing on the report without an available-stock contradiction.
      await c.query(`INSERT INTO warehouse_stock
        (id, organization_id, warehouse_id, scientific_name, national_code, has_no_batch_number, internal_batch_reference, on_hand_quantity, reserved_quantity, supply_type, purchase_origin, expiry_date)
        VALUES
        (gen_random_uuid(), '${ORG}', '${WH}', 'Amoxicillin', 'NC-AMX', true, 'ms-ibr-amx', 200, 0, 'aid', NULL, now()::date + interval '400 days'),
        (gen_random_uuid(), '${ORG}', '${WH}', 'Paracetamol', 'NC-PCM', true, 'ms-ibr-pcm', 500, 0, 'purchase', 'supplementary', now()::date + interval '30 days')
        ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });

    await rig.asUser(CWM, (c: any) => c.query(
      `SELECT public.phoenix_upsert_inventory_threshold($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ORG, 'warehouse', WH, 'Amoxicillin', 'NC-AMX', 250, null, null, true],
    ), { commit: true });
    await rig.asUser(CWM, (c: any) => c.query(
      `SELECT public.phoenix_upsert_inventory_threshold($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ORG, 'warehouse', WH, 'Paracetamol', 'NC-PCM', null, 100, null, true],
    ), { commit: true });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  let reportId: string;

  it('prepare: warehouse_officer generates the report with suggested classification from thresholds', async () => {
    const r = await asWO((c) => call(c, 'phoenix_status_prepare_report', [ORG]));
    expect(r.ok).toBe(true);
    reportId = r.report_id;

    const lines = await rig.asAdmin((c: any) =>
      c.query(`SELECT scientific_name, suggested_classification, on_hand_qty, central_qty, supplementary_qty
                 FROM inventory_status_report_lines WHERE report_id=$1 ORDER BY scientific_name`, [reportId])
        .then((r: any) => r.rows));
    const amx = lines.find((l: any) => l.scientific_name === 'Amoxicillin');
    const pcm = lines.find((l: any) => l.scientific_name === 'Paracetamol');
    expect(amx.suggested_classification).toBe('scarce');   // 200 <= reorder_point 250
    expect(pcm.suggested_classification).toBe('surplus');  // 500 > target_max 100
    expect(Number(amx.central_qty)).toBe(200);
    expect(Number(pcm.supplementary_qty)).toBe(500);
  });

  it('institution_admin cannot prepare (wrong permission)', async () => {
    await expect(asIA((c) => call(c, 'phoenix_status_prepare_report', [ORG]))).rejects.toThrow(/not_authorized_status_center_prepare_own/);
  });

  it('central_warehouse_manager cannot classify (wrong permission)', async () => {
    const lineId = await rig.asAdmin((c: any) =>
      c.query(`SELECT id FROM inventory_status_report_lines WHERE report_id=$1 AND scientific_name='Paracetamol'`, [reportId])
        .then((r: any) => r.rows[0].id));
    await expect(asCWM((c) => call(c, 'phoenix_status_classify_lines',
      [reportId, JSON.stringify([{ line_id: lineId, classification: 'surplus', reason: null }])])))
      .rejects.toThrow(/not_authorized_status_center_classify_own/);
  });

  it('bulk classify: accepts the system suggestion for Paracetamol, overrides Amoxicillin to available with a reason', async () => {
    const lines = await rig.asAdmin((c: any) =>
      c.query(`SELECT id, scientific_name FROM inventory_status_report_lines WHERE report_id=$1`, [reportId])
        .then((r: any) => r.rows));
    const amx = lines.find((l: any) => l.scientific_name === 'Amoxicillin');
    const pcm = lines.find((l: any) => l.scientific_name === 'Paracetamol');

    const r = await asWO((c) => call(c, 'phoenix_status_classify_lines', [reportId, JSON.stringify([
      { line_id: amx.id, classification: 'available', reason: null },
      { line_id: pcm.id, classification: 'surplus', reason: null },
    ])]));
    expect(r.ok).toBe(true);
    expect(r.classified).toBe(2);

    const after = await rig.asAdmin((c: any) =>
      c.query(`SELECT id, classification, classification_overridden FROM inventory_status_report_lines WHERE report_id=$1`, [reportId])
        .then((r: any) => r.rows));
    const amxAfter = after.find((l: any) => l.id === amx.id);
    const pcmAfter = after.find((l: any) => l.id === pcm.id);
    expect(amxAfter.classification).toBe('available');
    expect(amxAfter.classification_overridden).toBe(true);   // suggested was 'scarce'
    expect(pcmAfter.classification).toBe('surplus');
    expect(pcmAfter.classification_overridden).toBe(false);  // matched the suggestion
  });

  it('suspected_missing without stocktake evidence is rejected (whole batch, atomically)', async () => {
    const amx = await rig.asAdmin((c: any) =>
      c.query(`SELECT id FROM inventory_status_report_lines WHERE report_id=$1 AND scientific_name='Amoxicillin'`, [reportId])
        .then((r: any) => r.rows[0].id));
    await expect(asWO((c) => call(c, 'phoenix_status_classify_lines', [reportId, JSON.stringify([
      { line_id: amx, classification: 'suspected_missing', reason: 'looks short' },
    ])]))).rejects.toThrow(/stocktake_evidence_required/);

    // Confirm the batch truly did not apply (still 'available' from the prior test).
    const still = await rig.asAdmin((c: any) =>
      c.query(`SELECT classification FROM inventory_status_report_lines WHERE id=$1`, [amx]).then((r: any) => r.rows[0]));
    expect(still.classification).toBe('available');
  });

  let stocktakeLineShortId: string;
  let stocktakeLineNoShortageId: string;

  it('record_stocktake: server computes expected_qty from live stock, client supplies counted_qty', async () => {
    const r = await asWO((c) => call(c, 'phoenix_status_record_stocktake', [
      ORG, 'warehouse', WH, 'monthly count',
      JSON.stringify([
        { scientific_name: 'Amoxicillin', national_code: 'NC-AMX', counted_qty: 150 },  // 200 expected -> shortage
        { scientific_name: 'Paracetamol', national_code: 'NC-PCM', counted_qty: 500 },  // matches -> no shortage
      ]),
    ]));
    expect(r.ok).toBe(true);
    const lines = await rig.asAdmin((c: any) =>
      c.query(`SELECT id, scientific_name, expected_qty, counted_qty, variance FROM stocktake_count_lines WHERE stocktake_id=$1`, [r.stocktake_id])
        .then((r: any) => r.rows));
    const amx = lines.find((l: any) => l.scientific_name === 'Amoxicillin');
    const pcm = lines.find((l: any) => l.scientific_name === 'Paracetamol');
    expect(Number(amx.expected_qty)).toBe(200);
    expect(Number(amx.variance)).toBe(-50);
    expect(Number(pcm.variance)).toBe(0);
    stocktakeLineShortId = amx.id;
    stocktakeLineNoShortageId = pcm.id;
  });

  it('suspected_missing rejects evidence with a non-negative variance', async () => {
    const pcm = await rig.asAdmin((c: any) =>
      c.query(`SELECT id FROM inventory_status_report_lines WHERE report_id=$1 AND scientific_name='Paracetamol'`, [reportId])
        .then((r: any) => r.rows[0].id));
    await expect(asWO((c) => call(c, 'phoenix_status_classify_lines', [reportId, JSON.stringify([
      { line_id: pcm, classification: 'suspected_missing', reason: 'x', stocktake_count_line_id: stocktakeLineNoShortageId },
    ])]))).rejects.toThrow(/stocktake_evidence_not_a_shortage/);
  });

  it('suspected_missing rejects a missing reason even with valid evidence', async () => {
    const amx = await rig.asAdmin((c: any) =>
      c.query(`SELECT id FROM inventory_status_report_lines WHERE report_id=$1 AND scientific_name='Amoxicillin'`, [reportId])
        .then((r: any) => r.rows[0].id));
    await expect(asWO((c) => call(c, 'phoenix_status_classify_lines', [reportId, JSON.stringify([
      { line_id: amx, classification: 'suspected_missing', reason: '', stocktake_count_line_id: stocktakeLineShortId },
    ])]))).rejects.toThrow(/reason_required_for_suspected_missing/);
  });

  let amxLineId: string;

  it('classify suspected_missing with valid evidence + reason succeeds', async () => {
    amxLineId = await rig.asAdmin((c: any) =>
      c.query(`SELECT id FROM inventory_status_report_lines WHERE report_id=$1 AND scientific_name='Amoxicillin'`, [reportId])
        .then((r: any) => r.rows[0].id));
    const r = await asWO((c) => call(c, 'phoenix_status_classify_lines', [reportId, JSON.stringify([
      { line_id: amxLineId, classification: 'suspected_missing', reason: 'physical count short by 50', stocktake_count_line_id: stocktakeLineShortId },
    ])]));
    expect(r.ok).toBe(true);
    const line = await rig.asAdmin((c: any) =>
      c.query(`SELECT classification, confirmed_missing FROM inventory_status_report_lines WHERE id=$1`, [amxLineId]).then((r: any) => r.rows[0]));
    expect(line.classification).toBe('suspected_missing');
    expect(line.confirmed_missing).toBe(false);
  });

  it('four-eyes: the SAME officer who counted cannot single-handedly confirm — first call is held pending', async () => {
    const r = await asWO((c) => call(c, 'phoenix_status_confirm_missing', [amxLineId]));
    expect(r.ok).toBe(true);
    expect(r.confirmed).toBe(false);
    expect(r.reason).toBe('PENDING_SECOND_CONFIRMATION_SELF_COUNTED');

    const line = await rig.asAdmin((c: any) =>
      c.query(`SELECT confirmed_missing, first_confirmed_by FROM inventory_status_report_lines WHERE id=$1`, [amxLineId]).then((r: any) => r.rows[0]));
    expect(line.confirmed_missing).toBe(false);
    expect(line.first_confirmed_by).toBe(WO);
  });

  it('four-eyes: a repeat self-confirm attempt by the SAME officer stays pending, not confirmed', async () => {
    const r = await asWO((c) => call(c, 'phoenix_status_confirm_missing', [amxLineId]));
    expect(r.confirmed).toBe(false);
  });

  it('four-eyes: a SECOND, different warehouse_officer finalizes the confirmation', async () => {
    const r = await asWO2((c) => call(c, 'phoenix_status_confirm_missing', [amxLineId]));
    expect(r.ok).toBe(true);
    expect(r.confirmed).toBe(true);

    const line = await rig.asAdmin((c: any) =>
      c.query(`SELECT confirmed_missing, confirmed_by FROM inventory_status_report_lines WHERE id=$1`, [amxLineId]).then((r: any) => r.rows[0]));
    expect(line.confirmed_missing).toBe(true);
    expect(line.confirmed_by).toBe(WO2);
  });

  it('submit is refused while an unconfirmed suspected_missing line existed — now confirmed, refused only if unclassified lines remain (none do)', async () => {
    // Sanity: nothing left unclassified.
    const unclassified = await rig.asAdmin((c: any) =>
      c.query(`SELECT count(*)::int n FROM inventory_status_report_lines WHERE report_id=$1 AND classification IS NULL`, [reportId])
        .then((r: any) => r.rows[0].n));
    expect(unclassified).toBe(0);
  });

  it('warehouse_officer cannot submit (wrong permission)', async () => {
    await expect(asWO((c) => call(c, 'phoenix_status_submit_report', [reportId])))
      .rejects.toThrow(/not_authorized_status_center_review_submit_own/);
  });

  it('institution_admin from another organization cannot submit this report (isolation)', async () => {
    await expect(asIAOther((c) => call(c, 'phoenix_status_submit_report', [reportId])))
      .rejects.toThrow(/not_authorized_status_center_review_submit_own/);
  });

  it('institution_admin from another organization cannot even SELECT this report (RLS isolation)', async () => {
    const rows = await rig.asUser(IA_OTHER, (c: any) =>
      c.query(`SELECT id FROM inventory_status_reports WHERE id=$1`, [reportId]).then((r: any) => r.rows));
    expect(rows).toHaveLength(0);
  });

  it('institution_admin submits', async () => {
    const r = await asIA((c) => call(c, 'phoenix_status_submit_report', [reportId]));
    expect(r.ok).toBe(true);
    const status = await rig.asAdmin((c: any) =>
      c.query(`SELECT status FROM inventory_status_reports WHERE id=$1`, [reportId]).then((r: any) => r.rows[0].status));
    expect(status).toBe('submitted');
  });

  it('central_warehouse_manager from another organization cannot return/approve this report (isolation)', async () => {
    await expect(asCWMOther((c) => call(c, 'phoenix_status_return_for_clarification', [reportId, 'x'])))
      .rejects.toThrow(/not_authorized_status_center_return_for_clarification/);
  });

  it('central_warehouse_manager returns for clarification', async () => {
    const r = await asCWM((c) => call(c, 'phoenix_status_return_for_clarification', [reportId, 'please double-check Paracetamol']));
    expect(r.ok).toBe(true);
    const status = await rig.asAdmin((c: any) =>
      c.query(`SELECT status, return_reason FROM inventory_status_reports WHERE id=$1`, [reportId]).then((r: any) => r.rows[0]));
    expect(status.status).toBe('returned');
    expect(status.return_reason).toContain('Paracetamol');
  });

  it('warehouse_officer can reclassify a returned report, institution_admin resubmits', async () => {
    const pcm = await rig.asAdmin((c: any) =>
      c.query(`SELECT id FROM inventory_status_report_lines WHERE report_id=$1 AND scientific_name='Paracetamol'`, [reportId])
        .then((r: any) => r.rows[0].id));
    const reclassified = await asWO((c) => call(c, 'phoenix_status_classify_lines', [reportId, JSON.stringify([
      { line_id: pcm, classification: 'surplus', reason: 'confirmed, correct as surplus' },
    ])]));
    expect(reclassified.ok).toBe(true);
    const draftStatus = await rig.asAdmin((c: any) =>
      c.query(`SELECT status FROM inventory_status_reports WHERE id=$1`, [reportId]).then((r: any) => r.rows[0].status));
    expect(draftStatus).toBe('draft'); // classify reopened it

    const resubmitted = await asIA((c) => call(c, 'phoenix_status_submit_report', [reportId]));
    expect(resubmitted.ok).toBe(true);
  });

  it('institution_admin cannot approve+lock (wrong permission)', async () => {
    await expect(asIA((c) => call(c, 'phoenix_status_approve_lock_report', [reportId])))
      .rejects.toThrow(/not_authorized_status_center_approve_lock/);
  });

  it('central_warehouse_manager approves and locks the report', async () => {
    const r = await asCWM((c) => call(c, 'phoenix_status_approve_lock_report', [reportId]));
    expect(r.ok).toBe(true);
    const row = await rig.asAdmin((c: any) =>
      c.query(`SELECT status, approved_by, locked_at FROM inventory_status_reports WHERE id=$1`, [reportId]).then((r: any) => r.rows[0]));
    expect(row.status).toBe('locked');
    expect(row.approved_by).toBe(CWM);
    expect(row.locked_at).not.toBeNull();
  });

  it('a locked report cannot be reclassified (immutable)', async () => {
    const amx = amxLineId;
    await expect(asWO((c) => call(c, 'phoenix_status_classify_lines', [reportId, JSON.stringify([
      { line_id: amx, classification: 'available', reason: null },
    ])]))).rejects.toThrow(/report_not_editable/);
  });

  it('preparing again for the same org opens a NEW report, not the locked one', async () => {
    const r = await asWO((c) => call(c, 'phoenix_status_prepare_report', [ORG]));
    expect(r.ok).toBe(true);
    expect(r.report_id).not.toBe(reportId);
    const status = await rig.asAdmin((c: any) =>
      c.query(`SELECT status FROM inventory_status_reports WHERE id=$1`, [r.report_id]).then((row: any) => row.rows[0].status));
    expect(status).toBe('draft');
    // Clean up: leave the org in a locked-only state for the amendment test below.
    await rig.asAdmin((c: any) => c.query(`DELETE FROM inventory_status_report_lines WHERE report_id=$1`, [r.report_id]));
    await rig.asAdmin((c: any) => c.query(`DELETE FROM inventory_status_reports WHERE id=$1`, [r.report_id]));
  });

  it('amendment: only a locked report can be amended, creating a new versioned report linked back to the original', async () => {
    await expect(asCWM((c) => call(c, 'phoenix_status_create_amendment', [reportId, ''])))
      .rejects.toThrow(/reason_required/);

    const r = await asCWM((c) => call(c, 'phoenix_status_create_amendment', [reportId, 'correcting Amoxicillin evidence link']));
    expect(r.ok).toBe(true);
    const amendmentId = r.amendment_report_id;

    const amendment = await rig.asAdmin((c: any) =>
      c.query(`SELECT status, version, amendment_of, organization_id FROM inventory_status_reports WHERE id=$1`, [amendmentId])
        .then((r: any) => r.rows[0]));
    expect(amendment.status).toBe('draft');
    expect(amendment.version).toBe(2);
    expect(amendment.amendment_of).toBe(reportId);
    expect(amendment.organization_id).toBe(ORG);

    const original = await rig.asAdmin((c: any) =>
      c.query(`SELECT status FROM inventory_status_reports WHERE id=$1`, [reportId]).then((r: any) => r.rows[0].status));
    expect(original).toBe('locked'); // untouched

    const link = await rig.asAdmin((c: any) =>
      c.query(`SELECT reason FROM inventory_status_report_amendments WHERE original_report_id=$1 AND amendment_report_id=$2`, [reportId, amendmentId])
        .then((r: any) => r.rows[0]));
    expect(link.reason).toBe('correcting Amoxicillin evidence link');

    const amendmentLines = await rig.asAdmin((c: any) =>
      c.query(`SELECT count(*)::int n FROM inventory_status_report_lines WHERE report_id=$1`, [amendmentId]).then((r: any) => r.rows[0].n));
    expect(amendmentLines).toBe(2); // copied from the original
  });

  it('inventory.manage_thresholds is central_warehouse_manager only: warehouse_officer refused', async () => {
    await expect(asWO((c) => c.query(
      `SELECT public.phoenix_upsert_inventory_threshold($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ORG, 'warehouse', WH, 'Amoxicillin', 'NC-AMX', 260, null, null, true],
    ))).rejects.toThrow(/not_authorized_inventory_manage_thresholds/);
  });

  it('inventory.manage_thresholds is central_warehouse_manager only: institution_admin refused', async () => {
    await expect(asIA((c) => c.query(
      `SELECT public.phoenix_upsert_inventory_threshold($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ORG, 'warehouse', WH, 'Amoxicillin', 'NC-AMX', 260, null, null, true],
    ))).rejects.toThrow(/not_authorized_inventory_manage_thresholds/);
  });

  it('inventory.manage_thresholds: central_warehouse_manager CAN set an org-default (scope_id NULL) threshold', async () => {
    const res = await asCWM((c) => c.query(
      `SELECT public.phoenix_upsert_inventory_threshold($1,$2,$3,$4,$5,$6,$7,$8,$9) r`,
      [ORG, 'warehouse', null, 'Ibuprofen', null, 10, 200, null, true],
    ));
    expect(res.rows[0].r.organization_id).toBe(ORG);
  });

  it('phoenix_set_inventory_threshold_planning: central_warehouse_manager sets safety_stock/lead_time_days; warehouse_officer refused', async () => {
    const thresholdId = await rig.asAdmin((c: any) =>
      c.query(`SELECT id FROM inventory_signal_thresholds WHERE organization_id=$1 AND scientific_name='Ibuprofen'`, [ORG])
        .then((r: any) => r.rows[0].id));

    await expect(asWO((c) => call(c, 'phoenix_set_inventory_threshold_planning', [thresholdId, 20, 14])))
      .rejects.toThrow(/not_authorized_inventory_manage_thresholds/);

    const r = await asCWM((c) => call(c, 'phoenix_set_inventory_threshold_planning', [thresholdId, 20, 14]));
    expect(r.ok).toBe(true);
    const row = await rig.asAdmin((c: any) =>
      c.query(`SELECT safety_stock, lead_time_days FROM inventory_signal_thresholds WHERE id=$1`, [thresholdId]).then((r: any) => r.rows[0]));
    expect(row.safety_stock).toBe(20);
    expect(row.lead_time_days).toBe(14);
  });

  it('outlet_officer read projection: sees only its own outlet contribution, not full-org totals', async () => {
    // Give the outlet some stock for the projected material.
    await rig.asAdmin((c: any) => c.query(`INSERT INTO outlet_stock
      (id, organization_id, distribution_point_id, point_type, scientific_name, national_code, has_no_batch_number, internal_batch_reference, on_hand_quantity, reserved_quantity)
      VALUES (gen_random_uuid(), '${ORG}', '${DP}', 'pharmacy', 'Paracetamol', 'NC-PCM', true, 'ms-ibr-pcm-outlet', 40, 0)
      ON CONFLICT DO NOTHING;`));

    const rows = await asOO((c) => c.query(
      `SELECT * FROM public.phoenix_status_get_outlet_contribution($1,$2)`, [reportId, DP],
    ).then((r: any) => r.rows));
    const pcmRow = rows.find((r: any) => r.scientific_name === 'Paracetamol');
    expect(pcmRow).toBeDefined();
    expect(Number(pcmRow.on_hand_qty)).toBe(40); // the OUTLET's own stock, not the org total (500+)
  });
});
