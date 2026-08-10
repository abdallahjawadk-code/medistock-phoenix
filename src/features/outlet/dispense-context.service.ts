/**
 * MOVEMENT-DISPENSE-CONTEXT (migration 134) — record and read WHO/WHAT a
 * dispense movement was for: patient, crash cart, or internal order.
 *
 * Both RPCs are the only entry points — the underlying table has no grant
 * to `authenticated` at all (RLS enabled with zero policies). Recording is
 * insert-only and idempotent on requestId; a genuinely different payload
 * for an already-recorded movement is refused server-side
 * (movement_id_conflict), never silently overwritten. Reading always goes
 * through the server, which masks patient identity unless the caller holds
 * movement_context.view_sensitive — the client never has to reproduce that
 * masking decision itself, it only renders whatever the server returns.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';

export type DispenseBeneficiaryType = 'patient' | 'crash_cart' | 'internal_order';

/**
 * Which hospital document the patient reference number was read from
 * (migration 136). A document KIND, never an identity — the server never
 * masks it, unlike the number and the name.
 */
export type PatientReferenceType = 'chart' | 'card' | 'pass';

export const PATIENT_REFERENCE_TYPES: readonly PatientReferenceType[] =
  Object.freeze(['chart', 'card', 'pass']);

/**
 * STAGE-F-172: the document types a NEW patient dispense may declare.
 *
 * 'pass' stays in PatientReferenceType above because historical rows may
 * carry it and must keep rendering; Migration 172 refuses it on write
 * (patient_reference_type_pass_retired). WHICH of card/chart is legal for a
 * given outlet depends on that outlet's clinical context and is decided
 * SERVER-side — this type only stops the UI from offering a value that can
 * never be accepted anywhere.
 */
export type StageFPatientReferenceType = Extract<PatientReferenceType, 'card' | 'chart'>;

export const STAGE_F_PATIENT_REFERENCE_TYPES: readonly StageFPatientReferenceType[] =
  Object.freeze(['card', 'chart']);

/** The minimal shape DispenseContextDialog/Viewer need from an
 *  OutletMovementRow — kept separate so this service doesn't import from
 *  outlet-stock.service.ts (avoids a circular import). */
export interface OutletMovementForContext {
  id: string;
  scientificName: string;
  batchNumber: string | null;
  createdAt: string;
}

export interface RecordDispenseContextInput {
  requestId: string;
  movementId: string;
  beneficiaryType: DispenseBeneficiaryType;
  patientIdentifier?: string;
  patientName?: string;
  patientReferenceType?: PatientReferenceType;
  crashCartReference?: string;
  internalOrderReference?: string;
  notes?: string;
}

export interface RecordDispenseContextResult {
  ok: boolean;
  idempotentReplay: boolean;
  id: string;
  beneficiaryType: DispenseBeneficiaryType;
}

export async function recordDispenseContext(input: RecordDispenseContextInput): Promise<RecordDispenseContextResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');
  const { data, error } = await supabase.rpc('phoenix_record_movement_dispense_context', {
    p_request_id:               input.requestId,
    p_movement_id:               input.movementId,
    p_beneficiary_type:          input.beneficiaryType,
    p_patient_identifier:        input.patientIdentifier ?? null,
    p_patient_name:              input.patientName ?? null,
    p_crash_cart_reference:      input.crashCartReference ?? null,
    p_internal_order_reference:  input.internalOrderReference ?? null,
    p_notes:                     input.notes ?? null,
    p_patient_reference_type:    input.patientReferenceType ?? null,
  });
  if (error) throw error;
  const r = data as { ok: boolean; idempotent_replay?: boolean; id: string; beneficiary_type: DispenseBeneficiaryType };
  return { ok: r.ok, idempotentReplay: r.idempotent_replay ?? false, id: r.id, beneficiaryType: r.beneficiary_type };
}

/**
 * Classify a phoenix_record_movement_dispense_context failure into an i18n
 * string key. movement_id_conflict means someone already recorded a
 * DIFFERENT beneficiary for this movement — never overwritten, the actor
 * must be told rather than silently retried.
 */
export function classifyDispenseContextError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? '';
  if (message.includes('movement_not_a_dispense')) return 'dispense_context_not_a_dispense';
  if (message.includes('movement_not_found')) return 'dispense_context_movement_not_found';
  if (message.includes('movement_id_conflict')) return 'dispense_context_conflict';
  if (message.includes('patient_identifier_or_name_required')) return 'dispense_context_patient_required';
  if (message.includes('crash_cart_reference_required')) return 'dispense_context_crash_cart_required';
  if (message.includes('internal_order_reference_required')) return 'dispense_context_internal_order_required';
  if (message.includes('invalid_beneficiary_type')) return 'dispense_context_invalid_type';
  if (message.includes('patient_reference_type_required')) return 'dispense_context_reference_type_required';
  if (message.includes('patient_identifier_required_for_reference_type')) return 'dispense_context_reference_number_required';
  if (message.includes('invalid_patient_reference_type')) return 'dispense_context_invalid_reference_type';
  if (message.includes('outlet_quantity_cannot_go_negative')) return 'dispense_insufficient_stock';
  if (message.includes('outlet_quantity_below_reserved')) return 'dispense_below_reserved';
  if (message.includes('expired_batch_cannot_be_dispensed')) return 'dispense_expired_batch';
  if (message.includes('quantity_must_be_positive')) return 'dispense_quantity_positive';
  if (message.includes('forbidden_outlet_stock_dispense')) return 'dispense_forbidden';
  if (code === '42501' || message.includes('forbidden_movement_context_record')) return 'dispense_context_forbidden';
  return 'load_error';
}

