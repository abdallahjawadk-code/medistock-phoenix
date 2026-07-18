import type {
  InventorySignalType,
  InventorySeverity,
  InventoryScopeKind,
} from './inventory-intelligence.service';

/** i18n key for a signal type. */
export const SIGNAL_LABEL_KEY: Record<InventorySignalType, string> = {
  missing: 'inv_signal_missing',
  low_stock: 'inv_signal_low_stock',
  surplus: 'inv_signal_surplus',
  near_expiry: 'inv_signal_near_expiry',
  expired: 'inv_signal_expired',
};

/** i18n key for a severity level. */
export const SEVERITY_LABEL_KEY: Record<InventorySeverity, string> = {
  high: 'inv_sev_high',
  medium: 'inv_sev_medium',
  low: 'inv_sev_low',
};

/** PhoenixStatusBadge variant per severity. */
export const SEVERITY_BADGE_VARIANT: Record<InventorySeverity, 'err' | 'warn' | 'neutral'> = {
  high: 'err',
  medium: 'warn',
  low: 'neutral',
};

/** Left-border accent color per severity (CSS var). */
export const SEVERITY_BORDER: Record<InventorySeverity, string> = {
  high: 'var(--err)',
  medium: 'var(--warn)',
  low: 'var(--brd)',
};

/** i18n key for a scope kind. */
export const SCOPE_LABEL_KEY: Record<InventoryScopeKind, string> = {
  warehouse: 'inv_scope_warehouse',
  outlet: 'inv_scope_outlet',
};

/** Sort order for severities (high first). */
export const SEVERITY_RANK: Record<InventorySeverity, number> = { high: 0, medium: 1, low: 2 };
