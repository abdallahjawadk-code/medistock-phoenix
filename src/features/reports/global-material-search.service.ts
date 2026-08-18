/**
 * GLOBAL MATERIAL SEARCH — super_admin cross-organization stock lookup.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * G3.2 — WHAT CHANGED, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A. AGGREGATION WAS BY NAME. IT IS NOW BY CANONICAL IDENTITY.
 *    The group key used to be
 *      org | scopeKind | scopeId | lower(scientific_name) | lower(national_code)
 *    which is a DISPLAY LABEL pretending to be identity. Two genuinely
 *    different materials sharing a scientific name and lacking a national code
 *    were summed into one total; and because that lower-casing was not the
 *    project's bilingual normalizer, one material written with different Arabic
 *    hamza seats split into two groups. The error ran in both directions and
 *    was invisible in the export.
 *
 *    Grouping is now Migration 150's GENERATED `material_identity_key`, read
 *    from the row and never recomputed. A row without that key is ISOLATED
 *    under its own source-row id — never merged by name. See
 *    `materialGroupingKey` in search-contract.ts for why isolation is the safe
 *    direction: a material appearing twice is visible and correctable, whereas
 *    two materials silently summed is neither.
 *
 * B. AN ALERT IS NEVER A SECOND COPY OF THE STOCK IT DESCRIBES.
 *    Two things were wrong here, and they are corrected together.
 *
 *    B1 — THE SCHEMA. This file used to assert that `inventory_alerts` holds
 *    no structural material identifier, and concluded that every alert must
 *    therefore stand alone. Migration 150 had already added `central_item_id`,
 *    `source_stock_id`, `material_identity_version`, `material_identity_key`
 *    and `material_identity_state` to that table. A 'resolved' alert carries
 *    the SAME generated key as the stock it was computed from, so structural
 *    scope plus that key genuinely proves the association — no label is
 *    consulted. A 'legacy_unresolved' alert proves nothing and is still
 *    isolated under its own row id, with no name fallback in either direction.
 *    See `alertCanonicalIdentityKey` in search-contract.ts.
 *
 *    B2 — THE TOTALS, which is the defect that reached operators. Isolating
 *    an alert did not merely add a row: the alert-only group then adopted the
 *    alert's `observed_on_hand` as its balance. That snapshot is not
 *    independent inventory. 150 computes it FROM the very rows this report
 *    already counts — the quantity signals read `sum(on_hand_quantity)` over
 *    the scope's material, and the expiry signals read one lot's
 *    `on_hand_quantity`. So a warehouse holding 100 units, with one alert about
 *    those 100 units, reported 200: in the panel tiles, in the table, and in
 *    the workbook's Institution Summary. Alert quantities now feed no total
 *    anywhere. Every figure in this result comes from `warehouse_stock` /
 *    `outlet_stock` and nowhere else; an alert contributes its SIGNAL, and the
 *    fact that it exists, and nothing more.
 *
 * C. RESULTS NOW CARRY STRUCTURAL FACILITY CONTEXT.
 *    A row said "warehouse X" and nothing about which health centre X belonged
 *    to. Rows now carry `facilityId` and a classified `sectorRole`, both
 *    derived from `warehouses.facility_id` + organization class — never from a
 *    name, and never from `facility_id IS NULL` alone (DECISION D).
 *
 * D. TRUNCATION IS NO LONGER SILENT.
 *    Every per-field query is capped at PER_FIELD_LIMIT. When a cap is reached
 *    the underlying data is incomplete and the aggregate totals are therefore
 *    lower bounds — previously presented as if they were the whole picture.
 *    The result now reports `sourceTruncated` so the UI can say so.
 *
 * WHAT DID NOT CHANGE: this is still an explicit, user-triggered read. It never
 * writes, never polls, never scans without a term, and RLS remains
 * authoritative for every table. Aggregation stays in the read layer — no
 * table, no cache, no projection, no third stock truth. Moving it server-side
 * is G4, not this.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { normalizeSearchText } from '@/shared/lib/search-normalize';
import {
  alertCanonicalIdentityKey,
  classifyWarehouseSectorRole,
  isIsolatedGroupingKey,
  materialGroupingKey,
  type WarehouseSectorRole,
} from '@/shared/materials/search-contract';

export type GlobalMaterialScope = 'all' | 'warehouse' | 'outlet';
export type GlobalMaterialSignal = 'missing' | 'low_stock' | 'surplus' | 'near_expiry' | 'expired';

export interface GlobalMaterialSearchInput {
  term: string;
  organizationIds: string[];
  scope: GlobalMaterialScope;
  maxRows?: number;
}

export interface GlobalMaterialSearchRow {
  key: string;
  organizationId: string;
  organizationName: string;
  organizationNameAr: string;
  scopeKind: Exclude<GlobalMaterialScope, 'all'>;
  scopeId: string;
  scopeName: string;
  scopeNameAr: string;
  /**
   * G3.2 — the health-centre facility this stock physically sits under, or null
   * when the resource has no facility association. NEVER read `null` as
   * "sector main"; consult `sectorRole`, which is decided structurally.
   */
  facilityId: string | null;
  /** Structural role of the owning warehouse. See classifyWarehouseSectorRole. */
  sectorRole: WarehouseSectorRole;
  /**
   * Migration 150's canonical material identity for this group, or null when
   * the group is an isolated row / alert-only row that had none.
   */
  materialIdentityKey: string | null;
  /**
   * True when this row could NOT be grouped canonically and therefore stands
   * alone. Surfaced so an operator understands why a familiar material appears
   * unaggregated instead of assuming the report is broken.
   */
  isolated: boolean;
  /**
   * True when at least one real `warehouse_stock` / `outlet_stock` row landed in
   * this group. FALSE means the row exists only because an alert mentioned this
   * material and no readable stock row backed it, in which case every quantity
   * below is 0 — an honest "nothing readable here", never the alert's observed
   * snapshot dressed up as a balance.
   */
  stockBacked: boolean;
  /**
   * How many `inventory_alerts` rows contributed to this group. Alert METADATA:
   * it exists so a resolved alert stays discoverable once it stops being a row
   * of its own, and it is deliberately a COUNT rather than an observed quantity,
   * so that no consumer can sum it into a stock total.
   */
  alertCount: number;
  scientificName: string;
  tradeNames: string[];
  concentration: string[];
  dosageForm: string[];
  unit: string[];
  nationalCode: string | null;
  onHand: number;
  reserved: number;
  available: number;
  batchCount: number;
  nearestExpiry: string | null;
  expiredAvailable: number;
  nearExpiryAvailable: number;
  signals: GlobalMaterialSignal[];
}

