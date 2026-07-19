/**
 * W2 — CINEMATIC-PHOENIX-WELCOME
 * Source contracts for the post-authentication, pre-shell rebirth experience.
 * The sequence is presentation-only: it must never change authentication,
 * database, permissions, navigation, or medicine-supply state.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8').replace(/\r\n/g, '\n');

const welcome = read('features/auth/PhoenixWelcomeExperience.tsx');
const app = read('app/AuthenticatedApp.tsx');
const css = read('shared/lib/phoenix-nexus.css');
const strings = read('shared/i18n/strings.ts');

describe('W2 cinematic Phoenix welcome', () => {
  it('runs only after a real authenticated session and before the app shell', () => {
    const login = app.indexOf('if (!session)');
    const welcomeGate = app.indexOf('if (!welcomeSeen');
    const shell = app.indexOf('<PhoenixAppShell');
    expect(login).toBeGreaterThan(-1);
    expect(welcomeGate).toBeGreaterThan(login);
    expect(shell).toBeGreaterThan(welcomeGate);
  });

  it('plays once per user per tab session and resets only on explicit logout', () => {
    expect(app).toContain('medistock-phoenix-welcome:');
    expect(app).toContain('window.sessionStorage.getItem(welcomeKey)');
    expect(app).toContain("window.sessionStorage.setItem(welcomeKey, 'complete')");
    expect(app).toContain('window.sessionStorage.removeItem(welcomeKey)');
    expect(app).not.toContain('localStorage');
  });

  it('implements the complete ignition-to-departure choreography', () => {
    for (const phase of ['ignite', 'burn', 'ash', 'rebirth', 'reveal', 'depart']) {
      expect(welcome).toContain("'" + phase + "'");
      expect(css).toContain('[data-phase="' + phase + '"]');
    }
    expect(welcome).toContain('PHASE_SCHEDULE');
    expect(welcome).toContain('window.setTimeout(finish, 7300)');
  });

  it('is fully skippable with a 44px keyboard-accessible control and Escape', () => {
    expect(welcome).toContain("event.key === 'Escape'");
    expect(welcome).toContain('skipRef.current?.focus');
    expect(welcome).toContain("t('phoenix_welcome_skip'");
    expect(css).toMatch(/\.nexus-welcome__skip\s*\{[\s\S]*?min-height:\s*44px/);
    expect(welcome).toContain('premium-focus-ring');
  });

  it('exposes dialog semantics and polite phase status to assistive technology', () => {
    expect(welcome).toContain('role="dialog"');
    expect(welcome).toContain('aria-modal="true"');
    expect(welcome).toContain('aria-labelledby="phoenix-welcome-title"');
    expect(welcome).toContain('aria-describedby="phoenix-welcome-credits"');
    expect(welcome).toContain('aria-live="polite"');
    expect(welcome).toContain('aria-atomic="true"');
  });

  it('honours reduced motion and automatically compacts effects on constrained devices', () => {
    expect(welcome).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(welcome).toContain('window.setTimeout(finish, 1800)');
    expect(welcome).toContain('deviceMemory');
    expect(welcome).toContain('hardwareConcurrency');
    expect(welcome).toContain('saveData');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('[data-render-tier="compact"]');
  });

  it('uses bounded deterministic live layers rather than video or remote visual assets', () => {
    expect(welcome).toContain('Array.from({ length: 40 }');
    expect(welcome).toContain('Array.from({ length: 22 }');
    expect(welcome).toContain('Array.from({ length: 28 }');
    expect(welcome).not.toMatch(/<video|<canvas|requestAnimationFrame\([^)]*draw/i);
    expect(welcome).not.toMatch(/https?:\/\//);
    expect(css).not.toMatch(/url\(\s*['"]?https?:\/\//i);
  });

  it('renders the approved identity and credits from bilingual i18n keys', () => {
    for (const key of [
      'phoenix_welcome_kicker',
      'phoenix_welcome_title',
      'phoenix_welcome_department',
      'phoenix_welcome_issued_by',
      'phoenix_welcome_supervised_by',
    ]) {
      expect(welcome).toContain("t('" + key + "'");
      expect(strings).toContain(key + ':');
    }
    expect(strings).toContain('دائرة صحة بابل - قسم الصيدلة');
    expect(strings).toContain('تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم');
    expect(strings).toContain('بإشراف الصيدلاني باسم كاظم رمح');
  });

  it('builds a real burn, ash and rebirth visual language with no rapid looping flash', () => {
    for (const selector of [
      'nexus-welcome__solar-core',
      'nexus-welcome__phoenix--burn',
      'nexus-welcome__phoenix--reborn',
      'nexus-welcome__ash-field',
      'nexus-welcome__rebirth-flash',
      'nexus-welcome__shockwave',
      'nexus-welcome__wing-trace',
    ]) expect(css).toContain(selector);
    expect(css).toContain('nexus-welcome-flash 1.05s ease-out both');
    expect(css).not.toMatch(/nexus-welcome-flash[^;]*infinite/);
  });

  it('keeps phone, short-screen, RTL progress and reduced-motion layouts explicit', () => {
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('@media (max-height: 690px)');
    expect(css).toContain('[dir="rtl"] .nexus-welcome__progress');
    expect(css).toContain('.nexus-welcome__credits > div');
  });

  it('locks page scroll for the modal sequence and restores the previous state', () => {
    expect(welcome).toContain("document.body.style.overflow = 'hidden'");
    expect(welcome).toContain('document.body.style.overflow = previousOverflow');
    expect(welcome).toContain('previouslyFocused?.isConnected');
  });

  it('is presentation-only and cannot touch auth, RBAC, SQL, RPCs, or stock state', () => {
    expect(welcome).not.toMatch(/supabase|\.rpc\(|service_role|auth\.admin|signIn|signOut/i);
    expect(welcome).not.toMatch(/warehouse_|outlet_stock|inventory_alert|permission/i);
    expect(welcome).not.toMatch(/localStorage|innerHTML|dangerouslySetInnerHTML/);
  });
});
