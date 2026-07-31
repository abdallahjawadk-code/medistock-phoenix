import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('Phase A auth and welcome presentation contract', () => {
  const main = read('main.tsx');
  const css = read('shared/lib/phase-a-auth.css');
  const login = read('features/auth/LoginScreen.tsx');
  const welcome = read('features/auth/PhoenixWelcomeExperience.tsx');

  it('loads the isolated auth layer after the shared Phase A foundation', () => {
    const foundationIndex = main.indexOf("import '@/shared/lib/phase-a-foundation.css';");
    const authIndex = main.indexOf("import '@/shared/lib/phase-a-auth.css';");

    expect(foundationIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(foundationIndex);
    expect(main).toContain("document.documentElement.dataset.phoenixUiPhase = 'a'");
  });

  it('keeps every auth selector gated and provides desktop, mobile, and reduced-motion behavior', () => {
    expect(css).toContain("html[data-phoenix-ui-phase='a'] .premium-login.nexus-login");
    expect(css).toContain("html[data-phoenix-ui-phase='a'] .nexus-welcome");
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).toContain('@media (max-width: 520px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('env(safe-area-inset-bottom');
    expect(css).toContain('animation-play-state: paused');
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('preserves the existing sign-in, reset, session welcome, and approved artwork contracts', () => {
    expect(login).toContain('signIn(resolveLoginIdentifier(email), password)');
    expect(login).toContain('requestPasswordReset(email)');
    expect(login).toContain('/assets/phoenix/runtime/phoenix-login.avif');
    expect(login).not.toContain("supabase.from(");

    expect(welcome).toContain('onComplete');
    expect(welcome).toContain('/assets/phoenix/runtime/phoenix-welcome-clean.avif');
    expect(welcome).toContain('تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم');
    expect(welcome).toContain('بإشراف الصيدلاني باسم كاظم رمح');
    expect(welcome).not.toContain("supabase.from(");
  });
});
