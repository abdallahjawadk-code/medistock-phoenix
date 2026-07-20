import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { formatStableDate } from '@/shared/lib/date';
import { getExpiryRiskTier, getExpiryRiskLabel } from '@/shared/lib/expiry-risk';
import {
  exportOutletReportXlsx,
  triggerProfessionalPrint,
  type OutletReportRow,
  type ProfessionalReportColumn,
} from '@/shared/lib/professional-export';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { ExpiryRiskBadge } from '@/shared/ui/ExpiryRiskBadge';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal';
import type { LiveAvailRow } from './StatusCenterScreen';

/**
 * PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A
 *
 * Read-only outlet availability report modal, opened by selecting an outlet
 * from Status Center's "عرض حسب المنفذ" dropdown. NOT a medical/drug-
 * knowledge card — never doses, mechanisms, warnings, or clinical text, only
 * inventory/availability data already present in the system. Never mutates
 * data, never calls a write RPC.
 *
 * `rows` is the SAME already-filtered set StatusCenterScreen's main table/
 * outlet-grouped view render (no new fetch) — this component narrows it to
 * the selected outlet, then applies its OWN independent filters (search/
 * condition/supply/quantity/price/expiry/removed), combined with AND logic.
 * Those modal-only filters never affect Status Center's own filters/state.
 *
 * `CanonicalStatus`/`CondKey`/`SUPPLY_CATEGORIES`-equivalents and the small
 * `effOf`/`priceDisplay`/`parsePriceInput` helpers are intentionally
 * duplicated (not imported as values) from StatusCenterScreen.tsx — that
 * file imports this component, so importing a value binding back would
 * create a circular module dependency. Only `type LiveAvailRow` is imported,
 * which is erased at compile time and has no such problem.
 */

type CanonicalCondition = 'available' | 'low_stock' | 'missing' | 'surplus' | 'near_expiry' | 'expired';

const CANONICAL_CONDITIONS: CanonicalCondition[] = ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired'];

const CONDITION_VARIANT: Record<CanonicalCondition, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

/** Bilingual condition labels for the XLSX/print export — fixed regardless of the viewer's current app language, matching the main Status Center export's own convention. */
const EXPORT_CONDITION_LABELS: Record<CanonicalCondition, string> = {
  available:   'Available / متوفر',
  low_stock:   'Low Stock / منخفض',
  missing:     'Missing / مفقود',
  surplus:     'Surplus / فائض',
  near_expiry: 'Near Expiry / قريب الانتهاء',
  expired:     'Expired / منتهي الصلاحية',
};

type SupplyCategory = 'purchases' | 'kimadia' | 'donations' | 'aid';
const SUPPLY_CATEGORIES: { value: SupplyCategory; labelKey: string }[] = [
  { value: 'purchases', labelKey: 'sc_supply_purchases' },
  { value: 'kimadia',   labelKey: 'sc_supply_kimadia' },
  { value: 'donations', labelKey: 'sc_supply_donations' },
  { value: 'aid',       labelKey: 'sc_supply_aid' },
];

function normalizeSupplyType(v?: string | null): SupplyCategory | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('kimadia') || s.includes('كيماديا') || s.includes('كماديا')) return 'kimadia';
  if (s.includes('purchase') || s.includes('مشتر') || s.includes('شراء')) return 'purchases';
  if (s.includes('donation') || s.includes('هب') || s.includes('تبرع') || s.includes('منح')) return 'donations';
  if (s.includes('aid') || s.includes('مساعد') || s.includes('إغاث') || s.includes('اغاث')) return 'aid';
  return null;
}

function effOf(r: LiveAvailRow): CanonicalCondition {
  return (r.effective_status ?? (r.condition as CanonicalCondition | null) ?? 'available');
}

const DASH = '—';

function priceDisplay(price: number | null | undefined): string {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return DASH;
  return price.toFixed(2);
}

