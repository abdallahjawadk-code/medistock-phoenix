-- ============================================================================
-- Migration 020 — Material identity fields + Status Editor support
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: migration 019 must already be applied.
--   019 added port_name (text) and supply_type (text) to item_availability,
--   made local_item_id nullable, and created a (distribution_point_id, port_name)
--   unique index. Those columns remain as-is — port_name is now legacy/unused
--   in the editor, but is NOT dropped.
--
-- This migration:
--   1. Adds material identity columns: scientific_name, trade_name,
--      dosage_form, concentration, price.
--   2. Creates a partial unique index on (distribution_point_id, scientific_name)
--      for the new upsert flow that replaces the port_name-based upsert.
--
-- The new editor flow uses (distribution_point_id, scientific_name) as the
-- upsert key instead of port_name. port_name is left as a legacy unused column.
-- ============================================================================

begin;

-- ── 1. Add material identity columns ────────────────────────────────────────

alter table item_availability add column if not exists scientific_name text;
alter table item_availability add column if not exists trade_name text;
alter table item_availability add column if not exists dosage_form text;
alter table item_availability add column if not exists concentration text;
alter table item_availability add column if not exists price numeric(20,3);

-- ── 2. Unique index for the new upsert flow ─────────────────────────────────

create unique index if not exists item_avail_point_sciname_idx
  on item_availability (distribution_point_id, scientific_name)
  where scientific_name is not null;

-- ── VERIFY ──────────────────────────────────────────────────────────────────

do $$
begin
  -- scientific_name column must exist
  assert (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'item_availability'
      and column_name = 'scientific_name'
  ) = 1, 'FAIL: scientific_name column missing';

  -- trade_name column must exist
  assert (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'item_availability'
      and column_name = 'trade_name'
  ) = 1, 'FAIL: trade_name column missing';

  -- dosage_form column must exist
  assert (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'item_availability'
      and column_name = 'dosage_form'
  ) = 1, 'FAIL: dosage_form column missing';

  -- concentration column must exist
  assert (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'item_availability'
      and column_name = 'concentration'
  ) = 1, 'FAIL: concentration column missing';

  -- price column must exist
  assert (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'item_availability'
      and column_name = 'price'
  ) = 1, 'FAIL: price column missing';

  -- unique index must exist
  assert (
    select count(*) from pg_indexes
    where schemaname = 'public' and tablename = 'item_availability'
      and indexname = 'item_avail_point_sciname_idx'
  ) = 1, 'FAIL: item_avail_point_sciname_idx index missing';

  raise notice '020 VERIFY OK — all material identity columns and index present';
end;
$$;

commit;
