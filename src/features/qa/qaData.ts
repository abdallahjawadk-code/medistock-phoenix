/**
 * VISUAL-QA-HARNESS-A — deterministic SELECT fixtures (DEV/TEST ONLY).
 *
 * Every value is obviously synthetic and marked QA ONLY. Tables not listed here
 * resolve to an empty array, so screens render their real empty state cleanly.
 * These rows exist to exercise VISUAL layout only — never to assert data
 * correctness, RLS, or authorization.
 */
export type QaRow = Record<string, unknown>;

const QA = 'QA';
const ORG_A = 'qa-org-a1';
const ORG_B = 'qa-org-b2';
const ORG_C = 'qa-org-c3';
const ORG_D = 'qa-org-d4';
const ORG_E = 'qa-org-e5';
const ORG_F = 'qa-org-f6';

export const QA_FIXTURES: Record<string, QaRow[]> = {
  organizations: [
    { id: ORG_A, name: 'QA · Al-Hilla Teaching Hospital', name_ar: 'QA · مستشفى الحلة التعليمي', code: 'QA-HIL', status: 'active', city: 'Babil' },
    { id: ORG_B, name: 'QA · Al-Imam Al-Sadiq Hospital', name_ar: 'QA · مستشفى الإمام الصادق', code: 'QA-SDQ', status: 'active', city: 'Babil' },
    { id: ORG_C, name: 'QA · Al-Musayyib General Hospital', name_ar: 'QA · مستشفى المسيب العام', code: 'QA-MSB', status: 'active', city: 'Babil' },
    { id: ORG_D, name: 'QA · Al-Hashimiyah Hospital', name_ar: 'QA · مستشفى الهاشمية', code: 'QA-HSH', status: 'active', city: 'Babil' },
    { id: ORG_E, name: 'QA · Al-Mahawil Hospital', name_ar: 'QA · مستشفى المحاويل', code: 'QA-MHW', status: 'active', city: 'Babil' },
    { id: ORG_F, name: 'QA · Al-Qasim Hospital', name_ar: 'QA · مستشفى القاسم العام', code: 'QA-QSM', status: 'active', city: 'Babil' },
  ],
  warehouses: [
    { id: 'qa-wh-central', name: 'QA · Central Pharmacy Warehouse', name_ar: 'QA · المستودع المركزي', warehouse_kind: 'central', status: 'active', is_main: true, code: 'QA-CENTRAL', organization_id: ORG_A },
    { id: 'qa-wh-inst-a', name: 'QA · Al-Hilla Institution Store', name_ar: 'QA · مذخر مستشفى الحلة التعليمي', warehouse_kind: 'institution', status: 'active', is_main: true, code: 'QA-A', organization_id: ORG_A },
    { id: 'qa-wh-inst-b', name: 'QA · Al-Sadiq Institution Store', name_ar: 'QA · مذخر مستشفى الإمام الصادق', warehouse_kind: 'institution', status: 'active', is_main: true, code: 'QA-B', organization_id: ORG_B },
    { id: 'qa-wh-inst-c', name: 'QA · Al-Musayyib Institution Store', name_ar: 'QA · مذخر مستشفى المسيب العام', warehouse_kind: 'institution', status: 'active', is_main: true, code: 'QA-C', organization_id: ORG_C },
    { id: 'qa-wh-inst-d', name: 'QA · Al-Hashimiyah Institution Store', name_ar: 'QA · مذخر مستشفى الهاشمية', warehouse_kind: 'institution', status: 'active', is_main: true, code: 'QA-D', organization_id: ORG_D },
    { id: 'qa-wh-inst-e', name: 'QA · Al-Mahawil Institution Store', name_ar: 'QA · مذخر مستشفى المحاويل', warehouse_kind: 'institution', status: 'active', is_main: true, code: 'QA-E', organization_id: ORG_E },
    { id: 'qa-wh-inst-f', name: 'QA · Al-Qasim Institution Store', name_ar: 'QA · مذخر مستشفى القاسم العام', warehouse_kind: 'institution', status: 'active', is_main: true, code: 'QA-F', organization_id: ORG_F },
  ],
  distribution_points: [
    { id: 'qa-outlet-1', name: 'QA · Emergency Pharmacy', name_ar: 'QA · صيدلية الطوارئ', status: 'active', warehouse_id: 'qa-wh-inst-a', organization_id: ORG_A, point_type: 'pharmacy' },
    { id: 'qa-outlet-2', name: 'QA · Resuscitation Cart', name_ar: 'QA · عربة إنعاش الحلة', status: 'active', warehouse_id: 'qa-wh-inst-a', organization_id: ORG_A, point_type: 'rescue_cart' },
    { id: 'qa-outlet-3', name: 'QA · Shock Cabinet', name_ar: 'QA · خزانة صدمات الحلة', status: 'active', warehouse_id: 'qa-wh-inst-a', organization_id: ORG_A, point_type: 'crash_cabinet' },
  ],
  inventory_alerts: [
    {
      id: 'qa-alert-1', organization_id: ORG_A, scope_kind: 'warehouse', scope_id: 'qa-wh-inst-a',
      signal_type: 'low_stock', severity: 'high', expiry_tier: null, scientific_name: 'QA · Ceftriaxone',
      national_code: null, batch_number: null, expiry_date: null, observed_on_hand: 14, observed_available: 10,
      threshold_reorder_point: 40, threshold_target_max: 120, near_expiry_days: null, days_to_expiry: null,
      status: 'open', reason: null, occurrence_count: 3, last_observed_at: '2026-07-20T08:42:00Z', updated_at: '2026-07-20T08:42:00Z',
    },
    {
      id: 'qa-alert-2', organization_id: ORG_A, scope_kind: 'outlet', scope_id: 'qa-outlet-3',
      signal_type: 'near_expiry', severity: 'medium', expiry_tier: 'warning_6m', scientific_name: 'QA · Adrenaline',
      national_code: null, batch_number: 'QA-BATCH', expiry_date: '2026-11-01', observed_on_hand: 28, observed_available: 28,
      threshold_reorder_point: 10, threshold_target_max: 50, near_expiry_days: 270, days_to_expiry: 104,
      status: 'open', reason: null, occurrence_count: 1, last_observed_at: '2026-07-20T08:42:00Z', updated_at: '2026-07-20T08:42:00Z',
    },
  ],
  profiles: [
    { id: 'qa-user-1', full_name: `${QA} · مسؤول النظام`, role: 'super_admin', status: 'active', organization_id: null },
    { id: 'qa-user-2', full_name: `${QA} · أمين مذخر`, role: 'warehouse_officer', status: 'active', organization_id: ORG_A },
    { id: 'qa-user-3', full_name: `${QA} · أمين منفذ (موقوف)`, role: 'outlet_officer', status: 'suspended', organization_id: ORG_A },
  ],
};
