/**
 * CN-2B — the only data path the Central Needs UI uses.
 *
 * TWO KINDS OF CALL, and nothing else:
 *   * canonical RPCs on the browser's own Supabase client — every workflow
 *     mutation is a CN-1B/CN-2B SECURITY DEFINER function, re-authorized
 *     server-side. There is no direct INSERT/UPDATE/DELETE on any Central
 *     Needs table anywhere in this file, because `authenticated` holds no such
 *     grant and never should.
 *   * two same-origin trusted endpoints under `/api/central-needs/`, for the
 *     things a browser must not be able to do itself: minting a private
 *     storage capability, and running the authoritative Node 22 replay.
 *
 * Reads are plain selects governed by RLS (`central_needs.view`). A caller
 * without the permission sees nothing — that is the boundary, not a filter
 * applied here. The one exception is the need-line read, a SECURITY INVOKER RPC
 * (still RLS-governed) so its exact decimals arrive as text.
 */
import { supabase } from '@/shared/supabase/client';
import { normalizeSearchText } from '@/shared/lib/search-normalize';
import { resolveMaterials, type MatchGrade } from '@/shared/materials/material-resolver.service';
import { resolveExactCatalogCandidates, type ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import { isTrustedPlanYear, sortRegistryRevisions } from './central-needs.revision-context';

export type ImportSessionStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type RevisionStatus = 'draft' | 'submitted' | 'approved' | 'superseded' | 'rejected';
export type RecordDecision = 'mapped' | 'not_applicable';

export interface PlanRevision {
  id: string;
  planId: string;
  organizationId: string;
  /**
   * The plan year this revision belongs to. Revision numbers restart per plan,
   * so "#1" is ambiguous on its own — every label pairs it with the year.
   */
  planYear: number | null;
  revisionNumber: number;
  status: RevisionStatus;
}

export interface SourceFile {
  id: string;
  planRevisionId: string;
  originalFilename: string;
  fileHash: string;
  byteSize: number | null;
  storageLocator: string | null;
  uploadedAt: string;
}

export interface ImportSession {
  id: string;
  planRevisionId: string;
  sourceFileId: string;
  status: ImportSessionStatus;
  previewDigest: string | null;
  authoritativeDigest: string | null;
  parserIdentity: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
  notes: string | null;
  /**
   * PRE3-B — M211's verbatim archive path of the entry this session parsed;
   * null for a standalone workbook. Optional only so fixtures that predate it
   * stay valid; `listImportSessions` always sets it.
   */
  entryPath?: string | null;
}

export interface ImportBatch {
  id: string;
  planRevisionId: string;
  containerKind: 'file' | 'zip';
  containerFilename: string;
  containerSha256: string;
  acceptedEntryCount: number;
  excludedEntryCount: number;
  registeredAt: string;
}

export interface ImportBatchEntry {
  id: string;
  batchId: string;
  entryOrdinal: number;
  archiveEntryPath: string | null;
  entrySha256: string;
  importSessionId: string;
}

export interface SourceRecord {
  id: string;
  importSessionId: string;
  recordOrdinal: number;
  targetEntity: string;
  fieldName: string;
  sourceValues: Record<string, unknown>;
  sourceProvenance: Record<string, unknown> | null;
}

export interface RecordDisposition {
  id: string;
  importSessionId: string;
  targetEntity: string;
  decision: RecordDecision;
  centralItemId: string | null;
  decisionReason: string | null;
  decidedAt: string;
}

export interface FieldOverride {
  id: string;
  sourceRecordId: string;
  targetEntity: string;
  fieldName: string;
  previousValue: unknown;
  finalValue: unknown;
  /**
   * C5 §15 — `final_value::text` exactly as PostgreSQL printed it. A numeric
   * override's exact decimal lives here: `finalValue` went through JSON.parse,
   * which rounds a value JavaScript cannot represent. Always set by
   * `listOverrides`; optional only so older fixtures stay valid.
   */
  finalValueText?: string | null;
  overrideReason: string;
  overrideNote: string | null;
  createdAt: string;
  /** C5 §13 — `created_at::text` verbatim: the exact keyset cursor text. Always set by `listOverrides`. */
  createdAtText?: string;
}

/** The canonical unit vocabulary, mirroring `central_items.unit`'s own CHECK. */
export const NEED_LINE_UNITS = [
  'box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other',
] as const;
export type NeedLineUnit = (typeof NEED_LINE_UNITS)[number];

/**
 * Set when the source unit could not be safely expressed in the canonical
 * vocabulary. The conversion is never guessed, and such a line blocks approval
 * until a human resolves it (M212).
 */
export type UnitConversionState = 'canonical' | 'conversion_required';

/**
 * The operational Annual Needs projection (M212). One approved requirement per
 * (plan revision, beneficiary organization, central item, warehouse scope).
 * `organizationId` is the OWNING central organization — the beneficiary is its
 * own dimension.
 */
export interface NeedLine {
  id: string;
  planRevisionId: string;
  organizationId: string;
  beneficiaryOrganizationId: string;
  targetWarehouseId: string | null;
  centralItemId: string;
  /**
   * Exact decimal, carried as TEXT in both directions. The column is an
   * unconstrained PostgreSQL `numeric` (M212: a typmod would silently round),
   * and a JavaScript number cannot represent every such value — so the string
   * is the value here, never a display formatting of one. It is read through
   * `phoenix_central_needs_list_need_lines`, which emits it as TEXT; a table
   * read would hand PostgREST's JSON number to JSON.parse and round it.
   */
  approvedQuantity: string;
  approvedUnit: NeedLineUnit | null;
  unitConversionState: UnitConversionState;
  sourceUnitText: string | null;
  mappingReason: string;
  updatedAt: string;
}

/**
 * One designated quantity contribution: the exact immutable source record the
 * reviewer chose, what it contributes, and the override they relied on if any.
 * M212 requires at least one per need line and enforces
 * SUM(designatedQuantity) = approvedQuantity, so this is the provenance of the
 * approved number rather than a loose cross-reference.
 */
export interface NeedLineQuantitySource {
  sourceRecordId: string;
  /** Exact decimal as text, for the same reason as `approvedQuantity`. */
  designatedQuantity: string;
  appliedOverrideId?: string | null;
}

export interface NeedLineSourceLink extends NeedLineQuantitySource {
  needLineId: string;
  appliedOverrideId: string | null;
  /**
   * The linked cell's own identity. Provenance is REVISION-wide, so a line may
   * hold cells from import sessions other than the one on screen.
   */
  importSessionId: string;
  targetEntity: string;
  fieldName: string;
}

/**
 * CN-2B corrective extension (213): one physical imported column's explicit
 * review decision. Identity is (importSessionId, sheetIndex, columnIndex) —
 * read from persisted `source_provenance` server-side, never from header text,
 * which the corpus is proven to duplicate across distinct columns.
 *
 * Independent review finding 1: a column is in exactly one state —
 * `beneficiary` (names one care institution), `non_beneficiary` (names none;
 * an explicit, reasoned, audited human classification), or no decision at all
 * (`null` = UNRESOLVED). UNRESOLVED is never read as "not a beneficiary": the
 * server blocks readiness for every unresolved column that carries numeric
 * evidence on a mapped row.
 */
export type BeneficiaryColumnDecision = 'beneficiary' | 'non_beneficiary';

export interface BeneficiaryColumnMapping {
  importSessionId: string;
  sheetIndex: number;
  columnIndex: number;
  decision: BeneficiaryColumnDecision;
  beneficiaryOrganizationId: string | null;
  sourceFieldName: string | null;
  created: boolean;
  changed: boolean;
}

export interface SetBeneficiaryColumnsInput {
  importSessionId: string;
  sheetIndex: number;
  columnIndex: number;
  decision: BeneficiaryColumnDecision;
  /** The institution for a `beneficiary` decision; `null` for `non_beneficiary`. */
  beneficiaryOrganizationId: string | null;
  /**
   * The decision and beneficiary this column is believed to hold right now —
   * `null` / `null` when the caller believes it is still UNRESOLVED. A mismatch
   * refuses the WHOLE bulk call (`beneficiary_column_mapping_stale`) — no
   * silent overwrite of a decision the caller never saw.
   */
  previousDecision: BeneficiaryColumnDecision | null;
  previousBeneficiaryOrganizationId: string | null;
}

/**
 * The bounded, revision-level summary of every physical candidate beneficiary
 * column — one row per (importSessionId, sheetIndex, columnIndex), never one
 * row per cell. Backs the column-mapping picker without loading the full
 * ~113k-record archive into the browser.
 */
export interface BeneficiaryColumnSummary {
  importSessionId: string;
  originalFilename: string | null;
  archiveEntryPath: string | null;
  sheetIndex: number;
  sheetName: string | null;
  columnIndex: number;
  sourceFieldName: string | null;
  numericValueCount: number;
  zeroValueCount: number;
  nonzeroNumericCount: number;
  mappingId: string | null;
  /** The column's explicit review decision, or `null` = UNRESOLVED. */
  decision: BeneficiaryColumnDecision | null;
  beneficiaryOrganizationId: string | null;
  mappingReason: string | null;
  mappedAt: string | null;
  /** Numeric cells on rows dispositioned `mapped` in completed sessions — what makes a column review-relevant. */
  mappedRowNumericCount: number;
  /** The server's rule: UNRESOLVED and carrying numeric evidence on a mapped row, so it blocks submission. */
  reviewRequired: boolean;
}

export interface ReviewBlocker {
  blocker: string;
  detail: string | null;
}

export interface ReviewReadiness {
  planRevisionId: string;
  status: RevisionStatus;
  ready: boolean;
  blockers: ReviewBlocker[];
}

/**
 * A refusal from a canonical RPC or a read (C5 §14).
 *
 * The fields are kept SEPARATE and never re-derived from one another:
 *   * `businessCode` — the stable machine token every workflow decision reads;
 *   * `sqlstate`     — PostgREST's `error.code`, diagnostic/infrastructure only;
 *   * `message`, `details`, `hint` — verbatim from the server. Reason-specific
 *     copy reads the `reason=` token of `details` (`reasonOf`), never human text;
 *   * `retryable`    — a transient contention (deadlock, lock or statement
 *     timeout, serialization). The person may try again; nothing here retries.
 *
 * `code` stays as an alias of `businessCode` for the existing call sites.
 */
export class CentralNeedsError extends Error {
  public readonly businessCode: string;
  public readonly code: string;
  public readonly sqlstate: string | null;
  public readonly details: string | null;
  public readonly hint: string | null;
  public readonly retryable: boolean;

  constructor(
    businessCode: string,
    message?: string,
    diagnostics: { sqlstate?: string | null; details?: string | null; hint?: string | null; retryable?: boolean } = {},
  ) {
    super(message ?? businessCode);
    this.name = 'CentralNeedsError';
    this.businessCode = businessCode;
    this.code = businessCode;
    this.sqlstate = diagnostics.sqlstate ?? null;
    this.details = diagnostics.details ?? null;
    this.hint = diagnostics.hint ?? null;
    this.retryable = diagnostics.retryable === true;
  }
}

/** A server message IS a business code only when it is exactly one stable token. */
const BUSINESS_TOKEN = /^[a-z][a-z0-9_]*$/;

/**
 * C5 §4 — SQLSTATEs the database never catches or translates: deadlock,
 * lock_not_available, query_canceled (lock/statement timeout) and
 * serialization_failure. They carry no business meaning of their own.
 */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '55P03', '57014', '40001']);

