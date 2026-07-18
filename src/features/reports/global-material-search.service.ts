import { supabase, supabaseConfigured } from '@/shared/supabase/client';

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
  truncated: boolean;
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
}

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
}

interface NamedRow {
  id: string;
  name: string;
  name_ar: string;
}

interface MutableGroup {
  key: string;
  organizationId: string;
  scopeKind: 'warehouse' | 'outlet';
  scopeId: string;
  scientificName: string;
  nationalCode: string | null;
  hasStock: boolean;
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
].join(',');

const ALERT_SELECT = [
  'id', 'organization_id', 'scope_kind', 'scope_id', 'scientific_name',
  'national_code', 'signal_type', 'observed_on_hand', 'observed_available',
].join(',');

const PER_FIELD_LIMIT = 500;
const DEFAULT_RESULT_LIMIT = 1200;

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function groupKey(
  organizationId: string,
  scopeKind: 'warehouse' | 'outlet',
  scopeId: string,
  scientificName: string,
  nationalCode: string | null,
): string {
  return [
    organizationId,
    scopeKind,
    scopeId,
    normalized(scientificName),
    normalized(nationalCode),
  ].join('|');
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
): Promise<StockRow[]> {
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
    return (data ?? []) as unknown as StockRow[];
  }));
  return dedupeById(results.flat());
}

async function searchAlertRows(
  organizationIds: string[],
  term: string,
  scope: GlobalMaterialScope,
): Promise<AlertRow[]> {
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
    return (data ?? []) as unknown as AlertRow[];
  }));
  return dedupeById(results.flat());
}

function emptyResult(): GlobalMaterialSearchResult {
  return { rows: [], totalRows: 0, truncated: false, searchedAt: new Date().toISOString() };
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

  const stockPromises: Array<Promise<StockRow[]>> = [];
  if (input.scope !== 'outlet') {
    stockPromises.push(searchStockTable('warehouse_stock', 'warehouse_id', organizationIds, term));
  }
  if (input.scope !== 'warehouse') {
    stockPromises.push(searchStockTable('outlet_stock', 'distribution_point_id', organizationIds, term));
  }

  const [organizationsResult, warehousesResult, outletsResult, alerts] = await Promise.all([
    supabase.from('organizations').select('id,name,name_ar').in('id', organizationIds),
    supabase.from('warehouses').select('id,name,name_ar').in('organization_id', organizationIds),
    supabase.from('distribution_points').select('id,name,name_ar').in('organization_id', organizationIds),
    searchAlertRows(organizationIds, term, input.scope),
  ]);
  const stockSets = await Promise.all(stockPromises);

  if (organizationsResult.error) throw organizationsResult.error;
  if (warehousesResult.error) throw warehousesResult.error;
  if (outletsResult.error) throw outletsResult.error;

  const organizations = new Map(
    ((organizationsResult.data ?? []) as NamedRow[]).map(row => [row.id, row]),
  );
  const warehouses = new Map(
    ((warehousesResult.data ?? []) as NamedRow[]).map(row => [row.id, row]),
  );
  const outlets = new Map(
    ((outletsResult.data ?? []) as NamedRow[]).map(row => [row.id, row]),
  );

  const groups = new Map<string, MutableGroup>();
  const ensure = (
    organizationId: string,
    scopeKind: 'warehouse' | 'outlet',
    scopeId: string,
    scientificName: string,
    nationalCode: string | null,
  ): MutableGroup => {
    const key = groupKey(organizationId, scopeKind, scopeId, scientificName, nationalCode);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        organizationId,
        scopeKind,
        scopeId,
        scientificName: scientificName.trim(),
        nationalCode: nationalCode?.trim() || null,
        hasStock: false,
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

  const allStock = stockSets.flat() as StockRow[];
  for (const stock of allStock) {
    const scopeKind = stock.warehouse_id ? 'warehouse' : 'outlet';
    const scopeId = stock.warehouse_id ?? stock.distribution_point_id;
    if (!scopeId) continue;

    const group = ensure(
      stock.organization_id,
      scopeKind,
      scopeId,
      stock.scientific_name,
      stock.national_code,
    );
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

  for (const alert of alerts) {
    const group = ensure(
      alert.organization_id,
      alert.scope_kind,
      alert.scope_id,
      alert.scientific_name,
      alert.national_code,
    );
    group.signals.add(alert.signal_type);
    // Alert-only rows represent expected-but-zero or otherwise signalled stock.
    // Do not add the same observed snapshot repeatedly when several alert types
    // point to one material/location aggregate.
    if (!group.hasStock) {
      group.onHand = alert.observed_on_hand ?? 0;
      group.available = alert.observed_available ?? 0;
      group.reserved = Math.max(0, group.onHand - group.available);
    }
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
    return {
      key: group.key,
      organizationId: group.organizationId,
      organizationName: org?.name ?? '—',
      organizationNameAr: org?.name_ar ?? org?.name ?? '—',
      scopeKind: group.scopeKind,
      scopeId: group.scopeId,
      scopeName: scope?.name ?? '—',
      scopeNameAr: scope?.name_ar ?? scope?.name ?? '—',
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
    a.scientificName.localeCompare(b.scientificName)
    || a.organizationName.localeCompare(b.organizationName)
    || a.scopeName.localeCompare(b.scopeName),
  );

  const maxRows = Math.min(Math.max(input.maxRows ?? DEFAULT_RESULT_LIMIT, 1), 2000);
  return {
    rows: rows.slice(0, maxRows),
    totalRows: rows.length,
    truncated: rows.length > maxRows,
    searchedAt: new Date().toISOString(),
  };
}
