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
/**
 * Deterministic LOCAL outcomes for a small, explicit allowlist of migration-071
 * write RPCs (see qaFixtureClient's contract note).
 *
 * The canonical receipt — print, optional-field selector, XLSX, QR — renders
 * only AFTER a create or a receive, so no set of SELECT fixtures can reach it.
 * These outcomes let the harness reach that screen. Nothing is written, no
 * database is contacted, and no permission decision is made or bypassed here:
 * an outcome is a canned response shape, not an authorization result.
 *
 * Payload keys mirror what the real RPCs return, because movement-commit's
 * `readId` looks for exactly these (`return_request_id`, `id`, …). Every RPC
 * NOT listed here still fails closed with QA_READONLY.
 */
export const QA_MUTATION_OUTCOMES: Record<string, unknown> = {
  phoenix_request_outlet_return: { ok: true, return_request_id: '0aa11111-0000-4000-8000-000000000001' },
  phoenix_add_outlet_return_request_line: { ok: true, return_request_line_id: '0cc33333-0000-4000-8000-000000000001' },
  phoenix_submit_outlet_return_request: { ok: true },
  phoenix_receive_outlet_return_shipment_line: { ok: true },
};

/** Exported so the scope-assignment fixtures bind to the SAME organization ids. */
export const ORG_A = 'qa-org-a1';
export const ORG_B = 'qa-org-b2';

/**
 * Canonical UUIDs for the migration-071 return corridor.
 *
 * These MUST be real UUIDs rather than `qa-*` slugs: the QR payload and the
 * Current Movement Status lookup both parse a canonical UUID and reject
 * anything else, so a slug would make those surfaces untestable. The 0a/0b/0c
 * prefixes keep them obviously synthetic, and the production-safety test
 * asserts every one of them is absent from `dist/`.
 */
export const RR_SUBMITTED = '0aa11111-0000-4000-8000-000000000001';
export const RR_PARTIAL   = '0aa11111-0000-4000-8000-000000000002';
export const RR_COMPLETED = '0aa11111-0000-4000-8000-000000000003';
export const RR_REJECTED  = '0aa11111-0000-4000-8000-000000000004';

export const RRL_1 = '0cc33333-0000-4000-8000-000000000001';
export const RRL_2 = '0cc33333-0000-4000-8000-000000000002';
export const RRL_3 = '0cc33333-0000-4000-8000-000000000003';

export const SH_IN_TRANSIT = '0bb22222-0000-4000-8000-000000000001';
export const SH_PARTIAL    = '0bb22222-0000-4000-8000-000000000002';
export const SH_RECEIVED   = '0bb22222-0000-4000-8000-000000000003';

export const SHL_1 = '0dd44444-0000-4000-8000-000000000001';
export const SHL_2 = '0dd44444-0000-4000-8000-000000000002';
export const SHL_3 = '0dd44444-0000-4000-8000-000000000003';
export const SHL_4 = '0dd44444-0000-4000-8000-000000000004';

