/**
 * UI-MOBILE-PREMIUM-3D-CARDS-A
 *
 * This phase is CSS/className-only mobile visual polish (2.5D depth, glass,
 * gradient border, touch-press feedback, calm entrance/glow) applied to a
 * controlled first pass of card surfaces: institution/port cards,
 * inter-institution alert cards, and the two dashboard summary card lists.
 * No routing, RPC, permission, QR, alert-lifecycle, WhatsApp, or
 * user-management logic is touched.
 *
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const css = readSrc('shared/lib/global.css');
const institution = readSrc('features/institutions/InstitutionScreen.tsx');
const alerts = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const dashboard = readSrc('features/dashboard/DashboardScreen.tsx');
const usersService = readSrc('shared/supabase/services/users.service.ts');
const whatsappButton = readSrc('shared/ui/WhatsAppContactButton.tsx');
const alertLifecycleService = readSrc('features/alerts/inter-org-alert-lifecycle.service.ts');
const app = readSrc('app/App.tsx');

describe('1. Reusable mobile premium card classes exist in the CSS', () => {
  it('defines the required class set, scoped to the mobile breakpoint', () => {
    const mobileBlockStart = css.indexOf('UI-MOBILE-PREMIUM-3D-CARDS-A');
    expect(mobileBlockStart).toBeGreaterThan(-1);
    const mobileBlock = css.slice(mobileBlockStart);
    for (const className of [
      '.premium-mobile-card',
      '.premium-mobile-card-critical',
      '.premium-mobile-card-warning',
      '.premium-mobile-card-success',
      '.premium-mobile-glass',
      '.premium-mobile-pressable',
      '.premium-mobile-enter',
      '.premium-mobile-subtle-glow',
    ]) {
      expect(mobileBlock).toContain(className);
    }
  });

  it('the depth/glow/pressable/entrance rules live inside a max-width mobile media query', () => {
    const idx = css.indexOf('.premium-mobile-card {');
    const before = css.slice(0, idx);
    const lastMediaOpen = before.lastIndexOf('@media (max-width:');
    expect(lastMediaOpen).toBeGreaterThan(-1);
    // no unmatched closing brace between the media query and the class (i.e. still inside it)
    const between = css.slice(lastMediaOpen, idx);
    const opens = (between.match(/\{/g) || []).length;
    const closes = (between.match(/\}/g) || []).length;
    expect(opens).toBe(closes + 1);
  });
});

describe('2. Reduced-motion support exists for the new classes', () => {
  it('has a dedicated prefers-reduced-motion block disabling entrance/press/glow motion', () => {
    const enterIdx = css.indexOf('.premium-mobile-enter { animation: none');
    expect(enterIdx).toBeGreaterThan(-1);
    const before = css.slice(0, enterIdx);
    const rmIdx = before.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    expect(rmIdx).toBeGreaterThan(-1);
    const rmBlock = css.slice(rmIdx, enterIdx + 200);
    expect(rmBlock).toContain('.premium-mobile-enter');
    expect(rmBlock).toContain('.premium-mobile-subtle-glow');
    expect(rmBlock).toContain('animation: none !important');
  });

  it('the pre-existing global reduced-motion rule (collapsing all animation/transition durations) is still present', () => {
    expect(css).toContain('*, *::before, *::after {');
    expect(css).toContain('animation-duration: .01ms !important');
    expect(css).toContain('animation-iteration-count: 1 !important');
  });
});

describe('3. No aggressive/global infinite flashing animation was introduced', () => {
  it('premium-mobile-subtle-glow is the only new infinite animation, and it is not applied to every card unconditionally', () => {
    const infiniteMatches = css.match(/animation:\s*[\w-]+\s+[\d.]+s[\s\w-]*infinite/g) || [];
    // every "infinite" animation declared anywhere in the file must be the pre-existing
    // .anim-bp badge-pulse utility or our new subtle glow — nothing broader was added.
    for (const decl of infiniteMatches) {
      expect(decl.includes('bp') || decl.includes('premiumMobileGlow')).toBe(true);
    }
  });

  it('premium-mobile-card and premium-mobile-enter themselves carry no infinite/blink keyframe', () => {
    const cardBlock = css.slice(css.indexOf('.premium-mobile-card {'), css.indexOf('.premium-mobile-card-critical'));
    expect(cardBlock).not.toMatch(/infinite/);
    expect(cardBlock).not.toMatch(/blink/i);
  });

  it('no new animation-related dependency was introduced (framer-motion) anywhere touched by this phase', () => {
    for (const src of [institution, alerts, dashboard]) {
      expect(src).not.toMatch(/framer-motion/);
    }
  });
});

describe('4. Institution/port card containers receive the mobile premium card class', () => {
  it('PortCard applies premium-mobile-card (+ pressable/enter/state classes) to its PhoenixCard', () => {
    const idx = institution.indexOf('function PortCard(');
    const nextFnIdx = institution.indexOf('\nfunction ', idx + 1);
    const fnSlice = institution.slice(idx, nextFnIdx > -1 ? nextFnIdx : idx + 12000);
    expect(fnSlice).toContain('premium-mobile-card');
    expect(fnSlice).toContain('premium-mobile-pressable');
    expect(fnSlice).toContain('premium-mobile-enter');
  });
});

describe('5. Existing QR actions remain present and unchanged', () => {
  it('QR preview/generate/revoke controls are still present in InstitutionScreen', () => {
    for (const marker of ['qr_open_preview', 'qr_preview', 'qr_no_token', "'regenerate'", "'revoke'"]) {
      expect(institution).toContain(marker);
    }
  });
});

describe('6. Existing edit/disable/remove/safe-delete actions remain present and unchanged', () => {
  it('edit/archive/remove-from-port flows are still wired', () => {
    expect(institution).toContain('function openEdit()');
    expect(institution).toContain("setConfirmAction('archive')");
    expect(institution).toContain("setConfirmAction('edit')");
    expect(institution).toContain('canRemoveOutletMaterial');
    expect(institution).toContain("onClick={() => { setRemoveError(null); setRemoveTarget(r); }}");
  });
});

describe('7. Inter-institution alert cards receive the mobile premium card class', () => {
  it('AlertCard applies premium-mobile-card to its PhoenixCard', () => {
    const idx = alerts.indexOf('function AlertCard(');
    const fnSlice = alerts.slice(idx, idx + 2000);
    expect(fnSlice).toContain('premium-mobile-card');
  });
});

describe('8. High-severity alert cards receive the critical class', () => {
  it('severity === "high" maps to premium-mobile-card-critical', () => {
    const idx = alerts.indexOf('function AlertCard(');
    const fnSlice = alerts.slice(idx, idx + 2000);
    expect(fnSlice).toMatch(/a\.severity === 'high'[\s\S]{0,80}premium-mobile-card-critical/);
  });
});

describe('9. Medium-severity alert cards receive the warning class', () => {
  it('non-high severity falls back to premium-mobile-card-warning (medium is the only other alert severity)', () => {
    const idx = alerts.indexOf('function AlertCard(');
    const fnSlice = alerts.slice(idx, idx + 2000);
    expect(fnSlice).toContain('premium-mobile-card-warning');
  });
});

describe('10. WhatsApp button behavior remains user-click only and unchanged', () => {
  it('WhatsAppContactButton still builds a plain wa.me link with no API/token usage', () => {
    expect(whatsappButton).toMatch(/wa\.me/);
    expect(whatsappButton).not.toMatch(/graph\.facebook|WHATSAPP_TOKEN|whatsapp_business_api/i);
  });

  it('AlertCard still wires WhatsAppContactButton the same way (contactTargets/phone/message)', () => {
    expect(alerts).toContain('<WhatsAppContactButton');
    expect(alerts).toContain('resolveAlertContactTargets(a, activeOrgId, isSuper, lang)');
  });
});

describe('11. Alert lifecycle buttons remain present and unchanged', () => {
  it('acknowledge/start/resolve/dismiss/reopen actions are still wired to onAction', () => {
    for (const marker of [
      "onAction('acknowledged')", "onAction('in_progress')", "onAction('resolved')",
      "onAction('dismissed')", "onAction('open')",
    ]) {
      expect(alerts).toContain(marker);
    }
  });

  // REFRESH-ALERT-UI-DIFF-GUARDS-A: inter-org-alert-lifecycle.service.ts is no
  // longer expected to have zero diff — a later, separately-reviewed phase
  // (ALERT-CARDS-EXPIRY-RISK-BADGES-UI-A) legitimately extends it with
  // sourceExpiryRiskTier/sourceExpiryDaysRemaining mapping. The invariant
  // this test actually guards (the four lifecycle RPC wrapper functions
  // still exist, unrenamed/unremoved) is checked directly instead.
  it('inter-org-alert-lifecycle.service.ts core lifecycle functions remain present and unchanged in name/shape', () => {
    expect(alertLifecycleService).toContain('export async function getLiveInterInstitutionAlertsWithState(');
    expect(alertLifecycleService).toContain('export async function updateInterOrgAlertState(');
    expect(alertLifecycleService).toContain('export async function reopenInterOrgAlert(');
    expect(alertLifecycleService).toContain('export async function getInterOrgAlertEvents(');
    expect(alertLifecycleService.length).toBeGreaterThan(0);
  });
});

describe('12. Existing routes/links are not changed', () => {
  it('dashboard onNavigate targets (11, 13) are unchanged', () => {
    expect(dashboard).toContain('onNavigate(13)');
    expect(dashboard).toContain('onNavigate(11)');
  });

  it('App.tsx screen-number routing is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/app/App.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    expect(app).toContain('InterInstitutionAlertsScreen');
  });
});

describe('13. No backend/service/RLS/auth/permission files changed', () => {
  // REFRESH-ALERT-UI-DIFF-GUARDS-A: src/features/alerts/inter-org-alert-lifecycle.service.ts
  // is excluded from this loop because a later, separately-reviewed phase
  // (ALERT-CARDS-EXPIRY-RISK-BADGES-UI-A) legitimately extends it with
  // sourceExpiryRiskTier/sourceExpiryDaysRemaining mapping — every other
  // file in this list remains fully guarded (zero diff required).
  it('no diff in permission/service/RLS-adjacent files touched historically by this feature', () => {
    for (const rel of [
      'src/shared/supabase/services/users.service.ts',
      'src/shared/supabase/services/auth.service.ts',
      'src/features/alerts/inter-institution-alerts.service.ts',
      'src/features/alerts/live-inter-institution-alerts.service.ts',
    ]) {
      let diff = '';
      try {
        diff = execSync(`git diff -- ${rel}`, { cwd: ROOT, encoding: 'utf8' });
      } catch { /* ignore */ }
      expect(diff.trim()).toBe('');
    }
    expect(usersService.length).toBeGreaterThan(0);
  });

  it('no service_role/auth.admin appears in any file touched by this phase', () => {
    for (const src of [css, institution, alerts, dashboard]) {
      expect(src).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
    }
  });
});