/**
 * Maps a PostgREST error to a `CentralNeedsError` without inventing a code.
 * Anything that is not an exact token — `deadlock detected`, `canceling
 * statement due to lock timeout`, a transport failure — becomes
 * `central_needs_request_failed` with its SQLSTATE kept; a privilege refusal
 * without a token (for example a revoked EXECUTE during an activation freeze)
 * becomes `central_needs_action_unavailable`.
 */
export function centralNeedsErrorFromPostgrest(
  error: { message?: unknown; code?: unknown; details?: unknown; hint?: unknown } | null,
): CentralNeedsError {
  const message = typeof error?.message === 'string' ? error.message : '';
  const sqlstate = typeof error?.code === 'string' && error.code !== '' ? error.code : null;
  const businessCode = BUSINESS_TOKEN.test(message)
    ? message
    : sqlstate === '42501' ? 'central_needs_action_unavailable' : 'central_needs_request_failed';
  return new CentralNeedsError(businessCode, message === '' ? businessCode : message, {
    sqlstate,
    details: typeof error?.details === 'string' ? error.details : null,
    hint: typeof error?.hint === 'string' ? error.hint : null,
    retryable: sqlstate !== null && RETRYABLE_SQLSTATES.has(sqlstate),
  });
}

function fail(error: { message?: unknown; code?: unknown; details?: unknown; hint?: unknown } | null): never {
  throw centralNeedsErrorFromPostgrest(error);
}

/** The pinned `reason=` token of a server DETAIL (C5 §7.2 / §14). Never read from human copy. */
export function reasonOf(details: string | null | undefined): string | null {
  const match = (details ?? '').match(/(?:^|\s)reason=([^\s]+)/);
  return match ? match[1] : null;
}

/** The `source_record=` token of a server DETAIL — the exact cell a lineage refusal names. */
export function sourceRecordOf(details: string | null | undefined): string | null {
  const match = (details ?? '').match(/(?:^|\s)source_record=([^\s]+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Reads (RLS-governed)
// ---------------------------------------------------------------------------

/**
 * C1 — THE canonical registry read. Every screen takes its plan/revision facts
 * from these rows through `central-needs.revision-context`, never from a
 * parallel copy. Existing columns only; nothing is added or inferred.
 */
export async function listPlanRevisions(organizationId: string): Promise<PlanRevision[]> {
  // The plan year is embedded through the existing plan_id foreign key, so a
  // revision can always be labelled "2026 · revision 1" rather than a bare "#1".
  const { data, error } = await supabase
    .from('central_needs_plan_revisions')
    .select('id, plan_id, organization_id, revision_number, status, central_needs_plans(plan_year)')
    .eq('organization_id', organizationId)
    .order('revision_number', { ascending: false });
  if (error) fail(error);
  return sortRegistryRevisions((data ?? []).map((r) => {
    const plan = r.central_needs_plans as { plan_year?: number } | Array<{ plan_year?: number }> | null;
    const planYear = Array.isArray(plan) ? plan[0]?.plan_year : plan?.plan_year;
    return {
      id: r.id as string,
      planId: r.plan_id as string,
      organizationId: r.organization_id as string,
      // Only a year the database could hold is a year; anything else is
      // unavailable, and an unavailable year is never replaced by a guess.
      planYear: isTrustedPlanYear(planYear) ? planYear : null,
      revisionNumber: r.revision_number as number,
      status: r.status as RevisionStatus,
    };
  }));
}

/**
 * I — bounded, authorized source-evidence search.
 *
 * A plain RLS-governed read over the revision's own source files. There is no
 * cross-organization search surface here: RLS answers for the caller, and an
 * ineligible role (M211's restrictive policy) sees nothing at all.
 */
export async function searchSourceFiles(
  planRevisionId: string, query: string, limit = 50,
): Promise<SourceFile[]> {
  let request = supabase
    .from('central_needs_source_files')
    .select('id, plan_revision_id, original_filename, file_hash, byte_size, storage_locator, uploaded_at')
    .eq('plan_revision_id', planRevisionId);

  const term = query.trim();
  if (term !== '') {
    // Filename OR fingerprint prefix. A 64-hex term is treated as a hash.
    request = /^[0-9a-f]{4,64}$/i.test(term)
      ? request.or(`file_hash.ilike.${term}%,original_filename.ilike.%${term}%`)
      : request.ilike('original_filename', `%${term}%`);
  }

  const { data, error } = await request.order('uploaded_at', { ascending: false }).limit(limit);
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    planRevisionId: r.plan_revision_id as string,
    originalFilename: r.original_filename as string,
    fileHash: r.file_hash as string,
    byteSize: (r.byte_size as number | null) ?? null,
    storageLocator: (r.storage_locator as string | null) ?? null,
    uploadedAt: r.uploaded_at as string,
  }));
}

/**
 * PRE3-B — a free-text term as an ILIKE "contains" pattern. `\`, `%` and `_`
 * are escaped so the operator's text is matched as text, not as a pattern.
 * (PostgREST also reads a literal `*` as `%`; that one cannot be escaped and
 * only ever widens a match.)
 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const ENTRY_COLUMNS = 'id, batch_id, entry_ordinal, archive_entry_path, entry_sha256, import_session_id, central_needs_import_batches(container_filename)';

type BatchEntryHit = ImportBatchEntry & { containerFilename: string; batchId: string };

function batchEntryHitOf(r: Record<string, unknown>): BatchEntryHit {
  const batch = r.central_needs_import_batches as { container_filename?: string } | Array<{ container_filename?: string }> | null;
  const containerFilename = (Array.isArray(batch) ? batch[0]?.container_filename : batch?.container_filename) ?? '';
  return {
    id: r.id as string,
    batchId: r.batch_id as string,
    entryOrdinal: r.entry_ordinal as number,
    archiveEntryPath: (r.archive_entry_path as string | null) ?? null,
    entrySha256: r.entry_sha256 as string,
    importSessionId: r.import_session_id as string,
    containerFilename,
  };
}

/** The (batch, ordinal) key every entry read orders by — unique per M211, so a cut is deterministic. */
function compareBatchEntries(a: BatchEntryHit, b: BatchEntryHit): number {
  if (a.batchId !== b.batchId) return a.batchId < b.batchId ? -1 : 1;
  return a.entryOrdinal - b.entryOrdinal;
}

/**
 * The ids of this revision's batches whose container filename contains the
 * term — filtered by the server, ordered, then limited. `limit + 1` rows are
 * asked for so a cut can be reported rather than hidden.
 */
async function batchIdsByContainerFilename(
  planRevisionId: string, term: string, limit: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from('central_needs_import_batches')
    .select('id')
    .eq('plan_revision_id', planRevisionId)
    .ilike('container_filename', likeContains(term))
    .order('registered_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 1);
  if (error) fail(error);
  const ids = (data ?? []).map((r) => r.id as string);
  return { ids: ids.slice(0, limit), truncated: ids.length > limit };
}

/**
 * I — archive members for a revision, so a ZIP entry can be found by its path,
 * its container's filename or its fingerprint prefix. Entry rows carry the
 * verbatim archiveEntryPath as evidence.
 *
 * PRE3-B: every term is matched BY THE SERVER, then ordered, then limited —
 * never "first N rows, then filter in the browser", which silently dropped
 * every match past the cut. Each field is its own bounded query (one plain
 * ILIKE each, no hand-built logic tree); the answers are merged by id and
 * re-ordered by (batch, ordinal). An empty term is the bounded, ordered
 * listing the Work Session labels use.
 */
export async function searchBatchEntries(
  planRevisionId: string, query: string, limit = 100,
): Promise<BatchEntryHit[]> {
  const term = query.trim();
  const entries = () => supabase
    .from('central_needs_import_batch_entries')
    .select(ENTRY_COLUMNS)
    .eq('plan_revision_id', planRevisionId);
  const bounded = (q: ReturnType<typeof entries>) =>
    q.order('batch_id', { ascending: true }).order('entry_ordinal', { ascending: true }).limit(limit);

  const reads: Array<PromiseLike<{ data: unknown; error: unknown }>> = [];
  if (term === '') {
    reads.push(bounded(entries()));
  } else {
    reads.push(bounded(entries().ilike('archive_entry_path', likeContains(term))));
    if (/^[0-9a-f]{4,64}$/i.test(term)) {
      reads.push(bounded(entries().ilike('entry_sha256', `${term.toLowerCase()}%`)));
    }
    reads.push(batchIdsByContainerFilename(planRevisionId, term, limit).then(
      ({ ids }): PromiseLike<{ data: unknown; error: unknown }> => (
        ids.length === 0 ? Promise.resolve({ data: [], error: null }) : bounded(entries().in('batch_id', ids))
      ),
    ));
  }

  const merged = new Map<string, BatchEntryHit>();
  for (const { data, error } of await Promise.all(reads)) {
    if (error) fail(error as Parameters<typeof fail>[0]);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const hit = batchEntryHitOf(row);
      merged.set(hit.id, hit);
    }
  }
  return [...merged.values()].sort(compareBatchEntries).slice(0, limit);
}

/**
 * PRE3 N1 — requested keyset page size for the session enumeration. It is below
 * PostgREST's `max_rows` (supabase/config.toml: 1000), and correctness never
 * depends on either number: a page shorter than requested is simply followed by
 * the next keyset request, and completeness is proven by exact counts.
 */
const IMPORT_SESSION_PAGE_SIZE = 500;

const IMPORT_SESSION_COLUMNS = 'id, plan_revision_id, source_file_id, status, preview_digest, authoritative_digest, '
  + 'parser_identity, started_at, completed_at, notes, entry_path';

/** A uuid exactly as PostgreSQL prints it — the form whose text order is uuid order. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One session's keyset position: the server's own start-time text, its exact instant, and its id. */
interface SessionKey {
  text: string;
  micros: bigint;
  id: string;
}

