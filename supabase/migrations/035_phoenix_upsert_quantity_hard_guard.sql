-- ============================================================================
-- MIGRATION 035 — phoenix_upsert_availability: quantity hard guard on UPDATE
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 001, 010, 019, 020, 029, 030, 031, 032 (phoenix_upsert_availability
-- + item_availability material-identity schema + permission-matrix authorization),
-- 033, 034 (item_availability_movements schema + phoenix_apply_availability_movement
-- RPC — REQUIRED, already applied by the owner).
--
-- Task: BACKEND-QUANTITY-UPSERT-HARD-GUARD-A
--
-- Root cause being fixed:
--   The EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A phase added a frontend-only
--   guard (EditorScreen.tsx) that disables the quantity input and always
--   resends the existing row's own quantity when editing. That is a UX
--   guard only — phoenix_upsert_availability (migration 032) still accepts
--   an arbitrary p_quantity and silently writes it into item_availability.quantity
--   on its UPDATE branch for ANY caller with availability.update, bypassing
--   item_availability_movements entirely (no audit trail) if the RPC is
--   invoked directly (devtools, API client, or a future UI regression).
--
-- What this migration does:
--   Replaces phoenix_upsert_availability so its UPDATE branch can no longer
--   change quantity at all:
--     - If p_quantity IS DISTINCT FROM the row's current stored quantity,
--       the function raises 'quantity_update_requires_movement' and the
--       UPDATE does not happen (whole call aborts — Postgres functions are
--       single-transaction, so no partial write of the other fields either).
--     - If p_quantity equals the current stored quantity (the normal case,
--       since the frontend guard now always resends it unchanged), the
--       UPDATE proceeds exactly as before for every other column
--       (condition, expiry_date, batch_number, notes, supply_type, price,
--       trade_name) — quantity itself is simply left untouched by the SET
--       list (not merely re-assigned to its own value).
--   The INSERT branch is untouched: p_quantity is still the initial stock
--   quantity for a brand-new row, exactly as migration 032 defined it.
--
-- Error code choice: 'quantity_update_requires_movement' is raised with
-- ERRCODE = '23514' (check_violation) rather than '42501' (insufficient
-- privilege). This is a data-invariant violation, not a permission problem —
-- the caller may hold availability.update and still be rejected purely
-- because of the quantity mismatch, exactly mirroring how this same
-- function already raises 'scientific_name_required' with 23514 for a
-- similar "your input violates a business rule" case (not a permission
-- case, which uses 42501 elsewhere in this function).
--
-- All post-creation quantity changes must go through
-- phoenix_apply_availability_movement (migration 034), which is the only
-- path that also writes an auditable item_availability_movements row.
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-034 (034 included) in any way.
--   - Does NOT modify phoenix_apply_availability_movement.
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT touch EditorScreen, StatusCenter, or any frontend file.
--   - Does NOT change the function signature, return type, permission
--     checks (availability.create / availability.update / super_admin
--     bypass / forbidden_cross_org), organization-scope derivation,
--     port_name derivation, or grants — all preserved byte-for-byte from
--     migration 032 except the UPDATE branch's quantity handling.
--   - Does NOT weaken any RLS policy — item_availability's avail_insert_perm
--     / avail_update_perm policies (migration 032) are untouched; this is a
--     function-body-only change.
--   - Does NOT use any elevated/admin API key — this is a plain SQL migration.
--   - Does NOT add Excel import.
--
-- Security: SECURITY DEFINER, SET search_path = public — unchanged from 032.
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
  p_price                  numeric
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
  --    (trusted source, never trusted from the client). Loading the whole row
  --    lets us fall back across possible name columns without assuming one
  --    exact column exists in every environment.
  SELECT * INTO v_dp
  FROM public.distribution_points
  WHERE id = p_distribution_point_id;

  IF NOT FOUND OR v_dp.organization_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_point_org := v_dp.organization_id;

  -- 1b. Derive a guaranteed non-null port_name so the table identity check
  --     (local_item_id IS NOT NULL OR port_name IS NOT NULL) is satisfied for
  --     INSERTs that carry no local_item_id. Robust JSONB fallback covers
  --     schema drift; final fallback is the point id text (always non-null).
  v_port_name := COALESCE(
    NULLIF(to_jsonb(v_dp)->>'name', ''),
    NULLIF(to_jsonb(v_dp)->>'name_ar', ''),
    NULLIF(to_jsonb(v_dp)->>'display_name', ''),
    NULLIF(to_jsonb(v_dp)->>'port_name', ''),
    NULLIF(to_jsonb(v_dp)->>'title', ''),
    p_distribution_point_id::text
  );

  -- 2. authorize: permission-matrix based (unchanged from migration 032)
  --    super_admin bypasses org scope entirely; everyone else must be in the
  --    same organization as the target point. The actual create-vs-update
  --    permission is checked per-branch below (step 3/4/5) once we know
  --    whether this is an INSERT or an UPDATE.
  v_is_super := (v_role = 'super_admin');
  v_in_scope := v_is_super OR (v_point_org = v_my_org);

  IF NOT v_in_scope THEN
    RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super
     AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.create')
     AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.update') THEN
    -- Actor has neither permission at all — do not even attempt the
    -- UPDATE/INSERT probe below.
    RAISE EXCEPTION 'forbidden_role_or_permission' USING ERRCODE = '42501';
  END IF;

  -- 3. Determine whether a matching row already exists (matches partial
  --    index 029 via COALESCE) BEFORE deciding whether this is a create or
  --    an update, so a role holding only one of the two permissions gets an
  --    accurate, specific denial rather than falling through to a raw
  --    unique-constraint violation. Also fetch the row's CURRENT quantity —
  --    needed by the BACKEND-QUANTITY-UPSERT-HARD-GUARD-A check below.
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

    -- 4b. BACKEND-QUANTITY-UPSERT-HARD-GUARD-A: quantity can never be
    --     changed through this RPC's UPDATE path. p_quantity must equal the
    --     row's current stored quantity (the frontend guard added in
    --     EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A always resends it
    --     unchanged for this reason). Any difference — including a direct
    --     RPC call bypassing the UI — is rejected outright, before any
    --     column is written. Quantity changes after creation must go
    --     through phoenix_apply_availability_movement (migration 034),
    --     which also records an auditable item_availability_movements row.
    IF p_quantity IS DISTINCT FROM v_existing_quantity THEN
      RAISE EXCEPTION 'quantity_update_requires_movement' USING ERRCODE = '23514';
    END IF;

    -- quantity is intentionally NOT in this SET list — the guard above
    -- already proved p_quantity = v_existing_quantity, so omitting it here
    -- (rather than re-assigning it to itself) is the hard guarantee that no
    -- code path in this function can ever change quantity on UPDATE.
    UPDATE public.item_availability AS ia
       SET condition     = p_condition,
           expiry_date   = p_expiry_date,
           batch_number  = p_batch_number,
           notes         = p_notes,
           supply_type   = p_supply_type,
           price         = p_price,
           trade_name    = p_trade_name
     WHERE ia.id = v_existing_id
    RETURNING ia.id INTO v_id;

    RETURN v_id;
  END IF;

  -- 5. INSERT path — requires availability.create (super_admin always
  --    allowed). A role that holds availability.update but not
  --    availability.create (port_officer / point_operator) lands here for a
  --    genuinely new scientific_name/point combination and is correctly denied.
  IF NOT v_is_super AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.create') THEN
    RAISE EXCEPTION 'forbidden_availability_create' USING ERRCODE = '42501';
  END IF;

  -- 6. INSERT (super_admin, or any role holding availability.create)
  --    port_name is included explicitly to satisfy item_availability_identity_chk.
  --    p_quantity here is the INITIAL stock quantity for a brand-new row —
  --    unaffected by the UPDATE-path hard guard above.
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
    price
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
    p_price
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;