export interface GlobalMaterialSearchResult {
  rows: GlobalMaterialSearchRow[];
  totalRows: number;
  /** True when `rows` was cut to `maxRows` after aggregation. */
  truncated: boolean;
  /**
   * G3.2 — true when at least one SOURCE query hit its per-field cap, so the
   * underlying data set is incomplete and every total here is a lower bound.
   * Distinct from `truncated`, which is only about the displayed slice.
   */
  sourceTruncated: boolean;
  searchedAt: string;
}

interface StockRow {
  id: string;
  organization_id: string;
  warehouse_id?: string;
  distribution_point_id?: string;
  scientific_name: string;
  trade_name: string | null;
  concentration: string | null;
  dosage_form: string | null;
  unit: string | null;
  national_code: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  on_hand_quantity: number;
  reserved_quantity: number;
  available_quantity: number;
  /** 150 — GENERATED ALWAYS STORED. Read, never computed. */
  material_identity_key: string | null;
}

/**
 * An `inventory_alerts` row as this report reads it — Migration 150's real
 * shape, identity columns included.
 *
 * `observed_on_hand` / `observed_available` are typed here because they are part
 * of the row, NOT because anything totals them. They are a snapshot 150 copied
 * out of the stock tables at recompute time; see the G32-B01 note in the alert
 * loop for why treating them as a quantity source double-counts real medicine.
 */
