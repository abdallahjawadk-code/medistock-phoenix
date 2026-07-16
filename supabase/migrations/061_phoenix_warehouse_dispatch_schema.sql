-- =============================================================================
-- MediStock Phoenix V2 — Migration 061: Warehouse Dispatch Schema (additive)
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 060 is confirmed applied and healthy.
--
-- Prerequisites: Migrations 001–060 must already be applied. Migration 060
-- (warehouses repair + warehouse_stock + warehouse_stock_movements) is REQUIRED
-- — this migration's dispatch lines reference warehouse_stock directly.
--
-- WAREHOUSE-W1-DISPATCH-SCHEMA-061-A
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES
-- ─────────────────────────────────────────────────────────────────────────────
--   Creates the warehouse→outlet dispatch data model and the outlet-side
--   provenance identity that makes it safe. Six parts:
--
--   A. item_availability.internal_batch_reference — additive, nullable, private.
--   B. Outlet identity: replace migration 051's live 7-field unique index with
--      the corrected 8-field model (adds internal_batch_reference).
--   C. phoenix_upsert_availability — the manual/editor path is constrained to
--      internal_batch_reference IS NULL. Nothing else about it changes.
--   D. Composite unique FK targets on distribution_points / warehouse_stock.
--   E. warehouse_dispatches + warehouse_dispatch_lines.
--   F. item_availability_movements.dispatch_line_id + partial unique index.
--   Plus: 8 permission keys with separation of duty, RLS, grants, VERIFY.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE OUTLET INDEX IS REPLACED, NOT ADDED ALONGSIDE (read before editing)
-- ─────────────────────────────────────────────────────────────────────────────
--   Migration 051's index is
--     UNIQUE (distribution_point_id, scientific_name, COALESCE(concentration,''),
--             COALESCE(dosage_form,''), COALESCE(national_code,''),
--             COALESCE(batch_number,''), COALESCE(expiry_date, DATE '0001-01-01'))
--     WHERE scientific_name IS NOT NULL
--
--   Two independently accepted no-batch dispatch lines of the same material
--   produce identical 7-field keys (both nulls collapse to ''), so the second
--   acceptance would violate that index — dispatch could not preserve
--   provenance at all. Keeping BOTH indexes is impossible: the 7-field one
--   would reject exactly the rows the 8-field one is designed to allow.
--   Therefore 051's index is DROPPED and replaced. Migration 051 itself is not
--   modified — only the live index object it created is superseded here.
--
--   EXISTING ROWS ARE UNAFFECTED. Every current row has
--   internal_batch_reference = NULL (the column is created in this same
--   transaction), so its 8th component is COALESCE(NULL,'') = '' for every row.
--   The new key is therefore the old key with a constant appended: any two rows
--   that were distinct under 051 remain distinct, and any two that would
--   collide now would have collided under 051 too. A precheck below proves this
--   against real data before the swap, and fails the migration if it does not
--   hold.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO-BATCH IDENTITY (confirmed product decision — Option C, provenance-preserving)
-- ─────────────────────────────────────────────────────────────────────────────
--   • batch_number stays NULL when there is no manufacturer batch. It is the
--     real/public field and is never stuffed with a placeholder.
--   • internal_batch_reference (PRIVATE) distinguishes independently accepted
--     no-batch dispatch lines so they do not silently merge.
--   • Manual editor rows always keep internal_batch_reference = NULL, and the
--     editor can only ever match NULL rows (part C). Dispatch-origin rows are
--     therefore invisible to the manual merge path — the editor can neither
--     overwrite them nor reactivate them.
--   • internal_batch_reference is never public. get_public_qr_payload is not
--     touched by this migration, and its own VERIFY block (059) already asserts
--     batch_number/price/supply_type/national_code are absent from its output.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--   • Does NOT modify migrations 001–060 in any way.
--   • Does NOT create any dispatch workflow RPC (create/send/accept/reject/
--     cancel) — migration 062 owns those. This migration creates no function
--     other than the minimal phoenix_upsert_availability replacement in part C.
--   • Does NOT add any UI (W2/W3 scope).
--   • Does NOT modify get_public_qr_payload, PublicQrScreen, or migration 059.
--   • Does NOT modify migration 055 (Deep Clean). Dispatch history is preserved
--     and deliberately absent from its delete list.
--   • Does NOT touch inter_org_exchange_* / inter_org_alert_*.
--   • Does NOT change item_availability_movements.movement_type — acceptance
--     will use the existing 'add' type.
--   • Does NOT delete or mutate any existing row.
--   • Does NOT grant anon anything, anywhere.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
--   DROP INDEX public.item_availability_movements_dispatch_line_uniq;
--   ALTER TABLE public.item_availability_movements DROP COLUMN dispatch_line_id;
--   DROP TABLE public.warehouse_dispatch_lines;
--   DROP TABLE public.warehouse_dispatches;
--   DELETE FROM role_permission_defaults WHERE permission_key LIKE 'warehouse_dispatch.%';
--   DELETE FROM permission_keys          WHERE key           LIKE 'warehouse_dispatch.%';
--   DROP INDEX public.item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq;
--   -- then re-create migration 051's index verbatim, and re-apply migration
--   -- 053's phoenix_upsert_availability block verbatim:
--   ALTER TABLE public.item_availability DROP COLUMN internal_batch_reference;
--   ALTER TABLE public.distribution_points DROP CONSTRAINT distribution_points_id_org_uniq;
--   ALTER TABLE public.warehouse_stock     DROP CONSTRAINT warehouse_stock_id_org_uniq;
--   Safe in that order: this migration adds only nullable columns, new tables,
--   and new keys — no existing row is changed, so no data rollback is needed.
-- =============================================================================

begin;

-- =============================================================================
-- A. item_availability.internal_batch_reference (additive, nullable, private)
-- =============================================================================
-- Nullable by design: every existing row keeps NULL, which is exactly what
-- "entered manually, not from a dispatch" means. Never NOT NULL.

ALTER TABLE public.item_availability
  ADD COLUMN IF NOT EXISTS internal_batch_reference text;

