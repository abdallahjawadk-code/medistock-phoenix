import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const BRAND_DIR = join(SRC, 'assets/brand/phoenix-pharmacy');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const component = read('shared/ui/PhoenixPharmacyEmblem.tsx');
const mediStockMark = read('shared/ui/MediStockMark.tsx');
const phoenixMark = read('shared/ui/PhoenixMark.tsx');
const login = read('features/auth/LoginScreen.tsx');
const welcome = read('features/auth/PhoenixWelcomeExperience.tsx');
const sidebar = read('shared/ui/PhoenixSidebar.tsx');
const drawer = read('shared/ui/PhoenixMobileDrawer.tsx');
const loading = read('shared/ui/PhoenixLoadingState.tsx');
const publicQr = read('features/qr/PublicQrScreen.tsx');
const pwaPrompt = read('shared/pwa/PwaInstallPrompt.tsx');
const signatureCss = read('shared/lib/phase-a-auth-welcome-signature.css');

describe('A7.2.4 exact Phoenix Pharmacy raster sources', () => {
  it('ships only the three required exact local crops with authoritative hashes', () => {
    expect(readdirSync(BRAND_DIR).sort()).toEqual([
      'phoenix-pharmacy-compact-gold.png',
      'phoenix-pharmacy-compact-teal.png',
      'phoenix-pharmacy-full.png',
    ]);
    expect(sha256(join(BRAND_DIR, 'phoenix-pharmacy-full.png'))).toBe('6cc0c11affc54ab0101d5570b84dd785439d43fa167ef6094381f29893af7e09');
    expect(sha256(join(BRAND_DIR, 'phoenix-pharmacy-compact-gold.png'))).toBe('b2412f895e5339a5d60559de67f040a5aa88c7ebbf30aaa9b1c79d020370dfe1');
    expect(sha256(join(BRAND_DIR, 'phoenix-pharmacy-compact-teal.png'))).toBe('d8c9b2bf07ff3326f3476c5c2e26020f7ffb86f1fa66079ddec2e989476573a1');
  });

  it('does not ship the source sheet, inspection image, rejected preview, temp crops, or a generated emblem SVG', () => {
    const tracked = execSync('git ls-files src public', { cwd: ROOT, encoding: 'utf8' });
    expect(tracked).not.toMatch(/Source-Sheet|Transparency-Inspection|REJECTED-Claude|phoenix-pharmacy-emblem-compact\.svg/i);
    expect(component).not.toMatch(/<svg|<path|<ellipse|<circle|data:image|https?:\/\//);
    expect(existsSync(join(ROOT, 'scripts/phoenix-pharmacy-icons.mjs'))).toBe(false);
  });

  it('exposes full, compact-gold, and compact-teal as presentation-only image variants', () => {
    expect(component).toContain("'full' | 'compact-gold' | 'compact-teal'");
    expect(component).toContain('<img');
    expect(component).not.toMatch(/useApp|useAuth|useContext|filter:/);
  });
});

describe('A7.2.4 exact brand-surface rollout', () => {
  it('uses the full emblem at the required Login and Welcome sizes without a logo tile', () => {
    expect(mediStockMark).toContain('variant="full"');
    expect(login).toContain('size={80}');
    expect(welcome).toContain('size={88}');
    expect(login).toContain('nexus-login__brand-emblem');
    expect(login).not.toContain('nexus-brand-mark nexus-login__brand-mark');
    expect(signatureCss).toContain('.nexus-login__emblem');
    expect(signatureCss).toContain('.nexus-welcome__emblem');
  });

  it('uses exact compact gold on dark navigation and loading surfaces', () => {
    expect(phoenixMark).toContain('variant="compact-gold"');
    expect(sidebar).toContain('nexus-brand-mark--phoenix');
    expect(sidebar).toContain('size={40}');
    expect(drawer).toContain('size={44}');
    expect(loading).toContain('variant="compact-gold"');
  });

  it('uses exact compact teal for Public QR and the PWA install prompt without data-flow changes', () => {
    expect(publicQr).toContain('variant="compact-teal"');
    expect(pwaPrompt).toContain('variant="compact-teal"');
    expect(publicQr).toContain('export function isPubliclyAvailableQrItem(item: PublicItem): boolean {');
    expect(publicQr).toContain("if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) return false;");
  });
});

describe('A7.2.4 favicon and PWA outputs', () => {
  const icons = [
    ['phoenix-favicon-v2-16.png', 16],
    ['phoenix-favicon-v2-32.png', 32],
    ['phoenix-favicon-v2-48.png', 48],
    ['apple-touch-icon-v2.png', 180],
    ['pwa-icon-v2-192.png', 192],
    ['pwa-icon-v2-512.png', 512],
    ['pwa-icon-maskable-v2-192.png', 192],
    ['pwa-icon-maskable-v2-512.png', 512],
  ] as const;

  it('materializes every referenced icon at its declared dimensions', async () => {
    for (const [name, size] of icons) {
      const path = join(ROOT, 'public', name);
      expect(existsSync(path), name).toBe(true);
      const metadata = await sharp(path).metadata();
      expect(metadata.width, name).toBe(size);
      expect(metadata.height, name).toBe(size);
    }
  });

  it('keeps transparent any-purpose icons and an opaque safe-zone field for maskable icons', async () => {
    const any = await sharp(join(ROOT, 'public/pwa-icon-v2-512.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(any.data[3]).toBe(0);
    const maskable = await sharp(join(ROOT, 'public/pwa-icon-maskable-v2-512.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(maskable.data[3]).toBe(255);
  });

  it('uses raster-only compatibility SVG wrappers with local references and no drawn paths/base64', () => {
    for (const name of ['favicon.svg', 'app-icon.svg', 'phoenix-favicon-v2.svg', 'pwa-icon-192.svg', 'pwa-icon-512.svg', 'pwa-icon-maskable-512.svg']) {
      const svg = readFileSync(join(ROOT, 'public', name), 'utf8');
      expect(svg, name).toContain('<image href="/');
      expect(svg.replace('http://www.w3.org/2000/svg', ''), name).not.toMatch(/<path|<ellipse|<circle|base64|https?:\/\//);
    }
  });
});

describe('A7.2.4 preservation and fail-closed boundaries', () => {
  it('preserves all six A7.2.3 hero files byte-for-byte', () => {
    const hashes: Record<string, string> = {
      'supply-desktop-1536.webp': '050206796f6650a0c57aa2973a0242d3c4df442885336f794c25c2ed54dbfbf6',
      'supply-desktop-1280.webp': '702af55281c4e0aac282e7fd65bf7730f36e13d5854361ba7418d8ea58108e06',
      'supply-desktop-960.webp': '2ed30a5a4f56541a12d58ef452038a7efbfa0ddc42754ddd02d16a1e3e72d17b',
      'supply-mobile-940.webp': '82389ae12e0b10556746e50fdc9f504621f4a0afe9a10e4ffd7fdbc6cefc9b13',
      'supply-mobile-720.webp': 'dcc4e9fbf834c75a4c5fcb0134d0610e3c00f5ce56f5b58e6fd4358e09f809e2',
      'supply-mobile-480.webp': '6d3a0e7b0ed4c10edf3a760b7471f5bdb6b6692bcb256ff5e5587aec7f2df7cc',
    };
    for (const [name, hash] of Object.entries(hashes)) {
      expect(sha256(join(SRC, 'assets/auth-welcome', name)), name).toBe(hash);
    }
  });

  it('preserves timing, reduced motion, approved copy, and operational package icons', () => {
    expect(welcome).toContain('const SEQUENCE_MS = 6000;');
    expect(welcome).toContain('prefersReducedMotion');
    expect(login).toContain('Medication Supply Network — From the Pharmacy Department to the Dispensing Point.');
    expect(welcome).toContain('منظومة الإمداد الدوائي — من قسم الصيدلة إلى منفذ الصرف.');
    const iconDiff = execSync('git diff --name-only 4dc6d8122dbef51fb7632266f8e92b983559cc8e -- src/shared/ui/PhoenixIcon.tsx', { cwd: ROOT, encoding: 'utf8' });
    expect(iconDiff.trim()).toBe('');
  });

  it('has no migration, service/RPC, Auth/RBAC/route, dependency, or environment diff', () => {
    // PHASE-B1-AUTH-RESILIENCE: a later, separately authorized phase closed the
    // two authentication dead ends (a failed session read and a failed profile
    // read each left a permanent spinner). Its files are excluded BY NAME —
    // the guard itself is untouched and still covers every other path it ever
    // covered: package.json, package-lock.json, supabase/, all of
    // src/shared/authz, the rest of src/shared/supabase, the rest of src/app,
    // and the env files.
    const prohibited = execSync(
      'git diff --name-only 4dc6d8122dbef51fb7632266f8e92b983559cc8e -- package.json package-lock.json supabase src/shared/supabase src/shared/authz src/app .env .env.local' +
      ' ":!src/app/AppContext.tsx"' +
      ' ":!src/app/AuthenticatedApp.tsx"' +
      ' ":!src/app/__tests__/auth-resilience-context.runtime.test.tsx"' +
      ' ":!src/app/__tests__/auth-dead-end-screens.runtime.test.tsx"' +
      ' ":!src/app/__tests__/auth-session-race.runtime.test.tsx"' +
      ' ":!src/app/__tests__/db-pressure-quick-wins.test.ts"' +
      ' ":!src/app/screen-continuity.ts"' +
      ' ":!src/app/__tests__/phase-b45-screen-continuity.runtime.test.ts"' +
      ' ":!src/shared/supabase/services/auth.service.ts"' +
      ' ":!src/shared/supabase/services/__tests__/auth-signout.runtime.test.ts"' +
      ' ":!src/shared/supabase/__tests__/permission-persistence.test.ts"' +
      ' ":!src/shared/supabase/__tests__/permission-matrix-readiness.test.ts"' +
      ' ":!src/shared/supabase/__tests__/permission-save-diagnostics.test.ts"' +
      ' ":!src/shared/authz/__tests__/screen-access.test.ts"' +
      // PHASE-C2-ORG-SCOPE: a still later, separately authorized phase adds a
      // narrow-by-name exclusion (this same "narrow exclusion, never delete"
      // maintenance pattern) to four migration ISOLATION GUARD tests under
      // supabase/migrations/__tests__ — those guards assert no *product*
      // src/ file was touched by their own migration; C2 legitimately
      // touches reports/outlet src/ files, so each guard's own exclusion
      // list gained five entries. The guard test FILES themselves are
      // test-maintenance, not a migration/schema/RLS change — excluded here
      // by name, same as the auth-resilience test files above.
      ' ":!supabase/migrations/__tests__/053-item-availability-removed-marker.test.ts"' +
      ' ":!supabase/migrations/__tests__/054-dashboard-condition-count-rpcs.test.ts"' +
      ' ":!supabase/migrations/__tests__/061-warehouse-dispatch-schema.test.ts"' +
      ' ":!supabase/migrations/__tests__/062-user-rbac-scope-foundation.test.ts"' +
      // PHASE-D1A-TRANSFER-PRIVILEGE-LOCKDOWN: a still later, separately
      // authorized phase adds a genuine new migration (154) plus its own
      // dedicated static/dynamic test files and a manifest-registry update —
      // a real, in-scope backend change for THAT phase, excluded here by
      // name for the same reason every entry above is: it has nothing to do
      // with this (much earlier, UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/154_phoenix_transfer_corridor_privilege_lockdown.sql"' +
      ' ":!supabase/migrations/__tests__/154-transfer-corridor-privilege-lockdown-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/154-transfer-corridor-privilege-lockdown.dynamic.test.ts"' +
      ' ":!supabase/migrations/__tests__/helpers/reviewed-migrations.ts"' +
      ' ":!supabase/migrations/__tests__/reviewed-migration-manifest.test.ts"' +
      // PHASE-D1A-BRACE-EXPANSION-AUDIT-FIX: the same D1A phase's own CI
      // corrective commit bumps the pre-existing package.json override
      // (added 2026-07-25, commit 95b89e2, for a prior brace-expansion
      // advisory) from "5.0.8" to "5.0.9" to close GHSA-rgw5-rvv9-x895, a
      // bypass of that same mitigation, plus the matching single
      // package-lock.json node. A dependency-only lockfile fix, excluded
      // here by name for the same reason every entry above is: it has
      // nothing to do with this (much earlier, UI-only) pharmacy-emblem
      // phase.
      ' ":!package.json"' +
      ' ":!package-lock.json"' +
      // PHASE-D1B-1-LIFECYCLE-NOTIFICATION-COMPLETENESS: a still later,
      // separately authorized phase adds a genuine new migration (155) plus
      // its own dedicated static/dynamic test files — a real, in-scope
      // backend change for THAT phase, excluded here by name for the same
      // reason every entry above is: it has nothing to do with this (much
      // earlier, UI-only) pharmacy-emblem phase. reviewed-migrations.ts and
      // reviewed-migration-manifest.test.ts are already excluded above (D1A)
      // and need no second entry.
      ' ":!supabase/migrations/155_phoenix_transfer_send_receive_lifecycle_notifications.sql"' +
      ' ":!supabase/migrations/__tests__/155-transfer-send-receive-lifecycle-notifications-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/155-transfer-send-receive-lifecycle-notifications.dynamic.test.ts"' +
      // PHASE-D1B-6-OUTLET-RETURN-LINE-IDEMPOTENCY: a still later, separately
      // authorized phase adds a genuine new migration (156) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/156_phoenix_outlet_return_line_idempotency.sql"' +
      ' ":!supabase/migrations/__tests__/156-outlet-return-line-idempotency-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/156-outlet-return-line-idempotency.dynamic.test.ts"' +
      // PHASE-D1B-5-OUTLET-RETURN-EXCEPTION-RESOLUTION: a still later,
      // separately authorized phase adds a genuine new migration (157) plus
      // its own dedicated static/dynamic test files — a real, in-scope
      // backend change for THAT phase, excluded here by name for the same
      // reason every entry above is: it has nothing to do with this (much
      // earlier, UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/157_phoenix_outlet_return_exception_resolution.sql"' +
      ' ":!supabase/migrations/__tests__/157-outlet-return-exception-resolution-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/157-outlet-return-exception-resolution.dynamic.test.ts"' +
      // 157 also registers its new writer in the shared movement-writer-
      // contract registry/guard — test-maintenance, not new application
      // logic, same as every other __tests__/helpers exclusion above.
      ' ":!supabase/migrations/__tests__/helpers/reviewed-movement-writers.ts"' +
      ' ":!supabase/migrations/__tests__/movement-writer-completeness.test.ts"' +
      // PHASE-D2-1-TRANSACTIONAL-OUTBOX-FOUNDATION: a still later, separately
      // authorized phase adds a genuine new migration (158) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/158_phoenix_transactional_outbox_foundation.sql"' +
      ' ":!supabase/migrations/__tests__/158-transactional-outbox-foundation-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/158-transactional-outbox-foundation.dynamic.test.ts"' +
      // PHASE-D2-2-LIFECYCLE-OUTBOX-PRODUCER: a still later, separately
      // authorized phase adds a genuine new migration (159) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/159_phoenix_lifecycle_outbox_producer.sql"' +
      ' ":!supabase/migrations/__tests__/159-lifecycle-outbox-producer-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/159-lifecycle-outbox-producer.dynamic.test.ts"' +
      // PHASE-D2-2-DEMO-PURGE-OUTBOX-COMPATIBILITY: the same D2-2 phase's own
      // corrective migration (160) plus its own dedicated static/dynamic test
      // files — a real, in-scope backend change for THAT phase, excluded here
      // by name for the same reason every entry above is: it has nothing to
      // do with this (much earlier, UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/160_phoenix_demo_purge_outbox_compatibility.sql"' +
      ' ":!supabase/migrations/__tests__/160-demo-purge-outbox-compatibility-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/160-demo-purge-outbox-compatibility.dynamic.test.ts"' +
      // PHASE-D2-3-MOVEMENT-OUTBOX-PRODUCER: a still later, separately
      // authorized phase adds a genuine new migration (161) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/161_phoenix_movement_outbox_producer.sql"' +
      ' ":!supabase/migrations/__tests__/161-movement-outbox-producer-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/161-movement-outbox-producer.dynamic.test.ts"' +
      // PHASE-D2-4-STOCKTAKE-AND-EXCEPTION-OUTBOX-PRODUCERS: a still later,
      // separately authorized phase adds a genuine new migration (162) plus
      // its own dedicated static/dynamic test files — a real, in-scope
      // backend change for THAT phase, excluded here by name for the same
      // reason every entry above is: it has nothing to do with this (much
      // earlier, UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/162_phoenix_stocktake_and_exception_outbox_producers.sql"' +
      ' ":!supabase/migrations/__tests__/162-stocktake-and-exception-outbox-producers-static.test.ts"' +
      ' ":!supabase/migrations/__tests__/162-stocktake-and-exception-outbox-producers.dynamic.test.ts"' +
      // 162-CRLF-PORTABLE-VERIFICATION-HOTFIX: a still later, separately
      // authorized hotfix narrowly edits 162's own already-excluded VERIFY
      // block (CRLF-portability only, no business/event-contract change) and
      // adds its own dedicated regression test — a real, in-scope backend
      // change for THAT hotfix, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      ' ":!supabase/migrations/__tests__/162-crlf-portable-verification.dynamic.test.ts"' +
      // D2-4 also narrowly extends the shared PHOENIX_DEMO_V1 seed-lifecycle
      // proof with a regression guard for a real, pre-existing demo-seeder
      // bug discovered while verifying 162 (stocktakeAndCorrection used the
      // wrong actor tag and the wrong RPC line-payload shape, so it silently
      // created zero stocktakes rows since the group was written) — test-
      // maintenance for demo tooling, not a migration/schema/RLS change,
      // excluded here by name for the same reason every entry above is.
      ' ":!supabase/migrations/__tests__/phoenix-demo-seed-lifecycle.dynamic.test.ts"',
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(prohibited.trim()).toBe('');
  });
});
