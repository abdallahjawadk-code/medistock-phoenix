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
 * applied here.
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
 * (plan revision, beneficiary organization, central item). `organizationId` is
 * the OWNING central organization — the beneficiary is its own dimension.
 */
export interface NeedLine {
  id: string;
  planRevisionId: string;
  organizationId: string;
  beneficiaryOrganizationId: string;
  targetWarehouseId: string | null;
  centralItemId: string;
  /** Exact decimal, carried as text so no precision is lost in JavaScript. */
  approvedQuantity: string;
  approvedUnit: NeedLineUnit | null;
  unitConversionState: UnitConversionState;
  sourceUnitText: string | null;
  mappingReason: string;
  updatedAt: string;
}

export interface NeedLineSourceLink {
  importSessionId: string;
  targetEntity: string;
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

/**
 * The operational need lines of one revision, plus which imported rows each one
 * consolidates. RLS governs visibility on the OWNING organization, so a caller
 * without `central_needs.view` sees nothing rather than a filtered subset.
 */
export async function listNeedLines(planRevisionId: string): Promise<NeedLine[]> {
  const { data, error } = await supabase
    .from('central_needs_need_lines')
    .select('id, plan_revision_id, organization_id, beneficiary_organization_id, target_warehouse_id, central_item_id, approved_quantity, approved_unit, unit_conversion_state, source_unit_text, mapping_reason, updated_at')
    .eq('plan_revision_id', planRevisionId)
    // `id` breaks ties so the listed order is total, not merely chronological.
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    planRevisionId: r.plan_revision_id as string,
    organizationId: r.organization_id as string,
    beneficiaryOrganizationId: r.beneficiary_organization_id as string,
    targetWarehouseId: (r.target_warehouse_id as string | null) ?? null,
    centralItemId: r.central_item_id as string,
    // numeric(20,3) arrives as text from PostgREST; keep it as text so an exact
    // decimal is never silently coerced through a JavaScript float.
    approvedQuantity: String(r.approved_quantity),
    approvedUnit: (r.approved_unit as NeedLineUnit | null) ?? null,
    unitConversionState: r.unit_conversion_state as UnitConversionState,
    sourceUnitText: (r.source_unit_text as string | null) ?? null,
    mappingReason: r.mapping_reason as string,
    updatedAt: r.updated_at as string,
  }));
}

/**
 * Two plain reads rather than one embedded filter: the `need_line_id` set is
 * resolved first, then its links. A PostgREST embedded filter would express the
 * same intent in one round trip, but this form is obvious, and RLS governs both
 * halves identically — a caller who cannot see the lines gets no links either.
 */
export async function listNeedLineSources(
  planRevisionId: string,
): Promise<NeedLineSourceLink[]> {
  const lines = await supabase
    .from('central_needs_need_lines')
    .select('id')
    .eq('plan_revision_id', planRevisionId);
  if (lines.error) fail(lines.error);
  const ids = (lines.data ?? []).map((r) => r.id as string);
  if (ids.length === 0) return [];

  // M212's UNIQUE (import_session_id, target_entity) means a pair identifies
  // the claim by itself, so the owning line's id is not part of the answer.
  const { data, error } = await supabase
    .from('central_needs_need_line_sources')
    .select('import_session_id, target_entity')
    .in('need_line_id', ids);
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    importSessionId: r.import_session_id as string,
    targetEntity: r.target_entity as string,
  }));
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
 * Persist one operational need line (M212).
 *
 * Everything here is re-validated server-side — beneficiary eligibility,
 * warehouse ownership, unit vocabulary, conversion state, quantity sign,
 * revision editability and source lineage. The UI's own checks exist to give a
 * fast answer, never to be the authority.
 *
 * `approvedQuantity` is passed as a string so an exact decimal reaches
 * PostgreSQL's `numeric` without a JavaScript float in the middle.
 */
export async function setNeedLine(input: {
  planRevisionId: string;
  beneficiaryOrganizationId: string;
  centralItemId: string;
  approvedQuantity: string;
  mappingReason: string;
  approvedUnit?: NeedLineUnit | null;
  unitConversionState?: UnitConversionState;
  targetWarehouseId?: string | null;
  sourceUnitText?: string | null;
  sourceTargetEntities?: NeedLineSourceLink[];
}): Promise<{ needLineId: string; sourceLinkCount: number }> {
  const state = input.unitConversionState ?? 'canonical';
  const { data, error } = await supabase.rpc('phoenix_central_needs_set_need_line', {
    p_plan_revision_id: input.planRevisionId,
    p_beneficiary_organization_id: input.beneficiaryOrganizationId,
    p_central_item_id: input.centralItemId,
    p_approved_quantity: input.approvedQuantity,
    p_mapping_reason: input.mappingReason,
    // A conversion-required line carries no canonical unit, by contract.
    p_approved_unit: state === 'conversion_required' ? null : input.approvedUnit ?? null,
    p_unit_conversion_state: state,
    p_target_warehouse_id: input.targetWarehouseId ?? null,
    p_source_unit_text: input.sourceUnitText ?? null,
    p_source_target_entities: (input.sourceTargetEntities ?? []).map((l) => ({
      importSessionId: l.importSessionId,
      targetEntity: l.targetEntity,
    })),
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return {
    needLineId: row.need_line_id as string,
    sourceLinkCount: Number(row.source_link_count ?? 0),
  };
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
