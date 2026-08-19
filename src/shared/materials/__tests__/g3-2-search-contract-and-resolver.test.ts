/**
 * G3.2 — canonical search contract + material resolver convergence.
 *
 * These are BEHAVIOURAL tests against an injected fake PostgREST transport, not
 * source greps: they prove what the resolver RETURNS for a given row, which is
 * the only thing a calling screen can act on.
 *
 * Deliberately included are the negative cases, because every defect this unit
 * closes was a silent one — a discarded column, an unfiltered status, a null
 * read as a meaning. A test that only asserts the happy path would have passed
 * against the broken code too.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveMaterials } from '../material-resolver.service';
import {
  classifyWarehouseSectorRole,
  materialGroupingKey,
  isIsolatedGroupingKey,
} from '../search-contract';

// ── Fake supabase transport. Mirrors the shape the resolver builds: every
//    query terminates in .limit(), which resolves with the canned rows. ──
function fakeClient(rowsByTable: Record<string, unknown[]>) {
  const calls: Array<{ table: string; or: string | null; eqCols: string[]; selected: string }> = [];
  const client = {
    from(table: string) {
      const state = { table, or: null as string | null, eqCols: [] as string[], selected: '' };
      const builder: Record<string, unknown> = {
        select(cols?: string) { state.selected = cols ?? ''; return builder; },
        eq(col: string) { state.eqCols.push(col); return builder; },
        is() { return builder; },
        in() { return builder; },
        ilike() { return builder; },
        or(expr: string) { state.or = expr; return builder; },
        abortSignal() { return builder; },
        limit() {
          calls.push(state);
          return Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

vi.mock('@/shared/supabase/client', () => ({
  get supabase() { return (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase; },
  supabaseConfigured: true,
}));

function withClient<T>(
  rowsByTable: Record<string, unknown[]>,
  fn: (calls: ReturnType<typeof fakeClient>['calls']) => T,
): T {
  const { client, calls } = fakeClient(rowsByTable);
  (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase = client;
  return fn(calls);
}

const catalogRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', barcode: null,
  unit: 'box', status: 'active', trade_name: null, concentration: null, dosage_form: null,
  ...over,
});

const stockRow = (over: Record<string, unknown> = {}) => ({
  id: 's1', scientific_name: 'Amoxicillin', trade_name: null, concentration: '500mg',
  dosage_form: 'capsule', unit: 'box', national_code: 'NC-1', batch_number: 'B1',
  expiry_date: '2099-01-01', on_hand_quantity: 10, reserved_quantity: 0,
  available_quantity: 10, supply_type_text: null,
  material_identity_key: 'material:v1|central=c1|scientific=amoxicillin',
  central_item_id: 'c1', organization_id: 'org1', warehouse_id: 'wh1',
  ...over,
});

const warehouseRow = (over: Record<string, unknown> = {}) => ({
  id: 'wh1', organization_id: 'org1', facility_id: null,
  warehouse_kind: 'institution', is_main: true,
  organizations: { organization_kind: 'care_institution', institution_class: 'health_sector' },
  ...over,
});

// ═════════════════════════════════════════════════════════════════════════════
// U2 / G3.2-GAP-01 — catalog identity is READ, not discarded
// ═════════════════════════════════════════════════════════════════════════════
describe('U2 — catalog rows carry Migration 114 identity detail', () => {
  it('returns real concentration / dosage form / trade name from the row', async () => {
    const rows = await withClient({
      central_items: [catalogRow({
        trade_name: 'Amoxil', concentration: '500mg', dosage_form: 'capsule',
      })],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows).toHaveLength(1);
    expect(rows[0].concentration).toBe('500mg');
    expect(rows[0].dosageForm).toBe('capsule');
    expect(rows[0].tradeName).toBe('Amoxil');
    expect(rows[0].canonical.display.concentration).toBe('500mg');
    expect(rows[0].canonical.display.dosageForm).toBe('capsule');
  });

  it('POSITIVE — two catalog rows with the SAME name but different strengths are distinguishable', async () => {
    const rows = await withClient({
      central_items: [
        catalogRow({ id: 'c250', concentration: '250mg', dosage_form: 'capsule' }),
        catalogRow({ id: 'c500', concentration: '500mg', dosage_form: 'capsule' }),
      ],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows).toHaveLength(2);
    // The identities differ...
    expect(new Set(rows.map(r => r.centralItemId)).size).toBe(2);
    // ...and so does what the operator actually SEES. Before G3.2 these two
    // rendered identically and the operator picked blind.
    const rendered = rows.map(r => `${r.scientificName}|${r.concentration}|${r.dosageForm}`);
    expect(new Set(rendered).size).toBe(2);
  });

  it('BOUNDARY — a genuinely NULL discriminator stays NULL and is never invented', async () => {
    const rows = await withClient({
      central_items: [catalogRow({ concentration: null, dosage_form: null, trade_name: null })],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows[0].concentration).toBeNull();
    expect(rows[0].dosageForm).toBeNull();
  });

  it('BOUNDARY — a blank-string column is normalized to null, not to an empty label', async () => {
    const rows = await withClient({
      central_items: [catalogRow({ concentration: '   ', dosage_form: '' })],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows[0].concentration).toBeNull();
    expect(rows[0].dosageForm).toBeNull();
  });

  it('prefers 114 trade_name, falling back to name_ar only when the row has none', async () => {
    const withTrade = await withClient({
      central_items: [catalogRow({ trade_name: 'Amoxil', name_ar: 'أموكسيسيلين' })],
    }, () => resolveMaterials('amoxicillin', {}));
    expect(withTrade[0].tradeName).toBe('Amoxil');

    const withoutTrade = await withClient({
      central_items: [catalogRow({ trade_name: null, name_ar: 'أموكسيسيلين' })],
    }, () => resolveMaterials('amoxicillin', {}));
    expect(withoutTrade[0].tradeName).toBe('أموكسيسيلين');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U2 / G3.2-GAP-02 — inactive catalog rows are not operationally selectable
// ═════════════════════════════════════════════════════════════════════════════
describe('U2 — inactive catalog material exclusion (owner DECISION B)', () => {
  it('NEGATIVE — the catalog query filters on status, server-side', async () => {
    const calls = await withClient({ central_items: [] },
      (c) => resolveMaterials('amox', {}).then(() => c));
    const catalog = calls.find(c => c.table === 'central_items');
    // The exclusion must happen in the QUERY, not by filtering afterwards:
    // a client-side filter over a capped result set silently loses rows.
    expect(catalog?.eqCols).toContain('status');
  });

  it('NEGATIVE — a discontinued row that somehow arrives is reported as not selectable', async () => {
    const rows = await withClient({
      central_items: [catalogRow({ status: 'discontinued' })],
    }, () => resolveMaterials('amoxicillin', {}));

    // The row is not asserted to be absent (the server filter owns that); what
    // is asserted is that the contract never calls it selectable.
    expect(rows[0].canonical.eligibility.active).toBe(false);
    expect(rows[0].canonical.eligibility.selectable).toBe(false);
  });

  // FAIL-CLOSED — `status` is OPTIONAL on CatalogRow, so it can arrive as null
  // or be absent entirely. An earlier reading defaulted both to 'active', which
  // is the one direction this rule must never fail in: a row whose status is
  // UNKNOWN is not thereby a row that is KNOWN ACTIVE. These two cases are the
  // difference between "the server filter is the only thing standing between an
  // inactive material and an operator" and a genuine second line of defence.
  it('NEGATIVE — a null status is NOT promoted to active', async () => {
    const rows = await withClient({
      central_items: [catalogRow({ status: null })],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows[0].canonical.eligibility.active).toBe(false);
    expect(rows[0].canonical.eligibility.selectable).toBe(false);
  });

  it('NEGATIVE — an absent status field is NOT promoted to active', async () => {
    const row = catalogRow();
    delete (row as { status?: unknown }).status;
    const rows = await withClient({
      central_items: [row],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows[0].canonical.eligibility.active).toBe(false);
    expect(rows[0].canonical.eligibility.selectable).toBe(false);
  });

  // The positive polarity, asserted explicitly: a fail-closed rule that also
  // refused genuinely active rows would pass every negative test above and
  // still be wrong.
  it('POSITIVE — an explicitly active row remains selectable', async () => {
    const rows = await withClient({
      central_items: [catalogRow({ status: 'active' })],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows[0].canonical.eligibility.active).toBe(true);
    expect(rows[0].canonical.eligibility.selectable).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DECISION A — catalog national-code semantic
// ═════════════════════════════════════════════════════════════════════════════
describe('DECISION A — central_items.barcode IS the catalog national code', () => {
  it('maps barcode to the nationalCode semantic while keeping barcode visible', async () => {
    const rows = await withClient({
      central_items: [catalogRow({ barcode: '6291234567890' })],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows[0].canonical.display.nationalCode).toBe('6291234567890');
    expect(rows[0].barcode).toBe('6291234567890');
  });

  it('a catalog row without a barcode reports a null national code, never an empty string', async () => {
    const rows = await withClient({
      central_items: [catalogRow({ barcode: null })],
    }, () => resolveMaterials('amoxicillin', {}));
    expect(rows[0].canonical.display.nationalCode).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U1 / DECISION E — catalog results fabricate NO operational scope
// ═════════════════════════════════════════════════════════════════════════════
describe('U1 — scope is never fabricated (owner DECISION E)', () => {
  it('a catalog-only result declares scope.kind = "catalog"', async () => {
    const rows = await withClient({
      central_items: [catalogRow()],
    }, () => resolveMaterials('amoxicillin', {}));

    expect(rows[0].canonical.scope.kind).toBe('catalog');
  });

  it('NO-FABRICATION — a catalog scope carries no organization/facility/warehouse key at all', async () => {
    const rows = await withClient({
      central_items: [catalogRow()],
    }, () => resolveMaterials('amoxicillin', {}));

    const scope = rows[0].canonical.scope as unknown as Record<string, unknown>;
    for (const forbidden of ['organizationId', 'facilityId', 'warehouseId', 'distributionPointId']) {
      // Not merely null — absent. A present-but-null field invites a caller to
      // read it as if it meant something.
      expect(Object.prototype.hasOwnProperty.call(scope, forbidden)).toBe(false);
    }
  });

  it('does not read warehouse structure for a catalog-only search', async () => {
    const calls = await withClient({ central_items: [] },
      (c) => resolveMaterials('amox', {}).then(() => c));
    expect(calls.some(c => c.table === 'warehouses')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U1 / U2 — identity is carried, never computed
// ═════════════════════════════════════════════════════════════════════════════
describe('U1 — canonical identity is carried from the database', () => {
  it('a stock result carries 150 material_identity_key and central_item_id verbatim', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow()],
      warehouses: [warehouseRow()],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    const stock = rows.find(r => r.source === 'stock');
    expect(stock?.canonical.identity.materialIdentityKey)
      .toBe('material:v1|central=c1|scientific=amoxicillin');
    expect(stock?.canonical.identity.centralItemId).toBe('c1');
    expect(stock?.canonical.identity.warehouseStockId).toBe('s1');
  });

  it('selects material_identity_key from the stock table rather than deriving one', async () => {
    const calls = await withClient({
      central_items: [], warehouse_stock: [], warehouses: [],
    }, (c) => resolveMaterials('amox', { warehouseId: 'wh1' }).then(() => c));

    const stock = calls.find(c => c.table === 'warehouse_stock');
    expect(stock?.selected).toContain('material_identity_key');
  });

  it('NO-FABRICATION — a stock row with no generated key reports null, not a computed one', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow({ material_identity_key: null })],
      warehouses: [warehouseRow()],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    expect(rows.find(r => r.source === 'stock')?.canonical.identity.materialIdentityKey).toBeNull();
  });

  it('NO-FABRICATION — a catalog result never claims a material identity key', async () => {
    const rows = await withClient({ central_items: [catalogRow()] },
      () => resolveMaterials('amoxicillin', {}));
    expect(rows[0].canonical.identity.materialIdentityKey).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U5 / DECISION D — facility context and the meaning of NULL
// ═════════════════════════════════════════════════════════════════════════════
describe('U5 — structural facility context (owner DECISION D)', () => {
  it('a Health Centre depot carries its exact structural facility id', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow()],
      warehouses: [warehouseRow({ facility_id: 'fac-A', is_main: false })],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    const scope = rows.find(r => r.source === 'stock')?.canonical.scope;
    expect(scope?.kind).toBe('warehouse');
    expect(scope && 'facilityId' in scope ? scope.facilityId : null).toBe('fac-A');
    expect(scope && 'sectorRole' in scope ? scope.sectorRole : null).toBe('health_center');
  });

  it('SIBLING-SCOPE — two sibling centres in ONE sector resolve to different facilities', async () => {
    const a = await withClient({
      central_items: [], warehouse_stock: [stockRow({ warehouse_id: 'whA' })],
      warehouses: [warehouseRow({ id: 'whA', facility_id: 'fac-A', is_main: false })],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'whA' }));
    const b = await withClient({
      central_items: [], warehouse_stock: [stockRow({ warehouse_id: 'whB' })],
      warehouses: [warehouseRow({ id: 'whB', facility_id: 'fac-B', is_main: false })],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'whB' }));

    const facilityOf = (rows: Awaited<ReturnType<typeof resolveMaterials>>) => {
      const scope = rows.find(r => r.source === 'stock')?.canonical.scope;
      return scope && 'facilityId' in scope ? scope.facilityId : null;
    };
    expect(facilityOf(a)).toBe('fac-A');
    expect(facilityOf(b)).toBe('fac-B');
    expect(facilityOf(a)).not.toBe(facilityOf(b));
  });

  it('proves Sector Main only from health-sector organization + main institution warehouse', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow()],
      warehouses: [warehouseRow({ facility_id: null, is_main: true })],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    const scope = rows.find(r => r.source === 'stock')?.canonical.scope;
    expect(scope && 'sectorRole' in scope ? scope.sectorRole : null).toBe('sector_main');
  });

  it('NEGATIVE — a NULL facility in a NON-health-sector organization is NOT Sector Main', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow()],
      warehouses: [warehouseRow({
        facility_id: null,
        is_main: true,
        organizations: { organization_kind: 'care_institution', institution_class: 'hospital' },
      })],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    const scope = rows.find(r => r.source === 'stock')?.canonical.scope;
    expect(scope && 'facilityId' in scope ? scope.facilityId : 'x').toBeNull();
    // The null is reported honestly; the ROLE is not claimed.
    expect(scope && 'sectorRole' in scope ? scope.sectorRole : null).toBe('unclassified');
  });

  it('NEGATIVE — a facility-less NON-main warehouse in a health sector is NOT Sector Main', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow()],
      warehouses: [warehouseRow({ facility_id: null, is_main: false })],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    const scope = rows.find(r => r.source === 'stock')?.canonical.scope;
    expect(scope && 'sectorRole' in scope ? scope.sectorRole : null).toBe('unclassified');
  });

  it('an unreadable warehouse row degrades to unknown context, never to a guess', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow()],
      warehouses: [], // RLS-invisible / missing
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    const scope = rows.find(r => r.source === 'stock')?.canonical.scope;
    // Results still come back — a descriptive lookup failing must not break search.
    expect(rows.length).toBeGreaterThan(0);
    expect(scope && 'facilityId' in scope ? scope.facilityId : 'x').toBeNull();
    expect(scope && 'sectorRole' in scope ? scope.sectorRole : null).toBe('unclassified');
  });
});

describe('classifyWarehouseSectorRole — structure only, never names', () => {
  const base = {
    organizationKind: 'care_institution',
    institutionClass: 'health_sector',
    warehouseKind: 'institution',
    facilityId: null,
    isMain: true,
  };

  it('sector main requires ALL of: health sector + institution kind + main + no facility', () => {
    expect(classifyWarehouseSectorRole(base)).toBe('sector_main');
    expect(classifyWarehouseSectorRole({ ...base, institutionClass: 'hospital' })).toBe('unclassified');
    expect(classifyWarehouseSectorRole({ ...base, organizationKind: 'pharmacy_department_authority' })).toBe('unclassified');
    expect(classifyWarehouseSectorRole({ ...base, warehouseKind: 'central' })).toBe('unclassified');
    expect(classifyWarehouseSectorRole({ ...base, isMain: false })).toBe('unclassified');
  });

  it('a facility binding makes it a health centre regardless of organization class', () => {
    expect(classifyWarehouseSectorRole({ ...base, facilityId: 'fac-1' })).toBe('health_center');
    expect(classifyWarehouseSectorRole({ ...base, facilityId: 'fac-1', institutionClass: 'hospital' })).toBe('health_center');
  });

  it('missing inputs never produce a positive claim', () => {
    expect(classifyWarehouseSectorRole({
      organizationKind: null, institutionClass: null,
      warehouseKind: null, facilityId: null, isMain: null,
    })).toBe('unclassified');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U1 — eligibility carries an explicit reason
// ═════════════════════════════════════════════════════════════════════════════
describe('U1 — eligibility always explains a refusal', () => {
  it('an expired lot is not selectable and says why', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow({ expiry_date: '2000-01-01' })],
      warehouses: [warehouseRow()],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    const e = rows.find(r => r.source === 'stock')?.canonical.eligibility;
    expect(e?.expired).toBe(true);
    expect(e?.selectable).toBe(false);
    expect(e?.blockedReasonKey).toBe('mv_e_expired_not_dispatchable');
  });

  it('a zero-available lot is not selectable and says why', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [stockRow({ available_quantity: 0 })],
      warehouses: [warehouseRow()],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    const e = rows.find(r => r.source === 'stock')?.canonical.eligibility;
    expect(e?.selectable).toBe(false);
    expect(e?.blockedReasonKey).toBe('mv_e_quantity_exceeds_available');
  });

  it('every non-selectable result carries a reason key', async () => {
    const rows = await withClient({
      central_items: [catalogRow({ status: 'inactive' })],
      warehouse_stock: [stockRow({ available_quantity: 0 }), stockRow({ id: 's2', expiry_date: '2000-01-01' })],
      warehouses: [warehouseRow()],
    }, () => resolveMaterials('amoxicillin', { warehouseId: 'wh1' }));

    for (const row of rows.filter(r => r.source === 'stock' && !r.canonical.eligibility.selectable)) {
      expect(row.canonical.eligibility.blockedReasonKey).toBeTruthy();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U1 — no new authorization filter was introduced
// ═════════════════════════════════════════════════════════════════════════════
describe('U1/U5 — the client added no authorization filter', () => {
  it('the stock query still scopes ONLY by warehouse_id, as before G3.2', async () => {
    const calls = await withClient({
      central_items: [], warehouse_stock: [], warehouses: [],
    }, (c) => resolveMaterials('amox', { warehouseId: 'wh1' }).then(() => c));

    const stock = calls.find(c => c.table === 'warehouse_stock');
    // RLS / M182 / M187 remain the authority. A new client-side eq() here would
    // be a client pretending to be a security boundary.
    expect(stock?.eqCols).toEqual(['warehouse_id']);
  });

  it('the public audience still never reaches lot-level stock or warehouse structure', async () => {
    const calls = await withClient({
      central_items: [], warehouse_stock: [], warehouses: [],
    }, (c) => resolveMaterials('amox', { warehouseId: 'wh1', audience: 'public' }).then(() => c));

    expect(calls.some(c => c.table === 'warehouse_stock')).toBe(false);
    expect(calls.some(c => c.table === 'warehouses')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// U4 support — the grouping primitive itself
// ═════════════════════════════════════════════════════════════════════════════
describe('materialGroupingKey — canonical identity or isolation, never a name', () => {
  it('uses the database key when present', () => {
    const key = materialGroupingKey({ materialIdentityKey: 'material:v1|x', sourceRowId: 'row1' });
    expect(key).toBe('identity:material:v1|x');
    expect(isIsolatedGroupingKey(key as string)).toBe(false);
  });

  it('FAIL-SAFE — a missing key isolates the row by its own id', () => {
    const key = materialGroupingKey({ materialIdentityKey: null, sourceRowId: 'row1' });
    expect(key).toBe('isolated-row:row1');
    expect(isIsolatedGroupingKey(key as string)).toBe(true);
  });

  it('FAIL-SAFE — a blank key is treated as missing, not as a shared empty key', () => {
    const a = materialGroupingKey({ materialIdentityKey: '  ', sourceRowId: 'rowA' });
    const b = materialGroupingKey({ materialIdentityKey: '', sourceRowId: 'rowB' });
    expect(a).not.toBe(b);
  });

  it('two rows with identical NAMES but different keys never share a group key', () => {
    const a = materialGroupingKey({ materialIdentityKey: 'material:v1|a', sourceRowId: 'r1' });
    const b = materialGroupingKey({ materialIdentityKey: 'material:v1|b', sourceRowId: 'r2' });
    expect(a).not.toBe(b);
  });

  it('returns null when the row can be placed by neither key nor id', () => {
    expect(materialGroupingKey({ materialIdentityKey: null, sourceRowId: null })).toBeNull();
  });
});
