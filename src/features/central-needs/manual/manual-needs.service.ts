/**
 * R1-A4 — typed wrappers for the manual annual-needs routines (R1-a candidate 04 / R1-b).
 *
 * Same discipline as central-needs.service.ts: canonical RPCs only, no direct DML on any Central
 * Needs table, and a server refusal is surfaced as a CentralNeedsError carrying the database
 * identifier — never flattened, never retried here. Quantities travel as TEXT and come back as TEXT.
 */
import { supabase } from '@/shared/supabase/client';
import { centralNeedsErrorFromPostgrest } from '../central-needs.service';
import { checkManualQuantityText } from './manual-quantity';

export type ManualEventKind = 'add' | 'correct' | 'void' | 'carried_forward';

export interface ManualNeedEvent {
  id: string;
  planRevisionId: string;
  beneficiaryOrganizationId: string;
  centralItemId: string;
  targetWarehouseId: string | null;
  eventSeq: number;
  eventKind: ManualEventKind;
  quantityText: string | null;
  approvedUnit: string | null;
  reason: string;
  reference: string | null;
  actorId: string;
}

export interface ManualCapabilities {
  view: boolean;
  edit: boolean;
  approve: boolean;
  manualSet: boolean;
  excelImportOpen: boolean;
  approveExcludedForRevision: boolean;
}

export interface ManualScope {
  planRevisionId: string;
  beneficiaryOrganizationId: string;
  centralItemId: string;
  targetWarehouseId: string | null;
}

export interface ManualWriteResult {
  idempotentReplay: boolean;
  eventId: string | null;
  eventSeq: number | null;
}


function fail(error: { message?: unknown; code?: unknown; details?: unknown; hint?: unknown } | null): never {
  throw centralNeedsErrorFromPostgrest(error);
}

const writeResult = (data: unknown): ManualWriteResult => {
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    idempotentReplay: row.idempotent_replay === true,
    eventId: typeof row.event_id === 'string' ? row.event_id : null,
    eventSeq: typeof row.event_seq === 'number' ? row.event_seq : null,
  };
};

/** A fresh idempotency key for ONE user intent. The caller reuses it for retries of that intent only. */
export function newManualIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** Validates the quantity text on the client FIRST so an invalid value never reaches the network. */
function requireQuantity(text: string): string {
  const c = checkManualQuantityText(text);
  if (!c.ok) throw new Error(`manual_quantity_${c.reason}`);
  return c.text;
}

export async function getManualCapabilities(organizationId: string, planRevisionId: string | null): Promise<ManualCapabilities> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_my_capabilities', {
    p_organization_id: organizationId,
    p_plan_revision_id: planRevisionId,
  });
  if (error) fail(error);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  return {
    view: row?.view === true,
    edit: row?.edit === true,
    approve: row?.approve === true,
    manualSet: row?.manual_set === true,
    excelImportOpen: row?.excel_import_open === true,
    approveExcludedForRevision: row?.approve_excluded_for_revision === true,
  };
}

export async function listManualNeedEvents(planRevisionId: string): Promise<ManualNeedEvent[]> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_list_manual_need_events', { p_plan_revision_id: planRevisionId });
  if (error) fail(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    planRevisionId: r.plan_revision_id as string,
    beneficiaryOrganizationId: r.beneficiary_organization_id as string,
    centralItemId: r.central_item_id as string,
    targetWarehouseId: (r.target_warehouse_id as string | null) ?? null,
    eventSeq: r.event_seq as number,
    eventKind: r.event_kind as ManualEventKind,
    quantityText: (r.quantity_text as string | null) ?? null,
    approvedUnit: (r.approved_unit as string | null) ?? null,
    reason: (r.reason as string) ?? '',
    reference: (r.reference as string | null) ?? null,
    actorId: r.actor_id as string,
  }));
}

