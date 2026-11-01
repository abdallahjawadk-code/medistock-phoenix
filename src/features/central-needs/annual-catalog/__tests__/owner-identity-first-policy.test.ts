import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract checks only: do not treat them as live E2E, RLS or SQL evidence.
const fromAnnual = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
const fromManual = (path: string) => readFileSync(join(__dirname, '..', '..', 'manual', path), 'utf8');
const fromAllocation = (path: string) => readFileSync(join(__dirname, '..', '..', 'allocation', path), 'utf8');

const annual = fromAnnual('AnnualNeedsWorkspace.tsx');
const source = fromAnnual('annual-catalog-source.ts');
const journey = fromManual('ManualNeedsJourney.tsx');
const i18n = fromManual('manual-needs.i18n.ts');
const allocation = fromAllocation('conservative-policy.ts');

describe('owner identity-first annual needs workflow (source-level invariants)', () => {
  it('explicitly tells annual operators that original workbook quantities are not automatic annual needs', () => {
    expect(annual).toContain('data-testid="annual-identity-first-policy"');
    expect(annual).toContain("mt('annualIdentityFirstPolicy', lang)");
    expect(i18n).toContain('annualIdentityFirstPolicy:');
    expect(i18n).toContain('أدخل الاحتياج السنوي يدويًا');
    expect(i18n).toContain('Excel quantities are never auto-approved as annual needs');
  });

  it('keeps the new annual workspace connected to manual quantity entry and explicit beneficiary selection', () => {
    expect(annual).toContain('className="prism-annual-beneficiary"');
    expect(annual).toContain('<AnnualCatalogPicker');
    expect(annual).toContain('<ManualNeedsWorkspace');
    expect(annual).toContain('annualMode annualEntryEnabled');
    expect(journey).toContain("annualMode === 'annual' ? <AnnualNeedsWorkspace");
  });

  it('keeps the legacy workbook quantity-import workflow outside annual catalog mode', () => {
    expect(journey).toContain("annualMode === 'legacy' && <div className=\"prism-source-intake\">");
    expect(journey).toContain('<DossierWorkbookIntake');
    expect(journey).toContain("annualMode === 'annual' ? <AnnualNeedsWorkspace");
  });

  it('keeps annual source extraction identity-only and separate from quantity writers', () => {
    expect(source).toContain('Pure, bounded identity adapter. No quantities, RPCs');
    expect(source).toContain('Quantity and institution values are never read.');
    expect(source).toContain('extractAnnualIdentityBlock(');
    expect(source).not.toContain('addAnnualNeedLine(');
    expect(source).not.toContain('correctAnnualNeedLine(');
    expect(source).not.toContain('captureDossierWorkbook(');
  });

  it('keeps monthly allocation a pure proposal, never an implicit stock or allocation write', () => {
    expect(allocation).toContain('proposeEqualMonthlyQuantities(');
    expect(allocation).toContain('These functions never authorize, approve, persist or move stock.');
    expect(allocation).not.toContain('supabase.rpc(');
  });
});
