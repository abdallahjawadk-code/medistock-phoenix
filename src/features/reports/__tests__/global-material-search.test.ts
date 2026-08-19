import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { searchGlobalMaterialStock } from '../global-material-search.service';

/**
 * G3.2 — this suite is predominantly a source scan, which is the right tool for
 * the negatives it proves ("no elevated credential", "no write method", "does
 * not search on keystrokes"): those are properties of the whole module that no
 * single execution can demonstrate.
 *
 * Aggregation CORRECTNESS is different — it is an outcome, and an outcome must
 * be executed to be believed. The alert-merge cases below therefore run the
 * real service against an injected fake PostgREST transport. The builder is
 * thenable so a query ending at `.in(...)` resolves exactly like one ending at
 * `.limit(...)`, matching how the service actually composes its reads.
 */
vi.mock('@/shared/supabase/client', () => ({
  get supabase() { return (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase; },
  supabaseConfigured: true,
}));

const ORG = 'org1';

function stockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws1', organization_id: ORG, warehouse_id: 'wh1',
    scientific_name: 'Amoxicillin', trade_name: null, concentration: '500mg',
    dosage_form: 'capsule', unit: 'box', national_code: null,
    batch_number: 'B1', expiry_date: '2099-01-01',
    on_hand_quantity: 10, reserved_quantity: 0, available_quantity: 10,
    material_identity_key: 'material:v1|key-A',
    ...overrides,
  };
}

/**
 * A LEGACY_UNRESOLVED alert: Migration 150 could not prove which material it
 * describes, so its identity columns are null. Its display text is deliberately
 * IDENTICAL to the stock row above — the exact input a label-merge folds
 * together, and the exact input this report must refuse to fold.
 */
function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'al1', organization_id: ORG, scope_kind: 'warehouse', scope_id: 'wh1',
    scientific_name: 'Amoxicillin', national_code: null,
    signal_type: 'low_stock', observed_on_hand: 3, observed_available: 3,
    central_item_id: null, source_stock_id: null,
    material_identity_version: null, material_identity_key: null,
    material_identity_state: 'legacy_unresolved',
    ...overrides,
  };
}

/**
 * A RESOLVED alert: 150 proved its material, so it carries the SAME generated
 * `material_identity_key` as the stock row it was computed from.
 */
function resolvedAlertRow(overrides: Record<string, unknown> = {}) {
  return {
    ...alertRow(),
    id: 'al-r1',
    central_item_id: 'ci-1',
    material_identity_version: 1,
    material_identity_key: 'material:v1|key-A',
    material_identity_state: 'resolved',
    ...overrides,
  };
}

