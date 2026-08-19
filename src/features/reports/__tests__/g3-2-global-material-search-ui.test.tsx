/**
 * @vitest-environment jsdom
 *
 * G3.2 / U7 — global material search UX safety.
 *
 * Three layers, each proved at the level it actually lives at:
 *
 *  - TAB ACCESS is a pure function of role/permissions, tested BEHAVIOURALLY
 *    against that function. It is the authoritative frontend gate; the panel's
 *    own `role !== 'super_admin'` early return and the server's RLS remain in
 *    place behind it.
 *
 *  - TRUNCATION VISIBILITY is proved by RENDERING the real panel and asserting
 *    what a user would see: the notice appears when the search result reports
 *    an incomplete source read, and is absent when it does not. The service
 *    half of that chain — a capped query actually setting `sourceTruncated` —
 *    is proved in g3-2-global-material-search-identity.test.ts.
 *
 *  - The remaining structural scans cover properties no single render can
 *    demonstrate ("never writes", "no elevated credential", "no third stock
 *    truth"), which is the one job a source scan does better than execution.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { allowedReportTabs } from '../report-tab-access';
import type { GlobalMaterialSearchResult } from '../global-material-search.service';

// ── Mocks for the panel's collaborators. Only the boundaries are faked; the
//    panel's own rendering logic — the thing under test — runs for real. ──
const searchMock = vi.fn<(input: unknown) => Promise<GlobalMaterialSearchResult>>();

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({ lang: 'en' as const, role: 'super_admin' }),
}));

vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: () => Promise.resolve([
    { id: 'org-1', name: 'Sector One', name_ar: 'قطاع واحد', status: 'active' },
  ]),
}));

vi.mock('../global-material-export', () => ({
  exportGlobalMaterialSearchWorkbook: vi.fn(),
}));

vi.mock('../global-material-search.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchGlobalMaterialStock: (input: unknown) => searchMock(input),
}));

const resultRow = (over: Record<string, unknown> = {}) => ({
  key: 'k1', organizationId: 'org-1', organizationName: 'Sector One',
  organizationNameAr: 'قطاع واحد', scopeKind: 'warehouse' as const, scopeId: 'wh-1',
  scopeName: 'Depot A', scopeNameAr: 'مذخر أ',
  facilityId: 'fac-A', sectorRole: 'health_center' as const,
  materialIdentityKey: 'material:v1|key-A', isolated: false,
  stockBacked: true, alertCount: 0,
  scientificName: 'Amoxicillin', tradeNames: [], concentration: ['500mg'],
  dosageForm: ['capsule'], unit: ['box'], nationalCode: null,
  onHand: 10, reserved: 0, available: 10, batchCount: 1,
  nearestExpiry: null, expiredAvailable: 0, nearExpiryAvailable: 0,
  signals: [],
  ...over,
});

const searchResult = (sourceTruncated: boolean): GlobalMaterialSearchResult => ({
  rows: [resultRow()] as GlobalMaterialSearchResult['rows'],
  totalRows: 1,
  truncated: false,
  sourceTruncated,
  searchedAt: '2026-06-01T12:00:00Z',
});

/**
 * Mount the panel, run one search, and settle.
 *
 * Queries go through the rendered container rather than testing-library's
 * `screen`, which this file's module graph does not expose usable query methods
 * on. These are the same user-visible attributes `screen` would have matched —
 * a placeholder, a button's visible label, a data-testid — read from the real
 * DOM the component produced, so the assertions remain behavioural.
 */
async function searchWith(result: GlobalMaterialSearchResult): Promise<HTMLElement> {
  searchMock.mockResolvedValue(result);
  const { GlobalMaterialSearchPanel } = await import('../GlobalMaterialSearchPanel');
  const { container } = render(<GlobalMaterialSearchPanel />);

  const input = await waitFor(() => {
    const found = container.querySelector<HTMLInputElement>('input[placeholder*="Amoxicillin"]');
    if (!found) throw new Error('query input not rendered yet');
    return found;
  });
  fireEvent.change(input, { target: { value: 'amox' } });

  const searchButton = [...container.querySelectorAll('button')]
    .find(b => /(^|\s)Search(\s|$)/.test(b.textContent ?? ''));
  if (!searchButton) throw new Error('search button not found');
  fireEvent.click(searchButton);

  await waitFor(() => expect(searchMock).toHaveBeenCalled());
  await waitFor(() => {
    if (!container.textContent?.includes('Amoxicillin')) {
      throw new Error('results not rendered yet');
    }
  });
  return container;
}

