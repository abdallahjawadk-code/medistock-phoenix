-- =============================================================================
-- MediStock Phoenix V2 — Migration 060: Warehouse Foundation (additive)
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 059 is confirmed applied and healthy.
--
-- Prerequisites: Migrations 001–059 must already be applied.
--
-- WAREHOUSE-W1-FOUNDATION-IMPLEMENT-A
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES
-- ─────────────────────────────────────────────────────────────────────────────
--   Revives the dormant `warehouses` domain and creates the authoritative,
--   batch-aware warehouse stock foundation that a later phase (061/062) will
--   dispatch from. Three parts:
--
--   A. warehouses repair — adds `is_main boolean` and `code text` (the only
--      two columns the table lacks), the constraints that make them safe, and
--      a partial unique index enforcing ONE active main warehouse per
--      organization. Also adds UNIQUE (id, organization_id) purely as a
--      composite foreign-key TARGET (see "same-organization integrity").
--
--   B. warehouse RLS modernization — replaces migration 002's four legacy
--      role-based policies with permission-key + organization-scoped policies,
--      exactly mirroring what migration 021 did for distribution_points.
--
--   C. warehouse_stock + warehouse_stock_movements — the authoritative
--      quantity model and its immutable ledger.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE RLS REPLACEMENT IS REQUIRED (not cosmetic)
-- ─────────────────────────────────────────────────────────────────────────────
--   Migration 010 already created the `warehouses.view` / `warehouses.manage`
--   permission keys and granted BOTH to warehouse_officer (010:152-153).
--   But migration 002's write policies gate on the LEGACY role names
--   `hospital_admin` / `warehouse_manager`, which the current product does not
--   assign (the live roles are institution_admin / warehouse_officer;
--   migration 012 keeps the legacy names only as tolerated CHECK values).
--
--   Net effect today: a warehouse_officer HOLDS warehouses.manage and is still
--   blocked from every warehouse write — only super_admin can write. Migration
--   021 performed exactly this role→permission modernization for
--   distribution_points and deliberately left warehouses behind (it was
--   retiring the domain, not reviving it). This migration finishes that work.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAME-ORGANIZATION INTEGRITY (why UNIQUE (id, organization_id) exists)
-- ─────────────────────────────────────────────────────────────────────────────
--   warehouse_stock carries organization_id (for RLS scoping) AND warehouse_id.
--   Those two must never disagree, or a row could be readable by the wrong org.
--   A row-level CHECK cannot express a cross-table rule, and a trigger can be
--   bypassed by a SECURITY DEFINER path that forgets to fire it. Instead this
--   migration adds UNIQUE (id, organization_id) on warehouses as a composite FK
--   target, so warehouse_stock's
--     FOREIGN KEY (warehouse_id, organization_id) → warehouses(id, organization_id)
--   makes the agreement a STRUCTURAL guarantee the database itself enforces.
--   The added unique constraint is trivially satisfiable: `id` is already the
--   primary key, so (id, organization_id) is unique for every existing row —
--   this constraint CANNOT fail on existing data.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO-BATCH IDENTITY (confirmed product decision — corrected Option C)
-- ─────────────────────────────────────────────────────────────────────────────
--   Provenance-preserving. When a material has no manufacturer batch number:
--     • batch_number stays NULL — it is the real/public field and must not be
--       stuffed with a placeholder ('بلا', 'N/A', 'NONE', '-' are BANNED by an
--       explicit CHECK below, not merely by convention).
--     • has_no_batch_number = true records that "none" is an EXPLICIT answer
--       rather than "not entered yet".
--     • internal_batch_reference (PRIVATE, never public) distinguishes two
--       independently received no-batch shipments so they do not silently
--       merge into one stock row.
--   The 8-field identity index below therefore separates independently
--   received no-batch stock while still merging genuinely identical real
--   batches.
--
--   SCOPE BOUNDARY: this migration does NOT touch item_availability. The
--   outlet's existing seven-field identity (migration 051) is unchanged here.
--   Migration 061 will replace the live outlet index with the corrected
--   eight-field model and constrain phoenix_upsert_availability to
--   internal_batch_reference IS NULL. Deliberately NOT split across two
--   conflicting outlet unique indexes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--   • Does NOT modify migrations 001–059 in any way.
--   • Does NOT touch item_availability or item_availability_movements
--     (no ALTER, no DELETE, no index change) — 061's scope.
--   • Does NOT modify phoenix_upsert_availability / phoenix_apply_availability_movement.
--   • Does NOT modify get_public_qr_payload or any public QR behavior.
--   • Does NOT create warehouse_dispatches / warehouse_dispatch_lines — 061.
--   • Does NOT create dispatch_line_id on movements — 061 adds it additively.
--   • Does NOT create any warehouse stock WRITE rpc — 062.
--   • Does NOT touch inter_org_exchange_* / inter_org_alert_*.
--   • Does NOT touch migration 055 (phoenix_clean_availability_data). Warehouse
--     tables are deliberately absent from Deep Clean: warehouse masters, stock
--     and movement history are PRESERVED.
--   • Does NOT backfill any code. Does NOT auto-mark any warehouse as main.
--   • Does NOT drop a table/column, TRUNCATE, or DELETE any row.
--   • Does NOT grant anon anything, anywhere.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
--   DROP TABLE public.warehouse_stock_movements;
--   DROP TABLE public.warehouse_stock;
--   DROP INDEX public.warehouses_one_active_main_per_org_uniq;
--   DROP INDEX public.warehouses_org_code_uniq;
--   ALTER TABLE public.warehouses
--     DROP CONSTRAINT warehouses_id_org_uniq,
--     DROP CONSTRAINT warehouses_code_nonempty_chk,
--     DROP CONSTRAINT warehouses_code_no_placeholder_chk,
--     DROP CONSTRAINT warehouses_main_requires_active_chk,
--     DROP COLUMN is_main,
--     DROP COLUMN code;
--   Then re-apply migration 002's four `wh_*` policy statements verbatim to
--   restore the legacy authorization basis. No data rollback is needed: this
--   migration adds only defaulted/nullable columns and empty tables.
-- =============================================================================

