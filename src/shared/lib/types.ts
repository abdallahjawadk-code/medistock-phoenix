/* ─── MEDISTOCK PHOENIX — Core Types ──────────────────────────────────────── */

export type Lang = 'ar' | 'en';
export type Theme = 'light' | 'dark';
export type Role = 'super_admin' | 'hospital_admin' | 'pharmacist' | 'viewer';

export type AvailabilityStatus = 'available' | 'low' | 'missing' | 'near_expiry';
export type InstitutionStatus  = 'healthy' | 'safemode' | 'quarantine' | 'frozen';
export type ModuleStatus       = 'healthy' | 'safemode' | 'frozen';
export type EntityStatus       = 'active' | 'archived' | 'deleted';

export interface Institution {
  id: string;
  code: 'marjan' | 'hilla' | 'babil' | 'mahawil';
  name_ar: string;
  name_en: string;
  status: InstitutionStatus;
  available_count: number;
  low_count: number;
  missing_count: number;
  bridge_health: number;
}

export interface LocalItem {
  id: string;
  institution_id: string;
  local_code: string;
  name_ar: string;
  name_en: string;
  unit: string;
  manufacturer?: string;
  category?: string;
  status: 'active' | 'inactive';
}

export interface AvailabilityRecord {
  id: string;
  institution_id: string;
  item_id: string;
  quantity: number;
  status: AvailabilityStatus;
  batch_no?: string;
  expiry_date?: string;
  notes?: string;
  updated_at: string;
  updated_by?: string;
}

export interface QrToken {
  id: string;
  institution_id: string;
  token: string;
  public_id: string;
  is_active: boolean;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  institution_id?: string;
  actor_role: Role;
  action: string;
  entity_type: string;
  entity_id?: string;
  created_at: string;
}

export interface BridgeLink {
  from_code: string;
  to_code: string;
  health_pct: number;
  status: 'ok' | 'degraded' | 'down';
}

/* ── Purge / Archive contracts ── */
export type AllowlistedEntityType = 'local_item' | 'qr_token';

export interface PurgeImpact {
  entity_type: AllowlistedEntityType;
  entity_id: string;
  counts: Record<string, number>;
  warnings: string[];
}
