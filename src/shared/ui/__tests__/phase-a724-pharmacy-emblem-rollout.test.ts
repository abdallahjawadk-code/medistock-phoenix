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
      'phoenix-pharmacy-compact-gold.png','phoenix-pharmacy-compact-teal.png','phoenix-pharmacy-full.png',
    ]);
    expect(sha256(join(BRAND_DIR,'phoenix-pharmacy-full.png'))).toBe('6cc0c11affc54ab0101d5570b84dd785439d43fa167ef6094381f29893af7e09');
    expect(sha256(join(BRAND_DIR,'phoenix-pharmacy-compact-gold.png'))).toBe('b2412f895e5339a5d60559de67f040a5aa88c7ebbf30aaa9b1c79d020370dfe1');
    expect(sha256(join(BRAND_DIR,'phoenix-pharmacy-compact-teal.png'))).toBe('d8c9b2bf07ff3326f3476c5c2e26020f7ffb86f1fa66079ddec2e989476573a1');
  });
  it('does not ship rejected/source/generated emblem artifacts',()=>{
    const tracked=execSync('git ls-files src public',{cwd:ROOT,encoding:'utf8'});
    expect(tracked).not.toMatch(/Source-Sheet|Transparency-Inspection|REJECTED-Claude|phoenix-pharmacy-emblem-compact\.svg/i);
    expect(component).not.toMatch(/<svg|<path|<ellipse|<circle|data:image|https?:\/\//);
    expect(existsSync(join(ROOT,'scripts/phoenix-pharmacy-icons.mjs'))).toBe(false);
  });
  it('exposes presentation-only variants',()=>{
    expect(component).toContain("'full' | 'compact-gold' | 'compact-teal'"); expect(component).toContain('<img'); expect(component).not.toMatch(/useApp|useAuth|useContext|filter:/);
  });
});

describe('A7.2.4 exact brand-surface rollout',()=>{
  it('keeps Login/Welcome full emblem contract',()=>{
    expect(mediStockMark).toContain('variant="full"'); expect(login).toContain('size={80}'); expect(welcome).toContain('size={88}'); expect(login).toContain('nexus-login__brand-emblem'); expect(login).not.toContain('nexus-brand-mark nexus-login__brand-mark'); expect(signatureCss).toContain('.nexus-login__emblem'); expect(signatureCss).toContain('.nexus-welcome__emblem');
  });
  it('keeps compact gold navigation/loading contract',()=>{
    expect(phoenixMark).toContain('variant="compact-gold"'); expect(sidebar).toContain('nexus-brand-mark--phoenix'); expect(sidebar).toContain('size={40}'); expect(drawer).toContain('size={44}'); expect(loading).toContain('variant="compact-gold"');
  });
  it('keeps compact teal QR/PWA contract and QR data flow',()=>{
    expect(publicQr).toContain('variant="compact-teal"'); expect(pwaPrompt).toContain('variant="compact-teal"'); expect(publicQr).toContain('export function isPubliclyAvailableQrItem(item: PublicItem): boolean {'); expect(publicQr).toContain("if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) return false;");
  });
});