begin;

-- =============================================================================
-- A. Repair the existing `warehouses` table (additive only)
-- =============================================================================
-- The table already has id, organization_id, name, name_ar, location_notes,
-- status, archived_at, archived_by, archive_reason, created_at, updated_at,
-- created_by (migration 001, never altered since). ONLY is_main and code are
-- missing — nothing else is (re-)added here.

ALTER TABLE public.warehouses ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false;
ALTER TABLE public.warehouses ADD COLUMN IF NOT EXISTS code    text;

-- code: NULL means "no code assigned" (no placeholder). When present it must be
-- a real trimmed, non-empty value.
DO $$ BEGIN
  ALTER TABLE public.warehouses
    ADD CONSTRAINT warehouses_code_nonempty_chk
    CHECK (code IS NULL OR (btrim(code) = code AND code <> ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- code must never carry a literal "none" placeholder — absence is NULL.
DO $$ BEGIN
  ALTER TABLE public.warehouses
    ADD CONSTRAINT warehouses_code_no_placeholder_chk
    CHECK (
      code IS NULL
      OR (upper(btrim(code)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
          AND btrim(code) <> 'بلا')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A main warehouse is only meaningful while active. This also makes
-- "an archived warehouse cannot be an active main warehouse" structural.
-- Existing rows all have is_main = false (the new default), so this constraint
-- cannot fail on existing data regardless of their status.
DO $$ BEGIN
  ALTER TABLE public.warehouses
    ADD CONSTRAINT warehouses_main_requires_active_chk
    CHECK (is_main = false OR status = 'active');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Composite FK target (see header). Trivially satisfiable: id is already the PK.
DO $$ BEGIN
  ALTER TABLE public.warehouses
    ADD CONSTRAINT warehouses_id_org_uniq UNIQUE (id, organization_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Exactly one ACTIVE main warehouse per organization. Partial-unique idiom
-- matches migrations 029/051. Organizations with zero main warehouses stay
-- valid — nothing is auto-promoted.
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_one_active_main_per_org_uniq
  ON public.warehouses (organization_id)
  WHERE is_main = true AND status = 'active';

-- Warehouse code is unique per organization when assigned. btrim() is IMMUTABLE
-- (unlike a date/text cast — see migration 051's 42P17 incident), so it is safe
-- inside an index expression.
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_org_code_uniq
  ON public.warehouses (organization_id, btrim(code))
  WHERE code IS NOT NULL;

COMMENT ON COLUMN public.warehouses.is_main IS
  'True for the organization''s authoritative main warehouse. At most one '
  'active main warehouse per organization (warehouses_one_active_main_per_org_uniq). '
  'Only valid while status = ''active''.';

COMMENT ON COLUMN public.warehouses.code IS
  'Optional internal warehouse code, unique per organization when present. '
  'NULL means no code assigned — never a placeholder string.';

-- =============================================================================
-- B. Modernize warehouse RLS: legacy role gates → permission-key gates
-- =============================================================================
-- Mirrors migration 021's distribution_points modernization exactly. The four
-- policy names below are the complete set created by migration 002 for this
-- table — no other warehouse policy exists to drop.

DROP POLICY IF EXISTS "wh_select_org"          ON public.warehouses;
DROP POLICY IF EXISTS "wh_write_superadmin"    ON public.warehouses;
DROP POLICY IF EXISTS "wh_write_hospitaladmin" ON public.warehouses;
DROP POLICY IF EXISTS "wh_write_wh_manager"    ON public.warehouses;

-- SELECT: super_admin sees all; everyone else needs warehouses.view + own org.
CREATE POLICY "wh_select_perm" ON public.warehouses
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouses.view')
    )
  );

-- INSERT: super_admin bypass; otherwise warehouses.manage + own org.
CREATE POLICY "wh_insert_perm" ON public.warehouses
  FOR INSERT TO authenticated
  WITH CHECK (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouses.manage')
    )
  );

-- UPDATE: super_admin bypass; otherwise warehouses.manage + own org. The
-- WITH CHECK repeats the org test so a row cannot be moved to another org.
CREATE POLICY "wh_update_perm" ON public.warehouses
  FOR UPDATE TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouses.manage')
    )
  )
  WITH CHECK (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouses.manage')
    )
  );

