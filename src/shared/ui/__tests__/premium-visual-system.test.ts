import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
const css = read('shared/lib/global.css');
const tokens = read('shared/lib/tokens.css');

describe('premium visual system', () => {
  it('defines depth, glass, focus, motion, and responsive utilities', () => {
    for (const className of [
      'premium-shell', 'premium-glass-panel', 'premium-depth-card',
      'premium-3d-hover', 'premium-kpi-card', 'premium-focus',
      'premium-action-bar', 'institution-flow', 'history-timeline',
    ]) expect(css).toContain(className);
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('@media (max-width: 380px)');
    expect(tokens).toContain('--sh-depth');
    expect(tokens).toContain('--glass');
  });

  it('wires the premium system into shell and shared primitives', () => {
    expect(read('shared/ui/PhoenixAppShell.tsx')).toContain('premium-shell');
    expect(read('shared/ui/PhoenixSidebar.tsx')).toContain('premium-sidebar');
    expect(read('shared/ui/PhoenixTopbar.tsx')).toContain('premium-topbar');
    expect(read('shared/ui/PhoenixCard.tsx')).toContain('premium-depth-card');
    expect(read('shared/ui/PhoenixMetricCard.tsx')).toContain('premium-kpi-card');
    expect(read('shared/ui/PhoenixDialog.tsx')).toContain('premium-dialog-panel');
  });

  it('adds dense command-center and organization card hierarchy without new data sources', () => {
    const dashboard = read('features/dashboard/DashboardScreen.tsx');
    const institutions = read('features/institutions/InstitutionScreen.tsx');
    // Phase D replaced the flat premium-command-hero text header with the
    // design-source Dashboard hero band (real stock-health ring + live readouts).
    expect(dashboard).toContain('nexus-dash-hero');
    expect(dashboard).toContain("['open', 'acknowledged', 'in_progress']");
    expect(read('shared/ui/PhoenixMetricCard.tsx')).toContain('premium-kpi-footer');
    expect(institutions).toContain('premium-page-header');
    expect(institutions).toContain('premium-org-toolbar');
    expect(institutions).toContain('premium-org-card__meta');
    expect(institutions).toContain('org.code');
    expect(institutions).toContain('org.city');
    expect(institutions).not.toContain("supabase.from('organizations')");
  });

  it('avoids heavyweight motion libraries and isolates the WebGL stack to its lazy module', () => {
    const pkg = readFileSync(join(SRC, '../package.json'), 'utf8');
    // Motion is CSS or our own lazy WebGL engine — never a bundled animation lib.
    expect(pkg).not.toMatch(/framer-motion|gsap|lottie/);

    // three / @react-three/fiber ARE required now (the real cinematic Phoenix,
    // see tests/webgl-deps-contract.test.ts), but they must only be imported
    // from src/shared/webgl/** so Rollup keeps them in a lazy, code-split chunk
    // out of every operational screen. Any three/fiber import elsewhere would
    // pull the ~800KB GPU stack into a screen that must stay light.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          if (/__tests__/.test(rel) || rel.startsWith('shared/webgl/')) continue;
          const text = readFileSync(join(SRC, rel), 'utf8');
          if (/from ['"]three['"]|from ['"]@react-three\/fiber/.test(text)) offenders.push(rel);
        }
      }
    };
    walk('features');
    walk('shared');
    walk('app');
    expect(offenders, `three/fiber imported outside src/shared/webgl:\n${offenders.join('\n')}`).toEqual([]);
  });
});
