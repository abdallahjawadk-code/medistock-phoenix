import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CENTER_SCREEN,
  commandCenterLanding,
  isCommandCenterEligible,
  isScreenAuthorized,
  roleLandingScreen,
} from '@/shared/authz/screen-access';
import { isScreenRestorable } from '@/app/screen-continuity';
import { roleDefaults } from '@/shared/lib/permissions';
import {
  deriveCriticalSignals,
  deriveKpis,
  derivePanels,
  deriveStockHealth,
} from '../command-center.model';
import { classifyCommandCenterError } from '../useCommandCenter';
import type { CommandCenterReadContract } from '@/shared/supabase/services/command-center.service';

const SRC = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const CAPS = {
  dashboard_view: true,
  alerts_view: false,
  reports_view: false,
  warehouse_stock_view: false,
  outlet_stock_view: false,
  warehouse_transfer_view: false,
};

function orgContract(over: Partial<CommandCenterReadContract> = {}): CommandCenterReadContract {
  return {
    ok: true,
    scope: { kind: 'organization', organization_id: 'org-1', warehouse_id: null, distribution_point_id: null },
    capabilities: { ...CAPS },
    summary: {
      availability_rows: 40, quantity_units: 900,
      available: 20, low_stock: 6, missing: 4, near_expiry: 7, expired: 3, surplus: 0,
    },
    network: { organizations: 1, warehouses: 4, distribution_points: 9 },
    trend: null,
    trend_status: 'deferred_pending_measurement',
    near_expiry_days: 270,
    as_of: '2026-08-25T00:00:00.000Z',
    ...over,
  } as CommandCenterReadContract;
}

function warehouseContract(): CommandCenterReadContract {
  return {
    ok: true,
    scope: { kind: 'warehouse', organization_id: 'org-1', warehouse_id: 'wh-1', distribution_point_id: null },
    capabilities: { ...CAPS, warehouse_stock_view: true },
    summary: {
      stock_lines: 30, on_hand_units: 500, available_units: 420,
      zero_available_lines: 5, expired_lines: 2, near_expiry_lines: 3,
    },
    network: { organizations: 1, warehouses: 1, distribution_points: 2 },
    trend: null,
    trend_status: 'deferred_pending_measurement',
    near_expiry_days: 270,
    as_of: '2026-08-25T00:00:00.000Z',
  } as CommandCenterReadContract;
}

/* ────────────────────────────────────────────────────────────────────────── */

describe('RAC-3 · A) eligibility is a capability decision, never a role map', () => {
  it('admits exactly the actors holding dashboard.view', () => {
    expect(isCommandCenterEligible('institution_admin', new Set(['dashboard.view']))).toBe(true);
    expect(isCommandCenterEligible('warehouse_officer', new Set(['dashboard.view']))).toBe(true);
    expect(isCommandCenterEligible('super_admin', new Set(['dashboard.view']))).toBe(true);

    // No key -> refused, whatever the role name says.
    expect(isCommandCenterEligible('super_admin', new Set())).toBe(false);
    expect(isCommandCenterEligible('institution_admin', new Set())).toBe(false);
  });

  it('refuses the three roles migration 199 proves fail closed at runtime', () => {
    // These hold no dashboard.view by DB default, which is precisely why the
    // M199 dynamic suite asserts 42501 for each of them.
    for (const role of ['central_warehouse_manager', 'outlet_officer', 'health_center_manager']) {
      expect(roleDefaults(role).has('dashboard.view'), role).toBe(false);
      expect(isCommandCenterEligible(role, roleDefaults(role)), role).toBe(false);
    }
  });

  it('refuses a facility-scoped role even if it somehow carries the key', () => {
    // The facility-scoped branch returns before the capability gate, so an
    // override cannot open an organization-level surface to this role.
    expect(isCommandCenterEligible('health_center_manager', new Set(['dashboard.view']))).toBe(false);
    expect(isScreenAuthorized(COMMAND_CENTER_SCREEN, 'health_center_manager', new Set(['dashboard.view']))).toBe(false);
  });

  it('honours a per-profile grant, because effective permissions are the source', () => {
    // central_warehouse_manager holds no default key; an administrator granting
    // it must be honoured here exactly as the database honours it.
    expect(isCommandCenterEligible('central_warehouse_manager', new Set(['dashboard.view']))).toBe(true);
  });
});

