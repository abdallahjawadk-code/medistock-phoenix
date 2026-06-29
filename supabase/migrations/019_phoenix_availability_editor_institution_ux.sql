-- ============================================================================
-- 019_phoenix_availability_editor_institution_ux.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   Supports the Availability Editor UX refresh (AVAILABILITY-EDITOR-
--   INSTITUTION-UX-A): replaces the "الصنف" (item) dropdown with a free-text
--   "المنفذ" (Access point / Port) field, and adds a new institution-private
--   "نوع التجهيز" (Supply type) free-text field.
--
-- Documented schema gap (Part B — why this migration is needed):
--   item_availability.local_item_id is `not null references local_items(id)`
--   and is half of the table's unique key `(local_item_id, distribution_point_id)`,
--   which the editor's upsert already targets via `onConflict`. The new
--   "المنفذ" field is free text, not a selection from local_items — there is
--   no existing text column that can safely hold it, and the NOT NULL/unique
--   constraints on local_item_id cannot be satisfied by a form that no
--   longer collects an item selection. This migration adds a parallel,
--   independent path:
--     - local_item_id becomes nullable (existing rows are completely
--       unaffected — they already have a non-null value).
--     - a new nullable port_name text column holds the free-text value for
--       records created via the new flow.
--     - a new, NON-partial unique index on (distribution_point_id,
--       port_name) lets the new flow's upsert target a real conflict key.
--       Because Postgres unique indexes never treat two NULLs as duplicates,
--       this index is silently satisfied by every existing row (all of
--       which have port_name = NULL) without any backfill, and never
--       collides with the original (local_item_id, distribution_point_id)
--       unique constraint, which remains fully intact and unchanged.
--   The original item-based flow (local_item_id + that original unique
--   constraint) is NOT removed — only made optional, so any other code path
--   that still depends on it continues to work unmodified.
--
-- What this migration does:
--   A. ALTER COLUMN local_item_id DROP NOT NULL (loosens a constraint only —
--      does not delete, move, or alter any existing data; fully reversible).
--   B. ADD COLUMN IF NOT EXISTS port_name text — free-text "المنفذ" value.
--   C. ADD COLUMN IF NOT EXISTS supply_type text — free-text "نوع التجهيز"
--      value, institution-private (see Security note below).
--   D. Adds a CHECK constraint requiring at least one of local_item_id /
--      port_name to be present (defensive data-integrity guard; every
--      existing row already satisfies this since local_item_id was
--      previously NOT NULL).
--   E. CREATE UNIQUE INDEX IF NOT EXISTS for the new (distribution_point_id,
--      port_name) upsert conflict target.
--   F. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT touch the original (local_item_id, distribution_point_id)
--     unique constraint — it remains exactly as migration 001 defined it.
--   - Does NOT modify the `condition` CHECK constraint or its allowed
--     values (surplus / near_expiry stay separate at the DB layer — the
--     combined "Surplus - Near expiry" wording from Part D is a display-
--     only mapping in the frontend, not a new stored value).
--   - Does NOT modify RLS policies on item_availability. The existing
--     `avail_select_org` policy (organization_id = phoenix_my_org() OR
--     super_admin) already prevents other institutions from reading this
--     row (and therefore its new supply_type column) at all — column-level
--     protection is not needed for the authenticated cross-institution
--     case, only the existing row-level scoping.
--   - Does NOT modify get_public_qr_payload() or any other RPC — neither
--     port_name nor supply_type is added to any public/anon-facing output
--     by this migration. New columns are never automatically exposed by an
--     RPC; only an explicit later change to that RPC's body could do so.
--   - Does NOT touch auth.users, passwords, or any credential material.
--   - Does NOT change permission rules or any permission RPC.
--
-- Documented residual gap (Part E — report only, not fixed here):
--   The pre-existing `avail_select_anon` RLS policy on item_availability is
--   `for select to anon using (true)` — it grants the anon role read access
--   to EVERY column of EVERY row, with no organization filter. This was
--   already true before this migration (it already exposed quantity,
--   condition, notes, etc. to anon at the database layer) and is NOT
--   introduced or worsened by adding port_name/supply_type. The current
--   public QR flow does not query item_availability directly — it goes
--   through the curated get_public_qr_payload() RPC, which this migration
--   does not touch and which will not surface the new columns unless someone
--   explicitly edits that RPC body later. If true column-level public
--   protection is ever required (e.g. a future direct anon query against
--   this table), that is a separate, pre-existing RLS gap that should be
--   reviewed and fixed in its own dedicated, reviewed migration — not
--   bundled into this UX-driven change.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001-018 should already be applied.
--
-- Safety:
--   - No DROP, TRUNCATE, destructive DELETE, or unsafe CASCADE.
--   - ALTER COLUMN ... DROP NOT NULL is non-destructive and idempotent
--     (a no-op if the column is already nullable).
--   - ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS are
--     naturally idempotent.
--   - No existing row's data is modified, deleted, or backfilled.
-- ============================================================================

