/**
 * @vitest-environment jsdom
 *
 * G3.2 / REVISION 4 — G32-B01 + G32-B02: an alert is not a second stock truth.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 * ─────────────────────────────────────────────────────────────────────────────
 * Global Material Search isolated every `inventory_alerts` row into a group of
 * its own, and each such group then adopted the alert's `observed_on_hand` as
 * its balance. Those observed values are not independent inventory — Migration
 * 150 computes them FROM the stock tables this report already sums:
 *
 *   quantity signals (missing / low_stock / surplus)
 *       observed_on_hand := sum(on_hand_quantity) over the scope's material
 *   expiry signals (near_expiry / expired)
 *       observed_on_hand := one lot's on_hand_quantity, with that lot's id
 *                           recorded in source_stock_id
 *
 * So a warehouse holding 100 units, with one alert about those 100 units,
 * reported 200 — in the panel's tiles, in the results table, and in the
 * exported workbook's Institution Summary. An operator reading any of the three
 * saw twice the medicine that exists.
 *
 * The premise that produced it was a false schema claim: that `inventory_alerts`
 * "holds no structural material identifier at all". Migration 150 adds
 * `central_item_id`, `source_stock_id`, `material_identity_version`,
 * `material_identity_key` and `material_identity_state` to that table, under
 * `inventory_alerts_material_state_chk`, which ties state and key together.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSERTED, AND AT WHICH ALTITUDE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every case below runs the REAL aggregation against an injected fake PostgREST
 * transport, because a double count is an OUTCOME and an outcome has to be
 * executed to be believed. Cases 10 and 11 go further and re-prove it at the
 * two surfaces the defect actually reached — the rendered panel tile and the
 * workbook's Institution Summary sheet — since a service that is right while a
 * consumer re-sums it is still wrong on screen.
 *
 * The corrected rule in one line each:
 *   resolved alert          → joins the canonical material group by KEY
 *   legacy_unresolved alert → stays isolated; never merged by any label
 *   both                    → contribute a SIGNAL, never a quantity
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { searchGlobalMaterialStock } from '../global-material-search.service';
import { exportGlobalMaterialSearchWorkbook } from '../global-material-export';

// ─────────────────────────────────────────────────────────────────────────────
// Fake PostgREST transport. The builder is thenable so a query ending at
// `.in(...)` resolves exactly like one ending at `.limit(...)`, matching how the
// service actually composes its reads.
// ─────────────────────────────────────────────────────────────────────────────
interface TableRows { [table: string]: unknown[] }

function installClient(rowsByTable: TableRows): void {
  (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase = {
    from(table: string) {
      const result = { data: rowsByTable[table] ?? [], error: null };
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
}

vi.mock('@/shared/supabase/client', () => ({
  get supabase() { return (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase; },
  supabaseConfigured: true,
}));

// The panel's own collaborators. The panel's rendering and its aggregate tiles
// — the things under test in CASE 10 — are NOT mocked, and neither is the
// search service: the tile is fed by the real aggregation above.
vi.mock('@/app/AppContext', () => ({
  useApp: () => ({ lang: 'en' as const, role: 'super_admin' }),
}));

vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: () => Promise.resolve([
    { id: 'org1', name: 'Sector One', name_ar: 'قطاع واحد', status: 'active' },
  ]),
}));

const ORG = 'org1';
const KEY_A = 'material:v1|central=ci-1|scientific=amoxicillin|conc=500mg';
const KEY_B = 'material:v1|central=ci-2|scientific=amoxicillin|conc=250mg';

/** A `warehouse_stock` row. `material_identity_key` is 150's GENERATED column. */
const stock = (over: Record<string, unknown> = {}) => ({
  id: 'ws1',
  organization_id: ORG,
  warehouse_id: 'wh1',
  scientific_name: 'Amoxicillin',
  trade_name: null,
  concentration: '500mg',
  dosage_form: 'capsule',
  unit: 'box',
  national_code: null,
  batch_number: 'B1',
  expiry_date: '2099-01-01',
  on_hand_quantity: 100,
  reserved_quantity: 0,
  available_quantity: 100,
  material_identity_key: KEY_A,
  ...over,
});