function compareSessionKeys(a: SessionKey, b: SessionKey): number {
  if (a.micros !== b.micros) return a.micros < b.micros ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The one refusal of an enumeration that cannot be proven complete. `details`
 * pins a `reason=` token (count_unavailable, count_mismatch, overlong_page,
 * unparsable_row, foreign_revision, duplicate, out_of_order) for diagnosis.
 */
function sessionsReadInconsistent(planRevisionId: string, reason: string, detail: string): CentralNeedsError {
  return new CentralNeedsError(
    'import_sessions_read_inconsistent',
    `the import sessions of revision ${planRevisionId} could not be read completely and consistently (${reason}: ${detail})`,
    { details: `reason=${reason} ${detail}` },
  );
}

/** An exact PostgREST count (`Prefer: count=exact`), or null when the response carried none. */
function exactCount(count: unknown): number | null {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/**
 * EVERY import session of ONE revision, in the stable order `started_at ASC,
 * id ASC` that `rankImportSessions` numbers — or a refusal. Never a partial list.
 *
 * PRE3 N1: PostgREST caps any one response at `max_rows` (1000) and says
 * nothing about it (HTTP 200, `Content-Range: 0-999/*`), so an unpaged read
 * silently lost every session after the 1000th — its number, the "of N" total,
 * and any search hit for it. This read is therefore paged, the house keyset way
 * (see `listOverrides`):
 *
 *   * page 1 is the first rows in `(started_at, id)` order; every later page is
 *     strictly after the last row read — its exact start-time text plus its id
 *     (`started_at > t OR (started_at = t AND id > id)`), so a page boundary
 *     inside a run of equal start times neither repeats nor skips a session;
 *   * every page asks for an EXACT count (`Prefer: count=exact`). Page 1's count
 *     is the revision's total; each later page must count exactly the sessions
 *     not yet read. The read ends once every counted session has been read;
 *   * a read that spanned more than one page closes with one more exact count of
 *     the whole revision, which must equal what was read — so a session that
 *     appeared BEHIND the cursor while the pages were read cannot go unnoticed.
 *
 * FAIL CLOSED (`import_sessions_read_inconsistent`): a missing count, a page
 * that disagrees with the counts, a row of another revision, an unparsable
 * id or start time, a repeated session, or a row that is not strictly after the
 * one before it. A failed request throws as every read does. The caller never
 * receives a list it cannot prove complete.
 */
export async function listImportSessions(planRevisionId: string): Promise<ImportSession[]> {
  const out: ImportSession[] = [];
  const seen = new Set<string>();
  const revision = planRevisionId.toLowerCase();
  let total: number | null = null;
  let cursor: SessionKey | null = null;
  let pages = 0;

  for (;;) {
    let query = supabase
      .from('central_needs_import_sessions')
      .select(IMPORT_SESSION_COLUMNS, { count: 'exact' })
      .eq('plan_revision_id', planRevisionId);
    if (cursor !== null) {
      // Strictly after the last row read. Its start-time text was validated
      // (TIMESTAMPTZ_TEXT) and its id is a canonical uuid, so neither can
      // break out of the quoted logic-tree value.
      const at = quotedFilterValue(cursor.text);
      query = query.or(`started_at.gt.${at},and(started_at.eq.${at},id.gt.${cursor.id})`);
    }
    const { data, error, count } = await query
      .order('started_at', { ascending: true })
      // PRE3-B: a deterministic tie-break, so equal start times never swap places.
      .order('id', { ascending: true })
      .limit(IMPORT_SESSION_PAGE_SIZE);
    if (error) fail(error);
    pages += 1;

    const counted = exactCount(count);
    if (counted === null) {
      throw sessionsReadInconsistent(planRevisionId, 'count_unavailable', `page=${pages}`);
    }
    if (total === null) {
      total = counted;
    } else if (counted !== total - out.length) {
      throw sessionsReadInconsistent(planRevisionId, 'count_mismatch',
        `page=${pages} counted_after_cursor=${counted} expected=${total - out.length}`);
    }
    const batch = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (batch.length > counted) {
      throw sessionsReadInconsistent(planRevisionId, 'overlong_page', `page=${pages} rows=${batch.length} counted=${counted}`);
    }
    if (batch.length === 0) {
      // Only an exhausted count may end on an empty page (an empty revision's page 1).
      if (counted !== 0 || out.length !== total) {
        throw sessionsReadInconsistent(planRevisionId, 'count_mismatch',
          `page=${pages} rows=0 counted=${counted} read=${out.length} total=${total}`);
      }
      break;
    }

    for (const r of batch) {
      const id = r.id;
      const text = r.started_at;
      const micros = typeof text === 'string' ? timestampMicros(text) : null;
      if (typeof id !== 'string' || !CANONICAL_UUID.test(id) || typeof text !== 'string' || micros === null) {
        throw sessionsReadInconsistent(planRevisionId, 'unparsable_row', `page=${pages} id=${String(id)}`);
      }
      if (typeof r.plan_revision_id !== 'string' || r.plan_revision_id.toLowerCase() !== revision) {
        throw sessionsReadInconsistent(planRevisionId, 'foreign_revision', `page=${pages} id=${id}`);
      }
      if (seen.has(id)) throw sessionsReadInconsistent(planRevisionId, 'duplicate', `page=${pages} id=${id}`);
      const key: SessionKey = { text, micros, id };
      if (cursor !== null && compareSessionKeys(key, cursor) <= 0) {
        throw sessionsReadInconsistent(planRevisionId, 'out_of_order', `page=${pages} id=${id}`);
      }
      seen.add(id);
      cursor = key;
      out.push({
        id,
        planRevisionId: r.plan_revision_id as string,
        sourceFileId: r.source_file_id as string,
        status: r.status as ImportSessionStatus,
        previewDigest: (r.preview_digest as string | null) ?? null,
        authoritativeDigest: (r.authoritative_digest as string | null) ?? null,
        parserIdentity: (r.parser_identity as Record<string, unknown> | null) ?? null,
        startedAt: text,
        completedAt: (r.completed_at as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
        entryPath: (r.entry_path as string | null) ?? null,
      });
    }
    if (out.length === total) break;
  }

  // One page is one statement: its rows and its count share a snapshot. Several
  // pages are several snapshots, so the whole revision is counted once more.
  if (pages > 1) {
    const { error, count } = await supabase
      .from('central_needs_import_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('plan_revision_id', planRevisionId);
    if (error) fail(error);
    const counted = exactCount(count);
    if (counted === null) throw sessionsReadInconsistent(planRevisionId, 'count_unavailable', 'final');
    if (counted !== out.length) {
      throw sessionsReadInconsistent(planRevisionId, 'count_mismatch', `final counted=${counted} read=${out.length}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PRE3-B — Work Session search
// ---------------------------------------------------------------------------

/** The most sessions any one Work Session search query returns before it reports a cut. */
export const WORK_SESSION_SEARCH_LIMIT = 100;

/**
 * PRE3 N1 — the largest bound a Work Session search honours. Each bounded query
 * asks for one row more than it keeps; PostgREST's `max_rows` (1000) would cap a
 * larger request silently, and the cut would then go unreported. A bigger
 * `limit` is reduced to this, so a cut is still reported as `truncated`.
 */
export const WORK_SESSION_SEARCH_MAX_LIMIT = 999;

/** Why a session matched a Work Session search. Listed in display order. */
export type WorkSessionMatch =
  | 'ordinal'
  | 'session_id'
  | 'session_id_prefix'
  | 'entry_path'
  | 'container_filename'
  | 'source_filename';

export const WORK_SESSION_MATCH_ORDER: readonly WorkSessionMatch[] = [
  'ordinal', 'session_id', 'session_id_prefix', 'entry_path', 'container_filename', 'source_filename',
];

export interface WorkSessionSearchHit {
  importSessionId: string;
  /** Every way this session matched, in WORK_SESSION_MATCH_ORDER. */
  matchedOn: WorkSessionMatch[];
}

export interface WorkSessionSearchResult {
  hits: WorkSessionSearchHit[];
  /** True when any one server query reached its bound — refine the term to see every match. */
  truncated: boolean;
}

/** Arabic-Indic (U+0660..0669) and Extended Arabic-Indic (U+06F0..06F9) digits, read as ASCII. */
function asciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/** A Work Session number as typed: "3", "#3", "٣" or "#٣" → 3. Anything else → null. */
export function parseSessionOrdinal(term: string): number | null {
  const match = /^#?\s*(\d{1,6})$/.exec(asciiDigits(term.trim()));
  if (!match) return null;
  const ordinal = Number(match[1]);
  return ordinal >= 1 ? ordinal : null;
}

function compareSessionStart(a: ImportSession, b: ImportSession): number {
  const am = timestampMicros(a.startedAt);
  const bm = timestampMicros(b.startedAt);
  if (am !== null && bm !== null) {
    if (am !== bm) return am < bm ? -1 : 1;
  } else if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The stable Work Session number of every session of a revision: ALL of its
 * sessions, whatever their status, ordered by start time and then id. It is
 * computed from the complete list and never from a filtered one, so a search
 * can never renumber a session, and a new import only ever appends. The
 * complete list is `listImportSessions`, which pages past PostgREST's
 * `max_rows` and refuses rather than return a partial list (PRE3 N1).
 */
export function rankImportSessions(
  sessions: readonly ImportSession[],
): Map<string, { ordinal: number; total: number }> {
  const ordered = [...sessions].sort(compareSessionStart);
  return new Map(ordered.map((session, index) => [session.id, { ordinal: index + 1, total: ordered.length }]));
}

/**
 * A session-id term: the full UUID, or a prefix of at least four hex digits,
 * typed with or without hyphens (hyphens only where a UUID has them). Returns
 * the inclusive UUID range it covers — a uuid column cannot be ILIKE-matched,
 * and uuid order is the order of its lowercase text — or null.
 */
export function sessionIdRange(term: string): { lo: string; hi: string; exact: boolean } | null {
  const text = term.trim().toLowerCase();
  const hex = text.replace(/-/g, '');
  if (!/^[0-9a-f]{4,32}$/.test(hex)) return null;
  const hyphenate = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  const lo = hyphenate(hex.padEnd(32, '0'));
  if (text.includes('-') && !lo.startsWith(text)) return null;
  return { lo, hi: hyphenate(hex.padEnd(32, 'f')), exact: hex.length === 32 };
}

/**
 * Work Session search: which sessions of ONE revision match a term by archive
 * entry path, container filename, stored source filename, full session id or
 * session-id prefix. (The stable number is matched by the caller against
 * `rankImportSessions`, which needs no query.)
 *
 * Every match is decided by the server — filter, then order, then limit — in
 * small bounded queries, one per field, each asking for one row more than it
 * keeps so a cut is reported (`truncated`) rather than hidden. The answers are
 * merged by session id. A failed query throws: a failure is never an empty
 * result. An empty term searches nothing.
 */
export async function searchWorkSessions(
  planRevisionId: string, query: string, requestedLimit = WORK_SESSION_SEARCH_LIMIT,
): Promise<WorkSessionSearchResult> {
  const term = query.trim();
  if (term === '') return { hits: [], truncated: false };
  const limit = Math.min(Math.max(1, Math.trunc(requestedLimit) || 1), WORK_SESSION_SEARCH_MAX_LIMIT);

  const sessionsOf = () => supabase
    .from('central_needs_import_sessions')
    .select('id')
    .eq('plan_revision_id', planRevisionId);
  const byStart = (q: ReturnType<typeof sessionsOf>) =>
    q.order('started_at', { ascending: true }).order('id', { ascending: true }).limit(limit + 1);

  interface FieldRead { on: WorkSessionMatch; ids: string[]; truncated: boolean }
  const idsOf = async (
    on: WorkSessionMatch,
    request: PromiseLike<{ data: unknown; error: unknown }>,
    column = 'id',
  ): Promise<FieldRead> => {
    const { data, error } = await request;
    if (error) fail(error as Parameters<typeof fail>[0]);
    const ids = ((data ?? []) as Array<Record<string, unknown>>).map((r) => r[column] as string);
    return { on, ids: ids.slice(0, limit), truncated: ids.length > limit };
  };

  const reads: Array<Promise<FieldRead>> = [
    idsOf('entry_path', byStart(sessionsOf().ilike('entry_path', likeContains(term)))),
    // The server picks the matching containers; their entries name the sessions.
    batchIdsByContainerFilename(planRevisionId, term, limit).then(async ({ ids, truncated }) => {
      if (ids.length === 0) return { on: 'container_filename' as const, ids: [], truncated };
      const read = await idsOf('container_filename', supabase
        .from('central_needs_import_batch_entries')
        .select('import_session_id')
        .eq('plan_revision_id', planRevisionId)
        .in('batch_id', ids)
        .order('batch_id', { ascending: true })
        .order('entry_ordinal', { ascending: true })
        .limit(limit + 1), 'import_session_id');
      return { ...read, truncated: read.truncated || truncated };
    }),
    // The stored source file's name. M211 stores byte-identical content once,
    // so this is the name it was first uploaded under.
    (async () => {
      const files = await idsOf('source_filename', supabase
        .from('central_needs_source_files')
        .select('id')
        .eq('plan_revision_id', planRevisionId)
        .ilike('original_filename', likeContains(term))
        .order('uploaded_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit + 1));
      if (files.ids.length === 0) return files;
      const read = await idsOf('source_filename', byStart(sessionsOf().in('source_file_id', files.ids)));
      return { ...read, truncated: read.truncated || files.truncated };
    })(),
  ];
  const range = sessionIdRange(term);
  if (range) {
    reads.push(range.exact
      ? idsOf('session_id', sessionsOf().eq('id', range.lo).order('id', { ascending: true }).limit(limit + 1))
      : idsOf('session_id_prefix', sessionsOf().gte('id', range.lo).lte('id', range.hi).order('id', { ascending: true }).limit(limit + 1)));
  }

  const results = await Promise.all(reads);
  const matched = new Map<string, Set<WorkSessionMatch>>();
  for (const { on, ids } of results) {
    for (const id of ids) matched.set(id, (matched.get(id) ?? new Set<WorkSessionMatch>()).add(on));
  }
  const hits = [...matched.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([importSessionId, on]) => ({
      importSessionId,
      matchedOn: WORK_SESSION_MATCH_ORDER.filter((field) => on.has(field)),
    }));
  return { hits, truncated: results.some((read) => read.truncated) };
}

export async function listImportBatches(planRevisionId: string): Promise<ImportBatch[]> {
  const { data, error } = await supabase
    .from('central_needs_import_batches')
    .select('id, plan_revision_id, container_kind, container_filename, container_sha256, accepted_entry_count, excluded_entry_count, registered_at')
    .eq('plan_revision_id', planRevisionId)
    .order('registered_at', { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    planRevisionId: r.plan_revision_id as string,
    containerKind: r.container_kind as 'file' | 'zip',
    containerFilename: r.container_filename as string,
    containerSha256: r.container_sha256 as string,
    acceptedEntryCount: r.accepted_entry_count as number,
    excludedEntryCount: r.excluded_entry_count as number,
    registeredAt: r.registered_at as string,
  }));
}

export async function listBatchEntries(batchId: string): Promise<ImportBatchEntry[]> {
  const { data, error } = await supabase
    .from('central_needs_import_batch_entries')
    .select('id, batch_id, entry_ordinal, archive_entry_path, entry_sha256, import_session_id')
    .eq('batch_id', batchId)
    .order('entry_ordinal', { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    batchId: r.batch_id as string,
    entryOrdinal: r.entry_ordinal as number,
    archiveEntryPath: (r.archive_entry_path as string | null) ?? null,
    entrySha256: r.entry_sha256 as string,
    importSessionId: r.import_session_id as string,
  }));
}

// PostgREST's own configured `max_rows` (see supabase/config.toml) silently
// truncates any unpaginated select — this is what pagination exists to fix.
// 500 is only the REQUESTED range size; correctness below does NOT depend on
// the server actually honoring it. A response shorter than requested is
// advanced past (by its own actual length, not by 500) rather than treated
// as end-of-data, so this stays correct even if some server-side cap ever
// returns fewer rows per page than requested — see PAGINATION-CONTRACT.md in
// the CN2A-B2-PAGINATION-PREIMPLEMENT evidence bundle for the full page-size
// rationale.
const SOURCE_RECORDS_PAGE_SIZE = 500;

interface SourceRecordRow {
  id: string;
  import_session_id: string;
  record_ordinal: number;
  target_entity: string;
  field_name: string;
  source_values: unknown;
  source_provenance: unknown;
}

export async function listSourceRecords(importSessionId: string): Promise<SourceRecord[]> {
  const rows: SourceRecordRow[] = [];
  let offset = 0;

  // Fail-closed completeness, validated per row as each page arrives rather
  // than after every page has been fetched. The sole INSERT path (M210)
  // assigns record_ordinal via `WITH ORDINALITY` under
  // UNIQUE(import_session_id, record_ordinal), so a completed session's
  // retrieved ordinals are structurally exactly {1..N} — never sort a
  // malformed response silently into shape; any gap, duplicate, or
  // out-of-order ordinal throws instead of ever returning a partial or
  // corrupted dataset. Validating immediately (rather than waiting for the
  // whole fetch to finish) is also what lets the fetch loop below carry NO
  // fixed page-count ceiling: a backend that never returns a genuinely
  // empty page — whether because it is legitimately huge or because it is
  // replaying the same page forever — is stopped by this check, on the
  // very first ordinal that repeats or fails to advance by exactly one,
  // not by an arbitrary page-count guess that a large-enough real dataset
  // could otherwise exceed.
  const seenOrdinals = new Set<number>();
  let expectedOrdinal = 1;

  for (;;) {
    const { data, error } = await supabase
      .from('central_needs_source_records')
      .select('id, import_session_id, record_ordinal, target_entity, field_name, source_values, source_provenance')
      .eq('import_session_id', importSessionId)
      .order('record_ordinal', { ascending: true })
      .range(offset, offset + SOURCE_RECORDS_PAGE_SIZE - 1);
    if (error) fail(error);
    const batch = (data ?? []) as SourceRecordRow[];
    // A genuinely empty page is the one response shape that cannot mean
    // "more data, capped short" — see the PAGE_SIZE comment above.
    if (batch.length === 0) break;

    for (const row of batch) {
      const ordinal = row.record_ordinal;
      if (seenOrdinals.has(ordinal)) {
        throw new CentralNeedsError(
          'source_records_duplicate_ordinal',
          `duplicate record_ordinal ${ordinal} for import session ${importSessionId}`,
        );
      }
      seenOrdinals.add(ordinal);
      if (ordinal !== expectedOrdinal) {
        throw new CentralNeedsError(
          expectedOrdinal === 1 ? 'source_records_ordinal_gap_at_start' : 'source_records_ordinal_gap',
          `expected record_ordinal ${expectedOrdinal}, got ${ordinal} for import session ${importSessionId}`,
        );
      }
      rows.push(row);
      expectedOrdinal += 1;
    }
    // Advance by what was ACTUALLY returned, not by the requested size —
    // see the PAGE_SIZE comment above.
    offset += batch.length;
  }

  return rows.map((r) => ({
    id: r.id,
    importSessionId: r.import_session_id,
    recordOrdinal: r.record_ordinal,
    targetEntity: r.target_entity,
    fieldName: r.field_name,
    sourceValues: (r.source_values ?? {}) as Record<string, unknown>,
    sourceProvenance: (r.source_provenance as Record<string, unknown> | null) ?? null,
  }));
}

export async function listDispositions(importSessionId: string): Promise<RecordDisposition[]> {
  const { data, error } = await supabase
    .from('central_needs_record_mappings')
    .select('id, import_session_id, target_entity, decision, central_item_id, decision_reason, decided_at')
    .eq('import_session_id', importSessionId);
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    importSessionId: r.import_session_id as string,
    targetEntity: r.target_entity as string,
    decision: r.decision as RecordDecision,
    centralItemId: (r.central_item_id as string | null) ?? null,
    decisionReason: (r.decision_reason as string | null) ?? null,
    decidedAt: r.decided_at as string,
  }));
}

/**
 * C5 §13 — requested keyset page size only. It is deliberately below
 * PostgREST's `max_rows` (supabase/config.toml), and correctness never depends
 * on the server honouring it: a page shorter than requested may still be a
 * capped page, so only an explicitly EMPTY next page ends the read.
 */
const OVERRIDE_PAGE_SIZE = 500;

const OVERRIDE_COLUMNS = 'id, source_record_id, target_entity, field_name, previous_value, final_value, '
  + 'final_value_text:final_value::text, override_reason, override_note, created_at, created_at_text:created_at::text';

/** One override's keyset position: the exact server timestamp text, its exact instant, and its id. */
interface OverrideKey {
  text: string;
  micros: bigint;
  id: string;
}

const TIMESTAMPTZ_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?|Z)$/;

/**
 * The exact instant of a PostgreSQL `timestamptz::text`, in microseconds since
 * the epoch, or null when the text is not one. Never a JavaScript Date: a Date
 * keeps milliseconds only, and two overrides one microsecond apart (the M217
 * chronology rule) must still compare as different.
 */
function timestampMicros(text: string): bigint | null {
  const m = TIMESTAMPTZ_TEXT.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = '', sign, oh = '0', om = '0', os = '0'] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(ms)) return null;
  const offsetSeconds = BigInt(Number(oh) * 3600 + Number(om) * 60 + Number(os));
  const offsetMicros = (sign === '-' ? -offsetSeconds : sign === '+' ? offsetSeconds : 0n) * 1_000_000n;
  return BigInt(ms) * 1000n + BigInt(frac.padEnd(6, '0')) - offsetMicros;
}

function compareOverrideKeys(a: OverrideKey, b: OverrideKey): number {
  if (a.micros !== b.micros) return a.micros < b.micros ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** A PostgREST logic-tree value: the timestamp text carries `:` `.` `+` and a space, so it is quoted. */
const quotedFilterValue = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/*
 * C5 §13 (UI-F7) — THE POSTGREST SYNTAX THIS KEYSET READ ASSUMES.
 *
 * These are assumptions about PostgREST and postgrest-js, read from their
 * grammar and source; they are NOT yet proven against a live PostgREST (a
 * live-stack probe that pages >= 2 pages with microsecond ties under a non-UTC
 * session TimeZone is a pending pre-activation item). Every one of them FAILS
 * CLOSED if wrong: a rejected request, an unparsable value or a reordered page
 * throws, the caller marks the chain unavailable, and every override-dependent
 * write is withheld — never a partial or mixed chain.
 *
 *  1. Select casts with aliases — `created_at_text:created_at::text` and
 *     `final_value_text:final_value::text` — are PostgREST select syntax
 *     (`alias:column::type`). If the cast were not applied, `created_at_text`
 *     would be missing and every row fails the exact-keyset check below.
 *  2. `.or(f)` (postgrest-js) only appends the query parameter `or=(f)`
 *     verbatim; nothing is escaped for us. Two `or` parameters on one request
 *     are two top-level logic trees, which PostgREST ANDs — the ceiling AND the
 *     cursor. Were they ORed instead, the first later page would re-deliver
 *     already-read rows and the duplicate-id check throws.
 *  3. Logic-tree values are double-quoted, with `\` and `"` backslash-escaped
 *     (PostgREST's quoted-value grammar), because the timestamp text contains a
 *     space, `:`, `.` and `+`, and must never be split on the tree's reserved
 *     `,` `(` `)`. URLSearchParams then encodes the space as `+` and `+` as
 *     `%2B`; PostgREST's form-urlencoded query decoding turns them back into
 *     the exact text sent. A mis-decoded `+03` offset would move the instant;
 *     the server would then return rows the client's own exact microsecond
 *     comparison rejects (out of order, or above the ceiling).
 *  4. The compared value is the row's own `created_at::text`, so the
 *     `created_at.eq."…"` / `created_at.lt."…"` filters re-parse the very text
 *     PostgreSQL printed. That text carries its UTC offset, so the round trip
 *     is exact to the microsecond whatever the session TimeZone. It must be ISO
 *     DateStyle (`YYYY-MM-DD HH:MM:SS[.ffffff]±HH[:MM[:SS]]`, the PostgreSQL and
 *     Supabase default): any other DateStyle, a BC date or `infinity` fails
 *     TIMESTAMPTZ_TEXT and the chain is unavailable (fail closed). The text
 *     shapes themselves — `+03`, `+05:30`, a historical `+03:06:52`, and the
 *     SQL-DateStyle form that must be refused — were printed by PostgreSQL 17
 *     on the loopback rig (and the `::timestamptz` round trip compared equal);
 *     they are pinned in the keyset tests. Only the PostgREST transport of
 *     points 1-3 is unproven.
 *  5. `id.lt.<uuid>` / `id.lte.<uuid>` are unquoted: a uuid is hex digits and
 *     hyphens only. PostgreSQL orders uuid by its 16 bytes, which is the
 *     lexicographic order of its canonical lowercase text (`uuid_out`), so the
 *     client's string comparison of ids matches the server's `id DESC` tie-break.
 *  6. `max_rows` (supabase/config.toml: 1000) may cap any page below the
 *     requested OVERRIDE_PAGE_SIZE; correctness never depends on either number,
 *     because only an explicitly EMPTY page ends the read.
 */

/**
 * C5 §13 — the revision's COMPLETE override chain, newest first, in the exact
 * server order `created_at DESC, id DESC`. Consumers never re-sort it: the
 * first row of a source record is that record's head (§14).
 *
 *   * Page 1's first row `(created_at_text, id)` is the snapshot CEILING.
 *   * Every later page is strictly older than the cursor — the last row read,
 *     carried as its exact timestamp TEXT plus id — AND not newer than the
 *     ceiling, so an override recorded while the read runs is never mixed in.
 *   * Only an explicitly empty page ends the read. A page exactly at the
 *     server's `max_rows`, or any other short page, is followed by another
 *     keyset request.
 *
 * FAIL CLOSED: a read error, an unparsable timestamp, a repeated id, a row not
 * strictly older than the one before it, or a later-page row newer than the
 * ceiling throws. The caller then marks overrides unavailable and withholds
 * every override-dependent write; a partial chain is never returned.
 */
export async function listOverrides(planRevisionId: string): Promise<FieldOverride[]> {
  const out: FieldOverride[] = [];
  const seen = new Set<string>();
  let ceiling: OverrideKey | null = null;
  let cursor: OverrideKey | null = null;

  for (;;) {
    let query = supabase
      .from('central_needs_field_overrides')
      .select(OVERRIDE_COLUMNS)
      .eq('plan_revision_id', planRevisionId);
    if (ceiling !== null && cursor !== null) {
      // Two top-level logic trees, ANDed by PostgREST (UI-F7 assumption 2):
      // not newer than the ceiling, AND strictly older than the cursor.
      query = query
        .or(`created_at.lt.${quotedFilterValue(ceiling.text)},and(created_at.eq.${quotedFilterValue(ceiling.text)},id.lte.${ceiling.id})`)
        .or(`created_at.lt.${quotedFilterValue(cursor.text)},and(created_at.eq.${quotedFilterValue(cursor.text)},id.lt.${cursor.id})`);
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(OVERRIDE_PAGE_SIZE);
    if (error) fail(error);
    const batch = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (batch.length === 0) break;

    for (const r of batch) {
      const id = r.id;
      const text = r.created_at_text;
      const micros = typeof text === 'string' ? timestampMicros(text) : null;
      if (typeof id !== 'string' || id === '' || typeof text !== 'string' || micros === null) {
        throw new CentralNeedsError('field_overrides_read_inconsistent', `override row without an exact keyset (${String(id)})`);
      }
      if (seen.has(id)) {
        throw new CentralNeedsError('field_overrides_read_inconsistent', `duplicate override ${id}`);
      }
      const key: OverrideKey = { text, micros, id };
      if (ceiling === null) ceiling = key;
      else if (compareOverrideKeys(key, ceiling) > 0) {
        throw new CentralNeedsError('field_overrides_read_inconsistent', `override ${id} is newer than the read ceiling`);
      }
      if (cursor !== null && compareOverrideKeys(key, cursor) >= 0) {
        throw new CentralNeedsError('field_overrides_read_inconsistent', `out-of-order override ${id}`);
      }
      seen.add(id);
      cursor = key;
      out.push({
        id,
        sourceRecordId: r.source_record_id as string,
        targetEntity: r.target_entity as string,
        fieldName: r.field_name as string,
        previousValue: r.previous_value,
        finalValue: r.final_value,
        finalValueText: typeof r.final_value_text === 'string' ? r.final_value_text : null,
        overrideReason: r.override_reason as string,
        overrideNote: (r.override_note as string | null) ?? null,
        createdAt: r.created_at as string,
        createdAtText: text,
      });
    }
  }
  return out;
}

/** A plain decimal exactly as PostgreSQL prints `numeric::text` — never an exponent. */
const EXACT_DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * An exact quantity from the need-line read RPC. It MUST arrive as a string:
 * a JSON number has already been through JSON.parse, which rounds a large
 * unconstrained numeric before any code here runs. A value that is not an exact
 * decimal string is refused rather than shown as if it were the approved one.
 */
function exactQuantity(value: unknown): string {
  if (typeof value !== 'string' || !EXACT_DECIMAL_TEXT.test(value)) {
    throw new CentralNeedsError(
      'need_line_quantity_not_exact', `expected an exact decimal string, received ${typeof value}`);
  }
  return value;
}

/**
 * The operational need lines of one revision with their REVISION-wide
 * provenance, through the exact-decimal read RPC (M212 section 4c).
 *
 * Deliberately NOT a table read. PostgREST serializes a `numeric` column as a
 * JSON number, and supabase-js decodes it with JSON.parse, so an unconstrained
 * value such as 12345678901234567.891 would reach this module as
 * 12345678901234568 — already rounded, whatever this code did next. The RPC
 * emits both quantities as TEXT. It is SECURITY INVOKER, so RLS still answers
 * for the caller: without `central_needs.view` there are no rows.
 *
 * Each link carries its cell's own identity (session, row, field), so a line's
 * lineage can be shown in full even for cells outside the session on screen.
 */
export async function listNeedLineLineage(
  planRevisionId: string,
): Promise<{ needLines: NeedLine[]; sources: NeedLineSourceLink[] }> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_list_need_lines', {
    p_plan_revision_id: planRevisionId,
  });
  if (error) fail(error);
  const needLines: NeedLine[] = [];
  const sources: NeedLineSourceLink[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const id = r.id as string;
    needLines.push({
      id,
      planRevisionId: r.plan_revision_id as string,
      organizationId: r.organization_id as string,
      beneficiaryOrganizationId: r.beneficiary_organization_id as string,
      targetWarehouseId: (r.target_warehouse_id as string | null) ?? null,
      centralItemId: r.central_item_id as string,
      approvedQuantity: exactQuantity(r.approved_quantity),
      approvedUnit: (r.approved_unit as NeedLineUnit | null) ?? null,
      unitConversionState: r.unit_conversion_state as UnitConversionState,
      sourceUnitText: (r.source_unit_text as string | null) ?? null,
      mappingReason: r.mapping_reason as string,
      updatedAt: r.updated_at as string,
    });
    for (const s of (r.sources ?? []) as Array<Record<string, unknown>>) {
      sources.push({
        needLineId: id,
        sourceRecordId: s.source_record_id as string,
        designatedQuantity: exactQuantity(s.designated_quantity),
        appliedOverrideId: (s.applied_override_id as string | null) ?? null,
        importSessionId: s.import_session_id as string,
        targetEntity: s.target_entity as string,
        fieldName: s.field_name as string,
      });
    }
  }
  return { needLines, sources };
}

// ---------------------------------------------------------------------------
// Canonical RPC writes — every one of these is a CN-1B/CN-2B RPC.
// ---------------------------------------------------------------------------

/**
 * G — open (or reuse) the NEW / current annual draft for one plan year.
 *
 * This is the FIRST-revision / reuse-current call only: the server returns the
 * existing open draft when there is one, so it is safe to press twice and never
 * silently creates a second draft. C2 (M215) closed the legacy correction path
 * of this RPC (`p_open_next_revision = true` now fails with
 * `central_needs_governed_correction_required`), so the flag is fixed to the
 * literal `false` here and a correction goes through `openCorrectionRevision`.
 * There is no automatic revision creation anywhere in this feature.
 */
export async function openPlanRevision(
  organizationId: string,
  planYear: number,
  openNextRevision: false = false,
): Promise<{ planRevisionId: string; revisionNumber: number; planYear: number; idempotent: boolean }> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_open_plan_revision', {
    p_organization_id: organizationId,
    p_plan_year: planYear,
    p_open_next_revision: openNextRevision,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return {
    planRevisionId: row.plan_revision_id as string,
    revisionNumber: row.revision_number as number,
    planYear,
    idempotent: row.idempotent_replay === true,
  };
}

/**
 * C2 — open a correction DRAFT after the closed newest revision of a plan year
 * (M215 `phoenix_central_needs_open_correction_revision`).
 *
 * `expectedLatestRevisionId` is the stale-predecessor fence: the server refuses
 * with `central_needs_revision_stale` and writes nothing unless it is still the
 * plan's newest revision. That refusal is surfaced as-is — this function never
 * refreshes and retries. `reason` is mandatory; the server trims it and refuses
 * blank text with `correction_reason_required`. The approved revision stays in
 * effect until the correction itself is approved.
 */
export async function openCorrectionRevision(
  organizationId: string,
  planYear: number,
  expectedLatestRevisionId: string,
  reason: string,
): Promise<{
  planRevisionId: string;
  revisionNumber: number;
  planYear: number;
  openedAfterRevisionId: string;
  effectiveApprovedRevisionId: string | null;
}> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_open_correction_revision', {
    p_organization_id: organizationId,
    p_plan_year: planYear,
    p_expected_latest_revision_id: expectedLatestRevisionId,
    p_reason: reason,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return {
    planRevisionId: row.plan_revision_id as string,
    revisionNumber: row.revision_number as number,
    planYear,
    openedAfterRevisionId: row.opened_after_revision_id as string,
    effectiveApprovedRevisionId: (row.effective_approved_revision_id as string | null) ?? null,
  };
}

/** One lifecycle event of a plan year (M215 `phoenix_central_needs_revision_lifecycle`). */
export interface RevisionLifecycleEvent {
  action: 'open' | 'open_correction' | 'submit' | 'approve' | 'reject' | 'supersede';
  revisionId: string;
  revisionNumber: number | null;
  occurredAt: string;
  actorId: string | null;
  actorRole: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  openedAfterRevisionId: string | null;
  effectiveApprovedRevisionId: string | null;
  predecessorRevisionId: string | null;
  supersededByRevisionId: string | null;
}

/** One revision of the plan year, as `revision_lifecycle` lists it (M215 `revisions`). */
export interface RevisionLifecycleRevision {
  id: string;
  revisionNumber: number;
  status: RevisionStatus;
  /** The server's per-revision flag: status is `approved`. */
  effective: boolean;
}

export interface RevisionLifecycle {
  planId: string | null;
  planYear: number;
  /**
   * The server's newest-first single-row pick of an approved revision. A
   * DISPLAY input only (C4): never read it without `revisions`, because only
   * the full list can show that more than one revision is approved.
   */
  effectiveRevisionId: string | null;
  /** Every revision of the plan year, in revision order. */
  revisions: RevisionLifecycleRevision[];
  events: RevisionLifecycleEvent[];
}

/**
 * C2 — the narrow lifecycle history of ONE plan year: which revision was
 * corrected, which successor was created, by whom, when and why. Authorized by
 * `central_needs.view` server-side; it is not a generic audit reader.
 */
export async function fetchRevisionLifecycle(organizationId: string, planYear: number): Promise<RevisionLifecycle> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_revision_lifecycle', {
    p_organization_id: organizationId,
    p_plan_year: planYear,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    planId: str(row.plan_id),
    planYear,
    effectiveRevisionId: str(row.effective_revision_id),
    revisions: ((row.revisions ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      revisionNumber: Number(r.revision_number),
      status: r.status as RevisionStatus,
      effective: r.effective === true,
    })),
    events: ((row.events ?? []) as Array<Record<string, unknown>>).map((e) => ({
      action: String(e.action).replace('central_needs.plan_revision.', '') as RevisionLifecycleEvent['action'],
      revisionId: e.revision_id as string,
      revisionNumber: typeof e.revision_number === 'number' ? e.revision_number : null,
      occurredAt: e.occurred_at as string,
      actorId: str(e.actor_id),
      actorRole: str(e.actor_role),
      fromStatus: str(e.from_status),
      toStatus: str(e.to_status),
      reason: str(e.reason),
      openedAfterRevisionId: str(e.opened_after_revision_id),
      effectiveApprovedRevisionId: str(e.effective_approved_revision_id),
      predecessorRevisionId: str(e.predecessor_revision_id),
      supersededByRevisionId: str(e.superseded_by_revision_id),
    })),
  };
}

/** The general disposition write. `not_applicable` requires a reason server-side. */
export async function setRecordDisposition(input: {
  importSessionId: string;
  targetEntity: string;
  decision: RecordDecision;
  centralItemId?: string | null;
  decisionReason?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('phoenix_central_needs_set_record_disposition', {
    p_import_session_id: input.importSessionId,
    p_target_entity: input.targetEntity,
    p_decision: input.decision,
    p_central_item_id: input.decision === 'mapped' ? input.centralItemId ?? null : null,
    p_decision_reason: input.decision === 'not_applicable' ? input.decisionReason ?? null : null,
  });
  if (error) fail(error);
}

/**
 * Create one operational need line, or ADD provenance to the existing line of
 * the same scope (M212 section 4a). It never removes a link: removal is only
 * `deleteNeedLine`, with a reason.
 *
 * Everything here is re-validated server-side — beneficiary eligibility,
 * warehouse ownership and active status, unit vocabulary, conversion state,
 * quantity sign, revision editability, source lineage and the caller's expected
 * lineage. The UI's own checks exist to give a fast answer, never to be the
 * authority.
 *
 * `approvedQuantity` is the line's total AFTER this call (what it held plus
 * what is added), passed as a string so an exact decimal reaches PostgreSQL's
 * `numeric` without a JavaScript float in the middle.
 */
export async function setNeedLine(input: {
  planRevisionId: string;
  beneficiaryOrganizationId: string;
  centralItemId: string;
  approvedQuantity: string;
  mappingReason: string;
  /**
   * MANDATORY. M212 gives the RPC parameter no default, so there is no shape of
   * this call that persists a need line with no provenance — and deliberately no
   * `?? []` here either: an omitted lineage must fail, never become an empty
   * array on its way to the server.
   */
  quantitySources: NeedLineQuantitySource[];
  /**
   * MANDATORY. The source records this scope's line holds as the caller last
   * loaded it — an empty array when it expects no line yet. The server refuses
   * a view that no longer matches (`need_line_lineage_stale`) instead of letting
   * a session-limited save act on provenance it never saw.
   */
  expectedSourceRecordIds: string[];
  approvedUnit?: NeedLineUnit | null;
  unitConversionState?: UnitConversionState;
  targetWarehouseId?: string | null;
  sourceUnitText?: string | null;
}): Promise<{
  needLineId: string; created: boolean; sourceLinkCount: number; addedLinkCount: number; approvedQuantity: string;
}> {
  const state = input.unitConversionState ?? 'canonical';
  const { data, error } = await supabase.rpc('phoenix_central_needs_set_need_line', {
    p_plan_revision_id: input.planRevisionId,
    p_beneficiary_organization_id: input.beneficiaryOrganizationId,
    p_central_item_id: input.centralItemId,
    p_approved_quantity: input.approvedQuantity,
    p_mapping_reason: input.mappingReason,
    p_quantity_sources: input.quantitySources.map((s) => ({
      sourceRecordId: s.sourceRecordId,
      // Strings, so PostgreSQL casts the exact decimal itself.
      designatedQuantity: s.designatedQuantity,
      appliedOverrideId: s.appliedOverrideId ?? null,
    })),
    p_expected_source_record_ids: input.expectedSourceRecordIds,
    // A conversion-required line carries no canonical unit, by contract.
    p_approved_unit: state === 'conversion_required' ? null : input.approvedUnit ?? null,
    p_unit_conversion_state: state,
    p_target_warehouse_id: input.targetWarehouseId ?? null,
    p_source_unit_text: input.sourceUnitText ?? null,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return {
    needLineId: row.need_line_id as string,
    created: row.created === true,
    sourceLinkCount: Number(row.source_link_count ?? 0),
    addedLinkCount: Number(row.added_link_count ?? 0),
    approvedQuantity: String(row.approved_quantity ?? ''),
  };
}

/**
 * The explicit correction path (M212 section 4b): delete one DRAFT need line
 * and its source links, with a mandatory reason, audited server-side. Source
 * evidence is never touched. The caller states the links it saw, so a line that
 * gained provenance since is refused rather than removed unseen.
 */
export async function deleteNeedLine(input: {
  needLineId: string;
  reason: string;
  expectedSourceRecordIds: string[];
}): Promise<{ needLineId: string; deletedSourceCount: number }> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_delete_need_line', {
    p_need_line_id: input.needLineId,
    p_reason: input.reason,
    p_expected_source_record_ids: input.expectedSourceRecordIds,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return {
    needLineId: row.need_line_id as string,
    deletedSourceCount: Number(row.deleted_source_count ?? 0),
  };
}

/**
 * CN-2B corrective extension (213): record one or more physical columns'
 * explicit review decisions atomically — one user confirmation for the whole batch. Never
 * assigns a whole uploaded file/workbook to one beneficiary; each physical
 * column is confirmed and persisted independently, even when several share
 * the same `beneficiaryOrganizationId` in one call.
 */
export async function setBeneficiaryColumns(input: {
  planRevisionId: string;
  mappings: SetBeneficiaryColumnsInput[];
  mappingReason: string;
}): Promise<{ confirmed: BeneficiaryColumnMapping[] }> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_set_beneficiary_columns', {
    p_plan_revision_id: input.planRevisionId,
    p_mappings: input.mappings.map((m) => ({
      importSessionId: m.importSessionId,
      sheetIndex: m.sheetIndex,
      columnIndex: m.columnIndex,
      decision: m.decision,
      beneficiaryOrganizationId: m.beneficiaryOrganizationId,
      previousDecision: m.previousDecision,
      previousBeneficiaryOrganizationId: m.previousBeneficiaryOrganizationId,
    })),
    p_mapping_reason: input.mappingReason,
  });
  if (error) fail(error);
  const rows = ((data as Record<string, unknown>).confirmed ?? []) as Array<Record<string, unknown>>;
  return {
    confirmed: rows.map((r) => ({
      importSessionId: r.importSessionId as string,
      sheetIndex: Number(r.sheetIndex),
      columnIndex: Number(r.columnIndex),
      decision: r.decision as BeneficiaryColumnDecision,
      beneficiaryOrganizationId: (r.beneficiaryOrganizationId as string | null) ?? null,
      sourceFieldName: (r.sourceFieldName as string | null) ?? null,
      created: r.created === true,
      changed: r.changed === true,
    })),
  };
}

/**
 * The bounded column-summary read (213). SECURITY INVOKER, RLS-governed —
 * grants nothing beyond what the caller's own `central_needs.view` already
 * allows, same posture as `fetchNeedLines` below.
 */
export async function listBeneficiaryColumns(planRevisionId: string): Promise<BeneficiaryColumnSummary[]> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_list_beneficiary_columns', {
    p_plan_revision_id: planRevisionId,
  });
  if (error) fail(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    importSessionId: row.import_session_id as string,
    originalFilename: (row.original_filename as string | null) ?? null,
    archiveEntryPath: (row.archive_entry_path as string | null) ?? null,
    sheetIndex: Number(row.sheet_index),
    sheetName: (row.sheet_name as string | null) ?? null,
    columnIndex: Number(row.column_index),
    sourceFieldName: (row.source_field_name as string | null) ?? null,
    numericValueCount: Number(row.numeric_value_count ?? 0),
    zeroValueCount: Number(row.zero_value_count ?? 0),
    nonzeroNumericCount: Number(row.nonzero_numeric_count ?? 0),
    mappingId: (row.mapping_id as string | null) ?? null,
    decision: (row.column_decision as BeneficiaryColumnDecision | null) ?? null,
    beneficiaryOrganizationId: (row.beneficiary_organization_id as string | null) ?? null,
    mappingReason: (row.mapping_reason as string | null) ?? null,
    mappedAt: (row.mapped_at as string | null) ?? null,
    mappedRowNumericCount: Number(row.mapped_row_numeric_count ?? 0),
    reviewRequired: row.review_required === true,
  }));
}

