/**
 * AUTH-BRAND-ICON-MOBILE-LOGOUT-PASSKEY-A
 * Run: npm test -- --run
 *
 * Static source-code tests for:
 *  - professional PWA icon set (manifest + local, no external URLs)
 *  - login screen department subtitle replacing the old MASAR/network phrase
 *  - removal of the RLS / QR Public Safe / Intake Frozen technical badges
 *  - the new rights/supervision block on the login screen
 *  - mobile drawer logout access wired to the existing signOut/logout flow
 *  - no fake biometric/passkey login rendered anywhere
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const PUBLIC = join(__dirname, '../../../../public');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const loginScreen = readSrc('features/auth/LoginScreen.tsx');
const strings      = readSrc('shared/i18n/strings.ts');
const drawer        = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const appShell       = readSrc('shared/ui/PhoenixAppShell.tsx');
const globalCss      = readSrc('shared/lib/global.css');
const manifest       = readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8');
const indexHtml      = readFileSync(join(ROOT, 'index.html'), 'utf8');

describe('Professional PWA icon set', () => {
  it('app-icon.svg canonical vector source exists', () => {
    expect(existsSync(join(PUBLIC, 'app-icon.svg'))).toBe(true);
  });

  it('favicon.svg exists and index.html references it', () => {
    expect(existsSync(join(PUBLIC, 'favicon.svg'))).toBe(true);
    expect(indexHtml).toContain('href="/favicon.svg"');
  });

  it('PNG icon set was generated locally (Pillow, no new tooling)', () => {
    for (const name of ['pwa-icon-192.png', 'pwa-icon-512.png', 'pwa-icon-maskable-512.png', 'apple-touch-icon.png']) {
      const p = join(PUBLIC, name);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(0);
      expect(statSync(p).size).toBeLessThan(200_000);
    }
  });

  it('manifest.webmanifest points to the new PNG icons', () => {
    expect(manifest).toContain('/pwa-icon-192.png');
    expect(manifest).toContain('/pwa-icon-512.png');
    expect(manifest).toContain('/pwa-icon-maskable-512.png');
  });

  it('index.html references a real apple-touch-icon PNG', () => {
    expect(indexHtml).toContain('rel="apple-touch-icon"');
    expect(indexHtml).toContain('href="/apple-touch-icon.png"');
  });

  it('no icon references point to an external URL', () => {
    expect(manifest).not.toMatch(/https?:\/\//);
    expect(indexHtml).not.toMatch(/rel="(icon|apple-touch-icon|manifest)"[^>]*href="https?:\/\//);
  });
});

describe('Login screen: department subtitle replaces old MASAR/network phrase', () => {
  it('LoginScreen no longer renders the old tagline key', () => {
    expect(loginScreen).not.toContain("t('tagline'");
  });

  it('LoginScreen renders the new login_department_subtitle key', () => {
    expect(loginScreen).toContain("t('login_department_subtitle'");
  });

  it('login_department_subtitle is defined bilingually with the exact department phrase', () => {
    const line = strings.split('\n').find(l => l.includes('login_department_subtitle:'));
    expect(line).toContain('دائرة صحة بابل - قسم الصيدلة');
    expect(line).toContain('Babylon Health Directorate - Pharmacy Department');
  });

  it('no MASAR/network phrase variants remain in rendered login/shell UI', () => {
    // strings.ts intentionally keeps a code comment documenting the old
    // removed phrase for traceability (same convention as shell_brand_department
    // above it) — only rendered UI source is checked here, not comments.
    const haystacks = [loginScreen, indexHtml, drawer, appShell];
    const forbidden = [
      'شبكة توفر الصحة',
      'Health Supply Network',
      'MASAR Health Network',
    ];
    for (const hay of haystacks) {
      for (const phrase of forbidden) {
        expect(hay).not.toContain(phrase);
      }
    }
  });

  it('the old tagline key/value no longer exists in strings.ts', () => {
    expect(strings).not.toMatch(/^\s*tagline:/m);
  });

  it('product name MediStock-Babil is preserved on the login screen', () => {
    expect(loginScreen).toContain('MediStock-Babil');
  });
});

describe('Login screen: technical badges removed', () => {
  it('does not render the RLS badge', () => {
    expect(loginScreen).not.toContain('🛡 RLS');
    expect(loginScreen).not.toMatch(/>\s*RLS\s*</);
  });

  it('does not render the QR Public Safe badge', () => {
    expect(loginScreen).not.toContain('📱 QR Public Safe');
    expect(loginScreen).not.toContain('QR Public Safe');
  });

  it('does not render the Intake Frozen badge', () => {
    expect(loginScreen).not.toContain('🔒 Intake Frozen');
    expect(loginScreen).not.toContain('Intake Frozen');
  });

  it('no premium-status-badge trust-badge row remains on the login screen', () => {
    expect(loginScreen).not.toContain('premium-status-badge');
  });
});

describe('Login screen: professional rights/supervision block', () => {
  it('renders the rights code and supervision line via i18n keys', () => {
    expect(loginScreen).toContain("t('login_rights_code'");
    expect(loginScreen).toContain("t('login_supervision_line'");
  });

  it('login_rights_code contains the exact required text', () => {
    const line = strings.split('\n').find(l => l.includes('login_rights_code:'));
    expect(line).toContain('ph.Abdallahjawadk@2026');
  });

  it('login_supervision_line contains the exact required Arabic text', () => {
    const line = strings.split('\n').find(l => l.includes('login_supervision_line:'));
    expect(line).toContain('بأشراف الصيدلاني باسم كاظم رمح');
  });

  it('rights block uses a dedicated, styled CSS class (not a security-internals badge)', () => {
    expect(loginScreen).toContain('premium-login__rights');
    expect(globalCss).toContain('.premium-login__rights');
  });
});

describe('Mobile logout access', () => {
  it('PhoenixMobileDrawer accepts an onLogout prop', () => {
    expect(drawer).toContain('onLogout');
  });

  it('drawer renders the Sign out / تسجيل الخروج label via i18n', () => {
    expect(drawer).toContain("t('auth_sign_out'");
  });

  it('auth_sign_out is defined bilingually with the exact requested labels', () => {
    const line = strings.split('\n').find(l => l.includes('auth_sign_out:'));
    expect(line).toContain('تسجيل الخروج');
    expect(line).toContain('Sign out');
  });

  it('drawer logout button meets the 44px touch-target minimum', () => {
    expect(drawer).toMatch(/premium-drawer-logout[\s\S]{0,400}minHeight: '44px'/);
  });

  it('drawer calls onLogout (existing signOut flow) and closes the drawer on click', () => {
    expect(drawer).toMatch(/onClick=\{[^}]*onLogout\(\)[^}]*onClose\(\)[^}]*\}/);
  });

  it('PhoenixAppShell wires onLogout through to PhoenixMobileDrawer', () => {
    expect(appShell).toMatch(/<PhoenixMobileDrawer[\s\S]*?onLogout=\{onLogout\}/);
  });

  it('PhoenixAppShell (and therefore the mobile drawer) is never rendered for LoginScreen/PublicQrScreen', () => {
    // QR-BUNDLE-CODE-SPLIT-A: PublicQrScreen (App.tsx) and the authenticated
    // app (LoginScreen + PhoenixAppShell, now in AuthenticatedApp.tsx) are
    // two separate lazy-loaded branches — they structurally can never render
    // in the same tree, which is a stronger guarantee than the old ordering
    // check within a single file.
    const app = readSrc('app/App.tsx');
    const authenticatedApp = readSrc('app/AuthenticatedApp.tsx');
    expect(app).toContain('<PublicQrScreen');
    expect(app).toContain('<AuthenticatedApp');
    const loginIdx = authenticatedApp.indexOf('return <LoginScreen');
    const shellIdx = authenticatedApp.indexOf('<PhoenixAppShell');
    expect(loginIdx).toBeGreaterThan(-1);
    expect(shellIdx).toBeGreaterThan(-1);
    expect(shellIdx).toBeGreaterThan(loginIdx);
  });

  it('does not expose session/profile internals in the logout control itself', () => {
    expect(drawer).not.toMatch(/premium-drawer-logout[\s\S]{0,200}profile\./);
  });
});

describe('Biometric / WebAuthn: honest audit, no fake login', () => {
  it('no navigator.credentials / PublicKeyCredential calls exist anywhere in src', () => {
    // Full sweep intentionally not limited to auth files — a real backend
    // does not exist yet (no WebAuthn routes/tables/edge functions found),
    // so no frontend WebAuthn call sites should exist either.
    const files = [loginScreen, strings, drawer, appShell];
    for (const f of files) {
      expect(f).not.toMatch(/navigator\.credentials\.(get|create)/);
      expect(f).not.toContain('PublicKeyCredential');
    }
  });

  it('LoginScreen does not render an active biometric/passkey sign-in button', () => {
    expect(loginScreen).not.toContain("t('auth_passkey_title'");
    expect(loginScreen).not.toMatch(/fingerprint|Face ID|بصمة/i);
  });

  it('passkey readiness copy exists in i18n for a future WEBAUTHN-PASSKEY-B phase but is not wired into any screen', () => {
    for (const key of [
      'auth_passkey_title', 'auth_passkey_description',
      'auth_passkey_unavailable', 'auth_passkey_secure_context_required',
    ]) {
      expect(strings).toContain(`${key}:`);
    }
  });
});

describe('Safety guards', () => {
  it('no service_role/auth.admin usage introduced', () => {
    for (const f of [loginScreen, drawer, appShell, strings]) {
      expect(f).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|serviceRole|auth\.admin/);
    }
  });

  it('no password/secret/biometric data written to localStorage or sessionStorage', () => {
    for (const f of [loginScreen, drawer, appShell]) {
      expect(f).not.toMatch(/(local|session)Storage\.setItem\([^)]*(password|secret|token|fingerprint|face|biometric)/i);
    }
  });

  it('no Excel/XLSX import libraries introduced', () => {
    for (const f of [loginScreen, drawer, appShell]) {
      expect(f).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
    }
  });
});
