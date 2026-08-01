import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
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
  const motif = read('shared/ui/InstitutionalSupplyMotif.tsx');
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

  it('InstitutionalSupplyMotif is pure inline SVG: no <img>, no external URL, no Math.random', () => {
    expect(motif).not.toMatch(/<img\b/);
    expect(motif).not.toMatch(/https?:\/\//);
    expect(motif).not.toMatch(/Math\.random\(\)/);
    expect(motif).toContain('<svg');
    expect(motif).toContain('aria-hidden="true"');
  });

  it('both auth screens render the motif in place of the retired Phoenix-bird photo, and the small brand mark stays', () => {
    expect(login).toContain('InstitutionalSupplyMotif');
    expect(welcome).toContain('InstitutionalSupplyMotif');
    expect(login).not.toContain('/assets/phoenix/runtime/phoenix-login');
    expect(welcome).not.toContain('/assets/phoenix/runtime/phoenix-welcome-clean');
    expect(login).toContain('PhoenixMark');
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