describe('RAC-3 · B) landing preserves every ineligible actor exactly', () => {
  it('prefers the Command Center only for an eligible actor', () => {
    expect(commandCenterLanding('institution_admin', new Set(['dashboard.view']))).toBe(COMMAND_CENTER_SCREEN);
    expect(commandCenterLanding('institution_admin', new Set())).toBeNull();
  });

  it('leaves roleLandingScreen byte-identical to its pre-RAC-3 answers', () => {
    // The refusal fallback must not move. These are the exact values the
    // pre-existing suites pin.
    expect(roleLandingScreen('outlet_officer')).toBe(18);
    expect(roleLandingScreen(undefined)).toBe(18);
    expect(roleLandingScreen('health_center_manager')).toBe(18);
    for (const role of ['super_admin', 'institution_admin', 'central_warehouse_manager', 'warehouse_officer']) {
      expect(roleLandingScreen(role), role).toBe(21);
    }
  });

  it('keeps the existing landing for actors that intentionally lack the key', () => {
    for (const role of ['central_warehouse_manager', 'outlet_officer', 'health_center_manager']) {
      const perms = roleDefaults(role);
      expect(commandCenterLanding(role, perms), role).toBeNull();
      // …and therefore the caller falls through to precisely the old value.
      const landing = commandCenterLanding(role, perms) ?? roleLandingScreen(role);
      expect(landing, role).toBe(roleLandingScreen(role));
    }
  });

  it('never lands anyone on a screen the guard would then refuse', () => {
    for (const role of ['super_admin', 'institution_admin', 'central_warehouse_manager',
      'warehouse_officer', 'outlet_officer', 'health_center_manager', 'something_new']) {
      const perms = roleDefaults(role);
      const landing = commandCenterLanding(role, perms) ?? roleLandingScreen(role);
      expect(isScreenAuthorized(landing, role, perms), `${role} -> ${landing}`).toBe(true);
    }
  });

  it('makes the Command Center restorable, still subject to re-authorisation', () => {
    expect(isScreenRestorable(COMMAND_CENTER_SCREEN, 'institution_admin', new Set(['dashboard.view']))).toBe(true);
    // Storage is never trusted: without the key the restore is refused.
    expect(isScreenRestorable(COMMAND_CENTER_SCREEN, 'institution_admin', new Set())).toBe(false);
    expect(isScreenRestorable(COMMAND_CENTER_SCREEN, 'health_center_manager', new Set(['dashboard.view']))).toBe(false);
  });
});

