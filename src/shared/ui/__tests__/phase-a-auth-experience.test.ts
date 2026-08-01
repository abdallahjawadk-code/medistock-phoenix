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
    expect(login).not.toContain("supabase.from(");

    expect(welcome).toContain('onComplete');
    expect(welcome).toContain('تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم');
    expect(welcome).toContain('بإشراف الصيدلاني باسم كاظم رمح');
    expect(welcome).not.toContain("supabase.from(");
  });

  // PHASE-A-CLAUDE-A7.2: a later, separately-reviewed phase (Premium Living
  // Auth & Welcome) deliberately retires the photographic Phoenix-bird hero
  // art on BOTH screens — the reference board's own explicit "no Phoenix bird
  // as hero" contract — replacing it with an original inline-SVG illustration
  // (no image asset, no new dependency). The two asset-path assertions above
  // are superseded by this stronger check.
  // PHASE-A-CLAUDE-A7.2.2: that phase's first illustration
  // (<InstitutionalSupplyMotif>) read as a flat teaching diagram rather than
  // a premium institutional environment, so a further corrective round
  // replaced it with <PharmaceuticalSupplyScene> and retired the motif file
  // entirely; the same round also replaced the Phoenix-bird APP ICON in the
  // Login brand lockup with the geometric <MediStockMark>, per the board's
  // "no bird as the auth identity" requirement. PhoenixMark deliberately
  // stays in PhoenixSidebar/PhoenixMobileDrawer, so the wider application's
  // identity is untouched — asserted below so that scope cannot silently widen.
  it('the Phoenix-bird photo hero is retired from both screens in favour of the original institutional scene (A7.2 → A7.2.2)', () => {
    expect(login).toContain('PharmaceuticalSupplyScene');
    expect(welcome).toContain('PharmaceuticalSupplyScene');
    expect(login).not.toContain('/assets/phoenix/runtime/phoenix-login');
    expect(welcome).not.toContain('/assets/phoenix/runtime/phoenix-welcome-clean');
    // The retired motif must not creep back in alongside the scene.
    expect(login).not.toContain('InstitutionalSupplyMotif');
    expect(welcome).not.toContain('InstitutionalSupplyMotif');
  });

  it('the auth brand lockup uses the geometric mark, while the rest of the app keeps PhoenixMark (A7.2.2)', () => {
    expect(login).toContain('MediStockMark');
    expect(login).not.toContain('PhoenixMark');
    expect(welcome).toContain('MediStockMark');
    // Scope guard: the wider application identity is explicitly NOT part of
    // this change.
    const sidebar = read('shared/ui/PhoenixSidebar.tsx');
    const drawer = read('shared/ui/PhoenixMobileDrawer.tsx');
    expect(sidebar).toContain('PhoenixMark');
    expect(drawer).toContain('PhoenixMark');
  });
});
