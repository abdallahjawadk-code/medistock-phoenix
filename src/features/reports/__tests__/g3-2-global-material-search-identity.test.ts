/**
 * G3.2 / U4 + U5 + U7A — global material search: identity, structure, honesty.
 *
 * The behaviour under test is the one that silently produced WRONG NUMBERS.
 * Aggregating by `lower(scientific_name)` summed genuinely different materials
 * into a single total and split one material across Arabic spelling variants,
 * and the export presented both as fact. These tests therefore assert on the
 * aggregated OUTPUT, not on the shape of the query: a report is only correct if
 * its totals are.
 */
import { describe, it, expect, vi } from 'vitest';
import { searchGlobalMaterialStock } from '../global-material-search.service';

// ── A fake PostgREST transport. The builder is thenable so a query that ends
//    at .in(...) resolves just like one that ends at .limit(...). ──
interface TableRows { [table: string]: unknown[] }

function installClient(rowsByTable: TableRows) {
  const client = {
    from(table: string) {
      const rows = rowsByTable[table] ?? [];
      const result = { data: rows, error: null };
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq() { return builder; },
        in() { return builder; },
        ilike() { return builder; },
        limit() { return Promise.resolve(result); },
        then(resolve: (value: typeof result) => unknown) { return Promise.resolve(result).then(resolve); },
      };
      return builder;
    },
  };
  (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase = client;
}

vi.mock('@/shared/supabase/client', () => ({
  get supabase() { return (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase; },
  supabaseConfigured: true,
}));

const ORG = 'org1';

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
  on_hand_quantity: 10,
  reserved_quantity: 0,
  available_quantity: 10,
  material_identity_key: 'material:v1|key-A',
  ...over,
});

const warehouse = (over: Record<string, unknown> = {}) => ({
  id: 'wh1', name: 'Depot A', name_ar: 'مذخر أ',
  organization_id: ORG, facility_id: 'fac-A',
  warehouse_kind: 'institution', is_main: false,
  ...over,
});

const organization = (over: Record<string, unknown> = {}) => ({
  id: ORG, name: 'Sector One', name_ar: 'قطاع واحد',
  organization_kind: 'care_institution', institution_class: 'health_sector',
  ...over,
});

const run = (rows: TableRows) => {
  installClient({
    organizations: [organization()],
    warehouses: [warehouse()],
    distribution_points: [],
    inventory_alerts: [],
    warehouse_stock: [],
    outlet_stock: [],
    ...rows,
  });
  return searchGlobalMaterialStock({ term: 'amox', organizationIds: [ORG], scope: 'all' });
};

