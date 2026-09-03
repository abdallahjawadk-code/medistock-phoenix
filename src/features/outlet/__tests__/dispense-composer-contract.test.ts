/**
 * DISPENSE-WITH-CONTEXT-136 — composer frontend contract.
 *
 * The composer is the ONLY dispense entry point in the app. These assertions
 * pin the properties that make that safe:
 *   * it calls the ATOMIC RPC, never the bare dispense RPC or a table write;
 *   * it is gated on BOTH scoped permissions the composed act needs;
 *   * the form is discriminated on beneficiary type and clears stale fields
 *     when the type changes;
 *   * the request id is stable across a retry and reset when the world moved;
 *   * patient identity never reaches a URL, a log, or the movement reason;
 *   * every user-visible string is bilingual.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const OUTLET = join(__dirname, '..');
const SRC = join(__dirname, '../../..');
const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8');

const service = read(OUTLET, 'dispense-context.service.ts');
const composer = read(OUTLET, 'DispenseComposerDialog.tsx');
const screen = read(OUTLET, 'OutletOperationsScreen.tsx');
const permHook = read(SRC, 'features/inventory/useOutletDispensePermission.ts');
const strings = read(SRC, 'shared/i18n/strings.ts');

describe('A) the composer dispenses through the ATOMIC RPC only', () => {
  it('the service calls phoenix_dispense_outlet_stock_with_context', () => {
    expect(service).toContain("supabase.rpc('phoenix_dispense_outlet_stock_with_context'");
  });

  it('the composer never calls the bare dispense RPC or the context RPC separately', () => {
    // The BARE name, i.e. not followed by _with_context. (The doc comment
    // legitimately names the atomic RPC, which contains the bare name as a
    // substring — matching that would be a false positive.)
    expect(composer).not.toMatch(/phoenix_dispense_outlet_stock(?!_with_context)/);
    expect(composer).not.toContain('recordDispenseContext');
    expect(composer).toContain('dispenseWithContext');
  });

  it('no component writes a quantity to a table directly', () => {
    for (const [name, src] of [['composer', composer], ['service', service]] as const) {
      expect(src, name).not.toMatch(/\.from\(['"](outlet_stock|outlet_stock_movements|phoenix_movement_dispense_context)['"]\)\.(insert|update|upsert|delete)/);
    }
  });

  it('forwards every parameter the atomic RPC defines', () => {
    const start = service.indexOf('export async function dispenseWithContext');
    const body = service.slice(start);
    for (const p of [
      'p_request_id', 'p_outlet_stock_id', 'p_quantity', 'p_beneficiary_type',
      'p_patient_identifier', 'p_patient_name', 'p_patient_reference_type',
      'p_crash_cart_reference', 'p_internal_order_reference',
      'p_reason', 'p_notes', 'p_context_notes',
    ]) {
      expect(body, p).toContain(p);
    }
  });
});

describe('B) gated on BOTH scoped permissions the composed act needs', () => {
  it('the hook asks for outlet_stock.dispense AND movement_context.record', () => {
    expect(permHook).toContain("ask('outlet_stock.dispense')");
    expect(permHook).toContain("ask('movement_context.record')");
  });

  it('the hook requires both to be allowed', () => {
    expect(permHook).toMatch(/dispense\.ok && dispense\.allowed && context\.ok && context\.allowed/);
  });

  it('the hook never decides from a raw role name (super_admin bypass excepted)', () => {
    const withoutSuperAdmin = permHook.replace(/profile\.role === 'super_admin'/g, '');
    expect(withoutSuperAdmin).not.toMatch(/profile\.role\s*===\s*'/);
  });

  it('the composer refuses to submit when canDispense is false', () => {
    expect(composer).toMatch(/canSubmit\s*=\s*\n?\s*canDispense/);
    expect(composer).toContain('dsp_no_permission');
  });

  it('the screen wires the hook and shows the action only when permitted', () => {
    expect(screen).toContain('useOutletDispensePermission');
    expect(screen).toMatch(/canDispense && r\.availableQuantity > 0/);
  });
});

describe('C) discriminated form — only valid fields, no stale values on switch', () => {
  it('renders each beneficiary type\'s fields behind its own guard', () => {
    expect(composer).toContain("beneficiaryType === 'patient'");
    expect(composer).toContain("beneficiaryType === 'internal_order'");
    // STAGE-F-172: crash_cart is retired as a dispensing beneficiary, so it
    // no longer has a branch to render.
    expect(composer).not.toContain("beneficiaryType === 'crash_cart'");
  });

  it('switching type clears every other type\'s field', () => {
    const fn = composer.slice(composer.indexOf('function selectBeneficiaryType'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    for (const setter of [
      'setPatientName(\'\')', 'setPatientIdentifier(\'\')',
      'setInternalOrderReference(\'\')',
    ]) {
      expect(body, setter).toContain(setter);
    }
    // Nothing left to clear for the retired type — its state is gone.
    expect(composer).not.toContain('setCrashCartReference');
  });

  it('the type selector goes through selectBeneficiaryType, never a bare setState', () => {
    expect(composer).toMatch(/onChange=\{e => selectBeneficiaryType\(e\.target\.value as DispenseBeneficiaryType\)\}/);
  });

  it('only sends a reference type when a reference number accompanies it', () => {
    expect(composer).toMatch(/patientReferenceType: patientIdentifier\.trim\(\) \? patientReferenceType : undefined/);
  });

  it('uses the closed chart/card vocabulary for NEW dispensing, keeping pass readable', () => {
    // The historical union still carries 'pass' so old rows render …
    expect(service).toContain("'chart' | 'card' | 'pass'");
    // … but STAGE-F-172 refuses it on write, so the composer must never
    // offer it. Only the two owner-approved documents are selectable.
    expect(composer).toContain("value: 'chart'");
    expect(composer).toContain("value: 'card'");
    expect(composer).not.toContain("value: 'pass'");
    // And the retired beneficiary is gone from the selector too.
    expect(composer).not.toContain("value: 'crash_cart'");
  });
});

describe('D) retry safety', () => {
  it('holds a stable request id across a retry of the same attempt', () => {
    expect(composer).toContain('requestIdRef');
    expect(composer).toMatch(/if \(!requestIdRef\.current\) requestIdRef\.current = crypto\.randomUUID\(\)/);
  });

  it('clears the request id when the world moved (conflict / insufficient stock)', () => {
    expect(composer).toMatch(/dispense_context_conflict[\s\S]{0,120}requestIdRef\.current = null/);
  });

  it('disables submit while a request is in flight', () => {
    // 204/mds_badge: a suspended material's own gate (!suspended) sits
    // between canDispense and !busy now — still refuses in-flight resubmits,
    // just no longer the very next token after canDispense.
    expect(composer).toMatch(/canDispense && !suspended && !busy/);
  });
});

describe('E) validation surfaces before the server sees it (preflight, not authorization)', () => {
  it('blocks a non-positive or over-available quantity', () => {
    expect(composer).toContain('qtyInvalid');
    expect(composer).toContain('qtyExceeds');
    expect(composer).toMatch(/qtyNum > lot\.availableQuantity/);
  });

  it('requires the per-type mandatory field', () => {
    expect(composer).toContain('patientNameMissing');
    expect(composer).toContain('internalOrderMissing');
    // STAGE-F-172: the retired type has no field left to require …
    expect(composer).not.toContain('crashCartMissing');
    // … and a patient dispense now also requires the reference NUMBER,
    // because 172 refuses a document type with no number.
    expect(composer).toContain('patientRefIncomplete');
    expect(composer).toMatch(/patientRefIncomplete\s*=\s*beneficiaryType === 'patient' && patientIdentifier\.trim\(\) === ''/);
  });

  it('marks invalid fields for assistive technology and announces errors', () => {
    expect(composer).toMatch(/aria-invalid=/);
    expect((composer.match(/role="alert"/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('labels every input (no unlabelled control)', () => {
    const ids = [...composer.matchAll(/<input id="([^"]+)"|<textarea id="([^"]+)"/g)]
      .map(m => m[1] ?? m[2]);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    for (const id of ids) {
      expect(composer, `label for ${id}`).toContain(`htmlFor="${id}"`);
    }
  });
});

describe('F) privacy — identity never leaves the form except through the RPC body', () => {
  it('never puts patient fields in a URL, query string, or storage', () => {
    for (const src of [composer, service]) {
      expect(src).not.toMatch(/(localStorage|sessionStorage)[^;\n]*patient/i);
      expect(src).not.toMatch(/[?&](patient|mrn)[A-Za-z]*=/i);
    }
  });

  it('never console-logs the form state', () => {
    expect(composer).not.toMatch(/console\.(log|info|warn|error)/);
  });

  it('records the context note separately from the ledger reason', () => {
    // p_reason lands on the movement; p_context_notes lands on the context row.
    expect(composer).toMatch(/reason: reason\.trim\(\) \|\| undefined/);
    expect(composer).toMatch(/contextNotes: contextNotes\.trim\(\) \|\| undefined/);
  });

  it('the service exposes patientReferenceType as never-masked, unlike identity', () => {
    expect(service).toMatch(/Never masked — a document kind is not an identity/);
  });
});

describe('G) error classification covers the composed act\'s failure modes', () => {
  const start = service.indexOf('export function classifyDispenseContextError');
  const body = service.slice(start, service.indexOf('\n}', start));
  const cases: Array<[string, string]> = [
    ['patient_reference_type_required', 'dispense_context_reference_type_required'],
    ['patient_identifier_required_for_reference_type', 'dispense_context_reference_number_required'],
    ['invalid_patient_reference_type', 'dispense_context_invalid_reference_type'],
    ['outlet_quantity_cannot_go_negative', 'dispense_insufficient_stock'],
    ['outlet_quantity_below_reserved', 'dispense_below_reserved'],
    ['expired_batch_cannot_be_dispensed', 'dispense_expired_batch'],
    ['forbidden_outlet_stock_dispense', 'dispense_forbidden'],
  ];
  for (const [needle, key] of cases) {
    it(`${needle} → ${key}`, () => {
      expect(body).toContain(needle);
      expect(body).toContain(key);
    });
  }
});

describe('H) every composer string is bilingual', () => {
  const keys = [
    'dsp_action', 'dsp_title', 'dsp_quantity_label', 'dsp_quantity_invalid', 'dsp_quantity_exceeds',
    'dsp_patient_name_required', 'dsp_reference_type_label', 'dsp_ref_chart', 'dsp_ref_card',
    'dsp_ref_pass', 'dsp_reference_number_label', 'dsp_reason_label', 'dsp_submit',
    'dsp_succeeded', 'dsp_no_permission', 'dsp_atomic_note',
    'dispense_context_reference_type_required', 'dispense_context_reference_number_required',
    'dispense_context_invalid_reference_type', 'dispense_insufficient_stock',
    'dispense_below_reserved', 'dispense_expired_batch', 'dispense_quantity_positive',
    'dispense_forbidden',
  ];
  for (const key of keys) {
    it(`${key} has both ar and en entries`, () => {
      const re = new RegExp(`${key}:\\s*\\{[^}]*ar:[^}]*en:[^}]*\\}`);
      expect(strings, key).toMatch(re);
    });
  }

  it('the atomic guarantee is explained to the operator in both languages', () => {
    const m = /dsp_atomic_note:\s*\{\s*ar: '([^']+)',\s*en: '([^']+)'/.exec(strings);
    expect(m).not.toBeNull();
    expect(m![1].length).toBeGreaterThan(20);
    expect(m![2].length).toBeGreaterThan(20);
  });
});

describe('I) RTL/direction handling', () => {
  it('free-text inputs use dir="auto" so Arabic and Latin both render correctly', () => {
    const textInputs = composer.match(/<input id="dsp-(patient-name|patient-ref|cart|order|reason)"[^>]*/g) ?? [];
    expect(textInputs.length).toBeGreaterThanOrEqual(4);
    for (const tag of textInputs) {
      expect(tag, tag).toContain('dir="auto"');
    }
  });

  it('the identity/batch summary uses explicit direction', () => {
    expect(composer).toMatch(/dir="ltr"/);
    expect(composer).toMatch(/dir="auto"/);
  });
});
