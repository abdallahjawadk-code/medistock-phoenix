/**
 * PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A
 * Run: npm test -- --run status
 *
 * Static source-code tests for the user-entered price column + filter added
 * to Status Center, and the matching "Entered Price" column added to the
 * professional XLSX availability export. The price is the EXISTING
 * availability `price` field already entered by the user in the Availability/
 * Status Editor — never calculated, inferred, or overwritten here.
 *
 * No live DB is used — these are static source-code assertions, matching
 * this repo's established test conventions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../');
const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/status/StatusCenterScreen.tsx');
const exportModule = readSrc('shared/lib/professional-export.ts');
const strings = readSrc('shared/i18n/strings.ts');

function extractFunction(src: string, marker: string, endMarker: string): string {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const rowsFn = extractFunction(screen, 'const rows = useMemo(', 'const counts = useMemo(');
const exportFn = extractFunction(screen, 'async function exportXlsx', 'function handleMovementSuccess');

describe('A) getAvailabilityByOrg price availability preserved', () => {
  it('the availability service already selects price (no change needed/made here)', () => {
    const service = readSrc('shared/supabase/services/availability.service.ts');
    const fnStart = service.indexOf('export async function getAvailabilityByOrg');
    const body = service.slice(fnStart, fnStart + 1400);
    expect(body).toMatch(/\bprice\b/);
  });
});

describe('B) Status Center displays Entered Price / السعر المدخل', () => {
  it('the shared column list (print/HTML export) includes an Entered Price column right after Quantity', () => {
    const colsBlock = screen.slice(screen.indexOf("const columns: { key: string"), screen.indexOf('];', screen.indexOf("const columns: { key: string")));
    const qtyIdx = colsBlock.indexOf("key: 'qty'");
    const priceIdx = colsBlock.indexOf("key: 'price'");
    const supplyIdx = colsBlock.indexOf("key: 'supply'");
    expect(qtyIdx).toBeGreaterThan(-1);
    expect(priceIdx).toBeGreaterThan(qtyIdx);
    expect(priceIdx).toBeLessThan(supplyIdx);
    expect(colsBlock).toContain("t('sc_entered_price', lang)");
  });

  it('the on-screen table has an Entered Price header cell and a priceDisplay(r.price) body cell', () => {
    expect(screen).toContain("<th style={th}>{t('sc_entered_price', lang)}</th>");
    expect(screen).toContain('{priceDisplay(r.price)}');
  });

  it('priceDisplay uses row.price only — never calculates/infers/overwrites it', () => {
    const fn = extractFunction(screen, 'function priceDisplay', '}\n');
    expect(fn).toContain('price');
    expect(fn).not.toMatch(/quantity\s*\*|price\s*=\s*r\.quantity/);
  });

  it('priceDisplay shows "—" for null/undefined/0, and a 2-decimal value otherwise (documented display choice)', () => {
    const fn = extractFunction(screen, 'function priceDisplay', '}\n');
    expect(fn).toMatch(/price\s*<=\s*0/);
    expect(fn).toContain('toFixed(2)');
  });

  it('sc_entered_price i18n key exists bilingually with the exact required labels', () => {
    expect(strings).toMatch(/sc_entered_price:\s*\{\s*ar:\s*'السعر المدخل',\s*en:\s*'Entered Price'/);
  });
});

describe('C) Price filter UI: all six required modes exist', () => {
  it('PriceFilterMode type declares all six required literal modes', () => {
    const typeBlock = screen.slice(screen.indexOf('type PriceFilterMode ='), screen.indexOf(';', screen.indexOf('type PriceFilterMode =')));
    for (const mode of ['all', 'no_entered_price', 'has_entered_price', 'entered_price_less_than', 'entered_price_greater_than', 'entered_price_between']) {
      expect(typeBlock).toContain(`'${mode}'`);
    }
  });

  it('the filter <select> renders an <option> for every required mode', () => {
    const selectBlock = screen.slice(screen.indexOf('value={priceFilterMode}'), screen.indexOf('</select>', screen.indexOf('value={priceFilterMode}')));
    for (const mode of ['all', 'no_entered_price', 'has_entered_price', 'entered_price_less_than', 'entered_price_greater_than', 'entered_price_between']) {
      expect(selectBlock).toContain(`value="${mode}"`);
    }
  });

  it('price filter mode labels exist bilingually', () => {
    for (const key of [
      'sc_price_filter_label', 'sc_price_filter_all', 'sc_price_filter_no_entered',
      'sc_price_filter_has_entered', 'sc_price_filter_less_than', 'sc_price_filter_greater_than',
      'sc_price_filter_between',
    ]) {
      expect(strings).toMatch(new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
    }
  });
});

describe('D) Price filter logic: no_entered_price / has_entered_price', () => {
  it('no_entered_price includes price null/0 and excludes price > 0 (negation of "has a positive price")', () => {
    expect(rowsFn).toMatch(/priceFilterMode === 'no_entered_price'/);
    const idx = rowsFn.indexOf("priceFilterMode === 'no_entered_price'");
    const block = rowsFn.slice(idx, idx + 200);
    expect(block).toMatch(/!\(typeof r\.price === 'number' && r\.price > 0\)/);
  });

  it('has_entered_price includes only price > 0, excluding null/undefined/0', () => {
    expect(rowsFn).toMatch(/priceFilterMode === 'has_entered_price'/);
    const idx = rowsFn.indexOf("priceFilterMode === 'has_entered_price'");
    const block = rowsFn.slice(idx, idx + 200);
    expect(block).toMatch(/typeof r\.price === 'number' && r\.price > 0/);
  });
});

describe('E) Price filter logic: less_than / greater_than / between', () => {
  it('entered_price_less_than filters price < threshold, parsed via parsePriceInput', () => {
    const idx = rowsFn.indexOf("priceFilterMode === 'entered_price_less_than'");
    expect(idx).toBeGreaterThan(-1);
    const block = rowsFn.slice(idx, idx + 500);
    expect(block).toContain('parsePriceInput(priceValue)');
    expect(block).toMatch(/r\.price < threshold/);
  });

  it('entered_price_greater_than filters price > threshold, parsed via parsePriceInput', () => {
    const idx = rowsFn.indexOf("priceFilterMode === 'entered_price_greater_than'");
    expect(idx).toBeGreaterThan(-1);
    const block = rowsFn.slice(idx, idx + 300);
    expect(block).toContain('parsePriceInput(priceValue)');
    expect(block).toMatch(/r\.price > threshold/);
  });

  it('entered_price_between filters min <= price <= max', () => {
    const idx = rowsFn.indexOf("priceFilterMode === 'entered_price_between'");
    expect(idx).toBeGreaterThan(-1);
    const block = rowsFn.slice(idx, idx + 900);
    expect(block).toMatch(/r\.price >= min && r\.price <= max/);
  });
});

describe('F) Price filter validation: invalid/negative values and min > max are handled safely (never crash)', () => {
  it('parsePriceInput rejects non-numeric and negative values, returning null (never throws)', () => {
    const fn = extractFunction(screen, 'function parsePriceInput', '}\n');
    expect(fn).toContain('Number.isFinite(n)');
    expect(fn).toMatch(/n\s*<\s*0/);
    expect(fn).not.toContain('throw');
  });

  it('entered_price_between requires both min and max, and safely returns NO ROWS (not a crash) when either is missing/invalid or min > max', () => {
    const idx = rowsFn.indexOf("priceFilterMode === 'entered_price_between'");
    const block = rowsFn.slice(idx, idx + 900);
    expect(block).toMatch(/min === null \|\| max === null \|\| min > max/);
    expect(block).toContain('list = [];');
  });

  it('a single-value threshold (less_than/greater_than) with an invalid/empty input leaves the filter inactive rather than crashing', () => {
    const idx = rowsFn.indexOf("priceFilterMode === 'entered_price_less_than'");
    const block = rowsFn.slice(idx, idx + 500);
    expect(block).toMatch(/if \(threshold !== null\)/);
  });

  it('inline validation hints (priceValueInvalid/priceRangeInvalid) are rendered near the filter UI', () => {
    expect(screen).toContain('priceValueInvalid');
    expect(screen).toContain('priceRangeInvalid');
    expect(screen).toContain("t('sc_price_invalid', lang)");
    expect(screen).toContain("t('sc_price_range_invalid', lang)");
  });
});

describe('G) Price filter combines with existing filters using AND logic', () => {
  it('the price filter block runs inside the same rows useMemo as status/supply/search/quantity/smart filters, after all of them', () => {
    const statusIdx = rowsFn.indexOf('if (filterStatus)');
    const supplyIdx = rowsFn.indexOf('if (filterSupply)');
    const quantityIdx = rowsFn.indexOf("quantityFilter === 'has_quantity'");
    const searchIdx = rowsFn.indexOf('if (search.trim())');
    const priceIdx = rowsFn.indexOf("priceFilterMode === 'no_entered_price'");
    expect(statusIdx).toBeGreaterThan(-1);
    expect(supplyIdx).toBeGreaterThan(statusIdx);
    expect(quantityIdx).toBeGreaterThan(supplyIdx);
    expect(searchIdx).toBeGreaterThan(quantityIdx);
    expect(priceIdx).toBeGreaterThan(searchIdx);
  });

  it('the rows useMemo dependency array includes the new price filter state alongside every pre-existing filter', () => {
    const depsIdx = rowsFn.indexOf('}, [allRows,');
    expect(depsIdx).toBeGreaterThan(-1);
    const deps = rowsFn.slice(depsIdx, rowsFn.indexOf(');', depsIdx));
    for (const dep of ['filterStatus', 'filterSupply', 'search', 'quantityFilter', 'recentOnly', 'priceFilterMode', 'priceValue', 'priceMin', 'priceMax']) {
      expect(deps).toContain(dep);
    }
  });

  it('every price-filter branch narrows `list` (re-filters the already-filtered list), never resets it to allRows', () => {
    const priceSectionIdx = rowsFn.indexOf("priceFilterMode === 'no_entered_price'");
    const priceSection = rowsFn.slice(priceSectionIdx);
    expect(priceSection).not.toContain('list = allRows');
  });
});

describe('H) XLSX export includes Entered Price / السعر المدخل', () => {
  it('AVAIL_EXPORT_HEADERS.enteredPrice is the exact required bilingual label', () => {
    expect(exportModule).toContain("enteredPrice:  'Entered Price / السعر المدخل'");
  });

  it('the Entered Price column is placed right after Quantity and before Condition', () => {
    const colsBlock = exportModule.slice(exportModule.indexOf('const AVAIL_EXPORT_COLUMNS'), exportModule.indexOf('function availExportCellValue'));
    const qtyIdx = colsBlock.indexOf("key: 'quantity'");
    const priceIdx = colsBlock.indexOf("key: 'enteredPrice'");
    const condIdx = colsBlock.indexOf("key: 'condition'");
    expect(qtyIdx).toBeGreaterThan(-1);
    expect(priceIdx).toBeGreaterThan(qtyIdx);
    expect(priceIdx).toBeLessThan(condIdx);
  });

  it('enteredPrice is formatted with a 2-decimal numFmt only when the cell holds a real number', () => {
    expect(exportModule).toContain("col.kind === 'price' && typeof cell.value === 'number'");
    expect(exportModule).toContain("cell.numFmt = '0.00'");
  });

  it('a null/undefined enteredPrice exports as blank "—", never calculated/inferred, never crashes', () => {
    const idx = exportModule.indexOf("case 'enteredPrice':");
    const line = exportModule.slice(idx, exportModule.indexOf('\n', idx));
    expect(line).toContain("'—'");
    expect(line).toMatch(/typeof row\.enteredPrice === 'number'/);
  });
});

describe('I) XLSX Data Dictionary includes Entered Price / السعر المدخل', () => {
  it('AVAIL_EXPORT_DICTIONARY has an entry for AVAIL_EXPORT_HEADERS.enteredPrice', () => {
    const dictBlock = exportModule.slice(exportModule.indexOf('const AVAIL_EXPORT_DICTIONARY'), exportModule.indexOf('const AVAIL_CONDITION_STYLE'));
    expect(dictBlock).toContain('AVAIL_EXPORT_HEADERS.enteredPrice');
    expect(dictBlock).toMatch(/user-entered price/i);
  });
});

describe('J) XLSX export uses currently filtered rows and respects the price filter', () => {
  it('exportXlsx builds exportRows from `rows` (the fully filtered list), not `allRows`', () => {
    expect(exportFn).toMatch(/const exportRows: AvailabilityExportRow\[\] = rows\s*\n\s*\.filter\(r => r\.removed_at == null\)/);
    expect(exportFn).not.toContain('allRows');
  });

  it('exportXlsx maps enteredPrice from the same row.price used for the on-screen column (no separate calculation)', () => {
    expect(exportFn).toMatch(/enteredPrice:\s*typeof r\.price === 'number' \? r\.price : null/);
  });
});

describe('K) XLSX still excludes removed_at rows and keeps genuine missing rows', () => {
  it('exportXlsx still filters r.removed_at == null before building export rows', () => {
    expect(exportFn).toMatch(/\.filter\(r => r\.removed_at == null\)/);
  });

  it('exportXlsx does not additionally exclude condition === missing (genuine shortages with removed_at null remain exportable if they match active filters)', () => {
    expect(exportFn).not.toMatch(/condition === 'missing'/);
  });
});

describe('L) No sensitive fields exported', () => {
  it('exportXlsx never exports raw ids/removed_by/auth ids/org or distribution point ids — only display fields plus the new enteredPrice', () => {
    expect(exportFn).not.toMatch(/\bremoved_by\b/);
    expect(exportFn).not.toMatch(/\bid:\s*r\.id\b/);
    expect(exportFn).not.toMatch(/organization_id|distribution_point_id/);
  });

  it('AvailabilityExportRow/AVAIL_EXPORT_COLUMNS still carry no id/uuid/removed_by/org-id-like keys after the enteredPrice addition', () => {
    const rowType = exportModule.slice(exportModule.indexOf('export interface AvailabilityExportRow'), exportModule.indexOf('export interface AvailabilityExportConfig'));
    expect(rowType).not.toMatch(/\bid:\s*string/);
    expect(rowType).not.toMatch(/removed_by/);
    expect(rowType).not.toMatch(/organization_id|distribution_point_id/);
  });
});

describe('M) Safety: no SQL/migration/package changes; dashboard RPC switch untouched; unrelated screens untouched', () => {
  it('no migration SQL file was created or modified', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    const matches = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.startsWith('055_'));
    expect(matches).toEqual(['055_phoenix_clean_availability_data.sql']);
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('dashboard.service.ts (the migration-054 RPC switch) is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/dashboard.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no QR/alerts/movement-history/auth/permissions/navigation file changed', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/qr.service.ts src/features/qr/PublicQrScreen.tsx ' +
        'src/features/alerts/inter-org-alert-lifecycle.service.ts src/features/status/MovementHistoryModal.tsx ' +
        'src/features/status/MovementReportSection.tsx src/shared/supabase/services/auth.service.ts ' +
        'src/app/AppContext.tsx src/shared/lib/permissions.ts src/app/App.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no RLS/permission/auth SQL keywords introduced anywhere in the touched files', () => {
    expect(screen).not.toMatch(/CREATE POLICY|DROP POLICY|GRANT |REVOKE /);
    expect(exportModule).not.toMatch(/CREATE POLICY|DROP POLICY|GRANT |REVOKE /);
  });

  it('premium-preview.html remains untracked (only "??" status if present)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});
