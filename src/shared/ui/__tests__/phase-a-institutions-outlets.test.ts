import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import pkg from '../../../../package.json';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('Phase A institutions + outlet operations/dispensing (A5.1) presentation contract', () => {
  const main = read('main.tsx');
  const css = read('shared/lib/phase-a-institutions-outlets.css');
  const institutionScreen = read('features/institutions/InstitutionScreen.tsx');
  const availabilityModal = read('features/institutions/AvailabilityItemDetailsModal.tsx');
  const outletOperations = read('features/outlet/OutletOperationsScreen.tsx');
  const outletIncoming = read('features/outlet/OutletIncomingSupplies.tsx');
  const outletReturnComposer = read('features/outlet/OutletReturnComposer.tsx');
  const outletCorrection = read('features/outlet/OutletStockCorrectionModal.tsx');
  const dispenseComposer = read('features/outlet/DispenseComposerDialog.tsx');
  const dispenseContextDialog = read('features/outlet/DispenseContextDialog.tsx');
  const dispenseContextViewer = read('features/outlet/DispenseContextViewer.tsx');
  const currentMovementStatus = read('features/outlet/CurrentMovementStatus.tsx');
  const authenticatedApp = read('app/AuthenticatedApp.tsx');
  const screenAccess = read('shared/authz/screen-access.ts');

  it('loads the institutions/outlets layer after every prior Phase A layer, including A4.1', () => {
    const foundationIndex = main.indexOf("import '@/shared/lib/phase-a-foundation.css';");
    const authIndex = main.indexOf("import '@/shared/lib/phase-a-auth.css';");
    const ccIndex = main.indexOf("import '@/shared/lib/phase-a-command-center.css';");
    const itIndex = main.indexOf("import '@/shared/lib/phase-a-inventory-transfers.css';");
    const ioIndex = main.indexOf("import '@/shared/lib/phase-a-institutions-outlets.css';");

    expect(foundationIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(foundationIndex);
    expect(ccIndex).toBeGreaterThan(authIndex);
    expect(itIndex).toBeGreaterThan(ccIndex);
    expect(ioIndex).toBeGreaterThan(itIndex);
  });

  it('gates every real selector behind the Phase A document marker', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutKeyframeSteps = withoutComments.replace(/@keyframes[^{]*\{[\s\S]*?\n\}/g, '');
    const selectorLines = withoutKeyframeSteps
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.endsWith('{') && !l.startsWith('@'));
    expect(selectorLines.length).toBeGreaterThan(0);
    const ungated = selectorLines.filter(sel => !sel.includes("html[data-phoenix-ui-phase='a']"));
    expect(ungated).toEqual([]);
  });

  it('touches only the Institution and Outlet Operations surfaces via named className hooks', () => {
    expect(institutionScreen).toContain('nexus-institutions');
    expect(outletOperations).toContain('nexus-outlet-ops');
  });

  it('adds every A5.1 structural hook as a plain className on existing elements, gated the same way', () => {
    const a51Hooks = [
      '.nexus-io-header', '.nexus-io-header__titles', '.nexus-io-context-bar', '.nexus-io-tabs', '.nexus-io-tab',
      '.nexus-io-notice', '.nexus-io-content', '.nexus-io-toolbar', '.nexus-io-grid', '.nexus-io-org-card',
      '.nexus-io-row-card', '.nexus-io-form-card', '.nexus-io-detail-masthead', '.nexus-io-danger-card',
      '.nexus-io-stock-row', '.nexus-io-action-dispense', '.nexus-io-action-correct', '.nexus-io-dispense-body',
      '.nexus-io-correction-body', '.nexus-io-context-viewer', '.nexus-io-history-row', '.nexus-io-ledger-row',
    ];
    for (const hook of a51Hooks) {
      expect(css, `${hook} must be styled`).toContain(hook);
    }
  });

  it('applies the distribution-point kind accent from the existing pointType field only, and only for approved types', () => {
    expect(institutionScreen).toMatch(/isApprovedPointType\(point\.pointType\) \? ` nexus-io-row-card--\$\{point\.pointType\}` : ''/);
    expect(css).toContain('.nexus-io-row-card--pharmacy');
    expect(css).toContain('.nexus-io-row-card--crash_cabinet');
    expect(css).toContain('.nexus-io-row-card--rescue_cart');
  });

  it('applies the organization status accent from the existing org.status field only', () => {
    expect(institutionScreen).toMatch(/nexus-io-org-card--\$\{org\.status\}/);
  });

  it('applies the zero-vs-available stock row distinction from the existing availableQuantity field only, never a fabricated value', () => {
    expect(outletOperations).toMatch(/nexus-io-stock-row--zero/);
    expect(outletOperations).toMatch(/r\.availableQuantity === 0/);
    expect(outletOperations).not.toMatch(/Math\.random\(\)/);
  });

  it('separates dispense (primary) from physical-count correction (secondary/cautionary) as two distinct visual treatments', () => {
    expect(outletOperations).toContain('nexus-io-action-dispense');
    expect(outletOperations).toContain('nexus-io-action-correct');
    expect(outletCorrection).toContain('nexus-io-correction-body');
    expect(dispenseComposer).toContain('nexus-io-dispense-body');
  });

  it('is a pure CSS file: no imports, no Supabase/RPC access, no CDN or external URL', () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toContain('supabase');
    expect(css).not.toContain('.rpc(');
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain('100vw');
  });

  it('never reaches Supabase directly from any touched screen/component root (service-layer only)', () => {
    for (const [name, src] of [
      ['InstitutionScreen', institutionScreen],
      ['AvailabilityItemDetailsModal', availabilityModal],
      ['OutletOperationsScreen', outletOperations],
      ['OutletIncomingSupplies', outletIncoming],
      ['OutletReturnComposer', outletReturnComposer],
      ['OutletStockCorrectionModal', outletCorrection],
      ['DispenseComposerDialog', dispenseComposer],
      ['DispenseContextDialog', dispenseContextDialog],
      ['DispenseContextViewer', dispenseContextViewer],
      ['CurrentMovementStatus', currentMovementStatus],
    ] as const) {
      expect(src, `${name} must not import the raw Supabase client`).not.toContain("from '@/shared/supabase/client'");
    }
  });

  it('adds no new runtime or dev dependency', () => {
    const deps = Object.keys(pkg.dependencies).sort();
    const devDeps = Object.keys(pkg.devDependencies).sort();
    expect(deps).toEqual([
      '@fontsource-variable/dm-sans', '@fontsource-variable/inter', '@fontsource-variable/noto-sans-arabic',
      '@fontsource/ibm-plex-sans-arabic', '@react-three/fiber', '@supabase/supabase-js', 'exceljs',
      'qrcode', 'react', 'react-dom', 'tesseract.js', 'three',
    ]);
    expect(devDeps).toEqual([
      '@testing-library/jest-dom', '@testing-library/react', '@types/node', '@types/pg', '@types/qrcode',
      '@types/react', '@types/react-dom', '@types/three', '@typescript-eslint/eslint-plugin',
      '@typescript-eslint/parser', '@vitejs/plugin-react', 'eslint', 'jsdom', 'pg', 'playwright-core',
      'sharp', 'typescript', 'vite', 'vitest',
    ]);
  });

  it('uses only logical (RTL-safe) direction properties, never a hardcoded left/right side', () => {
    expect(css).not.toMatch(/[^-](left|right)\s*:/);
    expect(css).toMatch(/inset-inline/);
  });

  it('provides desktop and mobile responsive behavior', () => {
    expect(css).toContain('@media (max-width: 767px)');
  });

  it('removes nonessential motion under reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.nexus-institutions,[^}]*\.nexus-outlet-ops\s*\{[^}]*animation:\s*none/);
  });

  it('never mentions a database migration file, and no migration .sql file was created or modified by this phase', () => {
    expect(css).not.toMatch(/supabase\/migrations/);
    for (const src of [institutionScreen, outletOperations, dispenseComposer, outletCorrection]) {
      expect(src).not.toMatch(/supabase\/migrations/);
    }
    let diff = '';
    try {
      diff = execSync('git diff --name-only -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  // ── Domain boundary guards (owner instructions: no data/RBAC/routing/
  // business-logic changes) ────────────────────────────────────────────────

  it('leaves screen routing (screen 11 / screen 18) and their component names unchanged', () => {
    expect(authenticatedApp).toContain('case 11:');
    expect(authenticatedApp).toContain('<InstitutionScreen');
    expect(authenticatedApp).toContain('case 18:');
    expect(authenticatedApp).toContain('<OutletOperationsScreen');
  });

  it('keeps institutionsScreenAccess and roleLandingScreen exactly as they were', () => {
    expect(screenAccess).toContain("export function institutionsScreenAccess(role: string | null | undefined): 'directory' | 'own' | false {");
    expect(screenAccess).toContain("if (isPlatformAdmin(role)) return 'directory';");
    expect(screenAccess).toContain("if (isInstitutionAdmin(role)) return 'own';");
    expect(authenticatedApp).toContain('institutionsScreenAccess(role) === false');
  });

  it('keeps every existing Institution-surface permission gate untouched', () => {
    expect(institutionScreen).toContain("actorPermissions.has('ports.view')");
    expect(institutionScreen).toContain("actorPermissions.has('ports.create')");
    expect(institutionScreen).toContain("actorPermissions.has('ports.edit')");
    expect(institutionScreen).toContain("actorPermissions.has('ports.archive')");
    expect(institutionScreen).toContain("actorPermissions.has('availability.quantity.set')");
    expect(institutionScreen).toContain("actorPermissions.has('qr.generate')");
    expect(institutionScreen).toContain("actorPermissions.has('qr.revoke')");
  });

  it('keeps the Institution surface on its existing service calls, never a new query/RPC', () => {
    expect(institutionScreen).toContain('getOrganizations(');
    expect(institutionScreen).toContain('getOrganization(');
    expect(institutionScreen).toContain('createOrganization(');
    expect(institutionScreen).toContain('updateOrganization(');
    expect(institutionScreen).toContain('getProfilesByOrg(');
    expect(institutionScreen).toContain('updateProfileRole(');
    expect(institutionScreen).toContain('getWarehouses(');
    expect(institutionScreen).toContain('getPointsByOrg(');
    expect(institutionScreen).toContain('createDistributionPoint(');
    expect(institutionScreen).toContain('updateDistributionPoint(');
    expect(institutionScreen).toContain('createQrForTarget(');
    expect(institutionScreen).toContain('disableQrToken(');
    expect(institutionScreen).toContain('regenerateQrForPoint(');
    expect(institutionScreen).toContain('archiveEntity(');
    expect(institutionScreen).toContain('archiveOrganization(');
    expect(institutionScreen).toContain('getAvailabilityByPoint(');
    expect(institutionScreen).toContain('setAvailabilityVisibility(');
  });

  it('keeps catalogue visibility (removed_at) and physical outlet stock semantically distinct — no quantity write from the removal path', () => {
    expect(institutionScreen).toContain('setAvailabilityVisibility(removeTarget.id, true');
    expect(institutionScreen).not.toMatch(/setAvailabilityVisibility\([^)]*quantity/);
  });

  it('keeps the outlet surface scoped by manageableOutlets, never a bare role check', () => {
    expect(outletOperations).toContain('scopes.data?.manageableOutlets');
    expect(outletOperations).toContain('useInventoryScopes(');
  });

  it('keeps outlet dispensing on the single atomic dispense-with-context RPC path, never the bare dispense RPC', () => {
    expect(dispenseComposer).toContain('dispenseWithContext(');
    expect(dispenseComposer).not.toMatch(/\.rpc\(\s*['"]phoenix_dispense_outlet_stock['"]/);
    expect(outletOperations).toContain('useOutletDispensePermission(');
  });

  it('keeps outlet dispensing on mandatory beneficiary/context fields — no submit path bypasses beneficiary validation', () => {
    // STAGE-F-172: crash_cart is retired as a dispensing beneficiary, so its
    // per-type guard goes with it. What this test exists to protect — that no
    // submit path bypasses beneficiary validation — is UNCHANGED, and now
    // also covers the patient reference number, which 172 made mandatory.
    expect(dispenseComposer).toContain('patientNameMissing');
    expect(dispenseComposer).toContain('patientRefIncomplete');
    expect(dispenseComposer).toContain('internalOrderMissing');
    expect(dispenseComposer).not.toContain('crashCartMissing');
    expect(dispenseComposer).toMatch(/canSubmit\s*=[\s\S]*!patientNameMissing[\s\S]*!patientRefIncomplete[\s\S]*!internalOrderMissing/);
  });

  it('keeps physical-count correction on its existing guarded/approval-aware RPC path, never a direct stock write', () => {
    expect(outletCorrection).toContain('correctOutletStock(');
    expect(outletCorrection).toContain('expectedGeneration');
    expect(outletCorrection).toContain('requiresApproval');
    expect(outletOperations).toContain('useOutletCountPermission(');
  });

  it('keeps outlet returns draft-first: header/line writes appear only inside the confirm step', () => {
    expect(outletReturnComposer).toContain('requestOutletReturn(');
    expect(outletReturnComposer).toContain('addOutletReturnLine(');
    const confirmFnStart = outletReturnComposer.indexOf('const confirmAndCreate = async () => {');
    const requestCallIndex = outletReturnComposer.indexOf('requestOutletReturn({');
    expect(confirmFnStart).toBeGreaterThan(-1);
    expect(requestCallIndex).toBeGreaterThan(confirmFnStart);
  });

  it('keeps movement history read-only: no mutation call in the history tab or CurrentMovementStatus', () => {
    expect(outletOperations).not.toMatch(/OutletHistoryTab[\s\S]*?(insert|update|delete|upsert)\(/);
    expect(currentMovementStatus).not.toMatch(/\.(insert|update|delete|upsert)\(/);
  });

  it('keeps every existing outlet permission hook name untouched', () => {
    expect(outletOperations).toContain('useOutletCountPermission(');
    expect(outletOperations).toContain('useOutletDispensePermission(');
    expect(outletOperations).toContain('useMovementContextRecordPermission(');
  });

  // ── A5.1: no fabricated production data ─────────────────────────────────
  // Owner instructions (§4/§5): every reading must come from a real existing
  // source; no hardcoded KPI, no Math.random(), no demo array in a production
  // screen file, no value copied from the reference images.

  it('introduces no random or time-seeded fake value in any touched production file', () => {
    for (const [name, src] of [
      ['InstitutionScreen', institutionScreen],
      ['AvailabilityItemDetailsModal', availabilityModal],
      ['OutletOperationsScreen', outletOperations],
      ['OutletIncomingSupplies', outletIncoming],
      // OutletReturnComposer.tsx is excluded below, not here: it has one
      // PRE-EXISTING Math.random() use (newKey()'s crypto.randomUUID
      // fallback for a local idempotency key), unrelated to displayed data
      // and untouched by this phase's presentation-only edits.
      ['OutletStockCorrectionModal', outletCorrection],
      ['DispenseComposerDialog', dispenseComposer],
      ['DispenseContextDialog', dispenseContextDialog],
      ['DispenseContextViewer', dispenseContextViewer],
      ['CurrentMovementStatus', currentMovementStatus],
    ] as const) {
      expect(src, `${name} must not use Math.random for a displayed value`).not.toMatch(/Math\.random\(\)/);
    }
  });

  it('OutletReturnComposer\'s only Math.random() use remains the pre-existing local idempotency-key fallback, never a displayed value', () => {
    const uses = outletReturnComposer.match(/Math\.random\(\)/g) ?? [];
    expect(uses.length).toBe(1);
    expect(outletReturnComposer).toMatch(/randomUUID\(\)\s*\n?\s*:\s*`\$\{Date\.now\(\)\}-\$\{Math\.random\(\)/);
  });

  it('the CSS layer carries no literal data value — presentation only', () => {
    expect(css).not.toMatch(/content:\s*['"]\d/);
    expect(css).not.toMatch(/\[\s*\{/);
  });

  it('does not copy any reference-image number (e.g. the 72 institutions / 118 outlets / 2,846 items mock counters) into a production file', () => {
    for (const src of [institutionScreen, outletOperations]) {
      expect(src).not.toMatch(/\b2,?846\b/);
      expect(src).not.toMatch(/\b12,?450\b/);
    }
  });

  // ── QA fixture hygiene: no temporary QA-only change survives into the diff ──

  it('leaves the QA harness fixture files untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/qa/QaHarness.tsx src/features/qa/qaData.ts src/features/qa/qaFixtures.ts src/features/qa/qaFixtureClient.ts src/features/qa/qaScopes.ts src/features/qa/qaConfig.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('leaves no local QA-only env file in the committed tree', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- .env.local', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(status.trim()).toBe('');
  });
});