/**
 * A RESOLVED `inventory_alerts` row — the shape
 * `phoenix_recompute_inventory_alerts` writes for every live signal. Note the
 * observed snapshot deliberately EQUALS the stock quantity: that is what 150
 * puts there, and it is precisely what must not be counted twice.
 */
const resolvedAlert = (over: Record<string, unknown> = {}) => ({
  id: 'al1',
  organization_id: ORG,
  scope_kind: 'warehouse',
  scope_id: 'wh1',
  scientific_name: 'Amoxicillin',
  national_code: null,
  signal_type: 'low_stock',
  observed_on_hand: 100,
  observed_available: 100,
  central_item_id: 'ci-1',
  source_stock_id: null,
  material_identity_version: 1,
  material_identity_key: KEY_A,
  material_identity_state: 'resolved',
  ...over,
});

/**
 * A LEGACY_UNRESOLVED alert — 150's backfill could not prove one material, or
 * the threshold-expectation branch emitted a `missing` signal for a material
 * with no live variant at all. Identity columns are null, by CHECK constraint.
 */
const legacyAlert = (over: Record<string, unknown> = {}) => ({
  ...resolvedAlert(),
  id: 'al-legacy',
  central_item_id: null,
  source_stock_id: null,
  material_identity_version: null,
  material_identity_key: null,
  material_identity_state: 'legacy_unresolved',
  ...over,
});

const warehouse = (over: Record<string, unknown> = {}) => ({
  id: 'wh1', name: 'Depot A', name_ar: 'مذخر أ', organization_id: ORG,
  facility_id: 'fac-A', warehouse_kind: 'institution', is_main: false,
  ...over,
});

const organization = () => ({
  id: ORG, name: 'Sector One', name_ar: 'قطاع واحد',
  organization_kind: 'care_institution', institution_class: 'health_sector',
});

function seed(rows: TableRows): void {
  installClient({
    organizations: [organization()],
    warehouses: [warehouse()],
    distribution_points: [],
    inventory_alerts: [],
    warehouse_stock: [],
    outlet_stock: [],
    ...rows,
  });
}

const run = (rows: TableRows) => {
  seed(rows);
  return searchGlobalMaterialStock({ term: 'amox', organizationIds: [ORG], scope: 'all' });
};

/** Total on-hand across the whole result — the figure the panel tile shows. */
const totalOnHand = (rows: ReadonlyArray<{ onHand: number }>) =>
  rows.reduce((sum, row) => sum + row.onHand, 0);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// CASES 1–5 — a resolved alert never adds a balance