// ═════════════════════════════════════════════════════════════════════════════
// U4 — aggregation by canonical identity (owner DECISION C)
// ═════════════════════════════════════════════════════════════════════════════
describe('U4 — grouping is by material_identity_key, never by name', () => {
  it('NEGATIVE — same display name + DIFFERENT identity keys stay separate rows', async () => {
    const result = await run({
      warehouse_stock: [
        stock({ id: 'ws1', material_identity_key: 'material:v1|key-A', available_quantity: 10, on_hand_quantity: 10 }),
        stock({ id: 'ws2', material_identity_key: 'material:v1|key-B', available_quantity: 7, on_hand_quantity: 7 }),
      ],
    });

    // Before G3.2 these two summed into ONE row of 17. They are different
    // materials; the total was fiction.
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(r => r.available).sort((a, b) => a - b)).toEqual([7, 10]);
    expect(new Set(result.rows.map(r => r.materialIdentityKey)).size).toBe(2);
  });

  it('POSITIVE — the SAME identity key across several lots aggregates, as intended', async () => {
    const result = await run({
      warehouse_stock: [
        stock({ id: 'ws1', batch_number: 'B1', on_hand_quantity: 10, available_quantity: 10 }),
        stock({ id: 'ws2', batch_number: 'B2', on_hand_quantity: 5, available_quantity: 4, reserved_quantity: 1 }),
      ],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].onHand).toBe(15);
    expect(result.rows[0].available).toBe(14);
    expect(result.rows[0].reserved).toBe(1);
    // Lot identity is not material identity: both batches are still counted.
    expect(result.rows[0].batchCount).toBe(2);
    expect(result.rows[0].isolated).toBe(false);
  });

  it('FAIL-SAFE — rows with a MISSING identity key are isolated, never merged by name', async () => {
    const result = await run({
      warehouse_stock: [
        stock({ id: 'ws1', material_identity_key: null, on_hand_quantity: 10, available_quantity: 10 }),
        stock({ id: 'ws2', material_identity_key: null, on_hand_quantity: 5, available_quantity: 5 }),
      ],
    });

    // Identical names, identical everything a label could see — and still
    // separate, because nothing proved they are the same material.
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every(r => r.isolated)).toBe(true);
    expect(result.rows.every(r => r.materialIdentityKey === null)).toBe(true);
  });

  it('FAIL-SAFE — a keyed row and an unkeyed row of the same name do NOT merge', async () => {
    const result = await run({
      warehouse_stock: [
        stock({ id: 'ws1', material_identity_key: 'material:v1|key-A' }),
        stock({ id: 'ws2', material_identity_key: null }),
      ],
    });
    expect(result.rows).toHaveLength(2);
  });

  it('NO-FABRICATION — an isolated row does not invent an identity key to fill the field', async () => {
    const result = await run({
      warehouse_stock: [stock({ material_identity_key: null })],
    });
    expect(result.rows[0].materialIdentityKey).toBeNull();
    expect(result.rows[0].isolated).toBe(true);
  });

  it('the same material in two DIFFERENT locations stays separate (location is scope, not identity)', async () => {
    const result = await run({
      warehouses: [warehouse(), warehouse({ id: 'wh2', name: 'Depot B', facility_id: 'fac-B' })],
      warehouse_stock: [
        stock({ id: 'ws1', warehouse_id: 'wh1' }),
        stock({ id: 'ws2', warehouse_id: 'wh2' }),
      ],
    });
    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map(r => r.scopeId)).size).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U4 — alert identity (owner DECISION C, second half — CORRECTED)
