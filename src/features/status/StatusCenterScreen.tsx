import { useState, useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { useIsMobileViewport } from '@/shared/ui/useResponsiveViewport';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { formatStableDate, formatStableDateTime } from '@/shared/lib/date';
import { isLikelyMobilePrintContext } from '@/shared/lib/reportExport';
import { getExpiryRiskTier, getExpiryRiskLabel } from '@/shared/lib/expiry-risk';
import {
  exportAvailabilityXlsx,
  type AvailabilityExportRow,
} from '@/shared/lib/professional-export';
import { getAvailabilityByOrg } from '@/shared/supabase/services/availability.service';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import type { CanonicalStatus } from '@/shared/lib/status/canonical';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { ExpiryRiskBadge } from '@/shared/ui/ExpiryRiskBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal';
// CANONICAL-STOCK-CUTOVER: AdjustQuantityModal (the item_availability quantity
// writer, migration 034) is retired. item_availability is a read-only projection
// (083); a Status Center aggregate row can never be edited directly. Corrections
// go through AvailabilityStockCorrectionModal, which forces explicit canonical
// outlet_stock LOT selection and the guarded migration-086 RPC.
import { AvailabilityStockCorrectionModal, type AvailabilityCorrectionRow } from './AvailabilityStockCorrectionModal';
import { ReactivateMaterialModal, REACTIVATE_PERMISSION_KEYS, type ReactivateRow } from './ReactivateMaterialModal';
import { MovementHistoryModal, type MovementHistoryRow } from './MovementHistoryModal';
import { MovementReportSection } from './MovementReportSection';

// The prior "who may correct quantity" cohort (migration 032 flat permission
// keys) still decides whether the Correct-stock affordance is OFFERED. The real
// authorization is the scoped outlet_stock.count permission, resolved per-outlet
// inside AvailabilityStockCorrectionModal and re-enforced server-side by the
// guarded RPC — the flat keys are a UX visibility proxy only, never the boundary.
const STOCK_CORRECTION_VISIBILITY_KEYS = [
  'availability.quantity.set',
  'availability.quantity.add',
  'availability.quantity.subtract',
  'availability.quantity.correct',
];
import { computeInternalAlerts } from './internalAlerts';
import { InternalAlertsSection } from './InternalAlertsSection';
import { OutletMaterialGroups } from './OutletMaterialGroups';
import { OutletAvailabilityReportModal } from './OutletAvailabilityReportModal';
import { QuickActionGrid, type QuickAction } from '@/shared/ui/QuickActionGrid';
import { CommandCenterActivityFeed, type ActivityFeedEntry } from '@/shared/ui/CommandCenterActivityFeed';
import { SmartFilterChips, type SmartFilterChipItem } from '@/shared/ui/SmartFilterChips';
import { AuditLogSection } from '@/features/reports/AuditLogSection';
import { InventoryIntelligencePanel } from '@/features/inventory/InventoryIntelligencePanel';

// NOTE: Manual status reports (institution_item_status_reports) are intentionally
// NO LONGER part of this screen (LIVE-STATUS-CENTER-REPORTS-PRINT-EXPORT-A). The
// Status Center is now a live-availability reporting center driven entirely by
// item_availability via getAvailabilityByOrg. The manual status report service
// module and its DB table are NOT deleted — only the manual add/edit/resolve UI
// was removed to avoid confusion. Historical report rows remain untouched.

/** The 6 canonical statuses summarized/filtered in the live report. */
const CANONICAL_STATUSES: CanonicalStatus[] = [
  'available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired',
];

/** Badge variant per canonical effective status (UI only). */
const CANON_VARIANT: Record<CanonicalStatus, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

// BUGFIX-REPORTS-DATES-PORT-CLEAR-A: date-shaped columns — must render
// dir="ltr" in RTL layout (on-screen AND in the generated print HTML) or the
// bidi algorithm can visually reorder the separated digit groups.
const LTR_COLUMN_KEYS = new Set(['expiry', 'updated']);

// UX-SMART-FILTERS-TIMELINE-A: "recently updated" window for the smart
// filter chip — purely a client-side predicate over already-loaded rows'
// real updated_at, no new query.
const RECENTLY_UPDATED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type QuantityFilter = 'all' | 'has_quantity' | 'zero_quantity';

// PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: the six required price
// filter modes, matching the task's exact literal names.
type PriceFilterMode =
  | 'all'
  | 'no_entered_price'
  | 'has_entered_price'
  | 'entered_price_less_than'
  | 'entered_price_greater_than'
  | 'entered_price_between';

/**
 * Parses a free-text numeric input into a validated, non-negative number, or
 * null when the input is empty, non-numeric, or negative. Never throws — an
 * invalid/negative value is simply treated as "not provided" so the UI can
 * decide how to react (see priceFilterInvalid/priceRangeInvalid below)
 * instead of crashing on bad input.
 */
function parsePriceInput(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// CANONICAL-SUPPLY-PROVENANCE-088: CLOSED vocabulary — donations is no longer
// offered anywhere; legacy donation rows DISPLAY under aid (mساعدات) via the
// safe mapping below without any data rewrite.
type SupplyCategory = 'purchases' | 'kimadia' | 'aid';

const SUPPLY_CATEGORIES: { value: SupplyCategory; labelKey: string }[] = [
  { value: 'aid',       labelKey: 'sc_supply_aid' },
  { value: 'purchases', labelKey: 'sc_supply_purchases' },
  { value: 'kimadia',   labelKey: 'sc_supply_kimadia' },
];

/**
 * Normalize a free-text supply_type value into a known display category WITHOUT
 * altering the stored value. Returns null when it doesn't match a known category
 * (the original value is still preserved and shown in tables/exports).
 */
function normalizeSupplyType(v?: string | null): SupplyCategory | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('kimadia') || s.includes('كيماديا') || s.includes('كماديا')) return 'kimadia';
  if (s.includes('purchase') || s.includes('local_procurement') || s.includes('مشتر') || s.includes('شراء')) return 'purchases';
  // Legacy donations display under aid — safe mapping, data untouched.
  if (s.includes('donation') || s.includes('تبرع') || s.includes('منح')) return 'aid';
  if (s.includes('aid') || s.includes('مساعد') || s.includes('إغاث') || s.includes('اغاث') || s.startsWith('هب')) return 'aid';
  return null;
}

/**
 * A live item_availability row enriched with derived fields by the service
 * layer. Exported (PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A) so
 * OutletAvailabilityReportModal.tsx can type its `rows` prop against the
 * exact same shape — no new query, no new fields added to the interface.
 */
