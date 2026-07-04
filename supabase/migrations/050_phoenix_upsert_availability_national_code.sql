-- ============================================================================
-- 050_phoenix_upsert_availability_national_code.sql
-- MediStock Phoenix V2
--
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Review then apply manually in Supabase Dashboard → SQL Editor.
--
-- Task: DB-AVAILABILITY-UPSERT-NATIONAL-CODE-050-A
--
-- Prerequisites:
--   Migrations 001-049 must be applied. Migration 049
--   (item_availability.national_code, nullable, backfilled from
--   batch_number) is REQUIRED — already applied manually by the owner.
--   Migration 048 does NOT need to be applied first — independent, as
--   documented in migration 049.
--
-- Background:
--   Migration 049 added item_availability.national_code but did not touch
--   phoenix_upsert_availability, so nothing could write to the new column
--   yet. This migration adds RPC support for saving national_code, in
--   preparation for a later, separately reviewed frontend phase
--   (AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A) that will actually send it.
--
--   Scope is deliberately narrow: this migration ONLY teaches the RPC to
--   accept and persist national_code. It does NOT touch:
--     - the matching/uniqueness key (still distribution_point_id +
--       scientific_name + COALESCE(concentration,'') + COALESCE(dosage_form,''),
--       exactly as migrations 029/035 left it — no expiry_date, no
--       batch_number, no national_code in the match key),
--     - batch identity design (DATA-QUALITY-MATERIAL-BATCH-IDENTITY-A and
--       friends remain a separate, later effort),
--     - alert matching/alert_key,
--     - movement history,
--     - RLS/policies/permissions.
--
-- Signature change (important — read before applying):
--   Every prior redefinition of phoenix_upsert_availability (migrations 030,
--   031, 032, 035) used CREATE OR REPLACE FUNCTION with the EXACT SAME
--   12-parameter signature, so each one cleanly replaced the previous
--   function body with zero risk of Postgres treating it as a distinct
--   overload. This migration adds a genuinely new 13th parameter
--   (p_national_code text DEFAULT NULL), which changes the function's
--   argument-type list. Postgres identifies a function by its argument
--   TYPES, not by name/defaults, so `CREATE OR REPLACE FUNCTION
--   phoenix_upsert_availability(<12 types>, text)` would NOT replace the
--   existing 12-argument function — it would create a SECOND, overloaded
--   function alongside it, which Postgres/PostgREST could then resolve
--   ambiguously (or unpredictably) for callers depending on how many named
--   arguments they pass. To avoid that entirely, this migration explicitly
--   DROPs the old 12-argument function first, then CREATEs the new
--   13-argument one under the same name. There is only ever ONE
--   phoenix_upsert_availability function after this migration runs.
--
-- Backward compatibility (why existing frontend calls still work unchanged):
--   PostgREST/supabase-js RPC calls pass arguments BY NAME (as a JSON object
--   of p_xxx keys), not positionally. Because p_national_code has
--   `DEFAULT NULL` and is the last parameter, any caller that omits the
--   p_national_code key entirely (i.e. every existing call site today —
--   src/shared/supabase/services/availability.service.ts's upsertAvailability()
--   is intentionally NOT modified by this migration) continues to work with
--   zero code changes, with p_national_code implicitly NULL.
--
-- Critical data-safety decision — NULL parameter must never erase an
-- existing national_code:
--   Because the frontend does not send p_national_code yet, EVERY existing
--   call to this RPC (every ordinary availability edit through the current
--   Editor) will implicitly pass p_national_code = NULL until
--   AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A ships. If the UPDATE branch
--   naively did `SET national_code = v_national_code` unconditionally, it
--   would silently WIPE OUT every national_code value migration 049 just
--   backfilled, on the very next unrelated edit (e.g. changing quantity via
--   a movement, or condition, or notes) — a serious silent data-loss
--   regression, and the exact kind of silent-overwrite bug this whole
--   phase's lineage (DATA-QUALITY-MATERIAL-BATCH-IDENTITY-A onward) exists
--   to prevent.
--
--   To prevent this, the UPDATE branch uses:
--     national_code = COALESCE(v_national_code, ia.national_code)
--   i.e. only OVERWRITE national_code when the caller actually supplies a
--   non-null/non-blank value; otherwise the row's existing national_code is
--   left completely untouched. This is intentionally asymmetric with how
--   batch_number/notes/supply_type/price/trade_name are handled (those are
--   always overwritten from the parameter, matching current behavior
--   unchanged) — national_code alone gets this preserve-if-absent treatment
--   because it is the only new field being introduced into an RPC whose
--   callers do not yet know it exists. Once
--   AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A wires the editor to always
--   send the field explicitly, a later phase may reconsider this if an
--   explicit-clear capability is desired — out of scope here.
--
--   The INSERT branch has no such concern (a brand-new row has no existing
--   national_code to protect), so it simply inserts v_national_code exactly
--   as instructed.
--
-- What this migration does:
--   A. DROP the old 12-argument phoenix_upsert_availability function.
--   B. CREATE the new 13-argument phoenix_upsert_availability function:
--        1. Adds p_national_code text DEFAULT NULL as the 13th (final)
--           parameter.
--        2. Normalizes it once: v_national_code := NULLIF(btrim(p_national_code), '').
--        3. INSERT branch: sets national_code = v_national_code (may be NULL).
--        4. UPDATE branch: sets national_code = COALESCE(v_national_code,
--           ia.national_code) — never silently clears an existing value.
--        5. batch_number handling is completely unchanged (still comes
--           straight from p_batch_number on both INSERT and UPDATE, exactly
--           as migration 035 left it) — national_code and batch_number are
--           independent columns, independently maintained.
--        6. The matching/WHERE clause that decides UPDATE-vs-INSERT is
--           byte-for-byte identical to migration 035:
--           distribution_point_id + scientific_name +
--           COALESCE(concentration,'') + COALESCE(dosage_form,'') — no
--           expiry_date, no batch_number, no national_code added to it.
--        7. The BACKEND-QUANTITY-UPSERT-HARD-GUARD-A check (migration 035)
--           is preserved verbatim: UPDATE branch still raises
--           'quantity_update_requires_movement' if p_quantity differs from
--           the row's current stored quantity, and quantity is still absent
--           from the UPDATE SET list.
--        8. SECURITY DEFINER, SET search_path = public, the org/point
--           ownership derivation, the forbidden_cross_org check, and the
--           availability.create / availability.update permission checks are
--           all preserved verbatim from migration 035.
--   C. Re-grants EXECUTE on the new 13-argument signature to authenticated
--      only (anon/PUBLIC excluded) — same pattern as every prior migration.
--   D. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-049 in any way.
--   - Does NOT change the matching/uniqueness key — still exactly
--     distribution_point_id + scientific_name + COALESCE(concentration,'') +
--     COALESCE(dosage_form,''); no expiry_date, batch_number, or
--     national_code added to it. Multi-batch/expiry identity remains a
--     separate, later, more carefully reviewed effort.
--   - Does NOT change any unique index/constraint on item_availability
--     (migration 029's item_availability_dp_sci_conc_form_uniq, migration
--     001's item_availability_local_item_id_distribution_point_id_key —
--     both untouched).
--   - Does NOT change alert matching, alert_key, or any inter-institution
--     alert function/table (036/037/038/039/047/048) — none reference
--     national_code or batch_number, and this migration adds no reference.
--   - Does NOT change item_availability_movements or
--     phoenix_apply_availability_movement (033/034) in any way — this
--     migration only touches phoenix_upsert_availability, and the quantity
--     hard guard on its UPDATE branch is preserved exactly.
--   - Does NOT change any RLS policy — item_availability's existing RLS
--     (migration 002, avail_select_anon / avail_select_org /
--     avail_write_superadmin / avail_write_hospitaladmin /
--     avail_write_wh_manager / avail_write_point_operator) is row-scoped,
--     not column-scoped, so it already covers the new column usage with
--     zero policy changes required.
--   - Does NOT broaden grants — EXECUTE is still authenticated-only;
--     anon/PUBLIC are still explicitly revoked, identical to every prior
--     version of this function.
--   - Does NOT change auth/session logic.
--   - Does NOT use service_role or auth.admin.
--   - Does NOT add any WhatsApp Cloud/Graph API call, token, Bearer header,
--     or automated send.
--   - Does NOT apply migration 048.
--   - Does NOT create migration 051 or any migration beyond 050.
--   - Does NOT touch QR generation, export/print, or user-management logic.
--   - Does NOT modify any frontend file — src/shared/supabase/services/
--     availability.service.ts, EditorScreen.tsx, and src/shared/lib/types.ts
--     are all left exactly as DATA-MODEL-NATIONAL-CODE-SEPARATION-A left
--     them. Wiring the editor to actually send p_national_code is
--     explicitly deferred to AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A.
--   - Does NOT add any package dependency; does not touch package.json or
--     any lockfile.
--
-- Safety:
--   - The DROP + CREATE pair is the standard, safe way to change a Postgres
--     function's argument-type list without leaving a stray/ambiguous
--     overload behind — there is exactly one phoenix_upsert_availability
--     function, with 13 parameters, after this migration.
--   - No DROP TABLE, TRUNCATE, DELETE, or destructive CASCADE anywhere.
--   - No data is deleted or moved — this migration only replaces a function
--     body; item_availability's rows and columns are untouched (migration
--     049 already added national_code; this migration only makes it
--     writable through the RPC).
--
-- After applying, verify with:
--   SELECT prosecdef, pg_get_function_arguments(oid) FROM pg_proc
--   WHERE proname = 'phoenix_upsert_availability';
--   -- expect: exactly 1 row, prosecdef = true, arguments list ending in
--   -- "..., p_national_code text DEFAULT NULL::text"
--
--   -- Confirm an existing call (no p_national_code) never clears an
--   -- existing national_code:
--   SELECT national_code FROM item_availability WHERE id = '<row with a
--   backfilled national_code from migration 049>';
--   SELECT phoenix_upsert_availability(
--     '<that row''s distribution_point_id>', '<that row''s scientific_name>',
--     null, null, null, <that row's current quantity>, 'available', null,
--     null, 'touched, no national_code sent', null, null
--   );
--   SELECT national_code FROM item_availability WHERE id = '<same row>';
--   -- expect: unchanged (still the pre-existing value, not NULL)
--
--   -- Confirm an explicit national_code is now saved:
--   SELECT phoenix_upsert_availability(
--     '<distribution_point_id>', '<scientific_name>', null, null, null,
--     <quantity>, 'available', null, null, null, null, null, '  NC-123  '
--   );
--   -- expect: success; the row's national_code = 'NC-123' (trimmed)
-- ============================================================================

