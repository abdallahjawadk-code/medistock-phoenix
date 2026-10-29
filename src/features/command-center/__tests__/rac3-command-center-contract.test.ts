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
    // CN-1A: migration 209 is the Central Needs core registry — five new
    // organization-scoped tables, RLS, and four permission keys. Registered
    // by EXACT filename, exactly as M200-M208 were. RAC-3's own subject (the
    // command centre) is untouched by it.
    const M209 = 'supabase/migrations/209_phoenix_central_needs_registry.sql';
    // CN-1B: migration 210 is the Central Needs import/review workflow layer —
    // SECURITY DEFINER RPCs, one canonical-link table and the dual-pass trust
    // evidence on M209's import session. Registered by EXACT filename, exactly
    // as M200-M209 were. RAC-3's own subject (the command centre) is untouched
    // by it.
    const M210 = 'supabase/migrations/210_phoenix_central_needs_workflow_rpcs.sql';
    // CN-2B: migration 211 is the Central Needs import review workflow's
    // batch-and-disposition layer — reviewed and forward-only. Registered by
    // EXACT filename, exactly as M200-M210 were. RAC-3's own subject (the
    // command centre) remains untouched by it.
    const M211 = 'supabase/migrations/211_phoenix_central_needs_batch_and_disposition.sql';
    // CN-2B conformance: migration 212 is the Central Needs operational
    // need-line layer — two additive organization-scoped relations, one narrow
    // write RPC and the extended review-readiness blockers. Registered by
    // EXACT filename, exactly as M200-M211 were. RAC-3's own subject (the
    // command centre) remains untouched by it.
    const M212 = 'supabase/migrations/212_phoenix_central_needs_need_lines.sql';
    // CN-2B corrective: migration 213 is the independently reviewed Central
    // Needs beneficiary-column-mapping layer — one additive organization-scoped
    // relation, its write/read RPCs and the designation blocker. Registered by
    // EXACT filename, exactly as M200-M212 were. RAC-3's own subject (the
    // command centre) remains untouched by it.
    const M213 = 'supabase/migrations/213_phoenix_central_needs_beneficiary_column_mapping.sql';
    // M214: the Central Needs readiness-RPC transaction-mode correction — it
    // advances that one function's volatility (STABLE -> VOLATILE) and changes
    // no body, grant or search_path. Registered by EXACT filename, exactly as
    // M200-M213 were, so this guard still fails closed for any OTHER migration
    // or supabase/ file. RAC-3's own subject (the command centre) is untouched.
    const M214 = 'supabase/migrations/214_phoenix_central_needs_review_readiness_volatility.sql';
    // C2/M215: the governed Central Needs correction lifecycle — function-only;
    // it touches no command-centre object. Registered by EXACT filename, exactly
    // as M200-M214 were, so this guard still fails closed for any OTHER
    // migration or supabase/ file.
    const M215 = 'supabase/migrations/215_phoenix_central_needs_governed_correction_lifecycle.sql';
    // C4/M216: the independently reviewed Central Needs beneficiary-region
    // persistence — one region-version relation and the governed M213 <-> region
    // coexistence; it touches no command-centre object. Registered by EXACT
    // filename, exactly as M200-M215 were, so this guard still fails closed for
    // any OTHER migration or supabase/ file.
    const M216 = 'supabase/migrations/216_phoenix_central_needs_region_persistence.sql';
    // C5/M217: the Central Needs safety convergence (classifier, shared
    // quantity-lineage helper, NOT VALID source-value CHECK, approval-gate
    // fence); it touches no command-centre object. Registered by EXACT
    // filename, exactly as M200-M216 were, so this guard still fails closed for
    // any OTHER migration or supabase/ file. Its static, dynamic, lifecycle-chain
    // and activation-rehearsal suites live under supabase/migrations/__tests__/,
    // which this guard already exempts, and are not SQL.
    const M217 = 'supabase/migrations/217_phoenix_central_needs_c5_safety_convergence.sql';
    // C6-F1/M218: the Central Needs submission integrity fence (submission-gate
    // fence trigger on plan revisions, ACL-neutral submit/approve replacements);
    // it touches no command-centre object. Registered by EXACT filename, exactly
    // as M200-M217 were, so this guard still fails closed for any OTHER migration
    // or supabase/ file. Its static and dynamic suites live under
    // supabase/migrations/__tests__/, which this guard already exempts.
    const M218 = 'supabase/migrations/218_phoenix_central_needs_submission_integrity_fence.sql';
    // AUTH-1/M219: the sign-up authority hardening (internal 'pending_provisioning'
    // profiles role value plus a shape CHECK; sign-up, provisioning and
    // effective-permissions functions replaced with owners, ACLs and search_path
    // unchanged); it touches no command-centre object. Registered by EXACT
    // filename, exactly as M200-M218 were, so this guard still fails closed for
    // any OTHER migration or supabase/ file. Its static and dynamic suites live
    // under supabase/migrations/__tests__/, which this guard already exempts.
    const M219 = 'supabase/migrations/219_phoenix_auth_signup_authority_hardening.sql';
    // PRE3-B/M220: the Central Needs active-item server guard (the disposition
    // RPC is replaced, with signature, owner, ACL, SECURITY DEFINER and
    // search_path unchanged, and now requires a mapped central item to exist and
    // be active, read FOR SHARE; one private SECURITY INVOKER gate function with
    // no client grant, fired by one BEFORE UPDATE trigger on
    // central_needs_plan_revisions, re-checks active items at submit and
    // approve); it touches no command-centre object.
    // Registered by EXACT filename, exactly as M200-M219 were, so this guard
    // still fails closed for any OTHER migration or supabase/ file. Its static and
    // dynamic suites live under supabase/migrations/__tests__/, which this guard
    // already exempts.
    const M220 = 'supabase/migrations/220_phoenix_central_needs_active_item_guard.sql';
    // PDA-PROC-1/M221: the pharmacy department supplementary procurement
    // exclusion (one SECURITY DEFINER trigger guard function with no client
    // grant, fired by twelve BEFORE triggers on procurement_suppliers,
    // procurement_orders, procurement_order_lines, procurement_order_events,
    // procurement_receipts, procurement_receipt_lines, procurement_returns and
    // warehouse_stock, refuses procurement and purchase/supplementary stock for
    // any organization that is not a care_institution; no RPC is created or
    // replaced); it touches no command-centre object.
    // Registered by EXACT filename, exactly as M200-M220 were, so this guard
    // still fails closed for any OTHER migration or supabase/ file. Its static and
    // dynamic suites live under supabase/migrations/__tests__/, which this guard
    // already exempts.
    const M221 = 'supabase/migrations/221_phoenix_pharmacy_department_subpurchase_exclusion.sql';
    // Route A proposed M222 (OPS2-F1 v2 governed warehouse correction: one new
    // owner-only correction applier, plus the correction-request RPC and the generic
    // guarded movement writer re-bodied with unchanged ACLs); it touches no
    // command-centre object.
    // Registered by EXACT filename, exactly as M200-M221 were, so this guard
    // still fails closed for any OTHER migration or supabase/ file. Its two dynamic
    // security suites live under supabase/migrations/__tests__/, which this guard
    // already exempts.
    const M222 = 'supabase/migrations/222_phoenix_governed_warehouse_correction_security.sql';
    // R1 (staging release candidate): the un-numbered SQL CANDIDATES and their tooling/tests under supabase/candidates/ (never in the numbered
    // chain, never applied outside a disposable database) are registered by EXACT filename, exactly as M200-M222 were; no wildcard and no
    // directory exemption, so every other supabase/ file still fails this guard closed. They touch no command-centre object.
    const R1_CANDIDATES = [
      // D18: the unnumbered, unapplied R1 forward-fix candidate (exact filename).
      'supabase/candidates/FF1_r1_forward_fix_NOT_APPLIED.sql',
      'supabase/candidates/R1a_01_manual_source_schema_inert.sql',
      'supabase/candidates/R1a_02_authorization_closure.sql',
      // R1-RBAC-v2: exact reviewed #248 paths; every unlisted sibling remains refused.
      'supabase/candidates/R1a_02_authorization_closure_v2.sql',
      'supabase/candidates/R1a_06_material_registration_inert_v2.sql',
      'supabase/candidates/R1b_01_manual_activation_NOT_APPLIED_v2.sql',
      'supabase/candidates/R1a_03_lifecycle_relations_and_sod.sql',
      'supabase/candidates/R1a_04_manual_routines_inert.sql',
      'supabase/candidates/R1a_05_blockers_digest_d27.sql',
      'supabase/candidates/R1a_06_material_registration_inert.sql',
      'supabase/candidates/R1b_01_manual_activation_NOT_APPLIED.sql',
      'supabase/candidates/R1b_02_material_registration_activation_NOT_APPLIED.sql',
      'supabase/candidates/__tests__/hosted-adapter.dynamic.test.ts',
      'supabase/candidates/__tests__/m182-equivalence.dynamic.test.ts',
      'supabase/candidates/__tests__/r1-manual-lifecycle-canonical.dynamic.test.ts',
      'supabase/candidates/__tests__/r1a-01-manual-source-schema.dynamic.test.ts',
      'supabase/candidates/__tests__/r1a-02-authorization-closure.dynamic.test.ts',
      'supabase/candidates/__tests__/r1a-03-lifecycle-sod.dynamic.test.ts',
      'supabase/candidates/__tests__/r1a-04-manual-routines.dynamic.test.ts',
      'supabase/candidates/__tests__/r1a-05-blockers-digest-d27.dynamic.test.ts',
      'supabase/candidates/__tests__/r1a-06-material-registration.dynamic.test.ts',
      'supabase/candidates/__tests__/r1a-fixtures.ts',
      'supabase/candidates/__tests__/r1b-01-manual-activation.dynamic.test.ts',
      'supabase/candidates/__tests__/r1b-02-material-registration-activation.dynamic.test.ts',
      'supabase/candidates/__tests__/staging-baseline.dynamic.test.ts',
      'supabase/candidates/_build/R1a_05.template.sql',
      'supabase/candidates/_build/R1a_06.template.sql',
      'supabase/candidates/_build/R1a_06.writers.sql',
      'supabase/candidates/staging-baseline/182b_production_body_overlay.sql',
      'supabase/candidates/staging-baseline/M001-M221-freeze.json',
      'supabase/candidates/staging-baseline/audit-derivations.mjs',
      'supabase/candidates/staging-baseline/hosted-adapter/hosted-adapter.mjs',
      'supabase/candidates/staging-baseline/rollback_phase1_disposable.sql',
      'supabase/candidates/staging-baseline/sql-tokens.mjs',
      'supabase/candidates/staging-baseline/staging-baseline.mjs',
      'supabase/candidates/staging-baseline/verify_085_preconditions.sql',
      'supabase/candidates/staging-baseline/verify_baseline_221.sql',
      // F3 (S3c functional acceptance): the shared journey, its Staging runner and the disposable-database suite, registered by exact filename.
      'supabase/candidates/FF1-PLAN.md',
      'supabase/candidates/__tests__/ff1-forward-fix.dynamic.test.ts',
      'supabase/candidates/__tests__/functional-journey.dynamic.test.ts',
      'supabase/candidates/staging-baseline/hosted-adapter/functional-acceptance.mjs',
      'supabase/candidates/staging-baseline/hosted-adapter/functional-journey.mjs',
    ];
    const ALLOWED_SQL = [...R1_CANDIDATES, M200, M201, M202, M203, M204, M205, M206, M207, M208, M209, M210, M211, M212, M213, M214, M215, M216, M217, M218, M219, M220, M221, M222,
      // R1 numbering (D9 closed): the eight R1 migrations M223-M230, registered by EXACT filename (candidate bytes unchanged, R1-NUMBERING-MANIFEST.json).
      'supabase/migrations/223_phoenix_central_needs_manual_source_schema_inert.sql', 'supabase/migrations/224_phoenix_central_needs_authorization_closure.sql', 'supabase/migrations/225_phoenix_central_needs_lifecycle_relations_and_sod.sql', 'supabase/migrations/226_phoenix_central_needs_manual_routines_inert.sql', 'supabase/migrations/227_phoenix_central_needs_blockers_digest_d27.sql', 'supabase/migrations/228_phoenix_central_needs_material_registration_inert.sql', 'supabase/migrations/229_phoenix_central_needs_manual_activation.sql', 'supabase/migrations/230_phoenix_central_needs_material_registration_activation.sql', 'supabase/migrations/231_phoenix_unit_test_vocabulary.sql', 'supabase/migrations/232_phoenix_central_needs_same_actor_approval.sql', 'supabase/migrations/233_phoenix_central_needs_distinct_national_code.sql', 'supabase/migrations/234_phoenix_central_needs_annual_dossiers.sql', 'supabase/migrations/235_phoenix_central_needs_dossier_workbook_intake.sql'];
    const changed = execSync(
      'git diff --name-only b707f073d60b4cc61205c35003ab491f3aed7468',
      { cwd: process.cwd(), encoding: 'utf8' },
    ).split('\n').map(l => l.trim()).filter(Boolean);
    expect(changed.filter(f => f.endsWith('.sql') && !ALLOWED_SQL.includes(f))).toEqual([]);
    expect(changed.filter(f =>
      f.startsWith('supabase/')
      && !f.startsWith('supabase/migrations/__tests__/')
      && !ALLOWED_SQL.includes(f))).toEqual([]);
    // P-HARDEN-01 negative controls on the REAL ALLOWED_SQL list: the two hosted-adapter files are registered by exact name; near-misses are flagged.
    const flag = (files: string[]) => files.filter(f => f.startsWith('supabase/') && !f.startsWith('supabase/migrations/__tests__/') && !ALLOWED_SQL.includes(f));
    expect(flag(['supabase/candidates/staging-baseline/hosted-adapter/hosted-adapter.mjs', 'supabase/candidates/__tests__/hosted-adapter.dynamic.test.ts'])).toEqual([]);
    const unregistered = ['supabase/candidates/staging-baseline/hosted-adapter/hosted-adapter.mjs.bak', 'supabase/candidates/staging-baseline/hosted-adapter/other.mjs', 'supabase/candidates/staging-baseline/hosted-adapter.mjs',
      'supabase/candidates/__tests__/hosted-adapter.dynamic.test.ts.orig', 'supabase/candidates/__tests__/hosted-adapter-extra.dynamic.test.ts', 'supabase/candidates/hosted-adapter/hosted-adapter.mjs'];
    expect(flag(unregistered)).toEqual(unregistered);
    const r1V2NearMisses = [
      'supabase/candidates/R1a_02_authorization_closure_v2.sql.unreviewed',
      'supabase/candidates/R1a_06_material_registration_inert_v2.sql.unreviewed',
      'supabase/candidates/R1b_01_manual_activation_NOT_APPLIED_v2.sql.unreviewed',
    ];
    expect(flag(r1V2NearMisses)).toEqual(r1V2NearMisses);
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
  it('changes no dependency — package.json keeps its reviewed 6ce98332 contract and the WORKING lockfile must equal the complete SEC-HOTFIX-3 graph (the SEC-HOTFIX-2 graph frozen by exact commit + the explicit Vitest family 4.1.12 delta) plus exactly the CI-HOTFIX-4 undici 7.30.1 transformation', () => {
    // CN-2A-SHEETJS: the audited dependency baseline advances from d70b24a9
    // to 6ce98332, the reviewed CN-2A commit that adds exactly one runtime
    // dependency — `xlsx` (SheetJS Community Edition 0.20.3, vendored
    // in-repo at vendor/sheetjs/xlsx-0.20.3.tgz, never the npm registry's
    // stale 0.18.5, tarball SHA-256
    // 8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8) — for
    // the Central Needs legacy-XLS/XLSX/CSV import parser core. Nothing else
    // in `dependencies` changed (no addition, removal or move outside
    // `xlsx`), and `devDependencies`/`overrides`/`scripts`/`name` are
    // byte-identical to d70b24a9 — independently diffed field-by-field, not
    // merely asserted. Evidenced by this branch's own two commits: 3eaa1e3a
    // (adds the parser contract and engine, and the dependency itself) and
    // 6ce98332 (repairs the dependency's install path from a workspace-local
    // sibling directory to the in-repository vendored path — the earlier
    // 3eaa1e3a is deliberately NOT used as this pin, because its `xlsx`
    // value differs byte-for-byte from the final, portable one this baseline
    // must recognize).
    //
    // Registering the new baseline by EXACT commit, exactly as d4bd65d2 and
    // d70b24a9 were registered before it. The assertion itself is untouched
    // and stays byte-exact: nothing is normalised or exempted beyond the
    // pre-existing release-version allowance, no range or allowlist is
    // introduced, and any dependency drift away from 6ce98332 — including a
    // different `xlsx` version, a different install source, or any other
    // unapproved package — still fails closed. Advancing the pin changes
    // what the approved graph IS, never how strictly it is enforced.
    //
    // Since SEC-HOTFIX-1, BASE anchors the package.json contract and the
    // historical lockfile derivation only; the lockfile itself is anchored by
    // the separately reviewed graph frozen at SEC_HOTFIX_1_LOCK_BASE below,
    // since SEC-HOTFIX-2 by the graph frozen at SEC_HOTFIX_2_LOCK_BASE, and
    // since SEC-HOTFIX-3 by that graph plus the explicit Vitest 4.1.12 delta
    // below, checked against the WORKING lockfile rather than HEAD.
    const BASE = '6ce9833269536b5e5745d4139a648c6bf7d545ca';
    const jsonAt = (ref: string, file: string) => JSON.parse(
      execSync(`git show ${ref}:${file}`, { cwd: process.cwd(), encoding: 'utf8' }),
    );

    const base = jsonAt(BASE, 'package.json');
    const head = jsonAt('HEAD', 'package.json');
    expect(head.dependencies).toEqual(base.dependencies);
    expect(head.devDependencies).toEqual(base.devDependencies);
    // CI-HOTFIX-3: the one reviewed overrides delta (see the lockfile exception
    // below). The nested `@typescript-eslint/typescript-estree > minimatch >
    // brace-expansion` pin moves from exactly 5.0.9 to exactly 5.0.12; the
    // baseline value is asserted first, and every other override — and every
    // other key of this one — stays identical to the baseline.
    const ESTREE = '@typescript-eslint/typescript-estree';
    expect(base.overrides[ESTREE].minimatch['brace-expansion']).toBe('5.0.9');
    expect(head.overrides).toEqual({
      ...base.overrides,
      [ESTREE]: {
        ...base.overrides[ESTREE],
        minimatch: { ...base.overrides[ESTREE].minimatch, 'brace-expansion': '5.0.12' },
      },
    });
    // CN-2B: the lint script gains the `api` root alongside `src`, reviewed as
    // the one approved scripts delta. Every other script stays byte-identical
    // to the baseline — this is not a broad exemption, only this exact line.
    expect(head.scripts).toEqual({
      ...base.scripts,
      lint: 'eslint src api --report-unused-disable-directives --max-warnings 0',
    });
    expect(head.name).toBe(base.name);

    // The lockfile's whole graph must be identical too — only the two root
    // version fields may move (the release-version normalisation below). Since
    // SEC-HOTFIX-1 the approved graph is no longer re-derived from BASE: it is
    // the complete reviewed lockfile frozen by EXACT commit
    // (SEC_HOTFIX_1_LOCK_BASE below), which carries the TWO earlier reviewed
    // security exceptions (CI-HOTFIX-2 and CI-HOTFIX-3, below) and the reviewed
    // SEC-HOTFIX-1 sharp 0.35.5 / source-map-js 1.2.2 security fix.
    //
    // CI-HOTFIX-2 / GHSA-3wwx-pv8p-q78v: undici >=7.28.0 <7.29.1 is vulnerable
    // to denial of service through an unhandled error in WebSocket
    // permessage-deflate decompression. undici is a dev-only transitive
    // dependency (root devDependency jsdom@^29.1.1 -> jsdom@29.1.1 ->
    // undici@^7.25.0), so package.json does not change. `npm update undici`
    // (npm 10.9.8) resolves 7.30.0, inside jsdom's own range and above the
    // patched boundary, and it regenerates the lockfile root entry's `engines`
    // from package.json's existing `engines` field (not present at BASE).
    // CI-HOTFIX-2 therefore contributes EXACTLY two lockfile transformations:
    // the undici entry takes npm's generated 7.30.0 version/resolved/integrity
    // and keeps every other field, and the root entry gains
    // engines { node: '22.x' }.
    //
    // CI-HOTFIX-3 / GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7,
    // GHSA-6j4f-fj2g-mc7p: npm audit reports brace-expansion 4.0.0 - 5.0.11 as
    // vulnerable to denial of service (quadratic-time expansion, and
    // uncontrolled recursion on nested brace groups and in parseCommaParts),
    // with severity high. These newly published advisories made the reviewed
    // 5.0.9 override fail `npm audit`. The one shared
    // node_modules/brace-expansion entry is reached only through
    // minimatch@10.2.5 (brace-expansion@^5.0.5), which the lint toolchain and
    // exceljs's overridden archiver@8.0.0 -> readdir-glob@3.0.0 both resolve
    // to. CI-HOTFIX-3 therefore contributes EXACTLY the override pin above
    // (5.0.9 -> 5.0.12) and ONE lockfile transformation: that entry takes npm's
    // generated 5.0.12 version/resolved/integrity and keeps every other field.
    //
    // Until SEC-HOTFIX-1 the approved lockfile was BASE's lockfile with EXACTLY
    // those three transformations applied, and nothing else. That historical
    // contract is still asserted below, in full, against the commit SEC-HOTFIX-1
    // was built on (SEC_HOTFIX_1_LOCK_BASE~1), where it was last the approved
    // graph — so the evidence for CI-HOTFIX-2 and CI-HOTFIX-3 is kept, not
    // erased.
    //
    // SEC-HOTFIX-1 / GHSA-wq5f-xc86-pv6w (sharp < 0.35.5, through its librsvg
    // dependency) and GHSA-68fv-2mgg-jv7q (source-map-js 1.0.0 - 1.2.1, an
    // event-loop denial of service), both reported by npm audit as high:
    // sharp 0.35.4 -> 0.35.5 and source-map-js 1.2.1 -> 1.2.2, as a
    // lockfile-only change. package.json is not changed by it (asserted below),
    // and sharp 0.35.5 moves the 25 @img/sharp-* platform and libvips packages
    // it pins exactly, plus @img/sharp-wasm32, which @img/sharp-freebsd-wasm32
    // and @img/sharp-webcontainers-wasm32 pin exactly — 28 lockfile entries in
    // all, none added or removed. That reviewed result is deliberately NOT
    // re-typed here entry by entry: the approved graph IS the lockfile committed
    // at SEC_HOTFIX_1_LOCK_BASE, read with `git show`, so every version,
    // resolved URL, integrity hash, dependency edge, optional dependency,
    // platform-specific sharp package and unrelated entry is frozen exactly as
    // reviewed (reviewed commit patch, `git diff --full-index`, SHA-256
    // cc15bfd93cdf9717f996462935764c168195769ba6c922aa0f18415368cde078; frozen
    // package-lock.json SHA-256
    // d354aa57a59b5a7aa1de9fff34a40e7fce0f5cd420dbb5e31a990a3f37b03321).
    //
    // HEAD's complete lockfile must equal that frozen graph, with only the
    // pre-existing release-version normalisation. No range, allowlist, filter,
    // exemption or registry lookup is introduced, so ANY other lockfile drift —
    // a package version, resolved URL, integrity, dependency edge, addition,
    // removal, override, root metadata, or a different undici, brace-expansion,
    // sharp or source-map-js version — still fails closed. Advancing the pin
    // changes what the approved graph IS, never how strictly it is enforced.
    expect(head.engines).toEqual({ node: '22.x' });
    const UNDICI = 'node_modules/undici';
    const BRACE_EXPANSION = 'node_modules/brace-expansion';
    const SHARP = 'node_modules/sharp';
    const SOURCE_MAP_JS = 'node_modules/source-map-js';
    const expectedLock = (() => {
      const lock = jsonAt(BASE, 'package-lock.json');
      const packages = { ...(lock.packages as Record<string, Record<string, unknown>>) };
      expect(packages[UNDICI].version).toBe('7.29.0');
      expect(packages[BRACE_EXPANSION].version).toBe('5.0.9');
      expect(packages[SHARP].version).toBe('0.35.4');
      expect(packages[SOURCE_MAP_JS].version).toBe('1.2.1');
      expect(packages[''].engines).toBeUndefined();
      packages[''] = { ...packages[''], engines: { node: '22.x' } };
      packages[UNDICI] = {
        ...packages[UNDICI],
        version: '7.30.0',
        resolved: 'https://registry.npmjs.org/undici/-/undici-7.30.0.tgz',
        integrity: 'sha512-dkrQXeHSaoamnItlYbmzG0wFYrM0ZwDxCIg0A7aKjTyyhh9svRzCNFEzV+Vm05/yehjCzjDZ31KXfGEjYSztDQ==',
      };
      packages[BRACE_EXPANSION] = {
        ...packages[BRACE_EXPANSION],
        version: '5.0.12',
        resolved: 'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz',
        integrity: 'sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==',
      };
      return { ...lock, packages };
    })();
    const normalise = (lock: Record<string, unknown>) => {
      const packages = { ...(lock.packages as Record<string, Record<string, unknown>>) };
      packages[''] = { ...packages[''], version: 'RELEASE_VERSION' };
      return JSON.stringify({ ...lock, version: 'RELEASE_VERSION', packages });
    };

    // Like BASE, SEC_HOTFIX_1_LOCK_BASE must stay reachable in the CI checkout
    // that runs this test (the verify job, fetch-depth: 0): land PR #242 as a
    // merge commit, never squash or rebase, and never amend or rebase 84a8f720.
    // If it cannot be read, `git show` throws and this test fails closed — it
    // never passes silently.
    const SEC_HOTFIX_1_LOCK_BASE = '84a8f7207bbe03cb8b20814b51941377ef91f914';
    const SEC_HOTFIX_1_PARENT = `${SEC_HOTFIX_1_LOCK_BASE}~1`;
    // Historical: the graph SEC-HOTFIX-1 started from was exactly BASE plus the
    // CI-HOTFIX-2/-3 transformations, and SEC-HOTFIX-1 left package.json as it was.
    expect(normalise(jsonAt(SEC_HOTFIX_1_PARENT, 'package-lock.json')))
      .toBe(normalise(expectedLock));
    expect(jsonAt(SEC_HOTFIX_1_LOCK_BASE, 'package.json'))
      .toEqual(jsonAt(SEC_HOTFIX_1_PARENT, 'package.json'));
    const frozenLock = jsonAt(SEC_HOTFIX_1_LOCK_BASE, 'package-lock.json');
    const frozen = frozenLock.packages as Record<string, Record<string, unknown>>;
    // The frozen graph keeps the CI-HOTFIX-2/-3 entries exactly as reviewed ...
    expect(frozen[''].engines).toEqual({ node: '22.x' });
    expect(frozen[UNDICI]).toEqual(expectedLock.packages[UNDICI]);
    expect(frozen[BRACE_EXPANSION]).toEqual(expectedLock.packages[BRACE_EXPANSION]);
    // ... and carries exactly the four reviewed security versions.
    expect(frozen[UNDICI].version).toBe('7.30.0');
    expect(frozen[BRACE_EXPANSION].version).toBe('5.0.12');
    expect(frozen[SHARP].version).toBe('0.35.5');
    expect(frozen[SOURCE_MAP_JS].version).toBe('1.2.2');

    // SEC-HOTFIX-2 / GHSA-587h-7wmj-h5pm (high), GHSA-698v-4r3x-3vcv and
    // GHSA-r825-w8mm-5pxw (launch-editor, bundled by vite): npm audit reports
    // vite <= 6.4.3 as high, and the advisories name 6.4.4 as the first
    // patched 6.x release. vite is a dev-only root devDependency whose
    // package.json range (^6.4.3) already admits 6.4.4, so package.json
    // is not changed (asserted below). vite 6.4.4 declares the same
    // dependencies, bin, engines, peer and optional dependencies as 6.4.3, so
    // SEC-HOTFIX-2 contributes EXACTLY one lockfile transformation on top of the
    // frozen SEC-HOTFIX-1 graph: the node_modules/vite entry takes the
    // registry's 6.4.4 version/resolved/integrity and keeps every other field.
    // Anything else — another entry, a dependency edge, root metadata, or a
    // different vite version — still fails closed.
    const VITE = 'node_modules/vite';
    expect(frozen[VITE].version).toBe('6.4.3');
    const expectedHotfix2Lock = {
      ...frozenLock,
      packages: {
        ...frozen,
        [VITE]: {
          ...frozen[VITE],
          version: '6.4.4',
          resolved: 'https://registry.npmjs.org/vite/-/vite-6.4.4.tgz',
          integrity: 'sha512-xGjU/SyjeNyb0E4KxXBvYz/1C+3JXuujvf2hXNOtnlcE+58o5ajd9N2/n2VhkiJvpCP2qQasnUpx5PXNeI+p1Q==',
        },
      },
    };
    // Like SEC_HOTFIX_1_LOCK_BASE, SEC_HOTFIX_2_LOCK_BASE must stay reachable in
    // the CI checkout that runs this test: land the SEC-HOTFIX-2 PR as a merge
    // commit, never squash or rebase, and never amend or rebase 703be166. If it
    // cannot be read, `git show` throws and this test fails closed.
    const SEC_HOTFIX_2_LOCK_BASE = '703be16676f4ad364fc4a901a869a0c13edf2b70';
    const SEC_HOTFIX_2_PARENT = `${SEC_HOTFIX_2_LOCK_BASE}~1`;
    // Historical: SEC-HOTFIX-2 started from the frozen SEC-HOTFIX-1 graph and
    // left package.json as it was.
    expect(normalise(jsonAt(SEC_HOTFIX_2_PARENT, 'package-lock.json')))
      .toBe(normalise(frozenLock));
    expect(jsonAt(SEC_HOTFIX_2_LOCK_BASE, 'package.json'))
      .toEqual(jsonAt(SEC_HOTFIX_2_PARENT, 'package.json'));
    const frozenHotfix2Lock = jsonAt(SEC_HOTFIX_2_LOCK_BASE, 'package-lock.json');
    // The frozen SEC-HOTFIX-2 graph is the SEC-HOTFIX-1 graph with EXACTLY the vite entry moved.
    expect(normalise(frozenHotfix2Lock)).toBe(normalise(expectedHotfix2Lock));

    // SEC-HOTFIX-3 / GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp: npm audit
    // reports @vitest/mocker <= 4.1.11 as moderate (code injection through
    // unauthenticated manual mock registration; a Windows backslash traversal
    // of the redirect allowlist), reached through vitest. Both advisories name
    // 4.1.12 as the patched 4.x release. The Vitest family is released in
    // lockstep, so all eight entries move 4.1.11 -> 4.1.12 together, and
    // package.json's "vitest": "^4.1.11" already admits 4.1.12 (it is not
    // changed: asserted above, and against the working tree below). Every value
    // is written out from the npm registry's 4.1.12 manifests (published
    // 2026-10-15) — nothing is read from the registry at test time: each entry
    // takes the 4.1.12 version/resolved/integrity, and the manifests change ONLY
    // the family-internal edges listed per entry (vitest's dependencies and
    // peerDependencies, the @vitest/* dependencies on each other), each of which
    // was exactly "4.1.11" before. No key is added or removed, every other field
    // and every other entry stays as frozen, and vite stays 6.4.4. Anything else
    // — another entry, another edge, root metadata, a different integrity or
    // resolved URL, or a family member left at 4.1.11 — fails closed.
    const VITEST_FAMILY_4_1_12: Record<string, { resolved: string; integrity: string; edges: Record<string, Record<string, string>> }> = {
      'vitest': {
        resolved: 'https://registry.npmjs.org/vitest/-/vitest-4.1.12.tgz',
        integrity: 'sha512-5eWdz2yb3ajxWF3C8C4TjkXl7FGm3n2E/VlazALrQHzK7nYMSGFnCZto0bbPNl77AwkOZVLk0YnBAejUu0NiWA==',
        edges: {
          dependencies: { '@vitest/expect': '4.1.12', '@vitest/mocker': '4.1.12', '@vitest/pretty-format': '4.1.12', '@vitest/runner': '4.1.12', '@vitest/snapshot': '4.1.12', '@vitest/spy': '4.1.12', '@vitest/utils': '4.1.12' },
          peerDependencies: { '@vitest/browser-playwright': '4.1.12', '@vitest/browser-preview': '4.1.12', '@vitest/browser-webdriverio': '^4.1.11', '@vitest/coverage-istanbul': '4.1.12', '@vitest/coverage-v8': '4.1.12', '@vitest/ui': '4.1.12' },
        },
      },
      '@vitest/expect': {
        resolved: 'https://registry.npmjs.org/@vitest/expect/-/expect-4.1.12.tgz',
        integrity: 'sha512-vFlTt+YEu9WBpNjdGayNmlMVzrWPi1+sv853/7t2FU7hpO5gAFBKHzQmkCq5Xjpr+evegF2994LQT3hF3mRlqQ==',
        edges: {
          dependencies: { '@vitest/spy': '4.1.12', '@vitest/utils': '4.1.12' },
        },
      },
      '@vitest/mocker': {
        resolved: 'https://registry.npmjs.org/@vitest/mocker/-/mocker-4.1.12.tgz',
        integrity: 'sha512-fKShNpKZzupWZuY0z7egydvL0sqW4INEZBEExMBMAa6izlENEVHwoXgdaTCaBZ5fwlr4xf2o1wXC83n9RpO+NA==',
        edges: {
          dependencies: { '@vitest/spy': '4.1.12' },
        },
      },
      '@vitest/pretty-format': {
        resolved: 'https://registry.npmjs.org/@vitest/pretty-format/-/pretty-format-4.1.12.tgz',
        integrity: 'sha512-XW9O8+Mxx4VpCtkYdMJLZQQwsVryP9wk7cPKDxtXFfwSak6yRh5+2fep/Y0XF/ElBvJHq8bcYdi6aeuai0opZA==',
        edges: {},
      },
      '@vitest/runner': {
        resolved: 'https://registry.npmjs.org/@vitest/runner/-/runner-4.1.12.tgz',
        integrity: 'sha512-NKlVKCr5QnCe8jijdMnmkpHHU+WTqiLFR6G0pHji9uRjXK9xJl1k1nTw6F3pOOj2PDcsDt2GKQMI7wIsaT491w==',
        edges: {
          dependencies: { '@vitest/utils': '4.1.12' },
        },
      },
      '@vitest/snapshot': {
        resolved: 'https://registry.npmjs.org/@vitest/snapshot/-/snapshot-4.1.12.tgz',
        integrity: 'sha512-ko1y1Qgb/slzQ9mr+b89Cuqud8WG1TKtsPD8r7ZUBdvVOGt85Af2HwCqHujrhwJq95hs/9RM7fcAPg57o1vlzw==',
        edges: {
          dependencies: { '@vitest/pretty-format': '4.1.12', '@vitest/utils': '4.1.12' },
        },
      },
      '@vitest/spy': {
        resolved: 'https://registry.npmjs.org/@vitest/spy/-/spy-4.1.12.tgz',
        integrity: 'sha512-RGq9x4JNGNTZHEJxvN0oSiJjeSCExm0n2gZKKJZHY9cX5AVA6M7VJILBT3ZJ/tJ/0J9uWT7fETV9/btoi//vSg==',
        edges: {},
      },
      '@vitest/utils': {
        resolved: 'https://registry.npmjs.org/@vitest/utils/-/utils-4.1.12.tgz',
        integrity: 'sha512-Q3awXrwOfEV+qc3WmO5ONyE0yO7Q1gQ9/oyHxGLZ/pl7N3NO/ZztqQwKLuwMkV+CA1JYSIeO3gkHnRDIo4AVaA==',
        edges: {
          dependencies: { '@vitest/pretty-format': '4.1.12' },
        },
      },
    };
    const frozenHotfix2 = frozenHotfix2Lock.packages as Record<string, Record<string, unknown>>;
    const hotfix3Packages: Record<string, Record<string, unknown>> = { ...frozenHotfix2 };
    for (const [name, next] of Object.entries(VITEST_FAMILY_4_1_12)) {
      const key = `node_modules/${name}`;
      const prev = frozenHotfix2[key];
      // Provenance: the frozen SEC-HOTFIX-2 graph carries the reviewed 4.1.11 entry.
      expect(prev.version, key).toBe('4.1.11');
      const moved: Record<string, unknown> = { ...prev, version: '4.1.12', resolved: next.resolved, integrity: next.integrity };
      for (const [field, edges] of Object.entries(next.edges)) {
        const current = prev[field] as Record<string, string>;
        // An edge is moved, never added: it exists and was exactly 4.1.11.
        for (const dep of Object.keys(edges)) expect(current[dep], `${key} ${field}.${dep}`).toBe('4.1.11');
        moved[field] = { ...current, ...edges };
      }
      hotfix3Packages[key] = moved;
    }
    const expectedHotfix3Lock = { ...frozenHotfix2Lock, packages: hotfix3Packages };
    expect(hotfix3Packages[VITE].version).toBe('6.4.4');
    // CI-HOTFIX-4 / GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472 and
    // GHSA-xjj6-f33q-929c: npm audit reports undici 7.30.0 as high (EventSource
    // parser unbounded memory, Subresource Integrity bypass via non-lowercase
    // algorithm tokens, unhandled error on excessive content-encodings), with
    // 7.30.1 as the patched release. undici stays a dev-only transitive
    // dependency (jsdom@29.1.1 -> undici@^7.25.0), so package.json is not
    // changed, and the 7.30.1 manifest declares the same dependencies, peer,
    // optional, bin and engines fields as 7.30.0 — no edge moves. CI-HOTFIX-4
    // therefore contributes EXACTLY one lockfile transformation on top of the
    // SEC-HOTFIX-3 graph: the node_modules/undici entry takes the registry's
    // 7.30.1 version/resolved/integrity (tarball SHA-512 verified against the
    // registry metadata) and keeps every other field. The historical pins above
    // are untouched: the frozen SEC-HOTFIX-1 graph still carries undici 7.30.0,
    // and any other entry, edge, root metadata or a different undici version
    // still fails closed.
    const prevUndici = hotfix3Packages[UNDICI];
    expect(prevUndici.version).toBe('7.30.0');
    const hotfix4Packages: Record<string, Record<string, unknown>> = {
      ...hotfix3Packages,
      [UNDICI]: {
        ...prevUndici,
        version: '7.30.1',
        resolved: 'https://registry.npmjs.org/undici/-/undici-7.30.1.tgz',
        integrity: 'sha512-03KrMbjIFDWQR5RNPrSw3bd1r12JpyFQl9/yxjUbJtqkjmllqC5lFjZh6ujeuJCKr8EOQvRW872Oy/az+nLYxg==',
      },
    };
    const expectedHotfix4Lock = { ...expectedHotfix3Lock, packages: hotfix4Packages };
    // The authoritative assertion reads the WORKING lockfile. `git show HEAD`
    // cannot see an uncommitted lockfile and would report a false GREEN for it;
    // in CI the working tree is the checked-out commit, so the strictness is
    // the same. The whole graph must be the SEC-HOTFIX-3 graph above plus
    // exactly the CI-HOTFIX-4 undici 7.30.1 transformation, with only the
    // pre-existing release-version normalisation.
    const workingLock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));
    expect(normalise(workingLock)).toBe(normalise(expectedHotfix4Lock));
    // ... and the working package.json is the HEAD package.json whose contract is asserted above.
    expect(JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))).toEqual(head);
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
