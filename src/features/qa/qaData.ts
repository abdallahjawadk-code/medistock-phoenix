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

export const QA_FIXTURES: Record<string, QaRow[]> = {
  organizations: [
    { id: ORG_A, name: 'QA · Al-Hilla Teaching Hospital', name_ar: 'QA · مستشفى الحلة التعليمي', status: 'active', kind: 'institution' },
    { id: ORG_B, name: 'QA · Al-Imam Al-Sadiq Hospital', name_ar: 'QA · مستشفى الإمام الصادق', status: 'active', kind: 'institution' },
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
};
