import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import pkg from '../../../../package.json';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

/**
 * A7.2 — Premium Living Auth & Welcome Experience contract.
 *
 * This is the dedicated contract for the NEW signature layer only
 * (phase-a-auth-welcome-signature.css + InstitutionalSupplyMotif +
 * LoginScreen/PhoenixWelcomeExperience's hero swap + the light-first theme
 * default). A7's own contract (phase-a-visual-convergence.test.ts) and A7.1's
 * closure contract (phase-a71-visual-acceptance-closure.test.ts) already
 * cover their own layers and gained one narrow, documented exclusion each
 * here — see the comments at their own "byte-for-byte"/"last import" tests.
 */
describe('Phase A7.2 premium living auth & welcome signature contract', () => {
  const main = read('main.tsx');
  const css = read('shared/lib/phase-a-auth-welcome-signature.css');
  const convergenceCss = read('shared/lib/phase-a-visual-convergence.css');
  const motif = read('shared/ui/AuthSupplyHero.tsx');
  const mark = read('shared/ui/MediStockMark.tsx');
  const strings = read('shared/i18n/strings.ts');
  const login = read('features/auth/LoginScreen.tsx');
  const welcome = read('features/auth/PhoenixWelcomeExperience.tsx');
  const appContext = read('app/AppContext.tsx');
  const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');

  // ─── 1. CSS layer: import order, gating, purity ────────────────────────────

  it('is imported LAST, immediately after phase-a-visual-convergence.css, with nothing else reordering ahead of it', () => {
    const convergenceImport = "import '@/shared/lib/phase-a-visual-convergence.css';";
    const signatureImport = "import '@/shared/lib/phase-a-auth-welcome-signature.css';";
    const convergenceIndex = main.indexOf(convergenceImport);
    const signatureIndex = main.indexOf(signatureImport);
    expect(convergenceIndex).toBeGreaterThan(-1);
    expect(signatureIndex).toBeGreaterThan(convergenceIndex);
    const afterSignature = main.slice(signatureIndex + signatureImport.length);
    expect(afterSignature).not.toMatch(/import ['"].*\.css['"]/);
  });

  it('gates every real selector behind BOTH the Phase A marker and the daylight marker', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectorLines = withoutComments
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.endsWith('{') && !l.startsWith('@'));
    expect(selectorLines.length).toBeGreaterThan(0);
    const ungated = selectorLines.filter(sel =>
      !sel.includes("data-phoenix-ui-phase='a'") || !sel.includes("data-phoenix-visual='daylight'"),
    );
    expect(ungated).toEqual([]);
  });

  it('is a pure CSS file: no imports, no Supabase/RPC access, no CDN or external URL, no 100vw', () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toContain('supabase');
    expect(css).not.toContain('.rpc(');
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain('100vw');
  });

  it('uses only logical/keyword direction values, never a hardcoded left/right side', () => {
    expect(css).not.toMatch(/[^-](left|right)\s*:/);
  });

  it('uses design tokens (var(--...)) for every colour — no bespoke hex literal', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hexLiterals = withoutComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexLiterals).toEqual([]);
  });

  it('uses zero !important — every rule here is new and additive, nothing legacy to out-rank', () => {
    expect(css).not.toContain('!important');
  });

  it('reduced motion is inherited for free from the shared wildcard rule — no competing/duplicate media block here', () => {
    // phase-a-visual-convergence.css already pauses every animation/transition
    // under this SAME html[data-phoenix-ui-phase='a'][data-phoenix-visual=
    // 'daylight'] root via a universal descendant selector; this file's own
    // animated classes (.phoenix-supply-motif__route/__orbit) are descendants
    // of that same gated root, so they are covered without restating the query.
    expect(convergenceCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*html\[data-phoenix-ui-phase='a'\]\[data-phoenix-visual='daylight'\] \*\s*\{/,
    );
    expect(css).not.toMatch(/prefers-reduced-motion/);
  });

  it('does not embed the reference-board image, or any external image URL, in this file', () => {
    expect(css).not.toMatch(/data:image/);
    expect(css).not.toMatch(/reference-board|MediStock-Phoenix\.dc\.html/);
  });

  // ─── 2. The motif itself — original, dependency-free, no fetched asset ─────

  // ─── A7.2.3 · production photographic asset contract ──────────────────────
  // The hero is no longer inline SVG — it is real photography. These
  // assertions replace the "pure inline SVG" one for the same underlying
  // invariant: the hero must be LOCAL, never fetched from anywhere.

  it('the hero serves LOCAL build-hashed assets only — no external URL, CDN, runtime fetch or base64', () => {
    expect(motif).not.toMatch(/https?:\/\//);
    expect(motif).not.toMatch(/data:image/);
    expect(motif).not.toMatch(/fetch\(|XMLHttpRequest/);
    // Every source is a static import Vite resolves and hashes at build time.
    const imports = motif.match(/^import \w+ from '@\/assets\/auth-welcome\/[\w.-]+\.webp';$/gm) ?? [];
    expect(imports.length).toBe(6);
    expect(motif).toContain('aria-hidden="true"');
  });

  it('art direction is real: the portrait master serves phones, the landscape master serves desktop', () => {
    // A <source media> switch, so the unused master is never downloaded.
    expect(motif).toMatch(/<source\s[^>]*media="\(max-width: 900px\)"/);
    for (const m of ['mobile480', 'mobile720', 'mobile940']) expect(motif).toContain(m);
    for (const d of ['desktop960', 'desktop1280', 'desktop1536']) expect(motif).toContain(d);
    // The mobile srcSet must not reference a desktop master and vice versa.
    const mobileSource = motif.slice(motif.indexOf('max-width: 900px'), motif.indexOf('/>', motif.indexOf('max-width: 900px')));
    expect(mobileSource).not.toMatch(/desktop/);
  });

  it('declares responsive sizing and explicit intrinsic dimensions so the hero cannot shift layout', () => {
    expect(motif).toContain('srcSet');
    expect(motif).toContain('sizes=');
    expect(motif).toMatch(/width=\{[A-Z_]+\}/);
    expect(motif).toMatch(/height=\{[A-Z_]+\}/);
    expect(motif).toContain('decoding="async"');
  });

  it('the hero image files exist on disk, are WebP, and stay inside the agreed byte budget', () => {
    const dir = join(SRC, 'assets/auth-welcome');
    const budget: Record<string, number> = {
      'supply-desktop-1536.webp': 500_000,
      'supply-desktop-1280.webp': 350_000,
      'supply-desktop-960.webp': 300_000,
      'supply-mobile-940.webp': 400_000,
      'supply-mobile-720.webp': 280_000,
      'supply-mobile-480.webp': 180_000,
    };
    for (const [file, max] of Object.entries(budget)) {
      const p = join(dir, file);
      expect(existsSync(p), `${file} must exist`).toBe(true);
      const { size } = statSync(p);
      expect(size, `${file} is ${size} bytes, over its ${max} budget`).toBeLessThanOrEqual(max);
      // RIFF....WEBP magic — proves the extension is not lying about the codec.
      const head = readFileSync(p).subarray(0, 12).toString('latin1');
      expect(head.startsWith('RIFF') && head.includes('WEBP'), `${file} must be real WebP`).toBe(true);
    }
  });

  it('the retired vector hero components are gone, with no dangling reference left behind', () => {
    expect(existsSync(join(SRC, 'shared/ui/InstitutionalSupplyMotif.tsx'))).toBe(false);
    expect(existsSync(join(SRC, 'shared/ui/PharmaceuticalSupplyScene.tsx'))).toBe(false);
    expect(css).not.toMatch(/phoenix-supply-motif|pharma-scene/);
    expect(login).not.toMatch(/InstitutionalSupplyMotif|PharmaceuticalSupplyScene/);
    expect(welcome).not.toMatch(/InstitutionalSupplyMotif|PharmaceuticalSupplyScene/);
  });

  it('the brand mark delegates to the exact local raster emblem (A7.2.4 supersession)', () => {
    // A7.2.4 NARROWING (documented exclusion, guard never deleted):
    // MediStockMark no longer inlines its own SVG — it delegates to the
    // shared <PhoenixPharmacyEmblem> full variant (global brand rollout).
    expect(mark).not.toMatch(/<img\b/);
    expect(mark).not.toMatch(/https?:\/\//);
    expect(mark).toContain('PhoenixPharmacyEmblem');
    expect(mark).not.toMatch(/phoenix-icon|\.png|\.webp|\.avif/);
    const emblem = read('shared/ui/PhoenixPharmacyEmblem.tsx');
    expect(emblem).toContain('<img');
    expect(emblem).not.toContain('<svg');
    expect(emblem).toContain("variant = 'full'");
    expect(emblem).toContain("phoenix-pharmacy-full.png");
  });

  it('both auth screens render the scene in place of the retired Phoenix-bird photo AND the retired motif (A7.2.2)', () => {
    expect(login).toContain('AuthSupplyHero');
    expect(welcome).toContain('AuthSupplyHero');
    expect(login).not.toContain('/assets/phoenix/runtime/phoenix-login');
    expect(welcome).not.toContain('/assets/phoenix/runtime/phoenix-welcome-clean');
    expect(login).not.toContain('InstitutionalSupplyMotif');
    expect(welcome).not.toContain('InstitutionalSupplyMotif');
  });

  it('the auth identity mark is geometric, not the Phoenix bird — and the rest of the app is untouched (A7.2.2)', () => {
    expect(login).toContain('MediStockMark');
    expect(login).not.toContain('PhoenixMark');
    expect(welcome).toContain('MediStockMark');
    expect(read('shared/ui/PhoenixSidebar.tsx')).toContain('PhoenixMark');
    expect(read('shared/ui/PhoenixMobileDrawer.tsx')).toContain('PhoenixMark');
  });

  // ─── A7.2.2 · mandated Arabic copy correction ─────────────────────────────

  it('the auth headline says "من قسم الصيدلة", never "من المخزن المركزي" (A7.2.2)', () => {
    expect(login).toContain('منظومة الإمداد الدوائي — من قسم الصيدلة إلى منفذ الصرف.');
    expect(welcome).toContain('منظومة الإمداد الدوائي — من قسم الصيدلة إلى منفذ الصرف.');
    expect(login).not.toContain('من المخزن المركزي');
    expect(welcome).not.toContain('من المخزن المركزي');
  });

  it('the English headline is a natural translation, and no Arabic leaks into the English branch', () => {
    expect(login).toContain('Medication Supply Network — From the Pharmacy Department to the Dispensing Point.');
    expect(welcome).toContain('Medication Supply Network — From the Pharmacy Department to the Dispensing Point.');
    // The retired English copy referenced a "central store"; it must not linger.
    expect(login).not.toContain('central store');
  });

  // The copy fix is a MARKETING-COPY change on two screens only. Operational
  // central-warehouse terminology is business vocabulary and stays exactly as
  // it is — this guards against a careless global search-and-replace.
  it('operational central-warehouse terminology outside Login/Welcome is untouched (A7.2.2)', () => {
    expect(strings).toContain('مخازن قسم الصيدلة (مركزي)');
    expect(strings).toContain('المصدر (مركزي)');
    expect(strings).toContain('مشتريات مركزية');
    expect(strings).toContain('استرجاع مركزي');
    let diff = '';
    try {
      diff = execSync('git diff --name-only HEAD -- src/shared/i18n/strings.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  // ─── 3. No fabricated data, no invented functionality ──────────────────────

  it('Login shows zero internal KPIs — only descriptive, number-free trust text', () => {
    // The reference board's own numeric badges (99.9%, 2,500+, 1.2M, 98%) are
    // explicitly NOT reproduced — Login is public, pre-auth surface.
    for (const forbidden of ['99.9', '2,500', '2500', '1.2M', '98%']) {
      expect(login, `Login must not contain the design-reference number "${forbidden}"`).not.toContain(forbidden);
    }
    expect(login).not.toMatch(/\d[\d,.]*\s*%/);
    expect(login).not.toMatch(/\bKPI\b/i);
  });

  it('Welcome displays no counters at all — no source exists to safely authorize one yet', () => {
    // See the Real Counter Acceptance Table in the final report: NONE, by
    // design, because there is no existing authorized service/RPC boundary
    // this screen may call before/independent of role landing.
    expect(welcome).not.toMatch(/\d[\d,.]*\s*%/);
    expect(welcome).not.toMatch(/\bKPI\b/i);
    expect(welcome).not.toMatch(/Math\.random\(\)/);
  });

  it('neither screen fabricates SSO/OAuth buttons or support/certification claims that do not exist in the product', () => {
    for (const src of [login, welcome]) {
      expect(src).not.toMatch(/Google|Microsoft|\bSSO\b|OAuth|Sign in with/i);
      expect(src).not.toMatch(/certif|\bISO\b|support@|Support Phone/i);
    }
  });

  it('neither screen gained a direct Supabase/RPC call — real data still flows through the existing service boundary only', () => {
    for (const src of [login, welcome]) {
      expect(src).not.toContain('supabase.');
      expect(src).not.toMatch(/\.rpc\(/);
      expect(src).not.toMatch(/\.from\(['"]/);
    }
  });

  it('introduces no mock/demo/fixture value into a production component', () => {
    for (const src of [login, welcome, motif]) {
      expect(src).not.toMatch(/\bmock\b|\bdemo\b|\bfixture\b/i);
    }
  });

  // ─── 4. Handlers, session, permissions, routing — unchanged ───────────────

  it('sign-in, reset, and welcome-completion handlers are byte-for-byte present, unchanged', () => {
    expect(login).toContain('const res = await signIn(resolveLoginIdentifier(email), password);');
    expect(login).toContain('const res = await requestPasswordReset(email);');
    expect(login).toContain("res.error === 'NOT_CONFIGURED'");
    expect(welcome).toContain('const finish = useCallback(');
    expect(welcome).toContain('SEQUENCE_MS = 6000');
    expect(welcome).toContain('REDUCED_MS = 900');
  });

  it('AppContext session/permission/RBAC machinery is untouched — the only edit is the in-memory theme default', () => {
    const diff = (() => {
      try {
        return execSync('git diff -- src/app/AppContext.tsx', { cwd: ROOT, encoding: 'utf8' });
      } catch { return ''; }
    })();
    if (diff.trim()) {
      // Whatever the diff contains, it must never touch auth/session/RBAC surface.
      expect(diff).not.toMatch(/signIn|signOut|authz\.setContext|myPermissions|loadProfile|loadPermissions|onAuthChange|getSession/);
      expect(diff).not.toMatch(/localStorage|sessionStorage/);
    }
    // And the untouched machinery is still verifiably present verbatim.
    expect(appContext).toContain('const signIn = useCallback(async (email: string, password: string) => {');
    expect(appContext).toContain('await authSignOut();');
    expect(appContext).toContain('authz.setContext({');
    expect(appContext).toContain("const role: Role = profile?.role ?? 'outlet_officer';");
  });

  it('never touches routing, screen-ID registry, or role-landing destination', () => {
    const diff = (() => {
      try {
        return execSync(
          'git diff --name-only HEAD -- src/app/App.tsx src/app/AuthenticatedApp.tsx',
          { cwd: ROOT, encoding: 'utf8' },
        );
      } catch { return ''; }
    })();
    expect(diff.trim()).toBe('');
  });

  it('never touches a Supabase service, RPC call site, or migration file', () => {
    let svcDiff = '';
    let sqlDiff = '';
    try {
      svcDiff = execSync('git diff --name-only HEAD -- src/shared/supabase src/shared/authz', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    try {
      sqlDiff = execSync('git diff --name-only HEAD -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(svcDiff.trim()).toBe('');
    expect(sqlDiff.trim()).toBe('');
  });

  // ─── 5. Theme/language persistence contract ────────────────────────────────

  it('light is the default only because no saved-preference mechanism exists — no new persistence layer was added to override one', () => {
    expect(appContext).toContain("useState<Theme>('light')");
    // No storage key exists for either preference, before or after this phase —
    // "respect a saved preference" has nothing to override, and this phase
    // does not invent a mechanism that would need to.
    expect(appContext).not.toMatch(/localStorage|sessionStorage/);
    expect(main).not.toMatch(/localStorage|sessionStorage/);
  });

  it('language state and the toggle mechanism are unchanged (no parallel language state introduced)', () => {
    expect(appContext).toContain("const [lang, setLangState]   = useState<Lang>('ar');");
    expect(appContext).toContain("toggleLang  = () => setLangState(l => l === 'ar' ? 'en' : 'ar');");
    expect(appContext).toContain("toggleTheme = () => setThemeState(t => t === 'dark' ? 'light' : 'dark');");
  });

  it('index.html agrees with the light-first default at first paint, and leaves PWA meta (theme-color/manifest) untouched', () => {
    expect(indexHtml).toContain('data-theme="light"');
    // Deliberately out of scope for this presentation-only phase.
    expect(indexHtml).toContain('<meta name="theme-color" content="#07111F" />');
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it("Login's language/theme toggles remain the existing stable toolbar controls — no new control surface, no field reset on toggle", () => {
    expect(login).toContain('nexus-login__controls');
    expect(login).toContain('onClick={toggleLang}');
    expect(login).toContain('onClick={toggleTheme}');
    // The email/password fields are plain useState, entirely independent of
    // lang/theme — toggling either can never clear or remount them (verified
    // additionally via a live language-switch-with-values screenshot, see
    // docs/phoenix/visual-evidence/a72/login-language-switch-preserves-values-en-light-desktop.png).
    expect(login).toContain("const [email, setEmail] = useState('');");
    expect(login).toContain("const [password, setPassword] = useState('');");
  });

  // ─── 6. Dependency / hygiene ────────────────────────────────────────────────

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

  it('leaves the QA harness fixture files untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff --name-only HEAD -- src/features/qa/QaHarness.tsx src/features/qa/qaData.ts src/features/qa/qaFixtures.ts src/features/qa/qaFixtureClient.ts src/features/qa/qaScopes.ts src/features/qa/qaConfig.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('leaves no local QA-only env file and no other untracked temporary fixture in the committed tree', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- .env.local .env .env.*.local', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(status.trim()).toBe('');
  });

  it('never mutates real data from a visual-only source file (defence in depth)', () => {
    for (const src of [login, welcome, motif]) {
      expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    }
  });
});
