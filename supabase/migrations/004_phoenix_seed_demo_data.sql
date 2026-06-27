-- =============================================================================
-- MediStock Phoenix V2 — Migration 004: Demo Seed Data
-- Apply AFTER 003_phoenix_rpc_lifecycle.sql.
-- This seed is for demonstration and initial setup only.
-- All demo rows are tagged with a comment in their name/notes.
-- Safe to re-run (uses ON CONFLICT DO NOTHING).
-- =============================================================================

-- =============================================================================
-- ORGANIZATIONS (2)
-- =============================================================================
insert into organizations (id, name, name_ar, code, status, city)
values
  ('00000000-0000-0000-0000-000000000001',
   'Babil General Hospital',
   'مستشفى بابل العام',
   'babil-main',
   'active',
   'Babil'),
  ('00000000-0000-0000-0000-000000000002',
   'Al-Hilla Teaching Hospital',
   'مستشفى الحلة التعليمي',
   'hilla-teaching',
   'active',
   'Al-Hilla')
on conflict (id) do nothing;

-- =============================================================================
-- WAREHOUSES (2)
-- =============================================================================
insert into warehouses (id, organization_id, name, name_ar, status)
values
  ('00000000-0000-0000-0001-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'Central Pharmacy Warehouse',
   'مستودع الصيدلية المركزية',
   'active'),
  ('00000000-0000-0000-0001-000000000002',
   '00000000-0000-0000-0000-000000000002',
   'Al-Hilla Main Warehouse',
   'مستودع الحلة الرئيسي',
   'active')
on conflict (id) do nothing;

-- =============================================================================
-- DISTRIBUTION POINTS (4)
-- =============================================================================
insert into distribution_points (id, warehouse_id, organization_id, name, name_ar, point_type, status)
values
  ('00000000-0000-0000-0002-000000000001',
   '00000000-0000-0000-0001-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'Emergency Pharmacy Counter',
   'نقطة صيدلية الطوارئ',
   'dispensing',
   'active'),
  ('00000000-0000-0000-0002-000000000002',
   '00000000-0000-0000-0001-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'Internal Medicine Ward',
   'نقطة جناح الطب الداخلي',
   'dispensing',
   'active'),
  ('00000000-0000-0000-0002-000000000003',
   '00000000-0000-0000-0001-000000000002',
   '00000000-0000-0000-0000-000000000002',
   'Surgical Ward Counter',
   'نقطة جناح الجراحة',
   'dispensing',
   'active'),
  ('00000000-0000-0000-0002-000000000004',
   '00000000-0000-0000-0001-000000000002',
   '00000000-0000-0000-0000-000000000002',
   'Pediatrics Dispensing Point',
   'نقطة توزيع طب الأطفال',
   'dispensing',
   'active')
on conflict (id) do nothing;

-- =============================================================================
-- CENTRAL ITEMS (8)
-- =============================================================================
insert into central_items (id, name, name_ar, barcode, unit, category, status)
values
  ('00000000-0000-0000-0003-000000000001',
   'Amoxicillin 500mg Capsules',
   'أموكسيسيلين 500 ملغ كبسولات',
   '6921234560001',
   'box',
   'Antibiotics',
   'active'),
  ('00000000-0000-0000-0003-000000000002',
   'Paracetamol 500mg Tablets',
   'باراسيتامول 500 ملغ أقراص',
   '6921234560002',
   'box',
   'Analgesics',
   'active'),
  ('00000000-0000-0000-0003-000000000003',
   'Metformin 850mg Tablets',
   'ميتفورمين 850 ملغ أقراص',
   '6921234560003',
   'box',
   'Diabetes',
   'active'),
  ('00000000-0000-0000-0003-000000000004',
   'Amlodipine 5mg Tablets',
   'أملوديبين 5 ملغ أقراص',
   '6921234560004',
   'box',
   'Cardiovascular',
   'active'),
  ('00000000-0000-0000-0003-000000000005',
   'Normal Saline 0.9% 500ml',
   'محلول ملحي طبيعي 0.9% 500مل',
   '6921234560005',
   'bottle',
   'Infusion',
   'active'),
  ('00000000-0000-0000-0003-000000000006',
   'Omeprazole 20mg Capsules',
   'أوميبرازول 20 ملغ كبسولات',
   '6921234560006',
   'box',
   'Gastroenterology',
   'active'),
  ('00000000-0000-0000-0003-000000000007',
   'Ibuprofen 400mg Tablets',
   'إيبوبروفين 400 ملغ أقراص',
   '6921234560007',
   'box',
   'Analgesics',
   'active'),
  ('00000000-0000-0000-0003-000000000008',
   'Insulin Regular 100 IU/ml',
   'أنسولين عادي 100 وحدة/مل',
   '6921234560008',
   'vial',
   'Diabetes',
   'active')