-- Trimmed, non-empty, and never a literal "none" placeholder — absence is NULL.
DO $$ BEGIN
  ALTER TABLE public.item_availability
    ADD CONSTRAINT item_availability_internal_ref_chk
    CHECK (
      internal_batch_reference IS NULL
      OR (btrim(internal_batch_reference) = internal_batch_reference
          AND internal_batch_reference <> ''
          AND upper(btrim(internal_batch_reference)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
          AND btrim(internal_batch_reference) <> 'بلا')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.item_availability.internal_batch_reference IS
  'PRIVATE. NULL for every manually-entered row (the editor can only ever match '
  'and create NULL rows). Set only by dispatch acceptance, to keep independently '
  'accepted no-batch lines from merging into one identity. Never exposed '
  'publicly: get_public_qr_payload does not read it.';

-- =============================================================================
-- B. Outlet identity: replace 051's live 7-field index with the 8-field model
-- =============================================================================

-- B1. PRECHECK (fail-closed). Prove against real data that no two existing rows
--     collide under the NEW key before touching the old index. Because
--     internal_batch_reference was just added as NULL for every row, the new key
--     is the old key + a constant '' — so this can only fail if the database is
--     already in a state 051's index would itself have rejected. If it ever
--     does fail, the whole migration rolls back and the old index is untouched.
DO $$
DECLARE
  v_dupes int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1
    FROM public.item_availability
    WHERE scientific_name IS NOT NULL
    GROUP BY
      distribution_point_id,
      scientific_name,
      COALESCE(concentration, ''),
      COALESCE(dosage_form, ''),
      COALESCE(national_code, ''),
      COALESCE(batch_number, ''),
      COALESCE(expiry_date, DATE '0001-01-01'),
      COALESCE(internal_batch_reference, '')
    HAVING count(*) > 1
  ) d;

  ASSERT v_dupes = 0,
    'VERIFY FAILED (061 precheck): ' || v_dupes || ' existing item_availability group(s) '
    'would collide under the new 8-field identity — the old index is NOT dropped and '
    'this migration has rolled back. Resolve the duplicates first.';
END $$;

-- B2. Drop ONLY migration 051's exact live index. Keeping it alongside the new
--     one is impossible: it would reject exactly the independently-accepted
--     no-batch rows the 8-field index exists to permit.
DROP INDEX IF EXISTS public.item_availability_dp_sci_conc_form_nat_batch_exp_uniq;

-- B3. The corrected 8-field identity. Same normalization as 051, same partial
--     predicate, plus the private provenance component. The expiry component
--     uses the immutable date sentinel — expiry_date::text is NOT IMMUTABLE and
--     Postgres rejects it in an index (ERROR 42P17; see 051's incident note).
CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq
ON public.item_availability (
  distribution_point_id,
  scientific_name,
  COALESCE(concentration, ''),
  COALESCE(dosage_form, ''),
  COALESCE(national_code, ''),
  COALESCE(batch_number, ''),
  COALESCE(expiry_date, DATE '0001-01-01'),
  COALESCE(internal_batch_reference, '')
)
WHERE scientific_name IS NOT NULL;

-- item_availability_local_item_id_distribution_point_id_key (migration 001) is
-- intentionally left untouched, exactly as 043/051 left it: local_item_id has
-- been nullable since 019 and the RPC never sets it, so Postgres's NULLS
-- DISTINCT semantics make that legacy constraint inert for new-path rows.

-- =============================================================================
-- C. phoenix_upsert_availability — constrain the manual/editor path
-- =============================================================================
-- Reproduced from migration 053 (the authoritative definition) BYTE-FOR-BYTE,
-- with exactly ONE behavioural line added to the identity lookup:
--
--     AND ia.internal_batch_reference IS NULL
--
-- Everything else is unchanged and deliberately so: same 13-argument signature
-- and parameter order, RETURNS uuid, LANGUAGE plpgsql, SECURITY DEFINER,
-- SET search_path = public, the same org/cross-org authorization, the same
-- availability.create / availability.update permission gates, the same
-- normalization (NULLIF(btrim(x),'')), the same migration-035 quantity guard,
-- the same 053 reactivation semantics, and the same grants (CREATE OR REPLACE
-- with an identical argument-type list preserves them, so no re-GRANT is made).
--
-- Why this line: without it the editor's identity lookup would match a
-- dispatch-origin row (non-null internal reference) and merge into it, silently
-- destroying provenance and letting a manual edit overwrite accepted stock. The
-- INSERT path needs no change — its column list does not include
-- internal_batch_reference, so every manually created row keeps NULL.
--
-- No new parameter is added: the frontend contract is untouched, so W2/W3 can
-- adopt this without a service-layer change.

CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability(
  p_distribution_point_id uuid,
  p_scientific_name        text,
  p_trade_name             text,
  p_dosage_form            text,
  p_concentration          text,
  p_quantity               integer,
  p_condition              text,
  p_expiry_date            date,
  p_batch_number           text,
  p_notes                  text,
  p_supply_type            text,
  p_price                  numeric,
  p_national_code          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role               text := phoenix_my_role();
  v_my_org             uuid := phoenix_my_org();
  v_point_org          uuid;
  v_port_name          text;
  v_dp                 public.distribution_points%ROWTYPE;
  v_dosage             text := COALESCE(p_dosage_form, '');
  v_conc               text := COALESCE(p_concentration, '');
  v_national_code      text := NULLIF(btrim(p_national_code), '');
  v_batch_number       text := NULLIF(btrim(p_batch_number), '');
  v_national_code_key  text := COALESCE(NULLIF(btrim(p_national_code), ''), '');
  v_batch_number_key   text := COALESCE(NULLIF(btrim(p_batch_number), ''), '');
  -- FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A: `date`, not `text` — must
  -- match the immutable index expression above exactly (a text/::text
  -- cast is not IMMUTABLE and is rejected by CREATE UNIQUE INDEX).
  v_expiry_date_key    date := COALESCE(p_expiry_date, DATE '0001-01-01');
  v_id                 uuid;
  v_is_super           boolean;
  v_in_scope           boolean;
  v_existing_id        uuid;
  v_existing_quantity  integer;
  -- QR-REMOVED-MARKER-053-A: whether the incoming upsert represents active
  -- stock. Only used on the UPDATE path — never marks a row removed by
  -- itself, only ever clears an existing removal marker.
  v_reactivates        boolean;
BEGIN
  -- 0. scientific_name is required for the new path
  IF p_scientific_name IS NULL OR btrim(p_scientific_name) = '' THEN
    RAISE EXCEPTION 'scientific_name_required' USING ERRCODE = '23514';
  END IF;

  -- 1. derive the owning org AND a display port_name from the point
  --    (trusted source, never trusted from the client).
  SELECT * INTO v_dp
  FROM public.distribution_points
  WHERE id = p_distribution_point_id;

  IF NOT FOUND OR v_dp.organization_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_point_org := v_dp.organization_id;

  -- 1b. Derive a guaranteed non-null port_name (JSONB fallback for schema drift)
  v_port_name := COALESCE(
    NULLIF(to_jsonb(v_dp)->>'name', ''),
    NULLIF(to_jsonb(v_dp)->>'name_ar', ''),
    NULLIF(to_jsonb(v_dp)->>'display_name', ''),
    NULLIF(to_jsonb(v_dp)->>'port_name', ''),
    NULLIF(to_jsonb(v_dp)->>'title', ''),
    p_distribution_point_id::text
  );

  -- 2. authorize: permission-matrix based (unchanged from migration 035/050)
  v_is_super := (v_role = 'super_admin');
  v_in_scope := v_is_super OR (v_point_org = v_my_org);

  IF NOT v_in_scope THEN
    RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super
     AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.create')
     AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.update') THEN
    RAISE EXCEPTION 'forbidden_role_or_permission' USING ERRCODE = '42501';
  END IF;

  -- 3. Determine whether a matching row already exists. Matching key is
  --    WIDENED here (DB-MATERIAL-BATCH-IDENTITY-051-A, Option A) to mirror
  --    the new partial unique index above: distribution_point_id +
  --    scientific_name + COALESCE(concentration,'') + COALESCE(dosage_form,'')
  --    + COALESCE(national_code,'') + COALESCE(batch_number,'') +
  --    COALESCE(expiry_date, DATE '0001-01-01'). supply_type and price are
  --    intentionally NOT part of this match — they remain UI-mediated
  --    metadata (AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-A's panel), not DB
  --    identity, per the Option A design decision. expiry_date is compared
  --    as `date` (not text) per FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A —
  --    must match the index expression exactly for the RPC's INSERT-on-
  --    no-match / UPDATE-on-match branching to agree with what the unique
  --    index will actually accept.
  SELECT ia.id, ia.quantity INTO v_existing_id, v_existing_quantity
  FROM public.item_availability AS ia
  WHERE ia.distribution_point_id = p_distribution_point_id
    AND ia.scientific_name       = p_scientific_name
    AND COALESCE(ia.concentration, '')                 = v_conc
    AND COALESCE(ia.dosage_form,  '')                   = v_dosage
    AND COALESCE(ia.national_code, '')                  = v_national_code_key
    AND COALESCE(ia.batch_number, '')                   = v_batch_number_key
    AND COALESCE(ia.expiry_date, DATE '0001-01-01')     = v_expiry_date_key
    -- WAREHOUSE-W1-DISPATCH-SCHEMA-061-A: the ONLY behavioural change to this
    -- function. The manual/editor path may match manual rows only. A row with a
    -- non-null internal_batch_reference is dispatch-origin provenance and must
    -- never be merged into, overwritten by, or reactivated through the editor.
    AND ia.internal_batch_reference IS NULL;

  IF v_existing_id IS NOT NULL THEN
    -- 4. UPDATE path — requires availability.update (super_admin always allowed).
    IF NOT v_is_super AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.update') THEN
      RAISE EXCEPTION 'forbidden_availability_update' USING ERRCODE = '42501';
    END IF;

    -- 4b. BACKEND-QUANTITY-UPSERT-HARD-GUARD-A (migration 035), preserved
    --     verbatim: quantity can never be changed through this RPC's UPDATE
    --     path.
    IF p_quantity IS DISTINCT FROM v_existing_quantity THEN
      RAISE EXCEPTION 'quantity_update_requires_movement' USING ERRCODE = '23514';
    END IF;

    -- QR-REMOVED-MARKER-053-A: reactivate (clear removed_at/removed_by/
    -- removal_reason) only when this row represents active stock — positive
    -- existing quantity, OR a condition that is not itself a shortage state.
    -- A row still at quantity=0/condition='missing' is left exactly as it
    -- was (may be a genuine, still-open shortage, not a re-add) — its
    -- removed_at is NOT touched by this branch.
    v_reactivates := (v_existing_quantity > 0)
      OR (p_condition IN ('available', 'surplus', 'near_expiry', 'low_stock'));

    -- quantity is intentionally NOT in this SET list (migration 035 guard).
    -- national_code/batch_number/expiry_date are now assigned directly from
    -- their normalized submitted values (v_national_code, v_batch_number,
    -- p_expiry_date), NOT the old COALESCE-preserve trick migration 050 used
    -- for national_code — that trick existed only because national_code was
    -- NOT part of the match key yet. Now that all three are part of the
    -- WHERE clause above, reaching this branch already proves the submitted
    -- and stored values are equal (up to NULL/'' normalization), so a direct
    -- assignment cannot move this row's identity — it can only normalize
    -- incidental whitespace/blank-vs-NULL differences. See the migration
    -- header ("Identity-field UPDATE behavior") for the full reasoning.
    UPDATE public.item_availability AS ia
       SET condition     = p_condition,
           notes         = p_notes,
           supply_type   = p_supply_type,
           price         = p_price,
           trade_name    = p_trade_name,
           national_code = v_national_code,
           batch_number  = v_batch_number,
           expiry_date   = p_expiry_date,
           removed_at     = CASE WHEN v_reactivates THEN NULL ELSE ia.removed_at END,
           removed_by     = CASE WHEN v_reactivates THEN NULL ELSE ia.removed_by END,
           removal_reason = CASE WHEN v_reactivates THEN NULL ELSE ia.removal_reason END
     WHERE ia.id = v_existing_id
    RETURNING ia.id INTO v_id;

    RETURN v_id;
  END IF;

  -- 5. INSERT path — requires availability.create
  IF NOT v_is_super AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.create') THEN
    RAISE EXCEPTION 'forbidden_availability_create' USING ERRCODE = '42501';
  END IF;

  -- 6. INSERT (super_admin, or any role holding availability.create).
  -- removed_at/removed_by/removal_reason are intentionally NOT listed here —
  -- they default to NULL (QR-REMOVED-MARKER-053-A): a brand-new row is never
  -- removed.
  INSERT INTO public.item_availability (
    distribution_point_id,
    organization_id,
    port_name,
    scientific_name,
    trade_name,
    dosage_form,
    concentration,
    quantity,
    condition,
    expiry_date,
    batch_number,
    notes,
    supply_type,
    price,
    national_code
  ) VALUES (
    p_distribution_point_id,
    v_point_org,
    v_port_name,
    p_scientific_name,
    p_trade_name,
    v_dosage,
    v_conc,
    p_quantity,
    p_condition,
    p_expiry_date,
    v_batch_number,
    p_notes,
    p_supply_type,
    p_price,
    v_national_code
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
-- =============================================================================
-- D. Composite unique FK targets (same-organization integrity)
-- =============================================================================
-- A row-level CHECK cannot express a cross-table rule, and a trigger can be
-- bypassed by any SECURITY DEFINER path that forgets to fire it. Composite FKs
-- make "these two columns agree" a guarantee the database itself enforces —
-- the same technique migration 060 used for warehouses (warehouses_id_org_uniq).
--
-- Both constraints are trivially satisfiable: `id` is already the primary key of
-- each table, so (id, organization_id) is unique for every existing row. Neither
-- can fail on existing data.

DO $$ BEGIN
  ALTER TABLE public.distribution_points
    ADD CONSTRAINT distribution_points_id_org_uniq UNIQUE (id, organization_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.warehouse_stock
    ADD CONSTRAINT warehouse_stock_id_org_uniq UNIQUE (id, organization_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- E. warehouse_dispatches — one header per shipment
-- =============================================================================
-- The warehouse is NOT modelled as a distribution point: the header carries a
-- real warehouse_id and a separate destination_distribution_point_id, both
-- pinned to the header's own organization by composite FK. Same-organization
-- dispatch is therefore structural, not a convention.

CREATE TABLE IF NOT EXISTS public.warehouse_dispatches (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  warehouse_id                      uuid NOT NULL,
  destination_distribution_point_id uuid NOT NULL,

  dispatch_number                   text NOT NULL,
  status                            text NOT NULL DEFAULT 'draft',
  document_number                   text,
  default_currency                  text,
  notes                             text,

  created_by                        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_by                           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_at                           timestamptz,
  cancelled_by                      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at                      timestamptz,
  cancellation_reason               text,

  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),

  -- WAREHOUSE-W1-DISPATCH-FK-TARGET-061-FIX-A — READ BEFORE EDITING.
  -- Composite FK TARGET for warehouse_dispatch_lines_dispatch_org_fk (part F).
  -- REQUIRED, not decorative: PostgreSQL demands a UNIQUE or PRIMARY KEY on the
  -- exact referenced column set, and PRIMARY KEY (id) alone does NOT satisfy
  -- (id, organization_id). Without this constraint part F fails with
  --   ERROR 42830: there is no unique constraint matching given keys for
  --                referenced table "warehouse_dispatches"
  -- and the whole migration rolls back. Declared inline here, inside the CREATE
  -- TABLE, so it can never be ordered after the foreign key that needs it —
  -- exactly the guarantee 060 gives with warehouses_id_org_uniq and part D gives
  -- with distribution_points_id_org_uniq / warehouse_stock_id_org_uniq.
  -- Trivially satisfiable: id is already the primary key, so (id, organization_id)
  -- is unique for every row this table can ever hold.
  CONSTRAINT warehouse_dispatches_id_org_uniq UNIQUE (id, organization_id),

  -- RESTRICT on both: a warehouse or outlet with dispatch history cannot be
  -- deleted out from under it. Retention beats convenience here.
  CONSTRAINT warehouse_dispatches_wh_org_fk
    FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT warehouse_dispatches_dest_org_fk
    FOREIGN KEY (destination_distribution_point_id, organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT,

  -- Text + CHECK, never a Postgres enum: every status column in this schema is
  -- text+CHECK, and an enum cannot be altered inside a transaction.
  CONSTRAINT warehouse_dispatches_status_chk
    CHECK (status IN ('draft', 'sent', 'partially_accepted', 'accepted', 'rejected', 'cancelled')),

  CONSTRAINT warehouse_dispatches_number_chk
    CHECK (btrim(dispatch_number) = dispatch_number AND dispatch_number <> ''),
  CONSTRAINT warehouse_dispatches_document_number_chk
    CHECK (document_number IS NULL OR (btrim(document_number) = document_number AND document_number <> '')),
  CONSTRAINT warehouse_dispatches_currency_chk
    CHECK (default_currency IS NULL OR (btrim(default_currency) = default_currency AND default_currency <> '')),

  -- A cancelled dispatch must say when and why; a live one must not carry
  -- cancellation metadata at all.
  CONSTRAINT warehouse_dispatches_cancel_chk
    CHECK (
      CASE WHEN status = 'cancelled'
           THEN cancelled_at IS NOT NULL
                AND cancellation_reason IS NOT NULL
                AND btrim(cancellation_reason) <> ''
           ELSE cancelled_at IS NULL
                AND cancelled_by IS NULL
                AND cancellation_reason IS NULL
      END
    ),

  -- Anything past draft has physically been sent; draft never has.
  CONSTRAINT warehouse_dispatches_sent_at_chk
    CHECK (
      CASE WHEN status IN ('sent', 'partially_accepted', 'accepted', 'rejected')
           THEN sent_at IS NOT NULL
           WHEN status = 'draft'
           THEN sent_at IS NULL AND sent_by IS NULL
           ELSE true
      END
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_dispatches_org_number_uniq
  ON public.warehouse_dispatches (organization_id, btrim(dispatch_number));

CREATE INDEX IF NOT EXISTS warehouse_dispatches_org_idx        ON public.warehouse_dispatches (organization_id);
CREATE INDEX IF NOT EXISTS warehouse_dispatches_warehouse_idx  ON public.warehouse_dispatches (warehouse_id);
CREATE INDEX IF NOT EXISTS warehouse_dispatches_dest_idx       ON public.warehouse_dispatches (destination_distribution_point_id, status);
CREATE INDEX IF NOT EXISTS warehouse_dispatches_status_idx     ON public.warehouse_dispatches (status);

COMMENT ON TABLE public.warehouse_dispatches IS
  'One warehouse-to-outlet dispatch header, always within a single organization '
  '(enforced structurally by composite FKs to warehouses and distribution_points). '
  'Rows are written ONLY by migration 062 SECURITY DEFINER RPCs — no direct '
  'client INSERT/UPDATE/DELETE path, by design. Not public, and deliberately '
  'absent from Deep Clean (055): dispatch history is preserved.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_dispatches
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- F. warehouse_dispatch_lines — one row per material per dispatch
-- =============================================================================
-- Identity/price fields are IMMUTABLE SNAPSHOTS taken at send time, for the same
-- reason item_availability_movements (033) and the exchange domain (040)
-- snapshot theirs: the source row's identity is mutable, and history must stay
-- accurate when it later changes.

CREATE TABLE IF NOT EXISTS public.warehouse_dispatch_lines (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                uuid NOT NULL,
  dispatch_id                    uuid NOT NULL,
  warehouse_stock_id             uuid NOT NULL,
  central_item_id                uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,

  -- Immutable snapshots
  scientific_name                text NOT NULL,
  trade_name                     text,
  concentration                  text,
  dosage_form                    text,
  unit                           text,
  national_code                  text,
  has_no_national_code           boolean NOT NULL DEFAULT false,
  batch_number                   text,
  has_no_batch_number            boolean NOT NULL DEFAULT false,
  internal_batch_reference       text,
  expiry_date                    date,
  unit_price                     numeric(20,3),
  price_basis                    text,
  currency                       text,
  supply_type_text               text,

  -- Quantity + decision
  sent_quantity                  integer NOT NULL,
  received_quantity              integer,
  status                         text NOT NULL DEFAULT 'pending',
  difference_reason              text,
  rejection_reason               text,
  -- Actor references — RETENTION-SOFT, exactly like the result links below.
  -- SET NULL (never RESTRICT): a person who once accepted a line must not become
  -- permanently undeletable. The ID is present and authorized at decision time
  -- (migration 062 enforces that and writes an immutable audit_logs snapshot);
  -- a later auth-user deletion nulls the FK but never the decision itself —
  -- accepted_at/rejected_at and audit history preserve who-and-when.
  -- The decision CHECK below therefore must NOT require these to stay non-null.
  accepted_by                    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at                    timestamptz,
  rejected_by                    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_at                    timestamptz,

  -- Result links — RETENTION-SOFT references. SET NULL is REQUIRED, not
  -- stylistic: migration 055 physically DELETEs item_availability and
  -- item_availability_movements. RESTRICT here would break Deep Clean outright;
  -- CASCADE would destroy dispatch history. SET NULL is the only action that
  -- keeps both working.
  --
  -- Lifecycle: migration 062 populates BOTH links transactionally at acceptance,
  -- in the same transaction that creates the outlet row and its movement — so an
  -- accepted line always starts fully linked. Deep Clean may later null either
  -- one (independently, in separate statements). That loses the pointer, not the
  -- record: status, received_quantity, accepted_at and the line's immutable
  -- snapshots remain, and audit_logs keeps the full actor/context history.
  -- The decision CHECK below therefore must NOT require these to stay non-null.
  resulting_item_availability_id uuid REFERENCES public.item_availability(id) ON DELETE SET NULL,
  resulting_movement_id          uuid REFERENCES public.item_availability_movements(id) ON DELETE SET NULL,

  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),

  -- Lines are intrinsic children of their header: deleting a header (should one
  -- ever be deleted) must not orphan them. This is the ONLY cascade in 060/061.
  CONSTRAINT warehouse_dispatch_lines_dispatch_org_fk
    FOREIGN KEY (dispatch_id, organization_id)
    REFERENCES public.warehouse_dispatches (id, organization_id) ON DELETE CASCADE,

  -- Org agreement with the source stock, structural rather than conventional.
  CONSTRAINT warehouse_dispatch_lines_stock_org_fk
    FOREIGN KEY (warehouse_stock_id, organization_id)
    REFERENCES public.warehouse_stock (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT warehouse_dispatch_lines_status_chk
    CHECK (status IN ('pending', 'accepted', 'accepted_with_difference', 'rejected', 'cancelled')),

  CONSTRAINT warehouse_dispatch_lines_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT warehouse_dispatch_lines_sent_qty_chk
    CHECK (sent_quantity > 0),
  CONSTRAINT warehouse_dispatch_lines_received_qty_chk
    CHECK (received_quantity IS NULL OR received_quantity >= 0),
  CONSTRAINT warehouse_dispatch_lines_unit_price_chk
    CHECK (unit_price IS NULL OR unit_price >= 0),

  -- The has_no_* flags must EXACTLY correspond to their fields being NULL —
  -- they can never contradict the data they describe.
  CONSTRAINT warehouse_dispatch_lines_has_no_national_code_chk
    CHECK (has_no_national_code = (national_code IS NULL)),
  CONSTRAINT warehouse_dispatch_lines_has_no_batch_number_chk
    CHECK (has_no_batch_number = (batch_number IS NULL)),

  -- Option C: an internal reference exists exactly when there is no real batch.
  CONSTRAINT warehouse_dispatch_lines_internal_ref_rule_chk
    CHECK (
      CASE WHEN has_no_batch_number
           THEN internal_batch_reference IS NOT NULL
                AND btrim(internal_batch_reference) = internal_batch_reference
                AND internal_batch_reference <> ''
           ELSE internal_batch_reference IS NULL
      END
    ),

  -- Absence must be NULL + the flag, never a literal. Enforced, not documented.
  CONSTRAINT warehouse_dispatch_lines_no_placeholder_chk
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

  -- ---------------------------------------------------------------------------
  -- The decision state machine, expressed as data.
  -- ---------------------------------------------------------------------------
  -- WAREHOUSE-W1-DISPATCH-SCHEMA-061-RETENTION-FIX-A — READ BEFORE EDITING.
  --
  -- This CHECK describes the DURABLE state of a line, i.e. what must still hold
  -- AFTER the retention actions this schema deliberately allows. It is NOT the
  -- transition-time contract; migration 062's RPCs own that (see below).
  --
  -- The governing rule: a CHECK may never require a nullable FK column to stay
  -- non-null, because every FK here is ON DELETE SET NULL BY DESIGN, and SET NULL
  -- only ever makes a column MORE null. An earlier draft of this constraint
  -- required accepted_by / rejected_by / resulting_item_availability_id /
  -- resulting_movement_id to be NOT NULL on terminal rows. That produced two
  -- real, fail-shut contradictions:
  --
  --   A. Deleting an auth user fires SET NULL on accepted_by/rejected_by, which
  --      would violate the CHECK — making any user who ever accepted a line
  --      permanently UNDELETABLE.
  --   B. Migration 055 (Deep Clean) physically DELETEs item_availability and
  --      item_availability_movements. Each delete fires SET NULL on the result
  --      links, which would violate the CHECK — Deep Clean would ABORT, and stay
  --      broken forever once a single line had been accepted.
  --
  -- Both are fixed by requiring only what cannot be nulled from underneath us:
  --   • received_quantity, accepted_at, rejected_at, difference_reason and
  --     rejection_reason are plain columns — no FK, nothing ever nulls them, so
  --     they remain REQUIRED and carry the immutable business record.
  --   • accepted_by / rejected_by / result links are retention-soft references:
  --     present at decision time, possibly nulled later by a legitimate deletion.
  --
  -- Note the asymmetry that makes this safe: `IS NULL` requirements are always
  -- SET NULL-safe (they can only become MORE true), so pending/rejected/cancelled
  -- keep their full "must carry no result/decision" rules unchanged. Only the
  -- four `IS NOT NULL` requirements on nullable FK columns were removed.
  --
  -- What still guarantees correctness at acceptance time (migration 062):
  --   • the actor is authenticated and authorized when the decision is made;
  --   • the outlet row and its movement are created BEFORE the line becomes
  --     terminal, and the result links are populated in the SAME transaction;
  --   • audit_logs records an immutable actor/context snapshot that survives
  --     both auth-user deletion and Deep Clean;
  --   • the line's own immutable snapshots + accepted_at/received_quantity
  --     remain the durable business record regardless of what is later deleted.
  --
  -- Deliberately NOT added: a paired-null constraint on the two result links.
  -- Migration 055 deletes item_availability_movements and item_availability in
  -- SEPARATE statements, so inside that transaction one link is legitimately
  -- nulled before the other — a paired rule would abort Deep Clean exactly like
  -- the bug above.
  CONSTRAINT warehouse_dispatch_lines_decision_chk
    CHECK (
      CASE status
        WHEN 'pending' THEN
          received_quantity IS NULL
          AND accepted_by IS NULL AND accepted_at IS NULL
          AND rejected_by IS NULL AND rejected_at IS NULL
          AND difference_reason IS NULL AND rejection_reason IS NULL
          AND resulting_item_availability_id IS NULL
          AND resulting_movement_id IS NULL
        WHEN 'accepted' THEN
          received_quantity = sent_quantity
          AND accepted_at IS NOT NULL
          AND difference_reason IS NULL
          AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
        WHEN 'accepted_with_difference' THEN
          received_quantity IS NOT NULL
          AND received_quantity > 0
          AND received_quantity <> sent_quantity
          AND difference_reason IS NOT NULL AND btrim(difference_reason) <> ''
          AND accepted_at IS NOT NULL
          AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
        WHEN 'rejected' THEN
          received_quantity IS NULL
          AND rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''
          AND rejected_at IS NOT NULL
          AND accepted_by IS NULL AND accepted_at IS NULL AND difference_reason IS NULL
          AND resulting_item_availability_id IS NULL
          AND resulting_movement_id IS NULL
        WHEN 'cancelled' THEN
          received_quantity IS NULL
          AND accepted_by IS NULL AND accepted_at IS NULL
          AND rejected_by IS NULL AND rejected_at IS NULL
          AND resulting_item_availability_id IS NULL
          AND resulting_movement_id IS NULL
        ELSE false
      END
    )
);

CREATE INDEX IF NOT EXISTS warehouse_dispatch_lines_dispatch_idx ON public.warehouse_dispatch_lines (dispatch_id);
CREATE INDEX IF NOT EXISTS warehouse_dispatch_lines_org_idx      ON public.warehouse_dispatch_lines (organization_id);
CREATE INDEX IF NOT EXISTS warehouse_dispatch_lines_stock_idx    ON public.warehouse_dispatch_lines (warehouse_stock_id);
CREATE INDEX IF NOT EXISTS warehouse_dispatch_lines_status_idx   ON public.warehouse_dispatch_lines (status);

COMMENT ON TABLE public.warehouse_dispatch_lines IS
  'One material line per dispatch, with immutable identity/price snapshots taken '
  'at send time. Acceptance is line-level and partial acceptance is supported. '
  'Result links use ON DELETE SET NULL so Deep Clean (055) can physically delete '
  'outlet availability/movements without destroying dispatch history. Rows are '
  'written ONLY by migration 062 SECURITY DEFINER RPCs.';

COMMENT ON COLUMN public.warehouse_dispatch_lines.internal_batch_reference IS
  'PRIVATE. Set only when has_no_batch_number = true, and carried onto the '
  'resulting outlet row at acceptance so independently accepted no-batch lines '
  'stay distinct. Never public.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_dispatch_lines
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- G. item_availability_movements.dispatch_line_id — acceptance idempotency
-- =============================================================================
-- Migration 060 deliberately deferred this until the dispatch tables existed.
-- Additive and nullable: every existing movement row keeps NULL.
--
-- The partial unique index is what turns "one acceptance produces at most one
-- outlet movement" from an RPC convention into a DATABASE guarantee — the
-- idempotency gap the W1 audit identified. movement_type is NOT changed:
-- acceptance uses the existing 'add' type.

ALTER TABLE public.item_availability_movements
  ADD COLUMN IF NOT EXISTS dispatch_line_id uuid;

DO $$ BEGIN
  ALTER TABLE public.item_availability_movements
    ADD CONSTRAINT item_availability_movements_dispatch_line_fk
    FOREIGN KEY (dispatch_line_id)
    REFERENCES public.warehouse_dispatch_lines(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS item_availability_movements_dispatch_line_uniq
  ON public.item_availability_movements (dispatch_line_id)
  WHERE dispatch_line_id IS NOT NULL;

COMMENT ON COLUMN public.item_availability_movements.dispatch_line_id IS
  'PRIVATE. NULL for every manually-created movement. Set only by dispatch '
  'acceptance; the partial unique index guarantees one dispatch line can produce '
  'at most one outlet movement, making acceptance idempotent at the database '
  'level. Never exposed publicly.';

-- =============================================================================
-- H. Permission keys + role defaults (separation of duty)
-- =============================================================================
-- Uses the exact permission_keys contract from migration 010:
--   (key, module, action, label_en, label_ar, is_dangerous)
-- Idempotent via ON CONFLICT DO NOTHING, matching every existing permission
-- migration. These keys are the ONLY authorization basis migration 062's write
-- RPCs may use — never a role literal.

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('warehouse_dispatch.view','warehouse_dispatch','view','View dispatches','عرض التجهيزات',false),
  ('warehouse_dispatch.create','warehouse_dispatch','create','Create dispatch','إنشاء تجهيز',false),
  ('warehouse_dispatch.edit_draft','warehouse_dispatch','edit_draft','Edit draft dispatch','تعديل مسودة التجهيز',false),
  ('warehouse_dispatch.send','warehouse_dispatch','send','Send dispatch','إرسال التجهيز',true),
  ('warehouse_dispatch.cancel','warehouse_dispatch','cancel','Cancel dispatch','إلغاء التجهيز',true),
  ('warehouse_dispatch.accept','warehouse_dispatch','accept','Accept dispatch lines','استلام مواد التجهيز',true),
  ('warehouse_dispatch.reject','warehouse_dispatch','reject','Reject dispatch lines','رفض مواد التجهيز',true),
  ('warehouse_dispatch.audit','warehouse_dispatch','audit','View dispatch audit','عرض سجل التجهيز',false)
ON CONFLICT (key) DO NOTHING;

-- SEPARATION OF DUTY — the load-bearing rule of this whole domain:
--   • warehouse_officer sends but must NEVER accept or reject. If it could, a
--     sender could self-accept and stock would enter an outlet with nobody at
--     the outlet ever confirming receipt — which is precisely the silent
--     stock-injection this design exists to prevent.
--   • port_officer accepts/rejects but must NEVER create, edit, send or cancel.
--   • institution_admin holds all eight, as the oversight role.
--   • viewer is read-only (view + audit).
--   • anon gets nothing — it holds no permission row at all.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  -- warehouse_officer: the sending side. NO accept, NO reject.
  ('warehouse_officer','warehouse_dispatch.view',true),
  ('warehouse_officer','warehouse_dispatch.create',true),
  ('warehouse_officer','warehouse_dispatch.edit_draft',true),
  ('warehouse_officer','warehouse_dispatch.send',true),
  ('warehouse_officer','warehouse_dispatch.cancel',true),
  ('warehouse_officer','warehouse_dispatch.audit',true),

  -- port_officer: the receiving side. NO create/edit_draft/send/cancel.
  ('port_officer','warehouse_dispatch.view',true),
  ('port_officer','warehouse_dispatch.accept',true),
  ('port_officer','warehouse_dispatch.reject',true),
  ('port_officer','warehouse_dispatch.audit',true),

  -- institution_admin: oversight, both sides.
  ('institution_admin','warehouse_dispatch.view',true),
  ('institution_admin','warehouse_dispatch.create',true),
  ('institution_admin','warehouse_dispatch.edit_draft',true),
  ('institution_admin','warehouse_dispatch.send',true),
  ('institution_admin','warehouse_dispatch.cancel',true),
  ('institution_admin','warehouse_dispatch.accept',true),
  ('institution_admin','warehouse_dispatch.reject',true),
  ('institution_admin','warehouse_dispatch.audit',true),

  -- viewer: read-only.
  ('viewer','warehouse_dispatch.view',true),
  ('viewer','warehouse_dispatch.audit',true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- super_admin: repository convention (migration 010) seeds it from every key,
-- so the new keys are added the same way rather than hard-coded. This preserves
-- its existing global behavior without weakening it.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
  SELECT 'super_admin', key, true FROM public.permission_keys
ON CONFLICT (role, permission_key) DO NOTHING;

-- =============================================================================
-- I. RLS + grants for the dispatch tables
-- =============================================================================
-- Read-only for authenticated holders of warehouse_dispatch.view within their
-- own organization. No write policy and no write grant: writes arrive in
-- migration 062 through SECURITY DEFINER RPCs, exactly as warehouse_stock (060)
-- and item_availability_movements (033) do. anon gets nothing, anywhere.
--
-- Outlet-level narrowing (a port_officer seeing only its own destination) is
-- deliberately NOT attempted here: no assigned-distribution-point model exists
-- in this schema (see migration 033's own note), so org-scope is the honest
-- boundary today and migration 062's RPCs own the finer restriction. This
-- policy never broadens visibility beyond the caller's organization.

ALTER TABLE public.warehouse_dispatches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_dispatch_lines  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "warehouse_dispatches_select_perm"      ON public.warehouse_dispatches;
DROP POLICY IF EXISTS "warehouse_dispatch_lines_select_perm"  ON public.warehouse_dispatch_lines;

CREATE POLICY "warehouse_dispatches_select_perm" ON public.warehouse_dispatches
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
    )
  );

CREATE POLICY "warehouse_dispatch_lines_select_perm" ON public.warehouse_dispatch_lines
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
    )
  );

-- No INSERT/UPDATE/DELETE policy on either table, by design.

REVOKE ALL ON TABLE public.warehouse_dispatches      FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.warehouse_dispatch_lines  FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.warehouse_dispatches      TO authenticated;
GRANT SELECT ON TABLE public.warehouse_dispatch_lines  TO authenticated;
-- Explicitly documented as absent (idempotent no-op if never granted):
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_dispatches      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_dispatch_lines  FROM authenticated;

-- =============================================================================
-- J. VERIFY — runs INSIDE this transaction; any failure rolls everything back
-- =============================================================================
DO $$
DECLARE
  v_cnt      int;
  v_idxdef   text;
  v_txt      text;
  v_fn_src   text;
  v_item     text;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 1. Outlet internal_batch_reference
  -- ---------------------------------------------------------------------------
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_availability'
      AND column_name = 'internal_batch_reference'
      AND data_type = 'text' AND is_nullable = 'YES'
  ), 'VERIFY FAILED (061): item_availability.internal_batch_reference missing or not nullable text';

  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_availability_internal_ref_chk'),
    'VERIFY FAILED (061): item_availability_internal_ref_chk missing';

  -- Every pre-existing row must still be valid, i.e. untouched at NULL.
  SELECT count(*) INTO v_cnt FROM public.item_availability WHERE internal_batch_reference IS NOT NULL;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (061): ' || v_cnt || ' existing item_availability row(s) already carry an '
    'internal_batch_reference — this migration must not populate any row';

  -- ---------------------------------------------------------------------------
  -- 2. Outlet identity replacement
  -- ---------------------------------------------------------------------------
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'item_availability_dp_sci_conc_form_nat_batch_exp_uniq'
  ), 'VERIFY FAILED (061): migration 051 7-field index still present — it conflicts with the 8-field identity';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq'
  ), 'VERIFY FAILED (061): 8-field outlet identity index missing';

  SELECT indexdef INTO v_idxdef FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq';
  ASSERT v_idxdef ILIKE '%UNIQUE%', 'VERIFY FAILED (061): outlet identity index is not UNIQUE';
  ASSERT v_idxdef ILIKE '%internal_batch_reference%',
    'VERIFY FAILED (061): outlet identity index missing internal_batch_reference (8th component)';
  ASSERT v_idxdef ILIKE '%0001-01-01%',
    'VERIFY FAILED (061): outlet identity index must use the immutable DATE ''0001-01-01'' sentinel';
  ASSERT v_idxdef NOT ILIKE '%expiry_date::text%' AND v_idxdef NOT ILIKE '%text(expiry_date)%',
    'VERIFY FAILED (061): outlet identity index must not cast expiry_date to text (not IMMUTABLE, ERROR 42P17)';
  ASSERT v_idxdef ILIKE '%scientific_name IS NOT NULL%',
    'VERIFY FAILED (061): outlet identity index lost migration 051''s partial predicate';

  -- The legacy 001 constraint stays exactly as 043/051 left it.
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'item_availability_local_item_id_distribution_point_id_key'
  ), 'VERIFY FAILED (061): legacy local_item/dp constraint was removed — 061 must not touch it';

  -- ---------------------------------------------------------------------------
  -- 3. phoenix_upsert_availability: signature unchanged, manual path constrained
  -- ---------------------------------------------------------------------------
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_txt
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_upsert_availability';
  ASSERT v_txt = 'p_distribution_point_id uuid, p_scientific_name text, p_trade_name text, '
                 'p_dosage_form text, p_concentration text, p_quantity integer, p_condition text, '
                 'p_expiry_date date, p_batch_number text, p_notes text, p_supply_type text, '
                 'p_price numeric, p_national_code text',
    'VERIFY FAILED (061): phoenix_upsert_availability signature changed — found: ' || COALESCE(v_txt, '<null>');

  SELECT prosrc INTO v_fn_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_upsert_availability';

  ASSERT v_fn_src ILIKE '%ia.internal_batch_reference IS NULL%',
    'VERIFY FAILED (061): phoenix_upsert_availability does not restrict manual matching to '
    'internal_batch_reference IS NULL — the editor could merge into dispatch-origin rows';

  -- The INSERT path must not set the column (manual rows stay NULL).
  ASSERT v_fn_src NOT ILIKE '%internal_batch_reference,%',
    'VERIFY FAILED (061): phoenix_upsert_availability INSERT list must not include internal_batch_reference';

  -- Preserved 053/051/035 behaviour.
  ASSERT v_fn_src ILIKE '%quantity_update_requires_movement%',
    'VERIFY FAILED (061): migration 035 quantity guard lost from phoenix_upsert_availability';
  ASSERT v_fn_src ILIKE '%availability.create%' AND v_fn_src ILIKE '%availability.update%',
    'VERIFY FAILED (061): availability permission gates lost from phoenix_upsert_availability';
  ASSERT v_fn_src ILIKE '%forbidden_cross_org%',
    'VERIFY FAILED (061): cross-org authorization lost from phoenix_upsert_availability';

  SELECT p.prosecdef::text INTO v_txt FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_upsert_availability';
  ASSERT v_txt = 'true', 'VERIFY FAILED (061): phoenix_upsert_availability lost SECURITY DEFINER';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_upsert_availability'
      AND p.proconfig @> array['search_path=public']
  ), 'VERIFY FAILED (061): phoenix_upsert_availability lost SET search_path = public';

  -- ---------------------------------------------------------------------------
  -- 4. Composite FK targets
  -- ---------------------------------------------------------------------------
  FOREACH v_item IN ARRAY ARRAY[
    'distribution_points_id_org_uniq', 'warehouse_stock_id_org_uniq',
    'warehouse_dispatches_id_org_uniq'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_item),
      'VERIFY FAILED (061): composite FK target missing: ' || v_item;
  END LOOP;

  -- WAREHOUSE-W1-DISPATCH-FK-TARGET-061-FIX-A: prove the target this migration's
  -- own part F depends on PRECISELY — schema, owning relation, constraint type,
  -- validation state and exact definition — so a same-named constraint on another
  -- table can never satisfy it. The name-only loop above cannot distinguish that.
  ASSERT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'warehouse_dispatches'
      AND c.conname = 'warehouse_dispatches_id_org_uniq'
      AND c.contype = 'u'
      AND c.convalidated
      AND pg_get_constraintdef(c.oid) = 'UNIQUE (id, organization_id)'
  ), 'VERIFY FAILED (061): warehouse_dispatches_id_org_uniq must exist on '
     'public.warehouse_dispatches as a VALIDATED UNIQUE (id, organization_id). '
     'Without it warehouse_dispatch_lines_dispatch_org_fk cannot be created '
     '(ERROR 42830: no unique constraint matching given keys).';

  -- ...and the FK that needs it must reference exactly those columns, in order.
  -- Column sets are compared structurally through conkey/confkey rather than by
  -- string-matching pg_get_constraintdef, so deparser formatting can never fail
  -- this assertion and roll back a healthy migration.
  ASSERT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_class rt    ON rt.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname  = 'warehouse_dispatch_lines'
      AND rt.relname = 'warehouse_dispatches'
      AND c.conname  = 'warehouse_dispatch_lines_dispatch_org_fk'
      AND c.contype  = 'f'
      AND (SELECT array_agg(a.attname ORDER BY x.ord)
             FROM unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum)
          = ARRAY['dispatch_id','organization_id']::name[]
      AND (SELECT array_agg(a.attname ORDER BY x.ord)
             FROM unnest(c.confkey) WITH ORDINALITY AS x(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = x.attnum)
          = ARRAY['id','organization_id']::name[]
  ), 'VERIFY FAILED (061): warehouse_dispatch_lines_dispatch_org_fk must be '
     'FOREIGN KEY (dispatch_id, organization_id) REFERENCES '
     'warehouse_dispatches (id, organization_id) — same-organization dispatch '
     'integrity must stay structural, never a single-column dispatch_id FK.';

  -- ---------------------------------------------------------------------------
  -- 5. Dispatch tables
  -- ---------------------------------------------------------------------------
  FOREACH v_item IN ARRAY ARRAY['warehouse_dispatches', 'warehouse_dispatch_lines'] LOOP
    ASSERT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = v_item),
      'VERIFY FAILED (061): table missing: ' || v_item;

    ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_item)::regclass),
      'VERIFY FAILED (061): RLS not enabled on ' || v_item;

    ASSERT NOT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_item AND grantee = 'anon'
    ), 'VERIFY FAILED (061): anon holds a privilege on ' || v_item;

    ASSERT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_item
        AND grantee = 'authenticated' AND privilege_type = 'SELECT'
    ), 'VERIFY FAILED (061): authenticated lost SELECT on ' || v_item;

    ASSERT NOT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = v_item
        AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
    ), 'VERIFY FAILED (061): authenticated holds a write grant on ' || v_item;

    ASSERT NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_item
        AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
    ), 'VERIFY FAILED (061): a direct write policy exists on ' || v_item;
  END LOOP;

  -- Header statuses, exactly the six reviewed values.
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint
  WHERE conname = 'warehouse_dispatches_status_chk';
  FOREACH v_item IN ARRAY ARRAY['draft','sent','partially_accepted','accepted','rejected','cancelled'] LOOP
    ASSERT v_txt LIKE '%' || v_item || '%',
      'VERIFY FAILED (061): header status CHECK missing value: ' || v_item;
  END LOOP;

  -- Line statuses, exactly the five reviewed values.
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint
  WHERE conname = 'warehouse_dispatch_lines_status_chk';
  FOREACH v_item IN ARRAY ARRAY['pending','accepted','accepted_with_difference','rejected','cancelled'] LOOP
    ASSERT v_txt LIKE '%' || v_item || '%',
      'VERIFY FAILED (061): line status CHECK missing value: ' || v_item;
  END LOOP;

  FOREACH v_item IN ARRAY ARRAY[
    'warehouse_dispatches_wh_org_fk','warehouse_dispatches_dest_org_fk',
    'warehouse_dispatches_cancel_chk','warehouse_dispatches_sent_at_chk',
    'warehouse_dispatches_number_chk',
    'warehouse_dispatch_lines_dispatch_org_fk','warehouse_dispatch_lines_stock_org_fk',
    'warehouse_dispatch_lines_decision_chk','warehouse_dispatch_lines_sent_qty_chk',
    'warehouse_dispatch_lines_has_no_national_code_chk','warehouse_dispatch_lines_has_no_batch_number_chk',
    'warehouse_dispatch_lines_internal_ref_rule_chk','warehouse_dispatch_lines_no_placeholder_chk'
  ] LOOP
    ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_item),
      'VERIFY FAILED (061): dispatch constraint missing: ' || v_item;
  END LOOP;

  ASSERT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'warehouse_dispatches_org_number_uniq'),
    'VERIFY FAILED (061): dispatch_number is not unique per organization';

  -- Result links MUST be SET NULL (Deep Clean compatibility) and the stock link
  -- MUST be RESTRICT (a dispatched stock row cannot vanish under its history).
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'warehouse_dispatch_lines' AND c.contype = 'f' AND c.confdeltype = 'n'
      AND c.confrelid = 'public.item_availability'::regclass
  ), 'VERIFY FAILED (061): resulting_item_availability_id must be ON DELETE SET NULL';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'warehouse_dispatch_lines' AND c.contype = 'f' AND c.confdeltype = 'n'
      AND c.confrelid = 'public.item_availability_movements'::regclass
  ), 'VERIFY FAILED (061): resulting_movement_id must be ON DELETE SET NULL';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'warehouse_dispatch_lines' AND c.contype = 'f' AND c.confdeltype = 'r'
      AND c.confrelid = 'public.warehouse_stock'::regclass
  ), 'VERIFY FAILED (061): warehouse_stock_id must be ON DELETE RESTRICT';

  -- Both actor FKs must be SET NULL: a user who accepted a line must stay deletable.
  SELECT count(*) INTO v_cnt
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'warehouse_dispatch_lines' AND c.contype = 'f'
    AND c.confrelid = 'auth.users'::regclass AND c.confdeltype = 'n';
  ASSERT v_cnt = 2,
    'VERIFY FAILED (061): both accepted_by and rejected_by must be ON DELETE SET NULL, found ' || v_cnt;

  -- ---------------------------------------------------------------------------
  -- 5b. RETENTION SAFETY (WAREHOUSE-W1-DISPATCH-SCHEMA-061-RETENTION-FIX-A)
  -- ---------------------------------------------------------------------------
  -- The decision CHECK must describe DURABLE state. It may never require a
  -- nullable FK column to stay non-null, because every FK here is SET NULL by
  -- design and SET NULL only makes a column MORE null. Two concrete failures
  -- this prevents: deleting an auth user (would make an accepter undeletable),
  -- and migration 055 Deep Clean nulling the result links (would abort 055).
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint
  WHERE conname = 'warehouse_dispatch_lines_decision_chk';
  ASSERT v_txt IS NOT NULL, 'VERIFY FAILED (061): decision CHECK missing';

  ASSERT v_txt NOT LIKE '%accepted_by IS NOT NULL%',
    'VERIFY FAILED (061): decision CHECK requires accepted_by IS NOT NULL — deleting that auth '
    'user would fire SET NULL and violate this CHECK, making the user undeletable';
  ASSERT v_txt NOT LIKE '%rejected_by IS NOT NULL%',
    'VERIFY FAILED (061): decision CHECK requires rejected_by IS NOT NULL — same auth-user '
    'deletion deadlock';
  ASSERT v_txt NOT LIKE '%resulting_item_availability_id IS NOT NULL%',
    'VERIFY FAILED (061): decision CHECK requires resulting_item_availability_id IS NOT NULL — '
    'migration 055 Deep Clean deletes item_availability, fires SET NULL, and would abort';
  ASSERT v_txt NOT LIKE '%resulting_movement_id IS NOT NULL%',
    'VERIFY FAILED (061): decision CHECK requires resulting_movement_id IS NOT NULL — '
    'migration 055 Deep Clean deletes item_availability_movements, fires SET NULL, and would abort';

  -- What the durable contract DOES still require — none of these are FK columns,
  -- so nothing can null them from underneath the row.
  ASSERT v_txt LIKE '%accepted_at IS NOT NULL%',
    'VERIFY FAILED (061): accepted/accepted_with_difference must still require accepted_at';
  ASSERT v_txt LIKE '%rejected_at IS NOT NULL%',
    'VERIFY FAILED (061): rejected must still require rejected_at';
  ASSERT v_txt LIKE '%received_quantity = sent_quantity%',
    'VERIFY FAILED (061): accepted must still require received_quantity = sent_quantity';
  ASSERT v_txt LIKE '%received_quantity <> sent_quantity%',
    'VERIFY FAILED (061): accepted_with_difference must still require a differing quantity';
  ASSERT v_txt LIKE '%difference_reason%' AND v_txt LIKE '%rejection_reason%',
    'VERIFY FAILED (061): terminal reasons must still be required';

  -- Non-terminal / non-accepting states must still carry no result links.
  -- (IS NULL requirements are SET NULL-safe, so these stay in force.)
  ASSERT v_txt LIKE '%resulting_item_availability_id IS NULL%'
     AND v_txt LIKE '%resulting_movement_id IS NULL%',
    'VERIFY FAILED (061): pending/rejected/cancelled must still be forbidden from carrying result links';

  -- No paired-null rule: 055 deletes movements and availability in separate
  -- statements, so one link is legitimately nulled before the other.
  ASSERT v_txt NOT LIKE '%resulting_item_availability_id IS NULL) = (%',
    'VERIFY FAILED (061): a paired-null rule on the result links would abort Deep Clean mid-transaction';

  -- ---------------------------------------------------------------------------
  -- 6. Movement idempotency link
  -- ---------------------------------------------------------------------------
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_availability_movements'
      AND column_name = 'dispatch_line_id' AND is_nullable = 'YES'
  ), 'VERIFY FAILED (061): item_availability_movements.dispatch_line_id missing or not nullable';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'item_availability_movements' AND c.contype = 'f' AND c.confdeltype = 'n'
      AND c.confrelid = 'public.warehouse_dispatch_lines'::regclass
  ), 'VERIFY FAILED (061): movements.dispatch_line_id must be ON DELETE SET NULL';

  SELECT indexdef INTO v_idxdef FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'item_availability_movements_dispatch_line_uniq';
  ASSERT v_idxdef IS NOT NULL, 'VERIFY FAILED (061): movement dispatch-line unique index missing';
  ASSERT v_idxdef ILIKE '%UNIQUE%' AND v_idxdef ILIKE '%dispatch_line_id IS NOT NULL%',
    'VERIFY FAILED (061): movement dispatch-line index must be a PARTIAL UNIQUE on non-null dispatch_line_id';

  -- movement_type must be untouched: acceptance uses the existing 'add'.
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint
  WHERE conname = 'item_availability_movements_type_chk';
  ASSERT v_txt LIKE '%set_exact%' AND v_txt LIKE '%add%' AND v_txt LIKE '%subtract%' AND v_txt LIKE '%correction%',
    'VERIFY FAILED (061): item_availability_movements movement_type CHECK was altered';
  ASSERT v_txt NOT LIKE '%dispatch_send%' AND v_txt NOT LIKE '%dispatch_return%',
    'VERIFY FAILED (061): outlet movement_type CHECK must not gain warehouse-only movement types';

  SELECT count(*) INTO v_cnt FROM public.item_availability_movements WHERE dispatch_line_id IS NOT NULL;
  ASSERT v_cnt = 0,
    'VERIFY FAILED (061): ' || v_cnt || ' existing movement row(s) already carry a dispatch_line_id';

  -- ---------------------------------------------------------------------------
  -- 7. Permission keys + separation of duty
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt FROM public.permission_keys WHERE key LIKE 'warehouse_dispatch.%';
  ASSERT v_cnt = 8, 'VERIFY FAILED (061): expected exactly 8 warehouse_dispatch.* keys, found ' || v_cnt;

  FOREACH v_item IN ARRAY ARRAY['view','create','edit_draft','send','cancel','accept','reject','audit'] LOOP
    ASSERT EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'warehouse_dispatch.' || v_item),
      'VERIFY FAILED (061): permission key missing: warehouse_dispatch.' || v_item;
  END LOOP;

  -- THE separation-of-duty rule: the sender must never be able to self-accept.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.role_permission_defaults
    WHERE role = 'warehouse_officer'
      AND permission_key IN ('warehouse_dispatch.accept','warehouse_dispatch.reject')
      AND allowed = true
  ), 'VERIFY FAILED (061): warehouse_officer must NEVER hold accept/reject — a sender could self-accept';

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.role_permission_defaults
    WHERE role = 'port_officer'
      AND permission_key IN ('warehouse_dispatch.create','warehouse_dispatch.edit_draft',
                             'warehouse_dispatch.send','warehouse_dispatch.cancel')
      AND allowed = true
  ), 'VERIFY FAILED (061): port_officer must not hold create/edit_draft/send/cancel';

  SELECT count(*) INTO v_cnt FROM public.role_permission_defaults
  WHERE role = 'warehouse_officer' AND permission_key LIKE 'warehouse_dispatch.%' AND allowed = true;
  ASSERT v_cnt = 6, 'VERIFY FAILED (061): warehouse_officer must hold exactly 6 dispatch keys, found ' || v_cnt;

  SELECT count(*) INTO v_cnt FROM public.role_permission_defaults
  WHERE role = 'port_officer' AND permission_key LIKE 'warehouse_dispatch.%' AND allowed = true;
  ASSERT v_cnt = 4, 'VERIFY FAILED (061): port_officer must hold exactly 4 dispatch keys, found ' || v_cnt;

  SELECT count(*) INTO v_cnt FROM public.role_permission_defaults
  WHERE role = 'institution_admin' AND permission_key LIKE 'warehouse_dispatch.%' AND allowed = true;
  ASSERT v_cnt = 8, 'VERIFY FAILED (061): institution_admin must hold all 8 dispatch keys, found ' || v_cnt;

  SELECT count(*) INTO v_cnt FROM public.role_permission_defaults
  WHERE role = 'viewer' AND permission_key LIKE 'warehouse_dispatch.%' AND allowed = true;
  ASSERT v_cnt = 2, 'VERIFY FAILED (061): viewer must hold exactly view+audit, found ' || v_cnt;

  -- The pre-existing warehouse keys (010) must still be there.
  ASSERT (SELECT count(*) FROM public.permission_keys WHERE key IN ('warehouses.view','warehouses.manage')) = 2,
    'VERIFY FAILED (061): warehouses.view/manage keys missing';

  -- ---------------------------------------------------------------------------
  -- 8. Isolation: public QR, Deep Clean, exchange domain, 060 foundation
  -- ---------------------------------------------------------------------------
  SELECT prosrc INTO v_fn_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_public_qr_payload';
  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED (061): get_public_qr_payload is missing — 061 must not touch it';
  ASSERT v_fn_src NOT ILIKE '%internal_batch_reference%'
     AND v_fn_src NOT ILIKE '%dispatch%'
     AND v_fn_src NOT ILIKE '%warehouse_stock%',
    'VERIFY FAILED (061): public QR payload leaked an internal/dispatch field';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_clean_availability_data'
  ), 'VERIFY FAILED (061): phoenix_clean_availability_data missing — 061 must not touch migration 055';

  SELECT prosrc INTO v_fn_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_clean_availability_data';
  ASSERT v_fn_src NOT ILIKE '%warehouse_dispatch%',
    'VERIFY FAILED (061): Deep Clean must not delete dispatch history';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inter_org_exchange_requests_orgs_distinct_chk'
  ), 'VERIFY FAILED (061): exchange orgs-distinct constraint missing — the exchange domain must be untouched';

  -- Migration 060's foundation must still be intact.
  FOREACH v_item IN ARRAY ARRAY['warehouse_stock', 'warehouse_stock_movements'] LOOP
    ASSERT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = v_item),
      'VERIFY FAILED (061): migration 060 table missing: ' || v_item;
  END LOOP;

  ASSERT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'warehouses_one_active_main_per_org_uniq'),
    'VERIFY FAILED (061): migration 060 main-warehouse index missing';

  RAISE NOTICE 'Migration 061 verification passed: item_availability.internal_batch_reference added (nullable, private, no row populated); migration 051''s 7-field outlet index replaced by the 8-field provenance identity using the immutable DATE ''0001-01-01'' sentinel and 051''s partial predicate; phoenix_upsert_availability signature/SECURITY DEFINER/search_path/authorization/quantity-guard all preserved with the manual path restricted to internal_batch_reference IS NULL; warehouse_dispatches + warehouse_dispatch_lines created with same-organization composite FKs, exact header/line statuses, and a full decision state machine; result links and actor references are retention-soft SET NULL (an accepter stays deletable and Deep Clean cannot be aborted by them) while accepted_at/rejected_at/received_quantity/reasons remain the durable required record; warehouse stock RESTRICT; item_availability_movements.dispatch_line_id added with a partial unique index guaranteeing at most one outlet movement per accepted line, movement_type untouched; 8 permission keys seeded with separation of duty (warehouse_officer cannot accept/reject, port_officer cannot send/cancel); RLS enabled on both dispatch tables with read-only authenticated access, zero anon privileges and no write policy or grant; public QR, Deep Clean, the exchange domain and the 060 foundation all untouched; no dispatch RPC created (062 scope).';
END $$;

commit;
