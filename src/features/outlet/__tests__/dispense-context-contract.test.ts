/**
 * MOVEMENT-DISPENSE-CONTEXT (migration 134) — frontend contract.
 *
 * Static source assertions proving the frontend layer is a thin, honest
 * client of the three SECURITY DEFINER RPCs:
 *   - recordDispenseContext maps to phoenix_record_movement_dispense_context
 *     with exact params, never a direct table write (the table has no grant
 *     to authenticated at all — a direct write would 403 anyway, but this
 *     proves the client doesn't even attempt one);
 *   - getDispenseContext maps to phoenix_get_movement_dispense_context and
 *     treats "not recorded yet" (movement_context_not_found) as null, never
 *     as a thrown error the UI has to special-case;
 *   - the record action is gated in the UI on the SCOPED
 *     movement_context.record permission (the same question the RPC
 *     re-answers server-side) — never a raw role name;
 *   - the viewer renders exactly what the server returns and never attempts
 *     to unmask patient identity client-side;
 *   - bilingual strings exist for every key referenced.
 * Matches this repo's established static-scan test convention (no live DB).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const OUTLET = join(__dirname, '..');
const SRC = join(__dirname, '../../..');
const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8');

const service = read(OUTLET, 'dispense-context.service.ts');
const dialog = read(OUTLET, 'DispenseContextDialog.tsx');
const viewer = read(OUTLET, 'DispenseContextViewer.tsx');
const screen = read(OUTLET, 'OutletOperationsScreen.tsx');
const permHook = read(SRC, 'features/inventory/useMovementContextRecordPermission.ts');
const strings = read(SRC, 'shared/i18n/strings.ts');

describe('A) recordDispenseContext maps to the RPC with exact params, never a direct table write', () => {
  it('calls phoenix_record_movement_dispense_context, never a table write', () => {
    expect(service).toContain("supabase.rpc('phoenix_record_movement_dispense_context'");
    expect(service).not.toMatch(/\.from\(['"]phoenix_movement_dispense_context['"]\)\.(insert|update|upsert|delete)/);
  });

  it('forwards request id, movement id, beneficiary type, and all four optional fields', () => {
    const start = service.indexOf('export async function recordDispenseContext');
    const body = service.slice(start, service.indexOf('\n}', start));
    for (const p of [
      'p_request_id', 'p_movement_id', 'p_beneficiary_type',
      'p_patient_identifier', 'p_patient_name', 'p_crash_cart_reference',
      'p_internal_order_reference', 'p_notes',
    ]) {
      expect(body, p).toContain(p);
    }
  });

  it('surfaces idempotent_replay so a retried request never appears as a fresh write', () => {
    expect(service).toContain('idempotent_replay');
  });
});

describe('B) getDispenseContext maps to the RPC and treats "not recorded" as null, not an error', () => {
  it('calls phoenix_get_movement_dispense_context', () => {
    expect(service).toContain("supabase.rpc('phoenix_get_movement_dispense_context'");
  });

  it('returns null (never throws) for movement_context_not_found', () => {
    const start = service.indexOf('export async function getDispenseContext');
    expect(service.slice(start)).toContain('movement_context_not_found');
    expect(service.slice(start)).toMatch(/movement_context_not_found[\s\S]{0,20}return null/);
  });

  it('never attempts to unmask patient identity client-side — reads patient_identity_masked straight through', () => {
    expect(service).toContain('patient_identity_masked');
    expect(service).not.toMatch(/atob|decrypt|unmask/i);
  });
});

describe('C) error classification distinguishes conflict, validation, and authorization', () => {
  const start = service.indexOf('export function classifyDispenseContextError');
  const body = service.slice(start, service.indexOf('\n}', start));
  const cases: Array<[string, string]> = [
    ['movement_not_a_dispense', 'dispense_context_not_a_dispense'],
    ['movement_not_found', 'dispense_context_movement_not_found'],
    ['movement_id_conflict', 'dispense_context_conflict'],
    ['patient_identifier_or_name_required', 'dispense_context_patient_required'],
    ['crash_cart_reference_required', 'dispense_context_crash_cart_required'],
    ['internal_order_reference_required', 'dispense_context_internal_order_required'],
    ['invalid_beneficiary_type', 'dispense_context_invalid_type'],
  ];
  for (const [needle, key] of cases) {
    it(`${needle} → ${key}`, () => {
      expect(body).toContain(needle);
      expect(body).toContain(key);
    });
  }
  it('42501/forbidden_movement_context_record → dispense_context_forbidden', () => {
    expect(body).toMatch(/42501/);
    expect(body).toContain('forbidden_movement_context_record');
    expect(body).toContain('dispense_context_forbidden');
  });
});

describe('D) the record action is gated on the SCOPED movement_context.record permission', () => {
  it('the permission hook asks phoenix_profile_has_scoped_permission for movement_context.record', () => {
    expect(permHook).toContain("permissionKey: 'movement_context.record'");
    expect(permHook).toContain('hasScopedPermission');
  });

  it('the dialog refuses to submit when canRecord is false', () => {
    expect(dialog).toMatch(/canSubmit\s*=\s*canRecord/);
    expect(dialog).toContain('dc_no_permission');
  });

  it('the screen wires the permission hook and passes canRecord through to the dialog, never a raw role check', () => {
    expect(screen).toContain('useMovementContextRecordPermission');
    expect(screen).not.toMatch(/profile\.role\s*===\s*['"]outlet_officer['"]/);
  });
});

describe('E) the request id is stable across a retry (idempotency), like the correction modal', () => {
  it('uses a ref-held request id, generated once and cleared on success/close', () => {
    expect(dialog).toContain('requestIdRef');
    expect(dialog).toMatch(/crypto\.randomUUID\(\)/);
  });

  it('clears the request id on a genuine conflict so the next attempt is a fresh operation', () => {
    expect(dialog).toMatch(/dispense_context_conflict[\s\S]{0,80}requestIdRef\.current\s*=\s*null/);
  });
});

describe('F) the viewer renders exactly what the server returns — no client-side unmasking', () => {
  it('branches on patientIdentityMasked, never re-derives identity from other fields', () => {
    expect(viewer).toContain('patientIdentityMasked');
    expect(viewer).not.toMatch(/atob|decrypt|unmask/i);
  });

  it('shows the masked indicator, not a placeholder value, when masked', () => {
    expect(viewer).toContain('dc_identity_masked');
  });
});

describe('G) beneficiary-type-specific fields are mutually exclusive in the dialog, matching the server CHECK', () => {
  it('only renders patient fields for beneficiaryType patient, order field for internal_order', () => {
    expect(dialog).toContain("beneficiaryType === 'patient'");
    expect(dialog).toContain("beneficiaryType === 'internal_order'");
  });

  it('validates each type-specific requirement before allowing submit', () => {
    expect(dialog).toContain('patientValid');
    expect(dialog).toContain('internalOrderValid');
  });
});

/**
 * STAGE-F-172 — the patient-dispensing contract the product must now honour.
 *
 * These assertions are POSITIVE proof of the new contract, not a relaxation of
 * the old one: the legacy crash_cart handoff must be gone from the operator
 * surface, and a patient dispense must now declare WHICH document its
 * reference number came from.
 */