on conflict (id) do nothing;

-- =============================================================================
-- LOCAL ITEMS (4 — org 1 maps to 4 central items)
-- =============================================================================
insert into local_items (id, central_item_id, organization_id, local_code, status)
values
  ('00000000-0000-0000-0004-000000000001',
   '00000000-0000-0000-0003-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'BGH-AMX-500',
   'active'),
  ('00000000-0000-0000-0004-000000000002',
   '00000000-0000-0000-0003-000000000002',
   '00000000-0000-0000-0000-000000000001',
   'BGH-PCM-500',
   'active'),
  ('00000000-0000-0000-0004-000000000003',
   '00000000-0000-0000-0003-000000000005',
   '00000000-0000-0000-0000-000000000001',
   'BGH-NS-500',
   'active'),
  ('00000000-0000-0000-0004-000000000004',
   '00000000-0000-0000-0003-000000000008',
   '00000000-0000-0000-0000-000000000001',
   'BGH-INS-REG',
   'active')
on conflict (id) do nothing;

-- =============================================================================
-- ITEM AVAILABILITY (8 records — realistic mix of conditions)
-- =============================================================================
insert into item_availability
  (id, local_item_id, distribution_point_id, organization_id, quantity, condition, expiry_date, notes)
values
  ('00000000-0000-0000-0005-000000000001',
   '00000000-0000-0000-0004-000000000001',
   '00000000-0000-0000-0002-000000000001',
   '00000000-0000-0000-0000-000000000001',
   240, 'available', '2027-06-30',
   'Demo seed'),
  ('00000000-0000-0000-0005-000000000002',
   '00000000-0000-0000-0004-000000000002',
   '00000000-0000-0000-0002-000000000001',
   '00000000-0000-0000-0000-000000000001',
   12, 'low_stock', '2026-12-31',
   'Demo seed — low stock'),
  ('00000000-0000-0000-0005-000000000003',
   '00000000-0000-0000-0004-000000000003',
   '00000000-0000-0000-0002-000000000001',
   '00000000-0000-0000-0000-000000000001',
   0, 'missing', null,
   'Demo seed — missing'),
  ('00000000-0000-0000-0005-000000000004',
   '00000000-0000-0000-0004-000000000004',
   '00000000-0000-0000-0002-000000000001',
   '00000000-0000-0000-0000-000000000001',
   18, 'near_expiry', '2026-08-15',
   'Demo seed — near expiry'),
  ('00000000-0000-0000-0005-000000000005',
   '00000000-0000-0000-0004-000000000001',
   '00000000-0000-0000-0002-000000000002',
   '00000000-0000-0000-0000-000000000001',
   480, 'available', '2027-03-31',
   'Demo seed'),
  ('00000000-0000-0000-0005-000000000006',
   '00000000-0000-0000-0004-000000000002',
   '00000000-0000-0000-0002-000000000002',
   '00000000-0000-0000-0000-000000000001',
   150, 'available', '2027-01-31',
   'Demo seed'),
  ('00000000-0000-0000-0005-000000000007',
   '00000000-0000-0000-0004-000000000003',
   '00000000-0000-0000-0002-000000000002',
   '00000000-0000-0000-0000-000000000001',
   8, 'low_stock', '2026-09-30',
   'Demo seed — low'),
  ('00000000-0000-0000-0005-000000000008',
   '00000000-0000-0000-0004-000000000004',
   '00000000-0000-0000-0002-000000000002',
   '00000000-0000-0000-0000-000000000001',
   30, 'available', '2026-10-15',
   'Demo seed')
