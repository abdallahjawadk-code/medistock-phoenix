/**
 * RAC-3 — pure derivation over the RAC-2 Command Center contract.
 *
 * Every function here reads ONLY what Migration 199 actually returned. There
 * is no fallback number, no invented denominator and no cross-scope maths: a
 * field the contract did not send stays absent, and `null` is never silently
 * turned into `0`. The screen renders what the server authorized and nothing
 * else.
 */
import type {
  CommandCenterAvailabilitySummary,
  CommandCenterCapabilities,
  CommandCenterReadContract,
  CommandCenterScopeKind,
  CommandCenterStockSummary,
} from '@/shared/supabase/services/command-center.service';

/**
 * The contract sends ONE of two summary shapes, chosen server-side by scope:
 * organization/global scope counts `item_availability` rows by condition;
 * warehouse/outlet scope counts stock lines. They share no field, so the
 * discriminator is the scope kind the server itself reported — never a guess
 * from which keys happen to be present.
 */
export function isAvailabilityScope(kind: CommandCenterScopeKind): boolean {
  return kind === 'global' || kind === 'organization';
}

export function availabilitySummary(
  contract: CommandCenterReadContract,
): CommandCenterAvailabilitySummary | null {
  return isAvailabilityScope(contract.scope.kind)
    ? (contract.summary as CommandCenterAvailabilitySummary)
    : null;
}

export function stockSummary(
  contract: CommandCenterReadContract,
): CommandCenterStockSummary | null {
  return isAvailabilityScope(contract.scope.kind)
    ? null
    : (contract.summary as CommandCenterStockSummary);
}

