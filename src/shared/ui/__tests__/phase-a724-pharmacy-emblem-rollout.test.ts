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
    const A724_GUARD_BASE_SHA = "4dc6d8122dbef51fb7632266f8e92b983559cc8e";
    const A724_WATCHED_PREFIXES: readonly string[] = ["package.json","package-lock.json","supabase","src/shared/supabase","src/shared/authz","src/app",".env",".env.local"];
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
      'supabase/migrations/__tests__/053-item-availability-removed-marker.test.ts',
      'supabase/migrations/__tests__/054-dashboard-condition-count-rpcs.test.ts',
      'supabase/migrations/__tests__/061-warehouse-dispatch-schema.test.ts',
      'supabase/migrations/__tests__/062-user-rbac-scope-foundation.test.ts',
      'supabase/migrations/154_phoenix_transfer_corridor_privilege_lockdown.sql',
      'supabase/migrations/__tests__/154-transfer-corridor-privilege-lockdown-static.test.ts',
      'supabase/migrations/__tests__/154-transfer-corridor-privilege-lockdown.dynamic.test.ts',
      'supabase/migrations/__tests__/helpers/reviewed-migrations.ts',
      'supabase/migrations/__tests__/reviewed-migration-manifest.test.ts',
      'package.json',
      'package-lock.json',
      'supabase/migrations/155_phoenix_transfer_send_receive_lifecycle_notifications.sql',
      'supabase/migrations/__tests__/155-transfer-send-receive-lifecycle-notifications-static.test.ts',
      'supabase/migrations/__tests__/155-transfer-send-receive-lifecycle-notifications.dynamic.test.ts',
      'supabase/migrations/156_phoenix_outlet_return_line_idempotency.sql',
      'supabase/migrations/__tests__/156-outlet-return-line-idempotency-static.test.ts',
      'supabase/migrations/__tests__/156-outlet-return-line-idempotency.dynamic.test.ts',
      'supabase/migrations/157_phoenix_outlet_return_exception_resolution.sql',
      'supabase/migrations/__tests__/157-outlet-return-exception-resolution-static.test.ts',
      'supabase/migrations/__tests__/157-outlet-return-exception-resolution.dynamic.test.ts',
      'supabase/migrations/__tests__/helpers/reviewed-movement-writers.ts',
      'supabase/migrations/__tests__/movement-writer-completeness.test.ts',
      'supabase/migrations/158_phoenix_transactional_outbox_foundation.sql',
      'supabase/migrations/__tests__/158-transactional-outbox-foundation-static.test.ts',
      'supabase/migrations/__tests__/158-transactional-outbox-foundation.dynamic.test.ts',
      'supabase/migrations/159_phoenix_lifecycle_outbox_producer.sql',
      'supabase/migrations/__tests__/159-lifecycle-outbox-producer-static.test.ts',
      'supabase/migrations/__tests__/159-lifecycle-outbox-producer.dynamic.test.ts',
      'supabase/migrations/160_phoenix_demo_purge_outbox_compatibility.sql',
      'supabase/migrations/__tests__/160-demo-purge-outbox-compatibility-static.test.ts',
      'supabase/migrations/__tests__/160-demo-purge-outbox-compatibility.dynamic.test.ts',
      'supabase/migrations/161_phoenix_movement_outbox_producer.sql',
      'supabase/migrations/__tests__/161-movement-outbox-producer-static.test.ts',
      'supabase/migrations/__tests__/161-movement-outbox-producer.dynamic.test.ts',
      'supabase/migrations/162_phoenix_stocktake_and_exception_outbox_producers.sql',
      'supabase/migrations/__tests__/162-stocktake-and-exception-outbox-producers-static.test.ts',
      'supabase/migrations/__tests__/162-stocktake-and-exception-outbox-producers.dynamic.test.ts',
      'supabase/migrations/__tests__/162-crlf-portable-verification.dynamic.test.ts',
      'supabase/migrations/163_phoenix_outbox_consumer_foundation.sql',
      'supabase/migrations/__tests__/163-outbox-consumer-foundation-static.test.ts',
      'supabase/migrations/__tests__/163-outbox-consumer-foundation.dynamic.test.ts',
      'supabase/migrations/__tests__/163-verification-hardening.dynamic.test.ts',
      'supabase/migrations/__tests__/phoenix-demo-seed-lifecycle.dynamic.test.ts',
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
      'supabase/functions/phoenix-outbox-dispatcher/lib/rpc-client.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/dispatch.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/dispatch_test.ts',
      'supabase/migrations/__tests__/163-d3-2b-dispatch-integration.dynamic.test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/supabase-rpc-adapter.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/supabase-rpc-adapter_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation_test.ts',
      'supabase/migrations/__tests__/163-d3-2c-rpc-result-shape.dynamic.test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/runtime.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/runtime_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/runtime-config.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/runtime-config_test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/lib/supabase-client.ts',
      'supabase/config.toml',
      'supabase/migrations/164_phoenix_facility_identity_and_routing_foundation.sql',
      'supabase/migrations/__tests__/164-facility-identity-and-routing-foundation-static.test.ts',
      'supabase/migrations/__tests__/164-facility-identity-and-routing-foundation.dynamic.test.ts',
      'supabase/migrations/165_phoenix_sector_health_center_supply_and_return.sql',
      'supabase/migrations/__tests__/165-sector-health-center-supply-and-return-static.test.ts',
      'supabase/migrations/__tests__/165-sector-health-center-supply-and-return.dynamic.test.ts',
      'supabase/migrations/166_phoenix_initial_provisioning_invariant.sql',
      'supabase/migrations/__tests__/166-initial-provisioning-invariant-static.test.ts',
      'supabase/migrations/__tests__/166-initial-provisioning-invariant.dynamic.test.ts',
      'supabase/migrations/167_phoenix_dispatch_line_full_rejection_reconciliation.sql',
      'supabase/migrations/__tests__/167-dispatch-line-full-rejection-backfill.dynamic.test.ts',
      'supabase/migrations/__tests__/167-dispatch-line-full-rejection-reconciliation-static.test.ts',
      'supabase/migrations/__tests__/167-dispatch-line-full-rejection-reconciliation.dynamic.test.ts',
      'supabase/migrations/168_phoenix_atomic_emergency_outlet_replenishment.sql',
      'supabase/migrations/__tests__/168-atomic-emergency-outlet-replenishment-static.test.ts',
      'supabase/migrations/__tests__/168-atomic-emergency-outlet-replenishment.dynamic.test.ts',
      'supabase/migrations/169_phoenix_outlet_replenishment_reversal.sql',
      'supabase/migrations/__tests__/169-outlet-replenishment-reversal-static.test.ts',
      'supabase/migrations/__tests__/169-outlet-replenishment-reversal.dynamic.test.ts',
      'supabase/migrations/170_phoenix_organization_class_and_warehouse_facility_assignment.sql',
      'supabase/migrations/__tests__/170-organization-class-and-warehouse-facility-static.test.ts',
      'supabase/migrations/__tests__/170-organization-class-and-warehouse-facility.dynamic.test.ts',
      'supabase/migrations/__tests__/115-central-intake-catalog-lockdown.dynamic.test.ts',
      'supabase/migrations/__tests__/117-subpurchase-duplicate-candidates.dynamic.test.ts',
      'supabase/migrations/__tests__/119-report-snapshots-and-executive-overview.dynamic.test.ts',
      'supabase/migrations/__tests__/120-supply-sources-detail.dynamic.test.ts',
      'supabase/migrations/__tests__/141-demo-immutable-exemption.dynamic.test.ts',
      'supabase/migrations/__tests__/141-demo-org-blocked-parent.dynamic.test.ts',
      'supabase/migrations/__tests__/142-demo-profile-detach.dynamic.test.ts',
      'supabase/migrations/__tests__/145-demo-organization-watermark.dynamic.test.ts',
      'supabase/migrations/171_phoenix_organization_kind_pharmacy_department_authority.sql',
      'supabase/migrations/__tests__/171-organization-kind-pharmacy-department-authority-static.test.ts',
      'supabase/migrations/__tests__/171-organization-kind-pharmacy-department-authority.dynamic.test.ts',
      'src/shared/supabase/services/organizations.service.ts',
      'src/shared/supabase/services/warehouses.service.ts',
      'supabase/migrations/__tests__/172-e7-2-stage-e-wiring.dynamic.test.ts',
      'src/shared/supabase/services/__tests__/organization-classification-writer.test.ts',
      'supabase/migrations/172_phoenix_patient_dispensing_contract.sql',
      'supabase/migrations/__tests__/172-patient-dispensing-contract.dynamic.test.ts',
      'supabase/migrations/173_phoenix_database_security_surface_hardening.sql',
      'supabase/migrations/__tests__/173-database-security-surface-hardening-static.test.ts',
      'supabase/migrations/__tests__/173-database-security-surface-hardening.dynamic.test.ts',
      // POST-STAGE-F-SECURITY-174: exact Wave-1 ACL hardening artifacts only.
      'supabase/migrations/174_phoenix_authenticated_rpc_surface_hardening.sql',
      'supabase/migrations/__tests__/174-authenticated-rpc-surface-hardening-static.test.ts',
      'supabase/migrations/__tests__/174-authenticated-rpc-surface-hardening.dynamic.test.ts',
      'src/features/outlet/dispense-context.service.ts',
      'src/features/outlet/DispenseContextDialog.tsx',
      'src/features/outlet/__tests__/dispense-context-contract.test.ts',
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
    const prefixes = ['supabase', 'src/app'];
    const excluded = ['supabase/migrations/170_real_and_authorized.sql'];
    const filterProhibited = (changed: string[]) => changed.filter((f) =>
      prefixes.some((p) => f === p || f.startsWith(p + '/'))
      && !excluded.includes(f),
    );

    expect(filterProhibited([
      'supabase/migrations/170_real_and_authorized.sql',
      'src/shared/lib/unrelated.ts',
    ])).toEqual([]);

    expect(filterProhibited([
      'supabase/migrations/999_unlisted_sneaky_migration.sql',
    ])).toEqual(['supabase/migrations/999_unlisted_sneaky_migration.sql']);
  });
});
