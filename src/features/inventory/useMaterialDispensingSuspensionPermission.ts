import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

export interface MaterialDispensingSuspensionPermissions {
  /** May see the full row (reason_detail/reference_document/lift_reason). */
  canViewDetail: boolean;
  /** May call phoenix_suspend_material_dispensing. */
  canSuspend: boolean;
  /** May call phoenix_lift_material_dispensing_suspension. */
  canLift: boolean;
}

/**
 * MATERIAL-DISPENSING-SUSPENSION — the exact per-organization (optionally
 * per-outlet) decision for viewing, suspending, and lifting.
 *
 * Mirrors useQuarantinePermission's shape but asks three separate keys
 * (material_dispensing_suspension.view / .create / .lift) rather than one —
 * this domain's default role matrix seeds all three identically
 * (super_admin/central_warehouse_manager/institution_admin only), but the
 * RPCs check them independently, so the UI preflight does too rather than
 * assuming they always travel together.
 *
 * UI preflight ONLY: every RPC repeats this authorization server-side.
 */
export interface ScopedMaterialDispensingSuspensionPermission
  extends AsyncState<MaterialDispensingSuspensionPermissions> {
  /**
   * The scope `data` was computed for, or null when nothing has settled.
   * See ScopedQuarantinePermission for why the answer carries its own subject
   * instead of the caller inferring it from `loading`.
   */
  dataScopeKey: string | null;
}

/** Opaque, comparison-only identity of a suspension permission scope. */
export function suspensionPermissionScopeKey(
  organizationId: string | null,
  distributionPointId: string | null,
): string {
  return `${organizationId ?? '-'}/${distributionPointId ?? '-'}`;
}

export function useMaterialDispensingSuspensionPermission(
  organizationId: string | null,
  distributionPointId: string | null = null,
): ScopedMaterialDispensingSuspensionPermission {
  const { profile } = useApp();
  const scopeKey = suspensionPermissionScopeKey(organizationId, distributionPointId);

  const inner = useAsync<{ scopeKey: string; permissions: MaterialDispensingSuspensionPermissions }>(async () => {
    const deny: MaterialDispensingSuspensionPermissions = { canViewDetail: false, canSuspend: false, canLift: false };
    if (!organizationId || !profile?.id) return { scopeKey, permissions: deny };
    if (profile.role === 'super_admin') {
      return { scopeKey, permissions: { canViewDetail: true, canSuspend: true, canLift: true } };
    }

    const check = async (permissionKey: string) => {
      const result = await supabaseRbacTransport.hasScopedPermission({
        profileId: profile.id,
        permissionKey,
        organizationId,
        warehouseId: null,
        distributionPointId,
      });
      return result.ok && result.allowed;
    };

    const [canViewDetail, canSuspend, canLift] = await Promise.all([
      check('material_dispensing_suspension.view'),
      check('material_dispensing_suspension.create'),
      check('material_dispensing_suspension.lift'),
    ]);
    return { scopeKey, permissions: { canViewDetail, canSuspend, canLift } };
  }, [organizationId, distributionPointId, profile?.id, profile?.role]);

  return {
    ...inner,
    data: inner.data === null ? null : inner.data.permissions,
    dataScopeKey: inner.data?.scopeKey ?? null,
  };
}
