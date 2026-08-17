import { supabase, supabaseConfigured } from '../client';

export type DelegatedScopeType = 'organization' | 'warehouse' | 'distribution_point';
export type DelegatedRecipientRole =
  | 'central_warehouse_manager' | 'warehouse_officer' | 'outlet_officer';

export const DELEGATED_RECIPIENT_ROLES: readonly DelegatedRecipientRole[] = [
  'central_warehouse_manager', 'warehouse_officer', 'outlet_officer',
] as const;

export interface DelegatedScopeRow {
  assignmentId: string;
  profileId: string;
  targetOrganizationId: string;
  organizationName: string;
  organizationNameAr: string;
  scopeType: DelegatedScopeType;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseNameAr: string | null;
  distributionPointId: string | null;
  distributionPointName: string | null;
  distributionPointNameAr: string | null;
  parentWarehouseId: string | null;
  parentWarehouseName: string | null;
  parentWarehouseNameAr: string | null;
  includeChildOutlets: boolean;
  grantGroupId: string;
  grantOrigin: 'direct' | 'network_snapshot';
  isActive: boolean;
  assignedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

type ScopeRpcRow = {
  assignment_id: string; profile_id: string; target_organization_id: string;
  organization_name: string; organization_name_ar: string; scope_type: DelegatedScopeType;
  warehouse_id: string | null; warehouse_name: string | null; warehouse_name_ar: string | null;
  distribution_point_id: string | null; distribution_point_name: string | null;
  distribution_point_name_ar: string | null; parent_warehouse_id: string | null;
  parent_warehouse_name: string | null; parent_warehouse_name_ar: string | null;
  include_child_outlets: boolean; grant_group_id: string;
  grant_origin: DelegatedScopeRow['grantOrigin']; is_active: boolean;
  assigned_at: string; revoked_at: string | null; revoke_reason: string | null;
};

const mapScope = (r: ScopeRpcRow): DelegatedScopeRow => ({
  assignmentId: r.assignment_id, profileId: r.profile_id,
  targetOrganizationId: r.target_organization_id,
  organizationName: r.organization_name, organizationNameAr: r.organization_name_ar,
  scopeType: r.scope_type, warehouseId: r.warehouse_id,
  warehouseName: r.warehouse_name, warehouseNameAr: r.warehouse_name_ar,
  distributionPointId: r.distribution_point_id,
  distributionPointName: r.distribution_point_name,
  distributionPointNameAr: r.distribution_point_name_ar,
  parentWarehouseId: r.parent_warehouse_id,
  parentWarehouseName: r.parent_warehouse_name,
  parentWarehouseNameAr: r.parent_warehouse_name_ar,
  includeChildOutlets: r.include_child_outlets, grantGroupId: r.grant_group_id,
  grantOrigin: r.grant_origin, isActive: r.is_active, assignedAt: r.assigned_at,
  revokedAt: r.revoked_at, revokeReason: r.revoke_reason,
});

export async function listDelegatedScopes(
  profileId: string, includeRevoked = true,
): Promise<DelegatedScopeRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase.rpc('phoenix_list_delegated_scopes', {
    p_profile_id: profileId, p_include_revoked: includeRevoked,
  });
  if (error) throw error;
  return ((data ?? []) as ScopeRpcRow[]).map(mapScope);
}

export interface GrantDelegatedScopeInput {
  profileId: string;
  targetOrganizationId: string;
  scopeType: DelegatedScopeType;
  warehouseId?: string | null;
  distributionPointId?: string | null;
  includeChildOutlets?: boolean;
}

export async function grantDelegatedScope(input: GrantDelegatedScopeInput): Promise<void> {
  const { data, error } = await supabase.rpc('phoenix_admin_grant_delegated_scope', {
    p_profile_id: input.profileId,
    p_target_organization_id: input.targetOrganizationId,
    p_scope_type: input.scopeType,
    p_warehouse_id: input.warehouseId ?? null,
    p_distribution_point_id: input.distributionPointId ?? null,
    p_include_child_outlets: input.includeChildOutlets ?? false,
  });
  if (error) throw error;
  if (!(data as { ok?: boolean } | null)?.ok) throw new Error('DELEGATED_SCOPE_GRANT_FAILED');
}

export async function grantDelegatedNetworkSnapshot(profileId: string): Promise<number> {
  const { data, error } = await supabase.rpc('phoenix_admin_grant_delegated_network_snapshot', {
    p_profile_id: profileId,
  });
  if (error) throw error;
  const result = data as { ok?: boolean; organization_count?: number } | null;
  if (!result?.ok) throw new Error('DELEGATED_NETWORK_SNAPSHOT_FAILED');
  return result.organization_count ?? 0;
}

export type RevokeDelegatedScopeInput =
  | { assignmentId: string; grantGroupId?: never; reason: string }
  | { assignmentId?: never; grantGroupId: string; reason: string };

export async function revokeDelegatedScope(input: RevokeDelegatedScopeInput): Promise<number> {
  const reason = input.reason.trim();
  if (!reason) throw new Error('DELEGATED_REVOKE_REASON_REQUIRED');
  const { data, error } = await supabase.rpc('phoenix_admin_revoke_delegated_scope', {
    p_assignment_id: 'assignmentId' in input ? input.assignmentId : null,
    p_grant_group_id: 'grantGroupId' in input ? input.grantGroupId : null,
    p_revoke_reason: reason,
  });
  if (error) throw error;
  const result = data as { ok?: boolean; revoked_count?: number } | null;
  if (!result?.ok) throw new Error('DELEGATED_SCOPE_REVOKE_FAILED');
  return result.revoked_count ?? 0;
}

export interface OperationalResourceCatalogRow {
  organizationId: string; organizationName: string; organizationNameAr: string;
  warehouseId: string | null; warehouseName: string | null; warehouseNameAr: string | null;
  warehouseKind: 'central' | 'institution' | null; warehouseFacilityId: string | null;
  distributionPointId: string | null; distributionPointName: string | null;
  distributionPointNameAr: string | null; distributionPointType: string | null;
  scopeSource: 'primary' | 'delegated';
  includeChildOutlets: boolean;
}

export async function getMyOperationalResourceCatalog(): Promise<OperationalResourceCatalogRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase.rpc('phoenix_my_operational_resource_catalog');
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    organizationId: r.organization_id as string,
    organizationName: r.organization_name as string,
    organizationNameAr: r.organization_name_ar as string,
    warehouseId: (r.warehouse_id as string | null) ?? null,
    warehouseName: (r.warehouse_name as string | null) ?? null,
    warehouseNameAr: (r.warehouse_name_ar as string | null) ?? null,
    warehouseKind: (r.warehouse_kind as 'central' | 'institution' | null) ?? null,
    warehouseFacilityId: (r.warehouse_facility_id as string | null) ?? null,
    distributionPointId: (r.distribution_point_id as string | null) ?? null,
    distributionPointName: (r.distribution_point_name as string | null) ?? null,
    distributionPointNameAr: (r.distribution_point_name_ar as string | null) ?? null,
    distributionPointType: (r.distribution_point_type as string | null) ?? null,
    scopeSource: r.scope_source as 'primary' | 'delegated',
    includeChildOutlets: Boolean(r.include_child_outlets),
  }));
}