// ═════════════════════════════════════════════════════════════════════════════
describe('G32-B01 — a resolved alert never becomes a second copy of the stock', () => {
  it('CASE 1 — stock 100 + one resolved alert observing 100 totals 100, not 200', async () => {
    const result = await run({
      warehouse_stock: [stock()],
      inventory_alerts: [resolvedAlert()],
    });

    expect(totalOnHand(result.rows)).toBe(100);
    // One material in one place is one row. The alert did not open a second.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].onHand).toBe(100);
    expect(result.rows[0].available).toBe(100);
    // And it is the stock row that survived, carrying the alert as metadata.
    expect(result.rows[0].stockBacked).toBe(true);
    expect(result.rows[0].materialIdentityKey).toBe(KEY_A);
    expect(result.rows[0].signals).toContain('low_stock');
  });

  it('CASE 2 — TWO resolved alerts for the same material/scope still total 100', async () => {
    const result = await run({
      warehouse_stock: [stock()],
      inventory_alerts: [
        resolvedAlert({ id: 'al1', signal_type: 'low_stock' }),
        resolvedAlert({ id: 'al2', signal_type: 'surplus' }),
      ],
    });

    expect(totalOnHand(result.rows)).toBe(100);
    expect(result.rows).toHaveLength(1);
    // Both alerts are represented; neither contributed a quantity.
    expect(result.rows[0].alertCount).toBe(2);
    expect(result.rows[0].signals).toEqual(expect.arrayContaining(['low_stock', 'surplus']));
  });

  it('CASE 3 — a resolved near_expiry/expired alert adds no duplicate stock total', async () => {
    for (const signal of ['near_expiry', 'expired'] as const) {
      const result = await run({
        warehouse_stock: [stock()],
        // The expiry signals name the exact lot in `source_stock_id`, which is
        // the strongest possible proof that the observed value is a COPY of a
        // row already counted above.
        inventory_alerts: [resolvedAlert({
          id: `al-${signal}`, signal_type: signal, source_stock_id: 'ws1',
        })],
      });

      expect(totalOnHand(result.rows)).toBe(100);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].signals).toContain(signal);
    }
  });

  it('CASE 4 — a missing alert observing 0 leaves the real total at 100', async () => {
    const result = await run({
      warehouse_stock: [stock()],
      inventory_alerts: [resolvedAlert({
        signal_type: 'missing', observed_on_hand: 0, observed_available: 0,
      })],
    });

    // The failure this pins is subtler than addition: an alert must not be able
    // to REPLACE a real balance with its own snapshot either.
    expect(totalOnHand(result.rows)).toBe(100);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].onHand).toBe(100);
    expect(result.rows[0].signals).toContain('missing');
  });

  it('CASE 5 — a resolved alert with NO fetched stock row stays discoverable at zero', async () => {
    const result = await run({
      warehouse_stock: [],
      inventory_alerts: [resolvedAlert({ observed_on_hand: 100, observed_available: 100 })],
    });

    // Discoverable: the operator still sees the material and its signal.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].signals).toContain('low_stock');
    expect(result.rows[0].materialIdentityKey).toBe(KEY_A);
    expect(result.rows[0].alertCount).toBe(1);

    // FAIL CLOSED: no stock row was read, so no stock is reported. The observed
    // snapshot of 100 is not promoted into a balance that no table would
    // confirm — the row says "signal here, nothing readable", which is true.
    expect(result.rows[0].stockBacked).toBe(false);
    expect(result.rows[0].onHand).toBe(0);
    expect(result.rows[0].available).toBe(0);
    expect(result.rows[0].reserved).toBe(0);
    expect(totalOnHand(result.rows)).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CASES 6–7 — an unresolved alert is still never rescued by a label
// ═════════════════════════════════════════════════════════════════════════════
describe('G32-B02 — legacy_unresolved alerts stay identity-isolated', () => {
  it('CASE 6 — a legacy alert sharing a real material name does NOT merge by name', async () => {
    const result = await run({
      warehouse_stock: [stock()],
      // Same organization, same warehouse, same scientific_name, same national
      // code — every value a label-based merge keys on.
      inventory_alerts: [legacyAlert()],
    });

    expect(result.rows).toHaveLength(2);
    const stockRow = result.rows.find(r => !r.isolated);
    const alertRow = result.rows.find(r => r.isolated);

    expect(stockRow?.onHand).toBe(100);
    expect(stockRow?.signals).not.toContain('low_stock');
    expect(alertRow?.materialIdentityKey).toBeNull();

    // It is a SEPARATE row — and still not a second balance. The old code made
    // this row report 100 and the total 200; both halves are fixed.
    expect(alertRow?.onHand).toBe(0);
    expect(totalOnHand(result.rows)).toBe(100);
  });

  it('CASE 7 — two legacy alerts with identical display fields stay separate, with no fallback', async () => {
    const result = await run({
      inventory_alerts: [
        legacyAlert({ id: 'al-a', signal_type: 'low_stock' }),
        legacyAlert({ id: 'al-b', signal_type: 'missing' }),
      ],
    });

    expect(result.rows).toHaveLength(2);
    expect(result.rows.every(r => r.isolated)).toBe(true);
    expect(result.rows.every(r => r.materialIdentityKey === null)).toBe(true);
    // Nothing was invented to fill the identity, and nothing was counted.
    expect(totalOnHand(result.rows)).toBe(0);
  });

  it('an unresolved alert is not rescued by source_stock_id either', async () => {
    // A structural fallback would be the same mistake as a name fallback: 150
    // declined to certify this alert's identity, and a link it did not certify
    // is not proof. The correlation may only REFINE an already-proven key.
    const result = await run({
      warehouse_stock: [stock()],
      inventory_alerts: [legacyAlert({ source_stock_id: 'ws1' })],
    });

    expect(result.rows).toHaveLength(2);
    expect(result.rows.find(r => r.isolated)?.materialIdentityKey).toBeNull();
    expect(totalOnHand(result.rows)).toBe(100);
  });

  it('a row claiming resolved with a BLANK key is treated as unresolved', async () => {
    // The database CHECK forbids this pairing; the client still refuses to
    // trust a shape it did not construct. Under-claiming isolates a visible
    // row, over-claiming merges materials never proved to be the same.
    const result = await run({
      warehouse_stock: [stock()],
      inventory_alerts: [resolvedAlert({ material_identity_key: '   ' })],
    });

    expect(result.rows).toHaveLength(2);
    expect(totalOnHand(result.rows)).toBe(100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CASES 8–9 — canonical identity, not display text, decides separation
// ═════════════════════════════════════════════════════════════════════════════
describe('canonical identity keeps genuinely different materials apart', () => {
  it('CASE 8 — same scientific name, different concentration → separate groups', async () => {
    const result = await run({
      warehouse_stock: [
        stock({ id: 'ws1', concentration: '500mg', material_identity_key: KEY_A, on_hand_quantity: 100, available_quantity: 100 }),
        stock({ id: 'ws2', concentration: '250mg', material_identity_key: KEY_B, on_hand_quantity: 40, available_quantity: 40 }),
      ],
    });

    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map(r => r.materialIdentityKey))).toEqual(new Set([KEY_A, KEY_B]));
    // Separate groups, and the grand total is still every real unit once.
    expect(totalOnHand(result.rows)).toBe(140);
  });

  it('CASE 8b — a resolved alert joins ONLY the strength its key names', async () => {
    const result = await run({
      warehouse_stock: [
        stock({ id: 'ws1', concentration: '500mg', material_identity_key: KEY_A, on_hand_quantity: 100, available_quantity: 100 }),
        stock({ id: 'ws2', concentration: '250mg', material_identity_key: KEY_B, on_hand_quantity: 40, available_quantity: 40 }),
      ],
      inventory_alerts: [resolvedAlert({ material_identity_key: KEY_B, signal_type: 'low_stock' })],
    });

    expect(result.rows).toHaveLength(2);
    const b = result.rows.find(r => r.materialIdentityKey === KEY_B);
    const a = result.rows.find(r => r.materialIdentityKey === KEY_A);
    expect(b?.signals).toContain('low_stock');
    expect(a?.signals).not.toContain('low_stock');
    expect(totalOnHand(result.rows)).toBe(140);
  });

  it('CASE 9 — same normalized name, different dosage form → separate groups', async () => {
    const capsuleKey = 'material:v1|scientific=amoxicillin|form=capsule';
    const syrupKey = 'material:v1|scientific=amoxicillin|form=syrup';
    const result = await run({
      warehouse_stock: [
        // Identical bilingual spelling; the DOSAGE FORM is the real difference,
        // and 150's generated key is where that difference lives.
        stock({ id: 'ws1', dosage_form: 'capsule', material_identity_key: capsuleKey, on_hand_quantity: 100, available_quantity: 100 }),
        stock({ id: 'ws2', dosage_form: 'syrup', material_identity_key: syrupKey, on_hand_quantity: 30, available_quantity: 30 }),
      ],
    });

    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map(r => r.materialIdentityKey))).toEqual(
      new Set([capsuleKey, syrupKey]),
    );
    expect(totalOnHand(result.rows)).toBe(130);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CASE 10 — the panel's aggregate tile, PROVED BY RENDERING
// ═════════════════════════════════════════════════════════════════════════════
describe('CASE 10 — the panel aggregate tiles do not double count', () => {
  /** Mount the panel, run one real search, and return the rendered container. */
  async function renderSearch(rows: TableRows): Promise<HTMLElement> {
    seed(rows);
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

    await waitFor(() => {
      if (!container.textContent?.includes('Amoxicillin')) {
        throw new Error('results not rendered yet');
      }
    });
    return container;
  }

  /** Read the number printed on the tile whose caption is `label`. */
  function tileValue(container: HTMLElement, label: string): string | null {
    const caption = [...container.querySelectorAll('div')]
      .find(el => el.children.length === 0 && el.textContent?.trim() === label);
    return caption?.previousElementSibling?.textContent?.trim() ?? null;
  }

  it('stock 100 + a matching resolved alert renders an On hand tile of 100', async () => {
    const container = await renderSearch({
      warehouse_stock: [stock()],
      inventory_alerts: [resolvedAlert()],
    });

    // The defect was visible here first: this tile read 200.
    expect(tileValue(container, 'On hand')).toBe('100');
    expect(tileValue(container, 'Available')).toBe('100');
  });

  it('a legacy alert beside real stock leaves the On hand tile at 100', async () => {
    const container = await renderSearch({
      warehouse_stock: [stock()],
      inventory_alerts: [legacyAlert()],
    });

    // Two rows are listed — the alert is isolated, as it must be — but only one
    // of them carries a balance.
    expect(tileValue(container, 'On hand')).toBe('100');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CASE 11 — the workbook's Institution Summary, PROVED BY READING THE FILE
// ═════════════════════════════════════════════════════════════════════════════
describe('CASE 11 — the Excel Institution Summary does not double count', () => {
  /** Capture the Blob the module hands to the download anchor. */
  function captureDownloadBlob(): { get: () => Blob } {
    let captured: Blob | undefined;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => { captured = blob; return 'blob:mock-url'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    restore.push(() => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    });
    return {
      get: () => {
        if (!captured) throw new Error('no blob captured');
        return captured;
      },
    };
  }

  const restore: Array<() => void> = [];
  afterEach(() => restore.splice(0).forEach(fn => fn()));

  /** Export the REAL search result and read back the summary sheet's numbers. */
  async function summaryRow(rows: TableRows): Promise<{ onHand: number; available: number }> {
    const result = await run(rows);
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook({
      lang: 'en',
      query: 'amox',
      organizations: [{ id: ORG, name: 'Sector One', nameAr: 'قطاع واحد' }],
      result,
    });

    const workbook = new ExcelJS.Workbook();
    const buffer = Buffer.from(await capture.get().arrayBuffer());
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('Institution Summary')!;
    // Row 4 is the header; institution totals start at row 5.
    const data = sheet.getRow(5);
    return { onHand: Number(data.getCell(3).value), available: Number(data.getCell(5).value) };
  }

  it('stock 100 + a matching resolved alert sums to 100 in the workbook', async () => {
    const totals = await summaryRow({
      warehouse_stock: [stock()],
      inventory_alerts: [resolvedAlert()],
    });

    // This sheet sums `onHand` across every exported row, so an extra
    // alert-only row carrying an observed 100 landed here as 200.
    expect(totals.onHand).toBe(100);
    expect(totals.available).toBe(100);
  });

  it('an isolated legacy alert contributes no quantity to the institution total', async () => {
    const totals = await summaryRow({
      warehouse_stock: [stock()],
      inventory_alerts: [legacyAlert()],
    });

    expect(totals.onHand).toBe(100);
  });

  it('two resolved alerts about the same material still sum to 100', async () => {
    const totals = await summaryRow({
      warehouse_stock: [stock()],
      inventory_alerts: [
        resolvedAlert({ id: 'al1', signal_type: 'low_stock' }),
        resolvedAlert({ id: 'al2', signal_type: 'near_expiry', source_stock_id: 'ws1' }),
      ],
    });

    expect(totals.onHand).toBe(100);
  });
});