export async function openManualPlanRevision(organizationId: string, planYear: number) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_open_manual_plan_revision', {
    p_organization_id: organizationId,
    p_plan_year: planYear,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return { planRevisionId: row.plan_revision_id as string, revisionNumber: row.revision_number as number, idempotentReplay: row.idempotent_replay === true };
}

export async function openManualCorrectionRevision(organizationId: string, planYear: number, expectedLatestRevisionId: string, reason: string) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_open_manual_correction_revision', {
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
    effectiveApprovedRevisionId: (row.effective_approved_revision_id as string | null) ?? null,
  };
}

export async function carryForwardManualLines(planRevisionId: string, expectedSourceRevisionId: string) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_carry_forward_manual_lines', {
    p_plan_revision_id: planRevisionId,
    p_expected_source_revision_id: expectedSourceRevisionId,
  });
  if (error) fail(error);
  const row = data as Record<string, unknown>;
  return { carriedCount: row.carried_count as number, idempotentReplay: row.idempotent_replay === true };
}

export async function addManualNeedLine(
  s: ManualScope, quantityText: string, reason: string, idempotencyKey: string,
  expectedLastEventId: string | null, reference: string | null = null,
): Promise<ManualWriteResult> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_add_manual_need_line', {
    p_plan_revision_id: s.planRevisionId,
    p_beneficiary_organization_id: s.beneficiaryOrganizationId,
    p_central_item_id: s.centralItemId,
    p_target_warehouse_id: s.targetWarehouseId,
    p_quantity_text: requireQuantity(quantityText),
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
    p_expected_last_event_id: expectedLastEventId,
    p_reference: reference,
  });
  if (error) fail(error);
  return writeResult(data);
}

export async function correctManualNeedLine(
  s: ManualScope, quantityText: string, reason: string, idempotencyKey: string,
  expectedLastEventId: string, reference: string | null = null,
): Promise<ManualWriteResult> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_correct_manual_need_line', {
    p_plan_revision_id: s.planRevisionId,
    p_beneficiary_organization_id: s.beneficiaryOrganizationId,
    p_central_item_id: s.centralItemId,
    p_target_warehouse_id: s.targetWarehouseId,
    p_quantity_text: requireQuantity(quantityText),
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
    p_expected_last_event_id: expectedLastEventId,
    p_reference: reference,
  });
  if (error) fail(error);
  return writeResult(data);
}

export async function voidManualNeedLine(
  s: ManualScope, reason: string, idempotencyKey: string,
  expectedLastEventId: string, reference: string | null = null,
): Promise<ManualWriteResult> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_void_manual_need_line', {
    p_plan_revision_id: s.planRevisionId,
    p_beneficiary_organization_id: s.beneficiaryOrganizationId,
    p_central_item_id: s.centralItemId,
    p_target_warehouse_id: s.targetWarehouseId,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
    p_expected_last_event_id: expectedLastEventId,
    p_reference: reference,
  });
  if (error) fail(error);
  return writeResult(data);
}

export async function withdrawDraftRevision(planRevisionId: string, expectedLatestRevisionId: string, reason: string, reference: string | null = null) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_withdraw_draft_revision', {
    p_plan_revision_id: planRevisionId,
    p_expected_latest_revision_id: expectedLatestRevisionId,
    p_reason: reason,
    p_reference: reference,
  });
  if (error) fail(error);
  return { withdrawalId: (data as Record<string, unknown>).withdrawal_id as string };
}

export async function acknowledgeManualCoverage(planRevisionId: string, expectedOmittedScopeDigest: string, reason: string) {
  const { data, error } = await supabase.rpc('phoenix_central_needs_acknowledge_manual_coverage', {
    p_plan_revision_id: planRevisionId,
    p_expected_omitted_scope_digest: expectedOmittedScopeDigest,
    p_reason: reason,
  });
  if (error) fail(error);
  return { acknowledgementId: (data as Record<string, unknown>).acknowledgement_id as string };
}
