/**
 * AUTHENTICATED-SCREEN-SPLIT-B
 *
 * Static source-code tests — no DB connection, no component rendering
 * (matching this repo's established test conventions).
 *
 * Converts AvailabilityCleanupWizard and PlatformBroadcastAdminPanel (both
 * Super Admin-only, both already returning null internally for any other
 * role) to React.lazy imports inside UserManagementScreen.tsx, gated by the
 * same normalizeRole(role) === 'super_admin' check each already performed
 * internally — now also applied one level up so the dynamic import itself
 * is never triggered for non-super roles. No permission logic changed, no
 * UI text/behavior changed, no RPC/service call changed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const userMgmt = readSrc('features/users/UserManagementScreen.tsx');
const wizard = readSrc('features/admin/AvailabilityCleanupWizard.tsx');
const adminPanel = readSrc('features/platform-broadcast/PlatformBroadcastAdminPanel.tsx');
const app = readSrc('app/App.tsx');
const authenticatedApp = readSrc('app/AuthenticatedApp.tsx');
const platformBroadcastGate = readSrc('features/platform-broadcast/PlatformBroadcastGate.tsx');
const appShell = readSrc('shared/ui/PhoenixAppShell.tsx');

describe('UserManagementScreen: both panels are React.lazy, gated by role, wrapped in Suspense', () => {
  it('imports React.lazy/Suspense and lazy()-wraps both components (no static top-level import remains)', () => {
    expect(userMgmt).toMatch(/import \{[^}]*lazy[^}]*Suspense[^}]*\} from 'react';/);
    expect(userMgmt).not.toContain("import { AvailabilityCleanupWizard } from '@/features/admin/AvailabilityCleanupWizard';");
    expect(userMgmt).not.toContain("import { PlatformBroadcastAdminPanel } from '@/features/platform-broadcast/PlatformBroadcastAdminPanel';");
    expect(userMgmt).toContain("const AvailabilityCleanupWizard = lazy(() =>");
    expect(userMgmt).toContain("import('@/features/admin/AvailabilityCleanupWizard').then(m => ({ default: m.AvailabilityCleanupWizard }))");
    expect(userMgmt).toContain("const PlatformBroadcastAdminPanel = lazy(() =>");
    expect(userMgmt).toContain("import('@/features/platform-broadcast/PlatformBroadcastAdminPanel').then(m => ({ default: m.PlatformBroadcastAdminPanel }))");
  });

  it('both render sites are gated on normalizeRole(role) === \'super_admin\' — the exact same check each component already performs internally', () => {
    const gateCount = (userMgmt.match(/normalizeRole\(role\) === 'super_admin' && \(/g) ?? []).length;
    expect(gateCount).toBe(2);
    // normalizeRole is already imported/used elsewhere in this file for other
    // role checks — no new permission helper or logic was introduced.
    expect(userMgmt).toContain('normalizeRole,');
  });

  it('both are wrapped in Suspense with a minimal, non-admin-revealing fallback (PhoenixLoadingState)', () => {
    const suspenseBlocks = userMgmt.match(/<Suspense fallback=\{<PhoenixLoadingState \/>\}>[\s\S]*?<\/Suspense>/g) ?? [];
    expect(suspenseBlocks.length).toBe(2);
    expect(suspenseBlocks[0]).toContain('<AvailabilityCleanupWizard lang={lang} role={role} />');
    expect(suspenseBlocks[1]).toContain('<PlatformBroadcastAdminPanel lang={lang} role={role} />');
  });

  it('props passed to each component are unchanged (lang, role — same as before)', () => {
    expect(userMgmt).toMatch(/<AvailabilityCleanupWizard lang=\{lang\} role=\{role\} \/>/);
    expect(userMgmt).toMatch(/<PlatformBroadcastAdminPanel lang=\{lang\} role=\{role\} \/>/);
  });
});

describe('Non-super users: chunk never rendered, screen otherwise unaffected', () => {
  it('the role gate is a plain boolean short-circuit ({cond && (<Suspense>...)}) — for any non-super role this JSX branch never renders, so React.lazy never triggers the dynamic import', () => {
    // Structural guarantee: `{expr && (<Suspense>...)}` renders nothing at all
    // (not even the Suspense fallback) when expr is false — React never
    // attempts to mount the lazy child, so the chunk is never requested.
    const idx1 = userMgmt.indexOf("normalizeRole(role) === 'super_admin' && (\n        <Suspense fallback={<PhoenixLoadingState />}>\n          <AvailabilityCleanupWizard");
    const idx2 = userMgmt.indexOf("normalizeRole(role) === 'super_admin' && (\n        <Suspense fallback={<PhoenixLoadingState />}>\n          <PlatformBroadcastAdminPanel");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(-1);
  });

  it('nothing else in the component body (user list, permission matrix, lifecycle actions) depends on these two panels being mounted', () => {
    // The panels are appended at the very end of the screen's JSX tree with
    // no shared state/props threaded back into the rest of the screen. Only
    // the module-level lazy() declarations (above the component function)
    // are allowed to reference them before this point.
    const componentStart = userMgmt.indexOf('export function UserManagementScreen()');
    const panelsSectionStart = userMgmt.indexOf('{/* PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A');
    expect(componentStart).toBeGreaterThan(-1);
    expect(panelsSectionStart).toBeGreaterThan(componentStart);
    const bodyBeforePanels = userMgmt.slice(componentStart, panelsSectionStart);
    expect(bodyBeforePanels).not.toMatch(/AvailabilityCleanupWizard|PlatformBroadcastAdminPanel/);
  });
});

describe('Super Admin path: both panels still fully wired, same internal gating as defense in depth', () => {
  it('AvailabilityCleanupWizard still internally checks normalizeRole(role) === \'super_admin\' and returns null otherwise (untouched)', () => {
    expect(wizard).toContain("const isSuper = normalizeRole(role) === 'super_admin';");
    expect(wizard).toContain('if (!isSuper) return null;');
  });

  it('PlatformBroadcastAdminPanel still internally checks normalizeRole(role) === \'super_admin\' and returns null otherwise (untouched)', () => {
    expect(adminPanel).toContain("const isSuper = normalizeRole(role) === 'super_admin';");
    expect(adminPanel).toContain('if (!isSuper) return null;');
  });

  it('Deep Clean wizard RPC/confirmation logic is completely untouched by this phase', () => {
    expect(wizard).toContain('dryRunAvailabilityDeepClean');
    expect(wizard).toContain('executeAvailabilityDeepClean');
    expect(wizard).toContain('DEEP_CLEAN_AVAILABILITY_CONFIRMATION');
  });

  it('Platform Broadcast admin panel RPC/confirmation logic is completely untouched by this phase', () => {
    expect(adminPanel).toContain('createPlatformBroadcast');
    expect(adminPanel).toContain('deletePlatformBroadcast');
    expect(adminPanel).toContain('DELETE_PLATFORM_BROADCAST_CONFIRMATION');
  });
});

describe('Public QR route and PlatformBroadcastGate are unaffected by this phase', () => {
  it('App.tsx / AuthenticatedApp.tsx (the QR-BUNDLE-CODE-SPLIT-A boundary) were not touched by this phase', () => {
    expect(app).toContain("params.get('qid')");
    expect(app).toContain("params.get('token')");
    expect(app).toContain('<AuthenticatedApp');
    expect(authenticatedApp).toContain('UserManagementScreen');
  });

  it('PlatformBroadcastGate remains mounted only inside PhoenixAppShell (authenticated-only), untouched', () => {
    expect(appShell).toContain('<PlatformBroadcastGate />');
    expect(platformBroadcastGate).toContain('authReady && !!sessionUserId && !!profileId && !!activeOrgId');
  });
});
