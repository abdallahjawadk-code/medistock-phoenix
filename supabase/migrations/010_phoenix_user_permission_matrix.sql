-- =============================================================================
-- MediStock Phoenix V2 — Migration 010: User Permission Matrix + Official Roles
-- Apply AFTER 009_phoenix_inter_institution_alerts.sql.
-- Apply manually via Supabase SQL Editor after review + backup.
-- DO NOT run with `npx supabase db push`.  DO NOT modify 008 or 009.
--
-- Purpose:
--   1. Expand the official role model (non-destructively — legacy keys kept).
--   2. Add a two-layer permission matrix:
--        role_permission_defaults  (Layer 1)
--        profile_permission_overrides (Layer 2)
--      mirrored by src/shared/lib/permissions.ts.
--   3. Provide scoped, SECURITY DEFINER RPCs to read/assign/reset permissions.
--
-- Official roles: super_admin, warehouse_officer, port_officer,
--                 monthly_status_officer, viewer.
-- Legacy roles kept for compatibility: hospital_admin, warehouse_manager,
--                 point_operator, transfer_manager.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Expand profiles.role CHECK (additive — keeps every existing value valid)
-- -----------------------------------------------------------------------------
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (
  role in (
    -- official
    'super_admin', 'warehouse_officer', 'port_officer', 'monthly_status_officer', 'viewer',
    -- legacy (compatibility only — not offered in the official UI dropdown)
    'hospital_admin', 'warehouse_manager', 'point_operator', 'transfer_manager'
  )
);

