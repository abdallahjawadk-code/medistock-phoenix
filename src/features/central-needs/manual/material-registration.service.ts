/**
 * R1-A2/A4 — typed wrappers for the governed material-registration routines (R1-a candidate 06 / R1-b 02).
 * Canonical RPCs only: there is no client write to central_items or any registration table, a server refusal is surfaced as a
 * CentralNeedsError carrying the database identifier, and nothing here retries.
 */
import { supabase } from '@/shared/supabase/client';
import { getNeedsFeatures } from './dossier.service';
import { centralNeedsErrorFromPostgrest } from '../central-needs.service';

export type MaterialRequestStatus =
  | 'draft' | 'submitted' | 'under_review' | 'needs_info' | 'resolved_existing' | 'approved_new' | 'rejected' | 'cancelled';
export type MaterialProvenanceKind = 'manual_typed' | 'excel_assist';
export type MaterialUnit = 'box' | 'vial' | 'ampoule' | 'tablet' | 'bottle' | 'tube' | 'sachet' | 'other' | 'test';
export const MATERIAL_UNITS: readonly MaterialUnit[] = ['box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other', 'test'];

export interface MaterialDescriptor {
  scientificName: string;
  nameAr: string | null;
  tradeName: string | null;
  strength: string | null;
  dosageForm: string | null;
  unit: MaterialUnit;
  barcode: string | null;
  nationalCode?: string | null;
  note: string | null;
}

/** Identity-only pointer of the optional A3 assist: never a quantity. */
export interface ExcelAssistProvenance { sheet_index: number; row: number; column?: number; file_hash: string }

export interface MaterialRequest extends MaterialDescriptor {
  id: string;
  organizationId: string;
  requesterId: string;
  status: MaterialRequestStatus;
  version: number;
  provenanceKind: MaterialProvenanceKind;
  reviewerId: string | null;
  resolvedItemId: string | null;
  decisionReason: string | null;
  createdAt: string;
}

export interface MaterialRequestEvent {
  id: string;
  seq: number;
  eventKind: string;
  actorId: string;
  statusAfter: MaterialRequestStatus;
  note: string | null;
  createdAt: string;
}

export interface MaterialCandidate {
  centralItemId: string;
  grade: 'strong' | 'advisory';
  score: number;
  name: string;
  nameAr: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string;
  barcode: string | null;
  status: string;
  nationalCode?: string | null;
}

export interface MaterialCapabilities { canRequest: boolean; canReview: boolean; canLink: boolean }

export interface MaterialWriteResult { requestId: string; status: MaterialRequestStatus; version: number; idempotentReplay: boolean }

function fail(error: { message?: unknown; code?: unknown; details?: unknown; hint?: unknown } | null): never {
  throw centralNeedsErrorFromPostgrest(error);
}

const writeResult = (data: unknown): MaterialWriteResult & Record<string, unknown> => {
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    requestId: r.request_id as string,
    status: r.status as MaterialRequestStatus,
    version: r.version as number,
    idempotentReplay: r.idempotent_replay === true,
    ...(r.central_item_id ? { centralItemId: r.central_item_id as string } : {}),
    ...(typeof r.strong_matches === 'number' ? { strongMatches: r.strong_matches as number, advisoryMatches: r.advisory_matches as number } : {}),
  };
};

export function newMaterialIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export async function getMaterialCapabilities(organizationId: string): Promise<MaterialCapabilities> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_my_material_capabilities', { p_organization_id: organizationId });
  if (error) fail(error);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  return { canRequest: row?.can_request === true, canReview: row?.can_review === true, canLink: row?.can_link === true };
}

