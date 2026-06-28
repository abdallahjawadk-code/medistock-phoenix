-- =============================================================================
-- MediStock Phoenix V2 — Migration 008: Organization Status Contacts
-- Apply AFTER 007_phoenix_clear_port_availability.sql.
-- Apply manually via Supabase SQL Editor after review.
-- DO NOT run with `npx supabase db push`.
--
-- Purpose:
--   Scoped contact directory for the "Monthly Status Officer" of each
--   institution. Used ONLY inside authenticated, scoped inter-institution
--   alerts (see migration 009). Never exposed on public QR pages or to
--   anonymous (unauthenticated) visitors.
--
--   profiles has no phone field, so contact name + phone live here. Multiple
--   contacts per organization are allowed (prepares for multiple officers
--   later, ahead of USER-PERMISSION-MATRIX-A).
-- =============================================================================

create table if not exists organization_status_contacts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  display_name    text not null,
  phone           text not null,
  is_primary      boolean not null default false,
  is_active       boolean not null default true,
  created_by      uuid references profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists osc_org_idx     on organization_status_contacts(organization_id);
create index if not exists osc_active_idx   on organization_status_contacts(is_active);
create index if not exists osc_primary_idx  on organization_status_contacts(organization_id, is_primary);

-- updated_at trigger
do $$ begin
  create trigger set_updated_at before update on organization_status_contacts
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

-- =============================================================================
-- RLS POLICIES
--   Direct table access is scoped to the OWNER organization only. Cross-org
--   reads happen exclusively through the SECURITY DEFINER RPC in 009, which
--   returns only the counterpart contact for a matching alert.
-- =============================================================================
alter table organization_status_contacts enable row level security;

-- super_admin: full access
create policy "osc_all_superadmin" on organization_status_contacts
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

-- hospital_admin: manage contacts within own org
create policy "osc_all_hospitaladmin" on organization_status_contacts
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  );

-- warehouse_manager / point_operator / viewer: read own org contacts only
create policy "osc_select_members" on organization_status_contacts
  for select to authenticated
  using (
    phoenix_my_role() in ('warehouse_manager', 'point_operator', 'viewer')
    and organization_id = phoenix_my_org()
  );

-- No anonymous access at all (every policy targets authenticated only).

-- =============================================================================
-- END OF MIGRATION 008
-- Verify:
--   select tablename from pg_tables where schemaname = 'public'
--     and tablename = 'organization_status_contacts';
--   select relrowsecurity from pg_class where relname = 'organization_status_contacts';
-- =============================================================================