-- No DELETE policy, by design: warehouse retirement stays archive/inactivate
-- based (status + archived_* columns, archive_entity RPC), exactly like
-- distribution_points after migration 021.

-- =============================================================================
-- C. warehouse_stock — authoritative, batch-aware warehouse quantities
-- =============================================================================
-- Type choices are taken from the existing canonical columns, not invented:
--   • quantities  integer   — matches item_availability.quantity (001)
--   • unit_price  numeric(20,3) — matches item_availability.price (020)
--   • identity    text / date    — matches item_availability (020/049/051)

CREATE TABLE IF NOT EXISTS public.warehouse_stock (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  warehouse_id              uuid NOT NULL,

  -- Optional link to the drug master. Nullable and snapshot-backed for the same
  -- reason item_availability abandoned its mandatory local_item_id path in
  -- migration 019: the catalog row is not required to describe stock, and
  -- identity fields must survive catalog edits.
  central_item_id           uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,

  scientific_name           text NOT NULL,
  trade_name                text,
  concentration             text,
  dosage_form               text,
  unit                      text,

  -- Identity: national code / batch number, each with an EXPLICIT "none" flag
  -- so "no code" is distinguishable from "not entered yet" without placeholders.
  national_code             text,
  has_no_national_code      boolean NOT NULL DEFAULT false,
  batch_number              text,
  has_no_batch_number       boolean NOT NULL DEFAULT false,

  -- PRIVATE. Never public QR data. Set only for no-batch stock, to keep
  -- independently received shipments from merging. See header.
  internal_batch_reference  text,

  expiry_date               date,

  on_hand_quantity          integer NOT NULL DEFAULT 0,
  reserved_quantity         integer NOT NULL DEFAULT 0,
  -- Generated, so available_quantity = on_hand - reserved can never drift out
  -- of sync with its inputs. Not writable by any caller.
  available_quantity        integer GENERATED ALWAYS AS (on_hand_quantity - reserved_quantity) STORED,

  unit_price                numeric(20,3),
  price_basis               text,
  currency                  text,
  supply_type_text          text,
  source_document_number    text,
  notes                     text,

  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- Structural same-organization guarantee (see header). RESTRICT: a warehouse
  -- holding stock cannot be deleted out from under it.
  CONSTRAINT warehouse_stock_wh_org_fk
    FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT warehouse_stock_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),

  -- Optional identity text is stored trimmed and non-empty, or NULL. Never ''.
  CONSTRAINT warehouse_stock_trade_name_chk
    CHECK (trade_name IS NULL OR (btrim(trade_name) = trade_name AND trade_name <> '')),
  CONSTRAINT warehouse_stock_concentration_chk
    CHECK (concentration IS NULL OR (btrim(concentration) = concentration AND concentration <> '')),
  CONSTRAINT warehouse_stock_dosage_form_chk
    CHECK (dosage_form IS NULL OR (btrim(dosage_form) = dosage_form AND dosage_form <> '')),
  CONSTRAINT warehouse_stock_unit_chk
    CHECK (unit IS NULL OR (btrim(unit) = unit AND unit <> '')),
  CONSTRAINT warehouse_stock_national_code_chk
    CHECK (national_code IS NULL OR (btrim(national_code) = national_code AND national_code <> '')),
  CONSTRAINT warehouse_stock_batch_number_chk
    CHECK (batch_number IS NULL OR (btrim(batch_number) = batch_number AND batch_number <> '')),
  CONSTRAINT warehouse_stock_internal_ref_chk
    CHECK (internal_batch_reference IS NULL
           OR (btrim(internal_batch_reference) = internal_batch_reference
               AND internal_batch_reference <> '')),

  -- Placeholders are DATA CORRUPTION here: absence must be NULL + the has_no_*
  -- flag, never a literal. Enforced, not merely documented.
  CONSTRAINT warehouse_stock_no_placeholder_chk
    CHECK (
      (national_code IS NULL
        OR (upper(btrim(national_code)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
            AND btrim(national_code) <> 'بلا'))
      AND (batch_number IS NULL
        OR (upper(btrim(batch_number)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
            AND btrim(batch_number) <> 'بلا'))
      AND (internal_batch_reference IS NULL
        OR (upper(btrim(internal_batch_reference)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
            AND btrim(internal_batch_reference) <> 'بلا'))
    ),

  -- The has_no_* flag must EXACTLY correspond to its field being NULL — it can
  -- never contradict the data it describes.
  CONSTRAINT warehouse_stock_has_no_national_code_chk
    CHECK (has_no_national_code = (national_code IS NULL)),
  CONSTRAINT warehouse_stock_has_no_batch_number_chk
    CHECK (has_no_batch_number = (batch_number IS NULL)),

  -- Corrected Option C: an internal reference exists exactly when there is no
  -- real batch number — never alongside one, never absent from no-batch stock.
  CONSTRAINT warehouse_stock_internal_ref_rule_chk
    CHECK (
      CASE WHEN has_no_batch_number
           THEN internal_batch_reference IS NOT NULL
           ELSE internal_batch_reference IS NULL
      END
    ),

  CONSTRAINT warehouse_stock_on_hand_nonneg_chk   CHECK (on_hand_quantity  >= 0),
  CONSTRAINT warehouse_stock_reserved_nonneg_chk  CHECK (reserved_quantity >= 0),
  -- The reservation invariant: available_quantity can never go negative.
  CONSTRAINT warehouse_stock_reserved_le_on_hand_chk
    CHECK (reserved_quantity <= on_hand_quantity),
  CONSTRAINT warehouse_stock_unit_price_chk
    CHECK (unit_price IS NULL OR unit_price >= 0)
);

-- Warehouse stock identity. Mirrors migration 051's COALESCE normalization
-- exactly, INCLUDING the immutable date sentinel: expiry_date::text is NOT
-- IMMUTABLE (it depends on DateStyle) and Postgres rejects it in an index
-- (ERROR 42P17). The 8th component (internal_batch_reference) is what keeps
-- independently received no-batch stock separate.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_identity_uniq
  ON public.warehouse_stock (
    warehouse_id,
    scientific_name,
    COALESCE(concentration, ''),
    COALESCE(dosage_form, ''),
    COALESCE(national_code, ''),
    COALESCE(batch_number, ''),
    COALESCE(expiry_date, DATE '0001-01-01'),
    COALESCE(internal_batch_reference, '')
  );

CREATE INDEX IF NOT EXISTS warehouse_stock_org_idx        ON public.warehouse_stock (organization_id);
CREATE INDEX IF NOT EXISTS warehouse_stock_warehouse_idx  ON public.warehouse_stock (warehouse_id);
CREATE INDEX IF NOT EXISTS warehouse_stock_sci_name_idx   ON public.warehouse_stock (scientific_name);
CREATE INDEX IF NOT EXISTS warehouse_stock_expiry_idx     ON public.warehouse_stock (expiry_date);

COMMENT ON TABLE public.warehouse_stock IS
  'Authoritative batch-aware warehouse quantities. One row per exact material '
  'identity per warehouse (warehouse_stock_identity_uniq). available_quantity '
  'is generated as on_hand_quantity - reserved_quantity and is never written '
  'directly. Rows are written ONLY by a future SECURITY DEFINER RPC '
  '(migration 062) — there is no direct client INSERT/UPDATE/DELETE path, by '
  'design, matching item_availability_movements (033). Never public: this table '
  'is not readable by anon and never feeds get_public_qr_payload.';

COMMENT ON COLUMN public.warehouse_stock.internal_batch_reference IS
  'PRIVATE. Set only when has_no_batch_number = true, to keep independently '
  'received no-batch shipments from merging into one identity. Never exposed '
  'publicly; batch_number itself stays NULL for such stock.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_stock
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- D. warehouse_stock_movements — immutable ledger
-- =============================================================================
-- Every on-hand or reservation change is explained by exactly one row. Mirrors
-- item_availability_movements (033): identity snapshots (because the parent's
-- identity fields are mutable), before/delta/after arithmetic, actor snapshot,
-- and no client write path.

CREATE TABLE IF NOT EXISTS public.warehouse_stock_movements (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_stock_id                uuid NOT NULL REFERENCES public.warehouse_stock(id) ON DELETE RESTRICT,
  organization_id                   uuid NOT NULL,
  warehouse_id                      uuid NOT NULL,

  movement_type                     text NOT NULL,

  on_hand_before                    integer NOT NULL,
  on_hand_delta                     integer NOT NULL,
  on_hand_after                     integer NOT NULL,
  reserved_before                   integer NOT NULL,
  reserved_delta                    integer NOT NULL,
  reserved_after                    integer NOT NULL,

  reason                            text,
  -- Generic provenance pointer. Deliberately NOT a dispatch FK yet: migration
  -- 061 adds dispatch_line_id additively once the dispatch tables exist.
  reference_type                    text,
  reference_id                      uuid,
  source_document_number            text,

  actor_id                          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role                        text,
  actor_name                        text,

  scientific_name_snapshot          text NOT NULL,
  concentration_snapshot            text,
  dosage_form_snapshot              text,
  batch_number_snapshot             text,
  internal_batch_reference_snapshot text,

  created_at                        timestamptz NOT NULL DEFAULT now(),

  -- Same structural org guarantee as warehouse_stock.
  CONSTRAINT warehouse_stock_movements_wh_org_fk
    FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  -- Text + CHECK, never a Postgres enum: every status/type column in this
  -- schema (warehouses.status, item_availability.condition, movement_type in
  -- 033) is text+CHECK, and an enum cannot be altered inside a transaction.
  CONSTRAINT warehouse_stock_movements_type_chk
    CHECK (movement_type IN (
      'set_exact', 'add', 'subtract', 'correction',
      'reserve', 'release', 'dispatch_send', 'dispatch_return'
    )),

  -- Arithmetic must be self-consistent: the ledger can never disagree with itself.
  CONSTRAINT warehouse_stock_movements_on_hand_math_chk
    CHECK (on_hand_before + on_hand_delta = on_hand_after),
  CONSTRAINT warehouse_stock_movements_reserved_math_chk
    CHECK (reserved_before + reserved_delta = reserved_after),

  CONSTRAINT warehouse_stock_movements_on_hand_before_chk  CHECK (on_hand_before  >= 0),
  CONSTRAINT warehouse_stock_movements_on_hand_after_chk   CHECK (on_hand_after   >= 0),
  CONSTRAINT warehouse_stock_movements_reserved_before_chk CHECK (reserved_before >= 0),
  CONSTRAINT warehouse_stock_movements_reserved_after_chk  CHECK (reserved_after  >= 0),
  -- The reservation invariant holds at every point in history, not just now.
  CONSTRAINT warehouse_stock_movements_reserved_le_on_hand_chk
    CHECK (reserved_after <= on_hand_after),

  -- A correction or an absolute overwrite must be explained (033 precedent).
  CONSTRAINT warehouse_stock_movements_correction_reason_chk
    CHECK (movement_type <> 'correction' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT warehouse_stock_movements_set_exact_reason_chk
    CHECK (movement_type <> 'set_exact' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  -- Returned stock must be traceable to a reason or the thing it came back from.
  CONSTRAINT warehouse_stock_movements_dispatch_return_chk
    CHECK (
      movement_type <> 'dispatch_return'
      OR (reason IS NOT NULL AND btrim(reason) <> '')
      OR reference_id IS NOT NULL
    ),

  CONSTRAINT warehouse_stock_movements_sci_snapshot_chk
    CHECK (btrim(scientific_name_snapshot) = scientific_name_snapshot
           AND scientific_name_snapshot <> '')
);

CREATE INDEX IF NOT EXISTS warehouse_stock_movements_stock_idx
  ON public.warehouse_stock_movements (warehouse_stock_id);
CREATE INDEX IF NOT EXISTS warehouse_stock_movements_org_idx
  ON public.warehouse_stock_movements (organization_id);
CREATE INDEX IF NOT EXISTS warehouse_stock_movements_warehouse_idx
  ON public.warehouse_stock_movements (warehouse_id);
CREATE INDEX IF NOT EXISTS warehouse_stock_movements_created_idx
  ON public.warehouse_stock_movements (created_at);
CREATE INDEX IF NOT EXISTS warehouse_stock_movements_reference_idx
  ON public.warehouse_stock_movements (reference_type, reference_id);

COMMENT ON TABLE public.warehouse_stock_movements IS
  'Immutable ledger for warehouse_stock. Every on-hand/reservation change is '
  'one row with before/delta/after values, actor identity, an identity '
  'snapshot, and an optional reason/reference. Rows are inserted ONLY by a '
  'future SECURITY DEFINER RPC (migration 062) — no direct client INSERT, '
  'UPDATE or DELETE path, by design. Movement rows must never be edited or '
  'removed; corrections are recorded as new rows, never as edits to history. '
  'ON DELETE RESTRICT to warehouse_stock preserves that history. This table is '
  'deliberately NOT part of Deep Clean (migration 055).';

-- =============================================================================
-- E. RLS + grants for the new tables
-- =============================================================================
-- Read-only for authenticated holders of warehouses.view within their own org.
-- No write policy and no write grant: writes arrive in migration 062 through
-- SECURITY DEFINER RPCs. anon gets nothing, anywhere.

ALTER TABLE public.warehouse_stock            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_stock_movements  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "warehouse_stock_select_perm"      ON public.warehouse_stock;
DROP POLICY IF EXISTS "warehouse_stock_mov_select_perm"  ON public.warehouse_stock_movements;

CREATE POLICY "warehouse_stock_select_perm" ON public.warehouse_stock
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouses.view')
    )
  );

CREATE POLICY "warehouse_stock_mov_select_perm" ON public.warehouse_stock_movements
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouses.view')
    )
  );