on conflict (id) do nothing;

-- =============================================================================
-- QR TARGETS (2 — one per distribution point, first org)
-- =============================================================================
insert into qr_targets (id, organization_id, target_type, target_id, label, status)
values
  ('00000000-0000-0000-0006-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'distribution_point',
   '00000000-0000-0000-0002-000000000001',
   'Emergency Pharmacy — QR',
   'active'),
  ('00000000-0000-0000-0006-000000000002',
   '00000000-0000-0000-0000-000000000001',
   'distribution_point',
   '00000000-0000-0000-0002-000000000002',
   'Internal Medicine Ward — QR',
   'active')
on conflict (id) do nothing;

-- =============================================================================
-- QR TOKENS (2 — one per target, demo hashes)
-- =============================================================================
insert into qr_tokens
  (id, qr_target_id, organization_id, public_id, token_hash, status)
values
  ('00000000-0000-0000-0007-000000000001',
   '00000000-0000-0000-0006-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'demo-qr-emergency-01',
   encode(digest('demo-secret-token-emergency-01', 'sha256'), 'hex'),
   'active'),
  ('00000000-0000-0000-0007-000000000002',
   '00000000-0000-0000-0006-000000000002',
   '00000000-0000-0000-0000-000000000001',
   'demo-qr-internal-med-01',
   encode(digest('demo-secret-token-internal-med-01', 'sha256'), 'hex'),
   'active')
on conflict (id) do nothing;

-- =============================================================================
-- AUDIT LOGS (baseline entries)
-- =============================================================================
insert into audit_logs
  (id, organization_id, actor_role, action, entity_type, entity_id, entity_label, payload)
values
  ('00000000-0000-0000-0008-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'super_admin',
   'seed',
   'system',
   null,
   'Phoenix V2 initial seed',
   '{"version": "phoenix-v2", "seed": true}'),
  ('00000000-0000-0000-0008-000000000002',
   '00000000-0000-0000-0000-000000000001',
   'super_admin',
   'qr_created',
   'distribution_point',
   '00000000-0000-0000-0002-000000000001',
   'Emergency Pharmacy — QR',
   '{"demo": true}'),
  ('00000000-0000-0000-0008-000000000003',
   '00000000-0000-0000-0000-000000000001',
   'super_admin',
   'qr_created',
   'distribution_point',
   '00000000-0000-0000-0002-000000000002',
   'Internal Medicine Ward — QR',
   '{"demo": true}')
on conflict (id) do nothing;

-- =============================================================================
-- VERIFY SEED
-- =============================================================================
do $$
declare
  v_orgs  int; v_wh int; v_dp int; v_ci int; v_li int;
  v_avail int; v_qrt int; v_qtk int; v_al int;
begin
  select count(*) into v_orgs  from organizations;
  select count(*) into v_wh    from warehouses;
  select count(*) into v_dp    from distribution_points;
  select count(*) into v_ci    from central_items;
  select count(*) into v_li    from local_items;
  select count(*) into v_avail from item_availability;
  select count(*) into v_qrt   from qr_targets;
  select count(*) into v_qtk   from qr_tokens;
  select count(*) into v_al    from audit_logs;

  raise notice 'Seed verification: orgs=% wh=% dp=% ci=% li=% avail=% qrt=% qtk=% audit=%',
    v_orgs, v_wh, v_dp, v_ci, v_li, v_avail, v_qrt, v_qtk, v_al;

  if v_orgs < 2 or v_ci < 8 or v_avail < 8 then
    raise exception 'SEED_INCOMPLETE: Expected at least 2 orgs, 8 items, 8 availability rows.';
  end if;

  raise notice 'SEED_OK: Demo data applied successfully.';
end $$;

-- =============================================================================
-- END OF MIGRATION 004
-- =============================================================================
