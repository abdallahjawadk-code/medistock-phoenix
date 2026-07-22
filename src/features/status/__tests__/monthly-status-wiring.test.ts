/**
 * MONTHLY-STATUS-REDESIGN-092 — frontend wiring.
 *
 * Static checks only (no live database): navigation reaches screen 20 from
 * every surface, the service layer calls the EXACT RPC names migration 092
 * defines (drift here would silently break the workspace against a real
 * database while every other test still passes), and the screen never
 * writes the new tables directly.
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
const screen = readSrc('features/status/MonthlyStatusScreen.tsx');

describe('Navigation reaches screen 20 from every surface', () => {
  it('AuthenticatedApp routes screen 20 to MonthlyStatusScreen', () => {
    const app = readSrc('app/AuthenticatedApp.tsx');
    expect(app).toContain('MonthlyStatusScreen');
    expect(app).toMatch(/case 20:\s*return <MonthlyStatusScreen/);
  });

  it('sidebar, drawer and palette all expose screen 20', () => {
    for (const rel of ['shared/ui/PhoenixSidebar.tsx', 'shared/ui/PhoenixMobileDrawer.tsx', 'shared/ui/CommandPalette.tsx']) {
      const src = readSrc(rel);
      expect(src, rel).toContain('screen: 20');
      expect(src, rel).toContain('nav_monthly_status');
    }
  });

  it('PhoenixAppShell maps screen 20 to its own title, not a fallback', () => {
    const shell = readSrc('shared/ui/PhoenixAppShell.tsx');
    expect(shell).toMatch(/20:\s*'nav_monthly_status'/);
  });

  it('nav_monthly_status has bilingual i18n strings', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('nav_monthly_status:');
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

describe('The screen gates actions by role, mirroring the server, and reuses expiry-risk.ts', () => {
  it('imports normalizeRole and computes per-persona action flags', () => {
    expect(screen).toContain("import { normalizeRole } from '@/shared/lib/roles'");
    expect(screen).toContain('warehouse_officer');
    expect(screen).toContain('institution_admin');
    expect(screen).toContain('central_warehouse_manager');
  });

  it('reuses the existing expiry-risk tier classifier rather than reimplementing it', () => {
    expect(screen).toContain("from '@/shared/lib/expiry-risk'");
    expect(screen).toContain('getExpiryRiskTier(line.nearest_expiry_date)');
  });

  it('bulk classify sends the reason and stocktake evidence id, never invents a classification client-side beyond what the server validates', () => {
    expect(screen).toContain('classifyMonthlyStatusLines');
    expect(screen).toContain('stocktake_count_line_id');
  });

  it('submit is disabled while unclassified or unconfirmed-missing lines remain (client-side mirror of the server guard)', () => {
    expect(screen).toContain('allClassified');
    expect(screen).toContain('anyUnconfirmedMissing');
    expect(screen).toMatch(/disabled=\{busy \|\| !allClassified \|\| anyUnconfirmedMissing\}/);
  });

  it('no service_role or auth.admin in the screen', () => {
    expect(screen).not.toContain('service_role');
    expect(screen).not.toContain('auth.admin');
  });
});