-- No INSERT/UPDATE/DELETE policy on either table, by design.

REVOKE ALL ON TABLE public.warehouse_stock            FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.warehouse_stock_movements  FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.warehouse_stock            TO authenticated;
GRANT SELECT ON TABLE public.warehouse_stock_movements  TO authenticated;
-- Explicitly documented as absent (idempotent no-op if never granted):
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_stock            FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_stock_movements  FROM authenticated;

-- =============================================================================
-- F. VERIFY — runs INSIDE this transaction; any failure rolls the whole thing back
-- =============================================================================
DO $$
DECLARE
  v_cnt        int;
  v_idxdef     text;
  v_pol_qual   text;
  v_fn_src     text;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. warehouses repair
  -- ---------------------------------------------------------------------------
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'is_main'
      AND data_type = 'boolean' AND is_nullable = 'NO'
  ), 'VERIFY FAILED (060): warehouses.is_main missing or not NOT NULL boolean';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'code'
      AND data_type = 'text' AND is_nullable = 'YES'
  ), 'VERIFY FAILED (060): warehouses.code missing or not nullable text';

  -- No pre-existing warehouse column was duplicated or lost: 001's twelve
  -- columns + the two new ones = exactly 14.
  SELECT count(*) INTO v_cnt FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'warehouses';
  ASSERT v_cnt = 14,
    'VERIFY FAILED (060): warehouses should have exactly 14 columns (12 original + is_main + code), found ' || v_cnt;

  FOREACH v_idxdef IN ARRAY ARRAY[
    'id','organization_id','name','name_ar','location_notes','status',
    'archived_at','archived_by','archive_reason','created_at','updated_at','created_by'
  ] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = v_idxdef
    ), 'VERIFY FAILED (060): pre-existing warehouses column lost: ' || v_idxdef;
  END LOOP;

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'warehouses_one_active_main_per_org_uniq'
  ), 'VERIFY FAILED (060): one-active-main-per-org partial unique index missing';

  SELECT indexdef INTO v_idxdef FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'warehouses_one_active_main_per_org_uniq';
  ASSERT v_idxdef ILIKE '%UNIQUE%' AND v_idxdef ILIKE '%is_main%' AND v_idxdef ILIKE '%active%',
    'VERIFY FAILED (060): main-warehouse index is not a partial unique on is_main + active';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'warehouses_org_code_uniq'
  ), 'VERIFY FAILED (060): warehouses_org_code_uniq missing';

  FOREACH v_idxdef IN ARRAY ARRAY[
    'warehouses_code_nonempty_chk','warehouses_code_no_placeholder_chk',
    'warehouses_main_requires_active_chk','warehouses_id_org_uniq'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_idxdef),
      'VERIFY FAILED (060): constraint missing: ' || v_idxdef;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 2. Warehouse RLS modernization
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'warehouses'
    AND policyname IN ('wh_select_org','wh_write_superadmin','wh_write_hospitaladmin','wh_write_wh_manager');
  ASSERT v_cnt = 0,
    'VERIFY FAILED (060): legacy wh_* policies still present, found ' || v_cnt;

  FOREACH v_idxdef IN ARRAY ARRAY['wh_select_perm','wh_insert_perm','wh_update_perm'] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'warehouses'
        AND policyname = v_idxdef
    ), 'VERIFY FAILED (060): replacement policy missing: ' || v_idxdef;
  END LOOP;

  -- No warehouse policy may authorize on a legacy role name.
  SELECT string_agg(coalesce(qual,'') || ' ' || coalesce(with_check,''), ' ') INTO v_pol_qual
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'warehouses';
  ASSERT v_pol_qual NOT ILIKE '%hospital_admin%',
    'VERIFY FAILED (060): a warehouses policy still references hospital_admin';
  ASSERT v_pol_qual NOT ILIKE '%warehouse_manager%',
    'VERIFY FAILED (060): a warehouses policy still references warehouse_manager';
  ASSERT v_pol_qual ILIKE '%warehouses.view%' AND v_pol_qual ILIKE '%warehouses.manage%',
    'VERIFY FAILED (060): warehouses policies do not use the warehouses.view/manage permission keys';

  -- No client DELETE policy on warehouses.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'warehouses' AND cmd = 'DELETE'
  ), 'VERIFY FAILED (060): a DELETE policy exists on warehouses — retirement must stay archive-based';

  -- The permission keys this migration now depends on must still exist.
  ASSERT (SELECT count(*) FROM public.permission_keys WHERE key IN ('warehouses.view','warehouses.manage')) = 2,
    'VERIFY FAILED (060): warehouses.view/warehouses.manage permission keys missing';

  -- ---------------------------------------------------------------------------
  -- 3. warehouse_stock shape
  -- ---------------------------------------------------------------------------
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock'),
    'VERIFY FAILED (060): warehouse_stock missing';

  FOREACH v_idxdef IN ARRAY ARRAY['on_hand_quantity','reserved_quantity','available_quantity'] LOOP
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'warehouse_stock'
        AND column_name = v_idxdef AND data_type = 'integer'
    ), 'VERIFY FAILED (060): warehouse_stock.' || v_idxdef || ' must be integer';
  END LOOP;

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock'
      AND column_name = 'unit_price' AND data_type = 'numeric'
      AND numeric_precision = 20 AND numeric_scale = 3
  ), 'VERIFY FAILED (060): warehouse_stock.unit_price must be numeric(20,3)';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock'
      AND column_name = 'available_quantity' AND is_generated = 'ALWAYS'
  ), 'VERIFY FAILED (060): warehouse_stock.available_quantity must be a generated column';

  FOREACH v_idxdef IN ARRAY ARRAY[
    'warehouse_stock_has_no_national_code_chk','warehouse_stock_has_no_batch_number_chk',
    'warehouse_stock_internal_ref_rule_chk','warehouse_stock_reserved_le_on_hand_chk',
    'warehouse_stock_on_hand_nonneg_chk','warehouse_stock_reserved_nonneg_chk',
    'warehouse_stock_no_placeholder_chk','warehouse_stock_unit_price_chk',
    'warehouse_stock_wh_org_fk'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_idxdef),
      'VERIFY FAILED (060): warehouse_stock constraint missing: ' || v_idxdef;
  END LOOP;

  -- Identity index: 8 components, immutable date sentinel, no text cast.
  ASSERT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'warehouse_stock_identity_uniq'),
    'VERIFY FAILED (060): warehouse_stock_identity_uniq missing';

  SELECT indexdef INTO v_idxdef FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'warehouse_stock_identity_uniq';
  ASSERT v_idxdef ILIKE '%UNIQUE%', 'VERIFY FAILED (060): stock identity index is not UNIQUE';
  ASSERT v_idxdef ILIKE '%internal_batch_reference%',
    'VERIFY FAILED (060): stock identity index missing internal_batch_reference (8th component)';
  ASSERT v_idxdef ILIKE '%0001-01-01%',
    'VERIFY FAILED (060): stock identity index must use the immutable DATE ''0001-01-01'' sentinel';
  ASSERT v_idxdef NOT ILIKE '%expiry_date::text%' AND v_idxdef NOT ILIKE '%text(expiry_date)%',
    'VERIFY FAILED (060): stock identity index must not cast expiry_date to text (not IMMUTABLE, ERROR 42P17)';

  -- ---------------------------------------------------------------------------
  -- 4. warehouse_stock_movements shape
  -- ---------------------------------------------------------------------------
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock_movements'),
    'VERIFY FAILED (060): warehouse_stock_movements missing';

  FOREACH v_idxdef IN ARRAY ARRAY[
    'warehouse_stock_movements_type_chk',
    'warehouse_stock_movements_on_hand_math_chk','warehouse_stock_movements_reserved_math_chk',
    'warehouse_stock_movements_reserved_le_on_hand_chk',
    'warehouse_stock_movements_correction_reason_chk','warehouse_stock_movements_set_exact_reason_chk',
    'warehouse_stock_movements_dispatch_return_chk','warehouse_stock_movements_wh_org_fk'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_idxdef),
      'VERIFY FAILED (060): movements constraint missing: ' || v_idxdef;
  END LOOP;

  -- The ledger's parent link must RESTRICT, or history could be silently erased.
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'warehouse_stock_movements' AND c.contype = 'f'
      AND c.confdeltype = 'r'
      AND c.confrelid = 'public.warehouse_stock'::regclass
  ), 'VERIFY FAILED (060): warehouse_stock_movements → warehouse_stock must be ON DELETE RESTRICT';

  -- movement_type must be text + CHECK, never an enum.
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock_movements'
      AND column_name = 'movement_type' AND data_type = 'text'
  ), 'VERIFY FAILED (060): movement_type must be text (not an enum)';

  SELECT pg_get_constraintdef(oid) INTO v_idxdef FROM pg_constraint
  WHERE conname = 'warehouse_stock_movements_type_chk';
  FOREACH v_pol_qual IN ARRAY ARRAY[
    'set_exact','add','subtract','correction','reserve','release','dispatch_send','dispatch_return'
  ] LOOP
    ASSERT v_idxdef LIKE '%' || v_pol_qual || '%',
      'VERIFY FAILED (060): movement_type CHECK missing value: ' || v_pol_qual;
  END LOOP;

  -- 061 owns the dispatch linkage — it must not exist yet.
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock_movements'
      AND column_name = 'dispatch_line_id'
  ), 'VERIFY FAILED (060): dispatch_line_id must not exist yet — migration 061 adds it additively';

  -- ---------------------------------------------------------------------------
  -- 5. RLS + anon denial on the new tables
  -- ---------------------------------------------------------------------------
  FOREACH v_idxdef IN ARRAY ARRAY['warehouse_stock','warehouse_stock_movements'] LOOP
    ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_idxdef)::regclass),
      'VERIFY FAILED (060): RLS not enabled on ' || v_idxdef;

    -- anon must hold no privilege whatsoever.
    ASSERT NOT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_idxdef AND grantee = 'anon'
    ), 'VERIFY FAILED (060): anon holds a privilege on ' || v_idxdef;

    -- authenticated may read, and only read.
    ASSERT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_idxdef
        AND grantee = 'authenticated' AND privilege_type = 'SELECT'
    ), 'VERIFY FAILED (060): authenticated lost SELECT on ' || v_idxdef;

    ASSERT NOT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_idxdef
        AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
    ), 'VERIFY FAILED (060): authenticated holds a write grant on ' || v_idxdef;

    -- No write POLICY either — belt and braces with the missing grant.
    ASSERT NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_idxdef
        AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
    ), 'VERIFY FAILED (060): a direct write policy exists on ' || v_idxdef;
  END LOOP;

  -- ---------------------------------------------------------------------------
  -- 6. Isolation: public QR, item_availability, exchange domain untouched
  -- ---------------------------------------------------------------------------
  -- The public QR RPC must still exist, unchanged in shape, and must not have
  -- learned any warehouse field.
  SELECT prosrc INTO v_fn_src FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_public_qr_payload';
  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED (060): get_public_qr_payload is missing — 060 must not touch it';
  ASSERT v_fn_src NOT ILIKE '%warehouse_stock%'
     AND v_fn_src NOT ILIKE '%internal_batch_reference%'
     AND v_fn_src NOT ILIKE '%warehouse_dispatch%',
    'VERIFY FAILED (060): public QR payload leaked a warehouse/internal field';

  -- 051's outlet identity index must be untouched by this migration.
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'item_availability_dp_sci_conc_form_nat_batch_exp_uniq'
  ), 'VERIFY FAILED (060): migration 051 outlet identity index missing — 060 must not touch item_availability';

  -- 060 must not have added anything to item_availability (061 owns that).
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_availability'
      AND column_name = 'internal_batch_reference'
  ), 'VERIFY FAILED (060): item_availability.internal_batch_reference must be added by 061, not 060';

  -- Deep Clean and the exchange domain must still be intact and untouched.
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_clean_availability_data'
  ), 'VERIFY FAILED (060): phoenix_clean_availability_data missing — 060 must not touch migration 055';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_requests'
  ), 'VERIFY FAILED (060): inter_org_exchange_requests missing — 060 must not touch the exchange domain';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inter_org_exchange_requests_orgs_distinct_chk'
  ), 'VERIFY FAILED (060): exchange orgs-distinct constraint missing — the exchange domain must be untouched';

  RAISE NOTICE 'Migration 060 verification passed: warehouses repaired additively (is_main + code, one-active-main-per-org, org/code uniqueness, composite FK target); legacy role-based wh_* policies replaced by warehouses.view/manage permission policies with no legacy-role reference and no DELETE policy; warehouse_stock created with integer quantities, generated available_quantity, the reservation invariant, explicit no-code/no-batch rules, the private internal_batch_reference rule, placeholder bans, and an 8-field identity index using the immutable DATE ''0001-01-01'' sentinel; warehouse_stock_movements created as an immutable RESTRICT-linked ledger with text+CHECK movement types and self-consistent arithmetic; RLS enabled on both with read-only authenticated access, zero anon privileges, and no direct write policy or grant; item_availability, item_availability_movements, public QR, Deep Clean and the inter-org exchange domain all untouched; no dispatch objects created (061/062 scope).';
END $$;

commit;
