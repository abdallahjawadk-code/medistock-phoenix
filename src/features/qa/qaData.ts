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
/** Exported so the scope-assignment fixtures bind to the SAME organization ids. */
export const ORG_A = 'qa-org-a1';
export const ORG_B = 'qa-org-b2';

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
    // A second ORG_A warehouse holding NO stock. The OCR capture runner needs
    // both: `qa-wh-inst-a` collides with the eval fixture and proves the
    // blocking duplicate/conflict gate, while this empty one is the only way to
    // reach the final preview and confirmation states at all.
    { id: 'qa-wh-inst-a-empty', name: 'QA · Al-Hilla Annex Store (empty)', name_ar: 'QA · مذخر الحلة الفرعي (فارغ)', warehouseKind: 'institution', status: 'active', organization_id: ORG_A },
    { id: 'qa-wh-inst-b', name: 'QA · Al-Sadiq Institution Store', name_ar: 'QA · مذخر الصادق', warehouseKind: 'institution', status: 'inactive', organization_id: ORG_B },
  ],
  // Rows are read through getPointsByOrg, which selects the REAL column names
  // and maps warehouse_id → warehouseId / point_type → pointType. These keys
  // must therefore be snake_case: a camelCase `warehouseId` here resolves to
  // undefined, which silently breaks the migration-062 warehouse → outlet
  // derivation in useInventoryScopes.manageableOutlets.
  distribution_points: [
    { id: 'qa-outlet-1', name: 'QA · Emergency Outlet', name_ar: 'QA · منفذ الطوارئ', status: 'active', warehouse_id: 'qa-wh-inst-a', organization_id: ORG_A, point_type: 'pharmacy' },
    { id: 'qa-outlet-2', name: 'QA · Pediatrics Outlet', name_ar: 'QA · منفذ الأطفال', status: 'active', warehouse_id: 'qa-wh-inst-a', organization_id: ORG_A, point_type: 'crash_cabinet' },
    { id: 'qa-outlet-3', name: 'QA · Long Name Outlet ' + '—'.repeat(6) + ' overflow probe', name_ar: 'QA · منفذ باسم طويل جدًا لاختبار التفاف النص والفيض في الجداول والبطاقات', status: 'active', warehouse_id: 'qa-wh-inst-b', organization_id: ORG_B, point_type: 'pharmacy' },
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

  // Authorized central catalog — drives OCR tier-2/3 matching in the Inventory
  // Center intake scene. `central_items` really does carry only
  // (name, name_ar, barcode, unit, category, status); see ocr/catalog-adapter.ts
  // for why that makes tier-1 national-code matching inert. These rows are
  // shaped to exercise all three match outcomes against the eval fixtures:
  //   Amoxicillin        → UNIQUE   (one active row)
  //   Paracetamol        → AMBIGUOUS (two strengths, indistinguishable without
  //                        a concentration column — the documented blocker)
  //   Ceftriaxone        → absent   → NO_MATCH
  central_items: [
    { id: 'qa-ci-amox', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', barcode: 'QA0000000001', unit: 'capsule', category: 'antibiotic', status: 'active' },
    { id: 'qa-ci-para-500', name: 'Paracetamol', name_ar: 'باراسيتامول', barcode: 'QA0000000002', unit: 'tablet', category: 'analgesic', status: 'active' },
    { id: 'qa-ci-para-1g', name: 'Paracetamol', name_ar: 'باراسيتامول', barcode: 'QA0000000003', unit: 'vial', category: 'analgesic', status: 'active' },
    { id: 'qa-ci-omep', name: 'Omeprazole', name_ar: 'أوميبرازول', barcode: 'QA0000000004', unit: 'capsule', category: 'gastro', status: 'active' },
    { id: 'qa-ci-retired', name: 'Streptomycin', name_ar: 'ستربتومايسين', barcode: 'QA0000000005', unit: 'vial', category: 'antibiotic', status: 'retired' },
  ],

  // Existing warehouse batches. The first row deliberately COLLIDES with the
  // `en-clean-amoxicillin` eval fixture (same scientific name + batch number,
  // DIFFERENT expiry) so the OCR review surfaces a blocking `expiry_conflict`
  // without any mutation. Columns match getWarehouseStock's select exactly.
  warehouse_stock: [
    { id: 'qa-ws-1', warehouse_id: 'qa-wh-inst-a', scientific_name: 'Amoxicillin', batch_number: 'B4471X', expiry_date: '2028-01-31', on_hand_quantity: 180, reserved_quantity: 20, available_quantity: 160, national_code: '1234567' },
    { id: 'qa-ws-2', warehouse_id: 'qa-wh-inst-a', scientific_name: 'Omeprazole', batch_number: 'OMP5512', expiry_date: '2027-02-28', on_hand_quantity: 640, reserved_quantity: 0, available_quantity: 640, national_code: '2223334' },
    { id: 'qa-ws-3', warehouse_id: 'qa-wh-inst-a', scientific_name: 'Paracetamol', batch_number: null, expiry_date: '2026-09-30', on_hand_quantity: 42, reserved_quantity: 12, available_quantity: 30, national_code: null },
  ],

  // ── Read RPC fixtures (shapes match the real read-only RPCs) ──────────────

  // phoenix_get_pending_platform_broadcasts → { ok, broadcasts }. The broadcast
  // gate mounts inside PhoenixAppShell, so EVERY shell-based scene calls this on
  // mount; without a fixture it logged a console error on every captured cell.
  // An empty queue is the correct clean state — no modal over the screenshot.
  'rpc:phoenix_get_pending_platform_broadcasts': { ok: true, broadcasts: [] },

  // phoenix_get_dashboard_condition_counts → a single object of per-condition
  // COUNTS. Drives the hero reported-availability ring and the condition tiles.
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
