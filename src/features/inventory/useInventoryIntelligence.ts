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

/**
 * Whether an open suggestion's proven conservation may now be stale. Migration
 * 072 proves conservation only at each rebuild (last_validated_at); a later
 * real stock movement can invalidate it, so any surface MUST treat an aged
 * recommendation as needing live re-validation before action.
 *
 * maxAgeMs MUST come from the org's actual inventory_suggestion_policy
 * (migration 147) — getInventorySuggestionPolicy(orgId), falling back to the
 * documented 30-minute default — never a client-only literal, so the UI's
 * "stale" display can never disagree with what
 * phoenix_create_transfer_draft_from_suggestion will actually accept.
 */
export function isSuggestionStale(s: InventoryTransferSuggestion, maxAgeMs: number): boolean {
  const t = Date.parse(s.lastValidatedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > maxAgeMs;
}

export const INVENTORY_SUGGESTION_STALENESS_DEFAULT_MINUTES = 30;
