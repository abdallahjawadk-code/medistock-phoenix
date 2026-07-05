/* ─── MEDISTOCK PHOENIX — Core Types ──────────────────────────────────────── */

export type Lang = 'ar' | 'en';
export type Theme = 'light' | 'dark';
// Mirrors the DB CHECK constraint on public.profiles.role (migration 001).
export type Role =
  | 'super_admin'
  | 'hospital_admin'
  | 'warehouse_manager'
  | 'point_operator'
  | 'viewer';

export type AvailabilityStatus = 'available' | 'low' | 'missing' | 'near_expiry';
// Exact values accepted by the item_availability.condition CHECK (migration 001).
export type AvailabilityCondition =
  | 'available'
  | 'low_stock'
  | 'missing'
  | 'surplus'
  | 'near_expiry'
  | 'expired';
// Mirrors the DB CHECK constraint on public.organizations.status (migration 001).
export type OrganizationStatus = 'active' | 'inactive' | 'suspended';
export type ModuleStatus       = 'healthy' | 'safemode' | 'frozen';
export type EntityStatus       = 'active' | 'archived' | 'deleted';

export interface Organization {
  id: string;
  name: string;
  name_ar: string;
  code: string;
  status: OrganizationStatus;
  city: string;
  contact_email?: string;
}

export interface ProfileRow {
  id: string;
  organization_id: string | null;
  full_name: string;
  role: Role;
  status: 'active' | 'suspended' | 'archived';
}

export interface AvailabilityRecord {
  id: string;
  organization_id: string;
  item_id: string;
  quantity: number;
  status: AvailabilityStatus;
  batch_no?: string;
  expiry_date?: string;
  notes?: string;
  updated_at: string;
  updated_by?: string;
  /** Free-text "المنفذ" (Access point / Port) value — replaces item selection (migration 019). Null for legacy item-based rows. */
  port_name?: string | null;
  /** Free-text "نوع التجهيز" (Supply type), institution-private (migration 019). */
  supply_type?: string | null;
  scientific_name?: string | null;
  trade_name?: string | null;
  dosage_form?: string | null;
  concentration?: string | null;
  price?: number | null;
  /** Official product/registration code, distinct from batch_number (migration 049). */
  national_code?: string | null;
  /** Batch/lot number — the actual item_availability.batch_number column. */
  batch_number?: string | null;
  /** Intentional-removal marker (migration 053) — set when the material was removed from the outlet, not merely out of stock. Null for active/never-removed rows. */
  removed_at?: string | null;
}

export interface QrToken {
  id: string;
  organization_id: string;
  public_id: string;
  status: string;
  last_scanned_at: string | null;
  scan_count: number;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  organization_id?: string;
  actor_role: Role;
  action: string;
  entity_type: string;
  entity_id?: string;
  entity_label?: string;
  created_at: string;
}

/* ── Purge / Archive contracts ── */
export type AllowlistedEntityType = 'warehouse' | 'distribution_point' | 'local_item';

export interface PurgeImpact {
  entity_type: AllowlistedEntityType;
  entity_id: string;
  counts: Record<string, number>;
  warnings: string[];
}

/* ── Role hierarchy helpers ── */

const ROLE_RANK: Record<Role, number> = {
  super_admin: 5,
  hospital_admin: 4,
  warehouse_manager: 3,
  point_operator: 2,
  viewer: 1,
};

export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'hospital_admin') return targetRole !== 'super_admin';
  return false;
}

export function isAdminRole(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.hospital_admin;
}

export function canManageOrg(role: Role): boolean {
  return role === 'super_admin';
}

export const ASSIGNABLE_ROLES_BY_ACTOR: Record<Role, readonly Role[]> = {
  super_admin: ['super_admin', 'hospital_admin', 'warehouse_manager', 'point_operator', 'viewer'],
  hospital_admin: ['hospital_admin', 'warehouse_manager', 'point_operator', 'viewer'],
  warehouse_manager: [],
  point_operator: [],
  viewer: [],
};
