import { supabase, supabaseConfigured } from '../client';

export type CommandCenterScopeKind = 'global' | 'organization' | 'warehouse' | 'distribution_point';

export interface CommandCenterScopeRequest {
  organizationId?: string | null;
  warehouseId?: string | null;
  distributionPointId?: string | null;
}

export interface CommandCenterCapabilities {
  dashboard_view: boolean;
  alerts_view: boolean;
  reports_view: boolean;
  warehouse_stock_view: boolean;
  outlet_stock_view: boolean;
  warehouse_transfer_view: boolean;
}

export interface CommandCenterScope {
  kind: CommandCenterScopeKind;
  organization_id: string | null;
  warehouse_id: string | null;
  distribution_point_id: string | null;
}

export interface CommandCenterAvailabilitySummary {
  availability_rows: number;
  quantity_units: number;
  available: number;
  low_stock: number;
  missing: number;
  near_expiry: number;
  expired: number;
  surplus: number;
}

export interface CommandCenterStockSummary {
  stock_lines: number;
  on_hand_units: number;
  available_units: number;
  zero_available_lines: number;
  expired_lines: number;
  near_expiry_lines: number;
}

export interface CommandCenterNetworkSummary {
  organizations: number;
  warehouses: number;
  distribution_points: number;
}

export interface CommandCenterReadContract {
  ok: true;
  scope: CommandCenterScope;
  capabilities: CommandCenterCapabilities;
  summary: CommandCenterAvailabilitySummary | CommandCenterStockSummary;
  network: CommandCenterNetworkSummary;
  trend: null;
  trend_status: 'deferred_pending_measurement';
  near_expiry_days: 270;
  as_of: string;
}

/**
 * RAC-2 secure data boundary for the future Command Center.
 *
 * Authorization is deliberately NOT inferred from role strings in the client.
 * The server derives auth.uid(), enforces dashboard.view through the canonical
 * scoped-permission helper, and rejects unauthorized scope requests.
 */
export async function getCommandCenterReadContract(
  scope: CommandCenterScopeRequest = {},
): Promise<CommandCenterReadContract | null> {
  if (!supabaseConfigured) return null;

  if (scope.warehouseId && scope.distributionPointId) {
    throw new Error('command_center_invalid_scope');
  }

  const { data, error } = await supabase.rpc('phoenix_command_center_read_contract', {
    p_organization_id: scope.organizationId ?? null,
    p_warehouse_id: scope.warehouseId ?? null,
    p_distribution_point_id: scope.distributionPointId ?? null,
  });

  if (error) throw error;
  return data as CommandCenterReadContract;
}
