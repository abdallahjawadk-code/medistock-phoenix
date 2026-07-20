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
const webglSupport = read('../../webgl/webglSupport.ts');
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
    // Reduced-motion is now honoured via the shared prefersReducedMotion() helper
    // (which checks '(prefers-reduced-motion: reduce)' and gates the WebGL rebirth
    // to a short static path). The helper's query is covered by
    // src/shared/webgl/__tests__/webgl-support-and-fallback.test.tsx.
    expect(welcome).toContain('prefersReducedMotion');
    expect(webglSupport).toContain('(prefers-reduced-motion: reduce)');
    expect(authenticatedApp).toContain('medistock-phoenix-welcome:');
    expect(authenticatedApp).toContain("sessionStorage.setItem(welcomeKey, 'complete')");
    expect(authenticatedApp).toContain('sessionStorage.removeItem(welcomeKey)');
  });

  it('renders a live WebGL twin with an explicit safe fallback', () => {
    // The twin is a real Three.js scene (NetworkTwin3DScene), code-split behind
    // Suspense. The raw getContext probe now lives in the shared webglSupport
    // helper rather than inline here, so assert it at its real home — the
    // invariant (a genuine GL capability check, not a mock) is unchanged.
    expect(topology).toContain('NetworkTwin3DScene');
    expect(topology).toContain('shouldRenderWebGL');
    expect(webglSupport).toContain("getContext('webgl2')");
    expect(topology).toContain('setWebglReady(false)');
    expect(topology).toContain('SAFE MODE');
    expect(topology).toContain('prefers-reduced-motion: reduce');
    // DPR ceiling is enforced centrally by deviceProfile() (1.5 / 1.25 / 1 by
    // tier) and passed through to the Canvas; effects-policy.test.ts asserts the
    // ceiling itself. Here we assert the twin actually consumes it.
    expect(topology).toContain('dprCap={effects.profile.dprCap}');
    expect(webglSupport).toContain('dprCap: 1.5');
  });

  it('keeps the 2D deterministic map as the twin fallback and never lets 3D become mandatory', () => {
    // A lost context or an unavailable GL stack must drop to the deterministic
    // SVG map, which is laid out by twinLayout (collision-free at any density).
    expect(topology).toContain('computeTwin2dLayout');
    expect(topology).toContain('onContextLost');
    expect(topology).toContain("const effectiveView: '3d' | '2d' = canUse3D ? view : '2d'");
    // Offscreen / hidden-tab / blurred-window pause for the render loop.
    expect(topology).toContain('useRenderActive');
    expect(topology).toContain('continuous={effects.continuous && renderActive}');
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
    expect(parsed.name).toBe('MediStock-Babil Phoenix');
    // Dark-first Phoenix palette — both track --bg, so the install splash and
    // title bar match the app instead of the retired light teal.
    expect(parsed.background_color).toBe('#07111F');
    expect(parsed.theme_color).toBe('#07111F');
    expect(parsed.icons.some(icon => icon.src === '/pwa-icon-maskable-512.png' && icon.purpose === 'maskable')).toBe(true);
  });
});
