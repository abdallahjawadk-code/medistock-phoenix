/**
 * CN-2B CORRECTIVE EXTENSION (213) — DYNAMIC suite against the canonical
 * replayed chain (001..213). Proves physical-column beneficiary mapping: one
 * imported column maps to exactly one care_institution beneficiary, that
 * mapping is enforced server-side (not a UI courtesy) by the extended
 * phoenix_central_needs_set_need_line, and the review-blockers definition
 * accounts for every numeric cell of a confirmed column before a revision can
 * become ready — the multi-institution-row completeness gap M212 could not
 * close.
 *
 * Fixtures are seeded through the rig's superuser connection, exactly as the
 * 209/211/212 dynamic suites do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_OWNER      = '00000000-0000-0000-0000-000000213001'; // owns the plan (pharmacy_department_authority)
const ORG_BENE_A     = '00000000-0000-0000-0000-000000213002'; // Hospital A
const ORG_BENE_B     = '00000000-0000-0000-0000-000000213003'; // Hospital B
const ORG_BENE_C     = '00000000-0000-0000-0000-000000213004'; // Hospital C (zero-quantity scenario)
const ORG_INACTIVE   = '00000000-0000-0000-0000-000000213005'; // inactive institution
const ORG_OTHER      = '00000000-0000-0000-0000-000000213006'; // unrelated owner org

const U_EDIT   = '00000000-0000-0000-0000-000000213401'; // full central_needs on owner
const U_NOPERM = '00000000-0000-0000-0000-000000213402'; // owner org, no keys
const U_OTHER  = '00000000-0000-0000-0000-000000213403'; // different owner org

const ITEM_A = '00000000-0000-0000-0000-000000213801';

const PARSER_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};

const SET_LINE = 'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)';
const SET_COLUMNS = 'public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)';

interface Refusal { code: string; message: string; detail?: string }

async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

run('CN-2B/213 beneficiary column mapping — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 2050;
  let ordinalSeq = 0;

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  function provenance(sheetIndex: number, row: number, col: number, fileHash: string) {
    return {
      fileFingerprintSha256: fileHash,
      originalFilename: `needs-${fileHash.slice(0, 6)}.xlsx`,
      parserVersion: '1.0.0',
      sheetIndex,
      sheetName: `Sheet${sheetIndex}`,
      sheetHidden: 'visible',
      coordinate: { row, col, a1: `${String.fromCharCode(65 + col)}${row + 1}` },
      extractedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  /**
   * One completed import session with an explicit set of physical cells.
   * `rows`: one entry per (material) row; each carries one or more
   * `columns`, each an independent physical (sheetIndex, col) cell.
   */
  async function addSession(
    revId: string,
    sheetIndex: number,
    rows: Array<{
      row: number; entity: string; item?: string; decision?: 'mapped' | 'not_applicable';
      columns: Array<{ col: number; value: number | string; valueType?: 'number' | 'string'; fieldName?: string }>;
    }>,
  ) {
    ordinalSeq += 1;
    const fileHash = `${ordinalSeq}`.padStart(64, 'a');
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files
         (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [revId, ORG_OWNER, `needs-${ordinalSeq}.xls`, fileHash, 1024]);
    const digest = `${ordinalSeq}`.padStart(64, 'd');
    const [{ id: sessionId }] = await admin(
      `INSERT INTO central_needs_import_sessions
         (plan_revision_id, organization_id, source_file_id, status,
          preview_digest, authoritative_digest, parser_identity, completed_at)
       VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`,
      [revId, ORG_OWNER, fileId, digest, JSON.stringify(PARSER_IDENTITY)]);

    const records = new Map<string, string>(); // `${col}` -> source_record_id, per row-entity
    let ordinal = 0;
    for (const row of rows) {
      for (const col of row.columns) {
        ordinal += 1;
        const valueType = col.valueType ?? (typeof col.value === 'number' ? 'number' : 'string');
        const [{ id }] = await admin(
          `INSERT INTO central_needs_source_records
             (import_session_id, organization_id, record_ordinal, target_entity, field_name,
              source_values, source_provenance)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,
          [sessionId, ORG_OWNER, ordinal, row.entity, col.fieldName ?? `col:${col.col}`,
            JSON.stringify({ value: col.value, valueType, isFormula: false, formula: null }),
            JSON.stringify(provenance(sheetIndex, row.row, col.col, fileHash))]);
        records.set(`${row.entity}::${col.col}`, id);
      }
      const decision = row.decision ?? 'mapped';
      await admin(
        `INSERT INTO central_needs_record_mappings
           (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sessionId, ORG_OWNER, row.entity,
          decision === 'mapped' ? (row.item ?? ITEM_A) : null, decision,
          decision === 'mapped' ? null : 'out of scope']);
    }
    return { sessionId, records, fileHash };
  }

  async function scenario() {
    const y = year++;
    const [{ id: planId }] = await admin(
      `INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`,
      [ORG_OWNER, y]);
    const [{ id: revId }] = await admin(
      `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
         VALUES ($1,$2,1,'draft') RETURNING id`,
      [planId, ORG_OWNER]);
    return { planId, revId, year: y };
  }

  const cols = (...items: Array<{ importSessionId: string; sheetIndex: number; columnIndex: number;
    beneficiaryOrganizationId: string; previousBeneficiaryOrganizationId?: string | null }>) =>
    JSON.stringify(items);

  const setColumns = (userId: string | null, revId: string, mappings: string, reason = 'confirm column', role = 'authenticated') =>
    call(userId, `SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result`,
      [revId, mappings, reason], role);

  const sources = (...items: Array<[string, string | number]>) =>
    JSON.stringify(items.map(([id, qty]) => ({ sourceRecordId: id, designatedQuantity: String(qty), appliedOverrideId: null })));

  const setLine = (
    userId: string | null, revId: string,
    o: Partial<{ beneficiary: string; item: string; qty: string | number; reason: string;
      sources: string; expected: string[] | null }> = {},
    role = 'authenticated',
  ) => call(userId,
    `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,$11) AS result`,
    [revId, o.beneficiary ?? ORG_BENE_A, o.item ?? ITEM_A, 'qty' in o ? o.qty : 100, o.reason ?? 'mapped by reviewer',
      'sources' in o ? o.sources : '[]', 'expected' in o ? o.expected : [], 'box', 'canonical', null, null],
    role);

  const linksOf = (lineId: string) => admin(
    `SELECT source_record_id FROM central_needs_need_line_sources WHERE need_line_id=$1 ORDER BY source_record_id`, [lineId]);
  const linesOf = (revId: string) => admin(
    `SELECT id, beneficiary_organization_id, approved_quantity::text AS q
       FROM central_needs_need_lines WHERE plan_revision_id=$1 ORDER BY created_at, id`, [revId]);
  const blockers = (revId: string) =>
    admin(`SELECT blocker, detail FROM public._phoenix_central_needs_review_blockers_v1($1)`, [revId]);
  const mappingsOf = (sessionId: string) => admin(
    `SELECT sheet_index, column_index, beneficiary_organization_id
       FROM central_needs_beneficiary_column_mappings WHERE import_session_id=$1 ORDER BY sheet_index, column_index`, [sessionId]);

  // buildRig() replays the FULL chain (001..latest, C5/M217 included), which the
  // Vitest default 10s hook budget cannot hold: the reviewed long hook timeout
  // the other full-chain Central Needs suites use (C5 §19).
  beforeAll(async () => {
    rig = await buildRig();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'Babylon Pharmacy Dept','دائرة صحة بابل','p213-owner','pharmacy_department_authority',NULL),
        ($2,'Hospital A','مستشفى أ','p213-bene-a','care_institution','hospital'),
        ($3,'Hospital B','مستشفى ب','p213-bene-b','care_institution','hospital'),
        ($4,'Hospital C','مستشفى ج','p213-bene-c','care_institution','hospital'),
        ($5,'Inactive Institution','مؤسسة غير نشطة','p213-inactive','care_institution','hospital'),
        ($6,'Other Owner Org','جهة أخرى','p213-other','pharmacy_department_authority',NULL)
        ON CONFLICT (id) DO NOTHING`,
        [ORG_OWNER, ORG_BENE_A, ORG_BENE_B, ORG_BENE_C, ORG_INACTIVE, ORG_OTHER]);
      await c.query(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG_INACTIVE]);
      await c.query(`INSERT INTO central_items (id, name, name_ar, unit) VALUES ($1,'Item A','مادة أ','box')
        ON CONFLICT (id) DO NOTHING`, [ITEM_A]);
      await c.query(`INSERT INTO auth.users (id, email) VALUES
        ($1,'p213-edit@rig'),($2,'p213-noperm@rig'),($3,'p213-other@rig')
        ON CONFLICT (id) DO NOTHING`, [U_EDIT, U_NOPERM, U_OTHER]);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager', status='active', organization_id=$2 WHERE id=$1`,
        [U_EDIT, ORG_OWNER]);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager', status='active', organization_id=$2 WHERE id=$1`,
        [U_NOPERM, ORG_OWNER]);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager', status='active', organization_id=$2 WHERE id=$1`,
        [U_OTHER, ORG_OTHER]);
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES
        ($1,'central_needs.edit',true),($1,'central_needs.view',true),
        ($2,'central_needs.edit',true),($2,'central_needs.view',true)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [U_EDIT, U_OTHER]);
    });
  }, 600000);

  afterAll(async () => { await rig?.end(); });

  // ---- A/B/C. cell-level cardinality across confirmed beneficiary columns --
  describe('A/B/C. one row, two institution columns, cell-level cardinality', () => {
    it('A: two confirmed beneficiary columns on one row succeed as two independent need lines', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 5, entity: 'sheet:0:row:5', columns: [{ col: 1, value: 100 }, { col: 2, value: 50 }] },
      ]);
      const cellA = sess.records.get('sheet:0:row:5::1')!;
      const cellB = sess.records.get('sheet:0:row:5::2')!;

      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A },
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 2, beneficiaryOrganizationId: ORG_BENE_B },
      ));

      const a = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '100', sources: sources([cellA, '100']) });
      const b = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_B, qty: '50', sources: sources([cellB, '50']) });
      expect(a.need_line_id).not.toBe(b.need_line_id);
      expect((await linesOf(s.revId)).map((l: any) => l.beneficiary_organization_id).sort())
        .toEqual([ORG_BENE_A, ORG_BENE_B].sort());
    });

    it('B: same exact row, Hospital A cell and Hospital B cell coexist because CELL identity differs', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }, { col: 2, value: 20 }] },
      ]);
      const cellA = sess.records.get('sheet:0:row:1::1')!;
      const cellB = sess.records.get('sheet:0:row:1::2')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A },
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 2, beneficiaryOrganizationId: ORG_BENE_B },
      ));
      const a = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cellA, '10']) });
      const b = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_B, qty: '20', sources: sources([cellB, '20']) });
      expect(await linksOf(a.need_line_id)).toHaveLength(1);
      expect(await linksOf(b.need_line_id)).toHaveLength(1);
    });

    it('C: the exact same cell cannot feed two lines', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] },
      ]);
      const cellA = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      const first = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cellA, '10']) });
      // Same line, same cell, correctly-stated current lineage — the cell is
      // still refused because it is already linked to itself.
      const r = await refusal(setLine(U_EDIT, s.revId,
        { beneficiary: ORG_BENE_A, qty: '20', sources: sources([cellA, '10']), expected: [cellA] }));
      expect(r).toMatchObject({ code: '23514', message: 'source_record_already_linked' });
      expect(await linesOf(s.revId)).toHaveLength(1);
      expect(first.need_line_id).toBeTruthy();
    });
  });

  // ---- D/E. server-side enforcement -----------------------------------
  describe('D/E. server-side beneficiary-column enforcement', () => {
    it('D: source column mapped to A, setNeedLine called with B, refused server-side', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] },
      ]);
      const cellA = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      const r = await refusal(setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_B, qty: '10', sources: sources([cellA, '10']) }));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_conflict' });
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('E: source column unmapped, operational line refused', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] },
      ]);
      const cellA = sess.records.get('sheet:0:row:1::1')!;
      const r = await refusal(setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cellA, '10']) }));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_required' });
      expect(await linesOf(s.revId)).toHaveLength(0);
    });
  });

  // ---- F/G. beneficiary eligibility, reused from M212 -------------------
  describe('F/G. beneficiary eligibility is reused, not reinvented', () => {
    it('F: inactive beneficiary, mapping refused', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] },
      ]);
      const r = await refusal(setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_INACTIVE })));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_organization_not_active' });
      expect(await mappingsOf(sess.sessionId)).toHaveLength(0);
    });

    it('G: pharmacy_department_authority (the plan owner) refused as beneficiary', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] },
      ]);
      const r = await refusal(setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_OWNER })));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_must_be_care_institution' });
    });
  });

  // ---- H/I. duplicate header text never becomes identity -----------------
  describe('H/I. duplicate header text is never column identity', () => {
    it('H: two physical columns with identical field text remain two independent mappings', async () => {
      const s = await scenario();
      // Both columns carry the identical header text 'Quantity' — the
      // duplicate-header case the corpus is proven to contain. Identity must
      // still be the physical column, not the text.
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [
          { col: 1, value: 10, fieldName: 'Quantity' }, { col: 2, value: 20, fieldName: 'Quantity' }] },
      ]);
      const cellA = sess.records.get('sheet:0:row:1::1')!;
      const cellB = sess.records.get('sheet:0:row:1::2')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A },
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 2, beneficiaryOrganizationId: ORG_BENE_B },
      ));
      const rows = await mappingsOf(sess.sessionId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r: any) => r.beneficiary_organization_id).sort()).toEqual([ORG_BENE_A, ORG_BENE_B].sort());
      const a = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cellA, '10']) });
      const b = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_B, qty: '20', sources: sources([cellB, '20']) });
      expect(a.need_line_id).not.toBe(b.need_line_id);
    });

    it('I: same header text across two DIFFERENT import sessions — explicit bulk request maps both, persisted separately', async () => {
      const s = await scenario();
      const sess1 = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10, fieldName: 'Quantity' }] }]);
      const sess2 = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 20, fieldName: 'Quantity' }] }]);

      const r = await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess1.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A },
        { importSessionId: sess2.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A },
      ), 'apply to matching columns');
      expect((r as any).confirmed).toHaveLength(2);
      const rows1 = await mappingsOf(sess1.sessionId);
      const rows2 = await mappingsOf(sess2.sessionId);
      expect(rows1).toHaveLength(1);
      expect(rows2).toHaveLength(1);
    });
  });

  // ---- J/K. zero is a value, blank is not zero ---------------------------
  describe('J/K. zero is a value; blank is not zero', () => {
    it('J: a zero numeric cell remains valid and is accounted for', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 0 }] },
      ]);
      const cellZero = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_C }));
      // Unaccounted zero cell blocks readiness...
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('beneficiary_column_cell_without_need_line');
      // ...and can be legitimately designated as a zero-quantity line.
      const line = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_C, qty: '0', sources: sources([cellZero, '0']) });
      expect(line.approved_quantity).toBe('0');
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .not.toContain('beneficiary_column_cell_without_need_line');
    });

    it('K: a blank/missing cell does not become zero and is not a candidate at all', async () => {
      const s = await scenario();
      // A row with only ONE column populated; there is no record at all for a
      // "missing" second column, so it cannot appear as a mapping target nor
      // as an unaccounted-cell blocker.
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 5 }] },
      ]);
      const r = await refusal(setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 99, beneficiaryOrganizationId: ORG_BENE_A })));
      expect(r).toMatchObject({ code: '23503', message: 'beneficiary_column_no_matching_evidence' });
    });
  });

  // ---- L/M. cell-grain completeness blocker ------------------------------
  describe('L/M. completeness accounts for every cell of a confirmed column, not just the row', () => {
    it('L: mapped beneficiary column has two mapped material rows; only one is linked -> readiness stays blocked', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] },
        { row: 2, entity: 'sheet:0:row:2', columns: [{ col: 1, value: 20 }] },
      ]);
      const cell1 = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cell1, '10']) });
      const bl = (await blockers(s.revId)).map((b: any) => b.blocker);
      expect(bl).toContain('beneficiary_column_cell_without_need_line');
    });

    it('M: after both rows are linked, that blocker clears', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] },
        { row: 2, entity: 'sheet:0:row:2', columns: [{ col: 1, value: 20 }] },
      ]);
      const cell1 = sess.records.get('sheet:0:row:1::1')!;
      const cell2 = sess.records.get('sheet:0:row:2::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cell1, '10']) });
      expect((await blockers(s.revId)).map((b: any) => b.blocker)).toContain('beneficiary_column_cell_without_need_line');
      // Same accounting scope (beneficiary + item, no warehouse) as the first
      // call, so this EXTENDS the same line — expected must reflect that.
      await setLine(U_EDIT, s.revId,
        { beneficiary: ORG_BENE_A, item: ITEM_A, qty: '30', sources: sources([cell2, '20']), expected: [cell1] });
      expect((await blockers(s.revId)).map((b: any) => b.blocker)).not.toContain('beneficiary_column_cell_without_need_line');
    });
  });

  // ---- N. draft-only mutation --------------------------------------------
  describe('N. draft-only mutation', () => {
    it('attempting to modify a mapping after the revision is no longer draft is refused', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      await admin(`UPDATE central_needs_plan_revisions SET status = 'submitted' WHERE id = $1`, [s.revId]);
      const r = await refusal(setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A })));
      expect(r).toMatchObject({ code: '23514', message: 'plan_revision_not_editable' });
    });
  });

  // ---- O/P. authorization -------------------------------------------------
  describe('O/P. authorization', () => {
    it('O: an unauthorized cross-org caller is refused', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      const r = await refusal(setColumns(U_OTHER, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A })));
      expect(r).toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
    });

    it('O: a user in the owning org with no central_needs key is refused', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      const r = await refusal(setColumns(U_NOPERM, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A })));
      expect(r).toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
    });

    it('P: an anonymous caller is refused, by privilege and in practice', async () => {
      const [{ ok }] = await admin(`SELECT has_function_privilege('anon', '${SET_COLUMNS}', 'EXECUTE') AS ok`);
      expect(ok).toBe(false);
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      const r = await refusal(setColumns(null, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }), 'r', 'anon'));
      expect(r).toMatchObject({ code: '42501', message: 'permission denied for function phoenix_central_needs_set_beneficiary_columns' });
    });
  });

  // ---- Q/R. bulk atomicity and idempotency -------------------------------
  describe('Q/R. bulk atomicity and idempotent replay', () => {
    it('Q: an identical bulk mapping replay is idempotent — no duplicate physical rows, no audit noise', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      const first = await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      const [{ n: countBefore }] = await admin(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action='central_needs.beneficiary_column.set'`);
      const second = await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1,
          beneficiaryOrganizationId: ORG_BENE_A, previousBeneficiaryOrganizationId: ORG_BENE_A }));
      const [{ n: countAfter }] = await admin(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action='central_needs.beneficiary_column.set'`);
      expect((second as any).confirmed[0].changed).toBe(false);
      expect((second as any).confirmed[0].mappingId).toBe((first as any).confirmed[0].mappingId);
      expect(countAfter).toBe(countBefore);
      expect(await mappingsOf(sess.sessionId)).toHaveLength(1);
    });

    it('R: one invalid entry inside a bulk request rolls back the entire mutation', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] },
        { row: 2, entity: 'sheet:0:row:2', columns: [{ col: 2, value: 20 }] },
      ]);
      const r = await refusal(setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A },
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 2, beneficiaryOrganizationId: ORG_INACTIVE },
      )));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_organization_not_active' });
      expect(await mappingsOf(sess.sessionId)).toHaveLength(0);
    });

    it('no silent overwrite: re-mapping to a different beneficiary without stating the current one is refused', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      const r = await refusal(setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_B })));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_stale' });
      expect((await mappingsOf(sess.sessionId))[0].beneficiary_organization_id).toBe(ORG_BENE_A);
    });

    it('an explicit, reasoned correction (stating the correct previous beneficiary) is accepted and audited', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      const corrected = await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1,
          beneficiaryOrganizationId: ORG_BENE_B, previousBeneficiaryOrganizationId: ORG_BENE_A }), 'was mis-mapped');
      expect((corrected as any).confirmed[0].changed).toBe(true);
      expect((await mappingsOf(sess.sessionId))[0].beneficiary_organization_id).toBe(ORG_BENE_B);
      const [log] = await admin(
        `SELECT payload FROM audit_logs WHERE action='central_needs.beneficiary_column.set'
          ORDER BY created_at DESC LIMIT 1`);
      expect(log.payload.previous_beneficiary_organization_id).toBe(ORG_BENE_A);
      expect(log.payload.new_beneficiary_organization_id).toBe(ORG_BENE_B);
    });
  });

  // ---- Defence in depth: privileged bypass of the RPC --------------------
  describe('defence in depth — the deferred trigger catches what the RPC cannot see', () => {
    it('a privileged direct link of a cell whose column mapping later changes is caught at COMMIT', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      const cell = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      const line = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cell, '10']) });

      // Privileged direct re-point of the mapping (bypassing set_beneficiary_columns
      // entirely) to a DIFFERENT beneficiary than the already-linked line.
      const r = await refusal(rig.asAdmin((c: any) =>
        c.query(`UPDATE central_needs_beneficiary_column_mappings SET beneficiary_organization_id = $1 WHERE import_session_id = $2`,
          [ORG_BENE_B, sess.sessionId])));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_conflict' });
      expect((await linesOf(s.revId))[0]).toMatchObject({ id: line.need_line_id, beneficiary_organization_id: ORG_BENE_A });
    });

    it('a privileged DELETE of a mapping already feeding a need line is refused at COMMIT', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      const cell = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cell, '10']) });

      const r = await refusal(rig.asAdmin((c: any) =>
        c.query(`DELETE FROM central_needs_beneficiary_column_mappings WHERE import_session_id = $1`, [sess.sessionId])));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_in_use' });
      expect(await mappingsOf(sess.sessionId)).toHaveLength(1);
    });

    it('a privileged DELETE of an UNUSED mapping is allowed (nothing depends on it)', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      await rig.asAdmin((c: any) =>
        c.query(`DELETE FROM central_needs_beneficiary_column_mappings WHERE import_session_id = $1`, [sess.sessionId]));
      expect(await mappingsOf(sess.sessionId)).toHaveLength(0);
    });
  });

  // ---- S. INDEPENDENT REVIEW FINDING 1 — no relevant column escapes review --
  //
  // Every physical column carrying NUMERIC evidence on a row a human
  // dispositioned `mapped` must reach an explicit column-review decision:
  // `beneficiary` (a confirmed care_institution) or `non_beneficiary` (an
  // explicit, reasoned, audited human classification). "No decision row" is
  // UNRESOLVED and blocks readiness and submission server-side — it is never
  // read as "not a beneficiary". Before this fix the only column-grain
  // completeness branch started FROM the mapping table, so a column nobody
  // ever reviewed was invisible to it.
  describe('S. every relevant numeric column needs an explicit review decision (independent review finding 1)', () => {
    const decisions = (...items: Array<Record<string, unknown>>) => JSON.stringify(items);
    const readiness = async (revId: string) =>
      (await call(U_EDIT, `SELECT public.phoenix_central_needs_review_readiness($1) AS result`, [revId])) as
        { ready: boolean; blockers: Array<{ blocker: string; detail: string | null }> };
    const submit = (revId: string) =>
      call(U_EDIT, `SELECT public.phoenix_central_needs_submit_revision($1) AS result`, [revId]);
    const statusOf = async (revId: string) =>
      (await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [revId]))[0].status;
    const blockerNames = async (revId: string) => (await blockers(revId)).map((b: any) => b.blocker);
    const latestColumnAudit = async (mappingId: string) => (await admin(
      `SELECT actor_id, payload FROM audit_logs
        WHERE action='central_needs.beneficiary_column.set' AND entity_id=$1
        ORDER BY created_at DESC LIMIT 1`, [mappingId]))[0];

    /** Put the session inside one complete trusted batch, so the batch/session
     *  preconditions hold and only column-review state can remain blocking. */
    async function trustBatch(revId: string, sessionId: string) {
      ordinalSeq += 1;
      const [{ id: batchId }] = await admin(
        `INSERT INTO central_needs_import_batches
           (plan_revision_id, organization_id, container_kind, container_filename, container_sha256,
            storage_locator, accepted_entry_count, parser_identity)
         VALUES ($1,$2,'file','needs.xls',$3,'permanent/s',1,$4::jsonb) RETURNING id`,
        [revId, ORG_OWNER, `${ordinalSeq}`.padStart(64, 'c'), JSON.stringify(PARSER_IDENTITY)]);
      await admin(
        `INSERT INTO central_needs_import_batch_entries
           (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id)
         VALUES ($1,$2,$3,1,$4,$5)`,
        [batchId, revId, ORG_OWNER, `${ordinalSeq}`.padStart(64, 'e'), sessionId]);
    }

    /** One material row: Column A (col 1) and Column B (col 2), both numeric.
     *  A is confirmed as Hospital A and its cell is linked; B is untouched. */
    async function columnALinkedColumnBUntouched() {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 7, entity: 'sheet:0:row:7', columns: [
          { col: 1, value: 40, fieldName: 'Hospital A' },
          { col: 2, value: 60, fieldName: 'Hospital B' }] },
      ]);
      await trustBatch(s.revId, sess.sessionId);
      const cellA = sess.records.get('sheet:0:row:7::1')!;
      const cellB = sess.records.get('sheet:0:row:7::2')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '40', sources: sources([cellA, '40']) });
      return { s, sess, cellA, cellB };
    }

    it('S1 NEGATIVE: A mapped to Hospital A and linked, B numeric with NO review decision → blocker, not ready, submit refused', async () => {
      const { s, sess } = await columnALinkedColumnBUntouched();

      // M212's row-grain branch is already satisfied by Column A's linked cell, and
      // the cell-grain branch cannot see Column B (no mapping row exists for it) —
      // the exact escape the independent review found. The server must still refuse.
      expect.soft(await blockers(s.revId)).toEqual([{
        blocker: 'beneficiary_column_review_required',
        detail: `session=${sess.sessionId} sheet=0 column=2 numeric_cells_on_mapped_rows=1`,
      }]);
      const ready = await readiness(s.revId);
      expect.soft(ready.ready).toBe(false);
      expect.soft(ready.blockers.map((b) => b.blocker)).toContain('beneficiary_column_review_required');

      const r = await refusal(submit(s.revId));
      expect(r).toMatchObject({ code: '23514', message: 'plan_revision_not_ready_for_review' });
      expect(r.detail).toContain('beneficiary_column_review_required');
      expect(await statusOf(s.revId)).toBe('draft');
    });

    it('S2: B explicitly reviewed as NON-BENEFICIARY with a meaningful reason → the unresolved-column blocker clears; actor, time, reason and audit are kept', async () => {
      const { s, sess } = await columnALinkedColumnBUntouched();
      expect(await blockerNames(s.revId)).toContain('beneficiary_column_review_required');

      const reason = 'Column B holds the unit price, not an institution quantity';
      const res = await setColumns(U_EDIT, s.revId, decisions({
        importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 2,
        decision: 'non_beneficiary', beneficiaryOrganizationId: null, previousDecision: null,
      }), reason) as any;
      expect(res.confirmed[0]).toMatchObject({
        decision: 'non_beneficiary', beneficiaryOrganizationId: null, created: true, changed: true,
      });

      expect(await blockers(s.revId)).toEqual([]);
      expect((await readiness(s.revId)).ready).toBe(true);

      const [row] = await admin(
        `SELECT decision, beneficiary_organization_id, mapping_reason, mapped_by, mapped_at
           FROM central_needs_beneficiary_column_mappings WHERE import_session_id=$1 AND column_index=2`,
        [sess.sessionId]);
      expect(row).toMatchObject({
        decision: 'non_beneficiary', beneficiary_organization_id: null, mapping_reason: reason, mapped_by: U_EDIT,
      });
      expect(row.mapped_at).toBeTruthy();
      const log = await latestColumnAudit(res.confirmed[0].mappingId);
      expect(log.actor_id).toBe(U_EDIT);
      expect(log.payload).toMatchObject({
        column_index: 2, previous_decision: null, new_decision: 'non_beneficiary',
        new_beneficiary_organization_id: null, mapping_reason: reason,
      });

      await submit(s.revId);
      expect(await statusOf(s.revId)).toBe('submitted');
    });

    it('S3: B confirmed as Hospital B but NOT linked → beneficiary_column_cell_without_need_line remains; once linked, it clears', async () => {
      const { s, sess, cellB } = await columnALinkedColumnBUntouched();
      await setColumns(U_EDIT, s.revId, decisions({
        importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 2,
        decision: 'beneficiary', beneficiaryOrganizationId: ORG_BENE_B, previousDecision: null,
      }), 'Column B is Hospital B');
      expect(await blockers(s.revId)).toEqual([{
        blocker: 'beneficiary_column_cell_without_need_line',
        detail: `session=${sess.sessionId} sheet=0 column=2 target_entity=sheet:0:row:7 source_record=${cellB}`,
      }]);
      expect((await readiness(s.revId)).ready).toBe(false);

      await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_B, qty: '60', sources: sources([cellB, '60']) });
      expect(await blockers(s.revId)).toEqual([]);
      expect((await readiness(s.revId)).ready).toBe(true);
    });

    it('S4: a non-beneficiary decision is explicit and reasoned — blank reason, a named beneficiary, or an invented state is refused and writes nothing', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10, fieldName: 'مستشفى لم يُسجَّل بعد' }] },
      ]);
      const item = { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1 };

      expect(await refusal(setColumns(U_EDIT, s.revId,
        decisions({ ...item, decision: 'non_beneficiary', beneficiaryOrganizationId: null }), '   ')))
        .toMatchObject({ code: '23514', message: 'mapping_reason_required' });
      expect(await refusal(setColumns(U_EDIT, s.revId,
        decisions({ ...item, decision: 'non_beneficiary', beneficiaryOrganizationId: ORG_BENE_A }), 'not a beneficiary')))
        .toMatchObject({ code: '23514', message: 'beneficiary_column_non_beneficiary_must_not_name_beneficiary' });
      // No "unregistered" / "ignored" escape hatch exists: an institution that is not
      // registered yet stays UNRESOLVED until it exists and is confirmed, or a human
      // explicitly classifies the column as genuinely non-beneficiary.
      for (const invented of ['unregistered', 'ignored', 'unknown', '']) {
        expect(await refusal(setColumns(U_EDIT, s.revId,
          decisions({ ...item, decision: invented, beneficiaryOrganizationId: null }), 'reason')), invented)
          .toMatchObject({ code: '23514', message: 'beneficiary_column_decision_invalid' });
      }
      expect(await refusal(setColumns(U_EDIT, s.revId,
        decisions({ ...item, decision: 'beneficiary', beneficiaryOrganizationId: null }), 'reason')))
        .toMatchObject({ code: '23514', message: 'beneficiary_organization_required' });

      expect(await mappingsOf(sess.sessionId)).toHaveLength(0);
      expect(await blockerNames(s.revId)).toContain('beneficiary_column_review_required');
    });

    it('S5: a cell of a NON-BENEFICIARY column can never feed a need line', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      const cell = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, decisions({
        importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1,
        decision: 'non_beneficiary', beneficiaryOrganizationId: null,
      }), 'serial number column');
      const r = await refusal(setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cell, '10']) }));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_column_not_beneficiary' });
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('S6: changing an explicit decision must state the decision it replaces — a stale belief is refused; a reasoned change is accepted and audited', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [{ row: 1, entity: 'sheet:0:row:1', columns: [{ col: 1, value: 10 }] }]);
      const item = { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1 };
      await setColumns(U_EDIT, s.revId,
        decisions({ ...item, decision: 'non_beneficiary', beneficiaryOrganizationId: null }), 'looked like a total column');

      // Believing the column is still unreviewed cannot overwrite the decision…
      expect(await refusal(setColumns(U_EDIT, s.revId, decisions({
        ...item, decision: 'beneficiary', beneficiaryOrganizationId: ORG_BENE_A,
        previousDecision: null, previousBeneficiaryOrganizationId: null,
      }), 'reason'))).toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_stale' });
      // …nor can believing it is some beneficiary's column.
      expect(await refusal(setColumns(U_EDIT, s.revId, decisions({
        ...item, decision: 'beneficiary', beneficiaryOrganizationId: ORG_BENE_A,
        previousDecision: 'beneficiary', previousBeneficiaryOrganizationId: ORG_BENE_B,
      }), 'reason'))).toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_stale' });
      expect((await admin(
        `SELECT decision FROM central_needs_beneficiary_column_mappings WHERE import_session_id=$1`,
        [sess.sessionId]))[0].decision).toBe('non_beneficiary');

      const reason = 'header re-read: this is the Hospital A quantity';
      const res = await setColumns(U_EDIT, s.revId, decisions({
        ...item, decision: 'beneficiary', beneficiaryOrganizationId: ORG_BENE_A,
        previousDecision: 'non_beneficiary', previousBeneficiaryOrganizationId: null,
      }), reason) as any;
      expect(res.confirmed[0]).toMatchObject({
        decision: 'beneficiary', beneficiaryOrganizationId: ORG_BENE_A, created: false, changed: true,
      });
      expect((await latestColumnAudit(res.confirmed[0].mappingId)).payload).toMatchObject({
        previous_decision: 'non_beneficiary', new_decision: 'beneficiary',
        previous_beneficiary_organization_id: null, new_beneficiary_organization_id: ORG_BENE_A,
        mapping_reason: reason,
      });
    });

    it('S7: a beneficiary column already feeding a need line cannot be re-declared non-beneficiary out from under that line', async () => {
      const { s, sess } = await columnALinkedColumnBUntouched();
      const r = await refusal(setColumns(U_EDIT, s.revId, decisions({
        importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1,
        decision: 'non_beneficiary', beneficiaryOrganizationId: null,
        previousDecision: 'beneficiary', previousBeneficiaryOrganizationId: ORG_BENE_A,
      }), 'reclassify'));
      expect(r).toMatchObject({ code: '23514', message: 'beneficiary_column_mapping_conflict' });
      const [row] = await admin(
        `SELECT decision, beneficiary_organization_id FROM central_needs_beneficiary_column_mappings
          WHERE import_session_id=$1 AND column_index=1`, [sess.sessionId]);
      expect(row).toMatchObject({ decision: 'beneficiary', beneficiary_organization_id: ORG_BENE_A });
    });

    it('S8: relevance is exact — numeric cells on a NOT-APPLICABLE row and a text-only column on a mapped row need no column decision', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [
          { col: 1, value: 10, fieldName: 'Hospital A' },
          { col: 3, value: 'box', fieldName: 'Unit' }] },
        { row: 2, entity: 'sheet:0:row:2', decision: 'not_applicable', columns: [{ col: 2, value: 99, fieldName: 'Old stock' }] },
      ]);
      await trustBatch(s.revId, sess.sessionId);
      const cell = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cell, '10']) });
      expect(await blockers(s.revId)).toEqual([]);
    });

    it('S9: ZERO still counts — a column whose only numeric cell on a mapped row is 0 still needs a decision', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [
          { col: 1, value: 10, fieldName: 'Hospital A' },
          { col: 4, value: 0, fieldName: 'Hospital C' }] },
      ]);
      await trustBatch(s.revId, sess.sessionId);
      const cell = sess.records.get('sheet:0:row:1::1')!;
      await setColumns(U_EDIT, s.revId, cols(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_A }));
      await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE_A, qty: '10', sources: sources([cell, '10']) });
      expect(await blockers(s.revId)).toEqual([{
        blocker: 'beneficiary_column_review_required',
        detail: `session=${sess.sessionId} sheet=0 column=4 numeric_cells_on_mapped_rows=1`,
      }]);
    });

    it('S10: the column summary read reports each column\'s decision and whether it still blocks review', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, 0, [
        { row: 1, entity: 'sheet:0:row:1', columns: [
          { col: 1, value: 10, fieldName: 'Hospital A' },
          { col: 2, value: 3, fieldName: '#' },
          { col: 3, value: 7, fieldName: 'مستشفى لم يُسجَّل بعد' }] },
        { row: 2, entity: 'sheet:0:row:2', decision: 'not_applicable', columns: [{ col: 4, value: 1, fieldName: 'Old' }] },
      ]);
      await setColumns(U_EDIT, s.revId, decisions(
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 1, decision: 'beneficiary', beneficiaryOrganizationId: ORG_BENE_A },
        { importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 2, decision: 'non_beneficiary', beneficiaryOrganizationId: null },
      ), 'reviewed: column 1 is Hospital A, column 2 is the row number');
      const rows = await rig.asUser(U_EDIT, (c: any) => c.query(
        `SELECT column_index, column_decision, beneficiary_organization_id,
                mapped_row_numeric_count::int AS mapped_row_numeric_count, review_required
           FROM public.phoenix_central_needs_list_beneficiary_columns($1) ORDER BY column_index`,
        [s.revId]).then((r: any) => r.rows), { role: 'authenticated', commit: true });
      expect(rows).toEqual([
        { column_index: 1, column_decision: 'beneficiary', beneficiary_organization_id: ORG_BENE_A, mapped_row_numeric_count: 1, review_required: false },
        { column_index: 2, column_decision: 'non_beneficiary', beneficiary_organization_id: null, mapped_row_numeric_count: 1, review_required: false },
        { column_index: 3, column_decision: null, beneficiary_organization_id: null, mapped_row_numeric_count: 1, review_required: true },
        { column_index: 4, column_decision: null, beneficiary_organization_id: null, mapped_row_numeric_count: 0, review_required: false },
      ]);
    });
  });
});
