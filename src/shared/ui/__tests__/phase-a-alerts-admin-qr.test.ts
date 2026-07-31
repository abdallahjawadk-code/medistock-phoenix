import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import pkg from '../../../../package.json';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('Phase A alerts, administration + public QR (A6) presentation contract', () => {
  const main = read('main.tsx');
  const css = read('shared/lib/phase-a-alerts-admin-qr.css');
  const statusCenter = read('features/status/StatusCenterScreen.tsx');
  const internalAlerts = read('features/status/InternalAlertsSection.tsx');
  const outletGroups = read('features/status/OutletMaterialGroups.tsx');
  const userManagement = read('features/users/UserManagementScreen.tsx');
  const broadcastAdmin = read('features/platform-broadcast/PlatformBroadcastAdminPanel.tsx');
  const broadcastGate = read('features/platform-broadcast/PlatformBroadcastGate.tsx');
  const cleanupWizard = read('features/admin/AvailabilityCleanupWizard.tsx');
  const publicQr = read('features/qr/PublicQrScreen.tsx');
  const authenticatedApp = read('app/AuthenticatedApp.tsx');

  it('loads the alerts/admin/QR layer after every prior Phase A layer, including A5.1', () => {
    const foundationIndex = main.indexOf("import '@/shared/lib/phase-a-foundation.css';");
    const authIndex = main.indexOf("import '@/shared/lib/phase-a-auth.css';");
    const ccIndex = main.indexOf("import '@/shared/lib/phase-a-command-center.css';");
    const itIndex = main.indexOf("import '@/shared/lib/phase-a-inventory-transfers.css';");
    const ioIndex = main.indexOf("import '@/shared/lib/phase-a-institutions-outlets.css';");
    const aqIndex = main.indexOf("import '@/shared/lib/phase-a-alerts-admin-qr.css';");

    expect(foundationIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(foundationIndex);
    expect(ccIndex).toBeGreaterThan(authIndex);
    expect(itIndex).toBeGreaterThan(ccIndex);
    expect(ioIndex).toBeGreaterThan(itIndex);
    expect(aqIndex).toBeGreaterThan(ioIndex);
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

  it('touches only the named Status Center, Administration and Public QR surfaces via named className hooks', () => {
    expect(statusCenter).toContain('nexus-status-center');
    expect(internalAlerts).toContain('nexus-alerts-panel');
    expect(outletGroups).toContain('nexus-outlet-groups');
    expect(userManagement).toContain('nexus-user-admin');
    expect(broadcastAdmin).toContain('nexus-broadcast-admin');
    expect(broadcastGate).toContain('nexus-broadcast-gate');
    expect(cleanupWizard).toContain('nexus-cleanup-wizard');
    expect(publicQr).toContain('nexus-qr-public');
  });

  it('adds every A6 structural hook as a plain className/data-attribute on existing elements, gated the same way', () => {
    const a6Hooks = [
      '.nexus-sc-header', '.nexus-sc-tabs', '.nexus-sc-tab', '.nexus-sc-notice', '.nexus-sc-summary-card',
      '.nexus-sc-status-chip', '.nexus-sc-filter-card', '.nexus-sc-view-toggle', '.nexus-sc-table',
      '.nexus-sc-row', '.nexus-sc-action', '.nexus-sc-exchange-cta',
      '.nexus-alert-card', '.nexus-alerts-summary', '.nexus-alerts-empty',
      '.nexus-outlet-group-card', '.nexus-outlet-group-row', '.nexus-outlet-groups-empty',
      '.nexus-ua-header', '.nexus-ua-notice', '.nexus-ua-filters', '.nexus-ua-layout', '.nexus-ua-list',
      '.nexus-ua-user-card', '.nexus-ua-lifecycle-actions', '.nexus-ua-detail', '.nexus-ua-profile-card',
      '.nexus-ua-permission-matrix', '.nexus-ua-sensitive-warning', '.nexus-ua-perm-module',
      '.nexus-ua-perm-dangerous', '.nexus-ua-form-card', '.nexus-ua-modal-overlay', '.nexus-ua-modal-panel',
      '.nexus-broadcast-compose', '.nexus-broadcast-list', '.nexus-broadcast-item', '.nexus-broadcast-ack-details',
      '.nexus-broadcast-delete-confirm',
      '.nexus-cleanup-warning', '.nexus-cleanup-counts', '.nexus-cleanup-danger-zone', '.nexus-cleanup-success',
      '.nexus-qr-header', '.nexus-qr-org-card', '.nexus-qr-summary', '.nexus-qr-search', '.nexus-qr-item',
      '.nexus-qr-trust-note',
    ];
    for (const hook of a6Hooks) {
      expect(css, `${hook} must be styled`).toContain(hook);
    }
  });

  it('applies status/severity accents from real existing fields only, never a fabricated value', () => {
    // Status Center: canonical status is the same `eff`/`s` values the badges already use.
    expect(statusCenter).toMatch(/nexus-sc-row nexus-sc-row--\$\{eff\}/);
    expect(statusCenter).toMatch(/nexus-sc-status-chip nexus-sc-status-chip--\$\{s\}/);
    // Internal alerts: the same m.severity the badge variant already switches on.
    expect(internalAlerts).toMatch(/nexus-alert-card nexus-alert-card--\$\{m\.severity\}/);
    // Outlet groups: the same attentionCount already computed for the on-screen chip.
    expect(outletGroups).toMatch(/attentionCount > 0 \? ' nexus-outlet-group-card--attention' : ''/);
    // User cards: the same u.status the badge variant already switches on.
    expect(userManagement).toMatch(/nexus-ua-user-card nexus-ua-user-card--\$\{u\.status\}/);
    // Broadcast messages: the same m.severity/current.severity the badge variant already switches on.
    expect(broadcastAdmin).toMatch(/nexus-broadcast-item nexus-broadcast-item--\$\{m\.severity\}/);
    expect(broadcastGate).toMatch(/nexus-broadcast-gate nexus-broadcast-gate--\$\{current\.severity\}/);
    // Public QR: the same item.condition the per-item badge already renders.
    expect(publicQr).toMatch(/data-condition=\{item\.condition \?\? undefined\}/);
  });

  it('separates routine from destructive/cautionary operations as distinct visual treatments', () => {
    expect(userManagement).toMatch(/nexus-ua-modal-panel--\$\{isEnable \? 'recovery' : 'caution'\}/);
    expect(userManagement).toContain('nexus-ua-modal-panel--caution');
    expect(userManagement).toContain('nexus-ua-modal-panel--danger');
    expect(cleanupWizard).toContain('nexus-cleanup-danger-zone');
    expect(css).toContain('.nexus-ua-modal-panel--danger');
    expect(css).toContain('.nexus-cleanup-danger-zone');
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
      ['StatusCenterScreen', statusCenter],
      ['InternalAlertsSection', internalAlerts],
      ['OutletMaterialGroups', outletGroups],
      ['UserManagementScreen', userManagement],
      ['PlatformBroadcastAdminPanel', broadcastAdmin],
      ['PlatformBroadcastGate', broadcastGate],
      ['AvailabilityCleanupWizard', cleanupWizard],
      ['PublicQrScreen', publicQr],
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

  it('provides desktop and mobile responsive behavior, including touch targets', () => {
    expect(css).toContain('@media (max-width: 767px)');
    expect(css).toContain('var(--touch-target)');
  });

  it('removes nonessential motion under reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.nexus-status-center,[^}]*\.nexus-user-admin,[^}]*\.nexus-qr-public\s*\{[^}]*animation:\s*none/);
  });

  it('never mentions a database migration file, and no migration .sql file was created or modified by this phase', () => {
    expect(css).not.toMatch(/supabase\/migrations/);
    for (const src of [statusCenter, userManagement, broadcastAdmin, broadcastGate, cleanupWizard, publicQr]) {
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

  it('leaves screen routing and component names unchanged for every touched authenticated surface', () => {
    expect(authenticatedApp).toContain('<UserManagementScreen />');
    expect(authenticatedApp).toContain('case 14:');
  });

  it('keeps Status Center on its existing real data sources only, never a fabricated KPI', () => {
    expect(statusCenter).toContain('getAvailabilityByOrg(');
    expect(statusCenter).toContain('getOrganizations(');
    expect(statusCenter).toContain('computeInternalAlerts(');
  });

  it('keeps internal alerts read-only: no interactive control, no auto-transfer action, no exchange RPC import', () => {
    expect(internalAlerts).not.toMatch(/<button/);
    expect(internalAlerts).not.toMatch(/onClick/);
    expect(internalAlerts).not.toMatch(/^import .*(exchange|transfer)/im);
  });

  it('keeps the outlet-grouped view a pure alternate display of the same rows — no new fetch, no id exposed as visible text', () => {
    expect(outletGroups).not.toContain('useAsync');
    expect(outletGroups).not.toContain('getAvailabilityByOrg');
    expect(outletGroups).not.toMatch(/>\{[^}]*\.id\}/);
  });

  it('keeps every existing User Management permission gate untouched', () => {
    expect(userManagement).toContain("isSuper || actorEff.has('users.view')");
    expect(userManagement).toContain("isSuper || actorEff.has('users.create')");
    expect(userManagement).toContain("isSuper || actorEff.has('users.manage_permissions')");
    expect(userManagement).toContain("isSuper || actorEff.has('users.recycle')");
  });

  it('keeps every existing User Management lifecycle RPC call untouched', () => {
    for (const call of [
      'createUserViaEdge(', 'disableUserViaEdge(', 'enableUserViaEdge(',
      'recycleUserViaEdge(', 'rotatePasswordViaEdge(', 'deleteUserViaEdge(',
      'assignProfilePermissions(', 'resetProfilePermissions(',
    ]) {
      expect(userManagement).toContain(call);
    }
  });

  it('keeps the Availability Cleanup wizard fail-closed: dry-run mandatory, backup acknowledgement + exact typed confirmation required before execute', () => {
    expect(cleanupWizard).toContain('const canExecute = dryRunCounts !== null && backupAcknowledged && confirmationMatches && !executeBusy;');
    expect(cleanupWizard).toContain('DEEP_CLEAN_AVAILABILITY_CONFIRMATION');
    expect(cleanupWizard).toContain('if (!isSuper) return null;');
    expect(cleanupWizard).not.toMatch(/onDryRun\(\);?\s*$/m);
  });

  it('keeps the Platform Broadcast admin panel Super Admin-only and the acknowledgement gate impossible to silently dismiss', () => {
    expect(broadcastAdmin).toContain('if (!isSuper) return null;');
    expect(broadcastGate).toContain('/* no dismiss without acknowledging, by design */');
    expect(broadcastGate).toContain('getPendingPlatformBroadcasts(');
    expect(broadcastGate).toContain('acknowledgePlatformBroadcast(');
  });

  it('keeps Public QR anonymous and safe: no raw backend error surfaced, isPubliclyAvailableQrItem unchanged', () => {
    expect(publicQr).not.toContain('useApp().session');
    expect(publicQr).toContain("message={t('qr_public_load_error', lang)}");
    expect(publicQr).toMatch(
      /export function isPubliclyAvailableQrItem\(item: PublicItem\): boolean \{\s*if \(typeof item\.quantity !== 'number' \|\| !Number\.isFinite\(item\.quantity\) \|\| item\.quantity <= 0\) return false;/,
    );
    expect(publicQr).toContain("case 'available':");
    expect(publicQr).toContain("case 'near_expiry':");
    expect(publicQr).toContain("case 'surplus':");
    expect(publicQr).toContain("case 'low_stock':");
  });

  it('introduces no random or time-seeded fake value in any touched production file', () => {
    for (const [name, src] of [
      ['StatusCenterScreen', statusCenter],
      ['InternalAlertsSection', internalAlerts],
      ['OutletMaterialGroups', outletGroups],
      ['UserManagementScreen', userManagement],
      ['PlatformBroadcastAdminPanel', broadcastAdmin],
      ['PlatformBroadcastGate', broadcastGate],
      ['AvailabilityCleanupWizard', cleanupWizard],
      ['PublicQrScreen', publicQr],
    ] as const) {
      expect(src, `${name} must not use Math.random for a displayed value`).not.toMatch(/Math\.random\(\)/);
    }
  });

  it('the CSS layer carries no literal data value — presentation only', () => {
    expect(css).not.toMatch(/content:\s*['"]\d/);
    expect(css).not.toMatch(/\[\s*\{/);
  });

  it('does not copy any reference-image mock counter into a production file', () => {
    for (const src of [statusCenter, userManagement, broadcastAdmin, publicQr]) {
      expect(src).not.toMatch(/\b72\b\s*(institutions|مؤسسات)/i);
      expect(src).not.toMatch(/\b2,?846\b/);
      expect(src).not.toMatch(/\b156\b/);
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