describe('G2) Stage-F patient dispensing contract (Migration 172)', () => {
  it('the operator can no longer choose the retired crash_cart beneficiary', () => {
    // The option must be gone from the selector, and the dialog must no longer
    // branch on it or collect a free-text cart reference.
    expect(dialog).not.toContain("value: 'crash_cart'");
    expect(dialog).not.toContain("beneficiaryType === 'crash_cart'");
    expect(dialog).not.toContain('crashCartValid');
    expect(dialog).not.toContain('setCrashCartReference');
  });

  it('still offers the two canonical beneficiaries that survive Stage F', () => {
    expect(dialog).toContain("value: 'patient'");
    expect(dialog).toContain("value: 'internal_order'");
  });

  it('offers exactly card and chart as the new patient document types', () => {
    expect(dialog).toContain("value: 'card'");
    expect(dialog).toContain("value: 'chart'");
    // 'pass' is retired for new dispensing (172 refuses it server-side); it
    // must never be offered, even though historical rows may still carry it.
    expect(dialog).not.toContain("value: 'pass'");
  });

  it('requires BOTH the document type and the reference number before submit', () => {
    // 172 refuses a number with no document and a document with no number.
    expect(dialog).toContain("patientReferenceType !== ''");
    expect(dialog).toContain("patientIdentifier.trim() !== ''");
  });

  it('sends patientReferenceType to the service on submit', () => {
    expect(dialog).toContain('patientReferenceType: patientReferenceType || undefined');
  });

  it('the service exposes a Stage-F-narrowed document type without losing history', () => {
    // New writes: card | chart only …
    expect(service).toContain("export type StageFPatientReferenceType = Extract<PatientReferenceType, 'card' | 'chart'>");
    expect(service).toContain("Object.freeze(['card', 'chart'])");
    // … while the historical union keeps 'pass' so old rows still render.
    expect(service).toContain("export type PatientReferenceType = 'chart' | 'card' | 'pass'");
  });

  it('the dialog types its document state with the Stage-F narrowed type', () => {
    expect(dialog).toContain('StageFPatientReferenceType');
  });
});

describe('H) bilingual strings exist for every key referenced by the dialog/viewer/service', () => {
  const keys = [
    'dc_record_action', 'dc_dialog_title', 'dc_beneficiary_type_label',
    'dc_type_patient', 'dc_type_crash_cart', 'dc_type_internal_order',
    'dc_patient_privacy_note', 'dc_patient_identifier_label', 'dc_patient_name_label', 'dc_patient_required',
    'dc_crash_cart_reference_label', 'dc_crash_cart_required',
    'dc_internal_order_reference_label', 'dc_internal_order_required',
    'dc_notes_label', 'dc_submit', 'dc_cancel', 'dc_no_permission', 'dc_identity_masked',
    'dispense_context_not_a_dispense', 'dispense_context_movement_not_found', 'dispense_context_conflict',
    'dispense_context_patient_required', 'dispense_context_crash_cart_required',
    'dispense_context_internal_order_required', 'dispense_context_invalid_type', 'dispense_context_forbidden',
  ];
  for (const key of keys) {
    it(`${key} has both ar and en entries`, () => {
      const re = new RegExp(`${key}:\\s*\\{[^}]*ar:[^}]*en:[^}]*\\}`);
      expect(strings, key).toMatch(re);
    });
  }
});

describe('I) the history tab wires the dispense-context slot only for dispense-type rows', () => {
  it('gates the slot on movementType === dispense', () => {
    expect(screen).toContain("r.movementType === 'dispense'");
  });

  it('renders DispenseContextSlot and the DispenseContextDialog exactly once each', () => {
    expect((screen.match(/<DispenseContextSlot/g) ?? []).length).toBe(1);
    expect((screen.match(/<DispenseContextDialog/g) ?? []).length).toBe(1);
  });
});