interface AlertRow {
  id: string;
  organization_id: string;
  scope_kind: 'warehouse' | 'outlet';
  scope_id: string;
  scientific_name: string;
  national_code: string | null;
  signal_type: GlobalMaterialSignal;
  observed_on_hand: number | null;
  observed_available: number | null;
  /**
   * 150 — the catalog identity. Read as CONTEXT only: it comes from
   * `max(central_item_id)` over the aggregated stock rows, so it is legitimately
   * null for a fully-resolved alert whose stock predates the catalog linkage.
   * It can therefore never be a test of whether identity was proved.
   */
  central_item_id: string | null;
  /**
   * 150 — the EXACT stock row this alert was computed from. Populated for the
   * per-lot expiry signals; the scope-level quantity signals aggregate several
   * rows and legitimately leave it null.
   */
  source_stock_id: string | null;
  /** 150 — the canonical material key, or null when nothing was proved. */
  material_identity_key: string | null;
  /** 150 — 1 alongside a key, null alongside none; the CHECK ties them. */
  material_identity_version: number | null;
  /** 150 — 'resolved' | 'legacy_unresolved'. */
  material_identity_state: string | null;
}

interface NamedRow {
  id: string;
  name: string;
  name_ar: string;
}

/** A warehouse's structural row: facility binding + the shape 181 judges. */
interface WarehouseRow extends NamedRow {
  organization_id: string | null;
  facility_id: string | null;
  warehouse_kind: string | null;
  is_main: boolean | null;
}

/** An outlet's structural row: its parent warehouse, which owns the facility. */
interface OutletRow extends NamedRow {
  warehouse_id: string | null;
}

interface OrganizationRow extends NamedRow {
  organization_kind: string | null;
  institution_class: string | null;
}

interface MutableGroup {
  key: string;
  organizationId: string;
  scopeKind: 'warehouse' | 'outlet';
  scopeId: string;
  materialIdentityKey: string | null;
  isolated: boolean;
  scientificName: string;
  nationalCode: string | null;
  hasStock: boolean;
  alertCount: number;
  onHand: number;
  reserved: number;
  available: number;
  batches: Set<string>;
  tradeNames: Set<string>;
  concentration: Set<string>;
  dosageForm: Set<string>;
  unit: Set<string>;
  nearestExpiry: string | null;
  expiredAvailable: number;
  nearExpiryAvailable: number;
  signals: Set<GlobalMaterialSignal>;
}

const STOCK_SELECT = [
  'id', 'organization_id', 'scientific_name', 'trade_name', 'concentration',
  'dosage_form', 'unit', 'national_code', 'batch_number', 'expiry_date',
  'on_hand_quantity', 'reserved_quantity', 'available_quantity',
  // G3.2 — the canonical identity this report now groups by.
  'material_identity_key',
].join(',');

const ALERT_SELECT = [
  'id', 'organization_id', 'scope_kind', 'scope_id', 'scientific_name',
  'national_code', 'signal_type', 'observed_on_hand', 'observed_available',
  // G3.2 — Migration 150's identity columns. Reading them is what lets a
  // RESOLVED alert be recognised as the same material as the stock it was
  // computed from, instead of being isolated into a duplicate row.
  'central_item_id', 'source_stock_id', 'material_identity_key',
  'material_identity_version', 'material_identity_state',
].join(',');

const PER_FIELD_LIMIT = 500;
const DEFAULT_RESULT_LIMIT = 1200;

/** One source query's rows plus whether that query hit its cap. */
interface CappedRows<T> {
  rows: T[];
  capped: boolean;
}

/** Escapes PostgreSQL ILIKE wildcards; the caller supplies the surrounding %. */
function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function nonBlank(target: Set<string>, value: string | null): void {
  const clean = value?.trim();
  if (clean) target.add(clean);
}

function earliest(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate < current ? candidate : current;
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map(row => [row.id, row])).values()];
}

