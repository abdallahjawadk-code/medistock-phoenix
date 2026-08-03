import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync(
  new URL('../global-material-search.service.ts', import.meta.url),
  'utf8',
);
const panel = readFileSync(
  new URL('../GlobalMaterialSearchPanel.tsx', import.meta.url),
  'utf8',
);
const exporter = readFileSync(
  new URL('../global-material-export.ts', import.meta.url),
  'utf8',
);
// REPORTING-UNIFICATION: Global Material Search moved from ReportsScreen.tsx
// (screen 9, now retired) into DecisionIntelligenceReportsScreen.tsx (screen
// 21) as tab 11 — same panel component, same internal gate, mounted from a
// new location. The nav-reachability test below now checks the unified
// shell's single entry instead of a dedicated screen-9 entry, since there
// is no separate "Reports" nav item to reach it through anymore.
const dirc = readFileSync(
  new URL('../DecisionIntelligenceReportsScreen.tsx', import.meta.url),
  'utf8',
);
const tabAccess = readFileSync(
  new URL('../report-tab-access.ts', import.meta.url),
  'utf8',
);
const sidebar = readFileSync(
  new URL('../../../shared/ui/PhoenixSidebar.tsx', import.meta.url),
  'utf8',
);
const mobileDrawer = readFileSync(
  new URL('../../../shared/ui/PhoenixMobileDrawer.tsx', import.meta.url),
  'utf8',
);

describe('super-admin global material search boundary', () => {
  it('renders the tab and panel only for super_admin', () => {
    expect(tabAccess).toContain("global: { kind: 'role', role: 'super_admin' }");
    expect(tabAccess).toContain('return role === rule.role');
    expect(dirc).toContain("activeTab === 'global' && role === 'super_admin'");
    expect(panel).toContain("if (role !== 'super_admin') return null");
  });

  it('keeps the unified reporting/status shell (which owns global material search) reachable from desktop and mobile navigation', () => {
    [sidebar, mobileDrawer].forEach(source => {
      expect(source).toContain("screen: 21");
      expect(source).toContain("labelKey: 'nav_decision_reports'");
    });
  });

  it('never embeds elevated credentials or performs direct database writes', () => {
    const source = [service, panel, exporter].join('\n');
    expect(source).not.toContain('service_role');
    // Set.delete() in the UI only changes local checkbox state; inspect
    // the Supabase service itself for database mutation methods.
    expect(service).not.toMatch(/\.insert\s*\(/);
    expect(service).not.toMatch(/\.update\s*\(/);
    expect(service).not.toMatch(/\.delete\s*\(/);
    expect(service).not.toMatch(/\.rpc\s*\(/);
  });

  it('uses existing RLS-protected truth tables rather than item_availability', () => {
    expect(service).toContain("searchStockTable('warehouse_stock'");
    expect(service).toContain("searchStockTable('outlet_stock'");
    expect(service).toContain(".from('inventory_alerts')");
    expect(service).not.toContain(".from('item_availability')");
  });
});

describe('free-tier query pressure controls', () => {
  it('requires an explicit term and at least one selected organization', () => {
    expect(service).toContain("if (term.length < 2)");
    expect(service).toContain("if (organizationIds.length === 0)");
    expect(panel).toContain('onClick={() => void runSearch()}');
  });

  it('does not search on keystrokes or poll in the background', () => {
    expect(panel).toContain('onChange={event => { setQuery(event.target.value);');
    expect(panel).not.toMatch(/useEffect\s*\([^)]*searchGlobalMaterialStock/s);
    expect(service).toContain('PER_FIELD_LIMIT = 500');
    expect(service).toContain('DEFAULT_RESULT_LIMIT = 1200');
    expect(service).toContain('Math.min(Math.max');
  });

  it('escapes ILIKE wildcard input and deduplicates overlapping field matches', () => {
    expect(service).toContain('function escapeIlike');
    expect(service).toContain('function dedupeById');
    expect(service).toContain("['scientific_name', 'trade_name', 'national_code']");
  });

  it('invalidates in-flight results whenever the search context changes', () => {
    expect(panel).toContain('function invalidateSearchContext');
    expect(panel).toContain('requestSequence.current += 1');
    expect(panel).toContain('if (sequence !== requestSequence.current) return');
    expect(panel.match(/invalidateSearchContext\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});

describe('inventory meaning and aggregation', () => {
  it('shows on-hand, reserved, and generated available separately', () => {
    expect(service).toContain('on_hand_quantity');
    expect(service).toContain('reserved_quantity');
    expect(service).toContain('available_quantity');
    expect(panel).toContain('summary.reserved');
    expect(panel).toContain('row.reserved');
  });

  it('keeps material status sourced from 072 alerts and the fixed 270-day expiry window', () => {
    expect(service).toContain("['open', 'acknowledged', 'in_progress']");
    expect(service).toContain('setUTCDate(cutoffDate.getUTCDate() + 270)');
    expect(service).toContain("group.signals.add('expired')");
    expect(service).toContain("group.signals.add('near_expiry')");
  });

  it('includes alert-only missing rows without inventing missing for untracked organizations', () => {
    expect(service).toContain('// Alert-only rows represent expected-but-zero');
    expect(service).toContain('if (!group.hasStock)');
    expect(service).not.toMatch(/group\.signals\.add\('missing'\)/);
  });
});

describe('professional Excel export', () => {
  it('exports only the current result without any database access', () => {
    expect(exporter).toContain('from the already-returned search');
    expect(exporter).not.toContain('supabase');
    expect(exporter).not.toContain('searchGlobalMaterialStock');
    expect(panel).toContain('result,');
  });

  it('builds detailed, institution-summary, and policy sheets', () => {
    expect(exporter).toContain("workbook.addWorksheet(c.details");
    expect(exporter).toContain("workbook.addWorksheet(c.institutions");
    expect(exporter).toContain("workbook.addWorksheet(c.definitions");
    expect(exporter).toContain("orientation: 'landscape'");
    expect(exporter).toContain('printTitlesRow');
    expect(exporter).toContain('autoFilter');
  });

  it('documents the approved business rules in Arabic and English', () => {
    expect(exporter).toContain('الرصيد الفعلي − المحجوز');
    expect(exporter).toContain('270 يومًا (9 أشهر)');
    expect(exporter).toContain('On hand minus reserved');
    expect(exporter).toContain('270 days (9 months)');
  });
});

describe('bilingual responsive UX', () => {
  it('contains Arabic and English copy and separate mobile/desktop layouts', () => {
    expect(panel).toContain("ar: {");
    expect(panel).toContain("en: {");
    expect(panel).toContain("window.innerWidth < 768");
    expect(panel).toContain("isMobile ? (");
  });

  it('supports one, many, all, or cleared institution selections without raw UUID input', () => {
    expect(panel).toContain('selectedOrganizations');
    expect(panel).toContain('new Set(activeOrganizations.map(org => org.id))');
    expect(panel).toContain('setSelectedOrganizations(new Set())');
    expect(panel).not.toMatch(/placeholder=.*UUID/i);
  });
});
