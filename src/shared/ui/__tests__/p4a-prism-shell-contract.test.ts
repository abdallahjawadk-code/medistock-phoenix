import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(join(__dirname, '../../../', file), 'utf8');
const shell = read('shared/ui/PhoenixAppShell.tsx');
const css = read('shared/ui/prism/prism-shell.css');
const fonts = read('shared/ui/prism/prism-fonts.css');
const sidebar = read('shared/ui/PhoenixSidebar.tsx');
const topbar = read('shared/ui/PhoenixTopbar.tsx');

describe('P4-A scoped PRISM shell safety', () => {
  it('mounts the presentation layer on the actual authenticated shell', () => {
    expect(shell).toContain("import './prism/prism-shell.css'");
    expect(shell).toContain('premium-shell nexus-shell prism-shell');
    expect(shell).toContain('<PhoenixSidebar');
    expect(shell).toContain('<PhoenixMobileDrawer');
    expect(shell).toContain('<PhoenixTopbar');
    expect(shell).toContain('id="phoenix-main"');
    expect(shell).toContain('nexus-skip-link');
  });
  it('keeps the authorization and interaction owners intact', () => {
    expect(sidebar).toContain('projectNavigation(NAV_ITEMS');
    expect(sidebar).toContain('projectNavigation(SECONDARY_ITEMS');
    expect(topbar).toContain('onClick={toggleLang}');
    expect(topbar).toContain('onClick={toggleTheme}');
    expect(topbar).toContain('<NotificationBell');
    expect(shell).toContain('<CommandPalette onNavigate={onNavigate} />');
  });
  it('keeps CSS reversible, locally scoped and direction/theme-aware', () => {
    expect(css).toContain(".prism-shell");
    expect(css).toContain("[data-theme='dark'] .prism-shell");
    expect(css).toContain(".prism-shell[dir='ltr']");
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('forced-colors');
    expect(css).toContain('.prism-shell #phoenix-mobile-drawer .premium-mobile-drawer');
    expect(css).toContain(".prism-shell[dir='ltr'] #phoenix-mobile-drawer .premium-mobile-drawer");
    expect(css).toContain(".prism-shell #phoenix-mobile-drawer .premium-mobile-drawer .premium-nav-item[data-active='true']");
    expect(css).not.toMatch(/(^|\n)\s*(?:html|body|:root)\s*\{/);
    expect(css).not.toMatch(/https?:\/\//);
    expect(fonts).toContain("url('/fonts/prism/Changa-variable.ttf')");
    expect(fonts).toContain("url('/fonts/prism/Sora-variable.ttf')");
  });
});