export interface LiveAvailRow {
  id: string;
  scientific_name: string | null;
  trade_name: string | null;
  dosage_form: string | null;
  concentration: string | null;
  quantity: number;
  condition: string | null;
  expiry_date: string | null;
  supply_type: string | null;
  updated_at: string | null;
  raw_condition?: string;
  effective_status?: CanonicalStatus;
  expiry_bucket?: string | null;
  distribution_points: { id: string; name: string; name_ar: string; status?: string } | null;
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: already selected by getAvailabilityByOrg
  // (availability.service.ts) — batch_number/notes are pre-existing columns;
  // actor_name_snapshot is a display-name text column (never the raw
  // last_updated_by auth uuid); removed_at is migration 053's
  // intentional-removal marker, read here ONLY to exclude removed rows from
  // the XLSX export (the on-screen table itself stays unfiltered by it).
  batch_number?: string | null;
  notes?: string | null;
  actor_name_snapshot?: string | null;
  removed_at?: string | null;
  // PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A: removal_reason (migration
  // 053's free-text removal label) is now shown to the user via a friendly
  // bilingual mapping. national_code/price are already selected by
  // getAvailabilityByOrg and displayed here. (Reactivation is now catalogue-
  // visibility only — migration 084 — and writes no quantity/condition.)
  removal_reason?: string | null;
  national_code?: string | null;
  price?: number | null;
}

function effOf(r: LiveAvailRow): CanonicalStatus {
  return (r.effective_status ?? r.condition ?? 'available') as CanonicalStatus;
}

function dpNameOf(r: LiveAvailRow, lang: 'ar' | 'en'): string {
  const dp = r.distribution_points;
  if (!dp) return '—';
  return lang === 'ar' ? (dp.name_ar || dp.name) : dp.name;
}

// PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A: removal_reason (migration
// 053's free-text label) mapped to a friendly bilingual string — never
// rendered raw, and any unrecognized/future reason value falls back to a
// safe generic "Removed" label instead of showing the raw DB string.
function removalReasonLabel(reason: string | null | undefined, lang: 'ar' | 'en'): string {
  if (reason === 'removed_from_outlet') return t('sc_removal_reason_removed_from_outlet', lang);
  if (reason === 'clear_port_availability') return t('sc_removal_reason_clear_port_availability', lang);
  return t('sc_removal_reason_unknown', lang);
}

// BUGFIX-REPORTS-DATES-PORT-CLEAR-A follow-up: expiry_date must go through
// formatStableDate (like every other exported/printed date) rather than
// being passed through raw — otherwise its on-screen/CSV/print format
// diverges from the "updated" column right next to it.
function expiryDisplay(r: LiveAvailRow, lang: 'ar' | 'en'): string {
  if (r.expiry_date) return formatStableDate(r.expiry_date, lang);
  if (r.expiry_bucket) return t('cond_' + (r.expiry_bucket === 'expired' ? 'expired' : 'near_expiry'), lang);
  return '—';
}

// PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: on-screen display of the
// existing, user-entered `price` field only — never calculated, inferred, or
// overwritten here. DISPLAY CHOICE (documented per task): null/undefined AND
// an actual 0 all render as "—" on screen (a quick-glance table has no way to
// distinguish "never entered" from "entered as zero", and both mean "nothing
// meaningful to show" for a fast scan) — a real 2-decimal value is shown
// otherwise. This intentionally differs from the XLSX export below, which
// keeps 0 as a real numeric 0.00 (see enteredPriceExportValue).
function priceDisplay(price: number | null | undefined): string {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return '—';
  return price.toFixed(2);
}

const fieldStyle = {
  padding: '8px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '13px',
} as const;

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// SAFE-PROFESSIONAL-XLSX-EXPORT-A: bilingual condition labels for the XLSX
// export (Availability Export sheet + Summary sheet totals) — headers/labels
// in this export are always bilingual regardless of the app's current
// language, per this phase's explicit requirement. The on-screen table
// itself is untouched and still uses the existing lang-switched `t()` labels.
const AVAIL_EXPORT_CONDITION_LABELS: Record<CanonicalStatus, string> = {
  available:   'Available / متوفر',
  low_stock:   'Low Stock / منخفض',
  missing:     'Missing / مفقود',
  surplus:     'Surplus / فائض',
  near_expiry: 'Near Expiry / قريب الانتهاء',
  expired:     'Expired / منتهي الصلاحية',
};

/** Whole days from `now` until `expiryDate` (negative if already past) — null when unparseable/missing. */
function daysUntilExpiry(expiryDate: string | null, now: Date = new Date()): number | null {
  if (!expiryDate) return null;
  const d = new Date(expiryDate);
  if (isNaN(d.getTime())) return null;
  const dateOnly = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  return Math.round((dateOnly(d).getTime() - dateOnly(now).getTime()) / 86_400_000);
}