-- ============================================================================
-- A. Drop the old 12-argument function so the new 13-argument one does not
--    become an ambiguous overload alongside it.
-- ============================================================================

DROP FUNCTION IF EXISTS public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric
);

-- ============================================================================
-- B. New 13-argument function: adds p_national_code text DEFAULT NULL.
-- ============================================================================

CREATE FUNCTION public.phoenix_upsert_availability(
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
  v_role              text := phoenix_my_role();
  v_my_org            uuid := phoenix_my_org();
  v_point_org         uuid;
  v_port_name         text;
  v_dp                public.distribution_points%ROWTYPE;
  v_dosage            text := COALESCE(p_dosage_form, '');
  v_conc              text := COALESCE(p_concentration, '');
  v_national_code     text := NULLIF(btrim(p_national_code), '');
  v_id                uuid;
  v_is_super          boolean;
  v_in_scope          boolean;
  v_existing_id       uuid;
  v_existing_quantity integer;
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

  -- 2. authorize: permission-matrix based (unchanged from migration 035)
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
  --    UNCHANGED from migrations 029/035: distribution_point_id +
  --    scientific_name + COALESCE(concentration,'') + COALESCE(dosage_form,'').
  --    No expiry_date, batch_number, or national_code participates in this
  --    match — multi-batch/expiry identity is explicitly out of scope here.
  SELECT ia.id, ia.quantity INTO v_existing_id, v_existing_quantity
  FROM public.item_availability AS ia
  WHERE ia.distribution_point_id = p_distribution_point_id
    AND ia.scientific_name       = p_scientific_name
    AND COALESCE(ia.concentration, '') = v_conc
    AND COALESCE(ia.dosage_form,  '') = v_dosage;

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
    -- national_code uses COALESCE(v_national_code, ia.national_code) so that
    -- an omitted/blank p_national_code (every existing caller today) never
    -- clears a value already stored on the row — see the migration header
    -- for why this differs from every other column here, which are all
    -- unconditionally overwritten from their parameter exactly as before.
    UPDATE public.item_availability AS ia
       SET condition     = p_condition,
           expiry_date   = p_expiry_date,
           batch_number  = p_batch_number,
           notes         = p_notes,
           supply_type   = p_supply_type,
           price         = p_price,
           trade_name    = p_trade_name,
           national_code = COALESCE(v_national_code, ia.national_code)
     WHERE ia.id = v_existing_id
    RETURNING ia.id INTO v_id;

    RETURN v_id;
  END IF;

  -- 5. INSERT path — requires availability.create
  IF NOT v_is_super AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.create') THEN
    RAISE EXCEPTION 'forbidden_availability_create' USING ERRCODE = '42501';
  END IF;

  -- 6. INSERT (super_admin, or any role holding availability.create).
  --    national_code is set directly from v_national_code (may be NULL) —
  --    a brand-new row has no existing value to protect, unlike the UPDATE
  --    branch above.
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
    p_batch_number,
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
-- C. Grants — authenticated only, identical pattern to every prior version.
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
  v_fn_src      text;
  v_fn_count    integer;
  v_old_fn_count integer;
BEGIN
  SELECT count(*) INTO v_fn_count
  FROM pg_proc WHERE proname = 'phoenix_upsert_availability';

  ASSERT v_fn_count = 1,
    'VERIFY FAILED: expected exactly 1 phoenix_upsert_availability function (old 12-arg overload must be gone), found ' || v_fn_count;

  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'phoenix_upsert_availability';

  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED: phoenix_upsert_availability function not found';

  -- A. Signature / security properties preserved
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%',
    'VERIFY FAILED: phoenix_upsert_availability lost SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_upsert_availability lost SET search_path';
  ASSERT v_fn_src LIKE '%availability.create%',
    'VERIFY FAILED: phoenix_upsert_availability does not reference availability.create';
  ASSERT v_fn_src LIKE '%availability.update%',
    'VERIFY FAILED: phoenix_upsert_availability does not reference availability.update';
  ASSERT v_fn_src LIKE '%forbidden_cross_org%',
    'VERIFY FAILED: phoenix_upsert_availability does not reference forbidden_cross_org';

  -- B. national_code parameter present with a NULL default
  ASSERT v_fn_src LIKE '%p_national_code text DEFAULT NULL%',
    'VERIFY FAILED: p_national_code text DEFAULT NULL parameter not found';

  -- C. Quantity hard guard (migration 035) still present
  ASSERT v_fn_src LIKE '%quantity_update_requires_movement%',
    'VERIFY FAILED: quantity_update_requires_movement guard not found';
  ASSERT v_fn_src NOT LIKE '%SET quantity      = p_quantity%'
     AND v_fn_src NOT LIKE '%SET quantity = p_quantity%',
    'VERIFY FAILED: UPDATE branch still assigns quantity = p_quantity';

  -- D. national_code preserve-if-absent behavior on UPDATE
  ASSERT v_fn_src LIKE '%national_code = COALESCE(v_national_code, ia.national_code)%',
    'VERIFY FAILED: UPDATE branch does not preserve existing national_code when p_national_code is absent';

  -- E. batch_number still handled independently/unconditionally (unchanged)
  ASSERT v_fn_src LIKE '%batch_number  = p_batch_number%',
    'VERIFY FAILED: UPDATE branch no longer sets batch_number from p_batch_number';

  -- F. Matching key unchanged (no expiry_date/batch_number/national_code in it)
  ASSERT v_fn_src LIKE '%ia.scientific_name       = p_scientific_name%'
     AND v_fn_src LIKE '%COALESCE(ia.concentration, %'
     AND v_fn_src LIKE '%COALESCE(ia.dosage_form,%',
    'VERIFY FAILED: matching key no longer matches the expected scientific_name/concentration/dosage_form shape';

  -- G. Grants: authenticated only, anon/PUBLIC excluded
  SELECT count(*) INTO v_old_fn_count
  FROM information_schema.routine_privileges
  WHERE routine_schema = 'public'
    AND routine_name = 'phoenix_upsert_availability'
    AND grantee = 'authenticated'
    AND privilege_type = 'EXECUTE';

  ASSERT v_old_fn_count >= 1,
    'VERIFY FAILED: authenticated does not have EXECUTE on phoenix_upsert_availability';

  ASSERT NOT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_upsert_availability'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on phoenix_upsert_availability';

  -- H. item_availability RLS policy count unchanged (function-body-only change)
  ASSERT (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_availability'
  ) = 4,
    'VERIFY FAILED: item_availability policy count changed — expected exactly 4';

  -- I. phoenix_apply_availability_movement and get_public_qr_payload untouched
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'
  ), 'VERIFY FAILED: phoenix_apply_availability_movement is missing';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'
  ), 'VERIFY FAILED: get_public_qr_payload is missing (should not be touched by this migration)';

  RAISE NOTICE '050 OK: phoenix_upsert_availability now accepts p_national_code text DEFAULT NULL (13 args, single overload); INSERT sets national_code from the parameter; UPDATE preserves any existing national_code when the parameter is absent/blank; matching key, quantity hard guard, permissions, RLS, movement history, and alert objects all unchanged.';
END $$;

-- ============================================================================
-- END OF MIGRATION 050
-- ============================================================================
