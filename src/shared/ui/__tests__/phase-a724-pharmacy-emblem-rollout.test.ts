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
      ...[154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179].flatMap(n=>{
        const exact:Record<number,string>={154:'154_phoenix_transfer_corridor_privilege_lockdown.sql',155:'155_phoenix_transfer_send_receive_lifecycle_notifications.sql',156:'156_phoenix_outlet_return_line_idempotency.sql',157:'157_phoenix_outlet_return_exception_resolution.sql',158:'158_phoenix_transactional_outbox_foundation.sql',159:'159_phoenix_lifecycle_outbox_producer.sql',160:'160_phoenix_demo_purge_outbox_compatibility.sql',161:'161_phoenix_movement_outbox_producer.sql',162:'162_phoenix_stocktake_and_exception_outbox_producers.sql',163:'163_phoenix_outbox_consumer_foundation.sql',164:'164_phoenix_facility_identity_and_routing_foundation.sql',165:'165_phoenix_sector_health_center_supply_and_return.sql',166:'166_phoenix_initial_provisioning_invariant.sql',167:'167_phoenix_dispatch_line_full_rejection_reconciliation.sql',168:'168_phoenix_atomic_emergency_outlet_replenishment.sql',169:'169_phoenix_outlet_replenishment_reversal.sql',170:'170_phoenix_organization_class_and_warehouse_facility_assignment.sql',171:'171_phoenix_organization_kind_pharmacy_department_authority.sql',172:'172_phoenix_patient_dispensing_contract.sql',173:'173_phoenix_database_security_surface_hardening.sql',174:'174_phoenix_authenticated_rpc_surface_hardening.sql',175:'175_phoenix_read_helper_anonymous_surface_hardening.sql',176:'176_phoenix_canonical_outlet_availability_read_model.sql',177:'177_phoenix_canonical_public_qr.sql',178:'178_phoenix_distribution_point_owner_guard_privilege_fix.sql',179:'179_phoenix_canonical_authenticated_availability_hardening.sql'};
        const sql='supabase/migrations/'+exact[n];
        const tests=n===175
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
      'supabase/migrations/__tests__/164-facility-identity-and-routing-foundation-static.test.ts','supabase/migrations/__tests__/164-facility-identity-and-routing-foundation.dynamic.test.ts','supabase/migrations/__tests__/165-sector-health-center-supply-and-return-static.test.ts','supabase/migrations/__tests__/165-sector-health-center-supply-and-return.dynamic.test.ts','supabase/migrations/__tests__/166-initial-provisioning-invariant-static.test.ts','supabase/migrations/__tests__/166-initial-provisioning-invariant.dynamic.test.ts','supabase/migrations/__tests__/167-dispatch-line-full-rejection-backfill.dynamic.test.ts','supabase/migrations/__tests__/167-dispatch-line-full-rejection-reconciliation-static.test.ts','supabase/migrations/__tests__/167-dispatch-line-full-rejection-reconciliation.dynamic.test.ts','supabase/migrations/__tests__/168-atomic-emergency-outlet-replenishment-static.test.ts','supabase/migrations/__tests__/168-atomic-emergency-outlet-replenishment.dynamic.test.ts','supabase/migrations/__tests__/169-outlet-replenishment-reversal-static.test.ts','supabase/migrations/__tests__/169-outlet-replenishment-reversal.dynamic.test.ts','supabase/migrations/__tests__/170-organization-class-and-warehouse-facility-static.test.ts','supabase/migrations/__tests__/170-organization-class-and-warehouse-facility.dynamic.test.ts','supabase/migrations/__tests__/115-central-intake-catalog-lockdown.dynamic.test.ts','supabase/migrations/__tests__/117-subpurchase-duplicate-candidates.dynamic.test.ts','supabase/migrations/__tests__/119-report-snapshots-and-executive-overview.dynamic.test.ts','supabase/migrations/__tests__/120-supply-sources-detail.dynamic.test.ts','supabase/migrations/__tests__/141-demo-immutable-exemption.dynamic.test.ts','supabase/migrations/__tests__/141-demo-org-blocked-parent.dynamic.test.ts','supabase/migrations/__tests__/142-demo-profile-detach.dynamic.test.ts','supabase/migrations/__tests__/145-demo-organization-watermark.dynamic.test.ts','supabase/migrations/__tests__/171-organization-kind-pharmacy-department-authority-static.test.ts','supabase/migrations/__tests__/171-organization-kind-pharmacy-department-authority.dynamic.test.ts','src/shared/supabase/services/organizations.service.ts','src/shared/supabase/services/warehouses.service.ts','supabase/migrations/__tests__/172-e7-2-stage-e-wiring.dynamic.test.ts','src/shared/supabase/services/__tests__/organization-classification-writer.test.ts','supabase/migrations/__tests__/172-patient-dispensing-contract.dynamic.test.ts','supabase/migrations/__tests__/173-database-security-surface-hardening-static.test.ts','supabase/migrations/__tests__/173-database-security-surface-hardening.dynamic.test.ts','supabase/migrations/__tests__/174-authenticated-rpc-surface-hardening-static.test.ts','supabase/migrations/__tests__/174-authenticated-rpc-surface-hardening.dynamic.test.ts','src/features/outlet/dispense-context.service.ts','src/features/outlet/DispenseContextDialog.tsx','src/features/outlet/__tests__/dispense-context-contract.test.ts','src/features/outlet/__tests__/patient-fefo.test.ts'
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