/** Parses a free-text numeric input into a validated, non-negative number, or null when empty/non-numeric/negative — never throws. Same contract as StatusCenterScreen's own parsePriceInput (duplicated to avoid a circular import). */
function parsePriceInput(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Whole days from now until expiryDate (negative if already past) — null when unparseable/missing. */
function daysUntilExpiry(expiryDate: string | null | undefined): number | null {
  if (!expiryDate) return null;
  const d = new Date(expiryDate);
  if (isNaN(d.getTime())) return null;
  const dateOnly = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  return Math.round((dateOnly(d).getTime() - dateOnly(new Date()).getTime()) / 86_400_000);
}

/**
 * PHASE2-EXPORT-FIELD-SELECTOR-A
 *
 * Field (column) selector for this modal's Excel export and print/PDF —
 * controls WHICH COLUMNS appear in the output, never which rows (row
 * filtering above is completely untouched and independent). Exactly the 16
 * non-sensitive fields listed below are selectable; nothing ID/UUID/
 * removed_by/actor_id/entity_id/token/payload-shaped is ever offered here.
 *
 * `key` doubles as: (a) the printColumns entry key below, and (b)
 * (via FIELD_TO_EXCEL_COLUMN_KEY) the OUTLET_REPORT_COLUMNS key in
 * professional-export.ts, so one selection applies identically to both
 * Excel and print — never two separate selection states.
 */
interface FieldDefinition {
  key: string;
  labelKey: string;
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  { key: 'institution', labelKey: 'avail_inst_label' },
  { key: 'outlet', labelKey: 'avail_details_outlet_label' },
  { key: 'scientificName', labelKey: 'avail_scientific_name' },
  { key: 'tradeName', labelKey: 'avail_trade_name' },
  { key: 'dosageForm', labelKey: 'avail_dosage_form' },
  { key: 'concentration', labelKey: 'avail_concentration' },
  { key: 'quantity', labelKey: 'qty' },
  { key: 'condition', labelKey: 'avail_condition' },
  { key: 'enteredPrice', labelKey: 'sc_entered_price' },
  { key: 'supplyType', labelKey: 'avail_supply_type' },
  { key: 'batchNumber', labelKey: 'batch_no' },
  { key: 'expiryDate', labelKey: 'expiry' },
  { key: 'daysToExpiry', labelKey: 'avail_details_days_to_expiry' },
  { key: 'notes', labelKey: 'sc_notes' },
  { key: 'lastUpdated', labelKey: 'last_upd' },
  { key: 'removedStatus', labelKey: 'sc_removed_badge' },
];

const DEFAULT_SELECTED_FIELD_KEYS = FIELD_DEFINITIONS.map(f => f.key);

/** Maps the 16 selectable field keys above to their OUTLET_REPORT_COLUMNS key in professional-export.ts (identical for 14 of them; only lastUpdated/removedStatus differ from their Excel column key names). */
const FIELD_TO_EXCEL_COLUMN_KEY: Record<string, string> = {
  institution: 'institution', outlet: 'outlet', scientificName: 'scientificName', tradeName: 'tradeName',
  dosageForm: 'dosageForm', concentration: 'concentration', quantity: 'quantity', condition: 'condition',
  enteredPrice: 'enteredPrice', supplyType: 'supplyType', batchNumber: 'batchNumber', expiryDate: 'expiryDate',
  daysToExpiry: 'daysToExpiry', notes: 'notes', lastUpdated: 'lastUpdatedAt', removedStatus: 'removed',
};

const FIELD_SELECTOR_STORAGE_KEY = 'phoenix_outlet_report_selected_fields';

/**
 * Reads the persisted field selection from localStorage, falling back
 * safely to the full default set whenever the value is missing, corrupt,
 * not valid JSON, not an array, empty, or contains no recognized field key
 * (localStorage unavailable — private mode/blocked — also falls back here).
 * Never throws.
 */
function loadSelectedFields(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FIELD_SELECTOR_STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_SELECTED_FIELD_KEYS);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_SELECTED_FIELD_KEYS);
    const validKeys = new Set(FIELD_DEFINITIONS.map(f => f.key));
    const restored = parsed.filter((k): k is string => typeof k === 'string' && validKeys.has(k));
    return restored.length > 0 ? new Set(restored) : new Set(DEFAULT_SELECTED_FIELD_KEYS);
  } catch {
    return new Set(DEFAULT_SELECTED_FIELD_KEYS);
  }
}

/** Persists the current field selection — never throws (localStorage unavailable/blocked is simply a non-fatal no-op, matching usePwaInstallPrompt.ts's established pattern). */
function saveSelectedFields(keys: Set<string>): void {
  try {
    window.localStorage.setItem(FIELD_SELECTOR_STORAGE_KEY, JSON.stringify(Array.from(keys)));
  } catch {
    /* non-fatal — selection simply won't persist across reloads */
  }
}

type QuantityFilter = 'all' | 'has_quantity' | 'zero_quantity';
type PriceFilterMode =
  | 'all'
  | 'no_entered_price'
  | 'has_entered_price'
  | 'entered_price_less_than'
  | 'entered_price_greater_than'
  | 'entered_price_between';
type ExpiryFilter = 'all' | 'near_expiry' | 'expired' | 'valid';
type RemovedFilter = 'all' | 'active' | 'removed';

const fieldStyle = {
  padding: '7px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)',
  background: 'var(--s)', color: 'var(--t)', fontSize: '12px',
} as const;

const summaryCardStyle = {
  padding: '8px 12px', borderRadius: 'var(--r2)', background: 'var(--s2)',
  border: '1px solid var(--brd)', minWidth: '110px', textAlign: 'center' as const,
};