describe('A7.2.4 favicon and PWA outputs',()=>{
  const icons=[['phoenix-favicon-v2-16.png',16],['phoenix-favicon-v2-32.png',32],['phoenix-favicon-v2-48.png',48],['apple-touch-icon-v2.png',180],['pwa-icon-v2-192.png',192],['pwa-icon-v2-512.png',512],['pwa-icon-maskable-v2-192.png',192],['pwa-icon-maskable-v2-512.png',512]] as const;
  it('materializes every referenced icon at declared dimensions',async()=>{for(const [name,size] of icons){const path=join(ROOT,'public',name);expect(existsSync(path),name).toBe(true);const m=await sharp(path).metadata();expect(m.width,name).toBe(size);expect(m.height,name).toBe(size);}});
  it('keeps transparency/maskable invariants',async()=>{const any=await sharp(join(ROOT,'public/pwa-icon-v2-512.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});expect(any.data[3]).toBe(0);const mask=await sharp(join(ROOT,'public/pwa-icon-maskable-v2-512.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});expect(mask.data[3]).toBe(255);});
  it('uses raster-only compatibility SVG wrappers',()=>{for(const name of ['favicon.svg','app-icon.svg','phoenix-favicon-v2.svg','pwa-icon-192.svg','pwa-icon-512.svg','pwa-icon-maskable-512.svg']){const svg=readFileSync(join(ROOT,'public',name),'utf8');expect(svg,name).toContain('<image href="/');expect(svg.replace('http://www.w3.org/2000/svg',''),name).not.toMatch(/<path|<ellipse|<circle|base64|https?:\/\//);}});
});

describe('A7.2.4 preservation and fail-closed boundaries',()=>{
  it('preserves all six A7.2.3 hero files byte-for-byte',()=>{
    const hashes:Record<string,string>={'supply-desktop-1536.webp':'050206796f6650a0c57aa2973a0242d3c4df442885336f794c25c2ed54dbfbf6','supply-desktop-1280.webp':'702af55281c4e0aac282e7fd65bf7730f36e13d5854361ba7418d8ea58108e06','supply-desktop-960.webp':'2ed30a5a4f56541a12d58ef452038a7efbfa0ddc42754ddd02d16a1e3e72d17b','supply-mobile-940.webp':'82389ae12e0b10556746e50fdc9f504621f4a0afe9a10e4ffd7fdbc6cefc9b13','supply-mobile-720.webp':'dcc4e9fbf834c75a4c5fcb0134d0610e3c00f5ce56f5b58e6fd4358e09f809e2','supply-mobile-480.webp':'6d3a0e7b0ed4c10edf3a760b7471f5bdb6b6692bcb256ff5e5587aec7f2df7cc'};for(const [name,hash] of Object.entries(hashes))expect(sha256(join(SRC,'assets/auth-welcome',name)),name).toBe(hash);
  });
  it('preserves timing, reduced motion, copy, and operational icon',()=>{
    expect(welcome).toContain('const SEQUENCE_MS = 6000;'); expect(welcome).toContain('prefersReducedMotion'); expect(login).toContain('Medication Supply Network — From the Pharmacy Department to the Dispensing Point.'); expect(welcome).toContain('منظومة الإمداد الدوائي — من قسم الصيدلة إلى منفذ الصرف.'); const iconDiff=execSync('git diff --name-only 4dc6d8122dbef51fb7632266f8e92b983559cc8e -- src/shared/ui/PhoenixIcon.tsx',{cwd:ROOT,encoding:'utf8'});expect(iconDiff.trim()).toBe('');
  });
  it('has no unapproved migration/service/Auth/RBAC/environment diff',()=>{
    const BASE='4dc6d8122dbef51fb7632266f8e92b983559cc8e';
    const WATCHED=['package.json','package-lock.json','supabase','src/shared/supabase','src/shared/authz','src/app','.env','.env.local'] as const;
    const EXCLUDED:string[]=[
      'src/app/AppContext.tsx','src/app/AuthenticatedApp.tsx','src/app/__tests__/auth-resilience-context.runtime.test.tsx','src/app/__tests__/auth-dead-end-screens.runtime.test.tsx','src/app/__tests__/auth-session-race.runtime.test.tsx','src/app/__tests__/db-pressure-quick-wins.test.ts','src/app/screen-continuity.ts','src/app/__tests__/phase-b45-screen-continuity.runtime.test.ts','src/shared/supabase/services/auth.service.ts','src/shared/supabase/services/availability.service.ts','src/shared/supabase/services/__tests__/frontend-live-removed-at-filters.test.ts','src/shared/supabase/services/__tests__/auth-signout.runtime.test.ts','src/shared/supabase/__tests__/permission-persistence.test.ts','src/shared/supabase/__tests__/permission-matrix-readiness.test.ts','src/shared/supabase/__tests__/permission-save-diagnostics.test.ts','src/shared/authz/__tests__/screen-access.test.ts',
      'supabase/migrations/__tests__/053-item-availability-removed-marker.test.ts','supabase/migrations/__tests__/054-dashboard-condition-count-rpcs.test.ts','supabase/migrations/__tests__/061-warehouse-dispatch-schema.test.ts','supabase/migrations/__tests__/062-user-rbac-scope-foundation.test.ts','supabase/migrations/__tests__/helpers/reviewed-migrations.ts','supabase/migrations/__tests__/reviewed-migration-manifest.test.ts','supabase/migrations/__tests__/helpers/reviewed-movement-writers.ts','supabase/migrations/__tests__/movement-writer-completeness.test.ts','package.json','package-lock.json',
      // R1.1-U (182): the facility-scoped RBAC substage, registered by EXACT
      // filename like every entry before it. Two non-migration files are named
      // here rather than covered by any directory rule:
      //   * the admin-create-user Edge function, which gains facility_ids SHAPE
      //     validation and the all-or-nothing facility-scope call with its Auth
      //     rollback — the authority itself stays in the database;
      //   * the typecheck script-contract test, which locks out the no-op
      //     `tsc --noEmit` form that silently passed while three exhaustive role
      //     maps were broken.
      'supabase/functions/admin-create-user/index.ts',
      'src/app/__tests__/typecheck-script-contract.test.ts',
      // ...plus the two client-side halves of the same substage: the create-user
      // service, which forwards facility ids as a REQUEST the database
      // re-validates, and that Edge function's own secure-contract test, whose
      // credential-logging guarantee now covers BOTH rollback logs by name.
      'src/shared/supabase/services/users.service.ts',
      'src/shared/supabase/__tests__/admin-create-user-secure-contract.test.ts',
      // R1.1-U / U-B SAFE ACTIVATION — the four watched files the activation
      // boundary touches, each by EXACT filename:
      //   * screen-access.ts   — the facility-scoped role must not land on the
      //     reports surface, whose tabs are RLS-only and therefore not
      //     facility-safe;
      //   * rbac.service.ts    — the scope reader now SELECTs facility_id;
      //     without it a facility assignment arrived with no target and was
      //     silently dropped, giving valid DB scope and an unusable UI;
      //   * the two U-B proof suites — the frontend activation contract and the
      //     adversarial database confidentiality matrix.
      'src/shared/authz/screen-access.ts',
      'src/shared/authz/rbac.service.ts',
      'src/shared/authz/__tests__/ub-facility-scope-activation.test.ts',
      'supabase/migrations/__tests__/182-ub-facility-confidentiality.dynamic.test.ts',
      // R1.1-P — the facility-parity substage adds exactly TWO files under the
      // watched src/shared/authz directory, each registered by EXACT filename
      // like every entry above:
      //   * nav-projection.ts — the ONE navigation projection the sidebar,
      //     drawer, bottom bar and command palette now share, so a visible menu
      //     can no longer offer a screen isScreenAuthorized would refuse. It
      //     reuses that predicate and defines no authorization of its own.
      //   * its proof suite, which pins the projection against every historical
      //     role and permission combination.
      // R1.1-P creates NO migration and edits no Supabase service, so
      // supabase/migrations, supabase/functions, src/shared/supabase and
      // src/app all remain fully watched here — any unlisted file still fails.
      'src/shared/authz/nav-projection.ts',
      'src/shared/authz/__tests__/r1-1-p-nav-projection.test.ts',
      // R1.3 — the canonical supply cycle. Its migration and the two proofs for
      // it are registered in the numbered block below; this is the remainder:
      // the screen-17 reachability proof, under the watched src/shared/authz
      // directory (screen-access.ts itself is already listed above). No
      // pre-existing dynamic fixture is touched by R1.3.
      'src/shared/authz/__tests__/r1-3-supply-reachability.test.ts',
      // STAGE-G-G2: 177 registered by EXACT filename, same as every entry
      // before it — the public-QR read cutover plus its own static/dynamic
      // proofs. No wildcard, no directory exclusion; any OTHER unlisted file
      // still fails this guard.
      // P0 HOTFIX 178: registered the same way — the outlet owner-guard
      // privilege fix (SECURITY DEFINER on Migration 171's trigger function)
      // plus its own static/dynamic proofs. Exact filenames only.
      // STAGE-G-G3.1: 179 registered the same way — the authenticated
      // availability read-model regrouping (canonical material_identity_key
      // plus an additive row-level unit) and its own static/dynamic proofs.
      // Exact filenames only; any OTHER unlisted file still fails this guard.
      // R1.2 (180): registered the same way — the emergency-outlet
      // initial-provisioning authority boundary, its static proof, its dynamic
      // A-O proof matrix, and the 001->179 rig that reproduces the bypass it
      // closes. Exact filenames only; any OTHER unlisted file still fails.
      // R1.2C (183): registered the same way — the emergency-outlet topology
      // integrity migration, its static proof, its dynamic matrix + initial-
      // provisioning atomicity proof, the two-rig 168/183 parity proof, and the
      // B1/B2 corrective suite (warehouse-side lifecycle boundary + the
      // canonical-validator preflight) an independent adversarial review
      // required. Exact filenames only; any OTHER unlisted file still fails.
      // R1.3 (184): registered the same way — the canonical supply-cycle
      // migration plus its static proof and its dynamic A/B/C/D matrix. Exact
      // filenames only; any OTHER unlisted file still fails.
      // R1.3 corrective: the first Production apply of 184 aborted at Verify-K,
      // because real Supabase grants service_role EXECUTE on a preserved
      // owner/internal legacy helper that the disposable rig does not model.
      // The corrective narrows Verify-K to the CLIENT principals it was always
      // about and adds ONE regression suite reproducing that exact ACL shape.
      // Registered BY EXACT FILENAME like every entry before it; the guard is
      // extended, never widened, and any OTHER unlisted file still fails.
      ...[154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184].flatMap(n=>{
        const exact:Record<number,string>={154:'154_phoenix_transfer_corridor_privilege_lockdown.sql',155:'155_phoenix_transfer_send_receive_lifecycle_notifications.sql',156:'156_phoenix_outlet_return_line_idempotency.sql',157:'157_phoenix_outlet_return_exception_resolution.sql',158:'158_phoenix_transactional_outbox_foundation.sql',159:'159_phoenix_lifecycle_outbox_producer.sql',160:'160_phoenix_demo_purge_outbox_compatibility.sql',161:'161_phoenix_movement_outbox_producer.sql',162:'162_phoenix_stocktake_and_exception_outbox_producers.sql',163:'163_phoenix_outbox_consumer_foundation.sql',164:'164_phoenix_facility_identity_and_routing_foundation.sql',165:'165_phoenix_sector_health_center_supply_and_return.sql',166:'166_phoenix_initial_provisioning_invariant.sql',167:'167_phoenix_dispatch_line_full_rejection_reconciliation.sql',168:'168_phoenix_atomic_emergency_outlet_replenishment.sql',169:'169_phoenix_outlet_replenishment_reversal.sql',170:'170_phoenix_organization_class_and_warehouse_facility_assignment.sql',171:'171_phoenix_organization_kind_pharmacy_department_authority.sql',172:'172_phoenix_patient_dispensing_contract.sql',173:'173_phoenix_database_security_surface_hardening.sql',174:'174_phoenix_authenticated_rpc_surface_hardening.sql',175:'175_phoenix_read_helper_anonymous_surface_hardening.sql',176:'176_phoenix_canonical_outlet_availability_read_model.sql',177:'177_phoenix_canonical_public_qr.sql',178:'178_phoenix_distribution_point_owner_guard_privilege_fix.sql',179:'179_phoenix_canonical_authenticated_availability_hardening.sql',180:'180_phoenix_emergency_initial_provisioning_boundary.sql',181:'181_phoenix_health_sector_topology_reconciliation.sql',182:'182_phoenix_health_center_facility_scoped_rbac.sql',183:'183_phoenix_emergency_outlet_integrity.sql',184:'184_phoenix_canonical_supply_cycle.sql'};
        const sql='supabase/migrations/'+exact[n];
        const tests=n===184
          ? ['supabase/migrations/__tests__/184-canonical-supply-cycle-static.test.ts','supabase/migrations/__tests__/184-canonical-supply-cycle.dynamic.test.ts','supabase/migrations/__tests__/184-production-service-role-acl-compat.dynamic.test.ts']
          : n===183
          ? ['supabase/migrations/__tests__/183-emergency-outlet-integrity-static.test.ts','supabase/migrations/__tests__/183-emergency-outlet-integrity.dynamic.test.ts','supabase/migrations/__tests__/183-emergency-outlet-matrix-parity.dynamic.test.ts','supabase/migrations/__tests__/183-warehouse-lifecycle-and-preflight.dynamic.test.ts']
          : n===182
          // R1.1-U / U-B corrective adds the closure suite for the surfaces an
          // independent U-C audit found — the notification badge/mark-read
          // family, cross-centre metadata, sector aggregates — plus the two
          // systemic guards that close those CLASSES rather than instances.
          // Registered by EXACT filename, like every entry before it.
          ? ['supabase/migrations/__tests__/182-health-center-facility-scoped-rbac-static.test.ts','supabase/migrations/__tests__/182-health-center-facility-scoped-rbac.dynamic.test.ts','supabase/migrations/__tests__/182-ub-facility-confidentiality.dynamic.test.ts','supabase/migrations/__tests__/182-ub-corrective-closure.dynamic.test.ts']
          : n===181
          ? ['supabase/migrations/__tests__/181-health-sector-topology-static.test.ts','supabase/migrations/__tests__/181-health-sector-topology.dynamic.test.ts','supabase/migrations/__tests__/181-closure-round1.dynamic.test.ts','supabase/migrations/__tests__/181-null-warehouse-outlet.dynamic.test.ts']
          : n===180
          ? ['supabase/migrations/__tests__/180-emergency-initial-provisioning-boundary-static.test.ts','supabase/migrations/__tests__/180-emergency-initial-provisioning-boundary.dynamic.test.ts','supabase/migrations/__tests__/180-pre180-emergency-dispatch-bypass.dynamic.test.ts']
          : n===175
          ? ['supabase/migrations/__tests__/175-read-helper-anonymous-surface-hardening-static.test.ts','supabase/migrations/__tests__/175-read-helper-anonymous-surface-hardening.dynamic.test.ts']
          : n===176
            ? ['supabase/migrations/__tests__/176-canonical-outlet-availability-read-model-static.test.ts','supabase/migrations/__tests__/176-canonical-outlet-availability-read-model.dynamic.test.ts']
            : n===177
              ? ['supabase/migrations/__tests__/177-canonical-public-qr-static.test.ts','supabase/migrations/__tests__/177-canonical-public-qr.dynamic.test.ts']
              : n===178
                ? ['supabase/migrations/__tests__/178-dp-owner-guard-privilege-static.test.ts','supabase/migrations/__tests__/178-dp-owner-guard-privilege.dynamic.test.ts']
                : n===179
                  ? ['supabase/migrations/__tests__/179-canonical-authenticated-availability-static.test.ts','supabase/migrations/__tests__/179-canonical-authenticated-availability.dynamic.test.ts']
                  : [];
        return [sql,...tests];
      }),
      'supabase/migrations/__tests__/154-transfer-corridor-privilege-lockdown-static.test.ts','supabase/migrations/__tests__/154-transfer-corridor-privilege-lockdown.dynamic.test.ts','supabase/migrations/__tests__/155-transfer-send-receive-lifecycle-notifications-static.test.ts','supabase/migrations/__tests__/155-transfer-send-receive-lifecycle-notifications.dynamic.test.ts','supabase/migrations/__tests__/156-outlet-return-line-idempotency-static.test.ts','supabase/migrations/__tests__/156-outlet-return-line-idempotency.dynamic.test.ts','supabase/migrations/__tests__/157-outlet-return-exception-resolution-static.test.ts','supabase/migrations/__tests__/157-outlet-return-exception-resolution.dynamic.test.ts','supabase/migrations/__tests__/158-transactional-outbox-foundation-static.test.ts','supabase/migrations/__tests__/158-transactional-outbox-foundation.dynamic.test.ts','supabase/migrations/__tests__/159-lifecycle-outbox-producer-static.test.ts','supabase/migrations/__tests__/159-lifecycle-outbox-producer.dynamic.test.ts','supabase/migrations/__tests__/160-demo-purge-outbox-compatibility-static.test.ts','supabase/migrations/__tests__/160-demo-purge-outbox-compatibility.dynamic.test.ts','supabase/migrations/__tests__/161-movement-outbox-producer-static.test.ts','supabase/migrations/__tests__/161-movement-outbox-producer.dynamic.test.ts','supabase/migrations/__tests__/162-stocktake-and-exception-outbox-producers-static.test.ts','supabase/migrations/__tests__/162-stocktake-and-exception-outbox-producers.dynamic.test.ts','supabase/migrations/__tests__/162-crlf-portable-verification.dynamic.test.ts','supabase/migrations/__tests__/163-outbox-consumer-foundation-static.test.ts','supabase/migrations/__tests__/163-outbox-consumer-foundation.dynamic.test.ts','supabase/migrations/__tests__/163-verification-hardening.dynamic.test.ts','supabase/migrations/__tests__/phoenix-demo-seed-lifecycle.dynamic.test.ts','supabase/migrations/__tests__/163-d3-2b-dispatch-integration.dynamic.test.ts','supabase/migrations/__tests__/163-d3-2c-rpc-result-shape.dynamic.test.ts',
      'supabase/functions/phoenix-outbox-dispatcher/README.md','supabase/functions/phoenix-outbox-dispatcher/index.ts','supabase/functions/phoenix-outbox-dispatcher/lib/auth.ts','supabase/functions/phoenix-outbox-dispatcher/lib/auth_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/config.ts','supabase/functions/phoenix-outbox-dispatcher/lib/config_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/handler.ts','supabase/functions/phoenix-outbox-dispatcher/lib/handler_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/health.ts','supabase/functions/phoenix-outbox-dispatcher/lib/health_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/request.ts','supabase/functions/phoenix-outbox-dispatcher/lib/request_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/static_guards_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/rpc-client.ts','supabase/functions/phoenix-outbox-dispatcher/lib/dispatch.ts','supabase/functions/phoenix-outbox-dispatcher/lib/dispatch_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/supabase-rpc-adapter.ts','supabase/functions/phoenix-outbox-dispatcher/lib/supabase-rpc-adapter_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation.ts','supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/runtime.ts','supabase/functions/phoenix-outbox-dispatcher/lib/runtime_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/runtime-config.ts','supabase/functions/phoenix-outbox-dispatcher/lib/runtime-config_test.ts','supabase/functions/phoenix-outbox-dispatcher/lib/supabase-client.ts','supabase/config.toml',
      'supabase/migrations/__tests__/164-facility-identity-and-routing-foundation-static.test.ts','supabase/migrations/__tests__/164-facility-identity-and-routing-foundation.dynamic.test.ts','supabase/migrations/__tests__/165-sector-health-center-supply-and-return-static.test.ts','supabase/migrations/__tests__/165-sector-health-center-supply-and-return.dynamic.test.ts','supabase/migrations/__tests__/166-initial-provisioning-invariant-static.test.ts','supabase/migrations/__tests__/166-initial-provisioning-invariant.dynamic.test.ts','supabase/migrations/__tests__/167-dispatch-line-full-rejection-backfill.dynamic.test.ts','supabase/migrations/__tests__/167-dispatch-line-full-rejection-reconciliation-static.test.ts','supabase/migrations/__tests__/167-dispatch-line-full-rejection-reconciliation.dynamic.test.ts','supabase/migrations/__tests__/168-atomic-emergency-outlet-replenishment-static.test.ts','supabase/migrations/__tests__/168-atomic-emergency-outlet-replenishment.dynamic.test.ts','supabase/migrations/__tests__/169-outlet-replenishment-reversal-static.test.ts','supabase/migrations/__tests__/169-outlet-replenishment-reversal.dynamic.test.ts','supabase/migrations/__tests__/170-organization-class-and-warehouse-facility-static.test.ts','supabase/migrations/__tests__/170-organization-class-and-warehouse-facility.dynamic.test.ts','supabase/migrations/__tests__/115-central-intake-catalog-lockdown.dynamic.test.ts','supabase/migrations/__tests__/117-subpurchase-duplicate-candidates.dynamic.test.ts','supabase/migrations/__tests__/119-report-snapshots-and-executive-overview.dynamic.test.ts','supabase/migrations/__tests__/120-supply-sources-detail.dynamic.test.ts','supabase/migrations/__tests__/141-demo-immutable-exemption.dynamic.test.ts','supabase/migrations/__tests__/141-demo-org-blocked-parent.dynamic.test.ts','supabase/migrations/__tests__/142-demo-profile-detach.dynamic.test.ts','supabase/migrations/__tests__/145-demo-organization-watermark.dynamic.test.ts','supabase/migrations/__tests__/171-organization-kind-pharmacy-department-authority-static.test.ts','supabase/migrations/__tests__/171-organization-kind-pharmacy-department-authority.dynamic.test.ts','src/shared/supabase/services/organizations.service.ts','src/shared/supabase/services/warehouses.service.ts','supabase/migrations/__tests__/172-e7-2-stage-e-wiring.dynamic.test.ts','src/shared/supabase/services/__tests__/organization-classification-writer.test.ts','supabase/migrations/__tests__/172-patient-dispensing-contract.dynamic.test.ts','supabase/migrations/__tests__/173-database-security-surface-hardening-static.test.ts','supabase/migrations/__tests__/173-database-security-surface-hardening.dynamic.test.ts','supabase/migrations/__tests__/174-authenticated-rpc-surface-hardening-static.test.ts','supabase/migrations/__tests__/174-authenticated-rpc-surface-hardening.dynamic.test.ts','src/features/outlet/dispense-context.service.ts','src/features/outlet/DispenseContextDialog.tsx','src/features/outlet/__tests__/dispense-context-contract.test.ts','src/features/outlet/__tests__/patient-fefo.test.ts',
      // R1.2C (183): TEST-INFRASTRUCTURE ONLY. Each of these dynamic suites
      // replays the migration chain inside a beforeAll while running on
      // vitest's DEFAULT 10s hook budget, which no testTimeout covers. As the
      // chain grew, those hooks crept toward that ceiling and began dying
      // mid-replay — surfacing as ECONNRESET rather than as any assertion. The
      // only change to each file is an explicit hook budget; not one assertion
      // is added, removed, weakened or reworded. Registered by EXACT filename,
      // like every entry before it — anything else still fails this guard.
      'supabase/migrations/__tests__/093-lifecycle-regression.dynamic.test.ts','supabase/migrations/__tests__/146-secure-user-provisioning.dynamic.test.ts','supabase/migrations/__tests__/147-secure-user-delete-history-guard.dynamic.test.ts','supabase/migrations/__tests__/148-inventory-suggestion-policy-scope-fix.dynamic.test.ts','supabase/migrations/__tests__/148-transfer-suggestion-live-balance-fix.dynamic.test.ts','supabase/migrations/__tests__/151-real-operational-role-gates.dynamic.test.ts','supabase/migrations/__tests__/162-crlf-portable-verification.dynamic.test.ts','supabase/migrations/__tests__/ops-full-purge-v147.dynamic.test.ts','supabase/migrations/__tests__/ops-pre-launch-reset.dynamic.test.ts','supabase/migrations/__tests__/ops-purge-v147-manifest-coverage.dynamic.test.ts','supabase/migrations/__tests__/phase9-invariant-reconciliation.dynamic.test.ts',
      // Admin-create-user function-only deployment drift closure: focused
      // Edge/deployment contract coverage only; no migration or runtime
      // function-body change. supabase/functions/admin-create-user/index.ts is
      // byte-identical to master (sha256 c84e8f66...5fe3) — the drift being
      // closed is a DEPLOYMENT gap, not a code gap, so the reviewed artifact
      // must stay untouched. Registered by EXACT filename, like every entry
      // before it — anything else still fails this guard.
      'src/shared/supabase/__tests__/admin-create-user-deployment-contract.test.ts','src/shared/supabase/__tests__/admin-create-user-facility-scope-contract.test.ts',
      // R1.5 (185): the return/quarantine/recall parity stage. ONE migration and
      // its nine dynamic suites. It adds no table, column, permission key or RLS
      // widening, and touches no auth, RBAC, environment or dependency surface —
      // the only WATCHED prefix it enters is supabase/migrations. Registered by
      // EXACT filename, like every entry before it, so any unlisted file under a
      // watched prefix still fails this guard closed. Appended to the entry set
      // above rather than replacing it: both stages' registrations stand.
      'supabase/migrations/185_phoenix_return_quarantine_recall_parity.sql','supabase/migrations/__tests__/185-canonical-lot-identity.dynamic.test.ts','supabase/migrations/__tests__/185-exception-corrected-receipt-cap.dynamic.test.ts','supabase/migrations/__tests__/185-exception-facility-visibility.dynamic.test.ts','supabase/migrations/__tests__/185-f1-recall-selector.dynamic.test.ts','supabase/migrations/__tests__/185-f2-downstream-warehouse-recall.dynamic.test.ts','supabase/migrations/__tests__/185-f3-outlet-recall.dynamic.test.ts','supabase/migrations/__tests__/185-health-center-return-read-parity.dynamic.test.ts','supabase/migrations/__tests__/185-m1-corridor-return-reference.dynamic.test.ts','supabase/migrations/__tests__/185-warehouse-return-review-caps.dynamic.test.ts',
      // R1.6 (186): exact migration and focused/current-tip proof files only.
      // No watched prefix or assertion is broadened; unlisted files still fail closed.
      'supabase/migrations/186_phoenix_correction_reason_code_wrapper_parity.sql','supabase/migrations/__tests__/186-correction-reason-code-wrapper-parity-static.test.ts','supabase/migrations/__tests__/186-correction-reason-code-wrapper-parity.dynamic.test.ts','supabase/migrations/__tests__/r1-6-full-institutional-e2e-matrix.dynamic.test.ts',
      // Delegated Operational Access (187): one reviewed migration, exact guard
      // registrations, focused DB/client proofs, and the existing user/inventory
      // integration surfaces. No watched-prefix wildcard is introduced.
      'supabase/migrations/187_phoenix_delegated_operational_access.sql','supabase/migrations/__tests__/187-delegated-operational-access-static.test.ts','supabase/migrations/__tests__/187-delegated-operational-access.dynamic.test.ts','supabase/migrations/__tests__/helpers/reviewed-migrations.ts','supabase/migrations/__tests__/reviewed-migration-manifest.test.ts','supabase/migrations/__tests__/172-e7-2-stage-e-wiring.dynamic.test.ts','supabase/migrations/__tests__/181-health-sector-topology-static.test.ts','supabase/migrations/__tests__/182-health-center-facility-scoped-rbac-static.test.ts','supabase/migrations/__tests__/183-emergency-outlet-integrity-static.test.ts','supabase/migrations/__tests__/184-canonical-supply-cycle-static.test.ts','src/features/movement/__tests__/no-client-side-numbering.test.ts','src/features/users/UserManagementScreen.tsx','src/features/users/DelegatedAccessPanel.tsx','src/features/users/__tests__/delegated-operational-access-client.test.ts','src/shared/supabase/services/delegated-access.service.ts','src/shared/ui/PhoenixOrgScope.tsx','src/features/inventory/useInventoryScopes.ts','src/features/inventory/useOutletRecallPermission.ts','src/features/outlet/OutletOperationsScreen.tsx','src/features/outlet/__tests__/r1-6-recall-hcm-control-parity.test.ts','src/shared/i18n/strings.ts','src/shared/ui/__tests__/phase-a724-pharmacy-emblem-rollout.test.ts',
      // M188 (public QR facility context): one reviewed migration that forward-
      // replaces 177's public QR resolver with structural facility ancestry,
      // plus its static/dynamic proofs and the QR service that types the new
      // payload. No watched-prefix wildcard is introduced.
      'supabase/migrations/188_phoenix_public_qr_facility_context.sql','supabase/migrations/__tests__/188-public-qr-facility-context-static.test.ts','supabase/migrations/__tests__/188-public-qr-facility-context.dynamic.test.ts','src/shared/supabase/services/qr.service.ts',
      // G3.3 / M189 (inter-org alert canonical identity): ONE reviewed migration
      // that forward-replaces both independently-callable live inter-institution
      // alert RPCs and adds one shared read bridge, plus its static suite and
      // its directly-scoped dynamic suite. It adds no table, column, permission
      // key or RLS widening and touches no auth, RBAC, environment or dependency
      // surface — the only WATCHED prefix it enters is supabase/migrations.
      // Registered by EXACT filename, like every entry before it, so any
      // unlisted file under a watched prefix still fails this guard closed.
      'supabase/migrations/189_phoenix_inter_org_alert_canonical_identity.sql','supabase/migrations/__tests__/189-inter-org-alert-canonical-identity-static.test.ts','supabase/migrations/__tests__/189-inter-org-alert-canonical-identity.dynamic.test.ts',
      // G4.1 / M190 (inter-org alert CQRS boundary): ONE reviewed migration that
      // ADDS an explicit lifecycle-refresh COMMAND and two PURE query RPCs beside
      // the existing hybrid, which it leaves byte-identical, plus its static and
      // dynamic suites. It adds no table, column, permission key or RLS widening,
      // grants nothing to anon, opens no lifecycle table to a client role, and
      // touches no auth, RBAC, environment or dependency surface — the only
      // WATCHED prefix it enters is supabase/migrations. Its frontend half
      // (features/alerts, features/dashboard) is outside every watched prefix and
      // is therefore deliberately NOT listed here. Registered by EXACT filename,
      // like every entry before it, so any unlisted file under a watched prefix
      // still fails this guard closed.
      'supabase/migrations/191_phoenix_canonical_scope_topology_read_contract.sql','supabase/migrations/__tests__/191-canonical-scope-topology-static.test.ts','supabase/migrations/__tests__/191-canonical-scope-topology.dynamic.test.ts','supabase/migrations/190_phoenix_inter_org_alert_cqrs_boundary.sql','supabase/migrations/__tests__/190-inter-org-alert-cqrs-boundary-static.test.ts','supabase/migrations/__tests__/190-inter-org-alert-cqrs-boundary.dynamic.test.ts',
      // …and G4.2's ONE new production read service under the watched
      // src/shared/supabase prefix: a thin client for Migration 191's pure
      // query, carrying no topology rule of its own. It was registered in every
      // other G4.2 approved-diff surface but missed HERE, because this guard
      // reads `git diff --name-only <BASE>`, which never lists an UNTRACKED
      // file — so it stayed invisible until the payload was committed.
      // Registered by EXACT filename: no directory entry, no glob, no prefix
      // broadening, so every other file under src/shared/supabase still fails
      // this guard closed.
      'src/shared/supabase/services/scope-topology.service.ts',
      // …and G5's anonymous read-surface convergence (Migration 192) with its
      // two suites. It grants nothing, creates nothing and alters no policy —
      // it only removes direct anon SELECT — and the sole WATCHED prefix it
      // enters is supabase/migrations. Registered by EXACT filename; every
      // other file under supabase/ still fails this guard closed.
      'supabase/migrations/192_phoenix_anonymous_read_surface_convergence.sql',
      'supabase/migrations/__tests__/192-anon-read-surface-convergence-static.test.ts',
      'supabase/migrations/__tests__/192-anon-read-surface-convergence.dynamic.test.ts',
      // …plus the one guard test under the watched src/shared/supabase prefix
      // whose alert-lifecycle zero-diff clause G4.1 supersedes. Registered by
      // EXACT filename; frontend-live-removed-at-filters.test.ts is already
      // listed above, and no production service is added here.
      'src/shared/supabase/services/__tests__/dashboard-service-rpc-switch.test.ts',
      // …and the three historical alert-lineage guards whose UI-wiring and
      // service-wrapper assertions G4.1 re-points by EXACT name (036's read
      // wrapper, 037's UI compatibility, 039's service wrapper). Registered by
      // EXACT filename; every other file under supabase/ still fails closed.
      'supabase/migrations/__tests__/036-live-inter-institution-alerts-rpc.test.ts','supabase/migrations/__tests__/037-live-alert-identifiers.test.ts','supabase/migrations/__tests__/039-inter-org-alert-lifecycle-rpcs.test.ts',
      'supabase/migrations/__tests__/048-live-alerts-expiry-risk-tiers.test.ts','supabase/migrations/__tests__/049-add-national-code-to-item-availability.test.ts','supabase/migrations/__tests__/050-phoenix-upsert-availability-national-code.test.ts','supabase/migrations/__tests__/051-material-batch-identity-option-a.test.ts','supabase/migrations/__tests__/053-item-availability-removed-marker.test.ts','supabase/migrations/__tests__/054-dashboard-condition-count-rpcs.test.ts','supabase/migrations/__tests__/061-warehouse-dispatch-schema.test.ts','supabase/migrations/__tests__/062-user-rbac-scope-foundation.test.ts','src/features/account/__tests__/bugfix-my-account-clear-whatsapp-disables-official-contact.test.ts','src/features/account/__tests__/my-account-whatsapp-save.test.ts','src/features/alerts/__tests__/bugfix-inter-alerts-freeze.test.ts','src/features/institutions/__tests__/ui-hide-port-add-item.test.ts','src/shared/ui/__tests__/phase-a71-visual-acceptance-closure.test.ts',
      // …and H Unit 1's alert command-surface hardening (Migration 193) with
      // its two suites. It grants nothing, creates nothing, alters no policy
      // and touches no table ACL — one ALTER FUNCTION (a SECURITY DEFINER
      // flip) plus two REVOKEs of `authenticated` EXECUTE — and the sole
      // WATCHED prefix it enters is supabase/migrations. Registered by EXACT
      // filename; every other file under supabase/ still fails this guard
      // closed. These three were invisible to every pre-commit check because
      // this guard reads `git diff --name-only <BASE>`, which never lists an
      // UNTRACKED file — exactly the trap documented for G4.2 above.
      'supabase/migrations/193_phoenix_inter_org_alert_command_surface_hardening.sql',
      'supabase/migrations/__tests__/193-alert-command-surface-static.test.ts',
      'supabase/migrations/__tests__/193-alert-command-surface.dynamic.test.ts',
      // …and H Unit 2A's authorization-surface reproducibility convergence
      // (Migration 194) with its suites. It creates nothing, drops nothing,
      // alters no policy, no function body, no owner and no search_path — it
      // REVOKEs the six direct-write privileges from `authenticated` across
      // schema public, re-GRANTs the two contracted relations
      // (distribution_points, organizations INSERT/UPDATE) and REVOKEs
      // `authenticated` EXECUTE from the two manual availability writers. It
      // is an authorization NO-OP against current Production; its whole
      // purpose is to make a clean rebuild reproduce Production instead of
      // coming up MORE permissive. The sole WATCHED prefix it enters is
      // supabase/migrations. Registered by EXACT filename; every other file
      // under supabase/ still fails this guard closed.
      //
      // All five 194 files are listed even though `git diff --name-only
      // <BASE>` cannot see them yet — they are UNTRACKED until this unit is
      // committed, which is precisely the trap documented for G4.2 and 193
      // above. Registering them now means the guard stays honest the moment
      // they become tracked, instead of failing on the commit that lands them.
      'supabase/migrations/194_phoenix_authorization_surface_reproducibility_convergence.sql',
      'supabase/migrations/__tests__/194-authorization-surface-reproducibility-convergence-static.test.ts',
      'supabase/migrations/__tests__/194-authorization-surface-reproducibility-convergence.dynamic.test.ts',
      'supabase/migrations/__tests__/pg-rig-production-authorization-baseline.dynamic.test.ts',
      'supabase/migrations/__tests__/helpers/authorization-surface.ts',
      // …plus the 085 suites. Live Production verification showed migration
      // 085 WAS applied (schema_migrations version 085, count 1), so H Unit 2A
      // corrects the 085 status contract and retires the rig's 085 skip. The
      // migration file itself is NOT edited — only its tests change, and one
      // new dynamic suite is added to prove the attested replay and the
      // still-fail-closed raw apply.
      'supabase/migrations/__tests__/085-revoke-manual-availability-writers.test.ts',
      'supabase/migrations/__tests__/085-canonical-replay-attested.dynamic.test.ts',
      // …and H Unit 2's E2E/pg-rig mirror regression guard. The authenticated
      // E2E workflow hand-mirrors tools/pg-rig/bootstrap.sql's platform
      // baseline and tools/pg-rig/rig.mjs's replay policy; both silently went
      // stale during this unit and broke CI. This test pins the mirror so that
      // divergence fails locally instead of in a 30-minute remote job. It adds
      // no migration, no policy and no runtime code — it only reads the
      // workflow file. Registered by EXACT filename; every other file under
      // supabase/ still fails this guard closed.
      'supabase/migrations/__tests__/e2e-workflow-platform-mirror.test.ts',
      // …and H Unit 3's facility-authority re-entry guard, which lives under the
      // WATCHED src/shared/authz prefix. It is TEST-ONLY: it reads committed
      // source with the TypeScript compiler API to prove that no UNREVIEWED
      // authority sink is reachable from a facility-safe (L2) screen, and adds
      // no migration, no policy, no dependency and no runtime code. Registered
      // here by EXACT filename before the files are committed — an untracked
      // file is invisible to `git diff --name-only <BASE>`, which is exactly
      // how the U2 registration was missed and broke CI. No wildcard and no
      // directory exemption: every other file under src/shared/authz still
      // fails this guard closed.
      'src/shared/authz/__tests__/facility-authority-reentry-guard.helper.ts',
      'src/shared/authz/__tests__/facility-authority-reentry-guard.test.ts',
      // …and H Unit 4's forward-only Migration 195, which schema-qualifies the
      // two SECURITY DEFINER identity helpers (profiles -> public.profiles) and
      // changes nothing else: no grant, no ACL, no search_path, no RLS, no
      // runtime code. Proven on a disposable replay as a zero authorization
      // delta. Registered by EXACT filename; every other file under
      // supabase/ still fails this guard closed.
      'supabase/migrations/195_phoenix_auth_helper_profile_schema_qualification.sql'
    ];
    const changed=execSync(`git diff --name-only ${BASE}`,{cwd:ROOT,encoding:'utf8'}).split('\n').map(l=>l.trim()).filter(Boolean);
    const prohibited=changed.filter(f=>WATCHED.some(p=>f===p||f.startsWith(p+'/'))&&!EXCLUDED.includes(f));
    expect(prohibited).toEqual([]);
  });
  it('guard mechanism still catches an unlisted file',()=>{
    const prefixes=['supabase','src/app']; const excluded=['supabase/migrations/170_real_and_authorized.sql']; const filter=(changed:string[])=>changed.filter(f=>prefixes.some(p=>f===p||f.startsWith(p+'/'))&&!excluded.includes(f));
    expect(filter(['supabase/migrations/170_real_and_authorized.sql','src/shared/lib/unrelated.ts'])).toEqual([]);
    expect(filter(['supabase/migrations/999_unlisted_sneaky_migration.sql'])).toEqual(['supabase/migrations/999_unlisted_sneaky_migration.sql']);
  });
});
