import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import pkg from '../../../../package.json';

const SRC = join(__dirname, '../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('Phase A executive dashboard + unified reporting shell (A3) presentation contract', () => {
  const main = read('main.tsx');
  const css = read('shared/lib/phase-a-command-center.css');
  const dashboard = read('features/dashboard/DashboardScreen.tsx');
  const dirc = read('features/reports/DecisionIntelligenceReportsScreen.tsx');

  it('loads the command-center layer after the shared foundation and auth layers', () => {
    const foundationIndex = main.indexOf("import '@/shared/lib/phase-a-foundation.css';");
    const authIndex = main.indexOf("import '@/shared/lib/phase-a-auth.css';");
    const ccIndex = main.indexOf("import '@/shared/lib/phase-a-command-center.css';");

    expect(foundationIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(foundationIndex);
    expect(ccIndex).toBeGreaterThan(authIndex);
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

  it('touches only the dashboard and unified reports/status screens via one shared class hook', () => {
    expect(css).toContain('.nexus-command-center');
    expect(css).toContain('.nexus-command-center--dashboard');
    expect(css).toContain('.nexus-command-center--reports');
    expect(dashboard).toContain('nexus-command-center nexus-command-center--dashboard');
    expect(dirc).toContain('nexus-command-center nexus-command-center--reports');
  });

  it('is a pure CSS file: no imports, no Supabase/RPC access, no CDN or external URL', () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toContain('supabase');
    expect(css).not.toContain('.rpc(');
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain('100vw');
  });

  it('never reaches Supabase directly from the two screens it styles (service-layer only)', () => {
    expect(dashboard).not.toContain("from '@/shared/supabase/client'");
    expect(dirc).not.toContain("from '@/shared/supabase/client'");
  });

  it('keeps the dashboard and unified reports screen on their existing data sources', () => {
    expect(dashboard).toContain('getDashboardMetrics(');
    expect(dashboard).toContain('getInstitutionOverviews(');
    expect(dashboard).toContain('getStatusReportCounts(');
    expect(dirc).toContain('getExecutiveOverview(');
    expect(dirc).toContain('getAvailabilityByOrg(');
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
    expect(css).toMatch(/margin-inline|inset-inline|border-inline/);
  });

  it('provides desktop and mobile responsive behavior', () => {
    expect(css).toContain('@media (max-width: 767px)');
  });

  it('removes nonessential motion under reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.nexus-command-center\s*\{[^}]*animation:\s*none/);
  });

  it('never mentions a database migration file', () => {
    expect(css).not.toMatch(/supabase\/migrations/);
    expect(dashboard).not.toMatch(/supabase\/migrations/);
    expect(dirc).not.toMatch(/supabase\/migrations/);
  });
});