export async function listMaterialRequests(organizationId: string): Promise<MaterialRequest[]> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_list_material_requests', { p_organization_id: organizationId });
  if (error) fail(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    organizationId: r.organization_id as string,
    requesterId: r.requester_id as string,
    status: r.status as MaterialRequestStatus,
    version: r.version as number,
    scientificName: r.scientific_name as string,
    nameAr: (r.name_ar as string | null) ?? null,
    tradeName: (r.trade_name as string | null) ?? null,
    strength: (r.strength as string | null) ?? null,
    dosageForm: (r.dosage_form as string | null) ?? null,
    unit: r.unit as MaterialUnit,
    barcode: (r.barcode as string | null) ?? null,
    nationalCode: (r.national_code as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    provenanceKind: r.provenance_kind as MaterialProvenanceKind,
    reviewerId: (r.reviewer_id as string | null) ?? null,
    resolvedItemId: (r.resolved_item_id as string | null) ?? null,
    decisionReason: (r.decision_reason as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export async function listMaterialRequestEvents(requestId: string): Promise<MaterialRequestEvent[]> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_list_material_request_events', { p_request_id: requestId });
  if (error) fail(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    seq: r.seq as number,
    eventKind: r.event_kind as string,
    actorId: r.actor_id as string,
    statusAfter: r.status_after as MaterialRequestStatus,
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export async function listMaterialRequestCandidates(requestId: string, withNationalCode = false): Promise<MaterialCandidate[]> {
  const { data, error } = await supabase.rpc(withNationalCode ? 'phoenix_central_needs_material_request_code_candidates' : 'phoenix_central_needs_material_request_candidates', { p_request_id: requestId });
  if (error) fail(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    centralItemId: r.central_item_id as string,
    grade: r.grade as 'strong' | 'advisory',
    score: Number(r.score),
    name: r.name as string,
    nameAr: (r.name_ar as string | null) ?? null,
    concentration: (r.concentration as string | null) ?? null,
    dosageForm: (r.dosage_form as string | null) ?? null,
    unit: r.unit as string,
    barcode: (r.barcode as string | null) ?? null,
    nationalCode: (r.national_code as string | null) ?? null,
    status: r.status as string,
  }));
}

export async function createMaterialRequestDraft(
  organizationId: string, d: MaterialDescriptor, idempotencyKey: string,
  provenance: { kind: 'manual_typed' } | { kind: 'excel_assist'; pointer: ExcelAssistProvenance },
  planRevisionId: string | null = null,
) {
  const withCode = d.nationalCode !== undefined;
  if (withCode && !(await getNeedsFeatures()).nationalCode) throw new Error('national_code_not_deployed');
  const { data, error } = await supabase.rpc(withCode ? 'phoenix_central_needs_create_material_request_with_code' : 'phoenix_central_needs_create_material_request_draft', {
    ...(withCode ? { p_national_code: d.nationalCode } : {}),
    p_organization_id: organizationId,
    p_scientific_name: d.scientificName,
    p_name_ar: d.nameAr,
    p_trade_name: d.tradeName,
    p_strength: d.strength,
    p_dosage_form: d.dosageForm,
    p_unit: d.unit,
    p_barcode: d.barcode,
    p_note: d.note,
    p_provenance_kind: provenance.kind,
    p_provenance: provenance.kind === 'excel_assist' ? provenance.pointer : {},
    p_plan_revision_id: planRevisionId,
    p_idempotency_key: idempotencyKey,
  });
  if (error) fail(error);
  return writeResult(data);
}

export async function updateMaterialRequestDraft(requestId: string, expectedVersion: number, d: MaterialDescriptor) {
  const withCode = d.nationalCode !== undefined;
  if (withCode && !(await getNeedsFeatures()).nationalCode) throw new Error('national_code_not_deployed');
  const { data, error } = await supabase.rpc(withCode ? 'phoenix_central_needs_update_material_request_with_code' : 'phoenix_central_needs_update_material_request_draft', {
    ...(withCode ? { p_national_code: d.nationalCode } : {}),
    p_request_id: requestId,
    p_expected_version: expectedVersion,
    p_scientific_name: d.scientificName,
    p_name_ar: d.nameAr,
    p_trade_name: d.tradeName,
    p_strength: d.strength,
    p_dosage_form: d.dosageForm,
    p_unit: d.unit,
    p_barcode: d.barcode,
    p_note: d.note,
  });
  if (error) fail(error);
  return writeResult(data);
}

export async function submitMaterialRequest(requestId: string, expectedVersion: number) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_submit_material_request', { p_request_id: requestId, p_expected_version: expectedVersion });
  if (error) fail(error);
  return writeResult(data);
}

export async function startMaterialReview(requestId: string, expectedVersion: number) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_start_material_review', { p_request_id: requestId, p_expected_version: expectedVersion });
  if (error) fail(error);
  return writeResult(data);
}

export async function requestMaterialInfo(requestId: string, expectedVersion: number, note: string) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_request_material_info', { p_request_id: requestId, p_expected_version: expectedVersion, p_note: note });
  if (error) fail(error);
  return writeResult(data);
}

export async function resolveMaterialExisting(requestId: string, expectedVersion: number, itemId: string, note: string, codeAssignment?: { expected: string | null }) {
  const { data, error } = await supabase.rpc(codeAssignment ? 'phoenix_central_needs_resolve_material_existing_with_code' : 'phoenix_central_needs_resolve_material_existing', {
    ...(codeAssignment ? { p_expected_code: codeAssignment.expected, p_confirm_code: true } : {}),
    p_request_id: requestId, p_expected_version: expectedVersion, p_item_id: itemId, p_note: note,
  });
  if (error) fail(error);
  return writeResult(data);
}

/** `acknowledgedCandidates` = the similar catalog items a human confirmed are NOT the same material. */
export async function approveNewMaterial(requestId: string, expectedVersion: number, acknowledgedCandidates: string[], note: string, expectedNationalCode?: string | null) {
  const { data, error } = await supabase.rpc(expectedNationalCode !== undefined ? 'phoenix_central_needs_approve_material_with_code' : 'phoenix_central_needs_approve_new_material', {
    ...(expectedNationalCode !== undefined ? { p_expected_national_code: expectedNationalCode } : {}),
    p_request_id: requestId, p_expected_version: expectedVersion, p_acknowledged_candidates: acknowledgedCandidates, p_note: note,
  });
  if (error) fail(error);
  return writeResult(data);
}

export async function rejectMaterialRequest(requestId: string, expectedVersion: number, reason: string) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_reject_material_request', { p_request_id: requestId, p_expected_version: expectedVersion, p_reason: reason });
  if (error) fail(error);
  return writeResult(data);
}

export async function cancelMaterialRequest(requestId: string, expectedVersion: number, reason: string) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_cancel_material_request', { p_request_id: requestId, p_expected_version: expectedVersion, p_reason: reason });
  if (error) fail(error);
  return writeResult(data);
}

export async function linkMaterialRequestToDraft(requestId: string, planRevisionId: string) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_link_material_request_to_draft', { p_request_id: requestId, p_plan_revision_id: planRevisionId });
  if (error) fail(error);
  const r = (data ?? {}) as Record<string, unknown>;
  return { linkId: r.link_id as string, centralItemId: r.central_item_id as string, idempotentReplay: r.idempotent_replay === true };
}
