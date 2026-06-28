-- =============================================================================
-- MediStock Phoenix V2 — Migration 006: Institution Item Status Reports
-- Apply AFTER 005_phoenix_assign_profile_role.sql.
-- Apply manually via Supabase SQL Editor after review.
-- DO NOT run with `npx supabase db push`.
--
-- Purpose:
--   Central status reporting center where institutions submit scarce/surplus/
--   near-expiry/missing item reports for coordination (no auto-transfer).
-- =============================================================================

create table if not exists institution_item_status_reports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  item_id         uuid references central_items(id) on delete set null,
  item_name       text,
  item_name_ar    text,
  status_type     text not null
                    check (status_type in ('scarce', 'surplus', 'near_expiry', 'missing')),
  quantity        numeric,
  unit            text,
  expiry_date     date,
  notes           text,
  submitted_by    uuid references auth.users(id) on delete set null,
  submitted_at    timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users(id) on delete set null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists isr_org_idx     on institution_item_status_reports(organization_id);
create index if not exists isr_status_idx  on institution_item_status_reports(status_type);
create index if not exists isr_active_idx  on institution_item_status_reports(is_active);
create index if not exists isr_item_idx    on institution_item_status_reports(item_id);

-- updated_at trigger
do $$ begin
  create trigger set_updated_at before update on institution_item_status_reports
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================
alter table institution_item_status_reports enable row level security;

-- super_admin: full access
create policy "isr_all_superadmin" on institution_item_status_reports
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

-- hospital_admin: full access within own org
create policy "isr_all_hospitaladmin" on institution_item_status_reports
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  );

-- warehouse_manager: insert + select within own org
create policy "isr_select_wh_manager" on institution_item_status_reports
  for select to authenticated
  using (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  );

create policy "isr_insert_wh_manager" on institution_item_status_reports
  for insert to authenticated
  with check (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  );

-- point_operator: select only within own org
create policy "isr_select_operator" on institution_item_status_reports
  for select to authenticated
  using (
    phoenix_my_role() = 'point_operator'
    and organization_id = phoenix_my_org()
  );

-- viewer: select only within own org
create policy "isr_select_viewer" on institution_item_status_reports
  for select to authenticated
  using (
    phoenix_my_role() = 'viewer'
    and organization_id = phoenix_my_org()
  );

-- =============================================================================
-- END OF MIGRATION 006
-- Verify:
--   select tablename from pg_tables where schemaname = 'public'
--     and tablename = 'institution_item_status_reports';
-- =============================================================================