async function searchStockTable(
  table: 'warehouse_stock' | 'outlet_stock',
  scopeColumn: 'warehouse_id' | 'distribution_point_id',
  organizationIds: string[],
  term: string,
): Promise<CappedRows<StockRow>> {
  const pattern = `%${escapeIlike(term)}%`;
  const fields = ['scientific_name', 'trade_name', 'national_code'] as const;
  const results = await Promise.all(fields.map(async field => {
    const { data, error } = await supabase
      .from(table)
      .select(`${STOCK_SELECT},${scopeColumn}`)
      .in('organization_id', organizationIds)
      .ilike(field, pattern)
      .limit(PER_FIELD_LIMIT);
    if (error) throw error;
    const rows = (data ?? []) as unknown as StockRow[];
    // A query that returned exactly its cap almost certainly had more to give.
    return { rows, capped: rows.length >= PER_FIELD_LIMIT };
  }));
  return {
    rows: dedupeById(results.flatMap(r => r.rows)),
    capped: results.some(r => r.capped),
  };
}

async function searchAlertRows(
  organizationIds: string[],
  term: string,
  scope: GlobalMaterialScope,
): Promise<CappedRows<AlertRow>> {
  const pattern = `%${escapeIlike(term)}%`;
  const fields = ['scientific_name', 'national_code'] as const;
  const results = await Promise.all(fields.map(async field => {
    let query = supabase
      .from('inventory_alerts')
      .select(ALERT_SELECT)
      .in('organization_id', organizationIds)
      .in('status', ['open', 'acknowledged', 'in_progress'])
      .ilike(field, pattern)
      .limit(PER_FIELD_LIMIT);
    if (scope !== 'all') query = query.eq('scope_kind', scope);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as unknown as AlertRow[];
    return { rows, capped: rows.length >= PER_FIELD_LIMIT };
  }));
  return {
    rows: dedupeById(results.flatMap(r => r.rows)),
    capped: results.some(r => r.capped),
  };
}

function emptyResult(): GlobalMaterialSearchResult {
  return {
    rows: [], totalRows: 0, truncated: false, sourceTruncated: false,
    searchedAt: new Date().toISOString(),
  };
}

/**
 * Explicit, user-triggered search only. It never writes, never polls, never
 * scans without a term, and caps every query/result set to protect the free
 * Supabase project. RLS remains authoritative for every table read.
 */