/** A single KPI tile, already resolved to real values and an i18n label key. */
export interface CommandCenterKpi {
  id: string;
  labelKey: string;
  /**
   * `null` means the contract did not carry this figure. The card renders an
   * explicit "not reported" dash — it must never be displayed as zero, which
   * would assert a measurement the server never made.
   */
  value: number | null;
  icon: string;
  tone: 'neutral' | 'ok' | 'warn' | 'err';
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * The KPI row for the scope the server actually answered at.
 *
 * Order is operational, not alphabetical: the states that demand action come
 * before the states that merely describe volume.
 */
export function deriveKpis(contract: CommandCenterReadContract): CommandCenterKpi[] {
  const a = availabilitySummary(contract);
  if (a) {
    return [
      { id: 'expired', labelKey: 'rac3_kpi_expired', value: num(a.expired), icon: 'ban', tone: 'err' },
      { id: 'near_expiry', labelKey: 'rac3_kpi_near_expiry', value: num(a.near_expiry), icon: 'clock', tone: 'warn' },
      { id: 'missing', labelKey: 'rac3_kpi_missing', value: num(a.missing), icon: 'warning', tone: 'err' },
      { id: 'low_stock', labelKey: 'rac3_kpi_low_stock', value: num(a.low_stock), icon: 'package', tone: 'warn' },
      { id: 'available', labelKey: 'rac3_kpi_available', value: num(a.available), icon: 'check', tone: 'ok' },
      { id: 'surplus', labelKey: 'rac3_kpi_surplus', value: num(a.surplus), icon: 'recycle', tone: 'neutral' },
      { id: 'rows', labelKey: 'rac3_kpi_rows', value: num(a.availability_rows), icon: 'clipboard', tone: 'neutral' },
      { id: 'units', labelKey: 'rac3_kpi_units', value: num(a.quantity_units), icon: 'warehouse', tone: 'neutral' },
    ];
  }

  const s = stockSummary(contract);
  if (!s) return [];
  return [
    { id: 'expired_lines', labelKey: 'rac3_kpi_expired_lines', value: num(s.expired_lines), icon: 'ban', tone: 'err' },
    { id: 'near_expiry_lines', labelKey: 'rac3_kpi_near_expiry_lines', value: num(s.near_expiry_lines), icon: 'clock', tone: 'warn' },
    { id: 'zero_available', labelKey: 'rac3_kpi_zero_available', value: num(s.zero_available_lines), icon: 'warning', tone: 'warn' },
    { id: 'stock_lines', labelKey: 'rac3_kpi_stock_lines', value: num(s.stock_lines), icon: 'clipboard', tone: 'neutral' },
    { id: 'available_units', labelKey: 'rac3_kpi_available_units', value: num(s.available_units), icon: 'check', tone: 'ok' },
    { id: 'on_hand_units', labelKey: 'rac3_kpi_on_hand_units', value: num(s.on_hand_units), icon: 'warehouse', tone: 'neutral' },
  ];
}

/** One slice of the stock-health distribution. */
export interface StockHealthSlice {
  id: string;
  labelKey: string;
  value: number;
  color: string;
}

type SliceSeed = [string, string, number | null, string];

function availabilitySeeds(a: CommandCenterAvailabilitySummary): SliceSeed[] {
  return [
    ['available', 'rac3_state_available', num(a.available), 'var(--ok)'],
    ['low_stock', 'rac3_state_low_stock', num(a.low_stock), 'var(--warn)'],
    ['near_expiry', 'rac3_state_near_expiry', num(a.near_expiry), 'var(--gold)'],
    ['expired', 'rac3_state_expired', num(a.expired), 'var(--err)'],
    ['missing', 'rac3_state_missing', num(a.missing), 'var(--ember)'],
    ['surplus', 'rac3_state_surplus', num(a.surplus), 'var(--info)'],
  ];
}

function stockSeeds(s: CommandCenterStockSummary): SliceSeed[] {
  const lines = num(s.stock_lines);
  const zero = num(s.zero_available_lines);
  const expired = num(s.expired_lines);
  const near = num(s.near_expiry_lines);
  // A warehouse/outlet payload reports no positive "healthy" bucket, so it is
  // DERIVED only when every term needed to subtract is present — otherwise the
  // slice is omitted rather than guessed.
  const healthy =
    lines !== null && zero !== null && expired !== null && near !== null
      ? Math.max(0, lines - zero - expired - near)
      : null;
  return [
    ['healthy_lines', 'rac3_state_healthy_lines', healthy, 'var(--ok)'],
    ['near_expiry', 'rac3_state_near_expiry', near, 'var(--gold)'],
    ['expired', 'rac3_state_expired', expired, 'var(--err)'],
    ['zero_available', 'rac3_state_zero_available', zero, 'var(--ember)'],
  ];
}

/**
 * The distribution behind the stock-health figure.
 *
 * Only conditions the contract actually reported become slices, and the total
 * is the sum of exactly those slices — never a separately-reported row count,
 * which would silently introduce an "other" remainder the server never
 * described. An all-zero payload yields an empty list, which the panel renders
 * as its honest empty state instead of an empty ring.
 */
export function deriveStockHealth(contract: CommandCenterReadContract): StockHealthSlice[] {
  const a = availabilitySummary(contract);
  const s = stockSummary(contract);
  const seeds: SliceSeed[] = a ? availabilitySeeds(a) : s ? stockSeeds(s) : [];

  return seeds
    .filter((row): row is [string, string, number, string] => row[2] !== null && row[2] > 0)
    .map(([id, labelKey, value, color]) => ({ id, labelKey, value, color }));
}

/** A critical signal derived from the authorized payload — never a new query. */
export interface CriticalSignal {
  id: string;
  labelKey: string;
  value: number;
  tone: 'warn' | 'err';
}

/**
 * The operational signals that deserve attention above the fold.
 *
 * These are NOT the inter-organization alert inbox — that surface keeps its own
 * canonical screen and its own authorization, and RAC-3 widens no query to
 * reach it. These are the urgent states already present in the authorized
 * Command Center payload, surfaced where an operator will see them first. A
 * signal with a zero or absent count is omitted rather than shown as "0
 * critical", which would read as reassurance the data does not support.
 */
export function deriveCriticalSignals(contract: CommandCenterReadContract): CriticalSignal[] {
  const a = availabilitySummary(contract);
  const s = stockSummary(contract);
  const seeds: Array<[string, string, number | null, 'warn' | 'err']> = a
    ? [
        ['expired', 'rac3_signal_expired', num(a.expired), 'err'],
        ['missing', 'rac3_signal_missing', num(a.missing), 'err'],
        ['near_expiry', 'rac3_signal_near_expiry', num(a.near_expiry), 'warn'],
        ['low_stock', 'rac3_signal_low_stock', num(a.low_stock), 'warn'],
      ]
    : s
      ? [
          ['expired_lines', 'rac3_signal_expired_lines', num(s.expired_lines), 'err'],
          ['zero_available', 'rac3_signal_zero_available', num(s.zero_available_lines), 'err'],
          ['near_expiry_lines', 'rac3_signal_near_expiry_lines', num(s.near_expiry_lines), 'warn'],
        ]
      : [];

  return seeds
    .filter((row): row is [string, string, number, 'warn' | 'err'] => row[2] !== null && row[2] > 0)
    .map(([id, labelKey, value, tone]) => ({ id, labelKey, value, tone }));
}

/**
 * Panels are chosen by the capability flags the SERVER sent, never by role.
 *
 * A panel that is not enabled here is not rendered AND its data is never
 * requested — the whole payload arrives in the single authorized RPC, so an
 * unauthorized panel simply has nothing to draw. This is the "do not fetch
 * then hide" rule: there is no second request to suppress.
 */
export interface PanelVisibility {
  stockHealth: boolean;
  network: boolean;
  criticalSignals: boolean;
  alertsLink: boolean;
  reportsLink: boolean;
}

export function derivePanels(capabilities: CommandCenterCapabilities): PanelVisibility {
  const stock = !!capabilities.warehouse_stock_view || !!capabilities.outlet_stock_view;
  return {
    // dashboard_view is the gate the RPC already enforced in order to answer.
    stockHealth: !!capabilities.dashboard_view,
    network: !!capabilities.dashboard_view,
    criticalSignals: !!capabilities.dashboard_view,
    alertsLink: !!capabilities.alerts_view,
    reportsLink: !!capabilities.reports_view || stock,
  };
}