-- ============================================================================
-- A. Loosen local_item_id to nullable (existing rows unaffected — all
--    already have a non-null value, so this changes no data).
-- ============================================================================

alter table item_availability
  alter column local_item_id drop not null;

-- ============================================================================
-- B + C. New free-text columns.
-- ============================================================================

alter table item_availability add column if not exists port_name   text;
alter table item_availability add column if not exists supply_type text;

-- ============================================================================
-- D. Defensive integrity guard: every row must still identify what it is
--    about, either via the original item FK or the new free-text port name.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'item_availability_identity_chk'
  ) then
    alter table item_availability add constraint item_availability_identity_chk
      check (local_item_id is not null or port_name is not null);
  end if;
end $$;

-- ============================================================================
-- E. New, non-partial unique index for the free-text-port upsert flow.
--    NULLs are never considered duplicates of each other in a Postgres
--    unique index, so this is satisfied instantly by every existing row
--    (all of which have port_name = NULL) with no backfill required.
-- ============================================================================

create unique index if not exists item_avail_point_port_idx
  on item_availability (distribution_point_id, port_name);

-- ============================================================================
-- F. Verification
-- ============================================================================

do $$
declare
  v_col_count integer;
  v_nullable  text;
  v_idx_exists boolean;
begin
  select count(*) into v_col_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'item_availability'
    and column_name in ('port_name', 'supply_type');
  assert v_col_count = 2,
    'VERIFY FAILED: expected port_name + supply_type columns, found ' || v_col_count;

  select is_nullable into v_nullable
  from information_schema.columns
  where table_schema = 'public' and table_name = 'item_availability'
    and column_name = 'local_item_id';
  assert v_nullable = 'YES',
    'VERIFY FAILED: item_availability.local_item_id is still NOT NULL';

  select exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'item_availability'
      and indexname = 'item_avail_point_port_idx'
  ) into v_idx_exists;
  assert v_idx_exists,
    'VERIFY FAILED: item_avail_point_port_idx is missing';

  raise notice 'Migration 019 verification passed: port_name/supply_type added, local_item_id nullable, conflict index in place.';
end $$;

-- ============================================================================
-- END OF MIGRATION 019
--
-- Post-apply verification (run manually):
--
-- 1. Confirm the new columns and nullability:
--    select column_name, data_type, is_nullable
--    from information_schema.columns
--    where table_schema = 'public' and table_name = 'item_availability'
--    order by ordinal_position;
--
-- 2. Confirm the original unique constraint is untouched and the new index exists:
--    select indexname, indexdef from pg_indexes
--    where schemaname = 'public' and tablename = 'item_availability'
--    order by indexname;
--
-- 3. Confirm no existing row lost its local_item_id (this migration never
--    writes to existing rows — this is a sanity check, expect 0):
--    select count(*) from item_availability where local_item_id is null and port_name is null;
--
-- 4. Confirm RLS policies are unchanged (still organization-scoped for
--    authenticated users; anon policy is pre-existing, not modified here):
--    select policyname, cmd, qual from pg_policies
--    where schemaname = 'public' and tablename = 'item_availability'
--    order by policyname;
--
-- NOTE: the avail_select_anon (anon, using (true)) policy is pre-existing
-- (migration 002) and is NOT changed by this migration. See the "Documented
-- residual gap" note above if column-level public protection is ever needed.
-- ============================================================================
