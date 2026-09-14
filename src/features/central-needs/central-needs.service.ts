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
  overrideReason: string;
  overrideNote: string | null;
  createdAt: string;
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

/** A refusal from a canonical RPC, carrying its stable machine-readable code. */
export class CentralNeedsError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'CentralNeedsError';
  }
}

function fail(error: { message?: string } | null): never {
  const message = typeof error?.message === 'string' ? error.message : 'unknown_error';
  const token = message.match(/[a-z0-9_]{4,}/i);
  throw new CentralNeedsError(token ? token[0] : 'unknown_error', message);
}

// ---------------------------------------------------------------------------
// Reads (RLS-governed)
// ---------------------------------------------------------------------------

export async function listPlanRevisions(organizationId: string): Promise<PlanRevision[]> {
  // The plan year is embedded through the existing plan_id foreign key, so a
  // revision can always be labelled "2026 · revision 1" rather than a bare "#1".
  const { data, error } = await supabase
    .from('central_needs_plan_revisions')
    .select('id, plan_id, organization_id, revision_number, status, central_needs_plans(plan_year)')
    .eq('organization_id', organizationId)
    .order('revision_number', { ascending: false });
  if (error) fail(error);
  return (data ?? []).map((r) => {
    const plan = r.central_needs_plans as { plan_year?: number } | Array<{ plan_year?: number }> | null;
    const planYear = Array.isArray(plan) ? plan[0]?.plan_year : plan?.plan_year;
    return {
      id: r.id as string,
      planId: r.plan_id as string,
      organizationId: r.organization_id as string,
      planYear: typeof planYear === 'number' ? planYear : null,
      revisionNumber: r.revision_number as number,
      status: r.status as RevisionStatus,
    };
  }).sort((a, b) =>
    (b.planYear ?? 0) - (a.planYear ?? 0) || b.revisionNumber - a.revisionNumber);
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
 * I — archive members for a revision, so a ZIP entry can be found by its path.
 * Entry rows carry the verbatim archiveEntryPath as evidence.
 */
export async function searchBatchEntries(
  planRevisionId: string, query: string, limit = 100,
): Promise<Array<ImportBatchEntry & { containerFilename: string; batchId: string }>> {
  const { data, error } = await supabase
    .from('central_needs_import_batch_entries')
    .select('id, batch_id, entry_ordinal, archive_entry_path, entry_sha256, import_session_id, central_needs_import_batches(container_filename)')
    .eq('plan_revision_id', planRevisionId)
    .order('entry_ordinal', { ascending: true })
    .limit(limit);
  if (error) fail(error);
  const term = query.trim().toLowerCase();
  return (data ?? [])
    .map((r) => {
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
    })
    .filter((e) => term === ''
      || (e.archiveEntryPath ?? '').toLowerCase().includes(term)
      || e.entrySha256.toLowerCase().startsWith(term)
      || e.containerFilename.toLowerCase().includes(term));
}

export async function listImportSessions(planRevisionId: string): Promise<ImportSession[]> {
  const { data, error } = await supabase
    .from('central_needs_import_sessions')
    .select('id, plan_revision_id, source_file_id, status, preview_digest, authoritative_digest, parser_identity, started_at, completed_at, notes')
    .eq('plan_revision_id', planRevisionId)
    .order('started_at', { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    planRevisionId: r.plan_revision_id as string,
    sourceFileId: r.source_file_id as string,
    status: r.status as ImportSessionStatus,
    previewDigest: (r.preview_digest as string | null) ?? null,
    authoritativeDigest: (r.authoritative_digest as string | null) ?? null,
    parserIdentity: (r.parser_identity as Record<string, unknown> | null) ?? null,
    startedAt: r.started_at as string,
    completedAt: (r.completed_at as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  }));
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

export async function listSourceRecords(importSessionId: string): Promise<SourceRecord[]> {
  const { data, error } = await supabase
    .from('central_needs_source_records')
    .select('id, import_session_id, record_ordinal, target_entity, field_name, source_values, source_provenance')
    .eq('import_session_id', importSessionId)
    .order('record_ordinal', { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    importSessionId: r.import_session_id as string,
    recordOrdinal: r.record_ordinal as number,
    targetEntity: r.target_entity as string,
    fieldName: r.field_name as string,
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

export async function listOverrides(planRevisionId: string): Promise<FieldOverride[]> {
  const { data, error } = await supabase
    .from('central_needs_field_overrides')
    .select('id, source_record_id, target_entity, field_name, previous_value, final_value, override_reason, override_note, created_at')
    .eq('plan_revision_id', planRevisionId)
    .order('created_at', { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    sourceRecordId: r.source_record_id as string,
    targetEntity: r.target_entity as string,
    fieldName: r.field_name as string,
    previousValue: r.previous_value,
    finalValue: r.final_value,
    overrideReason: r.override_reason as string,
    overrideNote: (r.override_note as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
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
 * G — open (or reuse) the annual draft for one plan year.
 *
 * `openNextRevision = false` is the FIRST-revision / reuse-current call: M210
 * returns the existing open draft when there is one, so this is safe to press
 * twice and never silently creates a second draft. `true` is the explicit
 * "supersede a closed revision" action and is only offered after approval or
 * rejection. There is no automatic revision creation anywhere in this feature.
 */
export async function openPlanRevision(
  organizationId: string,
  planYear: number,
  openNextRevision = false,
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

export async function recordFieldOverride(input: {
  sourceRecordId: string;
  finalValue: unknown;
  overrideReason: string;
  overrideNote?: string | null;
  overrideReference?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('phoenix_central_needs_record_field_override', {
    p_source_record_id: input.sourceRecordId,
    p_final_value: input.finalValue,
    p_override_reason: input.overrideReason,
    p_override_note: input.overrideNote ?? null,
    p_override_reference: input.overrideReference ?? null,
  });
  if (error) fail(error);
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

export async function requestSourceDownload(batchId: string): Promise<{ url: string; originalFilename: string }> {
  const payload = await authorizedFetch('/api/central-needs/source-download', { batchId });
  return {
    url: payload.url as string,
    originalFilename: payload.originalFilename as string,
  };
}

// ---------------------------------------------------------------------------
// Canonical item lookup for mapping
// ---------------------------------------------------------------------------

export interface CentralItemOption {
  id: string;
  name: string;
}

/**
 * Candidate central items for a 'mapped' decision. A plain RLS-governed read
 * of the existing canonical registry — CN-2B introduces no item catalogue of
 * its own and creates no items.
 */
export async function searchCentralItems(query: string, limit = 25): Promise<CentralItemOption[]> {
  const { data, error } = await supabase
    .from('central_items')
    .select('id, name')
    .ilike('name', `%${query}%`)
    .order('name', { ascending: true })
    .limit(limit);
  if (error) fail(error);
  return (data ?? []).map((r) => ({ id: r.id as string, name: r.name as string }));
}
