-- =============================================================================
-- MediStock Phoenix — Inspect Public Schema Before Wipe
-- Run this BEFORE executing 000_full_public_app_wipe.sql
-- This is a READ-ONLY diagnostic. Safe to run at any time.
-- =============================================================================

-- 1. PUBLIC TABLES WITH SIZES
-- (row_count omitted: requires query_to_xml which is psql-only)
select
  t.tablename                                                           as table_name,
  pg_size_pretty(pg_total_relation_size(quote_ident(t.tablename)::regclass)) as total_size
from pg_tables t
where t.schemaname = 'public'
order by t.tablename;

-- 2. PUBLIC VIEWS
select viewname
from pg_views
where schemaname = 'public'
order by viewname;

-- 3. PUBLIC FUNCTIONS / RPCs
select
  p.proname                              as function_name,
  pg_get_function_arguments(p.oid)       as arguments,
  t.typname                              as return_type,
  p.prosecdef                            as security_definer,
  p.proowner::regrole::text              as owner
from pg_proc p
join pg_type t on t.oid = p.prorettype
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
order by p.proname;

-- 4. PUBLIC TRIGGERS
select
  trigger_name,
  event_manipulation,
  event_object_table,
  action_timing
from information_schema.triggers
where trigger_schema = 'public'
order by event_object_table, trigger_name;

-- 5. RLS POLICIES
select
  tablename,
  policyname,
  cmd,
  roles
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 6. INDEXES
select
  tablename,
  indexname
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;

-- 7. INSTALLED EXTENSIONS
select
  name,
  installed_version
from pg_available_extensions
where installed_version is not null
order by name;

-- 8. ENUM TYPES IN PUBLIC
select
  t.typname as enum_name,
  array_agg(e.enumlabel order by e.enumsortorder) as values
from pg_type t
join pg_enum e on e.enumtypid = t.oid
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public'
group by t.typname
order by t.typname;

-- 9. SUMMARY
select
  (select count(*) from pg_tables    where schemaname = 'public') as tables,
  (select count(*) from pg_views     where schemaname = 'public') as views,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f')                as functions,
  (select count(*) from pg_policies  where schemaname = 'public') as policies,
  (select count(*) from pg_indexes   where schemaname = 'public') as indexes,
  (select count(*) from information_schema.triggers
   where trigger_schema = 'public')                                as triggers;
