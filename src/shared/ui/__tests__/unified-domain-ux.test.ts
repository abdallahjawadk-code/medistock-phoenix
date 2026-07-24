/**
 * UNIFIED-DOMAIN-UX — acceptance contracts for the canonical supply-provenance
 * package (branch feat/phoenix-unified-domain-ux-corrections).
 *
 * The ledger-level behaviors (two-source separation, no auto-draw, 087
 * supplementary pinning, reconciliation, sealing) are proven DYNAMICALLY
 * against the disposable rig in
 * supabase/migrations/__tests__/088-supply-provenance.dynamic.test.ts.
 * This file pins the frontend contracts. Sources newline-normalized (CRLF).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { SUPPLY_TYPES, displaySupplyType, supplyTypeLabelKey } from '../../lib/supply-types';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const strings = read('shared/i18n/strings.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const ALL_SRC = walk(SRC).filter(f => /\.(ts|tsx)$/.test(f) && !f.includes('__tests__'));

// ─── 1. Closed supply vocabulary — هبات is GONE from the UI ──────────────────

describe('supply type is a closed three-value vocabulary', () => {
  it('exactly aid / purchase / kimadia', () => {
    expect([...SUPPLY_TYPES]).toEqual(['aid', 'purchase', 'kimadia']);
    expect(supplyTypeLabelKey('aid')).toBe('sc_supply_aid');
  });

  it('هبات appears in ZERO shipped source files (strings, lists, exports)', () => {
    for (const file of ALL_SRC) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('هبات'), `هبات still present in ${file}`).toBe(false);
    }
  });

  it('legacy donation values DISPLAY under aid without any data rewrite', () => {
    expect(displaySupplyType('هبة عام 2024')).toBe('aid');
    expect(displaySupplyType('donations')).toBe('aid');
    expect(displaySupplyType('تبرع')).toBe('aid');
    expect(displaySupplyType('local_procurement')).toBe('purchase');
    expect(displaySupplyType('كيماديا')).toBe('kimadia');
    expect(displaySupplyType('purchase')).toBe('purchase');
    expect(displaySupplyType('غير معروف')).toBeNull();
  });

  it('the intake form offers ONLY the closed list and notes the central default', () => {
    const screen = read('features/inventory/InventoryCenterScreen.tsx');
    expect(screen).toContain('SUPPLY_TYPES.map(x => ({ value: x, label: t(supplyTypeLabelKey(x), lang) }))');
    expect(screen).toContain("t('st_purchase_central_note', lang)");
    // No free-text supply input remains in the intake form.
    expect(screen).not.toMatch(/PhoenixInput[^\n]*inv_supply_type/);
  });

  it('OCR coerces its extracted supply text through the closed mapping', () => {
    const flow = read('features/inventory/ocr/OcrIntakeFlow.tsx');
    expect(flow).toContain('const normalizedSupplyType = displaySupplyType(values.supplyType);');
    expect(flow).toContain('const supplyTypeValid = normalizedSupplyType !== null;');
  });
});

// ─── 2. Provenance identity reaches the wire and the generation read ─────────

describe('the 088 provenance contract is wired end-to-end client-side', () => {
  const service = read('features/inventory/warehouse-intake.service.ts');

  it('the guarded receipt carries p_supply_type / p_purchase_origin', () => {
    expect(service).toContain('p_supply_type:            input.supplyType ?? null');
    expect(service).toContain('p_purchase_origin:        input.purchaseOrigin ?? null');
  });

  it('the client generation read includes BOTH provenance identity axes', () => {
    expect(service).toContain("['supply_type', filter.supply_type]");
    expect(service).toContain("['purchase_origin', filter.purchase_origin]");
  });

  it('a purchase with no explicit origin resolves as CENTRAL, mirroring the server', () => {
    expect(service).toContain("supplyType === 'purchase' ? (explicitOrigin ?? 'central') : explicitOrigin");
  });
});

// ─── 3. Terminology ──────────────────────────────────────────────────────────

describe('the new domain terminology is total across AR/EN', () => {
  it('Supplementary Purchases replaces Local Procurement', () => {
    expect(strings).toContain('المشتريات الفرعية');
    expect(strings).toContain('Supplementary Purchases');
    expect(strings).not.toContain('المشتريات المحلية');
  });

  it('Transfer Suggestions replaces Inter-Institution Alerts', () => {
    expect(strings).toContain('اقتراحات المناقلات');
    expect(strings).toContain('Transfer Suggestions');
    expect(strings).not.toContain('تنبيهات بين المؤسسات');
  });

  it('the merged movement tab is سجل وتتبع الحركة / Movement History & Tracking', () => {
    expect(strings).toContain('سجل وتتبع الحركة');
    expect(strings).toContain('Movement History & Tracking');
    expect(strings).not.toMatch(/or_tab_status:/);
  });

  it('origin badges exist for central vs supplementary purchases', () => {
    expect(strings).toContain('مشتريات مركزية');
    expect(strings).toContain('مشتريات فرعية');
  });

  it('the external reference is the optional official-letter field', () => {
    expect(strings).toContain('رقم الكتاب أو المستند الخارجي — اختياري');
    expect(strings).toContain('ينشئ MediStock رقم الطلب والتتبع الرسمي تلقائيًا');
  });
});

// ─── 4. Movement tracking merge ──────────────────────────────────────────────

describe('one Movement History & Tracking tab on the 081/082 timeline', () => {
  it('screen 18 has a single history tab and no status tab', () => {
    const screen = read('features/outlet/OutletOperationsScreen.tsx');
    expect(screen).not.toContain("or_tab_status");
    expect(screen).toContain('<CurrentMovementStatus lang={lang} />');
    expect(screen).toContain('<OutletHistoryTab');
  });

  it('the tracker consumes phoenix_movement_timeline and dropped the unavailable copy', () => {
    const svc = read('features/movement/movement-timeline.service.ts');
    expect(svc).toContain("supabase.rpc('phoenix_movement_timeline'");
    const tracker = read('features/outlet/CurrentMovementStatus.tsx');
    expect(tracker).toContain('getMovementTimeline');
    expect(tracker).not.toContain('or_status_timeline_note');
    expect(strings).not.toContain('or_status_timeline_note');
  });
});

// ─── 5. Transfer regulatory acknowledgement ──────────────────────────────────

describe('creating/approving a transfer requires the regulatory acknowledgement', () => {
  const ops = read('features/network/DirectSupplyOperations.tsx');

  it('the notice + mandatory checkbox gate submit and review', () => {
    expect(ops).toContain("t('ts_regulatory_notice', lang)");
    expect(ops).toContain('data-testid="transfer-reg-ack"');
    expect(ops).toContain('disabled={!regAck}');
    // Review form is unreachable until acknowledged.
    expect(ops).toContain('regAck && (\n        <ReviewForm');
  });

  it('the acknowledgment is recorded in the audit trail with actor + time', () => {
    expect(ops).toContain("phoenix_record_regulatory_ack");
    expect(ops).toContain("'transfer.create_ack'");
    expect(ops).toContain("'transfer.review_ack'");
  });

  it('suggestions stay recommendation-only — no accept control anywhere', () => {
    const svc = read('features/inventory/inventory-intelligence.service.ts');
    expect(svc).toContain('no accept wrapper');
  });
});

// ─── 6. Intelligence simplification ──────────────────────────────────────────

describe('inventory intelligence has ONE refresh action', () => {
  const panel = read('features/inventory/InventoryIntelligencePanel.tsx');
  it('recompute + regenerate collapsed into تحديث البيانات', () => {
    expect(panel).toContain('runRefreshAll');
    expect(panel).toContain("t('inv_action_refresh_data', lang)");
    expect(panel).not.toContain("↻ {t('inv_action_recompute', lang)}");
  });
  it('the exchange center is the Inter-Institution Transfer Center', () => {
    expect(strings).toContain('مركز المناقلات بين المؤسسات');
    expect(strings).not.toContain('مركز تبادل المواد');
  });
});

// ─── 7. Search + loader are in place (PR #43 not regressed) ──────────────────

describe('search and loader', () => {
  it('warehouse stock search covers scientific/national/batch under normalization', () => {
    const screen = read('features/inventory/InventoryCenterScreen.tsx');
    expect(screen).toContain("normalizedIncludes(b.scientificName ?? '', query)");
    expect(screen).toContain("normalizedIncludes(b.nationalCode ?? '', query)");
    expect(screen).toContain("normalizedIncludes(b.batchNumber ?? '', query)");
  });

  it('the public outlet QR page searches names only — no national code, no batches', () => {
    const qr = read('features/qr/PublicQrScreen.tsx');
    expect(qr).not.toContain('national_code');
    expect(qr).not.toContain('batch_number');
  });

  it('نبض الصيدلة replaces the generic orbit spinner', () => {
    const loading = read('shared/ui/PhoenixLoadingState.tsx');
    expect(loading).toContain('PharmacyPulseLoader');
    expect(loading).not.toContain('nexus-loading__orbit');
    const css = read('shared/lib/phoenix-nexus.css');
    expect(css).toContain('.nexus-pulse__serpent');
    expect(css).toContain('animation: nexus-pulse-reveal .01s linear .3s forwards');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('html[data-page-hidden] .nexus-pulse *');
  });
});