/** Upstream dispatch lines these returns trace back to (provenance). */
export const DISPATCH_LINE_1 = '0ee55555-0000-4000-8000-000000000001';
export const DISPATCH_LINE_2 = '0ee55555-0000-4000-8000-000000000002';
export const DISPATCH_LINE_3 = '0ee55555-0000-4000-8000-000000000003';

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

  // On-hand batches at each outlet. These are the rows the return request lines
  // above cite as `source_outlet_stock_id`, so the corridor's provenance chain
  // (outlet stock → return line → shipment line) resolves end to end.
  outlet_stock: [
    { id: 'qa-os-1', distribution_point_id: 'qa-outlet-1', scientific_name: 'Amoxicillin', trade_name: null, concentration: '500 mg', dosage_form: 'Capsule', unit: 'capsule', national_code: '1234567', batch_number: 'B4471X', internal_batch_reference: null, expiry_date: '2028-01-31', on_hand_quantity: 120, reserved_quantity: 40, available_quantity: 80 },
    { id: 'qa-os-2', distribution_point_id: 'qa-outlet-1', scientific_name: 'Omeprazole', trade_name: null, concentration: '20 mg', dosage_form: 'Capsule', unit: 'capsule', national_code: '2223334', batch_number: 'OMP5512', internal_batch_reference: null, expiry_date: '2027-02-28', on_hand_quantity: 90, reserved_quantity: 20, available_quantity: 70 },
    { id: 'qa-os-3', distribution_point_id: 'qa-outlet-1', scientific_name: 'Paracetamol', trade_name: null, concentration: '500 mg', dosage_form: 'Tablet', unit: 'tablet', national_code: null, batch_number: null, internal_batch_reference: 'QA-INT-77', expiry_date: '2026-09-30', on_hand_quantity: 18, reserved_quantity: 6, available_quantity: 12 },
    { id: 'qa-os-4', distribution_point_id: 'qa-outlet-2', scientific_name: 'Amoxicillin', trade_name: null, concentration: '500 mg', dosage_form: 'Capsule', unit: 'capsule', national_code: '1234567', batch_number: 'B4471X', internal_batch_reference: null, expiry_date: '2028-01-31', on_hand_quantity: 60, reserved_quantity: 0, available_quantity: 60 },
  ],

  // Read-only ledger behind Movement History. Current-state rows only — this is
  // NOT a reconstructed historical timeline (that needs the timeline RPC).
  outlet_stock_movements: [
    { id: 'qa-om-1', distribution_point_id: 'qa-outlet-1', movement_type: 'receipt', scientific_name_snapshot: 'Amoxicillin', batch_number_snapshot: 'B4471X', expiry_date_snapshot: '2028-01-31', on_hand_before: 80, on_hand_delta: 40, on_hand_after: 120, reason: 'QA · direct supply received', source_document_number: 'QA-DSP-0007', actor_name: 'QA · أمين المنفذ', created_at: '2026-07-19T07:30:00Z' },
    { id: 'qa-om-2', distribution_point_id: 'qa-outlet-1', movement_type: 'return_out', scientific_name_snapshot: 'Paracetamol', batch_number_snapshot: null, expiry_date_snapshot: '2026-09-30', on_hand_before: 24, on_hand_delta: -6, on_hand_after: 18, reason: 'QA · damaged stock returned', source_document_number: 'QA-RET-0002', actor_name: 'QA · أمين المنفذ', created_at: '2026-07-17T12:00:00Z' },
    { id: 'qa-om-3', distribution_point_id: 'qa-outlet-1', movement_type: 'dispense', scientific_name_snapshot: 'Omeprazole', batch_number_snapshot: 'OMP5512', expiry_date_snapshot: '2027-02-28', on_hand_before: 100, on_hand_delta: -10, on_hand_after: 90, reason: 'QA · dispensed to ward', source_document_number: null, actor_name: null, created_at: '2026-07-16T10:10:00Z' },
  ],

  // ── Migration-071 outlet return corridor ─────────────────────────────────
  //
  // Rows are read through outlet-return.service, which selects the REAL column
  // names, so every key here is snake_case exactly as the table declares it.
  //
  // Ids are canonical UUIDs, not `qa-*` slugs: the QR payload and the Current
  // Movement Status lookup both parse a canonical UUID, so a slug id would make
  // those surfaces unreachable. They remain obviously synthetic (the 0a/0b/0c
  // prefixes and the QA return numbers) and are asserted absent from dist/.
  //
  // Provenance is complete and internally consistent: every line points at the
  // outlet stock row and dispatch line it came from, every shipment points at
  // its request, and every shipment line points at its request line.
  outlet_return_requests: [
    // Submitted, awaiting review — the individual-receipt path.
    { id: RR_SUBMITTED, distribution_point_id: 'qa-outlet-1', source_organization_id: ORG_A, destination_warehouse_id: 'qa-wh-inst-a', destination_organization_id: ORG_A, return_number: 'QA-RET-0001', status: 'submitted', requested_by_side: 'outlet', notes: 'QA · near-expiry stock returned to the institution store', created_at: '2026-07-18T08:15:00Z' },
    // Partially fulfilled — drives the partial-outcome evidence.
    { id: RR_PARTIAL, distribution_point_id: 'qa-outlet-1', source_organization_id: ORG_A, destination_warehouse_id: 'qa-wh-inst-a', destination_organization_id: ORG_A, return_number: 'QA-RET-0002', status: 'partially_fulfilled', requested_by_side: 'outlet', notes: 'QA · one line short-shipped', created_at: '2026-07-17T11:40:00Z' },
    // Completed — the terminal, non-receivable state.
    { id: RR_COMPLETED, distribution_point_id: 'qa-outlet-2', source_organization_id: ORG_A, destination_warehouse_id: 'qa-wh-inst-a', destination_organization_id: ORG_A, return_number: 'QA-RET-0003', status: 'completed', requested_by_side: 'outlet', notes: null, created_at: '2026-07-15T09:05:00Z' },
    // Rejected — a failed request, never shipped.
    { id: RR_REJECTED, distribution_point_id: 'qa-outlet-1', source_organization_id: ORG_A, destination_warehouse_id: 'qa-wh-inst-a', destination_organization_id: ORG_A, return_number: 'QA-RET-0004', status: 'rejected', requested_by_side: 'outlet', notes: 'QA · rejected on review', created_at: '2026-07-14T13:25:00Z' },
  ],

  outlet_return_request_lines: [
    { id: RRL_1, return_request_id: RR_SUBMITTED, original_dispatch_line_id: DISPATCH_LINE_1, source_outlet_stock_id: 'qa-os-1', scientific_name: 'Amoxicillin', concentration: '500 mg', dosage_form: 'Capsule', unit: 'capsule', national_code: '1234567', batch_number: 'B4471X', internal_batch_reference: null, expiry_date: '2028-01-31', reason_code: 'near_expiry', reason_text: 'QA · within 90 days of expiry', requested_quantity: 40, approved_quantity: 40, fulfilled_quantity: 0, status: 'pending' },
    { id: RRL_2, return_request_id: RR_SUBMITTED, original_dispatch_line_id: DISPATCH_LINE_2, source_outlet_stock_id: 'qa-os-2', scientific_name: 'Omeprazole', concentration: '20 mg', dosage_form: 'Capsule', unit: 'capsule', national_code: '2223334', batch_number: 'OMP5512', internal_batch_reference: null, expiry_date: '2027-02-28', reason_code: 'surplus', reason_text: null, requested_quantity: 25, approved_quantity: 20, fulfilled_quantity: 0, status: 'pending' },
    { id: RRL_3, return_request_id: RR_PARTIAL, original_dispatch_line_id: DISPATCH_LINE_3, source_outlet_stock_id: 'qa-os-3', scientific_name: 'Paracetamol', concentration: '500 mg', dosage_form: 'Tablet', unit: 'tablet', national_code: null, batch_number: null, internal_batch_reference: 'QA-INT-77', expiry_date: '2026-09-30', reason_code: 'damaged', reason_text: 'QA · crushed blister', requested_quantity: 12, approved_quantity: 6, fulfilled_quantity: 6, status: 'partially_fulfilled' },
  ],

  outlet_return_shipments: [
    // In transit against the submitted request — receivable, so this is the
    // shipment the institution receipt surface offers for receiving.
    { id: SH_IN_TRANSIT, return_request_id: RR_SUBMITTED, distribution_point_id: 'qa-outlet-1', destination_warehouse_id: 'qa-wh-inst-a', shipment_number: 'QA-SHP-0001', status: 'in_transit' },
    // Partially received — the partial-failure evidence.
    { id: SH_PARTIAL, return_request_id: RR_PARTIAL, distribution_point_id: 'qa-outlet-1', destination_warehouse_id: 'qa-wh-inst-a', shipment_number: 'QA-SHP-0002', status: 'partially_received' },
    // Fully received — terminal, must NOT appear in the receivable queue.
    { id: SH_RECEIVED, return_request_id: RR_COMPLETED, distribution_point_id: 'qa-outlet-2', destination_warehouse_id: 'qa-wh-inst-a', shipment_number: 'QA-SHP-0003', status: 'received' },
  ],

  outlet_return_shipment_lines: [
    { id: SHL_1, shipment_id: SH_IN_TRANSIT, return_request_line_id: RRL_1, original_dispatch_line_id: DISPATCH_LINE_1, scientific_name: 'Amoxicillin', batch_number: 'B4471X', expiry_date: '2028-01-31', sent_quantity: 40, received_quantity: null, status: 'sent', difference_reason: null, disposition: null, custody_state: 'in_transit' },
    { id: SHL_2, shipment_id: SH_IN_TRANSIT, return_request_line_id: RRL_2, original_dispatch_line_id: DISPATCH_LINE_2, scientific_name: 'Omeprazole', batch_number: 'OMP5512', expiry_date: '2027-02-28', sent_quantity: 20, received_quantity: null, status: 'sent', difference_reason: null, disposition: null, custody_state: 'in_transit' },
    // A short-shipped line: sent 6, only 4 arrived, with the difference stated.
    { id: SHL_3, shipment_id: SH_PARTIAL, return_request_line_id: RRL_3, original_dispatch_line_id: DISPATCH_LINE_3, scientific_name: 'Paracetamol', batch_number: null, expiry_date: '2026-09-30', sent_quantity: 6, received_quantity: 4, status: 'received_with_difference', difference_reason: 'QA · 2 units missing on arrival', disposition: 'quarantine', custody_state: 'received' },
    { id: SHL_4, shipment_id: SH_RECEIVED, return_request_line_id: null, original_dispatch_line_id: DISPATCH_LINE_1, scientific_name: 'Amoxicillin', batch_number: 'B4471X', expiry_date: '2028-01-31', sent_quantity: 10, received_quantity: 10, status: 'received', difference_reason: null, disposition: 'return_to_stock', custody_state: 'received' },
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

  // ── INSTITUTION-LOCAL-PROCUREMENT-087 — Screen 19 fixtures ────────────────
  // Column names are the REAL snake_case DB columns the mapXxx() readers in
  // procurement.service.ts consume; the fixture client filters on the same
  // .eq('warehouse_id'|'organization_id'|'order_id', …) the service issues.
  // Rows span every lifecycle status so the composer / approvals / receiving /
  // history tabs each render populated, and the History tab reaches the
  // official receipt (print · XLSX · QR) and a provenance-pinned return.
  procurement_suppliers: [
    { id: 'qa-sup-1', organization_id: ORG_A, name: 'QA · Al-Rasheed Medical Supplies', name_ar: 'QA · الرشيد للتجهيزات الطبية', contact_person: 'QA · علي حسن', phone: '0790-000-0001', email: null, address: 'QA · الحلة', tax_number: null, notes: null, status: 'active' },
    { id: 'qa-sup-2', organization_id: ORG_A, name: 'QA · Babil Pharma Trading', name_ar: 'QA · بابل لتجارة الأدوية', contact_person: 'QA · حسين كريم', phone: '0770-000-0002', email: null, address: 'QA · بابل', tax_number: null, notes: null, status: 'active' },
    { id: 'qa-sup-3', organization_id: ORG_A, name: 'QA · Retired Supplier', name_ar: 'QA · مورد موقوف', contact_person: null, phone: null, email: null, address: null, tax_number: null, notes: null, status: 'inactive' },
  ],
  procurement_orders: [
    { id: 'qa-po-draft', organization_id: ORG_A, warehouse_id: 'qa-wh-inst-a', supplier_id: 'qa-sup-1', order_number: 'QA-PO-1001', status: 'draft', invoice_number: 'QA-INV-1001', invoice_date: '2026-07-10', external_reference: null, currency: 'IQD', notes: null, ocr_assisted: false, order_generation: 1, submitted_by: null, submitted_at: null, decided_by: null, decided_at: null, decision_notes: null, cancel_reason: null, created_by: 'qa-user-2', created_at: '2026-07-10T08:00:00Z' },
    { id: 'qa-po-submitted', organization_id: ORG_A, warehouse_id: 'qa-wh-inst-a', supplier_id: 'qa-sup-1', order_number: 'QA-PO-1002', status: 'submitted', invoice_number: 'QA-INV-1002', invoice_date: '2026-07-12', external_reference: null, currency: 'IQD', notes: null, ocr_assisted: true, order_generation: 3, submitted_by: 'qa-user-2', submitted_at: '2026-07-12T09:30:00Z', decided_by: null, decided_at: null, decision_notes: null, cancel_reason: null, created_by: 'qa-user-2', created_at: '2026-07-12T08:00:00Z' },
    { id: 'qa-po-approved', organization_id: ORG_A, warehouse_id: 'qa-wh-inst-a', supplier_id: 'qa-sup-2', order_number: 'QA-PO-1003', status: 'approved', invoice_number: 'QA-INV-1003', invoice_date: '2026-07-13', external_reference: null, currency: 'IQD', notes: null, ocr_assisted: false, order_generation: 4, submitted_by: 'qa-user-2', submitted_at: '2026-07-13T09:00:00Z', decided_by: 'qa-user-1', decided_at: '2026-07-13T11:00:00Z', decision_notes: 'QA · معتمد', cancel_reason: null, created_by: 'qa-user-2', created_at: '2026-07-13T08:00:00Z' },
    { id: 'qa-po-partial', organization_id: ORG_A, warehouse_id: 'qa-wh-inst-a', supplier_id: 'qa-sup-2', order_number: 'QA-PO-1004', status: 'partially_received', invoice_number: 'QA-INV-1004', invoice_date: '2026-07-14', external_reference: null, currency: 'IQD', notes: null, ocr_assisted: false, order_generation: 6, submitted_by: 'qa-user-2', submitted_at: '2026-07-14T09:00:00Z', decided_by: 'qa-user-1', decided_at: '2026-07-14T10:00:00Z', decision_notes: null, cancel_reason: null, created_by: 'qa-user-2', created_at: '2026-07-14T08:00:00Z' },
    { id: 'qa-po-received', organization_id: ORG_A, warehouse_id: 'qa-wh-inst-a', supplier_id: 'qa-sup-1', order_number: 'QA-PO-1005', status: 'received', invoice_number: 'QA-INV-1005', invoice_date: '2026-07-08', external_reference: null, currency: 'IQD', notes: null, ocr_assisted: false, order_generation: 7, submitted_by: 'qa-user-2', submitted_at: '2026-07-08T09:00:00Z', decided_by: 'qa-user-1', decided_at: '2026-07-08T10:00:00Z', decision_notes: null, cancel_reason: null, created_by: 'qa-user-2', created_at: '2026-07-08T08:00:00Z' },
    { id: 'qa-po-rejected', organization_id: ORG_A, warehouse_id: 'qa-wh-inst-a', supplier_id: 'qa-sup-1', order_number: 'QA-PO-1006', status: 'rejected', invoice_number: null, invoice_date: null, external_reference: null, currency: 'IQD', notes: null, ocr_assisted: false, order_generation: 3, submitted_by: 'qa-user-2', submitted_at: '2026-07-09T09:00:00Z', decided_by: 'qa-user-1', decided_at: '2026-07-09T12:00:00Z', decision_notes: 'QA · خارج الحاجة الحالية', cancel_reason: null, created_by: 'qa-user-2', created_at: '2026-07-09T08:00:00Z' },
  ],
  procurement_order_lines: [
    { id: 'qa-pol-1', order_id: 'qa-po-approved', central_item_id: null, scientific_name: 'QA · Paracetamol', trade_name: 'QA · Pamol', concentration: '500 mg', dosage_form: 'Tablet', unit: 'box', national_code: 'QA-NC-01', batch_number: 'QA-B-100', expiry_date: '2027-06-30', ordered_quantity: 40, received_quantity: 0, unit_price: 250, currency: 'IQD', notes: null },
    { id: 'qa-pol-2', order_id: 'qa-po-approved', central_item_id: null, scientific_name: 'QA · Ibuprofen', trade_name: null, concentration: '400 mg', dosage_form: 'Tablet', unit: 'box', national_code: null, batch_number: null, expiry_date: '2027-09-30', ordered_quantity: 20, received_quantity: 0, unit_price: 400, currency: 'IQD', notes: null },
    { id: 'qa-pol-3', order_id: 'qa-po-partial', central_item_id: null, scientific_name: 'QA · Amoxicillin', trade_name: null, concentration: '500 mg', dosage_form: 'Capsule', unit: 'box', national_code: 'QA-NC-03', batch_number: 'QA-B-300', expiry_date: '2027-03-31', ordered_quantity: 30, received_quantity: 10, unit_price: 300, currency: 'IQD', notes: null },
    { id: 'qa-pol-4', order_id: 'qa-po-received', central_item_id: null, scientific_name: 'QA · Omeprazole', trade_name: null, concentration: '20 mg', dosage_form: 'Capsule', unit: 'box', national_code: 'QA-NC-04', batch_number: 'QA-B-400', expiry_date: '2028-01-31', ordered_quantity: 12, received_quantity: 12, unit_price: 500, currency: 'IQD', notes: null },
    { id: 'qa-pol-5', order_id: 'qa-po-draft', central_item_id: null, scientific_name: 'QA · Metformin', trade_name: null, concentration: '850 mg', dosage_form: 'Tablet', unit: 'box', national_code: null, batch_number: null, expiry_date: '2027-12-31', ordered_quantity: 25, received_quantity: 0, unit_price: 180, currency: 'IQD', notes: null },
    { id: 'qa-pol-6', order_id: 'qa-po-submitted', central_item_id: null, scientific_name: 'QA · Azithromycin', trade_name: null, concentration: '250 mg', dosage_form: 'Tablet', unit: 'box', national_code: null, batch_number: null, expiry_date: '2027-11-30', ordered_quantity: 15, received_quantity: 0, unit_price: 600, currency: 'IQD', notes: null },
  ],
  procurement_receipts: [
    { id: 'qa-prc-1', order_id: 'qa-po-received', organization_id: ORG_A, warehouse_id: 'qa-wh-inst-a', supplier_id: 'qa-sup-1', receipt_number: 'QA-PR-2026-000001', invoice_number: 'QA-INV-1005', notes: null, received_by: 'qa-user-2', received_by_name: 'QA · أمين مذخر', received_by_role: 'warehouse_officer', created_at: '2026-07-08T12:00:00Z' },
    { id: 'qa-prc-2', order_id: 'qa-po-partial', organization_id: ORG_A, warehouse_id: 'qa-wh-inst-a', supplier_id: 'qa-sup-2', receipt_number: 'QA-PR-2026-000002', invoice_number: 'QA-INV-1004', notes: 'QA · دفعة أولى', received_by: 'qa-user-2', received_by_name: 'QA · أمين مذخر', received_by_role: 'warehouse_officer', created_at: '2026-07-14T12:00:00Z' },
  ],
  procurement_receipt_lines: [
    { id: 'qa-prl-1', receipt_id: 'qa-prc-1', order_line_id: 'qa-pol-4', quantity: 12, batch_number: 'QA-B-400', has_no_batch_number: false, national_code: 'QA-NC-04', expiry_date: '2028-01-31', unit_price: 500, warehouse_stock_id: 'qa-ws-400', movement_id: 'qa-mv-400', created_at: '2026-07-08T12:00:00Z' },
    { id: 'qa-prl-2', receipt_id: 'qa-prc-2', order_line_id: 'qa-pol-3', quantity: 10, batch_number: 'QA-B-300', has_no_batch_number: false, national_code: 'QA-NC-03', expiry_date: '2027-03-31', unit_price: 300, warehouse_stock_id: 'qa-ws-300', movement_id: 'qa-mv-300', created_at: '2026-07-14T12:00:00Z' },
  ],
  procurement_returns: [
    { id: 'qa-pret-1', order_id: 'qa-po-received', receipt_line_id: 'qa-prl-1', quantity: 2, reason: 'QA · تلف أثناء النقل', notes: null, movement_id: 'qa-mv-ret-1', actor_name: 'QA · أمين مذخر', created_at: '2026-07-09T09:00:00Z' },
  ],
  procurement_order_events: [
    { id: 'qa-pev-1', order_id: 'qa-po-received', event_type: 'created', from_status: null, to_status: 'draft', actor_name: 'QA · أمين مذخر', actor_role: 'warehouse_officer', notes: null, created_at: '2026-07-08T08:00:00Z' },
    { id: 'qa-pev-2', order_id: 'qa-po-received', event_type: 'submitted', from_status: 'draft', to_status: 'submitted', actor_name: 'QA · أمين مذخر', actor_role: 'warehouse_officer', notes: null, created_at: '2026-07-08T09:00:00Z' },
    { id: 'qa-pev-3', order_id: 'qa-po-received', event_type: 'approved', from_status: 'submitted', to_status: 'approved', actor_name: 'QA · مسؤول النظام', actor_role: 'super_admin', notes: null, created_at: '2026-07-08T10:00:00Z' },
    { id: 'qa-pev-4', order_id: 'qa-po-received', event_type: 'receipt_posted', from_status: 'approved', to_status: 'received', actor_name: 'QA · أمين مذخر', actor_role: 'warehouse_officer', notes: null, created_at: '2026-07-08T12:00:00Z' },
  ],

  // ── Screen 12 — Status Center («مواقف») / Screen 9 — Reports & tracking ──
  // getAvailabilityByOrg/getLowStockItems select a nested `distribution_points`
  // / `local_items.central_items` shape (a real PostgREST embedded-relation
  // response); the fixture client does no joins, so those nested objects must
  // be literal on the row itself, matching exactly what the real query returns.
  item_availability: [
    {
      id: 'qa-ia-1', organization_id: ORG_A, distribution_point_id: 'qa-outlet-1',
      scientific_name: 'Amoxicillin', trade_name: null, dosage_form: 'Capsule', concentration: '500 mg', price: null,
      quantity: 160, condition: 'available', batch_number: 'B4471X', national_code: '1234567', expiry_date: '2028-01-31',
      notes: null, supply_type: null, updated_at: '2026-07-19T07:30:00Z',
      removed_at: null, removal_reason: null,
      distribution_points: { id: 'qa-outlet-1', name: 'QA · Emergency Outlet', name_ar: 'QA · منفذ الطوارئ', status: 'active' },
      local_items: { id: 'qa-li-1', local_code: 'L-001', central_items: { id: 'qa-ci-amox', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', unit: 'capsule', barcode: 'QA0000000001' } },
    },
    {
      id: 'qa-ia-2', organization_id: ORG_A, distribution_point_id: 'qa-outlet-1',
      scientific_name: 'Paracetamol', trade_name: null, dosage_form: 'Tablet', concentration: '500 mg', price: null,
      quantity: 12, condition: 'low_stock', batch_number: null, national_code: null, expiry_date: '2026-09-30',
      notes: null, supply_type: null, updated_at: '2026-07-17T12:00:00Z',
      removed_at: null, removal_reason: null,
      distribution_points: { id: 'qa-outlet-1', name: 'QA · Emergency Outlet', name_ar: 'QA · منفذ الطوارئ', status: 'active' },
      local_items: { id: 'qa-li-2', local_code: 'L-002', central_items: { id: 'qa-ci-para-500', name: 'Paracetamol', name_ar: 'باراسيتامول', unit: 'tablet', barcode: 'QA0000000002' } },
    },
    {
      id: 'qa-ia-3', organization_id: ORG_A, distribution_point_id: 'qa-outlet-2',
      scientific_name: 'Ceftriaxone', trade_name: null, dosage_form: 'Vial', concentration: '1 g', price: null,
      quantity: 0, condition: 'missing', batch_number: null, national_code: null, expiry_date: null,
      notes: 'QA · نفدت الكمية', supply_type: null, updated_at: '2026-07-16T09:00:00Z',
      removed_at: null, removal_reason: null,
      distribution_points: { id: 'qa-outlet-2', name: 'QA · Pediatrics Outlet', name_ar: 'QA · منفذ الأطفال', status: 'active' },
      local_items: { id: 'qa-li-3', local_code: 'L-003', central_items: { id: 'qa-ci-ceft', name: 'Ceftriaxone', name_ar: 'سيفترياكسون', unit: 'vial', barcode: 'QA0000000006' } },
    },
    {
      id: 'qa-ia-4', organization_id: ORG_A, distribution_point_id: 'qa-outlet-1',
      scientific_name: 'Omeprazole', trade_name: null, dosage_form: 'Capsule', concentration: '20 mg', price: null,
      quantity: 70, condition: 'near_expiry', batch_number: 'OMP5512', national_code: '2223334', expiry_date: '2026-08-15',
      notes: null, supply_type: null, updated_at: '2026-07-16T10:10:00Z',
      removed_at: null, removal_reason: null,
      distribution_points: { id: 'qa-outlet-1', name: 'QA · Emergency Outlet', name_ar: 'QA · منفذ الطوارئ', status: 'active' },
      local_items: { id: 'qa-li-4', local_code: 'L-004', central_items: { id: 'qa-ci-omep', name: 'Omeprazole', name_ar: 'أوميبرازول', unit: 'capsule', barcode: 'QA0000000004' } },
    },
  ],

  // ── Screen 20 — Monthly Stock Status («الموقف المخزني الشهري») ───────────
  // getOpenMonthlyStatusReport (`.neq('status','locked')`, inert filter in the
  // fixture client) and getLatestLockedMonthlyStatusReport (`.eq('status','locked')`,
  // a REAL filter) both read this table — ordering the open report first lets
  // the "open" read resolve to it, while the eq-filter always finds the locked
  // row regardless of array position.
  inventory_status_reports: [
    { id: 'qa-msr-open', organization_id: ORG_A, status: 'submitted', version: 2, amendment_of: null, prepared_by: 'qa-user-2', prepared_at: '2026-07-20T07:00:00Z', submitted_by: 'qa-user-2', submitted_at: '2026-07-20T08:00:00Z', approved_by: null, approved_at: null, locked_at: null, returned_by: null, returned_at: null, return_reason: null, created_at: '2026-07-20T07:00:00Z', updated_at: '2026-07-20T08:00:00Z' },
    { id: 'qa-msr-locked', organization_id: ORG_A, status: 'locked', version: 1, amendment_of: null, prepared_by: 'qa-user-2', prepared_at: '2026-06-20T07:00:00Z', submitted_by: 'qa-user-2', submitted_at: '2026-06-20T08:00:00Z', approved_by: 'qa-user-1', approved_at: '2026-06-20T10:00:00Z', locked_at: '2026-06-20T10:00:00Z', returned_by: null, returned_at: null, return_reason: null, created_at: '2026-06-20T07:00:00Z', updated_at: '2026-06-20T10:00:00Z' },
  ],
  inventory_status_report_lines: [
    { id: 'qa-msl-1', report_id: 'qa-msr-open', scientific_name: 'Amoxicillin', national_code: '1234567', on_hand_qty: 180, reserved_qty: 20, in_transit_qty: 0, quarantine_qty: 0, central_qty: 640, supplementary_qty: 0, nearest_expiry_date: '2028-01-31', suggested_classification: 'available', classification: 'available', classification_reason: null, classification_overridden: false, stocktake_count_line_id: null, confirmed_missing: false, confirmed_by: null, confirmed_at: null },
    { id: 'qa-msl-2', report_id: 'qa-msr-open', scientific_name: 'Paracetamol', national_code: null, on_hand_qty: 12, reserved_qty: 6, in_transit_qty: 0, quarantine_qty: 0, central_qty: 42, supplementary_qty: 0, nearest_expiry_date: '2026-09-30', suggested_classification: 'scarce', classification: null, classification_reason: null, classification_overridden: false, stocktake_count_line_id: null, confirmed_missing: false, confirmed_by: null, confirmed_at: null },
    { id: 'qa-msl-3', report_id: 'qa-msr-open', scientific_name: 'Ceftriaxone', national_code: null, on_hand_qty: 0, reserved_qty: 0, in_transit_qty: 0, quarantine_qty: 0, central_qty: 0, supplementary_qty: 0, nearest_expiry_date: null, suggested_classification: 'scarce', classification: 'suspected_missing', classification_reason: 'QA · لم يُرصد أي مخزون', classification_overridden: false, stocktake_count_line_id: null, confirmed_missing: false, confirmed_by: null, confirmed_at: null },
  ],

  // ── Quarantine disposition (migration 099/105) — Screen 3 "الحجر الصحي" tab ─
  warehouse_quarantine_stock: [
    { id: 'qa-wq-1', warehouse_id: 'qa-wh-inst-a', scientific_name: 'Paracetamol', batch_number: null, national_code: null, expiry_date: '2026-09-30', quarantine_reason: 'QA · نقص عدد الوحدات عند الاستلام (شحنة مرتجعة جزئياً)', quantity: 2 },
  ],

  // ── Second-person correction approval (migration 098/101) — Screen 3
  // "تصحيحات بانتظار الاعتماد" tab. proposed_by is a DIFFERENT profile than the
  // approving super_admin persona, matching the real second-person constraint.
  phoenix_stock_correction_requests: [
    { id: 'qa-ocr-1', outlet_stock_id: 'qa-os-3', on_hand_before: 18, counted_quantity: 12, variance: -6, reason: 'QA · جرد فعلي أظهر نقصاً', notes: null, status: 'pending', proposed_by: 'qa-user-3', proposed_at: '2026-07-21T09:00:00Z' },
  ],
  phoenix_warehouse_correction_requests: [
    { id: 'qa-wcr-1', warehouse_stock_id: 'qa-ws-3', on_hand_before: 42, new_quantity: 48, variance: 6, reason: 'QA · تصحيح بعد جرد المخزن', source_document_number: null, notes: null, status: 'pending', proposed_by: 'qa-user-2', proposed_at: '2026-07-21T10:00:00Z' },
  ],

  // ── Notification bell (migration 094/099) — read RPC fixtures ───────────
  // The bell mounts inside PhoenixTopbar/PhoenixAppShell, so EVERY shell-based
  // scene calls phoenix_notifications_unread_count on mount; without a
  // fixture it logs a console.error on every captured cell.
  'rpc:phoenix_notifications_unread_count': 2,
  // event_type values must match the real dotted `table.status` vocabulary
  // (see `notif_evt_*` keys in strings.ts) — anything else falls back through
  // eventLabel() to the raw key text, which is exactly the kind of leaked-key
  // defect this fixture should NOT manufacture.
  'rpc:phoenix_notifications_list': {
    ok: true,
    notifications: [
      { id: 'qa-notif-1', event_type: 'outlet_return_requests.submitted', occurred_at: '2026-07-20T08:00:00Z', actor_id: 'qa-user-2', actor_role: 'outlet_officer', actor_name: 'QA · أمين المنفذ', status: 'submitted', reference_type: 'outlet_return_request', reference_id: RR_SUBMITTED, reference: 'QA-RET-0001', is_read: false },
      { id: 'qa-notif-2', event_type: 'procurement_orders.approved', occurred_at: '2026-07-13T11:00:00Z', actor_id: 'qa-user-1', actor_role: 'super_admin', actor_name: 'QA · مسؤول النظام', status: 'approved', reference_type: 'procurement_order', reference_id: 'qa-po-approved', reference: 'QA-PO-1003', is_read: false },
      { id: 'qa-notif-3', event_type: 'inventory_status_reports.locked', occurred_at: '2026-06-20T10:00:00Z', actor_id: 'qa-user-1', actor_role: 'super_admin', actor_name: 'QA · مسؤول النظام', status: 'locked', reference_type: 'inventory_status_report', reference_id: 'qa-msr-locked', reference: null, is_read: true },
    ],
    next_cursor: null,
  },
};