-- -----------------------------------------------------------------------------
-- 2. Permission catalog + matrix tables
-- -----------------------------------------------------------------------------
create table if not exists permission_keys (
  key          text primary key,
  module       text not null,
  action       text not null,
  label_en     text not null,
  label_ar     text not null,
  is_dangerous boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists role_permission_defaults (
  role           text not null,
  permission_key text not null references permission_keys(key) on delete cascade,
  allowed        boolean not null default false,
  primary key (role, permission_key)
);

create table if not exists profile_permission_overrides (
  profile_id           uuid not null references profiles(id) on delete cascade,
  permission_key       text not null references permission_keys(key) on delete cascade,
  allowed              boolean,            -- null = inherit role default
  scope_organization_id uuid references organizations(id) on delete cascade,
  scope_warehouse_id    uuid references warehouses(id) on delete cascade,
  scope_point_id        uuid references distribution_points(id) on delete cascade,
  created_by           uuid references profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (profile_id, permission_key)
);

create index if not exists ppo_profile_idx on profile_permission_overrides(profile_id);

do $$ begin
  create trigger set_updated_at before update on profile_permission_overrides
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- 3. RLS
--    Reads are scoped (own org / super). All mutations flow through the
--    SECURITY DEFINER RPCs below — no direct anon access.
-- -----------------------------------------------------------------------------
alter table permission_keys              enable row level security;
alter table role_permission_defaults     enable row level security;
alter table profile_permission_overrides enable row level security;

-- Catalog + role defaults are readable by any authenticated user (no secrets).
create policy "permkeys_select_auth" on permission_keys
  for select to authenticated using (true);
create policy "roledef_select_auth" on role_permission_defaults
  for select to authenticated using (true);

-- Overrides: super_admin sees all; others see only their own org's overrides.
create policy "ppo_select_scoped" on profile_permission_overrides
  for select to authenticated
  using (
    phoenix_my_role() = 'super_admin'
    or exists (
      select 1 from profiles p
      where p.id = profile_permission_overrides.profile_id
        and p.organization_id = phoenix_my_org()
    )
  );
-- No insert/update/delete policies: mutations only via SECURITY DEFINER RPCs.

-- -----------------------------------------------------------------------------
-- 4. Seed permission catalog (mirrors src/shared/lib/permissions.ts)
-- -----------------------------------------------------------------------------
insert into permission_keys (key, module, action, label_en, label_ar, is_dangerous) values
  ('dashboard.view','dashboard','view','View dashboard','عرض لوحة التحكم',false),
  ('organizations.view','organizations','view','View institutions','عرض المؤسسات',false),
  ('organizations.create','organizations','create','Create institutions','إنشاء مؤسسات',true),
  ('organizations.edit','organizations','edit','Edit institutions','تعديل المؤسسات',false),
  ('organizations.archive','organizations','archive','Archive institutions','أرشفة المؤسسات',true),
  ('users.view','users','view','View users','عرض المستخدمين',false),
  ('users.create','users','create','Create users','إنشاء المستخدمين',true),
  ('users.assign_role','users','assign_role','Assign roles','إسناد الأدوار',true),
  ('users.manage_permissions','users','manage_permissions','Manage permissions','إدارة الصلاحيات',true),
  ('warehouses.view','warehouses','view','View stores','عرض المذاخر',false),
  ('warehouses.manage','warehouses','manage','Manage stores','إدارة المذاخر',false),
  ('ports.view','ports','view','View ports','عرض المنافذ',false),
  ('ports.create','ports','create','Create ports','إنشاء المنافذ',false),
  ('ports.edit','ports','edit','Edit ports','تعديل المنافذ',false),
  ('ports.archive','ports','archive','Archive ports','أرشفة المنافذ',true),
  ('qr.view','qr','view','View QR','عرض QR',false),
  ('qr.generate','qr','generate','Generate QR','إنشاء QR',false),
  ('qr.revoke','qr','revoke','Revoke QR','إلغاء QR',true),
  ('availability.view','availability','view','View availability','عرض التوفر',false),
  ('availability.manage','availability','manage','Manage availability','إدارة التوفر',false),
  ('status_center.view','status_center','view','View status center','عرض مركز المواقف',false),
  ('status_center.create','status_center','create','Create status reports','إنشاء تقارير المواقف',false),
  ('status_center.edit','status_center','edit','Edit status reports','تعديل تقارير المواقف',false),
  ('status_center.resolve','status_center','resolve','Resolve status reports','إغلاق تقارير المواقف',false),
  ('exchange_alerts.view','exchange_alerts','view','View exchange alerts','عرض تنبيهات التبادل',false),
  ('inter_institution_alerts.view','inter_institution_alerts','view','View inter-institution alerts','عرض تنبيهات بين المؤسسات',false),
  ('status_contacts.view','status_contacts','view','View status contacts','عرض جهات الاتصال',false),
  ('status_contacts.manage','status_contacts','manage','Manage status contacts','إدارة جهات الاتصال',false),
  ('deletion_wizard.view','deletion_wizard','view','View deletion wizard','عرض معالج الحذف',false),
  ('deletion_wizard.clear_port_items','deletion_wizard','clear_port_items','Clear port items','حذف مواد المنفذ',true),
  ('deletion_wizard.archive_port','deletion_wizard','archive_port','Archive port','أرشفة المنفذ',true),
  ('deletion_wizard.archive_organization','deletion_wizard','archive_organization','Archive institution','أرشفة المؤسسة',true)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 5. Seed role defaults (mirrors permissions.ts)
-- -----------------------------------------------------------------------------
-- super_admin: everything
insert into role_permission_defaults (role, permission_key, allowed)
  select 'super_admin', key, true from permission_keys
on conflict do nothing;

insert into role_permission_defaults (role, permission_key, allowed) values
  -- warehouse_officer
  ('warehouse_officer','dashboard.view',true),
  ('warehouse_officer','organizations.view',true),
  ('warehouse_officer','warehouses.view',true),
  ('warehouse_officer','warehouses.manage',true),
  ('warehouse_officer','ports.view',true),
  ('warehouse_officer','qr.view',true),
  ('warehouse_officer','qr.generate',true),
  ('warehouse_officer','availability.view',true),
  ('warehouse_officer','availability.manage',true),
  ('warehouse_officer','status_center.view',true),
  ('warehouse_officer','exchange_alerts.view',true),
  ('warehouse_officer','inter_institution_alerts.view',true),
  ('warehouse_officer','deletion_wizard.view',true),
  ('warehouse_officer','deletion_wizard.clear_port_items',true),
  ('warehouse_officer','deletion_wizard.archive_port',true),
  -- port_officer
  ('port_officer','dashboard.view',true),
  ('port_officer','organizations.view',true),
  ('port_officer','ports.view',true),
  ('port_officer','ports.edit',true),
  ('port_officer','qr.view',true),
  ('port_officer','availability.view',true),
  ('port_officer','availability.manage',true),
  ('port_officer','status_center.view',true),
  ('port_officer','exchange_alerts.view',true),
  ('port_officer','inter_institution_alerts.view',true),
  -- monthly_status_officer
  ('monthly_status_officer','dashboard.view',true),
  ('monthly_status_officer','availability.view',true),
  ('monthly_status_officer','status_center.view',true),
  ('monthly_status_officer','status_center.create',true),
  ('monthly_status_officer','status_center.edit',true),
  ('monthly_status_officer','status_center.resolve',true),
  ('monthly_status_officer','exchange_alerts.view',true),
  ('monthly_status_officer','inter_institution_alerts.view',true),
  ('monthly_status_officer','status_contacts.view',true),
  ('monthly_status_officer','status_contacts.manage',true),
  -- viewer
  ('viewer','dashboard.view',true),
  ('viewer','organizations.view',true),
  ('viewer','warehouses.view',true),
  ('viewer','ports.view',true),
  ('viewer','qr.view',true),
  ('viewer','availability.view',true),
  ('viewer','status_center.view',true),
  ('viewer','exchange_alerts.view',true),
  ('viewer','inter_institution_alerts.view',true),
  ('viewer','status_contacts.view',true)
on conflict do nothing;

-- legacy hospital_admin: broad org admin (no platform-level org create/archive)
insert into role_permission_defaults (role, permission_key, allowed) values
  ('hospital_admin','dashboard.view',true),
  ('hospital_admin','organizations.view',true),
  ('hospital_admin','organizations.edit',true),
  ('hospital_admin','users.view',true),
  ('hospital_admin','users.create',true),
  ('hospital_admin','users.assign_role',true),
  ('hospital_admin','users.manage_permissions',true),
  ('hospital_admin','warehouses.view',true),
  ('hospital_admin','warehouses.manage',true),
  ('hospital_admin','ports.view',true),
  ('hospital_admin','ports.create',true),
  ('hospital_admin','ports.edit',true),
  ('hospital_admin','ports.archive',true),
  ('hospital_admin','qr.view',true),
  ('hospital_admin','qr.generate',true),
  ('hospital_admin','qr.revoke',true),
  ('hospital_admin','availability.view',true),
  ('hospital_admin','availability.manage',true),
  ('hospital_admin','status_center.view',true),
  ('hospital_admin','status_center.create',true),
  ('hospital_admin','status_center.edit',true),
  ('hospital_admin','status_center.resolve',true),
  ('hospital_admin','exchange_alerts.view',true),
  ('hospital_admin','inter_institution_alerts.view',true),
  ('hospital_admin','status_contacts.view',true),
  ('hospital_admin','status_contacts.manage',true),
  ('hospital_admin','deletion_wizard.view',true),
  ('hospital_admin','deletion_wizard.clear_port_items',true),
  ('hospital_admin','deletion_wizard.archive_port',true)
on conflict do nothing;

-- legacy mapped roles inherit their official equivalent's defaults
insert into role_permission_defaults (role, permission_key, allowed)
  select 'warehouse_manager', permission_key, allowed
  from role_permission_defaults where role = 'warehouse_officer'
on conflict do nothing;
insert into role_permission_defaults (role, permission_key, allowed)
  select 'point_operator', permission_key, allowed
  from role_permission_defaults where role = 'port_officer'
on conflict do nothing;
insert into role_permission_defaults (role, permission_key, allowed)
  select 'transfer_manager', permission_key, allowed
  from role_permission_defaults where role = 'monthly_status_officer'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 6. Internal helper: effective permission for a profile
-- -----------------------------------------------------------------------------
create or replace function phoenix_profile_has_permission(p_profile_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select o.allowed
       from profile_permission_overrides o
      where o.profile_id = p_profile_id and o.permission_key = p_key
        and o.allowed is not null),
    (select d.allowed
       from role_permission_defaults d
       join profiles pr on pr.id = p_profile_id
      where d.role = pr.role and d.permission_key = p_key),
    false
  );