describe('RAC-3 · C) the screen consumes only the secured RAC-2 service', () => {
  const screen = read('features/command-center/CommandCenterScreen.tsx');
  const hook = read('features/command-center/useCommandCenter.ts');
  const model = read('features/command-center/command-center.model.ts');

  it('never imports the supabase client or the legacy dashboard service', () => {
    for (const source of [screen, hook, model]) {
      expect(source).not.toContain('supabase/client');
      expect(source).not.toContain('dashboard.service');
      expect(source).not.toMatch(/\.rpc\(/);
      expect(source).not.toMatch(/\.from\(/);
    }
  });

  it('reaches the database through the RAC-2 typed service only', () => {
    expect(hook).toContain("from '@/shared/supabase/services/command-center.service'");
    expect(hook).toContain('getCommandCenterReadContract');
  });

  it('derives authority from server capabilities, not from role strings', () => {
    // No role-name branching anywhere in the feature's rendering decisions.
    for (const source of [screen, model]) {
      for (const role of ['super_admin', 'institution_admin', 'outlet_officer',
        'warehouse_officer', 'central_warehouse_manager', 'health_center_manager']) {
        expect(source, role).not.toContain(`'${role}'`);
      }
    }
    expect(model).toContain('capabilities');
  });

  it('issues no polling, no interval and no visibility-driven refetch', () => {
    for (const source of [screen, hook]) {
      expect(source).not.toContain('setInterval');
      expect(source).not.toContain('visibilitychange');
      expect(source).not.toContain('setTimeout');
    }
  });

  it('makes exactly one request per scope, from one hook call', () => {
    expect(screen.match(/useCommandCenter\(/g)?.length).toBe(1);
    expect(hook.match(/getCommandCenterReadContract\(/g)?.length).toBe(1);
  });
});

describe('RAC-3 · D) KPI and panel derivation is honest about what it received', () => {
  it('never turns an absent figure into zero', () => {
    const contract = orgContract({
      summary: { availability_rows: 5, quantity_units: 10, available: 5 } as never,
    });
    const kpis = deriveKpis(contract);
    const missing = kpis.find(k => k.id === 'missing');
    expect(missing).toBeDefined();
    // Absent in the payload -> null, NOT 0.
    expect(missing?.value).toBeNull();
    expect(kpis.find(k => k.id === 'available')?.value).toBe(5);
  });

  it('picks the summary shape from the scope the server reported', () => {
    expect(deriveKpis(orgContract()).map(k => k.id)).toContain('low_stock');
    expect(deriveKpis(warehouseContract()).map(k => k.id)).toContain('stock_lines');
    // The two shapes never bleed into each other.
    expect(deriveKpis(warehouseContract()).map(k => k.id)).not.toContain('low_stock');
  });

  it('builds stock-health slices only from reported, positive states', () => {
    const slices = deriveStockHealth(orgContract());
    expect(slices.map(s => s.id)).toEqual(['available', 'low_stock', 'near_expiry', 'expired', 'missing']);
    // surplus is 0 in the fixture, so it is omitted rather than drawn as an
    // invisible zero-length arc.
    expect(slices.map(s => s.id)).not.toContain('surplus');
    // The slices sum to exactly what the ring draws.
    expect(slices.reduce((n, s) => n + s.value, 0)).toBe(40);
  });

  it('returns no slices for an all-zero payload, so the panel can say so', () => {
    const empty = orgContract({
      summary: {
        availability_rows: 0, quantity_units: 0,
        available: 0, low_stock: 0, missing: 0, near_expiry: 0, expired: 0, surplus: 0,
      },
    });
    expect(deriveStockHealth(empty)).toEqual([]);
  });

  it('omits a critical signal that is zero instead of claiming "0 critical"', () => {
    const clean = orgContract({
      summary: {
        availability_rows: 20, quantity_units: 100,
        available: 20, low_stock: 0, missing: 0, near_expiry: 0, expired: 0, surplus: 0,
      },
    });
    expect(deriveCriticalSignals(clean)).toEqual([]);
    expect(deriveCriticalSignals(orgContract()).map(s => s.id))
      .toEqual(['expired', 'missing', 'near_expiry', 'low_stock']);
  });

  it('gates panels on the capability flags the contract sent', () => {
    expect(derivePanels({ ...CAPS }).alertsLink).toBe(false);
    expect(derivePanels({ ...CAPS, alerts_view: true }).alertsLink).toBe(true);
    expect(derivePanels({ ...CAPS, reports_view: true }).reportsLink).toBe(true);
  });
});

describe('RAC-3 · E) the trend stays deferred and is never fabricated', () => {
  const trend = read('features/command-center/panels/TrendPanel.tsx');

  it('renders the deferred status the contract declares', () => {
    expect(orgContract().trend).toBeNull();
    expect(orgContract().trend_status).toBe('deferred_pending_measurement');
  });

  it('draws no series, axis or sample geometry', () => {
    expect(trend).not.toContain('<svg');
    expect(trend).not.toContain('<path');
    expect(trend).not.toContain('polyline');
    expect(trend).not.toMatch(/\[\s*\d+\s*,/); // no inline sample array
  });
});

describe('RAC-3 · F) no chart dependency was introduced', () => {
  it('adds no charting package to package.json', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const banned of ['recharts', 'chart.js', 'echarts', 'apexcharts', 'victory',
      'd3', 'nivo', '@nivo/core', 'react-chartjs-2', 'plotly.js']) {
      expect(Object.keys(deps), banned).not.toContain(banned);
    }
  });

  it('draws its one visualization with plain SVG', () => {
    const health = read('features/command-center/panels/StockHealthPanel.tsx');
    expect(health).toContain('<svg');
    expect(health).toContain('strokeDasharray');
    expect(health).not.toMatch(/from 'recharts'|from 'chart\.js'|from 'd3'/);
  });
});

describe('RAC-3 · G) failures are classified, never flattened into "no data"', () => {
  it('separates a refusal from a transport failure', () => {
    expect(classifyCommandCenterError({ code: '42501', message: 'command_center_forbidden' }).kind)
      .toBe('unauthorized');
    expect(classifyCommandCenterError({ code: '22023', message: 'command_center_invalid_scope' }).kind)
      .toBe('invalid_scope');
    expect(classifyCommandCenterError({ code: '28000', message: 'nope' }).kind).toBe('unauthenticated');
    expect(classifyCommandCenterError({ code: '42883', message: 'missing' }).kind).toBe('unavailable');
    expect(classifyCommandCenterError(new Error('Failed to fetch')).kind).toBe('network');
  });

  it('classifies from the raised message when the SQLSTATE is not preserved', () => {
    expect(classifyCommandCenterError(new Error('command_center_forbidden')).kind).toBe('unauthorized');
  });

  it('treats an unrecognised failure as transport, not as a refusal', () => {
    // Reporting an unproven refusal would misinform the operator about their
    // own authority; the recoverable reading is the safe default.
    expect(classifyCommandCenterError({ code: '08006', message: 'connection lost' }).kind).toBe('network');
    expect(classifyCommandCenterError(undefined).kind).toBe('network');
  });

  it('drops the payload on an authorization answer', () => {
    const hook = read('features/command-center/useCommandCenter.ts');
    expect(hook).toContain("classified.kind === 'unauthorized'");
    expect(hook).toContain('setData(null)');
  });
});

describe('RAC-3 · H) the mobile notification hotfix is untouched', () => {
  const bell = read('shared/ui/NotificationBell.tsx');

  it('keeps every element of the PR #165 reliability fix', () => {
    expect(bell).toContain('createPortal');
    expect(bell).toContain('document.body');
    expect(bell).toContain('env(safe-area-inset-top, 0px)');
    expect(bell).toContain('env(safe-area-inset-bottom, 0px)');
    expect(bell).toContain('var(--z-modal)');
    expect(bell).toContain("event.key !== 'Escape'");
    expect(bell).toContain('bellButtonRef.current?.focus()');
    expect(bell).toContain('panelRef.current?.contains(target)');
  });

  it('was not modified by RAC-3 at all', () => {
    // Byte-identical to the merged Production tree.
    const diff = execSync(
      'git diff --name-only b707f073d60b4cc61205c35003ab491f3aed7468 -- src/shared/ui/NotificationBell.tsx',
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(diff.trim()).toBe('');
  });
});

describe('RAC-3 · I) no backend or migration change', () => {
  /**
   * UAT-BUG-001 landed migration 200 (the demo-purge auth-boundary correction)
   * after RAC-3, as a separately-reviewed change with its own static and
   * dynamic tests and its own entry in every exact-filename guard. It also
   * shifts the reviewed-migration ceiling from 199 to 200, which edits the
   * ceiling assertions living under supabase/migrations/__tests__/.
   *
   * A blanket "nothing under supabase/ ever changes again" ban would therefore
   * now fail for a correct, reviewed migration — the same situation the
   * dependency guard below already had to solve for package.json.
   *
   * The guarantee that actually matters — that RAC-3 itself is frontend-only —
   * is asserted DIRECTLY instead: no SQL file other than migration 200 may
   * differ, and nothing under supabase/ outside its test directory may differ.
   * That still fails closed on any migration RAC-3 might smuggle in, and is
   * narrower than the ban it replaces rather than weaker.
   */
  it('adds no migration and touches no SQL', () => {
    const M200 = 'supabase/migrations/200_phoenix_demo_purge_auth_boundary_correction.sql';
    // ISW1-D1: migration 201 is the server half of the organization
    // archive-safety repair — a BEFORE UPDATE OF status guard that refuses
    // archiving while canonical dependencies live. Registered by EXACT
    // filename, exactly as M200 was, so this guard still fails closed for any
    // OTHER migration or supabase/ file. RAC-3's own subject (the command
    // centre) is untouched by it.
    const M201 = 'supabase/migrations/201_phoenix_organization_archive_dependency_guard.sql';
    // ISW2: migration 202 closes the post-archive dependency-write race 201
    // disclosed as a known residual. Registered by EXACT filename, exactly as
    // M200/M201 were. RAC-3's own subject is untouched by it.
    const M202 = 'supabase/migrations/202_phoenix_organization_archive_reciprocal_guard.sql';
    // MDS-203..208: the material-dispensing-suspension domain and its five
    // enforcement migrations. Registered by EXACT filename, exactly as
    // M200/M201/M202 were. RAC-3's own subject (the command centre) is
    // untouched by any of them.
    const M203 = 'supabase/migrations/203_phoenix_material_dispensing_suspension.sql';
    const M204 = 'supabase/migrations/204_phoenix_dispensing_suspension_enforcement_dispense.sql';
    const M205 = 'supabase/migrations/205_phoenix_dispensing_suspension_enforcement_fefo.sql';
    const M206 = 'supabase/migrations/206_phoenix_dispensing_suspension_enforcement_suggestions.sql';
    const M207 = 'supabase/migrations/207_phoenix_dispensing_suspension_enforcement_warehouse_send.sql';
    const M208 = 'supabase/migrations/208_phoenix_dispensing_suspension_enforcement_replenishment_and_drafts.sql';
    const ALLOWED_SQL = [M200, M201, M202, M203, M204, M205, M206, M207, M208];
    const changed = execSync(
      'git diff --name-only b707f073d60b4cc61205c35003ab491f3aed7468',
      { cwd: process.cwd(), encoding: 'utf8' },
    ).split('\n').map(l => l.trim()).filter(Boolean);
    expect(changed.filter(f => f.endsWith('.sql') && !ALLOWED_SQL.includes(f))).toEqual([]);
    expect(changed.filter(f =>
      f.startsWith('supabase/')
      && !f.startsWith('supabase/migrations/__tests__/')
      && !ALLOWED_SQL.includes(f))).toEqual([]);
  });

  /**
   * The v2.1.0 release ceremony legitimately edits package.json and the
   * lockfile to carry the release version, so a blanket "these files never
   * change" ban would now fail for a correct release.
   *
   * The guarantee that actually matters — that no dependency was added, removed
   * or moved — is asserted DIRECTLY instead, by diffing the dependency graph
   * rather than the filename. That is strictly stronger than the ban it
   * replaces: it would also catch a dependency edit smuggled in beside a
   * version bump, which a filename check never could.
   */
  it('changes no dependency — only the release version may differ', () => {
    // SECURITY-BROWSERSLIST-4-28-7: the audited dependency baseline advances
    // from b707f073 to d4bd65d2, the reviewed security commit that resolves
    // GHSA-c83g-rgw3-j3cx and GHSA-73wf-gq98-2v4g by lifting browserslist off
    // the vulnerable <=4.28.6 range (4.28.4 -> 4.28.8, plus that package's own
    // data subtree: update-browserslist-db, baseline-browser-mapping,
    // caniuse-lite, electron-to-chromium, node-releases). That commit changes
    // package-lock.json ONLY — no manifest edit, no override, no added or
    // removed package, 501 entries before and after — and is evidenced in
    // artifacts 475-478.
    //
    // Registering the new baseline by EXACT commit, exactly as migrations 200,
    // 201 and 202 were registered by exact filename in the guard above. The
    // assertion itself is untouched and stays byte-exact: the browserslist
    // cluster is NOT normalised or exempted, no range or allowlist is
    // introduced, and any dependency drift away from d4bd65d2 still fails
    // closed. The five package.json fields asserted below are byte-identical
    // between b707f073 and d4bd65d2, so advancing the pin changes what the
    // approved graph IS, never how strictly it is enforced.
    const BASE = 'd4bd65d2910969c3f088ad002b396b6583ec58f9';
    const jsonAt = (ref: string, file: string) => JSON.parse(
      execSync(`git show ${ref}:${file}`, { cwd: process.cwd(), encoding: 'utf8' }),
    );

    const base = jsonAt(BASE, 'package.json');
    const head = jsonAt('HEAD', 'package.json');
    expect(head.dependencies).toEqual(base.dependencies);
    expect(head.devDependencies).toEqual(base.devDependencies);
    expect(head.overrides).toEqual(base.overrides);
    expect(head.scripts).toEqual(base.scripts);
    expect(head.name).toBe(base.name);

    // The lockfile's whole graph must be identical too — only the two root
    // version fields may move.
    const normalise = (lock: Record<string, unknown>) => {
      const packages = { ...(lock.packages as Record<string, Record<string, unknown>>) };
      packages[''] = { ...packages[''], version: 'RELEASE_VERSION' };
      return JSON.stringify({ ...lock, version: 'RELEASE_VERSION', packages });
    };
    expect(normalise(jsonAt('HEAD', 'package-lock.json')))
      .toBe(normalise(jsonAt(BASE, 'package-lock.json')));
  });
});

describe('RAC-3 · J) owner polish — Statistics identity and no Quick Actions', () => {
  const strings = read('shared/i18n/strings.ts');
  const shell = read('shared/ui/PhoenixAppShell.tsx');
  const screenSrc = read('features/command-center/CommandCenterScreen.tsx');
  const header = read('features/command-center/panels/CommandCenterHeader.tsx');

  it('names screen 22 «الإحصائيات» / Statistics in both languages', () => {
    expect(strings).toContain("rac3_nav:            { ar: 'الإحصائيات',               en: 'Statistics' },");
    expect(strings).toContain("rac3_title:          { ar: 'الإحصائيات',               en: 'Statistics' },");
  });

  it('leaves no user-visible Command Center wording in any rac3_ string', () => {
    const rac3Lines = strings.match(/^\s+rac3_[a-z_]+:.*$/gm) ?? [];
    expect(rac3Lines.length).toBeGreaterThan(30);
    for (const line of rac3Lines) {
      expect(line, line.slice(0, 60)).not.toContain('مركز القيادة');
      expect(line, line.slice(0, 60)).not.toContain('Command Center');
    }
  });

  it('maps the shell topbar title for screen 22 at its real source', () => {
    // The wrong «مركز التقارير والمواقف» header came from PhoenixAppShell's
    // `?? 'nav_decision_reports'` fallback, because 22 was missing from the map.
    // Fixed at the source, not patched in the page body.
    expect(shell).toContain("22: 'rac3_nav',");
    expect(shell).toContain("const title = t(SCREEN_TITLE_KEYS[currentScreen] ?? 'nav_decision_reports', lang);");
  });

  it('titles the page with an h2, leaving the shell topbar as the only h1', () => {
    expect(header).toContain('<h2 className="rac3-header__title">');
    expect(header).not.toContain('<h1');
  });

  it('composes no Quick Actions panel and imports nothing for one', () => {
    expect(screenSrc).not.toContain('QuickActionGrid');
    expect(screenSrc).not.toContain('QUICK_ACTION_CANDIDATES');
    expect(screenSrc).not.toContain('rac3_panel_actions');
    // Removed from the composition, not hidden: no leftover CSS hook either.
    expect(read('shared/lib/rac3-command-center.css')).not.toContain('rac3-panel--actions');
  });

  it('keeps the shared QuickActionGrid and its other consumers intact', () => {
    // The component is shared. Removing OUR panel must not remove theirs.
    expect(read('features/reports/DecisionIntelligenceReportsScreen.tsx')).toContain('QuickActionGrid');
    expect(read('features/status/StatusCenterScreen.tsx')).toContain('QuickActionGrid');
  });

  it('keeps every canonical navigation destination reachable', () => {
    // The destinations the removed panel linked to must still be offered by the
    // real navigation surfaces, which are the reason the panel was redundant.
    const sidebar = read('shared/ui/PhoenixSidebar.tsx');
    const drawer = read('shared/ui/PhoenixMobileDrawer.tsx');
    for (const s of [3, 13, 14, 17, 18, 19, 21]) {
      expect(sidebar + drawer, `screen ${s}`).toContain(`screen: ${s},`);
    }
    // …and screen 22 itself is still projected, under the new label.
    for (const surface of [sidebar, drawer, read('shared/ui/PhoenixMobileBottomNav.tsx'),
      read('shared/ui/CommandPalette.tsx')]) {
      expect(surface).toContain("{ screen: 22, icon: 'command', labelKey: 'rac3_nav' },");
    }
  });

  it('did not touch the screen-22 authorization rule while renaming it', () => {
    const authz = read('shared/authz/screen-access.ts');
    expect(authz).toContain('if (screen === COMMAND_CENTER_SCREEN) return permissions.has(DASHBOARD_VIEW_PERMISSION);');
    expect(authz).toContain('export const COMMAND_CENTER_SCREEN = 22;');
    expect(authz).toContain("export const DASHBOARD_VIEW_PERMISSION = 'dashboard.view';");
  });
});
