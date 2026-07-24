/**
 * PWA-INSTALL-PROMPT-A
 * Run: npm test -- --run
 *
 * Static source-code tests for the PWA install feature: manifest, service
 * worker, install-prompt hook/component, i18n strings, and app-shell
 * integration. No live DB/browser required.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../');
const readRoot = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const manifestPath = join(ROOT, 'public/manifest.webmanifest');
const swPath = join(ROOT, 'public/sw.js');
const indexHtmlPath = join(ROOT, 'index.html');

describe('Web App Manifest', () => {
  it('public/manifest.webmanifest exists', () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  it('has the required identity fields', () => {
    expect(manifest.name).toBe('MediStock-Babil Phoenix');
    expect(manifest.short_name).toBe('MediStock');
    expect(manifest.description).toBe('Bilingual medical supply and institution alert management platform');
  });

  it('has lang=ar-IQ and dir=rtl', () => {
    expect(manifest.lang).toBe('ar-IQ');
    expect(manifest.dir).toBe('rtl');
  });

  it('has start_url and scope set to root', () => {
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('has display=standalone and orientation=any', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('any');
  });

  it('uses the current premium background/theme colors (not placeholders)', () => {
    // Dark-first Phoenix art direction: the PWA chrome matches --bg so the
    // splash and title bar do not flash the retired light teal.
    expect(manifest.background_color).toBe('#07111F');
    expect(manifest.theme_color).toBe('#07111F');
  });

  it('has the required categories', () => {
    expect(manifest.categories).toEqual(expect.arrayContaining(['medical', 'productivity', 'business']));
  });

  it('has 192x192, 512x512, and a maskable icon', () => {
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    const purposes = manifest.icons.map((i: { purpose?: string }) => i.purpose);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(purposes).toContain('maskable');
  });

  it('icon files referenced by the manifest actually exist locally (no external URLs)', () => {
    manifest.icons.forEach((icon: { src: string }) => {
      expect(icon.src).toMatch(/^\//);
      expect(icon.src).not.toMatch(/^https?:\/\//);
      expect(existsSync(join(ROOT, 'public', icon.src.replace(/^\//, '')))).toBe(true);
    });
  });
});

describe('index.html PWA wiring', () => {
  const html = readFileSync(indexHtmlPath, 'utf8');

  it('links the manifest', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('sets theme-color to the Phoenix ground colour', () => {
    expect(html).toContain('<meta name="theme-color" content="#07111F" />');
  });

  it('sets apple-mobile-web-app-capable, title, and status-bar-style', () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="MediStock" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
  });

  it('keeps the viewport meta correct (MOBILE-SCROLL-OWNER-HOTFIX-A: safe-area + keyboard-resize aware)', () => {
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />',
    );
  });

  it('still loads /src/main.tsx as the module entry (Vite not broken)', () => {
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });
});

describe('Service worker', () => {
  it('public/sw.js exists', () => {
    expect(existsSync(swPath)).toBe(true);
  });

  const sw = readFileSync(swPath, 'utf8');

  it('uses a versioned cache name', () => {
    expect(sw).toMatch(/CACHE_VERSION\s*=\s*'medistock-shell-v\d+'/);
  });

  it('cleans up old caches on activate', () => {
    expect(sw).toContain("addEventListener('activate'");
    expect(sw).toContain('caches.delete(key)');
    expect(sw).toContain('key !== CACHE_VERSION');
  });

  it('never intercepts Supabase/REST/RPC/Auth/Storage requests', () => {
    expect(sw).toContain('.supabase.co');
    expect(sw).toContain("'/rest/v1'");
    expect(sw).toContain("'/auth/v1'");
    expect(sw).toContain("'/rpc/'");
    expect(sw).toContain("'/storage/v1'");
    expect(sw).toContain('isSupabaseOrApiRequest(url)) return');
  });

  it('only handles GET requests (never intercepts writes)', () => {
    expect(sw).toContain("request.method !== 'GET'");
  });

  it('only handles same-origin requests', () => {
    expect(sw).toContain('url.origin !== self.location.origin');
  });

  it('uses network-first with cache fallback (never serves stale-first)', () => {
    const fetchBlock = sw.slice(sw.indexOf("addEventListener('fetch'"));
    expect(fetchBlock).toMatch(/fetch\(request\)\s*\n\s*\.then/);
    expect(fetchBlock).toContain('.catch(() => caches.match(request))');
  });
});

describe('Service worker registration', () => {
  const regPath = join(ROOT, 'src/shared/pwa/registerServiceWorker.ts');
  const reg = readFileSync(regPath, 'utf8');

  it('exists and exports registerServiceWorker', () => {
    expect(existsSync(regPath)).toBe(true);
    expect(reg).toContain('export function registerServiceWorker');
  });

  it('never registers during local dev (import.meta.env.DEV guard)', () => {
    expect(reg).toContain('import.meta.env.DEV');
  });

  it('guards for serviceWorker support before registering', () => {
    expect(reg).toContain("'serviceWorker' in navigator");
  });

  it('registration failure is caught, not thrown (never crashes the app)', () => {
    expect(reg).toMatch(/\.register\('\/sw\.js'\)\s*\n?\s*\.catch/);
  });

  it('logs only a minimal warning, no secrets or request bodies', () => {
    expect(reg).toContain('console.warn');
    expect(reg).not.toContain('SUPABASE_SERVICE_ROLE');
    expect(reg).not.toContain('anon_key');
  });

  it('main.tsx calls registerServiceWorker()', () => {
    const main = readRoot('src/main.tsx');
    expect(main).toContain("import { registerServiceWorker } from '@/shared/pwa/registerServiceWorker'");
    expect(main).toContain('registerServiceWorker();');
  });
});

describe('usePwaInstallPrompt hook', () => {
  const hookPath = join(ROOT, 'src/shared/pwa/usePwaInstallPrompt.ts');
  const hook = readFileSync(hookPath, 'utf8');

  it('listens for beforeinstallprompt and calls preventDefault', () => {
    expect(hook).toContain("addEventListener('beforeinstallprompt'");
    expect(hook).toContain('event.preventDefault()');
  });

  it('stores the deferred prompt event', () => {
    expect(hook).toContain('setDeferredPrompt(event as BeforeInstallPromptEvent)');
  });

  it('promptInstall calls deferredPrompt.prompt() and awaits userChoice', () => {
    expect(hook).toContain('await deferredPrompt.prompt()');
    expect(hook).toContain('await deferredPrompt.userChoice');
  });

  it('listens for appinstalled and marks installed/hides the prompt', () => {
    expect(hook).toContain("addEventListener('appinstalled'");
    expect(hook).toContain('setInstalled(true)');
    expect(hook).toContain('setDeferredPrompt(null)');
  });

  it('detects standalone mode via matchMedia and iOS navigator.standalone', () => {
    expect(hook).toContain("matchMedia('(display-mode: standalone)')");
    expect(hook).toContain('.standalone === true');
  });

  it('persists dismissal in localStorage with a 7-day cooldown', () => {
    expect(hook).toContain('localStorage.setItem(DISMISS_STORAGE_KEY');
    expect(hook).toMatch(/DISMISS_COOLDOWN_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('does not show anything once installed/standalone is detected', () => {
    expect(hook).toContain('!installed');
  });

  it('detects likely iOS Safari conservatively (excludes CriOS/FxiOS/EdgiOS/OPiOS)', () => {
    expect(hook).toContain('isLikelyIosSafari');
    expect(hook).toContain('CriOS|FxiOS|EdgiOS|OPiOS');
  });
});

describe('PwaInstallPrompt component', () => {
  const componentPath = join(ROOT, 'src/shared/pwa/PwaInstallPrompt.tsx');
  const component = readFileSync(componentPath, 'utf8');

  it('renders nothing when neither native install nor iOS instructions apply', () => {
    expect(component).toMatch(/if \(!canInstallNative && !showIosInstructions\) return null;/);
  });

  it('the Install button calls promptInstall()', () => {
    expect(component).toContain('void promptInstall()');
  });

  it('the dismiss/later button calls dismiss()', () => {
    expect(component).toContain('onClick={dismiss}');
  });

  it('shows the iOS fallback instruction text when native install is unavailable', () => {
    expect(component).toContain("t('pwa_install_ios_instruction', lang)");
  });

  it('uses the premium-pwa-install class and mobile/desktop placement', () => {
    expect(component).toContain('premium-pwa-install');
    expect(component).toMatch(/data-placement=\{isMobile \? 'mobile' : 'desktop'\}/);
  });
});

describe('i18n strings for the install prompt', () => {
  const strings = readRoot('src/shared/i18n/strings.ts');

  const REQUIRED_KEYS = [
    'pwa_install_title',
    'pwa_install_description',
    'pwa_install_install',
    'pwa_install_later',
    'pwa_install_ios_instruction',
    'pwa_install_dismiss_label',
  ];

  REQUIRED_KEYS.forEach(key => {
    it(`defines '${key}' bilingually`, () => {
      const line = strings.split('\n').find(l => l.trim().startsWith(`${key}:`));
      expect(line).toBeTruthy();
      expect(line).toMatch(/ar: '[^']+'/);
      expect(line).toMatch(/en: '[^']+'/);
    });
  });

  it('the iOS instruction text matches the exact requested Arabic/English phrasing', () => {
    const line = strings.split('\n').find(l => l.includes('pwa_install_ios_instruction:'));
    expect(line).toContain('لتثبيت التطبيق على الهاتف، افتح قائمة المشاركة ثم اختر "إضافة إلى الشاشة الرئيسية".');
    expect(line).toContain('To install the app, open the Share menu and choose "Add to Home Screen".');
  });

  it('does not mix Arabic and English within any single pwa_install_* string value (aside from the MediStock brand name, which stays in Latin script by the same convention used throughout the app)', () => {
    const pwaLines = strings.split('\n').filter(l => /^\s*pwa_install_/.test(l));
    pwaLines.forEach(line => {
      const arMatch = line.match(/ar: '([^']+)'/);
      const enMatch = line.match(/en: '([^']+)'/);
      if (arMatch) expect(arMatch[1].replace('MediStock', '')).not.toMatch(/[a-zA-Z]{2,}/);
      if (enMatch) expect(enMatch[1]).not.toMatch(/[؀-ۿ]/);
    });
  });
});

describe('App shell integration', () => {
  const appShell = readRoot('src/shared/ui/PhoenixAppShell.tsx');

  it('imports and renders PwaInstallPrompt', () => {
    expect(appShell).toContain("import { PwaInstallPrompt } from '@/shared/pwa/PwaInstallPrompt'");
    expect(appShell).toContain('<PwaInstallPrompt isMobile={isMobile} />');
  });

  it('is not rendered on the login screen or public QR view (AppShell mounts only post-auth)', () => {
    const loginScreen = readRoot('src/features/auth/LoginScreen.tsx');
    const publicQrScreen = readRoot('src/features/qr/PublicQrScreen.tsx');
    expect(loginScreen).not.toContain('PwaInstallPrompt');
    expect(publicQrScreen).not.toContain('PwaInstallPrompt');
  });
});

describe('No forbidden content or scope creep', () => {
  // strings.ts is a large pre-existing shared file that legitimately contains
  // unrelated legacy wording (e.g. the material-alert-engine's 'opportunity'/
  // 'suggested_action' keys, documented and guarded in earlier phases) — this
  // phase only added the new pwa_install_* block, so guardrails below scope
  // to that new block rather than the whole file.
  const stringsFile = readRoot('src/shared/i18n/strings.ts');
  const pwaStringsBlock = stringsFile.slice(
    stringsFile.indexOf('/* ── PWA install prompt'),
    stringsFile.indexOf('/* ── Status ── */'),
  );

  const touchedFiles = [
    'index.html',
    'src/main.tsx',
    'src/shared/pwa/registerServiceWorker.ts',
    'src/shared/pwa/usePwaInstallPrompt.ts',
    'src/shared/pwa/PwaInstallPrompt.tsx',
    'src/shared/ui/PhoenixAppShell.tsx',
    'src/shared/lib/global.css',
    'public/sw.js',
    'public/manifest.webmanifest',
  ].map(readRoot).concat(pwaStringsBlock);

  it('no supply_type anywhere', () => {
    touchedFiles.forEach(f => expect(f).not.toContain('supply_type'));
  });

  it('no suggestion/recommendation/opportunity/اقتراح/فرصة wording', () => {
    touchedFiles.forEach(f => {
      expect(f.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
      expect(f).not.toContain('اقتراح');
      expect(f).not.toContain('فرصة');
    });
  });

  it('no service_role or auth.admin', () => {
    touchedFiles.forEach(f => {
      expect(f).not.toContain('service_role');
      expect(f).not.toMatch(/auth\.admin/);
    });
  });

  it('no Excel/XLSX import', () => {
    touchedFiles.forEach(f => expect(f).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i));
  });

  it('no quantity-movement calls or direct item_availability quantity writes', () => {
    touchedFiles.forEach(f => {
      expect(f).not.toContain('phoenix_apply_availability_movement');
      expect(f).not.toMatch(/UPDATE\s+(public\.)?item_availability\s+SET\s+quantity/i);
    });
  });

  it('no direct lifecycle table access', () => {
    touchedFiles.forEach(f => {
      expect(f).not.toMatch(/supabase\.from\(['"]inter_org_alert_states['"]/);
      expect(f).not.toMatch(/supabase\.from\(['"]inter_org_alert_events['"]/);
    });
  });

  it('no direct organizations/distribution_points query introduced', () => {
    touchedFiles.forEach(f => {
      expect(f).not.toMatch(/supabase\.from\(['"]organizations['"]/);
      expect(f).not.toMatch(/supabase\.from\(['"]distribution_points['"]/);
    });
  });

  it('no package.json runtime dependency changes beyond the explicitly approved additions (exceljs, self-hosted W1 fonts, and the cinematic WebGL stack), checked structurally, not just diff', () => {
    const pkg = JSON.parse(readRoot('package.json'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      // W1: self-hosted variable fonts replacing the external Google Fonts CDN
      // (CSP font-src 'self'). Weight-axis only; bundled by Vite.
      // The Phoenix design source's families. Inter has a variable build;
      // IBM Plex Sans Arabic does not, so its four design weights are static.
      '@fontsource-variable/inter', '@fontsource/ibm-plex-sans-arabic',
      // Superseded by the two above; removed in the Phase G cleanup once no
      // import remains. Listed here so this guard stays exact, not loosened.
      '@fontsource-variable/dm-sans', '@fontsource-variable/noto-sans-arabic',
      // Cinematic redesign: the real WebGL Phoenix stack. React-18-compatible
      // and lazy/code-split — enforced by tests/webgl-deps-contract.test.ts and
      // src/shared/ui/__tests__/premium-visual-system.test.ts (isolated to
      // src/shared/webgl/**). Asset/capture tooling (sharp, playwright-core)
      // lives in devDependencies, not here.
      '@react-three/fiber', 'three',
      // SECURITY: react-router pinned as a direct (exact-version) dependency
      // alongside react-router-dom so both upgrade together — see
      // tests/navigation-open-redirect-guard.test.ts. react-router-dom pulls
      // it in as a transitive dep regardless; pinning it directly stops the
      // two ever drifting to different resolved versions.
      '@supabase/supabase-js', 'exceljs', 'qrcode', 'react', 'react-dom', 'react-router', 'react-router-dom',
      // PHARMA-OCR-A: browser-local OCR engine. Loaded ONLY through a dynamic
      // import after the operator chooses to scan a document — verified absent
      // from the entry chunks by ocr-safety-invariants.test.ts. Its worker,
      // WASM and trained data are self-hosted under /assets/ocr (no CDN), and
      // no image or extracted text ever leaves the device.
      'tesseract.js',
    ].sort());
  });

  it('the OCR engine is never a static import, so it cannot enter a critical chunk', () => {
    // The dependency above is only acceptable because it is dynamically loaded.
    // This pins that condition at the point the dependency is approved.
    const staticImports = touchedFiles.filter(f => /^import[^\n]*'tesseract\.js'/m.test(f));
    expect(staticImports).toHaveLength(0);
  });
});

describe('premium-preview.html is untouched by this phase', () => {
  it('is not referenced by any PWA file', () => {
    const swContent = readFileSync(swPath, 'utf8');
    const manifestContent = readFileSync(manifestPath, 'utf8');
    expect(swContent).not.toContain('premium-preview');
    expect(manifestContent).not.toContain('premium-preview');
  });
});