//
// WHY THESE ASSERTIONS CHANGED, IN DETAIL.
//
// This block used to require EVERY `inventory_alerts` row to be isolated, on
// the stated premise that the table "carries no structural material identifier
// at all". That premise was false. Migration 150 adds `central_item_id`,
// `source_stock_id`, `material_identity_version`, `material_identity_key` and
// `material_identity_state` to `inventory_alerts`, and a 'resolved' alert's key
// is the SAME generated value the stock row carries — not a lookalike.
//
// Isolating such an alert was not a harmless extra row. The alert-only group
// then adopted `observed_on_hand` as its balance, and that snapshot is a COPY
// of stock this report had already counted: 150 fills it from
// `sum(on_hand_quantity)` for the quantity signals and from one lot's
// `on_hand_quantity` for the expiry signals. 100 units plus one alert about
// those 100 units read as 200.
//
// The corrected rule, asserted below:
//   resolved alert          → joins the canonical material group by KEY
//   legacy_unresolved alert → stays isolated; still NO name fallback
//   either way              → contributes a SIGNAL, never a quantity
// ═════════════════════════════════════════════════════════════════════════════
describe('U4 — alerts carry canonical identity, and never a second balance', () => {
  const resolvedAlert = (over: Record<string, unknown> = {}) => ({
    id: 'al1', organization_id: ORG, scope_kind: 'warehouse', scope_id: 'wh1',
    scientific_name: 'Amoxicillin', national_code: null,
    signal_type: 'low_stock', observed_on_hand: 10, observed_available: 10,
    central_item_id: 'ci-1', source_stock_id: null,
    material_identity_version: 1, material_identity_key: 'material:v1|key-A',
    material_identity_state: 'resolved',
    ...over,
  });

  const legacyAlert = (over: Record<string, unknown> = {}) => ({
    id: 'al9', organization_id: ORG, scope_kind: 'warehouse', scope_id: 'wh1',
    scientific_name: 'Amoxicillin', national_code: null,
    signal_type: 'low_stock', observed_on_hand: 3, observed_available: 3,
    central_item_id: null, source_stock_id: null,
    material_identity_version: null, material_identity_key: null,
    material_identity_state: 'legacy_unresolved',
    ...over,
  });

  it('POSITIVE — a RESOLVED alert joins its material group instead of duplicating it', async () => {
    const result = await run({
      warehouse_stock: [stock({ on_hand_quantity: 100, available_quantity: 100 })],
      inventory_alerts: [resolvedAlert({ observed_on_hand: 100, observed_available: 100 })],
    });

    // Structural scope + Migration 150's key proves this is the same material,
    // so there is ONE row — and it holds the stock's own total, not the stock's
    // total plus the alert's copy of it.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].onHand).toBe(100);
    expect(result.rows[0].available).toBe(100);
    // The alert did not vanish: it is represented on the canonical row.
    expect(result.rows[0].signals).toContain('low_stock');
    expect(result.rows[0].alertCount).toBe(1);
    expect(result.rows[0].isolated).toBe(false);
  });

  it('NEGATIVE — a LEGACY_UNRESOLVED alert with a matching NAME still does not join', async () => {
    const result = await run({
      warehouse_stock: [stock({ on_hand_quantity: 10, available_quantity: 10 })],
      inventory_alerts: [legacyAlert()],
    });

    // Nothing structural links this alert to that stock, and its name is not
    // allowed to. It stands alone — but it brings no balance with it.
    expect(result.rows).toHaveLength(2);
    const stockRow = result.rows.find(r => !r.isolated);
    const alertRow = result.rows.find(r => r.isolated);
    expect(stockRow?.available).toBe(10);
    expect(stockRow?.signals).not.toContain('low_stock');
    expect(alertRow?.signals).toContain('low_stock');
    expect(alertRow?.onHand).toBe(0);
  });

  it('an alert-only row is DISCOVERABLE but manufactures no stock from its snapshot', async () => {
    const result = await run({ inventory_alerts: [legacyAlert()] });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].isolated).toBe(true);
    expect(result.rows[0].signals).toContain('low_stock');
    expect(result.rows[0].alertCount).toBe(1);
    // `observed_on_hand` was 3. It is not inventory, so it is not reported as
    // inventory — the row says "signal here, no readable stock", which is true.
    expect(result.rows[0].stockBacked).toBe(false);
    expect(result.rows[0].onHand).toBe(0);
    expect(result.rows[0].available).toBe(0);
    expect(result.rows[0].reserved).toBe(0);
  });

  it('two LEGACY_UNRESOLVED alerts sharing every display value stay identity-isolated', async () => {
    const result = await run({
      inventory_alerts: [
        legacyAlert({ id: 'al1' }),
        legacyAlert({ id: 'al2', signal_type: 'missing' }),
      ],
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every(r => r.isolated)).toBe(true);
    expect(result.rows.every(r => r.materialIdentityKey === null)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U5 — structural facility context (owner DECISION D)
// ═════════════════════════════════════════════════════════════════════════════
describe('U5 — rows carry structural facility context', () => {
  it('a Health Centre depot row carries its exact facility id', async () => {
    const result = await run({ warehouse_stock: [stock()] });
    expect(result.rows[0].facilityId).toBe('fac-A');
    expect(result.rows[0].sectorRole).toBe('health_center');
  });

  it('SIBLING-SCOPE — two centres of ONE sector are distinguishable in the output', async () => {
    const result = await run({
      warehouses: [
        warehouse({ id: 'wh1', facility_id: 'fac-A' }),
        warehouse({ id: 'wh2', facility_id: 'fac-B', name: 'Depot B' }),
      ],
      warehouse_stock: [
        stock({ id: 'ws1', warehouse_id: 'wh1' }),
        stock({ id: 'ws2', warehouse_id: 'wh2' }),
      ],
    });
    expect(new Set(result.rows.map(r => r.facilityId))).toEqual(new Set(['fac-A', 'fac-B']));
  });

  it('a proven Sector Main is labelled sector_main', async () => {
    const result = await run({
      warehouses: [warehouse({ facility_id: null, is_main: true })],
      warehouse_stock: [stock()],
    });
    expect(result.rows[0].facilityId).toBeNull();
    expect(result.rows[0].sectorRole).toBe('sector_main');
  });

  it('NEGATIVE — a NULL facility outside a health sector is NOT sector_main', async () => {
    const result = await run({
      organizations: [organization({ institution_class: 'hospital' })],
      warehouses: [warehouse({ facility_id: null, is_main: true })],
      warehouse_stock: [stock()],
    });
    expect(result.rows[0].facilityId).toBeNull();
    expect(result.rows[0].sectorRole).toBe('unclassified');
  });

  it('an OUTLET resolves its facility through its PARENT warehouse, never by name', async () => {
    const result = await run({
      warehouses: [warehouse({ id: 'wh1', facility_id: 'fac-A' })],
      distribution_points: [{ id: 'dp1', name: 'Pharmacy', name_ar: 'صيدلية', warehouse_id: 'wh1' }],
      outlet_stock: [stock({ id: 'os1', warehouse_id: undefined, distribution_point_id: 'dp1' })],
    });
    expect(result.rows[0].scopeKind).toBe('outlet');
    expect(result.rows[0].facilityId).toBe('fac-A');
  });

  it('an outlet whose parent warehouse cannot be read is reported unplaced, not relocated', async () => {
    const result = await run({
      warehouses: [],
      distribution_points: [{ id: 'dp1', name: 'Pharmacy', name_ar: 'صيدلية', warehouse_id: null }],
      outlet_stock: [stock({ id: 'os1', warehouse_id: undefined, distribution_point_id: 'dp1' })],
    });
    expect(result.rows[0].facilityId).toBeNull();
    expect(result.rows[0].sectorRole).toBe('unclassified');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U7A — truncation is reported, never presented as a complete total
// ═════════════════════════════════════════════════════════════════════════════
describe('U7A — source truncation is surfaced', () => {
  it('a normal result reports sourceTruncated = false', async () => {
    const result = await run({ warehouse_stock: [stock()] });
    expect(result.sourceTruncated).toBe(false);
  });

  it('BOUNDARY — hitting the per-field cap marks the result as incomplete', async () => {
    // 500 = PER_FIELD_LIMIT. A query that returned exactly its cap had more.
    const capped = Array.from({ length: 500 }, (_, i) => stock({
      id: `ws${i}`, material_identity_key: `material:v1|key-${i}`,
    }));
    const result = await run({ warehouse_stock: capped });

    expect(result.sourceTruncated).toBe(true);
    // The totals still render — they are simply declared to be a lower bound
    // rather than silently presented as the whole picture.
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('sourceTruncated is independent of display truncation', async () => {
    const result = await run({ warehouse_stock: [stock()] });
    expect(result.truncated).toBe(false);
    expect(result.sourceTruncated).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Preserved guarantees
// ═════════════════════════════════════════════════════════════════════════════
describe('U4/U5 — preserved input guarantees', () => {
  it('still refuses a term shorter than two characters', async () => {
    installClient({});
    await expect(searchGlobalMaterialStock({ term: 'a', organizationIds: [ORG], scope: 'all' }))
      .rejects.toThrow('search_term_too_short');
  });

  it('still refuses a search with no organization selected', async () => {
    installClient({});
    await expect(searchGlobalMaterialStock({ term: 'amox', organizationIds: [], scope: 'all' }))
      .rejects.toThrow('organization_required');
  });

  it('still caps the number of organizations', async () => {
    installClient({});
    const many = Array.from({ length: 101 }, (_, i) => `org-${i}`);
    await expect(searchGlobalMaterialStock({ term: 'amox', organizationIds: many, scope: 'all' }))
      .rejects.toThrow('too_many_organizations');
  });

  it('reports expiry signals from the stock rows themselves', async () => {
    const result = await run({
      warehouse_stock: [stock({ expiry_date: '2000-01-01', available_quantity: 4, on_hand_quantity: 4 })],
    });
    expect(result.rows[0].signals).toContain('expired');
    expect(result.rows[0].expiredAvailable).toBe(4);
  });
});