// ---------------------------------------------------------------------------
// C4 (M216) — beneficiary regions
//
// A region is one rectangle of one sheet of one import session with an
// explicit human decision. The server keeps immutable VERSIONS: `regionId` is
// the logical region, `versionId` one decision about it. The working view is
// the ACTIVE versions only; a retired version is history and is never shown
// as current, never fenced and never re-used.
// ---------------------------------------------------------------------------

/** A whole physical column, as a region stores it: rows 0..1,048,575. */
export const REGION_WHOLE_COLUMN_ROW_END = 1_048_575;
export const REGION_MAX_COLUMN_INDEX = 16_383;

export type BeneficiaryRegionDecision = 'beneficiary' | 'non_beneficiary';

/** One ACTIVE region version: the server's current decision for one rectangle. */
export interface BeneficiaryRegionVersion {
  versionId: string;
  regionId: string;
  versionNo: number;
  supersedesVersionId: string | null;
  planRevisionId: string;
  importSessionId: string;
  sheetIndex: number;
  /** 0-based, inclusive, the parser's physical frame. */
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
  decision: BeneficiaryRegionDecision;
  beneficiaryOrganizationId: string | null;
  decisionReason: string;
  decidedBy: string | null;
  decidedAt: string;
}

export type BeneficiaryRegionChange =
  | { op: 'add'; rowStart: number; rowEnd: number; columnStart: number; columnEnd: number;
      decision: BeneficiaryRegionDecision; beneficiaryOrganizationId: string | null }
  | { op: 'replace'; versionId: string; rowStart: number; rowEnd: number; columnStart: number; columnEnd: number;
      decision: BeneficiaryRegionDecision; beneficiaryOrganizationId: string | null }
  | { op: 'remove'; versionId: string }
  /**
   * B2: convert one M213-decided column to regions. The four fence values are
   * sent back EXACTLY as last read (id, decision, beneficiary — null for a
   * `non_beneficiary` row — and `mapped_at` verbatim, never re-formatted). The
   * same call must carry at least one add/replace over the column; nothing is
   * ever copied from the M213 row.
   */
  | { op: 'convert_column'; columnIndex: number; expectedMappingId: string;
      previousDecision: BeneficiaryColumnDecision; previousBeneficiaryOrganizationId: string | null;
      previousMappedAt: string };