export function StatusCenterScreen({ onNavigate }: { onNavigate: (screen: number) => void }) {
  const { lang, activeOrgId, myPermissions, role } = useApp();
  const isMobile = useIsMobileViewport();

  const effectiveOrgId = activeOrgId ?? undefined;

  const [filterStatus, setFilterStatus] = useState<CanonicalStatus | ''>('');
  const [filterSupply, setFilterSupply] = useState<SupplyCategory | ''>('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'outlet'>('table');

  // PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A: top-level Status
  // Center tab — 'live' is the existing, unmodified availability
  // reporting UI (everything below); 'audit' shows the reusable, read-only
  // AuditLogSection (same component ReportsScreen.tsx's own Audit tab uses).
  // Purely additive UI state — no effect on any existing filter/data logic.
  const [mainTab, setMainTab] = useState<'live' | 'audit'>('live');

  // PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A: the outlet report modal's
  // selected outlet, or null when closed. Purely local UI state — no data
  // write, no new fetch (the modal reads the same already-filtered `rows`).
  const [reportOutlet, setReportOutlet] = useState<{ id: string; name: string; nameAr: string } | null>(null);

  // UX-SMART-FILTERS-TIMELINE-A: additional smart-filter dimensions, combined
  // safely with the existing filterStatus/filterSupply/search filters below —
  // all operate on already-loaded rows only, no new reads.
  const [quantityFilter, setQuantityFilter] = useState<QuantityFilter>('all');
  const [recentOnly, setRecentOnly] = useState(false);

  // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: price filter state.
  // priceValue is used by both single-threshold modes (less_than/greater_than);
  // priceMin/priceMax are used only by entered_price_between. All three are
  // kept as raw text so the input can show exactly what the user typed
  // (including a transient invalid value) — parsePriceInput() only runs when
  // computing `rows` below, it never mutates this raw text state.
  const [priceFilterMode, setPriceFilterMode] = useState<PriceFilterMode>('all');
  const [priceValue, setPriceValue] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');

  // AVAILABILITY-QUANTITY-MOVEMENT-UI-A: row-level "Adjust Quantity" action.
  // Visibility is UX-only — phoenix_apply_availability_movement (migration 034)
  // independently re-enforces the same permission matrix server-side.
  const canCorrectStock = STOCK_CORRECTION_VISIBILITY_KEYS.some(key => myPermissions.has(key));
  const [correctRow, setCorrectRow] = useState<AvailabilityCorrectionRow | null>(null);
  const [movementToast, setMovementToast] = useState<string | null>(null);

  // PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A: row-level "Reactivate" action,
  // shown only for rows already marked removed_at != null. Visibility is
  // UX-only — phoenix_apply_availability_movement and phoenix_upsert_availability
  // independently re-enforce the same permission matrix server-side.
  const canReactivate = REACTIVATE_PERMISSION_KEYS.every(key => myPermissions.has(key));
  const [reactivateRow, setReactivateRow] = useState<ReactivateRow | null>(null);

  // AVAILABILITY-MOVEMENT-HISTORY-VIEW-A: row-level "History" action.
  // Visibility is UX-only — avail_mvmt_select_perm RLS (migration 033)
  // independently re-enforces availability.movements.view + org scope on the
  // actual read; hiding the button here never substitutes for that.
  const canViewMovementHistory = myPermissions.has('availability.movements.view');
  const [historyRow, setHistoryRow] = useState<MovementHistoryRow | null>(null);

  // BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A: on mobile, printReport() routes
  // here instead of calling window.open/window.print directly.
  const [mobilePrintHtml, setMobilePrintHtml] = useState<string | null>(null);

  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: workbook generation is async (ExcelJS
  // writeBuffer, dynamically imported on first use) — guard against
  // double-clicks while a download is in flight, matching StatusEditorScreen's
  // existing xlsxBusy pattern.
  const [xlsxBusy, setXlsxBusy] = useState(false);

  const live = useAsync(
    () => effectiveOrgId ? getAvailabilityByOrg(effectiveOrgId) : Promise.resolve([]),
    [effectiveOrgId],
  );
  const orgs = useAsync(() => getOrganizations(), []);

  const orgName = useMemo(() => {
    if (!effectiveOrgId) return '';
    const o = (orgs.data ?? []).find(x => x.id === effectiveOrgId);
    if (!o) return '';
    return lang === 'ar' ? (o.name_ar || o.name) : (o.name || o.name_ar);
  }, [orgs.data, effectiveOrgId, lang]);

  const allRows = (live.data ?? []) as unknown as LiveAvailRow[];

  const rows = useMemo(() => {
    let list = allRows;
    // BUGFIX-HIDE-CLEARED-PORT-CONTENTS-A: clear_port_availability (migration
    // 042) and "Remove from outlet" both zero quantity + set condition =
    // 'missing' instead of deleting the row (preserves the movement ledger's
    // FK / audit trail). Hide those cleared rows from the default active-
    // contents view — they're indistinguishable at the data level from a
    // genuinely reported "out of stock" item, so an explicit "missing" status
    // filter still shows them (keeps that filter meaningful for real
    // restocking-alert use, rather than always returning zero rows).
    if (filterStatus !== 'missing') {
      list = list.filter(r => !(r.quantity === 0 && r.condition === 'missing'));
    }
    // A disabled/archived outlet has no active contents at all, regardless
    // of what its individual rows' condition/quantity happen to be.
    list = list.filter(r => !r.distribution_points?.status || r.distribution_points.status === 'active');
    if (filterStatus) list = list.filter(r => effOf(r) === filterStatus);
    if (filterSupply) list = list.filter(r => normalizeSupplyType(r.supply_type) === filterSupply);
    // UX-SMART-FILTERS-TIMELINE-A: smart-filter chips — combined additively
    // with the filters above, over the same already-loaded rows.
    if (quantityFilter === 'has_quantity') list = list.filter(r => r.quantity > 0);
    if (quantityFilter === 'zero_quantity') list = list.filter(r => r.quantity === 0);
    if (recentOnly) {
      const cutoff = Date.now() - RECENTLY_UPDATED_WINDOW_MS;
      list = list.filter(r => !!r.updated_at && new Date(r.updated_at).getTime() >= cutoff);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r =>
        (r.scientific_name ?? '').toLowerCase().includes(q) ||
        (r.trade_name ?? '').toLowerCase().includes(q) ||
        (r.concentration ?? '').toLowerCase().includes(q) ||
        (r.dosage_form ?? '').toLowerCase().includes(q) ||
        (r.distribution_points?.name ?? '').toLowerCase().includes(q) ||
        (r.distribution_points?.name_ar ?? '').includes(search.trim())
      );
    }
    // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: price filter — combines
    // with every filter above using AND logic (it only ever narrows `list`
    // further, never replaces it). Source is row.price only — never
    // calculated/inferred/overwritten. null/undefined price is treated as 0
    // ONLY for the purposes of no_entered_price/has_entered_price (never
    // mutates the row itself).
    if (priceFilterMode === 'no_entered_price') {
      list = list.filter(r => !(typeof r.price === 'number' && r.price > 0));
    } else if (priceFilterMode === 'has_entered_price') {
      list = list.filter(r => typeof r.price === 'number' && r.price > 0);
    } else if (priceFilterMode === 'entered_price_less_than') {
      const threshold = parsePriceInput(priceValue);
      // Invalid/negative/empty threshold: filter has no effect yet (documented
      // choice) — the user sees an inline validation hint (rendered below)
      // instead of the table silently emptying while they are still typing.
      if (threshold !== null) list = list.filter(r => typeof r.price === 'number' && r.price < threshold);
    } else if (priceFilterMode === 'entered_price_greater_than') {
      const threshold = parsePriceInput(priceValue);
      if (threshold !== null) list = list.filter(r => typeof r.price === 'number' && r.price > threshold);
    } else if (priceFilterMode === 'entered_price_between') {
      const min = parsePriceInput(priceMin);
      const max = parsePriceInput(priceMax);
      // entered_price_between REQUIRES both min and max (task spec). Documented
      // choice: missing/invalid min or max, OR min > max, safely returns NO
      // ROWS rather than throwing or silently ignoring the filter — the inline
      // validation hint (rendered below) explains why the table is empty.
      if (min === null || max === null || min > max) {
        list = [];
      } else {
        list = list.filter(r => typeof r.price === 'number' && r.price >= min && r.price <= max);
      }
    }
    return list;
  }, [allRows, filterStatus, filterSupply, search, quantityFilter, recentOnly, priceFilterMode, priceValue, priceMin, priceMax]);

  // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: inline validation hints
  // for the price filter UI — purely derived, never blocks other filters.
  const priceValueInvalid = useMemo(
    () => (priceFilterMode === 'entered_price_less_than' || priceFilterMode === 'entered_price_greater_than')
      && priceValue.trim() !== '' && parsePriceInput(priceValue) === null,
    [priceFilterMode, priceValue],
  );
  const priceRangeInvalid = useMemo(() => {
    if (priceFilterMode !== 'entered_price_between') return false;
    const min = parsePriceInput(priceMin);
    const max = parsePriceInput(priceMax);
    return min === null || max === null || min > max;
  }, [priceFilterMode, priceMin, priceMax]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of CANONICAL_STATUSES) c[s] = 0;
    for (const r of rows) { const s = effOf(r); c[s] = (c[s] ?? 0) + 1; }
    return c;
  }, [rows]);

  // PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A: outlet options for the
  // "عرض حسب المنفذ" selector dropdown — derived from the SAME already-
  // filtered `rows` the table/outlet-grouped view render (no new fetch),
  // so the dropdown's item counts always match what's currently on screen.
  const outletOptions = useMemo(() => {
    const byPoint = new Map<string, { id: string; name: string; nameAr: string; count: number }>();
    for (const r of rows) {
      const dp = r.distribution_points;
      if (!dp) continue;
      if (!byPoint.has(dp.id)) byPoint.set(dp.id, { id: dp.id, name: dp.name, nameAr: dp.name_ar, count: 0 });
      byPoint.get(dp.id)!.count++;
    }
    return Array.from(byPoint.values()).sort((a, b) => (lang === 'ar' ? a.nameAr : a.name).localeCompare(lang === 'ar' ? b.nameAr : b.name));
  }, [rows, lang]);

  // AVAILABILITY-ALERTS-QR-POLISH-B: same-institution alerts, computed
  // client-side from the full (unfiltered) live rows already loaded above —
  // independent of the table's current search/status filter, since this is
  // a whole-organization summary, not a filtered view.
  const internalAlerts = useMemo(() => computeInternalAlerts(allRows), [allRows]);

  // UX-COMMAND-CENTER-SMART-A: Quick Actions — navigate via the existing
  // onNavigate screen-switch only, mirroring the sidebar/drawer's unconditional
  // visibility, except User Management which mirrors that screen's own
  // users.view/super_admin gate so the tile never offers an entry point the
  // destination screen would otherwise hide.
  // PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A: nav_reports removed
  // from this list too, for the same "mirrors sidebar/drawer visibility"
  // reason stated above — its route (screen 9) remains fully wired in
  // App.tsx, only every navigation entry point was hidden.
  const canSeeUsers = role === 'super_admin' || myPermissions.has('users.view');
  const quickActions: QuickAction[] = useMemo(() => {
    const actions: QuickAction[] = [
      { screen: 11, icon: 'institutions', labelKey: 'nav_institutions' },
      { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
      { screen: 6,  icon: 'qr', labelKey: 'nav_qr' },
      { screen: 15, icon: 'account', labelKey: 'nav_my_account' },
    ];
    if (canSeeUsers) actions.splice(1, 0, { screen: 14, icon: 'users', labelKey: 'nav_users' });
    return actions;
  }, [canSeeUsers]);

  // UX-COMMAND-CENTER-SMART-A: honest "recent activity" strip — reuses the
  // already-loaded live availability rows (no new Supabase read), sorted by
  // their real updated_at timestamp. Empty state shown when there is nothing
  // to report yet.
  const activityEntries: ActivityFeedEntry[] = useMemo(() => {
    return [...allRows]
      .filter(r => r.updated_at)
      .sort((a, b) => new Date(b.updated_at as string).getTime() - new Date(a.updated_at as string).getTime())
      .slice(0, 5)
      .map(r => ({
        id: r.id,
        title: (lang === 'ar' ? r.scientific_name : r.trade_name || r.scientific_name) || r.trade_name || r.scientific_name || '—',
        subtitle: `${dpNameOf(r, lang)} · ${t('cond_' + effOf(r), lang)}`,
        timestamp: formatStableDate(r.updated_at, lang),
      }));
  }, [allRows, lang]);

  const generatedAt = () => formatStableDateTime(new Date(), lang);

  const selectedFiltersText = useMemo(() => {
    const parts: string[] = [];
    if (filterStatus) parts.push(`${t('sc_effective_status', lang)}: ${t('cond_' + filterStatus, lang)}`);
    if (filterSupply) parts.push(`${t('avail_supply_type', lang)}: ${t('sc_supply_' + filterSupply, lang)}`);
    // UX-SMART-FILTERS-TIMELINE-A: reflect the smart-filter chips in the same
    // "selected filters" summary already shown on screen and in export/print
    // — exportCsv/printReport themselves are unchanged, they just read `rows`
    // (already smart-filtered above) and this text.
    if (quantityFilter === 'has_quantity') parts.push(t('sf_has_quantity', lang));
    if (quantityFilter === 'zero_quantity') parts.push(t('sf_zero_quantity', lang));
    if (recentOnly) parts.push(t('sf_recently_updated', lang));
    if (search.trim()) parts.push(`${t('search', lang)}: ${search.trim()}`);
    // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: reflect the price
    // filter in the same summary shown on screen and passed into export/print.
    if (priceFilterMode === 'no_entered_price') parts.push(t('sc_price_filter_no_entered', lang));
    else if (priceFilterMode === 'has_entered_price') parts.push(t('sc_price_filter_has_entered', lang));
    else if (priceFilterMode === 'entered_price_less_than') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_less_than', lang)} ${priceValue.trim()}`);
    else if (priceFilterMode === 'entered_price_greater_than') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_greater_than', lang)} ${priceValue.trim()}`);
    else if (priceFilterMode === 'entered_price_between') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_between', lang)} ${priceMin.trim()}–${priceMax.trim()}`);
    return parts.length ? parts.join(' · ') : t('sc_all', lang);
  }, [filterStatus, filterSupply, quantityFilter, recentOnly, search, priceFilterMode, priceValue, priceMin, priceMax, lang]);

  // UX-SMART-FILTERS-TIMELINE-A: smart-filter chip definitions — every chip
  // only toggles the client-side state above; no new reads, no backend calls.
  const smartFilterChips: SmartFilterChipItem[] = [
    {
      key: 'all', labelKey: 'sc_all', icon: 'search',
      active: filterStatus === '' && quantityFilter === 'all' && !recentOnly,
      onClick: () => { setFilterStatus(''); setQuantityFilter('all'); setRecentOnly(false); },
    },
    {
      key: 'available', labelKey: 'cond_available', icon: 'check',
      active: filterStatus === 'available',
      onClick: () => setFilterStatus(prev => (prev === 'available' ? '' : 'available')),
    },
    {
      key: 'low_stock', labelKey: 'cond_low_stock', icon: 'warning',
      active: filterStatus === 'low_stock',
      onClick: () => setFilterStatus(prev => (prev === 'low_stock' ? '' : 'low_stock')),
    },
    {
      key: 'missing', labelKey: 'cond_missing', icon: 'close',
      active: filterStatus === 'missing',
      onClick: () => setFilterStatus(prev => (prev === 'missing' ? '' : 'missing')),
    },
    {
      key: 'near_expiry', labelKey: 'cond_near_expiry', icon: 'clock',
      active: filterStatus === 'near_expiry',
      onClick: () => setFilterStatus(prev => (prev === 'near_expiry' ? '' : 'near_expiry')),
    },
    {
      key: 'expired', labelKey: 'cond_expired', icon: 'ban',
      active: filterStatus === 'expired',
      onClick: () => setFilterStatus(prev => (prev === 'expired' ? '' : 'expired')),
    },
    {
      key: 'has_quantity', labelKey: 'sf_has_quantity', icon: 'package',
      active: quantityFilter === 'has_quantity',
      onClick: () => setQuantityFilter(prev => (prev === 'has_quantity' ? 'all' : 'has_quantity')),
    },
    {
      key: 'zero_quantity', labelKey: 'sf_zero_quantity', icon: 'info',
      active: quantityFilter === 'zero_quantity',
      onClick: () => setQuantityFilter(prev => (prev === 'zero_quantity' ? 'all' : 'zero_quantity')),
    },
    {
      key: 'recently_updated', labelKey: 'sf_recently_updated', icon: 'refresh',
      active: recentOnly,
      onClick: () => setRecentOnly(prev => !prev),
    },
  ];

  // ── Column definitions shared by table / print / CSV ──
  const columns: { key: string; label: string; value: (r: LiveAvailRow) => string }[] = [
    { key: 'org',     label: t('sc_lm_org', lang),          value: () => orgName || '—' },
    { key: 'port',    label: t('sc_lm_port', lang),         value: r => dpNameOf(r, lang) },
    { key: 'sci',     label: t('avail_scientific_name', lang), value: r => r.scientific_name || '—' },
    { key: 'trade',   label: t('avail_trade_name', lang),   value: r => r.trade_name || '—' },
    { key: 'conc',    label: t('avail_concentration', lang),value: r => r.concentration || '—' },
    { key: 'dosage',  label: t('avail_dosage_form', lang),  value: r => r.dosage_form || '—' },
    { key: 'qty',     label: t('qty', lang),                value: r => String(r.quantity ?? 0) },
    { key: 'price',   label: t('sc_entered_price', lang),   value: r => priceDisplay(r.price) },
    { key: 'supply',  label: t('avail_supply_type', lang),  value: r => r.supply_type || '—' },
    { key: 'raw',     label: t('sc_raw_condition', lang),   value: r => r.condition ? t('cond_' + r.condition, lang) : '—' },
    { key: 'eff',     label: t('sc_effective_status', lang),value: r => t('cond_' + effOf(r), lang) },
    { key: 'expiry',  label: t('expiry', lang),             value: r => expiryDisplay(r, lang) },
    { key: 'bucket',  label: t('sc_expiry_bucket', lang),   value: r => r.expiry_bucket || '—' },
    { key: 'updated', label: t('last_upd', lang),    value: r => formatStableDate(r.updated_at, lang) },
  ];

  function buildReportHtml(): string {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const countsLine = CANONICAL_STATUSES.map(s => `${t('cond_' + s, lang)}: ${counts[s]}`).join(' · ');
    const headCells = columns.map(c => `<th>${escHtml(c.label)}</th>`).join('');
    const bodyRows = rows.map(r =>
      '<tr>' + columns.map(c => `<td${LTR_COLUMN_KEYS.has(c.key) ? ' dir="ltr"' : ''}>${escHtml(c.value(r))}</td>`).join('') + '</tr>'
    ).join('');
    return `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8">
<title>${escHtml(t('sc_report_title', lang))}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: ${lang === 'ar' ? "'Segoe UI', Tahoma, Arial" : 'Arial, sans-serif'}; color: #111; direction: ${dir}; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .brand { font-size: 11px; color: #555; margin-bottom: 10px; }
  .meta { font-size: 11px; color: #333; margin: 2px 0; }
  .meta .val { unicode-bidi: isolate; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 10.5px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: ${lang === 'ar' ? 'right' : 'left'}; white-space: nowrap; }
  th { background: #eee; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
</style></head><body>
  <h1>${escHtml(t('sc_report_title', lang))}</h1>
  <div class="brand">MediStock-Babil / MASAR Health Network</div>
  ${orgName ? `<div class="meta">${escHtml(t('sc_lm_org', lang))}: ${escHtml(orgName)}</div>` : ''}
  <div class="meta">${escHtml(t('sc_selected_filters', lang))}: ${escHtml(selectedFiltersText)}</div>
  <div class="meta">${escHtml(t('sc_generated_at', lang))}: <span class="val" dir="ltr">${escHtml(generatedAt())}</span></div>
  <div class="meta">${escHtml(t('sc_total_rows', lang))}: ${rows.length}</div>
  <div class="meta">${escHtml(countsLine)}</div>
  <div class="footer">${escHtml(t('report_footer_generated_by', lang))}</div>
  <table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>
</body></html>`;
  }

  function printReport() {
    if (rows.length === 0) return;
    // BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A: mobile/PWA/webview contexts
    // route to the in-app fallback modal instead of window.open/window.print
    // — those can switch to a native print UI or open an external tab,
    // making the app appear to exit. Desktop keeps the original popup flow.
    if (isLikelyMobilePrintContext()) {
      setMobilePrintHtml(buildReportHtml());
      return;
    }
    const win = window.open('', '_blank');
    if (!win) {
      setMovementToast(t('print_popup_blocked', lang));
      setTimeout(() => setMovementToast(null), 3000);
      return;
    }
    win.document.write(buildReportHtml());
    win.document.close();
    win.focus();
    win.print();
    win.close();
  }

  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: replaces the previous hand-rolled CSV
  // export with a real, styled `.xlsx` workbook (Summary / Availability
  // Export / Data Dictionary sheets) via exportAvailabilityXlsx. Same button
  // location, same user flow, same `rows` (i.e. the same filters currently
  // applied on screen — status/supply/smart-filter chips/search) as the old
  // exportCsv — the ONLY additional exclusion is removed_at rows, which the
  // on-screen table itself intentionally does NOT filter (operations/
  // reactivation context), but which must never appear in this "live/current"
  // export. Genuine missing rows (removed_at null) are unaffected and remain
  // included, exactly like every other still-open shortage.
  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try {
      const exportRows: AvailabilityExportRow[] = rows
        .filter(r => r.removed_at == null)
        .map((r, i) => {
          const status = effOf(r);
          const tier = getExpiryRiskTier(r.expiry_date);
          return {
            no: i + 1,
            institution: orgName || '—',
            outlet: dpNameOf(r, lang),
            scientificName: r.scientific_name || '—',
            tradeName: r.trade_name || '—',
            dosageForm: r.dosage_form || '—',
            concentration: r.concentration || '—',
            batchNumber: r.batch_number || '—',
            quantity: r.quantity ?? 0,
            // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: the same
            // user-entered row.price already used for the on-screen column
            // above — never calculated/inferred/overwritten. `rows` is
            // already fully filtered (status/supply/search/quantity/smart
            // filters AND the new price filter), so exportXlsx exports
            // exactly what is currently on screen, same as every other field.
            enteredPrice: typeof r.price === 'number' ? r.price : null,
            conditionKey: status,
            conditionLabel: AVAIL_EXPORT_CONDITION_LABELS[status] ?? status,
            expiryDate: r.expiry_date ? new Date(r.expiry_date) : null,
            daysToExpiry: daysUntilExpiry(r.expiry_date),
            expiryRiskLabel: `${getExpiryRiskLabel(tier, 'en')} / ${getExpiryRiskLabel(tier, 'ar')}`,
            lastUpdatedBy: r.actor_name_snapshot || '—',
            lastUpdatedAt: r.updated_at ? new Date(r.updated_at) : null,
            notes: r.notes || '—',
          };
        });

      const safeOrg = orgName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
      const ok = await exportAvailabilityXlsx({
        reportTitle: t('sc_report_title', lang),
        generatedAt: new Date(),
        lang,
        fileNameBase: `medistock-status${safeOrg ? '-' + safeOrg : ''}`,
        filtersSummary: selectedFiltersText,
        footerText: t('report_footer_generated_by', lang),
        emptyMessage: t('se_no_records', lang),
        conditionLabels: AVAIL_EXPORT_CONDITION_LABELS,
        rows: exportRows,
      });
      if (!ok) {
        setMovementToast(t('csv_export_failed', lang));
        setTimeout(() => setMovementToast(null), 3000);
      }
    } catch {
      setMovementToast(t('csv_export_failed', lang));
      setTimeout(() => setMovementToast(null), 3000);
    } finally {
      setXlsxBusy(false);
    }
  }

  // CANONICAL-STOCK-CUTOVER: a correction now lands on a canonical outlet_stock
  // lot via the guarded RPC (migration 086); this only reloads the read
  // projection so the aggregate reflects the corrected lot. (Name kept as the
  // post-correction success handler / structural anchor.)
  function handleMovementSuccess() {
    setMovementToast(t('mvmt_success', lang));
    setTimeout(() => setMovementToast(null), 3000);
    live.reload();
  }

  // PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A: reloads the same live
  // availability data source used everywhere else on this screen — the
  // reactivated row's removed_at is now null, so it naturally loses the
  // Removed badge and becomes eligible for every live/current view (which
  // filter on removed_at independently at their own read layer) without any
  // extra wiring here.
  function handleReactivateSuccess() {
    setMovementToast(t('sc_reactivate_success', lang));
    setTimeout(() => setMovementToast(null), 3000);
    live.reload();
  }

  const btnStyle = {
    padding: '9px 14px', minHeight: '38px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)',
    background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
  } as const;

  const th = { textAlign: 'start' as const, padding: '8px 8px', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
  const td = { padding: '7px 8px', fontSize: '11.5px', borderBottom: '1px solid var(--brd)', whiteSpace: 'nowrap' as const };

  return (
    <div className="nexus-status-center" style={{ maxWidth: '1200px', animation: 'fs .3s ease' }}>
      {/* Header */}
      <div className="nexus-sc-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('nav_status_center', lang)}
          </h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('sc_report_sub', lang)}</p>
        </div>
        <PhoenixOrgScope />
      </div>

      {/* PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A: top-level tab bar
          — 'live' renders the exact same, unmodified content that already
          existed below (availability filters/table/outlet view/exports/
          movement report); 'audit' renders the reusable read-only
          AuditLogSection. Purely a display switch — no data/filter changes. */}
      <div className="nexus-sc-tabs" style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
        <button
          className="nexus-sc-tab"
          data-active={mainTab === 'live'}
          onClick={() => setMainTab('live')}
          style={{ ...btnStyle, padding: '7px 14px', background: mainTab === 'live' ? 'var(--p2)' : 'var(--s)', color: mainTab === 'live' ? 'var(--pd)' : 'var(--t)' }}
        >
          <PhoenixIcon name="clipboard" size={14} inline /> {t('nav_status_center', lang)}
        </button>
        <button
          className="nexus-sc-tab"
          data-active={mainTab === 'audit'}
          onClick={() => setMainTab('audit')}
          style={{ ...btnStyle, padding: '7px 14px', background: mainTab === 'audit' ? 'var(--p2)' : 'var(--s)', color: mainTab === 'audit' ? 'var(--pd)' : 'var(--t)' }}
        >
          <PhoenixIcon name="file" size={14} inline /> {t('tab_audit', lang)}
        </button>
      </div>

      {mainTab === 'audit' && <AuditLogSection />}

      {mainTab === 'live' && (
      <>
      {/* Quick Actions — UX-COMMAND-CENTER-SMART-A */}
      <div style={{ marginBottom: '16px' }}>
        <h3 className="premium-section-header" style={{ fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>{t('quick', lang)}</h3>
        <p style={{ fontSize: '11px', color: 'var(--t2)', marginBottom: '10px' }}>{t('cc_quick_actions_sub', lang)}</p>
        <QuickActionGrid actions={quickActions} onNavigate={onNavigate} />
      </div>

      {/* Notice: reporting only — no auto-transfer (safety disclaimer) */}
      <div className="nexus-sc-notice" style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <PhoenixIcon name="info" size={15} inline /> {t('sc_no_exchange', lang)}
      </div>

      {/* Report header card (printable info) */}
      <PhoenixCard className="nexus-sc-summary-card" padding="16px" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '16px', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: '6px' }}><PhoenixIcon name="clipboard" size={16} inline /> {t('sc_report_title', lang)}</span>
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--ok)', background: 'var(--ok2)', border: '1px solid var(--ok)', borderRadius: 'var(--rpill)', padding: '1px 8px' }}>LIVE</span>
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          {orgName && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><PhoenixIcon name="hospital" size={13} inline /> {orgName}</span>}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><PhoenixIcon name="clock" size={13} inline /> {t('sc_generated_at', lang)}: {generatedAt()}</span>
          <span>Σ {t('sc_total_rows', lang)}: {rows.length}</span>
        </div>
        {/* Counts by status */}
        <div className="nexus-sc-status-counts" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
          {CANONICAL_STATUSES.map(s => (
            <div key={s} className={`nexus-sc-status-chip nexus-sc-status-chip--${s}`} style={{ flex: '1 1 90px', minWidth: '90px', background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '8px 10px' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, lineHeight: 1 }}>{counts[s]}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('cond_' + s, lang)}</div>
            </div>
          ))}
        </div>
      </PhoenixCard>

      {/* AVAILABILITY-ALERTS-QR-POLISH-B: internal (same-institution) alerts —
          read-only, computed client-side from the rows already loaded above. */}
      {!live.loading && !live.error && <InternalAlertsSection matches={internalAlerts} />}

      {/* Recent Activity — UX-COMMAND-CENTER-SMART-A, real data only */}
      <div style={{ marginBottom: '16px' }}>
        <h3 className="premium-section-header" style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{t('cc_activity_title', lang)}</h3>
        {!live.loading && !live.error && <CommandCenterActivityFeed entries={activityEntries} />}
      </div>

      {/* Filters + export/print actions */}
      <PhoenixCard className="nexus-sc-filter-card" padding="14px" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as CanonicalStatus | '')} style={{ ...fieldStyle, minWidth: '150px', appearance: 'none', cursor: 'pointer' }} aria-label={t('sc_effective_status', lang)}>
            <option value="">{t('sc_all_statuses', lang)}</option>
            {CANONICAL_STATUSES.map(s => <option key={s} value={s}>{t('cond_' + s, lang)}</option>)}
          </select>

          <select value={filterSupply} onChange={e => setFilterSupply(e.target.value as SupplyCategory | '')} style={{ ...fieldStyle, minWidth: '150px', appearance: 'none', cursor: 'pointer' }} aria-label={t('avail_supply_type', lang)}>
            <option value="">{t('sc_all_supply_types', lang)}</option>
            {SUPPLY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{t(c.labelKey, lang)}</option>)}
          </select>

          <input type="search" dir="auto" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('search', lang)} style={{ ...fieldStyle, flex: 1, minWidth: '150px' }} aria-label={t('search', lang)} />

          <div className="premium-action-bar" style={{ display: 'flex', gap: '6px', marginInlineStart: 'auto', flexWrap: 'wrap' }}>
            <button onClick={exportXlsx} disabled={rows.length === 0 || xlsxBusy} aria-label={t('sc_export_excel', lang)} style={btnStyle}><PhoenixIcon name="reports" size={14} inline /> {t('sc_export_excel', lang)}</button>
            <button onClick={printReport} disabled={rows.length === 0} aria-label={t('sc_print_report', lang)} style={btnStyle}><PhoenixIcon name="print" size={14} inline /> {t('sc_print_report', lang)}</button>
            <button onClick={printReport} disabled={rows.length === 0} aria-label={t('sc_print_pdf', lang)} style={btnStyle}><PhoenixIcon name="file" size={14} inline /> {t('sc_print_pdf', lang)}</button>
          </div>
        </div>

        {/* Smart filter chips — UX-SMART-FILTERS-TIMELINE-A. Combine safely
            with the dropdowns/search above: every chip only sets the same
            client-side state, all applied together in the `rows` memo. */}
        <div style={{ marginTop: '12px' }}>
          <SmartFilterChips items={smartFilterChips} ariaLabel={t('sf_group_label', lang)} />
        </div>

        {/* AVAILABILITY-ALERTS-QR-POLISH-B: table / outlet-grouped view toggle —
            both modes render the exact same filtered `rows`; export/print
            always use the table's column definitions regardless of view mode. */}
        <div className="nexus-sc-view-toggle" style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
          <button
            data-active={viewMode === 'table'}
            onClick={() => setViewMode('table')}
            style={{ ...btnStyle, padding: '5px 12px', background: viewMode === 'table' ? 'var(--p2)' : 'var(--s)', color: viewMode === 'table' ? 'var(--pd)' : 'var(--t)' }}
          >
            <PhoenixIcon name="clipboard" size={14} inline /> {t('sc_view_table', lang)}
          </button>
          <button
            data-active={viewMode === 'outlet'}
            onClick={() => setViewMode('outlet')}
            style={{ ...btnStyle, padding: '5px 12px', background: viewMode === 'outlet' ? 'var(--p2)' : 'var(--s)', color: viewMode === 'outlet' ? 'var(--pd)' : 'var(--t)' }}
          >
            <PhoenixIcon name="outlet" size={14} inline /> {t('sc_view_outlet', lang)}
          </button>
        </div>

        {/* PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A: outlet selector — only
            shown in outlet-grouped view, purely additive to it (the existing
            OutletMaterialGroups card grid below keeps working unchanged).
            Selecting an outlet opens the read-only report modal; the select
            itself always resets to the placeholder afterward (it's a picker,
            not a persistent filter). */}
        {viewMode === 'outlet' && (
          <div style={{ marginTop: '10px' }}>
            <select
              value=""
              onChange={e => {
                const id = e.target.value;
                if (!id) return;
                const o = outletOptions.find(x => x.id === id);
                if (o) setReportOutlet({ id: o.id, name: o.name, nameAr: o.nameAr });
              }}
              style={{ ...fieldStyle, minWidth: '220px', appearance: 'none', cursor: 'pointer' }}
              aria-label={t('sc_outlet_report_select', lang)}
            >
              <option value="">{t('sc_outlet_report_select', lang)}</option>
              {outletOptions.map(o => (
                <option key={o.id} value={o.id}>
                  {(lang === 'ar' ? o.nameAr : o.name) || '—'} ({o.count} {t('sc_outlet_items_count', lang)})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Supply-type quick chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
          <button onClick={() => setFilterSupply('')} style={{ ...btnStyle, padding: '5px 12px', background: filterSupply === '' ? 'var(--p2)' : 'var(--s)', color: filterSupply === '' ? 'var(--pd)' : 'var(--t)' }}>{t('sc_all_supply_types', lang)}</button>
          {SUPPLY_CATEGORIES.map(c => (
            <button key={c.value} onClick={() => setFilterSupply(c.value)} style={{ ...btnStyle, padding: '5px 12px', background: filterSupply === c.value ? 'var(--p2)' : 'var(--s)', color: filterSupply === c.value ? 'var(--pd)' : 'var(--t)' }}>
              {t(c.labelKey, lang)}
            </button>
          ))}
        </div>

        {/* PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: entered-price
            filter — combines with every filter above via AND logic in the
            `rows` memo. */}
        <div style={{ marginTop: '10px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
            <select
              value={priceFilterMode}
              onChange={e => setPriceFilterMode(e.target.value as PriceFilterMode)}
              style={{ ...fieldStyle, minWidth: '170px', appearance: 'none', cursor: 'pointer' }}
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
              <input
                type="number" min="0" step="0.01" dir="ltr"
                value={priceValue}
                onChange={e => setPriceValue(e.target.value)}
                placeholder={t('sc_price_value_ph', lang)}
                aria-label={t('sc_price_value_ph', lang)}
                style={{ ...fieldStyle, minWidth: '120px' }}
              />
            )}

            {priceFilterMode === 'entered_price_between' && (
              <>
                <input
                  type="number" min="0" step="0.01" dir="ltr"
                  value={priceMin}
                  onChange={e => setPriceMin(e.target.value)}
                  placeholder={t('sc_price_min_ph', lang)}
                  aria-label={t('sc_price_min_ph', lang)}
                  style={{ ...fieldStyle, minWidth: '100px' }}
                />
                <input
                  type="number" min="0" step="0.01" dir="ltr"
                  value={priceMax}
                  onChange={e => setPriceMax(e.target.value)}
                  placeholder={t('sc_price_max_ph', lang)}
                  aria-label={t('sc_price_max_ph', lang)}
                  style={{ ...fieldStyle, minWidth: '100px' }}
                />
              </>
            )}
          </div>
          {priceValueInvalid && (
            <div style={{ fontSize: '11px', color: 'var(--err)', marginTop: '6px' }}>{t('sc_price_invalid', lang)}</div>
          )}
          {priceRangeInvalid && (
            <div style={{ fontSize: '11px', color: 'var(--err)', marginTop: '6px' }}>{t('sc_price_range_invalid', lang)}</div>
          )}
        </div>

        <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '10px' }}>
          {t('sc_selected_filters', lang)}: {selectedFiltersText}
        </div>
      </PhoenixCard>

      {/* Report table */}
      {live.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!live.loading && live.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={live.error} onRetry={live.reload} />
      )}
      {!live.loading && !live.error && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--t2)', fontSize: '13px' }}>
          {allRows.length === 0 ? t('sc_live_empty', lang) : t('sc_no_match', lang)}
        </div>
      )}
      {!live.loading && !live.error && rows.length > 0 && viewMode === 'outlet' && (
        <OutletMaterialGroups rows={rows} />
      )}
      {!live.loading && !live.error && rows.length > 0 && viewMode === 'table' && (
        <div className="nexus-sc-table-wrap" style={{ overflowX: 'auto' }}>
          <table className="nexus-sc-table" style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--s)', borderRadius: 'var(--r2)' }}>
            <thead>
              <tr>
                <th style={th}>{t('sc_lm_port', lang)}</th>
                <th style={th}>{t('avail_scientific_name', lang)}</th>
                <th style={th}>{t('avail_trade_name', lang)}</th>
                <th style={th}>{t('avail_concentration', lang)}</th>
                <th style={th}>{t('avail_dosage_form', lang)}</th>
                <th style={th}>{t('qty', lang)}</th>
                <th style={th}>{t('sc_entered_price', lang)}</th>
                <th style={th}>{t('avail_supply_type', lang)}</th>
                <th style={th}>{t('sc_raw_condition', lang)}</th>
                <th style={th}>{t('sc_effective_status', lang)}</th>
                <th style={th}>{t('sc_removed_badge', lang)}</th>
                <th style={th}>{t('expiry', lang)}</th>
                <th style={th}>{t('last_upd', lang)}</th>
                {(canCorrectStock || canReactivate || canViewMovementHistory) && <th style={th}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const eff = effOf(r);
                const isRemoved = r.removed_at != null;
                return (
                  <tr key={r.id} className={`nexus-sc-row nexus-sc-row--${eff}${isRemoved ? ' nexus-sc-row--removed' : ''}`}>
                    <td style={td} dir="auto">{dpNameOf(r, lang)}</td>
                    <td style={td} dir="auto">{r.scientific_name || '—'}</td>
                    <td style={td} dir="auto">{r.trade_name || '—'}</td>
                    <td style={td} dir="auto">{r.concentration || '—'}</td>
                    <td style={td} dir="auto">{r.dosage_form || '—'}</td>
                    <td style={td}>{r.quantity}</td>
                    <td style={td} dir="ltr">{priceDisplay(r.price)}</td>
                    <td style={td} dir="auto">{r.supply_type || '—'}</td>
                    <td style={td}>{r.condition ? t('cond_' + r.condition, lang) : '—'}</td>
                    <td style={td}><PhoenixStatusBadge variant={CANON_VARIANT[eff] ?? 'neutral'} label={t('cond_' + eff, lang)} /></td>
                    <td style={td}>
                      {/* PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A: removed-row
                          marker — badge + compact, safe removal details. Never
                          shows removed_by's raw uuid; actor_name_snapshot is the
                          only "who" field surfaced, as an already-resolved
                          display name. */}
                      {isRemoved ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <PhoenixStatusBadge variant="err" icon="ban" label={t('sc_removed_badge', lang)} />
                          <span style={{ fontSize: '10px', color: 'var(--t2)' }} dir="auto">
                            {removalReasonLabel(r.removal_reason, lang)}
                          </span>
                          <span style={{ fontSize: '10px', color: 'var(--t2)' }} dir="ltr">
                            {t('sc_removed_at_label', lang)}: {formatStableDate(r.removed_at, lang)}
                          </span>
                          {r.actor_name_snapshot && (
                            <span style={{ fontSize: '10px', color: 'var(--t2)' }} dir="auto">
                              {t('sc_last_action_by', lang)}: {r.actor_name_snapshot}
                            </span>
                          )}
                        </div>
                      ) : '—'}
                    </td>
                    <td style={td} dir="ltr">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                        <span>{expiryDisplay(r, lang)}</span>
                        <ExpiryRiskBadge expiryDate={r.expiry_date} lang={lang} />
                      </div>
                    </td>
                    <td style={td} dir="ltr">{formatStableDate(r.updated_at, lang)}</td>
                    {(canCorrectStock || canReactivate || canViewMovementHistory) && (
                      <td style={td}>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'nowrap' }}>
                          {/* PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A: a
                              removed row offers Reactivate INSTEAD of Adjust
                              Quantity — adjusting quantity alone would never
                              clear removed_at (only reason='removed_from_outlet'
                              or phoenix_upsert_availability's v_reactivates
                              branch do), which would leave a confusing
                              quantity>0-but-still-hidden row. */}
                          {isRemoved ? (
                            canReactivate && (
                              <button
                                className="nexus-sc-action nexus-sc-action--reactivate"
                                onClick={() => setReactivateRow(r as unknown as ReactivateRow)}
                                aria-label={t('sc_reactivate_action', lang)}
                                style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--ok)', background: 'var(--s)', color: 'var(--ok)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                              >
                                ↩ {t('sc_reactivate_action', lang)}
                              </button>
                            )
                          ) : (
                            canCorrectStock && (
                              <button
                                className="nexus-sc-action nexus-sc-action--correct"
                                onClick={() => setCorrectRow(r as unknown as AvailabilityCorrectionRow)}
                                aria-label={t('sc_correct_stock_action', lang)}
                                style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                              >
                                <PhoenixIcon name="editor" size={12} inline /> {t('sc_correct_stock_action', lang)}
                              </button>
                            )
                          )}
                          {canViewMovementHistory && (
                            <button
                              className="nexus-sc-action nexus-sc-action--history"
                              onClick={() => setHistoryRow(r)}
                              aria-label={t('mvmt_history_action', lang)}
                              style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            >
                              <PhoenixIcon name="clock" size={12} inline /> {t('mvmt_history_action', lang)}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AvailabilityStockCorrectionModal
        open={correctRow !== null}
        row={correctRow}
        orgId={effectiveOrgId ?? null}
        lang={lang}
        onClose={() => setCorrectRow(null)}
        onCorrected={handleMovementSuccess}
      />
      <ReactivateMaterialModal
        open={reactivateRow !== null}
        row={reactivateRow}
        lang={lang}
        myPermissions={myPermissions}
        onClose={() => setReactivateRow(null)}
        onSuccess={handleReactivateSuccess}
      />
      <MovementHistoryModal
        open={historyRow !== null}
        row={historyRow}
        lang={lang}
        onClose={() => setHistoryRow(null)}
      />
      <OutletAvailabilityReportModal
        open={reportOutlet !== null}
        onClose={() => setReportOutlet(null)}
        outletId={reportOutlet?.id ?? null}
        outletName={reportOutlet ? (lang === 'ar' ? (reportOutlet.nameAr || reportOutlet.name) : (reportOutlet.name || reportOutlet.nameAr)) : ''}
        institutionName={orgName}
        lang={lang}
        rows={rows}
      />
      {movementToast && <PhoenixToast message={movementToast} />}
      <MobilePrintFallbackModal
        open={mobilePrintHtml !== null}
        html={mobilePrintHtml ?? ''}
        title={t('sc_report_title', lang)}
        fileNameBase={`medistock-status${orgName ? '-' + orgName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) : ''}`}
        lang={lang}
        onClose={() => setMobilePrintHtml(null)}
      />

      {/* AVAILABILITY-MOVEMENT-REPORTS-PRINT-A: read-only, filterable
          quantity-movement report — hides itself when the caller lacks
          availability.movements.view (RLS remains the real enforcement). */}
      <MovementReportSection />

      {/* Inventory Intelligence (migration 072 · INVENTORY-INTELLIGENCE-FRONTEND-A):
          read-only signals/alerts + recommendation-only transfer suggestions
          (no Accept, no stock movement) + permission-gated threshold management.
          Hides itself when the caller lacks inventory.view_signals; RLS + the
          SECURITY DEFINER RPCs remain the real enforcement. */}
      <div style={{ marginTop: '28px' }}>
        <InventoryIntelligencePanel />
      </div>

      {/* Material Exchange Command Center CTA */}
      <div className="nexus-sc-exchange-cta" style={{ marginTop: '28px', background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)', padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--pd)', display: 'flex', alignItems: 'center', gap: '6px' }}><PhoenixIcon name="refresh" size={15} inline /> {t('material_exchange_center', lang)}</div>
          <div style={{ fontSize: '12px', color: 'var(--pd)', marginTop: '3px', opacity: 0.85 }}>{t('duplicate_exchange_moved_notice', lang)}</div>
        </div>
        <button
          onClick={() => onNavigate(13)}
          style={{ padding: '8px 16px', borderRadius: 'var(--r2)', border: 'none', background: 'var(--p)', color: 'white', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          {t('open_exchange_center', lang)} →
        </button>
      </div>
      </>
      )}
    </div>
  );
}
