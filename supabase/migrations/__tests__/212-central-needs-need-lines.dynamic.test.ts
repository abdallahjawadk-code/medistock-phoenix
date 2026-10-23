/**
 * CN-2B CONFORMANCE (212) — DYNAMIC suite against the canonical replayed chain.
 *
 * Proves the operational Annual Needs projection on a real PostgreSQL: schema
 * shape and security posture, the beneficiary/warehouse/unit contracts, the
 * EXACT quantity contract (nothing is ever silently rounded, NaN and Infinity
 * are refused), MANDATORY source-record provenance whose contributions sum to
 * the approved quantity, canonical-material agreement with each row's existing
 * mapping, the measured cardinality (one CELL feeds at most one line, one ROW
 * may feed several), revision-wide provenance that a save can never erase, the
 * explicit correction path, stale-client refusal, the deferred integrity
 * assertion on EVERY line a change touches, the exact-decimal read, stable
 * domain errors, authorization and role boundaries with their exact codes,
 * revision editability, the extended review blockers, and — the one that
 * protects live data — that an ALREADY-APPROVED revision is never retroactively
 * invalidated.
 *
 * Fixtures are seeded through the rig's superuser connection, exactly as the
 * 209/211 dynamic suites do: this suite tests 212's own contract, not 210/211's
 * import pipeline.
 *
 * TWO CHAIN MODES, ONE SET OF M212 ASSERTIONS. `buildRig({})` replays every
 * migration on disk, so this file runs against either:
 *   - the HISTORICAL boundary (chain through 212 only), or
 *   - the FORWARD contract (chain through 213), where a source cell may feed a
 *     need line only once its PHYSICAL COLUMN — (import session, sheetIndex,
 *     coordinate.col), read from the record's own source_provenance — carries a
 *     confirmed beneficiary mapping, and that beneficiary is the line's.
 * Every seeded source record therefore carries CN-2A-shaped evidence and
 * provenance, and each cell declares whose physical column it sits in (ORG_BENE
 * unless a test says otherwise). One header shared by cells of DIFFERENT
 * beneficiaries is two physical columns, exactly as in the real corpus. Under
 * the forward contract the fixtures confirm those columns through the REAL
 * phoenix_central_needs_set_beneficiary_columns RPC — never a mock, never a
 * disabled trigger; only J's deliberate privileged-bypass scenario writes a
 * mapping directly, because bypassing the RPCs is that test's premise. The mode
 * is detected from the replayed schema and cross-checked against the migration
 * files actually applied (see beforeAll), so it cannot silently disagree with
 * the chain. Mode branches wrap only SETUP that references 213 objects; the one
 * mode-aware EXPECTATION is A's exact trigger-attachment set, which 213
 * intentionally extends by one table — each mode asserts its own exact set.
 *
 * C5 (217) is detected the same way. On that chain a designated quantity is a
 * JSON STRING in the exact decimal grammar before any cast (§10), so B's
 * sign/NaN/free-text contributions are refused as designated_quantity_not_canonical;
 * the readiness warehouse DETAIL carries its reason token (§4); and an approved
 * revision is reached only through the real submit/approve RPCs, because the
 * approval-gate fence refuses a direct UPDATE into 'approved' (§16/§18). Those
 * are the only C5-aware expectations; every other M212 assertion is unchanged.
 *
 * M224 (the authorization closure) is detected the same way, and it changes WHO may act. Before
 * it, M211's eligibility is a ROLE CLASS (super_admin, central_warehouse_manager): the tests in D,
 * K and N marked HISTORICAL are that era's contract, kept verbatim and run only on that chain.
 * From M224 on, eligibility is MEMBERSHIP — an ACTIVE profile whose home is a LIVE
 * pharmacy_department_authority — plus the explicit key, plus the home-organization scope, with no
 * role class. On that chain the same job titles in the owning PDA are ordinary staff who succeed,
 * and the tests marked FORWARD prove the refusals by their exact code, each fixture differing from
 * an authorized member in one dimension only:
 *   forbidden_central_needs_role — not an active member of a live PDA (care-institution home,
 *     suspended or archived profile, no home, archived PDA); checked first;
 *   forbidden_central_needs — a member without the key, or a member of ANOTHER PDA (scope),
 *     a super_admin homed elsewhere included: there is no cross-organization bypass.
 * Each mode skips the other mode's tests, so a skip is reported as a skip, never as a pass.
 * CN212_HISTORICAL_UP_TO (local only; CI never sets it) replays the chain only through that
 * migration, so the historical branch can be run directly, e.g. CN212_HISTORICAL_UP_TO=223.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, migrationFiles, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_OWNER = '00000000-0000-0000-0000-000000212001'; // owns the plan
const ORG_BENE = '00000000-0000-0000-0000-000000212002'; // beneficiary institution
const ORG_BENE2 = '00000000-0000-0000-0000-000000212003'; // a second beneficiary
const ORG_AUTHORITY = '00000000-0000-0000-0000-000000212004'; // not a care_institution
const ORG_INACTIVE = '00000000-0000-0000-0000-000000212005'; // inactive institution
const ORG_OTHER = '00000000-0000-0000-0000-000000212006'; // a CARE INSTITUTION (not another PDA)
const ORG_PDA2 = '00000000-0000-0000-0000-000000212007'; // ANOTHER live pharmacy_department_authority
const ORG_PDA_ARCHIVED = '00000000-0000-0000-0000-000000212008'; // a pharmacy_department_authority, archived

const U_EDIT = '00000000-0000-0000-0000-000000212401'; // full central_needs on owner
const U_NOPERM = '00000000-0000-0000-0000-000000212402'; // owner org, no keys
const U_OTHER = '00000000-0000-0000-0000-000000212403'; // central_warehouse_manager homed in a care institution, all keys
const U_INST = '00000000-0000-0000-0000-000000212404'; // institution_admin job title, active in the owning PDA, all keys
const U_OUTLET = '00000000-0000-0000-0000-000000212405'; // outlet_officer job title, active in the owning PDA, all keys
// FORWARD (M224) membership matrix: each differs from an authorized member in ONE dimension.
const U_PDA2 = '00000000-0000-0000-0000-000000212407'; // central_warehouse_manager of ANOTHER PDA, all keys
const U_SA_PDA2 = '00000000-0000-0000-0000-000000212408'; // super_admin homed in ANOTHER PDA, all keys
const U_SA_NOHOME = '00000000-0000-0000-0000-000000212409'; // super_admin with no home organization, all keys
const U_SUSP = '00000000-0000-0000-0000-000000212410'; // owning PDA, SUSPENDED, all keys
const U_ARCHIVED = '00000000-0000-0000-0000-000000212411'; // owning PDA, profile ARCHIVED, all keys
const U_ARCH_PDA = '00000000-0000-0000-0000-000000212412'; // member of an ARCHIVED PDA, all keys
const U_VIEW = '00000000-0000-0000-0000-000000212413'; // warehouse_officer, owning PDA: view only
const U_APPROVE = '00000000-0000-0000-0000-000000212414'; // warehouse_officer, owning PDA: view + approve, no edit
const U_CARE_ADMIN = '00000000-0000-0000-0000-000000212415'; // institution_admin homed in the beneficiary care institution, all keys
const U_EDITOR = '00000000-0000-0000-0000-000000212416'; // warehouse_officer, owning PDA: view + edit, no approve

const ALL_KEYS = ['view', 'import', 'edit', 'approve'];
const ROLE_CODE = { code: '42501', message: 'forbidden_central_needs_role' } as const;
const SCOPE_CODE = { code: '42501', message: 'forbidden_central_needs' } as const;

/** Local, opt-in historical-boundary replay; unset (the canonical full chain) everywhere else. */
const UP_TO = process.env.CN212_HISTORICAL_UP_TO === undefined
  ? Infinity : Number(process.env.CN212_HISTORICAL_UP_TO);
if (!(UP_TO === Infinity || Number.isInteger(UP_TO))) {
  throw new Error(`CN212_HISTORICAL_UP_TO must be an integer, got ${process.env.CN212_HISTORICAL_UP_TO}`);
}

const ITEM_A = '00000000-0000-0000-0000-000000212801';
const ITEM_B = '00000000-0000-0000-0000-000000212802';

const WH_BENE = '00000000-0000-0000-0000-000000212901'; // belongs to ORG_BENE
const WH_BENE_2 = '00000000-0000-0000-0000-000000212903'; // also ORG_BENE
const WH_FOREIGN = '00000000-0000-0000-0000-000000212902'; // belongs to ORG_BENE2
const WH_ARCHIVED = '00000000-0000-0000-0000-000000212904'; // ORG_BENE, archived
const WH_INACTIVE = '00000000-0000-0000-0000-000000212905'; // ORG_BENE, inactive

const PARSER_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};

const SET_NEED_LINE =
  'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)';
const DELETE_NEED_LINE = 'public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])';
const LIST_NEED_LINES = 'public.phoenix_central_needs_list_need_lines(uuid)';

interface Row {
  entity: string;
  item?: string | null;
  decision?: 'mapped' | 'not_applicable';
  /**
   * `beneficiary` is the institution whose PHYSICAL column this cell sits in
   * (default ORG_BENE). Same header + same beneficiary = one column; the same
   * header for a different beneficiary is a different physical column.
   */
  fields?: Array<{ name: string; value: unknown; beneficiary?: string; exactNumber?: boolean }>;
}

interface Refusal { code: string; message: string; detail?: string }

/** Resolves to the database error a call was refused with; fails the test if it succeeded. */
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

