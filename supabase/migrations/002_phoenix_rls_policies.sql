-- =============================================================================
-- MediStock Phoenix V2 — Migration 002: RLS Policies
-- Apply AFTER 001_phoenix_core_schema.sql.
-- Apply manually via Supabase SQL Editor after review.
-- =============================================================================

-- =============================================================================
-- HELPER: current user's profile (cached for session)
-- =============================================================================
create or replace function phoenix_my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function phoenix_my_org()
returns uuid language sql stable security definer set search_path = public as $$
  select organization_id from profiles where id = auth.uid();
$$;

-- =============================================================================
-- ENABLE RLS ON ALL TABLES
-- =============================================================================
alter table organizations      enable row level security;
alter table profiles           enable row level security;
alter table warehouses         enable row level security;
alter table distribution_points enable row level security;
alter table central_items      enable row level security;
alter table local_items        enable row level security;
alter table item_availability  enable row level security;
alter table qr_targets         enable row level security;
alter table qr_tokens          enable row level security;
alter table audit_logs         enable row level security;

-- =============================================================================
-- ROLE MATRIX
--
-- super_admin        → full access to everything, all orgs
-- hospital_admin     → full access within own organization
-- warehouse_manager  → read all in org; write warehouses + availability
-- point_operator     → read all in org; write item_availability only
-- viewer             → read-only within own organization
-- anon               → read-only: qr_tokens (active, by public_id) + item_availability
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ORGANIZATIONS
-- ---------------------------------------------------------------------------
drop policy if exists "orgs_select_auth"    on organizations;
drop policy if exists "orgs_all_superadmin" on organizations;

create policy "orgs_select_auth" on organizations
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or id = phoenix_my_org()
  );

create policy "orgs_all_superadmin" on organizations
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

-- ---------------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_select_own_org"   on profiles;
drop policy if exists "profiles_update_own"        on profiles;
drop policy if exists "profiles_all_superadmin"   on profiles;
drop policy if exists "profiles_all_hospitaladmin" on profiles;

create policy "profiles_select_own_org" on profiles
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or organization_id = phoenix_my_org()
    or id = auth.uid()
  );

create policy "profiles_update_own" on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select role from profiles where id = auth.uid())  -- cannot self-promote
  );

create policy "profiles_all_superadmin" on profiles
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

create policy "profiles_all_hospitaladmin" on profiles
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
    and role != 'super_admin'           -- hospital_admin cannot create super_admin
  );

-- ---------------------------------------------------------------------------
-- WAREHOUSES
-- ---------------------------------------------------------------------------
drop policy if exists "wh_select_org"        on warehouses;
drop policy if exists "wh_write_superadmin"  on warehouses;
drop policy if exists "wh_write_hospitaladmin" on warehouses;
drop policy if exists "wh_write_wh_manager"  on warehouses;

create policy "wh_select_org" on warehouses
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or organization_id = phoenix_my_org()
  );

create policy "wh_write_superadmin" on warehouses
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

create policy "wh_write_hospitaladmin" on warehouses
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  );

create policy "wh_write_wh_manager" on warehouses
  for update to authenticated
  using (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  );

-- ---------------------------------------------------------------------------
-- DISTRIBUTION POINTS
-- ---------------------------------------------------------------------------
drop policy if exists "dp_select_org"          on distribution_points;
drop policy if exists "dp_write_superadmin"    on distribution_points;
drop policy if exists "dp_write_hospitaladmin" on distribution_points;
drop policy if exists "dp_write_wh_manager"    on distribution_points;

create policy "dp_select_org" on distribution_points
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or organization_id = phoenix_my_org()
  );

create policy "dp_write_superadmin" on distribution_points
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

create policy "dp_write_hospitaladmin" on distribution_points
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  );

create policy "dp_write_wh_manager" on distribution_points
  for all to authenticated
  using (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  );

-- ---------------------------------------------------------------------------
-- CENTRAL ITEMS  — super_admin writes; everyone reads
-- ---------------------------------------------------------------------------
drop policy if exists "ci_select_auth"      on central_items;
drop policy if exists "ci_write_superadmin" on central_items;

create policy "ci_select_auth" on central_items
  for select to authenticated
  using (true);                          -- all authenticated roles may read

create policy "ci_write_superadmin" on central_items
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

-- ---------------------------------------------------------------------------
-- LOCAL ITEMS
-- ---------------------------------------------------------------------------
drop policy if exists "li_select_org"          on local_items;
drop policy if exists "li_write_superadmin"    on local_items;
drop policy if exists "li_write_hospitaladmin" on local_items;
drop policy if exists "li_write_wh_manager"    on local_items;