/** The rendering parser, as the client asserts it — a refuse-only witness. */
export interface RenderedParserIdentity {
  contractVersion: string;
  sheetjsVersion: string;
  sheetjsTarballSha256: string;
}

export interface SetBeneficiaryRegionsResult {
  operationBatchId: string;
  /** The COMPLETE final ACTIVE set of the scope — the next write's fence. */
  activeVersions: BeneficiaryRegionVersion[];
  changes: Array<{ op: 'add' | 'replace' | 'remove'; regionId: string; previousVersionId: string | null; newVersionId: string | null }>;
  convertedColumns: Array<{ columnIndex: number; retiredMappingId: string }>;
}

/**
 * The ONE write path of beneficiary regions. One call covers exactly one
 * (import session, sheet) and is atomic server-side: every refusal writes
 * nothing. `expectedVersionIds` is the COMPLETE set of ACTIVE version ids the
 * human last loaded for this sheet (empty when they believe there are none);
 * a stale set is refused as `beneficiary_region_stale`. This function never
 * refreshes that set and never retries — a refusal is surfaced as-is.
 */
export async function setBeneficiaryRegions(input: {
  planRevisionId: string;
  importSessionId: string;
  sheetIndex: number;
  renderedParserIdentity: RenderedParserIdentity;
  expectedSheetName: string;
  expectedVersionIds: readonly string[];
  changes: readonly BeneficiaryRegionChange[];
  reason: string;
}): Promise<SetBeneficiaryRegionsResult> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_set_beneficiary_regions', {
    p_plan_revision_id: input.planRevisionId,
    p_import_session_id: input.importSessionId,
    p_sheet_index: input.sheetIndex,
    p_rendered_parser_identity: {
      contractVersion: input.renderedParserIdentity.contractVersion,
      sheetjsVersion: input.renderedParserIdentity.sheetjsVersion,
      sheetjsTarballSha256: input.renderedParserIdentity.sheetjsTarballSha256,
    },
    p_expected_sheet_name: input.expectedSheetName,
    p_expected_version_ids: [...input.expectedVersionIds],
    p_changes: input.changes.map((c) => {
      switch (c.op) {
        case 'remove':
          return { op: 'remove', versionId: c.versionId };
        case 'convert_column':
          return {
            op: 'convert_column',
            columnIndex: c.columnIndex,
            expectedMappingId: c.expectedMappingId,
            previousDecision: c.previousDecision,
            previousBeneficiaryOrganizationId: c.previousBeneficiaryOrganizationId,
            previousMappedAt: c.previousMappedAt,
          };
        default:
          return {
            op: c.op,
            ...(c.op === 'replace' ? { versionId: c.versionId } : {}),
            rowStart: c.rowStart,
            rowEnd: c.rowEnd,
            columnStart: c.columnStart,
            columnEnd: c.columnEnd,
            decision: c.decision,
            beneficiaryOrganizationId: c.beneficiaryOrganizationId,
          };
      }
    }),
    p_reason: input.reason,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return {
    operationBatchId: row.operation_batch_id as string,
    activeVersions: ((row.active_versions ?? []) as Array<Record<string, unknown>>).map((v) => regionVersionFromRow({
      ...v,
      plan_revision_id: row.plan_revision_id,
      import_session_id: row.import_session_id,
      sheet_index: row.sheet_index,
    })),
    changes: ((row.changes ?? []) as Array<Record<string, unknown>>).map((c) => ({
      op: c.op as 'add' | 'replace' | 'remove',
      regionId: c.regionId as string,
      previousVersionId: (c.previousVersionId as string | null) ?? null,
      newVersionId: (c.newVersionId as string | null) ?? null,
    })),
    convertedColumns: ((row.converted_columns ?? []) as Array<Record<string, unknown>>).map((c) => ({
      columnIndex: Number(c.columnIndex),
      retiredMappingId: c.retiredMappingId as string,
    })),
  };
}