interface Props {
  open: boolean;
  onClose: () => void;
  outletId: string | null;
  outletName: string;
  institutionName: string;
  lang: 'ar' | 'en';
  /** Already-filtered by Status Center's own main filters — this component narrows it further to `outletId` and its own modal-only filters. */
  rows: LiveAvailRow[];
}

export function OutletAvailabilityReportModal({ open, onClose, outletId, outletName, institutionName, lang, rows }: Props) {
  const [search, setSearch] = useState('');
  const [conditionFilter, setConditionFilter] = useState<CanonicalCondition | ''>('');
  const [supplyFilter, setSupplyFilter] = useState<SupplyCategory | ''>('');
  const [quantityFilter, setQuantityFilter] = useState<QuantityFilter>('all');
  const [priceFilterMode, setPriceFilterMode] = useState<PriceFilterMode>('all');
  const [priceValue, setPriceValue] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>('all');
  const [removedFilter, setRemovedFilter] = useState<RemovedFilter>('all');
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [mobilePrintHtml, setMobilePrintHtml] = useState<string | null>(null);

  // PHASE2-EXPORT-FIELD-SELECTOR-A: column (field) selection for Excel/print —
  // completely independent of the row filters above. Lazily initialized from
  // localStorage (falls back to "all 16 fields" — the pre-existing behavior —
  // on first load or any read failure).
  const [selectedFields, setSelectedFields] = useState<Set<string>>(() => loadSelectedFields());
  const [fieldsOpen, setFieldsOpen] = useState(false);

  function updateSelectedFields(next: Set<string>) {
    setSelectedFields(next);
    saveSelectedFields(next);
  }
  function toggleField(key: string) {
    const next = new Set(selectedFields);
    if (next.has(key)) next.delete(key); else next.add(key);
    updateSelectedFields(next);
  }
  function selectAllFields() {
    updateSelectedFields(new Set(DEFAULT_SELECTED_FIELD_KEYS));
  }
  function clearAllFields() {
    updateSelectedFields(new Set());
  }
  function restoreDefaultFields() {
    updateSelectedFields(new Set(DEFAULT_SELECTED_FIELD_KEYS));
  }
  const noFieldsSelected = selectedFields.size === 0;

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const outletRows = useMemo(
    () => (outletId ? rows.filter(r => r.distribution_points?.id === outletId) : []),
    [rows, outletId],
  );

  const priceValueInvalid = (priceFilterMode === 'entered_price_less_than' || priceFilterMode === 'entered_price_greater_than')
    && priceValue.trim() !== '' && parsePriceInput(priceValue) === null;
  const priceRangeInvalid = priceFilterMode === 'entered_price_between'
    && (priceMin.trim() !== '' || priceMax.trim() !== '')
    && (parsePriceInput(priceMin) === null || parsePriceInput(priceMax) === null || (parsePriceInput(priceMin) ?? 0) > (parsePriceInput(priceMax) ?? 0));

  // All filters combine with AND logic — each only narrows `list` further,
  // never replaces it. No crash on null/undefined fields anywhere below.
  const filteredRows = useMemo(() => {
    let list = outletRows;

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r =>
        (r.scientific_name ?? '').toLowerCase().includes(q) ||
        (r.trade_name ?? '').toLowerCase().includes(q) ||
        (r.concentration ?? '').toLowerCase().includes(q) ||
        (r.dosage_form ?? '').toLowerCase().includes(q) ||
        (r.batch_number ?? '').toLowerCase().includes(q)
      );
    }
    if (conditionFilter) list = list.filter(r => effOf(r) === conditionFilter);
    if (supplyFilter) list = list.filter(r => normalizeSupplyType(r.supply_type) === supplyFilter);
    if (quantityFilter === 'has_quantity') list = list.filter(r => (r.quantity ?? 0) > 0);
    if (quantityFilter === 'zero_quantity') list = list.filter(r => (r.quantity ?? 0) === 0);

    if (priceFilterMode === 'no_entered_price') {
      list = list.filter(r => !(typeof r.price === 'number' && r.price > 0));
    } else if (priceFilterMode === 'has_entered_price') {
      list = list.filter(r => typeof r.price === 'number' && r.price > 0);
    } else if (priceFilterMode === 'entered_price_less_than') {
      const threshold = parsePriceInput(priceValue);
      if (threshold !== null) list = list.filter(r => typeof r.price === 'number' && r.price < threshold);
    } else if (priceFilterMode === 'entered_price_greater_than') {
      const threshold = parsePriceInput(priceValue);
      if (threshold !== null) list = list.filter(r => typeof r.price === 'number' && r.price > threshold);
    } else if (priceFilterMode === 'entered_price_between') {
      const min = parsePriceInput(priceMin);
      const max = parsePriceInput(priceMax);
      if (min === null || max === null || min > max) {
        list = [];
      } else {
        list = list.filter(r => typeof r.price === 'number' && r.price >= min && r.price <= max);
      }
    }

    if (expiryFilter === 'near_expiry') list = list.filter(r => effOf(r) === 'near_expiry');
    else if (expiryFilter === 'expired') list = list.filter(r => effOf(r) === 'expired');
    else if (expiryFilter === 'valid') list = list.filter(r => effOf(r) !== 'near_expiry' && effOf(r) !== 'expired');

    if (removedFilter === 'active') list = list.filter(r => r.removed_at == null);
    else if (removedFilter === 'removed') list = list.filter(r => r.removed_at != null);

    return list;
  }, [outletRows, search, conditionFilter, supplyFilter, quantityFilter, priceFilterMode, priceValue, priceMin, priceMax, expiryFilter, removedFilter]);

  const summary = useMemo(() => {
    let availableCount = 0, lowStockCount = 0, missingCount = 0, nearExpiryCount = 0, surplusCount = 0;
    let totalQuantity = 0, pricedItemsCount = 0;
    for (const r of filteredRows) {
      const eff = effOf(r);
      if (eff === 'available') availableCount++;
      else if (eff === 'low_stock') lowStockCount++;
      else if (eff === 'missing') missingCount++;
      else if (eff === 'near_expiry') nearExpiryCount++;
      else if (eff === 'surplus') surplusCount++;
      totalQuantity += r.quantity ?? 0;
      if (typeof r.price === 'number' && r.price > 0) pricedItemsCount++;
    }
    return {
      totalItems: filteredRows.length,
      availableCount, lowStockCount, missingCount, nearExpiryCount, surplusCount,
      totalQuantity, pricedItemsCount,
    };
  }, [filteredRows]);

  const selectedFiltersText = useMemo(() => {
    const parts: string[] = [];
    if (search.trim()) parts.push(`${t('search', lang)}: ${search.trim()}`);
    if (conditionFilter) parts.push(`${t('avail_condition', lang)}: ${t('cond_' + conditionFilter, lang)}`);
    if (supplyFilter) parts.push(`${t('avail_supply_type', lang)}: ${t(SUPPLY_CATEGORIES.find(c => c.value === supplyFilter)?.labelKey ?? '', lang)}`);
    if (quantityFilter === 'has_quantity') parts.push(t('sf_has_quantity', lang));
    if (quantityFilter === 'zero_quantity') parts.push(t('sf_zero_quantity', lang));
    if (priceFilterMode === 'no_entered_price') parts.push(t('sc_price_filter_no_entered', lang));
    else if (priceFilterMode === 'has_entered_price') parts.push(t('sc_price_filter_has_entered', lang));
    else if (priceFilterMode === 'entered_price_less_than') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_less_than', lang)} ${priceValue.trim()}`);
    else if (priceFilterMode === 'entered_price_greater_than') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_greater_than', lang)} ${priceValue.trim()}`);
    else if (priceFilterMode === 'entered_price_between') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_between', lang)} ${priceMin.trim()}–${priceMax.trim()}`);
    if (expiryFilter === 'near_expiry') parts.push(t('sc_outlet_report_filter_expiry_near', lang));
    else if (expiryFilter === 'expired') parts.push(t('sc_outlet_report_filter_expiry_expired', lang));
    else if (expiryFilter === 'valid') parts.push(t('sc_outlet_report_filter_expiry_valid', lang));
    if (removedFilter === 'active') parts.push(t('sc_outlet_report_filter_removed_active', lang));
    else if (removedFilter === 'removed') parts.push(t('sc_outlet_report_filter_removed_removed', lang));
    return parts.length ? parts.join(' · ') : t('sc_all', lang);
  }, [search, conditionFilter, supplyFilter, quantityFilter, priceFilterMode, priceValue, priceMin, priceMax, expiryFilter, removedFilter, lang]);

  function buildExportRows(): OutletReportRow[] {
    return filteredRows.map((r, i) => {
      const status = effOf(r);
      const tier = getExpiryRiskTier(r.expiry_date);
      return {
        no: i + 1,
        institution: institutionName || '—',
        outlet: outletName || '—',
        scientificName: r.scientific_name || '—',
        tradeName: r.trade_name || '—',
        dosageForm: r.dosage_form || '—',
        concentration: r.concentration || '—',
        batchNumber: r.batch_number || '—',
        quantity: r.quantity ?? 0,
        enteredPrice: typeof r.price === 'number' ? r.price : null,
        conditionKey: status,
        conditionLabel: EXPORT_CONDITION_LABELS[status] ?? status,
        expiryDate: r.expiry_date ? new Date(r.expiry_date) : null,
        daysToExpiry: daysUntilExpiry(r.expiry_date),
        expiryRiskLabel: `${getExpiryRiskLabel(tier, 'en')} / ${getExpiryRiskLabel(tier, 'ar')}`,
        lastUpdatedBy: r.actor_name_snapshot || '—',
        lastUpdatedAt: r.updated_at ? new Date(r.updated_at) : null,
        notes: r.notes || '—',
        removedLabel: r.removed_at != null ? 'Removed / مُزالة' : 'Active / نشط',
        // PHASE2-EXPORT-FIELD-SELECTOR-A: raw supply_type text, same value already shown on screen and in printColumns — never calculated/inferred.
        supplyType: r.supply_type || '—',
      };
    });
  }

  async function exportXlsx() {
    if (xlsxBusy || noFieldsSelected) return;
    setXlsxBusy(true);
    try {
      const safeOutlet = (outletName || 'outlet').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
      // PHASE2-EXPORT-FIELD-SELECTOR-A: translate the modal's canonical
      // field keys to their OUTLET_REPORT_COLUMNS key names. selectedFields
      // always has all 16 keys by default, so selectedColumnKeys is
      // populated the same as before for any user who never touches the
      // selector — buildOutletReportWorkbook still exports every column.
      const selectedColumnKeys = new Set(
        Array.from(selectedFields).map(k => FIELD_TO_EXCEL_COLUMN_KEY[k]).filter(Boolean),
      );
      const ok = await exportOutletReportXlsx({
        reportTitle: t('sc_outlet_report_title', lang),
        moduleName: outletName,
        generatedAt: new Date(),
        lang,
        fileNameBase: `MediStock-Babil_Outlet_Report_${safeOutlet}`,
        filtersSummary: selectedFiltersText,
        footerText: t('report_footer_generated_by', lang),
        emptyMessage: t('se_no_records', lang),
        outletName,
        institutionName,
        summary,
        rows: buildExportRows(),
        selectedColumnKeys,
      });
      if (!ok) showToast(t('csv_export_failed', lang));
    } catch {
      showToast(t('csv_export_failed', lang));
    } finally {
      setXlsxBusy(false);
    }
  }

  // Print/PDF reuses the existing generic professional print primitive
  // (triggerProfessionalPrint/buildPremiumPrintHtml) — dependency-free
  // browser print-to-PDF, exactly like every other screen's print button.
  // No new PDF library was added.
  // PHASE2-EXPORT-FIELD-SELECTOR-A: `key` on every entry below now matches
  // FIELD_DEFINITIONS' canonical field keys exactly (previously abbreviated
  // internal names like 'sci'/'conc'/'updated') — these keys are only ever
  // used internally (React iteration key, column identification inside
  // buildPremiumPrintHtml) and are not asserted on by any existing test, so
  // this rename is safe. institution/outlet are NEW here (this print output
  // never had per-row institution/outlet columns before — they were only
  // shown in the header); both are constants, not per-row lookups.
  const printColumns: ProfessionalReportColumn<LiveAvailRow>[] = [
    { key: 'institution', label: t('avail_inst_label', lang), value: () => institutionName || '—' },
    { key: 'outlet', label: t('avail_details_outlet_label', lang), value: () => outletName || '—' },
    { key: 'scientificName', label: t('avail_scientific_name', lang), value: r => r.scientific_name || '—' },
    { key: 'tradeName', label: t('avail_trade_name', lang), value: r => r.trade_name || '—' },
    { key: 'dosageForm', label: t('avail_dosage_form', lang), value: r => r.dosage_form || '—' },
    { key: 'concentration', label: t('avail_concentration', lang), value: r => r.concentration || '—' },
    { key: 'quantity', label: t('qty', lang), value: r => String(r.quantity ?? 0), numeric: true },
    { key: 'condition', label: t('avail_condition', lang), value: r => t('cond_' + effOf(r), lang) },
    { key: 'enteredPrice', label: t('sc_entered_price', lang), value: r => priceDisplay(r.price), numeric: true },
    { key: 'supplyType', label: t('avail_supply_type', lang), value: r => r.supply_type || '—' },
    { key: 'batchNumber', label: t('batch_no', lang), value: r => r.batch_number || '—', ltr: true },
    { key: 'expiryDate', label: t('expiry', lang), value: r => formatStableDate(r.expiry_date, lang), ltr: true, dateColumn: 'date', excelValue: r => r.expiry_date },
    { key: 'daysToExpiry', label: t('avail_details_days_to_expiry', lang), value: r => { const d = daysUntilExpiry(r.expiry_date); return d === null ? '—' : String(d); }, numeric: true },
    { key: 'notes', label: t('sc_notes', lang), value: r => r.notes || '—' },
    { key: 'lastUpdated', label: t('last_upd', lang), value: r => formatStableDate(r.updated_at, lang), ltr: true, dateColumn: 'date', excelValue: r => r.updated_at },
    { key: 'removedStatus', label: t('sc_removed_badge', lang), value: r => r.removed_at != null ? t('sc_removed_badge', lang) : t('sc_outlet_report_active_label', lang) },
  ];

  function printReport() {
    if (noFieldsSelected) return;
    // PHASE2-EXPORT-FIELD-SELECTOR-A: same selectedFields set as Excel —
    // one selection, applied identically to both surfaces. Default (all 16
    // selected) keeps every printColumns entry, unchanged from before.
    const columns = printColumns.filter(c => selectedFields.has(c.key));
    const config = {
      reportTitle: t('sc_outlet_report_title', lang),
      moduleName: `${outletName}${institutionName ? ' — ' + institutionName : ''}`,
      generatedAt: new Date(),
      lang,
      fileNameBase: `MediStock-Babil_Outlet_Report_${(outletName || 'outlet').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40)}`,
      filtersSummary: selectedFiltersText,
      footerText: t('report_footer_generated_by', lang),
      emptyMessage: t('se_no_records', lang),
      columns,
      rows: filteredRows,
      rowAccent: (r: LiveAvailRow) => {
        const eff = effOf(r);
        return eff === 'missing' || eff === 'expired' ? 'err' as const
          : eff === 'low_stock' || eff === 'near_expiry' ? 'warn' as const
          : 'ok' as const;
      },
      labels: {
        generatedAt: t('sc_generated_at', lang),
        filtersSummary: t('sc_selected_filters', lang),
        rowCount: t('sc_total_rows', lang),
      },
    };
    const { ok, mobileHtml } = triggerProfessionalPrint(config);
    if (mobileHtml !== undefined) {
      setMobilePrintHtml(mobileHtml);
      return;
    }
    if (!ok) showToast(t('print_popup_blocked', lang));
  }

  return (
    <PhoenixDialog open={open} onClose={onClose} title={t('sc_outlet_report_title', lang)} maxWidth={1100}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
        <button
          onClick={onClose}
          aria-label={t('close', lang)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t2)', padding: '4px 8px', display: 'inline-flex', alignItems: 'center' }}
        >
          <PhoenixIcon name="close" size={16} />
        </button>
      </div>

      {!outletId ? (
        <div style={{ textAlign: 'center', padding: '30px', color: 'var(--t2)', fontSize: '13px' }}>
          {t('sc_outlet_report_no_outlet', lang)}
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '15px', fontWeight: 700 }} dir="auto"><PhoenixIcon name="package" size={15} inline /> {outletName || '—'}</div>
            {institutionName && <div style={{ fontSize: '12px', color: 'var(--t2)' }} dir="auto"><PhoenixIcon name="hospital" size={12} inline /> {institutionName}</div>}
          </div>

          {/* Summary cards */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
            <div style={summaryCardStyle}><div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('sc_outlet_report_summary_total_items', lang)}</div><div style={{ fontSize: '16px', fontWeight: 700 }}>{summary.totalItems}</div></div>
            <div style={summaryCardStyle}><div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('cond_available', lang)}</div><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--ok)' }}>{summary.availableCount}</div></div>
            <div style={summaryCardStyle}><div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('cond_low_stock', lang)}</div><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--warn)' }}>{summary.lowStockCount}</div></div>
            <div style={summaryCardStyle}><div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('cond_missing', lang)}</div><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--err)' }}>{summary.missingCount}</div></div>
            <div style={summaryCardStyle}><div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('cond_near_expiry', lang)}</div><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--warn)' }}>{summary.nearExpiryCount}</div></div>
            <div style={summaryCardStyle}><div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('cond_surplus', lang)}</div><div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--ok)' }}>{summary.surplusCount}</div></div>
            <div style={summaryCardStyle}><div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('sc_outlet_report_summary_total_qty', lang)}</div><div style={{ fontSize: '16px', fontWeight: 700 }}>{summary.totalQuantity}</div></div>
            <div style={summaryCardStyle}><div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('sc_outlet_report_summary_priced_items', lang)}</div><div style={{ fontSize: '16px', fontWeight: 700 }}>{summary.pricedItemsCount}</div></div>
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
            <input type="text" dir="auto" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('search', lang)} style={{ ...fieldStyle, flex: '1 1 160px', minWidth: '140px' }} />
            <select value={conditionFilter} onChange={e => setConditionFilter(e.target.value as CanonicalCondition | '')} style={{ ...fieldStyle, minWidth: '130px' }} aria-label={t('avail_condition', lang)}>
              <option value="">{t('sc_all', lang)}</option>
              {CANONICAL_CONDITIONS.map(c => <option key={c} value={c}>{t('cond_' + c, lang)}</option>)}
            </select>
            <select value={supplyFilter} onChange={e => setSupplyFilter(e.target.value as SupplyCategory | '')} style={{ ...fieldStyle, minWidth: '140px' }} aria-label={t('avail_supply_type', lang)}>
              <option value="">{t('sc_all_supply_types', lang)}</option>
              {SUPPLY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{t(c.labelKey, lang)}</option>)}
            </select>
            <select value={quantityFilter} onChange={e => setQuantityFilter(e.target.value as QuantityFilter)} style={{ ...fieldStyle, minWidth: '120px' }} aria-label={t('qty', lang)}>
              <option value="all">{t('sc_all', lang)}</option>
              <option value="has_quantity">{t('sf_has_quantity', lang)}</option>
              <option value="zero_quantity">{t('sf_zero_quantity', lang)}</option>
            </select>
            <select value={expiryFilter} onChange={e => setExpiryFilter(e.target.value as ExpiryFilter)} style={{ ...fieldStyle, minWidth: '140px' }} aria-label={t('sc_outlet_report_filter_expiry_label', lang)}>
              <option value="all">{t('sc_all', lang)}</option>
              <option value="near_expiry">{t('sc_outlet_report_filter_expiry_near', lang)}</option>
              <option value="expired">{t('sc_outlet_report_filter_expiry_expired', lang)}</option>
              <option value="valid">{t('sc_outlet_report_filter_expiry_valid', lang)}</option>
            </select>
            <select value={removedFilter} onChange={e => setRemovedFilter(e.target.value as RemovedFilter)} style={{ ...fieldStyle, minWidth: '140px' }} aria-label={t('sc_outlet_report_filter_removed_label', lang)}>
              <option value="all">{t('sc_all', lang)}</option>
              <option value="active">{t('sc_outlet_report_filter_removed_active', lang)}</option>
              <option value="removed">{t('sc_outlet_report_filter_removed_removed', lang)}</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
            <select
              value={priceFilterMode}
              onChange={e => setPriceFilterMode(e.target.value as PriceFilterMode)}
              style={{ ...fieldStyle, minWidth: '160px' }}
              aria-label={t('sc_price_filter_label', lang)}
            >
              <option value="all">{t('sc_price_filter_all', lang)}</option>
              <option value="no_entered_price">{t('sc_price_filter_no_entered', lang)}</option>
              <option value="has_entered_price">{t('sc_price_filter_has_entered', lang)}</option>
              <option value="entered_price_less_than">{t('sc_price_filter_less_than', lang)}</option>
              <option value="entered_price_greater_than">{t('sc_price_filter_greater_than', lang)}</option>
              <option value="entered_price_between">{t('sc_price_filter_between', lang)}</option>
            </select>
            {(priceFilterMode === 'entered_price_less_than' || priceFilterMode === 'entered_price_greater_than') && (
              <input type="number" min="0" step="0.01" dir="ltr" value={priceValue} onChange={e => setPriceValue(e.target.value)} placeholder={t('sc_price_value_ph', lang)} style={{ ...fieldStyle, minWidth: '110px' }} />
            )}
            {priceFilterMode === 'entered_price_between' && (
              <>
                <input type="number" min="0" step="0.01" dir="ltr" value={priceMin} onChange={e => setPriceMin(e.target.value)} placeholder={t('sc_price_min_ph', lang)} style={{ ...fieldStyle, minWidth: '90px' }} />
                <input type="number" min="0" step="0.01" dir="ltr" value={priceMax} onChange={e => setPriceMax(e.target.value)} placeholder={t('sc_price_max_ph', lang)} style={{ ...fieldStyle, minWidth: '90px' }} />
              </>
            )}
          </div>
          {priceValueInvalid && <div style={{ fontSize: '11px', color: 'var(--err)', marginBottom: '8px' }}>{t('sc_price_invalid', lang)}</div>}
          {priceRangeInvalid && <div style={{ fontSize: '11px', color: 'var(--err)', marginBottom: '8px' }}>{t('sc_price_range_invalid', lang)}</div>}

          {/* PHASE2-EXPORT-FIELD-SELECTOR-A: inline collapsible field
              selector — controls WHICH COLUMNS Excel/print include, never
              which rows (row filters above are untouched). Collapsed by
              default; selection itself still defaults to all 16 fields
              regardless of whether this section has ever been opened. */}
          <div style={{ marginBottom: '10px', border: '1px solid var(--brd)', borderRadius: 'var(--r2)' }}>
            <button
              type="button"
              onClick={() => setFieldsOpen(v => !v)}
              style={{ ...fieldStyle, width: '100%', textAlign: 'start', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: 'none', background: 'transparent' }}
            >
              <span><PhoenixIcon name="scope" size={14} inline /> {t('sc_outlet_report_fields_title', lang)} ({selectedFields.size}/{FIELD_DEFINITIONS.length})</span>
              <span>{fieldsOpen ? '▲' : '▼'}</span>
            </button>
            {fieldsOpen && (
              <div style={{ padding: '10px', borderTop: '1px solid var(--brd)' }}>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                  <PhoenixButton variant="ghost" size="sm" onClick={selectAllFields}>{t('sc_outlet_report_fields_select_all', lang)}</PhoenixButton>
                  <PhoenixButton variant="ghost" size="sm" onClick={clearAllFields}>{t('sc_outlet_report_fields_clear_all', lang)}</PhoenixButton>
                  <PhoenixButton variant="ghost" size="sm" onClick={restoreDefaultFields}>{t('sc_outlet_report_fields_restore_default', lang)}</PhoenixButton>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '6px' }}>
                  {FIELD_DEFINITIONS.map(f => (
                    <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={selectedFields.has(f.key)} onChange={() => toggleField(f.key)} />
                      <span dir="auto">{t(f.labelKey, lang)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          {noFieldsSelected && (
            <div style={{ fontSize: '11px', color: 'var(--err)', marginBottom: '8px' }}>{t('sc_outlet_report_fields_none_selected', lang)}</div>
          )}

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <PhoenixButton variant="secondary" size="sm" loading={xlsxBusy} disabled={xlsxBusy || noFieldsSelected} onClick={exportXlsx}>
<PhoenixIcon name="reports" size={14} inline /> {t('sc_outlet_report_export', lang)}
            </PhoenixButton>
            <PhoenixButton variant="ghost" size="sm" disabled={filteredRows.length === 0 || noFieldsSelected} onClick={printReport}>
<PhoenixIcon name="file" size={14} inline /> {t('sc_print_pdf', lang)}
            </PhoenixButton>
          </div>

          {/* Table */}
          {filteredRows.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px', color: 'var(--t2)', fontSize: '13px' }}>{t('se_no_records', lang)}</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
                <thead>
                  <tr>
                    <th style={th}>{t('avail_scientific_name', lang)}</th>
                    <th style={th}>{t('avail_trade_name', lang)}</th>
                    <th style={th}>{t('avail_dosage_form', lang)}</th>
                    <th style={th}>{t('avail_concentration', lang)}</th>
                    <th style={th}>{t('qty', lang)}</th>
                    <th style={th}>{t('avail_condition', lang)}</th>
                    <th style={th}>{t('sc_entered_price', lang)}</th>
                    <th style={th}>{t('avail_supply_type', lang)}</th>
                    <th style={th}>{t('batch_no', lang)}</th>
                    <th style={th}>{t('expiry', lang)}</th>
                    <th style={th}>{t('avail_details_days_to_expiry', lang)}</th>
                    <th style={th}>{t('sc_notes', lang)}</th>
                    <th style={th}>{t('last_upd', lang)}</th>
                    <th style={th}>{t('sc_removed_badge', lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map(r => {
                    const eff = effOf(r);
                    const days = daysUntilExpiry(r.expiry_date);
                    return (
                      <tr key={r.id}>
                        <td style={td} dir="auto">{r.scientific_name || DASH}</td>
                        <td style={td} dir="auto">{r.trade_name || DASH}</td>
                        <td style={td} dir="auto">{r.dosage_form || DASH}</td>
                        <td style={td} dir="auto">{r.concentration || DASH}</td>
                        <td style={td}>{r.quantity ?? 0}</td>
                        <td style={td}><PhoenixStatusBadge variant={CONDITION_VARIANT[eff]} label={t('cond_' + eff, lang)} /></td>
                        <td style={td}>{priceDisplay(r.price)}</td>
                        <td style={td} dir="auto">{r.supply_type || DASH}</td>
                        <td style={td} dir="ltr">{r.batch_number || DASH}</td>
                        <td style={td} dir="ltr">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <span>{formatStableDate(r.expiry_date, lang)}</span>
                            <ExpiryRiskBadge expiryDate={r.expiry_date} lang={lang} />
                          </div>
                        </td>
                        <td style={td}>{days === null ? DASH : days}</td>
                        <td style={td} dir="auto">{r.notes || DASH}</td>
                        <td style={td} dir="ltr">{formatStableDate(r.updated_at, lang)}</td>
                        <td style={td}>
                          {r.removed_at != null
                            ? <PhoenixStatusBadge variant="err" label={t('sc_removed_badge', lang)} />
                            : DASH}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: '16px' }}>
        <PhoenixButton variant="ghost" size="md" style={{ width: '100%' }} onClick={onClose}>
          {t('close', lang)}
        </PhoenixButton>
      </div>

      {toast && <PhoenixToast message={toast} />}
      <MobilePrintFallbackModal
        open={mobilePrintHtml !== null}
        html={mobilePrintHtml ?? ''}
        title={t('sc_outlet_report_title', lang)}
        fileNameBase={`MediStock-Babil_Outlet_Report_${(outletName || 'outlet').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40)}`}
        lang={lang}
        onClose={() => setMobilePrintHtml(null)}
      />
    </PhoenixDialog>
  );
}

const th = { padding: '7px 8px', textAlign: 'start' as const, fontSize: '10.5px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
const td = { padding: '7px 8px', fontSize: '11px', borderBottom: '1px solid var(--brd)', verticalAlign: 'top' as const };
