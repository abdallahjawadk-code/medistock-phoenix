-- ============================================================================
-- 051_material_batch_identity_option_a.sql
-- MediStock Phoenix V2
--
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Review then apply manually in Supabase Dashboard → SQL Editor.
--
-- Task: DB-MATERIAL-BATCH-IDENTITY-051-A
--
-- Prerequisites:
--   Migrations 001-050 must already be applied. Migrations 049
--   (item_availability.national_code, nullable, backfilled from
--   batch_number) and 050 (phoenix_upsert_availability accepts
--   p_national_code text DEFAULT NULL) are REQUIRED — already applied
--   manually by the owner. Migration 048 does NOT need to be applied first
--   or reconsidered as part of this migration — it is independent and
--   remains a separate, later re-review item (see "What this migration does
--   NOT do" below).
--
-- Background:
--   DB-MATERIAL-BATCH-IDENTITY-DESIGN-A (design-only, no file changes)
--   investigated three options for closing the gap where item_availability's
--   uniqueness/matching key (distribution_point_id + scientific_name +
--   concentration + dosage_form) ignored national_code, batch_number,
--   expiry_date, supply_type, and price — meaning a different batch of the
--   same product could silently overwrite an existing row's identity
--   details. That design phase recommended Option A: fold national_code,
--   batch_number, and expiry_date into DB identity (the three fields that
--   genuinely define "a different batch" in this domain), while
--   deliberately continuing to exclude supply_type and price (free-text/
--   administrative fields that would otherwise silently fragment rows on
--   routine edits, e.g. a price correction) — those two remain UI-mediated
--   via the existing similar-material comparison/blocking panel
--   (AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-A), unchanged by this
--   migration.
--
-- This migration implements Option A only:
--   A. Replaces item_availability_dp_sci_conc_form_uniq (migration 029) with
--      a new partial unique index that adds national_code, batch_number,
--      and expiry_date to the key.
--   B. Replaces phoenix_upsert_availability's existing-row lookup to match
--      on the same widened key, and adjusts identity-field handling on
--      UPDATE (see "Identity-field UPDATE behavior" below).
--   C. Verification block.
--
-- FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A (applied to this file before any
-- manual apply attempt succeeded):
--   The first draft of this migration used COALESCE(expiry_date::text, '')
--   for the expiry_date identity component, both in the CREATE UNIQUE INDEX
--   expression and in the RPC's v_expiry_date_key/matching WHERE clause. A
--   manual SQL Editor apply attempt failed with:
--     ERROR: 42P17: functions in index expression must be marked IMMUTABLE
--   because date-to-text casting depends on the session's DateStyle setting
--   and is therefore not IMMUTABLE, which Postgres requires for any
--   expression used in an index. That attempt did NOT succeed — the DB was
--   left on the OLD index (item_availability_dp_sci_conc_form_uniq) and the
--   new index was never created; no partial/inconsistent state resulted.
--   This file now uses an immutable date-sentinel expression instead:
--     COALESCE(expiry_date, DATE '0001-01-01')
--   both in the index and in the RPC (v_expiry_date_key is now `date`, not
--   `text`) — DATE arithmetic/equality has no locale/session dependency, so
--   this is safely IMMUTABLE. This changes only the expiry_date identity
--   expression's type/representation; the set of rows the index/RPC treat as
--   "the same identity" is unaffected (NULL expiry_date still collapses to a
--   single sentinel value either way, and any real expiry_date maps 1:1
--   whether compared as text or as date).
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-050 in any way.
--   - Does NOT touch item_availability_local_item_id_distribution_point_id_key
--     (migration 001's legacy 2-column unique constraint) — untouched,
--     still active for any row still using the local_item_id path.
--   - Does NOT add supply_type or price to DB uniqueness or to the RPC's
--     matching WHERE clause — both remain exactly as migration 050 left
--     them: unconditionally overwritten metadata on UPDATE, with all
--     conflict detection for them staying in the frontend's similar-match
--     panel (AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-A), unchanged.
--   - Does NOT change the RPC's parameter list — still the exact same
--     13-argument signature migration 050 introduced
--     (..., p_national_code text DEFAULT NULL); only the function BODY
--     changes (existing-row lookup + UPDATE SET list for the three fields
--     now in the identity key), so this migration uses
--     CREATE OR REPLACE FUNCTION with the IDENTICAL argument-type list —
--     no DROP FUNCTION is needed here (unlike migration 050, which had to
--     add a genuinely new parameter and therefore could not simply
--     CREATE OR REPLACE over the old 12-argument function).
--   - Does NOT change the quantity hard guard (migration 035) —
--     quantity_update_requires_movement still fires on any p_quantity
--     mismatch, and quantity is still absent from the UPDATE SET list.
--     phoenix_apply_availability_movement (migration 034) remains the only
--     path for post-creation quantity changes.
--   - Does NOT change item_availability_movements (migration 033) or
--     phoenix_apply_availability_movement (migration 034) in any way.
--     Movement rows are keyed by item_availability.id, which this migration
--     never reassigns, renames, or deletes — every existing movement
--     reference stays exactly as valid as it was before this migration.
--     A row that used to silently absorb a different batch's edits will,
--     going forward, cause a NEW row (with its own fresh id and empty
--     movement history) to be inserted instead — this is the intended
--     effect of Option A, and is safe: no historical movement row is ever
--     touched or reassigned by this migration.
--   - Does NOT change any alert function, alert_key, or alert lifecycle
--     table (036/037/038/039/047/048) — none of them reference
--     national_code/batch_number/expiry_date as an identity key (048's
--     source_expiry_risk_tier/source_expiry_days_remaining are read-only,
--     row-scoped display fields, not part of any matching or alert_key
--     logic). The live alert RPC already joins at row granularity
--     (source/target item_availability rows), so once multiple rows can
--     exist per product (different batches), it will naturally begin
--     producing one alert per qualifying batch pairing with zero code
--     change required — an expected, previously-documented side effect
--     (increased alert volume), not a bug this migration needs to address.
--   - Does NOT change any RLS policy — item_availability's existing RLS
--     (migration 002) is row-scoped, not column-scoped or index-scoped, so
--     widening the unique index and the RPC's internal matching logic
--     requires zero policy changes.
--   - Does NOT broaden grants — EXECUTE on phoenix_upsert_availability is
--     still authenticated-only; anon/PUBLIC remain revoked, identical to
--     every prior version.
--   - Does NOT change auth/session logic, use service_role, or use
--     auth.admin.
--   - Does NOT add any WhatsApp Cloud/Graph API call, token, Bearer header,
--     or automated send.
--   - Does NOT apply migration 048.
--   - Does NOT create migration 052 or any migration beyond 051.
--   - Does NOT touch QR generation, export/print, or user-management logic.
--   - Does NOT modify any frontend file. The current frontend
--     (EditorScreen.tsx's existingRow detection) still matches on the OLD
--     4-column key and will therefore, immediately after this migration is
--     applied, sometimes disagree with what the RPC actually does: the
--     editor may believe an existing row was found (old key) and lock/
--     prefill accordingly, while the RPC (new 7-column key) may not find a
--     match for a different national_code/batch_number/expiry_date and
--     insert a NEW row instead of updating the one the editor displayed.
--     This is a KNOWN, TEMPORARY inconsistency window between applying this
--     migration and completing the frontend-sync phase
--     (AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B) — the design phase
--     explicitly flagged that the DB migration and the frontend matching-
--     key extension must land together in practice, even though they are
--     prepared/reviewed/committed as separate phases. Do not apply this
--     migration in production without immediately following it with the
--     frontend-sync phase; until that lands, treat this as reviewed-but-
--     not-yet-safe-to-apply-alone, or accept the inconsistency window
--     knowingly for a short review/test period.
--
-- Identity-field UPDATE behavior (read before applying):
--   Before this migration, national_code was NOT part of the matching key,
--   so migration 050 had to guard its UPDATE assignment with
--   COALESCE(v_national_code, ia.national_code) — otherwise an omitted/blank
--   p_national_code (every caller before AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A
--   shipped) would silently erase an existing value on any unrelated edit.
--
--   After this migration, national_code (along with batch_number and
--   expiry_date) IS part of the matching key. This structurally changes the
--   risk: by the time execution reaches the UPDATE branch, the WHERE clause
--   that found v_existing_id has ALREADY proven
--   COALESCE(ia.national_code,'') = COALESCE(NULLIF(btrim(p_national_code),''),'')
--   (and the equivalent for batch_number/expiry_date) — i.e. the submitted
--   and stored values are already equal (up to NULL/'' normalization). There
--   is no longer any scenario where UPDATE could "move" a row's identity
--   out from under it, because a genuinely different value would have
--   caused a NEW row to be inserted instead of matching this one.
--
--   Given that, this migration chooses the SIMPLER of the two safe options
--   the task allowed: assign national_code/batch_number/expiry_date on
--   UPDATE from their normalized submitted values (v_national_code,
--   v_batch_number, p_expiry_date), exactly like every other overwritten
--   column (condition/notes/supply_type/price/trade_name) — NOT the
--   COALESCE-preserve trick migration 050 needed, which is no longer
--   necessary and would only obscure that these fields are now identity-
--   equivalent to what's already stored. This also has a small beneficial
--   side effect: it normalizes any stored value that had incidental leading/
--   trailing whitespace into the trimmed form (national_code/batch_number),
--   and re-stores NULL rather than a lingering empty string, matching this
--   project's existing "prefer NULL over ''" convention for optional text
--   columns.
--
--   Concretely: v_national_code / v_batch_number are computed once as
--   NULLIF(btrim(p_xxx), '') (may be NULL — this is the STORED form,
--   matching migrations 049/050's convention), and separately
--   v_national_code_key / v_batch_number_key are COALESCE(..., '') text
--   forms used ONLY inside the WHERE-clause comparison (matching the
--   COALESCE(ia.xxx, '') pattern already used for concentration/dosage_form
--   since migration 029) — never written to a column. v_expiry_date_key is
--   the odd one out: it is a `date` (not `text`), computed as
--   COALESCE(p_expiry_date, DATE '0001-01-01') — see
--   FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A above for why a text/::text
--   cast cannot be used here (it is not IMMUTABLE, which Postgres requires
--   for index expressions). DATE '0001-01-01' is used purely as an
--   impossible-in-practice sentinel to stand in for "no expiry_date", the
--   same role '' plays for the two text keys.
--
-- Duplicate/conflict safety before applying:
--   Because the new unique index is narrower than "any row could exist" (it
--   is a genuinely NEW, WIDER key than the old one), no existing row can
--   ever violate it that didn't already coexist safely under the OLD
--   (narrower) key — widening a partial unique index's column list can only
--   ever make previously-illegal duplicates legal, never the reverse, so
--   CREATE UNIQUE INDEX here cannot fail due to pre-existing data. This is
--   the opposite risk profile from migration 049's backfill (which needed a
--   verification block to catch unsafely-diverged data) — here, the
--   verification block instead simply confirms the new index was created
--   successfully and the old one is gone.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Safety:
--   - DROP INDEX IF EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS — idempotent.
--   - CREATE OR REPLACE FUNCTION — idempotent, same argument-type list as
--     migration 050, so this is a true in-place replacement, not a new
--     overload.
--   - No DROP TABLE, TRUNCATE, DELETE, or destructive CASCADE anywhere.
--   - No data is deleted or moved.
--
-- After applying, verify with:
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'item_availability'
--     AND indexname = 'item_availability_dp_sci_conc_form_nat_batch_exp_uniq';
--   -- expect: 1 row, indexdef mentions national_code, batch_number, expiry_date,
--   -- and DATE '0001-01-01' (NOT expiry_date::text)
--
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'item_availability'
--     AND indexname = 'item_availability_dp_sci_conc_form_uniq';
--   -- expect: 0 rows (old index gone)
--
--   SELECT pg_get_function_arguments(oid) FROM pg_proc
--   WHERE proname = 'phoenix_upsert_availability';
--   -- expect: 1 row, 13 arguments, ending in p_national_code text DEFAULT NULL::text
--
--   -- Confirm a genuinely different batch now creates an independent row
--   -- instead of silently updating the old one:
--   SELECT phoenix_upsert_availability(
--     '<distribution_point_id>', '<scientific_name>', null, null, null,
--     10, 'available', '2027-01-01', 'BATCH-A', null, null, null, 'NC-1'
--   );
--   SELECT phoenix_upsert_availability(
--     '<same distribution_point_id>', '<same scientific_name>', null, null, null,
--     5, 'available', '2028-06-01', 'BATCH-B', null, null, null, 'NC-2'
--   );
--   -- expect: two distinct item_availability rows, not one row overwritten.
-- ============================================================================

-- ============================================================================
-- A. Replace the old 4-column unique index with the new 7-column (Option A)
--    partial unique index.
-- ============================================================================

DROP INDEX IF EXISTS public.item_availability_dp_sci_conc_form_uniq;

-- NOTE (FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A): the expiry_date
-- component below uses the immutable date-sentinel form
-- COALESCE(expiry_date, DATE '0001-01-01'), NOT expiry_date::text —
-- date-to-text casting is not IMMUTABLE (it depends on DateStyle) and
-- Postgres rejects non-IMMUTABLE expressions in index definitions
-- (ERROR 42P17: functions in index expression must be marked IMMUTABLE).
CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_uniq
ON public.item_availability (
  distribution_point_id,
  scientific_name,
  COALESCE(concentration, ''),
  COALESCE(dosage_form, ''),
  COALESCE(national_code, ''),
  COALESCE(batch_number, ''),
  COALESCE(expiry_date, DATE '0001-01-01')
)
WHERE scientific_name IS NOT NULL;

-- item_availability_local_item_id_distribution_point_id_key (migration 001)
-- is intentionally left untouched — not dropped, not modified.

-- ============================================================================
-- B. phoenix_upsert_availability: same 13-argument signature as migration
--    050, only the existing-row lookup and identity-field UPDATE handling
--    change (see header for the full reasoning).
-- ============================================================================

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
    AND COALESCE(ia.expiry_date, DATE '0001-01-01')     = v_expiry_date_key;

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
           expiry_date   = p_expiry_date
     WHERE ia.id = v_existing_id
    RETURNING ia.id INTO v_id;

    RETURN v_id;
  END IF;

  -- 5. INSERT path — requires availability.create
  IF NOT v_is_super AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.create') THEN
    RAISE EXCEPTION 'forbidden_availability_create' USING ERRCODE = '42501';
  END IF;

  -- 6. INSERT (super_admin, or any role holding availability.create).
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

-- ============================================================================
-- C. Grants — unchanged signature, so the same GRANT/REVOKE targets as
--    migration 050 (authenticated only, anon/PUBLIC excluded).
-- ============================================================================

REVOKE ALL ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text
) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- D. Verification
-- ============================================================================

DO $$
DECLARE
  v_fn_src         text;
  v_fn_count       integer;
  v_new_idx_def    text;
  v_old_idx_count  integer;
  v_legacy_uniq_count integer;
  v_grant_count    integer;
BEGIN
  -- 1/2. Old index gone, new index exists
  SELECT count(*) INTO v_old_idx_count
  FROM pg_indexes
  WHERE tablename = 'item_availability'
    AND indexname = 'item_availability_dp_sci_conc_form_uniq';
  ASSERT v_old_idx_count = 0,
    'VERIFY FAILED: old item_availability_dp_sci_conc_form_uniq index still exists';

  SELECT indexdef INTO v_new_idx_def
  FROM pg_indexes
  WHERE tablename = 'item_availability'
    AND indexname = 'item_availability_dp_sci_conc_form_nat_batch_exp_uniq';
  ASSERT v_new_idx_def IS NOT NULL,
    'VERIFY FAILED: new item_availability_dp_sci_conc_form_nat_batch_exp_uniq index was not created';

  -- 3. New index includes national_code, batch_number, expiry_date
  ASSERT v_new_idx_def LIKE '%national_code%',
    'VERIFY FAILED: new unique index does not reference national_code';
  ASSERT v_new_idx_def LIKE '%batch_number%',
    'VERIFY FAILED: new unique index does not reference batch_number';
  ASSERT v_new_idx_def LIKE '%expiry_date%',
    'VERIFY FAILED: new unique index does not reference expiry_date';

  -- 3b. FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A: the expiry_date
  --     component must use the immutable date-sentinel form, NOT the
  --     non-IMMUTABLE ::text cast that caused the original apply attempt
  --     to fail with 42P17.
  ASSERT v_new_idx_def LIKE '%0001-01-01%',
    'VERIFY FAILED: new unique index does not use the DATE ''0001-01-01'' sentinel for expiry_date';
  ASSERT v_new_idx_def NOT LIKE '%expiry_date::text%',
    'VERIFY FAILED: new unique index still uses the non-IMMUTABLE expiry_date::text expression';

  -- 4. New index does NOT include supply_type or price
  ASSERT v_new_idx_def NOT LIKE '%supply_type%',
    'VERIFY FAILED: new unique index unexpectedly references supply_type';
  ASSERT v_new_idx_def NOT LIKE '%price%',
    'VERIFY FAILED: new unique index unexpectedly references price';

  -- 5. Legacy local_item unique constraint still exists
  SELECT count(*) INTO v_legacy_uniq_count
  FROM pg_constraint
  WHERE conname = 'item_availability_local_item_id_distribution_point_id_key';
  ASSERT v_legacy_uniq_count = 1,
    'VERIFY FAILED: legacy item_availability_local_item_id_distribution_point_id_key constraint is missing';

  -- 6. Exactly one phoenix_upsert_availability function exists
  SELECT count(*) INTO v_fn_count
  FROM pg_proc WHERE proname = 'phoenix_upsert_availability';
  ASSERT v_fn_count = 1,
    'VERIFY FAILED: expected exactly 1 phoenix_upsert_availability function, found ' || v_fn_count;

  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'phoenix_upsert_availability';
  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED: phoenix_upsert_availability function not found';

  -- 7. 13 args including p_national_code
  ASSERT v_fn_src LIKE '%p_national_code text DEFAULT NULL%',
    'VERIFY FAILED: p_national_code text DEFAULT NULL parameter not found';

  -- 8/9. SECURITY DEFINER + search_path
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%',
    'VERIFY FAILED: phoenix_upsert_availability lost SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_upsert_availability lost SET search_path';

  -- 10. Matching key includes national_code, batch_number, expiry_date
  ASSERT v_fn_src LIKE '%COALESCE(ia.national_code, %'
     AND v_fn_src LIKE '%v_national_code_key%',
    'VERIFY FAILED: matching WHERE clause does not include national_code';
  ASSERT v_fn_src LIKE '%COALESCE(ia.batch_number, %'
     AND v_fn_src LIKE '%v_batch_number_key%',
    'VERIFY FAILED: matching WHERE clause does not include batch_number';
  ASSERT v_fn_src LIKE '%COALESCE(ia.expiry_date, DATE ''0001-01-01'')%'
     AND v_fn_src LIKE '%v_expiry_date_key%',
    'VERIFY FAILED: matching WHERE clause does not include expiry_date';

  -- 10b. FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A: v_expiry_date_key must
  --      be declared `date`, and the WHERE clause must never fall back to
  --      the non-IMMUTABLE ::text cast that caused the original apply
  --      attempt to fail with 42P17.
  ASSERT v_fn_src LIKE '%v_expiry_date_key%date%',
    'VERIFY FAILED: v_expiry_date_key is not declared as date';
  ASSERT v_fn_src NOT LIKE '%expiry_date::text%',
    'VERIFY FAILED: phoenix_upsert_availability still uses the non-IMMUTABLE expiry_date::text expression';

  -- 11. Matching key does NOT include supply_type/price in the WHERE lookup
  --     (scope the check to the SELECT ... INTO v_existing_id lookup only —
  --     supply_type/price legitimately appear elsewhere, e.g. the UPDATE SET
  --     list and INSERT column list).
  ASSERT substring(v_fn_src from 'SELECT ia\.id, ia\.quantity INTO.*?IF v_existing_id')
     NOT LIKE '%ia.supply_type%',
    'VERIFY FAILED: matching WHERE lookup unexpectedly references supply_type';
  ASSERT substring(v_fn_src from 'SELECT ia\.id, ia\.quantity INTO.*?IF v_existing_id')
     NOT LIKE '%ia.price%',
    'VERIFY FAILED: matching WHERE lookup unexpectedly references price';

  -- 12. Quantity hard guard remains
  ASSERT v_fn_src LIKE '%quantity_update_requires_movement%',
    'VERIFY FAILED: quantity_update_requires_movement guard not found';

  -- 13. UPDATE SET list does not assign quantity
  ASSERT v_fn_src NOT LIKE '%SET quantity      = p_quantity%'
     AND v_fn_src NOT LIKE '%SET quantity = p_quantity%',
    'VERIFY FAILED: UPDATE branch still assigns quantity = p_quantity';

  -- 14. Permission checks remain
  ASSERT v_fn_src LIKE '%availability.create%',
    'VERIFY FAILED: phoenix_upsert_availability does not reference availability.create';
  ASSERT v_fn_src LIKE '%availability.update%',
    'VERIFY FAILED: phoenix_upsert_availability does not reference availability.update';

  -- 15. Ownership/cross-org checks remain
  ASSERT v_fn_src LIKE '%forbidden_cross_org%',
    'VERIFY FAILED: phoenix_upsert_availability does not reference forbidden_cross_org';

  -- 16/17. Grants: authenticated only, anon/PUBLIC excluded
  SELECT count(*) INTO v_grant_count
  FROM information_schema.routine_privileges
  WHERE routine_schema = 'public'
    AND routine_name = 'phoenix_upsert_availability'
    AND grantee = 'authenticated'
    AND privilege_type = 'EXECUTE';
  ASSERT v_grant_count >= 1,
    'VERIFY FAILED: authenticated does not have EXECUTE on phoenix_upsert_availability';

  ASSERT NOT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_upsert_availability'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on phoenix_upsert_availability';

  -- 18. item_availability RLS policy count unchanged
  ASSERT (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_availability'
  ) = 4,
    'VERIFY FAILED: item_availability policy count changed — expected exactly 4';

  -- 19/20. phoenix_apply_availability_movement and get_public_qr_payload untouched
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'
  ), 'VERIFY FAILED: phoenix_apply_availability_movement is missing';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'
  ), 'VERIFY FAILED: get_public_qr_payload is missing (should not be touched by this migration)';

  -- 21. No alert functions/tables changed (existence check only — this
  --     migration does not redefine any of them)
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state'
  ), 'VERIFY FAILED: phoenix_get_live_inter_institution_alerts_with_state is missing';

  RAISE NOTICE '051 OK: item_availability uniqueness widened to distribution_point_id + scientific_name + concentration + dosage_form + national_code + batch_number + expiry_date (Option A); phoenix_upsert_availability matches on the same widened key; supply_type/price remain outside DB identity; quantity hard guard, permissions, RLS, movement history, and alert objects all unchanged.';
END $$;

-- ============================================================================
-- END OF MIGRATION 051
-- ============================================================================