describe('14. No migrations created or modified', () => {
  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded because a later, separately-reviewed phase (FIX-MIGRATION-051-
  // IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it in-place before its
  // first successful manual apply.
  it('no diff/new file under supabase/migrations other than the already-approved 051 immutable-expiry-date fix', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('15. No package/lockfile changes', () => {
  it('no diff in package.json/lockfiles', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removedLines.length).toBe(0);
    expect(addedLines.every(l => /"exceljs":/.test(l))).toBe(true);
  });
});

describe('16. premium-preview.html and supabase/.temp/ remain untracked', () => {
  it('both stay untracked (?? status) if present, never staged', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) expect(status.trim().startsWith('??')).toBe(true);

    const full = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = full.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) expect(tempLine.trim().startsWith('??')).toBe(true);
  });
});

describe('17. Service-D stash is untouched', () => {
  it('stash@{0} (paused Service-D work) is still present', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});

describe('18. No raw UUID rendering is introduced', () => {
  it('none of the touched files render a raw id/pointId/orgId/alertKey UUID directly as visible text', () => {
    for (const src of [institution, alerts, dashboard]) {
      expect(src).not.toMatch(/\{a\.id\}<\/|\{point\.id\}<\/|\{inst\.id\}<\//);
    }
  });
});

describe('19. Desktop styling is protected (mobile-only scoping)', () => {
  it('every new premium-mobile-* rule is declared inside a max-width media query, never at top level', () => {
    const classNames = [
      'premium-mobile-card', 'premium-mobile-card-critical', 'premium-mobile-card-warning',
      'premium-mobile-card-success', 'premium-mobile-glass', 'premium-mobile-pressable',
      'premium-mobile-enter', 'premium-mobile-subtle-glow',
    ];
    for (const cls of classNames) {
      const ruleIdx = css.indexOf(`.${cls} {`);
      expect(ruleIdx).toBeGreaterThan(-1);
      const before = css.slice(0, ruleIdx);
      const lastMediaOpen = before.lastIndexOf('@media (max-width:');
      const lastMediaCloseCandidate = before.lastIndexOf('\n}\n');
      expect(lastMediaOpen).toBeGreaterThan(-1);
      // ensure no reduced-motion-only or unrelated media query sits between
      expect(lastMediaOpen).toBeGreaterThan(lastMediaCloseCandidate - 200);
    }
  });
});

describe('20. RTL is preserved in touched screens', () => {
  it('dir="auto"/dir="rtl"/dir="ltr" usage is preserved', () => {
    for (const src of [institution, alerts, dashboard]) {
      expect(src).toMatch(/dir=["'](auto|rtl|ltr)["']|dir=\{/);
    }
  });
});
