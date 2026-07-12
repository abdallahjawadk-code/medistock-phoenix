/**
 * DB-PRESSURE-QUICK-WINS-A
 *
 * Static source-code tests — no DB connection, no component rendering
 * (matching this repo's established test conventions; see
 * public-qr-hide-nonavailable-items.test.ts's own note on this).
 *
 * Covers the two implemented quick wins from
 * ARCHITECTURE-DB-PRESSURE-SECURITY-AUDIT-A:
 *   1. Public QR visitors skip the auth/session/profile/permissions
 *      bootstrap in AppContext (AppProvider gets skipAuthBootstrap=true only
 *      when ?qid=/?token= is present).
 *   2. getOrganizations() is cached + in-flight-deduped, with invalidation
 *      wired into every place that mutates the organizations table.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const SRC = join(__dirname, '../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function extractFn(src: string, startMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const nextExport = src.indexOf('\nexport ', start + startMarker.length);
  return nextExport > -1 ? src.slice(start, nextExport) : src.slice(start);
}

const app = readSrc('app/App.tsx');
const appContext = readSrc('app/AppContext.tsx');
const orgsService = readSrc('shared/supabase/services/organizations.service.ts');
const lifecycleService = readSrc('shared/supabase/services/lifecycle.service.ts');
const publicQrScreen = readSrc('features/qr/PublicQrScreen.tsx');
const appShell = readSrc('shared/ui/PhoenixAppShell.tsx');
const platformBroadcastGate = readSrc('features/platform-broadcast/PlatformBroadcastGate.tsx');

// ============================================================================
// 1. Public QR skips auth bootstrap; authenticated route is unaffected
// ============================================================================

describe('Public QR route skips AppContext auth bootstrap', () => {
  it('App.tsx computes qid once and passes skipAuthBootstrap={!!qid} to AppProvider', () => {
    expect(app).toMatch(/const qid = publicQrId\(\);/);
    expect(app).toContain('<AppProvider skipAuthBootstrap={!!qid}>');
  });

  it('qid detection itself (?qid=/?token=) is unchanged', () => {
    expect(app).toContain("params.get('qid')");
    expect(app).toContain("params.get('token')");
  });

  it('AppProvider accepts an optional skipAuthBootstrap prop defaulting to false (authenticated callers unaffected)', () => {
    expect(appContext).toMatch(/skipAuthBootstrap\?:\s*boolean/);
    expect(appContext).toContain('skipAuthBootstrap = false');
  });

  it('the auth-bootstrap effect short-circuits (authReady=true, no getSession/onAuthChange/loadProfile) when skipAuthBootstrap is true', () => {
    const effectStart = appContext.indexOf('useEffect(() => {\n    let active = true;');
    expect(effectStart).toBeGreaterThan(-1);
    const guardLine = appContext.slice(effectStart, effectStart + 300);
    expect(guardLine).toMatch(/if \(!supabaseConfigured \|\| skipAuthBootstrap\) \{/);
    expect(guardLine).toContain('setAuthReady(true);');
    expect(guardLine).toContain('return;');
  });

  it('skipAuthBootstrap is included in the effect dependency array (no stale-closure risk)', () => {
    expect(appContext).toContain('}, [loadProfile, skipAuthBootstrap]);');
  });

  it('getSession/onAuthChange/getMyProfile/getEffectivePermissions calls themselves are unchanged (still present, still only guarded by the new flag)', () => {
    expect(appContext).toContain('onAuthChange(async (event, s) => {');
    expect(appContext).toContain('getSession().then(async (s) => {');
    expect(appContext).toContain('const p = await getMyProfile();');
    expect(appContext).toContain('const res = await getEffectivePermissions(p.id);');
  });

  it('PublicQrScreen itself only reads lang/toggleLang off useApp() — nothing that depends on session/profile/permissions', () => {
    expect(publicQrScreen).toContain('const { lang, toggleLang } = useApp();');
    expect(publicQrScreen).not.toMatch(/useApp\(\)[^;]*\b(session|profile|myPermissions|activeOrgId)\b/);
  });

  it('getPublicQrPayload is still called exactly once, unchanged params/shape', () => {
    const calls = (publicQrScreen.match(/getPublicQrPayload\(/g) ?? []).length;
    expect(calls).toBe(1);
    expect(publicQrScreen).toContain('() => getPublicQrPayload(publicId)');
  });
});

// ============================================================================
// 2. PlatformBroadcastGate remains authenticated-only
// ============================================================================

describe('PlatformBroadcastGate remains authenticated-only (unaffected by this phase)', () => {
  it('is mounted only inside PhoenixAppShell, which App.tsx never renders for the public QR branch', () => {
    expect(appShell).toContain('<PlatformBroadcastGate />');
    expect(app).not.toContain('PlatformBroadcastGate');
    expect(app).not.toContain('PhoenixAppShell');
  });

  it('still gates its fetch on authReady/session/profile/activeOrgId (unchanged)', () => {
    expect(platformBroadcastGate).toContain('authReady && !!sessionUserId && !!profileId && !!activeOrgId');
  });
});

// ============================================================================
// 3. getOrganizations(): cache + in-flight dedup, invalidated on mutation
// ============================================================================

describe('getOrganizations(): in-memory cache + in-flight request dedup', () => {
  it('caches only successful responses (cache assigned after the error check, inside the in-flight promise)', () => {
    const body = extractFn(orgsService, 'export async function getOrganizations()');
    expect(body).toContain('if (orgsCache) return orgsCache;');
    expect(body).toContain('if (orgsInFlight) return orgsInFlight;');
    const errorIdx = body.indexOf('if (error) {');
    const cacheAssignIdx = body.indexOf('orgsCache = rows;');
    expect(errorIdx).toBeGreaterThan(-1);
    expect(cacheAssignIdx).toBeGreaterThan(errorIdx);
  });

  it('never caches a failed request (orgsInFlight is cleared and the error is re-thrown, not swallowed)', () => {
    expect(orgsService).toMatch(/if \(error\) \{\s*orgsInFlight = null;\s*throw error;\s*\}/);
  });

  it('exports invalidateOrganizationsCache() that clears both cache and any in-flight promise', () => {
    const body = extractFn(orgsService, 'export function invalidateOrganizationsCache(): void {');
    expect(body).toContain('orgsCache = null;');
    expect(body).toContain('orgsInFlight = null;');
  });

  it('does not change the returned OrgRow shape (still id/name/name_ar/code/status/city/contact_email)', () => {
    expect(orgsService).toContain('id:      r.id,');
    expect(orgsService).toContain('name:    r.name,');
    expect(orgsService).toContain('name_ar: r.name_ar,');
    expect(orgsService).toContain('code:    r.code,');
    expect(orgsService).toContain('status:  r.status,');
    expect(orgsService).toContain("city:    r.city ?? '',");
    expect(orgsService).toContain("contact_email: r.contact_email ?? '',");
  });

  it('the underlying query (select columns, order) is unchanged', () => {
    expect(orgsService).toContain("select('id, name, name_ar, code, status, city, contact_email')");
    expect(orgsService).toContain(".order('name_ar')");
  });
});

describe('getOrganizations() cache invalidation on every organizations-table mutation', () => {
  it('createOrganization invalidates the cache after a successful insert', () => {
    const body = extractFn(orgsService, 'export async function createOrganization');
    expect(body).toContain('if (error) throw error;');
    expect(body).toContain('invalidateOrganizationsCache();');
    expect(body.indexOf('invalidateOrganizationsCache();')).toBeGreaterThan(body.indexOf('if (error) throw error;'));
  });

  it('updateOrganization invalidates the cache after a successful update', () => {
    const body = extractFn(orgsService, 'export async function updateOrganization');
    expect(body).toContain('if (error) throw error;');
    expect(body).toContain('invalidateOrganizationsCache();');
    expect(body.indexOf('invalidateOrganizationsCache();')).toBeGreaterThan(body.indexOf('if (error) throw error;'));
  });

  it('archiveOrganization (lifecycle.service.ts) is the only other write path to the organizations table, and it also invalidates the cache', () => {
    expect(lifecycleService).toContain("import { invalidateOrganizationsCache } from './organizations.service';");
    const body = extractFn(lifecycleService, 'export async function archiveOrganization');
    expect(body).toContain("update({ status: 'inactive' })");
    expect(body).toContain('if (error) throw error;');
    expect(body).toContain('invalidateOrganizationsCache();');
    expect(body.indexOf('invalidateOrganizationsCache();')).toBeGreaterThan(body.indexOf('if (error) throw error;'));
  });
});

// ============================================================================
// 4. No QR/RLS/RPC/Auth security behavior changed
// ============================================================================

describe('Guards: no QR payload/RPC/RLS change, no migration, no package/lockfile change', () => {
  it('get_public_qr_payload RPC name/params referenced by the frontend are unchanged', () => {
    const qrService = readSrc('shared/supabase/services/qr.service.ts');
    expect(qrService).toContain("supabase.rpc('get_public_qr_payload', {");
    expect(qrService).toContain('p_public_id: publicId,');
  });

  it('no new migration file was added by this phase', () => {
    const migrationsDir = join(SRC, '../supabase/migrations');
    const files: string[] = readdirSync(migrationsDir).filter((f: string) => /^\d{3}_/.test(f));
    const nums = files.map(f => parseInt(f.slice(0, 3), 10));
    // PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A: additive migration 058 is a later,
    // separately-reviewed phase — this phase itself still adds no migration.
    expect(Math.max(...nums)).toBeLessThanOrEqual(58);
  });

  it('no package/lockfile diff', () => {
    const ROOT = join(SRC, '../');
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});