$$;

-- restrict execution to authenticated users (RLS-equivalent gate happens inside)
-- — grants unchanged from migration 032.
REVOKE ALL ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric
) TO authenticated;

-- Ask PostgREST to reload its schema cache so the corrected RPC is visible.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
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

  -- B. New hard guard is present
  ASSERT v_fn_src LIKE '%quantity_update_requires_movement%',
    'VERIFY FAILED: quantity_update_requires_movement guard not found';
  ASSERT v_fn_src LIKE '%IS DISTINCT FROM v_existing_quantity%',
    'VERIFY FAILED: quantity mismatch comparison not found';

  -- C. Explanatory reference to the correct remediation path (comment-only;
  --    this function does not and should not call phoenix_apply_availability_movement)
  ASSERT v_fn_src LIKE '%phoenix_apply_availability_movement%',
    'VERIFY FAILED: no reference to phoenix_apply_availability_movement as the required remediation path';

  -- D. UPDATE branch no longer assigns quantity = p_quantity
  ASSERT v_fn_src NOT LIKE '%SET quantity      = p_quantity%'
     AND v_fn_src NOT LIKE '%SET quantity = p_quantity%',
    'VERIFY FAILED: UPDATE branch still assigns quantity = p_quantity';

  -- E. INSERT branch still uses p_quantity as the initial quantity
  ASSERT v_fn_src LIKE '%quantity,%' AND v_fn_src LIKE '%p_quantity,%',
    'VERIFY FAILED: INSERT branch no longer references p_quantity';

  -- F. Grants: authenticated only, anon/PUBLIC excluded (unchanged from 032)
  ASSERT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_upsert_availability'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated does not have EXECUTE on phoenix_upsert_availability';

  ASSERT NOT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_upsert_availability'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on phoenix_upsert_availability';

  -- G. phoenix_apply_availability_movement itself was not touched by this migration
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'
  ), 'VERIFY FAILED: phoenix_apply_availability_movement is missing';

  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement';

  ASSERT v_fn_src LIKE '%quantity_cannot_go_negative%'
     AND v_fn_src LIKE '%INSERT INTO public.item_availability_movements%',
    'VERIFY FAILED: phoenix_apply_availability_movement no longer matches its migration-034 shape';

  -- H. No new/changed RLS policy on item_availability (this migration is
  --    function-body-only — avail_insert_perm/avail_update_perm from 032
  --    are untouched)
  ASSERT (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_availability'
  ) = 4,
    'VERIFY FAILED: item_availability policy count changed — expected exactly 4 (avail_select_org, avail_select_anon, avail_insert_perm, avail_update_perm)';

  -- I. get_public_qr_payload untouched (function still exists, unmodified by this file)
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'
  ), 'VERIFY FAILED: get_public_qr_payload is missing (should not be touched by this migration)';

  RAISE NOTICE '035 OK: phoenix_upsert_availability UPDATE branch can no longer change quantity (quantity_update_requires_movement guard in place); INSERT branch unchanged; phoenix_apply_availability_movement, item_availability RLS, and get_public_qr_payload untouched.';
