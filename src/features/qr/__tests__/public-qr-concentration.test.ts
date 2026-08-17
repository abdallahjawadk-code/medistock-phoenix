/**
 * PUBLIC-QR-CONCENTRATION-059-A
 *
 * buildQrItemMetaLine is a pure exported function — tested directly, matching
 * this repo's convention of pure-function unit tests plus static source-code
 * wiring checks (no @testing-library/react component rendering is used
 * anywhere in this codebase; see public-qr-hide-nonavailable-items.test.ts).
 *
 * Required public QR appearance:
 *   Material name
 *   concentration • dosage form
 *   quantity / status / expiry (unchanged)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildQrItemMetaLine } from '../PublicQrScreen';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/qr/PublicQrScreen.tsx');
const qrService = readSrc('shared/supabase/services/qr.service.ts');

// ============================================================================
// A. Rendering rules (pure function)
// ============================================================================

describe('A. buildQrItemMetaLine: concentration/dosage-form display rules', () => {
  it('1. renders concentration when populated', () => {
    expect(buildQrItemMetaLine({ concentration: '500 mg' })).toBe('500 mg');
  });

  it('2. null concentration renders nothing', () => {
    expect(buildQrItemMetaLine({ concentration: null })).toBe('');
  });

  it('3. empty concentration renders nothing', () => {
    expect(buildQrItemMetaLine({ concentration: '' })).toBe('');
  });

  it('4. whitespace-only concentration renders nothing', () => {
    expect(buildQrItemMetaLine({ concentration: '   ' })).toBe('');
    expect(buildQrItemMetaLine({ concentration: '\t\n ' })).toBe('');
  });

  it('5. concentration is trimmed', () => {
    expect(buildQrItemMetaLine({ concentration: '  500 mg  ' })).toBe('500 mg');
  });

  it('6. dosage_form continues to render (migration 058 behavior preserved)', () => {
    expect(buildQrItemMetaLine({ dosage_form: 'Tablet' })).toBe('Tablet');
    expect(buildQrItemMetaLine({ dosage_form: '  Tablet  ' })).toBe('Tablet');
    expect(buildQrItemMetaLine({ dosage_form: null })).toBe('');
    expect(buildQrItemMetaLine({ dosage_form: '   ' })).toBe('');
  });

  it('7. both values render as "concentration • dosage form"', () => {
    expect(buildQrItemMetaLine({ concentration: '500 mg', dosage_form: 'Tablet' }))
      .toBe('500 mg • Tablet');
  });

  it('8. the bullet appears only when BOTH exist', () => {
    expect(buildQrItemMetaLine({ concentration: '500 mg', dosage_form: 'Tablet' })).toContain(' • ');
    expect(buildQrItemMetaLine({ concentration: '500 mg' })).not.toContain('•');
    expect(buildQrItemMetaLine({ dosage_form: 'Tablet' })).not.toContain('•');
    expect(buildQrItemMetaLine({})).not.toContain('•');
  });

  it('9. never produces a leading, trailing or isolated bullet', () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { concentration: null, dosage_form: null },
      { concentration: '', dosage_form: '' },
      { concentration: '   ', dosage_form: '   ' },
      { concentration: '500 mg', dosage_form: '' },
      { concentration: '', dosage_form: 'Tablet' },
      { concentration: '  ', dosage_form: 'Tablet' },
      { concentration: '500 mg', dosage_form: '  ' },
    ];
    cases.forEach(c => {
      const out = buildQrItemMetaLine(c);
      expect(out).not.toMatch(/^\s*•/);
      expect(out).not.toMatch(/•\s*$/);
      expect(out.trim()).not.toBe('•');
    });
  });

  it('neither present → empty string (caller renders nothing, no reserved space)', () => {
    expect(buildQrItemMetaLine({})).toBe('');
    expect(buildQrItemMetaLine({ concentration: null, dosage_form: null })).toBe('');
  });

  it('11. Arabic concentration text is handled safely (no mangling, no translation)', () => {
    expect(buildQrItemMetaLine({ concentration: '٥٠٠ ملغم' })).toBe('٥٠٠ ملغم');
    expect(buildQrItemMetaLine({ concentration: '  ٥٠٠ ملغم  ', dosage_form: 'أقراص' }))
      .toBe('٥٠٠ ملغم • أقراص');
  });

  it('never emits a placeholder for missing values', () => {
    const out = [
      buildQrItemMetaLine({}),
      buildQrItemMetaLine({ concentration: null }),
      buildQrItemMetaLine({ dosage_form: null }),
    ].join('|');
    expect(out).not.toMatch(/N\/A|n\/a|غير متوفر|null|undefined|-{2,}/);
  });

  it('non-string values are ignored rather than coerced', () => {
    expect(buildQrItemMetaLine({ concentration: 500 as unknown as string })).toBe('');
    expect(buildQrItemMetaLine({ concentration: 500 as unknown as string, dosage_form: 'Tablet' })).toBe('Tablet');
  });
});

// ============================================================================
// B. Wiring / layout
// ============================================================================

describe('B. PublicQrScreen wiring', () => {
  it('PublicItem carries the additive optional concentration field', () => {
    expect(screen).toContain('concentration?: string | null;');
  });

  it('the meta line is built once per item via the shared helper (no duplicate render)', () => {
    expect(screen).toContain('const metaLine = buildQrItemMetaLine(item);');
    const renders = screen.match(/\{metaLine\}/g) ?? [];
    expect(renders.length).toBe(1);
  });

  it('10. the meta line keeps dir="auto"', () => {
    expect(screen).toMatch(/\{metaLine && \(\s*\n\s*<div dir="auto"/);
  });

  it('the meta line renders only when non-empty (empty string is falsy → nothing)', () => {
    expect(screen).toContain('{metaLine && (');
  });

  it('sits directly below the material name, above quantity/status', () => {
    const nameIdx = screen.indexOf('{label}');
    const metaIdx = screen.indexOf('{metaLine && (');
    const qtyIdx = screen.indexOf('{item.quantity}');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(metaIdx).toBeGreaterThan(nameIdx);
    expect(qtyIdx).toBeGreaterThan(metaIdx);
  });

  it('12. name/quantity/condition/expiry rendering is unchanged', () => {
    expect(screen).toContain('const label = itemLabel(item, lang);');
    expect(screen).toContain('{item.quantity}{item.unit ? ` ${item.unit}` : \'\'}');
    expect(screen).toContain('<PhoenixStatusBadge variant={variant} label={condLabel} />');
    expect(screen).toContain("{t('public_expiry_warn', lang)} {item.expiry_date}");
  });

  it('the QR card was not redesigned (same wrapper/meta styling as migration 058)', () => {
    expect(screen).toContain("style={{ marginTop: '4px', fontSize: '11px', color: 'var(--t2)' }}");
  });
});

// ============================================================================
// C. Network / behavior preservation
// ============================================================================

describe('C. QR request + behavior preserved', () => {
  it('13. exactly one RPC request remains (no extra network call added)', () => {
    const calls = screen.match(/getPublicQrPayload\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(screen).toContain('() => getPublicQrPayload(publicId)');
    const rpc = qrService.match(/supabase\.rpc\('get_public_qr_payload'/g) ?? [];
    expect(rpc.length).toBe(1);
  });

  it('qr.service.ts publishes a narrow typed PublicQrPayload (188 additive facility fields)', () => {
    expect(qrService).toContain("supabase.rpc('get_public_qr_payload', {");
    expect(qrService).toContain('p_public_id: publicId,');
    expect(qrService).toContain('export interface PublicQrPayload');
    expect(qrService).toContain("facility_id?: string | null");
    expect(qrService).toContain("facility_name?: string | null");
    expect(qrService).toContain("facility_name_ar?: string | null");
    expect(qrService).toContain('return data as PublicQrPayload;');
  });

  it('14. invalid/disabled QR behavior remains', () => {
    expect(screen).toContain("t('qr_invalid', lang)");
    expect(screen).toContain("t('qr_scan_again', lang)");
    expect(screen).toContain("payload?.ok === true");
    expect(screen).toContain("t('qr_public_load_error', lang)");
  });

  it('15. removed/non-available item filtering remains', () => {
    expect(screen).toContain('export function isPubliclyAvailableQrItem');
    expect(screen).toContain('rawItems.filter(isPubliclyAvailableQrItem)');
  });

  it('?qid= / ?token= detection is untouched (lives in App.tsx, not here)', () => {
    expect(screen).not.toContain("params.get('qid')");
  });
});

// ============================================================================
// D. Privacy — nothing beyond concentration is exposed
// ============================================================================

describe('D. public privacy: only concentration newly rendered', () => {
  const FORBIDDEN = [
    'price', 'entered_price', 'unit_price', 'supply_type', 'national_code',
    'batch_number', 'internal_batch_reference', 'dispatch', 'warehouse_id',
    'document_number', 'actor_name_snapshot', 'actor_email_snapshot',
    'removed_by', 'last_updated_by',
  ];

  FORBIDDEN.forEach(field => {
    it(`does not render '${field}'`, () => {
      expect(screen).not.toContain(field);
    });
  });

  it('16-20. price / supply type / national code / batch / dispatch all absent from the payload type', () => {
    const typeStart = screen.indexOf('type PublicItem = {');
    const typeEnd = screen.indexOf('};', typeStart);
    const publicItemType = screen.slice(typeStart, typeEnd);
    expect(publicItemType).not.toMatch(/price|supply_type|national_code|batch_number|dispatch/);
    // Only the reviewed public fields are modelled.
    expect(publicItemType).toContain('concentration?: string | null;');
    expect(publicItemType).toContain('dosage_form?: string | null;');
  });

  it('the trust note stating no private data is exposed remains', () => {
    expect(screen).toContain("t('qr_no_expose', lang)");
  });
});