create policy "li_select_org" on local_items
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or organization_id = phoenix_my_org()
  );

create policy "li_write_superadmin" on local_items
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

create policy "li_write_hospitaladmin" on local_items
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  );

create policy "li_write_wh_manager" on local_items
  for all to authenticated
  using (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  );

-- ---------------------------------------------------------------------------
-- ITEM AVAILABILITY
-- ---------------------------------------------------------------------------
drop policy if exists "avail_select_org"           on item_availability;
drop policy if exists "avail_write_superadmin"     on item_availability;
drop policy if exists "avail_write_hospitaladmin"  on item_availability;
drop policy if exists "avail_write_wh_manager"     on item_availability;
drop policy if exists "avail_write_point_operator" on item_availability;
drop policy if exists "avail_select_anon"          on item_availability;

-- anon can read (for public QR scan results)
create policy "avail_select_anon" on item_availability
  for select to anon
  using (true);

create policy "avail_select_org" on item_availability
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or organization_id = phoenix_my_org()
  );

create policy "avail_write_superadmin" on item_availability
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

create policy "avail_write_hospitaladmin" on item_availability
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  );

create policy "avail_write_wh_manager" on item_availability
  for all to authenticated
  using (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  );

create policy "avail_write_point_operator" on item_availability
  for update to authenticated
  using (
    phoenix_my_role() = 'point_operator'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'point_operator'
    and organization_id = phoenix_my_org()
  );

-- ---------------------------------------------------------------------------
-- QR TARGETS
-- ---------------------------------------------------------------------------
drop policy if exists "qrt_select_org"         on qr_targets;
drop policy if exists "qrt_write_superadmin"   on qr_targets;
drop policy if exists "qrt_write_hospitaladmin" on qr_targets;
drop policy if exists "qrt_write_wh_manager"   on qr_targets;

create policy "qrt_select_org" on qr_targets
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or organization_id = phoenix_my_org()
  );

create policy "qrt_write_superadmin" on qr_targets
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

create policy "qrt_write_hospitaladmin" on qr_targets
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  );

create policy "qrt_write_wh_manager" on qr_targets
  for all to authenticated
  using (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  );

-- ---------------------------------------------------------------------------
-- QR TOKENS
-- ---------------------------------------------------------------------------
drop policy if exists "qrtk_select_anon"         on qr_tokens;
drop policy if exists "qrtk_select_org"          on qr_tokens;
drop policy if exists "qrtk_write_superadmin"    on qr_tokens;
drop policy if exists "qrtk_write_hospitaladmin" on qr_tokens;
drop policy if exists "qrtk_write_wh_manager"    on qr_tokens;

-- anon: only active tokens, read by public_id (for QR scan)
create policy "qrtk_select_anon" on qr_tokens
  for select to anon
  using (status = 'active');

create policy "qrtk_select_org" on qr_tokens
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or organization_id = phoenix_my_org()
  );

create policy "qrtk_write_superadmin" on qr_tokens
  for all to authenticated
  using   (phoenix_my_role() = 'super_admin')
  with check (phoenix_my_role() = 'super_admin');

create policy "qrtk_write_hospitaladmin" on qr_tokens
  for all to authenticated
  using (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'hospital_admin'
    and organization_id = phoenix_my_org()
  );

create policy "qrtk_write_wh_manager" on qr_tokens
  for all to authenticated
  using (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  )
  with check (
    phoenix_my_role() = 'warehouse_manager'
    and organization_id = phoenix_my_org()
  );

-- ---------------------------------------------------------------------------
-- AUDIT LOGS — append-only: INSERT for auth; SELECT scoped; no UPDATE/DELETE
-- ---------------------------------------------------------------------------
drop policy if exists "al_select_superadmin"   on audit_logs;
drop policy if exists "al_select_hospitaladmin" on audit_logs;
drop policy if exists "al_insert_auth"          on audit_logs;

create policy "al_select_superadmin" on audit_logs
  for select to authenticated
  using (phoenix_my_role() = 'super_admin');

create policy "al_select_hospitaladmin" on audit_logs
  for select to authenticated
  using (
    phoenix_my_role() in ('hospital_admin', 'warehouse_manager')
    and organization_id = phoenix_my_org()
  );

create policy "al_insert_auth" on audit_logs
  for insert to authenticated
  with check (actor_id = auth.uid());

-- No UPDATE or DELETE policy on audit_logs → those operations are always denied.

-- =============================================================================
-- END OF MIGRATION 002
-- Verify with:
--   select schemaname, tablename, policyname, cmd, roles
--   from pg_policies where schemaname = 'public' order by tablename, policyname;
-- =============================================================================
