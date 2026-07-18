import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const css = read('../../lib/phoenix-nexus.css');
const shell = read('../PhoenixAppShell.tsx');
const sidebar = read('../PhoenixSidebar.tsx');
const drawer = read('../PhoenixMobileDrawer.tsx');
const bottomNav = read('../PhoenixMobileBottomNav.tsx');
const palette = read('../CommandPalette.tsx');
const login = read('../../../features/auth/LoginScreen.tsx');
const welcome = read('../../../features/auth/PhoenixWelcomeExperience.tsx');
const authenticatedApp = read('../../../app/AuthenticatedApp.tsx');
const topology = read('../../../features/network/NetworkTopologyStage.tsx');
const networkScreen = read('../../../features/network/NetworkManagementScreen.tsx');
const manifest = read('../../../../public/manifest.webmanifest');

describe('Phoenix Nexus production design boundaries', () => {
  it('activates one shared cinematic shell without changing screen routing', () => {
    expect(shell).toContain('premium-shell nexus-shell');
    expect(shell).toContain('currentScreen={currentScreen}');
    expect(shell).toContain('onNavigate={onNavigate}');
    expect(authenticatedApp).toContain('<ScreenAuthzGuard');
  });

  it('uses one deterministic SVG icon language on every navigation surface', () => {
    [sidebar, drawer, bottomNav, palette].forEach(source => {
      expect(source).toContain('PhoenixIcon');
      expect(source).not.toMatch(/[🏛📋📊🔔👥🗺✏️👤🔎]/u);
    });
  });

  it('preserves permission predicates across desktop, drawer, and command palette', () => {
    [sidebar, drawer, palette].forEach(source => {
      expect(source).toContain("role === 'super_admin' || myPermissions.has('users.view')");
      expect(source).toContain("role === 'super_admin' || myPermissions.has('users.edit_scope')");
    });
  });

  it('provides day, night, responsive, and reduced-motion design contracts', () => {
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('@media (max-width: 767px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('--nx-ember');
    expect(css).toContain('--nx-cyan');
  });

  it('keeps authentication behavior intact while replacing only its presentation', () => {
    expect(login).toContain('resolveLoginIdentifier(email)');
    expect(login).toContain('requestPasswordReset(email)');
    expect(login).toContain("res.error === 'NOT_CONFIGURED'");
    expect(login).toContain('autoComplete="username"');
    expect(login).toContain('autoComplete="current-password"');
  });

  it('shows a skippable welcome once per authenticated session and clears it on logout', () => {
    expect(welcome).toContain('onClick={finish}');
    expect(welcome).toContain('prefers-reduced-motion: reduce');
    expect(authenticatedApp).toContain('medistock-phoenix-welcome:');
    expect(authenticatedApp).toContain("sessionStorage.setItem(welcomeKey, 'complete')");
    expect(authenticatedApp).toContain('sessionStorage.removeItem(welcomeKey)');
  });

  it('renders a live WebGL twin with an explicit safe fallback', () => {
    expect(topology).toContain("canvas.getContext('webgl'");
    expect(topology).toContain('setWebglReady(false)');
    expect(topology).toContain('SAFE MODE');
    expect(topology).toContain('prefers-reduced-motion: reduce');
    expect(topology).toContain('Math.min(window.devicePixelRatio || 1, 1.6)');
  });

  it('binds the twin to RLS-protected network reads without introducing writes', () => {
    expect(networkScreen).toContain('getAllWarehouses()');
    expect(networkScreen).toContain('getSupplyRoutes()');
    expect(networkScreen).toContain('getPointsByOrg(orgId)');
    expect(networkScreen).toContain('<NetworkTopologyStage');
    expect(topology).not.toContain('supabaseClient');
    expect(topology).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
  });

  it('ships installable Phoenix identity assets and production colors', () => {
    const parsed = JSON.parse(manifest) as {
      name: string;
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string; purpose: string }>;
    };
    expect(parsed.name).toContain('MediStock Phoenix');
    expect(parsed.background_color).toBe('#F3F7FB');
    expect(parsed.theme_color).toBe('#0D9488');
    expect(parsed.icons.some(icon => icon.src === '/pwa-icon-maskable-512.png' && icon.purpose === 'maskable')).toBe(true);
  });
});