export interface DispenseContext {
  id: string;
  movementId: string;
  beneficiaryType: DispenseBeneficiaryType;
  /** null when masked (caller lacks movement_context.view_sensitive) or the
   *  beneficiary is not a patient. */
  patientIdentifier: string | null;
  patientName: string | null;
  /** Never masked — a document kind is not an identity. */
  patientReferenceType: PatientReferenceType | null;
  /** true only when beneficiaryType is patient AND the identity is masked —
   *  distinguishes "no identity recorded" from "recorded but hidden". */
  patientIdentityMasked: boolean;
  crashCartReference: string | null;
  internalOrderReference: string | null;
  notes: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Returns null when no context has been recorded for this movement yet —
 *  never throws for the "not recorded" case, only for a real failure
 *  (auth, cross-org denial). */
export async function getDispenseContext(movementId: string): Promise<DispenseContext | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase.rpc('phoenix_get_movement_dispense_context', { p_movement_id: movementId });
  if (error) {
    if (error.message?.includes('movement_context_not_found')) return null;
    throw error;
  }
  const r = data as {
    id: string; movement_id: string; beneficiary_type: DispenseBeneficiaryType;
    patient_identifier: string | null; patient_name: string | null;
    patient_reference_type: PatientReferenceType | null; patient_identity_masked: boolean;
    crash_cart_reference: string | null; internal_order_reference: string | null;
    notes: string | null; recorded_by: string; recorded_at: string;
  };
  return {
    id: r.id, movementId: r.movement_id, beneficiaryType: r.beneficiary_type,
    patientIdentifier: r.patient_identifier, patientName: r.patient_name,
    patientReferenceType: r.patient_reference_type, patientIdentityMasked: r.patient_identity_masked,
    crashCartReference: r.crash_cart_reference, internalOrderReference: r.internal_order_reference,
    notes: r.notes, recordedBy: r.recorded_by, recordedAt: r.recorded_at,
  };
}

// ─── Atomic dispense + context (migration 136) ──────────────────────────────

export interface DispenseWithContextInput {
  /** Stable across retries of the SAME attempt — drives idempotency on BOTH
   *  halves, so a lost response can be replayed without double-dispensing. */
  requestId: string;
  outletStockId: string;
  quantity: number;
  beneficiaryType: DispenseBeneficiaryType;
  patientIdentifier?: string;
  patientName?: string;
  patientReferenceType?: PatientReferenceType;
  crashCartReference?: string;
  internalOrderReference?: string;
  /** Free-text clinical reason recorded on the movement itself. */
  reason?: string;
  /** Free-text note recorded on the outlet stock row. */
  notes?: string;
  /** Free-text note recorded on the CONTEXT row (never on the ledger). */
  contextNotes?: string;
}

export interface DispenseWithContextResult {
  ok: boolean;
  idempotentReplay: boolean;
  movementId: string;
  outletStockId: string;
  quantityBefore: number;
  quantityDelta: number;
  quantityAfter: number;
  dispenseContextId: string;
  beneficiaryType: DispenseBeneficiaryType;
}

/**
 * Dispenses outlet stock AND records the beneficiary context in ONE server
 * transaction (migration 136). This is the ONLY dispense entry point the UI
 * uses: calling the bare dispense RPC and then the context RPC would be two
 * transactions, and a failure between them would leave stock gone with no
 * beneficiary recorded — a gap the browser cannot close. If the context is
 * invalid, the server rolls the dispense back too, so the operator never has
 * to reconcile a half-completed act.
 */
export async function dispenseWithContext(
  input: DispenseWithContextInput,
): Promise<DispenseWithContextResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');
  const { data, error } = await supabase.rpc('phoenix_dispense_outlet_stock_with_context', {
    p_request_id:               input.requestId,
    p_outlet_stock_id:          input.outletStockId,
    p_quantity:                 input.quantity,
    p_beneficiary_type:         input.beneficiaryType,
    p_patient_identifier:       input.patientIdentifier ?? null,
    p_patient_name:             input.patientName ?? null,
    p_patient_reference_type:   input.patientReferenceType ?? null,
    p_crash_cart_reference:     input.crashCartReference ?? null,
    p_internal_order_reference: input.internalOrderReference ?? null,
    p_reason:                   input.reason ?? null,
    p_notes:                    input.notes ?? null,
    p_context_notes:            input.contextNotes ?? null,
  });
  if (error) throw error;
  const r = data as {
    ok: boolean; idempotent_replay?: boolean; movement_id: string; outlet_stock_id: string;
    quantity_before: number; quantity_delta: number; quantity_after: number;
    dispense_context_id: string; beneficiary_type: DispenseBeneficiaryType;
  };
  return {
    ok: r.ok,
    idempotentReplay: r.idempotent_replay ?? false,
    movementId: r.movement_id,
    outletStockId: r.outlet_stock_id,
    quantityBefore: r.quantity_before,
    quantityDelta: r.quantity_delta,
    quantityAfter: r.quantity_after,
    dispenseContextId: r.dispense_context_id,
    beneficiaryType: r.beneficiary_type,
  };
}