function regionVersionFromRow(r: Record<string, unknown>): BeneficiaryRegionVersion {
  return {
    versionId: r.version_id as string,
    regionId: r.region_id as string,
    versionNo: Number(r.version_no),
    supersedesVersionId: (r.supersedes_version_id as string | null) ?? null,
    planRevisionId: r.plan_revision_id as string,
    importSessionId: r.import_session_id as string,
    sheetIndex: Number(r.sheet_index),
    rowStart: Number(r.row_start),
    rowEnd: Number(r.row_end),
    columnStart: Number(r.column_start),
    columnEnd: Number(r.column_end),
    decision: r.decision as BeneficiaryRegionDecision,
    beneficiaryOrganizationId: (r.beneficiary_organization_id as string | null) ?? null,
    decisionReason: r.decision_reason as string,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: r.decided_at as string,
  };
}

/** Requested page size only; correctness never depends on the server honouring it. */
const REGION_PAGE_SIZE = 500;

const regionsIntersect = (a: BeneficiaryRegionVersion, b: BeneficiaryRegionVersion): boolean =>
  a.importSessionId === b.importSessionId && a.sheetIndex === b.sheetIndex
  && a.rowStart <= b.rowEnd && b.rowStart <= a.rowEnd
  && a.columnStart <= b.columnEnd && b.columnStart <= a.columnEnd;

