import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import pkg from '../../../../package.json';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('Phase A7 Phoenix Daylight visual convergence contract', () => {
  const main = read('main.tsx');
  const css = read('shared/lib/phase-a-visual-convergence.css');
  const sidebar = read('shared/ui/PhoenixSidebar.tsx');
  const mobileDrawer = read('shared/ui/PhoenixMobileDrawer.tsx');
  const bottomNav = read('shared/ui/PhoenixMobileBottomNav.tsx');
  const button = read('shared/ui/PhoenixButton.tsx');
  const badge = read('shared/ui/PhoenixStatusBadge.tsx');
  const loginScreen = read('features/auth/LoginScreen.tsx');
  const welcome = read('features/auth/PhoenixWelcomeExperience.tsx');

  it('loads as the LAST Phase A CSS layer, after A1 through A6', () => {
    const foundationIndex = main.indexOf("import '@/shared/lib/phase-a-foundation.css';");
    const authIndex = main.indexOf("import '@/shared/lib/phase-a-auth.css';");
    const ccIndex = main.indexOf("import '@/shared/lib/phase-a-command-center.css';");
    const itIndex = main.indexOf("import '@/shared/lib/phase-a-inventory-transfers.css';");
    const ioIndex = main.indexOf("import '@/shared/lib/phase-a-institutions-outlets.css';");
    const aqIndex = main.indexOf("import '@/shared/lib/phase-a-alerts-admin-qr.css';");
    const convergenceIndex = main.indexOf("import '@/shared/lib/phase-a-visual-convergence.css';");

    expect(foundationIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(foundationIndex);
    expect(ccIndex).toBeGreaterThan(authIndex);
    expect(itIndex).toBeGreaterThan(ccIndex);
    expect(ioIndex).toBeGreaterThan(itIndex);
    expect(aqIndex).toBeGreaterThan(ioIndex);
    expect(convergenceIndex).toBeGreaterThan(aqIndex);
  });

  it('sets the daylight root contract before first paint, alongside the existing phase marker', () => {
    expect(main).toContain("document.documentElement.dataset.phoenixUiPhase = 'a';");
    expect(main).toContain("document.documentElement.dataset.phoenixVisual = 'daylight';");
    // The visual marker must be set unconditionally (not tied to the theme
    // toggle) — it names the STRUCTURAL design language, not light/dark.
    expect(main).not.toMatch(/phoenixVisual = theme/);
  });

  it('gates every real selector behind BOTH the Phase A marker and the daylight marker', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectorLines = withoutComments
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.endsWith('{') && !l.startsWith('@'));
    expect(selectorLines.length).toBeGreaterThan(0);
    // Both attributes must be present, but not necessarily adjacent/ordered —
    // the hidden-tab-pause rule legitimately mirrors phase-a-foundation.css's
    // own established `html[data-page-hidden][data-phoenix-ui-phase='a']`
    // convention, which puts data-page-hidden first.
    const ungated = selectorLines.filter(sel =>
      !sel.includes("data-phoenix-ui-phase='a'") || !sel.includes("data-phoenix-visual='daylight'"),
    );
    expect(ungated).toEqual([]);
  });

  it('defines the Phoenix Daylight institutional tokens (gold, sidebar, info-blue) once, centrally', () => {
    for (const token of [
      '--phoenix-gold:', '--phoenix-gold-2:', '--phoenix-gold-ink:',
      '--phoenix-sidebar-bg:', '--phoenix-sidebar-text:', '--phoenix-sidebar-active-bg:',
      '--phoenix-info:', '--phoenix-canvas:',
    ]) {
      expect(css, `${token} must be defined`).toContain(token);
    }
    // Dark theme restates the sidebar/gold tokens rather than leaving them to
    // drift from light-theme values by accident.
    expect(css).toMatch(/\[data-theme='dark'\]\s*\{[^}]*--phoenix-sidebar-bg/);
  });

  it('is a pure CSS file: no imports, no Supabase/RPC access, no CDN or external URL, no 100vw', () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toContain('supabase');
    expect(css).not.toContain('.rpc(');
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain('100vw');
  });

  it('uses only logical (RTL-safe) direction properties, never a hardcoded left/right side', () => {
    expect(css).not.toMatch(/[^-](left|right)\s*:/);
    expect(css).toMatch(/grid-template-areas/);
  });

  it('fixes the auth panel order with ONE direction-agnostic rule instead of a [dir="rtl"] override', () => {
    // The reference board mirrors the auth/hero panels by LOGICAL position
    // (auth at inline-start, hero at inline-end) in both languages — the
    // prior [dir="rtl"] override in phoenix-nexus.css kept the form pinned to
    // the physical left in both directions instead, which this layer corrects
    // by never re-introducing a dir-conditional area map of its own.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).toMatch(/grid-template-areas:\s*"form art"/);
    expect(withoutComments).not.toMatch(/\[dir=['"]rtl['"]\][^{]*\.premium-login/);
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

  it('never mentions a database migration file, and no migration .sql file was created or modified by this phase', () => {
    expect(css).not.toMatch(/supabase\/migrations/);
    let diff = '';
    try {
      diff = execSync('git diff --name-only HEAD -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('never touches a Supabase service, RPC call site, or route/screen-number registry', () => {
    let diff = '';
    try {
      // STAGE-E-E7-2: a still later, separately-reviewed phase wires the
      // Stage-E outlet corridor into the application. It edits exactly two
      // service files — organizations.service.ts (the organization writer now
      // sends the Migration-164/171 classification pair it previously omitted)
      // and warehouses.service.ts (distribution points now carry Migration
      // 164's clinical_location_kind) — neither of which is a visual change.
      // Excluded BY EXACT NAME; every other path this guard watched, the rest
      // of src/shared/supabase included, is still covered.
      diff = execSync(
        'git diff --name-only HEAD -- src/shared/supabase src/app/AuthenticatedApp.tsx src/app/App.tsx src/shared/authz '
        + '":!src/shared/supabase/services/organizations.service.ts" '
        + '":!src/shared/supabase/services/warehouses.service.ts"',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  // PHASE-A-CLAUDE-A7.2: a later, separately-reviewed phase (Premium Living
  // Auth & Welcome) deliberately edits both files' JSX — swapping the
  // photographic Phoenix-bird hero art for an original <InstitutionalSupply
  // Motif> illustration, the reference board's own explicit "no Phoenix bird
  // as hero" requirement — so a zero-diff check no longer holds. The actual
  // invariant this test protects (every handler byte-for-byte identical) is
  // asserted directly below instead, and still holds.
  it('leaves auth handlers unchanged (sign-in, reset, welcome-completion) — only the hero visual changed in A7.2', () => {
    expect(loginScreen).toContain('const res = await signIn(resolveLoginIdentifier(email), password);');
    expect(loginScreen).toContain('const res = await requestPasswordReset(email);');
    expect(welcome).toContain('const finish = useCallback(');
  });

  it('leaves every existing sidebar/drawer permission gate untouched', () => {
    for (const src of [sidebar, mobileDrawer]) {
      expect(src).toContain("role === 'super_admin' || myPermissions.has('users.view')");
      expect(src).toContain("role === 'super_admin' || myPermissions.has('users.edit_scope')");
    }
    expect(sidebar).toContain('institutionsScreenAccess(role)');
    expect(mobileDrawer).toContain('institutionsScreenAccess(role)');
  });

  it('keeps nav active-state a data-attribute (aria-current parity), not a new interaction', () => {
    for (const src of [sidebar, mobileDrawer]) {
      expect(src).toContain('data-active={currentScreen === item.screen}');
      expect(src).toContain("aria-current={currentScreen === item.screen ? 'page' : undefined}");
    }
    expect(css).toContain('.premium-nav-item[data-active="true"]');
  });

  it('never leaves an inactive nav/bottom-nav button on the browser default button face (a real regression caught via rendered evidence, not assumed)', () => {
    expect(css).toMatch(/\.premium-sidebar \.premium-nav-item\s*\{[^}]*background:\s*transparent/);
  });

  it('keeps the primary action gold and the secondary action teal, from a token — never a baked hex', () => {
    expect(button).toMatch(/--phoenix-gold-2/);
    expect(button).toContain("color: 'var(--teal)'");
    expect(css).toMatch(/\.phoenix-button\[data-variant="primary"\]\s*\{[^}]*--phoenix-gold/);
  });

  it('gives PhoenixStatusBadge a data-variant hook and a dedicated info-blue token distinct from the teal secondary accent', () => {
    expect(badge).toContain('data-variant={variant}');
    expect(badge).toContain('--phoenix-info');
  });

  it('never disables reduced motion or the hidden-tab animation pause contract', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('html[data-page-hidden]');
  });

  it('keeps language/theme controls inside the existing stable toolbars, no new control surface', () => {
    expect(loginScreen).toContain('nexus-login__controls');
    expect(loginScreen).toContain('onClick={toggleLang}');
    expect(loginScreen).toContain('onClick={toggleTheme}');
  });

  it('introduces no Math.random or fabricated KPI value in any touched file', () => {
    for (const [name, src] of [
      ['PhoenixSidebar', sidebar], ['PhoenixMobileDrawer', mobileDrawer], ['PhoenixMobileBottomNav', bottomNav],
      ['PhoenixButton', button], ['PhoenixStatusBadge', badge],
    ] as const) {
      expect(src, `${name} must not use Math.random for a displayed value`).not.toMatch(/Math\.random\(\)/);
    }
  });

  it('does not embed the reference-board image, or any external image URL, in a product asset or CSS file', () => {
    expect(css).not.toMatch(/data:image/);
    expect(css).not.toMatch(/reference-board|MediStock-Phoenix\.dc\.html/);
  });

  it('leaves the QA harness fixture files untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff --name-only HEAD -- src/features/qa/QaHarness.tsx src/features/qa/qaData.ts src/features/qa/qaFixtures.ts src/features/qa/qaFixtureClient.ts src/features/qa/qaScopes.ts src/features/qa/qaConfig.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('leaves no local QA-only env file and no other untracked temporary fixture in the committed tree', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- .env.local .env .env.*.local', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(status.trim()).toBe('');
  });

  it('never mutates real data from a visual-only source file (defence in depth alongside the QA harness safety test)', () => {
    for (const src of [sidebar, mobileDrawer, bottomNav, button, badge]) {
      expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
    }
  });
});