/** Install the fake transport and hand back the real service function. */
async function loadServiceWithRows(rowsByTable: Record<string, unknown[]>) {
  const tables: Record<string, unknown[]> = {
    organizations: [{
      id: ORG, name: 'Sector One', name_ar: 'قطاع واحد',
      organization_kind: 'care_institution', institution_class: 'health_sector',
    }],
    warehouses: [{
      id: 'wh1', name: 'Depot A', name_ar: 'مذخر أ', organization_id: ORG,
      facility_id: 'fac-A', warehouse_kind: 'institution', is_main: false,
    }],
    distribution_points: [],
    inventory_alerts: [],
    warehouse_stock: [],
    outlet_stock: [],
    ...rowsByTable,
  };

  (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase = {
    from(table: string) {
      const result = { data: tables[table] ?? [], error: null };
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq() { return builder; },
        in() { return builder; },
        ilike() { return builder; },
        limit() { return Promise.resolve(result); },
        then(resolve: (value: typeof result) => unknown) {
          return Promise.resolve(result).then(resolve);
        },
      };
      return builder;
    },
  };

  return searchGlobalMaterialStock;
}

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

  /**
   * G3.2 / DECISION C, CORRECTED — this replaced an assertion that pinned the
   * literal text of a source COMMENT, and it is now corrected a second time.
   *
   * The intermediate version required EVERY alert to be isolated, because the
   * implementation claimed `inventory_alerts` "holds no structural material
   * identifier". Migration 150 disproves that: it adds `central_item_id`,
   * `source_stock_id`, `material_identity_version`, `material_identity_key` and
   * `material_identity_state`, and a 'resolved' alert's key is the same
   * generated value the stock row carries. Isolating those alerts spawned a
   * duplicate group that then reported `observed_on_hand` — a COPY of stock
   * already counted — as if it were a second balance.
   *
   * What has NOT changed is the negative that mattered all along: an alert with
   * nothing but a matching NAME still never joins a stock group.
   */
  it('a RESOLVED alert joins its material group rather than duplicating the balance', async () => {
    const searchGlobalMaterialStock = await loadServiceWithRows({
      warehouse_stock: [stockRow({ id: 'ws1', on_hand_quantity: 100, available_quantity: 100 })],
      inventory_alerts: [resolvedAlertRow({ observed_on_hand: 100, observed_available: 100 })],
    });

    const result = await searchGlobalMaterialStock({
      term: 'amox', organizationIds: ['org1'], scope: 'all',
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].onHand).toBe(100);
    expect(result.rows[0].available).toBe(100);
    expect(result.rows[0].signals).toContain('low_stock');
    expect(result.rows[0].alertCount).toBe(1);
  });

  it('a LEGACY_UNRESOLVED alert is never merged into a stock group by display text', async () => {
    const searchGlobalMaterialStock = await loadServiceWithRows({
      warehouse_stock: [stockRow({ id: 'ws1', on_hand_quantity: 10, available_quantity: 10 })],
      inventory_alerts: [alertRow({ id: 'al1' })],
    });

    const result = await searchGlobalMaterialStock({
      term: 'amox', organizationIds: ['org1'], scope: 'all',
    });

    // Same organization, same location, same scientific_name — every value a
    // label-based merge would have keyed on. They stay two rows.
    expect(result.rows).toHaveLength(2);

    const stockGroup = result.rows.find(r => !r.isolated);
    const alertGroup = result.rows.find(r => r.isolated);
    expect(stockGroup?.available).toBe(10);
    expect(stockGroup?.signals).not.toContain('low_stock');
    expect(alertGroup?.signals).toContain('low_stock');
  });

  it('several legacy alert rows sharing display text do not collapse into one identity', async () => {
    const searchGlobalMaterialStock = await loadServiceWithRows({
      inventory_alerts: [
        alertRow({ id: 'al1', signal_type: 'low_stock' }),
        alertRow({ id: 'al2', signal_type: 'missing' }),
      ],
    });

    const result = await searchGlobalMaterialStock({
      term: 'amox', organizationIds: ['org1'], scope: 'all',
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every(r => r.isolated)).toBe(true);
    expect(result.rows.every(r => r.materialIdentityKey === null)).toBe(true);
  });

  it('an alert-only row reports its SIGNAL and no manufactured balance', async () => {
    const searchGlobalMaterialStock = await loadServiceWithRows({
      inventory_alerts: [alertRow({ observed_on_hand: 3, observed_available: 1 })],
    });

    const result = await searchGlobalMaterialStock({
      term: 'amox', organizationIds: ['org1'], scope: 'all',
    });
    // The alert is discoverable...
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].signals).toContain('low_stock');
    // ...and its observed snapshot is not promoted into stock truth.
    expect(result.rows[0].stockBacked).toBe(false);
    expect(result.rows[0].onHand).toBe(0);
    expect(result.rows[0].available).toBe(0);
    expect(result.rows[0].reserved).toBe(0);
  });

  it('no name-derived fallback identity survives anywhere in the executable aggregation', () => {
    const executable = service
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    // The old group key folded lower-cased scientific_name and national_code
    // into the identity. Nothing may key a material group on either again.
    expect(executable).not.toMatch(/normalized\s*\(\s*\w*[Ss]cientific/);
    expect(executable).not.toMatch(/groupKey\s*\([^)]*[Ss]cientific/);
    // Grouping delegates to the shared canonical primitive...
    expect(executable).toContain('materialGroupingKey(');
    // ...and 150's generated key is read, never rebuilt here.
    expect(executable).toContain('material_identity_key');
    expect(executable).not.toContain('_phoenix_material_identity_v1');
  });

  it('still never invents a missing signal for an untracked organization', () => {
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
