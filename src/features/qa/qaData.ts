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

/**
 * Fixtures for the fixture client. Table keys hold row arrays (read by
 * `.from(t)`); `rpc:<name>` keys hold whatever the real read RPC returns — an
 * array OR an object — matching each RPC's actual response schema so screens
 * render their POPULATED state, not an error. Values are obviously synthetic.
 */
export const QA_FIXTURES: Record<string, unknown> = {
  organizations: [
    { id: ORG_A, name: 'QA · Al-Hilla Teaching Hospital', name_ar: 'QA · مستشفى الحلة التعليمي', code: 'QA-A', city: 'Al-Hilla', status: 'active', kind: 'institution' },
    { id: ORG_B, name: 'QA · Al-Imam Al-Sadiq Hospital', name_ar: 'QA · مستشفى الإمام الصادق', code: 'QA-B', city: 'Al-Hilla', status: 'active', kind: 'institution' },
  ],
  warehouses: [
    { id: 'qa-wh-central', name: 'QA · Central Pharmacy Store', name_ar: 'QA · مخزن قسم الصيدلة', warehouseKind: 'central', status: 'active', organization_id: null },
    { id: 'qa-wh-inst-a', name: 'QA · Al-Hilla Institution Store', name_ar: 'QA · مذخر الحلة', warehouseKind: 'institution', status: 'active', organization_id: ORG_A },
    { id: 'qa-wh-inst-b', name: 'QA · Al-Sadiq Institution Store', name_ar: 'QA · مذخر الصادق', warehouseKind: 'institution', status: 'inactive', organization_id: ORG_B },
  ],
  distribution_points: [
    { id: 'qa-outlet-1', name: 'QA · Emergency Outlet', name_ar: 'QA · منفذ الطوارئ', status: 'active', warehouseId: 'qa-wh-inst-a', organization_id: ORG_A },
    { id: 'qa-outlet-2', name: 'QA · Pediatrics Outlet', name_ar: 'QA · منفذ الأطفال', status: 'active', warehouseId: 'qa-wh-inst-a', organization_id: ORG_A },
    { id: 'qa-outlet-3', name: 'QA · Long Name Outlet ' + '—'.repeat(6) + ' overflow probe', name_ar: 'QA · منفذ باسم طويل جدًا لاختبار التفاف النص والفيض في الجداول والبطاقات', status: 'active', warehouseId: 'qa-wh-inst-b', organization_id: ORG_B },
  ],
  profiles: [
    { id: 'qa-user-1', full_name: `${QA} · مسؤول النظام`, role: 'super_admin', status: 'active', organization_id: null },
    { id: 'qa-user-2', full_name: `${QA} · أمين مذخر`, role: 'warehouse_officer', status: 'active', organization_id: ORG_A },
    { id: 'qa-user-3', full_name: `${QA} · أمين منفذ (موقوف)`, role: 'outlet_officer', status: 'suspended', organization_id: ORG_A },
  ],

  // QR tokens — drives the active/disabled QR tiles (counted head-only).
  qr_tokens: [
    { id: 'qa-qr-1', status: 'active', organization_id: ORG_A },
    { id: 'qa-qr-2', status: 'active', organization_id: ORG_A },
    { id: 'qa-qr-3', status: 'active', organization_id: ORG_B },
    { id: 'qa-qr-4', status: 'active', organization_id: ORG_B },
    { id: 'qa-qr-5', status: 'active', organization_id: ORG_A },
    { id: 'qa-qr-6', status: 'disabled', organization_id: ORG_B },
  ],

  // Manual status reports — drives the "Status Reports" summary tiles
  // (getStatusReportCounts reads status_type + is_active).
  institution_item_status_reports: [
    { id: 'qa-sr-1', status_type: 'scarce', is_active: true, organization_id: ORG_A },
    { id: 'qa-sr-2', status_type: 'scarce', is_active: true, organization_id: ORG_B },
    { id: 'qa-sr-3', status_type: 'surplus', is_active: true, organization_id: ORG_A },
    { id: 'qa-sr-4', status_type: 'near_expiry', is_active: true, organization_id: ORG_A },
    { id: 'qa-sr-5', status_type: 'missing', is_active: true, organization_id: ORG_B },
    { id: 'qa-sr-6', status_type: 'scarce', is_active: false, organization_id: ORG_A },
  ],

  // ── Read RPC fixtures (shapes match the real read-only RPCs) ──────────────

  // phoenix_get_dashboard_condition_counts → a single object of per-condition
  // COUNTS. Drives the hero stock-health ring and the condition tiles.
  // ring = 128 / (128 + 22 + 9) = 80.5% → 81%.
  'rpc:phoenix_get_dashboard_condition_counts': {
    available: 128, low_stock: 22, missing: 9, near_expiry: 14, surplus: 6,
  },

  // phoenix_get_institution_condition_counts → one row per org. Drives the
  // Institution Status cards' available/low/missing readouts.
  'rpc:phoenix_get_institution_condition_counts': [
    { organization_id: ORG_A, available: 76, low: 8, missing: 3 },
    { organization_id: ORG_B, available: 52, low: 14, missing: 6 },
  ],

  // phoenix_get_live_inter_institution_alerts_with_state → an object with an
  // `ok` flag and an `alerts` array. Empty list → the widget's clean "no live
  // alerts" state (a valid populated state, not an error banner).
  'rpc:phoenix_get_live_inter_institution_alerts_with_state': {
    ok: true, alerts: [], computed_at: '2026-07-20T09:00:00Z',
  },
};