/**
 * The region WORKING VIEW: every ACTIVE version of a revision — optionally of
 * one (session, sheet) — read directly under RLS, in the deterministic order
 * (import session, sheet, row start, column start, version id), in ranged
 * pages that end ONLY on an empty page and advance by the rows actually
 * returned. A short page is never taken as the end.
 *
 * FAIL CLOSED: a read error, a duplicate or out-of-order version, two ACTIVE
 * versions of one region or with one geometry, or two intersecting ACTIVE
 * rectangles throws — the caller then shows the layer as unavailable and
 * disables every write. It never returns a partial or repaired set.
 */
export async function listBeneficiaryRegions(input: {
  planRevisionId: string;
  importSessionId?: string;
  sheetIndex?: number;
}): Promise<BeneficiaryRegionVersion[]> {
  const out: BeneficiaryRegionVersion[] = [];
  const seenVersions = new Set<string>();
  const seenRegions = new Set<string>();
  const seenGeometry = new Set<string>();
  let offset = 0;
  let previousKey: [string, number, number, number, string] | null = null;

  for (;;) {
    let query = supabase
      .from('central_needs_beneficiary_regions')
      .select('version_id, region_id, version_no, supersedes_version_id, plan_revision_id, import_session_id, sheet_index, '
        + 'row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason, decided_by, decided_at')
      .eq('plan_revision_id', input.planRevisionId)
      .is('retired_at', null);
    if (input.importSessionId !== undefined) query = query.eq('import_session_id', input.importSessionId);
    if (input.sheetIndex !== undefined) query = query.eq('sheet_index', input.sheetIndex);
    const { data, error } = await query
      .order('import_session_id', { ascending: true })
      .order('sheet_index', { ascending: true })
      .order('row_start', { ascending: true })
      .order('column_start', { ascending: true })
      .order('version_id', { ascending: true })
      .range(offset, offset + REGION_PAGE_SIZE - 1);
    if (error) fail(error);
    const batch = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (batch.length === 0) break;

    for (const raw of batch) {
      const v = regionVersionFromRow(raw);
      if (seenVersions.has(v.versionId)) {
        throw new CentralNeedsError('beneficiary_regions_read_inconsistent', `duplicate version ${v.versionId}`);
      }
      const key: [string, number, number, number, string] = [v.importSessionId, v.sheetIndex, v.rowStart, v.columnStart, v.versionId];
      if (previousKey !== null && compareRegionKey(previousKey, key) >= 0) {
        throw new CentralNeedsError('beneficiary_regions_read_inconsistent', `out-of-order version ${v.versionId}`);
      }
      if (seenRegions.has(v.regionId)) {
        throw new CentralNeedsError('beneficiary_regions_read_inconsistent', `two ACTIVE versions of region ${v.regionId}`);
      }
      const geometry = `${v.importSessionId}:${v.sheetIndex}:${v.rowStart}:${v.rowEnd}:${v.columnStart}:${v.columnEnd}`;
      if (seenGeometry.has(geometry)) {
        throw new CentralNeedsError('beneficiary_regions_read_inconsistent', `two ACTIVE versions with geometry ${geometry}`);
      }
      seenVersions.add(v.versionId);
      seenRegions.add(v.regionId);
      seenGeometry.add(geometry);
      previousKey = key;
      out.push(v);
    }
    offset += batch.length;
  }

  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      if (regionsIntersect(out[i], out[j])) {
        throw new CentralNeedsError('beneficiary_regions_read_inconsistent',
          `ACTIVE versions ${out[i].versionId} and ${out[j].versionId} intersect`);
      }
    }
  }
  return out;
}

function compareRegionKey(a: [string, number, number, number, string], b: [string, number, number, number, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  for (let i = 1; i <= 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  if (a[4] === b[4]) return 0;
  return a[4] < b[4] ? -1 : 1;
}

/** One M213 whole-column decision of one (session, sheet), with its exact conversion fence values. */
export interface ScopeColumnMapping {
  mappingId: string;
  importSessionId: string;
  sheetIndex: number;
  columnIndex: number;
  decision: BeneficiaryColumnDecision;
  beneficiaryOrganizationId: string | null;
  /** Exactly as the server rendered it — sent back verbatim as a conversion fence. */
  mappedAt: string;
}

/**
 * The M213 rows of one (session, sheet), read directly under RLS with the
 * same paging and fail-closed rules as the region read. Each row carries its
 * id and `mapped_at` exactly as returned, so a conversion can state the exact
 * M213 fence.
 */
export async function listScopeColumnMappings(input: {
  planRevisionId: string;
  importSessionId: string;
  sheetIndex: number;
}): Promise<ScopeColumnMapping[]> {
  const out: ScopeColumnMapping[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let previousColumn = -1;
  for (;;) {
    const { data, error } = await supabase
      .from('central_needs_beneficiary_column_mappings')
      .select('id, import_session_id, sheet_index, column_index, decision, beneficiary_organization_id, mapped_at')
      .eq('plan_revision_id', input.planRevisionId)
      .eq('import_session_id', input.importSessionId)
      .eq('sheet_index', input.sheetIndex)
      .order('column_index', { ascending: true })
      .range(offset, offset + REGION_PAGE_SIZE - 1);
    if (error) fail(error);
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    if (batch.length === 0) break;
    for (const r of batch) {
      const id = r.id as string;
      const columnIndex = Number(r.column_index);
      if (seen.has(id) || columnIndex <= previousColumn || typeof r.mapped_at !== 'string') {
        throw new CentralNeedsError('beneficiary_regions_read_inconsistent', `inconsistent M213 row ${id}`);
      }
      seen.add(id);
      previousColumn = columnIndex;
      out.push({
        mappingId: id,
        importSessionId: r.import_session_id as string,
        sheetIndex: Number(r.sheet_index),
        columnIndex,
        decision: r.decision as BeneficiaryColumnDecision,
        beneficiaryOrganizationId: (r.beneficiary_organization_id as string | null) ?? null,
        mappedAt: r.mapped_at,
      });
    }
    offset += batch.length;
  }
  return out;
}

/**
 * Records one reasoned override. The new override's id is returned for the
 * record only — it is never pinned automatically (C5 §14): after an override
 * is created the caller re-reads the chain, and any need-line designation that
 * relied on an older head is cleared for the reviewer to choose again.
 */
export async function recordFieldOverride(input: {
  sourceRecordId: string;
  finalValue: unknown;
  overrideReason: string;
  overrideNote?: string | null;
  overrideReference?: string | null;
}): Promise<{ overrideId: string | null }> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_record_field_override', {
    p_source_record_id: input.sourceRecordId,
    p_final_value: input.finalValue,
    p_override_reason: input.overrideReason,
    p_override_note: input.overrideNote ?? null,
    p_override_reference: input.overrideReference ?? null,
  });
  if (error) fail(error);
  const row = (data ?? null) as Record<string, unknown> | null;
  return { overrideId: typeof row?.override_id === 'string' ? row.override_id : null };
}

export async function abandonImportSession(importSessionId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('phoenix_central_needs_abandon_import_session', {
    p_import_session_id: importSessionId,
    p_reason: reason,
  });
  if (error) fail(error);
}

/**
 * Server-computed readiness. The UI never decides completeness itself — this is
 * the same predicate the submit gate runs, so a green badge and a refused
 * submit cannot disagree.
 */
export async function fetchReviewReadiness(planRevisionId: string): Promise<ReviewReadiness> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_review_readiness', {
    p_plan_revision_id: planRevisionId,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return {
    planRevisionId: row.plan_revision_id as string,
    status: row.status as RevisionStatus,
    ready: row.ready === true,
    blockers: ((row.blockers ?? []) as Array<Record<string, unknown>>).map((b) => ({
      blocker: b.blocker as string,
      detail: (b.detail as string | null) ?? null,
    })),
  };
}

