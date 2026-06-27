-- =============================================================================
-- MediStock Phoenix V2 — Migration 001: Core Schema
-- Apply manually via Supabase SQL Editor after review.
-- DO NOT run with `npx supabase db push`.
-- =============================================================================

-- Enable required extensions
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";   -- for name search similarity

-- =============================================================================
-- 1. ORGANIZATIONS
--    Hospitals / clinics. Written only by super_admin.
-- =============================================================================
create table if not exists organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  name_ar       text not null,
  code          text not null unique,          -- short slug, e.g. "babil-main"
  status        text not null default 'active'
                  check (status in ('active', 'inactive', 'suspended')),
  city          text,
  contact_email text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null
);

create index if not exists organizations_status_idx on organizations(status);
create index if not exists organizations_code_idx   on organizations(code);

-- =============================================================================
-- 2. PROFILES
--    One row per auth.users row. Role controls RLS.
-- =============================================================================
create table if not exists profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  full_name       text not null,
  role            text not null
                    check (role in (
                      'super_admin',
                      'hospital_admin',
                      'warehouse_manager',
                      'point_operator',
                      'viewer'
                    )),
  status          text not null default 'active'
                    check (status in ('active', 'suspended', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists profiles_org_idx  on profiles(organization_id);
create index if not exists profiles_role_idx on profiles(role);

-- =============================================================================
-- 3. WAREHOUSES
--    Physical storage locations within an organization.
-- =============================================================================
create table if not exists warehouses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,
  name_ar         text not null,
  location_notes  text,
  status          text not null default 'active'
                    check (status in ('active', 'inactive', 'archived')),
  archived_at     timestamptz,
  archived_by     uuid references auth.users(id) on delete set null,
  archive_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null
);

create index if not exists warehouses_org_idx    on warehouses(organization_id);
create index if not exists warehouses_status_idx on warehouses(status);

-- =============================================================================
-- 4. DISTRIBUTION POINTS
--    Dispensing points (pharmacy counters, wards) within a warehouse.
-- =============================================================================
create table if not exists distribution_points (
  id              uuid primary key default gen_random_uuid(),
  warehouse_id    uuid not null references warehouses(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,
  name_ar         text not null,
  point_type      text not null default 'dispensing'
                    check (point_type in ('dispensing', 'storage', 'returns', 'emergency')),
  status          text not null default 'active'
                    check (status in ('active', 'inactive', 'archived')),
  archived_at     timestamptz,
  archived_by     uuid references auth.users(id) on delete set null,
  archive_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null
);

create index if not exists dist_points_warehouse_idx on distribution_points(warehouse_id);
create index if not exists dist_points_org_idx       on distribution_points(organization_id);
create index if not exists dist_points_status_idx    on distribution_points(status);

-- =============================================================================
-- 5. CENTRAL ITEMS
--    Drug master list. Written ONLY by super_admin (enforced by RLS).
--    Read by all authenticated roles.
-- =============================================================================
create table if not exists central_items (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  name_ar         text not null,
  barcode         text unique,
  unit            text not null default 'box'
                    check (unit in ('box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other')),
  category        text,
  description     text,
  status          text not null default 'active'
                    check (status in ('active', 'inactive', 'discontinued')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null
);

create index if not exists central_items_name_trgm   on central_items using gin(name gin_trgm_ops);
create index if not exists central_items_name_ar_trgm on central_items using gin(name_ar gin_trgm_ops);
create index if not exists central_items_barcode_idx  on central_items(barcode);
create index if not exists central_items_status_idx   on central_items(status);

-- =============================================================================
-- 6. LOCAL ITEMS
--    Hospital-level item customization (alias, local code) referencing central.
-- =============================================================================
create table if not exists local_items (
  id              uuid primary key default gen_random_uuid(),
  central_item_id uuid not null references central_items(id) on delete restrict,
  organization_id uuid not null references organizations(id) on delete cascade,
  local_name      text,                        -- optional override
  local_code      text,                        -- internal hospital code
  status          text not null default 'active'
                    check (status in ('active', 'inactive', 'archived')),
  archived_at     timestamptz,
  archived_by     uuid references auth.users(id) on delete set null,
  archive_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  unique (central_item_id, organization_id)
);

create index if not exists local_items_org_idx     on local_items(organization_id);
create index if not exists local_items_central_idx on local_items(central_item_id);

-- =============================================================================
-- 7. ITEM AVAILABILITY
--    Availability record per local_item at a distribution_point.
--    This is the core operational table — updated by pharmacists/operators.
-- =============================================================================
create table if not exists item_availability (
  id                   uuid primary key default gen_random_uuid(),
  local_item_id        uuid not null references local_items(id) on delete restrict,
  distribution_point_id uuid not null references distribution_points(id) on delete restrict,
  organization_id      uuid not null references organizations(id) on delete cascade,
  quantity             integer not null default 0 check (quantity >= 0),
  condition            text not null default 'available'
                         check (condition in (
                           'available',
                           'low_stock',
                           'missing',
                           'surplus',
                           'near_expiry',
                           'expired'
                         )),
  batch_number         text,
  expiry_date          date,
  notes                text,
  last_updated_by      uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (local_item_id, distribution_point_id)
);

create index if not exists item_avail_org_idx       on item_availability(organization_id);
create index if not exists item_avail_point_idx     on item_availability(distribution_point_id);
create index if not exists item_avail_condition_idx on item_availability(condition);
create index if not exists item_avail_expiry_idx    on item_availability(expiry_date);

-- =============================================================================
-- 8. QR TARGETS
--    Anything that can be assigned a QR code.
--    Allowlist: warehouse | distribution_point | local_item
-- =============================================================================
do $$ begin
  create type qr_target_type as enum (
    'warehouse',
    'distribution_point',
    'local_item'
  );
exception when duplicate_object then null;
end $$;

create table if not exists qr_targets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  target_type     qr_target_type not null,
  target_id       uuid not null,                -- FK resolved by application + RPC
  label           text,                          -- human-readable label for this QR
  status          text not null default 'active'
                    check (status in ('active', 'inactive', 'archived')),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  unique (target_type, target_id)
);

create index if not exists qr_targets_org_idx    on qr_targets(organization_id);
create index if not exists qr_targets_target_idx on qr_targets(target_id);

-- =============================================================================
-- 9. QR TOKENS
--    One active token per qr_target. Hash-only storage.
--    stable public_id survives token rotation (used in QR URL).
-- =============================================================================
create table if not exists qr_tokens (
  id              uuid primary key default gen_random_uuid(),
  qr_target_id    uuid not null references qr_targets(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  public_id       text not null unique default encode(gen_random_bytes(12), 'hex'),
  token_hash      text not null,                 -- sha256 hex, never store plain token
  status          text not null default 'active'
                    check (status in ('active', 'disabled', 'rotated')),
  disabled_at     timestamptz,
  disabled_by     uuid references auth.users(id) on delete set null,
  disable_reason  text,
  last_scanned_at timestamptz,
  scan_count      bigint not null default 0,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null
);

create unique index if not exists qr_tokens_active_per_target
  on qr_tokens(qr_target_id)
  where status = 'active';

create index if not exists qr_tokens_public_id_idx on qr_tokens(public_id);
create index if not exists qr_tokens_org_idx       on qr_tokens(organization_id);

-- =============================================================================
-- 10. AUDIT LOGS
--     Append-only. No UPDATE or DELETE permitted (enforced by RLS + no policy).
-- =============================================================================
create table if not exists audit_logs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  actor_id        uuid references auth.users(id) on delete set null,
  actor_role      text,
  action          text not null,                 -- 'create' | 'update' | 'archive' | 'purge' | 'qr_*'
  entity_type     text not null,
  entity_id       uuid,
  entity_label    text,
  payload         jsonb,                         -- before/after snapshot for mutations
  ip_address      inet,
  created_at      timestamptz not null default now()
);

create index if not exists audit_logs_org_idx    on audit_logs(organization_id);
create index if not exists audit_logs_actor_idx  on audit_logs(actor_id);
create index if not exists audit_logs_entity_idx on audit_logs(entity_type, entity_id);
create index if not exists audit_logs_created_idx on audit_logs(created_at desc);

-- =============================================================================
-- UPDATED_AT TRIGGER
-- =============================================================================
create or replace function phoenix_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$ begin
  create trigger set_updated_at before update on organizations
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger set_updated_at before update on profiles
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger set_updated_at before update on warehouses
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger set_updated_at before update on distribution_points
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger set_updated_at before update on central_items
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger set_updated_at before update on local_items
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger set_updated_at before update on item_availability
    for each row execute function phoenix_set_updated_at();
exception when duplicate_object then null; end $$;

-- =============================================================================
-- AUTO-PROFILE TRIGGER
-- Creates a profile row when a new auth.users row is inserted.
-- Role defaults to 'viewer'; super_admin must promote via SQL.
-- =============================================================================
create or replace function phoenix_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email, 'Unknown'),
    coalesce(new.raw_user_meta_data->>'role', 'viewer')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$ begin
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function phoenix_handle_new_user();
exception when duplicate_object then null; end $$;

-- =============================================================================
-- END OF MIGRATION 001
-- Verify with:
--   select tablename from pg_tables where schemaname = 'public' order by tablename;
-- Expected: audit_logs, central_items, distribution_points, item_availability,
--           local_items, organizations, profiles, qr_targets, qr_tokens, warehouses
-- =============================================================================