END $$;

-- ============================================================================
-- END OF MIGRATION 035
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. Confirm the guard triggers on a direct quantity change attempt:
--    SELECT phoenix_upsert_availability(
--      '<existing distribution_point_id>', '<existing scientific_name>',
--      null, null, null, <current_quantity + 1>, 'available', null, null, null, null, null
--    );
--    -- expect: ERROR quantity_update_requires_movement
--    -- then confirm item_availability.quantity for that row is UNCHANGED.
--
-- 2. Confirm a normal save (same quantity, changed condition/notes/etc.)
--    still succeeds:
--    SELECT phoenix_upsert_availability(
--      '<existing distribution_point_id>', '<existing scientific_name>',
--      null, null, null, <current_quantity>, 'low_stock', null, null, 'updated notes', null, null
--    );
--    -- expect: success, condition/notes updated, quantity unchanged.
--
-- 3. Confirm a brand-new row still gets its initial quantity:
--    SELECT phoenix_upsert_availability(
--      '<distribution_point_id with no matching row>', '<new scientific_name>',
--      null, null, null, 25, 'available', null, null, null, null, null
--    );
--    -- expect: success, new row created with quantity = 25.
--
-- 4. Confirm the intended remediation path still works normally:
--    SELECT phoenix_apply_availability_movement('<item_availability.id>', 'add', 5, null, 'restock');
--    -- expect: success, quantity increases by 5, a movement row is recorded.
-- ============================================================================