afterEach(() => {
  cleanup();
  searchMock.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// U7A — truncation visibility, PROVED BY RENDERING
// ═════════════════════════════════════════════════════════════════════════════
describe('U7A — the incomplete-results notice is actually rendered', () => {
  it('sourceTruncated = TRUE renders the notice to the user', async () => {
    const container = await searchWith(searchResult(true));

    const notice = container.querySelector('[data-testid="global-search-source-truncated"]');
    expect(notice).not.toBeNull();
    // It says what is actually wrong: the totals are a lower bound.
    expect(notice!.textContent).toMatch(/LOWER BOUND/i);
    // And it is announced to assistive technology, not merely coloured.
    expect(notice!.getAttribute('role')).toBe('status');
  });

  it('sourceTruncated = FALSE renders NO such notice', async () => {
    const container = await searchWith(searchResult(false));

    // The results are on screen...
    expect(container.textContent).toContain('Amoxicillin');
    // ...and the warning is absent from the DOM, not merely hidden.
    expect(container.querySelector('[data-testid="global-search-source-truncated"]')).toBeNull();
  });

  it('the notice is distinct from the display-limit notice, not a reuse of it', async () => {
    const container = await searchWith({ ...searchResult(true), truncated: true, totalRows: 5000 });

    const sourceNotice = container.querySelector('[data-testid="global-search-source-truncated"]');
    const statuses = [...container.querySelectorAll('[role="status"]')];
    expect(sourceNotice).not.toBeNull();
    // Both warnings render, and they are different elements with different text.
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    const other = statuses.find(el => el !== sourceNotice);
    expect(other?.textContent).not.toBe(sourceNotice!.textContent);
  });
});

const read = (...parts: string[]) =>
  readFileSync(join(process.cwd(), 'src', 'features', 'reports', ...parts), 'utf8')
    .replace(/\r\n/g, '\n');

const panel = read('GlobalMaterialSearchPanel.tsx');
const screen = read('DecisionIntelligenceReportsScreen.tsx');
const service = read('global-material-search.service.ts');

// ═════════════════════════════════════════════════════════════════════════════
// U7B — tab access parity
// ═════════════════════════════════════════════════════════════════════════════
describe('U7B — the Global Material Search tab is not shown where its body is forbidden', () => {
  it('NEGATIVE — a non-super_admin role is not offered the tab', () => {
    const permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    for (const role of ['institution_admin', 'warehouse_officer', 'health_center_manager', 'viewer']) {
      expect(allowedReportTabs(permissions, role)).not.toContain('global');
    }
  });

  it('NEGATIVE — no permission set can grant the tab to a non-super_admin role', () => {
    // The rule is role-based, so a generous permission bundle must not open it.
    const generous = new Set([
      'reports.view', 'status_center.view', 'audit.view', 'availability.update',
      'inventory.manage_thresholds', 'global.search',
    ]);
    expect(allowedReportTabs(generous, 'institution_admin')).not.toContain('global');
  });

  it('POSITIVE — super_admin is offered the tab', () => {
    expect(allowedReportTabs(new Set(), 'super_admin')).toContain('global');
  });

  it('an unauthenticated (null) role is offered no tabs at all', () => {
    expect(allowedReportTabs(new Set(), null)).toEqual([]);
  });

  it('the tab list rendered by the screen is filtered through that allow-list', () => {
    // The screen must not render `allTabs` directly — the filter is the gate.
    expect(screen).toContain('allTabs.filter(item => allowedTabs.includes(item.id))');
  });

  it('the panel body keeps its own independent role check (defence in depth)', () => {
    expect(panel).toContain("role !== 'super_admin'");
    expect(screen).toContain("activeTab === 'global' && role === 'super_admin'");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U7A — truncation visibility
// ═════════════════════════════════════════════════════════════════════════════
describe('U7A — incomplete source data is visibly communicated', () => {
  it('the service exposes a source-truncation flag distinct from display truncation', () => {
    expect(service).toContain('sourceTruncated');
    expect(service).toContain('truncated: rows.length > maxRows');
  });

  it('the flag is derived from a source query actually hitting its cap', () => {
    expect(service).toContain('rows.length >= PER_FIELD_LIMIT');
  });

  it('the panel renders a warning bound to sourceTruncated', () => {
    expect(panel).toContain('result.sourceTruncated');
    expect(panel).toContain('data-testid="global-search-source-truncated"');
  });

  it('the warning is announced to assistive technology, not merely coloured', () => {
    const banner = panel.slice(panel.indexOf('result.sourceTruncated'));
    expect(banner.slice(0, 400)).toContain('role="status"');
  });

  it('the warning carries its own copy in BOTH languages', () => {
    expect(panel).toContain('sourceTruncated:');
    // Arabic and English copy blocks each define the key.
    expect(panel.match(/sourceTruncated:\s*'/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('it is a SEPARATE message from the display-limit notice, not a reuse of it', () => {
    expect(panel).toContain('c.sourceTruncated');
    expect(panel).toContain('c.truncated');
    expect(panel.indexOf('c.sourceTruncated')).not.toBe(panel.indexOf('c.truncated'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Preserved: this remains a read-only, on-demand surface
// ═════════════════════════════════════════════════════════════════════════════
describe('preserved — the panel stays an explicit, read-only search', () => {
  it('does not search on keystrokes or poll in the background', () => {
    expect(panel).not.toMatch(/useEffect\s*\([^)]*searchGlobalMaterialStock/s);
    expect(panel).not.toContain('setInterval');
  });

  it('the service performs no write of any kind', () => {
    for (const write of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']) {
      expect(service).not.toContain(write);
    }
  });

  it('no elevated credential is embedded', () => {
    expect(service).not.toContain('service_role');
    expect(panel).not.toContain('service_role');
  });

  it('U4 aggregation created no table, cache or projection — no third stock truth', () => {
    const executable = service
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(executable).not.toContain('localStorage');
    expect(executable).not.toContain('sessionStorage');
    expect(executable).not.toContain('indexedDB');
    expect(executable).not.toContain('CREATE ');
    expect(executable).not.toContain('materialized');
  });

  it('grouping reads the database key and never rebuilds it in TypeScript', () => {
    expect(service).toContain('materialGroupingKey');
    // 150's helper must not be reimplemented client-side.
    expect(service).not.toContain('_phoenix_material_identity_v1');
    expect(service).not.toContain("'material:v1'");
  });
});