run('CN-2B/212 operational need lines — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  // One plan per scenario, unique per (organization, plan_year) and bounded by
  // central_needs_plans_plan_year_check (2000..2100): start at the floor for capacity.
  let year = 2000;
  let fileSeq = 0;
  /** True when the replayed chain carries 213's beneficiary-column contract (set in beforeAll). */
  let FORWARD = false;
  /** True when the replayed chain carries 216's beneficiary-region relation (set in beforeAll). */
  let REGIONS = false;
  /** True when the replayed chain carries C5/217's frozen numeric classifier (set in beforeAll). */
  let C5 = false;
  /** True when the replayed chain carries M224's membership authorization (set in beforeAll). */
  let M224 = false;

  /**
   * C5 §10 (217): designatedQuantity is judged LEXICALLY before any cast, so a
   * sign, NaN/Infinity or free text is refused as designated_quantity_not_canonical
   * ahead of M212's own numeric checks, which that grammar makes unreachable.
   */
  const designatedRefusal = (m212Code: string) => (C5 ? 'designated_quantity_not_canonical' : m212Code);

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  // R1-a: revision INSERTs are gated on an authorized actor (single authority predicate). The fixture
  // therefore inserts them inside a transaction that carries the plan-owning editor's JWT subject.
  const adminAsEditor = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
        const r = await c.query(sql, params);
        await c.query('COMMIT');
        return r.rows;
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
    });

  /**
   * One more completed import session in an existing revision. Each row carries
   * its own source records (cells) and its own canonical mapping decision, so
   * provenance is designated at the record level the way the real import
   * pipeline produces it.
   */
  async function addSession(revId: string, rows: Row[]) {
    fileSeq += 1;
    const hash = `${fileSeq}`.padStart(64, 'a');
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files
         (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [revId, ORG_OWNER, `needs-${fileSeq}.xls`, hash, 1024]);
    // M211 requires a completed session to carry its finalization evidence
    // (preview_digest = authoritative_digest, parser identity, completed_at).
    const digest = `${fileSeq}`.padStart(64, 'd');
    const [{ id: sessionId }] = await admin(
      `INSERT INTO central_needs_import_sessions
         (plan_revision_id, organization_id, source_file_id, status,
          preview_digest, authoritative_digest, parser_identity, completed_at)
       VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`,
      [revId, ORG_OWNER, fileId, digest, JSON.stringify(PARSER_IDENTITY)]);

    const records = new Map<string, string>();
    // This session's physical columns: one per distinct (sheet, header, beneficiary).
    const columns = new Map<string, { sheetIndex: number; columnIndex: number; beneficiary: string }>();
    let ordinal = 0;
    for (const row of rows) {
      const at = /^sheet:(\d+):row:(\d+)$/.exec(row.entity);
      const sheetIndex = at ? Number(at[1]) : 0;
      const rowIndex = at ? Number(at[2]) : ordinal;
      for (const f of row.fields ?? [{ name: 'final', value: 100 }]) {
        ordinal += 1;
        const beneficiary = f.beneficiary ?? ORG_BENE;
        const columnKey = `${sheetIndex} ${f.name} ${beneficiary}`;
        if (!columns.has(columnKey)) columns.set(columnKey, { sheetIndex, columnIndex: columns.size, beneficiary });
        const { columnIndex } = columns.get(columnKey)!;
        // CN-2A's own evidence and provenance shapes — the physical coordinate 213 keys on.
        const sourceValues = {
          value: f.value, valueType: typeof f.value === 'number' ? 'number' : 'string', isFormula: false, formula: null,
        };
        // `exactNumber`: a native NUMBER cell whose exact decimal text is written
        // into the jsonb literal itself (jsonb stores numbers as PostgreSQL
        // numeric), so no JS number ever rounds it — the C5 parser envelope.
        if (f.exactNumber && !/^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$/.test(String(f.value))) {
          throw new Error(`exactNumber fixture is not an exact decimal: ${String(f.value)}`);
        }
        const sourceValuesText = f.exactNumber
          ? `{"value":${String(f.value)},"valueType":"number","isFormula":false,"formula":null}`
          : JSON.stringify(sourceValues);
        const provenance = {
          fileFingerprintSha256: hash, originalFilename: `needs-${fileSeq}.xls`, parserVersion: '1.0.0',
          sheetIndex, sheetName: `Sheet${sheetIndex}`, sheetHidden: 'visible',
          coordinate: { row: rowIndex, col: columnIndex, a1: `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}` },
          extractedAt: '2026-01-01T00:00:00.000Z',
        };
        const [{ id }] = await admin(
          `INSERT INTO central_needs_source_records
             (import_session_id, organization_id, record_ordinal, target_entity, field_name,
              source_values, source_provenance)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,
          [sessionId, ORG_OWNER, ordinal, row.entity, f.name, sourceValuesText, JSON.stringify(provenance)]);
        records.set(`${row.entity}::${f.name}`, id);
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
    // Forward contract only: a human confirms each physical column's
    // beneficiary, through the real RPC, before any of its cells may feed a line.
    if (FORWARD) {
      await call(U_EDIT,
        `SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result`,
        [revId, JSON.stringify([...columns.values()].map((c) => ({
          importSessionId: sessionId, sheetIndex: c.sheetIndex, columnIndex: c.columnIndex,
          beneficiaryOrganizationId: c.beneficiary, previousBeneficiaryOrganizationId: null,
        }))), 'fixture: confirmed physical beneficiary column']);
    }
    return { sessionId, records };
  }

  /** A revision with one completed session. */
  async function scenario(opts: { status?: string; rows?: Row[] } = {}) {
    const y = year++;
    if (y > 2100) throw new Error('fixture capacity: plan_year 2000..2100 exhausted (one plan per scenario)');
    const rows: Row[] = opts.rows ?? [{
      entity: 'sheet:0:row:5',
      fields: [{ name: 'requested', value: 100 }, { name: 'final', value: 120 }],
    }];
    const [{ id: planId }] = await admin(
      `INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`,
      [ORG_OWNER, y]);
    // Always seeded as a DRAFT so its evidence (and, under 213, its column
    // confirmations) can be established; a non-draft status is applied after.
    const [{ id: revId }] = await adminAsEditor(
      `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
         VALUES ($1,$2,1,'draft') RETURNING id`,
      [planId, ORG_OWNER]);
    const { sessionId, records } = await addSession(revId, rows);
    if (opts.status && opts.status !== 'draft') {
      await admin(`UPDATE central_needs_plan_revisions SET status=$2 WHERE id=$1`, [revId, opts.status]);
    }
    return { planId, revId, sessionId, records, rows, year: y };
  }

  /**
   * C6-F1 (218): a direct DRAFT -> SUBMITTED write is refused by the submission
   * fence, so a fixture reaches SUBMITTED canonically, in every chain mode, as
   * the approved-revision fixture below does: its completed session registered
   * in a trusted batch, readiness proven empty, then the real submit RPC.
   */
  async function submitCanonically(s: { revId: string; sessionId: string; year: number }) {
    const [{ id: batchId }] = await admin(
      `INSERT INTO central_needs_import_batches
         (plan_revision_id, organization_id, container_kind, container_filename, container_sha256,
          storage_locator, accepted_entry_count, parser_identity)
       VALUES ($1,$2,'file','needs.xls',$3,'permanent/x',1,$4::jsonb) RETURNING id`,
      [s.revId, ORG_OWNER, `${s.year}`.padStart(64, 'c'), JSON.stringify(PARSER_IDENTITY)]);
    await admin(
      `INSERT INTO central_needs_import_batch_entries
         (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id)
       VALUES ($1,$2,$3,1,$4,$5)`,
      [batchId, s.revId, ORG_OWNER, `${s.year}`.padStart(64, 'e'), s.sessionId]);
    expect(await blockers(s.revId)).toEqual([]);
    expect(await call(U_EDIT, `SELECT public.phoenix_central_needs_submit_revision($1) AS result`, [s.revId]))
      .toMatchObject({ status: 'submitted' });
  }

  /** `[{ sourceRecordId, designatedQuantity, appliedOverrideId }]` as jsonb text. */
  const sources = (...items: Array<[string, string | number] | [string, string | number, string | null]>) =>
    JSON.stringify(items.map(([id, qty, override]) => ({
      sourceRecordId: id,
      designatedQuantity: typeof qty === 'number' ? qty : String(qty),
      appliedOverrideId: override ?? null,
    })));

  const setLine = (
    userId: string | null,
    revId: string,
    o: Partial<{
      beneficiary: string; item: string; qty: string | number; reason: string;
      unit: string | null; state: string; warehouse: string | null; sourceUnit: string | null;
      sources: string; expected: string[] | null;
    }> = {},
    role = 'authenticated',
  ) => call(userId,
    `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,$11) AS result`,
    // `'x' in o`, never `??`: a test that deliberately passes null must reach
    // the server as NULL rather than be turned into a default here.
    [revId, o.beneficiary ?? ORG_BENE, o.item ?? ITEM_A, 'qty' in o ? o.qty : 100, o.reason ?? 'mapped by reviewer',
      'sources' in o ? o.sources : '[]', 'expected' in o ? o.expected : [],
      o.unit === undefined ? 'box' : o.unit, o.state ?? 'canonical',
      o.warehouse ?? null, o.sourceUnit ?? null],
    role);

  const deleteLine = (
    userId: string | null, lineId: string, reason: string | null, expected: string[] | null, role = 'authenticated',
  ) => call(userId,
    `SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[]) AS result`,
    [lineId, reason, expected], role);

  /**
   * The RPC read exactly as PostgREST serializes it — json_agg over the function
   * result — returned as RAW TEXT and decoded with JSON.parse, which is what
   * supabase-js does. node-postgres would otherwise decode json itself.
   */
  const listAsClient = async (userId: string, revId: string) => {
    const body = await call(userId,
      `SELECT coalesce(json_agg(t), '[]'::json)::text AS result
         FROM public.phoenix_central_needs_list_need_lines($1) t`, [revId]);
    return JSON.parse(body as string) as Array<Record<string, any>>;
  };

  const linksOf = (lineId: string) => admin(
    `SELECT source_record_id, designated_quantity::text AS q
       FROM central_needs_need_line_sources WHERE need_line_id=$1 ORDER BY source_record_id`, [lineId]);

  const linesOf = (revId: string) => admin(
    `SELECT id, beneficiary_organization_id, central_item_id, target_warehouse_id,
            approved_quantity::text AS q
       FROM central_needs_need_lines WHERE plan_revision_id=$1 ORDER BY created_at, id`, [revId]);

  const blockers = (revId: string) =>
    admin(`SELECT blocker, detail FROM public._phoenix_central_needs_review_blockers_v1($1)`, [revId]);

  /**
   * Forward contract only: re-confirm the physical column a record sits in for
   * a different beneficiary, through the real RPC and its stale-view guard.
   */
  const remapColumnOf = async (revId: string, recordId: string, to: string, from: string) => {
    const [cell] = await admin(
      `SELECT import_session_id AS session,
              (source_provenance->>'sheetIndex')::int AS sheet,
              (source_provenance->'coordinate'->>'col')::int AS col
         FROM central_needs_source_records WHERE id=$1`, [recordId]);
    return call(U_EDIT,
      `SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result`,
      [revId, JSON.stringify([{
        importSessionId: cell.session, sheetIndex: cell.sheet, columnIndex: cell.col,
        beneficiaryOrganizationId: to, previousBeneficiaryOrganizationId: from,
      }]), 'fixture: beneficiary column corrected']);
  };

  const freshWarehouse = async (org = ORG_BENE) => {
    const [{ id }] = await admin(
      `INSERT INTO warehouses (organization_id, name, name_ar, status)
       VALUES ($1, 'CN212 WH ' || gen_random_uuid()::text, 'مخزن', 'active') RETURNING id`, [org]);
    return id as string;
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: UP_TO });
    // Which contract did the replay produce? Detected from the schema, then
    // cross-checked against the migration files the rig actually applied, so
    // the fixture mode can never silently disagree with the chain under test.
    const [{ present }] = await admin(
      `SELECT to_regprocedure('public.phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)') IS NOT NULL AS present`);
    const chainIncludes213 = migrationFiles(UP_TO).some((f: string) => f.startsWith('213_'));
    if (present !== chainIncludes213) {
      throw new Error(`fixture mode mismatch: 213 contract present=${present}, 213 applied=${chainIncludes213}`);
    }
    FORWARD = present;
    // 216 attaches the same deferred assertion to its region relation (C4 T2).
    const [{ regions }] = await admin(
      `SELECT to_regclass('public.central_needs_beneficiary_regions') IS NOT NULL AS regions`);
    const chainIncludes216 = migrationFiles(UP_TO).some((f: string) => f.startsWith('216_'));
    if (regions !== chainIncludes216) {
      throw new Error(`fixture mode mismatch: 216 relation present=${regions}, 216 applied=${chainIncludes216}`);
    }
    REGIONS = regions;
    // C5/217 carries the frozen numeric classifier; same cross-check.
    const [{ c5 }] = await admin(
      `SELECT to_regprocedure('public._phoenix_central_needs_review_numeric_class_v1(jsonb)') IS NOT NULL AS c5`);
    const chainIncludes217 = migrationFiles(UP_TO).some((f: string) => f.startsWith('217_'));
    if (c5 !== chainIncludes217) {
      throw new Error(`fixture mode mismatch: 217 classifier present=${c5}, 217 applied=${chainIncludes217}`);
    }
    C5 = c5;
    // M224 carries the single membership-based authority predicate; same cross-check.
    const [{ m224 }] = await admin(
      `SELECT to_regprocedure('phoenix_cn_policy.actor_scope_org(text)') IS NOT NULL AS m224`);
    const chainIncludes224 = migrationFiles(UP_TO).some((f: string) => f.startsWith('224_'));
    if (m224 !== chainIncludes224) {
      throw new Error(`fixture mode mismatch: 224 predicate present=${m224}, 224 applied=${chainIncludes224}`);
    }
    M224 = m224;
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_OWNER}','CN212-OWNER','مالك','p212-owner','pharmacy_department_authority',NULL),
        ('${ORG_BENE}','CN212-BENE','منتفع','p212-bene','care_institution','hospital'),
        ('${ORG_BENE2}','CN212-BENE2','منتفع٢','p212-bene2','care_institution','hospital'),
        ('${ORG_INACTIVE}','CN212-INACT','معطل','p212-inact','care_institution','hospital'),
        ('${ORG_OTHER}','CN212-OTHER','اخر','p212-other','care_institution','hospital'),
        ('${ORG_AUTHORITY}','CN212-AUTH','سلطة','p212-auth','pharmacy_department_authority',NULL),
        ('${ORG_PDA2}','CN212-PDA2','دائرة ثانية','p212-pda2','pharmacy_department_authority',NULL),
        ('${ORG_PDA_ARCHIVED}','CN212-PDA-ARCH','دائرة مؤرشفة','p212-pda-arch','pharmacy_department_authority',NULL)
        ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_EDIT}','p212-edit@rig'),('${U_NOPERM}','p212-noperm@rig'),
        ('${U_OTHER}','p212-other@rig'),('${U_INST}','p212-inst@rig'),('${U_OUTLET}','p212-outlet@rig'),
        ('${U_PDA2}','p212-pda2@rig'),('${U_SA_PDA2}','p212-sa-pda2@rig'),('${U_SA_NOHOME}','p212-sa-nohome@rig'),
        ('${U_SUSP}','p212-susp@rig'),('${U_ARCHIVED}','p212-archived@rig'),('${U_ARCH_PDA}','p212-arch-pda@rig'),
        ('${U_VIEW}','p212-view@rig'),('${U_APPROVE}','p212-approve@rig'),('${U_CARE_ADMIN}','p212-care-admin@rig'),
        ('${U_EDITOR}','p212-editor@rig')
        ON CONFLICT (id) DO NOTHING;`);

      for (const [u, org, role, status] of [
        [U_EDIT, ORG_OWNER, 'central_warehouse_manager', 'active'],
        [U_NOPERM, ORG_OWNER, 'central_warehouse_manager', 'active'],
        [U_OTHER, ORG_OTHER, 'central_warehouse_manager', 'active'],
        [U_INST, ORG_OWNER, 'institution_admin', 'active'],
        [U_OUTLET, ORG_OWNER, 'outlet_officer', 'active'],
        [U_PDA2, ORG_PDA2, 'central_warehouse_manager', 'active'],
        [U_SA_PDA2, ORG_PDA2, 'super_admin', 'active'],
        [U_SA_NOHOME, null, 'super_admin', 'active'],
        [U_SUSP, ORG_OWNER, 'central_warehouse_manager', 'suspended'],
        [U_ARCHIVED, ORG_OWNER, 'central_warehouse_manager', 'archived'],
        [U_ARCH_PDA, ORG_PDA_ARCHIVED, 'central_warehouse_manager', 'active'],
        [U_VIEW, ORG_OWNER, 'warehouse_officer', 'active'],
        [U_APPROVE, ORG_OWNER, 'warehouse_officer', 'active'],
        [U_CARE_ADMIN, ORG_BENE, 'institution_admin', 'active'],
        [U_EDITOR, ORG_OWNER, 'warehouse_officer', 'active'],
      ] as const) {
        await c.query(`UPDATE profiles SET role=$1,status=$4,organization_id=$2 WHERE id=$3`,
          [role, org, u, status]);
      }
      // Every user except U_NOPERM, U_VIEW, U_APPROVE and U_EDITOR holds every key, so
      // only the intended dimension (key, organization, membership or role class) refuses them.
      const keys: Array<[string, string[]]> = [
        ...[U_EDIT, U_OTHER, U_INST, U_OUTLET, U_PDA2, U_SA_PDA2, U_SA_NOHOME, U_SUSP, U_ARCHIVED,
          U_ARCH_PDA, U_CARE_ADMIN].map((u): [string, string[]] => [u, ALL_KEYS]),
        [U_VIEW, ['view']], [U_APPROVE, ['view', 'approve']], [U_EDITOR, ['view', 'edit']],
      ];
      for (const [u, ks] of keys) {
        for (const k of ks) {
          await c.query(
            `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
               ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`,
            [u, `central_needs.${k}`]);
        }
      }
      // ORG_PDA_ARCHIVED is archived through the real transition (active -> inactive stamps
      // archived_at, database-owned), after its member was assigned, never by writing archived_at.
      await c.query(`UPDATE organizations SET status='inactive' WHERE id='${ORG_PDA_ARCHIVED}'`);
      const [{ archived }] = (await c.query(
        `SELECT archived_at IS NOT NULL AS archived FROM organizations WHERE id='${ORG_PDA_ARCHIVED}'`)).rows;
      if (!archived) throw new Error('fixture: ORG_PDA_ARCHIVED was not archived by its status transition');

      await c.query(`INSERT INTO central_items (id,name,name_ar,unit) VALUES
        ('${ITEM_A}','Paracetamol 500mg','باراسيتامول','box'),
        ('${ITEM_B}','Amoxicillin 250mg','اموكسيسيلين','vial') ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status) VALUES
        ('${WH_BENE}','${ORG_BENE}','BENE WH','مخزن المنتفع','active'),
        ('${WH_BENE_2}','${ORG_BENE}','BENE WH 2','مخزن المنتفع٢','active'),
        ('${WH_FOREIGN}','${ORG_BENE2}','OTHER WH','مخزن اخر','active'),
        ('${WH_ARCHIVED}','${ORG_BENE}','BENE WH ARCHIVED','مخزن مؤرشف','active'),
        ('${WH_INACTIVE}','${ORG_BENE}','BENE WH INACTIVE','مخزن معطل','active')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE warehouses SET status='archived', archived_at=now(), archive_reason='rig'
                      WHERE id='${WH_ARCHIVED}'`);
      await c.query(`UPDATE warehouses SET status='inactive' WHERE id='${WH_INACTIVE}'`);

      await c.query(`UPDATE organizations SET status='inactive' WHERE id='${ORG_INACTIVE}'`);
    });
  }, 600000);

  afterAll(async () => { await rig?.end(); });

  // ---- A. SCHEMA AND SECURITY POSTURE ------------------------------------
  describe('A. schema and security posture', () => {
    it('creates both relations with RLS enabled and forced', async () => {
      const rows = await admin(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid IN ('public.central_needs_need_lines'::regclass,
                        'public.central_needs_need_line_sources'::regclass)
          ORDER BY relname`);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.relrowsecurity, r.relname).toBe(true);
        expect(r.relforcerowsecurity, r.relname).toBe(true);
      }
    });

    it('applies M211 role-class restriction to both relations as a RESTRICTIVE policy', async () => {
      const rows = await admin(
        `SELECT c.relname, p.polpermissive, pg_get_expr(p.polqual, p.polrelid) AS qual
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
          WHERE p.polrelid IN ('public.central_needs_need_lines'::regclass,
                               'public.central_needs_need_line_sources'::regclass)
            AND NOT p.polpermissive
            -- R1-a additive policies (candidates 02/05) are asserted in their own suites; the M211 one is still required exactly once per relation
            AND p.polname NOT IN ('r1_actor_scope_restrictive', 'excel_history_read_restrictive')
          ORDER BY c.relname`);
      expect(rows.map((r: any) => r.relname)).toEqual(
        ['central_needs_need_line_sources', 'central_needs_need_lines']);
      for (const r of rows) expect(r.qual, r.relname).toContain('_phoenix_central_needs_role_eligible_v1()');
    });

    it('stores BOTH quantities as unconstrained numeric — a typmod would round', async () => {
      const rows = await admin(
        `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
           FROM information_schema.columns
          WHERE table_schema='public'
            AND (table_name,column_name) IN
                (('central_needs_need_lines','approved_quantity'),
                 ('central_needs_need_line_sources','designated_quantity'))
          ORDER BY table_name`);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.data_type, r.table_name).toBe('numeric');
        expect(r.numeric_precision, r.table_name).toBeNull();
        expect(r.numeric_scale, r.table_name).toBeNull();
      }
    });

    it('keys the canonical line on revision + beneficiary + item + warehouse, NULLS NOT DISTINCT', async () => {
      const [{ def }] = await admin(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid='public.central_needs_need_lines'::regclass AND contype='u'
            AND conname='central_needs_need_lines_scope_key'`);
      expect(def).toBe(
        'UNIQUE NULLS NOT DISTINCT (plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id)');
    });

    it('lets one source RECORD (cell) feed at most one need line, structurally', async () => {
      const [{ def }] = await admin(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid='public.central_needs_need_line_sources'::regclass AND contype='u'
            AND conname='central_needs_need_line_sources_record_key'`);
      expect(def).toBe('UNIQUE (source_record_id)');
    });

    it('asserts NO row-level cardinality anywhere — the false one-row-one-line rule is gone', async () => {
      const [{ def }] = await admin(
        `SELECT pg_get_functiondef('public._phoenix_central_needs_assert_need_line_integrity_v1()'::regprocedure) AS def`);
      expect(def).not.toContain('source_row_split_across_need_lines');
      const [{ n }] = await admin(
        `SELECT count(*)::int AS n FROM pg_constraint
          WHERE conrelid='public.central_needs_need_line_sources'::regclass AND contype='u'`);
      expect(n).toBe(1); // only UNIQUE (source_record_id)
    });

    it('carries the deferred integrity assertion on both tables', async () => {
      const rows = await admin(
        `SELECT c.relname, t.tgdeferrable, t.tginitdeferred, t.tgconstraint <> 0 AS is_constraint
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE t.tgname='assert_need_line_integrity' AND NOT t.tgisinternal
          ORDER BY c.relname`);
      // 213 attaches the SAME deferred assertion to its mapping table as well;
      // each chain asserts its own exact attachment set.
      expect(rows.map((r: any) => r.relname)).toEqual(FORWARD
        ? ['central_needs_beneficiary_column_mappings',
           ...(REGIONS ? ['central_needs_beneficiary_regions'] : []),
           'central_needs_need_line_sources', 'central_needs_need_lines']
        : ['central_needs_need_line_sources', 'central_needs_need_lines']);
      for (const r of rows) {
        expect(r.tgdeferrable, r.relname).toBe(true);
        expect(r.tginitdeferred, r.relname).toBe(true);
        expect(r.is_constraint, r.relname).toBe(true);
      }
    });

    it('grants authenticated SELECT only — no direct write path', async () => {
      const rows = await admin(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee='authenticated' AND table_schema='public'
            AND table_name IN ('central_needs_need_lines','central_needs_need_line_sources')
          ORDER BY privilege_type`);
      expect([...new Set(rows.map((r: any) => r.privilege_type))]).toEqual(['SELECT']);
    });

    it('pins search_path on every function it defines; only the read is SECURITY INVOKER', async () => {
      const rows = await admin(
        `SELECT p.proname, p.proconfig, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN (
            'phoenix_central_needs_set_need_line',
            'phoenix_central_needs_delete_need_line',
            'phoenix_central_needs_list_need_lines',
            '_phoenix_central_needs_assert_beneficiary_v1',
            '_phoenix_central_needs_assert_need_line_integrity_v1')
          ORDER BY p.proname`);
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        expect(r.proconfig, r.proname).toContain('search_path=public, pg_temp');
        expect(r.prosecdef, r.proname).toBe(r.proname !== 'phoenix_central_needs_list_need_lines');
      }
    });
  });

  // ---- B. EXACT QUANTITY CONTRACT ----------------------------------------
  describe('B. quantity and unit contract', () => {
    it('accepts zero as a valid approved quantity', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: 0, sources: sources([id, '0']) });
      expect(r.ok).toBe(true);
      const [row] = await admin(
        `SELECT approved_quantity::text AS q FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.q).toBe('0');
    });

    it('PRESERVES a 4-decimal quantity exactly — the old numeric(20,3) would have rounded it', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: '120.1239', sources: sources([id, '120.1239']) });
      const [row] = await admin(
        `SELECT approved_quantity::text AS q, scale(approved_quantity) AS s
           FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.q).toBe('120.1239');
      expect(row.s).toBe(4);
      // The contrast this test exists for: what a declared scale would have done.
      const [{ rounded }] = await admin(`SELECT '120.1239'::numeric(20,3)::text AS rounded`);
      expect(rounded).toBe('120.124');
      expect(row.q).not.toBe(rounded);
      const [link] = await linksOf(r.need_line_id);
      expect(link.q).toBe('120.1239');
    });

    it('rejects a negative quantity', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: -1, sources: sources([id, '-1']) })))
        .toMatchObject({ code: '23514', message: 'approved_quantity_must_not_be_negative' });
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: 1, sources: sources([id, '-1']) })))
        .toMatchObject({ code: '23514', message: designatedRefusal('designated_quantity_must_not_be_negative') });
    });

    it('rejects a missing quantity — blank is not zero', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: null as unknown as number, sources: sources([id, '0']) })))
        .toMatchObject({ code: '23514', message: 'approved_quantity_required' });
    });

    it('rejects NaN and Infinity rather than storing a non-finite quantity', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: 'NaN', sources: sources([id, 'NaN']) })))
        .toMatchObject({ code: '23514', message: 'approved_quantity_must_be_finite' });
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: 'Infinity', sources: sources([id, 'Infinity']) })))
        .toMatchObject({ code: '23514', message: 'approved_quantity_must_be_finite' });
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: 1, sources: sources([id, 'NaN']) })))
        .toMatchObject({ code: '23514', message: designatedRefusal('designated_quantity_must_be_finite') });
    });

    it('refuses a non-numeric designated contribution instead of coercing it', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, {
        qty: 100,
        sources: JSON.stringify([{ sourceRecordId: id, designatedQuantity: '12 boxes' }]),
      }))).toMatchObject({ code: '23514', message: designatedRefusal('designated_quantity_not_numeric') });
    });

    it('refuses a unit outside the canonical central_items vocabulary', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await refusal(setLine(U_EDIT, s.revId, { unit: 'crate', sources: sources([id, '100']) }));
      expect(r.code).toBe('23514');
      expect(r.message).toContain('central_needs_need_lines_unit_vocab_chk');
    });

    it('requires a canonical unit when the state is canonical', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, { unit: null, sources: sources([id, '100']) })))
        .toMatchObject({ code: '23514', message: 'canonical_unit_required' });
    });

    it('refuses a guessed conversion: conversion_required must carry no unit', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, {
        state: 'conversion_required', unit: 'box', sources: sources([id, '100']),
      }))).toMatchObject({ code: '23514', message: 'conversion_required_must_not_carry_unit' });
    });

    it('accepts conversion_required with no unit and keeps the source unit as evidence', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, {
        state: 'conversion_required', unit: null, sourceUnit: 'علبة ٢٠ قرص',
        sources: sources([id, '100']),
      });
      const [row] = await admin(
        `SELECT approved_unit, unit_conversion_state, source_unit_text
           FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.approved_unit).toBeNull();
      expect(row.unit_conversion_state).toBe('conversion_required');
      expect(row.source_unit_text).toBe('علبة ٢٠ قرص');
    });
  });

  // ---- C. BENEFICIARY AND WAREHOUSE (incl. review Q2) --------------------
  describe('C. beneficiary and target warehouse', () => {
    const one = async () => {
      const s = await scenario();
      return { s, id: s.records.get('sheet:0:row:5::final')! };
    };

    it('persists the beneficiary as a dimension distinct from the owning org', async () => {
      const { s, id } = await one();
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      const [row] = await admin(
        `SELECT organization_id, beneficiary_organization_id FROM central_needs_need_lines WHERE id=$1`,
        [r.need_line_id]);
      expect(row.organization_id).toBe(ORG_OWNER);
      expect(row.beneficiary_organization_id).toBe(ORG_BENE);
    });

    it('refuses a beneficiary that is not a care institution', async () => {
      const { s, id } = await one();
      expect(await refusal(setLine(U_EDIT, s.revId, { beneficiary: ORG_AUTHORITY, sources: sources([id, '100']) })))
        .toMatchObject({ code: '23514', message: 'beneficiary_must_be_care_institution' });
    });

    it('refuses an inactive beneficiary', async () => {
      const { s, id } = await one();
      expect(await refusal(setLine(U_EDIT, s.revId, { beneficiary: ORG_INACTIVE, sources: sources([id, '100']) })))
        .toMatchObject({ code: '23514', message: 'beneficiary_organization_not_active' });
    });

    it('treats target_warehouse_id as optional (institution-level need)', async () => {
      const { s, id } = await one();
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      const [row] = await admin(
        `SELECT target_warehouse_id FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.target_warehouse_id).toBeNull();
    });

    it('PASSES an ACTIVE warehouse owned by the beneficiary', async () => {
      const { s, id } = await one();
      const r = await setLine(U_EDIT, s.revId, { warehouse: WH_BENE, sources: sources([id, '100']) });
      const [row] = await admin(
        `SELECT target_warehouse_id FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id]);
      expect(row.target_warehouse_id).toBe(WH_BENE);
    });

    it('REFUSES an ARCHIVED warehouse, even though the beneficiary owns it', async () => {
      const { s, id } = await one();
      const r = await refusal(setLine(U_EDIT, s.revId, { warehouse: WH_ARCHIVED, sources: sources([id, '100']) }));
      expect(r).toMatchObject({ code: '23514', message: 'target_warehouse_not_active' });
      expect(r.detail).toBe(`warehouse=${WH_ARCHIVED} status=archived`);
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('REFUSES an INACTIVE warehouse, even though the beneficiary owns it', async () => {
      const { s, id } = await one();
      const r = await refusal(setLine(U_EDIT, s.revId, { warehouse: WH_INACTIVE, sources: sources([id, '100']) }));
      expect(r).toMatchObject({ code: '23514', message: 'target_warehouse_not_active' });
      expect(r.detail).toBe(`warehouse=${WH_INACTIVE} status=inactive`);
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('REFUSES a warehouse belonging to another organization', async () => {
      const { s, id } = await one();
      expect(await refusal(setLine(U_EDIT, s.revId, { warehouse: WH_FOREIGN, sources: sources([id, '100']) })))
        .toMatchObject({ code: '23514', message: 'target_warehouse_not_owned_by_beneficiary' });
    });
  });

  // ---- D. AUTHORIZATION — exact codes -----------------------------------
  describe('D. authorization', () => {
    const one = async () => {
      const s = await scenario();
      return { s, id: s.records.get('sheet:0:row:5::final')! };
    };

    it('allows a central warehouse manager holding central_needs.edit', async () => {
      const { s, id } = await one();
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect(r.ok).toBe(true);
    });

    it('refuses an unauthenticated caller with not_authenticated / 28000', async () => {
      const { s, id } = await one();
      expect(await refusal(setLine(null, s.revId, { sources: sources([id, '100']) })))
        .toMatchObject({ code: '28000', message: 'not_authenticated' });
    });

    it('denies a user in the owning org holding no central_needs key — 42501 forbidden_central_needs', async () => {
      const { s, id } = await one();
      expect(await refusal(setLine(U_NOPERM, s.revId, { sources: sources([id, '100']) })))
        .toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('HISTORICAL (pre-M224 role class): denies a user from a different organization — 42501 forbidden_central_needs', async (ctx) => {
      if (M224) ctx.skip();
      const { s, id } = await one();
      expect(await refusal(setLine(U_OTHER, s.revId, { sources: sources([id, '100']) })))
        .toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
    });

    it('HISTORICAL (pre-M224 role class): denies institution_admin and outlet_officer even holding every key — 42501 forbidden_central_needs_role', async (ctx) => {
      if (M224) ctx.skip();
      const { s, id } = await one();
      expect(await refusal(setLine(U_INST, s.revId, { sources: sources([id, '100']) })))
        .toMatchObject({ code: '42501', message: 'forbidden_central_needs_role' });
      expect(await refusal(setLine(U_OUTLET, s.revId, { sources: sources([id, '100']) })))
        .toMatchObject({ code: '42501', message: 'forbidden_central_needs_role' });
    });

    it('FORWARD (M224): ordinary active staff of the owning PDA succeed whatever their job title — institution_admin and outlet_officer holding central_needs.edit', async (ctx) => {
      if (!M224) ctx.skip();
      // One revision, one row per member (two materials), so each line is that member's own write.
      const s = await scenario({ rows: [
        { entity: 'sheet:0:row:5', fields: [{ name: 'final', value: 100 }] },
        { entity: 'sheet:0:row:6', item: ITEM_B, fields: [{ name: 'final', value: 100 }] },
      ] });
      const written: string[] = [];
      for (const [u, entity, item, unit] of [
        [U_INST, 'sheet:0:row:5', ITEM_A, 'box'], [U_OUTLET, 'sheet:0:row:6', ITEM_B, 'vial'],
      ] as const) {
        const r = await setLine(u, s.revId, { item, unit, sources: sources([s.records.get(`${entity}::final`)!, '100']) });
        expect(r.ok, u).toBe(true);
        written.push(r.need_line_id);
        const [line] = await admin(`SELECT mapped_by, approved_quantity::text AS q FROM central_needs_need_lines WHERE id=$1`,
          [r.need_line_id]);
        expect(line, u).toEqual({ mapped_by: u, q: '100' });
        const [log] = await admin(
          `SELECT actor_id FROM audit_logs WHERE action='central_needs.need_line.set' AND entity_id=$1`, [r.need_line_id]);
        expect(log.actor_id, u).toBe(u);
      }
      expect((await linesOf(s.revId)).map((l: any) => l.id).sort()).toEqual([...written].sort());
    });

    it('FORWARD (M224): a member of ANOTHER live PDA holding every key is refused by scope — forbidden_central_needs — and so is a super_admin homed there: no cross-organization bypass', async (ctx) => {
      if (!M224) ctx.skip();
      const { s, id } = await one();
      for (const u of [U_PDA2, U_SA_PDA2]) {
        expect(await refusal(setLine(u, s.revId, { sources: sources([id, '100']) })), u).toMatchObject(SCOPE_CODE);
      }
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('FORWARD (M224): a care-institution member holding every key is refused by membership first — forbidden_central_needs_role', async (ctx) => {
      if (!M224) ctx.skip();
      const { s, id } = await one();
      for (const u of [U_OTHER, U_CARE_ADMIN]) {
        const e = await refusal(setLine(u, s.revId, { sources: sources([id, '100']) }));
        expect(e, u).toMatchObject(ROLE_CODE);
        expect(e.detail, u).toContain('not an active member of a live pharmacy_department_authority');
      }
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('FORWARD (M224): suspended, archived, home-less and archived-PDA members holding every key are refused by membership — forbidden_central_needs_role — writing nothing', async (ctx) => {
      if (!M224) ctx.skip();
      const { s, id } = await one();
      for (const u of [U_SUSP, U_ARCHIVED, U_SA_NOHOME, U_ARCH_PDA]) {
        expect(await refusal(setLine(u, s.revId, { sources: sources([id, '100']) })), u).toMatchObject(ROLE_CODE);
      }
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('FORWARD (M224): keys are independent — view-only and approve-without-edit members of the owning PDA cannot write a line (forbidden_central_needs)', async (ctx) => {
      if (!M224) ctx.skip();
      const { s, id } = await one();
      for (const u of [U_VIEW, U_APPROVE]) {
        expect(await refusal(setLine(u, s.revId, { sources: sources([id, '100']) })), u).toMatchObject(SCOPE_CODE);
      }
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('keeps the internal helpers off the client surface', async () => {
      const rows = await admin(
        `SELECT p.proname,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN (
            '_phoenix_central_needs_assert_beneficiary_v1',
            '_phoenix_central_needs_assert_need_line_integrity_v1')`);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.auth_exec, r.proname).toBe(false);
        expect(r.anon_exec, r.proname).toBe(false);
      }
    });

    it('denies anon every need-line RPC, by privilege and in practice', async () => {
      for (const fn of [SET_NEED_LINE, DELETE_NEED_LINE, LIST_NEED_LINES]) {
        const [{ ok }] = await admin(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') AS ok`);
        expect(ok, fn).toBe(false);
      }
      const { s, id } = await one();
      expect(await refusal(setLine(null, s.revId, { sources: sources([id, '100']) }, 'anon')))
        .toMatchObject({ code: '42501', message: 'permission denied for function phoenix_central_needs_set_need_line' });
    });

    it('refuses direct authenticated INSERT, UPDATE and DELETE on both tables — 42501', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(call(U_EDIT,
        `INSERT INTO central_needs_need_lines
           (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
            approved_quantity, approved_unit, mapping_reason)
         VALUES ($1,$2,$3,$4,1,'box','direct') RETURNING id AS result`,
        [s.revId, ORG_OWNER, ORG_BENE, ITEM_A])))
        .toMatchObject({ code: '42501', message: 'permission denied for table central_needs_need_lines' });

      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect(await refusal(call(U_EDIT,
        `DELETE FROM central_needs_need_lines WHERE id=$1`, [r.need_line_id])))
        .toMatchObject({ code: '42501', message: 'permission denied for table central_needs_need_lines' });
      expect(await refusal(call(U_EDIT,
        `UPDATE central_needs_need_lines SET approved_quantity=1 WHERE id=$1`, [r.need_line_id])))
        .toMatchObject({ code: '42501', message: 'permission denied for table central_needs_need_lines' });
      expect(await refusal(call(U_EDIT,
        `DELETE FROM central_needs_need_line_sources WHERE need_line_id=$1`, [r.need_line_id])))
        .toMatchObject({ code: '42501', message: 'permission denied for table central_needs_need_line_sources' });
      expect(await linksOf(r.need_line_id)).toHaveLength(1);
    });
  });

  // ---- E. REVISION LIFECYCLE --------------------------------------------
  describe('E. revision lifecycle', () => {
    it('refuses mapping on a non-draft revision — plan_revision_not_editable', async () => {
      // C6-F1 (218): submitted canonically — the one mapped cell feeds its line,
      // which makes the revision READY — never by a direct UPDATE.
      const s = await scenario({ rows: [{ entity: 'sheet:0:row:5', fields: [{ name: 'final', value: 100 }] }] });
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      await submitCanonically(s);
      expect(await refusal(setLine(U_EDIT, s.revId, { sources: sources([id, '100']) })))
        .toMatchObject({ code: '23514', message: 'plan_revision_not_editable' });
    });

    it('NEVER retroactively invalidates an already-approved revision', async () => {
      // An approved revision with a mapped row and no need line at all — exactly
      // the shape a revision approved before M212 has.
      //
      // C5 §16/§18: on the 217 chain a direct UPDATE into 'approved' is refused by
      // the approval-gate fence, so the approval is reached canonically, in every
      // chain mode. The one row is first dispositioned not_applicable, which makes
      // the revision READY with no need line; its session is registered in a
      // trusted batch, and it is submitted and approved through the real RPCs.
      // Only then is the row re-dispositioned 'mapped' with privilege (the
      // canonical mapping is mutable by design, M210 — see G), which yields that
      // exact shape on an approval the fence admitted.
      const s = await scenario({
        rows: [{ entity: 'sheet:0:row:5', decision: 'not_applicable', fields: [{ name: 'final', value: 100 }] }],
      });
      const id = s.records.get('sheet:0:row:5::final')!;
      const [{ id: batchId }] = await admin(
        `INSERT INTO central_needs_import_batches
           (plan_revision_id, organization_id, container_kind, container_filename, container_sha256,
            storage_locator, accepted_entry_count, parser_identity)
         VALUES ($1,$2,'file','needs.xls',$3,'permanent/x',1,$4::jsonb) RETURNING id`,
        [s.revId, ORG_OWNER, `${s.year}`.padStart(64, 'c'), JSON.stringify(PARSER_IDENTITY)]);
      await admin(
        `INSERT INTO central_needs_import_batch_entries
           (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id)
         VALUES ($1,$2,$3,1,$4,$5)`,
        [batchId, s.revId, ORG_OWNER, `${s.year}`.padStart(64, 'e'), s.sessionId]);
      expect(await blockers(s.revId)).toEqual([]);
      expect(await call(U_EDIT, `SELECT public.phoenix_central_needs_submit_revision($1) AS result`, [s.revId]))
        .toMatchObject({ status: 'submitted' });
      expect(await call(U_EDIT, `SELECT public.phoenix_central_needs_approve_revision($1) AS result`, [s.revId]))
        .toMatchObject({ ok: true, status: 'approved' });
      await admin(
        `UPDATE central_needs_record_mappings
            SET decision='mapped', central_item_id=$2, decision_reason=NULL
          WHERE import_session_id=$1 AND target_entity='sheet:0:row:5'`, [s.sessionId, ITEM_A]);

      expect(await linesOf(s.revId)).toHaveLength(0);

      // The approval stands, and the blockers function is not consulted by the
      // approve path at all — the only callers are the submit gate (draft-only)
      // and the read-only readiness query.
      const [{ status }] = await admin(
        `SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [s.revId]);
      expect(status).toBe('approved');
      const callers = await admin(
        // prokind='f': pg_get_functiondef raises on an aggregate.
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.prokind='f'
            AND pg_get_functiondef(p.oid) LIKE '%_phoenix_central_needs_review_blockers_v1%'
            AND p.proname <> '_phoenix_central_needs_review_blockers_v1'
          ORDER BY p.proname`);
      expect(callers.map((r: any) => r.proname)).toEqual(
        ['phoenix_central_needs_review_readiness', 'phoenix_central_needs_submit_revision']);
      // And mapping an approved revision is refused, so history cannot be
      // rewritten in place either.
      expect(await refusal(setLine(U_EDIT, s.revId, { sources: sources([id, '100']) })))
        .toMatchObject({ code: '23514', message: 'plan_revision_not_editable' });
    });

    it('FORWARD (M224): approving needs central_needs.approve — an ordinary editor without it is refused, an ordinary member holding it approves', async (ctx) => {
      if (!M224) ctx.skip();
      const s = await scenario({ rows: [{ entity: 'sheet:0:row:5', fields: [{ name: 'final', value: 100 }] }] });
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDITOR, s.revId, { sources: sources([id, '100']) });
      await submitCanonically(s);
      const approve = (u: string) => call(u, `SELECT public.phoenix_central_needs_approve_revision($1) AS result`, [s.revId]);
      expect(await refusal(approve(U_EDITOR))).toMatchObject(SCOPE_CODE);
      const [{ status: still }] = await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [s.revId]);
      expect(still).toBe('submitted');
      expect(await approve(U_APPROVE)).toMatchObject({ ok: true, status: 'approved' });
      const [{ approved_by }] = await admin(`SELECT approved_by FROM central_needs_plan_revisions WHERE id=$1`, [s.revId]);
      expect(approved_by).toBe(U_APPROVE);
    });

    it('FORWARD (M224): Excel-revision separation of duties is disabled by Q-E — no current migration enables it; the manual path refuses self-approval (suite 224)', async (ctx) => {
      if (!M224) ctx.skip();
      // M225 (SOD-8 / Q-E) ships Excel SoD DISABLED on this full chain, including M229: the approve path above admits a
      // submitter who also holds approve. Pinning the switch and its single use makes a silent flip,
      // or a silent loss of the manual-path refusal, fail here instead of passing unnoticed.
      const [{ enabled }] = await admin(`SELECT phoenix_cn_policy.excel_sod_enabled() AS enabled`);
      expect(enabled).toBe(false);
      const defs = await admin(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prokind='f' AND pg_get_functiondef(p.oid) LIKE '%OLD.source_mode = ''manual'' OR phoenix_cn_policy.excel_sod_enabled()%'
            AND pg_get_functiondef(p.oid) LIKE '%central_needs_separation_of_duties_violation%'`);
      expect(defs.length).toBeGreaterThan(0);
    });
  });

  // ---- F. MANDATORY SOURCE LINEAGE --------------------------------------
  describe('F. source lineage is mandatory', () => {
    it('refuses an EMPTY designated-source array', async () => {
      const s = await scenario();
      expect(await refusal(setLine(U_EDIT, s.revId, { sources: '[]' })))
        .toMatchObject({ code: '23514', message: 'need_line_requires_source_lineage' });
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('refuses a NULL designated-source array', async () => {
      const s = await scenario();
      expect(await refusal(setLine(U_EDIT, s.revId, { sources: null as unknown as string })))
        .toMatchObject({ code: '23514', message: 'quantity_sources_must_be_array' });
    });

    it('refuses a NULL expected lineage — every writer must state what it saw', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, { sources: sources([id, '100']), expected: null })))
        .toMatchObject({ code: '23514', message: 'expected_source_record_ids_required' });
    });

    it('has NO overload that omits the provenance or the expected lineage', async () => {
      const s = await scenario();
      expect((await refusal(call(U_EDIT,
        `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5) AS result`,
        [s.revId, ORG_BENE, ITEM_A, 100, 'no lineage']))).code).toBe('42883');
      expect((await refusal(call(U_EDIT,
        `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6::jsonb) AS result`,
        [s.revId, ORG_BENE, ITEM_A, 100, 'no expected lineage', '[]']))).code).toBe('42883');
      const rows = await admin(
        `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
          WHERE ns.nspname='public' AND p.proname IN
            ('phoenix_central_needs_set_need_line','phoenix_central_needs_delete_need_line')
          ORDER BY p.proname`);
      expect(rows).toHaveLength(2);
    });

    it('refuses an orphan line even when inserted with full privileges', async () => {
      const s = await scenario();
      expect(await refusal(admin(
        `INSERT INTO central_needs_need_lines
           (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
            approved_quantity, approved_unit, mapping_reason)
         VALUES ($1,$2,$3,$4,5,'box','privileged orphan')`,
        [s.revId, ORG_OWNER, ORG_BENE, ITEM_A])))
        .toMatchObject({ code: '23514', message: 'need_line_requires_source_lineage' });
    });

    it('refuses DELETING the last link of an existing line, even with full privileges', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect(await refusal(admin(
        `DELETE FROM central_needs_need_line_sources WHERE need_line_id=$1`, [r.need_line_id])))
        .toMatchObject({ code: '23514', message: 'need_line_requires_source_lineage' });
    });

    it('refuses a source record that belongs to another revision', async () => {
      const a = await scenario();
      const b = await scenario();
      const foreign = b.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, a.revId, { sources: sources([foreign, '100']) })))
        .toMatchObject({ code: '23514', message: 'source_link_session_not_in_revision' });
    });

    it('refuses a source record whose row was dispositioned not_applicable', async () => {
      const s = await scenario({
        rows: [{ entity: 'sheet:0:row:9', decision: 'not_applicable', fields: [{ name: 'final', value: 10 }] }],
      });
      const id = s.records.get('sheet:0:row:9::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, { sources: sources([id, '10']) })))
        .toMatchObject({ code: '23514', message: 'source_link_requires_mapped_disposition' });
    });

    it('refuses a source record that does not exist', async () => {
      const s = await scenario();
      expect(await refusal(setLine(U_EDIT, s.revId, {
        sources: sources(['00000000-0000-0000-0000-0000000000ff', '10']),
      }))).toMatchObject({ code: '23503', message: 'source_record_not_found' });
    });
  });

  // ---- G. CANONICAL MATERIAL CONSISTENCY --------------------------------
  describe('G. canonical material consistency', () => {
    it('HARD REJECTS a need line for ITEM_B fed by a source mapped to ITEM_A', async () => {
      const s = await scenario(); // row mapped to ITEM_A
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, { item: ITEM_B, sources: sources([id, '100']) })))
        .toMatchObject({ code: '23514', message: 'source_link_material_mismatch' });
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('rejects the same mismatch when inserted with full privileges, at COMMIT', async () => {
      const s = await scenario(); // mapped to ITEM_A
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          const { rows } = await c.query(
            `INSERT INTO central_needs_need_lines
               (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
                approved_quantity, approved_unit, mapping_reason)
             VALUES ($1,$2,$3,$4,7,'box','privileged mismatch') RETURNING id`,
            [s.revId, ORG_OWNER, ORG_BENE, ITEM_B]);
          await c.query(
            `INSERT INTO central_needs_need_line_sources
               (need_line_id, organization_id, source_record_id, designated_quantity)
             VALUES ($1,$2,$3,7)`,
            [rows[0].id, ORG_OWNER, id]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        }
      }))).toMatchObject({ code: '23514', message: 'need_line_material_mapping_conflict' });
    });

    it('accepts two lines for two materials when each row is mapped to its own', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', item: ITEM_A, fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', item: ITEM_B, fields: [{ name: 'final', value: 20 }] },
        ],
      });
      const a = await setLine(U_EDIT, s.revId, {
        item: ITEM_A, qty: 10, sources: sources([s.records.get('sheet:0:row:1::final')!, '10']),
      });
      const b = await setLine(U_EDIT, s.revId, {
        item: ITEM_B, qty: 20, unit: 'vial', sources: sources([s.records.get('sheet:0:row:2::final')!, '20']),
      });
      expect(a.need_line_id).not.toBe(b.need_line_id);
    });

    it('surfaces a LATER re-mapping as a review blocker instead of rewriting the line', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .not.toContain('need_line_material_mapping_divergent');

      // The canonical mapping is mutable by design (M210). Re-map the row.
      await admin(
        `UPDATE central_needs_record_mappings SET central_item_id=$1 WHERE import_session_id=$2`,
        [ITEM_B, s.sessionId]);

      const after = await blockers(s.revId);
      expect(after.map((b: any) => b.blocker)).toContain('need_line_material_mapping_divergent');
      // The approved line itself is untouched — nothing silently followed.
      const [line] = await linesOf(s.revId);
      expect(line.central_item_id).toBe(ITEM_A);
    });
  });

  // ---- H. QUANTITY PROVENANCE -------------------------------------------
  describe('H. approved-quantity provenance', () => {
    it('refuses a total that is not the sum of its designated contributions', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: '200', sources: sources([id, '120']) })))
        .toMatchObject({ code: '23514', message: 'need_line_quantity_provenance_mismatch' });
    });

    it('preserves N -> 1 provenance: every contributing record and its exact share', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 5.5 }] },
          { entity: 'sheet:0:row:3', fields: [{ name: 'final', value: 0.25 }] },
        ],
      });
      const ids = ['sheet:0:row:1::final', 'sheet:0:row:2::final', 'sheet:0:row:3::final']
        .map((k) => s.records.get(k)!);
      const r = await setLine(U_EDIT, s.revId, {
        qty: '15.75',
        sources: sources([ids[0], '10'], [ids[1], '5.5'], [ids[2], '0.25']),
      });
      expect(r.source_link_count).toBe(3);
      const links = await admin(
        `SELECT designated_quantity::text AS q
           FROM central_needs_need_line_sources WHERE need_line_id=$1
          ORDER BY designated_quantity`, [r.need_line_id]);
      expect(links.map((l: any) => l.q)).toEqual(['0.25', '5.5', '10']);
      const [{ proven }] = await admin(
        `SELECT (n.approved_quantity = (SELECT sum(designated_quantity)
                                          FROM central_needs_need_line_sources
                                         WHERE need_line_id = n.id)) AS proven
           FROM central_needs_need_lines n WHERE n.id=$1`, [r.need_line_id]);
      expect(proven).toBe(true);
    });

    it('designates ONE cell of a multi-quantity row — the row alone is not the provenance', async () => {
      const s = await scenario({
        rows: [{
          entity: 'sheet:0:row:7',
          fields: [{ name: 'requested', value: 900 }, { name: 'final', value: 120 }],
        }],
      });
      const finalCell = s.records.get('sheet:0:row:7::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: '120', sources: sources([finalCell, '120']) });
      const [link] = await admin(
        `SELECT r.field_name FROM central_needs_need_line_sources ls
           JOIN central_needs_source_records r ON r.id = ls.source_record_id
          WHERE ls.need_line_id=$1`, [r.need_line_id]);
      expect(link.field_name).toBe('final');
    });

    it('pins a field override the reviewer relied on, and validates it belongs to that record', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      // M210 made source_record_id NOT NULL: an override corrects one exact record.
      const [{ id: overrideId }] = await admin(
        `INSERT INTO central_needs_field_overrides
           (plan_revision_id, organization_id, source_record_id, target_entity, field_name,
            final_value, override_reason)
         VALUES ($1,$2,$3,'sheet:0:row:5','final','130'::jsonb,'committee correction') RETURNING id`,
        [s.revId, ORG_OWNER, id]);
      // An override of a DIFFERENT record cannot be pinned to this one.
      const other = s.records.get('sheet:0:row:5::requested')!;
      const [{ id: wrongOverride }] = await admin(
        `INSERT INTO central_needs_field_overrides
           (plan_revision_id, organization_id, source_record_id, target_entity, field_name,
            final_value, override_reason)
         VALUES ($1,$2,$3,'sheet:0:row:5','requested','999'::jsonb,'unrelated') RETURNING id`,
        [s.revId, ORG_OWNER, other]);
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: '130', sources: sources([id, '130', wrongOverride]) })))
        .toMatchObject({ code: '23514', message: 'applied_override_does_not_match_source_record' });

      const r = await setLine(U_EDIT, s.revId, { qty: '130', sources: sources([id, '130', overrideId]) });
      const [link] = await admin(
        `SELECT applied_override_id FROM central_needs_need_line_sources WHERE need_line_id=$1`,
        [r.need_line_id]);
      expect(link.applied_override_id).toBe(overrideId);
    });

    it('writes the provenance into the audit payload', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: '120.1239', sources: sources([id, '120.1239']) });
      const [log] = await admin(
        `SELECT payload FROM audit_logs
          WHERE action='central_needs.need_line.set' AND entity_id=$1
          ORDER BY created_at DESC LIMIT 1`, [r.need_line_id]);
      expect(log.payload.operation).toBe('created');
      expect(log.payload.approved_quantity).toBe('120.1239');
      expect(log.payload.designated_sum).toBe('120.1239');
      expect(log.payload.source_link_count).toBe(1);
      expect(log.payload.previous_source_record_ids).toEqual([]);
      expect(log.payload.quantity_sources).toHaveLength(1);
      expect(log.payload.quantity_sources[0].source_record_id).toBe(id);
      expect(log.payload.quantity_sources[0].designated_quantity).toBe('120.1239');
    });
  });

  // ---- I. SCOPE CARDINALITY ---------------------------------------------
  describe('I. scope cardinality', () => {
    it('a second save for the same scope EXTENDS the one line instead of double counting', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:5', fields: [{ name: 'final', value: 100 }] },
          { entity: 'sheet:0:row:6', fields: [{ name: 'final', value: 40 }] },
        ],
      });
      const a = s.records.get('sheet:0:row:5::final')!;
      const b = s.records.get('sheet:0:row:6::final')!;
      const first = await setLine(U_EDIT, s.revId, { qty: '100', sources: sources([a, '100']) });
      const second = await setLine(U_EDIT, s.revId, { qty: '140', sources: sources([b, '40']), expected: [a] });
      expect(second.need_line_id).toBe(first.need_line_id);
      expect(second.created).toBe(false);
      expect(second.source_link_count).toBe(2);
      const rows = await linesOf(s.revId);
      expect(rows).toHaveLength(1);
      expect(rows[0].q).toBe('140');
    });

    it('allows the same material for a DIFFERENT beneficiary', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 20, beneficiary: ORG_BENE2 }] },
        ],
      });
      await setLine(U_EDIT, s.revId, {
        beneficiary: ORG_BENE, qty: '10', sources: sources([s.records.get('sheet:0:row:1::final')!, '10']),
      });
      await setLine(U_EDIT, s.revId, {
        beneficiary: ORG_BENE2, qty: '20', sources: sources([s.records.get('sheet:0:row:2::final')!, '20']),
      });
      expect(await linesOf(s.revId)).toHaveLength(2);
    });

    it('allows a warehouse-targeted split across TWO active warehouses of one beneficiary', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 20 }] },
        ],
      });
      await setLine(U_EDIT, s.revId, {
        warehouse: WH_BENE, qty: '10', sources: sources([s.records.get('sheet:0:row:1::final')!, '10']),
      });
      await setLine(U_EDIT, s.revId, {
        warehouse: WH_BENE_2, qty: '20', sources: sources([s.records.get('sheet:0:row:2::final')!, '20']),
      });
      const rows = await linesOf(s.revId);
      expect(rows.map((r: any) => r.target_warehouse_id).sort()).toEqual([WH_BENE, WH_BENE_2].sort());
    });

    it('REFUSES mixing an institution-level line with a warehouse-targeted one', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 20 }] },
        ],
      });
      await setLine(U_EDIT, s.revId, {
        qty: '10', sources: sources([s.records.get('sheet:0:row:1::final')!, '10']),
      });
      expect(await refusal(setLine(U_EDIT, s.revId, {
        warehouse: WH_BENE, qty: '20', sources: sources([s.records.get('sheet:0:row:2::final')!, '20']),
      }))).toMatchObject({ code: '23514', message: 'need_line_scope_mixes_institution_and_warehouse' });
      expect(await linesOf(s.revId)).toHaveLength(1);
    });

    it('consolidates many source rows of one material into ONE canonical line', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:63', fields: [{ name: 'final', value: 40 }] },
          { entity: 'sheet:0:row:84', fields: [{ name: 'final', value: 35 }] },
        ],
      });
      const r = await setLine(U_EDIT, s.revId, {
        qty: '75',
        sources: sources(
          [s.records.get('sheet:0:row:63::final')!, '40'],
          [s.records.get('sheet:0:row:84::final')!, '35']),
      });
      expect(await linesOf(s.revId)).toHaveLength(1);
      expect(r.source_link_count).toBe(2);
      // Neither source record was rewritten to achieve the consolidation.
      const raw = await admin(
        `SELECT source_values->>'value' AS v FROM central_needs_source_records
          WHERE import_session_id=$1 ORDER BY record_ordinal`, [s.sessionId]);
      expect(raw.map((x: any) => x.v)).toEqual(['40', '35']);
    });
  });

  // ---- J. REVIEW BLOCKERS ----------------------------------------------
  describe('J. review blockers', () => {
    it('preserves every pre-212 blocker branch', async () => {
      const [{ def }] = await admin(
        // R1-a (candidate 05) moves the Excel body into phoenix_private; the branches must still all be present
        // in the public definition together with its private Excel body.
        `SELECT string_agg(pg_get_functiondef(p.oid), E'
') AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE (n.nspname='public' AND p.proname='_phoenix_central_needs_review_blockers_v1')
             OR (n.nspname='phoenix_private' AND p.proname='central_needs_excel_review_blockers_v1')`);
      for (const branch of [
        'no_finalized_import', 'import_session_still_open',
        'completed_session_not_in_trusted_batch', 'incomplete_trusted_batch',
        'target_entity_without_disposition',
      ]) expect(def, branch).toContain(branch);
    });

    it('blocks a mapped row that no need line claims, and clears once it is claimed', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('mapped_target_entity_without_need_line');
      await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .not.toContain('mapped_target_entity_without_need_line');
    });

    it('blocks while any need line still needs a unit conversion', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, {
        state: 'conversion_required', unit: null, sources: sources([id, '100']),
      });
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('need_line_unit_conversion_required');
    });

    it('blocks an ineligible beneficiary that bypassed the write RPC (defence in depth)', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        if (FORWARD) {
          // Under 213 a bypass of the write RPC must also bypass the column-
          // mapping RPC (which refuses an inactive beneficiary): the privileged
          // session re-points this cell's confirmed column to ORG_INACTIVE.
          await c.query(
            `UPDATE central_needs_beneficiary_column_mappings m
                SET beneficiary_organization_id = $1
               FROM central_needs_source_records r
              WHERE r.id = $2
                AND m.import_session_id = r.import_session_id
                AND m.sheet_index  = (r.source_provenance->>'sheetIndex')::int
                AND m.column_index = (r.source_provenance->'coordinate'->>'col')::int`,
            [ORG_INACTIVE, id]);
        }
        const { rows } = await c.query(
          `INSERT INTO central_needs_need_lines
             (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
              approved_quantity, approved_unit, mapping_reason)
           VALUES ($1,$2,$3,$4,100,'box','privileged insert') RETURNING id`,
          [s.revId, ORG_OWNER, ORG_INACTIVE, ITEM_A]);
        await c.query(
          `INSERT INTO central_needs_need_line_sources
             (need_line_id, organization_id, source_record_id, designated_quantity)
           VALUES ($1,$2,$3,100)`,
          [rows[0].id, ORG_OWNER, id]);
        await c.query('COMMIT');
      });
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('need_line_beneficiary_ineligible');
    });

    it('blocks a target warehouse that stopped belonging to the beneficiary', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const wh = await freshWarehouse();
      await setLine(U_EDIT, s.revId, { warehouse: wh, sources: sources([id, '100']) });
      await admin(`UPDATE warehouses SET organization_id=$1 WHERE id=$2`, [ORG_BENE2, wh]);
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('need_line_warehouse_org_mismatch');
    });

    it('a warehouse ARCHIVED after mapping becomes a blocker — and the submit gate refuses', async () => {
      // A revision that is otherwise READY: its one completed session is in a
      // trusted batch and its one mapped row is claimed by a need line.
      const s = await scenario({ rows: [{ entity: 'sheet:0:row:5', fields: [{ name: 'final', value: 100 }] }] });
      const id = s.records.get('sheet:0:row:5::final')!;
      const wh = await freshWarehouse();
      const line = await setLine(U_EDIT, s.revId, { warehouse: wh, sources: sources([id, '100']) });
      const [{ id: batchId }] = await admin(
        `INSERT INTO central_needs_import_batches
           (plan_revision_id, organization_id, container_kind, container_filename, container_sha256,
            storage_locator, accepted_entry_count, parser_identity)
         VALUES ($1,$2,'file','needs.xls',$3,'permanent/x',1,$4::jsonb) RETURNING id`,
        [s.revId, ORG_OWNER, `${s.year}`.padStart(64, 'c'), JSON.stringify(PARSER_IDENTITY)]);
      await admin(
        `INSERT INTO central_needs_import_batch_entries
           (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id)
         VALUES ($1,$2,$3,1,$4,$5)`,
        [batchId, s.revId, ORG_OWNER, `${s.year}`.padStart(64, 'e'), s.sessionId]);
      expect(await blockers(s.revId)).toEqual([]);

      await admin(`UPDATE warehouses SET status='archived', archived_at=now(), archive_reason='rig' WHERE id=$1`, [wh]);

      const after = await blockers(s.revId);
      expect(after).toEqual([{
        blocker: 'need_line_target_warehouse_not_active',
        // C5 §4 (217) appends the reason token to this readiness DETAIL.
        detail: `need_line=${line.need_line_id} warehouse=${wh} status=archived${C5 ? ' reason=not_active' : ''}`,
      }]);
      const r = await refusal(call(U_EDIT,
        `SELECT public.phoenix_central_needs_submit_revision($1) AS result`, [s.revId]));
      expect(r).toMatchObject({ code: '23514', message: 'plan_revision_not_ready_for_review' });
      expect(r.detail).toContain('need_line_target_warehouse_not_active');
      const [{ status }] = await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [s.revId]);
      expect(status).toBe('draft');
    });

    it('a warehouse INACTIVATED after mapping becomes a blocker too', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const wh = await freshWarehouse();
      await setLine(U_EDIT, s.revId, { warehouse: wh, sources: sources([id, '100']) });
      await admin(`UPDATE warehouses SET status='inactive' WHERE id=$1`, [wh]);
      expect((await blockers(s.revId)).map((b: any) => b.blocker))
        .toContain('need_line_target_warehouse_not_active');
    });
  });

  // ---- K. CROSS-ORGANIZATION AND ROLE ISOLATION -------------------------
  describe('K. cross-organization and role isolation', () => {
    it('does not expose a need line to another organization, nor to the beneficiary', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });

      const count = (u: string) => call(u,
        `SELECT count(*)::int AS result FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]);
      expect(await count(U_EDIT)).toBe(1);
      expect(await count(U_OTHER)).toBe(0);

      // A user of the BENEFICIARY institution sees nothing either: read is gated
      // on the owning organization, exactly as every other Central Needs policy.
      const beneficiaryUser = '00000000-0000-0000-0000-000000212406';
      await admin(`INSERT INTO auth.users (id,email) VALUES ($1,'p212-bene-user@rig')
                     ON CONFLICT (id) DO NOTHING`, [beneficiaryUser]);
      await admin(`UPDATE profiles SET role='institution_admin', status='active', organization_id=$1 WHERE id=$2`,
        [ORG_BENE, beneficiaryUser]);
      for (const k of ['view', 'edit']) {
        await admin(
          `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
             ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`,
          [beneficiaryUser, `central_needs.${k}`]);
      }
      expect(await count(beneficiaryUser)).toBe(0);
    });

    it('does not expose the provenance links either', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      const other = await call(U_OTHER,
        `SELECT count(*)::int AS result FROM central_needs_need_line_sources WHERE need_line_id=$1`,
        [r.need_line_id]);
      expect(other).toBe(0);
    });

    it('does not expose a need line to a member of ANOTHER pharmacy department holding every key', async () => {
      // Mode-independent: ORG_PDA2's central_warehouse_manager is role-eligible before M224 and an
      // active member of a live PDA after it, so ONLY the organization scope can hide the row.
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect(await call(U_PDA2,
        `SELECT count(*)::int AS result FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId])).toBe(0);
      expect(await call(U_PDA2,
        `SELECT count(*)::int AS result FROM central_needs_need_line_sources WHERE need_line_id=$1`,
        [r.need_line_id])).toBe(0);
      expect(await listAsClient(U_PDA2, s.revId)).toEqual([]);
    });

    it('HISTORICAL (pre-M224 role class): gives an INELIGIBLE role in the owning org zero rows, whatever keys it holds', async (ctx) => {
      if (M224) ctx.skip();
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      for (const u of [U_INST, U_OUTLET]) {
        expect(await call(u,
          `SELECT count(*)::int AS result FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId])).toBe(0);
        expect(await call(u,
          `SELECT count(*)::int AS result FROM central_needs_need_line_sources WHERE need_line_id=$1`,
          [r.need_line_id])).toBe(0);
        expect(await listAsClient(u, s.revId)).toEqual([]);
      }
    });

    it('FORWARD (M224): ordinary PDA staff holding view READ their organization\'s lines, provenance and the list RPC — exactly what the editor sees', async (ctx) => {
      if (!M224) ctx.skip();
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      const editorView = await listAsClient(U_EDIT, s.revId);
      expect(editorView).toHaveLength(1);
      for (const u of [U_INST, U_OUTLET, U_VIEW, U_APPROVE]) {
        expect(await call(u,
          `SELECT count(*)::int AS result FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]), u).toBe(1);
        expect(await call(u,
          `SELECT count(*)::int AS result FROM central_needs_need_line_sources WHERE need_line_id=$1`,
          [r.need_line_id]), u).toBe(1);
        expect(await listAsClient(u, s.revId), u).toEqual(editorView);
      }
    });

    it('FORWARD (M224): zero leakage — no view key, care home, another PDA, a super_admin elsewhere, suspended/archived/home-less/archived-PDA members read no line, no source and nothing through the RPC', async (ctx) => {
      if (!M224) ctx.skip();
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const r = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      for (const u of [U_NOPERM, U_OTHER, U_CARE_ADMIN, U_PDA2, U_SA_PDA2, U_SA_NOHOME, U_SUSP, U_ARCHIVED, U_ARCH_PDA]) {
        expect(await call(u,
          `SELECT count(*)::int AS result FROM central_needs_need_lines WHERE plan_revision_id=$1`, [s.revId]), u).toBe(0);
        expect(await call(u,
          `SELECT count(*)::int AS result FROM central_needs_need_line_sources WHERE need_line_id=$1`,
          [r.need_line_id]), u).toBe(0);
        expect(await listAsClient(u, s.revId), u).toEqual([]);
      }
      // The refusals were reads only: the line and its provenance are unchanged.
      expect(await linesOf(s.revId)).toHaveLength(1);
      expect(await linksOf(r.need_line_id)).toHaveLength(1);
    });
  });

  // ---- L. CELL-LEVEL CARDINALITY (review C1) ----------------------------
  describe('L. one row may feed several lines; one cell feeds at most one', () => {
    /** One material row, two institution quantity columns — the corpus shape. */
    const multiInstitutionRow = () => scenario({
      rows: [{
        entity: 'sheet:0:row:12',
        fields: [{ name: 'مستشفى أ', value: 30 }, { name: 'مستشفى ب', value: 45, beneficiary: ORG_BENE2 }],
      }],
    });

    it('same row: cell A -> beneficiary A and cell B -> beneficiary B BOTH succeed', async () => {
      const s = await multiInstitutionRow();
      const cellA = s.records.get('sheet:0:row:12::مستشفى أ')!;
      const cellB = s.records.get('sheet:0:row:12::مستشفى ب')!;
      const a = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE, qty: '30', sources: sources([cellA, '30']) });
      const b = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE2, qty: '45', sources: sources([cellB, '45']) });
      expect(a.need_line_id).not.toBe(b.need_line_id);
      expect((await linksOf(a.need_line_id)).map((l: any) => l.source_record_id)).toEqual([cellA]);
      expect((await linksOf(b.need_line_id)).map((l: any) => l.source_record_id)).toEqual([cellB]);
      // Both lines carry the row's ONE canonical material.
      const lines = await linesOf(s.revId);
      expect(lines.map((l: any) => l.central_item_id)).toEqual([ITEM_A, ITEM_A]);
      expect(lines.map((l: any) => l.beneficiary_organization_id).sort()).toEqual([ORG_BENE, ORG_BENE2].sort());
      // And the revision is not blocked for having "split" the row.
      expect((await blockers(s.revId)).map((x: any) => x.blocker))
        .not.toContain('mapped_target_entity_without_need_line');
    });

    it('the EXACT same cell cannot feed a second line — source_record_already_linked', async () => {
      const s = await multiInstitutionRow();
      const cellA = s.records.get('sheet:0:row:12::مستشفى أ')!;
      const first = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE, qty: '30', sources: sources([cellA, '30']) });
      // A second line is a different SCOPE. Cell A sits in Hospital A's column,
      // so under 213 a Hospital-B line would be refused earlier, by the column
      // contract; the second scope is therefore Hospital A's warehouse-targeted
      // line — a genuinely different line in both chains, refused only because
      // the CELL is already taken.
      const r = await refusal(setLine(U_EDIT, s.revId, {
        beneficiary: ORG_BENE, warehouse: WH_BENE, qty: '30', sources: sources([cellA, '30']),
      }));
      expect(r).toMatchObject({ code: '23514', message: 'source_record_already_linked' });
      expect(r.detail).toBe(`source_record=${cellA} need_line=${first.need_line_id}`);
      expect(r.message).not.toMatch(/duplicate|23505|_record_key/);
      expect(await linesOf(s.revId)).toHaveLength(1);
      expect((await linksOf(first.need_line_id)).map((l: any) => l.source_record_id)).toEqual([cellA]);
    });

    it('the same cell twice in ONE call is refused with the same domain error, and nothing is written', async () => {
      const s = await multiInstitutionRow();
      const cellA = s.records.get('sheet:0:row:12::مستشفى أ')!;
      const r = await refusal(setLine(U_EDIT, s.revId, { qty: '60', sources: sources([cellA, '30'], [cellA, '30']) }));
      expect(r).toMatchObject({ code: '23514', message: 'source_record_already_linked' });
      expect(r.message).not.toMatch(/duplicate/);
      expect(await linesOf(s.revId)).toHaveLength(0);
    });

    it('a cell already on a line cannot be added to that same line again', async () => {
      const s = await multiInstitutionRow();
      const cellA = s.records.get('sheet:0:row:12::مستشفى أ')!;
      await setLine(U_EDIT, s.revId, { qty: '30', sources: sources([cellA, '30']) });
      expect(await refusal(setLine(U_EDIT, s.revId, { qty: '60', sources: sources([cellA, '30']), expected: [cellA] })))
        .toMatchObject({ code: '23514', message: 'source_record_already_linked' });
    });
  });

  // ---- M. REVISION-WIDE PROVENANCE AND STALE CLIENTS (review Q1) --------
  describe('M. provenance is revision-wide and a save can never erase it', () => {
    /** One revision, two completed sessions, the same material in each. */
    const twoSessions = async () => {
      const s = await scenario({ rows: [{ entity: 'sheet:0:row:3', fields: [{ name: 'final', value: 10 }] }] });
      const second = await addSession(s.revId, [{ entity: 'sheet:0:row:3', fields: [{ name: 'final', value: 7 }] }]);
      return {
        ...s,
        s1: s.records.get('sheet:0:row:3::final')!,
        s2: second.records.get('sheet:0:row:3::final')!,
        session2: second.sessionId,
      };
    };

    it('consolidates cells from TWO import sessions into one line in one call', async () => {
      const t = await twoSessions();
      const r = await setLine(U_EDIT, t.revId, { qty: '17', sources: sources([t.s1, '10'], [t.s2, '7']) });
      const links = await admin(
        `SELECT r.import_session_id FROM central_needs_need_line_sources ls
           JOIN central_needs_source_records r ON r.id = ls.source_record_id
          WHERE ls.need_line_id=$1 ORDER BY r.import_session_id`, [r.need_line_id]);
      expect(links.map((l: any) => l.import_session_id).sort()).toEqual([t.sessionId, t.session2].sort());
    });

    it('an incremental add from a LATER session keeps every earlier link', async () => {
      const t = await twoSessions();
      const first = await setLine(U_EDIT, t.revId, { qty: '10', sources: sources([t.s1, '10']) });
      const second = await setLine(U_EDIT, t.revId, { qty: '17', sources: sources([t.s2, '7']), expected: [t.s1] });
      expect(second.need_line_id).toBe(first.need_line_id);
      expect(second.added_link_count).toBe(1);
      expect((await linksOf(first.need_line_id)).map((l: any) => l.source_record_id).sort())
        .toEqual([t.s1, t.s2].sort());
      expect((await linesOf(t.revId))[0].q).toBe('17');
      const [log] = await admin(
        `SELECT payload FROM audit_logs WHERE action='central_needs.need_line.set' AND entity_id=$1
          ORDER BY created_at DESC, id DESC LIMIT 1`, [first.need_line_id]);
      expect(log.payload.operation).toBe('extended');
      expect(log.payload.previous_source_record_ids).toEqual([t.s1]);
      expect(log.payload.previous_approved_quantity).toBe('10');
    });

    it('a SESSION-LIMITED save that never saw the earlier link is refused, and erases nothing', async () => {
      const t = await twoSessions();
      const first = await setLine(U_EDIT, t.revId, { qty: '10', sources: sources([t.s1, '10']) });
      // What the entry-HEAD client did: looking only at session 2, it knows of no
      // link and submits session 2's cell as the line's whole provenance.
      const r = await refusal(setLine(U_EDIT, t.revId, { qty: '7', sources: sources([t.s2, '7']), expected: [] }));
      expect(r).toMatchObject({ code: '23514', message: 'need_line_lineage_stale' });
      expect(r.detail).toBe(`need_line=${first.need_line_id} expected_links=0 current_links=1`);
      expect((await linksOf(first.need_line_id)).map((l: any) => l.source_record_id)).toEqual([t.s1]);
      expect((await linesOf(t.revId))[0].q).toBe('10');
    });

    it('a save that KNOWS the earlier link still cannot replace it by restating the total', async () => {
      const t = await twoSessions();
      const first = await setLine(U_EDIT, t.revId, { qty: '10', sources: sources([t.s1, '10']) });
      expect(await refusal(setLine(U_EDIT, t.revId, { qty: '7', sources: sources([t.s2, '7']), expected: [t.s1] })))
        .toMatchObject({ code: '23514', message: 'need_line_quantity_provenance_mismatch' });
      expect((await linksOf(first.need_line_id)).map((l: any) => l.source_record_id)).toEqual([t.s1]);
    });

    it('refuses a stale view that lists a link the line no longer (or never) had', async () => {
      const t = await twoSessions();
      await setLine(U_EDIT, t.revId, { qty: '10', sources: sources([t.s1, '10']) });
      const extra = await addSession(t.revId, [{ entity: 'sheet:0:row:3', fields: [{ name: 'final', value: 1 }] }]);
      const s3 = extra.records.get('sheet:0:row:3::final')!;
      expect(await refusal(setLine(U_EDIT, t.revId, { qty: '18', sources: sources([s3, '1']), expected: [t.s1, t.s2] })))
        .toMatchObject({ code: '23514', message: 'need_line_lineage_stale' });
    });

    it('will not re-interpret existing designations in a different unit', async () => {
      const t = await twoSessions();
      await setLine(U_EDIT, t.revId, { qty: '10', sources: sources([t.s1, '10']) });
      const r = await refusal(setLine(U_EDIT, t.revId, {
        qty: '17', unit: 'vial', sources: sources([t.s2, '7']), expected: [t.s1],
      }));
      expect(r).toMatchObject({ code: '23514', message: 'need_line_attributes_conflict' });
    });

    it('a CONCURRENT create of the same scope from a stale snapshot surfaces need_line_scope_conflict, never a raw 23505', async () => {
      const t = await twoSessions();
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query('SET LOCAL ROLE authenticated');
        // The first snapshot-taking statement: this transaction now sees no line.
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
        // Another session creates the scope and commits.
        await setLine(U_EDIT, t.revId, { qty: '10', sources: sources([t.s1, '10']) });
        const r = await refusal(client.query(
          `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,$11)`,
          [t.revId, ORG_BENE, ITEM_A, '7', 'stale snapshot', sources([t.s2, '7']), [], 'box', 'canonical', null, null]));
        expect(r).toMatchObject({ code: '23514', message: 'need_line_scope_conflict' });
        expect(r.message).not.toMatch(/duplicate|scope_key/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
      expect(await linesOf(t.revId)).toHaveLength(1);
    });

    it('a CONCURRENT link of the same cell from a stale snapshot surfaces source_record_already_linked, never a raw 23505', async () => {
      const t = await twoSessions();
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query('SET LOCAL ROLE authenticated');
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
        await setLine(U_EDIT, t.revId, { beneficiary: ORG_BENE, qty: '10', sources: sources([t.s1, '10']) });
        const r = await refusal(client.query(
          `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,$11)`,
          // The same cell for a different scope of the SAME beneficiary (see L):
          // under 213 a Hospital-B scope would be refused by the column contract first.
          [t.revId, ORG_BENE, ITEM_A, '10', 'stale snapshot', sources([t.s1, '10']), [], 'box', 'canonical', WH_BENE, null]));
        expect(r).toMatchObject({ code: '23514', message: 'source_record_already_linked' });
        expect(r.message).not.toMatch(/duplicate|record_key/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
      expect(await linesOf(t.revId)).toHaveLength(1);
    });

    it('the exact read returns the REVISION-wide lineage with each cell identity', async () => {
      const t = await twoSessions();
      const r = await setLine(U_EDIT, t.revId, { qty: '17', sources: sources([t.s1, '10'], [t.s2, '7']) });
      const [line] = await listAsClient(U_EDIT, t.revId);
      expect(line.id).toBe(r.need_line_id);
      expect(line.sources).toHaveLength(2);
      const bySession = Object.fromEntries(line.sources.map((x: any) => [x.import_session_id, x]));
      expect(bySession[t.sessionId]).toMatchObject({
        source_record_id: t.s1, designated_quantity: '10', target_entity: 'sheet:0:row:3', field_name: 'final',
      });
      expect(bySession[t.session2]).toMatchObject({
        source_record_id: t.s2, designated_quantity: '7', target_entity: 'sheet:0:row:3', field_name: 'final',
      });
    });
  });

  // ---- N. EXPLICIT CORRECTION PATH (review Q3) --------------------------
  describe('N. explicit, reasoned, audited correction', () => {
    it('deletes a draft line: links, then line; audited with identity and reason; evidence untouched', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const [{ id: overrideId }] = await admin(
        `INSERT INTO central_needs_field_overrides
           (plan_revision_id, organization_id, source_record_id, target_entity, field_name,
            final_value, override_reason)
         VALUES ($1,$2,$3,'sheet:0:row:5','final','130'::jsonb,'committee') RETURNING id`,
        [s.revId, ORG_OWNER, id]);
      const line = await setLine(U_EDIT, s.revId, { qty: '130.5', sources: sources([id, '130.5', overrideId]) });
      const evidenceBefore = await admin(
        `SELECT id, source_values::text AS v FROM central_needs_source_records WHERE import_session_id=$1 ORDER BY id`,
        [s.sessionId]);

      const out = await deleteLine(U_EDIT, line.need_line_id, 'wrong beneficiary chosen', [id]);
      expect(out).toMatchObject({ ok: true, need_line_id: line.need_line_id, deleted_source_count: 1 });
      expect(await linesOf(s.revId)).toHaveLength(0);
      expect(await linksOf(line.need_line_id)).toHaveLength(0);

      const [log] = await admin(
        `SELECT actor_id, payload FROM audit_logs
          WHERE action='central_needs.need_line.delete' AND entity_id=$1`, [line.need_line_id]);
      expect(log.actor_id).toBe(U_EDIT);
      expect(log.payload).toMatchObject({
        plan_revision_id: s.revId, organization_id: ORG_OWNER, beneficiary_organization_id: ORG_BENE,
        central_item_id: ITEM_A, target_warehouse_id: null, approved_quantity: '130.5',
        deletion_reason: 'wrong beneficiary chosen', deleted_source_count: 1,
      });
      expect(log.payload.deleted_sources).toEqual([expect.objectContaining({
        source_record_id: id, designated_quantity: '130.5', applied_override_id: overrideId,
      })]);

      expect(await admin(
        `SELECT id, source_values::text AS v FROM central_needs_source_records WHERE import_session_id=$1 ORDER BY id`,
        [s.sessionId])).toEqual(evidenceBefore);
      const [{ n }] = await admin(`SELECT count(*)::int AS n FROM central_needs_field_overrides WHERE id=$1`, [overrideId]);
      expect(n).toBe(1);
    });

    it('refuses deletion on a non-draft revision, leaving the line intact', async () => {
      // C6-F1 (218): submitted canonically — the one mapped cell feeds the line,
      // which makes the revision READY — never by a direct UPDATE.
      const s = await scenario({ rows: [{ entity: 'sheet:0:row:5', fields: [{ name: 'final', value: 100 }] }] });
      const id = s.records.get('sheet:0:row:5::final')!;
      const line = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      await submitCanonically(s);
      expect(await refusal(deleteLine(U_EDIT, line.need_line_id, 'too late', [id])))
        .toMatchObject({ code: '23514', message: 'plan_revision_not_editable' });
      expect(await linksOf(line.need_line_id)).toHaveLength(1);
    });

    it('requires a non-empty reason', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const line = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      for (const reason of [null, '', '   ']) {
        expect(await refusal(deleteLine(U_EDIT, line.need_line_id, reason, [id])), String(reason))
          .toMatchObject({ code: '23514', message: 'need_line_deletion_reason_required' });
      }
      expect(await linesOf(s.revId)).toHaveLength(1);
    });

    it('HISTORICAL (pre-M224 role class): requires authorization, with exact codes, and deletes nothing when refused', async (ctx) => {
      if (M224) ctx.skip();
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const line = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect(await refusal(deleteLine(null, line.need_line_id, 'r', [id])))
        .toMatchObject({ code: '28000', message: 'not_authenticated' });
      expect(await refusal(deleteLine(U_NOPERM, line.need_line_id, 'r', [id])))
        .toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
      expect(await refusal(deleteLine(U_OTHER, line.need_line_id, 'r', [id])))
        .toMatchObject({ code: '42501', message: 'forbidden_central_needs' });
      expect(await refusal(deleteLine(U_INST, line.need_line_id, 'r', [id])))
        .toMatchObject({ code: '42501', message: 'forbidden_central_needs_role' });
      expect(await refusal(deleteLine(U_OUTLET, line.need_line_id, 'r', [id])))
        .toMatchObject({ code: '42501', message: 'forbidden_central_needs_role' });
      expect(await refusal(deleteLine(null, line.need_line_id, 'r', [id], 'anon')))
        .toMatchObject({ code: '42501', message: 'permission denied for function phoenix_central_needs_delete_need_line' });
      expect(await linksOf(line.need_line_id)).toHaveLength(1);
    });

    it('FORWARD (M224): delete requires authorization with exact codes, and every refusal leaves the line, its links and the audit trail untouched', async (ctx) => {
      if (!M224) ctx.skip();
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const line = await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      const deletions = async () => (await admin(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action='central_needs.need_line.delete' AND entity_id=$1`,
        [line.need_line_id]))[0].n;
      expect(await refusal(deleteLine(null, line.need_line_id, 'r', [id])))
        .toMatchObject({ code: '28000', message: 'not_authenticated' });
      // a member without edit, or of another PDA (a super_admin homed there included): scope
      for (const u of [U_NOPERM, U_VIEW, U_APPROVE, U_PDA2, U_SA_PDA2]) {
        expect(await refusal(deleteLine(u, line.need_line_id, 'r', [id])), u).toMatchObject(SCOPE_CODE);
      }
      // not an active member of a live PDA: membership, checked first
      for (const u of [U_OTHER, U_CARE_ADMIN, U_SUSP, U_ARCHIVED, U_SA_NOHOME, U_ARCH_PDA]) {
        expect(await refusal(deleteLine(u, line.need_line_id, 'r', [id])), u).toMatchObject(ROLE_CODE);
      }
      expect(await refusal(deleteLine(null, line.need_line_id, 'r', [id], 'anon')))
        .toMatchObject({ code: '42501', message: 'permission denied for function phoenix_central_needs_delete_need_line' });
      expect(await linesOf(s.revId)).toEqual([expect.objectContaining({ id: line.need_line_id, q: '100' })]);
      expect(await linksOf(line.need_line_id)).toEqual([expect.objectContaining({ source_record_id: id, q: '100' })]);
      expect(await deletions()).toBe(0);
    });

    it('FORWARD (M224): an ordinary PDA member holding edit deletes with a reason; the audit names that member; evidence and lineage are kept', async (ctx) => {
      if (!M224) ctx.skip();
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const line = await setLine(U_INST, s.revId, { sources: sources([id, '100']) });
      const evidenceBefore = await admin(
        `SELECT id, source_values::text AS v FROM central_needs_source_records WHERE import_session_id=$1 ORDER BY id`,
        [s.sessionId]);
      const out = await deleteLine(U_OUTLET, line.need_line_id, 'line mapped to the wrong item', [id]);
      expect(out).toMatchObject({ ok: true, need_line_id: line.need_line_id, deleted_source_count: 1 });
      expect(await linesOf(s.revId)).toHaveLength(0);
      expect(await linksOf(line.need_line_id)).toHaveLength(0);
      const [log] = await admin(
        `SELECT actor_id, payload FROM audit_logs WHERE action='central_needs.need_line.delete' AND entity_id=$1`,
        [line.need_line_id]);
      expect(log.actor_id).toBe(U_OUTLET);
      expect(log.payload).toMatchObject({
        plan_revision_id: s.revId, organization_id: ORG_OWNER, deletion_reason: 'line mapped to the wrong item',
        deleted_source_count: 1,
      });
      expect(log.payload.deleted_sources).toEqual([expect.objectContaining({ source_record_id: id, designated_quantity: '100' })]);
      expect(await admin(
        `SELECT id, source_values::text AS v FROM central_needs_source_records WHERE import_session_id=$1 ORDER BY id`,
        [s.sessionId])).toEqual(evidenceBefore);
    });

    it('refuses a stale delete that did not see a link added since', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 5 }] },
        ],
      });
      const a = s.records.get('sheet:0:row:1::final')!;
      const b = s.records.get('sheet:0:row:2::final')!;
      const line = await setLine(U_EDIT, s.revId, { qty: '10', sources: sources([a, '10']) });
      await setLine(U_EDIT, s.revId, { qty: '15', sources: sources([b, '5']), expected: [a] });
      expect(await refusal(deleteLine(U_EDIT, line.need_line_id, 'stale', [a])))
        .toMatchObject({ code: '23514', message: 'need_line_lineage_stale' });
      expect(await linksOf(line.need_line_id)).toHaveLength(2);
    });

    it('reports an unknown line as need_line_not_found', async () => {
      expect(await refusal(deleteLine(U_EDIT, '00000000-0000-0000-0000-0000000000ee', 'r', [])))
        .toMatchObject({ code: 'P0002', message: 'need_line_not_found' });
    });

    it('RECOVERS a wrong beneficiary: delete, then the same cell maps to the right one', async () => {
      // The wrong decision starts at the cell's column: it was confirmed as ORG_BENE2's.
      const s = await scenario({
        rows: [{
          entity: 'sheet:0:row:5',
          fields: [{ name: 'requested', value: 100 }, { name: 'final', value: 120, beneficiary: ORG_BENE2 }],
        }],
      });
      const id = s.records.get('sheet:0:row:5::final')!;
      const wrong = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE2, sources: sources([id, '100']) });
      await deleteLine(U_EDIT, wrong.need_line_id, 'beneficiary was ORG_BENE', [id]);
      // Under 213 the correction also lives where the error lived — the column —
      // and is possible only now that no need line uses it.
      if (FORWARD) await remapColumnOf(s.revId, id, ORG_BENE, ORG_BENE2);
      const right = await setLine(U_EDIT, s.revId, { beneficiary: ORG_BENE, sources: sources([id, '100']) });
      const lines = await linesOf(s.revId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ id: right.need_line_id, beneficiary_organization_id: ORG_BENE });
    });

    it('RECOVERS a wrong target warehouse', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const wrong = await setLine(U_EDIT, s.revId, { warehouse: WH_BENE, sources: sources([id, '100']) });
      await deleteLine(U_EDIT, wrong.need_line_id, 'institution-level, not warehouse', [id]);
      await setLine(U_EDIT, s.revId, { warehouse: null, sources: sources([id, '100']) });
      expect((await linesOf(s.revId)).map((l: any) => l.target_warehouse_id)).toEqual([null]);
    });

    it('RECOVERS a wrong source designation, freeing the wrongly designated cell', async () => {
      const s = await scenario(); // cells: requested=100, final=120
      const requested = s.records.get('sheet:0:row:5::requested')!;
      const final = s.records.get('sheet:0:row:5::final')!;
      const wrong = await setLine(U_EDIT, s.revId, { qty: '100', sources: sources([requested, '100']) });
      await deleteLine(U_EDIT, wrong.need_line_id, 'the final column is authoritative', [requested]);
      const right = await setLine(U_EDIT, s.revId, { qty: '120', sources: sources([final, '120']) });
      expect((await linksOf(right.need_line_id)).map((l: any) => l.source_record_id)).toEqual([final]);
      const [{ n }] = await admin(
        `SELECT count(*)::int AS n FROM central_needs_need_line_sources WHERE source_record_id=$1`, [requested]);
      expect(n).toBe(0);
    });

    it('RECOVERS a LATER material re-mapping in-product: blocker, delete, re-map, blocker clears', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const old = await setLine(U_EDIT, s.revId, { item: ITEM_A, sources: sources([id, '100']) });
      await admin(`UPDATE central_needs_record_mappings SET central_item_id=$1 WHERE import_session_id=$2`,
        [ITEM_B, s.sessionId]);
      expect((await blockers(s.revId)).map((b: any) => b.blocker)).toContain('need_line_material_mapping_divergent');
      // Adding to the divergent line is refused; the line cannot be "fixed" in place.
      await deleteLine(U_EDIT, old.need_line_id, 'row re-mapped to ITEM_B', [id]);
      await setLine(U_EDIT, s.revId, { item: ITEM_B, unit: 'vial', sources: sources([id, '100']) });
      const after = (await blockers(s.revId)).map((b: any) => b.blocker);
      expect(after).not.toContain('need_line_material_mapping_divergent');
      expect(after).not.toContain('mapped_target_entity_without_need_line');
    });

    it('RECOVERS a warehouse archived after mapping: blocker, delete, re-route, blocker clears', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      const wh = await freshWarehouse();
      const line = await setLine(U_EDIT, s.revId, { warehouse: wh, sources: sources([id, '100']) });
      await admin(`UPDATE warehouses SET status='archived', archived_at=now(), archive_reason='rig' WHERE id=$1`, [wh]);
      expect((await blockers(s.revId)).map((b: any) => b.blocker)).toContain('need_line_target_warehouse_not_active');
      await deleteLine(U_EDIT, line.need_line_id, 'warehouse archived', [id]);
      await setLine(U_EDIT, s.revId, { warehouse: WH_BENE, sources: sources([id, '100']) });
      expect((await blockers(s.revId)).map((b: any) => b.blocker)).not.toContain('need_line_target_warehouse_not_active');
    });
  });

  // ---- O. EVERY AFFECTED LINE IS ASSERTED (review F4) -------------------
  describe('O. a privileged link re-point cannot orphan the line it leaves', () => {
    const twoLines = async (extraOnFirst = false) => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 10 }, { name: 'extra', value: 5 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'final', value: 20 }] },
        ],
      });
      const x = s.records.get('sheet:0:row:1::final')!;
      const z = s.records.get('sheet:0:row:1::extra')!;
      const y = s.records.get('sheet:0:row:2::final')!;
      // Two distinct lines of ONE beneficiary (a warehouse split). Under 213 a
      // cell of ORG_BENE's confirmed column can never sit on another
      // beneficiary's line at all, so a cross-beneficiary re-point would be
      // refused for THAT reason first and could no longer probe L1's lineage.
      const l1 = extraOnFirst
        ? await setLine(U_EDIT, s.revId, { warehouse: WH_BENE, qty: '15', sources: sources([x, '10'], [z, '5']) })
        : await setLine(U_EDIT, s.revId, { warehouse: WH_BENE, qty: '10', sources: sources([x, '10']) });
      const l2 = await setLine(U_EDIT, s.revId, { warehouse: WH_BENE_2, qty: '20', sources: sources([y, '20']) });
      return { s, x, y, z, l1: l1.need_line_id as string, l2: l2.need_line_id as string };
    };

    const privileged = (statements: Array<[string, unknown[]]>) => rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        for (const [sql, params] of statements) await c.query(sql, params);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
    });

    it('moving the LAST link of L1 to L2 (with L2 re-totalled) is refused for L1 at COMMIT', async () => {
      const t = await twoLines();
      const r = await refusal(privileged([
        ['UPDATE central_needs_need_line_sources SET need_line_id=$1 WHERE source_record_id=$2', [t.l2, t.x]],
        ['UPDATE central_needs_need_lines SET approved_quantity=30 WHERE id=$1', [t.l2]],
      ]));
      expect(r).toMatchObject({ code: '23514', message: 'need_line_requires_source_lineage' });
      expect(r.detail).toBe(`need_line=${t.l1}`);
      expect((await linksOf(t.l1)).map((l: any) => l.source_record_id)).toEqual([t.x]);
      expect((await linesOf(t.s.revId)).map((l: any) => l.q).sort()).toEqual(['10', '20']);
    });

    it('moving ONE of L1 two links leaves L1 with a mismatched total — refused for L1', async () => {
      const t = await twoLines(true);
      const r = await refusal(privileged([
        ['UPDATE central_needs_need_line_sources SET need_line_id=$1 WHERE source_record_id=$2', [t.l2, t.z]],
        ['UPDATE central_needs_need_lines SET approved_quantity=25 WHERE id=$1', [t.l2]],
      ]));
      expect(r).toMatchObject({ code: '23514', message: 'need_line_quantity_provenance_mismatch' });
      expect(r.detail).toBe(`need_line=${t.l1} approved=15 designated_sum=10`);
      expect(await linksOf(t.l1)).toHaveLength(2);
    });

    it('a re-point that keeps BOTH lines consistent is still accepted', async () => {
      const t = await twoLines(true);
      await privileged([
        ['UPDATE central_needs_need_line_sources SET need_line_id=$1 WHERE source_record_id=$2', [t.l2, t.z]],
        ['UPDATE central_needs_need_lines SET approved_quantity=25 WHERE id=$1', [t.l2]],
        ['UPDATE central_needs_need_lines SET approved_quantity=10 WHERE id=$1', [t.l1]],
      ]);
      expect((await linksOf(t.l2)).map((l: any) => l.source_record_id).sort()).toEqual([t.y, t.z].sort());
    });
  });

  // ---- P. EXACT-DECIMAL READ (review F5) --------------------------------
  describe('P. the read path is exact, end to end', () => {
    const BIG = '12345678901234567.891';
    // The BIG source cell is a native NUMBER stored as an exact jsonb numeric
    // literal (exactNumber), exactly as the CN-2A parser envelope carries it. A
    // TEXT cell that merely looks numeric is ambiguous_numeric_text under C5 and
    // could feed a line only through an explicit numeric override (§9); the read
    // path under test here is the number path, which is unchanged.
    const bigCell = [{ entity: 'sheet:0:row:1', fields: [{ name: 'final', value: BIG, exactNumber: true }] }];

    it(`returns ${BIG} to a JSON client as the exact string, never through a JS number`, async () => {
      const s = await scenario({ rows: bigCell });
      const id = s.records.get('sheet:0:row:1::final')!;
      const [cell] = await admin(
        `SELECT source_values->>'value' AS v, source_values->>'valueType' AS t
           FROM central_needs_source_records WHERE id=$1`, [id]);
      expect(cell).toEqual({ v: BIG, t: 'number' });
      const r = await setLine(U_EDIT, s.revId, { qty: BIG, sources: sources([id, BIG]) });
      expect(r.approved_quantity).toBe(BIG);

      const [line] = await listAsClient(U_EDIT, s.revId);
      expect(typeof line.approved_quantity).toBe('string');
      expect(line.approved_quantity).toBe(BIG);
      expect(typeof line.sources[0].designated_quantity).toBe('string');
      expect(line.sources[0].designated_quantity).toBe(BIG);
    });

    it('proves WHY: the same column read as a table through json_agg is rounded by JSON.parse', async () => {
      const s = await scenario({ rows: bigCell });
      const id = s.records.get('sheet:0:row:1::final')!;
      const r = await setLine(U_EDIT, s.revId, { qty: BIG, sources: sources([id, BIG]) });
      const body = await call(U_EDIT,
        `SELECT coalesce(json_agg(t), '[]'::json)::text AS result
           FROM (SELECT approved_quantity FROM central_needs_need_lines WHERE id=$1) t`, [r.need_line_id]);
      const [decoded] = JSON.parse(body as string);
      expect(typeof decoded.approved_quantity).toBe('number');
      expect(String(decoded.approved_quantity)).not.toBe(BIG);
    });

    it('keeps 120.1239, 0.1 + 0.2 = 0.3, and 0 exact through the same read', async () => {
      const s = await scenario({
        rows: [
          { entity: 'sheet:0:row:1', fields: [{ name: 'final', value: 120.1239 }] },
          { entity: 'sheet:0:row:2', fields: [{ name: 'a', value: 0.1, beneficiary: ORG_BENE2 }, { name: 'b', value: 0.2, beneficiary: ORG_BENE2 }] },
          { entity: 'sheet:0:row:3', item: ITEM_B, fields: [{ name: 'final', value: 0 }] },
        ],
      });
      await setLine(U_EDIT, s.revId, {
        beneficiary: ORG_BENE, qty: '120.1239', sources: sources([s.records.get('sheet:0:row:1::final')!, '120.1239']),
      });
      await setLine(U_EDIT, s.revId, {
        beneficiary: ORG_BENE2, qty: '0.3',
        sources: sources([s.records.get('sheet:0:row:2::a')!, '0.1'], [s.records.get('sheet:0:row:2::b')!, '0.2']),
      });
      await setLine(U_EDIT, s.revId, {
        item: ITEM_B, unit: 'vial', qty: '0', sources: sources([s.records.get('sheet:0:row:3::final')!, '0']),
      });
      const lines = await listAsClient(U_EDIT, s.revId);
      expect(lines.map((l) => l.approved_quantity)).toEqual(['120.1239', '0.3', '0']);
      expect(lines[1].sources.map((x: any) => x.designated_quantity).sort()).toEqual(['0.1', '0.2']);
      for (const l of lines) {
        expect(typeof l.approved_quantity).toBe('string');
        for (const x of l.sources) expect(typeof x.designated_quantity).toBe('string');
      }
    });

    it('grants nothing: another organization and anon read nothing through it', async () => {
      const s = await scenario();
      const id = s.records.get('sheet:0:row:5::final')!;
      await setLine(U_EDIT, s.revId, { sources: sources([id, '100']) });
      expect(await listAsClient(U_OTHER, s.revId)).toEqual([]);
      expect(await refusal(call(null,
        `SELECT count(*)::int AS result FROM public.phoenix_central_needs_list_need_lines($1)`, [s.revId], 'anon')))
        .toMatchObject({ code: '42501', message: 'permission denied for function phoenix_central_needs_list_need_lines' });
    });
  });
});
