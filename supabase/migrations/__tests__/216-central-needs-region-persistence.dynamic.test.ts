/**
 * C4 / M216 — DYNAMIC proof of beneficiary-region persistence against a real
 * disposable PostgreSQL with the canonical chain applied in order (buildRig():
 * every migration on disk, so C5/M217 too — whose approval-gate fence is why
 * the approved and submitted lifecycle fixtures go through the real RPCs).
 * C5 §18: the ONE session_replication_role use (RX-8, the lock-free race
 * simulation) is an explicitly labelled policy exception, not a fixture: it
 * proves inside its own transaction that only region/M213 rows change and no
 * revision, need line, link, override, source record or audit row (so no
 * approved state and no approval gate) is touched.
 *
 * Covers the frozen C4 adversarial matrix (R1-R12, RX-1..RX-8, RV-1..RV-11)
 * and the I4 critical list. EVERY refusal asserts three things:
 *   1. the exact SQLSTATE and refusal code;
 *   2. the final database state is byte-identical to the state before the
 *      call (every region version, the revision's M213 rows, need lines and
 *      need-line links);
 *   3. audit delta = zero (the global audit_logs row count is unchanged).
 *
 * Fixtures are seeded through the rig's superuser connection, exactly as the
 * 209-215 dynamic suites do. "Bypass" cases use that superuser connection on
 * purpose: they are the privileged paths the contract's triggers must still
 * bind. Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_OWNER    = '00000000-0000-0000-0000-000000216001';
const ORG_BENE_A   = '00000000-0000-0000-0000-000000216002';
const ORG_BENE_B   = '00000000-0000-0000-0000-000000216003';
const ORG_BENE_C   = '00000000-0000-0000-0000-000000216004';
const ORG_INACTIVE = '00000000-0000-0000-0000-000000216005';
const ORG_OTHER    = '00000000-0000-0000-0000-000000216006';

const U_EDIT    = '00000000-0000-0000-0000-000000216401'; // view/import/edit on owner
const U_APPROVE = '00000000-0000-0000-0000-000000216402'; // view/approve on owner
const U_NOPERM  = '00000000-0000-0000-0000-000000216403'; // eligible role, no key
const U_OTHER   = '00000000-0000-0000-0000-000000216404'; // every key, other owner org
const U_VIEW    = '00000000-0000-0000-0000-000000216405'; // view only on owner

const ITEM_A = '00000000-0000-0000-0000-000000216801';
const ITEM_B = '00000000-0000-0000-0000-000000216802';

const WHOLE = 1048575;
const PARSER_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};
const RENDERED = { ...PARSER_IDENTITY, runtime: 'browser_worker' };

const REGIONS_SQL =
  'SELECT public.phoenix_central_needs_set_beneficiary_regions($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7::jsonb,$8) AS result';
const SET_COLUMNS_SQL = 'SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result';
const SET_LINE_SQL =
  'SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,$11) AS result';
const DELETE_LINE_SQL = 'SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[]) AS result';

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

type Cell = { col: number; value?: number | string; valueType?: 'number' | 'string'; provenance?: Record<string, unknown> };
type Row = { row: number; decision?: 'mapped' | 'not_applicable'; item?: string; cells: Cell[] };
type Change = Record<string, unknown>;

run('C4/M216 beneficiary-region persistence — dynamic (PostgreSQL)', { timeout: 120_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 2001;
  let fileSeq = 0;

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });
  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  /** Superuser transaction (a privileged bypass), committed unless fn throws. */
  const bypass = <T = any>(fn: (c: any) => Promise<T>): Promise<T> => rig.asAdmin(async (c: any) => {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  });

  /** An explicitly held transaction, for deterministic interleavings. */
  const held = async (userId: string | null, role = 'authenticated') => {
    const client = await rig.pool.connect();
    let open = true;
    await client.query('BEGIN');
    if (role !== 'superuser') {
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    }
    const finish = async (verb: 'COMMIT' | 'ROLLBACK') => {
      if (!open) return;
      open = false;
      try { await client.query(verb); } finally { client.release(); }
    };
    return {
      q: (sql: string, params: unknown[] = []) => client.query(sql, params).then((r: any) => r.rows),
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK'),
    };
  };

  const pidWaitingOnLock = async () => {
    for (let i = 0; i < 40; i += 1) {
      const rows = await admin(`SELECT count(*)::int AS n FROM pg_stat_activity
                                 WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if (rows[0].n > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  function provenance(sheetIndex: number, row: number, col: number, fileHash: string, sheetName: string) {
    return {
      fileFingerprintSha256: fileHash,
      originalFilename: `needs-${fileHash.slice(0, 6)}.xlsx`,
      parserVersion: '1.0.0',
      sheetIndex,
      sheetName,
      sheetHidden: 'visible',
      coordinate: { row, col, a1: `${String.fromCharCode(65 + (col % 26))}${row + 1}` },
      extractedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  /** One import session with explicit physical cells. Records keyed `${sheet}:${row}:${col}`. */
  async function addSession(revId: string, sheets: Array<{ sheet: number; name?: string; rows: Row[] }>,
    opts: { status?: 'completed' | 'processing'; org?: string } = {}) {
    fileSeq += 1;
    const org = opts.org ?? ORG_OWNER;
    const fileHash = `${fileSeq}`.padStart(64, 'b');
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [revId, org, `needs-${fileSeq}.xlsx`, fileHash, 2048]);
    const digest = `${fileSeq}`.padStart(64, 'e');
    const status = opts.status ?? 'completed';
    const [{ id: sessionId }] = await admin(
      status === 'completed'
        ? `INSERT INTO central_needs_import_sessions
             (plan_revision_id, organization_id, source_file_id, status, preview_digest, authoritative_digest, parser_identity, completed_at)
           VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`
        : `INSERT INTO central_needs_import_sessions
             (plan_revision_id, organization_id, source_file_id, status, preview_digest, parser_identity)
           VALUES ($1,$2,$3,'processing',$4,$5::jsonb) RETURNING id`,
      [revId, org, fileId, digest, JSON.stringify(PARSER_IDENTITY)]);
    const records = new Map<string, string>();
    let ordinal = 0;
    for (const s of sheets) {
      const name = s.name ?? `Sheet${s.sheet}`;
      for (const row of s.rows) {
        const entity = `sheet:${s.sheet}:row:${row.row}`;
        for (const cell of row.cells) {
          ordinal += 1;
          const value = cell.value ?? 10;
          const valueType = cell.valueType ?? (typeof value === 'number' ? 'number' : 'string');
          const prov = { ...provenance(s.sheet, row.row, cell.col, fileHash, name), ...(cell.provenance ?? {}) };
          const [{ id }] = await admin(
            `INSERT INTO central_needs_source_records
               (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values, source_provenance)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,
            [sessionId, org, ordinal, entity, `col:${cell.col}`,
              JSON.stringify({ value, valueType, isFormula: false, formula: null }), JSON.stringify(prov)]);
          records.set(`${s.sheet}:${row.row}:${cell.col}`, id);
        }
        const decision = row.decision ?? 'mapped';
        await admin(
          `INSERT INTO central_needs_record_mappings
             (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [sessionId, org, entity, decision === 'mapped' ? (row.item ?? ITEM_A) : null, decision,
            decision === 'mapped' ? null : 'out of scope']);
      }
    }
    return { sessionId, records, rec: (sheet: number, row: number, col: number) => records.get(`${sheet}:${row}:${col}`)! };
  }

  /** Rows `rows` each carrying numeric cells in `cols`, on sheet 0. */
  const grid = (rows: number[], cols: number[], item = ITEM_A): Row[] =>
    rows.map((row) => ({ row, item, cells: cols.map((col) => ({ col })) }));

  async function scenario(org = ORG_OWNER) {
    const y = year++;
    const [{ id: planId }] = await admin(
      `INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [org, y]);
    const [{ id: revId }] = await admin(
      `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
         VALUES ($1,$2,1,'draft') RETURNING id`, [planId, org]);
    return { planId, revId, year: y };
  }

  const setRegions = (userId: string | null, o: {
    rev: string; session: string | null; sheet?: number | null; identity?: unknown; sheetName?: string | null;
    expected: string[] | null; changes: unknown; reason?: string | null;
  }, role = 'authenticated') => call(userId, REGIONS_SQL, [
    o.rev, o.session, o.sheet === undefined ? 0 : o.sheet,
    o.identity === undefined ? JSON.stringify(RENDERED) : (o.identity === null ? null : JSON.stringify(o.identity)),
    o.sheetName === undefined ? 'Sheet0' : o.sheetName,
    o.expected, o.changes === null ? null : JSON.stringify(o.changes), o.reason === undefined ? 'declared by reviewer' : o.reason,
  ], role);

  const add = (rowStart: number, rowEnd: number, columnStart: number, columnEnd: number,
    beneficiary: string | null = ORG_BENE_A, decision = beneficiary ? 'beneficiary' : 'non_beneficiary'): Change =>
    ({ op: 'add', rowStart, rowEnd, columnStart, columnEnd, decision, beneficiaryOrganizationId: beneficiary });
  const replace = (versionId: string, rowStart: number, rowEnd: number, columnStart: number, columnEnd: number,
    beneficiary: string | null = ORG_BENE_A, decision = beneficiary ? 'beneficiary' : 'non_beneficiary'): Change =>
    ({ op: 'replace', versionId, rowStart, rowEnd, columnStart, columnEnd, decision, beneficiaryOrganizationId: beneficiary });
  const remove = (versionId: string): Change => ({ op: 'remove', versionId });

  const activeOf = (sessionId: string, sheet = 0) => admin(
    `SELECT version_id, region_id, version_no, supersedes_version_id, row_start, row_end, column_start, column_end,
            decision, beneficiary_organization_id, decision_reason, decided_by
       FROM central_needs_beneficiary_regions
      WHERE import_session_id=$1 AND sheet_index=$2 AND retired_at IS NULL
      ORDER BY row_start, column_start, version_id`, [sessionId, sheet]);
  const versionsOf = (sessionId: string) => admin(
    `SELECT * FROM central_needs_beneficiary_regions WHERE import_session_id=$1 ORDER BY region_id, version_no`, [sessionId]);
  const activeIds = async (sessionId: string, sheet = 0) => (await activeOf(sessionId, sheet)).map((v: any) => v.version_id);
  const blockers = (revId: string) =>
    admin(`SELECT blocker, detail FROM public._phoenix_central_needs_review_blockers_v1($1)`, [revId]);
  const blockerCodes = async (revId: string) => (await blockers(revId)).map((b: any) => b.blocker);
  const auditCount = async (actionPrefix = '') =>
    (await admin(`SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE $1`, [`${actionPrefix}%`]))[0].n;

  const setColumns = (userId: string, revId: string, items: unknown[], reason = 'confirm column') =>
    call(userId, SET_COLUMNS_SQL, [revId, JSON.stringify(items), reason]);
  const m213Of = (sessionId: string) => admin(
    `SELECT id, sheet_index, column_index, decision, beneficiary_organization_id,
            to_jsonb(mapped_at) #>> '{}' AS mapped_at
       FROM central_needs_beneficiary_column_mappings WHERE import_session_id=$1 ORDER BY sheet_index, column_index`,
    [sessionId]);
  /** mapped_at exactly as list_beneficiary_columns returns it (the JSON rendering PostgREST sends). */
  const listedColumn = async (revId: string, sessionId: string, col: number, sheet = 0) => {
    const rows = await rig.asUser(U_EDIT, (c: any) => c.query(
      `SELECT mapping_id, column_decision, beneficiary_organization_id, to_jsonb(mapped_at) #>> '{}' AS mapped_at,
              review_required
         FROM public.phoenix_central_needs_list_beneficiary_columns($1)
        WHERE import_session_id=$2 AND sheet_index=$3 AND column_index=$4`, [revId, sessionId, sheet, col])
      .then((r: any) => r.rows));
    return rows[0];
  };
  const convert = (m: any, col: number, extra: Record<string, unknown> = {}): Change => ({
    op: 'convert_column', columnIndex: col, expectedMappingId: m.mapping_id ?? m.id,
    previousDecision: m.column_decision ?? m.decision,
    previousBeneficiaryOrganizationId: m.beneficiary_organization_id ?? null,
    previousMappedAt: m.mapped_at, ...extra,
  });

  const sources = (...items: Array<[string, string | number]>) =>
    JSON.stringify(items.map(([id, qty]) => ({ sourceRecordId: id, designatedQuantity: String(qty), appliedOverrideId: null })));
  const setLine = (revId: string, o: { beneficiary: string; qty: number; sources: string; expected?: string[]; item?: string }) =>
    call(U_EDIT, SET_LINE_SQL, [revId, o.beneficiary, o.item ?? ITEM_A, o.qty, 'designated by reviewer',
      o.sources, o.expected ?? [], 'box', 'canonical', null, null]);
  const deleteLine = (lineId: string, expected: string[]) =>
    call(U_EDIT, DELETE_LINE_SQL, [lineId, 'wrong geometry, re-designate after conversion', expected]);

  /**
   * C5 §16/§18 (217): on the forward chain a direct UPDATE into 'approved' is
   * refused by the approval-gate fence (23514 central_needs_approval_gate_missing),
   * and a revision set 'submitted' directly must never go on to be approved. A
   * lifecycle fixture therefore reaches SUBMITTED only canonically: the given
   * region-covered cells (10 each) are designated to ONE need line of the
   * region's beneficiary, the completed session is registered in a trusted
   * batch, readiness is proven empty, and the real submit RPC runs (U_EDIT).
   */
  async function submitCanonically(revId: string, sessionId: string, cells: string[], beneficiary: string) {
    await setLine(revId, {
      beneficiary, qty: 10 * cells.length, sources: sources(...cells.map((id): [string, number] => [id, 10])),
    });
    const hex = sessionId.replace(/-/g, '');
    const [{ id: batchId }] = await admin(
      `INSERT INTO central_needs_import_batches
         (plan_revision_id, organization_id, container_kind, container_filename, container_sha256,
          storage_locator, accepted_entry_count, parser_identity)
       VALUES ($1,$2,'file','needs.xlsx',$3,'permanent/x',1,$4::jsonb) RETURNING id`,
      [revId, ORG_OWNER, hex.padStart(64, 'c'), JSON.stringify(PARSER_IDENTITY)]);
    await admin(
      `INSERT INTO central_needs_import_batch_entries
         (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id)
       VALUES ($1,$2,$3,1,$4,$5)`,
      [batchId, revId, ORG_OWNER, hex.padStart(64, 'e'), sessionId]);
    expect(await blockers(revId)).toEqual([]);
    const out = await call(U_EDIT, 'SELECT public.phoenix_central_needs_submit_revision($1) AS result', [revId]);
    expect(out.status).toBe('submitted');
  }

  /** submitCanonically, then the real approve RPC (U_APPROVE), which writes its own approval gate. */
  async function approveCanonically(revId: string, sessionId: string, cells: string[], beneficiary: string) {
    await submitCanonically(revId, sessionId, cells, beneficiary);
    const out = await call(U_APPROVE, 'SELECT public.phoenix_central_needs_approve_revision($1) AS result', [revId]);
    expect(out).toMatchObject({ ok: true, status: 'approved' });
  }

  /** Everything a region refusal must leave untouched, plus the global audit count. */
  async function snapshot(revId: string) {
    const [row] = await admin(`
      SELECT
        (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.version_id), '[]'::jsonb)
           FROM central_needs_beneficiary_regions v WHERE v.plan_revision_id = $1) AS regions,
        (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb)
           FROM central_needs_beneficiary_column_mappings m WHERE m.plan_revision_id = $1) AS m213,
        (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id), '[]'::jsonb)
           FROM central_needs_need_lines n WHERE n.plan_revision_id = $1) AS lines,
        (SELECT coalesce(jsonb_agg(to_jsonb(ls) ORDER BY ls.source_record_id), '[]'::jsonb)
           FROM central_needs_need_line_sources ls
           JOIN central_needs_need_lines n ON n.id = ls.need_line_id WHERE n.plan_revision_id = $1) AS links,
        (SELECT count(*) FROM central_needs_beneficiary_regions) AS all_regions,
        (SELECT count(*) FROM audit_logs) AS audit`, [revId]);
    return row;
  }

  /** Asserts exact code + SQLSTATE, unchanged final state and audit delta = 0. */
  async function refused(revId: string, action: () => Promise<unknown>, message: string, sqlstate = '23514') {
    const before = await snapshot(revId);
    const r = await refusal(action());
    expect(r.message).toBe(message);
    expect(r.code).toBe(sqlstate);
    expect(await snapshot(revId)).toEqual(before);
    return r;
  }

  /** A one-session scenario with numeric cells rows 1..40 x columns 1..6 on sheet 0. */
  async function standard(rows = Array.from({ length: 40 }, (_, i) => i + 1), cols = [1, 2, 3, 4, 5, 6]) {
    const s = await scenario();
    const sess = await addSession(s.revId, [{ sheet: 0, rows: grid(rows, cols) }]);
    return { ...s, ...sess };
  }

  beforeAll(async () => {
    rig = await buildRig();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'C4 Pharmacy Dept','دائرة صحة','p216-owner','pharmacy_department_authority',NULL),
        ($2,'Hospital A','مستشفى أ','p216-bene-a','care_institution','hospital'),
        ($3,'Hospital B','مستشفى ب','p216-bene-b','care_institution','hospital'),
        ($4,'Hospital C','مستشفى ج','p216-bene-c','care_institution','hospital'),
        ($5,'Inactive Institution','مؤسسة غير نشطة','p216-inactive','care_institution','hospital'),
        ($6,'Other Owner Org','جهة أخرى','p216-other','pharmacy_department_authority',NULL)
        ON CONFLICT (id) DO NOTHING`,
        [ORG_OWNER, ORG_BENE_A, ORG_BENE_B, ORG_BENE_C, ORG_INACTIVE, ORG_OTHER]);
      await c.query(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG_INACTIVE]);
      await c.query(`INSERT INTO central_items (id, name, name_ar, unit) VALUES
        ($1,'Item A','مادة أ','box'), ($2,'Item B','مادة ب','box') ON CONFLICT (id) DO NOTHING`, [ITEM_A, ITEM_B]);
      await c.query(`INSERT INTO auth.users (id, email) VALUES
        ($1,'p216-edit@rig'),($2,'p216-approve@rig'),($3,'p216-noperm@rig'),($4,'p216-other@rig'),($5,'p216-view@rig')
        ON CONFLICT (id) DO NOTHING`, [U_EDIT, U_APPROVE, U_NOPERM, U_OTHER, U_VIEW]);
      for (const [u, org] of [[U_EDIT, ORG_OWNER], [U_APPROVE, ORG_OWNER], [U_NOPERM, ORG_OWNER], [U_OTHER, ORG_OTHER], [U_VIEW, ORG_OWNER]]) {
        await c.query(`UPDATE profiles SET role='central_warehouse_manager', status='active', organization_id=$2 WHERE id=$1`, [u, org]);
      }
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES
        ($1,'central_needs.view',true),($1,'central_needs.import',true),($1,'central_needs.edit',true),
        ($2,'central_needs.view',true),($2,'central_needs.approve',true),
        ($3,'central_needs.view',true),($3,'central_needs.edit',true),($3,'central_needs.import',true),
        ($4,'central_needs.view',true)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [U_EDIT, U_APPROVE, U_OTHER, U_VIEW]);
    });
  }, 600_000);

  afterAll(async () => { await rig?.end(); });

  // ===========================================================================
  // R1 / R2 / R3 / R4 / R5 — grain, stacking, side by side, overlap policy
  // ===========================================================================
  describe('R1-R5 grain and overlap policy', () => {
    it('R1 a whole column is ONE region version 1 of a new lineage, with one add audit row', async () => {
      const s = await standard();
      const audit0 = await auditCount('central_needs.beneficiary_region.');
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(0, WHOLE, 3, 3)] });
      expect(out.ok).toBe(true);
      const [v] = await activeOf(s.sessionId);
      expect(v).toMatchObject({ version_no: 1, supersedes_version_id: null, row_start: 0, row_end: WHOLE,
        column_start: 3, column_end: 3, decision: 'beneficiary', beneficiary_organization_id: ORG_BENE_A,
        decision_reason: 'declared by reviewer', decided_by: U_EDIT });
      expect(out.active_versions.map((a: any) => a.version_id)).toEqual([v.version_id]);
      expect(out.changes).toEqual([{ op: 'add', regionId: v.region_id, previousVersionId: null, newVersionId: v.version_id }]);
      expect(await auditCount('central_needs.beneficiary_region.')).toBe(audit0 + 1);
      const [row] = await admin(`SELECT * FROM audit_logs WHERE action='central_needs.beneficiary_region.add' AND entity_id=$1`, [v.region_id]);
      expect(row).toMatchObject({ organization_id: ORG_OWNER, actor_id: U_EDIT, actor_role: 'central_warehouse_manager',
        entity_type: 'central_needs_beneficiary_region', entity_label: null });
      expect(row.payload).toMatchObject({ plan_revision_id: s.revId, import_session_id: s.sessionId, sheet_index: 0,
        operation_batch_id: out.operation_batch_id, expected_version_ids: [], region_id: v.region_id,
        previous_version_id: null, new_version_id: v.version_id, previous_bounds: null,
        new_bounds: { rowStart: 0, rowEnd: WHOLE, columnStart: 3, columnEnd: 3 }, new_decision: 'beneficiary',
        new_beneficiary_organization_id: ORG_BENE_A, reason: 'declared by reviewer' });
    });

    it('R1 a region over an M213-decided column is refused (no conversion) — zero mutation, zero audit', async () => {
      const s = await standard();
      await setColumns(U_EDIT, s.revId, [{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 3, beneficiaryOrganizationId: ORG_BENE_A }]);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 10, 2, 4)] }),
        'beneficiary_region_column_already_decided');
    });

    it('R1/T4 an M213 decision on a region-governed column is refused at COMMIT (grain conflict)', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 3, 3)] });
      await refused(s.revId, () => setColumns(U_EDIT, s.revId,
        [{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 3, beneficiaryOrganizationId: ORG_BENE_A }]),
      'beneficiary_decision_grain_conflict');
    });

    it('R2 stacked A/B regions in one column: pairing enforced per cell, gap blocks as uncovered, branch 13 silent', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [add(1, 20, 2, 2, ORG_BENE_A), add(22, 40, 2, 2, ORG_BENE_B)] });
      const a = await setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 5, 2), 10]) });
      expect(a.ok).toBe(true);
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 20,
        sources: sources([s.rec(0, 30, 2), 10]), expected: [s.rec(0, 5, 2)] }), 'beneficiary_region_mapping_conflict');
      const b = await setLine(s.revId, { beneficiary: ORG_BENE_B, qty: 10, sources: sources([s.rec(0, 30, 2), 10]) });
      expect(b.ok).toBe(true);
      const bl = await blockers(s.revId);
      const uncovered = bl.filter((x: any) => x.blocker === 'beneficiary_region_cell_uncovered');
      expect(uncovered.map((x: any) => x.detail)).toEqual([
        `session=${s.sessionId} sheet=0 column=2 uncovered_numeric_cells_on_mapped_rows=1 first_uncovered_row=21`]);
      expect(bl.some((x: any) => x.blocker === 'beneficiary_column_review_required' && x.detail.includes(' column=2 '))).toBe(false);
      const review = await listedColumn(s.revId, s.sessionId, 2);
      expect(review.review_required).toBe(false);
    });

    it('R3 side-by-side disjoint regions are accepted; a column overlap is refused', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [add(1, 40, 2, 2, ORG_BENE_A), add(1, 40, 3, 3, ORG_BENE_B)] });
      const ids = await activeIds(s.sessionId);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [add(1, 40, 3, 4, ORG_BENE_C)] }), 'beneficiary_region_overlap');
    });

    it('R4 one beneficiary, two disjoint regions: both accepted, cells consolidate into ONE line; same-beneficiary overlap refused', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [add(1, 20, 2, 2, ORG_BENE_A), add(1, 20, 5, 6, ORG_BENE_A)] });
      const line = await setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 20,
        sources: sources([s.rec(0, 3, 2), 10], [s.rec(0, 3, 6), 10]) });
      expect(line.source_link_count).toBe(2);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]))[0].n).toBe(1);
      const ids = await activeIds(s.sessionId);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [add(15, 25, 2, 2, ORG_BENE_A)] }), 'beneficiary_region_overlap');
    });

    it('R5 every overlap form is refused, whatever beneficiary or decision; adjacency is allowed', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(10, 20, 2, 3, ORG_BENE_A)] });
      const ids = await activeIds(s.sessionId);
      const forms: Array<[string, Change[]]> = [
        ['partial corner', [add(15, 25, 3, 4, ORG_BENE_B)]],
        ['contained', [add(12, 14, 2, 2, ORG_BENE_B)]],
        ['containing', [add(5, 30, 1, 5, ORG_BENE_B)]],
        ['single shared cell', [add(20, 20, 3, 3, ORG_BENE_B)]],
        ['whole column vs partial', [add(0, WHOLE, 3, 3, ORG_BENE_B)]],
        ['beneficiary vs non_beneficiary', [add(18, 22, 2, 2, null)]],
        ['same beneficiary', [add(18, 22, 2, 2, ORG_BENE_A)]],
        ['two co-submitted new regions overlapping each other', [add(30, 35, 4, 4, ORG_BENE_B), add(33, 38, 4, 5, ORG_BENE_C)]],
      ];
      for (const [label, changes] of forms) {
        const r = await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids, changes }),
          'beneficiary_region_overlap');
        expect(r.detail, label).toContain(`session=${s.sessionId} sheet=0`);
      }
      // Adjacent on every side is allowed (touching edges share no cell).
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [add(21, 30, 2, 3, ORG_BENE_B), add(1, 9, 2, 3, ORG_BENE_C), add(10, 20, 4, 4, null), add(10, 20, 1, 1, ORG_BENE_B)] });
      expect(out.active_versions).toHaveLength(5);
    });

    it('exact duplicates are refused before any write: equal to a surviving ACTIVE version, and two equal adds in one call', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 10, 2, 2, ORG_BENE_A)] });
      const ids = await activeIds(s.sessionId);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [add(1, 10, 2, 2, ORG_BENE_B)] }), 'beneficiary_region_duplicate');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [add(20, 25, 4, 4, ORG_BENE_B), add(20, 25, 4, 4, ORG_BENE_C)] }), 'beneficiary_region_duplicate');
    });
  });

  // ===========================================================================
  // RV-1 / RV-2 / RV-3 / RX-5 — versions, fences, concurrency, retry
  // ===========================================================================
  describe('RV-1..RV-3, RV-9, RX-5 versioning and stale fences', () => {
    it('RV-1 same-geometry replace: target stamped, then version 2 of the SAME region; history kept; one replace audit row', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      const audit0 = await auditCount('central_needs.beneficiary_region.');
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id],
        changes: [replace(v1.version_id, 1, 20, 2, 2, null)], reason: 'these are not beneficiary cells' });
      const [v2] = await activeOf(s.sessionId);
      expect(v2).toMatchObject({ region_id: v1.region_id, version_no: 2, supersedes_version_id: v1.version_id,
        decision: 'non_beneficiary', beneficiary_organization_id: null, decision_reason: 'these are not beneficiary cells' });
      const [old] = await admin(`SELECT * FROM central_needs_beneficiary_regions WHERE version_id=$1`, [v1.version_id]);
      expect(old).toMatchObject({ retirement_kind: 'replaced', retired_by: U_EDIT, retirement_reason: 'these are not beneficiary cells',
        decision: 'beneficiary', beneficiary_organization_id: ORG_BENE_A, decision_reason: 'declared by reviewer' });
      expect(old.retired_at).not.toBeNull();
      expect(out.changes).toEqual([{ op: 'replace', regionId: v1.region_id, previousVersionId: v1.version_id, newVersionId: v2.version_id }]);
      expect(await auditCount('central_needs.beneficiary_region.')).toBe(audit0 + 1);
      const [row] = await admin(`SELECT payload FROM audit_logs WHERE action='central_needs.beneficiary_region.replace' AND entity_id=$1`, [v1.region_id]);
      expect(row.payload).toMatchObject({ previous_version_id: v1.version_id, new_version_id: v2.version_id,
        previous_decision: 'beneficiary', previous_beneficiary_organization_id: ORG_BENE_A,
        new_decision: 'non_beneficiary', new_beneficiary_organization_id: null,
        previous_bounds: { rowStart: 1, rowEnd: 20, columnStart: 2, columnEnd: 2 } });
    });

    it('RV-1 a replace to IDENTICAL content is refused as a duplicate', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id],
        changes: [replace(v1.version_id, 1, 20, 2, 2, ORG_BENE_A)] }), 'beneficiary_region_duplicate');
    });

    it('repetition rule: remove+add of the same bounds in ONE call is refused; across two calls it is a new lineage', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id],
        changes: [remove(v1.version_id), add(1, 20, 2, 2, ORG_BENE_B)] }), 'beneficiary_region_duplicate');
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id], changes: [remove(v1.version_id)] });
      expect(await activeOf(s.sessionId)).toHaveLength(0);
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 2, 2, ORG_BENE_B)] });
      const [again] = await activeOf(s.sessionId);
      expect(again.region_id).not.toBe(v1.region_id);
      expect(again.version_no).toBe(1);
      const history = await versionsOf(s.sessionId);
      expect(history).toHaveLength(2);
      expect(history.find((h: any) => h.version_id === v1.version_id)).toMatchObject({ retirement_kind: 'removed' });
    });

    it('repetition rule: replace(v1: B->B2)+add(B), remove(v1)+replace(v2->B) and swapped replaces are refused', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [add(1, 10, 2, 2, ORG_BENE_A), add(11, 20, 2, 2, ORG_BENE_B)] });
      const [v1, v2] = await activeOf(s.sessionId);
      const ids = [v1.version_id, v2.version_id];
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [replace(v1.version_id, 1, 5, 2, 2, ORG_BENE_A), add(1, 10, 2, 2, ORG_BENE_C)] }), 'beneficiary_region_duplicate');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [remove(v1.version_id), replace(v2.version_id, 1, 10, 2, 2, ORG_BENE_B)] }), 'beneficiary_region_duplicate');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [replace(v1.version_id, 11, 20, 2, 2, ORG_BENE_A), replace(v2.version_id, 1, 10, 2, 2, ORG_BENE_B)] }),
      'beneficiary_region_duplicate');
      // A replace whose NEW bounds equal another surviving ACTIVE version.
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [replace(v1.version_id, 11, 20, 2, 2, ORG_BENE_A)] }), 'beneficiary_region_duplicate');
    });

    it('a split whose pieces overlap only transiently is legal in one call (final state judged)', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 40, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id],
        changes: [add(21, 40, 2, 2, ORG_BENE_B), replace(v1.version_id, 1, 20, 2, 2, ORG_BENE_A)] });
      expect(out.active_versions).toHaveLength(2);
      const batch = await admin(`SELECT count(*)::int n FROM audit_logs WHERE payload->>'operation_batch_id'=$1`, [out.operation_batch_id]);
      expect(batch[0].n).toBe(2);
    });

    it('RV-2 a stale ACTIVE-set fence is refused; a retired target under a current fence is unknown', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [add(1, 10, 2, 2, ORG_BENE_A), add(11, 20, 2, 2, ORG_BENE_B)] });
      const [v1, v2] = await activeOf(s.sessionId);
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id, v2.version_id],
        changes: [replace(v2.version_id, 11, 20, 2, 2, ORG_BENE_C)] });
      const [, v3] = await activeOf(s.sessionId);
      const r = await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId,
        expected: [v1.version_id, v2.version_id], changes: [add(30, 35, 3, 3, ORG_BENE_A)] }), 'beneficiary_region_stale');
      expect(r.detail).toContain('expected_active=2 current_active=2');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId,
        expected: [v1.version_id, v3.version_id], changes: [remove(v2.version_id)] }), 'beneficiary_region_unknown');
      // Empty-set belief while regions exist is stale too.
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId,
        expected: [], changes: [add(30, 35, 3, 3, ORG_BENE_A)] }), 'beneficiary_region_stale');
    });

    it('RV-3 concurrent replace of one version: serialized by the revision lock; the loser is stale; the lineage never forks', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      const a = await held(U_EDIT);
      const b = await held(U_EDIT);
      try {
        await a.q(REGIONS_SQL, [s.revId, s.sessionId, 0, JSON.stringify(RENDERED), 'Sheet0', [v1.version_id],
          JSON.stringify([replace(v1.version_id, 1, 20, 2, 2, ORG_BENE_B)]), 'tab A']);
        const bCall = b.q(REGIONS_SQL, [s.revId, s.sessionId, 0, JSON.stringify(RENDERED), 'Sheet0', [v1.version_id],
          JSON.stringify([replace(v1.version_id, 1, 20, 2, 2, ORG_BENE_C)]), 'tab B']).then(() => null, (e: any) => e);
        expect(await pidWaitingOnLock()).toBe(true);
        await a.commit();
        const auditAfterWinner = await auditCount();
        const err = await bCall;
        expect(err).toMatchObject({ code: '23514', message: 'beneficiary_region_stale' });
        await b.rollback();
        expect(await auditCount()).toBe(auditAfterWinner);
      } finally {
        await a.rollback();
        await b.rollback();
      }
      const history = await versionsOf(s.sessionId);
      expect(history).toHaveLength(2);
      const [active] = await activeOf(s.sessionId);
      expect(active).toMatchObject({ region_id: v1.region_id, version_no: 2, beneficiary_organization_id: ORG_BENE_B });
    });

    it('RX-5 a network retry of a committed call is refused as stale and double-writes nothing', async () => {
      const s = await standard();
      const req = { rev: s.revId, session: s.sessionId, expected: [] as string[], changes: [add(1, 20, 2, 2, ORG_BENE_A)] };
      await setRegions(U_EDIT, req);
      await refused(s.revId, () => setRegions(U_EDIT, req), 'beneficiary_region_stale');
      expect(await activeOf(s.sessionId)).toHaveLength(1);
    });

    it('RV-9 / R7 reload: the working view is ACTIVE versions only, readable under RLS by an authorized reader only', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id],
        changes: [replace(v1.version_id, 1, 25, 2, 2, ORG_BENE_A)] });
      const read = (u: string) => rig.asUser(u, (c: any) => c.query(
        `SELECT version_id, version_no FROM central_needs_beneficiary_regions
          WHERE plan_revision_id=$1 AND import_session_id=$2 AND sheet_index=0 AND retired_at IS NULL
          ORDER BY import_session_id, sheet_index, row_start, column_start, version_id`, [s.revId, s.sessionId])
        .then((r: any) => r.rows));
      const mine = await read(U_VIEW);
      expect(mine).toHaveLength(1);
      expect(mine[0].version_no).toBe(2);
      expect(await read(U_NOPERM)).toHaveLength(0);
      expect(await read(U_OTHER)).toHaveLength(0);
      const history = await rig.asUser(U_VIEW, (c: any) => c.query(
        `SELECT version_no, retirement_kind FROM central_needs_beneficiary_regions WHERE import_session_id=$1 ORDER BY region_id, version_no`,
        [s.sessionId]).then((r: any) => r.rows));
      expect(history).toEqual([{ version_no: 1, retirement_kind: 'replaced' }, { version_no: 2, retirement_kind: null }]);
    });
  });

  // ===========================================================================
  // Guards, shape, session, witnesses (steps 1-10)
  // ===========================================================================
  describe('steps 1-10 guards, shape, session and witnesses', () => {
    it('authentication, role class, capability and organization are enforced before anything else', async () => {
      const s = await standard();
      const base = { rev: s.revId, session: s.sessionId, expected: [] as string[], changes: [add(1, 20, 2, 2)] };
      await refused(s.revId, () => setRegions(null, base), 'not_authenticated', '28000');
      await refused(s.revId, () => setRegions(U_NOPERM, base), 'forbidden_central_needs', '42501');
      await refused(s.revId, () => setRegions(U_OTHER, base), 'forbidden_central_needs', '42501');
      await refused(s.revId, () => setRegions(U_VIEW, base), 'forbidden_central_needs', '42501');
      const anon = await refusal(setRegions(null, base, 'anon'));
      expect(anon.code).toBe('42501');
      const direct = await refusal(rig.asUser(U_EDIT, (c: any) => c.query(
        `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision,
           beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,1,2,2,2,'beneficiary',$4,'direct')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A])));
      expect(direct.code).toBe('42501');
    });

    it('non-draft revision is refused (plan_revision_not_editable); a non-newest draft is ambiguous', async () => {
      const s = await standard();
      await admin(`UPDATE central_needs_plan_revisions SET status='submitted' WHERE id=$1`, [s.revId]);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 2, 2, 2)] }),
        'plan_revision_not_editable');
      const t = await standard();
      await admin(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
                   VALUES ($1,$2,2,'rejected')`, [t.planId, ORG_OWNER]);
      await refused(t.revId, () => setRegions(U_EDIT, { rev: t.revId, session: t.sessionId, expected: [], changes: [add(1, 2, 2, 2)] }),
        'central_needs_lifecycle_state_ambiguous');
    });

    it('a whitespace-only reason is refused', async () => {
      const s = await standard();
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [add(1, 2, 2, 2)], reason: ' \t ​ ' }), 'mapping_reason_required');
    });

    it('expected ids: missing, null element or duplicate is refused', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 2, 2, 2)] });
      const [v] = await activeOf(s.sessionId);
      for (const expected of [null, [v.version_id, null], [v.version_id, v.version_id]] as any[]) {
        await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected, changes: [add(5, 6, 2, 2)] }),
          'beneficiary_region_expected_ids_required');
      }
    });

    it('malformed operations and coordinates are refused with the exact code', async () => {
      const s = await standard();
      const shape: Array<[unknown, string]> = [
        [[], 'beneficiary_region_operation_invalid'],
        [null, 'beneficiary_region_operation_invalid'],
        [[{ op: 'merge' }], 'beneficiary_region_operation_invalid'],
        [[{ ...add(1, 2, 2, 2), rowStart: '1' }], 'beneficiary_region_operation_invalid'],
        [[{ ...add(1, 2, 2, 2), rowEnd: 2.5 }], 'beneficiary_region_operation_invalid'],
        [[{ ...add(1, 2, 2, 2), columnStart: null }], 'beneficiary_region_operation_invalid'],
        [[{ ...add(1, 2, 2, 2), beneficiaryOrganizationId: 'not-a-uuid' }], 'beneficiary_region_operation_invalid'],
        [[{ op: 'remove', versionId: 'nope' }], 'beneficiary_region_operation_invalid'],
        [[add(-1, 2, 2, 2)], 'beneficiary_region_bounds_invalid'],
        [[add(5, 2, 2, 2)], 'beneficiary_region_bounds_invalid'],
        [[add(1, WHOLE + 1, 2, 2)], 'beneficiary_region_bounds_invalid'],
        [[add(1, 2, 3, 2)], 'beneficiary_region_bounds_invalid'],
        [[add(1, 2, 2, 16384)], 'beneficiary_region_bounds_invalid'],
        [[{ ...add(1, 2, 2, 2), decision: undefined }], 'beneficiary_region_decision_invalid'],
        [[{ ...add(1, 2, 2, 2), decision: 'ignored' }], 'beneficiary_region_decision_invalid'],
        [[{ ...add(1, 2, 2, 2), beneficiaryOrganizationId: null, decision: 'beneficiary' }], 'beneficiary_region_beneficiary_required'],
        [[{ ...add(1, 2, 2, 2, ORG_BENE_A), decision: 'non_beneficiary' }], 'beneficiary_region_non_beneficiary_must_not_name_beneficiary'],
        [[add(1, 2, 2, 2, ORG_INACTIVE)], 'beneficiary_organization_not_active'],
        [[add(1, 2, 2, 2, ORG_OWNER)], 'beneficiary_must_be_care_institution'],
        [[add(100, 120, 2, 2)], 'beneficiary_region_no_matching_evidence'],
        [[add(1, 2, 40, 45)], 'beneficiary_region_no_matching_evidence'],
      ];
      for (const [changes, code] of shape) {
        const r = await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes }),
          code, code === 'beneficiary_region_no_matching_evidence' ? '23503' : '23514');
        expect(r.message, JSON.stringify(changes)).toBe(code);
      }
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [add(1, 2, 2, 2, '00000000-0000-0000-0000-00000021699f')] }), 'beneficiary_organization_not_found', '23503');
      // A remove naming a version twice.
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 2, 2, 2)] });
      const ids = await activeIds(s.sessionId);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: ids,
        changes: [remove(ids[0]), remove(ids[0])] }), 'beneficiary_region_operation_invalid');
    });

    it('RX-6 foreign session, incomplete session and invalid sheet index are refused', async () => {
      const s = await standard();
      const other = await standard();
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: other.sessionId, expected: [], changes: [add(1, 2, 2, 2)] }),
        'beneficiary_region_session_not_in_revision');
      const open = await addSession(s.revId, [{ sheet: 0, rows: grid([1, 2], [2]) }], { status: 'processing' });
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: open.sessionId, expected: [], changes: [add(1, 2, 2, 2)] }),
        'beneficiary_region_session_not_completed');
      for (const sheet of [-1, 1.5, 7, null]) {
        await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, sheet, expected: [], changes: [add(1, 2, 2, 2)] }),
          'beneficiary_region_sheet_index_invalid');
      }
    });

    it('R12 parser-identity and sheet-name witnesses refuse any disagreement and are never persisted', async () => {
      const s = await standard();
      const base = { rev: s.revId, session: s.sessionId, expected: [] as string[], changes: [add(1, 2, 2, 2)] };
      for (const identity of [null, {}, { ...RENDERED, sheetjsVersion: '0.20.2' },
        { ...RENDERED, sheetjsTarballSha256: 'f'.repeat(64) }, { ...RENDERED, contractVersion: '1.1.0' }]) {
        await refused(s.revId, () => setRegions(U_EDIT, { ...base, identity }), 'beneficiary_region_parser_identity_mismatch');
      }
      for (const sheetName of ['Sheet1', 'sheet0', 'Sheet0 ', null]) {
        await refused(s.revId, () => setRegions(U_EDIT, { ...base, sheetName }), 'beneficiary_region_sheet_mismatch');
      }
      const cols = (await admin(`SELECT column_name FROM information_schema.columns
                                  WHERE table_name='central_needs_beneficiary_regions'`)).map((c: any) => c.column_name);
      expect(cols.some((c: string) => /parser|sheet_name|anchor|role|quantity|unit|material|warehouse/.test(c))).toBe(false);
    });
  });

  // ===========================================================================
  // RX-4 / RV-4 — linked-cell invariant at write and at COMMIT
  // ===========================================================================
  describe('RX-4 / RV-4 linked-cell invariant', () => {
    async function linked() {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(0, WHOLE, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      const line = await setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 5, 2), 10]) });
      return { ...s, v1, line };
    }

    it('RV-4 removing the LAST region beneath a linked cell is refused at write', async () => {
      const s = await linked();
      const r = await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [s.v1.version_id],
        changes: [remove(s.v1.version_id)] }), 'beneficiary_region_in_use');
      expect(r.detail).toContain(`source_record=${s.rec(0, 5, 2)}`);
      expect(r.detail).toContain('failure=undecided_column');
    });

    it('a shrink that loses a linked cell is refused', async () => {
      const s = await linked();
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [s.v1.version_id],
        changes: [replace(s.v1.version_id, 10, 40, 2, 2, ORG_BENE_A)] }), 'beneficiary_region_in_use');
    });

    it('a replace that would switch a linked cell\'s beneficiary or decision is refused', async () => {
      const s = await linked();
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [s.v1.version_id],
        changes: [replace(s.v1.version_id, 0, WHOLE, 2, 2, ORG_BENE_B)] }), 'beneficiary_region_in_use');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [s.v1.version_id],
        changes: [replace(s.v1.version_id, 0, WHOLE, 2, 2, null)] }), 'beneficiary_region_in_use');
    });

    it('a replace that keeps every linked cell under the same beneficiary is accepted (a split around the link)', async () => {
      const s = await linked();
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [s.v1.version_id],
        changes: [replace(s.v1.version_id, 0, 20, 2, 2, ORG_BENE_A), add(21, WHOLE, 2, 2, ORG_BENE_B)] });
      expect(out.active_versions).toHaveLength(2);
    });

    it('RV-4 at COMMIT: a privileged bypass stamp retiring the last covering region is refused by T2', async () => {
      const s = await linked();
      await refused(s.revId, () => bypass((c) => c.query(
        `UPDATE central_needs_beneficiary_regions SET retired_at=now(), retired_by=$2, retirement_kind='removed', retirement_reason='bypass'
          WHERE version_id=$1`, [s.v1.version_id, U_EDIT])), 'beneficiary_region_in_use');
    });

    it('the delete path works: delete the line with a reason, then the region may be removed', async () => {
      const s = await linked();
      await deleteLine(s.line.need_line_id, [s.rec(0, 5, 2)]);
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [s.v1.version_id], changes: [remove(s.v1.version_id)] });
      expect(await activeOf(s.sessionId)).toHaveLength(0);
    });
  });

  // ===========================================================================
  // RX-1 / RV-5 / RV-6 / RV-7 — M213 -> Region conversion (B2)
  // ===========================================================================
  describe('RX-1 / RV-5..RV-7 M213 to region conversion', () => {
    async function decided(decision: 'beneficiary' | 'non_beneficiary' = 'beneficiary', col = 2) {
      const s = await standard();
      await setColumns(U_EDIT, s.revId, [{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: col,
        decision, beneficiaryOrganizationId: decision === 'beneficiary' ? ORG_BENE_A : null }], 'whole column decided');
      const m = await listedColumn(s.revId, s.sessionId, col);
      return { ...s, m };
    }

    it('RV-5 success: M213 row deleted, explicit regions inserted, one conversion audit row with the FULL snapshot', async () => {
      const s = await decided();
      const [m213] = await admin(`SELECT * FROM central_needs_beneficiary_column_mappings WHERE id=$1`, [s.m.mapping_id]);
      const audit0 = await auditCount();
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2), add(1, 20, 2, 2, ORG_BENE_A), add(22, 40, 2, 2, ORG_BENE_B)], reason: 'stacked column' });
      expect(await m213Of(s.sessionId)).toHaveLength(0);
      expect(out.converted_columns).toEqual([{ columnIndex: 2, retiredMappingId: s.m.mapping_id }]);
      const active = await activeOf(s.sessionId);
      expect(active.map((a: any) => [a.row_start, a.row_end, a.beneficiary_organization_id]))
        .toEqual([[1, 20, ORG_BENE_A], [22, 40, ORG_BENE_B]]);
      expect(await auditCount()).toBe(audit0 + 3);
      const [conv] = await admin(`SELECT * FROM audit_logs WHERE action='central_needs.beneficiary_column.converted_to_regions' AND entity_id=$1`,
        [s.m.mapping_id]);
      expect(conv.entity_type).toBe('central_needs_beneficiary_column_mapping');
      expect(conv.payload).toMatchObject({ plan_revision_id: s.revId, import_session_id: s.sessionId, sheet_index: 0,
        column_index: 2, operation_batch_id: out.operation_batch_id, reason: 'stacked column',
        retired_mapping: { id: m213.id, decision: 'beneficiary', beneficiary_organization_id: ORG_BENE_A,
          source_field_name: m213.source_field_name, mapping_reason: 'whole column decided', mapped_by: U_EDIT } });
      expect(new Date(conv.payload.retired_mapping.mapped_at).getTime()).toBe(new Date(m213.mapped_at).getTime());
      expect([...conv.payload.new_version_ids].sort()).toEqual(active.map((a: any) => a.version_id).sort());
      // Nothing was copied from M213: the second region is B, not the M213 beneficiary.
      const lr = await listedColumn(s.revId, s.sessionId, 2);
      expect(lr.mapping_id).toBeNull();
    });

    it('conversion with no intersecting new region is refused; nothing is auto-created', async () => {
      const s = await decided();
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2), add(1, 20, 3, 3, ORG_BENE_A)] }), 'beneficiary_region_conversion_requires_region');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2)] }), 'beneficiary_region_conversion_requires_region');
    });

    it('a stale M213 fence (re-pointed column, wrong id, wrong decision/beneficiary, missing row) is refused', async () => {
      const s = await decided();
      const wrong: Array<Record<string, unknown>> = [
        { expectedMappingId: '00000000-0000-0000-0000-000000216999' },
        { previousDecision: 'non_beneficiary' },
        { previousBeneficiaryOrganizationId: ORG_BENE_B },
        { previousBeneficiaryOrganizationId: null },
      ];
      for (const w of wrong) {
        await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
          changes: [convert(s.m, 2, w), add(1, 20, 2, 2, ORG_BENE_A)] }), 'beneficiary_region_stale');
      }
      await setColumns(U_EDIT, s.revId, [{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 2,
        beneficiaryOrganizationId: ORG_BENE_B, previousBeneficiaryOrganizationId: ORG_BENE_A }], 're-pointed');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert({ ...s.m, beneficiary_organization_id: ORG_BENE_B }, 2), add(1, 20, 2, 2, ORG_BENE_A)] }),
      'beneficiary_region_stale');
      // A column with no M213 row cannot be "converted".
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 4), add(1, 20, 4, 4, ORG_BENE_A)] }), 'beneficiary_region_stale');
    });

    it('null-safe fence: a non_beneficiary M213 row converts with a JSON-null previous beneficiary', async () => {
      const s = await decided('non_beneficiary');
      expect(s.m.beneficiary_organization_id).toBeNull();
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2), add(0, WHOLE, 2, 2, null)] });
      expect(out.converted_columns).toHaveLength(1);
    });

    it('mapped_at exactness: the value exactly as list_beneficiary_columns returns it passes; a millisecond-truncated one is stale', async () => {
      const s = await decided();
      await admin(`UPDATE central_needs_beneficiary_column_mappings SET mapped_at='2026-09-01 10:00:00.123456+00' WHERE id=$1`, [s.m.mapping_id]);
      const m = await listedColumn(s.revId, s.sessionId, 2);
      expect(m.mapped_at).toMatch(/\.123456/);
      const truncated = m.mapped_at.replace('.123456', '.123');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert({ ...m, mapped_at: truncated }, 2), add(0, WHOLE, 2, 2, ORG_BENE_A)] }), 'beneficiary_region_stale');
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(m, 2), add(0, WHOLE, 2, 2, ORG_BENE_A)] });
      expect(out.ok).toBe(true);
    });

    it('optional importSessionId/sheetIndex equal to the call scope pass; different ones are refused', async () => {
      const s = await decided();
      const other = await standard();
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2, { importSessionId: other.sessionId }), add(0, WHOLE, 2, 2)] }), 'beneficiary_region_operation_invalid');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2, { sheetIndex: 1 }), add(0, WHOLE, 2, 2)] }), 'beneficiary_region_operation_invalid');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [{ ...convert(s.m, 2), previousMappedAt: undefined }, add(0, WHOLE, 2, 2)] }), 'beneficiary_region_operation_invalid');
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2), convert(s.m, 2), add(0, WHOLE, 2, 2)] }), 'beneficiary_region_operation_invalid');
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2, { importSessionId: s.sessionId, sheetIndex: 0 }), add(0, WHOLE, 2, 2)] });
      expect(out.ok).toBe(true);
    });

    it('RV-6 a failed multi-column conversion rolls back as a whole: both M213 rows remain, no version, no audit', async () => {
      const s = await standard();
      await setColumns(U_EDIT, s.revId, [
        { importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 2, beneficiaryOrganizationId: ORG_BENE_A },
        { importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 3, beneficiaryOrganizationId: ORG_BENE_B }]);
      const c2 = await listedColumn(s.revId, s.sessionId, 2);
      const c3 = await listedColumn(s.revId, s.sessionId, 3);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(c2, 2), convert(c3, 3), add(0, WHOLE, 2, 2, ORG_BENE_A)] }), 'beneficiary_region_conversion_requires_region');
      // (c) both converted, but a linked cell of column 3 would land under another beneficiary: refused after the writes.
      await setLine(s.revId, { beneficiary: ORG_BENE_B, qty: 10, sources: sources([s.rec(0, 7, 3), 10]) });
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(c2, 2), convert(c3, 3), add(0, WHOLE, 2, 3, ORG_BENE_A)] }), 'beneficiary_region_in_use');
      expect(await m213Of(s.sessionId)).toHaveLength(2);
    });

    it('RV-7 a conversion that would split an existing line is refused; after deleting the line it commits and pairs per cell', async () => {
      const s = await decided();
      const line = await setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 20,
        sources: sources([s.rec(0, 3, 2), 10], [s.rec(0, 25, 2), 10]) });
      const stacked = [convert(s.m, 2), add(1, 20, 2, 2, ORG_BENE_A), add(22, 40, 2, 2, ORG_BENE_B)];
      const r = await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: stacked }),
        'beneficiary_region_in_use');
      expect(r.detail).toContain(`source_record=${s.rec(0, 25, 2)}`);
      await deleteLine(line.need_line_id, [s.rec(0, 3, 2), s.rec(0, 25, 2)].sort());
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: stacked });
      await setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 3, 2), 10]) });
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 20, sources: sources([s.rec(0, 25, 2), 10]),
        expected: [s.rec(0, 3, 2)] }), 'beneficiary_region_mapping_conflict');
      const b = await setLine(s.revId, { beneficiary: ORG_BENE_B, qty: 10, sources: sources([s.rec(0, 25, 2), 10]) });
      expect(b.ok).toBe(true);
    });

    it('a conversion keeping every linked cell under its beneficiary commits: T5\' permits the in-use M213 delete at COMMIT', async () => {
      const s = await decided();
      await setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 3, 2), 10]) });
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(s.m, 2), add(0, 20, 2, 2, ORG_BENE_A), add(21, WHOLE, 2, 2, ORG_BENE_B)] });
      expect(out.ok).toBe(true);
      expect(await m213Of(s.sessionId)).toHaveLength(0);
    });

    it('T5\' at COMMIT under a privileged bypass: an in-use M213 delete is refused unless the column is fully covered', async () => {
      const s = await decided();
      await setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 3, 2), 10]) });
      await refused(s.revId, () => bypass((c) => c.query(
        `DELETE FROM central_needs_beneficiary_column_mappings WHERE id=$1`, [s.m.mapping_id])),
      'beneficiary_column_mapping_in_use');
      const insertRegion = (c: any, rs: number, re: number, ben: string) => c.query(
        `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision,
           beneficiary_organization_id, decision_reason, decided_by)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,$4,$5,2,2,'beneficiary',$6,'bypass',$7)`,
        [s.revId, ORG_OWNER, s.sessionId, rs, re, ben, U_EDIT]);
      // Covered by the WRONG beneficiary: the M213 delete event fires first -> unchanged M213 code.
      await refused(s.revId, () => bypass(async (c) => {
        await c.query(`DELETE FROM central_needs_beneficiary_column_mappings WHERE id=$1`, [s.m.mapping_id]);
        await insertRegion(c, 0, WHOLE, ORG_BENE_B);
      }), 'beneficiary_column_mapping_in_use');
      // Fully covered with the line's beneficiary: T5' permits it.
      await bypass(async (c) => {
        await c.query(`DELETE FROM central_needs_beneficiary_column_mappings WHERE id=$1`, [s.m.mapping_id]);
        await insertRegion(c, 0, WHOLE, ORG_BENE_A);
      });
      expect(await m213Of(s.sessionId)).toHaveLength(0);
      expect(await activeOf(s.sessionId)).toHaveLength(1);
    });

    it('a bypass delete of an UNUSED M213 row passes as today and leaves the column UNRESOLVED (branch 13 blocks)', async () => {
      const s = await decided();
      await bypass((c) => c.query(`DELETE FROM central_needs_beneficiary_column_mappings WHERE id=$1`, [s.m.mapping_id]));
      const bl = await blockers(s.revId);
      expect(bl.some((b: any) => b.blocker === 'beneficiary_column_review_required' && b.detail.includes(' column=2 '))).toBe(true);
    });
  });

  // ===========================================================================
  // RV-8 / RV-11 — Region -> M213 inverse and readiness across transitions
  // ===========================================================================
  describe('RV-8 / RV-11 inverse and readiness', () => {
    it('RV-8 two governed steps: retire the regions (column UNRESOLVED, branch 13 blocks), then M213 decides (T4 permits)', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(0, WHOLE, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id], changes: [remove(v1.version_id)] });
      let codes = await blockers(s.revId);
      expect(codes.some((b: any) => b.blocker === 'beneficiary_column_review_required' && b.detail.includes(' column=2 '))).toBe(true);
      expect(codes.some((b: any) => b.blocker === 'beneficiary_region_cell_uncovered')).toBe(false);
      expect((await listedColumn(s.revId, s.sessionId, 2)).review_required).toBe(true);
      await setColumns(U_EDIT, s.revId, [{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 2,
        beneficiaryOrganizationId: ORG_BENE_A, previousDecision: null }], 'back to a whole-column decision');
      codes = await blockers(s.revId);
      expect(codes.some((b: any) => b.blocker === 'beneficiary_column_review_required' && b.detail.includes(' column=2 '))).toBe(false);
      expect(codes.some((b: any) => b.blocker === 'beneficiary_column_cell_without_need_line' && b.detail.includes(' column=2 '))).toBe(true);
    });

    it('RV-8 step 1 is refused while linked cells depend on the regions', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(0, WHOLE, 2, 3, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      await setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 4, 2), 10]) });
      // Narrowing away from column 2 (keeping column 3) would orphan the linked cell.
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id],
        changes: [replace(v1.version_id, 0, WHOLE, 3, 3, ORG_BENE_A)] }), 'beneficiary_region_in_use');
    });

    it('RV-11 blocker 13/14 partition: region-governed cells move to 14 per cell; an unsafely located cell stays in 13', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, [{ sheet: 0, rows: [
        ...grid([1, 2, 3, 4, 5], [2]),
        // sheetIndex stored as the JSON STRING "0": M213's raw cast reads column 2,
        // but the safe extractor cannot locate it.
        { row: 6, cells: [{ col: 2, provenance: { sheetIndex: '0' } }] },
      ] }]);
      await setRegions(U_EDIT, { rev: s.revId, session: sess.sessionId, expected: [], changes: [add(1, 3, 2, 2, ORG_BENE_A)] });
      const bl = await blockers(s.revId);
      expect(bl.filter((b: any) => b.blocker === 'beneficiary_region_cell_uncovered').map((b: any) => b.detail)).toEqual([
        `session=${sess.sessionId} sheet=0 column=2 uncovered_numeric_cells_on_mapped_rows=2 first_uncovered_row=4`]);
      expect(bl.filter((b: any) => b.blocker === 'beneficiary_column_review_required').map((b: any) => b.detail)).toEqual([
        `session=${sess.sessionId} sheet=0 column=2 numeric_cells_on_mapped_rows=1`]);
      expect(bl.filter((b: any) => b.blocker === 'beneficiary_region_cell_without_need_line')).toHaveLength(3);
      expect((await listedColumn(s.revId, sess.sessionId, 2)).review_required).toBe(true);
      // The unsafe cell can never be designated: its column cannot be identified.
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10,
        sources: sources([sess.rec(0, 6, 2), 10]) }), 'beneficiary_column_mapping_required');
    });

    it('RV-11 after a conversion: branch 12 no longer sees the column, 13 excludes it, 14 owns gaps, 15 owes links', async () => {
      const s = await standard();
      await setColumns(U_EDIT, s.revId, [{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 2, beneficiaryOrganizationId: ORG_BENE_A }]);
      const m = await listedColumn(s.revId, s.sessionId, 2);
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [convert(m, 2), add(1, 20, 2, 2, ORG_BENE_A), add(30, 40, 2, 2, null)] });
      const bl = await blockers(s.revId);
      const col2 = (code: string) => bl.filter((b: any) => b.blocker === code && b.detail.includes(' column=2 '));
      expect(col2('beneficiary_column_cell_without_need_line')).toHaveLength(0);
      expect(col2('beneficiary_column_review_required')).toHaveLength(0);
      expect(col2('beneficiary_region_cell_uncovered').map((b: any) => b.detail)).toEqual([
        `session=${s.sessionId} sheet=0 column=2 uncovered_numeric_cells_on_mapped_rows=9 first_uncovered_row=21`]);
      expect(bl.filter((b: any) => b.blocker === 'beneficiary_region_cell_without_need_line')).toHaveLength(20);
    });

    it('RX-7 a merge-covered cell carrying its own value inside a beneficiary region owes a link (blocker 15)', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, [{ sheet: 0, rows: [
        { row: 1, cells: [{ col: 2 }] },
        { row: 2, cells: [{ col: 2, provenance: { mergedRange: 'C2:C3' } }] },
      ] }]);
      await setRegions(U_EDIT, { rev: s.revId, session: sess.sessionId, expected: [], changes: [add(1, 2, 2, 2, ORG_BENE_A)] });
      const bl = await blockers(s.revId);
      expect(bl.filter((b: any) => b.blocker === 'beneficiary_region_cell_without_need_line').map((b: any) => b.detail))
        .toContain(`session=${sess.sessionId} sheet=0 row=2 column=2 region=${(await activeIds(sess.sessionId))[0]} target_entity=sheet:0:row:2 source_record=${sess.rec(0, 2, 2)}`);
    });

    it('a non_beneficiary region is reviewed and never owes a link; its cells cannot be designated', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(0, WHOLE, 2, 2, null)] });
      const bl = await blockers(s.revId);
      expect(bl.some((b: any) => b.blocker.startsWith('beneficiary_region_') && b.detail.includes(' column=2 '))).toBe(false);
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 4, 2), 10]) }),
        'beneficiary_region_not_beneficiary');
    });

    it('set_need_line on a region-governed column: an uncovered cell is beneficiary_region_required', async () => {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 10, 2, 2, ORG_BENE_A)] });
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 15, 2), 10]) }),
        'beneficiary_region_required');
      // M213 path is unchanged for a column no region spans.
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 15, 5), 10]) }),
        'beneficiary_column_mapping_required');
    });
  });

  // ===========================================================================
  // RX-2 — concurrent M213 write and region write
  // ===========================================================================
  describe('RX-2 concurrency across grains', () => {
    it('a region write and an M213 write on the same column serialize; the later M213 commit is refused by T4', async () => {
      const s = await standard();
      const a = await held(U_EDIT);
      const b = await held(U_EDIT);
      try {
        await a.q(REGIONS_SQL, [s.revId, s.sessionId, 0, JSON.stringify(RENDERED), 'Sheet0', [],
          JSON.stringify([add(1, 20, 4, 4, ORG_BENE_A)]), 'tab A']);
        const bCall = b.q(SET_COLUMNS_SQL, [s.revId, JSON.stringify([{ importSessionId: s.sessionId, sheetIndex: 0,
          columnIndex: 4, beneficiaryOrganizationId: ORG_BENE_B }]), 'tab B']).then(() => null, (e: any) => e);
        expect(await pidWaitingOnLock()).toBe(true);
        await a.commit();
        expect(await bCall).toBeNull();
        const err = await b.commit().then(() => null, (e: any) => e);
        expect(err).toMatchObject({ code: '23514', message: 'beneficiary_decision_grain_conflict' });
      } finally {
        await a.rollback();
        await b.rollback();
      }
      expect(await m213Of(s.sessionId)).toHaveLength(0);
      expect(await activeOf(s.sessionId)).toHaveLength(1);
    });
  });

  // ===========================================================================
  // R8 / R9 / R10 / R11 / RV-10 — correction lifecycle
  // ===========================================================================
  describe('R8-R11 / RV-10 correction lifecycle', () => {
    async function approvedWithRegion() {
      // C5 §18: approved canonically (draft -> submit -> approve through the real
      // RPCs), never by a direct UPDATE the 217 fence refuses. One region-governed
      // column of three numeric cells keeps the revision small enough to be READY;
      // R8-R11 assert only on that column's region, so nothing they prove moves.
      const s = await standard([1, 2, 3], [2]);
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(0, WHOLE, 2, 2, ORG_BENE_A)] });
      await approveCanonically(s.revId, s.sessionId, [1, 2, 3].map((r) => s.rec(0, r, 2)), ORG_BENE_A);
      return s;
    }
    const regionRows = () => admin(`SELECT to_jsonb(v) j FROM central_needs_beneficiary_regions v ORDER BY version_id`);

    it('R8 an approved revision is read-only: the RPC refuses, T1 refuses insert and stamp, and every delete', async () => {
      const s = await approvedWithRegion();
      const [v1] = await activeOf(s.sessionId);
      await refused(s.revId, () => setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id],
        changes: [remove(v1.version_id)] }), 'plan_revision_not_editable');
      await refused(s.revId, () => bypass((c) => c.query(
        `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,1,5,4,4,'beneficiary',$4,'bypass')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A])),
      'plan_revision_not_editable');
      await refused(s.revId, () => bypass((c) => c.query(
        `UPDATE central_needs_beneficiary_regions SET retired_at=now(), retired_by=$2, retirement_kind='removed', retirement_reason='x'
          WHERE version_id=$1`, [v1.version_id, U_EDIT])), 'plan_revision_not_editable');
      await refused(s.revId, () => bypass((c) => c.query(
        `DELETE FROM central_needs_beneficiary_regions WHERE version_id=$1`, [v1.version_id])), 'beneficiary_region_version_immutable');
    });

    it('R9 / RV-10 a correction opens with ZERO regions; its regions are new lineages on its own sessions only', async () => {
      const s = await approvedWithRegion();
      const before = await regionRows();
      const corr = await call(U_EDIT, 'SELECT public.phoenix_central_needs_open_correction_revision($1,$2,$3,$4) AS result',
        [ORG_OWNER, s.year, s.revId, 'annual correction']);
      const rev2 = corr.plan_revision_id ?? corr.revision_id ?? corr.id;
      expect(rev2).toBeTruthy();
      expect((await admin(`SELECT count(*)::int n FROM central_needs_beneficiary_regions WHERE plan_revision_id=$1`, [rev2]))[0].n).toBe(0);
      expect(await regionRows()).toEqual(before);
      // The draft cannot bind the predecessor's session (RPC and composite FK).
      await refused(rev2, () => setRegions(U_EDIT, { rev: rev2, session: s.sessionId, expected: [], changes: [add(1, 5, 3, 3)] }),
        'beneficiary_region_session_not_in_revision');
      const fk = await refusal(bypass((c) => c.query(
        `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,1,5,3,3,'beneficiary',$4,'bypass')`, [rev2, ORG_OWNER, s.sessionId, ORG_BENE_A])));
      expect(fk.code).toBe('23503');
      const sess2 = await addSession(rev2, [{ sheet: 0, rows: grid([1, 2, 3], [2]) }]);
      await setRegions(U_EDIT, { rev: rev2, session: sess2.sessionId, expected: [], changes: [add(0, WHOLE, 2, 2, ORG_BENE_A)] });
      const [mine] = await activeOf(sess2.sessionId);
      const [pred] = await activeOf(s.sessionId);
      expect(mine.region_id).not.toBe(pred.region_id);
    });

    async function submittedCorrection() {
      const s = await approvedWithRegion();
      const corr = await call(U_EDIT, 'SELECT public.phoenix_central_needs_open_correction_revision($1,$2,$3,$4) AS result',
        [ORG_OWNER, s.year, s.revId, 'annual correction']);
      const rev2 = corr.plan_revision_id ?? corr.revision_id ?? corr.id;
      const sess2 = await addSession(rev2, [{ sheet: 0, rows: grid([1, 2, 3], [2]) }]);
      await setRegions(U_EDIT, { rev: rev2, session: sess2.sessionId, expected: [], changes: [add(0, WHOLE, 2, 2, ORG_BENE_B)] });
      // C5 §18: R11 goes on to APPROVE this correction, so it is submitted
      // canonically through the real submit RPC — never by a direct UPDATE.
      await submitCanonically(rev2, sess2.sessionId, [1, 2, 3].map((r) => sess2.rec(0, r, 2)), ORG_BENE_B);
      return { s, rev2, sess2 };
    }

    it('R11 approve performs ZERO region writes and no region audit', async () => {
      const { s, rev2 } = await submittedCorrection();
      const before = await regionRows();
      const auditRegions = await auditCount('central_needs.beneficiary_');
      const out = await call(U_APPROVE, 'SELECT public.phoenix_central_needs_approve_revision($1) AS result', [rev2]);
      expect(out.ok).toBe(true);
      expect(await regionRows()).toEqual(before);
      expect(await auditCount('central_needs.beneficiary_')).toBe(auditRegions);
      const statuses = await admin(`SELECT id, status FROM central_needs_plan_revisions WHERE id IN ($1,$2)`, [s.revId, rev2]);
      expect(Object.fromEntries(statuses.map((r: any) => [r.id, r.status]))).toEqual({ [s.revId]: 'superseded', [rev2]: 'approved' });
    });

    it('R10 reject performs ZERO region writes; the correction\'s versions become frozen history', async () => {
      const { rev2, sess2 } = await submittedCorrection();
      const before = await regionRows();
      const auditRegions = await auditCount('central_needs.beneficiary_');
      await call(U_APPROVE, 'SELECT public.phoenix_central_needs_reject_revision($1,$2) AS result', [rev2, 'not accepted']);
      expect(await regionRows()).toEqual(before);
      expect(await auditCount('central_needs.beneficiary_')).toBe(auditRegions);
      const [v] = await activeOf(sess2.sessionId);
      await refused(rev2, () => bypass((c) => c.query(
        `UPDATE central_needs_beneficiary_regions SET retired_at=now(), retired_by=$2, retirement_kind='removed', retirement_reason='x'
          WHERE version_id=$1`, [v.version_id, U_EDIT])), 'plan_revision_not_editable');
    });
  });

  // ===========================================================================
  // RX-8 — T1 / T3 / S9 / S12 / S13 under privileged bypass; FK actor nulling
  // ===========================================================================
  describe('RX-8 privileged bypass: T1, T3, uniqueness, actor nulling', () => {
    async function oneRegion() {
      const s = await standard();
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 2, 2, ORG_BENE_A)] });
      const [v1] = await activeOf(s.sessionId);
      return { ...s, v1 };
    }
    const upd = (sql: string, params: unknown[]) => bypass((c) => c.query(sql, params));

    it('T1 refuses a physical delete, an un-retire, a second stamp, an incomplete stamp, a content change and a born-retired insert', async () => {
      const s = await oneRegion();
      const cases: Array<[string, string, unknown[]]> = [
        ['operation=delete', `DELETE FROM central_needs_beneficiary_regions WHERE version_id=$1`, [s.v1.version_id]],
        ['transition=incomplete_stamp', `UPDATE central_needs_beneficiary_regions SET retired_at=now(), retirement_kind='removed', retirement_reason='x' WHERE version_id=$1`, [s.v1.version_id]],
        ['transition=content_change', `UPDATE central_needs_beneficiary_regions SET row_end=19 WHERE version_id=$1`, [s.v1.version_id]],
        ['transition=content_change', `UPDATE central_needs_beneficiary_regions SET beneficiary_organization_id=$2 WHERE version_id=$1`, [s.v1.version_id, ORG_BENE_B]],
        ['transition=content_change', `UPDATE central_needs_beneficiary_regions SET decision_reason='rewritten' WHERE version_id=$1`, [s.v1.version_id]],
        ['transition=born_retired', `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason,
           retired_at, retired_by, retirement_kind, retirement_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,30,35,4,4,'beneficiary',$4,'bypass', now(), $5, 'removed', 'x')`,
          [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A, U_EDIT]],
      ];
      for (const [detail, sql, params] of cases) {
        const r = await refused(s.revId, () => upd(sql, params), 'beneficiary_region_version_immutable');
        expect(r.detail).toContain(detail);
      }
      // Retire legitimately (remove), then un-retire and second stamp are refused.
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [s.v1.version_id], changes: [remove(s.v1.version_id)] });
      let r = await refused(s.revId, () => upd(`UPDATE central_needs_beneficiary_regions SET retired_at=NULL, retired_by=NULL,
        retirement_kind=NULL, retirement_reason=NULL WHERE version_id=$1`, [s.v1.version_id]), 'beneficiary_region_version_immutable');
      expect(r.detail).toContain('transition=un_retire');
      r = await refused(s.revId, () => upd(`UPDATE central_needs_beneficiary_regions SET retirement_reason='again' WHERE version_id=$1`,
        [s.v1.version_id]), 'beneficiary_region_version_immutable');
      expect(r.detail).toContain('transition=second_stamp');
    });

    it('T1 admits the house FK actor nulling on a draft and on an approved revision; nothing else changes', async () => {
      for (const approveAfter of [false, true]) {
        const tmp = approveAfter ? '00000000-0000-0000-0000-000000216498' : '00000000-0000-0000-0000-000000216499';
        await admin(`INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [tmp, `${tmp}@rig`]);
        await admin(`UPDATE profiles SET role='central_warehouse_manager', status='active', organization_id=$2 WHERE id=$1`, [tmp, ORG_OWNER]);
        await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES
          ($1,'central_needs.view',true),($1,'central_needs.edit',true) ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [tmp]);
        // One region-governed column (rows 1-25, column 2) that the replaced
        // version covers exactly, so the approved case can be made READY: C5 §18
        // approves it canonically (submit -> approve through the real RPCs),
        // never by a direct UPDATE the 217 fence refuses. The FK actor nulling
        // under test concerns only the two version rows, whatever the grid.
        const rows = Array.from({ length: 25 }, (_, i) => i + 1);
        const s = await standard(rows, [2]);
        await setRegions(tmp, { rev: s.revId, session: s.sessionId, expected: [], changes: [add(1, 20, 2, 2, ORG_BENE_A)] });
        const [v1] = await activeOf(s.sessionId);
        await setRegions(tmp, { rev: s.revId, session: s.sessionId, expected: [v1.version_id], changes: [replace(v1.version_id, 1, 25, 2, 2, ORG_BENE_A)] });
        if (approveAfter) {
          await approveCanonically(s.revId, s.sessionId, rows.map((r) => s.rec(0, r, 2)), ORG_BENE_A);
        }
        const before = await versionsOf(s.sessionId);
        await admin(`DELETE FROM auth.users WHERE id=$1`, [tmp]);
        const after = await versionsOf(s.sessionId);
        expect(after).toHaveLength(2);
        const strip = (v: any) => ({ ...v, decided_by: undefined, retired_by: undefined });
        expect(after.map(strip)).toEqual(before.map(strip));
        expect(after.every((v: any) => v.decided_by === null)).toBe(true);
        expect(after.find((v: any) => v.version_id === v1.version_id).retired_by).toBeNull();
      }
    });

    it('S12/S13/S9 refuse a second ACTIVE holder of one region or one geometry and a forked lineage', async () => {
      const s = await oneRegion();
      const ins = (regionId: string, versionNo: number, supersedes: string | null, rs: number, re: number) => bypass((c) => c.query(
        `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, supersedes_version_id, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,5,5,'beneficiary',$9,'bypass')`,
        [regionId, versionNo, supersedes, s.revId, ORG_OWNER, s.sessionId, rs, re, ORG_BENE_A]));
      const one = await refusal(ins(s.v1.region_id, 2, s.v1.version_id, 30, 31));
      expect(one.code).toBe('23505');
      await bypass((c) => c.query(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,1,2,6,6,'beneficiary',$4,'bypass')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A]));
      const geo = await refusal(bypass((c) => c.query(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,1,2,6,6,'beneficiary',$4,'bypass')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_B])));
      expect(geo.code).toBe('23505');
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: await activeIds(s.sessionId),
        changes: [replace(s.v1.version_id, 1, 25, 2, 2, ORG_BENE_A)] });
      const fork = await refusal(bypass(async (c) => {
        await c.query(`UPDATE central_needs_beneficiary_regions SET retired_at=now(), retired_by=$2, retirement_kind='removed', retirement_reason='x'
                        WHERE region_id=$1 AND retired_at IS NULL`, [s.v1.region_id, U_EDIT]);
        await c.query(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, supersedes_version_id, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES ($1,3,$2,$3,$4,$5,0,40,40,2,2,'beneficiary',$6,'fork')`, [s.v1.region_id, s.v1.version_id, s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A]);
      }));
      expect(fork.code).toBe('23505');
    });

    it('T3 refuses a malformed lineage at COMMIT (beneficiary_region_lineage_invalid)', async () => {
      const s = await oneRegion();
      // (1) a successor of a version retired as REMOVED.
      let r = await refused(s.revId, () => bypass(async (c) => {
        await c.query(`UPDATE central_needs_beneficiary_regions SET retired_at=now(), retired_by=$2, retirement_kind='removed', retirement_reason='x'
                        WHERE version_id=$1`, [s.v1.version_id, U_EDIT]);
        await c.query(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, supersedes_version_id, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES ($1,2,$2,$3,$4,$5,0,1,20,2,2,'beneficiary',$6,'x')`, [s.v1.region_id, s.v1.version_id, s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A]);
      }), 'beneficiary_region_lineage_invalid');
      expect(r.detail).toContain('problem=');
      // (2) version_no skips (3 after 1).
      r = await refused(s.revId, () => bypass(async (c) => {
        await c.query(`UPDATE central_needs_beneficiary_regions SET retired_at=now(), retired_by=$2, retirement_kind='replaced', retirement_reason='x'
                        WHERE version_id=$1`, [s.v1.version_id, U_EDIT]);
        await c.query(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, supersedes_version_id, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES ($1,3,$2,$3,$4,$5,0,1,20,2,2,'beneficiary',$6,'x')`, [s.v1.region_id, s.v1.version_id, s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A]);
      }), 'beneficiary_region_lineage_invalid');
      expect(r.detail).toContain('problem=successor_not_after_replaced_predecessor');
      // (3) stamped REPLACED with no successor.
      r = await refused(s.revId, () => bypass((c) => c.query(
        `UPDATE central_needs_beneficiary_regions SET retired_at=now(), retired_by=$2, retirement_kind='replaced', retirement_reason='x'
          WHERE version_id=$1`, [s.v1.version_id, U_EDIT])), 'beneficiary_region_lineage_invalid');
      expect(r.detail).toContain('problem=replaced_without_successor');
    });

    it('T3 refuses a bypass overlap and a bypass X1 conflict at COMMIT', async () => {
      const s = await oneRegion();
      await refused(s.revId, () => bypass((c) => c.query(
        `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,5,25,1,3,'beneficiary',$4,'bypass')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_B])),
      'beneficiary_region_overlap');
      await setColumns(U_EDIT, s.revId, [{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 5, beneficiaryOrganizationId: ORG_BENE_A }]);
      await refused(s.revId, () => bypass((c) => c.query(
        `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,1,5,5,5,'beneficiary',$4,'bypass')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A])),
      'beneficiary_decision_grain_conflict');
    });

    it('T1 takes a FOR SHARE lock on the revision: a bypass version write holds off a concurrent submit', async () => {
      const s = await standard();
      const bypassTx = await held(null, 'superuser');
      const submitter = await held(U_EDIT);
      try {
        await bypassTx.q(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,1,5,2,2,'beneficiary',$4,'bypass')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A]);
        const locks = await admin(`SELECT mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
                                    WHERE c.relname='central_needs_plan_revisions' AND l.mode='RowShareLock'`);
        expect(locks.length).toBeGreaterThan(0);
        await submitter.q(`SET LOCAL lock_timeout = '400ms'`);
        const err = await submitter.q('SELECT public.phoenix_central_needs_submit_revision($1)', [s.revId]).then(() => null, (e: any) => e);
        expect(err).toMatchObject({ code: '55P03' });
      } finally {
        await submitter.rollback();
        await bypassTx.rollback();
      }
    });

    it('a lock-free bypass race that commits an overlap or X1 violation is blocked at submit by blockers 16 and 17', async () => {
      const s = await oneRegion();
      // Reproduce the committed outcome of two lock-free transactions that never
      // saw each other: triggers are suspended only inside this superuser txn.
      //
      // C5 §18 DISPOSITION — an explicitly labelled POLICY EXCEPTION (a
      // race-simulation NEGATIVE, never a lifecycle fixture). This suite runs on
      // the 217 chain, where §18 forbids session_replication_role for fixtures:
      // replica mode also silences the C5 approval fence and the deferred
      // lineage trigger. It stays on the 217 chain (it is not pinned to <= 216)
      // on purpose — the blockers and set_need_line it judges below ARE the M217
      // replacements. It is permitted ONLY because the replica window writes
      // region and M213 mapping rows alone, proven INSIDE the same transaction
      // before COMMIT: no plan, plan revision, need line, link, override, source
      // record or audit row changes (so no approved state and no approval gate
      // can be forged under it); and the switch is transaction-local.
      const lifecycleFingerprint = async (c: any) => (await c.query(`SELECT
          (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY r.id), '')) FROM central_needs_plan_revisions r) AS revisions,
          (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id), '')) FROM central_needs_plans p) AS plans,
          (SELECT md5(coalesce(string_agg(to_jsonb(n)::text, ',' ORDER BY n.id), '')) FROM central_needs_need_lines n) AS lines,
          (SELECT md5(coalesce(string_agg(to_jsonb(l)::text, ',' ORDER BY l.id), '')) FROM central_needs_need_line_sources l) AS links,
          (SELECT md5(coalesce(string_agg(to_jsonb(o)::text, ',' ORDER BY o.id), '')) FROM central_needs_field_overrides o) AS overrides,
          (SELECT count(*) FROM central_needs_source_records)::int AS records,
          (SELECT count(*) FROM audit_logs)::int AS audits,
          (SELECT count(*) FROM audit_logs WHERE action = 'central_needs.plan_revision.approval_gate')::int AS gates,
          (SELECT count(*) FROM central_needs_plan_revisions WHERE status = 'approved')::int AS approved`)).rows[0];
      const replicationRole = async (c: any) => (await c.query(`SELECT current_setting('session_replication_role') AS r`)).rows[0].r;
      const raceWrites = async (c: any) => {
        await c.query(`SET LOCAL session_replication_role = replica`);
        // Two regions that intersect on rows 16-17 of column 4 (blocker 16).
        await c.query(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,15,30,3,4,'beneficiary',$4,'race')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_B]);
        await c.query(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,16,17,4,4,'beneficiary',$4,'race')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_C]);
        // An M213 row on column 2, which v1 spans (blocker 17).
        await c.query(`INSERT INTO central_needs_beneficiary_column_mappings (plan_revision_id, organization_id, import_session_id,
           sheet_index, column_index, decision, beneficiary_organization_id, mapping_reason) VALUES ($1,$2,$3,0,2,'beneficiary',$4,'race')`,
        [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A]);
        await c.query(`INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id,
           import_session_id, sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
         VALUES (gen_random_uuid(),1,$1,$2,$3,0,500,600,9,9,'beneficiary',$4,'no evidence')`, [s.revId, ORG_OWNER, s.sessionId, ORG_BENE_A]);
      };
      /** What the replica window is allowed to write: region versions and M213 rows of THIS session. */
      const regionRows = async (c: any) => (await c.query(`SELECT
          (SELECT count(*) FROM central_needs_beneficiary_regions WHERE import_session_id = $1)::int AS regions,
          (SELECT count(*) FROM central_needs_beneficiary_column_mappings WHERE import_session_id = $1)::int AS m213`, [s.sessionId])).rows[0];
      let inside: { before: unknown; after: unknown; role: string; wrote: { regions: number; m213: number } } | undefined;
      await rig.asAdmin(async (c: any) => {
        expect(await replicationRole(c)).toBe('origin');
        await c.query('BEGIN');
        try {
          const before = await lifecycleFingerprint(c);
          const rows0 = await regionRows(c);
          await raceWrites(c);
          const rows1 = await regionRows(c);
          inside = { before, after: await lifecycleFingerprint(c), role: await replicationRole(c),
            wrote: { regions: rows1.regions - rows0.regions, m213: rows1.m213 - rows0.m213 } };
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
        // SET LOCAL: replica mode ended with the transaction on this very connection.
        expect(await replicationRole(c)).toBe('origin');
      });
      expect(inside!.role).toBe('replica');
      expect(inside!.wrote).toEqual({ regions: 3, m213: 1 });   // the window did write — exactly the race rows
      expect(inside!.after).toEqual(inside!.before);            // and nothing of the lifecycle
      const [rev] = await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [s.revId]);
      expect(rev.status).toBe('draft');
      expect(await admin(`SELECT id FROM audit_logs WHERE entity_id=$1 AND action='central_needs.plan_revision.approval_gate'`, [s.revId]))
        .toEqual([]);

      const codes = await blockerCodes(s.revId);
      expect(codes).toContain('beneficiary_region_overlap');
      expect(codes).toContain('beneficiary_decision_grain_conflict');
      const geo = (await blockers(s.revId)).filter((b: any) => b.blocker === 'beneficiary_region_geometry_invalid');
      expect(geo).toHaveLength(1);
      expect(geo[0].detail).toContain('reason=no_matching_evidence');
      // set_need_line refuses the ambiguous cells.
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 18, 2), 10]) }),
        'beneficiary_decision_grain_conflict');
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([s.rec(0, 16, 4), 10]) }),
        'beneficiary_region_overlap');
    });
  });

  // ===========================================================================
  // Coverage of the multi-sheet scope and the malformed-provenance rule (RX-3)
  // ===========================================================================
  describe('scope and RX-3', () => {
    it('one call writes exactly one (session, sheet); another sheet of the same session is independent', async () => {
      const s = await scenario();
      const sess = await addSession(s.revId, [
        { sheet: 0, rows: grid([1, 2, 3], [2]) },
        { sheet: 3, name: 'Hidden Tab', rows: [{ row: 1, cells: [{ col: 2 }] }, { row: 2, cells: [{ col: 2 }] }] },
      ]);
      await setRegions(U_EDIT, { rev: s.revId, session: sess.sessionId, expected: [], changes: [add(0, WHOLE, 2, 2, ORG_BENE_A)] });
      const out = await setRegions(U_EDIT, { rev: s.revId, session: sess.sessionId, sheet: 3, sheetName: 'Hidden Tab',
        expected: [], changes: [add(0, WHOLE, 2, 2, ORG_BENE_B)] });
      expect(out.sheet_index).toBe(3);
      expect(await activeOf(sess.sessionId, 0)).toHaveLength(1);
      expect(await activeOf(sess.sessionId, 3)).toHaveLength(1);
    });

    it('RX-3 malformed provenance never raises in the new code and is never inside a region', async () => {
      const [r] = await admin(`SELECT * FROM public._phoenix_central_needs_resolve_region_v1(gen_random_uuid(),
        '{"sheetIndex":"abc","coordinate":{"row":1.5,"col":-2}}'::jsonb)`);
      expect(r).toMatchObject({ cell_sheet: null, cell_row: null, cell_col: null, column_governed: false, covering_count: 0 });
      const s = await scenario();
      const sess = await addSession(s.revId, [{ sheet: 0, rows: [
        { row: 1, cells: [{ col: 2 }] },
        { row: 2, cells: [{ col: 2, provenance: { coordinate: { row: 2.5, col: 2, a1: 'C3' } } }] },
      ] }]);
      await setRegions(U_EDIT, { rev: s.revId, session: sess.sessionId, expected: [], changes: [add(0, WHOLE, 2, 2, ORG_BENE_A)] });
      // The row-unlocatable cell in a region-governed column blocks as uncovered.
      const bl = await blockers(s.revId);
      expect(bl.filter((b: any) => b.blocker === 'beneficiary_region_cell_uncovered').map((b: any) => b.detail)).toEqual([
        `session=${sess.sessionId} sheet=0 column=2 uncovered_numeric_cells_on_mapped_rows=1 first_uncovered_row=(unidentified)`]);
      await refused(s.revId, () => setLine(s.revId, { beneficiary: ORG_BENE_A, qty: 10, sources: sources([sess.rec(0, 2, 2), 10]) }),
        'beneficiary_region_required');
    });
  });

  // ===========================================================================
  // Audit discipline and the zero-backfill / privilege surface
  // ===========================================================================
  describe('audit, surface and no backfill', () => {
    it('exactly one audit row per region change and per converted column; no trigger-generated duplicates', async () => {
      const s = await standard();
      await setColumns(U_EDIT, s.revId, [{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 5, beneficiaryOrganizationId: ORG_BENE_C }]);
      const m = await listedColumn(s.revId, s.sessionId, 5);
      await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [],
        changes: [add(1, 10, 2, 2, ORG_BENE_A), add(11, 20, 2, 2, ORG_BENE_B)] });
      const [v1, v2] = await activeOf(s.sessionId);
      const out = await setRegions(U_EDIT, { rev: s.revId, session: s.sessionId, expected: [v1.version_id, v2.version_id],
        changes: [replace(v1.version_id, 1, 9, 2, 2, ORG_BENE_A), remove(v2.version_id), convert(m, 5), add(0, WHOLE, 5, 5, ORG_BENE_C)] });
      const rows = await admin(`SELECT action, entity_id FROM audit_logs WHERE payload->>'operation_batch_id'=$1 ORDER BY action`,
        [out.operation_batch_id]);
      expect(rows.map((r: any) => r.action)).toEqual([
        'central_needs.beneficiary_column.converted_to_regions',
        'central_needs.beneficiary_region.add',
        'central_needs.beneficiary_region.remove',
        'central_needs.beneficiary_region.replace',
      ]);
      expect(rows.find((r: any) => r.action.endsWith('.replace')).entity_id).toBe(v1.region_id);
      expect(rows.find((r: any) => r.action.endsWith('.remove')).entity_id).toBe(v2.region_id);
      const lifecycle = await admin(`SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'central_needs.plan_revision.%'
                                      AND payload->>'operation_batch_id' IS NOT NULL`);
      expect(lifecycle[0].n).toBe(0);
    });

    it('internal helpers are not client-callable; the RPC is SECURITY DEFINER with a pinned search_path', async () => {
      const rows = await admin(`SELECT p.proname, p.prosecdef, p.proconfig,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
          has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname LIKE '%central_needs%'
         AND (p.proname LIKE '%region%' OR p.proname LIKE '%m213_coordinate%' OR p.proname LIKE '%safe_coordinate%')`);
      const rpc = rows.find((r: any) => r.proname === 'phoenix_central_needs_set_beneficiary_regions');
      expect(rpc).toMatchObject({ prosecdef: true, auth_exec: true, anon_exec: false, public_exec: false });
      expect(rpc.proconfig).toContain('search_path=public, pg_temp');
      for (const r of rows.filter((x: any) => x.proname.startsWith('_'))) {
        expect({ name: r.proname, auth: r.auth_exec, anon: r.anon_exec, pub: r.public_exec })
          .toEqual({ name: r.proname, auth: false, anon: false, pub: false });
      }
    });
  });
});
