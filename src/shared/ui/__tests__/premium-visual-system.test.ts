import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
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
    expect(dashboard).toContain('premium-command-hero');
    expect(dashboard).toContain("['open', 'acknowledged', 'in_progress']");
    expect(read('shared/ui/PhoenixMetricCard.tsx')).toContain('premium-kpi-footer');
    expect(institutions).toContain('premium-page-header');
    expect(institutions).toContain('premium-org-toolbar');
    expect(institutions).toContain('premium-org-card__meta');
    expect(institutions).toContain('org.code');
    expect(institutions).toContain('org.city');
    expect(institutions).not.toContain("supabase.from('organizations')");
  });

  it('uses CSS-only effects without visual library dependencies', () => {
    const pkg = readFileSync(join(SRC, '../package.json'), 'utf8');
    expect(pkg).not.toMatch(/three|react-three-fiber|framer-motion/);
  });
});
