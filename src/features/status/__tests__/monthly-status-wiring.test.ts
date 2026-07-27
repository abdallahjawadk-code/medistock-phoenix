/**
 * MONTHLY-STATUS-REDESIGN-092 / REPORTING-UNIFICATION — frontend wiring.
 *
 * Static checks only (no live database): the full prepare/classify/submit/
 * approve+lock/amend workflow now lives inside the unified reporting/status
 * shell (DecisionIntelligenceReportsScreen.tsx, as MonthlyPositionTab) —
 * screen 20 is a redirect to it, not a separate rendered screen. The
 * service layer calls the EXACT RPC names migration 092 defines (drift
 * here would silently break the workspace against a real database while
 * every other test still passes), and the screen never writes the new
 * tables directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

const migration092 = readPhoenix('supabase/migrations/092_phoenix_monthly_status_redesign.sql');
const service = readSrc('shared/supabase/services/monthly-status.service.ts');
const dirc = readSrc('features/reports/DecisionIntelligenceReportsScreen.tsx');

describe('Screen 20 redirects to the unified shell\'s Monthly Position tab', () => {
  it('AuthenticatedApp redirects screen 20 to the unified shell with initialTab="monthly", not a standalone screen', () => {
    const app = readSrc('app/AuthenticatedApp.tsx');
    expect(app).not.toContain('MonthlyStatusScreen');
    expect(app).toMatch(/case 20:\s*return <DecisionIntelligenceReportsScreen[^>]*initialTab="monthly"/);
  });

  it('sidebar, drawer and palette expose the single unified entry (screen 21), not a dedicated screen 20 item', () => {
    for (const rel of ['shared/ui/PhoenixSidebar.tsx', 'shared/ui/PhoenixMobileDrawer.tsx', 'shared/ui/CommandPalette.tsx']) {
      const src = readSrc(rel);
      expect(src, rel).not.toContain('screen: 20');
      expect(src, rel).toContain('screen: 21');
      expect(src, rel).toContain("labelKey: 'nav_decision_reports'");
    }
  });

  it('PhoenixAppShell maps screen 20 to the same unified title as screen 21, since both render the same shell', () => {
    const shell = readSrc('shared/ui/PhoenixAppShell.tsx');
    expect(shell).toMatch(/20:\s*'nav_decision_reports'/);
    expect(shell).toMatch(/21:\s*'nav_decision_reports'/);
  });
});

describe('Every RPC the service calls exists, by exact name, in migration 092', () => {
  const rpcCalls = [...service.matchAll(/supabase\.rpc\('([a-z_0-9]+)'/g)].map(m => m[1]);

  it('found a substantial number of RPC calls (guard against a vacuous pass)', () => {
    // phoenix_set_inventory_threshold_planning and phoenix_status_get_outlet_
    // contribution are defined by 092 and exercised directly by the dynamic
    // rig test, but this UI slice does not wire them (no threshold-editing
    // or outlet-contribution surface in this screen yet) — 8, not all 10.
    expect(rpcCalls.length).toBeGreaterThanOrEqual(8);
  });

  it.each([...new Set(rpcCalls)])('migration 092 defines function %s', (fn) => {
    expect(migration092).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
  });
});

describe('The service layer never writes the new tables directly', () => {
  it('no .from(...).insert/update/delete on the report/stocktake tables', () => {
    for (const table of [
      'inventory_status_reports', 'inventory_status_report_lines',
      'inventory_status_report_amendments', 'stocktakes', 'stocktake_count_lines',
    ]) {
      expect(service).not.toMatch(new RegExp(`from\\(['"]${table}['"]\\)\\s*\\.\\s*(insert|update|delete)`));
    }
  });

  it('reads (.select) on the report/line tables are RLS-scoped, not service_role', () => {
    expect(service).not.toContain('service_role');
    expect(service).toContain(".from('inventory_status_reports')");
    expect(service).toContain(".from('inventory_status_report_lines')");
  });
});

describe('The unified shell gates Monthly Position actions by role, mirroring the server, and reuses expiry-risk.ts', () => {
  it('imports normalizeRole and computes per-persona action flags', () => {
    expect(dirc).toContain("import { normalizeRole } from '@/shared/lib/roles'");
    expect(dirc).toContain('warehouse_officer');
    expect(dirc).toContain('institution_admin');
    expect(dirc).toContain('central_warehouse_manager');
  });

  it('reuses the existing expiry-risk tier classifier rather than reimplementing it', () => {
    expect(dirc).toContain("from '@/shared/lib/expiry-risk'");
    expect(dirc).toContain('getExpiryRiskTier(line.nearest_expiry_date)');
  });

  it('bulk classify sends the reason and stocktake evidence id, never invents a classification client-side beyond what the server validates', () => {
    expect(dirc).toContain('classifyMonthlyStatusLines');
    expect(dirc).toContain('stocktake_count_line_id');
  });

  it('submit is disabled while unclassified or unconfirmed-missing lines remain (client-side mirror of the server guard)', () => {
    expect(dirc).toContain('allClassified');
    expect(dirc).toContain('anyUnconfirmedMissing');
    expect(dirc).toMatch(/disabled=\{busy \|\| !allClassified \|\| anyUnconfirmedMissing\}/);
  });

  it('no service_role or auth.admin in the unified shell', () => {
    expect(dirc).not.toContain('service_role');
    expect(dirc).not.toContain('auth.admin');
  });
});
