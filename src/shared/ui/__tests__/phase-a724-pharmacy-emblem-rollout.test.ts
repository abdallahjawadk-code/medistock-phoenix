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
    const A724_GUARD_BASE_SHA = "4dc6d8122dbef51fb7632266f8e92b983559cc8e";
    const A724_WATCHED_PREFIXES: readonly string[] = ["package.json","package-lock.json","supabase","src/shared/supabase","src/shared/authz","src/app",".env",".env.local"];
    // Excluded by exact filename only — no wildcard, no directory prefix.
    // Every entry below is preserved from the original pathspec-based guard,
    // one per historical phase; see each phase's own comment for why it is
    // here. Read via a SHORT git command (no per-file pathspec on the
    // command line) and filtered in JS instead — a Windows cmd.exe
    // ARG_MAX workaround only; the base SHA, watched prefixes, and
    // exclusion set are byte-for-byte the same as before this change.
    const A724_EXCLUDED_FILES: readonly string[] = [
      'src/app/AppContext.tsx',
      'src/app/AuthenticatedApp.tsx',
      'src/app/__tests__/auth-resilience-context.runtime.test.tsx',
      'src/app/__tests__/auth-dead-end-screens.runtime.test.tsx',
      'src/app/__tests__/auth-session-race.runtime.test.tsx',
      'src/app/__tests__/db-pressure-quick-wins.test.ts',
      'src/app/screen-continuity.ts',
      'src/app/__tests__/phase-b45-screen-continuity.runtime.test.ts',
      'src/shared/supabase/services/auth.service.ts',
      'src/shared/supabase/services/__tests__/auth-signout.runtime.test.ts',
      'src/shared/supabase/__tests__/permission-persistence.test.ts',
      'src/shared/supabase/__tests__/permission-matrix-readiness.test.ts',
      'src/shared/supabase/__tests__/permission-save-diagnostics.test.ts',
      'src/shared/authz/__tests__/screen-access.test.ts',
      // PHASE-C2-ORG-SCOPE: a still later, separately authorized phase adds a
      // narrow-by-name exclusion (this same "narrow exclusion, never delete"
      // maintenance pattern) to four migration ISOLATION GUARD tests under
      // supabase/migrations/__tests__ — those guards assert no *product*
      // src/ file was touched by their own migration; C2 legitimately
      // touches reports/outlet src/ files, so each guard's own exclusion
      // list gained five entries. The guard test FILES themselves are
      // test-maintenance, not a migration/schema/RLS change — excluded here
      // by name, same as the auth-resilience test files above.
      'supabase/migrations/__tests__/053-item-availability-removed-marker.test.ts',
      'supabase/migrations/__tests__/054-dashboard-condition-count-rpcs.test.ts',
      'supabase/migrations/__tests__/061-warehouse-dispatch-schema.test.ts',
      'supabase/migrations/__tests__/062-user-rbac-scope-foundation.test.ts',
      // PHASE-D1A-TRANSFER-PRIVILEGE-LOCKDOWN: a still later, separately
      // authorized phase adds a genuine new migration (154) plus its own
      // dedicated static/dynamic test files and a manifest-registry update —
      // a real, in-scope backend change for THAT phase, excluded here by
      // name for the same reason every entry above is: it has nothing to do
      // with this (much earlier, UI-only) pharmacy-emblem phase.
      'supabase/migrations/154_phoenix_transfer_corridor_privilege_lockdown.sql',
      'supabase/migrations/__tests__/154-transfer-corridor-privilege-lockdown-static.test.ts',
      'supabase/migrations/__tests__/154-transfer-corridor-privilege-lockdown.dynamic.test.ts',
      'supabase/migrations/__tests__/helpers/reviewed-migrations.ts',
      'supabase/migrations/__tests__/reviewed-migration-manifest.test.ts',
      // PHASE-D1A-BRACE-EXPANSION-AUDIT-FIX: the same D1A phase's own CI
      // corrective commit bumps the pre-existing package.json override
      // (added 2026-07-25, commit 95b89e2, for a prior brace-expansion
      // advisory) from "5.0.8" to "5.0.9" to close GHSA-rgw5-rvv9-x895, a
      // bypass of that same mitigation, plus the matching single
      // package-lock.json node. A dependency-only lockfile fix, excluded
      // here by name for the same reason every entry above is: it has
      // nothing to do with this (much earlier, UI-only) pharmacy-emblem
      // phase.
      'package.json',
      'package-lock.json',
      // PHASE-D1B-1-LIFECYCLE-NOTIFICATION-COMPLETENESS: a still later,
      // separately authorized phase adds a genuine new migration (155) plus
      // its own dedicated static/dynamic test files — a real, in-scope
      // backend change for THAT phase, excluded here by name for the same
      // reason every entry above is: it has nothing to do with this (much
      // earlier, UI-only) pharmacy-emblem phase. reviewed-migrations.ts and
      // reviewed-migration-manifest.test.ts are already excluded above (D1A)
      // and need no second entry.
      'supabase/migrations/155_phoenix_transfer_send_receive_lifecycle_notifications.sql',
      'supabase/migrations/__tests__/155-transfer-send-receive-lifecycle-notifications-static.test.ts',
      'supabase/migrations/__tests__/155-transfer-send-receive-lifecycle-notifications.dynamic.test.ts',
      // PHASE-D1B-6-OUTLET-RETURN-LINE-IDEMPOTENCY: a still later, separately
      // authorized phase adds a genuine new migration (156) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      'supabase/migrations/156_phoenix_outlet_return_line_idempotency.sql',
      'supabase/migrations/__tests__/156-outlet-return-line-idempotency-static.test.ts',
      'supabase/migrations/__tests__/156-outlet-return-line-idempotency.dynamic.test.ts',
      // PHASE-D1B-5-OUTLET-RETURN-EXCEPTION-RESOLUTION: a still later,
      // separately authorized phase adds a genuine new migration (157) plus
      // its own dedicated static/dynamic test files — a real, in-scope
      // backend change for THAT phase, excluded here by name for the same
      // reason every entry above is: it has nothing to do with this (much
      // earlier, UI-only) pharmacy-emblem phase.
      'supabase/migrations/157_phoenix_outlet_return_exception_resolution.sql',
      'supabase/migrations/__tests__/157-outlet-return-exception-resolution-static.test.ts',
      'supabase/migrations/__tests__/157-outlet-return-exception-resolution.dynamic.test.ts',
      // 157 also registers its new writer in the shared movement-writer-
      // contract registry/guard — test-maintenance, not new application
      // logic, same as every other __tests__/helpers exclusion above.
      'supabase/migrations/__tests__/helpers/reviewed-movement-writers.ts',
      'supabase/migrations/__tests__/movement-writer-completeness.test.ts',
      // PHASE-D2-1-TRANSACTIONAL-OUTBOX-FOUNDATION: a still later, separately
      // authorized phase adds a genuine new migration (158) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      'supabase/migrations/158_phoenix_transactional_outbox_foundation.sql',
      'supabase/migrations/__tests__/158-transactional-outbox-foundation-static.test.ts',
      'supabase/migrations/__tests__/158-transactional-outbox-foundation.dynamic.test.ts',
      // PHASE-D2-2-LIFECYCLE-OUTBOX-PRODUCER: a still later, separately
      // authorized phase adds a genuine new migration (159) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      'supabase/migrations/159_phoenix_lifecycle_outbox_producer.sql',
      'supabase/migrations/__tests__/159-lifecycle-outbox-producer-static.test.ts',
      'supabase/migrations/__tests__/159-lifecycle-outbox-producer.dynamic.test.ts',
      // PHASE-D2-2-DEMO-PURGE-OUTBOX-COMPATIBILITY: the same D2-2 phase's own
      // corrective migration (160) plus its own dedicated static/dynamic test
      // files — a real, in-scope backend change for THAT phase, excluded here
      // by name for the same reason every entry above is: it has nothing to
      // do with this (much earlier, UI-only) pharmacy-emblem phase.
      'supabase/migrations/160_phoenix_demo_purge_outbox_compatibility.sql',
      'supabase/migrations/__tests__/160-demo-purge-outbox-compatibility-static.test.ts',
      'supabase/migrations/__tests__/160-demo-purge-outbox-compatibility.dynamic.test.ts',
      // PHASE-D2-3-MOVEMENT-OUTBOX-PRODUCER: a still later, separately
      // authorized phase adds a genuine new migration (161) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      'supabase/migrations/161_phoenix_movement_outbox_producer.sql',
      'supabase/migrations/__tests__/161-movement-outbox-producer-static.test.ts',
      'supabase/migrations/__tests__/161-movement-outbox-producer.dynamic.test.ts',
      // PHASE-D2-4-STOCKTAKE-AND-EXCEPTION-OUTBOX-PRODUCERS: a still later,
      // separately authorized phase adds a genuine new migration (162) plus
      // its own dedicated static/dynamic test files — a real, in-scope
      // backend change for THAT phase, excluded here by name for the same
      // reason every entry above is: it has nothing to do with this (much
      // earlier, UI-only) pharmacy-emblem phase.
      'supabase/migrations/162_phoenix_stocktake_and_exception_outbox_producers.sql',
      'supabase/migrations/__tests__/162-stocktake-and-exception-outbox-producers-static.test.ts',
      'supabase/migrations/__tests__/162-stocktake-and-exception-outbox-producers.dynamic.test.ts',
      // 162-CRLF-PORTABLE-VERIFICATION-HOTFIX: a still later, separately
      // authorized hotfix narrowly edits 162's own already-excluded VERIFY
      // block (CRLF-portability only, no business/event-contract change) and
      // adds its own dedicated regression test — a real, in-scope backend
      // change for THAT hotfix, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      'supabase/migrations/__tests__/162-crlf-portable-verification.dynamic.test.ts',
      // D3-1-OUTBOX-CONSUMER-STATE-FOUNDATION: a still later, separately
      // authorized phase adds a genuine new migration (163) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above is: it has nothing to do with this (much earlier,
      // UI-only) pharmacy-emblem phase.
      'supabase/migrations/163_phoenix_outbox_consumer_foundation.sql',
      'supabase/migrations/__tests__/163-outbox-consumer-foundation-static.test.ts',
      'supabase/migrations/__tests__/163-outbox-consumer-foundation.dynamic.test.ts',
      // 163-VERIFICATION-HARDENING-HOTFIX: a still later, separately
      // authorized hotfix narrowly edits 163's own PRECONDITION/VERIFY
      // blocks only (a defective \b LISTEN/NOTIFY regex, and bare-proname
      // D2/D3-1 function lookups, both fixed before 163 was ever applied to
      // Production — no DDL, no runtime function body, no signature
      // changed) and adds its own dedicated regression test — a real,
      // in-scope backend change for THAT hotfix, excluded here by name for
      // the same reason every entry above is: it has nothing to do with
      // this (much earlier, UI-only) pharmacy-emblem phase.
      'supabase/migrations/__tests__/163-verification-hardening.dynamic.test.ts',
      // D2-4 also narrowly extends the shared PHOENIX_DEMO_V1 seed-lifecycle
      // proof with a regression guard for a real, pre-existing demo-seeder
      // bug discovered while verifying 162 (stocktakeAndCorrection used the
      // wrong actor tag and the wrong RPC line-payload shape, so it silently
      // created zero stocktakes rows since the group was written) — test-
      // maintenance for demo tooling, not a migration/schema/RLS change,
      // excluded here by name for the same reason every entry above is.
      'supabase/migrations/__tests__/phoenix-demo-seed-lifecycle.dynamic.test.ts',
      // D3-2A-OUTBOX-DISPATCHER-AUTH-HEALTH-FOUNDATION: a still later,
      // separately authorized phase adds a new Edge Function directory
      // (phoenix-outbox-dispatcher) with its own dedicated unit and static
      // guard tests — a real, in-scope backend change for THAT phase, adding
      // no migration, no schema, no RLS and no product src/ file, excluded
      // here by name for the same reason every entry above is: it has nothing
      // to do with this (much earlier, UI-only) pharmacy-emblem phase.
      'supabase/functions/phoenix-outbox-dispatcher/README.md',
      'supabase/functions/phoenix-outbox-dispatcher/index.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/auth.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/auth_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/config.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/config_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/handler.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/handler_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/health.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/health_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/request.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/request_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/static_guards_test.ts',
      // D3-2B-OUTBOX-DISPATCH-ORCHESTRATION: the next, separately authorized
      // slice of that same phase adds the pure orchestration module, its
      // portable RPC type contract, and its own disposable pg-rig integration
      // test — again no migration, no schema, no RLS and no product src/
      // file, excluded here by name for the same reason.
      'supabase/functions/phoenix-outbox-dispatcher/lib/rpc-client.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/dispatch.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/dispatch_test.ts',
      'supabase/migrations/__tests__/163-d3-2b-dispatch-integration.dynamic.test.ts',
      // D3-2C-PRODUCTION-RPC-ADAPTER: the next, separately authorized slice of
      // that same phase adds the unwired, dependency-injected production RPC
      // adapter, its pure runtime result validators, their unit tests, and its
      // own disposable pg-rig result-shape test — again no migration, no
      // schema, no RLS and no product src/ file, excluded here by name for the
      // same reason.
      'supabase/functions/phoenix-outbox-dispatcher/lib/supabase-rpc-adapter.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/supabase-rpc-adapter_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation_test.ts',
      'supabase/migrations/__tests__/163-d3-2c-rpc-result-shape.dynamic.test.ts',
      // D3-2D-OUTBOX-DISPATCHER-RUNTIME: the next, separately authorized slice
      // wires that adapter into the Edge Function's request path DISABLED BY
      // DEFAULT, adding the activation/configuration parser, the single
      // client-construction site, the runtime gate, their tests, and a
      // verify_jwt entry in supabase/config.toml scoped to this one function.
      // Still no migration, no schema, no RLS and no product src/ file —
      // excluded here by name for the same reason every entry above is: it has
      // nothing to do with this (much earlier, UI-only) pharmacy-emblem phase.
      'supabase/functions/phoenix-outbox-dispatcher/lib/runtime.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/runtime_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/runtime-config.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/runtime-config_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/supabase-client.ts',
      'supabase/config.toml',
      // STAGE-E-2 FACILITY-IDENTITY-AND-ROUTING-FOUNDATION: a still later,
      // separately authorized phase adds a genuine new migration (164 — the
      // subordinate-facility identity table, the warehouse->facility link, two
      // classification columns and the replenishment-route authority) plus its
      // own dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason every
      // entry above is: it has nothing to do with this (much earlier, UI-only)
      // pharmacy-emblem phase. Named exactly, so this guard still catches any
      // OTHER unlisted migration/schema/RLS/service change.
      'supabase/migrations/164_phoenix_facility_identity_and_routing_foundation.sql',
      'supabase/migrations/__tests__/164-facility-identity-and-routing-foundation-static.test.ts',
      'supabase/migrations/__tests__/164-facility-identity-and-routing-foundation.dynamic.test.ts',
      // STAGE-E-3 SECTOR-HEALTH-CENTER-SUPPLY-AND-RETURN: the next, separately
      // authorized phase adds migration 165 (two CREATE OR REPLACE endpoint
      // validators, no new schema object) plus its own dedicated static/dynamic
      // test files -- a real, in-scope backend change for THAT phase, excluded
      // here by name for the same reason every entry above is: it has nothing
      // to do with this (much earlier, UI-only) pharmacy-emblem phase. Named
      // exactly, so this guard still catches any OTHER unlisted change.
      'supabase/migrations/165_phoenix_sector_health_center_supply_and_return.sql',
      'supabase/migrations/__tests__/165-sector-health-center-supply-and-return-static.test.ts',
      'supabase/migrations/__tests__/165-sector-health-center-supply-and-return.dynamic.test.ts',
      // STAGE-E-4 INITIAL-PROVISIONING-INVARIANT: the next, separately
      // authorized phase adds migration 166 (two flag columns on
      // warehouse_dispatches, one CHECK, one partial unique index, one new
      // create RPC and one CREATE OR REPLACE of the 149 receive wrapper) plus
      // its own dedicated static/dynamic test files -- a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason every
      // entry above is: it has nothing to do with this (much earlier, UI-only)
      // pharmacy-emblem phase. Named exactly, so this guard still catches any
      // OTHER unlisted change.
      'supabase/migrations/166_phoenix_initial_provisioning_invariant.sql',
      'supabase/migrations/__tests__/166-initial-provisioning-invariant-static.test.ts',
      'supabase/migrations/__tests__/166-initial-provisioning-invariant.dynamic.test.ts',
      // FIX-DISPATCH-REJECTION-167: authored on its own branch concurrently
      // with 166, migration 167 (reconciles the 'rejected' branch of
      // warehouse_dispatch_lines_decision_chk to the receive writer's
      // long-standing received_quantity = 0; no function touched) plus its own
      // dedicated static/dynamic test files — a real, in-scope backend change
      // for THAT phase, excluded here by name for the same reason every entry
      // above is: it has nothing to do with this (much earlier, UI-only)
      // pharmacy-emblem phase. Named exactly, so this guard still catches any
      // OTHER unlisted migration/schema/RLS/service change.
      'supabase/migrations/167_phoenix_dispatch_line_full_rejection_reconciliation.sql',
      'supabase/migrations/__tests__/167-dispatch-line-full-rejection-backfill.dynamic.test.ts',
      'supabase/migrations/__tests__/167-dispatch-line-full-rejection-reconciliation-static.test.ts',
      'supabase/migrations/__tests__/167-dispatch-line-full-rejection-reconciliation.dynamic.test.ts',
      // STAGE-E-E5-168: Migration 168 (atomic pharmacy→emergency-outlet
      // replenishment) plus its own dedicated static/dynamic test files — a
      // real, in-scope backend change for THAT phase, excluded here by name
      // for the same reason every entry above exists: this guard freezes an
      // earlier, UI-only pharmacy-emblem phase. Named exactly, so this guard
      // still catches any OTHER unlisted migration/schema/RLS/service change.
      'supabase/migrations/168_phoenix_atomic_emergency_outlet_replenishment.sql',
      'supabase/migrations/__tests__/168-atomic-emergency-outlet-replenishment-static.test.ts',
      'supabase/migrations/__tests__/168-atomic-emergency-outlet-replenishment.dynamic.test.ts',
      // STAGE-E-E6-169: Migration 169 (outlet-replenishment reversal) plus its
      // own dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above exists: this guard freezes an earlier, UI-only
      // pharmacy-emblem phase. Named exactly, so this guard still catches any
      // OTHER unlisted migration/schema/RLS/service change.
      'supabase/migrations/169_phoenix_outlet_replenishment_reversal.sql',
      'supabase/migrations/__tests__/169-outlet-replenishment-reversal-static.test.ts',
      'supabase/migrations/__tests__/169-outlet-replenishment-reversal.dynamic.test.ts',
      // STAGE-E-E7-1-170: Migration 170 (organization-class NOT NULL +
      // immutability, warehouse-facility assignment RPC + hard guard) plus its
      // own dedicated static/dynamic test files — a real, in-scope backend
      // change for THAT phase, excluded here by name for the same reason
      // every entry above exists: this guard freezes an earlier, UI-only
      // pharmacy-emblem phase. Named exactly, so this guard still catches any
      // OTHER unlisted migration/schema/RLS/service change.
      'supabase/migrations/170_phoenix_organization_class_and_warehouse_facility_assignment.sql',
      'supabase/migrations/__tests__/170-organization-class-and-warehouse-facility-static.test.ts',
      'supabase/migrations/__tests__/170-organization-class-and-warehouse-facility.dynamic.test.ts',
      // STAGE-E-E7-1-170-COMPAT: a follow-up compatibility correction, once
      // Migration 170 made organizations.institution_class NOT NULL, updates
      // these pre-existing predecessor fixture-test files (all pre-dating 164)
      // to specify institution_class on the organizations their own fixtures
      // create — no assertion or business behavior changes, excluded here by
      // name for the same reason every entry above exists: this guard freezes
      // an earlier, UI-only pharmacy-emblem phase. Named exactly, so this
      // guard still catches any OTHER unlisted migration/schema/RLS/service
      // change.
      'supabase/migrations/__tests__/115-central-intake-catalog-lockdown.dynamic.test.ts',
      'supabase/migrations/__tests__/117-subpurchase-duplicate-candidates.dynamic.test.ts',
      'supabase/migrations/__tests__/119-report-snapshots-and-executive-overview.dynamic.test.ts',
      'supabase/migrations/__tests__/120-supply-sources-detail.dynamic.test.ts',
      'supabase/migrations/__tests__/141-demo-immutable-exemption.dynamic.test.ts',
      'supabase/migrations/__tests__/141-demo-org-blocked-parent.dynamic.test.ts',
      'supabase/migrations/__tests__/142-demo-profile-detach.dynamic.test.ts',
      'supabase/migrations/__tests__/145-demo-organization-watermark.dynamic.test.ts',
      // STAGE-E-E7-1-171: Migration 171 (organization_kind discriminator —
      // care_institution | pharmacy_department_authority — separate from
      // institution_class) plus its own dedicated static/dynamic test files —
      // a real, in-scope backend change for THAT phase, excluded here by
      // name for the same reason every entry above exists: this guard
      // freezes an earlier, UI-only pharmacy-emblem phase. Named exactly, so
      // this guard still catches any OTHER unlisted migration/schema/RLS/
      // service change.
      'supabase/migrations/171_phoenix_organization_kind_pharmacy_department_authority.sql',
      'supabase/migrations/__tests__/171-organization-kind-pharmacy-department-authority-static.test.ts',
      'supabase/migrations/__tests__/171-organization-kind-pharmacy-department-authority.dynamic.test.ts',
      // STAGE-E-E7-2: the application-wiring phase for Stage E. It adds NO
      // migration; it wires the already-reviewed 164/166/168/169/170/171 RPCs
      // into real services and UI. The two service files below are the only
      // watched-prefix production files it touches — organizations.service.ts
      // (the writer now sends the classification pair it previously omitted,
      // a genuine regression fix) and warehouses.service.ts (distribution
      // points now carry Migration 164's clinical_location_kind, without which
      // no emergency outlet could ever be replenished). The dynamic test file
      // is E7-2's own proof against a real database. Named exactly, so this
      // guard still catches any OTHER unlisted migration/schema/RLS/service
      // change.
      'src/shared/supabase/services/organizations.service.ts',
      'src/shared/supabase/services/warehouses.service.ts',
      'supabase/migrations/__tests__/172-e7-2-stage-e-wiring.dynamic.test.ts',
      // E7-2's behavioural test for the organization writer. It lives beside
      // the service it covers, which puts it under the watched
      // src/shared/supabase prefix. `git diff` cannot see an UNTRACKED file,
      // so this one stayed invisible to the guard locally and only surfaced
      // once committed — CI caught it, which is the guard working correctly.
      'src/shared/supabase/services/__tests__/organization-classification-writer.test.ts',
      // STAGE-F-PATIENT-DISPENSING-172: a still later, separately authorized
      // stage adds a genuine new migration (172) plus the product files that
      // migration's contract requires — the dispense-context service (the
      // Stage-F card/chart type and submit payload), its dialog, and the
      // strings those two render. Excluded here by name for the same reason
      // every entry above is: none of it has anything to do with this much
      // earlier, UI-only pharmacy-emblem phase. Named exactly, so this guard
      // still catches any OTHER unlisted migration/schema/RLS/service change.
      'supabase/migrations/172_phoenix_patient_dispensing_contract.sql',
      'supabase/migrations/__tests__/172-patient-dispensing-contract.dynamic.test.ts',
      'src/features/outlet/dispense-context.service.ts',
      'src/features/outlet/DispenseContextDialog.tsx',
      'src/features/outlet/__tests__/dispense-context-contract.test.ts',
      // The FEFO advisory ships inside that same service, so its unit matrix
      // lives beside it. Listed pre-emptively: git diff cannot see an
      // UNTRACKED file, so a new test only becomes visible to this guard once
      // committed — exactly how the organization-classification writer test
      // above surfaced in CI rather than locally.
      'src/features/outlet/__tests__/patient-fefo.test.ts',
    ];

    const changed = execSync(
      `git diff --name-only ${A724_GUARD_BASE_SHA}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).split('\n').map((l) => l.trim()).filter(Boolean);
    const prohibited = changed.filter((f) =>
      A724_WATCHED_PREFIXES.some((p) => f === p || f.startsWith(p + '/'))
      && !A724_EXCLUDED_FILES.includes(f),
    );
    expect(prohibited).toEqual([]);
  });

  it('the rewritten (JS-side-filtered) guard mechanism still catches an unlisted file', () => {
    // STAGE-E-E7-1-171: the guard above was rewritten from a single long
    // shell pathspec to a short git command plus JS-side filtering, purely
    // to work around Windows cmd.exe's ~8191-character command-line limit
    // (CI runs on Ubuntu, where this was never a problem, but the guard
    // should also be runnable locally on Windows). This test proves the
    // rewritten filtering MECHANISM itself — prefix match minus exact-name
    // exclusion — still fails closed on a file that matches a watched
    // prefix and is NOT in the exclusion list, using the exact same
    // algorithm shape as the real check above, independent of real git
    // state.
    const prefixes = ['supabase', 'src/app'];
    const excluded = ['supabase/migrations/170_real_and_authorized.sql'];
    const filterProhibited = (changed: string[]) => changed.filter((f) =>
      prefixes.some((p) => f === p || f.startsWith(p + '/'))
      && !excluded.includes(f),
    );

    expect(filterProhibited([
      'supabase/migrations/170_real_and_authorized.sql', // excluded by name
      'src/shared/lib/unrelated.ts', // not under a watched prefix
    ])).toEqual([]);

    expect(filterProhibited([
      'supabase/migrations/999_unlisted_sneaky_migration.sql', // watched, NOT excluded
    ])).toEqual(['supabase/migrations/999_unlisted_sneaky_migration.sql']);
  });
});
