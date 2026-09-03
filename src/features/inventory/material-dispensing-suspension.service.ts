import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * MATERIAL-DISPENSING-SUSPENSION — thin client over migration 203's domain
 * and its suspend/lift/badge-status RPCs.
 *
 * Reads of the full row (admin management view) are an RLS-scoped SELECT,
 * gated on material_dispensing_suspension.view — never returned to a role
 * that only holds .view_badge (see getMaterialDispensingSuspensionBadges
 * below for that lighter-weight, broadly-granted read). Every mutation is a
 * SECURITY DEFINER RPC that re-checks the scoped permission server-side;
 * nothing here writes the table directly (there is no INSERT/UPDATE grant
 * to write with).
 *
 * Deliberately separate from quarantine.service.ts — see
 * docs/phoenix/proposals/203-material-dispensing-suspension.md for why the
 * two domains never share a table, an RPC, or a translated string.
 */

export interface MaterialDispensingSuspensionRow {
  id: string;
  centralItemId: string;
  materialName: string;
  materialNameAr: string;
  organizationId: string;
  distributionPointId: string | null;
  reasonCode: string;
  reasonDetail: string | null;
  referenceDocument: string | null;
  effectiveStart: string;
  effectiveEnd: string | null;
  createdBy: string;
  createdAt: string;
  liftedBy: string | null;
  liftedAt: string | null;
  liftReason: string | null;
}

interface SuspensionDbRow {
  id: string; central_item_id: string; organization_id: string;
  distribution_point_id: string | null; reason_code: string;
  reason_detail: string | null; reference_document: string | null;
  effective_start: string; effective_end: string | null;
  created_by: string; created_at: string;
  lifted_by: string | null; lifted_at: string | null; lift_reason: string | null;
  central_items: { name: string; name_ar: string } | null;
}

const mapRow = (r: SuspensionDbRow): MaterialDispensingSuspensionRow => ({
  id: r.id,
  centralItemId: r.central_item_id,
  materialName: r.central_items?.name ?? '',
  materialNameAr: r.central_items?.name_ar ?? '',
  organizationId: r.organization_id,
  distributionPointId: r.distribution_point_id,
  reasonCode: r.reason_code,
  reasonDetail: r.reason_detail,
  referenceDocument: r.reference_document,
  effectiveStart: r.effective_start,
  effectiveEnd: r.effective_end,
  createdBy: r.created_by,
  createdAt: r.created_at,
  liftedBy: r.lifted_by,
  liftedAt: r.lifted_at,
  liftReason: r.lift_reason,
});

/** Every suspension (active and lifted) an org's .view holder may see, newest first. */
export async function getMaterialDispensingSuspensions(
  organizationId: string,
): Promise<MaterialDispensingSuspensionRow[]> {
  if (!supabaseConfigured || !organizationId) return [];
  const { data, error } = await supabase
    .from('material_dispensing_suspensions')
    .select('id, central_item_id, organization_id, distribution_point_id, reason_code, reason_detail, reference_document, effective_start, effective_end, created_by, created_at, lifted_by, lifted_at, lift_reason, central_items(name,name_ar)')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as unknown as SuspensionDbRow[] | null ?? []).map(mapRow);
}

export interface RpcResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

function rpcErrorCode(message: string | undefined): string {
  if (!message) return 'unknown_error';
  const match = /[a-z][a-z0-9_]{3,}/.exec(message);
  return match ? match[0] : 'unknown_error';
}

async function callRpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: rpcErrorCode(error.message) };
  const payload = (data ?? {}) as { ok?: boolean } & T;
  return { ok: payload.ok !== false, data: payload as T };
}

export type SuspensionReasonCode =
  | 'regulatory_hold' | 'recall_investigation' | 'clinical_safety_concern'
  | 'quality_investigation' | 'license_or_permit_issue'
  | 'supply_integrity_concern' | 'other';

/** Suspends a material from dispensing, org-wide or at one named outlet. */
export function suspendMaterialDispensing(input: {
  requestId: string;
  centralItemId: string;
  organizationId: string;
  reasonCode: SuspensionReasonCode;
  distributionPointId?: string | null;
  reasonDetail?: string | null;
  referenceDocument?: string | null;
  effectiveStart?: string | null;
  effectiveEnd?: string | null;
}): Promise<RpcResult<{ suspension_id?: string; already_active?: boolean }>> {
  return callRpc('phoenix_suspend_material_dispensing', {
    p_request_id: input.requestId,
    p_central_item_id: input.centralItemId,
    p_organization_id: input.organizationId,
    p_reason_code: input.reasonCode,
    p_distribution_point_id: input.distributionPointId ?? null,
    p_reason_detail: input.reasonDetail ?? null,
    p_reference_document: input.referenceDocument ?? null,
    p_effective_start: input.effectiveStart ?? null,
    p_effective_end: input.effectiveEnd ?? null,
  });
}

/** Lifts an active suspension. Never releases quarantine — an unrelated domain. */
export function liftMaterialDispensingSuspension(input: {
  requestId: string; suspensionId: string; liftReason: string;
}): Promise<RpcResult<{ suspension_id?: string }>> {
  return callRpc('phoenix_lift_material_dispensing_suspension', {
    p_request_id: input.requestId,
    p_suspension_id: input.suspensionId,
    p_lift_reason: input.liftReason,
  });
}

export interface MaterialDispensingSuspensionBadge {
  centralItemId: string;
  isSuspended: boolean;
  reasonCode: string | null;
  effectiveStart: string | null;
}

interface BadgeDbRow {
  central_item_id: string; is_suspended: boolean;
  reason_code: string | null; effective_start: string | null;
}

/**
 * Lightweight status for showing the موقوف الصرف badge in a picker/composer —
 * never returns reason_detail/reference_document/lift fields (see
 * material_dispensing_suspension.view_badge in migration 203: broadly
 * granted, coded-reason-only). Batches by central_item_id so a list view can
 * ask once instead of once per row.
 */
export async function getMaterialDispensingSuspensionBadges(input: {
  centralItemIds: string[];
  organizationId: string;
  distributionPointId?: string | null;
}): Promise<Map<string, MaterialDispensingSuspensionBadge>> {
  const map = new Map<string, MaterialDispensingSuspensionBadge>();
  if (!supabaseConfigured || input.centralItemIds.length === 0 || !input.organizationId) return map;
  const { data, error } = await supabase.rpc('phoenix_get_material_dispensing_suspension_status', {
    p_central_item_ids: input.centralItemIds,
    p_organization_id: input.organizationId,
    p_distribution_point_id: input.distributionPointId ?? null,
  });
  if (error) throw error;
  for (const row of (data as BadgeDbRow[] | null ?? [])) {
    map.set(row.central_item_id, {
      centralItemId: row.central_item_id,
      isSuspended: row.is_suspended,
      reasonCode: row.reason_code,
      effectiveStart: row.effective_start,
    });
  }
  return map;
}