export async function searchGlobalMaterialStock(
  input: GlobalMaterialSearchInput,
): Promise<GlobalMaterialSearchResult> {
  if (!supabaseConfigured) return emptyResult();

  const term = input.term.trim();
  const organizationIds = [...new Set(input.organizationIds.filter(Boolean))];
  if (term.length < 2) throw new Error('search_term_too_short');
  if (organizationIds.length === 0) throw new Error('organization_required');
  if (organizationIds.length > 100) throw new Error('too_many_organizations');

  const stockPromises: Array<Promise<CappedRows<StockRow>>> = [];
  if (input.scope !== 'outlet') {
    stockPromises.push(searchStockTable('warehouse_stock', 'warehouse_id', organizationIds, term));
  }
  if (input.scope !== 'warehouse') {
    stockPromises.push(searchStockTable('outlet_stock', 'distribution_point_id', organizationIds, term));
  }

  const [organizationsResult, warehousesResult, outletsResult, alerts] = await Promise.all([
    // G3.2 — organization class is required to classify a sector role. Without
    // it a facility-less warehouse cannot be told apart from a sector main.
    supabase.from('organizations').select('id,name,name_ar,organization_kind,institution_class').in('id', organizationIds),
    supabase.from('warehouses').select('id,name,name_ar,organization_id,facility_id,warehouse_kind,is_main').in('organization_id', organizationIds),
    supabase.from('distribution_points').select('id,name,name_ar,warehouse_id').in('organization_id', organizationIds),
    searchAlertRows(organizationIds, term, input.scope),
  ]);
  const stockSets = await Promise.all(stockPromises);

  if (organizationsResult.error) throw organizationsResult.error;
  if (warehousesResult.error) throw warehousesResult.error;
  if (outletsResult.error) throw outletsResult.error;

  const organizations = new Map(
    ((organizationsResult.data ?? []) as unknown as OrganizationRow[]).map(row => [row.id, row]),
  );
  const warehouses = new Map(
    ((warehousesResult.data ?? []) as unknown as WarehouseRow[]).map(row => [row.id, row]),
  );
  const outlets = new Map(
    ((outletsResult.data ?? []) as unknown as OutletRow[]).map(row => [row.id, row]),
  );

  /**
   * Resolve a scope's structural facility context.
   *
   * A warehouse answers directly. An outlet answers through its PARENT
   * warehouse (`distribution_points.warehouse_id`) — the structural chain, not
   * a name. When the parent cannot be read the answer is an honest null plus
   * 'unclassified'; an unplaced outlet is reported as unplaced, exactly as
   * health-sector-grouping.ts reports it, never relocated to look tidy.
   */
  const resolveStructure = (
    scopeKind: 'warehouse' | 'outlet',
    scopeId: string,
  ): { facilityId: string | null; sectorRole: WarehouseSectorRole } => {
    const warehouse = scopeKind === 'warehouse'
      ? warehouses.get(scopeId)
      : (() => {
          const parentId = outlets.get(scopeId)?.warehouse_id;
          return parentId ? warehouses.get(parentId) : undefined;
        })();
    if (!warehouse) return { facilityId: null, sectorRole: 'unclassified' };

    const org = warehouse.organization_id ? organizations.get(warehouse.organization_id) : undefined;
    return {
      facilityId: warehouse.facility_id ?? null,
      // DECISION D — never from the null alone.
      sectorRole: classifyWarehouseSectorRole({
        organizationKind: org?.organization_kind ?? null,
        institutionClass: org?.institution_class ?? null,
        warehouseKind: warehouse.warehouse_kind,
        facilityId: warehouse.facility_id,
        isMain: warehouse.is_main,
      }),
    };
  };

  const groups = new Map<string, MutableGroup>();

  /**
   * Find or create the group for one row.
   *
   * `identityPart` is what makes two rows THE SAME MATERIAL. It comes from
   * `materialGroupingKey`, i.e. the database's generated key, or an isolated
   * per-row key when there is none. It is never derived from a name.
   */
  const ensure = (params: {
    identityPart: string;
    organizationId: string;
    scopeKind: 'warehouse' | 'outlet';
    scopeId: string;
    materialIdentityKey: string | null;
    isolated: boolean;
    scientificName: string;
    nationalCode: string | null;
  }): MutableGroup => {
    const key = [
      params.organizationId, params.scopeKind, params.scopeId, params.identityPart,
    ].join('|');
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        organizationId: params.organizationId,
        scopeKind: params.scopeKind,
        scopeId: params.scopeId,
        materialIdentityKey: params.materialIdentityKey,
        isolated: params.isolated,
        scientificName: params.scientificName.trim(),
        nationalCode: params.nationalCode?.trim() || null,
        hasStock: false,
        alertCount: 0,
        onHand: 0,
        reserved: 0,
        available: 0,
        batches: new Set(),
        tradeNames: new Set(),
        concentration: new Set(),
        dosageForm: new Set(),
        unit: new Set(),
        nearestExpiry: null,
        expiredAvailable: 0,
        nearExpiryAvailable: 0,
        signals: new Set(),
      };
      groups.set(key, group);
    }
    return group;
  };

  const today = new Date().toISOString().slice(0, 10);
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() + 270);
  const nearExpiryCutoff = cutoffDate.toISOString().slice(0, 10);

  const allStock = stockSets.flatMap(set => set.rows);
  for (const stock of allStock) {
    const scopeKind = stock.warehouse_id ? 'warehouse' : 'outlet';
    const scopeId = stock.warehouse_id ?? stock.distribution_point_id;
    if (!scopeId) continue;

    // DECISION C — canonical identity, or isolation. Never a name fallback.
    const identityPart = materialGroupingKey({
      materialIdentityKey: stock.material_identity_key,
      sourceRowId: stock.id,
    });
    // materialGroupingKey only returns null when the row has neither a key nor
    // an id. Such a row cannot be placed at all and is dropped rather than
    // merged into anything.
    if (!identityPart) continue;

    const group = ensure({
      identityPart,
      organizationId: stock.organization_id,
      scopeKind,
      scopeId,
      materialIdentityKey: stock.material_identity_key ?? null,
      isolated: isIsolatedGroupingKey(identityPart),
      scientificName: stock.scientific_name,
      nationalCode: stock.national_code,
    });
    group.hasStock = true;
    group.onHand += stock.on_hand_quantity;
    group.reserved += stock.reserved_quantity;
    group.available += stock.available_quantity;
    group.batches.add(`${stock.batch_number ?? 'NO_BATCH'}|${stock.expiry_date ?? 'NO_EXPIRY'}`);
    nonBlank(group.tradeNames, stock.trade_name);
    nonBlank(group.concentration, stock.concentration);
    nonBlank(group.dosageForm, stock.dosage_form);
    nonBlank(group.unit, stock.unit);
    group.nearestExpiry = earliest(group.nearestExpiry, stock.expiry_date);

    if (stock.expiry_date && stock.expiry_date < today) {
      group.expiredAvailable += stock.available_quantity;
      group.signals.add('expired');
    } else if (stock.expiry_date && stock.expiry_date <= nearExpiryCutoff) {
      group.nearExpiryAvailable += stock.available_quantity;
      group.signals.add('near_expiry');
    }
  }

  /**
   * Stock-row id → the LIVE generated identity on that row.
   *
   * Migration 150 records in `inventory_alerts.source_stock_id` the exact stock
   * row a per-lot expiry alert was computed from. When that row is in this
   * result set, its own GENERATED column is the newer truth — the alert holds a
   * copy written at recompute time — so any drift between the two resolves
   * toward the table. Without this, a stale copy would open a second group for
   * a material whose stock is right there, which is the very duplication this
   * correction removes. The scope-level quantity signals aggregate several rows
   * and leave `source_stock_id` null; they fall back to the alert's own key.
   */
  const identityByStockRowId = new Map<string, string>();
  for (const stock of allStock) {
    if (stock.material_identity_key) {
      identityByStockRowId.set(stock.id, stock.material_identity_key);
    }
  }

  for (const alert of alerts.rows) {
    // CORRECTED DECISION C. A 'resolved' alert carries Migration 150's canonical
    // `material_identity_key` — the same generated value the stock rows carry —
    // so the alert's own structural scope plus that key IS proof of which
    // material it concerns, and it joins that material's group. A
    // 'legacy_unresolved' alert proves nothing and stays isolated under its own
    // row id. Neither branch ever consults a name, a national code or any other
    // display label to decide identity.
    const canonicalKey = alertCanonicalIdentityKey({
      materialIdentityState: alert.material_identity_state,
      materialIdentityKey: alert.material_identity_key,
      materialIdentityVersion: alert.material_identity_version,
    });
    const correlatedKey = alert.source_stock_id
      ? identityByStockRowId.get(alert.source_stock_id) ?? null
      : null;
    // The correlation may only REFINE an identity the alert already proved. An
    // unresolved alert stays unresolved even when it names a stock row: rescuing
    // it here would be a structural fallback standing in for the name fallback,
    // merging on a link Migration 150 itself declined to certify.
    const identityKey = canonicalKey ? (correlatedKey ?? canonicalKey) : null;

    const identityPart = materialGroupingKey({
      materialIdentityKey: identityKey,
      sourceRowId: alert.id,
    });
    if (!identityPart) continue;

    const group = ensure({
      identityPart,
      organizationId: alert.organization_id,
      scopeKind: alert.scope_kind,
      scopeId: alert.scope_id,
      materialIdentityKey: identityKey,
      isolated: isIsolatedGroupingKey(identityPart),
      scientificName: alert.scientific_name,
      nationalCode: alert.national_code,
    });
    group.signals.add(alert.signal_type);
    group.alertCount += 1;

    // G32-B01 — AND THE ALERT CONTRIBUTES NOTHING ELSE. NO QUANTITY. EVER.
    //
    // `observed_on_hand` / `observed_available` are not a balance this report
    // may add or assign. They are a snapshot Migration 150 COPIED OUT OF the
    // very tables already counted above: `phoenix_recompute_inventory_alerts`
    // takes `sum(on_hand_quantity)` over the scope's material for the quantity
    // signals, and one lot's `on_hand_quantity` for the expiry signals. Adding
    // them, or assigning them to an alert-only group, states the same physical
    // medicine twice — and it did, everywhere the operator looks: the panel
    // tiles, the results table, and the workbook's Institution Summary.
    //
    // There are exactly two ordinary stock truths, `warehouse_stock` and
    // `outlet_stock`. `inventory_alerts` is a signal table, not a third one.
    //
    // An alert whose stock row is absent from this result set therefore leaves
    // the group at ZERO rather than filling it from the snapshot. That is the
    // fail-closed direction: the alert stays visible and discoverable, and the
    // operator reads "there is a signal here and no readable stock", which is
    // true, instead of a balance no table would confirm.
  }

  const signalRank: Record<GlobalMaterialSignal, number> = {
    expired: 0,
    missing: 1,
    low_stock: 2,
    near_expiry: 3,
    surplus: 4,
  };

  const rows = [...groups.values()].map<GlobalMaterialSearchRow>(group => {
    const org = organizations.get(group.organizationId);
    const scope = group.scopeKind === 'warehouse'
      ? warehouses.get(group.scopeId)
      : outlets.get(group.scopeId);
    const structure = resolveStructure(group.scopeKind, group.scopeId);
    return {
      key: group.key,
      organizationId: group.organizationId,
      organizationName: org?.name ?? '—',
      organizationNameAr: org?.name_ar ?? org?.name ?? '—',
      scopeKind: group.scopeKind,
      scopeId: group.scopeId,
      scopeName: scope?.name ?? '—',
      scopeNameAr: scope?.name_ar ?? scope?.name ?? '—',
      facilityId: structure.facilityId,
      sectorRole: structure.sectorRole,
      materialIdentityKey: group.materialIdentityKey,
      isolated: group.isolated,
      stockBacked: group.hasStock,
      alertCount: group.alertCount,
      scientificName: group.scientificName,
      tradeNames: [...group.tradeNames].sort(),
      concentration: [...group.concentration].sort(),
      dosageForm: [...group.dosageForm].sort(),
      unit: [...group.unit].sort(),
      nationalCode: group.nationalCode,
      onHand: group.onHand,
      reserved: group.reserved,
      available: group.available,
      batchCount: group.batches.size,
      nearestExpiry: group.nearestExpiry,
      expiredAvailable: group.expiredAvailable,
      nearExpiryAvailable: group.nearExpiryAvailable,
      signals: [...group.signals].sort((a, b) => signalRank[a] - signalRank[b]),
    };
  }).sort((a, b) =>
    // G3.2 — ordering is presentation, so it stays name-based; it decides where
    // a row appears, never which rows are the same material.
    normalizeSearchText(a.scientificName).localeCompare(normalizeSearchText(b.scientificName))
    || a.organizationName.localeCompare(b.organizationName)
    || a.scopeName.localeCompare(b.scopeName),
  );

  const maxRows = Math.min(Math.max(input.maxRows ?? DEFAULT_RESULT_LIMIT, 1), 2000);
  return {
    rows: rows.slice(0, maxRows),
    totalRows: rows.length,
    truncated: rows.length > maxRows,
    sourceTruncated: alerts.capped || stockSets.some(set => set.capped),
    searchedAt: new Date().toISOString(),
  };
}
