/**
 * PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A
 *
 * The public QR material list additively shows the previously-entered
 * pharmaceutical dosage form (item_availability.dosage_form, surfaced by the
 * additive migration 058 RPC field) below the material name — but only when it
 * holds a real, non-empty, non-whitespace value. It must never render a
 * placeholder, empty row, "N/A", or reserved blank space, and must not disturb
 * any existing material field, the single-RPC call, the invalid-QR experience,
 * or the removed/non-available hiding.
 *
 * This repo's convention is pure-function + static source-wiring tests (there
 * is no @testing-library/react component rendering anywhere in the codebase),
 * so the render guard is verified by (a) replicating the exact predicate as a
 * pure function for behavioral coverage and (b) asserting the wiring in the
 * PublicQrScreen source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

const screen = readSrc('features/qr/PublicQrScreen.tsx');
const service = readSrc('shared/supabase/services/qr.service.ts');

/**
 * Exact replica of the render guard in PublicQrScreen.tsx. Kept in lockstep by
 * the wiring assertions below (which pin the same predicate text in source).
 */
function renderedDosageForm(dosage_form?: string | null): string | null {
  return typeof dosage_form === 'string' && dosage_form.trim().length > 0
    ? dosage_form.trim()
    : null;
}

describe('dosage form render guard (behavioral)', () => {
  it('1. renders when populated', () => {
    expect(renderedDosageForm('Tablet')).toBe('Tablet');
  });

  it('2. null does not render', () => {
    expect(renderedDosageForm(null)).toBeNull();
  });

  it('3. empty string does not render', () => {
    expect(renderedDosageForm('')).toBeNull();
  });

  it('4. whitespace-only value does not render', () => {
    expect(renderedDosageForm('   ')).toBeNull();
    expect(renderedDosageForm('\t\n ')).toBeNull();
  });

  it('5. displayed value is trimmed', () => {
    expect(renderedDosageForm('  Syrup  ')).toBe('Syrup');
  });

  it('undefined (field absent from payload) does not render', () => {
    expect(renderedDosageForm(undefined)).toBeNull();
  });

  it('preserves Arabic value verbatim (no translation/normalization)', () => {
    expect(renderedDosageForm('أقراص')).toBe('أقراص');
  });
});

describe('PublicQrScreen wiring: additive dosage form', () => {
  it('PublicItem type gains an optional/nullable dosage_form field', () => {
    expect(screen).toMatch(/dosage_form\?:\s*string\s*\|\s*null/);
  });

  it('computes the rendered value with the exact non-empty-trim guard', () => {
    expect(screen).toMatch(
      /typeof item\.dosage_form === 'string' &&\s*item\.dosage_form\.trim\(\)\.length > 0/,
    );
  });

  it('renders the trimmed value only when present (no placeholder)', () => {
    expect(screen).toMatch(/\{dosageForm && \(/);
    expect(screen).toContain('{dosageForm}');
  });

  it('6. uses dir="auto" on the dosage form line (RTL/LTR safe)', () => {
    // the dosage form block is a <div dir="auto"> ... {dosageForm} ... </div>
    expect(screen).toMatch(/<div dir="auto"[^>]*>\s*\{dosageForm\}/);
  });

  it('adds no placeholder text for a missing dosage form', () => {
    expect(screen).not.toContain('N/A');
    expect(screen).not.toContain('غير متوفر');
  });
});

describe('PublicQrScreen: existing material fields untouched', () => {
  it('7. still renders the material name label', () => {
    expect(screen).toContain('const label = itemLabel(item, lang);');
    expect(screen).toMatch(/dir="auto">\{label\}</);
  });

  it('8. introduces no concentration field (payload/UI shape otherwise unchanged)', () => {
    // concentration was never part of the public payload or card; this phase
    // must not add it. dosage_form is the only new field.
    expect(screen).not.toContain('concentration');
  });

  it('9. quantity render (guarded by variant !== err) is unchanged', () => {
    expect(screen).toMatch(/typeof item\.quantity === 'number' && variant !== 'err'/);
  });

  it('10. condition badge rendering is unchanged', () => {
    expect(screen).toContain('PhoenixStatusBadge');
    expect(screen).toMatch(/const condLabel = item\.condition \? conditionLabel/);
  });

  it('11. expiry rendering (near-expiry/expired only) is unchanged', () => {
    expect(screen).toMatch(/item\.expiry_date && isNearExpiry/);
  });

  it('14/15. near-expiry + expired classification (expiry bucket badge) unchanged', () => {
    expect(screen).toMatch(/const isNearExpiry = item\.condition === 'near_expiry' \|\| item\.condition === 'expired';/);
    expect(screen).toContain('getExpBucketBadge');
  });

  it('12. invalid/disabled QR experience is unchanged', () => {
    expect(screen).toMatch(/!loading && !error && !ok/);
    expect(screen).toContain("t('qr_invalid', lang)");
  });

  it('13. removed/non-available items remain hidden via the same filter', () => {
    expect(screen).toMatch(/rawItems\.filter\(isPubliclyAvailableQrItem\)/);
    expect(screen).toMatch(/filteredItems\.map\(/);
  });
});

describe('PublicQrScreen: single RPC + no new data exposure', () => {
  it('16. calls getPublicQrPayload exactly once, via useAsync', () => {
    const occurrences = (screen.match(/getPublicQrPayload\(/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(screen).toMatch(/useAsync\(\s*\(\) => getPublicQrPayload\(publicId\),\s*\[publicId\],\s*\)/);
  });

  it('17. no second Supabase request is introduced (screen uses only the service, no direct client)', () => {
    expect(screen).not.toContain("from '@/shared/supabase/client'");
    // the service performs exactly one supabase.rpc call for the payload
    const rpcCalls = (service.match(/supabase\.rpc\('get_public_qr_payload'/g) ?? []).length;
    expect(rpcCalls).toBe(1);
  });

  it('18. renders no additional private field', () => {
    expect(screen).not.toContain('batch_number');
    expect(screen).not.toContain('trade_name');
    expect(screen).not.toContain('entered_price');
    expect(screen).not.toMatch(/\bprice\b/);
    expect(screen).not.toContain('national_code');
    expect(screen).not.toContain('supply_type');
    expect(screen).not.toContain('notes');
  });
});