$$;

-- -----------------------------------------------------------------------------
-- 7. get_effective_permissions(profile_id) -> jsonb { key: bool, ... }
-- -----------------------------------------------------------------------------
create or replace function get_effective_permissions(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_role  text;
  v_org   uuid;
  v_target_org uuid;
  v_result jsonb;
begin
  v_actor := auth.uid();
  if v_actor is null then return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); end if;

  select role, organization_id into v_role, v_org from profiles where id = v_actor;
  select organization_id into v_target_org from profiles where id = p_profile_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND'); end if;

  -- scope: super, self, or same-org
  if v_role <> 'super_admin' and p_profile_id <> v_actor and v_target_org is distinct from v_org then
    return jsonb_build_object('ok', false, 'error', 'OUT_OF_SCOPE');
  end if;

  select coalesce(jsonb_object_agg(k.key, phoenix_profile_has_permission(p_profile_id, k.key)), '{}'::jsonb)
    into v_result
  from permission_keys k;

  return jsonb_build_object('ok', true, 'permissions', v_result);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. assign_profile_permissions(profile_id, permissions jsonb)
--    permissions = { "key": true|false|null, ... }
-- -----------------------------------------------------------------------------
create or replace function assign_profile_permissions(p_profile_id uuid, p_permissions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_role  text;
  v_org   uuid;
  v_target_org uuid;
  v_key   text;
  v_val   jsonb;
  v_bool  boolean;
  v_dangerous boolean;
  v_applied  int := 0;
  v_rejected jsonb := '[]'::jsonb;
begin
  v_actor := auth.uid();
  if v_actor is null then return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); end if;

  select role, organization_id into v_role, v_org from profiles where id = v_actor;
  select organization_id into v_target_org from profiles where id = p_profile_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND'); end if;

  -- authority: super_admin, or holds users.manage_permissions within same org
  if v_role <> 'super_admin' then
    if not phoenix_profile_has_permission(v_actor, 'users.manage_permissions') then
      return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
    end if;
    if v_target_org is distinct from v_org then
      return jsonb_build_object('ok', false, 'error', 'OUT_OF_SCOPE');
    end if;
  end if;

  -- block self-permission edits (no self-escalation)
  if p_profile_id = v_actor then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_EDIT_OWN_PERMISSIONS');
  end if;

  for v_key, v_val in select * from jsonb_each(p_permissions) loop
    -- unknown key
    if not exists (select 1 from permission_keys where key = v_key) then
      v_rejected := v_rejected || jsonb_build_object('key', v_key, 'error', 'UNKNOWN_PERMISSION');
      continue;
    end if;

    if jsonb_typeof(v_val) = 'null' then
      v_bool := null;
    else
      v_bool := v_val::text::boolean;
    end if;

    -- granting requires the actor to hold the permission (dangerous included)
    if v_bool is true and v_role <> 'super_admin' then
      if not phoenix_profile_has_permission(v_actor, v_key) then
        select is_dangerous into v_dangerous from permission_keys where key = v_key;
        v_rejected := v_rejected || jsonb_build_object(
          'key', v_key,
          'error', case when v_dangerous then 'NEEDS_AUTHORITY_FOR_DANGEROUS' else 'CANNOT_GRANT_UNHELD' end
        );
        continue;
      end if;
    end if;

    insert into profile_permission_overrides (profile_id, permission_key, allowed, created_by)
      values (p_profile_id, v_key, v_bool, v_actor)
    on conflict (profile_id, permission_key)
      do update set allowed = excluded.allowed, created_by = v_actor, updated_at = now();
    v_applied := v_applied + 1;
  end loop;

  insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
    values (v_target_org, v_actor, v_role, 'permissions_assigned', 'profile', p_profile_id,
            jsonb_build_object('applied', v_applied, 'rejected', v_rejected));

  return jsonb_build_object('ok', true, 'applied', v_applied, 'rejected', v_rejected);
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. reset_profile_permissions(profile_id) -> clears overrides (role defaults)
-- -----------------------------------------------------------------------------
create or replace function reset_profile_permissions(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_role  text;
  v_org   uuid;
  v_target_org uuid;
  v_count int;
begin
  v_actor := auth.uid();
  if v_actor is null then return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); end if;

  select role, organization_id into v_role, v_org from profiles where id = v_actor;
  select organization_id into v_target_org from profiles where id = p_profile_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND'); end if;

  if v_role <> 'super_admin' then
    if not phoenix_profile_has_permission(v_actor, 'users.manage_permissions') then
      return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
    end if;
    if v_target_org is distinct from v_org then
      return jsonb_build_object('ok', false, 'error', 'OUT_OF_SCOPE');
    end if;
  end if;

  delete from profile_permission_overrides where profile_id = p_profile_id;
  get diagnostics v_count = row_count;

  insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
    values (v_target_org, v_actor, v_role, 'permissions_reset', 'profile', p_profile_id,
            jsonb_build_object('cleared', v_count));

  return jsonb_build_object('ok', true, 'cleared', v_count);
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Re-create assign_profile_role with the EXPANDED official+legacy allowlist
--     (supersedes migration 005; same security contract, wider role set).
-- -----------------------------------------------------------------------------
create or replace function assign_profile_role(p_target_id uuid, p_new_role text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id     uuid;
  v_actor_role   text;
  v_actor_org_id uuid;
  v_target       profiles%rowtype;
  v_allowed_roles text[] := array[
    'super_admin', 'warehouse_officer', 'port_officer', 'monthly_status_officer', 'viewer',
    'hospital_admin', 'warehouse_manager', 'point_operator', 'transfer_manager'
  ];
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  end if;

  select role, organization_id into v_actor_role, v_actor_org_id
  from profiles where id = v_actor_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  end if;

  -- Only platform admin or (legacy) org admin may assign roles.
  if v_actor_role not in ('super_admin', 'hospital_admin') then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  if p_new_role != all(v_allowed_roles) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ROLE', 'allowed', v_allowed_roles);
  end if;

  select * into v_target from profiles where id = p_target_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');
  end if;

  if p_target_id = v_actor_id then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_CHANGE_OWN_ROLE');
  end if;

  -- Only super_admin may create/assign super_admin.
  if p_new_role = 'super_admin' and v_actor_role <> 'super_admin' then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_ESCALATE_TO_SUPER_ADMIN');
  end if;

  if v_actor_role = 'hospital_admin' then
    if v_target.organization_id is distinct from v_actor_org_id then
      return jsonb_build_object('ok', false, 'error', 'CANNOT_MODIFY_OTHER_ORG');
    end if;
    if v_target.role = 'super_admin' then
      return jsonb_build_object('ok', false, 'error', 'CANNOT_MODIFY_SUPER_ADMIN');
    end if;
  end if;

  if v_target.role = p_new_role then
    return jsonb_build_object('ok', true, 'changed', false, 'reason', 'ALREADY_ASSIGNED');
  end if;

  update profiles set role = p_new_role, updated_at = now() where id = p_target_id;

  insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
    values (v_target.organization_id, v_actor_id, v_actor_role, 'role_assigned', 'profile',
            p_target_id, v_target.full_name,
            jsonb_build_object('previous_role', v_target.role, 'new_role', p_new_role));

  return jsonb_build_object('ok', true, 'changed', true, 'previous_role', v_target.role, 'new_role', p_new_role);
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Grants — authenticated only, anon revoked
-- -----------------------------------------------------------------------------
revoke all on function get_effective_permissions(uuid) from anon;
revoke all on function assign_profile_permissions(uuid, jsonb) from anon;
revoke all on function reset_profile_permissions(uuid) from anon;
grant execute on function get_effective_permissions(uuid) to authenticated;
grant execute on function assign_profile_permissions(uuid, jsonb) to authenticated;
grant execute on function reset_profile_permissions(uuid) to authenticated;

-- =============================================================================
-- END OF MIGRATION 010
-- Verify:
--   select count(*) from permission_keys;            -- expect 32
--   select role, count(*) from role_permission_defaults group by role;
--   select routine_name from information_schema.routines
--   where routine_schema = 'public'
--     and routine_name in ('get_effective_permissions','assign_profile_permissions',
--                          'reset_profile_permissions','assign_profile_role');
-- =============================================================================
