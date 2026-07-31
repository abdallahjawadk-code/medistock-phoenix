import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import {
  getInventoryAlerts,
  getInventoryThresholds,
  getInventoryTransferSuggestions,
  type InventoryAlert,
  type InventoryThreshold,
  type InventoryTransferSuggestion,
  type InventoryAlertStatus,
  type InventorySuggestionStatus,
} from './inventory-intelligence.service';

/**
 * INVENTORY-INTELLIGENCE-FRONTEND-A — React data hooks.
 *
 * Thin wrappers over the RLS-protected reads, keyed on the active org so the
 * super_admin org switcher re-loads. RLS already restricts every row to the
 * organizations/scopes the caller may see, so these return exactly the caller's
 * relevant rows — no client-side authorization filtering.
 */

/** Permission keys migration 072 registered — the UI gates on these. */
export const INVENTORY_PERMISSION_KEYS = {
  viewSignals: 'inventory.view_signals',
  recompute: 'inventory.recompute',
  manageAlerts: 'inventory.manage_alerts',
  manageThresholds: 'inventory.manage_thresholds',
  suggestTransfers: 'inventory.suggest_transfers',
  actOnSuggestions: 'inventory.act_on_suggestions',
  purge: 'inventory.purge',
} as const;

export function useInventoryAlerts(
  opts: { statuses?: InventoryAlertStatus[]; limit?: number } = {},
): AsyncState<InventoryAlert[]> {
  const { activeOrgId } = useApp();
  const statusesKey = (opts.statuses ?? []).join(',');
  return useAsync(
    () => getInventoryAlerts(activeOrgId ?? undefined, opts),
    [activeOrgId, statusesKey, opts.limit],
  );
}

export function useInventoryThresholds(): AsyncState<InventoryThreshold[]> {
  const { activeOrgId } = useApp();
  return useAsync(() => getInventoryThresholds(activeOrgId ?? undefined), [activeOrgId]);
}

export function useInventoryTransferSuggestions(
  opts: { statuses?: InventorySuggestionStatus[]; limit?: number } = {},
): AsyncState<InventoryTransferSuggestion[]> {
  const { activeOrgId } = useApp();
  const statusesKey = (opts.statuses ?? []).join(',');
  return useAsync(
    () => getInventoryTransferSuggestions(activeOrgId ?? undefined, opts),
    [activeOrgId, statusesKey, opts.limit],
  );
}