export async function submitRevision(planRevisionId: string): Promise<void> {
  const { error } = await supabase.rpc('phoenix_central_needs_submit_revision', {
    p_plan_revision_id: planRevisionId,
  });
  if (error) fail(error);
}

export async function approveRevision(planRevisionId: string): Promise<void> {
  const { error } = await supabase.rpc('phoenix_central_needs_approve_revision', {
    p_plan_revision_id: planRevisionId,
  });
  if (error) fail(error);
}

export async function rejectRevision(planRevisionId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('phoenix_central_needs_reject_revision', {
    p_plan_revision_id: planRevisionId,
    p_reason: reason,
  });
  if (error) fail(error);
}

// ---------------------------------------------------------------------------
// Trusted same-origin endpoints
// ---------------------------------------------------------------------------

async function authorizedFetch(path: string, body: unknown): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new CentralNeedsError('not_authenticated');

  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new CentralNeedsError('server_unavailable');
  }
  if (!response.ok || payload.ok !== true) {
    throw new CentralNeedsError(
      typeof payload.error === 'string' ? payload.error : 'server_error',
      typeof payload.detail === 'string' ? payload.detail : undefined,
    );
  }
  return payload;
}

export interface UploadTicket {
  uploadId: string;
  source: { path: string; token: string };
  preview: { path: string; token: string };
}

export async function requestUploadTicket(planRevisionId: string, byteSize: number): Promise<UploadTicket> {
  const payload = await authorizedFetch('/api/central-needs/upload-ticket', {
    planRevisionId,
    byteSize,
  });
  return {
    uploadId: payload.uploadId as string,
    source: payload.source as { path: string; token: string },
    preview: payload.preview as { path: string; token: string },
  };
}

const SOURCE_BUCKET = 'central-needs-source-files';

/**
 * Uploads straight to private storage with the server-minted capability, so a
 * workbook never passes through a serverless request body. The browser holds
 * no service-role credential at any point — only this one short-lived token,
 * scoped to one object key it did not choose.
 */
export async function uploadToStaging(ticket: UploadTicket, source: Blob, previewJson: string): Promise<void> {
  const sourceUpload = await supabase.storage
    .from(SOURCE_BUCKET)
    .uploadToSignedUrl(ticket.source.path, ticket.source.token, source);
  if (sourceUpload.error) throw new CentralNeedsError('staging_source_upload_failed');

  const previewUpload = await supabase.storage
    .from(SOURCE_BUCKET)
    .uploadToSignedUrl(ticket.preview.path, ticket.preview.token, new Blob([previewJson], { type: 'application/json' }));
  if (previewUpload.error) throw new CentralNeedsError('staging_preview_upload_failed');
}

export interface FinalizeResult {
  batchId: string;
  idempotentReplay: boolean;
  acceptedEntryCount: number;
  excludedEntryCount: number;
  importSessionIds: string[];
}

export async function finalizeImport(input: {
  planRevisionId: string;
  uploadId: string;
  containerKind: 'file' | 'zip';
}): Promise<FinalizeResult> {
  const payload = await authorizedFetch('/api/central-needs/finalize-import', input);
  return {
    batchId: payload.batchId as string,
    idempotentReplay: payload.idempotentReplay === true,
    acceptedEntryCount: payload.acceptedEntryCount as number,
    excludedEntryCount: payload.excludedEntryCount as number,
    importSessionIds: (payload.importSessionIds ?? []) as string[],
  };
}

export async function requestSourceDownload(batchId: string): Promise<{
  url: string;
  originalFilename: string;
  containerKind: 'file' | 'zip';
  containerSha256: string;
}> {
  const payload = await authorizedFetch('/api/central-needs/source-download', { batchId });
  return {
    url: payload.url as string,
    originalFilename: payload.originalFilename as string,
    containerKind: payload.containerKind as 'file' | 'zip',
    containerSha256: payload.containerSha256 as string,
  };
}

// ---------------------------------------------------------------------------
// Canonical item lookup for mapping
// ---------------------------------------------------------------------------

export interface CentralItemOption {
  id: string;
  name: string;
  /**
   * The item's own registered canonical unit (`central_items.unit`, NOT
   * NULL). Additive field for Simple Mode's material card, which shows this
   * ALONGSIDE — never in place of — the workbook's own unit text. Reading an
   * already-canonical, super-admin-controlled field is not the same as
   * inferring a unit from workbook text, and nothing here writes it back or
   * treats it as the source unit.
   */
  unit: string;
  /**
   * PRE3-A — the discriminators an operator needs to tell two registered
   * materials apart, read from the same catalog row. All optional so older
   * fixtures stay valid; a field that is NULL on the row stays null.
   */
  nameAr?: string | null;
  /** `central_items.trade_name` (M114). Null when the row has none. */
  tradeName?: string | null;
  concentration?: string | null;
  dosageForm?: string | null;
  /** The catalog's national-code semantic, `central_items.barcode` (M114 / G3.2 Decision A). */
  nationalCode?: string | null;
  /** How strongly the query matched — a ranking, never an authorization to map. */
  grade?: MatchGrade;
  /** i18n key explaining why it matched. */
  reasonKey?: string;
}

/** Fewer normalized characters than this searches nothing (the shared resolver's own floor). */
export const CENTRAL_ITEM_QUERY_MIN = 2;

/**
 * Candidate central items for a 'mapped' decision.
 *
 * PRE3-A: this is now the shared material resolver — the same registered-
 * catalog read every other material picker uses — and no longer a narrow
 * name-only ILIKE of its own. That brings, unchanged from the resolver:
 *   - only ACTIVE catalog rows (`status = 'active'`), so a discontinued or
 *     inactive item can never be offered as a mapping target;
 *   - matching on scientific name, Arabic/alternate name, trade name and the
 *     catalog national code, raw and Arabic-normalized;
 *   - grading (confirmed / strong / probable) that ranks candidates and never
 *     picks one.
 * Only catalog results with a real central item id are returned — a stock lot
 * or any other non-catalog identity can never become a `mapped` target here.
 * It is a read: it creates no item, and choosing a result still takes an
 * explicit operator confirmation before `setRecordDisposition` is called.
 * A failed read throws; it is never reported as "no match".
 */
export async function searchCentralItems(query: string, limit = 25): Promise<CentralItemOption[]> {
  let resolved: Awaited<ReturnType<typeof resolveMaterials>>;
  try {
    resolved = await resolveMaterials(query, { audience: 'internal', limit });
  } catch (error) {
    if (error instanceof CentralNeedsError) throw error;
    fail(error as Parameters<typeof fail>[0]);
  }
  return resolved.filter(isMappableCatalogResult).map(centralItemOptionOf);
}

/**
 * A resolver result that may become a `mapped` target: a catalog row with a
 * real central item id that is active and selectable. Nothing else — a stock
 * lot or any other non-catalog identity — ever is.
 */
function isMappableCatalogResult(m: ResolvedMaterial): boolean {
  return m.source === 'catalog'
    && typeof m.centralItemId === 'string' && m.centralItemId !== ''
    && m.canonical.eligibility.active
    && m.canonical.eligibility.selectable;
}

/** The ONE mapping from a resolver result to a mapping candidate — for the search and the exact-match check alike. */
function centralItemOptionOf(m: ResolvedMaterial): CentralItemOption {
  const nameAr = m.nameAr ?? null;
  return {
    id: m.centralItemId as string,
    name: m.scientificName,
    unit: m.unit ?? '',
    nameAr,
    // The resolver falls back to the Arabic name when trade_name is empty;
    // that fallback is already shown as nameAr, so it is not repeated here.
    tradeName: m.tradeName !== null && m.tradeName !== nameAr ? m.tradeName : null,
    concentration: m.concentration,
    dosageForm: m.dosageForm,
    nationalCode: m.nationalCode,
    grade: m.grade,
    reasonKey: m.reasonKey,
  };
}

/**
 * PRE3-A — whether a typed query is long enough to search at all, by the same
 * normalized measure the resolver applies. A shorter query is "keep typing",
 * never "nothing is registered".
 */
export function centralItemQueryIsSearchable(query: string): boolean {
  return normalizeSearchText((query ?? '').trim()).length >= CENTRAL_ITEM_QUERY_MIN;
}

/**
 * PRE3-A — does this candidate carry exactly this text as one of its names
 * (scientific, Arabic/alternate or trade — Arabic-normalized), or as its
 * national code verbatim? It decides only whether a one-click suggestion may be
 * OFFERED; it never maps anything, and nothing near it is fuzzy.
 */
export function centralItemExactlyNames(item: CentralItemOption, text: string): boolean {
  const raw = (text ?? '').trim();
  const norm = normalizeSearchText(raw);
  if (norm === '') return false;
  const names = [item.name, item.nameAr, item.tradeName];
  if (names.some((name) => typeof name === 'string' && normalizeSearchText(name) === norm)) return true;
  return typeof item.nationalCode === 'string' && item.nationalCode.trim() !== '' && item.nationalCode.trim() === raw;
}

/** PRE3 Run 4 — what a one-click material suggestion may be decided from. */
export interface CentralItemExactMatches {
  /** Every candidate the server returned that `centralItemExactlyNames` the text — active, mappable items only. */
  matches: CentralItemOption[];
  /**
   * True ONLY when the server PROVED that its candidate set holds every active
   * item that could exactly name the text (the shared resolver's exact-candidate
   * mode: a superset predicate, active rows only, exact count within the cap).
   * Without it, `matches` may be missing a second exact item — no suggestion.
   */
  complete: boolean;
}

/**
 * PRE3 Run 4 — the active registered items that carry `text` exactly as a name
 * or national code (the `centralItemExactlyNames` rule), with whether that list
 * is PROVEN complete. A single suggestion may be offered only when it is
 * complete AND holds exactly one item; two or more are a choice; anything
 * unproven is no suggestion. It is a read: nothing is mapped, and a suggestion
 * still waits for the person's explicit confirmation. A failed read throws; it
 * is never reported as "no exact match".
 */
export async function findExactCentralItemMatches(text: string): Promise<CentralItemExactMatches> {
  let found: Awaited<ReturnType<typeof resolveExactCatalogCandidates>>;
  try {
    found = await resolveExactCatalogCandidates(text);
  } catch (error) {
    if (error instanceof CentralNeedsError) throw error;
    fail(error as Parameters<typeof fail>[0]);
  }
  const candidates = found.items.filter(isMappableCatalogResult).map(centralItemOptionOf);
  return {
    matches: candidates.filter((item) => centralItemExactlyNames(item, text)),
    complete: found.complete,
  };
}

/**
 * PRE3-A — what tells two registered materials apart, as (label key, value)
 * pairs in a fixed order: Arabic/alternate name, trade name, concentration,
 * dosage form, national code. A field the catalog row does not carry is left
 * out, never filled in. (The scientific name is the option's own label and the
 * catalog unit is shown beside it, so neither is repeated here.)
 */
export function centralItemDiscriminators(item: CentralItemOption): Array<{ labelKey: string; value: string }> {
  const pairs: Array<[string, string | null | undefined]> = [
    ['cn2b_material_name_ar', item.nameAr],
    ['inv_trade_name', item.tradeName],
    ['inv_concentration', item.concentration],
    ['inv_dosage_form', item.dosageForm],
    ['inv_national_code', item.nationalCode],
  ];
  return pairs.flatMap(([labelKey, value]) => (
    typeof value === 'string' && value.trim() !== '' ? [{ labelKey, value: value.trim() }] : []
  ));
}
